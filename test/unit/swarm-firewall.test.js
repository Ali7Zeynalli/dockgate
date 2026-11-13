'use strict';
// Swarm → Firewall (server/swarm-firewall.js) — which rule a Swarm port needs, and how a port stands. No Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swfw-test-'));
const F = require('../../server/swarm-firewall');

test('ingress is filtered by its published port, host mode by the container port', () => {
  assert.equal(F.checkPortOf({ mode: 'ingress', published: 8080, target: 80 }), 8080);
  assert.equal(F.checkPortOf({ mode: 'host', published: 8080, target: 80 }), 80);
});
test('a port is open to everyone wherever nothing filters Docker traffic', () => {
  const p = { checkPort: 8080, proto: 'tcp' };
  assert.equal(F.portState({ managed: false }, p).risk, true);
  assert.equal(F.portState({ managed: true, backend: 'firewalld' }, p).risk, true);
  assert.match(F.portState({ managed: true, backend: 'ufw', dockerIsolation: false }, p).text, /isolation/);
});
test('with isolation: closed without a route rule, open to its sources with one', () => {
  const p = { checkPort: 8080, proto: 'tcp' };
  const fw = { managed: true, backend: 'ufw', dockerIsolation: true, _groups: [] };
  assert.equal(F.portState(fw, p).state, 'closed');
  fw._groups.push({ key: 'k', dir: 'in', action: 'allow', proto: 'tcp', container: 8080, remotes: ['203.0.113.7', 'any4'], entries: [] });
  assert.deepEqual([F.portState(fw, p).state, F.portState(fw, p).text], ['open', 'open to 203.0.113.7, anyone']);
  assert.equal(F.portState(fw, { checkPort: 8080, proto: 'udp' }).state, 'closed', 'another protocol');
});
test('the rule written on each server is a ufw route rule for the right port and sources', () => {
  const FW = require('../../server/security/fwmodel');
  const want = F.wantRule({ proto: 'tcp', checkPort: 8080, service: 'shop_web' });
  want.remotes = [{ remote: '203.0.113.7', tag: 'manual' }];
  const plan = FW.planChange({ backend: 'ufw', zone: null, old: null, want });
  assert.equal(plan.cmds.length, 1);
  assert.match(plan.cmds[0], /ufw route allow proto tcp from 203\.0\.113\.7 to any port 8080 comment 'dockgate:/);
  const close = FW.planChange({ backend: 'ufw', zone: null, old: { ...want, entries: [{ route: true, remote: '203.0.113.7', tag: 'manual', action: 'allow' }] }, want: null });
  assert.match(close.cmds[0], /ufw route delete allow proto tcp from 203\.0\.113\.7 to any port 8080/);
});
