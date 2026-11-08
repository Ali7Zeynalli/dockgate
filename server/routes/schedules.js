// /api/schedules — Tools → Schedules (server/schedules.js).
const express = require('express');
const router = express.Router();
const S = require('../schedules');
const { stmts } = require('../db');
const { logAction } = require('../audit');

const fail = (res, e) => res.status(e.statusCode || 500).json({ error: e.message });
const view = (s) => ({ ...s, params: JSON.parse(s.params || '{}'), running: S.isRunning(s.id) });

router.get('/', (req, res) => {
  try {
    const servers = [{ id: 'local', name: 'Local' }, ...stmts.getServers.all().filter(x => x.id !== 'local').map(x => ({ id: x.id, name: x.name || x.id }))];
    res.json({ schedules: S.q.all.all().map(view), servers, timezone: S.timezone() });
  } catch (e) { fail(res, e); }
});

router.post('/', (req, res) => {
  try {
    const v = S.validate(req.body || {});
    const id = S.q.insert.run({ ...v, next_run_at: v.enabled ? S.nextRun(v) : null, created_at: Date.now() }).lastInsertRowid;
    logAction({ req, server: v.server_id, resourceType: 'schedule', resourceName: v.name, action: 'schedule_create', details: { kind: v.kind, freq: v.freq, at: v.at } });
    res.json(view(S.q.get.get(id)));
  } catch (e) { fail(res, e); }
});

router.put('/:id', (req, res) => {
  try {
    const cur = S.q.get.get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Task not found' });
    const body = req.body || {};
    if (Object.keys(body).length === 1 && body.enabled !== undefined) { // the On switch
      const on = body.enabled ? 1 : 0;
      S.q.setEnabled.run(on, on ? S.nextRun(cur) : null, cur.id);
    } else {
      const v = S.validate({ ...cur, params: JSON.parse(cur.params || '{}'), enabled: !!cur.enabled, ...body });
      S.q.update.run({ ...v, id: cur.id, next_run_at: v.enabled ? S.nextRun(v) : null });
    }
    logAction({ req, server: cur.server_id, resourceType: 'schedule', resourceName: cur.name, action: 'schedule_update', details: body });
    res.json(view(S.q.get.get(cur.id)));
  } catch (e) { fail(res, e); }
});

router.delete('/:id', (req, res) => {
  try {
    const cur = S.q.get.get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Task not found' });
    S.q.del.run(cur.id);
    logAction({ req, server: cur.server_id, resourceType: 'schedule', resourceName: cur.name, action: 'schedule_delete' });
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// POST /api/schedules/:id/run — run now, wait for the result (prune and backups take seconds to minutes).
router.post('/:id/run', async (req, res) => {
  try { res.json(view(await S.runOne(Number(req.params.id), { manual: true }))); }
  catch (e) { fail(res, e); }
});

module.exports = router;
