const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

router.get('/preview', async (req, res) => {
  try { res.json(await dockerService.getCleanupPreview()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/containers', async (req, res) => {
  try {
    const result = await dockerService.pruneContainers();
    logAction({ req, resourceType: 'system', resourceName: 'cleanup', action: 'prune_containers', details: result });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/images', async (req, res) => {
  try {
    // Default: bütün unused image-lər silinsin (UI-dəki count ilə uyğun olsun)
    // if ?dangling=true is passed, only dangling images are removed
    const dangling = req.query.dangling === 'true';
    const result = await dockerService.pruneImages(dangling);
    logAction({ req, resourceType: 'system', resourceName: 'cleanup', action: 'prune_images', details: result });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/volumes', async (req, res) => {
  try {
    const result = await dockerService.pruneVolumes();
    logAction({ req, resourceType: 'system', resourceName: 'cleanup', action: 'prune_volumes', details: result });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/networks', async (req, res) => {
  try {
    const result = await dockerService.pruneNetworks();
    logAction({ req, resourceType: 'system', resourceName: 'cleanup', action: 'prune_networks', details: result });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/build_cache', async (req, res) => {
  try {
    const result = await dockerService.pruneBuildCache();
    logAction({ req, resourceType: 'system', resourceName: 'cleanup', action: 'prune_build_cache', details: result });
    res.json(result);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/system', async (req, res) => {
  try {
    const includeVolumes = req.query.volumes === 'true';
    const result = await dockerService.systemPrune(includeVolumes);
    logAction({ req, resourceType: 'system', resourceName: 'cleanup', action: 'system_prune', details: result });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
