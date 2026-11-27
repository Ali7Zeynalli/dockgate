'use strict';
// Change settings of a network (server/network-recreate.js): the new create body, how each container goes back,
// and which networks are not changed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const NR = require('../../server/network-recreate');

const OLD = {
  Id: 'n1', Name: 'app', Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false, EnableIPv6: false,
  Options: { 'com.docker.network.driver.mtu': '1500', 'com.docker.network.bridge.name': 'br-app' },
  Labels: { team: 'web' },
  IPAM: { Driver: 'default', Config: [{ Subnet: '172.31.0.0/16', Gateway: '172.31.0.1', IPRange: '172.31.5.0/24' }] },
};

test('the create body: changes applied, the rest kept; a new subnet drops the old gateway and range', () => {
  const same = NR.buildCreate(OLD, { internal: true, mtu: '1450', icc: false });
  assert.equal(same.Name, 'app'); assert.equal(same.Internal, true);
  assert.deepEqual(same.IPAM.Config, [{ Subnet: '172.31.0.0/16', Gateway: '172.31.0.1', IPRange: '172.31.5.0/24' }]);
  assert.equal(same.Options['com.docker.network.driver.mtu'], '1450');
  assert.equal(same.Options['com.docker.network.bridge.enable_icc'], 'false');
  assert.equal(same.Options['com.docker.network.bridge.name'], 'br-app');
  assert.deepEqual(same.Labels, { team: 'web' });
  const moved = NR.buildCreate(OLD, { subnet: '172.31.0.0/24' });
  assert.deepEqual(moved.IPAM.Config, [{ Subnet: '172.31.0.0/24' }], 'Docker picks the gateway');
  const v6 = NR.buildCreate(OLD, { ipv6: true, subnet6: 'fd00:1::/64', mtu: '' });
  assert.equal(v6.EnableIPv6, true); assert.equal(v6.IPAM.Config[1].Subnet, 'fd00:1::/64');
  assert.equal(v6.Options['com.docker.network.driver.mtu'], undefined, 'empty MTU: the default');
  assert.deepEqual(NR.buildCreate(OLD, { icc: true }).Options['com.docker.network.bridge.enable_icc'], undefined);
});

test('going back: aliases always, a fixed address only when it fits the new subnet', () => {
  const m = { name: 'db', aliases: ['db', 'postgres'], fixed4: '172.31.9.10', fixed6: '' };
  const fits = NR.endpointFor(m, NR.buildCreate(OLD, {}));
  assert.deepEqual(fits.endpoint, { Aliases: ['db', 'postgres'], IPAMConfig: { IPv4Address: '172.31.9.10' } });
  const out = NR.endpointFor(m, NR.buildCreate(OLD, { subnet: '172.31.0.0/24' }));
  assert.deepEqual(out.endpoint, { Aliases: ['db', 'postgres'] });
  assert.match(out.notes[0], /outside the new subnet/);
});

test('not changed here: Docker\'s own, Swarm, compose; members read from inspect', () => {
  assert.match(NR.refusal({ Name: 'bridge' }, 0), /own networks/);
  assert.match(NR.refusal({ Name: 'x', Scope: 'swarm' }, 0), /Swarm/);
  assert.match(NR.refusal({ Name: 'x', Scope: 'local' }, 2), /Swarm/);
  assert.match(NR.refusal({ Name: 'shop_default', Labels: { 'com.docker.compose.project': 'shop' } }, 0), /compose project shop/);
  assert.equal(NR.refusal(OLD, 0), null);
  const ms = NR.membersOf(OLD, [
    { Id: 'abc123def456', Name: '/db', State: { Running: true }, NetworkSettings: { Networks: { app: { NetworkID: 'n1', Aliases: ['db', 'abc123def456', 'postgres'], IPAMConfig: { IPv4Address: '172.31.9.10' } } } } },
    { Id: 'zzz', Name: '/web', State: { Running: false }, NetworkSettings: { Networks: { other: { NetworkID: 'n2' } } } },
  ]);
  assert.deepEqual(ms, [{ id: 'abc123def456', name: 'db', running: true, aliases: ['postgres'], fixed4: '172.31.9.10', fixed6: '' }]);
});
