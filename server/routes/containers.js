const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');

/**
 * Return a shallow copy of an audit `details` body with secret-bearing values masked, so
 * environment variables (tokens, passwords, …) never land in the audit log or its CSV export.
 * Masks the values of an `Env` array ("KEY=secret" → "KEY=***"); everything else is left intact.
 * @param {*} body the raw request body about to be logged
 * @returns {*} a safe-to-log copy (or the original if there is nothing to redact)
 */
function redactSecrets(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.Env)) return body;
  return {
    ...body,
    Env: body.Env.map(e => {
      const s = String(e);
      const i = s.indexOf('=');
      return i === -1 ? s : s.slice(0, i) + '=***';
    }),
  };
}

// List all containers
router.get('/', async (req, res) => {
  try {
    const all = req.query.all !== 'false';
    const containers = await dockerService.listContainers(all);
    // Containers moved to Swarm (docker run → stack): kept stopped; marked so they are not started twice.
    const moved = new Map();
    try { for (const r of require('../swarm-stacks').stackRows()) if (r.from_container) moved.set(JSON.parse(r.from_container).id, r.name); } catch (e) { /* Swarm off */ }
    // Enrich with metadata
    const enriched = containers.map(c => {
      const fav = stmts.isFavorite.get(c.id, 'container');
      const note = stmts.getNote.get(c.id, 'container');
      const tags = stmts.getTagsForResource.all(c.id, 'container');
      const stack = moved.get(c.id);
      return { ...c, isFavorite: !!fav, note: note?.note || null, tags: tags.map(t => ({ tag: t.tag, color: t.color })), ...(stack ? { movedToSwarm: stack } : {}) };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit entries carry the container NAME (the ID changes on every recreate, the name stays), so a
// container's history can be found after an update.
async function nameOf(id) {
  try { return (await dockerService.docker.getContainer(id).inspect()).Name.replace(/^\//, ''); }
  catch (e) { return String(id).substring(0, 12); }
}

// ---- Image update with history and roll back (server/image-update-runner.js) ----
const runner = () => require('../image-update-runner');
const activeServer = () => dockerService.getActiveServerId() || 'local';
// History of image updates: ?name= (container) and/or ?project=&service=; none → the whole server.
router.get('/image-updates/history', (req, res) => {
  try { res.json({ rows: runner().history({ serverId: activeServer(), name: req.query.name, project: req.query.project, service: req.query.service, limit: req.query.limit }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/image-updates/job/:jobId', (req, res) => {
  const j = runner().getJob(req.params.jobId);
  if (!j) return res.status(404).json({ error: 'Job not found (DockGate restarted?) — see the update history' });
  res.json(j);
});
router.get('/image-updates/:historyId/log', (req, res) => {
  const r = runner().logOf(req.params.historyId);
  if (!r || r.server_id !== activeServer()) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
// Roll back to the image a container ran before the update in history row :historyId.
router.post('/image-updates/:historyId/rollback', async (req, res) => {
  try {
    const job = await runner().start({ kind: 'rollback', historyId: req.params.historyId, containerId: (req.body || {}).containerId || null, sourceIp: req.ip });
    res.json({ jobId: job.id, historyId: job.historyId });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
// Update status of one container: the newer-image check row, its last updates and a roll back target.
router.get('/:id/image-update', async (req, res) => {
  try {
    const info = await dockerService.docker.getContainer(req.params.id).inspect();
    const name = (info.Name || '').replace(/^\//, '');
    const l = info.Config.Labels || {};
    const project = l['com.docker.compose.project'] || null, service = l['com.docker.compose.service'] || null;
    const IU = require('../image-updates');
    const check = IU.resultFor(activeServer(), info.Config.Image);
    let current = null;
    try { const im = await dockerService.docker.getImage(info.Image).inspect(); current = { version: IU.versionOf(im.Config, (IU.parseRef(info.Config.Image) || {}).repo || ''), created: im.Created }; } catch (e) { /* removed */ }
    const stale = (await IU.staleContainers(dockerService.docker).catch(() => new Map())).get(info.Id) || null;
    res.json({ name, project, service, image: info.Config.Image, imageId: info.Image, current, check, stale,
      history: runner().history({ serverId: activeServer(), name, project, service, limit: 10 }),
      rollback: await runner().rollbackTarget(activeServer(), name, project, service, info.Image) });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
// Pull the same tag and recreate the container (compose: only its service), with a check and an automatic roll back.
router.post('/:id/image-update', async (req, res) => {
  try {
    const job = await runner().start({ kind: 'update', containerId: req.params.id, sourceIp: req.ip });
    res.json({ jobId: job.id, historyId: job.historyId });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
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

// Running processes inside the container (docker top)
router.get('/:id/top', async (req, res) => {
  try {
    res.json(await dockerService.containerTop(req.params.id));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Export the container's filesystem as a tar download
router.get('/:id/export', async (req, res) => {
  try {
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'export' });
    const stream = await dockerService.containerExportStream(req.params.id);
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id.substring(0, 12)}.tar"`);
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// One-off command execution — defined BEFORE "/:id/:action" so "exec" isn't treated as an action.
// body: { cmd: "ls -la /" | ["ls","-la","/"] }
router.post('/:id/exec', async (req, res) => {
  try {
    const raw = (req.body || {}).cmd;
    const cmd = Array.isArray(raw) ? raw : String(raw || '').trim().split(/\s+/).filter(Boolean);
    if (!cmd.length) return res.status(400).json({ error: 'cmd required' });
    const result = await dockerService.containerExecOnce(req.params.id, cmd);
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'exec', details: { cmd: cmd.join(' ') } });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Live resource / restart-policy update (C1) — body: { cpus?, memory?, restart? }
router.post('/:id/update', async (req, res) => {
  try {
    const { cpus, memory, restart } = req.body || {};
    const cfg = {};
    if (cpus !== undefined && cpus !== '') cfg.NanoCpus = Math.round(parseFloat(cpus) * 1e9) || 0;
    // MemorySwap = -1 → limitsiz swap (Docker qaydası: MemorySwap ≥ Memory; bərabər qoymaq swap-ı 0 edərdi)
    if (memory !== undefined && memory !== '') { cfg.Memory = parseMemory(memory); cfg.MemorySwap = -1; }
    if (restart) cfg.RestartPolicy = { Name: restart, MaximumRetryCount: restart === 'on-failure' ? 3 : 0 };
    if (!Object.keys(cfg).length) return res.status(400).json({ error: 'Nothing to update' });
    await dockerService.updateContainer(req.params.id, cfg);
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'update', details: { cpus, memory, restart } });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Commit the container into a new image (C4) — body: { repo, tag?, comment? }
router.post('/:id/commit', async (req, res) => {
  try {
    const { repo, tag, comment } = req.body || {};
    if (!repo) return res.status(400).json({ error: 'repo required' });
    const r = await dockerService.commitContainer(req.params.id, { repo, tag: tag || 'latest', comment });
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'commit', details: { repo, tag: tag || 'latest' } });
    res.json(r);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Recreate with (optionally) a new image — the update flow (C2). body: { image? }
router.post('/:id/recreate', async (req, res) => {
  try {
    const before = await dockerService.docker.getContainer(req.params.id).inspect().catch(() => null);
    const r = await dockerService.recreateContainer(req.params.id, (req.body || {}).image);
    const cname = before ? before.Name.replace(/^\//, '') : req.params.id.substring(0, 12);
    logAction({ req, resourceId: r.id, resourceType: 'container', resourceName: cname, action: 'recreate', details: { from: before ? before.Config.Image : undefined, image: (req.body || {}).image || '(same)', old_id: before ? before.Id.slice(0, 12) : undefined } });
    res.json(r);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// C3 — browse files inside a (running) container
router.get('/:id/files', async (req, res) => {
  try { res.json(await dockerService.containerListFiles(req.params.id, req.query.path || '/')); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// C3 — download a single file from a container
router.get('/:id/file', async (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'path required' });
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'file-download', details: { path: req.query.path } });
    await dockerService.containerDownloadFile(req.params.id, req.query.path, res);
  } catch (err) { if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message }); }
});

// C3 — copy in: extract an uploaded tar into the container at ?path= (raw tar body). Before /:id/:action.
router.post('/:id/upload', async (req, res) => {
  try {
    await dockerService.containerUpload(req.params.id, req.query.path || '/', req);
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'cp-in', details: { path: req.query.path || '/' } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Edit files in a container: read / save a text file, new folder, rename, delete (server/file-edit.js)
const FE = require('../file-edit');
const feFail = (res, err) => res.status(err.statusCode || 500).json({ error: err.message });
router.get('/:id/text', async (req, res) => {
  try { res.json(await FE.read('container', req.params.id, String(req.query.path || ''))); } catch (e) { feFail(res, e); }
});
router.put('/:id/text', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await FE.write('container', req.params.id, String(b.path || ''), b.content);
    logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action: 'file-edit', details: { path: r.path, size: r.size, created: r.created } });
    res.json(r);
  } catch (e) { feFail(res, e); }
});
for (const [route, fn, action] of [['mkdir', (id, b) => FE.mkdir('container', id, String(b.path || '')), 'file-mkdir'], ['rename', (id, b) => FE.rename('container', id, String(b.path || ''), b.name), 'file-rename'], ['delete-path', (id, b) => FE.remove('container', id, String(b.path || '')), 'file-delete']]) {
  router.post(`/:id/${route}`, async (req, res) => {
    try {
      const r = await fn(req.params.id, req.body || {});
      logAction({ req, resourceId: req.params.id, resourceType: 'container', resourceName: await nameOf(req.params.id), action, details: { path: (req.body || {}).path, ...(route === 'rename' ? { to: r.path } : {}) } });
      res.json(r);
    } catch (e) { feFail(res, e); }
  });
}

// Container actions
router.post('/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const result = await dockerService.containerAction(id, action, req.body);
    // Log activity
    try {
      const info = await dockerService.inspectContainer(id);
      logAction({ req, resourceId: id, resourceType: 'container', resourceName: info.Name?.replace(/^\//, '') || id.substring(0, 12), action, details: redactSecrets(req.body) });
    } catch (e) {
      logAction({ req, resourceId: id, resourceType: 'container', resourceName: id.substring(0, 12), action, details: redactSecrets(req.body) });
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
    logAction({ req, resourceId: result.id, resourceType: 'container', resourceName: req.body.name || result.id.substring(0, 12), action: 'create', details: redactSecrets(req.body) });
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
