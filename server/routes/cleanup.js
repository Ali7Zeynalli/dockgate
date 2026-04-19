const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');

router.get('/preview', async (req, res) => {
  try { res.json(await dockerService.getCleanupPreview()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/containers', async (req, res) => {
  try {
    const result = await dockerService.pruneContainers();
    stmts.logActivity.run('', 'system', 'cleanup', 'prune_containers', JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/images', async (req, res) => {
  try {
    // Default: bütün unused image-lər silinsin (UI-dəki count ilə uyğun olsun)
    // ?dangling=true ötürülsə yalnız dangling silinir
    const dangling = req.query.dangling === 'true';
    const result = await dockerService.pruneImages(dangling);
    stmts.logActivity.run('', 'system', 'cleanup', 'prune_images', JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/volumes', async (req, res) => {
  try {
    const result = await dockerService.pruneVolumes();
    stmts.logActivity.run('', 'system', 'cleanup', 'prune_volumes', JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/networks', async (req, res) => {
  try {
    const result = await dockerService.pruneNetworks();
    stmts.logActivity.run('', 'system', 'cleanup', 'prune_networks', JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/build_cache', async (req, res) => {
  try {
    const result = await dockerService.pruneBuildCache();
    stmts.logActivity.run('', 'system', 'cleanup', 'prune_build_cache', JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/system', async (req, res) => {
  try {
    const includeVolumes = req.query.volumes === 'true';
    const result = await dockerService.systemPrune(includeVolumes);
    stmts.logActivity.run('', 'system', 'cleanup', 'system_prune', JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
