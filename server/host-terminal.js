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
  let sshConn = null;
  let sshStream = null;
  let ptyProc = null;

  function cleanup() {
    socket.removeAllListeners('hostterm:input');
    socket.removeAllListeners('hostterm:resize');
    try { if (sshStream) sshStream.end(); } catch (e) {}
    try { if (sshConn) sshConn.end(); } catch (e) {}
    try { if (ptyProc) ptyProc.kill(); } catch (e) {}
    sshConn = sshStream = ptyProc = null;
  }

  socket.on('hostterm:start', async ({ cols = 80, rows = 24, cwd = '' } = {}) => {
    cleanup();
    try {
      const serverId = dockerService.getActiveServerId();

      if (serverId === 'local') {
        // ---- Local: a shell inside the DockGate container ----
        if (!pty) { socket.emit('hostterm:error', { error: 'node-pty is not available in this build' }); return; }
        const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
        // Start in the project's folder when one is given and exists, else the home dir.
        let startCwd = process.env.HOME || '/app';
        if (cwd && typeof cwd === 'string') { try { if (fs.statSync(cwd).isDirectory()) startCwd = cwd; } catch (e) {} }
        ptyProc = pty.spawn(shell, [], {
          name: 'xterm-color', cols, rows,
          cwd: startCwd, env: process.env,
        });
        ptyProc.onData(d => socket.emit('hostterm:data', { data: d }));
        ptyProc.onExit(() => socket.emit('hostterm:end', {}));
        socket.on('hostterm:input', d => { try { ptyProc.write(d); } catch (e) {} });
        socket.on('hostterm:resize', ({ cols, rows }) => { try { ptyProc.resize(cols || 80, rows || 24); } catch (e) {} });
        logAction({ socket, server: 'local', resourceType: 'system', resourceName: 'host-shell', action: 'hostterm_open', details: { target: 'local-container', shell } });
        socket.emit('hostterm:ready', { target: 'local', host: 'DockGate container' });
        return;
      }

      // ---- Remote: an interactive SSH shell on the selected host ----
      const s = stmts.getServer.get(serverId);
      if (!s) { socket.emit('hostterm:error', { error: 'Active server not found' }); return; }
      const opts = { host: s.host, port: s.port || 22, username: s.username, readyTimeout: 20000, keepaliveInterval: 15000 };
      if (s.key_path) {
        const keyPath = path.isAbsolute(s.key_path) ? s.key_path : path.join(SSH_KEYS_DIR, s.key_path);
        if (!fs.existsSync(keyPath)) { socket.emit('hostterm:error', { error: `SSH key not found: ${keyPath}` }); return; }
        opts.privateKey = fs.readFileSync(keyPath);
        if (s.passphrase) opts.passphrase = decrypt(s.passphrase);
      } else if (s.password) {
        opts.password = decrypt(s.password);
      } // else: agent — left to ssh2 defaults

      const conn = new Client();
      conn.on('ready', () => {
        conn.shell({ term: 'xterm-color', cols, rows }, (err, stream) => {
          if (err) { socket.emit('hostterm:error', { error: err.message }); conn.end(); return; }
          sshConn = conn; sshStream = stream;
          stream.on('data', d => socket.emit('hostterm:data', { data: d.toString('utf8') }));
          stream.stderr.on('data', d => socket.emit('hostterm:data', { data: d.toString('utf8') }));
          stream.on('close', () => { socket.emit('hostterm:end', {}); cleanup(); });
          socket.on('hostterm:input', d => { try { stream.write(d); } catch (e) {} });
          socket.on('hostterm:resize', ({ cols, rows }) => { try { stream.setWindow(rows || 24, cols || 80, 0, 0); } catch (e) {} });
          logAction({ socket, server: serverId, resourceType: 'server', resourceName: serverId, action: 'hostterm_open', details: { host: s.host } });
          socket.emit('hostterm:ready', { target: serverId, host: s.host });
          // Open in the project's folder when one is given (ssh2 shell has no cwd option → cd on open;
          // single-quoted so the path can't break out of the command).
          if (cwd && typeof cwd === 'string') { const q = "'" + cwd.replace(/'/g, "'\\''") + "'"; try { stream.write('cd ' + q + '\n'); } catch (e) {} }
        });
      });
      conn.on('error', (err) => socket.emit('hostterm:error', { error: err.message }));
      conn.connect(opts);
    } catch (err) {
      socket.emit('hostterm:error', { error: err.message });
    }
  });

  socket.on('hostterm:stop', cleanup);
  socket.on('disconnect', cleanup);
}

module.exports = { attachHostTerminal };
