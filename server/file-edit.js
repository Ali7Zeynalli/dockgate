// Edit files inside a container or a volume: read a text file, save it, make a folder, rename, delete.
// Containers: through `exec` (the container must run) and putArchive for saving (keeps owner and mode).
// Volumes: through a throwaway helper container that mounts the volume read-write; saving uses putArchive
// on the helper before it starts, so nothing runs a shell with the file content.
// Paths are confined: '..' can not leave '/' (container) or the volume.
const tarStream = require('tar-stream');
const dockerService = require('./docker');

const MAX_EDIT = 1024 * 1024; // 1 MB: bigger files are downloaded, not edited here
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const docker = () => dockerService.docker;

function confine(p, { root = '/' } = {}) {
  const parts = [];
  for (const seg of String(p || '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return (root === '/' ? '' : root) + '/' + parts.join('/');
}
const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const VALID_NAME = (n) => !!n && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\0') && n.length <= 255;

/** One tar with one file: name, content (Buffer), mode, uid, gid. */
function tarOf(name, content, { mode = 0o644, uid = 0, gid = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const pack = tarStream.pack();
    const chunks = [];
    pack.on('data', c => chunks.push(c)); pack.on('end', () => resolve(Buffer.concat(chunks))); pack.on('error', reject);
    pack.entry({ name, mode, uid, gid, mtime: new Date() }, content, (err) => { if (err) return reject(err); pack.finalize(); });
  });
}

/** Run a command in a container; stdout and stderr apart, plus the exit code. */
async function execIn(c, id, cmd) {
  const exec = await c.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    const out = [], err = [];
    c.modem.demuxStream(stream, { write: d => out.push(d) }, { write: d => err.push(d) });
    stream.on('end', async () => {
      let code = null; try { code = (await exec.inspect()).ExitCode; } catch (e) { /* best effort */ }
      resolve({ out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8').trim(), code });
    });
    stream.on('error', reject);
  });
}

// ---- volume helper ----
async function helperRun(vol, cmd) {
  const c = docker();
  await dockerService.ensureHelperImage();
  const h = await c.createContainer({ Image: dockerService.VOL_HELPER_IMAGE, Cmd: cmd, HostConfig: { Binds: [`${vol}:/volume`] }, AttachStdout: true, AttachStderr: true, Tty: false, Labels: { 'dockgate.helper': 'file-edit' } });
  try {
    const stream = await h.attach({ stream: true, stdout: true, stderr: true });
    const out = [], err = [];
    c.modem.demuxStream(stream, { write: d => out.push(d) }, { write: d => err.push(d) });
    const ended = new Promise(r => stream.on('end', r));
    await h.start();
    const w = await h.wait();
    await Promise.race([ended, new Promise(r => setTimeout(r, 1000))]);
    return { out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8').trim(), code: w.StatusCode };
  } finally { await h.remove({ force: true }).catch(() => {}); }
}

// A shell script with the paths as $1/$2 (never interpolated): read, stat, mkdir, mv, rm.
const SCRIPTS = {
  stat: 'stat -c "%a %u %g %s %F" -- "$1"',
  read: `[ -f "$1" ] || { echo "not a file" >&2; exit 2; }; s=$(stat -c %s -- "$1"); [ "$s" -le ${MAX_EDIT} ] || { echo "too big to edit here ($s bytes) — download it" >&2; exit 3; }; cat -- "$1"`,
  mkdir: '[ ! -e "$1" ] || { echo "already exists" >&2; exit 2; }; mkdir -p -- "$1"',
  mv: '[ -e "$1" ] || { echo "not found" >&2; exit 2; }; [ ! -e "$2" ] || { echo "the new name already exists" >&2; exit 2; }; mv -- "$1" "$2"',
  rm: '[ -e "$1" ] || [ -L "$1" ] || { echo "not found" >&2; exit 2; }; rm -rf -- "$1"',
};
const sh = (script, ...args) => ['sh', '-c', script, 'sh', ...args];
function check(r, what) {
  if (r.code === 0) return r;
  const msg = r.err || `exit code ${r.code}`;
  if (/No such container|is not running/i.test(msg)) throw bad(409, 'The container must be running');
  if (/executable file not found|sh: not found|no such file or directory.*sh/i.test(msg)) throw bad(400, 'The container has no shell (sh) — files can only be downloaded and uploaded');
  throw bad(400, `${what}: ${msg}`);
}

/** target: { kind: 'container'|'volume', id }. Returns the runner for that target. */
function target(kind, id, client = null) {
  if (kind === 'container') {
    const c = client || docker();
    return {
      path: (p) => confine(p),
      run: async (script, ...args) => { try { return await execIn(c, id, sh(script, ...args)); } catch (e) { if (e.statusCode === 409) throw bad(409, 'The container must be running'); throw e; } },
      put: async (dir, tar) => c.getContainer(id).putArchive(tar, { path: dir }),
    };
  }
  if (kind === 'volume') {
    return {
      path: (p) => confine(p, { root: '/volume' }),
      run: (script, ...args) => helperRun(id, sh(script, ...args)),
      put: async (dir, tar) => {
        const c = docker();
        await dockerService.ensureHelperImage();
        const h = await c.createContainer({ Image: dockerService.VOL_HELPER_IMAGE, Cmd: ['true'], HostConfig: { Binds: [`${id}:/volume`] }, Labels: { 'dockgate.helper': 'file-edit' } });
        try { await h.putArchive(tar, { path: dir }); } finally { await h.remove({ force: true }).catch(() => {}); }
      },
    };
  }
  throw bad(400, 'kind must be container or volume');
}
const shown = (kind, p) => (kind === 'volume' ? p.replace(/^\/volume/, '') || '/' : p);

/** Read a text file (up to 1 MB). Binary files are refused. */
async function read(kind, id, path, { client } = {}) {
  const t = target(kind, id, client);
  const p = t.path(path);
  const r = check(await t.run(SCRIPTS.read, p), 'Read');
  if (r.out.includes(0)) throw bad(400, 'This is a binary file — download it instead');
  return { path: shown(kind, p), content: r.out.toString('utf8'), size: r.out.length };
}

/** Save a text file; an existing file keeps its owner and mode, a new one gets 0644 root. */
async function write(kind, id, path, content, { client } = {}) {
  const t = target(kind, id, client);
  const p = t.path(path);
  const name = baseOf(p);
  if (!VALID_NAME(name)) throw bad(400, 'Give a file name');
  const buf = Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length > MAX_EDIT) throw bad(400, 'More than 1 MB — upload the file instead');
  let meta = { mode: 0o644, uid: 0, gid: 0 };
  const st = await t.run(SCRIPTS.stat, p);
  if (st.code === 0) {
    const [mode, uid, gid, , ...type] = st.out.toString().trim().split(' ');
    if (!/regular/.test(type.join(' '))) throw bad(400, 'Not a regular file');
    meta = { mode: parseInt(mode, 8), uid: Number(uid), gid: Number(gid) };
  }
  try { await t.put(dirOf(p), await tarOf(name, buf, meta)); }
  catch (e) {
    if (e.statusCode === 404) throw bad(400, `The folder ${shown(kind, dirOf(p))} does not exist — make it first`);
    if (e.statusCode === 403 || /read-only/i.test(e.message)) throw bad(400, 'That place is read-only');
    throw e;
  }
  return { path: shown(kind, p), size: buf.length, created: st.code !== 0 };
}

async function mkdir(kind, id, path, { client } = {}) {
  const t = target(kind, id, client);
  const p = t.path(path);
  if (!VALID_NAME(baseOf(p))) throw bad(400, 'Give a folder name');
  check(await t.run(SCRIPTS.mkdir, p), 'New folder');
  return { path: shown(kind, p) };
}

async function rename(kind, id, path, newName, { client } = {}) {
  const t = target(kind, id, client);
  const p = t.path(path);
  if (!VALID_NAME(String(newName || ''))) throw bad(400, 'The new name can not contain /');
  const to = dirOf(p).replace(/\/$/, '') + '/' + newName;
  check(await t.run(SCRIPTS.mv, p, to), 'Rename');
  return { path: shown(kind, to) };
}

async function remove(kind, id, path, { client } = {}) {
  const t = target(kind, id, client);
  const p = t.path(path);
  if (p === '/' || p === '/volume' || p === '/volume/') throw bad(400, 'The top folder can not be deleted');
  if (kind === 'container' && /^\/(bin|sbin|lib|lib64|usr|etc|proc|sys|dev|boot|var|run)$/.test(p)) throw bad(400, `${p} is a system folder — it is not deleted here`);
  check(await t.run(SCRIPTS.rm, p), 'Delete');
  return { path: shown(kind, p) };
}

// ---- browse / download / upload a container on any Docker client (a Swarm task on another node) ----
const LIST_SCRIPT = `cd "$1" 2>/dev/null && for f in * .*; do [ "$f" = "." ] || [ "$f" = ".." ] || { [ -e "$f" ] && printf '%s\\t%s\\t%s\\n' "$([ -d "$f" ] && echo d || echo f)" "$(stat -c %s "$f" 2>/dev/null || echo 0)" "$f"; }; done`;
async function list(id, path, { client } = {}) {
  const c = client || docker();
  const p = confine(path || '/');
  const r = await execIn(c, id, sh(LIST_SCRIPT, p)).catch(e => { if (e.statusCode === 409) throw bad(409, 'The container must be running'); throw e; });
  const entries = r.out.toString('utf8').split('\n').filter(Boolean).map(line => {
    const i1 = line.indexOf('\t'), i2 = line.indexOf('\t', i1 + 1);
    if (i1 < 0 || i2 < 0) return null;
    return { type: line.slice(0, i1) === 'd' ? 'dir' : 'file', size: parseInt(line.slice(i1 + 1, i2)) || 0, name: line.slice(i2 + 1).replace(/\r$/, '') };
  }).filter(Boolean).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
  return { path: p, entries };
}
async function download(id, path, res, { client } = {}) {
  const c = client || docker();
  const p = confine(path);
  const exec = await c.getContainer(id).exec({ Cmd: ['cat', p], AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(baseOf(p) || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  const { Writable } = require('stream');
  c.modem.demuxStream(stream, res, new Writable({ write(x, e, cb) { cb(); } }));
  stream.on('end', () => { try { res.end(); } catch (e) { /* closed */ } });
  stream.on('error', () => { try { res.destroy(); } catch (e) { /* closed */ } });
}
async function upload(id, path, req, { client } = {}) {
  const c = client || docker();
  await c.getContainer(id).putArchive(req, { path: confine(path) });
  return { success: true };
}

module.exports = { read, write, mkdir, rename, remove, list, download, upload, confine, tarOf, MAX_EDIT };
