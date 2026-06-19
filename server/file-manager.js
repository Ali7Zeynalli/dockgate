// Remote file manager (Phase 2) — browse/upload/download/mkdir/rename/delete on a remote SSH host via
// SFTP. DockGate already stores the key/password (same auth as host-terminal.js / docker.js). One SFTP
// session is opened per operation and closed after (no pooling yet). Local host is not handled here
// (Phase 3, deferred) — the route returns a "switch to a remote server" message for local.
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { decrypt } = require('./auth/secrets');
const remoteExec = require('./remote-compose'); // execRemote + shq — reused so SSH-exec/quoting isn't duplicated

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

// The remote user's home directory (absolute) — used as a friendly starting point for the folder picker.
function homeDir(server) {
  return withSftp(server, sftp => new Promise((resolve) => sftp.realpath('.', (e, abs) => resolve(e ? '/' : abs))));
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

// Recursively list a remote directory (flat, sorted) — for the project Files tree on a remote host.
function listTree(server, baseDir) {
  const base = normRemote(baseDir);
  return withSftp(server, sftp => new Promise((resolve, reject) => {
    const out = [];
    const walk = (dir, rel, cb) => {
      sftp.readdir(dir, (e, list) => {
        if (e) return cb(e);
        let i = 0;
        const next = () => {
          if (i >= list.length) return cb();
          const ent = list[i++];
          const r = rel ? rel + '/' + ent.filename : ent.filename;
          // A subdir we can't read (EACCES — e.g. a root-owned bind-mount dir, or .ssh) must NOT kill the
          // whole listing: list it, but skip its children and continue with the siblings.
          if (ent.attrs.isDirectory()) { out.push({ path: r, type: 'dir', size: 0 }); walk(dir + '/' + ent.filename, r, () => next()); }
          else { out.push({ path: r, type: 'file', size: ent.attrs.size }); next(); }
        };
        next();
      });
    };
    walk(base, '', (e) => e ? reject(e) : resolve(out.sort((a, b) => a.path.localeCompare(b.path))));
  }));
}

// Read a remote file as text (binary/oversized → metadata only), for the in-project editor.
function readFileText(server, p) {
  const file = normRemote(p);
  return withSftp(server, sftp => new Promise((resolve, reject) => {
    sftp.stat(file, (e, st) => {
      if (e) return reject(e);
      const size = st.size;
      if (size > 2 * 1024 * 1024) return resolve({ isBinary: true, size });
      const chunks = [];
      const rs = sftp.createReadStream(file);
      rs.on('data', d => chunks.push(d));
      rs.on('error', reject);
      rs.on('end', () => {
        const buf = Buffer.concat(chunks);
        const isBinary = buf.subarray(0, 8000).includes(0);
        resolve(isBinary ? { isBinary: true, size } : { isBinary: false, size, content: buf.toString('utf8') });
      });
    });
  }));
}

// Write text to a remote file (create/overwrite).
function writeFileText(server, p, content) {
  const file = normRemote(p);
  return withSftp(server, sftp => new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(file);
    ws.on('close', resolve); ws.on('error', reject);
    ws.end(Buffer.from(String(content), 'utf8'));
  }));
}

// ---- Heavier ops that need a shell (SFTP has no copy / recursive-delete / archive) ----

// Recursively delete a path. Tries the SSH user first; if root-owned leftovers block it (Docker bind-mount
// data dirs created as root), falls back to a throwaway root container — same trick as removeRemoteDir.
async function removeRecursive(server, p) {
  const target = normRemote(p);
  if (target === '/' || target.split('/').filter(Boolean).length < 1) {
    throw Object.assign(new Error('Refusing to delete an unsafe path'), { statusCode: 400 });
  }
  const r = await remoteExec.execRemote(server, `rm -rf ${remoteExec.shq(target)} 2>&1`);
  if (r.code === 0) return { path: target };
  // Root-owned leftovers → escalate via a root container, but only for a deep path (≥3 segments) so a
  // system/home root can never be mounted-and-wiped.
  if (target.split('/').filter(Boolean).length < 3) {
    throw Object.assign(new Error('Delete failed: ' + (r.stdout || r.stderr || '').trim()), { statusCode: 500 });
  }
  const parent = target.replace(/\/[^/]+$/, '') || '/';
  const base = target.split('/').pop();
  const dr = await remoteExec.execRemote(server, `docker run --rm -v ${remoteExec.shq(parent)}:/t alpine rm -rf ${remoteExec.shq('/t/' + base)} 2>&1`);
  if (dr.code !== 0) throw Object.assign(new Error('Delete failed (SSH user + root container both denied): ' + (dr.stdout || dr.stderr || r.stdout || '').trim()), { statusCode: 500 });
  return { path: target };
}

// Copy a file or directory (cp -a → recursive + preserves attrs/timestamps). dest is the full target path.
async function copy(server, src, dest) {
  const s = normRemote(src), d = normRemote(dest);
  if (s === d) throw Object.assign(new Error('Source and destination are the same'), { statusCode: 400 });
  const r = await remoteExec.execRemote(server, `cp -a ${remoteExec.shq(s)} ${remoteExec.shq(d)} 2>&1`);
  if (r.code !== 0) throw Object.assign(new Error('Copy failed: ' + (r.stdout || r.stderr || '').trim()), { statusCode: 500 });
  return { from: s, to: d };
}

// Move/rename a file or directory (mv -f → works across directories where SFTP rename may fail).
async function move(server, src, dest) {
  const s = normRemote(src), d = normRemote(dest);
  if (s === d) throw Object.assign(new Error('Source and destination are the same'), { statusCode: 400 });
  const r = await remoteExec.execRemote(server, `mv -f ${remoteExec.shq(s)} ${remoteExec.shq(d)} 2>&1`);
  if (r.code !== 0) throw Object.assign(new Error('Move failed: ' + (r.stdout || r.stderr || '').trim()), { statusCode: 500 });
  return { from: s, to: d };
}

// Stream a .tar.gz of a remote directory to an HTTP response so whole folders can be downloaded.
function archiveDirTo(server, dir, res) {
  const target = normRemote(dir);
  const parent = target.replace(/\/[^/]+$/, '') || '/';
  const base = target.split('/').pop() || 'archive';
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; try { conn.end(); } catch (e) {} err ? reject(err) : resolve(); };
    conn.on('ready', () => {
      conn.exec(`tar czf - -C ${remoteExec.shq(parent)} ${remoteExec.shq(base)}`, (err, stream) => {
        if (err) return done(err);
        res.setHeader('Content-Disposition', `attachment; filename="${base.replace(/"/g, '')}.tar.gz"`);
        res.setHeader('Content-Type', 'application/gzip');
        stream.on('error', done);
        stream.on('end', () => done());
        stream.stderr.on('data', () => {}); // ignore tar's "Removing leading /" notices
        stream.pipe(res);
      });
    });
    conn.on('error', done);
    try { conn.connect(authFor(server)); } catch (e) { done(e); }
  });
}

module.exports = {
  listDir, downloadTo, uploadFrom, mkdir, rename, remove, normRemote, joinRemote, homeDir, listTree,
  readFileText, writeFileText, removeRecursive, copy, move, archiveDirTo,
};
