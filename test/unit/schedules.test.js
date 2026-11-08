'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-sched-test-'));
const S = require('../../server/schedules');

const iso = (ms) => new Date(ms).toISOString();

test('daily: next 03:30 Berlin, before and after the time, across the DST change', () => {
  const tz = 'Europe/Berlin';
  // 2026-03-28 10:00 UTC (CET, +1) → next 03:30 Berlin is 2026-03-29, which is already CEST (+2) → 01:30 UTC
  assert.equal(iso(S.nextRun({ freq: 'daily', at: '03:30' }, Date.UTC(2026, 2, 28, 10, 0), tz)), '2026-03-29T01:30:00.000Z');
  // just before 03:30 Berlin the same day (02:29 UTC in winter = 03:29 Berlin)
  assert.equal(iso(S.nextRun({ freq: 'daily', at: '03:30' }, Date.UTC(2026, 0, 10, 2, 29), tz)), '2026-01-10T02:30:00.000Z');
});

test('weekly: the chosen weekday; hourly: the chosen minute', () => {
  // 2026-11-08 is a Sunday. Weekly Monday 04:00 UTC → 2026-11-09 04:00Z
  assert.equal(iso(S.nextRun({ freq: 'weekly', at: '04:00', weekday: 1 }, Date.UTC(2026, 10, 8, 12, 0), 'UTC')), '2026-11-09T04:00:00.000Z');
  // Weekly Sunday 04:00, it is Sunday 12:00 → next Sunday
  assert.equal(iso(S.nextRun({ freq: 'weekly', at: '04:00', weekday: 0 }, Date.UTC(2026, 10, 8, 12, 0), 'UTC')), '2026-11-15T04:00:00.000Z');
  assert.equal(iso(S.nextRun({ freq: 'hourly', at: '00:15' }, Date.UTC(2026, 10, 8, 12, 20), 'UTC')), '2026-11-08T13:15:00.000Z');
});

test('validate: refuses unsafe or incomplete input, fills a name', () => {
  assert.throws(() => S.validate({ kind: 'rm', freq: 'daily', server_id: 'local' }), /what the task does/);
  assert.throws(() => S.validate({ kind: 'prune', freq: 'daily', server_id: 'local', params: {} }), /at least one/);
  assert.throws(() => S.validate({ kind: 'volume_backup', freq: 'daily', server_id: 'local', params: { volume: 'db; rm -rf /' } }), /Choose a volume/);
  assert.throws(() => S.validate({ kind: 'volume_backup', freq: 'daily', server_id: 'local', params: { volume: 'db', dir: '/' } }), /two levels deep/);
  assert.throws(() => S.validate({ kind: 'volume_backup', freq: 'daily', server_id: 'local', params: { volume: 'db', dir: "/var/x'y" } }), /two levels deep/);
  assert.throws(() => S.validate({ kind: 'prune', freq: 'daily', server_id: 'local', at: '25:00', params: { images: true } }), /03:30/);
  const v = S.validate({ kind: 'prune', freq: 'daily', server_id: 'local', at: '03:30', params: { images: true, build_cache: true, volumes: true } });
  assert.deepEqual(JSON.parse(v.params), { containers: false, images: true, networks: false, build_cache: true });
  assert.equal(v.name, 'Prune unused images, build cache');
});
