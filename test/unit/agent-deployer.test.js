// Edge agent updates: the image tag follows the agent's code, the new image is on the server before the old agent
// stops, a failed start puts the old agent back, reconfigure keeps the running image, old images are cleaned up.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-deployer-test-'));
delete process.env.AGENT_IMAGE;
process.env.AGENT_STARTUP_WATCH_MS = '0';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const steps = []; let buildCtx = null;
function fakeDaemon(name) {
  const d = { name, images: new Map(), containers: [], failStart: false, crash: false, arch: 'x86_64' };
  const imgArch = () => (d.arch === 'aarch64' ? 'arm64' : 'amd64');
  const cont = (c) => ({
    stop: async () => { steps.push(`${name}:stop ${c.Names[0]}`); c.State = 'exited'; },
    rename: async ({ name: n }) => { steps.push(`${name}:rename ${c.Names[0]} -> /${n}`); c.Names = ['/' + n]; },
    remove: async () => { steps.push(`${name}:remove ${c.Names[0]}`); d.containers = d.containers.filter(x => x !== c); },
    start: async () => { if (c.fail) throw new Error('port in use'); steps.push(`${name}:start ${c.Names[0]}`); c.State = 'running'; },
    inspect: async () => ({ State: c.crash ? { Running: false, Restarting: true, ExitCode: 255 } : { Running: c.State === 'running', Restarting: false, ExitCode: 0 } }),
    logs: async () => Buffer.from('exec /usr/local/bin/docker-entrypoint.sh: exec format error\n'),
  });
  d.client = {
    listContainers: async () => d.containers.filter(c => c.Labels['dockgate.role'] === 'agent'),
    getContainer: (idOrName) => { const c = d.containers.find(x => x.Id === idOrName || x.Names[0] === '/' + idOrName); return c ? cont(c) : { remove: async () => { throw new Error('no such container'); } }; },
    createContainer: async (spec) => { steps.push(`${name}:create ${spec.Image}`); const c = { Id: 'c' + Math.random().toString(16).slice(2, 8), Names: ['/' + spec.name], Image: spec.Image, Labels: spec.Labels, State: 'created', fail: d.failStart, crash: d.crash }; d.containers.push(c); return cont(c); },
    getImage: (ref) => ({
      inspect: async () => { if (!d.images.has(ref)) throw new Error('no such image'); return { Architecture: d.images.get(ref) }; },
      get: (cb) => cb(null, Readable.from(['tar'])),
      remove: async (o) => { if (!(o && o.force) && d.containers.some(c => c.Image === ref)) throw new Error('in use'); d.images.delete(ref); steps.push(`${name}:rmi ${ref}`); },
    }),
    loadImage: (tar, opts, cb) => { steps.push(`${name}:load`); cb(null, 'stream'); },
    buildImage: (ctx, opts, cb) => { steps.push(`${name}:build ${opts.t}`); buildCtx = ctx; d.images.set(opts.t, imgArch()); cb(null, 'stream'); },
    info: async () => ({ Architecture: d.arch }),
    listImages: async () => [...d.images.keys()].map(t => ({ RepoTags: [t] })),
    pull: (ref, o, cb) => { steps.push(`${name}:pull ${ref}`); if (!d.pullable) return cb(new Error('denied')); d.images.set(ref, imgArch()); cb(null, 'stream'); },
    modem: { followProgress: (s, done) => { for (const r of loads) r(); done(null); } },
  };
  // a copied image keeps the CPU it was built for (DockGate's host)
  const loads = [() => { if (steps.at(-1) === `${name}:load`) d.images.set(require('../../server/agent/deployer').IMAGE_REF, local.images.get(require('../../server/agent/deployer').IMAGE_REF)); }];
  return d;
}
const local = fakeDaemon('dockgate'), remote = fakeDaemon('srv');
const dockerMod = require('../../server/docker');
dockerMod.createLocalClient = () => local.client;
dockerMod.createSshClient = () => remote.client;
const { stmts } = require('../../server/db');
stmts.insertServer.run('srv', 'ssh', '203.0.113.30', 22, 'deploy', null, null, null, '', 'test', 0);
const D = require('../../server/agent/deployer');

beforeEach(() => { steps.length = 0; remote.failStart = false; remote.crash = false; remote.pullable = false; });

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
  assert.match(D.IMAGE_REF, /^ghcr\.io\/ali7zeynalli\/dockgate-agent:\d+\.\d+\.\d+-[0-9a-f]{10}$/);
  assert.equal(D.isOldAgentTag('dockgate-agent:1.1.0-091f83fc8e'), true, 'a 2.22.x local tag is old');
  const cli = require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '../../agent/build-info.js')], { encoding: 'utf8' }).trim();
  assert.equal(D.IMAGE_REF.split(':').pop(), cli, 'CI (agent/build-info.js) publishes exactly the tag DockGate asks for');
  assert.equal(D.isOldAgentTag('dockgate/agent:1.0.0'), true);
  assert.equal(D.isOldAgentTag(D.IMAGE_REF), false);
  assert.equal(D.isOldAgentTag('nginx:1.27'), false);
});

test('update of an old 1.0.0 agent with no published image to pull: build once, copy, then swap; old image removed', async () => {
  remote.images.set('dockgate/agent:1.0.0', 'amd64');
  remote.containers.push({ Id: 'old1', Names: ['/dockgate-agent'], Image: 'dockgate/agent:1.0.0', Labels: { 'dockgate.role': 'agent', 'dockgate.version': '1.0.0' }, State: 'running' });
  const before = await D.statusOne('srv');
  assert.equal(before.updateAvailable, true, 'an agent without a build label is older');
  await D.installOne('srv', () => {}, () => {}, 'update');
  const i = (s) => steps.findIndex(x => x.startsWith(s));
  assert.ok(i('dockgate:build') >= 0 && i('srv:load') > i('dockgate:build'), 'built on DockGate, then copied');
  assert.ok(buildCtx.src.includes('Dockerfile') && buildCtx.src.includes('src/index.js'), 'built through the Docker API from the agent folder (no docker CLI / buildx)');
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
  remote.images.set('dockgate/agent:1.0.0', 'amd64');
  await D.installOne('srv', () => {}, () => {}, 'reconfigure');
  assert.ok(steps.includes('srv:create dockgate/agent:1.0.0'));
  assert.ok(!steps.some(s => s.includes('rmi') || s.includes('load')));
});

test('a new agent that dies right after starting fails the job and the previous one comes back', async () => {
  remote.crash = true;
  await assert.rejects(D.installOne('srv', () => {}, () => {}, 'update'), /stopped right after starting \(exit 255\): exec .*exec format error/);
  assert.equal(remote.containers.length, 1);
  assert.equal(remote.containers[0].Names[0], '/dockgate-agent');
  assert.equal(remote.containers[0].State, 'running');
});

test('an ARM server managed from an x86 DockGate: the agent is built on the server, nothing is copied', async () => {
  remote.arch = 'aarch64';
  // what an earlier version left there: the x86 image copied over
  remote.images.set(D.IMAGE_REF, 'amd64');
  const lines = [];
  await D.installOne('srv', (l) => lines.push(l), () => {}, 'update');
  assert.ok(steps.includes(`srv:rmi ${D.IMAGE_REF}`), 'the wrong-CPU image is removed');
  assert.ok(steps.includes(`srv:build ${D.IMAGE_REF}`), 'built on the server');
  assert.ok(!steps.some(s => s === 'srv:load'), 'not copied');
  assert.equal(remote.images.get(D.IMAGE_REF), 'arm64');
  assert.match(lines.join(''), /the server is arm64, DockGate's host is amd64/);
  remote.arch = 'x86_64';
});

test('the published multi-arch image is pulled on the server: nothing built or copied', async () => {
  remote.arch = 'aarch64'; remote.pullable = true;
  remote.images.delete(D.IMAGE_REF);
  await D.installOne('srv', () => {}, () => {}, 'update');
  assert.ok(steps.includes(`srv:pull ${D.IMAGE_REF}`));
  assert.ok(!steps.some(s => /build|load/.test(s)), steps.join(' | '));
  assert.equal(remote.images.get(D.IMAGE_REF), 'arm64');
  const st = await D.statusOne('srv');
  assert.equal(st.updateAvailable, false);
  remote.arch = 'x86_64';
});
