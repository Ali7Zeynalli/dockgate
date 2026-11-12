// /api/swarm — Docker Swarm on the server in use (server/swarm.js).
const express = require('express');
const router = express.Router();
const swarm = require('../swarm');
const cluster = require('../swarm-cluster');
const { logAction } = require('../audit');
const dockerService = require('../docker');

const fail = (res, err) => res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : (swarm.dockerMsg(err) || err.message) });

router.get('/status', async (req, res) => {
  try { res.json({ ...(await swarm.status()), job: swarm.runningJob() ? swarm.runningJob().id : null }); } catch (e) { fail(res, e); }
});
router.post('/checks', async (req, res) => {
  try { res.json(await swarm.checks({ pool: (req.body || {}).pool })); } catch (e) { fail(res, e); }
});
router.post('/init', async (req, res) => {
  try { const j = await swarm.startInit(req.body || {}, { sourceIp: req.ip }); res.json({ jobId: j.id }); } catch (e) { fail(res, e); }
});
router.get('/jobs', (req, res) => { res.json({ jobs: swarm.listJobs() }); });
// Autoscale rules (server/swarm-autoscale.js)
const autoscale = require('../swarm-autoscale');
router.get('/autoscale', async (req, res) => { try { res.json(await autoscale.overview()); } catch (e) { fail(res, e); } });
router.get('/autoscale/rules', async (req, res) => { try { res.json({ rules: await autoscale.listRules() }); } catch (e) { fail(res, e); } });
router.put('/autoscale/rules', async (req, res) => { try { res.json(await autoscale.saveRules((req.body || {}).services, req.body || {}, { sourceIp: req.ip })); } catch (e) { fail(res, e); } });
router.put('/autoscale/settings', (req, res) => { try { res.json(autoscale.saveSettings(req.body || {}, { sourceIp: req.ip })); } catch (e) { fail(res, e); } });
router.post('/services/:id/autoscale/enabled', async (req, res) => { try { res.json(await autoscale.setEnabled(req.params.id, !!(req.body || {}).on, { sourceIp: req.ip })); } catch (e) { fail(res, e); } });
router.get('/services/:id/autoscale', async (req, res) => { try { res.json(await autoscale.getRule(req.params.id)); } catch (e) { fail(res, e); } });
router.put('/services/:id/autoscale', async (req, res) => { try { res.json(await autoscale.saveRule(req.params.id, req.body || {}, { sourceIp: req.ip })); } catch (e) { fail(res, e); } });
router.delete('/services/:id/autoscale', async (req, res) => { try { res.json(await autoscale.removeRule(req.params.id, { sourceIp: req.ip })); } catch (e) { fail(res, e); } });
router.get('/job/:id', (req, res) => {
  const j = swarm.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found (DockGate restarted?)' });
  res.json(j);
});
router.get('/overview', async (req, res) => {
  try { res.json(await cluster.overviewExtras(await swarm.overview())); } catch (e) { fail(res, e); }
});

// ---- phase 2: nodes and several servers (server/swarm-cluster.js) ----
router.get('/nodes', async (req, res) => { try { res.json(await cluster.nodes()); } catch (e) { fail(res, e); } });
router.get('/candidates', async (req, res) => { try { res.json({ servers: await cluster.candidates() }); } catch (e) { fail(res, e); } });
// Checks for servers that should join. body: { servers:[{id, role}], create: true when the swarm does not exist yet }
router.post('/candidates/check', async (req, res) => {
  try {
    const b = req.body || {};
    let ref;
    if (b.create) {
      const st = await swarm.status();
      const ck = await swarm.checks({ pool: b.pool });
      const addr = b.managerAddr || (ck.addresses.find(a => a.private) || ck.addresses[0] || {}).ip || null;
      ref = { version: st.dockerVersion, arch: st.arch, addr, hostnames: [st.serverName], dataPort: Number(b.dataPort) || 4789, preInit: true };
    } else {
      const ov = await cluster.nodes();
      const me = ov.nodes.find(n => n.self) || {};
      ref = { version: me.engine, arch: me.arch, addr: me.addr, addrs: ov.nodes.map(n => n.addr), hostnames: ov.nodes.map(n => n.hostname) };
    }
    res.json(await cluster.checkServers((b.servers || []).slice(0, 20), ref));
  } catch (e) { fail(res, e); }
});
router.post('/cluster', async (req, res) => {
  try { const j = await cluster.startCreateCluster(req.body || {}, { sourceIp: req.ip }); res.json({ jobId: j.id }); } catch (e) { fail(res, e); }
});
router.post('/servers/add', async (req, res) => {
  try { const j = await cluster.startAddServers(req.body || {}, { sourceIp: req.ip }); res.json({ jobId: j.id }); } catch (e) { fail(res, e); }
});
router.get('/nodes/:id/detail', async (req, res) => { try { res.json(await cluster.nodeDetail(req.params.id)); } catch (e) { fail(res, e); } });
router.get('/nodes/:id/events', async (req, res) => { try { res.json({ events: await cluster.nodeEvents(req.params.id, req.query.hours) }); } catch (e) { fail(res, e); } });
router.get('/nodes/:id/audit', async (req, res) => { try { res.json({ audit: cluster.nodeAudit(String(req.query.name || '')) }); } catch (e) { fail(res, e); } });
router.get('/nodes/:id/drain-impact', async (req, res) => { try { res.json(await cluster.drainImpact(req.params.id)); } catch (e) { fail(res, e); } });
router.post('/nodes/:id/update', async (req, res) => {
  try { res.json(await cluster.updateNode(req.params.id, req.body || {}, { sourceIp: req.ip })); } catch (e) { fail(res, e); }
});
router.post('/nodes/:id/remove', async (req, res) => {
  try {
    if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'confirm required' });
    const j = await cluster.startRemoveNode(req.params.id, { sourceIp: req.ip }); res.json({ jobId: j.id });
  } catch (e) { fail(res, e); }
});
router.post('/rebalance', async (req, res) => {
  try { const j = await cluster.startRebalance({ sourceIp: req.ip }); res.json({ jobId: j.id }); } catch (e) { fail(res, e); }
});
// ---- phase 3: services (server/swarm-services.js) ----
const svc = require('../swarm-services');
const ok = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : (swarm.dockerMsg(e) || e.message), ...(e.needConfirm ? { needConfirm: e.needConfirm } : {}) }); } };
router.get('/services', ok(async () => ({ services: await svc.list() })));
router.get('/services/stats', ok(() => svc.stats()));
router.get('/services/new', ok(() => svc.choices()));
router.post('/services/check-images', ok(() => svc.checkImages()));
router.post('/services/:id/update-newest', ok((req) => svc.updateToNewest(req.params.id, { sourceIp: req.ip })));
router.post('/services', ok((req) => svc.create((req.body || {}).form || {}, { sourceIp: req.ip })));
router.get('/services/:id', ok((req) => svc.get(req.params.id)));
router.put('/services/:id', ok((req) => svc.save(req.params.id, (req.body || {}).form || {}, { sourceIp: req.ip, version: (req.body || {}).version })));
router.post('/services/:id/scale', ok((req) => svc.scale(req.params.id, (req.body || {}).replicas, { sourceIp: req.ip, confirmDb: !!(req.body || {}).confirmDb })));
router.post('/services/:id/image', ok((req) => svc.setImage(req.params.id, (req.body || {}).image, { sourceIp: req.ip })));
router.post('/services/:id/rollback', ok((req) => svc.rollback(req.params.id, { sourceIp: req.ip })));
router.post('/services/:id/resume-update', ok((req) => svc.resumeUpdate(req.params.id, { sourceIp: req.ip })));
router.post('/services/:id/restart', ok((req) => svc.restart(req.params.id, { sourceIp: req.ip })));
router.delete('/services/:id', ok((req) => svc.remove(req.params.id, { sourceIp: req.ip })));
router.get('/services/:id/tasks', ok(async (req) => ({ tasks: await svc.tasks(req.params.id) })));
router.get('/services/:id/logs', ok((req) => svc.logs(req.params.id, { tail: req.query.tail })));
router.get('/services/:id/progress', ok((req) => svc.progress(req.params.id)));
router.get('/services/:id/history', ok((req) => svc.history(req.params.id, req.query.hours)));
router.get('/services/:id/summary', ok((req) => svc.one(req.params.id)));
router.get('/services/:id/events', ok(async (req) => ({ events: await svc.events(req.params.id, req.query.hours) })));
router.get('/services/:id/audit', ok(async (req) => ({ audit: svc.auditOf((await svc.one(req.params.id)).name) })));
// Files of a task's container, on whichever node it runs (through that node's DockGate server).
const FE = require('../file-edit');
const onTask = (fn) => ok(async (req) => { const t = await svc.taskTarget(req.params.task); return fn(t, req); });
const auditTask = (req, t, action, details) => logAction({ req, server: t.serverId, resourceId: t.containerId, resourceType: 'container', resourceName: `task ${req.params.task.slice(0, 12)} @ ${t.node}`, action, details });
router.get('/tasks/:task/where', onTask(async (t) => ({ serverId: t.serverId, node: t.node, containerId: t.containerId })));
router.get('/tasks/:task/files', onTask((t, req) => FE.list(t.containerId, String(req.query.path || '/'), { client: t.client })));
router.get('/tasks/:task/text', onTask((t, req) => FE.read('container', t.containerId, String(req.query.path || ''), { client: t.client })));
router.put('/tasks/:task/text', onTask(async (t, req) => { const b = req.body || {}; const r = await FE.write('container', t.containerId, String(b.path || ''), b.content, { client: t.client }); auditTask(req, t, 'file-edit', { path: r.path, size: r.size }); return r; }));
router.post('/tasks/:task/mkdir', onTask(async (t, req) => { const r = await FE.mkdir('container', t.containerId, String((req.body || {}).path || ''), { client: t.client }); auditTask(req, t, 'file-mkdir', { path: r.path }); return r; }));
router.post('/tasks/:task/rename', onTask(async (t, req) => { const b = req.body || {}; const r = await FE.rename('container', t.containerId, String(b.path || ''), b.name, { client: t.client }); auditTask(req, t, 'file-rename', { path: b.path, to: r.path }); return r; }));
router.post('/tasks/:task/delete-path', onTask(async (t, req) => { const r = await FE.remove('container', t.containerId, String((req.body || {}).path || ''), { client: t.client }); auditTask(req, t, 'file-delete', { path: r.path }); return r; }));
router.get('/tasks/:task/file', async (req, res) => {
  try { const t = await svc.taskTarget(req.params.task); auditTask(req, t, 'file-download', { path: req.query.path }); await FE.download(t.containerId, String(req.query.path || ''), res, { client: t.client }); }
  catch (e) { if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.message }); }
});
router.post('/tasks/:task/upload', async (req, res) => {
  try { const t = await svc.taskTarget(req.params.task); await FE.upload(t.containerId, String(req.query.path || '/'), req, { client: t.client }); auditTask(req, t, 'cp-in', { path: req.query.path }); res.json({ success: true }); }
  catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});
// ---- phase 4: stacks and moving compose projects (server/swarm-stacks.js) ----
const stacks = require('../swarm-stacks');
const jobOf = (j) => ({ jobId: j.id });
router.get('/stacks', ok(async () => ({ stacks: await stacks.list() })));
router.get('/stacks/:name/history', ok(async (req) => ({ history: stacks.history(req.params.name) })));
router.get('/migrate', ok(() => stacks.candidates()));
router.post('/migrate/preview', ok((req) => stacks.preview(String((req.body || {}).project || ''), (req.body || {}).settings)));
router.post('/migrate', ok(async (req) => jobOf(await stacks.startMove((req.body || {}).plans, { sourceIp: req.ip }))));
router.post('/stacks/:name/redeploy', ok(async (req) => jobOf(await stacks.startRedeploy(req.params.name, { deployId: (req.body || {}).deployId, settings: (req.body || {}).settings, sourceIp: req.ip }))));
router.post('/stacks/:name/move-back', ok(async (req) => {
  if ((req.body || {}).confirm !== true) throw Object.assign(new Error('confirm required'), { statusCode: 400 });
  const row = stacks.stackRows().find(r => r.name === req.params.name);
  if (row && row.origin === 'container') return jobOf(await sy.startBackToContainer(req.params.name, { sourceIp: req.ip }));
  return jobOf(await stacks.startMoveBack(req.params.name, { sourceIp: req.ip }));
}));
// ---- stack files kept in DockGate, taking over outside stacks, docker run containers (server/swarm-yaml.js) ----
const sy = require('../swarm-yaml');
router.post('/stacks', ok(async (req) => jobOf(await sy.startDeploy({ ...(req.body || {}), create: true }, { sourceIp: req.ip }))));
router.post('/stacks/check', ok(async (req) => { const b = req.body || {}; const out = await sy.check(String(b.yaml || ''), sy.parseEnv(b.env)); return { ok: true, rendered: out }; }));
router.get('/stacks/:name/file', ok(async (req) => sy.getFile(req.params.name)));
router.put('/stacks/:name/file', ok(async (req) => jobOf(await sy.startDeploy({ ...(req.body || {}), name: req.params.name, create: false }, { sourceIp: req.ip }))));
router.get('/stacks/:name/written', ok(async (req) => ({ yaml: await sy.yamlFromStack(req.params.name) })));
router.post('/stacks/:name/take-over', ok((req) => sy.takeOver(req.params.name, req.body || {}, { sourceIp: req.ip })));
router.get('/containers', ok(async () => ({ containers: await sy.containers() })));
router.get('/containers/:id/stack-file', ok((req) => sy.yamlFromContainer(req.params.id)));
router.post('/containers/:id/move', ok(async (req) => jobOf(await sy.startConvert({ ...(req.body || {}), containerId: req.params.id }, { sourceIp: req.ip }))));
router.delete('/stacks/:name', ok((req) => stacks.removeStack(req.params.name, { sourceIp: req.ip })));
// ---- phase 5: secrets, configs, networks (server/swarm-objects.js) ----
const objs = require('../swarm-objects');
const kindOf = (k) => { if (!['secret', 'config'].includes(k)) throw Object.assign(new Error('kind must be secret or config'), { statusCode: 400 }); return k; };
router.get('/objects', ok(() => objs.list()));
router.post('/objects/:kind', ok((req) => objs.create(kindOf(req.params.kind), req.body || {}, { sourceIp: req.ip })));
router.get('/objects/config/:id/content', ok((req) => objs.configContent(req.params.id)));
router.post('/objects/:kind/:id/rotate', ok(async (req) => jobOf(await objs.startRotate(kindOf(req.params.kind), req.params.id, (req.body || {}).value, { sourceIp: req.ip }))));
router.delete('/objects/:kind/:id', ok((req) => objs.remove(kindOf(req.params.kind), req.params.id, { sourceIp: req.ip })));
router.get('/networks', ok(async () => ({ networks: await objs.networks() })));
router.post('/networks', ok((req) => objs.createNetwork(req.body || {}, { sourceIp: req.ip })));
router.delete('/networks/:id', ok((req) => objs.removeNetwork(req.params.id, { sourceIp: req.ip })));
router.post('/networks/ingress', ok((req) => {
  if ((req.body || {}).confirm !== true) throw Object.assign(new Error('confirm required'), { statusCode: 400 });
  return objs.changeIngress((req.body || {}).subnet, { sourceIp: req.ip });
}));
// ---- phase 7: backup and recovery (server/swarm-backup.js) ----
const bk = require('../swarm-backup');
router.get('/backups', ok(async () => ({ backups: bk.list(), nightly: bk.nightlyOn() })));
router.post('/backups', ok((req) => bk.backupNow({ reason: 'manual', sourceIp: req.ip })));
router.put('/backups/nightly', ok(async (req) => { bk.setNightly(!!(req.body || {}).on); logAction({ req, resourceType: 'swarm', resourceName: 'backup', action: 'swarm_backup_nightly', details: { on: !!(req.body || {}).on } }); return { nightly: bk.nightlyOn() }; }));
router.post('/backups/upload', ok((req) => bk.upload(req, { sourceIp: req.ip })));
router.get('/backups/:file/restore-plan', ok((req) => bk.restorePlan(req.params.file)));
router.post('/backups/:file/restore', ok(async (req) => jobOf(await bk.startRestore(req.params.file, { services: (req.body || {}).services, secrets: (req.body || {}).secrets }, { sourceIp: req.ip }))));
router.get('/backups/:file', (req, res) => {
  try {
    const p = bk.filePath(req.params.file);
    logAction({ req, resourceType: 'swarm', resourceName: req.params.file, action: 'swarm_backup_download' });
    res.download(p, req.params.file);
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});
router.get('/recovery', ok(() => bk.recoveryInfo()));
router.post('/recover', ok(async (req) => jobOf(await bk.startRecover({ confirm: (req.body || {}).confirm, sourceIp: req.ip }))));
// A short summary for the Dashboard: running / wanted tasks and ready nodes (no events).
router.get('/summary', ok(async () => {
  const st = await swarm.status();
  if (st.state !== 'active' || !st.manager) return { active: st.state === 'active', manager: st.manager, state: st.state };
  const c = dockerService.docker;
  try {
    const [services, nodes] = await Promise.all([c.listServices({ status: true }), c.listNodes()]);
    let running = 0, desired = 0;
    for (const s of services) if (s.ServiceStatus) { running += s.ServiceStatus.RunningTasks; desired += s.ServiceStatus.DesiredTasks; }
    return { active: true, manager: true, services: services.length, running, desired, nodes: nodes.length, ready: nodes.filter(n => n.Status.State === 'ready').length };
  } catch (e) { return { active: true, manager: true, quorumLost: true }; }
}));
router.get('/settings', async (req, res) => {
  try { res.json(await swarm.settings()); } catch (e) { fail(res, e); }
});
router.put('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await swarm.updateSettings({ autolock: b.autolock, certDays: b.certDays, taskHistory: b.taskHistory, heartbeatSec: b.heartbeatSec, snapshotInterval: b.snapshotInterval });
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'swarm', action: 'swarm_settings', details: { before: r.before, after: r.after } });
    res.json(r);
  } catch (e) { fail(res, e); }
});
// Join tokens (audited: a token lets a server into the swarm).
router.post('/join-tokens', async (req, res) => {
  try {
    const r = await swarm.joinTokens();
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'join tokens', action: 'swarm_join_tokens_shown' });
    res.json(r);
  } catch (e) { fail(res, e); }
});
router.post('/join-tokens/:role/rotate', async (req, res) => {
  try {
    const r = await swarm.rotateToken(req.params.role);
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: `${req.params.role} join token`, action: 'swarm_join_token_rotate' });
    res.json(r);
  } catch (e) { fail(res, e); }
});
// Root CA rotation and unlock key rotation (audited).
router.post('/ca/rotate', async (req, res) => {
  try {
    if (!(req.body || {}).confirm) return res.status(400).json({ error: 'confirm required' });
    const r = await swarm.rotateCA();
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'root CA', action: 'swarm_ca_rotate', details: r });
    res.json(r);
  } catch (e) { fail(res, e); }
});
router.post('/unlock-key/rotate', async (req, res) => {
  try {
    if (!(req.body || {}).confirm) return res.status(400).json({ error: 'confirm required' });
    const r = await swarm.rotateUnlockKey();
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'unlock key', action: 'swarm_unlock_key_rotate' });
    res.json(r);
  } catch (e) { fail(res, e); }
});
// Raw inspect JSON of a service, node or task.
router.get('/inspect/:kind/:id', ok(async (req) => {
  const c = dockerService.docker;
  const k = req.params.kind;
  if (k === 'service') return c.getService(req.params.id).inspect();
  if (k === 'node') return c.getNode(req.params.id).inspect();
  if (k === 'task') return c.getTask(req.params.id).inspect();
  throw Object.assign(new Error('kind must be service, node or task'), { statusCode: 400 });
}));
// Show the stored autolock key (audited).
router.post('/unlock-key', (req, res) => {
  try {
    const key = swarm.storedUnlockKey();
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'unlock key', action: 'swarm_unlock_key_shown' });
    res.json({ key });
  } catch (e) { fail(res, e); }
});
router.post('/unlock', async (req, res) => {
  try {
    await swarm.unlock((req.body || {}).key);
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'swarm', action: 'swarm_unlock' });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.post('/leave', async (req, res) => {
  try {
    if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'confirm required' });
    const r = await swarm.leave();
    logAction({ req, server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm', resourceName: 'swarm', action: 'swarm_leave', details: r });
    res.json(r);
  } catch (e) { fail(res, e); }
});

module.exports = router;
