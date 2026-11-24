'use strict';
// Server Console > Scripts: own code, scripts added from the server, the bash -n check, and a blocks script
// whose file was changed by hand (409 CHANGED). The "server" is this machine through shims (no sudo here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-scr-'));
const BIN = path.join(ROOT, 'bin'), HOME = path.join(ROOT, 'home'), TOOLS = path.join(ROOT, 'tools');
for (const d of [BIN, HOME, TOOLS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(BIN, 'sudo'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'id'), '#!/bin/bash\n[ "$1" = "-u" ] && echo 1000 && exit 0; /usr/bin/id "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'crontab'), `#!/bin/bash\n[ "$1" = "-l" ] && echo "0 3 * * * ${TOOLS}/nightly.sh >> /tmp/x.log 2>&1" && exit 0; exit 1\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, HOME };
const runLocal = (cmd) => new Promise((res) => execFile('bash', ['-c', cmd], { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(so), stderr: String(se) })));
const rcPath = require.resolve('../../server/remote-compose');
const realRc = require(rcPath);
require.cache[rcPath].exports = { ...realRc, execRemote: async (_s, cmd) => runLocal(cmd) };
const S = require('../../server/scripts');
const B = require('../../server/script-builder');
const SRV = { id: 'srv-code', name: 'p1', username: 'deploy' };

test('own code: written after bash -n, a syntax error writes nothing, runs and is deleted', async () => {
  await assert.rejects(S.createCode(SRV, { name: 'broken', code: 'if true; then\necho x\n' }), (e) => e.code === 'SYNTAX' && /syntax error/.test(e.message) && /broken\.sh/.test(e.message));
  assert.equal(S.list(SRV.id).some(s => s.name === 'broken'), false, 'nothing kept');
  assert.equal(fs.existsSync(path.join(HOME, '.dockgate/scripts/broken.sh')), false);
  const c = await S.createCode(SRV, { name: 'hello', title: 'Says hi', code: '#!/usr/bin/env bash\necho "hi $((2+3))"\n' });
  assert.equal(c.kind, 'code'); assert.equal(c.path, path.join(HOME, '.dockgate/scripts/hello.sh')); assert.equal(c.spec.root, false);
  const r = await S.run(SRV, c.id); assert.equal(r.code, 0); assert.match(r.output, /hi 5/);
  await assert.rejects(S.save(SRV, { name: 'hello', steps: [{ type: 'sleep', seconds: 1 }] }, c.id), /own code/);
  await S.remove(SRV, c.id); assert.equal(fs.existsSync(c.path), false);
});

test('blocks script changed on the server by hand: 409 CHANGED, then force or keep it as code', async () => {
  const s = await S.save(SRV, { name: 'tidy', steps: [{ type: 'sleep', seconds: 1 }] });
  assert.equal(s.kind, 'blocks'); assert.ok(s.hash);
  await S.save(SRV, { name: 'tidy', steps: [{ type: 'sleep', seconds: 2 }] }, s.id); // unchanged file: no question
  fs.appendFileSync(s.path, 'echo added-by-hand\n');
  await assert.rejects(S.save(SRV, { name: 'tidy', steps: [{ type: 'sleep', seconds: 3 }] }, s.id), (e) => e.statusCode === 409 && e.code === 'CHANGED' && /added-by-hand/.test(e.current));
  const f = await S.save(SRV, { name: 'tidy', steps: [{ type: 'sleep', seconds: 3 }] }, s.id, { force: true });
  assert.doesNotMatch(fs.readFileSync(f.path, 'utf8'), /added-by-hand/);
  fs.appendFileSync(f.path, 'echo mine\n');
  const c = S.toCode(SRV, s.id);
  assert.equal(c.kind, 'code'); assert.match(fs.readFileSync(c.path, 'utf8'), /echo mine/, 'the file stays as it is');
  await S.remove(SRV, s.id);
});

test('scripts already on the server: found (crontab ones too), added where they are, never deleted', async () => {
  const p = path.join(TOOLS, 'nightly.sh');
  fs.writeFileSync(p, '#!/bin/bash\necho nightly-ran\n', { mode: 0o755 });
  try { fs.chownSync(p, 65534, 65534); } catch (e) { /* not root: owned by this user already */ }
  const found = await S.discover(SRV);
  const hit = found.find(x => x.path === p);
  assert.ok(hit, 'found through the crontab'); assert.equal(hit.inCron, true); assert.ok(hit.size > 0);
  const a = await S.addExisting(SRV, { path: p });
  assert.equal(a.name, 'nightly'); assert.equal(a.kind, 'code'); assert.equal(a.spec.external, true); assert.equal(a.spec.root, false, 'not root-owned: runs as the SSH user'); assert.equal(a.path, p);
  assert.equal((await S.discover(SRV)).some(x => x.path === p), false, 'not offered again');
  await assert.rejects(S.addExisting(SRV, { path: p, name: 'again' }), /in the list already/);
  await assert.rejects(S.addExisting(SRV, { path: path.join(TOOLS, 'none.sh') }), /No such file/);
  await assert.rejects(S.addExisting(SRV, { path: 'relative.sh' }), /full path/);
  assert.match((await S.run(SRV, a.id)).output, /nightly-ran/);
  await S.remove(SRV, a.id);
  assert.ok(fs.existsSync(p), 'the file stays on the server');
});

test('Insert block: a block as plain shell that bash accepts', async () => {
  for (const step of [{ type: 'disk_check', path: '/', max: 90 }, { type: 'sleep', seconds: 2 }, { type: 'telegram', token: '123456:ABCdefghijklmnopqrstuvwxyz0123456', chat: '-1001234', text: 'x $(rm -rf /) done' }]) {
    const t = B.snippet(step);
    assert.match(t, /^# --- .+ \(DockGate block\) ---/);
    const r = await runLocal(`bash -n /dev/stdin <<'DGEOF'\n${t}\nDGEOF`);
    assert.equal(r.code, 0, r.stderr);
  }
  assert.throws(() => B.snippet({ type: 'nope' }), /Unknown block/);
});
