'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-fml-'));
const ROOT = path.join(BASE, 'host');
const OUTSIDE = path.join(BASE, 'secret');
fs.mkdirSync(path.join(ROOT, 'srv', 'app'), { recursive: true });
fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(OUTSIDE, 'passwd'), 'root:x');
fs.symlinkSync(OUTSIDE, path.join(ROOT, 'srv', 'escape'));
process.env.FILES_ROOT = ROOT;
const L = require('../../server/file-manager-local');

test('shared folders are listed; paths outside or through a symlink are refused', async () => {
  assert.ok(L.available());
  assert.deepEqual(L.roots(), [path.join(ROOT, 'srv')]);
  const top = await L.listDir(null, '/');
  assert.equal(top.path, ROOT);
  await assert.rejects(L.listDir(null, ROOT + '/srv/../../secret'), /outside|No such/);
  await assert.rejects(L.readFileText(null, ROOT + '/srv/escape/passwd'), /outside/);
  await assert.rejects(L.writeFileText(null, ROOT + '/srv/escape/new', 'x'), /outside/);
  await assert.rejects(L.listDir(null, '/etc'), /No such|outside/);
});

test('write, read, copy, move, delete inside a shared folder; the shared folder itself is protected', async () => {
  await L.writeFileText(null, ROOT + '/srv/app/a.txt', 'hello');
  assert.equal((await L.readFileText(null, ROOT + '/srv/app/a.txt')).content, 'hello');
  await L.copy(null, ROOT + '/srv/app/a.txt', ROOT + '/srv/app/b.txt');
  await L.move(null, ROOT + '/srv/app/b.txt', ROOT + '/srv/c.txt');
  assert.ok(fs.existsSync(path.join(ROOT, 'srv', 'c.txt')));
  const md = await L.mkdir(null, ROOT + '/srv', 'data', {});
  assert.equal(md.existed, false);
  assert.equal((await L.mkdir(null, ROOT + '/srv', 'data', { ensure: true })).existed, true);
  await L.removeRecursive(null, ROOT + '/srv/app');
  assert.ok(!fs.existsSync(path.join(ROOT, 'srv', 'app')));
  await assert.rejects(L.removeRecursive(null, ROOT + '/srv'), /shared folder itself/);
  const tree = await L.listTree(null, ROOT + '/srv');
  assert.ok(tree.some(e => e.path === 'c.txt'));
});
