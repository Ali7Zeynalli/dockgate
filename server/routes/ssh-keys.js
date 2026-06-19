const express = require('express');
const router = express.Router();
const { stmts } = require('../db');
const { logAction } = require('../audit');
const sshKeys = require('../ssh-keys');

// GET / — list keys (private key is NEVER returned, only public + fingerprint)
router.get('/', (req, res) => {
  try { res.json(stmts.getSshKeys.all().map(sshKeys.mask)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /:id — one key (public only)
router.get('/:id', (req, res) => {
  const row = stmts.getSshKey.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'SSH key not found' });
  res.json(sshKeys.mask(row));
});

// POST / — generate a new keypair.  body: { name, description?, type? (ed25519|rsa) }
router.post('/', async (req, res) => {
  try {
    const { name, description, type } = req.body || {};
    const key = await sshKeys.generate({ name, description, type });
    logAction({ req, server: 'local', resourceType: 'ssh-key', resourceName: name, action: 'generate', details: { type: key.key_type } });
    res.json({ success: true, key });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// POST /import — import an existing private key.  body: { name, description?, privateKey }
router.post('/import', async (req, res) => {
  try {
    const { name, description, privateKey } = req.body || {};
    const key = await sshKeys.importKey({ name, description, privateKey });
    logAction({ req, server: 'local', resourceType: 'ssh-key', resourceName: name, action: 'import', details: { type: key.key_type } });
    res.json({ success: true, key });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// PUT /:id — rename / re-describe (key material is immutable).  body: { name?, description? }
router.put('/:id', (req, res) => {
  try {
    const row = stmts.getSshKey.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'SSH key not found' });
    const name = req.body && req.body.name !== undefined ? req.body.name : row.name;
    const description = req.body && req.body.description !== undefined ? req.body.description : row.description;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    stmts.renameSshKey.run(String(name).trim(), (String(description || '').trim()) || null, row.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/test — verify the key can authenticate to a repo (git ls-remote).  body: { repoUrl }
router.post('/:id/test', async (req, res) => {
  try {
    if (!stmts.getSshKey.get(req.params.id)) return res.status(404).json({ error: 'SSH key not found' });
    const r = await sshKeys.testAgainstRepo(req.params.id, (req.body || {}).repoUrl);
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  try {
    const row = stmts.getSshKey.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'SSH key not found' });
    stmts.deleteSshKey.run(req.params.id);
    logAction({ req, server: 'local', resourceType: 'ssh-key', resourceName: row.name, action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
