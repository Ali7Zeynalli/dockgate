'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-imgupd-test-'));
const IU = require('../../server/image-updates');

test('parseRef: Docker Hub, other registries, ports, default tag, IDs and digests', () => {
  assert.deepEqual(IU.parseRef('nginx:1.27'), { host: 'docker.io', repo: 'nginx', tag: '1.27' });
  assert.deepEqual(IU.parseRef('grafana/grafana'), { host: 'docker.io', repo: 'grafana/grafana', tag: 'latest' });
  assert.deepEqual(IU.parseRef('ghcr.io/acme/api:2.4.1'), { host: 'ghcr.io', repo: 'acme/api', tag: '2.4.1' });
  assert.deepEqual(IU.parseRef('localhost:5000/app:dev'), { host: 'localhost:5000', repo: 'app', tag: 'dev' });
  assert.deepEqual(IU.parseRef('nginx@sha256:abc'), { pinned: true });
  assert.equal(IU.parseRef('sha256:0123456789ab'), null);
});

test('checkServer: newer, current, built locally, pinned, registry error; one lookup per tag', async () => {
  const img = (id, digests) => ({ Id: id, RepoDigests: digests });
  const docker = {
    listContainers: async () => [
      { Image: 'nginx:1.27', ImageID: 'i1' }, { Image: 'nginx:1.27', ImageID: 'i1' },
      { Image: 'postgres:16', ImageID: 'i2' }, { Image: 'shop-web:dev', ImageID: 'i3' },
      { Image: 'redis@sha256:x', ImageID: 'i4' }, { Image: 'ghcr.io/acme/api:2', ImageID: 'i5' },
    ],
    listImages: async () => [img('i1', ['nginx@sha256:old']), img('i2', ['postgres@sha256:same']), img('i3', []), img('i4', ['redis@sha256:x']), img('i5', ['ghcr.io/acme/api@sha256:a'])],
  };
  const calls = [];
  const fetchDigest = async (reg, repo, tag) => {
    calls.push(`${reg.server_address}/${repo}:${tag}`);
    if (repo === 'nginx') return 'sha256:new';
    if (repo === 'postgres') return 'sha256:same';
    throw new Error('not authorized');
  };
  const fetchConfig = async (reg, repo) => ({ created: '2026-11-05T10:00:00Z', config: { Env: [repo === 'nginx' ? 'NGINX_VERSION=1.27.5' : 'X=1'] } });
  const rows = await IU.checkServer('srv1', docker, { fetchDigest, fetchConfig });
  const by = Object.fromEntries(rows.map(r => [r.image, r]));
  assert.equal(by['nginx:1.27'].status, 'update');
  assert.equal(by['nginx:1.27'].remote_digest, 'sha256:new');
  assert.equal(by['nginx:1.27'].remote_version, '1.27.5', 'version read from the registry config');
  assert.equal(by['postgres:16'].remote_version, null, 'no config fetch for an image that is current');
  assert.equal(by['postgres:16'].status, 'current');
  assert.equal(by['shop-web:dev'].status, 'skip');
  assert.equal(by['redis@sha256:x'].status, 'skip');
  assert.equal(by['ghcr.io/acme/api:2'].status, 'error');
  assert.equal(calls.filter(c => c.includes('nginx')).length, 1, 'same tag looked up once');
  assert.deepEqual(IU.unannounced('srv1').map(r => r.image), ['nginx:1.27']);
  IU.announce('srv1', IU.unannounced('srv1'));
  assert.equal(IU.unannounced('srv1').length, 0, 'announced once per digest');
});

test('versionOf: repo-named env, aliases, OCI label, helper vars ignored', () => {
  assert.equal(IU.versionOf({ Env: ['PATH=/x', 'GOSU_VERSION=1.17', 'PG_MAJOR=15', 'PG_VERSION=15.19'] }, 'postgres'), '15.19');
  assert.equal(IU.versionOf({ Env: ['NGINX_VERSION=1.27.5', 'NJS_VERSION=0.8.10', 'PKG_RELEASE=1'] }, 'nginx'), '1.27.5');
  assert.equal(IU.versionOf({ Env: ['REDIS_VERSION=7.4.12'] }, 'bitnami/redis'), '7.4.12');
  assert.equal(IU.versionOf({ Env: ['GOSU_VERSION=1.17'], Labels: { 'org.opencontainers.image.version': 'v3.1.7' } }, 'traefik'), 'v3.1.7');
  assert.equal(IU.versionOf({ Env: ['GOSU_VERSION=1.17', 'YARN_VERSION=1.22'] }, 'myapp'), null, 'only helper versions → unknown');
  assert.equal(IU.versionOf({ Env: ['APP_VERSION=2.0'] }, 'ghcr.io/acme/api'), '2.0', 'another *_VERSION as a last resort');
  assert.equal(IU.versionOf({ Labels: { 'org.opencontainers.image.version': 'latest' } }, 'x'), null);
  assert.equal(IU.versionOf(null, 'x'), null);
});

test('checkServer compares the image the TAG points at, not the first container\'s image', async () => {
  const docker = {
    listContainers: async () => [{ Image: 'app:stable', ImageID: 'old' }, { Image: 'app:stable', ImageID: 'new' }],
    listImages: async () => [{ Id: 'new', RepoTags: ['app:stable'], RepoDigests: ['app@sha256:n'] }, { Id: 'old', RepoTags: [], RepoDigests: ['app@sha256:o'] }],
  };
  const rows = await IU.checkServer('srv2', docker, { fetchDigest: async () => 'sha256:n', fetchConfig: async () => null });
  assert.equal(rows.find(r => r.image === 'app:stable').status, 'current');
});

test('staleContainers: a container on an older image than its tag (also when Docker lists it by ID)', async () => {
  const docker = {
    listContainers: async () => [
      { Id: 'c1', Image: 'app:stable', ImageID: 'new' },
      { Id: 'c2', Image: 'aaaaaaaaaaaa', ImageID: 'old' },
      { Id: 'c3', Image: 'nginx', ImageID: 'ng' },
    ],
    listImages: async () => [{ Id: 'new', RepoTags: ['app:stable'] }, { Id: 'old', RepoTags: ['dockgate-rollback/x:previous'] }, { Id: 'ng', RepoTags: ['nginx:latest'] }],
    getContainer: (id) => ({ inspect: async () => ({ Config: { Image: id === 'c2' ? 'app:stable' : 'x' } }) }),
    getImage: () => ({ inspect: async () => ({ Config: { Env: ['APP_VERSION=1.1'] }, Created: '2026-11-09T10:00:00Z' }) }),
  };
  const st = await IU.staleContainers(docker);
  assert.deepEqual([...st.keys()], ['c2']);
  assert.equal(st.get('c2').version, '1.1');
  assert.equal(st.get('c2').image, 'app:stable');
  assert.equal(st.get('c2').imageId, 'new');
});
