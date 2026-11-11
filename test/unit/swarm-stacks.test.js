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
  assert.deepEqual(web.ports, [{ target: 8080, published: 18090, protocol: 'tcp', mode: 'ingress' }], 'number port, host_ip dropped');
  assert.equal(web.entrypoint, undefined, 'nulls are removed');
  assert.deepEqual(web.networks, { default: {} });
  assert.equal(web.deploy.replicas, 1); assert.equal(web.deploy.update_config.order, 'start-first'); assert.equal(web.deploy.update_config.failure_action, 'rollback');
  assert.equal(db.deploy.update_config.order, 'stop-first', 'a service with data never runs two copies');
  assert.deepEqual(worker.deploy.restart_policy, { condition: 'on-failure', max_attempts: 3, delay: '5s' });
  assert.equal(worker.security_opt, undefined);
  assert.deepEqual(st.volumes, { appdata: { name: 'app_appdata' } });
  assert.deepEqual(st.networks.default, { name: 'app_default', driver: 'overlay', attachable: true });
  assert.equal(st.name, undefined);
});

test('adapt: settings, databases at 1, host ports, several servers and encryption', () => {
  const st = S.adapt(cfg(), { services: { web: { replicas: 3, portMode: 'host' }, db: { replicas: 3 }, worker: { replicas: 2, order: 'stop-first' } } }, { nodes: 3, hostname: 'vps1', encrypt: true });
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
