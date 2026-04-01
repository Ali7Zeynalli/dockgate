const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');

// List all containers
router.get('/', async (req, res) => {
  try {
    const all = req.query.all !== 'false';
    const containers = await dockerService.listContainers(all);
    // Enrich with metadata
    const enriched = containers.map(c => {
      const fav = stmts.isFavorite.get(c.id, 'container');
      const note = stmts.getNote.get(c.id, 'container');
      const tags = stmts.getTagsForResource.all(c.id, 'container');
      return { ...c, isFavorite: !!fav, note: note?.note || null, tags: tags.map(t => ({ tag: t.tag, color: t.color })) };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inspect container
router.get('/:id', async (req, res) => {
  try {
    const data = await dockerService.inspectContainer(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Container stats (one-shot)
router.get('/:id/stats', async (req, res) => {
  try {
    const stats = await dockerService.getContainerStats(req.params.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container logs
router.get('/:id/logs', async (req, res) => {
  try {
    const logs = await dockerService.getContainerLogs(req.params.id, {
      tail: parseInt(req.query.tail) || 200,
      timestamps: req.query.timestamps === 'true',
    });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container actions
router.post('/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const result = await dockerService.containerAction(id, action, req.body);
    // Log activity
    try {
      const info = await dockerService.inspectContainer(id);
      stmts.logActivity.run(id, 'container', info.Name?.replace(/^\//, '') || id.substring(0, 12), action, JSON.stringify(req.body));
    } catch (e) {
      stmts.logActivity.run(id, 'container', id.substring(0, 12), action, JSON.stringify(req.body));
    }
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Create container
router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createContainer(req.body);
    stmts.logActivity.run(result.id, 'container', req.body.name || result.id.substring(0, 12), 'create', JSON.stringify(req.body));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
