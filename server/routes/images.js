const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');

router.get('/', async (req, res) => {
  try {
    const images = await dockerService.listImages();
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await dockerService.inspectImage(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/pull', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Image name required' });
    const result = await dockerService.pullImage(image);
    stmts.logActivity.run('', 'image', image, 'pull', '');
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/tag', async (req, res) => {
  try {
    const { repo, tag } = req.body;
    await dockerService.tagImage(req.params.id, repo, tag);
    stmts.logActivity.run(req.params.id, 'image', `${repo}:${tag}`, 'tag', '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    await dockerService.removeImage(req.params.id, force);
    stmts.logActivity.run(req.params.id, 'image', req.params.id.substring(0, 12), 'remove', '');
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
