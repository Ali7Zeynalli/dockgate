const express = require('express');
const router = express.Router();
const dockerService = require('../docker');

router.get('/info', async (req, res) => {
  try { res.json(await dockerService.getSystemInfo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/version', async (req, res) => {
  try { res.json(await dockerService.getDockerVersion()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/df', async (req, res) => {
  try { res.json(await dockerService.getDiskUsage()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
