// System (host) terminal — a shell on the SERVER you're managing, separate from the container exec terminal.
// It always targets the ACTIVE server (the one selected in the header):
//   - remote SSH host → a real interactive shell over ssh2 (DockGate already holds the key/password)
//   - local          → a PTY shell inside the DockGate container (has the docker CLI + socket)
//
// Wire-protocol (socket.io), mirrors the container terminal but on its own channel so both can coexist:
//   in:  hostterm:start {cols,rows} · hostterm:input <str> · hostterm:resize {cols,rows} · hostterm:stop
//   out: hostterm:ready {target,host} · hostterm:data {data} · hostterm:end · hostterm:error {error}
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { decrypt } = require('./auth/secrets');

let pty = null;
try { pty = require('node-pty'); } catch (e) { /* optional dep — local host terminal disabled if missing */ }

const SSH_KEYS_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');

function attachHostTerminal(socket, { dockerService, stmts, logAction }) {
  const hostSessions = new Map(); // slot -> { sshConn, sshStream, ptyProc }

  function cleanupSlot(slot) {
    const s = hostSessions.get(slot);
    if (!s) return;
    try { if (s.sshStream) s.sshStream.end(); } catch (e) {}
    try { if (s.sshConn) s.sshConn.end(); } catch (e) {}
    try { if (s.ptyProc) s.ptyProc.kill(); } catch (e) {}
    hostSessions.delete(slot);
  }

  function cleanupAll() {
    for (const slot of hostSessions.keys()) {
      cleanupSlot(slot);
    }
  }

  socket.on('hostterm:start', async ({ cols = 80, rows = 24, cwd = '', slot = 0 } = {}) => {
    cleanupSlot(slot);
    try {
      const serverId = dockerService.getActiveServerId();

      if (serverId === 'local') {
        // ---- Local: a shell inside the DockGate container ----
        if (!pty) { socket.emit('hostterm:error', { error: 'node-pty is not available in this build', slot }); return; }
        const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
        let startCwd = process.env.HOME || '/app';
        if (cwd && typeof cwd === 'string') { try { if (fs.statSync(cwd).isDirectory()) startCwd = cwd; } catch (e) {} }
        const ptyProc = pty.spawn(shell, [], {
          name: 'xterm-color', cols, rows,
          cwd: startCwd, env: process.env,
        });
        hostSessions.set(slot, { ptyProc });
        ptyProc.onData(d => socket.emit('hostterm:data', { data: d, slot }));
        ptyProc.onExit(() => { socket.emit('hostterm:end', { slot }); cleanupSlot(slot); });
        logAction({ socket, server: 'local', resourceType: 'system', resourceName: 'host-shell', action: 'hostterm_open', details: { target: 'local-container', shell, slot } });
        socket.emit('hostterm:ready', { target: 'local', host: 'DockGate container', slot });
        return;
      }

      // ---- Remote: an interactive SSH shell on the selected host ----
      const s = stmts.getServer.get(serverId);
      if (!s) { socket.emit('hostterm:error', { error: 'Active server not found', slot }); return; }
      const opts = { host: s.host, port: s.port || 22, username: s.username, readyTimeout: 20000, keepaliveInterval: 15000 };
      if (s.key_path) {
        const keyPath = path.isAbsolute(s.key_path) ? s.key_path : path.join(SSH_KEYS_DIR, s.key_path);
        if (!fs.existsSync(keyPath)) { socket.emit('hostterm:error', { error: `SSH key not found: ${keyPath}`, slot }); return; }
        opts.privateKey = fs.readFileSync(keyPath);
        if (s.passphrase) opts.passphrase = decrypt(s.passphrase);
      } else if (s.password) {
        opts.password = decrypt(s.password);
      } // else: agent — left to ssh2 defaults

      const conn = new Client();
      conn.on('ready', () => {
        conn.shell({ term: 'xterm-color', cols, rows }, (err, stream) => {
          if (err) { socket.emit('hostterm:error', { error: err.message, slot }); conn.end(); return; }
          hostSessions.set(slot, { sshConn: conn, sshStream: stream });
          stream.on('data', d => socket.emit('hostterm:data', { data: d.toString('utf8'), slot }));
          stream.stderr.on('data', d => socket.emit('hostterm:data', { data: d.toString('utf8'), slot }));
          stream.on('close', () => { socket.emit('hostterm:end', { slot }); cleanupSlot(slot); });
          logAction({ socket, server: serverId, resourceType: 'server', resourceName: serverId, action: 'hostterm_open', details: { host: s.host, slot } });
          socket.emit('hostterm:ready', { target: serverId, host: s.host, slot });
          if (cwd && typeof cwd === 'string') { const q = "'" + cwd.replace(/'/g, "'\\''") + "'"; try { stream.write('cd ' + q + '\n'); } catch (e) {} }
        });
      });
      conn.on('error', (err) => socket.emit('hostterm:error', { error: err.message, slot }));
      conn.connect(opts);
    } catch (err) {
      socket.emit('hostterm:error', { error: err.message, slot });
    }
  });

  socket.on('hostterm:input', (payload) => {
    const slot = (typeof payload === 'object' && payload !== null && payload.slot !== undefined) ? payload.slot : 0;
    const data = typeof payload === 'string' ? payload : payload?.data;
    const s = hostSessions.get(slot);
    if (!s || data === undefined) return;
    if (s.ptyProc) { try { s.ptyProc.write(data); } catch (e) {} }
    else if (s.sshStream) { try { s.sshStream.write(data); } catch (e) {} }
  });

  socket.on('hostterm:resize', (payload) => {
    const slot = (typeof payload === 'object' && payload !== null && payload.slot !== undefined) ? payload.slot : 0;
    const cols = payload?.cols;
    const rows = payload?.rows;
    const s = hostSessions.get(slot);
    if (!s || !cols || !rows) return;
    if (s.ptyProc) { try { s.ptyProc.resize(cols || 80, rows || 24); } catch (e) {} }
    else if (s.sshStream) { try { s.sshStream.setWindow(rows || 24, cols || 80, 0, 0); } catch (e) {} }
  });

  socket.on('hostterm:stop', (payload) => {
    const slot = (typeof payload === 'object' && payload !== null && payload.slot !== undefined) ? payload.slot : (typeof payload === 'number' ? payload : undefined);
    if (slot !== undefined) cleanupSlot(slot);
    else cleanupAll();
  });

  socket.on('disconnect', cleanupAll);
}

module.exports = { attachHostTerminal };
