const express = require('express');
const router = express.Router();
const dockerService = require('../docker');

router.get('/', async (req, res) => {
  try {
    const df = await dockerService.getDiskUsage();
    // BuildCache might be null if no cache exists
    const cache = df.BuildCache || [];
    // Sort by created or size initially
    res.json(cache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prune', async (req, res) => {
  try {
    const result = await dockerService.pruneBuildCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
