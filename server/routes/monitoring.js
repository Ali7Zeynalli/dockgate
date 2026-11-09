const express = require('express');
const router = express.Router();
const http = require('http');
const fs = require('fs');
const { stmts } = require('../db');
const { resolveKeyPath } = require('../ssh-keys');
const { decrypt } = require('../auth/secrets');
const remoteCompose = require('../remote-compose');
const hostStats = require('../host-stats');
const deployer = require('../agent/deployer');
const dockerService = require('../docker');
const LogDoctor = require('../diagnostics/log-doctor');
const hostLogs = require('../host-logs');

// Helper to query on-host agent query server via wget/curl over SSH or loopback
// Helper to query on-host agent query server via wget/curl over SSH or docker exec
async function queryAgent(serverId, endpoint) {
  if (serverId === 'local') {
    // 1. Try local loopback if running in same net/process
    try {
      return await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:9000${endpoint}`, { timeout: 1500 }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Agent invalid response')); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Agent query timeout')); });
      });
    } catch (e) {}

    // 2. Query via docker exec on local dockgate-agent container
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      exec(`docker exec dockgate-agent wget -qO- "http://127.0.0.1:9000${endpoint}" 2>/dev/null`, { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return reject(new Error('Local agent not available'));
        try { resolve(JSON.parse(stdout.trim())); } catch (pe) { reject(pe); }
      });
    });
  }

  const server = stmts.getServer.get(serverId);
  if (!server) throw new Error(`Server not found: ${serverId}`);

  // Query agent container via docker exec or wget over SSH
  const cmd = `docker exec dockgate-agent wget -qO- "http://127.0.0.1:9000${endpoint}" 2>/dev/null || wget -qO- "http://127.0.0.1:9000${endpoint}" 2>/dev/null`;
  const raw = await remoteCompose.execRemote(server, cmd);
  if (!raw || !raw.trim()) throw new Error('Agent returned empty response or is not responding');
  return JSON.parse(raw.trim());
}

// GET /api/monitoring/servers — list all servers with agent readiness
router.get('/servers', async (req, res) => {
  try {
    const servers = stmts.getServers.all();
    const agentStatuses = await deployer.statusAll().catch(() => ({}));
    const result = servers.map(s => ({
      id: s.id,
      name: s.name || s.id,
      host: s.host,
      type: s.type,
      agent: agentStatuses[s.id] || { installed: false, running: false, state: 'absent' },
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/:serverId/metrics?range=live|48h&container=<name>
//   live (default) — the last 15 minutes from the Edge agent when it runs, otherwise one fresh sample (the page
//                    keeps a rolling 15-minute window itself).
//   48h            — DockGate's own store: one sample a minute per server, 5-minute buckets (average + peak).
//                    The same with or without the agent, and it survives reboots.
// Keep the agent's last `ms` of samples. host.* arrays line up with timestamps; a container's arrays may be
// shorter (it started later), so each keeps at most the same number of newest points.
function liveCut(data, ms) {
  const ts = data.timestamps || [];
  const from = ts.findIndex(t => t >= Date.now() - ms);
  if (from <= 0) return data;
  const keep = ts.length - from;
  const host = {};
  for (const [k, v] of Object.entries(data.host || {})) host[k] = Array.isArray(v) ? v.slice(-keep) : v;
  const containers = {};
  for (const [name, m] of Object.entries(data.containers || {})) { containers[name] = {}; for (const [k, v] of Object.entries(m || {})) containers[name][k] = Array.isArray(v) ? v.slice(-keep) : v; }
  return { ...data, count: keep, timestamps: ts.slice(from), host, containers };
}
router.get('/:serverId/metrics', async (req, res) => {
  const { serverId } = req.params;
  const { container = '' } = req.query;
  const range = req.query.range === '48h' ? '48h' : 'live';

  try {
    if (range === 'live') {
      try {
        const data = await queryAgent(serverId, `/metrics?range=1h${container ? `&container=${encodeURIComponent(container)}` : ''}`);
        return res.json({ source: 'agent', range, ...liveCut(data, 15 * 60 * 1000) });
      } catch (agentErr) { /* no agent → one fresh sample below */ }
    }

    if (range === '48h') {
      const rows = stmts.getHostHistory.all(serverId);
      const first = stmts.getHostHistoryFirst.get(serverId) || {};
      const col = (k) => rows.map(r => (r[k] == null ? null : Math.round(r[k] * 10) / 10));
      const last = rows[rows.length - 1] || {};
      let latestContainers = {};
      try {
        const running = (await dockerService.listContainers(false)).filter(c => c.state === 'running');
        const statResults = await Promise.all(running.map(c => dockerService.getContainerStats(c.id).then(s => ({ name: c.name || c.id.substring(0, 12), stats: s })).catch(() => null)));
        for (const r of statResults) if (r) latestContainers[r.name] = { cpuPercent: r.stats.cpuPercent, memPercent: r.stats.memoryPercent, memUsageBytes: r.stats.memoryUsage };
      } catch (e) { /* container stats are best-effort */ }
      return res.json({
        source: 'stored', range, bucketSeconds: 300, count: rows.length,
        storedSince: first.first ? new Date(String(first.first).replace(' ', 'T') + 'Z').getTime() : null, samples: first.n || 0,
        timestamps: rows.map(r => r.b * 1000),
        host: {
          cpu: col('cpu'), memPercent: col('mem'), diskPercent: col('disk'), netRxBytesSec: col('rx'), netTxBytesSec: col('tx'), load1: col('load1'),
          max: { cpu: col('cpu_max'), memPercent: col('mem_max'), diskPercent: col('disk_max'), netRxBytesSec: col('rx_max'), netTxBytesSec: col('tx_max'), load1: col('load1_max') },
          latest: { cpu: last.cpu || 0, memPercent: last.mem || 0, diskPercent: last.disk || 0, netRxBytesSec: last.rx || 0, netTxBytesSec: last.tx || 0 },
        },
        containers: {}, latestContainers,
      });
    }

    // Live without the agent: one fresh host + container sample (the page keeps the rolling window).
    let stats = null;
    if (serverId === 'local') {
      stats = await hostStats.collectLocalStats().catch(() => null);
    } else {
      try {
        const server = stmts.getServer.get(serverId);
        if (server) {
          const cfg = { ...server, keyPath: resolveKeyPath(server), password: decrypt(server.password), passphrase: decrypt(server.passphrase) };
          stats = await hostStats.collectHostStats(cfg).catch(() => null);
        }
      } catch (e) { /* best-effort */ }
    }
    const cpuVal = stats ? (stats.cpu || 0) : 0;
    const memVal = (stats && stats.mem && stats.mem.total) ? Math.round((stats.mem.used / stats.mem.total) * 100) : 0;
    const diskVal = (stats && stats.disks && stats.disks[0]) ? (stats.disks[0].usePct || 0) : 0;
    const netRxVal = stats && stats.net ? Math.round(stats.net.rxBytesSec || 0) : 0;
    const netTxVal = stats && stats.net ? Math.round(stats.net.txBytesSec || 0) : 0;

    // Collect live container stats
    let liveContainers = {};
    let latestContainers = {};
    try {
      const running = (await dockerService.listContainers(false)).filter(c => c.state === 'running');
      const statResults = await Promise.all(running.map(c =>
        dockerService.getContainerStats(c.id).then(s => ({ name: c.name || c.id.substring(0, 12), stats: s })).catch(() => null)
      ));
      for (const r of statResults) {
        if (!r) continue;
        liveContainers[r.name] = [{ cpuPercent: r.stats.cpuPercent, memPercent: r.stats.memoryPercent }];
        latestContainers[r.name] = { cpuPercent: r.stats.cpuPercent, memPercent: r.stats.memoryPercent, memUsageBytes: r.stats.memoryUsage };
      }
    } catch (e) { /* container stats are best-effort */ }

    const now = Date.now();
    res.json({
      source: 'live-fallback',
      range,
      count: 1,
      timestamps: [now],
      host: {
        cpu: [cpuVal],
        memPercent: [memVal],
        diskPercent: [diskVal],
        netRxBytesSec: [netRxVal],
        netTxBytesSec: [netTxVal],
        latest: {
          cpu: cpuVal,
          memPercent: memVal,
          diskPercent: diskVal,
          netRxBytesSec: netRxVal,
          netTxBytesSec: netTxVal,
        }
      },
      containers: liveContainers,
      latestContainers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/:serverId/logs?container=<name>&source=<src>&level=error&search=text&limit=100&since=123
router.get('/:serverId/logs', async (req, res) => {
  const { serverId } = req.params;
  const { container = '', source = '', level = '', search = '', limit = 100, since = 0 } = req.query;

  try {
    // 1. Try querying the agent's centralized log store first
    try {
      const params = new URLSearchParams();
      if (container) params.set('container', container);
      if (source) params.set('source', source);
      if (level) params.set('level', level);
      if (search) params.set('search', search);
      if (limit) params.set('limit', limit);
      if (since) params.set('since', since);

      const data = await queryAgent(serverId, `/logs?${params.toString()}`);
      return res.json({ source: 'agent', ...data });
    } catch (agentErr) {
      // Fallback: Agent not installed -> direct docker container & host logs
    }

    let logs = [];
    let availableContainers = [];

    // Fallback: System / Auth / Kernel / Nginx Host Logs
    if (source && (source === 'system' || source === 'auth' || source === 'kernel' || source === 'nginx')) {
      const srcMap = { system: 'syslog', auth: 'auth', kernel: 'kernel', nginx: 'journald' };
      const hlKey = srcMap[source] || 'journald';
      const hostLogRes = await hostLogs.collectHostLogs({ id: serverId, host: serverId }, { source: hlKey }, limit || 100).catch(() => null);
      if (hostLogRes && hostLogRes.text) {
        const hLines = hostLogRes.text.split('\n');
        for (let i = 0; i < hLines.length; i++) {
          const msg = hLines[i].trim();
          if (!msg) continue;
          const isErr = /error|fatal|fail|panic|exception/i.test(msg);
          const isWrn = /warn/i.test(msg);
          const lvl = isErr ? 'error' : (isWrn ? 'warn' : 'info');
          if (level && lvl !== level) continue;
          if (search && !msg.toLowerCase().includes(search.toLowerCase())) continue;
          logs.push({
            id: `h_${source}_${i}`,
            timestamp: Date.now() - (hLines.length - i) * 1000,
            containerName: source,
            source,
            stream: 'stdout',
            message: msg,
            level: lvl,
          });
        }
      }
    } else {
      // Fallback: Collect logs from Docker directly
      const runningContainers = await dockerService.listContainers(false).catch(() => []);
      availableContainers = runningContainers.map(c => c.name || c.shortId || c.id);

      const containersToRead = container
        ? runningContainers.filter(c => c.name === container || c.id === container || c.shortId === container)
        : runningContainers.slice(0, 8); // Top 8 containers

      for (const c of containersToRead) {
        const cName = c.name || c.shortId || c.id.substring(0, 12);
        const tailCount = container ? Math.min(Number(limit) || 100, 300) : 30;
        const lines = await dockerService.getContainerLogs(c.id, { tail: tailCount }).catch(() => []);
        for (let i = 0; i < lines.length; i++) {
          const msg = lines[i];
          const isErr = /error|fatal|fail|panic|exception/i.test(msg);
          const isWrn = /warn/i.test(msg);
          const lvl = isErr ? 'error' : (isWrn ? 'warn' : 'info');

          if (level && lvl !== level) continue;
          if (search && !msg.toLowerCase().includes(search.toLowerCase())) continue;

          logs.push({
            id: `c_${cName}_${i}`,
            timestamp: Date.now() - (lines.length - i) * 1000,
            containerName: cName,
            source: 'container',
            stream: 'stdout',
            message: msg,
            level: lvl,
          });
        }
      }
    }

    // Sort chronologically
    logs.sort((a, b) => a.timestamp - b.timestamp);

    return res.json({
      source: 'fallback',
      total: logs.length,
      returned: logs.length,
      logs,
      errorCount24h: logs.filter(l => l.level === 'error').length,
      availableContainers,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/:serverId/doctor — Intelligent Diagnostic & Health Analysis
router.get('/:serverId/doctor', async (req, res) => {
  const { serverId } = req.params;

  try {
    let rawLogs = [];

    // Attempt to fetch recent logs from the agent
    try {
      const agentLogs = await queryAgent(serverId, '/logs?limit=500');
      rawLogs = agentLogs.logs || [];
    } catch (e) {
      // Fallback: collect logs from active containers & host events
      try {
        const containers = await dockerService.listContainers(false);
        for (const c of containers.slice(0, 6)) {
          const cName = c.name || c.shortId || c.id.substring(0, 12);
          const cLogs = await dockerService.getContainerLogs(c.id, { tail: 40 }).catch(() => []);
          for (const msg of cLogs) {
            rawLogs.push({
              timestamp: Date.now(),
              containerName: cName,
              message: msg,
              source: 'container',
            });
          }
        }
      } catch (err) {}
    }

    // Run Log Doctor Diagnostic Analysis
    const analysis = LogDoctor.analyze(rawLogs);
    res.json({
      serverId,
      analyzedLogCount: rawLogs.length,
      ...analysis,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/:serverId/summary
router.get('/:serverId/summary', async (req, res) => {
  const { serverId } = req.params;
  try {
    try {
      const data = await queryAgent(serverId, '/summary');
      return res.json({ source: 'agent', ...data });
    } catch (e) {
      // Fallback: live host stats and container matrix
      let hostData = null;

      if (serverId !== 'local') {
        const server = stmts.getServer.get(serverId);
        if (server) {
          const cfg = { ...server, keyPath: resolveKeyPath(server), password: decrypt(server.password), passphrase: decrypt(server.passphrase) };
          const s = await hostStats.collectHostStats(cfg).catch(() => null);
          if (s) {
            hostData = {
              cpu: s.cpu || 0,
              memPercent: s.mem && s.mem.total ? Math.round((s.mem.used / s.mem.total) * 100) : 0,
              diskPercent: (s.disks && s.disks[0]) ? s.disks[0].usePct : 0,
              netRxBytesSec: s.net ? Math.round(s.net.rxBytesSec) : 0,
              netTxBytesSec: s.net ? Math.round(s.net.txBytesSec) : 0,
              load1: s.load ? s.load.load1 : 0,
            };
          }
        }
      } else {
        const s = await hostStats.collectLocalStats().catch(() => null);
        if (s) {
          hostData = {
            cpu: s.cpu || 0,
            memPercent: s.mem && s.mem.total ? Math.round((s.mem.used / s.mem.total) * 100) : 0,
            diskPercent: (s.disks && s.disks[0]) ? (s.disks[0].usePct || 0) : 0,
            netRxBytesSec: s.net ? Math.round(s.net.rxBytesSec || 0) : 0,
            netTxBytesSec: s.net ? Math.round(s.net.txBytesSec || 0) : 0,
            load1: s.load ? s.load.load1 : 0,
          };
        }
      }

      // Container resource breakdown — fetch real stats for each running container
      const containers = await dockerService.listContainers(false).catch(() => []);
      const breakdown = await Promise.all(containers.map(async (c) => {
        const base = {
          id: c.shortId || c.id.substring(0, 12),
          name: c.name || c.shortId || c.id.substring(0, 12),
          image: c.image,
          state: c.state,
          status: c.status,
          cpuPercent: 0,
          memUsageBytes: 0,
          memPercent: 0,
        };
        if (c.state === 'running') {
          try {
            const s = await dockerService.getContainerStats(c.id);
            base.cpuPercent = s.cpuPercent;
            base.memUsageBytes = s.memoryUsage;
            base.memPercent = s.memoryPercent;
          } catch (e) { /* container may have stopped between list and stats */ }
        }
        return base;
      }));

      res.json({
        source: 'live-fallback',
        host: hostData,
        containersCount: containers.length,
        breakdown,
        recentErrors1h: 0,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
