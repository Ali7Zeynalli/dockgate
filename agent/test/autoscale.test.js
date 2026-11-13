'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hostRoom, decideHost } = require('../src/control/scale-decision');
const { Scaler, cleanAuto } = require('../src/control/autoscale');
const { hostCapFrom } = require('../src/control/measure');

const MB = 1048576, GB = 1024 * MB;
const rule = (o = {}) => ({ min: 1, max: 5, cpuUp: 75, cpuDown: 25, memUp: null, memDown: null, logic: 'or', basis: 'average', step: 1, upMinutes: 2, downMinutes: 2, coolUpMinutes: 3, coolDownMinutes: 10, ...o });
const now = 10_000_000;
const busy = (cpu, n = 4) => Array.from({ length: n }, (_, i) => ({ t: now - i * 30000, cpu, cpuMin: cpu, cpuMax: cpu, mem: null }));
const lim = { cpu: 1, mem: 512 * MB };
const roomy = { cpu: 8, mem: 16 * GB, memAvail: 10 * GB, load: 2 };

test('room on the server: by free memory and by CPU load, keeping some for the server', () => {
  assert.equal(hostRoom(roomy, lim).fits, 4); // 0.8*8 - 2 = 4.4 cores → 4
  assert.equal(hostRoom({ ...roomy, memAvail: 2.6 * GB }, lim).fits, 2); // 2.6 GB - 1.6 GB kept → 2 × 512 MB
  assert.equal(hostRoom({ ...roomy, load: 7 }, lim).fits, 0);
  assert.equal(hostRoom({ ...roomy, memAvail: null, load: null }, lim).fits, Infinity, 'unknown → not the reason to stop');
});
test('add only as far as there is room; "full" when there is none; removing is never held back', () => {
  assert.equal(decideHost(rule(), busy(90), 2, now, {}, roomy, lim, 30000).to, 3);
  assert.equal(decideHost(rule({ step: 5 }), busy(90), 2, now, {}, roomy, lim, 30000).to, 5, 'step 5 but max 5');
  assert.equal(decideHost(rule({ step: 5, max: 10 }), busy(90), 2, now, {}, roomy, lim, 30000).to, 6, 'only 4 fit');
  const full = decideHost(rule(), busy(90), 2, now, {}, { ...roomy, load: 7.5 }, lim, 30000);
  assert.equal(full.action, 'full'); assert.match(full.reason, /no room/);
  assert.equal(decideHost(rule(), busy(5), 3, now, {}, { ...roomy, load: 7.5 }, lim, 30000).to, 2);
});
test('host numbers from /proc', () => {
  const c = hostCapFrom({ NCPU: 4, MemTotal: 8 * GB }, 'MemTotal: 8388608 kB\nMemAvailable:    4194304 kB\n', '1.50 1.20 1.00 2/300 999');
  assert.deepEqual(c, { cpu: 4, mem: 8 * GB, memAvail: 4 * GB, load: 1.5 });
  assert.equal(hostCapFrom({ NCPU: 4, MemTotal: 1 }, '', '').load, null);
});
test('a rule keeps only its known shape', () => {
  assert.equal(cleanAuto({ mode: 'rm -rf' }), undefined);
  const a = cleanAuto({ mode: 'auto', min: 3, max: 2, cpuUp: 500, extra: 1 });
  assert.equal(a.max, 3); assert.equal(a.cpuUp, 75); assert.equal(a.extra, undefined);
});

// A server with N replicas of p/api at a given CPU % of a 1-core limit.
function server(n, cpuPct) {
  const done = []; let cts = [];
  const mk = (i) => ({ Id: `id${i}`, Names: [`/p-api-${i}`], State: 'running', Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'api', 'com.docker.compose.container-number': String(i) } });
  for (let i = 1; i <= n; i++) cts.push(mk(i));
  const stats = { cpu_stats: { cpu_usage: { total_usage: cpuPct * 1000 }, system_cpu_usage: 1000 * 100, online_cpus: 1 }, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 }, memory_stats: { usage: 100 * MB, stats: {} } };
  return { done, get count() { return cts.length; },
    listContainers: async () => cts,
    info: async () => ({ NCPU: 8, MemTotal: 16 * GB }),
    getContainer: (id) => ({
      inspect: async () => ({ HostConfig: { NanoCpus: 1e9, Memory: 512 * MB }, Config: {} }),
      stats: async () => stats,
      stop: async () => done.push(['stop', id]), remove: async () => { done.push(['remove', id]); cts = cts.filter(c => c.Id !== id); },
    }),
    getNetwork: () => ({ inspect: async () => ({ Containers: {} }) }) };
}
const rulesFor = (auto) => ({ projects: { p: { api: { min: auto.min, max: auto.max, auto } } } });
function scaler(docker, cap = roomy) {
  const log = [], notes = [], changes = [];
  const sc = new Scaler({ docker, everyMs: 30000, state: {}, readCap: async () => cap, notify: async (t) => notes.push(t), record: (e) => log.push(e), onChange: async (...a) => changes.push(a) });
  return { sc, log, notes, changes };
}
const quiet = cleanAuto({ mode: 'auto', min: 1, max: 5, cpuDown: 25, downMinutes: 2 });

test('simulate never changes anything, and says what it would do', async () => {
  const d = server(3, 5); const { sc, log } = scaler(d);
  const r = rulesFor({ ...quiet, simulateUntil: Date.now() + 3600e3 });
  for (let i = 0; i < 4; i++) await sc.tick(r, Date.now() + i * 30000);
  assert.equal(d.count, 3); assert.deepEqual(d.done, []);
  assert.equal(log.filter(e => e.mode === 'simulate').length, 1, 'once, then the wait after a change applies');
  assert.match(log[0].reason, /CPU 5%/);
});
test('auto removes one replica when quiet, gracefully, and tells', async () => {
  const d = server(3, 5); const { sc, log, notes, changes } = scaler(d);
  for (let i = 0; i < 4; i++) await sc.tick(rulesFor(quiet), Date.now() + i * 30000);
  assert.equal(d.count, 2); assert.deepEqual(d.done.map(x => x[0]), ['stop', 'remove']);
  assert.deepEqual(changes, [['p', 'api', 2]]); assert.equal(notes.length, 1);
  assert.equal(log.filter(e => e.mode === 'auto' && e.ok).length, 1);
});
test('busy project: nothing measured or changed', async () => {
  const d = server(3, 5); const { sc, log } = scaler(d);
  for (let i = 0; i < 4; i++) await sc.tick(rulesFor(quiet), Date.now() + i * 30000, async () => true);
  assert.equal(d.count, 3); assert.equal(log.length, 0);
});
test('server full: one notice for the whole episode, nothing started', async () => {
  const d = server(2, 95); const { sc, log, notes } = scaler(d, { ...roomy, load: 7.9 });
  const r = rulesFor(cleanAuto({ mode: 'auto', min: 1, max: 5, upMinutes: 1 }));
  for (let i = 0; i < 5; i++) await sc.tick(r, Date.now() + i * 30000);
  assert.equal(d.count, 2); assert.equal(notes.length, 1); assert.equal(log.filter(e => e.mode === 'full').length, 1);
});
test('suggest writes a suggestion once, changes nothing', async () => {
  const d = server(3, 5); const { sc, log } = scaler(d);
  for (let i = 0; i < 6; i++) await sc.tick(rulesFor({ ...quiet, mode: 'suggest' }), Date.now() + i * 30000);
  assert.equal(d.count, 3); assert.equal(log.filter(e => e.mode === 'suggest').length, 1); assert.equal(log[0].to, 2);
});
test('a check every minute and "add after 1 minute": two checks a minute apart are enough', () => {
  const { decide } = require('../src/control/scale-decision');
  const s = [{ t: now - 60000, cpu: 90 }, { t: now, cpu: 90 }];
  assert.equal(decide(rule({ upMinutes: 1 }), s, 1, now, {}, 60000).to, 2);
});
