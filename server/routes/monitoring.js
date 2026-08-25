const express = require('express');
const router = express.Router();
const http = require('http');
const { stmts } = require('../db');
const { resolveKeyPath } = require('../ssh-keys');
const { decrypt } = require('../auth/secrets');
const remoteCompose = require('../remote-compose');
const hostStats = require('../host-stats');
const deployer = require('../agent/deployer');
const dockerService = require('../docker');
const LogDoctor = require('../diagnostics/log-doctor');

// Helper to query on-host agent query server via wget/curl over SSH or loopback
async function queryAgent(serverId, endpoint) {
  if (serverId === 'local') {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:9000${endpoint}`, { timeout: 4000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Agent invalid response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Agent query timeout')); });
    });
  }

  const server = stmts.getServer.get(serverId);
  if (!server) throw new Error(`Server not found: ${serverId}`);

  // Query agent container via docker exec or wget over SSH
  const cmd = `docker exec dockgate-notifier wget -qO- "http://127.0.0.1:9000${endpoint}" 2>/dev/null || wget -qO- "http://127.0.0.1:9000${endpoint}" 2>/dev/null`;
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

// GET /api/monitoring/:serverId/metrics?range=1h|6h|24h|7d&container=<name>
router.get('/:serverId/metrics', async (req, res) => {
  const { serverId } = req.params;
  const { range = '1h', container = '' } = req.query;

  try {
    // 1. Try querying the dockgate-agent on the server first
    try {
      const qs = `?range=${encodeURIComponent(range)}${container ? `&container=${encodeURIComponent(container)}` : ''}`;
      const data = await queryAgent(serverId, `/metrics${qs}`);
      return res.json({ source: 'agent', ...data });
    } catch (agentErr) {
      // Fallback: Agent not installed or not answering -> return DB metrics or live sample
    }

    // Fallback: Query historical DB metrics if remote server
    if (serverId !== 'local') {
      const dbMetrics = stmts.getHostMetrics ? stmts.getHostMetrics.all(serverId, 300) : [];
      if (dbMetrics.length > 0) {
        const timestamps = dbMetrics.map(m => new Date(m.created_at).getTime()).reverse();
        const cpu = dbMetrics.map(m => m.cpu_pct || 0).reverse();
        const memPercent = dbMetrics.map(m => m.mem_pct || 0).reverse();
        const diskPercent = dbMetrics.map(m => m.disk_pct || 0).reverse();
        const netRx = dbMetrics.map(m => m.net_rx_bytes_sec || 0).reverse();
        const netTx = dbMetrics.map(m => m.net_tx_bytes_sec || 0).reverse();

        return res.json({
          source: 'db-fallback',
          range,
          count: timestamps.length,
          timestamps,
          host: {
            cpu,
            memPercent,
            diskPercent,
            netRxBytesSec: netRx,
            netTxBytesSec: netTx,
            latest: {
              cpu: cpu[cpu.length - 1] || 0,
              memPercent: memPercent[memPercent.length - 1] || 0,
              diskPercent: diskPercent[diskPercent.length - 1] || 0,
            }
          },
          containers: {},
        });
      }
    }

    res.json({ source: 'none', count: 0, timestamps: [], host: { cpu: [], memPercent: [], diskPercent: [], netRxBytesSec: [], netTxBytesSec: [] }, containers: {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/:serverId/logs?container=<name>&source=<src>&level=error&search=text&limit=100&since=123
router.get('/:serverId/logs', async (req, res) => {
  const { serverId } = req.params;
  const { container = '', source = '', level = '', search = '', limit = 100, since = 0 } = req.query;

  try {
    // 1. Try querying the agent's centralized log store
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
      // Fallback: Agent not installed -> direct docker logs
    }

    // Fallback: If container specified, read from Docker directly
    if (container) {
      const lines = await dockerService.getContainerLogs(container, { tail: Number(limit) || 100 });
      const logs = (lines || []).map((l, i) => ({
        id: `fb_${i}`,
        timestamp: Date.now(),
        containerName: container,
        source: 'container',
        stream: 'stdout',
        message: l,
        level: /error|fatal|fail/i.test(l) ? 'error' : (/warn/i.test(l) ? 'warn' : 'info'),
      }));
      return res.json({ source: 'docker-fallback', total: logs.length, returned: logs.length, logs, errorCount24h: 0, availableContainers: [container] });
    }

    res.json({ source: 'none', total: 0, returned: 0, logs: [], errorCount24h: 0, availableContainers: [] });
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
        for (const c of containers.slice(0, 5)) {
          const cLogs = await dockerService.getContainerLogs(c.Id, { tail: 30 }).catch(() => []);
          for (const msg of cLogs) {
            rawLogs.push({
              timestamp: Date.now(),
              containerName: (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, ''),
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
      // Fallback: live host stats
      if (serverId !== 'local') {
        const server = stmts.getServer.get(serverId);
        if (server) {
          const cfg = { ...server, keyPath: resolveKeyPath(server), password: decrypt(server.password), passphrase: decrypt(server.passphrase) };
          const s = await hostStats.collectHostStats(cfg);
          return res.json({
            source: 'live-fallback',
            host: {
              cpu: s.cpu || 0,
              memPercent: s.mem && s.mem.total ? Math.round((s.mem.used / s.mem.total) * 100) : 0,
              diskPercent: (s.disks && s.disks[0]) ? s.disks[0].usePct : 0,
              netRxBytesSec: s.net ? Math.round(s.net.rxBytesSec) : 0,
              netTxBytesSec: s.net ? Math.round(s.net.txBytesSec) : 0,
              load1: s.load ? s.load.load1 : 0,
            },
            containersCount: 0,
            breakdown: [],
            recentErrors1h: 0,
          });
        }
      }
      res.json({ source: 'none', host: null, breakdown: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
