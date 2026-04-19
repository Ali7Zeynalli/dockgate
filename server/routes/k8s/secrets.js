const express = require('express');
const router = express.Router();
const k8sService = require('../../k8s');

router.use((req, res, next) => {
  if (!k8sService.isEnabled()) return res.status(400).json({ error: 'Kubernetes mode aktiv deyil' });
  next();
});

router.get('/', async (req, res) => {
  try { res.json(await k8sService.listSecrets(req.query.namespace || 'all')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:namespace/:name', async (req, res) => {
  try {
    const reveal = req.query.reveal === 'true';
    res.json(await k8sService.getSecret(req.params.namespace, req.params.name, { reveal }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
