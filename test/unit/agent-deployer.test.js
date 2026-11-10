// Edge agent updates: the image tag follows the agent's code, the new image is on the server before the old agent
// stops, a failed start puts the old agent back, reconfigure keeps the running image, old images are cleaned up.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-deployer-test-'));
delete process.env.AGENT_IMAGE;
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const steps = [];
function fakeDaemon(name) {
  const d = { name, images: new Set(), containers: [], failStart: false };
  const cont = (c) => ({
    stop: async () => { steps.push(`${name}:stop ${c.Names[0]}`); c.State = 'exited'; },
    rename: async ({ name: n }) => { steps.push(`${name}:rename ${c.Names[0]} -> /${n}`); c.Names = ['/' + n]; },
    remove: async () => { steps.push(`${name}:remove ${c.Names[0]}`); d.containers = d.containers.filter(x => x !== c); },
    start: async () => { if (c.fail) throw new Error('port in use'); steps.push(`${name}:start ${c.Names[0]}`); c.State = 'running'; },
  });
  d.client = {
    listContainers: async () => d.containers.filter(c => c.Labels['dockgate.role'] === 'agent'),
    getContainer: (idOrName) => { const c = d.containers.find(x => x.Id === idOrName || x.Names[0] === '/' + idOrName); return c ? cont(c) : { remove: async () => { throw new Error('no such container'); } }; },
    createContainer: async (spec) => { steps.push(`${name}:create ${spec.Image}`); const c = { Id: 'c' + Math.random().toString(16).slice(2, 8), Names: ['/' + spec.name], Image: spec.Image, Labels: spec.Labels, State: 'created', fail: d.failStart }; d.containers.push(c); return cont(c); },
    getImage: (ref) => ({
      inspect: async () => { if (!d.images.has(ref)) throw new Error('no such image'); return {}; },
      get: (cb) => cb(null, Readable.from(['tar'])),
      remove: async () => { if (d.containers.some(c => c.Image === ref)) throw new Error('in use'); d.images.delete(ref); steps.push(`${name}:rmi ${ref}`); },
    }),
    loadImage: (tar, opts, cb) => { steps.push(`${name}:load`); cb(null, 'stream'); },
    listImages: async () => [...d.images].map(t => ({ RepoTags: [t] })),
    pull: (ref, o, cb) => cb(new Error('should not pull')),
    modem: { followProgress: (s, done) => { for (const r of loads) r(); done(null); } },
  };
  const loads = [() => { if (steps.at(-1) === `${name}:load`) d.images.add(require('../../server/agent/deployer').IMAGE_REF); }];
  return d;
}
const local = fakeDaemon('dockgate'), remote = fakeDaemon('srv');
const dockerMod = require('../../server/docker');
dockerMod.createLocalClient = () => local.client;
dockerMod.createSshClient = () => remote.client;
const cp = require('node:child_process');
const realExecFile = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => { if (cmd === 'docker' && args[0] === 'build') { steps.push('dockgate:build ' + args[2]); local.images.add(args[2]); return cb(null, '', ''); } return realExecFile(cmd, args, opts, cb); };
const { stmts } = require('../../server/db');
stmts.insertServer.run('srv', 'ssh', '203.0.113.30', 22, 'deploy', null, null, null, '', 'test', 0);
const D = require('../../server/agent/deployer');

beforeEach(() => { steps.length = 0; remote.failStart = false; });

test('the tag follows the agent code: a changed file gives a new build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-src-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.1.0"}');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'a');
  const a = D.agentBuildInfo(dir);
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'b');
  const b = D.agentBuildInfo(dir);
  assert.equal(a.version, '1.1.0');
  assert.notEqual(a.build, b.build);
  assert.match(D.IMAGE_REF, /^dockgate-agent:\d+\.\d+\.\d+-[0-9a-f]{10}$/);
  assert.equal(D.isOldAgentTag('dockgate/agent:1.0.0'), true);
  assert.equal(D.isOldAgentTag(D.IMAGE_REF), false);
  assert.equal(D.isOldAgentTag('nginx:1.27'), false);
});

test('update of an old 1.0.0 agent: build once, copy, then swap; old image removed; no Docker Hub pull', async () => {
  remote.images.add('dockgate/agent:1.0.0');
  remote.containers.push({ Id: 'old1', Names: ['/dockgate-agent'], Image: 'dockgate/agent:1.0.0', Labels: { 'dockgate.role': 'agent', 'dockgate.version': '1.0.0' }, State: 'running' });
  const before = await D.statusOne('srv');
  assert.equal(before.updateAvailable, true, 'an agent without a build label is older');
  await D.installOne('srv', () => {}, () => {}, 'update');
  const i = (s) => steps.findIndex(x => x.startsWith(s));
  assert.ok(i('dockgate:build') >= 0 && i('srv:load') > i('dockgate:build'), 'built on DockGate, then copied');
  assert.ok(i('srv:stop /dockgate-agent') > i('srv:load'), 'the old agent stops only after the image arrived');
  assert.ok(i('srv:create ' + D.IMAGE_REF) > i('srv:rename'), 'old renamed before the new one is created');
  assert.ok(steps.includes('srv:rmi dockgate/agent:1.0.0'), 'old image removed');
  const after = await D.statusOne('srv');
  assert.equal(after.state, 'running'); assert.equal(after.build, D.AGENT_BUILD); assert.equal(after.updateAvailable, false);
  assert.equal(remote.containers.length, 1, 'the old container is gone');
});

test('a second update with the image already there copies nothing', async () => {
  await D.installOne('srv', () => {}, () => {}, 'update');
  assert.ok(!steps.some(s => s.includes('build') || s.includes('load')));
});

test('if the new agent does not start, the previous one is put back and running', async () => {
  remote.failStart = true;
  await assert.rejects(D.installOne('srv', () => {}, () => {}, 'update'), /port in use/);
  assert.equal(remote.containers.length, 1);
  assert.equal(remote.containers[0].Names[0], '/dockgate-agent');
  assert.equal(remote.containers[0].State, 'running');
  assert.ok(steps.includes('srv:start /dockgate-agent'));
});

test('reconfigure keeps the image the agent runs (settings change, code does not)', async () => {
  remote.containers[0].Image = 'dockgate/agent:1.0.0'; remote.containers[0].Labels['dockgate.build'] = '';
  remote.images.add('dockgate/agent:1.0.0');
  await D.installOne('srv', () => {}, () => {}, 'reconfigure');
  assert.ok(steps.includes('srv:create dockgate/agent:1.0.0'));
  assert.ok(!steps.some(s => s.includes('rmi') || s.includes('load')));
});
