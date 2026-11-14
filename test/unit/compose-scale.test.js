'use strict';
// Compose replicas without Swarm: the override file and the checks (server/compose-scale.js) — no Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-scale-test-'));
const S = require('../../server/compose-scale');

test('buildOverride writes replicas and aliases on the service networks, resets only what was asked', () => {
  const y = S.buildOverride({ api: { replicas: 3 }, web: { replicas: 2, dropPorts: true, dropName: true, aliases: ['old-web'], networks: ['front', 'back'] } });
  assert.match(y, /^# Written by DockGate/);
  assert.match(y, /  api:\n    deploy:\n      replicas: 3\n/);
  assert.match(y, /    ports: !reset \[\]\n/);
  assert.match(y, /    container_name: !reset null\n/);
  assert.match(y, /      front:\n        aliases:\n          - old-web\n      back:\n        aliases:\n          - old-web\n/);
  assert.doesNotMatch(y.split('  web:')[0], /reset/, 'api gets no resets');
  assert.equal(S.buildOverride({}), '');
  assert.equal(S.buildOverride({ api: {} }), '', 'nothing to say → no file');
});

test('names and numbers are checked before anything is written', () => {
  assert.throws(() => S.buildOverride({ 'a;rm -rf /': { replicas: 2 } }), /Service/);
  assert.throws(() => S.buildOverride({ api: { replicas: 21 } }), /0–20/);
  assert.throws(() => S.buildOverride({ api: { replicas: 1.5 } }), /0–20/);
  assert.throws(() => S.buildOverride({ api: { aliases: ['x\n  privileged: true'] } }), /Alias/);
  assert.throws(() => S.buildOverride({ api: { aliases: ['a'], networks: ['n: {}'] } }), /Network/);
});

test('overridePath never points into the project folder', () => {
  assert.equal(S.overridePath('local', 'shop').local, path.join(process.env.DATA_DIR, 'compose-overrides', 'local', 'shop', 'docker-compose.dockgate.yml'));
  assert.equal(S.overridePath('web-1', 'shop').remote, '~/.dockgate/overrides/shop/docker-compose.dockgate.yml');
  assert.throws(() => S.overridePath('local', '../etc'), /Project/);
});

test('writeOverride (local) is atomic, private, recorded and removable', async () => {
  const r = { remote: false };
  const { previous } = await S.writeOverride(r, 'local', 'shop', S.buildOverride({ api: { replicas: 2 } }));
  assert.equal(previous, null);
  const p = S.overridePath('local', 'shop').local;
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
  assert.equal(S.overrideFor('local', 'shop'), p);
  const again = await S.writeOverride(r, 'local', 'shop', S.buildOverride({ api: { replicas: 3 } }));
  assert.match(again.previous, /replicas: 2/);
  await S.removeAll(r, 'local', 'shop');
  assert.equal(fs.existsSync(p), false); assert.equal(S.overrideFor('local', 'shop'), null);
});

test('rules are saved per server, project and service', () => {
  S.saveRule('local', 'shop', 'api', { replicas: 3, dropPorts: true, aliases: ['shop-api'] });
  assert.deepEqual(S.readRules('local', 'shop').api, { replicas: 3, dropPorts: true, dropName: false, aliases: ['shop-api'], mode: 'off', heal: false, keepRunning: false });
  assert.deepEqual(S.readRules('web-1', 'shop'), {});
});

test('checkScalable: databases and writable data stay at 1; ports and names get a fix; old Compose is told', () => {
  assert.match(S.checkScalable({ image: 'postgres:16' }, 'db', '2.27.0').block, /database/);
  assert.match(S.checkScalable({ image: 'app', volumes: [{ type: 'volume', source: 'd', target: '/d' }] }, 'a', '2.27.0').block, /\/d/);
  assert.equal(S.checkScalable({ image: 'app', volumes: [{ type: 'volume', source: 'd', target: '/d', read_only: true }] }, 'a', '2.27.0').ok, true);
  assert.match(S.checkScalable({ image: 'app', network_mode: 'host' }, 'a', '2.27.0').block, /host/);
  const r = S.checkScalable({ image: 'app', ports: [{ published: '80', target: 80 }], container_name: 'x' }, 'web', '5.6.1');
  assert.deepEqual(r.fixes.sort(), ['dropName', 'dropPorts']); assert.equal(r.ok, true);
  assert.match(S.checkScalable({ image: 'app', ports: [{ published: '80', target: 80 }] }, 'web', '2.20.0').block, /2\.24\.4/);
  assert.equal(S.checkScalable({ image: 'app', ports: [{ target: 80 }] }, 'web', '2.20.0').ok, true, 'an unpublished port needs no fix');
});

test('limitsOf reads every way limits are written', () => {
  assert.deepEqual(S.limitsOf({ cpus: 0.5, mem_limit: '134217728' }), { cpu: 0.5, mem: 134217728 });
  assert.deepEqual(S.limitsOf({ deploy: { resources: { limits: { cpus: '1.5', memory: '512M' } } } }), { cpu: 1.5, mem: 536870912 });
  assert.deepEqual(S.limitsOf({ cpu_quota: 50000, cpu_period: 100000 }), { cpu: 0.5, mem: 0 });
  assert.deepEqual(S.limitsOf({}), { cpu: 0, mem: 0 });
  assert.equal(S.verAtLeast('5.6.1', '2.24.4'), true); assert.equal(S.verAtLeast('2.24.3', '2.24.4'), false);
});

test('Compose Auto Scaling suggestions: replicas from the real load, limits left alone', () => {
  const CA = require('../../server/compose-autoscale');
  const t0 = 1_800_000_000_000;
  // 40 readings: 2 replicas, usually 60 % of their limit each, busy hour at 95 %
  const samples = Array.from({ length: 40 }, (_, i) => ({ t: t0 + i * 120000, replicas: 2, cpu: i >= 36 ? 95 : 60, mem: 40 }));
  const r = CA.suggestFrom(samples, { cpu: 0.5, mem: 256 * 1048576 }, Infinity, { current: 2 });
  assert.equal(r.enough, true);
  assert.equal(r.values.min, 2);       // 1.2 replicas of load at 70 % → 2
  assert.equal(r.values.max, 5);       // 1.9 at the 95th percentile → 3, × 1.5 → 5
  assert.equal(r.values.memUp, null);  // memory flat
  assert.equal(CA.suggestFrom(samples, {}, 1, { current: 2 }).values.max, 3, 'capped by what fits');
  assert.equal(CA.suggestFrom(samples.slice(0, 10)).enough, false);
  const idle = Array.from({ length: 40 }, (_, i) => ({ t: t0 + i * 120000, replicas: 1, cpu: 5, mem: 10 }));
  assert.match(CA.suggestFrom(idle, { cpu: 2 }).notes.join(' '), /much higher than it needs/);
});
