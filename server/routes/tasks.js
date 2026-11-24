// Deploy > Tasks API (server/tasks.js, task-recipes.js) - the SSH server picked in the top bar. Mounted at /api/tasks.
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
// ---------- env files of the folder (task-envfiles.js) ----------
const EF = require('../task-envfiles');
router.get('/env-files', send(async (req) => { const s = T.server(sid()); const d = T.okDir(req.query.dir); const r = await EF.discover(T, s, d); return { ...r, loaded: EF.loaded(s.id, d), dockgate: T.envList(sid(), d).map(e => e.key) }; }));
router.get('/env-files/values', send(async (req) => { const s = T.server(sid()); const d = T.okDir(req.query.dir); const r = await EF.values(T, s, d, req.query.file); logAction({ req, resourceType: 'task', resourceName: d, action: 'env_file_view', details: { file: r.file } }); return r; }));
router.put('/env-files', send(async (req) => { const s = T.server(sid()); const d = T.okDir(req.body.dir); const list = EF.setLoaded(s.id, d, req.body.load); logAction({ req, resourceType: 'task', resourceName: d, action: 'env_files_load', details: { files: list } }); return { loaded: list }; }));
router.post('/env-files/import', send(async (req) => {
  const s = T.server(sid()); const d = T.okDir(req.body.dir);
  const r = await EF.values(T, s, d, req.body.file);
  const want = new Set(Array.isArray(req.body.keys) ? req.body.keys : r.vars.map(v => v.key));
  const items = r.vars.filter(v => want.has(v.key) && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v.key)).map(v => ({ key: v.key, value: v.value, secret: v.secret }));
  const env = T.envSet(sid(), d, items);
  logAction({ req, resourceType: 'task', resourceName: d, action: 'env_import', details: { file: r.file, keys: items.map(i => i.key) } });
  return { imported: items.length, skipped: want.size - items.length, env };
}));
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
// mode: (none) -> 409 when it runs already, 'queue' -> after the running one, 'replace' -> cancel the running one, then this
router.post('/recipes/:id/run', send(async (req) => { const m = (req.body || {}).mode; return R.run(req.params.id, { trigger: 'manual', by: req.ip, req, mode: m === 'queue' || m === 'replace' ? m : null }); }));
// the webhook / CI token of a recipe
router.post('/recipes/:id/hook', send(async (req) => { const r = R.enableHook(req.params.id); logAction({ req, resourceType: 'task', action: 'recipe_hook_on', details: { recipe: Number(req.params.id) } }); return r; }));
router.delete('/recipes/:id/hook', send(async (req) => { const r = R.disableHook(req.params.id); logAction({ req, resourceType: 'task', action: 'recipe_hook_off', details: { recipe: Number(req.params.id) } }); return r; }));
router.get('/recipes/:id/hook', send(async (req) => R.hookSecret(req.params.id)));
router.put('/recipes/:id/status-token', send(async (req) => { const r = R.setStatusToken(req.params.id, req.body.token); logAction({ req, resourceType: 'task', action: 'recipe_status_token', details: { recipe: Number(req.params.id), set: !!req.body.token } }); return r; }));

module.exports = router;
