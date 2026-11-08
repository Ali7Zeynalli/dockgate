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
  const rows = await IU.checkServer('srv1', docker, { fetchDigest });
  const by = Object.fromEntries(rows.map(r => [r.image, r]));
  assert.equal(by['nginx:1.27'].status, 'update');
  assert.equal(by['nginx:1.27'].remote_digest, 'sha256:new');
  assert.equal(by['postgres:16'].status, 'current');
  assert.equal(by['shop-web:dev'].status, 'skip');
  assert.equal(by['redis@sha256:x'].status, 'skip');
  assert.equal(by['ghcr.io/acme/api:2'].status, 'error');
  assert.equal(calls.filter(c => c.includes('nginx')).length, 1, 'same tag looked up once');
  assert.deepEqual(IU.unannounced('srv1').map(r => r.image), ['nginx:1.27']);
  IU.announce('srv1', IU.unannounced('srv1'));
  assert.equal(IU.unannounced('srv1').length, 0, 'announced once per digest');
});
