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

// V1 — download a gzipped tar of the volume's contents (helper container streams it)
router.get('/:name/backup', async (req, res) => {
  try {
    logAction({ req, resourceType: 'volume', resourceName: req.params.name, action: 'backup' });
    await dockerService.backupVolumeToResponse(req.params.name, res);
  } catch (err) {
    if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// V4 — clone the volume into a new one (helper container copies the data)
router.post('/:name/clone', async (req, res) => {
  try {
    const dest = (req.body || {}).dest;
    if (!dest) return res.status(400).json({ error: 'dest required' });
    const r = await dockerService.cloneVolume(req.params.name, dest);
    logAction({ req, resourceType: 'volume', resourceName: dest, action: 'clone', details: { from: req.params.name } });
    res.json(r);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
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
