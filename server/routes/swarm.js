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
