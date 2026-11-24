'use strict';
// Proxies & SSL > Certificates -> "Why?, fix" (server/cert-doctor.js): the address checks and the fetch that asks
// for the ACME challenge path the way Let's Encrypt does.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const D = require('../../server/cert-doctor');

test('Cloudflare addresses are told apart from the server\'s own', () => {
  assert.equal(D.isCloudflare('104.16.1.1'), true);
  assert.equal(D.isCloudflare('172.67.10.10'), true);
  assert.equal(D.isCloudflare('188.114.97.3'), true);
  assert.equal(D.isCloudflare('8.8.8.8'), false);
  assert.equal(D.isCloudflare('172.80.0.1'), false);
  assert.equal(D.isCloudflare('2606:4700::1'), false); // only IPv4 ranges are listed
});

test('private and local addresses', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.5', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::1', 'fe80::1', 'fd00::5']) assert.equal(D.isPrivate(ip), true, ip);
  for (const ip of ['172.32.0.1', '8.8.8.8', '203.0.113.9', '2001:db8::1']) assert.equal(D.isPrivate(ip), false, ip);
});

test('the challenge fetch follows redirects and reports what answered', async (t) => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(301, { Location: '/b' }); return res.end(); }
    if (req.url === '/b') { res.writeHead(302, { Location: '/c' }); return res.end(); }
    if (req.url === '/c') { res.writeHead(200); return res.end('token-ok'); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ok = await D.fetchLikeAcme(base + '/a');
  assert.equal(ok.status, 200); assert.equal(ok.body, 'token-ok'); assert.match(ok.url, /\/c$/);
  assert.equal((await D.fetchLikeAcme(base + '/missing')).status, 404);
  assert.equal((await D.fetchLikeAcme(base + '/loop')).status, 302, 'stops after 3 redirects');
  const down = await D.fetchLikeAcme('http://127.0.0.1:1/x');
  assert.equal(down.status, 0); assert.ok(down.error);
});

test('an unknown fix is refused', async () => {
  await assert.rejects(() => D.fix('AA:BB', 'rm-everything', 'admin'), (e) => e.statusCode >= 400);
});
