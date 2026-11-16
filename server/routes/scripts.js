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
const send = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.current != null ? { current: e.current } : {}) }); } };
const audit = (req, s, action, details) => logAction({ req, server: s.id, resourceType: 'script', resourceName: (details && details.name) || '', action, details });

router.get('/:id/scripts', send(async (req) => ({ scripts: S.list(serverOf(req).id), blocks: B.BLOCKS, templates: B.TEMPLATES })));
// The script text for the steps in the form (nothing saved).
router.post('/:id/scripts/preview', send(async (req) => { serverOf(req); return { text: B.build(req.body || {}) }; }));
// One block as shell for your own script (nothing saved).
router.post('/:id/scripts/snippet', send(async (req) => { serverOf(req); return { text: B.snippet(req.body || {}) }; }));
// Shell scripts on the server not in the list yet.
router.get('/:id/scripts/discover', send(async (req) => ({ files: await S.discover(serverOf(req)) })));
// body { path, name?, title? } — add a script that is on the server already (it stays where it is).
router.post('/:id/scripts/existing', send(async (req) => { const s = serverOf(req); const r = await S.addExisting(s, req.body || {}); audit(req, s, 'script_add_existing', { name: r.name, path: r.path }); return r; }));
// body { name, title, code } — your own shell.
router.post('/:id/scripts/code', send(async (req) => { const s = serverOf(req); const r = await S.createCode(s, req.body || {}); audit(req, s, 'script_create', { name: r.name, path: r.path, kind: 'code' }); return r; }));
router.post('/:id/scripts/:sid/to-code', send(async (req) => { const s = serverOf(req); const r = S.toCode(s, req.params.sid); audit(req, s, 'script_to_code', { name: r.name }); return r; }));
router.put('/:id/scripts/:sid/title', send(async (req) => { const s = serverOf(req); return S.setTitle(s, req.params.sid, (req.body || {}).title); }));
router.post('/:id/scripts', send(async (req) => { const s = serverOf(req); const r = await S.save(s, req.body || {}); audit(req, s, 'script_create', { name: r.name, path: r.path }); return r; }));
router.put('/:id/scripts/:sid', send(async (req) => { const s = serverOf(req); const r = await S.save(s, req.body || {}, req.params.sid, { force: !!(req.query.force === '1') }); audit(req, s, 'script_update', { name: r.name, path: r.path }); return r; }));
router.delete('/:id/scripts/:sid', send(async (req) => { const s = serverOf(req); const r = await S.remove(s, req.params.sid); audit(req, s, 'script_delete', { name: r.name }); return { success: true }; }));
router.post('/:id/scripts/:sid/run', send(async (req) => { const s = serverOf(req); const sc = S.get(s.id, req.params.sid); audit(req, s, 'script_run', { name: sc && sc.name }); return S.run(s, req.params.sid); }));
// body { schedule, notify[], log }
router.post('/:id/scripts/:sid/schedule', send(async (req) => { const s = serverOf(req); const sc = S.get(s.id, req.params.sid); await S.schedule(s, req.params.sid, req.body || {}); audit(req, s, 'script_schedule', { name: sc && sc.name, schedule: (req.body || {}).schedule }); return { success: true }; }));

module.exports = router;
