// Integration tests for the compose project Files API (tree / dir / filecontent) on a local managed project.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-compose-files-test-'));

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/compose', require('../../server/routes/compose'));

const dir = path.join(process.env.DATA_DIR, 'compose', 'p1');
fs.mkdirSync(path.join(dir, 'conf'), { recursive: true });
fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
fs.writeFileSync(path.join(dir, 'conf', 'app.ini'), 'a=1\n');
fs.writeFileSync(path.join(dir, '.dockgate-git.json'), '{"token":"secret"}');
fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([1, 0, 2]));
fs.writeFileSync(path.join(process.env.DATA_DIR, 'outside.txt'), 'nope');

test('tree lists project files, hides protected ones, finds compose.yaml', async () => {
  const r = await request(app).get('/api/compose/p1/tree');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.composeFile, 'compose.yaml');
  const names = r.body.files.map(f => f.path);
  assert.deepStrictEqual(names, ['compose.yaml', 'conf', 'conf/app.ini', 'logo.bin']);
  assert.strictEqual((await request(app).get('/api/compose/nope/tree')).status, 404);
  assert.strictEqual((await request(app).get('/api/compose/bad..name/tree')).status, 400);
});

test('dir lists one folder', async () => {
  const r = await request(app).get('/api/compose/p1/dir').query({ sub: 'conf' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(JSON.stringify(r.body).includes('app.ini'));
});

test('filecontent: read text, binary flagged, traversal and protected files refused', async () => {
  const r = await request(app).get('/api/compose/p1/filecontent').query({ path: 'conf/app.ini' });
  assert.strictEqual(r.body.content, 'a=1\n');
  assert.strictEqual((await request(app).get('/api/compose/p1/filecontent').query({ path: 'logo.bin' })).body.isBinary, true);
  const esc = await request(app).get('/api/compose/p1/filecontent').query({ path: '../outside.txt' });
  assert.ok(!(esc.body.content || '').includes('nope'), 'cannot read outside the project');
  assert.strictEqual((await request(app).get('/api/compose/p1/filecontent').query({ path: '.dockgate-git.json' })).status, 400);
});

test('filecontent: write creates folders, delete removes, compose file cannot be deleted', async () => {
  assert.strictEqual((await request(app).put('/api/compose/p1/filecontent').send({ path: 'new/x.env', content: 'K=V' })).status, 200);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'new', 'x.env'), 'utf8'), 'K=V');
  assert.strictEqual((await request(app).put('/api/compose/p1/filecontent').send({ path: '.dockgate-deploy.json', content: '{}' })).status, 400);
  assert.strictEqual((await request(app).put('/api/compose/p1/filecontent').send({ path: 'a.txt' })).status, 400, 'content required');
  assert.strictEqual((await request(app).delete('/api/compose/p1/filecontent').query({ path: 'new/x.env' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'new', 'x.env')));
  assert.strictEqual((await request(app).delete('/api/compose/p1/filecontent').query({ path: 'compose.yaml' })).status, 400);
});
