// Unit tests for the Swarm autoscale decision (server/swarm-autoscale.js) — pure, no Docker.
const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../../server/swarm-autoscale');

const base = { min: 2, max: 5, cpuUp: 75, cpuDown: 25, memUp: null, memDown: null, logic: 'or', basis: 'average', step: 1, upMinutes: 5, downMinutes: 10, coolUpMinutes: 3, coolDownMinutes: 10 };
const rule = (x = {}) => ({ ...base, ...x });
const now = 10_000_000_000;
// one sample a minute for `n` minutes, newest at `now`; fields default to the same value for avg/min/max
const series = (n, f) => Array.from({ length: n }, (_, i) => {
  const v = typeof f === 'function' ? f(i) : f;
  const o = typeof v === 'object' ? v : { cpu: v };
  return { t: now - (n - 1 - i) * 60000, cpu: o.cpu, cpuMin: o.cpuMin ?? o.cpu, cpuMax: o.cpuMax ?? o.cpu, mem: o.mem ?? null, memMin: o.memMin ?? o.mem ?? null, memMax: o.memMax ?? o.mem ?? null };
});

test('adds one replica when the average CPU stays above the limit for the window', () => {
  const d = A.decide(rule(), series(5, 90), 2, now);
  assert.deepStrictEqual([d.action, d.to], ['up', 3]);
  assert.match(d.reason, /CPU 90% per replica for 5 min/);
});

test('no change on a short spike or with too few samples; one missed check is allowed', () => {
  assert.strictEqual(A.decide(rule(), series(5, i => (i === 4 ? 100 : 40)), 2, now), null);
  assert.strictEqual(A.decide(rule(), series(2, 95), 2, now), null);
  assert.strictEqual(A.decide(rule(), series(5, 90).filter((_, i) => i !== 2), 2, now).to, 3);
});

test('memory alone adds a replica with "or", but needs CPU too with "and"', () => {
  const s = series(5, { cpu: 20, mem: 85 });
  assert.strictEqual(A.decide(rule({ memUp: 70, memDown: 40 }), s, 2, now).to, 3);
  assert.match(A.decide(rule({ memUp: 70, memDown: 40 }), s, 2, now).reason, /memory 85%/);
  assert.strictEqual(A.decide(rule({ memUp: 70, memDown: 40, logic: 'and' }), s, 2, now), null);
  assert.strictEqual(A.decide(rule({ memUp: 70, memDown: 40, logic: 'and' }), series(5, { cpu: 90, mem: 85 }), 2, now).to, 3);
});

test('"every replica busy" uses the least busy replica', () => {
  const s = series(5, { cpu: 80, cpuMin: 30, cpuMax: 130 }); // one replica hot, one idle: average 80
  assert.strictEqual(A.decide(rule(), s, 2, now).to, 3);
  assert.strictEqual(A.decide(rule({ basis: 'every' }), s, 2, now), null);
  assert.strictEqual(A.decide(rule({ basis: 'every' }), series(5, { cpu: 90, cpuMin: 82, cpuMax: 95 }), 2, now).to, 3);
});

test('removing needs CPU and memory both low, over the longer window', () => {
  const r = rule({ memUp: 70, memDown: 40 });
  assert.strictEqual(A.decide(r, series(10, { cpu: 5, mem: 60 }), 4, now), null); // memory still high
  assert.strictEqual(A.decide(r, series(5, { cpu: 5, mem: 10 }), 4, now), null); // only 5 of 10 minutes
  const d = A.decide(r, series(10, { cpu: 5, mem: 10 }), 4, now);
  assert.deepStrictEqual([d.action, d.to], ['down', 3]);
});

test('step adds or removes several replicas, within min and max', () => {
  assert.strictEqual(A.decide(rule({ step: 2 }), series(5, 90), 2, now).to, 4);
  assert.strictEqual(A.decide(rule({ step: 2 }), series(5, 90), 4, now).to, 5);
  assert.strictEqual(A.decide(rule({ step: 2 }), series(10, 5), 3, now).to, 2);
});

test('separate waits after adding and after removing', () => {
  assert.strictEqual(A.decide(rule(), series(5, 95), 3, now, { at: now - 2 * 60000, dir: 'up' }), null);
  assert.strictEqual(A.decide(rule(), series(5, 95), 3, now, { at: now - 4 * 60000, dir: 'up' }).to, 4);
  assert.strictEqual(A.decide(rule(), series(5, 95), 3, now, { at: now - 4 * 60000, dir: 'down' }), null); // 10 min after removing
});

test('never past the range by load; out of the range is put right at once', () => {
  assert.strictEqual(A.decide(rule(), series(5, 99), 5, now), null);
  assert.strictEqual(A.decide(rule(), series(10, 1), 2, now), null);
  assert.strictEqual(A.decide(rule(), [], 1, now, { at: now - 1000, dir: 'up' }).to, 2);
  assert.strictEqual(A.decide(rule(), [], 8, now, { at: now - 1000, dir: 'up' }).to, 5);
});

test('checks every 30 seconds need twice the samples', () => {
  const s30 = Array.from({ length: 6 }, (_, i) => ({ t: now - (5 - i) * 30000, cpu: 90, cpuMin: 90, cpuMax: 90, mem: null }));
  assert.strictEqual(A.decide(rule({ upMinutes: 5 }), s30, 2, now, {}, 30000), null); // 6 of ~9 needed
});

test('room counts replicas that fit server by server', () => {
  const cap = { nodes: [
    { active: true, cpu: 4, mem: 8 * 2 ** 30, cpuReserved: 3, memReserved: 2 ** 30 },
    { active: true, cpu: 2, mem: 4 * 2 ** 30, cpuReserved: 0, memReserved: 3.5 * 2 ** 30 },
    { active: false, cpu: 8, mem: 16 * 2 ** 30, cpuReserved: 0, memReserved: 0 } ] };
  assert.strictEqual(A.room(cap, 0.5, 256 * 2 ** 20), 2 + 2); // node 1: 1 CPU free → 2; node 2: 512 MB free → 2
  assert.strictEqual(A.room(cap, 0, 0), null);
});

test('validate fills defaults and refuses rules that would flap or are out of range', () => {
  const v = A.validate({});
  assert.strictEqual(v.min, 1); assert.strictEqual(v.memUp, null); assert.strictEqual(v.logic, 'or'); assert.strictEqual(v.coolDownMinutes, 10);
  assert.throws(() => A.validate({ min: 4, max: 2 }), /maximum must be at least the minimum/);
  assert.throws(() => A.validate({ cpuUp: 50, cpuDown: 45 }), /at least 10 below/);
  assert.throws(() => A.validate({ memUp: 70, memDown: 65 }), /memory % at least 10 below/);
  assert.strictEqual(A.validate({ memUp: 70 }).memDown, 40);
  assert.throws(() => A.validate({ step: 9 }), /Replicas per change/);
  assert.strictEqual(A.validate({ cooldownMinutes: 7 }).coolUpMinutes, 7); // a 2.41 form
});
