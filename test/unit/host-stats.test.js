const { test } = require('node:test');
const assert = require('node:assert');
const hs = require('../../server/host-stats');

test('parseCpu: busy% from two /proc/stat samples', () => {
  const s1 = 'cpu  100 0 50 1000 0 0 0 0\ncpu0 50 0 25 500 0 0 0 0';
  const s2 = 'cpu  150 0 70 1200 0 0 0 0\ncpu0 75 0 35 600 0 0 0 0';
  const r = hs.parseCpu(s1, s2); // total Δ=270, idle Δ=200 → busy ≈ 25.9%
  assert.ok(r.cpuPercent > 25 && r.cpuPercent < 27, `got ${r.cpuPercent}`);
});

test('parseMem: used = total - available; swap', () => {
  const m = hs.parseMem('MemTotal: 2048000 kB\nMemFree: 100000 kB\nMemAvailable: 1024000 kB\nSwapTotal: 1000 kB\nSwapFree: 1000 kB');
  assert.equal(m.total, 2048000 * 1024);
  assert.equal(m.available, 1024000 * 1024);
  assert.equal(m.used, 1024000 * 1024);
  assert.equal(m.swapUsed, 0);
});

test('parseLoad: load + running/total procs', () => {
  const l = hs.parseLoad('0.50 0.40 0.30 2/431 12345');
  assert.equal(l.load1, 0.5); assert.equal(l.procsRunning, 2); assert.equal(l.procsTotal, 431);
});

test('parseDf: parses real disks with percent + mount', () => {
  const d = hs.parseDf('Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/sda1 10000000000 5000000000 5000000000 50% /');
  assert.equal(d.length, 1);
  assert.equal(d[0].usePct, 50); assert.equal(d[0].mount, '/'); assert.equal(d[0].used, 5000000000);
});

test('parseNet: rate from two /proc/net/dev samples, excludes lo', () => {
  const n1 = 'Inter-|\n face |\n  eth0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0';
  const n2 = 'Inter-|\n face |\n  eth0: 1600 1 0 0 0 0 0 0 2600 2 0 0 0 0 0 0\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0';
  const net = hs.parseNet(n1, n2, 0.6); // Δ600 over 0.6s = 1000/s each (lo ignored)
  assert.equal(net.rxBytesSec, 1000); assert.equal(net.txBytesSec, 1000);
});

test('parsePorts: unique listening ports from ss output (ignores :*)', () => {
  const ss = 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 *:80 *:*\nLISTEN 0 128 [::]:443 [::]:*';
  assert.deepEqual(hs.parsePorts(ss), [22, 80, 443]);
});

test('parsePs: top processes', () => {
  const ps = '  PID COMMAND %CPU %MEM RSS\n 1234 node 12.5 3.2 50000\n 5678 nginx 1.0 0.5 10000';
  const p = hs.parsePs(ps);
  assert.equal(p[0].pid, 1234); assert.equal(p[0].comm, 'node'); assert.equal(p[0].cpu, 12.5); assert.equal(p[0].rss, 50000 * 1024);
});

test('parseSnapshot: stitches marker-delimited sections', () => {
  const out = [
    '@@S1@@', 'cpu  100 0 50 1000 0 0 0 0',
    '@@N1@@', '  eth0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0',
    '@@S2@@', 'cpu  150 0 70 1200 0 0 0 0',
    '@@N2@@', '  eth0: 1600 1 0 0 0 0 0 0 2600 2 0 0 0 0 0 0',
    '@@MEM@@', 'MemTotal: 2048000 kB\nMemAvailable: 1024000 kB',
    '@@LOAD@@', '0.50 0.40 0.30 2/431 1',
    '@@UP@@', '123456.78 0',
    '@@DF@@', 'Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/sda1 100 50 50 50% /',
    '@@PS@@', '  PID COMMAND %CPU %MEM RSS\n 1 init 0.0 0.1 1000',
    '@@PORTS@@', 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
    '@@END@@',
  ].join('\n');
  const snap = hs.parseSnapshot(out);
  assert.ok(snap.cpu > 25 && snap.cpu < 27);
  assert.equal(snap.uptime, 123456);
  assert.equal(snap.net.rxBytesSec, 1000);
  assert.deepEqual(snap.ports, [22]);
  assert.equal(snap.disks.length, 1);
});
