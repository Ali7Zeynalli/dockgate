const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listNetworks()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await dockerService.inspectNetwork(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createNetwork(req.body);
    stmts.logActivity.run(result.id || '', 'network', req.body.Name || '', 'create', '');
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dockerService.removeNetwork(req.params.id);
    stmts.logActivity.run(req.params.id, 'network', req.params.id.substring(0, 12), 'remove', '');
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
