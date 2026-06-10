const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

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
    logAction({ req, resourceType: 'image', resourceName: image, action: 'pull' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/tag', async (req, res) => {
  try {
    const { repo, tag } = req.body;
    await dockerService.tagImage(req.params.id, repo, tag);
    logAction({ req, resourceId: req.params.id, resourceType: 'image', resourceName: `${repo}:${tag}`, action: 'tag' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push — push a local image to its registry. The credential is auto-matched by registry host
// (see docker.pushImage). repoTag is taken from the body so registry/owner slashes are preserved.
// body: { repoTag }  e.g. "ghcr.io/owner/app:1.0"
router.post('/push', async (req, res) => {
  try {
    const { repoTag } = req.body || {};
    if (!repoTag) return res.status(400).json({ error: 'repoTag required' });
    const result = await dockerService.pushImage(repoTag);
    logAction({ req, resourceType: 'image', resourceName: repoTag, action: 'push' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    await dockerService.removeImage(req.params.id, force);
    logAction({ req, resourceId: req.params.id, resourceType: 'image', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
