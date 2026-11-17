// Deploy → Tasks API (server/tasks.js, task-recipes.js) — the SSH server picked in the top bar. Mounted at /api/tasks.
const express = require('express');
const router = express.Router();
const T = require('../tasks');

const send = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(e.statusCode || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.run ? { run: e.run } : {}) }); }
};
const sid = () => require('../docker').getActiveServerId();

router.get('/projects', send(async () => ({ server: sid(), projects: await T.projects(sid()) })));
router.post('/projects', send(async (req) => T.addProject(sid(), req.body.dir, req.body.name)));
router.delete('/projects', send(async (req) => T.removeProject(sid(), req.query.dir)));
router.get('/discover', send(async (req) => T.discover(sid(), req.query.dir)));
// body { dir, source, name, vars, args, dry, runAs, timeoutMin } | { dir, source: 'custom', cmd, label }
router.post('/run', send(async (req) => { const b = req.body || {}; return T.start(sid(), b.dir, b, { trigger: 'manual', by: req.ip, req }); }));
router.post('/runs/:id/cancel', send(async (req) => T.cancel(req.params.id)));
router.get('/runs', send(async (req) => ({ runs: T.runs(sid(), req.query.dir, req.query.limit) })));
router.get('/runs/:id', send(async (req) => T.runLog(req.params.id, req.query.from)));
router.get('/env', send(async (req) => ({ env: T.envList(sid(), req.query.dir) })));
router.put('/env', send(async (req) => { const r = T.envSet(sid(), req.body.dir, req.body.items); require('../audit').logAction({ req, resourceType: 'task', resourceName: req.body.dir, action: 'task_env', details: { keys: (req.body.items || []).map(i => i.key + (i.remove ? ' (removed)' : '')) } }); return { env: r }; }));
router.get('/kamal-versions', send(async (req) => T.kamalVersions(sid(), req.query.dir)));
router.get('/templates', send(async () => ({ templates: Object.entries(T.TEMPLATES).map(([name, t]) => ({ name, file: t.file, text: t.text })) })));
router.post('/templates', send(async (req) => T.addTemplate(sid(), req.body.dir, req.body.name, { overwrite: !!req.body.overwrite })));

// ---------- recipes (task-recipes.js) ----------
const R = require('../task-recipes');
const { logAction } = require('../audit');
router.get('/recipes', send(async (req) => ({ recipes: R.list(sid(), req.query.dir), kinds: R.KINDS })));
router.post('/recipes', send(async (req) => { const r = R.save(sid(), req.body.dir, req.body); logAction({ req, resourceType: 'task', resourceName: req.body.dir, action: 'recipe_create', details: { recipe: r.name } }); return r; }));
router.put('/recipes/:id', send(async (req) => { const r = R.save(sid(), req.body.dir, req.body, req.params.id); logAction({ req, resourceType: 'task', resourceName: req.body.dir, action: 'recipe_edit', details: { recipe: r.name } }); return r; }));
router.delete('/recipes/:id', send(async (req) => { const r = R.get(req.params.id); R.remove(r.id); logAction({ req, resourceType: 'task', resourceName: r.dir, action: 'recipe_delete', details: { recipe: r.name } }); return { ok: true }; }));
// mode: (none) → 409 when it runs already · 'queue' → after the running one · 'replace' → cancel the running one, then this
router.post('/recipes/:id/run', send(async (req) => { const m = (req.body || {}).mode; return R.run(req.params.id, { trigger: 'manual', by: req.ip, req, mode: m === 'queue' || m === 'replace' ? m : null }); }));
// the webhook / CI token of a recipe
router.post('/recipes/:id/hook', send(async (req) => { const r = R.enableHook(req.params.id); logAction({ req, resourceType: 'task', action: 'recipe_hook_on', details: { recipe: Number(req.params.id) } }); return r; }));
router.delete('/recipes/:id/hook', send(async (req) => { const r = R.disableHook(req.params.id); logAction({ req, resourceType: 'task', action: 'recipe_hook_off', details: { recipe: Number(req.params.id) } }); return r; }));
router.get('/recipes/:id/hook', send(async (req) => R.hookSecret(req.params.id)));
router.put('/recipes/:id/status-token', send(async (req) => { const r = R.setStatusToken(req.params.id, req.body.token); logAction({ req, resourceType: 'task', action: 'recipe_status_token', details: { recipe: Number(req.params.id), set: !!req.body.token } }); return r; }));

module.exports = router;
