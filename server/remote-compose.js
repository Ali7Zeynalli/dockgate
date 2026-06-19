// Remote-native compose (deploy target = the remote server itself). When a remote SSH server is active,
// a project's files live ON THE REMOTE host (in a chosen folder) and `docker compose` runs there via SSH
// exec — so bind-mounts/build-contexts resolve on the remote and the files persist where they run.
// Reuses the same ssh2 auth as host-terminal.js / file-manager.js.
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { stmts } = require('./db');
const dockerService = require('./docker');
const { decrypt } = require('./auth/secrets');

const SSH_KEYS_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');

function authFor(s) {
  const opts = { host: s.host, port: s.port || 22, username: s.username, readyTimeout: 20000 };
  if (s.key_path) {
    const keyPath = path.isAbsolute(s.key_path) ? s.key_path : path.join(SSH_KEYS_DIR, s.key_path);
    if (!fs.existsSync(keyPath)) throw new Error(`SSH key not found: ${keyPath}`);
    opts.privateKey = fs.readFileSync(keyPath);
    if (s.passphrase) opts.passphrase = decrypt(s.passphrase);
  } else if (s.password) {
    opts.password = decrypt(s.password);
  }
  return opts;
}

// The active server config if it's a remote SSH host, else null (Local).
function getActiveRemoteServer() {
  const id = dockerService.getActiveServerId();
  if (!id || id === 'local') return null;
  return stmts.getServer.get(id) || null;
}

function withConn(server, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (err, val) => { if (settled) return; settled = true; try { conn.end(); } catch (e) {} err ? reject(err) : resolve(val); };
    conn.on('ready', () => { Promise.resolve(fn(conn)).then(v => finish(null, v)).catch(finish); });
    conn.on('error', finish);
    try { conn.connect(authFor(server)); } catch (e) { finish(e); }
  });
}

// Single-quote a string for safe use in a remote shell command.
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Run a shell command on the remote host. Returns { code, stdout, stderr }.
// onData (optional): called with each output chunk as it arrives, for live streaming to a job log.
function execRemote(server, cmd, onData) {
  return withConn(server, conn => new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errout = '';
      stream.on('data', d => { const s = d.toString(); out += s; if (onData) onData(s); });
      stream.stderr.on('data', d => { const s = d.toString(); errout += s; if (onData) onData(s); });
      stream.on('close', (code) => resolve({ code: code || 0, stdout: out, stderr: errout }));
    });
  }));
}

// Resolve a leading "~" to the remote user's $HOME so SFTP (which doesn't expand ~) gets an absolute path.
async function resolveRemotePath(server, p) {
  let s = String(p || '').trim();
  if (!s) s = '~/.dockgate/projects';
  if (s.startsWith('~')) {
    const r = await execRemote(server, 'printf %s "$HOME"');
    const home = (r.stdout || '').trim() || `/home/${server.username}`;
    s = s.replace(/^~(?=\/|$)/, home);
  }
  // collapse any accidental double slashes, strip trailing slash
  return ('/' + s).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}

// Is `docker compose` (v2) available on the remote host?
async function checkComposeAvailable(server) {
  const r = await execRemote(server, 'docker compose version --short 2>/dev/null || docker compose version 2>/dev/null');
  return r.code === 0 && !!(r.stdout || '').trim();
}

// Recursively upload a local directory's contents into a remote directory (SFTP). Dirs are pre-created
// with one `mkdir -p`. Returns the number of files uploaded.
async function uploadDirToRemote(server, localDir, remoteDir) {
  const files = [];
  const dirs = new Set();
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur).sort()) {
      const full = path.join(cur, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(full).isDirectory()) { dirs.add(r); walk(full, r); }
      else files.push({ full, rel: r });
    }
  };
  walk(localDir, '');
  const mkCmd = `mkdir -p ${shq(remoteDir)} ` + [...dirs].map(d => shq(remoteDir + '/' + d)).join(' ');
  const mk = await execRemote(server, mkCmd);
  if (mk.code !== 0) throw new Error('Remote mkdir failed: ' + (mk.stderr || mk.stdout || ''));
  await withConn(server, conn => new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      (async () => {
        for (const f of files) {
          await new Promise((res, rej) => {
            const ws = sftp.createWriteStream(remoteDir + '/' + f.rel);
            ws.on('close', res); ws.on('error', rej);
            fs.createReadStream(f.full).on('error', rej).pipe(ws);
          });
        }
        resolve();
      })().catch(reject);
    });
  }));
  return files.length;
}

// Run `docker compose` for a project in its remote folder. actionArgs is an array, e.g. ['up','-d'].
// Uses a DockGate-owned, WRITABLE DOCKER_CONFIG so `--build` doesn't fail when the user's ~/.docker is
// root-owned (e.g. a host previously used by Coolify/root → "buildx/.lock: permission denied"). Any
// existing registry auth (~/.docker/config.json) is copied in so private-image pulls still work.
async function runComposeInRemoteDir(server, remoteDir, project, actionArgs, onData) {
  const args = ['compose', '-p', project, ...actionArgs].map(shq).join(' ');
  const cfg = '"$HOME/.dockgate/.docker-config"';
  const prep = `mkdir -p ${cfg} && { cp -f "$HOME/.docker/config.json" ${cfg}/config.json 2>/dev/null; true; }`;
  const r = await execRemote(server, `cd ${shq(remoteDir)} && ${prep} && DOCKER_CONFIG=${cfg} docker ${args} 2>&1`, onData);
  if (r.code !== 0) {
    // When streaming, the full output already reached the job log — keep the thrown error short to avoid duplicating it.
    const e = new Error(onData ? ('compose exited with code ' + r.code) : (r.stdout || r.stderr || 'compose failed').trim());
    e.statusCode = 400; throw e;
  }
  return r.stdout || r.stderr || '';
}

// Recursively delete a remote directory. SAFETY: only deep, absolute paths (≥3 segments) — never '/',
// '/home', '/home/<user>', '/opt', etc. Always called with the path DockGate itself stored at deploy time.
async function removeRemoteDir(server, remoteDir) {
  const p = String(remoteDir || '').replace(/\/+$/, '');
  const segs = p.split('/').filter(Boolean);
  if (!p.startsWith('/') || p.includes('..') || segs.length < 3) {
    const e = new Error(`Refusing to delete an unsafe path: ${p || '(empty)'}`); e.statusCode = 400; throw e;
  }
  const r = await execRemote(server, `rm -rf ${shq(p)}`);
  if (r.code !== 0) { const e = new Error('Remote rm failed: ' + (r.stderr || r.stdout || '')); e.statusCode = 500; throw e; }
  return p;
}

module.exports = {
  getActiveRemoteServer, execRemote, resolveRemotePath, checkComposeAvailable,
  uploadDirToRemote, runComposeInRemoteDir, removeRemoteDir, shq,
};
