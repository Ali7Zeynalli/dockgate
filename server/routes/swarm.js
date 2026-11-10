// /api/swarm — Docker Swarm on the server in use (server/swarm.js).
const express = require('express');
const router = express.Router();
const swarm = require('../swarm');
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
  try { res.json(await swarm.overview()); } catch (e) { fail(res, e); }
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
