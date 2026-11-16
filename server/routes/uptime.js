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
// Pause or resume every check (planned work on the whole site). body { paused, minutes? }
router.post('/pause-all', (req, res) => {
  const { paused, minutes } = req.body || {};
  const list = U.list().filter(c => (paused ? c.enabled : !c.enabled));
  for (const c of list) U.setPaused(c.id, !!paused, minutes);
  logAction({ req, resourceType: 'uptime', resourceName: 'all checks', action: paused ? 'uptime_pause_all' : 'uptime_resume_all', details: { count: list.length, minutes: minutes || null } });
  res.json({ success: true, count: list.length });
});
router.get('/suggest/proxies', async (req, res) => {
  try { res.json(await U.L.suggestions(U.list(), require('../docker').getActiveServerId())); } catch (e) { res.json([]); }
});
router.get('/:id', (req, res) => {
  const d = U.detail(req.params.id, RANGES[req.query.range] || U.DAY);
  if (!d) return res.status(404).json({ error: 'Check not found' });
  res.json(d);
});
// What the check is linked to, now (containers, state, last log lines), and restarting it.
router.get('/:id/context', async (req, res) => {
  const c = U.get(req.params.id); if (!c) return res.status(404).json({ error: 'Check not found' });
  if (!c.config.link) return res.json(null);
  res.json(await U.L.context(c.config.link, { lines: 40 }));
});
router.post('/:id/restart', async (req, res) => {
  const c = U.get(req.params.id); if (!c) return res.status(404).json({ error: 'Check not found' });
  if (!c.config.link) return res.status(400).json({ error: 'This check is not linked to a container' });
  try {
    const r = await U.L.restart(c.config.link);
    logAction({ req, server: c.config.link.server, resourceType: c.config.link.kind === 'swarm' ? 'service' : c.config.link.kind, resourceName: c.config.link.name, action: 'uptime_restart', details: { check: c.name, restarted: r.restarted } });
    res.json(r);
  } catch (e) { fail(res, e); }
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
  try { res.json(await U.runOne(c, { record: c.enabled, force: true })); } catch (e) { fail(res, e); }
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
