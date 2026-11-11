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
router.post('/services', ok((req) => svc.create((req.body || {}).form || {}, { sourceIp: req.ip })));
router.get('/services/:id', ok((req) => svc.get(req.params.id)));
router.put('/services/:id', ok((req) => svc.save(req.params.id, (req.body || {}).form || {}, { sourceIp: req.ip, version: (req.body || {}).version })));
router.post('/services/:id/scale', ok((req) => svc.scale(req.params.id, (req.body || {}).replicas, { sourceIp: req.ip, confirmDb: !!(req.body || {}).confirmDb })));
router.post('/services/:id/image', ok((req) => svc.setImage(req.params.id, (req.body || {}).image, { sourceIp: req.ip })));
router.post('/services/:id/rollback', ok((req) => svc.rollback(req.params.id, { sourceIp: req.ip })));
router.post('/services/:id/restart', ok((req) => svc.restart(req.params.id, { sourceIp: req.ip })));
router.delete('/services/:id', ok((req) => svc.remove(req.params.id, { sourceIp: req.ip })));
router.get('/services/:id/tasks', ok(async (req) => ({ tasks: await svc.tasks(req.params.id) })));
router.get('/services/:id/logs', ok((req) => svc.logs(req.params.id, { tail: req.query.tail })));
router.get('/services/:id/progress', ok((req) => svc.progress(req.params.id)));
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
  return jobOf(await stacks.startMoveBack(req.params.name, { sourceIp: req.ip }));
}));
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
router.get('/backups/:file', (req, res) => {
  try {
    const p = bk.filePath(req.params.file);
    logAction({ req, resourceType: 'swarm', resourceName: req.params.file, action: 'swarm_backup_download' });
    res.download(p, req.params.file);
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});
router.get('/recovery', ok(() => bk.recoveryInfo()));
router.post('/recover', ok(async (req) => jobOf(await bk.startRecover({ confirm: (req.body || {}).confirm, sourceIp: req.ip }))));
router.get('/settings', async (req, res) => {
  try { res.json(await swarm.settings()); } catch (e) { fail(res, e); }
});
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
