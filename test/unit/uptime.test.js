'use strict';
// Observe → Uptime: settings checks, probes against local servers (HTTP, HTTPS, TCP), the down / up / slow /
// certificate rules, results, incidents, uptime figures and alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'); const https = require('https'); const net = require('net');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../../server/uptime-probe');

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('settings are checked and cleaned', () => {
  const v = P.normalize({ type: 'http', target: 'https://example.com/health', config: { expect: '200,301', timeout: 5 }, interval: 60, fails: 2 });
  assert.equal(v.name, 'https://example.com/health');
  assert.equal(v.config.certAlerts, true);
  assert.throws(() => P.normalize({ type: 'http', target: 'ftp://x' }), /http/);
  assert.throws(() => P.normalize({ type: 'http', target: 'https://x', config: { expect: 'abc' } }), /Expected status/);
  assert.throws(() => P.normalize({ type: 'http', target: 'https://x', interval: 5 }), /30 seconds/);
  assert.equal(P.normalize({ type: 'tcp', target: 'db.internal:5432' }).target, 'db.internal:5432');
  assert.throws(() => P.normalize({ type: 'tcp', target: 'db.internal' }), /Port/);
  assert.equal(P.normalize({ type: 'ssl', target: 'https://example.com/x' }).target, 'example.com');
  assert.equal(P.normalize({ type: 'http', target: 'http://example.com' }).config.certAlerts, false);
  const m = P.statusMatcher('200-299,301,4xx');
  assert.ok(m(204) && m(301) && m(404) && !m(500) && !m(302));
  assert.ok(P.blockedAddress('169.254.169.254') && !P.blockedAddress('10.0.0.1'));
});

test('rules: down after N failures, back up after one success, slow once, certificate thresholds once each', () => {
  const check = { fails: 2, interval: 60, config: { slowMs: 500, slowCount: 2, certAlerts: true } };
  let st = {}, a;
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100 }, check, 1000)); assert.equal(st.status, 'up'); assert.deepEqual(a, []);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: false, ms: 0, error: 'Timeout' }, check, 61000)); assert.equal(st.status, 'up'); assert.equal(a.length, 0);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: false, ms: 0, error: 'Timeout' }, check, 121000)); assert.equal(st.status, 'down'); assert.equal(a[0].type, 'site_down');
  assert.equal(st.since, 61000, 'down since the first failure');
  ({ state: st, alerts: a } = P.evaluate(st, { ok: false, ms: 0, error: 'Timeout' }, check, 181000)); assert.equal(a.length, 0, 'no repeat while down');
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 90, status: 200 }, check, 241000)); assert.equal(a[0].type, 'site_up'); assert.equal(a[0].data.until - a[0].data.since, 180000);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 900 }, check, 301000)); assert.equal(a.length, 0);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 900 }, check, 361000)); assert.equal(a[0].type, 'site_slow');
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 900 }, check, 421000)); assert.equal(a.length, 0, 'slow only once');
  ({ state: st } = P.evaluate(st, { ok: true, ms: 100 }, check, 481000)); assert.equal(st.slow, false);
  const cert = (d) => ({ validTo: Date.now() + d * 86400000, daysLeft: d, nameOk: true, authorized: true, issuer: 'X' });
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: cert(40) }, check, 500000)); assert.equal(a.length, 0);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: cert(13) }, check, 510000)); assert.equal(a[0].type, 'cert_expiring'); assert.equal(a[0].data.days, 14);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: cert(12) }, check, 520000)); assert.equal(a.length, 0, 'same threshold not again');
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: cert(6) }, check, 530000)); assert.equal(a[0].data.days, 7);
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: cert(90) }, check, 540000)); assert.deepEqual(st.certSent, [], 'renewed: starts over');
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: { ...cert(90), nameOk: false } }, check, 550000)); assert.equal(a[0].type, 'cert_invalid');
  ({ state: st, alerts: a } = P.evaluate(st, { ok: true, ms: 100, cert: { ...cert(90), nameOk: false } }, check, 560000)); assert.equal(a.length, 0, 'invalid only once');
});

test('HTTP probe: status, text on the page, redirects, timeout, refused', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok') { res.end('all good'); return; }
    if (req.url === '/err') { res.statusCode = 503; res.end('down'); return; }
    if (req.url === '/redir') { res.writeHead(302, { Location: '/ok' }); res.end(); return; }
    if (req.url === '/slow') { setTimeout(() => res.end('late'), 3000); return; }
    res.statusCode = 404; res.end();
  });
  const port = await listen(srv);
  const chk = (p, config = {}) => P.probe({ type: 'http', target: `http://127.0.0.1:${port}${p}`, config: { expect: '200', timeout: 5, ...config } });
  try {
    let r = await chk('/ok'); assert.equal(r.ok, true); assert.equal(r.status, 200);
    r = await chk('/err'); assert.equal(r.ok, false); assert.match(r.error, /HTTP 503/);
    r = await chk('/ok', { contains: 'good' }); assert.equal(r.ok, true);
    r = await chk('/ok', { contains: 'missing' }); assert.equal(r.ok, false); assert.match(r.error, /does not contain/);
    r = await chk('/ok', { notContains: 'good' }); assert.equal(r.ok, false);
    r = await chk('/redir'); assert.equal(r.ok, true);
    r = await chk('/redir', { follow: false, expect: '302' }); assert.equal(r.ok, true);
    r = await chk('/slow', { timeout: 1 }); assert.equal(r.ok, false); assert.match(r.error, /Timeout after 1 s/);
  } finally { srv.close(); }
  const r = await P.probe({ type: 'http', target: `http://127.0.0.1:${port}/ok`, config: { timeout: 2 } });
  assert.equal(r.ok, false); assert.match(r.error, /refused/i);
});

test('TCP probe and DNS of an unknown name', async () => {
  const srv = net.createServer((s) => s.end());
  const port = await listen(srv);
  try { assert.equal((await P.probe({ type: 'tcp', target: `127.0.0.1:${port}`, config: { timeout: 2 } })).ok, true); } finally { srv.close(); }
  assert.equal((await P.probe({ type: 'tcp', target: `127.0.0.1:${port}`, config: { timeout: 2 } })).ok, false);
  const d = await P.probe({ type: 'dns', target: 'no-such-name.invalid', config: { timeout: 3 } });
  assert.equal(d.ok, false);
});

let hasOpenssl = false; try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); hasOpenssl = true; } catch (e) {}
test('HTTPS / SSL probe reads the certificate: days left, name, self-signed', { skip: !hasOpenssl && 'openssl missing' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '10', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => res.end('ok'));
  const port = await listen(srv);
  try {
    let r = await P.probe({ type: 'http', target: `https://localhost:${port}/`, config: { timeout: 5, expect: '200' } });
    assert.equal(r.ok, false); assert.match(r.error, /self-signed/);
    r = await P.probe({ type: 'http', target: `https://localhost:${port}/`, config: { timeout: 5, expect: '200', ignoreTls: true } });
    assert.equal(r.ok, true); assert.ok(r.cert); assert.ok(r.cert.daysLeft >= 9 && r.cert.daysLeft <= 10); assert.equal(r.cert.nameOk, true); assert.equal(r.cert.authorized, false);
    r = await P.probe({ type: 'ssl', target: `localhost:${port}`, config: { timeout: 5 } });
    assert.equal(r.ok, true); assert.ok(r.cert.daysLeft <= 10); assert.deepEqual(r.cert.names, ['localhost']);
    r = await P.probe({ type: 'ssl', target: `127.0.0.1:${port}`, config: { timeout: 5 } });
    assert.equal(r.cert.nameOk, false, 'certificate is not for 127.0.0.1');
  } finally { srv.close(); }
});

test('checks run, results and incidents are kept, uptime is counted, alerts go out', async () => {
  const sent = [];
  const hm = require('../../server/notifications/health-monitor');
  const orig = hm.deliver;
  hm.deliver = async (type, s, subject) => { sent.push({ type, s, subject }); return true; };
  const U = require('../../server/uptime');
  let up = true;
  const srv = http.createServer((req, res) => { res.statusCode = up ? 200 : 500; res.end(); });
  const port = await listen(srv);
  try {
    const c = U.create({ type: 'http', name: 'site', target: `http://127.0.0.1:${port}/`, interval: 30, fails: 2, config: { timeout: 3 } });
    await U.runOne(U.get(c.id));
    up = false;
    await U.runOne(U.get(c.id));
    let r = await U.runOne(U.get(c.id));
    assert.equal(r.state.status, 'down');
    await new Promise(x => setTimeout(x, 20));
    assert.deepEqual(sent.map(x => x.type), ['site_down']);
    assert.equal(sent[0].s.id, `uptime:${c.id}`);
    up = true;
    r = await U.runOne(U.get(c.id));
    await new Promise(x => setTimeout(x, 20));
    assert.deepEqual(sent.map(x => x.type), ['site_down', 'site_up']);
    const d = U.detail(c.id);
    assert.equal(d.periods.d1.n, 4);
    assert.equal(d.periods.d1.uptime, 50);
    assert.equal(d.incidents.length, 1); assert.ok(d.incidents[0].end);
    assert.match(d.incidents[0].cause, /HTTP 500/);
    assert.ok(d.series.some(p => p.n > 0));
    assert.equal(U.summary(U.get(c.id)).bar.slice(-1)[0], 2, 'this hour: some failed');
    U.setPaused(c.id, true, 30);
    assert.equal(U.get(c.id).enabled, false);
    assert.ok(U.get(c.id).pausedUntil > Date.now());
    U.setPaused(c.id, false);
    assert.equal(U.get(c.id).enabled, true);
    const e = U.update(c.id, { name: 'renamed', config: { expect: '200-299' } });
    assert.equal(e.name, 'renamed'); assert.equal(e.config.expect, '200-299'); assert.equal(e.config.timeout, 3, 'other settings kept');
    U.remove(c.id);
    assert.equal(U.get(c.id), null);
    assert.equal(U.stats(c.id, U.DAY).n, 0, 'history removed');
  } finally { srv.close(); hm.deliver = orig; }
});

test('alert texts', () => {
  const U = require('../../server/uptime');
  const c = { id: 1, name: 'shop', target: 'https://shop.example.com' };
  assert.match(U.message('site_down', c, { error: 'Timeout after 10 s', fails: 2 })[1], /🔴 Site down — shop\nTimeout after 10 s \(2 checks in a row\)/);
  assert.match(U.message('site_up', c, { since: 0, until: 14 * 60000, ms: 120, status: 200 })[1], /Down for 14 min/);
  assert.match(U.message('cert_expiring', c, { cert: { validTo: Date.parse('2026-12-01'), daysLeft: 9, issuer: "Let's Encrypt R11" } })[0], /9 days/);
  assert.match(U.message('cert_invalid', c, { cert: { daysLeft: -1, nameOk: true } })[1], /expired/);
});
