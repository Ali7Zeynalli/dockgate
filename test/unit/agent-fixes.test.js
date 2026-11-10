// Edge agent 1.1.0 fixes: events read line by line, the error-spike alert fires, container network is per second,
// memory follows `docker stats` on cgroup v2, host log lines keep their own time, dmesg lines are not repeated,
// levels do not turn any 5xx-looking number into an error, the query port listens on loopback only.
process.env.AGENT_HEALTH_PORT = '0';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
let dmesgOut = '';
const realExec = cp.exec;
cp.exec = (cmd, cb) => (/^dmesg/.test(cmd) ? cb(null, dmesgOut) : realExec(cmd, cb));

const Storage = require('../../agent/src/storage');
const LogAggregator = require('../../agent/src/log-aggregator');
const MetricsCollector = require('../../agent/src/metrics-collector');
const Harvester = require('../../agent/src/host-log-harvester');
const Monitor = require('../../agent/src/monitor');
const { startQueryServer } = require('../../agent/src/health');

test('events: several in one chunk and one split across chunks are all handled', () => {
  const m = new Monitor(); const got = []; const stream = new EventEmitter();
  m._handleEvent = (e) => got.push(e.Action);
  m.docker = { getEvents: (o, cb) => cb(null, stream) };
  m._startEventStream();
  const ev = (a) => JSON.stringify({ Type: 'container', Action: a, Actor: { ID: 'x', Attributes: {} }, time: 1 });
  stream.emit('data', Buffer.from(ev('die') + '\n' + ev('oom') + '\n' + ev('die').slice(0, 20)));
  stream.emit('data', Buffer.from(ev('die').slice(20) + '\n'));
  stream.emit('data', Buffer.from(ev('start')));
  assert.deepEqual(got, ['die', 'oom', 'die', 'start']);
  m.stopped = true;
});

test('error spike: 30 errors within a minute sends one Telegram message', async () => {
  const sent = [];
  const la = new LogAggregator(null, new Storage(), { telegram: { isConfigured: true, sendMessage: async (x) => { sent.push(x.text); } } });
  for (let i = 0; i < 40; i++) la.processLogLine('abcdef123456', 'api', 'stdout', `error: db down ${i}`);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /High Error Spike on \[api\]/);
});

test('a reattached container log continues after the last kept line (no 30 s repeat)', async () => {
  let opts;
  const docker = { getContainer: () => ({ logs: async (o) => { opts = o; return new EventEmitter(); } }) };
  const la = new LogAggregator(docker, new Storage());
  la.processLogLine('cid1', 'api', 'stdout', '2026-11-09T10:15:30.250Z hello');
  await la.attachContainerLogs({ Id: 'cid1', Names: ['/api'] });
  assert.equal(opts.since, `${Math.floor(Date.parse('2026-11-09T10:15:30.250Z') / 1000)}.250001`);
});

test('container network is bytes per second, memory subtracts inactive_file (cgroup v2)', async () => {
  const stats = (rx, usage) => ({ cpu_stats: { cpu_usage: { total_usage: 2 }, system_cpu_usage: 20, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 10 },
    memory_stats: { usage, limit: 1000e6, stats: { inactive_file: 100e6, anon: 150e6 } }, networks: { eth0: { rx_bytes: rx, tx_bytes: rx / 2 } } });
  let cur = stats(1e9, 300e6);
  const docker = { listContainers: async () => [{ Id: 'c1aaaaaaaaaaaa', Names: ['/api'] }], getContainer: () => ({ stats: async () => cur }) };
  const mc = new MetricsCollector(docker, new Storage());
  const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
  try {
    const a = await mc.getContainerStats();
    assert.equal(a.api.netRxSec, 0, 'first sample has no rate yet (not the 1 GB total)');
    assert.equal(a.api.memUsedBytes, 200e6, '300 MB usage − 100 MB inactive file cache');
    now += 10_000; cur = stats(1e9 + 5e6, 300e6);
    const b = await mc.getContainerStats();
    assert.equal(b.api.netRxSec, 500000, '5 MB in 10 s');
    assert.equal(b.api.netTxSec, 250000);
  } finally { Date.now = realNow; }
});

test('host log lines keep the time they were written', () => {
  const t = Harvester.lineTime, now = new Date(2026, 10, 9, 12, 0, 0).getTime();
  assert.equal(t('2026-11-09T10:15:30.123456+00:00 web1 sshd[1]: Accepted', now), Date.parse('2026-11-09T10:15:30.123Z'));
  assert.equal(t('Nov  9 10:15:30 web1 sshd[1]: Failed password', now), new Date(2026, 10, 9, 10, 15, 30).getTime());
  assert.equal(t('1.2.3.4 - - [09/Nov/2026:10:15:30 +0000] "GET / HTTP/1.1" 200 512', now), Date.parse('2026-11-09T10:15:30Z'));
  assert.equal(t('2026/11/09 10:15:30 [error] 12#12: connect() failed', now), new Date(2026, 10, 9, 10, 15, 30).getTime());
  assert.equal(t('[Sun Nov  9 10:15:30 2026] Out of memory: Killed process 42', now), new Date(2026, 10, 9, 10, 15, 30).getTime());
  assert.equal(t('Dec 31 23:59:00 web1 cron[1]: x', new Date(2027, 0, 1, 0, 5).getTime()), new Date(2026, 11, 31, 23, 59).getTime(), 'December line read in January');
  assert.equal(t('no time here', now), now);
});

test('dmesg: the same kernel lines are added once, new ones are added', () => {
  const st = new Storage(); const h = new Harvester(st);
  dmesgOut = '[Sun Nov  9 10:15:30 2026] Out of memory: Killed process 42 (node)\n[Sun Nov  9 10:16:00 2026] EXT4-fs error (device sda1)\n';
  h.harvestDmesg(); h.harvestDmesg(); h.harvestDmesg();
  assert.equal(st.getLogs({ source: 'kernel', limit: 100 }).returned, 2);
  dmesgOut += '[Sun Nov  9 10:20:00 2026] I/O error, dev sdb\n';
  h.harvestDmesg();
  const k = st.getLogs({ source: 'kernel', limit: 100 }).logs;
  assert.equal(k.length, 3);
  assert.equal(k[0].timestamp, new Date(2026, 10, 9, 10, 15, 30).getTime());
});

test('levels: a status code counts only where a status stands; stderr alone is a warning', () => {
  const s = new Storage();
  assert.equal(s._detectLogLevel('1.2.3.4 - - [x] "GET /a HTTP/1.1" 404 512', 'stdout'), 'warn');
  assert.equal(s._detectLogLevel('1.2.3.4 - - [x] "GET /a HTTP/1.1" 502 157', 'stdout'), 'error');
  assert.equal(s._detectLogLevel('served 512 bytes in 503 ms', 'stdout'), 'info');
  assert.equal(s._detectLogLevel('LOG:  database system is ready', 'stderr'), 'warn');
  assert.equal(s._detectLogLevel('Failed password for root', 'stdout'), 'error');
  assert.equal(s._detectLogLevel('using failover endpoint', 'stdout'), 'info', 'fail inside another word');
  assert.equal(s.addLog({ containerName: 'a', message: 'x'.repeat(20000) }).message.length, 8192, 'a line keeps at most 8 KB');
});

test('the query server listens on loopback only', async () => {
  const srv = startQueryServer(new Storage(), () => ({ streamConnected: true }));
  await new Promise(r => srv.listening ? r() : srv.once('listening', r));
  assert.equal(srv.address().address, '127.0.0.1');
  srv.close();
});
