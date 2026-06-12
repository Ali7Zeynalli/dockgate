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

// The managed project's compose file — ANY of the standard names (.yml AND .yaml). A folder/git deploy
// may bring docker-compose.yaml, so nothing may hardcode docker-compose.yml.
function findComposeFile(dir) {
  return COMPOSE_FILENAMES.find(n => fs.existsSync(path.join(dir, n))) || null;
}

// Validate a compose file with `docker compose config -q` (throws with stderr if invalid)
async function validateComposeFile(cwd, file = 'docker-compose.yml') {
  await execFileAsync('docker', ['compose', '-f', file, 'config', '-q'], { cwd });
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
    const hasManaged = !!findComposeFile(mDir);
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

// Read a managed project's YAML (for the editor) — finds ANY standard compose filename (.yml/.yaml)
router.get('/:project/file', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const dir = managedDir(req.params.project);
    const name = findComposeFile(dir);
    if (!name) return res.status(404).json({ error: 'No DockGate-managed compose file for this project' });
    res.json({ project: req.params.project, yaml: fs.readFileSync(path.join(dir, name), 'utf8'), managed: true, file: name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Overwrite a managed project's YAML → validate → (optional) re-up.
// Writes back to the project's EXISTING compose filename (e.g. docker-compose.yaml) — otherwise a
// second .yml file would shadow/be shadowed and edits would silently not apply.
router.put('/:project/file', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const { yaml, up = false } = req.body || {};
    if (!yaml || !yaml.trim()) return res.status(400).json({ error: 'Compose YAML is required' });
    const dir = managedDir(req.params.project);
    fs.mkdirSync(dir, { recursive: true });
    const name = findComposeFile(dir) || 'docker-compose.yml';
    fs.writeFileSync(path.join(dir, name), yaml, 'utf8');
    try { await validateComposeFile(dir, name); }
    catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.stderr || e.message) }); }
    let output = '';
    if (up) output = await runCompose(req.params.project, ['up', '-d'], dir);
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'edit', details: { up } });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ---- Managed project file tree (Phase 1): browse/edit ALL files of a project, not just the compose YAML
// (Dockerfile, .dockerignore, .env, configs…). Files live in COMPOSE_DIR/<project>/ on DockGate. ----

// Files that must never be read/written/deleted via the file API (token leak / git internals).
function isProtectedProjectFile(rel) {
  return rel === '.dockgate-git.json' || rel === '.git' || rel.startsWith('.git/');
}

// Resolve a project-relative path to an absolute path INSIDE the managed dir, or null if it escapes
// (traversal or symlink). Used for read/write/delete of individual project files.
function safeProjectFile(project, relPath) {
  const dir = managedDir(project);
  const rel = safeRelPath(relPath);
  if (!rel || isProtectedProjectFile(rel)) return null;
  const abs = path.join(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  try { // symlink-escape guard (only meaningful for existing paths)
    const realDir = fs.realpathSync(dir);
    const real = fs.realpathSync(abs);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) return null;
  } catch (e) { /* path may not exist yet (new file) — prefix check above already guards */ }
  return abs;
}

// Treat a file as binary (non-editable) if it's large or contains a NUL byte in its head.
function isBinaryFile(abs, size) {
  if (size > 2 * 1024 * 1024) return true;
  try {
    const fd = fs.openSync(abs, 'r');
    const n = Math.min(size, 8000);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.includes(0);
  } catch (e) { return false; }
}

// GET file tree (flat, sorted) of a managed project — skips .git internals + the git-secret file.
router.get('/:project/tree', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const dir = managedDir(req.params.project);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No DockGate-managed files for this project' });
    const out = [];
    const walk = (cur, rel) => {
      for (const name of fs.readdirSync(cur).sort()) {
        const r = rel ? rel + '/' + name : name;
        if (isProtectedProjectFile(r)) continue;
        let st; try { st = fs.statSync(path.join(cur, name)); } catch (e) { continue; }
        if (st.isDirectory()) { out.push({ path: r, type: 'dir', size: 0 }); walk(path.join(cur, name), r); }
        else out.push({ path: r, type: 'file', size: st.size });
      }
    };
    walk(dir, '');
    res.json({ project: req.params.project, files: out, composeFile: findComposeFile(dir) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET a single file's content (text). Binary/oversized → metadata only.
router.get('/:project/filecontent', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const abs = safeProjectFile(req.params.project, req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'File not found' });
    const size = fs.statSync(abs).size;
    if (isBinaryFile(abs, size)) return res.json({ path: req.query.path, isBinary: true, size });
    res.json({ path: req.query.path, isBinary: false, size, content: fs.readFileSync(abs, 'utf8') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT a single file's content (create or overwrite).
router.put('/:project/filecontent', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const { path: rel, content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });
    const abs = safeProjectFile(req.params.project, rel);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-edit', details: { file: safeRelPath(rel) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE a single project file (not the compose file itself, not protected files).
router.delete('/:project/filecontent', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rel = safeRelPath(req.query.path);
    const abs = safeProjectFile(req.params.project, req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    if (COMPOSE_FILENAMES.includes(rel)) return res.status(400).json({ error: 'Cannot delete the compose file itself' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
    fs.rmSync(abs, { recursive: true, force: true });
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-delete', details: { file: rel } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deploy a whole project FOLDER (uploaded from the browser as base64 files) → write to the managed
// dir → up. Works on the active daemon (local or remote via DOCKER_HOST=ssh, #2-A). Image-based
// compose is ideal; build contexts upload to the daemon, bind-mount paths resolve on the daemon's host.
router.post('/deploy-folder', async (req, res) => {
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
    const composeFile = findComposeFile(dir);
    if (!composeFile) return res.status(400).json({ error: 'No docker-compose.yml (or compose.yaml) found in the folder' });
    try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: dir }); }
    catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.stderr || e.message) }); }
    let output = '';
    if (up) output = await runCompose(project, ['up', '-d'], dir);
    logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: 'deploy-folder', details: { files: files.length, composeFile } });
    res.json({ success: true, output, composeFile });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ---- Per-file folder deploy (#2-A v2: live progress) ----
// The UI uploads files ONE BY ONE into a staging dir so it can show a real "12/45 uploaded" list,
// then finish validates the compose file and brings the project up. The single-shot /deploy-folder
// above stays for API compatibility.
const STAGING_DIR = path.join(COMPOSE_DIR, '.staging');
const folderUploads = new Map(); // uploadId → { project, dir, total, files, created }
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Drop stale sessions (browser closed mid-upload) so staging dirs don't accumulate.
function gcFolderUploads() {
  const now = Date.now();
  for (const [id, u] of folderUploads) {
    if (now - u.created > UPLOAD_TTL_MS) {
      fs.rmSync(u.dir, { recursive: true, force: true });
      folderUploads.delete(id);
    }
  }
}

router.post('/deploy-folder-start', async (req, res) => {
  try {
    gcFolderUploads();
    const { project } = req.body || {};
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (a-z, 0-9, _, -)' });
    if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
      return res.status(409).json({ error: `A project named "${project}" already exists` });
    }
    const uploadId = crypto.randomBytes(16).toString('hex');
    const dir = path.join(STAGING_DIR, `${project}-${uploadId}`);
    fs.mkdirSync(dir, { recursive: true });
    folderUploads.set(uploadId, { project, dir, total: 0, files: 0, created: Date.now() });
    res.json({ uploadId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/deploy-folder-file', (req, res) => {
  try {
    const { uploadId, path: relPath, b64 } = req.body || {};
    const u = folderUploads.get(uploadId);
    if (!u) return res.status(410).json({ error: 'Upload session expired — start over' });
    const rel = safeRelPath(relPath);
    if (!rel) return res.status(400).json({ error: 'Invalid file path' });
    const dest = path.join(u.dir, rel);
    if (!dest.startsWith(u.dir + path.sep)) return res.status(400).json({ error: 'Invalid file path' }); // traversal guard
    const buf = Buffer.from(String(b64 || ''), 'base64');
    u.total += buf.length;
    if (u.total > UPLOAD_MAX_BYTES) {
      fs.rmSync(u.dir, { recursive: true, force: true });
      folderUploads.delete(uploadId);
      return res.status(400).json({ error: 'Folder exceeds the 50MB upload limit — use pre-built images or git-based deploy for large projects' });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    u.files++;
    res.json({ success: true, files: u.files, bytes: u.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/deploy-folder-finish', async (req, res) => {
  const u = folderUploads.get((req.body || {}).uploadId);
  try {
    const { uploadId, up = true } = req.body || {};
    if (!u) return res.status(410).json({ error: 'Upload session expired — start over' });
    if (!u.files) return res.status(400).json({ error: 'No files uploaded' });
    const composeFile = findComposeFile(u.dir);
    if (!composeFile) { throw Object.assign(new Error('No docker-compose.yml (or compose.yaml) found in the folder'), { statusCode: 400 }); }
    try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: u.dir }); }
    catch (e) { throw Object.assign(new Error('Invalid compose file: ' + (e.stderr || e.message)), { statusCode: 400 }); }
    // Staging is valid → promote it to the managed project dir.
    const dir = managedDir(u.project);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(u.dir, dir);
    folderUploads.delete(uploadId);
    let output = '';
    if (up) output = await runCompose(u.project, ['up', '-d'], dir);
    logAction({ req, resourceId: u.project, resourceType: 'compose', resourceName: u.project, action: 'deploy-folder', details: { files: u.files, composeFile } });
    res.json({ success: true, output, composeFile });
  } catch (err) {
    // Validation/up failure → clean the staging dir so a retry starts fresh.
    if (u) { fs.rmSync(u.dir, { recursive: true, force: true }); folderUploads.delete((req.body || {}).uploadId); }
    res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() });
  }
});

// Cancel/close mid-upload — drop the staging dir.
router.post('/deploy-folder-abort', (req, res) => {
  const u = folderUploads.get((req.body || {}).uploadId);
  if (u) { fs.rmSync(u.dir, { recursive: true, force: true }); folderUploads.delete((req.body || {}).uploadId); }
  res.json({ success: true });
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
    const composeFile = findComposeFile(projectDir);
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
  const composeFile = meta.composeFile || findComposeFile(projectDir);
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
