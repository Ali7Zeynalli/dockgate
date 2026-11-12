'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-stacks-test-'));
const S = require('../../server/swarm-stacks');

// What `docker compose config --format json` gives for a small project.
const cfg = () => ({
  name: 'app',
  networks: { default: { name: 'app_default', ipam: {} } },
  services: {
    db: { restart: 'always', image: 'postgres:16', entrypoint: null, networks: { default: null }, volumes: [{ type: 'volume', source: 'appdata', target: '/var/lib/postgresql/data', volume: {} }] },
    web: { restart: 'unless-stopped', container_name: 'app-web', image: 'traefik/whoami:v1.10', entrypoint: null, networks: { default: null }, environment: { GREETING: 'hi' },
      depends_on: { db: { condition: 'service_healthy', required: true } }, ports: [{ mode: 'ingress', target: 8080, published: '18090', protocol: 'tcp', host_ip: '127.0.0.1' }], build: { context: '.' } },
    worker: { restart: 'on-failure:3', image: 'alpine', security_opt: ['no-new-privileges'], command: ['sleep', '9'] },
  },
  volumes: { appdata: { name: 'app_appdata' } },
});

test('restart → restart policy', () => {
  assert.deepEqual(S.restartPolicy('always'), { condition: 'any' });
  assert.deepEqual(S.restartPolicy('unless-stopped'), { condition: 'any' });
  assert.deepEqual(S.restartPolicy('no'), { condition: 'none' });
  assert.deepEqual(S.restartPolicy('on-failure:3'), { condition: 'on-failure', max_attempts: 3 });
});

test('adapt: what stack deploy rejects is removed or converted; volume names stay', () => {
  const st = S.adapt(cfg(), {}, { nodes: 1 });
  const web = st.services.web, db = st.services.db, worker = st.services.worker;
  assert.equal(web.container_name, undefined); assert.equal(web.build, undefined); assert.equal(web.restart, undefined);
  assert.deepEqual(web.depends_on, ['db']);
  assert.equal(web.ports, undefined, 'a port only on 127.0.0.1 is not published on Swarm (it would open on every server)');
  assert.equal(web.entrypoint, undefined, 'nulls are removed');
  assert.deepEqual(web.networks, { default: { aliases: ['app-web'] } }, 'the old container name stays reachable');
  assert.equal(web.deploy.replicas, 1); assert.equal(web.deploy.update_config.order, 'start-first'); assert.equal(web.deploy.update_config.failure_action, 'rollback');
  assert.equal(db.deploy.update_config.order, 'stop-first', 'a service with data never runs two copies');
  assert.deepEqual(worker.deploy.restart_policy, { condition: 'on-failure', max_attempts: 3, delay: '5s' });
  assert.equal(worker.security_opt, undefined);
  assert.deepEqual(st.volumes, { appdata: { name: 'app_appdata' } });
  assert.deepEqual(st.networks.default, { name: 'app_default', driver: 'overlay', attachable: true });
  assert.equal(st.name, undefined);
});

test('adapt: settings, databases at 1, host ports, several servers and encryption', () => {
  const st = S.adapt(cfg(), { services: { web: { replicas: 3, portMode: 'host', localPorts: 'host' }, db: { replicas: 3 }, worker: { replicas: 2, order: 'stop-first' } } }, { nodes: 3, hostname: 'vps1', encrypt: true });
  assert.equal(st.services.web.deploy.replicas, 3);
  assert.equal(st.services.web.ports[0].mode, 'host'); assert.equal(st.services.web.deploy.update_config.order, 'stop-first');
  assert.equal(st.services.db.deploy.replicas, 1, 'a database stays at 1');
  assert.deepEqual(st.services.db.deploy.placement.constraints, ['node.hostname == vps1'], 'data stays on its server');
  assert.equal(st.services.web.deploy.placement, undefined);
  assert.equal(st.services.worker.deploy.update_config.order, 'stop-first');
  assert.deepEqual(st.networks.default.driver_opts, { encrypted: '' });
});

test('adapt keeps external networks and the deploy section of the file', () => {
  const c = cfg();
  c.networks.proxy = { name: 'proxy', external: true };
  c.services.worker.deploy = { replicas: 4, resources: { limits: { memory: '64M' } } };
  const st = S.adapt(c, {}, { nodes: 1 });
  assert.deepEqual(st.networks.proxy, { name: 'proxy', external: true });
  assert.equal(st.services.worker.deploy.replicas, 4);
  assert.deepEqual(st.services.worker.deploy.resources, { limits: { memory: '64M' } });
});

test('adapt: resource fields become deploy.resources; shm_size a /dev/shm tmpfs; deploy: wins', () => {
  const c = cfg();
  Object.assign(c.services.db, { mem_limit: '536870912', mem_reservation: '134217728', cpus: 1.5, pids_limit: 200, shm_size: '268435456' });
  Object.assign(c.services.worker, { cpu_quota: 50000, cpu_period: 100000, mem_limit: '100000000', deploy: { resources: { limits: { memory: '64M' } } } });
  const st = S.adapt(c, {}, { nodes: 1 });
  assert.deepEqual(st.services.db.deploy.resources, { limits: { memory: '512M', cpus: '1.5', pids: 200 }, reservations: { memory: '128M' } });
  assert.ok(st.services.db.volumes.some(v => v.type === 'tmpfs' && v.target === '/dev/shm' && v.tmpfs.size === 268435456));
  for (const k of ['mem_limit', 'mem_reservation', 'cpus', 'pids_limit', 'shm_size']) assert.equal(st.services.db[k], undefined, k);
  assert.deepEqual(st.services.worker.deploy.resources.limits, { memory: '64M', cpus: '0.5' }, 'quota/period → cpus; the deploy section keeps its memory');
});

test('adapt: links become aliases, volumes_from shares the mounts, fixed addresses go', () => {
  const c = cfg();
  c.services.worker.links = ['db:database'];
  c.services.worker.volumes_from = ['db:ro'];
  c.services.worker.networks = { default: { ipv4_address: '172.20.0.9' } };
  const st = S.adapt(c, {}, { nodes: 1 });
  assert.deepEqual(st.services.db.networks.default.aliases, ['database']);
  assert.deepEqual(st.services.worker.volumes, [{ type: 'volume', source: 'appdata', target: '/var/lib/postgresql/data', volume: {}, read_only: true }]);
  assert.deepEqual(st.services.worker.networks, { default: {} });
  assert.equal(st.services.worker.links, undefined); assert.equal(st.services.worker.volumes_from, undefined);
});

test('adapt: ports — 127.0.0.1 inside or host mode, an address → host mode, network_mode host → host network', () => {
  const c = cfg();
  c.services.web.ports.push({ mode: 'ingress', target: 9000, published: '9000', protocol: 'tcp', host_ip: '10.0.0.5' }, { mode: 'ingress', target: 80, published: '80', protocol: 'tcp' });
  let st = S.adapt(c, {}, { nodes: 1 });
  assert.deepEqual(st.services.web.ports, [{ target: 9000, published: 9000, protocol: 'tcp', mode: 'host' }, { target: 80, published: 80, protocol: 'tcp', mode: 'host' }], 'loopback dropped; a bound address makes the service host mode');
  st = S.adapt(cfg(), { services: { web: { localPorts: 'host' } } }, { nodes: 1 });
  assert.deepEqual(st.services.web.ports, [{ target: 8080, published: 18090, protocol: 'tcp', mode: 'host' }]);
  assert.equal(st.services.web.deploy.update_config.order, 'stop-first');
  const h = cfg(); h.services.worker.network_mode = 'host'; h.services.worker.ports = [{ target: 1, published: '1' }];
  st = S.adapt(h, {}, { nodes: 1 });
  assert.deepEqual(st.services.worker.networks, { host_net: {} }); assert.equal(st.services.worker.ports, undefined); assert.equal(st.services.worker.network_mode, undefined);
  assert.deepEqual(st.networks.host_net, { external: true, name: 'host' });
});

test('resourcesOf, aliasesOf and portScope', () => {
  assert.deepEqual(S.resourcesOf({ mem_limit: '1000' }).limits, { memory: '1000b' });
  assert.deepEqual([...S.aliasesOf({ services: { a: { container_name: 'old-a' }, b: { links: ['a', 'a:alpha'] } } }).a], ['old-a', 'alpha']);
  assert.equal(S.portScope({ host_ip: '127.0.0.1' }), 'local'); assert.equal(S.portScope({ host_ip: '::1' }), 'local');
  assert.equal(S.portScope({ host_ip: '0.0.0.0' }), 'any'); assert.equal(S.portScope({}), 'any'); assert.equal(S.portScope({ host_ip: '192.168.1.4' }), 'address');
});

test('startLevels orders services by depends_on; none or a loop → null', () => {
  const st = (d) => ({ services: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { depends_on: v }])) });
  assert.deepEqual(S.startLevels(st({ db: [], cache: [], api: ['db', 'cache'], web: ['api'] })), [['db', 'cache'], ['api'], ['web']]);
  assert.equal(S.startLevels(st({ a: [], b: [] })), null);
  assert.equal(S.startLevels(st({ a: ['b'], b: ['a'] })), null);
  assert.deepEqual(S.startLevels(st({ a: ['gone'], b: ['a'] })), [['a'], ['b']], 'a dependency outside the stack is ignored');
});

test('adapt: a shared Compose bridge (external) becomes its overlay twin; other external networks stay', () => {
  const c = cfg();
  c.networks.web = { name: 'web', external: true };
  c.networks.edge = { name: 'edge', external: true };
  const st = S.adapt(c, {}, { nodes: 1, twins: { web: 'web-swarm' } });
  assert.deepEqual(st.networks.web, { external: true, name: 'web-swarm' });
  assert.deepEqual(st.networks.edge, { name: 'edge', external: true });
  assert.equal(S.twinName('web'), 'web-swarm');
});
