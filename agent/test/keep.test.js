'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keepAlive } = require('../src/control/keep');

// A fake Docker with replicas of p/web; records what was done.
function fake(list) {
  const done = [];
  const inspect = (id) => ({ Id: id, Name: '/p-web-1', Config: { Image: 'web:1', Env: ['A=1'], Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'web', 'com.docker.compose.container-number': '1' }, Hostname: 'h' },
    HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] }, Memory: 1 }, NetworkSettings: { Networks: { p_default: { Aliases: ['web'] } } } });
  const docker = {
    done,
    listContainers: async () => list.map(c => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'web', 'com.docker.compose.container-number': String(c.n || 1) } })),
    getContainer: (id) => ({ inspect: async () => inspect(id), start: async () => done.push(['start', id]) }),
    createContainer: async (spec) => { done.push(['create', spec.name, spec.HostConfig.PortBindings]); return { id: 'new', start: async () => done.push(['start', 'new']) }; },
    getNetwork: () => ({ connect: async () => {} }),
  };
  return docker;
}

test('while it runs, its config is kept and nothing is done', async () => {
  const st = {};
  const d = fake([{ id: 'a', name: 'p-web-1', state: 'running' }]);
  assert.equal(await keepAlive({ docker: d, project: 'p', service: 'web', state: st }), null);
  assert.equal(st.snaps['p/web'].inspect.Id, 'a');
  assert.deepEqual(d.done, []);
});
test('stopped: started on the second check (not the first)', async () => {
  const st = {};
  const d = fake([{ id: 'a', name: 'p-web-1', state: 'exited' }]);
  assert.equal(await keepAlive({ docker: d, project: 'p', service: 'web', state: st }), null);
  const r = await keepAlive({ docker: d, project: 'p', service: 'web', state: st });
  assert.equal(r.action, 'start'); assert.deepEqual(d.done, [['start', 'a']]);
});
test('removed: made again from the kept config — same name and host port', async () => {
  const st = {};
  await keepAlive({ docker: fake([{ id: 'a', name: 'p-web-1', state: 'running' }]), project: 'p', service: 'web', state: st });
  const gone = fake([]);
  await keepAlive({ docker: gone, project: 'p', service: 'web', state: st });
  const r = await keepAlive({ docker: gone, project: 'p', service: 'web', state: st });
  assert.equal(r.action, 'recreate'); assert.equal(r.ok, true);
  assert.equal(gone.done[0][1], 'p-web-1');
  assert.deepEqual(gone.done[0][2], { '80/tcp': [{ HostPort: '8080' }] });
});
test('removed before any config was kept: says so, does nothing', async () => {
  const st = {}, gone = fake([]);
  await keepAlive({ docker: gone, project: 'p', service: 'web', state: st });
  const r = await keepAlive({ docker: gone, project: 'p', service: 'web', state: st });
  assert.equal(r.ok, false); assert.match(r.reason, /no config was kept/);
});
