'use strict';
// Connect to Git (server/git-connect.js) against real local repositories: compare leaves the folder alone,
// connect keeps ignored / untracked files and backs up what it replaces, undo restores, and the first push
// leaves secrets out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch (e) { return false; } })();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-gc-'));
process.env.DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
process.env.DG_GITCONNECT_ALLOW_FILE = '1';
const G = require('../../server/git-connect');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const w = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const r = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');

function repo(name, files) {
  const bare = path.join(root, name + '.git'); git(root, 'init', '-q', '--bare', bare);
  if (files) {
    const src = path.join(root, name + '-src'); git(root, 'init', '-q', src);
    for (const [f, s] of Object.entries(files)) w(src, f, s);
    git(src, 'add', '-A'); git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'); git(src, 'push', '-q', bare, 'HEAD:main');
  }
  return 'file://' + bare;
}
function folder(name, files) { const d = path.join(root, name); for (const [f, s] of Object.entries(files)) w(d, f, s); return d; }

test('safe folders only', () => {
  for (const d of ['/', '/etc', '/home', 'relative/x', '/srv/../etc', "/srv/a'b"]) assert.throws(() => G._safeDir(d));
  assert.equal(G._safeDir('/srv/app/'), '/srv/app');
});

test('check, compare, connect, pull, undo', { skip: !hasGit }, async () => {
  const url = repo('shop', { 'docker-compose.yml': 'services: {}\n', 'app.txt': 'v2\n', 'same.txt': 's\n', '.gitignore': 'data/\n.env\n', '.github/workflows/ci.yml': 'on: push\n' });
  const d = folder('shop-dir', { 'docker-compose.yml': 'services: {}\n', 'app.txt': 'v1 server\n', 'same.txt': 's\n', 'notes.txt': 'n\n', '.env': 'X=1\n', 'data/db': 'db\n', '.dockgate-deploy.json': '{}' });
  const t = await G.target('local', d);
  const c = await G.check(t, { repoUrl: url });
  assert.deepEqual(c.branches, ['main']); assert.equal(c.empty, false); assert.equal(c.isGit, false);

  const cmp = await G.compare(t, { repoUrl: url }, 'main', { composeRel: 'docker-compose.yml' });
  assert.deepEqual(cmp.differs, ['app.txt']);
  assert.deepEqual(cmp.onlyRepo.sort(), ['.github/workflows/ci.yml', '.gitignore']);
  assert.deepEqual(cmp.onlyServer, ['notes.txt']);
  assert.ok(cmp.ignored.includes('.env') && cmp.ignored.includes('data/'));
  assert.ok(!cmp.ignored.some(f => f.startsWith('.dockgate-')), 'DockGate records are not listed');
  assert.equal(cmp.composeInRepo, true);
  assert.equal(fs.existsSync(path.join(d, '.git')), false, 'compare does not touch the folder');
  assert.match((await G.diff(cmp.session, 'app.txt')).diff, /-v1 server[\s\S]*\+v2/);

  const res = await G.connect(cmp.session, {});
  assert.equal(res.replaced, 1); assert.equal(res.added, 2);
  assert.equal(r(d, 'app.txt'), 'v2\n');
  assert.equal(r(d, '.env'), 'X=1\n'); assert.equal(r(d, 'data/db'), 'db\n'); assert.equal(r(d, 'notes.txt'), 'n\n');
  assert.equal(git(d, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/main');
  assert.equal(git(d, 'status', '--porcelain').trim(), '?? notes.txt', '.dockgate files are excluded');

  // a new commit arrives -> git pull works in the folder
  const src = path.join(root, 'shop-src'); w(src, 'app.txt', 'v3\n'); git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'v3'); git(src, 'push', '-q', url.replace('file://', ''), 'HEAD:main');
  git(d, 'pull', '-q'); assert.equal(r(d, 'app.txt'), 'v3\n');

  const u = await G.undo(res.backup);
  assert.equal(u.restored, 1);
  assert.equal(fs.existsSync(path.join(d, '.git')), false);
  assert.equal(r(d, 'app.txt'), 'v1 server\n');
  assert.equal(fs.existsSync(path.join(d, '.gitignore')), false); assert.equal(fs.existsSync(path.join(d, '.github')), false);
  await assert.rejects(G.undo(res.backup), /undone already/);
});

test('keep the server version of a file', { skip: !hasGit }, async () => {
  const url = repo('keep', { 'a.txt': 'repo\n' });
  const d = folder('keep-dir', { 'a.txt': 'server\n' });
  const t = await G.target('local', d);
  const cmp = await G.compare(t, { repoUrl: url }, 'main');
  const res = await G.connect(cmp.session, { keep: ['a.txt'] });
  assert.deepEqual(res.kept, ['a.txt']); assert.equal(res.localChanges, 1);
  assert.equal(r(d, 'a.txt'), 'server\n');
});

test('compare refuses a folder that is a checkout already, and a missing branch', { skip: !hasGit }, async () => {
  const url = repo('br', { 'x': '1' });
  const d = folder('br-dir', { 'x': '1' });
  const t = await G.target('local', d);
  await assert.rejects(G.compare(t, { repoUrl: url }, 'nope'), /Fetching branch nope failed/);
  git(d, 'init', '-q');
  await assert.rejects(G.compare(t, { repoUrl: url }, 'main'), /Git checkout already/);
});

test('first push to an empty repository leaves secrets and data out', { skip: !hasGit }, async () => {
  const url = repo('empty');
  const d = folder('push-dir', { 'docker-compose.yml': 'services: {}\n', '.env': 'X=1\n', 'data/db': 'db\n', 'src/app.js': 'x\n' });
  const t = await G.target('local', d);
  const c = await G.check(t, { repoUrl: url }); assert.equal(c.empty, true);
  const gi = await G.suggestGitignore(t); assert.equal(gi.exists, false); assert.match(gi.text, /^\.env$/m); assert.match(gi.text, /^data\/$/m);
  const pv = await G.initPreview(t, gi.text); assert.deepEqual(pv.files.sort(), ['docker-compose.yml', 'src/app.js']);
  await assert.rejects(G.initPush(t, { repoUrl: url }, { name: '', email: 'x' }), /name/);
  const res = await G.initPush(t, { repoUrl: url }, { branch: 'main', name: 'Ann', email: 'ann@x.io' });
  assert.equal(res.files, 3); assert.equal(res.wroteGitignore, true);
  const pushed = git(root, '--git-dir', url.replace('file://', ''), 'ls-tree', '-r', '--name-only', 'main').trim().split('\n').sort();
  assert.deepEqual(pushed, ['.gitignore', 'docker-compose.yml', 'src/app.js']);
  assert.equal(git(root, '--git-dir', url.replace('file://', ''), 'log', '-1', '--format=%an <%ae>', 'main').trim(), 'Ann <ann@x.io>');
  await assert.rejects(G.initPush(t, { repoUrl: url }, { branch: 'main', name: 'Ann', email: 'ann@x.io' }), /Git checkout already/);
});

test('a secret file not in .gitignore stops the first push', { skip: !hasGit }, async () => {
  const url = repo('sec');
  const d = folder('sec-dir', { 'app.js': 'x', 'server.pem': 'KEY', '.gitignore': 'node_modules/\n' });
  const t = await G.target('local', d);
  await assert.rejects(G.initPush(t, { repoUrl: url }, { name: 'Ann', email: 'a@b.c' }), /look like secrets/);
  assert.equal(fs.existsSync(path.join(d, '.git')), false);
});

test('tokens are hidden in messages', () => {
  assert.equal(G.redact('fatal: https://ghp_abc123@github.com/o/r', { token: 'ghp_abc123' }), 'fatal: https://***@github.com/o/r');
  assert.equal(G.redact('x ghp_abc123 y', { token: 'ghp_abc123' }), 'x *** y');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
