// Remote file manager (Phase 2) — browse/upload/download/mkdir/rename/delete on a remote SSH host via SFTP.
// Connections are POOLED per server (ssh-pool.js): DockGate connects once and reuses the session for many
// operations — the FileZilla model — instead of a fresh SSH handshake per op. Local host is not handled here
// (Phase 3, deferred) — the route returns a "switch to a remote server" message for local.
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');              // still used by archiveDirTo's own exec (tar) connection
const remoteExec = require('./remote-compose');  // execRemote + shq — reused so SSH-exec/quoting isn't duplicated
const pool = require('./ssh-pool');
const { withSftp, authFor } = pool;              // metadata ops go through the pooled connection

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
async function downloadTo(server, p, res) {
  const file = normRemote(p);
  const lease = await pool.acquire(server);
  return await new Promise((resolve, reject) => {
    let settled = false;
    // transport=true → the connection is suspect (stream broke / client aborted) → destroy the lease;
    // an app error (stat ENOENT) leaves the connection healthy → just release it.
    const done = (err, transport) => {
      if (settled) return; settled = true;
      if (err) { transport ? pool.destroyLease(lease) : pool.release(lease); reject(err); }
      else { pool.release(lease); resolve(); }
    };
    lease.sftp.stat(file, (e2, st) => {
      if (e2) return done(e2, false);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file).replace(/"/g, '')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      if (st && st.size) res.setHeader('Content-Length', st.size);
      const rs = lease.sftp.createReadStream(file);
      rs.on('error', (e) => done(e, true));
      rs.on('end', () => done());
      res.on('close', () => { if (!settled) done(new Error('client closed the connection'), true); }); // aborted mid-stream
      rs.pipe(res);
    });
  });
}

// Stream an incoming request body INTO a remote file (dir + filename).
async function uploadFrom(server, dir, name, req) {
  const dest = joinRemote(dir, name);
  const lease = await pool.acquire(server);
  return await new Promise((resolve, reject) => {
    let settled = false;
    // Any failure/abort DESTROYS the lease: the write stream leaves a dangling/partial file handle on the
    // channel, so the connection must not go back to the pool. No retry — the request body is already consumed.
    const done = (err) => {
      if (settled) return; settled = true;
      if (err) { pool.destroyLease(lease); reject(err); }
      else { pool.release(lease); resolve({ path: dest }); }
    };
    const ws = lease.sftp.createWriteStream(dest);
    ws.on('error', done);
    ws.on('close', () => done());
    req.on('error', done);
    req.on('aborted', () => done(new Error('upload aborted')));
    req.pipe(ws);
  });
}

async function mkdir(server, dir, name, opts = {}) {
  const target = joinRemote(dir, name);
  // Idempotent when opts.ensure (used by folder upload): treat an already-existing DIRECTORY as success.
  // SFTP v3 (OpenSSH) returns a generic SSH_FX_FAILURE for "already exists" — indistinguishable by code from
  // other errors — so we confirm with stat() (OpenSSH's own try-mkdir-then-stat pattern).
  const existed = await withSftp(server, sftp => new Promise((resolve, reject) => {
    sftp.mkdir(target, (e) => {
      if (!e) return resolve(false);              // freshly created
      if (!opts.ensure) return reject(e);         // strict (manual "+ Folder"): surface the error as before
      sftp.stat(target, (e2, st) => {
        if (!e2 && st.isDirectory()) return resolve(true);   // already a directory → success
        if (!e2) return reject(Object.assign(new Error('A file with that name already exists'), { statusCode: 409 }));
        reject(e);                                            // truly missing / other → the original mkdir error
      });
    });
  }));
  return { path: target, existed };
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

// ── Archive extraction (unzip / untar an uploaded archive on the remote host) ─────────────────────────
// Safe by construction: extracts into a NEW subfolder (default) via shell tools over SSH, with a hard
// timeout, tar's built-in '..'-rejection (no -P), and a post-extract symlink-containment scan. Zip uses
// only sanitizing extractors (unzip / python3 -m zipfile / bsdtar) — never an unguarded 7z/jar.
function classifyArchive(name) {
  const n = (name || '').toLowerCase();
  if (/\.(tar\.gz|tgz)$/.test(n)) return 'tgz';
  if (/\.(tar\.bz2|tbz2)$/.test(n)) return 'tbz2';
  if (/\.(tar\.xz|txz)$/.test(n)) return 'txz';
  if (/\.tar$/.test(n)) return 'tar';
  if (/\.zip$/.test(n)) return 'zip';
  if (/\.gz$/.test(n)) return 'gz';
  return null;
}
function mimeToKind(m) {
  if (/application\/zip/.test(m)) return 'zip';
  if (/application\/x-tar/.test(m)) return 'tar';
  if (/application\/(gzip|x-gzip)/.test(m)) return 'tgz';   // assume tar.gz; a bare .gz keeps its 'gz' extension path
  if (/application\/x-bzip2/.test(m)) return 'tbz2';
  if (/application\/x-xz/.test(m)) return 'txz';
  return null;
}
async function pickZipTool(server) {
  // First available SANITIZING zip extractor (unzip refuses out-of-dir; python zipfile sanitizes; bsdtar rejects '..').
  const r = await remoteExec.execRemote(server, `for t in unzip python3 bsdtar; do command -v "$t" >/dev/null 2>&1 && { echo "$t"; break; }; done`);
  return (r.stdout || '').trim() || null;
}

/**
 * Extract an archive on the remote host. opts: { here?, overwrite?, deleteAfter? }.
 * Default destination = a new subfolder named after the archive (safest). Returns { path: destDir }.
 */
async function extract(server, archivePath, opts = {}) {
  const src = normRemote(archivePath);
  const cwd = src.replace(/\/[^/]+$/, '') || '/';
  const base = src.split('/').pop() || 'archive';
  const shq = remoteExec.shq;
  const A = shq(src);

  // Classify by extension; fall back to magic bytes for unknown names.
  let kind = classifyArchive(base);
  if (!kind) {
    try { const m = await remoteExec.execRemote(server, `file -b --mime-type ${A} 2>/dev/null`); kind = mimeToKind((m.stdout || '').trim()); } catch (e) {}
  }
  if (!kind) throw Object.assign(new Error('Not a recognized archive (.zip, .tar, .tar.gz, .tar.bz2, .tar.xz, .gz)'), { statusCode: 400 });

  // Destination: a fresh subfolder named after the archive (default) or the current folder ("here").
  const stem = base.replace(/\.(tar\.(gz|bz2|xz)|tgz|tbz2|txz|tar|zip|gz)$/i, '') || 'extracted';
  const dest = opts.here ? cwd : joinRemote(cwd, stem);
  if (dest === '/' || dest.split('/').filter(Boolean).length < 1) throw Object.assign(new Error('Refusing to extract to the filesystem root'), { statusCode: 400 });
  const D = shq(dest);

  // Subfolder mode: refuse a non-empty existing target unless overwrite was chosen.
  if (!opts.here && !opts.overwrite) {
    const chk = await remoteExec.execRemote(server, `test -d ${D} && [ -n "$(ls -A ${D} 2>/dev/null)" ] && echo NONEMPTY || true`);
    if ((chk.stdout || '').includes('NONEMPTY')) throw Object.assign(new Error(`"${stem}" already exists and isn't empty — pick "overwrite" or a different archive name`), { statusCode: 409 });
  }

  const T = 600; // hard 10-min timeout (execRemote itself has no per-command timeout)
  let cmd;
  if (kind === 'zip') {
    const tool = await pickZipTool(server);
    if (!tool) throw Object.assign(new Error("No safe zip extractor on this server — install 'unzip' or 'python3', or upload a .tar.gz instead"), { statusCode: 422 });
    if (tool === 'unzip') cmd = `mkdir -p ${D} && timeout ${T} unzip ${opts.overwrite ? '-o' : '-n'} ${A} -d ${D} 2>&1`;
    else if (tool === 'python3') cmd = `mkdir -p ${D} && timeout ${T} python3 -m zipfile -e ${A} ${D} 2>&1`;
    else cmd = `mkdir -p ${D} && timeout ${T} bsdtar -x -C ${D} -f ${A} 2>&1`;
  } else if (kind === 'gz') {
    const out = shq(joinRemote(dest, base.replace(/\.gz$/i, '') || 'file'));
    cmd = `mkdir -p ${D} && timeout ${T} sh -c ${shq(`gzip -dc ${A} > ${out}`)} 2>&1`;
  } else {
    // -k = don't overwrite existing files (both GNU & busybox tar). No --no-same-owner (busybox lacks the
    // long option; it's a no-op for non-root anyway). tar rejects '..' members itself; -C confines output.
    const flag = kind === 'tgz' ? 'xzf' : kind === 'tbz2' ? 'xjf' : kind === 'txz' ? 'xJf' : 'xf';
    cmd = `mkdir -p ${D} && timeout ${T} tar ${opts.overwrite ? '' : '-k'} -C ${D} -${flag} ${A} 2>&1`;
  }

  const cleanup = async () => { if (!opts.here) await remoteExec.execRemote(server, `rm -rf ${D} 2>&1`).catch(() => {}); };
  const r = await remoteExec.execRemote(server, cmd);
  if (r.code !== 0) {
    await cleanup();
    throw Object.assign(new Error('Extract failed: ' + ((r.stdout || r.stderr || '').trim() || `exit ${r.code}`)), { statusCode: 500 });
  }

  // Containment scan: reject if the archive left any symlink pointing OUTSIDE the destination (tar/zip
  // block writes through symlinks but can still materialize an attacker-chosen out-of-tree symlink).
  const scan = await remoteExec.execRemote(server, `RD=$(readlink -f ${D}); find ${D} -type l 2>/dev/null | while IFS= read -r l; do t=$(readlink -f "$l" 2>/dev/null); case "$t" in "$RD"|"$RD"/*) ;; *) echo BAD ;; esac; done`);
  if ((scan.stdout || '').includes('BAD')) {
    await cleanup();
    throw Object.assign(new Error('Extract blocked: the archive contains a symlink pointing outside the target folder (possible attack)'), { statusCode: 400 });
  }

  if (opts.deleteAfter) await remoteExec.execRemote(server, `rm -f ${A} 2>&1`).catch(() => {});
  return { path: dest, kind };
}

module.exports = {
  listDir, downloadTo, uploadFrom, mkdir, rename, remove, normRemote, joinRemote, homeDir, listTree,
  readFileText, writeFileText, removeRecursive, copy, move, archiveDirTo, extract, classifyArchive,
};
