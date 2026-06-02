// Integration tests for the /api/meta routes (settings, activity/audit).
// These mount only the settings router with an isolated temp DB — no Docker daemon needed.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-meta-test-'));

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.set('trust proxy', true);
app.use('/api/meta', require('../../server/routes/settings'));

test('GET /api/meta/version returns the package version', async () => {
  const res = await request(app).get('/api/meta/version');
  assert.strictEqual(res.status, 200);
  assert.match(res.body.version, /^\d+\.\d+\.\d+$/);
});

test('POST /api/meta/settings honours the allow-list and rejects active_server', async () => {
  const res = await request(app).post('/api/meta/settings')
    .send({ theme: 'light', active_server: 'HACK', evil: 'x' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual([...res.body.rejected].sort(), ['active_server', 'evil']);

  const get = await request(app).get('/api/meta/settings');
  assert.strictEqual(get.body.theme, 'light');          // allowed key applied
  assert.strictEqual(get.body.active_server, 'local');  // reserved key ignored (no drift)
});

test('timezone is an allowed setting and persists', async () => {
  await request(app).post('/api/meta/settings').send({ timezone: 'Asia/Tokyo' });
  const get = await request(app).get('/api/meta/settings');
  assert.strictEqual(get.body.timezone, 'Asia/Tokyo');
});

test('settings changes are recorded in the audit log with server + source IP', async () => {
  const res = await request(app).get('/api/meta/activity?type=system');
  assert.strictEqual(res.status, 200);
  const entry = res.body.find(r => r.action === 'settings_update');
  assert.ok(entry, 'a settings_update audit entry exists');
  assert.strictEqual(entry.server, 'local');
  assert.ok(entry.source_ip, 'source_ip is captured');
});

test('audit search matches the server column (the v2.0.5 search fix)', async () => {
  const res = await request(app).get('/api/meta/activity?q=local');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.length > 0, 'searching by server "local" returns rows');
});

test('audit search matches action/resource as well', async () => {
  const res = await request(app).get('/api/meta/activity?q=settings_update');
  assert.ok(res.body.some(r => r.action === 'settings_update'));
});

test('audit filter by action narrows results', async () => {
  const res = await request(app).get('/api/meta/activity?action=settings_update');
  assert.ok(res.body.length > 0);
  assert.ok(res.body.every(r => r.action === 'settings_update'));
});

test('GET /api/meta/activity/facets returns distinct filter values', async () => {
  const res = await request(app).get('/api/meta/activity/facets');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.types.includes('system'));
  assert.ok(res.body.servers.includes('local'));
  assert.ok(Array.isArray(res.body.actions));
});

test('clearing the audit log leaves a single activity_cleared entry', async () => {
  await request(app).delete('/api/meta/activity');
  const res = await request(app).get('/api/meta/activity');
  assert.strictEqual(res.body.length, 1);
  assert.strictEqual(res.body[0].action, 'activity_cleared');
});
