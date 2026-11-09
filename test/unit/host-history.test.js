// Monitoring → Last 48 hours: DockGate keeps 48 hours of host samples per server and serves 5-minute buckets.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-hosthist-test-'));
const { test } = require('node:test');
const assert = require('node:assert');
const { db, stmts } = require('../../server/db');

const put = (server, minutesAgo, cpu) => db.prepare(`INSERT INTO host_metrics (server_id, ts, cpu, mem_pct, disk_pct, net_rx, net_tx, load1) VALUES (?, datetime('now', ?), ?, 40, 50, 1000, 2000, 0.5)`).run(server, `-${minutesAgo} minutes`, cpu);

test('samples older than 48 hours are dropped, newer ones kept, per server', () => {
  put('a', 49 * 60, 10); put('a', 47 * 60, 20); put('a', 1, 30); put('b', 49 * 60, 99);
  stmts.trimHostMetricsAge.run('a', 'a');
  const a = db.prepare("SELECT cpu FROM host_metrics WHERE server_id = 'a' ORDER BY id").all().map(r => r.cpu);
  assert.deepEqual(a, [20, 30]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_metrics WHERE server_id = 'b'").get().n, 1, 'another server is not touched');
});

test('history comes in 5-minute buckets with average and peak', () => {
  db.prepare("DELETE FROM host_metrics WHERE server_id = 'c'").run();
  // five samples inside one 5-minute bucket (aligned to the bucket start) + one in an older bucket
  const base = Math.floor(Date.now() / 1000 / 300) * 300 - 600; // a full bucket 10 minutes ago
  const ins = db.prepare("INSERT INTO host_metrics (server_id, ts, cpu, mem_pct, disk_pct, net_rx, net_tx, load1) VALUES ('c', datetime(?, 'unixepoch'), ?, 40, 50, 1000, 2000, 0.5)");
  [10, 20, 30, 40, 50].forEach((cpu, i) => ins.run(base + i * 60, cpu));
  ins.run(base - 3600, 5);
  const rows = stmts.getHostHistory.all('c');
  assert.equal(rows.length, 2);
  const last = rows[rows.length - 1];
  assert.equal(last.b, base); assert.equal(last.n, 5); assert.equal(last.cpu, 30); assert.equal(last.cpu_max, 50);
  assert.equal(stmts.getHostHistoryFirst.get('c').n, 6);
});
