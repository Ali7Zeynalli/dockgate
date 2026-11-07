// Integration tests for /api/auth — first-run setup gate, rate limit, session revocation.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-auth-test-'));

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

function makeApp(trust) {
  const app = express();
  app.use(express.json());
  app.set('trust proxy', trust);
  app.use('/api/auth', require('../../server/routes/auth'));
  const { requireAuth } = require('../../server/auth/middleware');
  app.get('/api/private', requireAuth, (req, res) => res.json({ ok: true }));
  return app;
}
// Requests from supertest arrive from loopback; trusting loopback lets a test pose as any client IP.
const app = makeApp('loopback');
const auth = require('../../server/routes/auth');
const cookieOf = (res) => (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

test('setup from the internet needs the setup token; from the local network it does not', async () => {
  const st = await request(app).get('/api/auth/status').set('X-Forwarded-For', '203.0.113.5');
  assert.strictEqual(st.body.setupTokenRequired, true);
  const denied = await request(app).post('/api/auth/setup').set('X-Forwarded-For', '203.0.113.5').send({ password: 'long-enough-1' });
  assert.strictEqual(denied.status, 403);
  const local = await request(app).get('/api/auth/status').set('X-Forwarded-For', '192.168.1.20');
  assert.strictEqual(local.body.setupTokenRequired, false);
  const ok = await request(app).post('/api/auth/setup').set('X-Forwarded-For', '203.0.113.5').send({ password: 'long-enough-1', setupToken: auth._test.SETUP_TOKEN });
  assert.strictEqual(ok.status, 200);
  const again = await request(app).post('/api/auth/setup').set('X-Forwarded-For', '192.168.1.20').send({ password: 'other-pass-22' });
  assert.strictEqual(again.status, 409, 'setup only once');
});

test('a password change signs out every other session; sign-out-everywhere ends all', async () => {
  const a = cookieOf(await request(app).post('/api/auth/login').send({ password: 'long-enough-1' }));
  const b = cookieOf(await request(app).post('/api/auth/login').send({ password: 'long-enough-1' }));
  assert.strictEqual((await request(app).get('/api/private').set('Cookie', b)).status, 200);
  const ch = await request(app).post('/api/auth/change-password').set('Cookie', a).send({ currentPassword: 'long-enough-1', newPassword: 'new-pass-333' });
  assert.strictEqual(ch.status, 200);
  const a2 = cookieOf(ch);
  assert.strictEqual((await request(app).get('/api/private').set('Cookie', b)).status, 401, 'the other device is signed out');
  assert.strictEqual((await request(app).get('/api/private').set('Cookie', a2)).status, 200, 'this device stays logged in');
  assert.strictEqual((await request(app).post('/api/auth/logout-all').set('Cookie', a2)).status, 200);
  assert.strictEqual((await request(app).get('/api/private').set('Cookie', a2)).status, 401);
});

test('login rate limit cannot be bypassed with a spoofed X-Forwarded-For when no proxy is trusted', async () => {
  const direct = makeApp(false);
  let last;
  for (let i = 0; i < 12; i++) last = await request(direct).post('/api/auth/login').set('X-Forwarded-For', `198.51.100.${i}`).send({ password: 'wrong' });
  assert.strictEqual(last.status, 429, 'all attempts count against the real peer address');
});
