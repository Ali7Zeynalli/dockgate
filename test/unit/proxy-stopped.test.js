'use strict';
// Proxies & SSL — a stopped proxy and the networks it joins: the archive tar reader / writer (server/tar-lite.js),
// nginx's runtime name resolution (`resolve`, nginx ≥ 1.27.3) and joined networks kept in the Compose override.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../server/tar-lite');
const G = require('../../server/proxy-gen');
const S = require('../../server/compose-scale');

test('makeTar → parseTar gives the same file back (name, text, mode)', () => {
  const text = 'server { listen 80; }\n'.repeat(40); // more than one 512-byte block
  const [f] = T.parseTar(T.makeTar('shop.conf', text, 0o640));
  assert.equal(f.name, 'shop.conf'); assert.equal(f.type, 'file'); assert.equal(f.data.toString(), text); assert.equal(f.mode, 0o640);
  assert.throws(() => T.makeTar('x'.repeat(101), 'a'), /too long/);
});

test('parseTar reads folders, GNU long names and skips pax headers', () => {
  const hdr = (name, type, body = '') => { const t = T.makeTar(name.slice(0, 100), body); t[156] = type.charCodeAt(0); let sum = 0; t.fill(0x20, 148, 156); for (let i = 0; i < 512; i++) sum += t[i]; t.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return t.subarray(0, t.length - 1024); };
  const long = 'conf.d/' + 'a'.repeat(120) + '.conf';
  const buf = Buffer.concat([hdr('conf.d/', '5'), hdr('pax', 'x', 'path=ignored\n'), hdr('././@LongLink', 'L', long + '\0'), hdr('short', '0', 'hello'), Buffer.alloc(1024)]);
  const out = T.parseTar(buf);
  assert.deepEqual(out.map(f => [f.name, f.type]), [['conf.d/', 'dir'], [long, 'file']]);
  assert.equal(out[1].data.toString(), 'hello');
});

test('nginxResolves: 1.27.3 and newer', () => {
  assert.equal(G.nginxResolves('1.27.3'), true); assert.equal(G.nginxResolves('1.27.5'), true); assert.equal(G.nginxResolves('1.28.0'), true); assert.equal(G.nginxResolves('2.0.0'), true);
  assert.equal(G.nginxResolves('1.27.2'), false); assert.equal(G.nginxResolves('1.26.9'), false); assert.equal(G.nginxResolves('1.27-alpine'), false); assert.equal(G.nginxResolves(null), false);
});

test('nginxSite with resolve: the upstream gets a zone, Docker\'s resolver and resolve on names (not on IPs)', () => {
  const t = G.nginxSite({ domain: 'shop.example.test', targets: ['web-1:80', '172.18.0.5:80'], dockerDns: true, https: 'none' }, { resolve: true });
  assert.match(t, /upstream dg_shop_example_test \{\n {2}zone dg_shop_example_test 64k;\n {2}resolver 127\.0\.0\.11 valid=10s ipv6=off;\n {2}server web-1:80 resolve;\n {2}server 172\.18\.0\.5:80;\n\}/);
  const old = G.nginxSite({ domain: 'shop.example.test', targets: ['web-1:80', 'web-2:80'], dockerDns: true, https: 'none' });
  assert.doesNotMatch(old, /resolve;|zone /);
  const host = G.nginxSite({ domain: 'shop.example.test', targets: ['web-1:80', 'web-2:80'], dockerDns: false, https: 'none' }, { resolve: true });
  assert.doesNotMatch(host, /resolve;/, 'no Docker DNS (a proxy on the host): nothing to resolve through');
});

test('nginxSetUpstream: resolve adds zone and resolver once, and an upstream that had resolve keeps it', () => {
  const text = 'upstream api_pool {\n  least_conn;\n  server a:80;\n  server b:80 backup;\n}\n';
  const r1 = G.nginxSetUpstream(text, 'api_pool', { method: 'least_conn', servers: [{ addr: 'a:80' }, { addr: 'b:80', backup: true }], resolve: true });
  assert.match(r1, /zone api_pool 64k;/); assert.match(r1, /server a:80 resolve;/); assert.match(r1, /server b:80 backup resolve;/);
  const r2 = G.nginxSetUpstream(r1, 'api_pool', { method: 'round_robin', servers: [{ addr: 'a:80' }, { addr: 'c:80' }] });
  assert.match(r2, /server c:80 resolve;/, 'kept without being asked');
  assert.equal(r2.match(/zone /g).length, 1); assert.equal(r2.match(/resolver /g).length, 1);
  assert.equal(G.nginxUpstreams(r2)[0].servers.map(s => s.addr).join(','), 'a:80,c:80');
  const r3 = G.nginxSetUpstream(text, 'api_pool', { method: 'least_conn', servers: [{ addr: 'a:80' }] });
  assert.doesNotMatch(r3, /resolve/);
});

test('buildOverride keeps joined networks: the service\'s own networks too, and the joined ones as external', () => {
  const y = S.buildOverride({ proxy: { networks: ['default'], extraNetworks: ['gitdemo_default', 'default'] } });
  assert.match(y, /proxy:\n {4}networks:\n {6}default: \{\}\n {6}gitdemo_default: \{\}/);
  assert.match(y, /\nnetworks:\n {2}gitdemo_default:\n {4}external: true\n$/);
  assert.doesNotMatch(y, /\n {2}default:\n {4}external/);
  const both = S.buildOverride({ web: { networks: ['front'], aliases: ['old-web'], extraNetworks: ['edge'] } });
  assert.match(both, /front:\n {8}aliases:\n {10}- old-web\n {6}edge: \{\}/);
  assert.throws(() => S.buildOverride({ web: { extraNetworks: ['bad name;'] } }));
  // a later write (scale, labels) reads the service's networks from `docker compose config`, which already has the joined one
  const later = S.buildOverride({ proxy: { networks: ['default', 'gitdemo_default'], extraNetworks: ['gitdemo_default'], replicas: 2 } });
  assert.equal(later.match(/gitdemo_default: \{\}/g).length, 1);
  assert.match(later, /\nnetworks:\n {2}gitdemo_default:\n {4}external: true\n$/, 'still declared, or Compose says the network is undefined');
});
