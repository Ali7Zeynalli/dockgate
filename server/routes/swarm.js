const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

// Every endpoint except GET / requires the active daemon to be a swarm manager.
async function assertSwarm() {
  const info = await dockerService.getSwarmInfo();
  if (!info.active) {
    const e = new Error('The active host is not in Swarm mode. Run "docker swarm init" on it first.');
    e.statusCode = 400;
    throw e;
  }
}

// GET /api/swarm — swarm state (used by the UI to gate the Swarm page)
router.get('/', async (req, res) => {
  try { res.json(await dockerService.getSwarmInfo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Services ----
router.get('/services', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listServices()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Create a new service (SW-a)
router.post('/services', async (req, res) => {
  try {
    await assertSwarm();
    const b = req.body || {};
    if (!b.name || !b.image) return res.status(400).json({ error: 'name and image are required' });
    const r = await dockerService.createService(b);
    logAction({ req, resourceType: 'service', resourceName: b.name, action: 'create', details: { image: b.image } });
    res.json(r);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/services/:id', async (req, res) => {
  try { res.json(await dockerService.inspectService(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/services/:id/tasks', async (req, res) => {
  try { res.json(await dockerService.listServiceTasks(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Aggregated service logs (SW-a)
router.get('/services/:id/logs', async (req, res) => {
  try { res.json({ logs: await dockerService.getServiceLogs(req.params.id, parseInt(req.query.tail) || 200) }); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Rolling image update (SW-a)
router.post('/services/:id/update', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image required' });
    await dockerService.updateServiceImage(req.params.id, image);
    logAction({ req, resourceType: 'service', resourceName: req.params.id.substring(0, 12), action: 'update', details: { image } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/services/:id/scale', async (req, res) => {
  try {
    const { replicas } = req.body || {};
    if (replicas === undefined || replicas === '') return res.status(400).json({ error: 'replicas required' });
    await dockerService.scaleService(req.params.id, replicas);
    logAction({ req, resourceType: 'service', resourceName: req.params.id.substring(0, 12), action: 'scale', details: { replicas } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/services/:id', async (req, res) => {
  try {
    await dockerService.removeService(req.params.id);
    logAction({ req, resourceType: 'service', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ---- Nodes ----
router.get('/nodes', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listNodes()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/nodes/:id/availability', async (req, res) => {
  try {
    const { availability } = req.body || {};
    if (!['active', 'pause', 'drain'].includes(availability)) return res.status(400).json({ error: 'availability must be active | pause | drain' });
    await dockerService.updateNodeAvailability(req.params.id, availability);
    logAction({ req, resourceType: 'node', resourceName: req.params.id.substring(0, 12), action: 'availability', details: { availability } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
