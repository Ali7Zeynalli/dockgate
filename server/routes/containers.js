const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');

// List all containers
router.get('/', async (req, res) => {
  try {
    const all = req.query.all !== 'false';
    const containers = await dockerService.listContainers(all);
    // Enrich with metadata
    const enriched = containers.map(c => {
      const fav = stmts.isFavorite.get(c.id, 'container');
      const note = stmts.getNote.get(c.id, 'container');
      const tags = stmts.getTagsForResource.all(c.id, 'container');
      return { ...c, isFavorite: !!fav, note: note?.note || null, tags: tags.map(t => ({ tag: t.tag, color: t.color })) };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inspect container
router.get('/:id', async (req, res) => {
  try {
    const data = await dockerService.inspectContainer(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Container stats (one-shot)
router.get('/:id/stats', async (req, res) => {
  try {
    const stats = await dockerService.getContainerStats(req.params.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container logs
router.get('/:id/logs', async (req, res) => {
  try {
    const logs = await dockerService.getContainerLogs(req.params.id, {
      tail: parseInt(req.query.tail) || 200,
      timestamps: req.query.timestamps === 'true',
    });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container actions
router.post('/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const result = await dockerService.containerAction(id, action, req.body);
    // Log activity
    try {
      const info = await dockerService.inspectContainer(id);
      logAction({ req, resourceId: id, resourceType: 'container', resourceName: info.Name?.replace(/^\//, '') || id.substring(0, 12), action, details: req.body });
    } catch (e) {
      logAction({ req, resourceId: id, resourceType: 'container', resourceName: id.substring(0, 12), action, details: req.body });
    }
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Create container (raw dockerode config — advanced)
router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createContainer(req.body);
    logAction({ req, resourceId: result.id, resourceType: 'container', resourceName: req.body.name || result.id.substring(0, 12), action: 'create', details: req.body });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse a human memory value ("512m", "1g", "256") into bytes
function parseMemory(v) {
  if (!v) return undefined;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] || '').toLowerCase()];
  return Math.round(n * mult);
}

// Build a Docker Engine create config from the friendly "Run" form payload
function buildRunConfig(b) {
  const exposed = {};
  const bindings = {};
  for (const p of (b.ports || [])) {
    if (!p.container) continue;
    const proto = (p.proto || 'tcp').toLowerCase();
    const key = `${p.container}/${proto}`;
    exposed[key] = {};
    if (p.host) bindings[key] = [{ HostPort: String(p.host) }];
  }
  const binds = (b.volumes || [])
    .filter(v => v.host && v.container)
    .map(v => `${v.host}:${v.container}${v.mode === 'ro' ? ':ro' : ''}`);
  const env = (b.env || []).map(e => (typeof e === 'string' ? e : `${e.key}=${e.value}`)).filter(e => e && e.includes('='));

  const hostConfig = {};
  if (Object.keys(bindings).length) hostConfig.PortBindings = bindings;
  if (binds.length) hostConfig.Binds = binds;
  if (b.restart && b.restart !== 'no') hostConfig.RestartPolicy = { Name: b.restart };
  if (b.cpus) hostConfig.NanoCpus = Math.round(parseFloat(b.cpus) * 1e9);
  const mem = parseMemory(b.memory);
  if (mem) hostConfig.Memory = mem;
  if (b.network) hostConfig.NetworkMode = b.network;

  const config = { Image: b.image };
  if (b.name) config.name = b.name;
  if (env.length) config.Env = env;
  if (b.cmd && b.cmd.trim()) config.Cmd = b.cmd.trim().split(/\s+/);
  if (Object.keys(exposed).length) config.ExposedPorts = exposed;
  if (Object.keys(hostConfig).length) config.HostConfig = hostConfig;
  return config;
}

// Run a container from the guided form: (optional) pull → create → start.
// Runs against the ACTIVE daemon (local or remote SSH) via the docker Proxy.
router.post('/run', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.image) return res.status(400).json({ error: 'Image is required' });

    if (b.pull) {
      try { await dockerService.pullImage(b.image); }
      catch (e) { return res.status(400).json({ error: 'Pull failed: ' + e.message }); }
    }

    const config = buildRunConfig(b);
    let result;
    try {
      result = await dockerService.createContainer(config);
    } catch (e) {
      // Image not present locally → pull once then retry
      if (/no such image|not found/i.test(e.message)) {
        await dockerService.pullImage(b.image);
        result = await dockerService.createContainer(config);
      } else { throw e; }
    }

    await dockerService.containerAction(result.id, 'start');
    logAction({ req, resourceId: result.id, resourceType: 'container', resourceName: b.name || result.id.substring(0, 12), action: 'run', details: { image: b.image, ports: (b.ports || []).length, volumes: (b.volumes || []).length } });
    res.json({ success: true, id: result.id });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
