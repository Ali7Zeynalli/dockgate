'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('../src/control/executor');
const { cleanRules } = require('../src/control/index');
const { healDecision } = require('../src/control/heal-decision');

// A fake Docker with N running replicas of p/s; records what was done to it.
function fakeDocker(n) {
  const done = [];
  const cts = Array.from({ length: n }, (_, i) => ({ Id: `id${i + 1}`, Names: [`/p-s-${i + 1}`], State: 'running',
    Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 's', 'com.docker.compose.container-number': String(i + 1) } }));
  return { done, listContainers: async () => cts,
    getContainer: (id) => ({ restart: async () => done.push(['restart', id]), stop: async () => done.push(['stop', id]), remove: async () => done.push(['remove', id]), inspect: async () => ({ Config: {} }) }),
    getNetwork: () => ({ inspect: async () => ({ Containers: {} }) }) };
}
const rules = { projects: { p: { s: { replicas: 2, min: 1, max: 3 } } } };

test('anything outside the whitelist is refused, and nothing is touched', async () => {
  const d = fakeDocker(2);
  for (const a of ['exec', 'rm', 'pull', 'run', '', undefined]) assert.equal((await ex.execute(a, { project: 'p', service: 's' }, { docker: d, rules })).ok, false);
  assert.deepEqual(d.done, []);
});
test('only services DockGate gave a rule for, with clean names', async () => {
  const d = fakeDocker(2);
  await assert.rejects(ex.execute('restart', { project: 'other', service: 's', container: 'id1' }, { docker: d, rules }), /no rule/);
  await assert.rejects(ex.execute('restart', { project: 'p;rm -rf /', service: 's' }, { docker: d, rules }), /bad name/);
  await assert.rejects(ex.execute('add-replica', { project: 'p', service: 's' }, { docker: d, rules: null }), /no rule/);
});
test('restart only hits a replica of that service', async () => {
  const d = fakeDocker(2);
  assert.equal((await ex.execute('restart', { project: 'p', service: 's', container: 'someone-else' }, { docker: d, rules })).ok, false);
  assert.equal((await ex.execute('restart', { project: 'p', service: 's', container: 'p-s-2' }, { docker: d, rules })).ok, true);
  assert.deepEqual(d.done, [['restart', 'id2']]);
});
test('limits hold on the agent side: max, min, and the hard cap', async () => {
  assert.match((await ex.execute('add-replica', { project: 'p', service: 's' }, { docker: fakeDocker(3), rules })).reason, /maximum \(3\)/);
  assert.match((await ex.execute('remove-replica', { project: 'p', service: 's' }, { docker: fakeDocker(1), rules })).reason, /minimum \(1\)/);
  const d = fakeDocker(2);
  const r = await ex.execute('remove-replica', { project: 'p', service: 's' }, { docker: d, rules });
  assert.equal(r.ok, true); assert.equal(r.container, 'p-s-2'); // the highest number goes
  assert.equal(ex.maxOf({ max: 500 }), ex.MAX_REPLICAS);
});
test('rules keep only the known shape and limits', () => {
  const r = cleanRules({ version: 4, projects: { 'ok': { web: { replicas: 3, max: 99, heal: 'yes', extra: 'x', healPerHour: 0 } }, '../bad': { x: {} }, p: { 'a b': {} } } });
  assert.equal(r.version, 4);
  assert.deepEqual(Object.keys(r.projects), ['ok']);
  assert.deepEqual(r.projects.ok.web, { replicas: 3, min: undefined, max: undefined, heal: false, healPerHour: 3, keep: true, auto: undefined });
});
test('healing waits for the start period, then gives up after the hourly limit', () => {
  const now = 10_000_000;
  assert.notEqual(healDecision({ fails: 5, restarts: [], since: now - 10_000 }, now, { healPerHour: 3 }), 'restart');
  assert.equal(healDecision({ fails: 3, restarts: [], since: now - 120_000 }, now, { healPerHour: 3 }), 'restart');
  assert.notEqual(healDecision({ fails: 3, restarts: [now - 1000, now - 2000, now - 3000], since: now - 120_000 }, now, { healPerHour: 3 }), 'restart');
});
