const express = require('express');
const router = express.Router();
const k8sService = require('../../k8s');

router.use((req, res, next) => {
  if (!k8sService.isEnabled()) return res.status(400).json({ error: 'Kubernetes mode aktiv deyil' });
  next();
});

router.get('/', async (req, res) => {
  try { res.json(await k8sService.listNodes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
