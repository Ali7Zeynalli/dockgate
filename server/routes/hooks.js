// Open webhooks (no session): mounted at /api/hooks BEFORE the auth gate in index.js. Each request is checked
// against the secret of what it targets (task-hooks.verify) — a wrong or missing signature gets 401.
//   POST /api/hooks/deploy/:hookId   GitHub · GitLab · Bitbucket Cloud / Server · Gitea · CI (Authorization: Bearer <secret>)
const express = require('express');
const router = express.Router();
const H = require('../task-hooks');
const { logAction } = require('../audit');

// GitHub can send "application/x-www-form-urlencoded" (payload=…): keep the raw body for the signature there too
router.use(express.urlencoded({ extended: false, limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

router.post('/deploy/:hookId', async (req, res) => {
  const R = require('../task-recipes');
  const t = /^[a-f0-9]{24}$/.test(req.params.hookId) ? R.hookTarget(req.params.hookId) : null;
  if (!t) return res.status(404).json({ error: 'not found' });
  const v = H.verify(req.headers, req.rawBody || Buffer.from(''), t.secret);
  if (!v.ok) { logAction({ req, server: t.recipe.serverId, resourceType: 'task', resourceName: t.recipe.dir, action: 'hook_refused', details: { recipe: t.recipe.name, provider: v.provider } }); return res.status(401).json({ error: 'bad signature or token' }); }
  let body = req.body || {};
  if (typeof body.payload === 'string') { try { body = JSON.parse(body.payload); } catch (e) { return res.status(400).json({ error: 'payload is not JSON' }); } }
  const g = H.parse(v.provider, v.event, body);
  if (g.ping) return res.json({ ok: true, pong: true, recipe: t.recipe.name });
  if (g.ignored) return res.status(202).json({ ignored: g.ignored });
  if (!H.branchMatch(t.recipe.hookBranch, g.branch)) return res.status(202).json({ ignored: `branch ${g.branch} — this recipe deploys ${t.recipe.hookBranch}` });
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const target = req.headers.host ? `${proto}://${req.headers.host}/#/deploy?tab=tasks` : null;
  const status = t.statusToken ? H.statusPoster(v.provider, g, t.statusToken, target, `DockGate: ${t.recipe.name}`) : null;
  try {
    const out = await R.run(t.recipe.id, { trigger: v.provider === 'ci' ? 'ci' : `webhook:${v.provider}`, by: g.author || v.provider, git: { sha: g.sha, branch: g.branch, message: g.message, author: g.author, repo: g.repo }, status });
    logAction({ req, server: t.recipe.serverId, resourceType: 'task', resourceName: t.recipe.dir, action: 'hook_deploy', details: { recipe: t.recipe.name, provider: v.provider, branch: g.branch, commit: g.sha && String(g.sha).slice(0, 12), run: out.id } });
    res.status(202).json({ ok: true, run: out.id });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message, ...(e.run ? { run: e.run } : {}) }); }
});

module.exports = router;
