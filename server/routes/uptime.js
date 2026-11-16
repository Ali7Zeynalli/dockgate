// Observe → Uptime API (server/uptime.js).
const express = require('express');
const router = express.Router();
const U = require('../uptime');
const P = require('../uptime-probe');
const { logAction } = require('../audit');

const RANGES = { '24h': U.DAY, '7d': 7 * U.DAY, '30d': 30 * U.DAY, '90d': 90 * U.DAY };
const fail = (res, e) => res.status(e.statusCode || (/^[A-Z][a-z]/.test(e.message) ? 400 : 500)).json({ error: e.message });

router.get('/', (req, res) => {
  try { const now = Date.now(); res.json(U.list().map(c => U.summary(c, now))); } catch (e) { fail(res, e); }
});
router.get('/:id', (req, res) => {
  const d = U.detail(req.params.id, RANGES[req.query.range] || U.DAY);
  if (!d) return res.status(404).json({ error: 'Check not found' });
  res.json(d);
});
// Try settings without saving them.
router.post('/test', async (req, res) => {
  try { const v = P.normalize(req.body || {}); res.json(await P.probe(v)); } catch (e) { fail(res, e); }
});
router.post('/', async (req, res) => {
  try {
    const c = U.create(req.body || {});
    logAction({ req, resourceType: 'uptime', resourceName: c.name, action: 'uptime_create', details: { type: c.type, target: c.target } });
    U.runOne(c).catch(() => {});
    res.json(c);
  } catch (e) { fail(res, e); }
});
router.put('/:id', (req, res) => {
  try { const c = U.update(req.params.id, req.body || {}); logAction({ req, resourceType: 'uptime', resourceName: c.name, action: 'uptime_update', details: { type: c.type, target: c.target } }); res.json(c); }
  catch (e) { fail(res, e); }
});
router.delete('/:id', (req, res) => {
  const c = U.get(req.params.id); if (!c) return res.status(404).json({ error: 'Check not found' });
  U.remove(c.id);
  logAction({ req, resourceType: 'uptime', resourceName: c.name, action: 'uptime_delete' });
  res.json({ success: true });
});
router.post('/:id/check', async (req, res) => {
  const c = U.get(req.params.id); if (!c) return res.status(404).json({ error: 'Check not found' });
  try { res.json(await U.runOne(c, { record: c.enabled })); } catch (e) { fail(res, e); }
});
// body { paused: true|false, minutes? }
router.post('/:id/pause', (req, res) => {
  const c = U.get(req.params.id); if (!c) return res.status(404).json({ error: 'Check not found' });
  const { paused, minutes } = req.body || {};
  const r = U.setPaused(c.id, !!paused, minutes);
  logAction({ req, resourceType: 'uptime', resourceName: c.name, action: paused ? 'uptime_pause' : 'uptime_resume', details: { minutes: minutes || null } });
  res.json(r);
});

module.exports = router;
