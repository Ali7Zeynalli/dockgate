// Unit tests for the Swarm autoscale decision (server/swarm-autoscale.js) — pure, no Docker.
const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../../server/swarm-autoscale');

const rule = { min: 2, max: 5, cpuUp: 75, cpuDown: 25, upMinutes: 5, downMinutes: 10, cooldownMinutes: 5 };
const now = 10_000_000_000;
// one sample a minute for `n` minutes, newest at `now`
const series = (n, cpu) => Array.from({ length: n }, (_, i) => ({ t: now - (n - 1 - i) * 60000, cpu: typeof cpu === 'function' ? cpu(i) : cpu }));

test('scales up by one when the average CPU stays above the limit for the window', () => {
  const d = A.decide(rule, series(5, 90), 2, now);
  assert.deepStrictEqual([d.action, d.to], ['up', 3]);
  assert.match(d.reason, /CPU 90% per task for 5 min/);
});

test('does not scale up on a short spike or with too few samples', () => {
  assert.strictEqual(A.decide(rule, series(5, i => (i === 4 ? 100 : 40)), 2, now), null); // average 52
  assert.strictEqual(A.decide(rule, series(2, 95), 2, now), null); // 2 minutes of a 5-minute window
});

test('allows one missed sample in the window', () => {
  const s = series(5, 90).filter((_, i) => i !== 2);
  assert.strictEqual(A.decide(rule, s, 2, now).to, 3);
});

test('never goes above the maximum or below the minimum by CPU', () => {
  assert.strictEqual(A.decide(rule, series(5, 99), 5, now), null);
  assert.strictEqual(A.decide(rule, series(10, 1), 2, now), null);
});

test('scales down by one after the longer quiet window', () => {
  assert.strictEqual(A.decide(rule, series(5, 5), 4, now), null); // only 5 of 10 minutes
  const d = A.decide(rule, series(10, 5), 4, now);
  assert.deepStrictEqual([d.action, d.to], ['down', 3]);
});

test('waits for the cooldown after a change', () => {
  assert.strictEqual(A.decide(rule, series(5, 95), 3, now, now - 2 * 60000), null);
  assert.strictEqual(A.decide(rule, series(5, 95), 3, now, now - 6 * 60000).to, 4);
});

test('puts a service outside the range back at once, even in the cooldown', () => {
  assert.deepStrictEqual(A.decide(rule, [], 1, now, now - 1000).to, 2);
  assert.deepStrictEqual(A.decide(rule, [], 8, now, now - 1000).to, 5);
});

test('ignores samples without a reading', () => {
  const one = series(5, 90).map((x, i) => (i === 0 ? { ...x, cpu: null } : x));
  assert.strictEqual(A.decide(rule, one, 2, now).to, 3); // 4 readings in a 5-minute window: enough
  const two = series(5, 90).map((x, i) => (i < 2 ? { ...x, cpu: null } : x));
  assert.strictEqual(A.decide(rule, two, 2, now), null); // 3 readings: not enough to decide
});

test('validate fills defaults and refuses rules that would flap or are out of range', () => {
  assert.deepStrictEqual(A.validate({}), { enabled: true, ...A.DEFAULTS });
  assert.throws(() => A.validate({ min: 4, max: 2 }), /maximum must be at least the minimum/);
  assert.throws(() => A.validate({ cpuUp: 50, cpuDown: 45 }), /at least 10 below/);
  assert.throws(() => A.validate({ max: 0 }), /Maximum replicas/);
  assert.throws(() => A.validate({ upMinutes: 1.5 }), /whole number/);
  assert.strictEqual(A.validate({ enabled: false }).enabled, false);
});
