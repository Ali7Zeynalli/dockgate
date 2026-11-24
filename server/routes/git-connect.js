// Connect to Git (server/git-connect.js). Mounted at /api/git-connect.
// A target is { project } (a Compose project: its folder and server from the deploy record, or its
// containers' working folder) or { dir } on the server in use (Deploy > Tasks folders).
const express = require('express');
const path = require('path');
const router = express.Router();
const GC = require('../git-connect');
const { logAction } = require('../audit');

const send = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(e.statusCode || 500).json({ error: GC.redact(e.message, req.body || {}), ...(e.sensitive ? { sensitive: e.sensitive } : {}) }); }
};

async function resolve(body = {}) {
  const docker = require('../docker');
  const up = Math.max(0, Math.min(2, parseInt(body.rootUp, 10) || 0));
  let serverId = docker.getActiveServerId() || 'local', dir = body.dir, composeRel = '', project = '';
  if (body.project) {
    const { readDeployMeta, managedDir, validateProjectName } = require('./compose-shared');
    project = String(body.project);
    if (!validateProjectName(project)) throw Object.assign(new Error('Invalid project name'), { statusCode: 400 });
    const dm = readDeployMeta(project);
    let file = 'docker-compose.yml';
    if (dm && dm.mode === 'remote') { serverId = dm.serverId; dir = dm.remotePath; file = dm.composeFile || file; }
    else if (dm && dm.mode === 'local') { serverId = 'local'; dir = dm.workingDir || managedDir(project); file = dm.composeFile || file; }
    else {
      const p = await docker.getComposeProject(project).catch(() => null);
      if (!p || !p.workingDir) throw Object.assign(new Error('DockGate does not know the folder of this project'), { statusCode: 404 });
      dir = p.workingDir;
      const cfg = String(p.configFiles || '').split(',')[0];
      if (cfg) file = path.posix.basename(cfg.trim());
    }
    let rel = path.posix.basename(file);
    for (let i = 0; i < up; i++) { rel = path.posix.join(path.posix.basename(dir), rel); dir = path.posix.dirname(dir); }
    composeRel = rel;
  }
  if (!dir) throw Object.assign(new Error('Give the folder'), { statusCode: 400 });
  return { t: await GC.target(serverId, dir), composeRel, project };
}
const auth = (b) => ({ repoUrl: b.repoUrl, token: b.token, keyId: b.keyId });
const audit = (req, action, t, details) => logAction({ req, server: t.serverId === 'local' ? undefined : t.serverId, resourceType: 'git', resourceId: t.dir, resourceName: (req.body && req.body.project) || t.dir, action, details });

router.post('/check', send(async (req) => {
  const { t, composeRel, project } = await resolve(req.body);
  const c = await GC.check(t, auth(req.body));
  return { ...c, project, composeRel, backups: GC.listBackups(t.serverId, t.dir).slice(0, 10) };
}));
router.post('/compare', send(async (req) => {
  const { t, composeRel } = await resolve(req.body);
  return GC.compare(t, auth(req.body), req.body.branch, { composeRel });
}));
router.post('/diff', send(async (req) => GC.diff(req.body.session, String(req.body.file || ''))));
router.post('/connect', send(async (req) => {
  const r = await GC.connect(req.body.session, { keep: req.body.keep, project: req.body.project || '' });
  audit(req, 'git_connect', { serverId: r.server, dir: r.dir }, { repo: r.repoUrl, branch: r.branch, commit: r.commit.hash, replaced: r.replaced, kept: r.kept.length, added: r.added, backup: r.backup });
  if (req.body.project) { try { require('./compose')._invalidateGit(req.body.project); } catch (e) { /* cache expires */ } }
  return r;
}));
router.post('/undo', send(async (req) => {
  const r = await GC.undo(String(req.body.backup || ''));
  audit(req, 'git_connect_undo', { serverId: r.server, dir: r.dir }, { backup: req.body.backup, restored: r.restored, removed: r.removed });
  if (req.body.project) { try { require('./compose')._invalidateGit(req.body.project); } catch (e) { /* cache expires */ } }
  return r;
}));
router.post('/init-preview', send(async (req) => {
  const { t } = await resolve(req.body);
  const gi = await GC.suggestGitignore(t);
  const text = gi.exists ? gi.text : (req.body.gitignore != null ? String(req.body.gitignore) : gi.text);
  const pv = await GC.initPreview(t, text);
  if (!gi.exists) { pv.files.unshift('.gitignore'); pv.count += 1; }
  return { gitignore: { exists: gi.exists, text }, ...pv };
}));
router.post('/init-push', send(async (req) => {
  const { t, project } = await resolve(req.body);
  const b = req.body;
  const r = await GC.initPush(t, auth(b), { branch: b.branch, gitignore: b.gitignore, name: b.name, email: b.email, message: b.message, allowSensitive: !!b.allowSensitive, project });
  audit(req, 'git_first_push', t, { repo: r.repoUrl, branch: r.branch, commit: r.commit, files: r.files, backup: r.backup });
  if (project) { try { require('./compose')._invalidateGit(project); } catch (e) { /* cache expires */ } }
  return r;
}));

module.exports = router;
