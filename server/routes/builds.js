/**
 * Build tarixçəsi və cache API route-ları
 * Niyə: Docker image build etmək, tarixçəni saxlamaq və cache idarə etmək
 * Modul: Builds route
 * İstifadə: server/index.js
 */
const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');

// Build cache siyahısı
router.get('/cache', async (req, res) => {
  try {
    const df = await dockerService.getDiskUsage();
    const cache = df.BuildCache || [];
    res.json(cache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build cache təmizlə
router.post('/cache/prune', async (req, res) => {
  try {
    const result = await dockerService.pruneBuildCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build tarixçəsi siyahısı
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const builds = stmts.getBuilds.all(limit);
    res.json(builds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tək build detalı
router.get('/:id', async (req, res) => {
  try {
    const build = stmts.getBuild.get(req.params.id);
    if (!build) return res.status(404).json({ error: 'Build tapılmadı' });
    res.json(build);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build sil
router.delete('/:id', async (req, res) => {
  try {
    stmts.deleteBuild.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bütün build tarixçəsini təmizlə
router.delete('/', async (req, res) => {
  try {
    stmts.clearBuilds.run();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
