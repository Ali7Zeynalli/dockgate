'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swbk-test-'));
const B = require('../../server/swarm-backup');

test('backup files are only served by their exact name', () => {
  assert.throws(() => B.filePath('../docker-panel.db'), /Invalid/);
  assert.throws(() => B.filePath('swarm-abc-20261111-112248.tar/../../x'), /Invalid/);
  assert.throws(() => B.filePath('swarm-abc-20261111-112248.tar'), /not found/);
  assert.deepEqual(B.list(), []);
});

test('the cluster description strips join tokens and lists secrets by name only', async () => {
  const c = {
    swarmInspect: async () => ({ ID: 'c1', JoinTokens: { Worker: 'SWMTKN-secret', Manager: 'SWMTKN-secret2' }, Spec: {} }),
    listNodes: async () => [{ ID: 'n1', Description: { Hostname: 'vps1', Engine: { EngineVersion: '29' } }, Spec: { Role: 'manager', Availability: 'active', Labels: { db: 'true' } }, Status: { Addr: '10.0.0.2' } }],
    listServices: async () => [{ ID: 's1', Spec: { Name: 'web' } }],
    listNetworks: async () => [{ Name: 'ingress', Ingress: true }, { Name: 'backend', Driver: 'overlay', Attachable: true, IPAM: { Config: [{ Subnet: '10.0.1.0/24' }] } }],
    listConfigs: async () => [{ Spec: { Name: 'site', Data: 'eA==' } }],
    listSecrets: async () => [{ Spec: { Name: 'db_password', Data: 'should-not-be-here' } }],
  };
  const d = await B.describe(c, 'local');
  assert.equal(JSON.stringify(d).includes('SWMTKN'), false);
  assert.deepEqual(d.secrets, [{ name: 'db_password', labels: {} }]);
  assert.deepEqual(d.networks.map(n => n.name), ['backend'], 'ingress is left out');
  assert.equal(d.nodes[0].labels.db, 'true');
  assert.deepEqual(d.errors, []);
});

test('without a leader the description says so once', async () => {
  const fail = async () => { const e = new Error('x'); e.json = { message: "rpc error: code = Unknown desc = The swarm does not have a leader." }; throw e; };
  const d = await B.describe({ swarmInspect: fail, listNodes: fail, listServices: fail, listNetworks: fail, listConfigs: fail, listSecrets: fail }, 'local');
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0], /no leader/);
});
