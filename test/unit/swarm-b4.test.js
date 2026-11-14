'use strict';
// Move to Swarm: privileged → cap_add hints, and macvlan networks in the stack file (server/swarm-stacks.js). No Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-b4-test-'));
const S = require('../../server/swarm-stacks');

test('known image families get a cap_add hint; others none', () => {
  assert.deepEqual(S.capHint('lscr.io/linuxserver/wireguard:latest').caps, ['NET_ADMIN', 'SYS_MODULE']);
  assert.deepEqual(S.capHint('pihole/pihole:2024.07').caps, ['NET_ADMIN']);
  assert.equal(S.capHint('docker:27-dind'), null);
});
test('cap_add is used only when accepted, and privileged never reaches the stack file', () => {
  const cfg = { services: { vpn: { image: 'tailscale/tailscale', privileged: true, cap_add: ['SYS_TIME'] } } };
  assert.equal(S.adapt(cfg, {}, {}).services.vpn.privileged, undefined);
  assert.deepEqual(S.adapt(cfg, {}, {}).services.vpn.cap_add, ['SYS_TIME']);
  assert.deepEqual(S.adapt(cfg, { services: { vpn: { capInstead: true } } }, {}).services.vpn.cap_add, ['SYS_TIME', 'NET_ADMIN']);
});
test('a macvlan network becomes the Swarm network DockGate makes from config-only networks', () => {
  const cfg = { services: { dns: { image: 'x', networks: { lan: null } } }, networks: { lan: { driver: 'macvlan', driver_opts: { parent: 'eth0' }, ipam: { config: [{ subnet: '192.168.1.0/24' }] } } } };
  assert.deepEqual(S.adapt(cfg, {}, { stackName: 'home' }).networks.lan, { external: true, name: 'home_lan-swarm' });
});
test('DockGate\'s own containers never move to Swarm', () => {
  const { isOwn } = require('../../server/swarm-yaml');
  assert.equal(isOwn({ 'dockgate.role': 'agent' }, 'x', '/whatever'), true);
  assert.equal(isOwn({}, 'ghcr.io/ali7zeynalli/dockgate-agent:1.1.0-cc2970d20b', '/x'), true);
  assert.equal(isOwn({}, 'ghcr.io/ali7zeynalli/dockgate:latest', '/x'), true);
  assert.equal(isOwn({}, 'nginx:1.27', '/dockgate-agent'), true);
  assert.equal(isOwn({}, 'nginx:1.27', '/web'), false);
});
