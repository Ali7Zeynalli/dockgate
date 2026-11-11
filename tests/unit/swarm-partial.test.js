'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swpart-test-'));
const ST = require('../../server/swarm-stacks');
const FE = require('../../server/file-edit');

const cfg = {
  name: 'shop',
  services: {
    web: { image: 'nginx:1.27', depends_on: { api: { condition: 'service_started' }, gpu: { condition: 'service_started' } }, volumes: [{ type: 'volume', source: 'html', target: '/usr/share/nginx/html' }] },
    api: { image: 'api:1' },
    gpu: { image: 'worker:1', devices: ['/dev/dri'] },
  },
  networks: { default: { name: 'shop_default' } },
  volumes: { html: { name: 'shop_html' }, ext: { external: true, name: 'shared' } },
};

test('part of a project: only the moving services, depends_on kept to them, volumes by their Compose name', () => {
  const out = ST.adapt(cfg, {}, { nodes: 1, only: ['web', 'api'], project: 'shop' });
  assert.deepEqual(Object.keys(out.services).sort(), ['api', 'web']);
  assert.deepEqual(out.services.web.depends_on, ['api'], 'gpu stays in Compose: not a stack service');
  assert.deepEqual(out.volumes.html, { external: true, name: 'shop_html' }, 'same volume as in Compose: the data stays');
  assert.deepEqual(out.volumes.ext, { external: true, name: 'shared' });
  assert.equal(out.networks.default.name, undefined, 'the stack makes its own network; the Compose one keeps its name');
  assert.equal(out.networks.default.driver, 'overlay');
});

test('a whole project keeps the Compose names as they are', () => {
  const out = ST.adapt(cfg, {}, { nodes: 1 });
  assert.equal(Object.keys(out.services).length, 3);
  assert.equal(out.volumes.html.name, 'shop_html');
  assert.equal(out.volumes.html.external, undefined);
  assert.equal(out.networks.default.name, 'shop_default');
});

test('file paths can not leave / or the volume', () => {
  assert.equal(FE.confine('../../etc/passwd'), '/etc/passwd');
  assert.equal(FE.confine('/a/./b/../c'), '/a/c');
  assert.equal(FE.confine('../../x', { root: '/volume' }), '/volume/x');
  assert.equal(FE.confine('', { root: '/volume' }), '/volume/');
});
