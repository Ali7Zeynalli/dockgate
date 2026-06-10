const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listNetworks()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await dockerService.inspectNetwork(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createNetwork(req.body);
    logAction({ req, resourceId: result.id || '', resourceType: 'network', resourceName: req.body.Name || '', action: 'create' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dockerService.removeNetwork(req.params.id);
    logAction({ req, resourceId: req.params.id, resourceType: 'network', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Attach / detach a container to/from a network (membership is live; the network itself is immutable).
router.post('/:id/connect', async (req, res) => {
  try {
    const { container } = req.body || {};
    if (!container) return res.status(400).json({ error: 'container required' });
    await dockerService.connectNetwork(req.params.id, container);
    logAction({ req, resourceId: req.params.id, resourceType: 'network', resourceName: req.params.id.substring(0, 12), action: 'connect', details: { container } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/:id/disconnect', async (req, res) => {
  try {
    const { container, force } = req.body || {};
    if (!container) return res.status(400).json({ error: 'container required' });
    await dockerService.disconnectNetwork(req.params.id, container, force);
    logAction({ req, resourceId: req.params.id, resourceType: 'network', resourceName: req.params.id.substring(0, 12), action: 'disconnect', details: { container } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
