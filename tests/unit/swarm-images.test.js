'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swimg-test-'));
const SI = require('../../server/swarm-images');

const svc = (id, name, image) => ({ ID: id, Spec: { Name: name, TaskTemplate: { ContainerSpec: { Image: image } } } });
const client = (services) => ({ listServices: async () => services, version: async () => ({ Os: 'linux', Arch: 'x86_64' }) });

test('splitImage separates the tag from the pinned digest', () => {
  assert.deepEqual(SI.splitImage('nginx:1.27@sha256:abc'), { tagRef: 'nginx:1.27', digest: 'sha256:abc' });
  assert.deepEqual(SI.splitImage('localhost:5000/app:1'), { tagRef: 'localhost:5000/app:1', digest: null });
});

test('a service is "update" when the registry digest of its tag differs, "current" when it matches', async () => {
  const c = client([svc('a', 'web', 'nginx:1.27@sha256:old'), svc('b', 'api', 'redis:7@sha256:same'), svc('c', 'local', 'myapp:dev')]);
  const asked = [];
  const rows = await SI.check(c, 'cl1', {
    fetchDigest: async (reg, repo, tag) => { asked.push(`${repo}:${tag}`); return repo === 'library/nginx' || repo === 'nginx' ? 'sha256:new' : 'sha256:same'; },
    fetchConfig: async () => ({ config: { Labels: { 'org.opencontainers.image.version': '1.27.4' } }, created: '2026-11-01T00:00:00Z' }),
  });
  const by = Object.fromEntries(rows.map(r => [r.service_name, r]));
  assert.equal(by.web.status, 'update');
  assert.equal(by.web.remote_digest, 'sha256:new');
  assert.equal(by.web.remote_version, '1.27.4');
  assert.equal(by.api.status, 'current');
  assert.equal(by.local.status, 'skip', 'no digest recorded: nothing to compare');
  assert.equal(asked.length, 2, 'the service without a digest is not asked for');
  assert.deepEqual(SI.unannounced('cl1').map(r => r.service_name), ['web']);
  SI.announce('cl1', SI.unannounced('cl1'));
  assert.deepEqual(SI.unannounced('cl1'), [], 'announced once per new digest');
});

test('a registry error is stored per service, and removed services are dropped', async () => {
  await SI.check(client([svc('a', 'web', 'nginx:1.27@sha256:old')]), 'cl2', { fetchDigest: async () => { throw new Error('not authorized'); }, fetchConfig: async () => null });
  let r = SI.results('cl2');
  assert.equal(r.a.status, 'error');
  assert.match(r.a.error, /not authorized/);
  await SI.check(client([]), 'cl2', { fetchDigest: async () => 'x', fetchConfig: async () => null });
  r = SI.results('cl2');
  assert.deepEqual(Object.keys(r), []);
});
