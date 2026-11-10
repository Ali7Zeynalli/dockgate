'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-iurun-test-'));
const R = require('../../server/image-update-runner');

test('configFrom keeps what the user set and drops what came from the old image', () => {
  const info = {
    Id: 'abcdef123456789', Name: '/db',
    Config: {
      Hostname: 'abcdef123456', Env: ['PATH=/usr/bin', 'PG_VERSION=15.8', 'POSTGRES_PASSWORD=x'],
      Cmd: ['postgres'], Entrypoint: ['docker-entrypoint.sh'], WorkingDir: '/', User: '',
      Labels: { 'org.opencontainers.image.version': '15.8', team: 'a' }, ExposedPorts: { '5432/tcp': {}, '9187/tcp': {} },
      Healthcheck: { Test: ['CMD', 'pg_isready'] },
    },
    HostConfig: { Binds: ['pg:/var/lib/postgresql/data'] },
  };
  const img = { Env: ['PATH=/usr/bin', 'PG_VERSION=15.8'], Cmd: ['postgres'], Entrypoint: ['docker-entrypoint.sh'], WorkingDir: '/',
    Labels: { 'org.opencontainers.image.version': '15.8' }, ExposedPorts: { '5432/tcp': {} } };
  const c = R.configFrom(info, 'postgres:15-alpine', img);
  assert.deepEqual(c.Env, ['POSTGRES_PASSWORD=x'], 'image env (PG_VERSION) is not pinned onto the new image');
  assert.equal(c.Cmd, undefined); assert.equal(c.Entrypoint, undefined); assert.equal(c.WorkingDir, undefined);
  assert.deepEqual(c.Labels, { team: 'a' });
  assert.deepEqual(c.ExposedPorts, { '9187/tcp': {} });
  assert.deepEqual(c.Healthcheck, { Test: ['CMD', 'pg_isready'] }, 'a healthcheck the user added is kept');
  assert.equal(c.Hostname, undefined, 'hostname made from the old ID is dropped');
  assert.equal(c.name, 'db');
  assert.deepEqual(c.HostConfig.Binds, ['pg:/var/lib/postgresql/data']);
});

test('configFrom: a user Cmd is kept; a user Entrypoint carries its Cmd', () => {
  const base = { Id: 'x1', Name: '/a', HostConfig: {} };
  const img = { Cmd: ['nginx', '-g', 'daemon off;'], Entrypoint: ['/docker-entrypoint.sh'] };
  let c = R.configFrom({ ...base, Config: { Cmd: ['nginx', '-T'], Entrypoint: ['/docker-entrypoint.sh'] } }, 'nginx', img);
  assert.deepEqual(c.Cmd, ['nginx', '-T']); assert.equal(c.Entrypoint, undefined);
  c = R.configFrom({ ...base, Config: { Cmd: ['nginx', '-g', 'daemon off;'], Entrypoint: ['/bin/sh', '-c'] } }, 'nginx', img);
  assert.deepEqual(c.Entrypoint, ['/bin/sh', '-c']); assert.deepEqual(c.Cmd, ['nginx', '-g', 'daemon off;']);
});

test('rollback tag names and tag split', () => {
  assert.equal(R._rollbackRepo('Shop_App-1'), 'dockgate-rollback/shop_app-1');
  assert.equal(R._rollbackRepo('my app!'), 'dockgate-rollback/my-app-');
  assert.deepEqual(R._splitTag('localhost:5000/app:stable'), { repo: 'localhost:5000/app', tag: 'stable' });
  assert.deepEqual(R._splitTag('localhost:5000/app'), { repo: 'localhost:5000/app', tag: 'latest' });
  assert.deepEqual(R._splitTag('postgres:15-alpine'), { repo: 'postgres', tag: '15-alpine' });
});

test('history is kept per container name and leaves the log out', () => {
  const { db } = require('../../server/db');
  const ins = db.prepare(`INSERT INTO image_update_history (server_id, container_name, project, service, image, kind, status, log, started_at)
    VALUES (?, ?, ?, ?, 'app:1', 'update', 'updated', 'secret log', ?)`);
  ins.run('local', 'shop-app-1', 'shop', 'app', 1); ins.run('local', 'web', null, null, 2); ins.run('local', 'shop-app-2', 'shop', 'app', 3);
  assert.deepEqual(R.history({ serverId: 'local', name: 'web' }).map(r => r.container_name), ['web']);
  assert.deepEqual(R.history({ serverId: 'local', name: 'shop-app-1', project: 'shop', service: 'app' }).map(r => r.container_name), ['shop-app-2', 'shop-app-1'], 'a compose service keeps its history when the container name changes');
  assert.equal(R.history({ serverId: 'local' })[0].log, undefined);
  assert.equal(R.logOf(R.history({ serverId: 'local', name: 'web' })[0].id).log, 'secret log');
});
