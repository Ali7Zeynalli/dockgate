const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const dockerService = require('../docker');
const { logAction } = require('../audit');
const { execFile } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const execFileAsync = util.promisify(execFile);
const { buildCliEnv } = require('../remote-cli-env');

// ---- Git deploy (#2-B) helpers ----
// Non-interactive git (no credential/host prompts); a token (if any) is embedded into the https URL.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' };
function gitUrlWithToken(url, token) {
  return (token && /^https:\/\//i.test(url)) ? url.replace(/^https:\/\//i, `https://${encodeURIComponent(token)}@`) : url;
}
function redactToken(s, token) {
  return token ? String(s).split(token).join('***') : String(s);
}
function gitMetaPath(project) { return path.join(managedDir(project), '.dockgate-git.json'); }
function readGitMeta(project) {
  try { return JSON.parse(fs.readFileSync(gitMetaPath(project), 'utf8')); } catch (e) { return null; }
}
// Run a git command; if a shallow (--depth) op is rejected by the server (dumb HTTP / old git), retry full.
async function gitRun(args, opts) {
  try { return await execFileAsync('git', args, { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024, ...opts }); }
  catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    if (/shallow|dumb http/i.test(msg) && args.includes('--depth')) {
      const i = args.indexOf('--depth');
      const full = args.filter((_, idx) => idx !== i && idx !== i + 1);
      return await execFileAsync('git', full, { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024, ...opts });
    }
    throw e;
  }
}

// DockGate-managed compose projects live here (created/edited from the UI).
// Respects DATA_DIR (same as db.js) so tests/custom deploys use an isolated location.
const COMPOSE_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'compose');

// Validate compose project name — only safe characters (also prevents path traversal in COMPOSE_DIR)
function validateProjectName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

// Absolute path to a managed project's directory (project name already validated by caller)
function managedDir(project) {
  return path.join(COMPOSE_DIR, project);
}

// Sanitize an uploaded relative file path: drop leading slashes and any "../" so it can't escape the dir.
function safeRelPath(p) {
  const norm = path.normalize(String(p || '')).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
  if (norm === '.' || norm.includes('..')) return '';
  return norm;
}

// Standard compose filenames docker compose auto-detects.
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// Validate a compose file with `docker compose config -q` (throws with stderr if invalid)
async function validateComposeFile(cwd) {
  await execFileAsync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '-q'], { cwd });
}

// Run docker compose command safely using execFile (no shell injection).
// env: registry creds (private image pull) + DOCKER_HOST=ssh when the active server is remote.
async function runCompose(project, action, cwd) {
  const { env } = buildCliEnv(dockerService.getActiveServerId(), 'compose');
  const args = ['compose', '-p', project, ...action];
  const { stdout, stderr } = await execFileAsync('docker', args, { cwd, env, maxBuffer: 4 * 1024 * 1024 });
  return stdout || stderr;
}

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listComposeProjects()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:project', async (req, res) => {
  try { res.json(await dockerService.getComposeProject(req.params.project)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Compose commands run the host `docker compose` CLI in a working dir on DockGate's filesystem.
// Local → the local daemon. Remote SSH host → DOCKER_HOST=ssh:// (buildCliEnv) targets that daemon,
// but the compose file must be local, so only DockGate-managed projects can be (re)deployed remotely.
async function runComposeAction(req, res, action, label) {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const isLocal = dockerService.isLocalActive();
    const project = await dockerService.getComposeProject(req.params.project);
    const mDir = managedDir(req.params.project);
    const hasManaged = fs.existsSync(path.join(mDir, 'docker-compose.yml'));
    let cwd;
    if (isLocal) {
      cwd = project.workingDir;
      if (!cwd && hasManaged) cwd = mDir;
      if (!cwd) return res.status(400).json({ error: 'Working directory not found — this project has no running containers and is not DockGate-managed. Bring it up from its compose folder.' });
    } else {
      // Remote daemon: the local CLI can only read a local compose file, so require a managed project.
      if (!hasManaged) return res.status(400).json({ error: 'On a remote host, only DockGate-managed Compose projects can be deployed (the compose file must live on DockGate). Create it here first.' });
      cwd = mDir;
    }
    const output = await runCompose(req.params.project, action, cwd); // buildCliEnv throws 400 for unsupported remote auth
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: label, details: output });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
}

router.post('/:project/up', (req, res) => runComposeAction(req, res, ['up', '-d'], 'up'));
router.post('/:project/down', (req, res) => runComposeAction(req, res, ['down'], 'down'));
router.post('/:project/restart', (req, res) => runComposeAction(req, res, ['restart'], 'restart'));
router.post('/:project/pull', (req, res) => runComposeAction(req, res, ['pull'], 'pull'));
// docker compose build — compose faylındakı `build:` bölməli servislərin image-lərini qurur
router.post('/:project/build', (req, res) => runComposeAction(req, res, ['build'], 'build'));

// ---- DockGate-managed compose files (create / read / edit) — local host only ----

// Create a new managed project: write YAML → validate → up -d
router.post('/create', async (req, res) => {
  try {
    // The YAML is written to DockGate's local managed dir; `up` targets the active daemon
    // (local, or remote via DOCKER_HOST=ssh from runCompose). No local-only gate needed.
    const { project, yaml, up = true } = req.body || {};
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (only a-z, 0-9, _, -)' });
    if (!yaml || !yaml.trim()) return res.status(400).json({ error: 'Compose YAML is required' });
    if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
      return res.status(409).json({ error: `A project named "${project}" already exists` });
    }
    const dir = managedDir(project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), yaml, 'utf8');
    try { await validateComposeFile(dir); }
    catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.stderr || e.message) }); }
    let output = '';
    if (up) output = await runCompose(project, ['up', '-d'], dir);
    logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: 'create', details: { up } });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Read a managed project's YAML (for the editor)
router.get('/:project/file', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const f = path.join(managedDir(req.params.project), 'docker-compose.yml');
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'No DockGate-managed compose file for this project' });
    res.json({ project: req.params.project, yaml: fs.readFileSync(f, 'utf8'), managed: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Overwrite a managed project's YAML → validate → (optional) re-up
router.put('/:project/file', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const { yaml, up = false } = req.body || {};
    if (!yaml || !yaml.trim()) return res.status(400).json({ error: 'Compose YAML is required' });
    const dir = managedDir(req.params.project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), yaml, 'utf8');
    try { await validateComposeFile(dir); }
    catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.stderr || e.message) }); }
    let output = '';
    if (up) output = await runCompose(req.params.project, ['up', '-d'], dir);
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'edit', details: { up } });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Deploy a whole project FOLDER (uploaded from the browser as base64 files) → write to the managed
// dir → up. Works on the active daemon (local or remote via DOCKER_HOST=ssh, #2-A). Image-based
// compose is ideal; build contexts upload to the daemon, bind-mount paths resolve on the daemon's host.
router.post('/deploy-folder', express.json({ limit: '60mb' }), async (req, res) => {
  try {
    const { project, files, up = true } = req.body || {};
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (a-z, 0-9, _, -)' });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'No files uploaded' });
    if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
      return res.status(409).json({ error: `A project named "${project}" already exists` });
    }
    const dir = managedDir(project);
    fs.mkdirSync(dir, { recursive: true });
    let total = 0;
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.b64 !== 'string') continue;
      const rel = safeRelPath(f.path);
      if (!rel) continue;
      const dest = path.join(dir, rel);
      if (dest !== dir && !dest.startsWith(dir + path.sep)) continue; // traversal guard
      const buf = Buffer.from(f.b64, 'base64');
      total += buf.length;
      if (total > 50 * 1024 * 1024) return res.status(400).json({ error: 'Folder exceeds the 50MB upload limit — use pre-built images or git-based deploy for large projects' });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    const composeFile = COMPOSE_FILENAMES.find(n => fs.existsSync(path.join(dir, n)));
    if (!composeFile) return res.status(400).json({ error: 'No docker-compose.yml (or compose.yaml) found in the folder' });
    try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: dir }); }
    catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.stderr || e.message) }); }
    let output = '';
    if (up) output = await runCompose(project, ['up', '-d'], dir);
    logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: 'deploy-folder', details: { files: files.length, composeFile } });
    res.json({ success: true, output, composeFile });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Deploy from a Git repo (#2-B): clone → managed project → up. Stores repo/branch/token + a webhook
// secret for later re-deploys. Private repos: supply a token (embedded into the https URL; not logged).
router.post('/deploy-git', async (req, res) => {
  const { token = '' } = req.body || {};
  try {
    const { project, repoUrl, branch = '', subdir = '', up = true } = req.body || {};
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (a-z, 0-9, _, -)' });
    if (!repoUrl || !/^https?:\/\//i.test(repoUrl)) return res.status(400).json({ error: 'A http(s) git URL is required' });
    if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
      return res.status(409).json({ error: `A project named "${project}" already exists` });
    }
    const dir = managedDir(project);
    fs.rmSync(dir, { recursive: true, force: true });
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(gitUrlWithToken(repoUrl, token), dir);
    try { await gitRun(cloneArgs); }
    catch (e) { return res.status(400).json({ error: 'git clone failed: ' + redactToken(e.stderr || e.message, token) }); }

    const relSub = safeRelPath(subdir);
    const projectDir = relSub ? path.join(dir, relSub) : dir;
    const composeFile = COMPOSE_FILENAMES.find(n => fs.existsSync(path.join(projectDir, n)));
    if (!composeFile) return res.status(400).json({ error: `No docker-compose.yml found in the repo${relSub ? ' subdir "' + relSub + '"' : ''}` });

    const secret = crypto.randomBytes(18).toString('hex');
    fs.writeFileSync(gitMetaPath(project), JSON.stringify({ repoUrl, branch, token, subdir: relSub, composeFile, secret }, null, 2), { mode: 0o600 });
    try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: projectDir }); }
    catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.stderr || e.message) }); }

    let output = '';
    if (up) output = await runCompose(project, ['up', '-d'], projectDir);
    logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: 'deploy-git', details: { repoUrl, branch: branch || 'default' } });
    res.json({ success: true, output, composeFile, webhookSecret: secret });
  } catch (err) { res.status(err.statusCode || 500).json({ error: redactToken(err.message, token) }); }
});

// Re-deploy a git project: fetch latest → hard reset → up --build (rebuild from new source).
async function gitRedeploy(project) {
  const meta = readGitMeta(project);
  if (!meta) { const e = new Error('Not a Git-managed project'); e.statusCode = 400; throw e; }
  const dir = managedDir(project);
  const projectDir = meta.subdir ? path.join(dir, meta.subdir) : dir;
  await gitRun(['-C', dir, 'fetch', '--depth', '1', 'origin', meta.branch || 'HEAD']);
  await gitRun(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
  const composeFile = meta.composeFile || COMPOSE_FILENAMES.find(n => fs.existsSync(path.join(projectDir, n)));
  const output = await runCompose(project, ['up', '-d', '--build'], projectDir);
  return { output, composeFile };
}

// Git info for a project (used by the UI to show redeploy + webhook). No token returned.
router.get('/:project/git', (req, res) => {
  if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
  const meta = readGitMeta(req.params.project);
  if (!meta) return res.json({ gitManaged: false });
  res.json({ gitManaged: true, repoUrl: meta.repoUrl, branch: meta.branch || 'default', subdir: meta.subdir || '', hasToken: !!meta.token, webhookSecret: meta.secret });
});

// Manual re-deploy (pull latest + up)
router.post('/:project/redeploy', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const r = await gitRedeploy(req.params.project);
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'redeploy' });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() }); }
});

// Webhook: push-triggered re-deploy. Secured by the per-project secret in ?key= (no session needed).
// Targets the CURRENTLY ACTIVE daemon (note: switch to the project's host before relying on it).
router.post('/webhook/:project', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(404).json({ error: 'not found' });
    const meta = readGitMeta(req.params.project);
    if (!meta || !meta.secret || req.query.key !== meta.secret) return res.status(403).json({ error: 'invalid webhook key' });
    const r = await gitRedeploy(req.params.project);
    logAction({ req, server: 'local', resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'webhook-redeploy' });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() }); }
});

module.exports = router;
