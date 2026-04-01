const express = require('express');
const router = express.Router();
const { stmts } = require('../db');

// ============ FAVORITES ============
router.get('/favorites', (req, res) => {
  try {
    const type = req.query.type;
    const favs = type ? stmts.getFavoritesByType.all(type) : stmts.getFavorites.all();
    res.json(favs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/favorites', (req, res) => {
  try {
    const { id, type = 'container', name = '' } = req.body;
    stmts.addFavorite.run(id, type, name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/favorites/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    stmts.removeFavorite.run(req.params.id, type);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ NOTES ============
router.get('/notes', (req, res) => {
  try { res.json(stmts.getNotes.all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/notes/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    const note = stmts.getNote.get(req.params.id, type);
    res.json(note || { note: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notes', (req, res) => {
  try {
    const { id, type = 'container', note } = req.body;
    stmts.setNote.run(id, type, note);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/notes/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    stmts.deleteNote.run(req.params.id, type);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ TAGS ============
router.get('/tags', (req, res) => {
  try { res.json(stmts.getTags.all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tags/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    res.json(stmts.getTagsForResource.all(req.params.id, type));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tags', (req, res) => {
  try {
    const { id, type = 'container', tag, color = '#00d4aa' } = req.body;
    stmts.addTag.run(id, type, tag, color);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tags/:id/:tag', (req, res) => {
  try {
    const type = req.query.type || 'container';
    stmts.removeTag.run(req.params.id, type, req.params.tag);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ ACTIVITY ============
router.get('/activity', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json(stmts.getActivity.all(limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/activity', (req, res) => {
  try { stmts.clearActivity.run(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SETTINGS ============
router.get('/settings', (req, res) => {
  try {
    const settings = {};
    stmts.getSettings.all().forEach(s => { settings[s.key] = s.value; });
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings', (req, res) => {
  try {
    Object.entries(req.body).forEach(([key, value]) => {
      stmts.setSetting.run(key, String(value));
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SYSTEM AUTO-START ============
router.get('/autostart', async (req, res) => {
  try {
    const dockerService = require('../docker');
    const status = await dockerService.getAutoStartStatus();
    res.json({ enabled: status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/autostart', async (req, res) => {
  try {
    const dockerService = require('../docker');
    const enabled = req.body.enabled === true;
    const policy = await dockerService.setAutoStart(enabled);
    stmts.logActivity.run('', 'system', 'settings', 'autostart_toggle', JSON.stringify({ policy }));
    res.json({ success: true, policy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
