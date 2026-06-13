// Host metrics — PURE parsers for /proc + df/ps/ss output, plus collectHostStats() which gathers one
// snapshot over SSH via an isolated worker (host-stats-worker.js). CPU% and net rate need two reads
// ~0.6s apart, so the remote command samples /proc/stat and /proc/net/dev twice.
const { execFile } = require('child_process');
const path = require('path');

function cpuTimes(line) {
  const p = line.trim().split(/\s+/).slice(1).map(Number); // user nice system idle iowait irq softirq steal …
  const idle = (p[3] || 0) + (p[4] || 0);
  const total = p.reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}
function parseCpu(stat1, stat2) {
  const l1 = (stat1 || '').split('\n').find(l => /^cpu\s/.test(l));
  const l2 = (stat2 || '').split('\n').find(l => /^cpu\s/.test(l));
  if (!l1 || !l2) return { cpuPercent: 0 };
  const a = cpuTimes(l1), b = cpuTimes(l2);
  const dt = b.total - a.total, di = b.idle - a.idle;
  const pct = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  return { cpuPercent: Math.round(pct * 10) / 10 };
}
function parseMem(txt) {
  const m = {};
  for (const line of (txt || '').split('\n')) { const x = line.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = parseInt(x[2]) * 1024; }
  const total = m.MemTotal || 0;
  const available = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0);
  return { total, available, used: Math.max(0, total - available), swapTotal: m.SwapTotal || 0, swapUsed: Math.max(0, (m.SwapTotal || 0) - (m.SwapFree || 0)) };
}
function parseLoad(txt) {
  const p = (txt || '').trim().split(/\s+/);
  const procs = (p[3] || '0/0').split('/');
  return { load1: parseFloat(p[0]) || 0, load5: parseFloat(p[1]) || 0, load15: parseFloat(p[2]) || 0, procsRunning: parseInt(procs[0]) || 0, procsTotal: parseInt(procs[1]) || 0 };
}
function parseUptime(txt) { return Math.floor(parseFloat((txt || '').trim().split(/\s+/)[0]) || 0); }
function parseDf(txt) {
  return (txt || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 6)
    .map(p => ({ fs: p[0], size: +p[1] || 0, used: +p[2] || 0, avail: +p[3] || 0, usePct: parseInt(p[4]) || 0, mount: p.slice(5).join(' ') }))
    .filter(d => d.size > 0);
}
function netTotals(txt) {
  let rx = 0, tx = 0;
  for (const line of (txt || '').split('\n')) {
    const m = line.match(/^\s*([\w@.:-]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
    if (m && m[1] !== 'lo') { rx += +m[2]; tx += +m[3]; }
  }
  return { rx, tx };
}
function parseNet(net1, net2, dtSec) {
  const a = netTotals(net1), b = netTotals(net2);
  const d = dtSec > 0 ? dtSec : 1;
  return { rxBytesSec: Math.max(0, Math.round((b.rx - a.rx) / d)), txBytesSec: Math.max(0, Math.round((b.tx - a.tx) / d)) };
}
function parsePs(txt) {
  return (txt || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 5)
    .map(p => ({ pid: +p[0] || 0, comm: p[1], cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0, rss: (+p[4] || 0) * 1024 }));
}
function parsePorts(txt) {
  const ports = new Set();
  for (const line of (txt || '').split('\n')) {
    const local = line.trim().split(/\s+/).find(c => /:\d+$/.test(c)); // first addr:port (not addr:*)
    if (local) { const port = parseInt(local.split(':').pop()); if (port) ports.add(port); }
  }
  return [...ports].sort((a, b) => a - b);
}

// One-shot remote command: two /proc samples ~0.6s apart, then df/ps/ss. Markers delimit the sections.
const STATS_CMD = [
  'echo @@S1@@; cat /proc/stat',
  'echo @@N1@@; cat /proc/net/dev',
  'sleep 0.6',
  'echo @@S2@@; cat /proc/stat',
  'echo @@N2@@; cat /proc/net/dev',
  'echo @@MEM@@; cat /proc/meminfo',
  'echo @@LOAD@@; cat /proc/loadavg',
  'echo @@UP@@; cat /proc/uptime',
  'echo @@DF@@; df -PB1 -x tmpfs -x devtmpfs -x overlay 2>/dev/null',
  'echo @@PS@@; ps -eo pid,comm,pcpu,pmem,rss --sort=-pcpu 2>/dev/null | head -n 8',
  'echo @@PORTS@@; (ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null)',
  'echo @@END@@',
].join('; ');

function parseSnapshot(out) {
  const sec = (tag) => { const parts = (out || '').split('@@' + tag + '@@'); return parts[1] ? parts[1].split('@@')[0] : ''; };
  return {
    cpu: parseCpu(sec('S1'), sec('S2')).cpuPercent,
    mem: parseMem(sec('MEM')),
    load: parseLoad(sec('LOAD')),
    uptime: parseUptime(sec('UP')),
    disks: parseDf(sec('DF')),
    net: parseNet(sec('N1'), sec('N2'), 0.6),
    procs: parsePs(sec('PS')),
    ports: parsePorts(sec('PORTS')),
  };
}

// Gather one snapshot over SSH via the isolated worker. server: { host,port,username,keyPath?,password?,passphrase? }.
function collectHostStats(server) {
  return new Promise((resolve, reject) => {
    const cfg = { host: server.host, port: server.port, username: server.username, keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null };
    const child = execFile(process.execPath, [path.join(__dirname, 'host-stats-worker.js'), JSON.stringify(cfg)], { maxBuffer: 8 * 1024 * 1024 });
    const to = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('host stats timed out')); }, 25000);
    let buf = '', err = '';
    child.stdout.on('data', d => { buf += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(to); if (code !== 0) return reject(new Error(err.trim() || 'host stats failed')); try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad stats output')); } });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

module.exports = { parseCpu, parseMem, parseLoad, parseUptime, parseDf, parseNet, parsePs, parsePorts, parseSnapshot, STATS_CMD, collectHostStats };
