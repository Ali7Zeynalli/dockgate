// Remote file manager (Phase 2) — browse/upload/download/mkdir/rename/delete on a remote SSH host via
// SFTP. DockGate already stores the key/password (same auth as host-terminal.js / docker.js). One SFTP
// session is opened per operation and closed after (no pooling yet). Local host is not handled here
// (Phase 3, deferred) — the route returns a "switch to a remote server" message for local.
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const SSH_KEYS_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');

function authFor(s) {
  const opts = { host: s.host, port: s.port || 22, username: s.username, readyTimeout: 20000 };
  if (s.key_path) {
    const keyPath = path.isAbsolute(s.key_path) ? s.key_path : path.join(SSH_KEYS_DIR, s.key_path);
    if (!fs.existsSync(keyPath)) throw new Error(`SSH key not found: ${keyPath}`);
    opts.privateKey = fs.readFileSync(keyPath);
    if (s.passphrase) opts.passphrase = s.passphrase;
  } else if (s.password) {
    opts.password = s.password;
  }
  return opts;
}

// Open an SFTP session, run fn(sftp) → Promise, then always close the connection.
function withSftp(server, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (err, val) => { if (settled) return; settled = true; try { conn.end(); } catch (e) {} err ? reject(err) : resolve(val); };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return finish(err);
        Promise.resolve(fn(sftp)).then(v => finish(null, v)).catch(e => finish(e));
      });
    });
    conn.on('error', (e) => finish(e));
    try { conn.connect(authFor(server)); } catch (e) { finish(e); }
  });
}

// Normalize a remote absolute path, resolving '.'/'..' segments (can't escape '/').
function normRemote(p) {
  const raw = ('/' + String(p == null ? '/' : p)).replace(/\\/g, '/');
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}
function joinRemote(dir, name) {
  // name is a single segment — strip any slashes to keep it inside dir
  const clean = String(name || '').replace(/[/\\]/g, '').trim();
  if (!clean || clean === '.' || clean === '..') throw Object.assign(new Error('Invalid name'), { statusCode: 400 });
  return normRemote(dir + '/' + clean);
}

async function listDir(server, p) {
  const dir = normRemote(p);
  const list = await withSftp(server, sftp => new Promise((resolve, reject) => sftp.readdir(dir, (e, l) => e ? reject(e) : resolve(l))));
  const entries = list.map(e => {
    const a = e.attrs;
    const type = a.isDirectory() ? 'dir' : (typeof a.isSymbolicLink === 'function' && a.isSymbolicLink() ? 'link' : 'file');
    return { name: e.filename, type, size: a.size, mtime: a.mtime, mode: a.mode };
  }).sort((x, y) => x.type === y.type ? x.name.localeCompare(y.name) : (x.type === 'dir' ? -1 : 1));
  return { path: dir, entries };
}

// Stream a remote file to an HTTP response. Connection stays open until the stream ends.
function downloadTo(server, p, res) {
  const file = normRemote(p);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; try { conn.end(); } catch (e) {} err ? reject(err) : resolve(); };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return done(err);
        sftp.stat(file, (e2, st) => {
          if (e2) return done(e2);
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file).replace(/"/g, '')}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
          if (st && st.size) res.setHeader('Content-Length', st.size);
          const rs = sftp.createReadStream(file);
          rs.on('error', done);
          rs.on('end', () => done());
          rs.pipe(res);
        });
      });
    });
    conn.on('error', done);
    try { conn.connect(authFor(server)); } catch (e) { done(e); }
  });
}

// Stream an incoming request body INTO a remote file (dir + filename).
function uploadFrom(server, dir, name, req) {
  const dest = joinRemote(dir, name);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; try { conn.end(); } catch (e) {} err ? reject(err) : resolve({ path: dest }); };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return done(err);
        const ws = sftp.createWriteStream(dest);
        ws.on('error', done);
        ws.on('close', () => done());
        req.on('error', done);
        req.pipe(ws);
      });
    });
    conn.on('error', done);
    try { conn.connect(authFor(server)); } catch (e) { done(e); }
  });
}

async function mkdir(server, dir, name) {
  const target = joinRemote(dir, name);
  await withSftp(server, sftp => new Promise((resolve, reject) => sftp.mkdir(target, (e) => e ? reject(e) : resolve())));
  return { path: target };
}
async function rename(server, oldPath, newPath) {
  const o = normRemote(oldPath), n = normRemote(newPath);
  await withSftp(server, sftp => new Promise((resolve, reject) => sftp.rename(o, n, (e) => e ? reject(e) : resolve())));
  return { from: o, to: n };
}
async function remove(server, p, isDir) {
  const target = normRemote(p);
  if (target === '/') throw Object.assign(new Error('Refusing to delete /'), { statusCode: 400 });
  await withSftp(server, sftp => new Promise((resolve, reject) => {
    const cb = (e) => e ? reject(e) : resolve();
    if (isDir) sftp.rmdir(target, cb); else sftp.unlink(target, cb);
  }));
  return { path: target };
}

module.exports = { listDir, downloadTo, uploadFrom, mkdir, rename, remove, normRemote };
