'use strict';
// Tools > Schedules "Back up a database", systemd timers in Cron, "Everything on a server", the Dashboard's
// "Needs attention on all servers", and docker.withServer (a task runs on its own server, not the one in use).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../server/schedules');
const cron = require('../../server/cron');
const FA = require('../../server/fleet-attention');
const docker = require('../../server/docker');

test('a database backup task: container, database or all, format, keep', () => {
  const v = S.validate({ kind: 'db_backup', server_id: 'local', freq: 'daily', at: '03:15', params: { container: 'shop-db', database: 'shop', format: 'sql', keep: 3 } });
  assert.deepEqual(JSON.parse(v.params), { container: 'shop-db', database: 'shop', format: 'sql', keep: 3 });
  assert.equal(v.name, 'Back up database shop-db / shop');
  const all = S.validate({ kind: 'db_backup', server_id: 'local', freq: 'daily', params: { container: 'shop-db', format: 'custom' } });
  assert.deepEqual(JSON.parse(all.params), { container: 'shop-db', database: '', format: 'sql', keep: 7 }, 'a whole-server backup is plain SQL');
  assert.throws(() => S.validate({ kind: 'db_backup', server_id: 'local', freq: 'daily', params: { container: 'a b' } }), /PostgreSQL container/);
  assert.throws(() => S.validate({ kind: 'db_backup', server_id: 'local', freq: 'daily', params: { container: 'db', keep: 0 } }), /Keep between/);
});

test('systemd timers: turned-off ones are listed from the unit files, with a switch', () => {
  const t = cron.parseTimers('Id=apt-daily.timer\nUnit=apt-daily.service\nActiveState=active\nUnitFileState=enabled\n',
    'apt-daily.timer enabled\nold.timer disabled\nboot.timer static\n');
  assert.deepEqual(t.map(x => [x.unit, x.state, x.canToggle, x.runs]), [['apt-daily.timer', 'enabled', true, 'apt-daily.service'], ['old.timer', 'disabled', true, 'old.service']]);
});

test('timer actions refuse odd names before anything runs on the server', async () => {
  for (const u of ['x;rm -rf /.timer', 'apt-daily.service', '../a.timer', '']) await assert.rejects(() => cron.timerAction({ id: 'x' }, u, 'run'), /Unknown timer/);
});

test('containers in trouble: restarting, unhealthy, stopped with an error - not a clean stop', () => {
  assert.equal(FA.problemOf({ State: 'restarting', Status: 'Restarting (1) 3 seconds ago' }), 'restarting');
  assert.equal(FA.problemOf({ State: 'running', Status: 'Up 2 hours (unhealthy)' }), 'unhealthy');
  assert.equal(FA.problemOf({ State: 'exited', Status: 'Exited (1) 5 minutes ago' }), 'stopped with exit 1');
  assert.equal(FA.problemOf({ State: 'exited', Status: 'Exited (0) 5 minutes ago' }), null);
  assert.equal(FA.problemOf({ State: 'exited', Status: 'Exited (137) 1 hour ago' }), null, 'docker stop');
  assert.equal(FA.problemOf({ State: 'running', Status: 'Up 2 hours (healthy)' }), null);
});

test('a locked server shows only that it is locked', async () => {
  const r = await FA.summary((id) => id === 'local');
  const local = r.servers.find(x => x.id === 'local');
  assert.equal(local.locked, true); assert.deepEqual([local.updates, local.problems, local.jobs], [[], [], []]);
});

test('withServer: the server for one call chain only', async () => {
  const { stmts } = require('../../server/db');
  stmts.insertServer.run('ws-test', 'ssh', '10.0.0.7', 22, 'u', null, null, null, '', null, 1);
  assert.equal(docker.getActiveServerId(), 'local');
  const seen = await docker.withServer('ws-test', async () => { await new Promise(r => setTimeout(r, 5)); return docker.getActiveServerId(); });
  assert.equal(seen, 'ws-test');
  assert.equal(docker.getActiveServerId(), 'local', 'the server in use did not change');
  assert.throws(() => docker.withServer('no-such', () => 1), /Server not found/);
});

test('everything on a server: DockGate tasks by next run, two starting together are marked', async () => {
  const SA = require('../../server/schedule-all');
  const now = Date.now();
  for (const at of ['03:00', '03:05', '09:00']) S.q.insert.run({ name: `t${at}`, kind: 'prune', server_id: 'local', params: '{"images":true}', freq: 'daily', at, weekday: null, enabled: 1, next_run_at: S.nextRun({ freq: 'daily', at }, now), created_at: now });
  const r = await SA.forServer('local', { now });
  const mine = r.items.filter(x => /^t\d/.test(x.name));
  assert.deepEqual(mine.map(x => x.name), ['t03:00', 't03:05', 't09:00'].sort((a, b) => mine.find(x => x.name === a).next - mine.find(x => x.name === b).next));
  assert.equal(mine.find(x => x.name === 't03:00').clash, true); assert.equal(mine.find(x => x.name === 't03:05').clash, true);
  assert.ok(!mine.find(x => x.name === 't09:00').clash);
  assert.match(r.notes.join(' '), /SSH servers/);
});
