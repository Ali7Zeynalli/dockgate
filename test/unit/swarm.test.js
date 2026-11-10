'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swarm-test-'));
const sw = require('../../server/swarm');

test('CIDR overlap and private ranges', () => {
  assert.equal(sw._overlaps('10.0.0.0/8', '10.0.0.0/16'), true);
  assert.equal(sw._overlaps('10.200.0.0/16', '10.0.0.0/16'), false);
  assert.equal(sw._overlaps('10.0.0.0/8', '10.0.1.5'), true);
  assert.equal(sw._overlaps('172.30.0.0/16', '172.17.0.0/16'), false);
  assert.equal(sw._parseCidr('300.1.1.1/8'), null);
  assert.equal(sw._isPrivate('10.0.0.5'), true);
  assert.equal(sw._isPrivate('100.101.1.2'), true, 'CGNAT / Tailscale');
  assert.equal(sw._isPrivate('49.12.1.1'), false);
});

test('initOptions: defaults and limits', () => {
  const o = sw.initOptions({});
  assert.deepEqual(o, { advertiseAddr: null, pool: '10.0.0.0/8', subnetSize: 24, dataPort: 4789, autolock: false, certDays: 90, taskHistory: 5 });
  assert.throws(() => sw.initOptions({ advertiseAddr: 'eth0' }), /IPv4/);
  assert.throws(() => sw.initOptions({ pool: '10.0.0.0/30' }), /pool/);
  assert.throws(() => sw.initOptions({ pool: '10.200.0.0/16', subnetSize: 12 }), /between \/16 and \/29/);
  assert.throws(() => sw.initOptions({ dataPort: 80 }), /data port/);
  assert.equal(sw.initOptions({ autolock: 1, taskHistory: 0 }).taskHistory, 0);
});

// A fake Docker for checks(): local server (DockGate in a container, so no address list).
function fakeDocker({ state = 'inactive', liveRestore = false, nets = [] } = {}) {
  return {
    info: async () => ({ ServerVersion: '29.1.0', OperatingSystem: 'Ubuntu', Architecture: 'x86_64', Name: 'vps1', LiveRestoreEnabled: liveRestore, Swarm: { LocalNodeState: state, ControlAvailable: state === 'active' } }),
    listNetworks: async () => nets.map((s, i) => ({ Name: `n${i}`, IPAM: { Config: [{ Subnet: s }] } })),
    listContainers: async () => [],
  };
}
function withDocker(fake, fn) {
  const ds = require('../../server/docker');
  const desc = Object.getOwnPropertyDescriptor(ds, 'docker');
  Object.defineProperty(ds, 'docker', { value: fake, configurable: true, writable: true });
  return fn().finally(() => Object.defineProperty(ds, 'docker', desc));
}

test('checks: a network in 10.0.0.0/8 makes the default pool a warning and suggests a free one', () => withDocker(fakeDocker({ nets: ['172.17.0.0/16', '10.0.0.0/16'] }), async () => {
  const r = await sw.checks();
  const pool = r.checks.find(c => c.id === 'pool');
  assert.equal(pool.status, 'warn');
  assert.match(pool.detail, /10\.0\.0\.0\/16/);
  assert.equal(r.pool, '10.200.0.0/16');
  assert.equal(r.ok, true, 'a warning does not block');
}));

test('checks: live-restore and an existing swarm block Create', () => withDocker(fakeDocker({ liveRestore: true, state: 'active' }), async () => {
  const r = await sw.checks();
  assert.equal(r.ok, false);
  assert.equal(r.checks.find(c => c.id === 'live-restore').status, 'bad');
  assert.equal(r.checks.find(c => c.id === 'state').status, 'bad');
}));
