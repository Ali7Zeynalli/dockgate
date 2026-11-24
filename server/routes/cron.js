// Server Console > Cron API (server/cron.js). Mounted under /api/servers (behind requireAuth).
const express = require('express');
const router = express.Router();
const { stmts } = require('../db');
const { logAction } = require('../audit');
const cron = require('../cron');

function serverOf(req) {
  const row = stmts.getServer.get(req.params.id);
  if (!row) throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  if (row.id === 'local' || row.type === 'local') throw Object.assign(new Error('Cron is managed on remote servers (over SSH)'), { statusCode: 400 });
  return row;
}
const send = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || (/^[A-Z]/.test(e.message) ? 400 : 500)).json({ error: e.message, code: e.code }); }
};

// Everything scheduled on the server (DockGate's tasks, deploy recipes, cron, timers) - Local too.
router.get('/:id/scheduled', send(async (req) => {
  const id = req.params.id;
  if (id !== 'local' && !stmts.getServer.get(id)) throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  return require('../schedule-all').forServer(id);
}));
router.get('/:id/cron', send(async (req) => cron.read(serverOf(req))));
// body { source, op: { action, index, raw, entry }, preview }
router.post('/:id/cron/change', send(async (req) => {
  const s = serverOf(req);
  const { source, op, preview } = req.body || {};
  const r = await cron.change(s, source, op || {}, { preview: !!preview, serverId: s.id });
  if (!preview) logAction({ req, server: s.id, resourceType: 'cron', resourceName: (op && op.entry && op.entry.meta && op.entry.meta.name) || (op && op.raw) || source, action: `cron_${op && op.action}`, details: { source, schedule: op && op.entry && op.entry.schedule } });
  return r;
}));
// body { source, command, user }
router.post('/:id/cron/run', send(async (req) => {
  const s = serverOf(req);
  const { source, command, user } = req.body || {};
  if (!command) throw new Error('command is required');
  logAction({ req, server: s.id, resourceType: 'cron', resourceName: String(command).slice(0, 120), action: 'cron_run_now', details: { source, user } });
  return cron.runNow(s, source, command, user);
}));
// systemd timers: body { unit, action: enable | disable | run | logs }
router.post('/:id/cron/timer', send(async (req) => {
  const s = serverOf(req);
  const { unit, action } = req.body || {};
  const r = await cron.timerAction(s, unit, action);
  if (action !== 'logs') logAction({ req, server: s.id, resourceType: 'cron', resourceName: String(unit), action: `timer_${action}`, details: { ok: r.ok, code: r.code } });
  return r;
}));
// Next runs of a schedule typed in the form (server clock offset in minutes).
router.post('/:id/cron/next', send(async (req) => {
  const C = require('../cron-parse');
  const { schedule, offsetMin } = req.body || {};
  return { next: C.nextRuns(schedule, Date.now(), Number(offsetMin) || 0, 5), human: C.describe(schedule) };
}));
router.get('/:id/cron/versions', send(async (req) => {
  const s = serverOf(req);
  return require('../file-versions').list(s.id, `cron:${String(req.query.source || '')}`);
}));

module.exports = router;
