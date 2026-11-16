// Server Console → Scripts API (server/scripts.js, server/script-builder.js). Mounted under /api/servers.
const express = require('express');
const router = express.Router();
const { stmts } = require('../db');
const { logAction } = require('../audit');
const S = require('../scripts');
const B = require('../script-builder');

function serverOf(req) {
  const row = stmts.getServer.get(req.params.id);
  if (!row) throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  if (row.id === 'local' || row.type === 'local') throw Object.assign(new Error('Scripts run on remote servers (over SSH)'), { statusCode: 400 });
  return row;
}
const send = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); } };
const audit = (req, s, action, details) => logAction({ req, server: s.id, resourceType: 'script', resourceName: (details && details.name) || '', action, details });

router.get('/:id/scripts', send(async (req) => ({ scripts: S.list(serverOf(req).id), blocks: B.BLOCKS, templates: B.TEMPLATES })));
// The script text for the steps in the form (nothing saved).
router.post('/:id/scripts/preview', send(async (req) => { serverOf(req); return { text: B.build(req.body || {}) }; }));
router.post('/:id/scripts', send(async (req) => { const s = serverOf(req); const r = await S.save(s, req.body || {}); audit(req, s, 'script_create', { name: r.name, path: r.path }); return r; }));
router.put('/:id/scripts/:sid', send(async (req) => { const s = serverOf(req); const r = await S.save(s, req.body || {}, req.params.sid); audit(req, s, 'script_update', { name: r.name, path: r.path }); return r; }));
router.delete('/:id/scripts/:sid', send(async (req) => { const s = serverOf(req); const r = await S.remove(s, req.params.sid); audit(req, s, 'script_delete', { name: r.name }); return { success: true }; }));
router.post('/:id/scripts/:sid/run', send(async (req) => { const s = serverOf(req); const sc = S.get(s.id, req.params.sid); audit(req, s, 'script_run', { name: sc && sc.name }); return S.run(s, req.params.sid); }));
// body { schedule, notify[], log }
router.post('/:id/scripts/:sid/schedule', send(async (req) => { const s = serverOf(req); const sc = S.get(s.id, req.params.sid); await S.schedule(s, req.params.sid, req.body || {}); audit(req, s, 'script_schedule', { name: sc && sc.name, schedule: (req.body || {}).schedule }); return { success: true }; }));

module.exports = router;
