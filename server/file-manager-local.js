// Local file manager — the same operations as file-manager.js (SFTP), on the machine DockGate runs on, but
// only inside FILES_ROOT (default /host). DockGate runs as root in its container, so it never browses the
// whole host: you share a folder on purpose, e.g. `- /srv:/host/srv` under the DockGate service's volumes.
// Every path is resolved with realpath and must stay inside FILES_ROOT, so a symlink cannot lead outside.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const remote = require('./file-manager'); // classifyArchive + extract (with a local runner)

const ROOT = path.resolve(process.env.FILES_ROOT || '/host');
const err = (msg, code = 400) => Object.assign(new Error(msg), { statusCode: code });

function rootReal() { try { return fs.realpathSync(ROOT); } catch (e) { return null; } }

/** Folders shared under FILES_ROOT (top level). Empty when nothing is mounted. */
function roots() {
  const r = rootReal();
  if (!r) return [];
  try { return fs.readdirSync(r, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => path.join(ROOT, e.name)); }
  catch (e) { return []; }
}
function available() { return roots().length > 0; }

/** Absolute path inside FILES_ROOT. mustExist: the path itself is checked (else its parent). */
function safe(p, { mustExist = true } = {}) {
  const r = rootReal();
  if (!r) throw err(`No folder is shared with DockGate under ${ROOT}`, 404);
  const want = remote.normRemote(p);
  const abs = want === '/' ? ROOT : (want === ROOT || want.startsWith(ROOT + '/') ? want : path.join(ROOT, want));
  const check = mustExist ? abs : path.dirname(abs);
  let real;
  try { real = fs.realpathSync(check); } catch (e) { throw err(mustExist ? 'No such file or folder' : 'The folder does not exist', 404); }
  if (real !== r && !real.startsWith(r + path.sep)) throw err('That path leads outside the folders shared with DockGate', 403);
  return abs;
}
const inside = (abs) => { const r = rootReal(); return !!r && (abs === ROOT || abs.startsWith(ROOT + '/')); };

function homeDir() { return Promise.resolve(ROOT); }

async function listDir(_s, p) {
  const dir = safe(p);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
    let st = null; try { st = fs.lstatSync(path.join(dir, e.name)); } catch (x) { /* vanished */ }
    const type = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
    return { name: e.name, type, size: st ? st.size : 0, mtime: st ? Math.floor(st.mtimeMs / 1000) : 0, mode: st ? st.mode : 0, uid: st ? st.uid : null, gid: st ? st.gid : null, owner: st ? String(st.uid) : '', group: st ? String(st.gid) : '' };
  }).sort((x, y) => x.type === y.type ? x.name.localeCompare(y.name) : (x.type === 'dir' ? -1 : 1));
  return { path: dir, entries };
}

async function downloadTo(_s, p, res) {
  const file = safe(p);
  const st = fs.statSync(file);
  if (!st.isFile()) throw err('Not a file');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file).replace(/"/g, '')}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  await new Promise((resolve, reject) => { const rs = fs.createReadStream(file); rs.on('error', reject); rs.on('end', resolve); rs.pipe(res); });
}

async function uploadFrom(_s, dir, name, req) {
  const dest = safe(remote.joinRemote(safe(dir), name), { mustExist: false });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    ws.on('error', reject); ws.on('close', resolve);
    req.on('error', reject); req.on('aborted', () => reject(new Error('upload aborted')));
    req.pipe(ws);
  });
  return { path: dest };
}

async function mkdir(_s, dir, name, opts = {}) {
  const target = safe(remote.joinRemote(safe(dir), name), { mustExist: false });
  if (fs.existsSync(target)) {
    if (opts.ensure && fs.statSync(target).isDirectory()) return { path: target, existed: true };
    throw err(fs.statSync(target).isDirectory() ? 'A folder with that name already exists' : 'A file with that name already exists', 409);
  }
  fs.mkdirSync(target);
  return { path: target, existed: false };
}
async function rename(_s, oldPath, newPath) { const o = safe(oldPath), n = safe(newPath, { mustExist: false }); fs.renameSync(o, n); return { from: o, to: n }; }
async function remove(_s, p, isDir) {
  const t = safe(p);
  if (t === ROOT || roots().includes(t)) throw err('A shared folder itself cannot be deleted here');
  if (isDir) fs.rmdirSync(t); else fs.unlinkSync(t);
  return { path: t };
}
async function removeRecursive(_s, p) {
  const t = safe(p);
  if (t === ROOT || roots().includes(t)) throw err('A shared folder itself cannot be deleted here');
  fs.rmSync(t, { recursive: true, force: true });
  return { path: t };
}
async function copy(_s, src, dest) {
  const s = safe(src), d = safe(dest, { mustExist: false });
  if (s === d) throw err('Source and destination are the same');
  fs.cpSync(s, d, { recursive: true, preserveTimestamps: true, errorOnExist: false });
  return { from: s, to: d };
}
async function move(_s, src, dest) {
  const s = safe(src), d = safe(dest, { mustExist: false });
  if (s === d) throw err('Source and destination are the same');
  try { fs.renameSync(s, d); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(s, d, { recursive: true, preserveTimestamps: true }); fs.rmSync(s, { recursive: true, force: true }); }
  return { from: s, to: d };
}

function listTree(_s, baseDir) {
  const base = safe(baseDir);
  const out = [];
  const walk = (dir, rel) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; } // unreadable: keep the siblings
    for (const e of list) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out.push({ path: r, type: 'dir', size: 0 }); walk(path.join(dir, e.name), r); }
      else { let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch (x) { /* gone */ } out.push({ path: r, type: 'file', size }); }
    }
  };
  walk(base, '');
  return Promise.resolve(out.sort((a, b) => a.path.localeCompare(b.path)));
}

async function readFileText(_s, p) {
  const file = safe(p);
  const st = fs.statSync(file);
  if (st.size > 2 * 1024 * 1024) return { isBinary: true, size: st.size };
  const buf = fs.readFileSync(file);
  const mtime = Math.floor(st.mtimeMs / 1000);
  return buf.subarray(0, 8000).includes(0) ? { isBinary: true, size: st.size, mtime } : { isBinary: false, size: st.size, mtime, content: buf.toString('utf8') };
}
/**
 * Never half written: a temporary file next to it gets the file's mode and owner, then replaces it in one rename.
 * (DockGate runs as root here, so owner and mode can always be kept; sudo is not needed.)
 */
async function writeFileText(_s, p, content, opts = {}) {
  const file = safe(p, { mustExist: false });
  let st = null; try { st = fs.statSync(file); } catch (e) { /* a new file */ }
  if (st && opts.baseMtime && !opts.force && Number(opts.baseMtime) !== Math.floor(st.mtimeMs / 1000)) {
    throw Object.assign(new Error(`${file} changed after you opened it — reload it, or save anyway`), { statusCode: 409, code: 'CHANGED' });
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.dg-${require('crypto').randomBytes(5).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, String(content), { encoding: 'utf8', mode: st ? st.mode & 0o7777 : 0o644 });
    if (st) { fs.chmodSync(tmp, st.mode & 0o7777); try { fs.chownSync(tmp, st.uid, st.gid); } catch (e) { /* not root: keeps ours */ } }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } throw e; }
  return { atomic: true };
}
const MODE_RE = /^[0-7]{3,4}$/;
const walkAll = (p, fn) => { fn(p); const st = fs.lstatSync(p); if (st.isDirectory()) for (const n of fs.readdirSync(p)) walkAll(path.join(p, n), fn); };
async function chmod(_s, p, mode, { recursive = false } = {}) {
  const file = safe(p);
  if (!MODE_RE.test(String(mode))) throw Object.assign(new Error('Mode: 3 or 4 octal digits, e.g. 644 or 0755'), { statusCode: 400 });
  const m = parseInt(mode, 8);
  if (recursive) walkAll(file, (x) => { if (!fs.lstatSync(x).isSymbolicLink()) fs.chmodSync(x, m); }); else fs.chmodSync(file, m);
  return { path: file, mode };
}
async function chown(_s, p, owner, group, { recursive = false } = {}) {
  const file = safe(p);
  const num = (v, what) => { if (!/^\d{1,10}$/.test(String(v))) throw Object.assign(new Error(`${what}: a number here (DockGate's container does not know the host's user names)`), { statusCode: 400 }); return Number(v); };
  const uid = num(owner, 'Owner'), gid = group === undefined || group === null || group === '' ? -1 : num(group, 'Group');
  const one = (x) => fs.lchownSync(x, uid, gid);
  if (recursive) walkAll(file, one); else one(file);
  return { path: file, owner, group: group || null };
}

function archiveDirTo(_s, dir, res) {
  const target = safe(dir);
  const parent = path.dirname(target), base = path.basename(target) || 'archive';
  return new Promise((resolve, reject) => {
    res.setHeader('Content-Disposition', `attachment; filename="${base.replace(/"/g, '')}.tar.gz"`);
    res.setHeader('Content-Type', 'application/gzip');
    const t = spawn('tar', ['czf', '-', '-C', parent, base]);
    t.on('error', reject); t.stderr.on('data', () => {});
    t.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
    t.stdout.pipe(res);
  });
}

// extract() from file-manager.js builds the same safe commands; here they run in DockGate's container.
const runLocal = (_s, cmd) => new Promise((resolve) => {
  execFile('sh', ['-c', cmd], { timeout: 11 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
});
async function extract(_s, archivePath, opts = {}) {
  const src = safe(archivePath);
  const r = await remote.extract(null, src, opts, runLocal);
  safe(r.path); // the destination is still inside the shared folders
  return r;
}

module.exports = {
  chmod, chown, safe,
  ROOT, roots, available, inside, listDir, downloadTo, uploadFrom, mkdir, rename, remove, normRemote: remote.normRemote, joinRemote: remote.joinRemote,
  homeDir, listTree, readFileText, writeFileText, removeRecursive, copy, move, archiveDirTo, extract, classifyArchive: remote.classifyArchive,
};
