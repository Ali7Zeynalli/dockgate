'use strict';
// The DNS check through Cloudflare (server/dns-cloudflare.js) against a fake Cloudflare API: the zone is found by
// walking up the name, the TXT record is added and removed, errors say what Cloudflare said.
const test = require('node:test');
const assert = require('node:assert/strict');
const CF = require('../../server/dns-cloudflare');

function fakeCf({ zones = ['example.test'], token = 'tok_0123456789abcdefghij' } = {}) {
  const calls = []; const records = new Map(); let n = 0;
  const fetchImpl = async (url, opt) => {
    const u = new URL(url); const path = u.pathname.replace('/client/v4', ''); calls.push(`${opt.method} ${path}${u.search}`);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (opt.headers.Authorization !== `Bearer ${token}`) return json(403, { success: false, errors: [{ message: 'Invalid API Token' }] });
    if (path === '/user/tokens/verify') return json(200, { success: true, result: { status: 'active' } });
    if (path === '/zones') { const name = u.searchParams.get('name'); return json(200, { success: true, result: zones.includes(name) ? [{ id: `z-${name}`, name }] : [] }); }
    let m;
    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records$/)) && opt.method === 'POST') { const b = JSON.parse(opt.body); const id = `r${++n}`; records.set(id, { zone: m[1], ...b }); return json(200, { success: true, result: { id } }); }
    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/)) && opt.method === 'DELETE') { records.delete(m[2]); return json(200, { success: true, result: { id: m[2] } }); }
    return json(404, { success: false, errors: [{ message: 'no route' }] });
  };
  return { fetchImpl, calls, records, token };
}

test('the zone is the longest parent name the token holds', async () => {
  const f = fakeCf({ zones: ['example.test'] });
  const z = await CF.zoneFor(f.token, '_acme-challenge.shop.eu.example.test', { fetchImpl: f.fetchImpl });
  assert.deepEqual(z, { id: 'z-example.test', name: 'example.test' });
  assert.deepEqual(f.calls.map(c => c.replace(/&status=active/, '')), ['GET /zones?name=shop.eu.example.test', 'GET /zones?name=eu.example.test', 'GET /zones?name=example.test']);
  await assert.rejects(() => CF.zoneFor(f.token, '_acme-challenge.other.test', { fetchImpl: f.fetchImpl }), /No Cloudflare zone/);
});

test('a TXT record is added in the right zone and removed again', async () => {
  const f = fakeCf();
  const h = await CF.setTxt(f.token, '_acme-challenge.example.test', 'abc123', { fetchImpl: f.fetchImpl });
  assert.equal(h.zoneId, 'z-example.test');
  const rec = f.records.get(h.id);
  assert.equal(rec.type, 'TXT'); assert.equal(rec.name, '_acme-challenge.example.test'); assert.equal(rec.content, 'abc123');
  await CF.clearTxt(f.token, h, { fetchImpl: f.fetchImpl });
  assert.equal(f.records.size, 0);
});

test('a refused token is reported as such; verify says active', async () => {
  const f = fakeCf();
  assert.deepEqual(await CF.verify(f.token, { fetchImpl: f.fetchImpl }), { ok: true, status: 'active' });
  await assert.rejects(() => CF.verify('tok_wrongwrongwrongwrong', { fetchImpl: f.fetchImpl }), (e) => /refused the token: Invalid API Token/.test(e.message) && e.statusCode === 403);
  await assert.rejects(() => CF.verify('', { fetchImpl: f.fetchImpl }), /No Cloudflare API token/);
});

test('waiting for public DNS: every resolver must answer the value', async () => {
  let round = 0; const log = [];
  const resolve = async () => (++round < 3 ? [['x'], []] : [['x', 'want'], ['want']]);
  assert.equal(await CF.waitTxt('_acme-challenge.example.test', 'want', { resolve, every: 1, timeoutMs: 5000, log: (m) => log.push(m) }), true);
  assert.equal(round, 3); assert.match(log.join('\n'), /waiting for public DNS/); assert.match(log.join('\n'), /visible in public DNS/);
  await assert.rejects(() => CF.waitTxt('_acme-challenge.example.test', 'never', { resolve: async () => [[]], every: 1, timeoutMs: 20 }), /did not show in public DNS/);
});
