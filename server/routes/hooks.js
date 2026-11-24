// Open webhooks (no session): mounted at /api/hooks BEFORE the auth gate in index.js. Each request is checked
// against the secret of what it targets (task-hooks.verify) - a wrong or missing signature gets 401.
//   POST /api/hooks/deploy/:hookId   GitHub, GitLab, Bitbucket Cloud / Server, Gitea, CI (Authorization: Bearer <secret>)
// Guards: 30 requests a minute per address (429); 20 wrong signatures in 10 minutes block the address for 15 minutes
// (one audit entry per window, not one per request); bodies over 1 MB are refused; a delivery already taken
// (same delivery id within 24 h) or the same commit within 2 minutes does not deploy again (CI: "force": true does).
const express = require('express');
const router = express.Router();
const H = require('../task-hooks');
const { logAction } = require('../audit');
const { db } = require('../db');

const MAX_BODY = 1024 * 1024;
const PER_MIN = 30, BAD_MAX = 20, BAD_WINDOW = 10 * 60000, BLOCK_FOR = 15 * 60000, DELIVERY_TTL = 24 * 3600000;

db.exec('CREATE TABLE IF NOT EXISTS task_hook_deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
const qd = {
  has: db.prepare('SELECT 1 FROM task_hook_deliveries WHERE id = ? AND at > ?'),
  put: db.prepare('INSERT OR REPLACE INTO task_hook_deliveries (id, at) VALUES (?, ?)'),
  prune: db.prepare('DELETE FROM task_hook_deliveries WHERE at < ?'),
};

// per address: { minute, count, bad: [times], blockedUntil, logged }
const seen = new Map();
const ipOf = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || '?');
function entry(ip, now) {
  let e = seen.get(ip);
  if (!e) { e = { minute: now, count: 0, bad: [], blockedUntil: 0, logged: 0 }; seen.set(ip, e); }
  if (now - e.minute >= 60000) { e.minute = now; e.count = 0; }
  e.bad = e.bad.filter(t => now - t < BAD_WINDOW);
  return e;
}
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of seen) if (now - e.minute > BAD_WINDOW && e.blockedUntil < now && !e.bad.length) seen.delete(ip);
  try { qd.prune.run(now - DELIVERY_TTL); } catch (e) { /* db closed in tests */ }
}, 5 * 60000);
if (sweep.unref) sweep.unref();

// GitHub can send "application/x-www-form-urlencoded" (payload=...): keep the raw body for the signature there too
router.use(express.urlencoded({ extended: false, limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

router.post('/deploy/:hookId', async (req, res) => {
  const now = Date.now(); const ip = ipOf(req); const e = entry(ip, now);
  if (e.blockedUntil > now) return res.status(429).set('Retry-After', String(Math.ceil((e.blockedUntil - now) / 1000))).json({ error: 'too many wrong signatures - try later' });
  if (++e.count > PER_MIN) return res.status(429).set('Retry-After', '60').json({ error: 'too many requests' });
  if (req.rawBody && req.rawBody.length > MAX_BODY) return res.status(413).json({ error: 'body too large (1 MB at most)' });
  const R = require('../task-recipes');
  const t = /^[a-f0-9]{24}$/.test(req.params.hookId) ? R.hookTarget(req.params.hookId) : null;
  const refuse = (code, msg, details) => {
    e.bad.push(now);
    const block = e.bad.length >= BAD_MAX;
    if (block) e.blockedUntil = now + BLOCK_FOR;
    if (now - e.logged > BAD_WINDOW || block) { // one audit line per address and window
      e.logged = now;
      logAction({ req, server: t ? t.recipe.serverId : null, resourceType: 'task', resourceName: t ? t.recipe.dir : null, action: 'hook_refused', details: { ...details, address: ip, refusedIn10Min: e.bad.length, ...(block ? { blockedMinutes: BLOCK_FOR / 60000 } : {}) } });
    }
    return res.status(code).json({ error: msg });
  };
  if (!t) return refuse(404, 'not found', { reason: 'unknown hook' });
  const v = H.verify(req.headers, req.rawBody || Buffer.from(''), t.secret);
  if (!v.ok) return refuse(401, 'bad signature or token', { recipe: t.recipe.name, provider: v.provider });
  e.bad = []; // a good signature clears the address

  let body = req.body || {};
  if (typeof body.payload === 'string') { try { body = JSON.parse(body.payload); } catch (x) { return res.status(400).json({ error: 'payload is not JSON' }); } }
  const g = H.parse(v.provider, v.event, body);
  if (g.ping) return res.json({ ok: true, pong: true, recipe: t.recipe.name });
  if (g.ignored) return res.status(202).json({ ignored: g.ignored });
  if (!H.branchMatch(t.recipe.hookBranch, g.branch)) return res.status(202).json({ ignored: `branch ${g.branch} - this recipe deploys ${t.recipe.hookBranch}` });

  // the same delivery again (a retry or a redelivery) -> already taken
  const did = H.deliveryId(req.headers);
  const key = did ? `${req.params.hookId}:${did}` : null;
  if (key && qd.has.get(key, now - DELIVERY_TTL)) return res.json({ ok: true, duplicate: true, ignored: 'this delivery was taken already' });
  const force = v.provider === 'ci' && (body.force === true || body.force === 'true');
  if (!force && g.sha && R.sameCommitRecently(t.recipe.id, g.sha)) { if (key) qd.put.run(key, now); return res.status(202).json({ ignored: `commit ${String(g.sha).slice(0, 10)} was deployed less than 2 minutes ago${v.provider === 'ci' ? ' - send "force": true to deploy it again' : ''}` }); }

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const target = req.headers.host ? `${proto}://${req.headers.host}/#/deploy?tab=tasks` : null;
  const status = t.statusToken ? H.statusPoster(v.provider, g, t.statusToken, target, `DockGate: ${t.recipe.name}`) : null;
  try {
    const out = await R.run(t.recipe.id, { trigger: v.provider === 'ci' ? 'ci' : `webhook:${v.provider}`, by: g.author || v.provider, git: { sha: g.sha, branch: g.branch, message: g.message, author: g.author, repo: g.repo }, status });
    if (key) qd.put.run(key, now);
    logAction({ req, server: t.recipe.serverId, resourceType: 'task', resourceName: t.recipe.dir, action: out.queued ? 'hook_queued' : 'hook_deploy', details: { recipe: t.recipe.name, provider: v.provider, branch: g.branch, commit: g.sha && String(g.sha).slice(0, 12), run: out.id } });
    res.status(202).json(out.queued ? { ok: true, queued: true, run: out.id, note: 'a deploy is running - this one starts when it ends' } : { ok: true, run: out.id });
  } catch (x) { res.status(x.statusCode || 500).json({ error: x.message, ...(x.run ? { run: x.run } : {}) }); }
});

router._reset = () => seen.clear(); // tests
module.exports = router;
