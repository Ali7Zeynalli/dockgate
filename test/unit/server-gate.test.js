'use strict';
// A server's access password, per DockGate session (server/auth/server-gate.js): every way into a locked server
// — the APIs of the server in use, /api/servers/<id>/…, websocket streams — needs this session to have typed it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stmts } = require('../../server/db');
const { hashPassword } = require('../../server/auth/password');
const gate = require('../../server/auth/server-gate');
const G = require('../../server/proxy-gen');

const addServer = (id, pass) => {
  stmts.insertServer.run(id, 'ssh', '10.0.0.9', 22, 'u', null, null, null, '', null, 1);
  if (pass) { const { salt, hash } = hashPassword(pass); stmts.setServerAccessPass.run(`${salt}:${hash}`, id); }
};
const req = (path, token) => ({ path, headers: { cookie: token ? `dg_session=${token}` : '' } });
const run = (r) => { let out = null; gate.requireServerGate(r, { status: (c) => ({ json: (b) => { out = { c, b }; return out; } }) }, () => { out = 'next'; }); return out; };

test('a locked server is refused until this session unlocks it; other sessions stay locked', () => {
  try { addServer('gated-1', 'secret'); addServer('open-1', null); } catch (e) { assert.fail(`addServer: ${e.message}`); }
  assert.equal(gate.isGated('gated-1'), true); assert.equal(gate.isGated('open-1'), false); assert.equal(gate.isGated('local'), false);
  const a = 'payload.sigA', b = 'payload.sigB';
  const r1 = run(req('/servers/gated-1/cron', a));
  assert.equal(r1.c, 403); assert.equal(r1.b.needsAccessPassword, true); assert.equal(r1.b.serverId, 'gated-1');
  assert.equal(run(req('/servers/open-1/cron', a)), 'next');
  assert.equal(run(req('/servers/gated-1/unlock', a)), 'next', 'the unlock route itself is open');
  assert.equal(run(req('/servers/gated-1/host/stats', a)), 'next', 'dashboard health numbers are open');
  gate.unlock(gate.keyOf(a), 'gated-1');
  assert.equal(run(req('/servers/gated-1/cron', a)), 'next');
  assert.equal(run(req('/servers/gated-1/cron', b)).c, 403, 'another session is still locked');
  gate.forget(gate.keyOf(a));
  assert.equal(run(req('/servers/gated-1/cron', a)).c, 403, 'signing out locks it again');
});

test('the unlock expires after 12 hours', () => {
  const k = gate.keyOf('payload.sigC'); gate.unlock(k, 'gated-1');
  gate._unlocked.get(k).set('gated-1', Date.now() - gate.TTL_MS - 1000);
  assert.equal(gate.isUnlocked(k, 'gated-1'), false);
});

test('APIs that do not work on the server in use are not gated', () => {
  assert.equal(run(req('/servers', 'payload.sigD')), 'next');
  assert.equal(run(req('/help/doc/proxies', 'payload.sigD')), 'next');
  assert.equal(run(req('/meta/settings', 'payload.sigD')), 'next');
});

test('nginxAddHttps / nginxEnsureAcme use the ports the proxy listens on', () => {
  const t = 'server {\n  listen 8080;\n  server_name a.test;\n  location / { proxy_pass http://x:1; }\n}\n';
  const r = G.nginxAddHttps(t, 'a.test', '/c.pem', '/k.pem', { redirect: true, httpPort: 8080, httpsPort: 8443 });
  assert.deepEqual((r.text || r).match(/listen [^;]*;/g), ['listen 8080;', 'listen 8443 ssl;']);
  const tlsOnly = 'server {\n  listen 8443 ssl;\n  server_name b.test;\n  ssl_certificate /c; ssl_certificate_key /k;\n}\n';
  assert.match(G.nginxEnsureAcme(tlsOnly, 'b.test', { httpPort: 8080 }).text, /listen 8080;/);
});
