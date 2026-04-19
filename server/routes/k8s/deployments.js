const express = require('express');
const router = express.Router();
const k8sService = require('../../k8s');
const { stmts } = require('../../db');

router.use((req, res, next) => {
  if (!k8sService.isEnabled()) return res.status(400).json({ error: 'Kubernetes mode aktiv deyil' });
  next();
});

router.get('/', async (req, res) => {
  try { res.json(await k8sService.listDeployments(req.query.namespace || 'all')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:namespace/:name', async (req, res) => {
  try { res.json(await k8sService.inspectDeployment(req.params.namespace, req.params.name)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/:namespace/:name/scale', async (req, res) => {
  try {
    const { replicas } = req.body;
    if (replicas === undefined || isNaN(parseInt(replicas))) {
      return res.status(400).json({ error: 'replicas rəqəm olmalıdır' });
    }
    const result = await k8sService.scaleDeployment(req.params.namespace, req.params.name, replicas);
    stmts.logActivity.run(
      `${req.params.namespace}/${req.params.name}`, 'deployment',
      req.params.name, 'scale', JSON.stringify(result),
    );
    res.json(result);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/:namespace/:name/restart', async (req, res) => {
  try {
    const result = await k8sService.restartDeployment(req.params.namespace, req.params.name);
    stmts.logActivity.run(
      `${req.params.namespace}/${req.params.name}`, 'deployment',
      req.params.name, 'restart', JSON.stringify(result),
    );
    res.json(result);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/:namespace/:name', async (req, res) => {
  try {
    const result = await k8sService.deleteDeployment(req.params.namespace, req.params.name);
    stmts.logActivity.run(
      `${req.params.namespace}/${req.params.name}`, 'deployment',
      req.params.name, 'delete', '',
    );
    res.json(result);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
