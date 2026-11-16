'use strict';
// Tools → Files editor: atomic writes that keep mode and owner (remote over a fake SFTP, local on disk),
// the "changed after you opened it" check, sudo errors, chmod / chown input checks, earlier versions, line diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');
const { Writable } = require('stream');

// ---- a fake SFTP server in memory: files { data, mode, uid, gid, mtime } ----
const files = new Map();
const opts = { denyDirWrite: false, denyChown: false, noRename: false };
const execs = [];
let execReply = () => ({ code: 0, stdout: '' });
const ME = 1000;
function fakeSftp() {
  const err = (code, msg) => Object.assign(new Error(msg), { code });
  return {
    stat(p, cb) { const f = files.get(p); f ? cb(null, { ...f, size: f.data.length }) : cb(err(2, 'No such file')); },
    createWriteStream(p, o = {}) {
      const chunks = [];
      const ws = new Writable({ emitClose: false, write(c, _e, done) { chunks.push(c); done(); } });
      const dir = path.posix.dirname(p), existing = files.get(p);
      ws.on('finish', () => {
        if (!existing && opts.denyDirWrite && !dir.startsWith('/tmp')) { ws.emit('error', err(3, 'Permission denied')); return; }
        if (existing && existing.uid !== ME && !(existing.mode & 0o002)) { ws.emit('error', err(3, 'Permission denied')); return; }
        const data = Buffer.concat(chunks);
        if (existing) Object.assign(existing, { data, mtime: existing.mtime + 1 });
        else files.set(p, { data, mode: o.mode ?? 0o644, uid: ME, gid: ME, mtime: 100 });
        ws.emit('close');
      });
      return ws;
    },
    chmod(p, m, cb) { const f = files.get(p); if (f) f.mode = m; cb(null); },
    setstat(p, a, cb) { if (opts.denyChown) return cb(err(3, 'Permission denied')); const f = files.get(p); Object.assign(f, { uid: a.uid, gid: a.gid }); cb(null); },
    unlink(p, cb) { files.delete(p); cb(null); },
    ext_openssh_rename(a, b, cb) { if (opts.noRename) return cb(err(8, 'unsupported')); const f = files.get(a); files.delete(a); files.set(b, { ...f, mtime: f.mtime + 1 }); cb(null); },
  };
}
const poolPath = require.resolve('../../server/ssh-pool');
const rcPath = require.resolve('../../server/remote-compose');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { withSftp: async (_s, fn) => fn(fakeSftp()), authFor: () => ({}) } };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
require.cache[rcPath] = { id: rcPath, filename: rcPath, loaded: true, exports: { shq, execRemote: async (_s, cmd) => { execs.push(cmd); return execReply(cmd); } } };
const R = require('../../server/file-manager');
const SRV = { id: 's1' };
const reset = () => { files.clear(); Object.assign(opts, { denyDirWrite: false, denyChown: false, noRename: false }); execs.length = 0; execReply = () => ({ code: 0, stdout: '' }); };

test('remote: a save goes through a temporary file and keeps mode and owner', async () => {
  reset();
  files.set('/srv/app/nginx.conf', { data: Buffer.from('old'), mode: 0o640, uid: 33, gid: 33 | 0, mtime: 50 });
  files.get('/srv/app/nginx.conf').mode = 0o646; // others may write → the SSH user may write it
  const r = await R.writeFileText(SRV, '/srv/app/nginx.conf', 'new');
  const f = files.get('/srv/app/nginx.conf');
  assert.equal(r.atomic, true);
  assert.equal(f.data.toString(), 'new');
  assert.equal(f.mode, 0o646);
  assert.deepEqual([f.uid, f.gid], [33, 33]);
  assert.equal([...files.keys()].filter(k => k.includes('.dg-')).length, 0, 'no temporary file left behind');
});

test('remote: when the owner can not be kept the file is written in place (owner stays)', async () => {
  reset(); opts.denyChown = true;
  files.set('/srv/www/index.html', { data: Buffer.from('a'), mode: 0o666, uid: 33, gid: 33, mtime: 50 });
  const r = await R.writeFileText(SRV, '/srv/www/index.html', 'b');
  assert.equal(r.atomic, false);
  const f = files.get('/srv/www/index.html');
  assert.equal(f.data.toString(), 'b'); assert.equal(f.uid, 33);
  assert.equal([...files.keys()].filter(k => k.includes('.dg-')).length, 0);
});

test('remote: a folder the user may not write but a writable file → in place; no rename support → mv', async () => {
  reset(); opts.denyDirWrite = true;
  files.set('/etc/app.conf', { data: Buffer.from('a'), mode: 0o644, uid: ME, gid: ME, mtime: 50 });
  assert.equal((await R.writeFileText(SRV, '/etc/app.conf', 'b')).atomic, false);
  assert.equal(files.get('/etc/app.conf').data.toString(), 'b');
  reset(); opts.noRename = true;
  files.set('/srv/x.txt', { data: Buffer.from('a'), mode: 0o644, uid: ME, gid: ME, mtime: 50 });
  await R.writeFileText(SRV, '/srv/x.txt', 'b');
  assert.ok(execs.some(c => /^mv -f '\/srv\/\.x\.txt\.dg-[0-9a-f]+' '\/srv\/x\.txt'$/.test(c)), execs.join('\n'));
});

test('remote: a file of another user → 403 EACCES (the UI offers sudo); changed since opened → 409 CHANGED', async () => {
  reset();
  files.set('/etc/nginx/nginx.conf', { data: Buffer.from('a'), mode: 0o644, uid: 0, gid: 0, mtime: 50 });
  opts.denyChown = true;
  await assert.rejects(R.writeFileText(SRV, '/etc/nginx/nginx.conf', 'b'), (e) => e.code === 'EACCES' && e.statusCode === 403);
  assert.equal(files.get('/etc/nginx/nginx.conf').data.toString(), 'a');
  files.set('/srv/a', { data: Buffer.from('a'), mode: 0o644, uid: ME, gid: ME, mtime: 77 });
  await assert.rejects(R.writeFileText(SRV, '/srv/a', 'b', { baseMtime: 70 }), (e) => e.code === 'CHANGED' && e.statusCode === 409);
  assert.equal(files.get('/srv/a').data.toString(), 'a');
  await R.writeFileText(SRV, '/srv/a', 'b', { baseMtime: 70, force: true });
  assert.equal(files.get('/srv/a').data.toString(), 'b');
});

test('remote sudo: read via base64, save keeps owner/mode in one mv; a password prompt → code SUDO', async () => {
  reset();
  execReply = (c) => c.includes('stat -c') ? { code: 0, stdout: '5 123\n' } : { code: 0, stdout: Buffer.from('hello').toString('base64') };
  const rd = await R.readFileText(SRV, '/etc/shadowish', { sudo: true });
  assert.equal(rd.content, 'hello'); assert.equal(rd.mtime, 123);
  execReply = () => ({ code: 0, stdout: '' });
  await R.writeFileText(SRV, "/etc/it's.conf", 'x', { sudo: true });
  const script = execs.find(c => c.includes('sudo -n mv -f'));
  assert.match(script, /sudo -n chown "\$O"/); assert.match(script, /sudo -n chmod "\$M"/);
  assert.ok(script.includes(`'/etc/it'\\''s.conf'`), 'path is quoted');
  execReply = () => ({ code: 1, stdout: 'sudo: a password is required' });
  await assert.rejects(R.writeFileText(SRV, '/etc/a', 'x', { sudo: true }), (e) => e.code === 'SUDO');
});

test('chmod / chown: input is checked before anything runs', async () => {
  reset();
  await assert.rejects(R.chmod(SRV, '/srv/a', '7777x'), /octal/);
  await assert.rejects(R.chmod(SRV, '/srv/a', '644; rm -rf /'), /octal/);
  await assert.rejects(R.chown(SRV, '/srv/a', 'root;id', ''), /name or number/);
  await assert.rejects(R.chown(SRV, '/srv/a', 'www-data', '$(id)'), /name or number/);
  assert.equal(execs.length, 0);
  await R.chmod(SRV, '/srv/a', '0755', { recursive: true, sudo: true });
  await R.chown(SRV, '/srv/a', 'www-data', 'www-data');
  assert.deepEqual(execs, ["sudo -n chmod -R 0755 '/srv/a' 2>&1", "sudo -n chown www-data:www-data '/srv/a' 2>&1"]);
  execReply = () => ({ code: 1, stdout: "chmod: changing permissions of '/srv/a': Operation not permitted" });
  await assert.rejects(R.chmod(SRV, '/srv/a', '644'), (e) => e.code === 'EACCES');
});

// ---- local (FILES_ROOT) ----
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-fes-'));
const ROOT = path.join(BASE, 'host');
fs.mkdirSync(path.join(ROOT, 'srv', 'app'), { recursive: true });
process.env.FILES_ROOT = ROOT;
const L = require('../../server/file-manager-local');

test('local: atomic save keeps the mode; changed since opened → CHANGED; chmod / chown', async () => {
  const f = path.join(ROOT, 'srv/app/run.sh');
  fs.writeFileSync(f, 'echo 1'); fs.chmodSync(f, 0o750);
  const rd = await L.readFileText(null, f);
  await L.writeFileText(null, f, 'echo 2', { baseMtime: rd.mtime });
  assert.equal(fs.readFileSync(f, 'utf8'), 'echo 2');
  assert.equal(fs.statSync(f).mode & 0o7777, 0o750);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(n => n.includes('.dg-')), []);
  await assert.rejects(L.writeFileText(null, f, 'x', { baseMtime: rd.mtime - 60 }), (e) => e.code === 'CHANGED');
  await L.chmod(null, f, '700'); assert.equal(fs.statSync(f).mode & 0o7777, 0o700);
  await assert.rejects(L.chmod(null, f, 'abc'), /octal/);
  await assert.rejects(L.chown(null, f, 'root', ''), /number/i);
  const me = os.userInfo();
  await L.chown(null, f, String(me.uid), String(me.gid));
  const ls = await L.listDir(null, path.join(ROOT, 'srv/app'));
  const e = ls.entries.find(x => x.name === 'run.sh');
  assert.equal(e.uid, me.uid); assert.equal(e.mode & 0o777, 0o700);
});

test('versions: kept encrypted, last 5 only, per server, large ones skipped', () => {
  const V = require('../../server/file-versions');
  for (let i = 1; i <= 7; i++) V.save('s1', '/etc/a.conf', `v${i}`);
  V.save('s2', '/etc/a.conf', 'other server');
  const l = V.list('s1', '/etc/a.conf');
  assert.equal(l.length, 5);
  assert.equal(V.get('s1', l[0].id).content, 'v7');
  assert.equal(V.get('s1', l[4].id).content, 'v3');
  assert.equal(V.get('s2', l[0].id), null, 'another server can not read it');
  const raw = require('../../server/db').db.prepare('SELECT content FROM file_versions LIMIT 1').get().content;
  assert.ok(!/^v\d$/.test(raw), 'stored encrypted');
  assert.equal(V.save('s1', '/big', 'x'.repeat(V.MAX + 1)), false);
});

test('editor diff: only changed lines with a little context', () => {
  const ctx = { window: {}, escapeHtml: (s) => s };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/file-editor.js'), 'utf8'), ctx);
  const d = ctx.window.FileEditor.diffLines('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nE\nf\ng\nh\ni');
  assert.deepEqual(JSON.parse(JSON.stringify(d.filter(x => x.t !== ' ').map(x => x.t + x.s))), ['-e', '+E', '+i']);
  assert.ok(d.length <= 12);
  assert.equal(ctx.window.FileEditor.diffLines('x', 'x').filter(x => x.t !== ' ').length, 0);
});
