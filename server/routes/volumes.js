const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listVolumes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name', async (req, res) => {
  try { res.json(await dockerService.inspectVolume(req.params.name)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createVolume(req.body);
    logAction({ req, resourceId: req.body.Name || '', resourceType: 'volume', resourceName: req.body.Name || 'unnamed', action: 'create' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:name', async (req, res) => {
  try {
    await dockerService.removeVolume(req.params.name);
    logAction({ req, resourceId: req.params.name, resourceType: 'volume', resourceName: req.params.name, action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
