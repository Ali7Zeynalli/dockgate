const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listVolumes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name', async (req, res) => {
  try { res.json(await dockerService.inspectVolume(req.params.name)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createVolume(req.body);
    stmts.logActivity.run(req.body.Name || '', 'volume', req.body.Name || 'unnamed', 'create', '');
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:name', async (req, res) => {
  try {
    await dockerService.removeVolume(req.params.name);
    stmts.logActivity.run(req.params.name, 'volume', req.params.name, 'remove', '');
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
