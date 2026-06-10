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

// GET /search?q= — proxy Docker Hub image search (browser CORS blocks calling Hub directly).
// Defined before "/:id" so "search" isn't captured as an image id. Returns normalized results.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ count: 0, results: [] });
    const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(q)}&page_size=25`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).json({ error: `Docker Hub HTTP ${r.status}` });
    const data = await r.json();
    const results = (data.results || []).map(x => ({
      name: x.repo_name,
      description: x.short_description || '',
      stars: x.star_count || 0,
      official: !!x.is_official,
    }));
    res.json({ count: data.count || results.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
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

// GET /:id/history — image layer history (each layer's command + size)
router.get('/:id/history', async (req, res) => {
  try {
    res.json(await dockerService.imageHistory(req.params.id));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /:id/save — download the image as a tar (docker save) — I2
router.get('/:id/save', async (req, res) => {
  try {
    const stream = await dockerService.imageSaveStream(req.params.id);
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)}.tar"`);
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
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

// POST /load — load images from an uploaded tar (docker load) — I2.
// The body is the raw tar stream (Content-Type isn't application/json, so it bypasses express.json).
router.post('/load', async (req, res) => {
  try {
    const result = await dockerService.loadImage(req);
    logAction({ req, resourceType: 'image', resourceName: '(loaded)', action: 'load' });
    res.json({ success: true, output: result.output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /untag — remove a specific repo:tag reference (handles namespaced tags with slashes,
// which a DELETE /:id path can't carry). Removes just the tag if the image has others.
router.post('/untag', async (req, res) => {
  try {
    const { tag } = req.body || {};
    if (!tag) return res.status(400).json({ error: 'tag required' });
    await dockerService.removeImage(tag, false);
    logAction({ req, resourceType: 'image', resourceName: tag, action: 'untag' });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
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
