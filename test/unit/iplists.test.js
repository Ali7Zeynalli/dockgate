const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-iplists-test-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const L = require('../../server/security/iplists');

test('iplists: addresses are normalised (network address, compact IPv6, /32 dropped)', () => {
  assert.equal(L.normalizeSource('10.0.0.5/24'), '10.0.0.0/24');
  assert.equal(L.normalizeSource('2400:CB00:0::/32'), '2400:cb00::/32');
  assert.equal(L.normalizeSource('2001:db8:10:ff::1/48'), '2001:db8:10::/48');
  assert.equal(L.normalizeSource('1.2.3.4/32'), '1.2.3.4');
  assert.equal(L.normalizeSource('::ffff:1.2.3.4'), '1.2.3.4');
  for (const bad of ['1.2.3.999', '1.2.3.4/33', 'abc', '1.2.3.4;id', '$(reboot)', '']) assert.equal(L.normalizeSource(bad), null, bad);
  const p = L.parseSourceText('173.245.48.0/20 103.21.244.0/22,\n2400:cb00::/32\n\nnope 173.245.48.0/20');
  assert.deepEqual(p.valid, ['173.245.48.0/20', '103.21.244.0/22', '2400:cb00::/32']);
  assert.deepEqual(p.invalid, ['nope']);
  assert.ok(L.sourceContains('192.0.2.0/24', '192.0.2.44'));
  assert.ok(!L.sourceContains('192.0.2.0/24', '192.0.3.1'));
  assert.ok(!L.sourceContains('2400:cb00::/32', '192.0.2.44'), 'families never mix');
});

test('iplists: official lists ship with the published ranges; custom lists validated', () => {
  const cf = L.get('cloudflare');
  assert.equal(cf.v4, 15); assert.equal(cf.v6, 7);
  assert.equal(L.get('github').items.length, 6);
  const office = L.saveCustom(null, { name: 'Office', items: '203.0.113.0/27\n2001:db8:10::/48' });
  assert.equal(office.kind, 'custom');
  assert.throws(() => L.saveCustom(null, { name: 'x', items: '1.2.3.4 nope' }), /nope/);
  assert.throws(() => L.saveCustom(null, { name: 'x', items: '0.0.0.0/0' }), /Anyone/);
  assert.throws(() => L.saveCustom(null, { name: '', items: '1.2.3.4' }), /name/);
  assert.throws(() => L.saveCustom('cloudflare', { name: 'x', items: '1.2.3.4' }), /Official/);
  const edited = L.saveCustom(office.id, { name: 'Office', items: ['203.0.113.0/27'] });
  assert.deepEqual(edited.prevItems, ['203.0.113.0/27', '2001:db8:10::/48'], 'previous version kept');
  assert.throws(() => L.removeCustom('cloudflare'), /cannot be deleted/);
  L.removeCustom(office.id);
  assert.equal(L.get(office.id), null);
});

test('iplists: checking an official list shows the difference and saves nothing', async () => {
  const cur = L.get('cloudflare').items;
  const fetcher = async (url) => url.endsWith('v4') ? cur.filter(x => !x.includes(':')).concat('104.30.0.0/19').join('\n') : cur.filter(x => x.includes(':')).slice(1).join('\n');
  const r = await L.checkOfficial('cloudflare', fetcher);
  assert.deepEqual(r.add, ['104.30.0.0/19']);
  assert.deepEqual(r.remove, ['2400:cb00::/32']);
  assert.deepEqual(L.get('cloudflare').items, cur, 'not saved');
  await assert.rejects(L.checkOfficial('cloudflare', async () => { throw new Error('offline'); }), /Could not fetch the Cloudflare list: offline/);
  await assert.rejects(L.checkOfficial('cloudflare', async () => ''), /empty/);
  await assert.rejects(L.checkOfficial('nope'), /official/);
});

test('iplists: infer lists on a port (outdated version too) and expand back to addresses', () => {
  const lists = L.all();
  const cf = L.get('cloudflare').items;
  assert.deepEqual(L.inferSources([...cf, '203.0.113.5', '192.0.2.44'], lists, '192.0.2.44').sources, ['@cloudflare', '@dockgate', '203.0.113.5']);
  assert.deepEqual(L.inferSources(cf.slice(1), lists).sources, cf.slice(1), 'a partial list stays as addresses');
  const ex = L.expandSources(['@github', '198.51.100.7', '@dockgate'], lists, '192.0.2.44');
  assert.equal(ex.length, 8);
  assert.deepEqual(ex.at(-1), { src: '192.0.2.44', tag: 'dockgate' });
  assert.throws(() => L.expandSources(['any', '1.2.3.4'], lists), /Anyone/);
  assert.throws(() => L.expandSources(['@dockgate'], lists, null), /unknown/);
});

test('ip-lists API: list, parse, create, edit, delete', async () => {
  const app = express(); app.use(express.json()); app.use('/l', require('../../server/routes/ip-lists'));
  const all = await request(app).get('/l');
  assert.ok(all.body.lists.some(l => l.id === 'cloudflare'));
  const parsed = await request(app).post('/l/parse').send({ text: '1.2.3.4, 2001:DB8::/32 x' });
  assert.deepEqual(parsed.body, { valid: ['1.2.3.4', '2001:db8::/32'], invalid: ['x'] });
  const c = await request(app).post('/l').send({ name: 'VPN', items: '10.8.0.0/24' });
  assert.equal(c.status, 200);
  assert.equal((await request(app).put('/l/' + c.body.id).send({ name: 'VPN', items: 'bad' })).status, 400);
  assert.equal((await request(app).delete('/l/cloudflare')).status, 400);
  assert.equal((await request(app).delete('/l/' + c.body.id)).status, 200);
  assert.equal((await request(app).post('/l/cloudflare/update').send({ items: ['nope'] })).status, 400);
});
