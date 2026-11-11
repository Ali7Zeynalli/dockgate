'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-svc-test-'));
const S = require('../../server/swarm-services');

test('durations, sizes and command lines', () => {
  assert.equal(S.parseDur('10s'), 10e9); assert.equal(S.parseDur('1m30s'), 90e9); assert.equal(S.parseDur('500ms'), 5e8); assert.equal(S.parseDur('15'), 15e9);
  assert.equal(S.parseDur(''), undefined); assert.throws(() => S.parseDur('soon'), /10s/);
  assert.equal(S.fmtDur(90e9), '1m30s'); assert.equal(S.fmtDur(5e8), '500ms');
  assert.equal(S.parseBytes('512M'), 512 * 1024 ** 2); assert.equal(S.parseBytes('1g'), 1024 ** 3); assert.throws(() => S.parseBytes('lots'), /512M/);
  assert.deepEqual(S.splitArgs(`--name "api server" --x='a b' plain\\ space`), ['--name', 'api server', '--x=a b', 'plain space']);
  assert.throws(() => S.splitArgs('a "b'), /quote/);
});

test('a new service gets safe defaults', () => {
  const f = S.newForm(); f.name = 'api'; f.general.image = 'nginx:1.27';
  const spec = S.specFromForm(f, null);
  assert.deepEqual(spec.Mode, { Replicated: { Replicas: 1 } });
  assert.equal(spec.UpdateConfig.Order, 'start-first'); assert.equal(spec.UpdateConfig.FailureAction, 'rollback'); assert.equal(spec.UpdateConfig.Monitor, 15e9);
  assert.equal(spec.TaskTemplate.RestartPolicy.Condition, 'any');
  assert.deepEqual(spec.TaskTemplate.LogDriver, { Name: 'json-file', Options: { 'max-size': '10m', 'max-file': '3' } });
});

test('form → spec → form keeps the values; unknown spec fields survive an edit', () => {
  const f = S.newForm(); f.name = 'api'; f.general.image = 'whoami:1'; f.general.replicas = 3; f.general.command = '--port 8080';
  f.resources.memory = '64M'; f.resources.cpus = 0.5; f.placement.constraints = ['node.labels.db==true']; f.placement.spread = ['node.labels.zone'];
  f.env.env = ['A=1']; f.network.ports = [{ published: 80, target: 8080, protocol: 'tcp', mode: 'host' }]; f.mounts = [{ type: 'volume', source: 'data', target: '/data' }];
  f.health = { mode: 'custom', test: 'curl -f localhost || exit 1', interval: '10s', retries: 3 };
  const spec = S.specFromForm(f, null);
  assert.equal(spec.UpdateConfig.Order, 'stop-first', 'host-mode ports force stop-first');
  assert.deepEqual(spec.TaskTemplate.ContainerSpec.Healthcheck.Test, ['CMD-SHELL', 'curl -f localhost || exit 1']);
  const back = S.formFromSpec(spec);
  assert.equal(back.general.replicas, 3); assert.equal(back.general.command, '--port 8080'); assert.equal(back.resources.memory, '64M');
  assert.deepEqual(back.placement.spread, ['node.labels.zone']); assert.equal(back.health.interval, '10s');
  spec.TaskTemplate.ContainerSpec.Privileges = { NoNewPrivileges: true }; spec.TaskTemplate.ContainerSpec.Image = 'whoami:1@sha256:abc';
  const again = S.specFromForm(back, spec);
  assert.deepEqual(again.TaskTemplate.ContainerSpec.Privileges, { NoNewPrivileges: true });
  assert.equal(again.TaskTemplate.ContainerSpec.Image, 'whoami:1@sha256:abc', 'the pinned digest stays when the image did not change');
  back.general.mode = 'global';
  assert.throws(() => S.specFromForm(back, spec), /mode/);
});

test('form validation', () => {
  const base = () => { const f = S.newForm(); f.name = 'x'; f.general.image = 'nginx'; return f; };
  const bad = (fn, re) => { const f = base(); fn(f); assert.throws(() => S.specFromForm(f, null), re); };
  bad(f => { f.name = 'bad name'; }, /Name/);
  bad(f => { f.placement.constraints = ['zone=eu']; }, /Constraint/);
  bad(f => { f.mounts = [{ type: 'bind', source: 'rel', target: '/x' }]; }, /absolute/);
  bad(f => { f.network.ports = [{ target: 80, mode: 'ingress' }]; f.network.endpointMode = 'dnsrr'; }, /DNS round robin/);
  bad(f => { f.resources.memory = '1M'; }, /6M/);
  bad(f => { f.advanced.ulimits = ['nofile'];}, /Ulimit/);
  bad(f => { f.env.secrets = [{ name: 'nope' }]; }, /does not exist/);
});

test('database images are recognised', () => {
  for (const i of ['postgres:16', 'library/mysql:8', 'bitnami/redis:7', 'mongo', 'docker.io/library/mariadb:11']) assert.equal(S.isDatabase(i), true, i);
  for (const i of ['nginx', 'traefik/whoami', 'ghcr.io/acme/postgres-exporter:1']) assert.equal(S.isDatabase(i), false, i);
});
