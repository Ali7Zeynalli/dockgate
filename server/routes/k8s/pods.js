const express = require('express');
const router = express.Router();
const k8sService = require('../../k8s');
const { stmts } = require('../../db');

router.use((req, res, next) => {
  if (!k8sService.isEnabled()) return res.status(400).json({ error: 'Kubernetes mode aktiv deyil' });
  next();
});

router.get('/', async (req, res) => {
  try {
    const ns = req.query.namespace || 'all';
    res.json(await k8sService.listPods(ns));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:namespace/:name', async (req, res) => {
  try { res.json(await k8sService.inspectPod(req.params.namespace, req.params.name)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/:namespace/:name/logs', async (req, res) => {
  try {
    const logs = await k8sService.getPodLogs(req.params.namespace, req.params.name, {
      container: req.query.container,
      tail: parseInt(req.query.tail) || 200,
      timestamps: req.query.timestamps === 'true',
      previous: req.query.previous === 'true',
    });
    res.json({ logs });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/:namespace/:name', async (req, res) => {
  try {
    const grace = req.query.grace ? parseInt(req.query.grace) : 30;
    const result = await k8sService.deletePod(req.params.namespace, req.params.name, { grace });
    stmts.logActivity.run(
      `${req.params.namespace}/${req.params.name}`, 'pod',
      req.params.name, 'delete', JSON.stringify({ grace }),
    );
    res.json(result);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
