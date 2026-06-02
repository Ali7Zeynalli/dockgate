// Unit tests for the pure helpers in server/docker.js.
// These need no Docker daemon — parseStats/demuxLogs are pure functions.
const { test } = require('node:test');
const assert = require('node:assert');
const docker = require('../../server/docker');

test('parseStats computes CPU%, memory% and IO from a raw stats sample', () => {
  const raw = {
    cpu_stats:    { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 8000 },
    memory_stats: { usage: 50 * 1024 * 1024, limit: 100 * 1024 * 1024 },
    networks:     { eth0: { rx_bytes: 100, tx_bytes: 200 } },
    blkio_stats:  { io_service_bytes_recursive: [{ op: 'read', value: 10 }, { op: 'write', value: 20 }] },
    pids_stats:   { current: 5 },
  };
  const s = docker.parseStats(raw);
  // cpuDelta=1000, systemDelta=2000, cpus=2 → (1000/2000)*2*100 = 100
  assert.strictEqual(s.cpuPercent, 100);
  assert.strictEqual(s.memoryPercent, 50);
  assert.strictEqual(s.networkRx, 100);
  assert.strictEqual(s.networkTx, 200);
  assert.strictEqual(s.blockRead, 10);
  assert.strictEqual(s.blockWrite, 20);
  assert.strictEqual(s.pids, 5);
});

test('parseStats does not throw when precpu_stats is missing (first sample)', () => {
  const s = docker.parseStats({
    cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
    memory_stats: { usage: 0, limit: 1 },
  });
  assert.ok(s.cpuPercent >= 0);
  assert.strictEqual(s.networkRx, 0);
});

test('demuxLogs strips the 8-byte Docker multiplexed stream header', () => {
  const payload = Buffer.from('hello world\n', 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1; // stream type: stdout
  header.writeUInt32BE(payload.length, 4);
  const frame = Buffer.concat([header, payload]);
  assert.strictEqual(docker.demuxLogs(frame), 'hello world\n');
});

test('demuxLogs returns plain strings unchanged', () => {
  assert.strictEqual(docker.demuxLogs('already a string'), 'already a string');
});

test('demuxLogs concatenates multiple frames', () => {
  const frame = (txt) => {
    const p = Buffer.from(txt, 'utf8');
    const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(p.length, 4);
    return Buffer.concat([h, p]);
  };
  const buf = Buffer.concat([frame('line1\n'), frame('line2\n')]);
  assert.strictEqual(docker.demuxLogs(buf), 'line1\nline2\n');
});
