'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../server/notifications/alert-rules');

const rule = (type, params, enabled = 1) => ({ event_type: type, enabled, params: JSON.stringify(params) });
const MIN = 60000;
const rulesAllOn = () => ({
  server_down: R.effective(rule('server_down', { minutes: 3 })),
  server_up: R.effective(rule('server_up', {})),
  host_disk: R.effective(rule('host_disk', { percent: 85 })),
  host_mem: R.effective(rule('host_mem', { percent: 90, minutes: 5 })),
  host_cpu: R.effective(rule('host_cpu', { percent: 90, minutes: 10 })),
});
const ok = (x = {}) => ({ ok: true, cpu: 10, memPct: 40, disks: [{ mount: '/', usePct: 50, size: 100, used: 50 }], ...x });

test('validateParams: accepts limits in range, rounds, rejects out of range and missing', () => {
  assert.deepEqual(R.validateParams('host_mem', { percent: '91.4', minutes: 5 }), { percent: 91, minutes: 5 });
  assert.throws(() => R.validateParams('host_disk', { percent: 20 }), /between 50 and 99/);
  assert.throws(() => R.validateParams('server_down', {}), /minutes is required/);
  assert.throws(() => R.validateParams('container_die', {}), /no limits/);
  assert.deepEqual(R.validateParams('disk_threshold', { gb: 40 }), { gb: 40 });
});

test('effective: shared off wins, server off, custom merges over shared', () => {
  const r = rule('host_disk', { percent: 85 });
  assert.deepEqual(R.effective(r, null), { on: true, params: { percent: 85 }, source: 'default' });
  assert.equal(R.effective(r, { mode: 'off' }).on, false);
  assert.deepEqual(R.effective(r, { mode: 'custom', params: '{"percent":75}' }).params, { percent: 75 });
  assert.equal(R.effective(rule('host_disk', { percent: 85 }, 0), { mode: 'custom', params: '{"percent":75}' }).on, false);
});

test('server down only after the waiting time, once; back up reports the outage', () => {
  const rules = rulesAllOn();
  let s = {}, out;
  const t0 = 1_000_000;
  out = R.evaluate(s, { ok: false, error: 'timed out' }, t0, rules); s = out.state;
  assert.equal(out.alerts.length, 0, 'not yet');
  out = R.evaluate(s, { ok: false }, t0 + 2 * MIN, rules); s = out.state;
  assert.equal(out.alerts.length, 0, 'still inside 3 min');
  out = R.evaluate(s, { ok: false }, t0 + 3 * MIN, rules); s = out.state;
  assert.deepEqual(out.alerts.map(a => a.type), ['server_down']);
  assert.equal(out.alerts[0].data.since, t0);
  out = R.evaluate(s, { ok: false }, t0 + 4 * MIN, rules); s = out.state;
  assert.equal(out.alerts.length, 0, 'no repeat while still down');
  out = R.evaluate(s, ok(), t0 + 10 * MIN, rules); s = out.state;
  assert.deepEqual(out.alerts.map(a => a.type), ['server_up']);
  assert.equal(out.alerts[0].data.until - out.alerts[0].data.since, 10 * MIN);
});

test('a short blip does not alert and sends no "back up"', () => {
  const rules = rulesAllOn();
  let out = R.evaluate({}, { ok: false }, 0, rules);
  out = R.evaluate(out.state, ok(), MIN, rules);
  assert.equal(out.alerts.length, 0);
});

test('server_down off: no down and no up alert', () => {
  const rules = { ...rulesAllOn(), server_down: R.effective(rule('server_down', { minutes: 3 }), { mode: 'off' }) };
  let out = R.evaluate({}, { ok: false }, 0, rules);
  out = R.evaluate(out.state, { ok: false }, 10 * MIN, rules);
  assert.equal(out.alerts.length, 0);
  out = R.evaluate(out.state, ok(), 11 * MIN, rules);
  assert.equal(out.alerts.length, 0);
});

test('disk: fullest disk at or above the limit alerts at once', () => {
  const out = R.evaluate({}, ok({ disks: [{ mount: '/', usePct: 60 }, { mount: '/var', usePct: 86 }] }), 0, rulesAllOn());
  assert.deepEqual(out.alerts.map(a => [a.type, a.data.disk.mount, a.data.limit]), [['host_disk', '/var', 85]]);
});

test('memory: alerts only when high for the whole period; a dip resets the timer', () => {
  const rules = rulesAllOn();
  let out = R.evaluate({}, ok({ memPct: 95 }), 0, rules);
  out = R.evaluate(out.state, ok({ memPct: 95 }), 4 * MIN, rules);
  assert.equal(out.alerts.length, 0);
  out = R.evaluate(out.state, ok({ memPct: 50 }), 5 * MIN, rules); // dip
  out = R.evaluate(out.state, ok({ memPct: 95 }), 6 * MIN, rules);
  out = R.evaluate(out.state, ok({ memPct: 95 }), 10 * MIN, rules);
  assert.equal(out.alerts.length, 0, 'only 4 min since the dip');
  out = R.evaluate(out.state, ok({ memPct: 96 }), 11 * MIN, rules);
  assert.deepEqual(out.alerts.map(a => a.type), ['host_mem']);
});

test('cpu rule off by default in shared rules: never alerts', () => {
  const rules = { ...rulesAllOn(), host_cpu: R.effective(rule('host_cpu', { percent: 90, minutes: 10 }, 0)) };
  let out = R.evaluate({}, ok({ cpu: 99 }), 0, rules);
  out = R.evaluate(out.state, ok({ cpu: 99 }), 20 * MIN, rules);
  assert.equal(out.alerts.filter(a => a.type === 'host_cpu').length, 0);
});
