const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const dockerService = require('../docker');
const { logAction } = require('../audit');
const { execFile, spawn } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const execFileAsync = util.promisify(execFile);
const { buildCliEnv } = require('../remote-cli-env');
const remoteCompose = require('../remote-compose');
const fileManager = require('../file-manager');
const sshKeys = require('../ssh-keys');

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
async function gitRun(args, opts = {}) {
  const { onData, ...rest } = opts;
  if (onData) {
    // Streaming path (live progress) — git clone/fetch progress goes to stderr.
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, { env: GIT_ENV, ...rest });
      let out = ''; const ch = d => { const s = d.toString(); out += s; onData(s); };
      child.stdout.on('data', ch); child.stderr.on('data', ch);
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve({ stdout: out }) : reject(Object.assign(new Error(out.trim() || ('git exited ' + code)), { code })));
    });
  }
  try { return await execFileAsync('git', args, { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024, ...rest }); }
  catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    if (/shallow|dumb http/i.test(msg) && args.includes('--depth')) {
      const i = args.indexOf('--depth');
      const full = args.filter((_, idx) => idx !== i && idx !== i + 1);
      return await execFileAsync('git', full, { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024, ...rest });
    }
    throw e;
  }
}

// Run a git command using a named SSH key from the store: materialize it to a temp 0600 file, point
// GIT_SSH_COMMAND at it, run, then shred. No keyId → ordinary gitRun (token-in-URL / public repo).
async function gitWithKey(keyId, args, opts) {
  if (!keyId) return gitRun(args, opts);
  const k = sshKeys.materializeToTemp(keyId);
  try {
    const env = { ...GIT_ENV, GIT_SSH_COMMAND: `ssh -i ${k.path} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new` };
    return await gitRun(args, { ...opts, env });
  } finally { k.cleanup(); }
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

// Find ALL compose files in a staged tree (recursive, NAME-AGNOSTIC): any *.yml/*.yaml whose top level
// declares `services:`. Catches docker-compose.app.yml, stack.yml, infra/*.yml, etc. — not just the 4
// standard names. Returns POSIX-relative paths, shallowest first. Skips obvious junk dirs.
function findComposeFiles(dir) {
  const out = [];
  const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.dockgate']);
  const walk = (cur, rel) => {
    let entries; try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(cur, e.name), r); continue; }
      if (!/\.ya?ml$/i.test(e.name)) continue;
      try { if (/^services:/m.test(fs.readFileSync(path.join(cur, e.name), 'utf8').slice(0, 65536))) out.push(r); } catch (e2) {}
      if (out.length >= 50) return; // sanity cap
    }
  };
  walk(dir, '');
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return out;
}

// Best-effort extraction of services / external networks / build-flag from one compose file, via
// `docker compose config --format json`. Resilient: a parse failure (e.g. missing ${VAR}) is reported,
// not thrown, so the user can still pick the file.
async function scanComposeFile(baseDir, relPath) {
  const cwd = path.join(baseDir, path.posix.dirname(relPath));
  const file = path.posix.basename(relPath);
  const info = { path: relPath, dir: path.posix.dirname(relPath), services: [], externalNets: [], hasBuild: false, parseError: null };
  try {
    const { stdout } = await execFileAsync('docker', ['compose', '-f', file, 'config', '--format', 'json'], { cwd, maxBuffer: 8 * 1024 * 1024 });
    const cfg = JSON.parse(stdout);
    const svc = cfg.services || {};
    info.services = Object.keys(svc);
    info.hasBuild = info.services.some(s => svc[s] && svc[s].build);
    const nets = cfg.networks || {};
    info.externalNets = Object.entries(nets).filter(([, v]) => v && v.external).map(([k, v]) => (v && v.name) || k);
  } catch (e) {
    info.parseError = (e.stderr || e.message || 'parse failed').toString().split('\n')[0].slice(0, 200);
  }
  return info;
}

// Local pointer for a REMOTE-deployed project: the files live on the remote, but DockGate remembers
// which server + folder so it can drive up/down/rebuild even when the project is fully down (no labels).
function deployMetaPath(project) { return path.join(managedDir(project), '.dockgate-deploy.json'); }
function readDeployMeta(project) { try { return JSON.parse(fs.readFileSync(deployMetaPath(project), 'utf8')); } catch (e) { return null; } }

// If the project lives on the active remote host (folder-deployed), return its SFTP context; else null.
// Used to make the Files browser read/write the REMOTE folder instead of DockGate's local pointer dir.
function remoteProjectCtx(project) {
  const meta = readDeployMeta(project);
  if (!meta || meta.mode !== 'remote' || meta.serverId !== dockerService.getActiveServerId()) return null;
  const server = remoteCompose.getActiveRemoteServer();
  if (!server) return null;
  return { server, remotePath: meta.remotePath, composeFile: meta.composeFile };
}
// Build a safe absolute remote path under the project's remote folder (traversal guard).
function safeRemoteProjectPath(remotePath, relPath) {
  const rel = safeRelPath(relPath);
  if (!rel || isProtectedProjectFile(rel)) return null;
  return remotePath.replace(/\/$/, '') + '/' + rel;
}
function writeDeployMeta(project, meta) {
  const d = managedDir(project);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(deployMetaPath(project), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

// Validate a compose file with `docker compose config -q` (throws with stderr if invalid)
async function validateComposeFile(cwd, file = 'docker-compose.yml') {
  await execFileAsync('docker', ['compose', '-f', file, 'config', '-q'], { cwd });
}

// Run docker compose command safely using execFile (no shell injection).
// env: registry creds (private image pull) + DOCKER_HOST=ssh when the active server is remote.
async function runCompose(project, action, cwd, onData) {
  const { env } = buildCliEnv(dockerService.getActiveServerId(), 'compose');
  const args = ['compose', '-p', project, ...action];
  if (!onData) {
    const { stdout, stderr } = await execFileAsync('docker', args, { cwd, env, maxBuffer: 4 * 1024 * 1024 });
    return stdout || stderr;
  }
  // Streaming variant — live output for the deploy console. Every other caller keeps the buffered path.
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd, env });
    let out = '';
    const onChunk = (d) => { const s = d.toString(); out += s; onData(s); };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) return resolve(out); const e = new Error('docker compose exited with code ' + code); e.statusCode = 400; reject(e); });
  });
}

router.get('/', async (req, res) => {
  try {
    const list = await dockerService.listComposeProjects();
    const activeId = dockerService.getActiveServerId();
    if (activeId !== 'local' && fs.existsSync(COMPOSE_DIR)) {
      // Annotate running remote folder-deployed projects so the UI can show Update/etc.
      for (const p of list) {
        const meta = readDeployMeta(p.name);
        if (meta && meta.mode === 'remote' && meta.serverId === activeId) { p.remote = true; p.deploySource = meta.source || 'folder'; }
      }
      // Merge in remote-deployed projects that are currently DOWN (no containers → not in the daemon list).
      const seen = new Set(list.map(p => p.name));
      for (const name of fs.readdirSync(COMPOSE_DIR)) {
        if (seen.has(name) || !validateProjectName(name)) continue;
        const meta = readDeployMeta(name);
        if (meta && meta.mode === 'remote' && meta.serverId === activeId) {
          list.push({ name, workingDir: meta.remotePath, configFiles: meta.composeFile || '', services: [], running: 0, stopped: 0, total: 0, remote: true, deploySource: meta.source || 'folder' });
        }
      }
    }
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all background deploy jobs (running + recent) — powers the "Deploys" console on the Compose page.
// Defined BEFORE /:project so the literal path isn't captured as a project name. (deployJobs is defined
// further down but referenced at call time, which is always after module load.)
router.get('/deploy-jobs', (req, res) => {
  gcDeployJobs();
  const jobs = [...deployJobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(j => ({ id: j.id, project: j.project, status: j.status, phase: j.phase, steps: j.steps || [], startedAt: j.startedAt, finishedAt: j.finishedAt }));
  res.json(jobs);
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

    if (!isLocal) {
      const server = remoteCompose.getActiveRemoteServer();
      // Remote-native: the project's files live on the remote → run `docker compose` THERE over SSH.
      // Prefer the live working_dir label; fall back to the stored deploy pointer when the project is down.
      const meta = readDeployMeta(req.params.project);
      const remoteDir = project.workingDir
        || (meta && meta.mode === 'remote' && meta.serverId === dockerService.getActiveServerId() ? meta.remotePath : null);
      if (server && remoteDir) {
        const output = await remoteCompose.runComposeInRemoteDir(server, remoteDir, req.params.project, action);
        logAction({ req, server: dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: label, details: output });
        return res.json({ success: true, output });
      }
      // Legacy DockGate-managed on a remote daemon (files on DockGate, DOCKER_HOST=ssh).
      if (hasManaged) {
        const output = await runCompose(req.params.project, action, mDir);
        logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: label, details: output });
        return res.json({ success: true, output });
      }
      return res.status(400).json({ error: 'On a remote host, control only DockGate-deployed projects (deploy from a folder/Git to this server first).' });
    }

    // Local daemon.
    let cwd = project.workingDir;
    if (!cwd && hasManaged) cwd = mDir;
    if (!cwd) return res.status(400).json({ error: 'Working directory not found — this project has no running containers and is not DockGate-managed. Bring it up from its compose folder.' });
    const output = await runCompose(req.params.project, action, cwd);
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
// Parse a list of service names (?services=a,b or body.services=[...]) — safe charset only.
function parseServices(src) {
  let raw = src || [];
  if (typeof raw === 'string') raw = raw.split(',');
  return (Array.isArray(raw) ? raw : []).map(s => String(s).trim()).filter(s => /^[a-zA-Z0-9._-]+$/.test(s));
}
// Rebuild = rebuild images from source + force-recreate so the new image lands in the container.
// ?services=a,b → rebuild ONLY those services (+ --no-deps so their dependencies aren't recreated).
router.post('/:project/rebuild', (req, res) => {
  const svc = parseServices((req.body && req.body.services) || (req.query && req.query.services));
  const action = ['up', '-d', '--build', '--force-recreate'];
  if (svc.length) action.push('--no-deps', ...svc);
  return runComposeAction(req, res, action, 'rebuild');
});

// Delete a whole project: stop+remove containers (compose down), optionally remove data volumes (-v),
// optionally remove the project FILES (the remote folder, or the local managed dir), and drop DockGate's
// tracking. ?volumes=1 also removes named volumes (data loss). ?files=0 keeps the files.
router.delete('/:project', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const project = req.params.project;
    const removeVolumes = req.query.volumes === '1' || req.query.volumes === 'true';
    const removeFiles = !(req.query.files === '0' || req.query.files === 'false'); // default: remove files
    const downArgs = removeVolumes ? ['down', '-v'] : ['down'];
    const isLocal = dockerService.isLocalActive();
    const proj = await dockerService.getComposeProject(project).catch(() => ({ workingDir: '' }));
    const mDir = managedDir(project);
    const meta = readDeployMeta(project);

    if (!isLocal) {
      const server = remoteCompose.getActiveRemoteServer();
      const remoteDir = (meta && meta.mode === 'remote' && meta.serverId === dockerService.getActiveServerId() ? meta.remotePath : null) || proj.workingDir;
      if (!server || !remoteDir) return res.status(400).json({ error: 'Cannot resolve the remote project to delete.' });
      try { await remoteCompose.runComposeInRemoteDir(server, remoteDir, project, downArgs); } catch (e) { /* may already be down */ }
      let removedPath = null;
      if (removeFiles) removedPath = await remoteCompose.removeRemoteDir(server, remoteDir);
      fs.rmSync(mDir, { recursive: true, force: true }); // drop the local pointer → untrack
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: project, resourceType: 'compose', resourceName: project, action: 'delete', details: { removeVolumes, removeFiles, remoteDir: removedPath || remoteDir } });
      return res.json({ success: true, removedPath });
    }

    // Local daemon.
    const cwd = proj.workingDir || (findComposeFile(mDir) ? mDir : null);
    if (cwd) { try { await runCompose(project, downArgs, cwd); } catch (e) { /* may already be down */ } }
    if (removeFiles && findComposeFile(mDir)) fs.rmSync(mDir, { recursive: true, force: true }); // only DockGate-managed files
    logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: 'delete', details: { removeVolumes, removeFiles } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

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

// Read a managed project's YAML (for the editor) — finds ANY standard compose filename (.yml/.yaml).
// Remote folder-deployed project → the compose file lives on the SERVER, so read it over SFTP (otherwise
// the editor came back empty, because the local managed dir only holds the .dockgate-deploy.json pointer).
router.get('/:project/file', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const name = rc.composeFile || 'docker-compose.yml';
      const abs = rc.remotePath.replace(/\/+$/, '') + '/' + name;
      const r = await fileManager.readFileText(rc.server, abs);
      if (r.isBinary || r.content == null) return res.status(404).json({ error: `Could not read ${name} on the server` });
      return res.json({ project: req.params.project, yaml: r.content, managed: true, file: name, remote: true });
    }
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
    // Remote folder-deployed project → write the compose file on the SERVER over SFTP, validate + (re)up THERE.
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const name = rc.composeFile || 'docker-compose.yml';
      await fileManager.writeFileText(rc.server, rc.remotePath.replace(/\/+$/, '') + '/' + name, yaml);
      try { await remoteCompose.runComposeInRemoteDir(rc.server, rc.remotePath, req.params.project, ['-f', name, 'config', '-q']); }
      catch (e) { return res.status(400).json({ error: 'Invalid compose file: ' + (e.message || e) }); }
      let output = '';
      if (up) output = await remoteCompose.runComposeInRemoteDir(rc.server, rc.remotePath, req.params.project, ['-f', name, 'up', '-d']);
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'edit', details: { up, remote: true } });
      return res.json({ success: true, output });
    }
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

// GET file tree (flat, sorted). Remote folder-deployed project → browse the REMOTE folder over SFTP;
// otherwise the local managed dir. Skips .git internals + the git-secret file.
router.get('/:project/tree', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const files = (await fileManager.listTree(rc.server, rc.remotePath)).filter(f => !isProtectedProjectFile(f.path));
      return res.json({ project: req.params.project, files, composeFile: rc.composeFile, remote: true, remotePath: rc.remotePath });
    }
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

// GET a single file's content (text). Binary/oversized → metadata only. Remote project → SFTP read.
router.get('/:project/filecontent', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = safeRemoteProjectPath(rc.remotePath, req.query.path);
      if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
      const r = await fileManager.readFileText(rc.server, abs);
      return res.json({ path: req.query.path, ...r });
    }
    const abs = safeProjectFile(req.params.project, req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'File not found' });
    const size = fs.statSync(abs).size;
    if (isBinaryFile(abs, size)) return res.json({ path: req.query.path, isBinary: true, size });
    res.json({ path: req.query.path, isBinary: false, size, content: fs.readFileSync(abs, 'utf8') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT a single file's content (create or overwrite). Remote project → SFTP write.
router.put('/:project/filecontent', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const { path: rel, content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = safeRemoteProjectPath(rc.remotePath, rel);
      if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
      await fileManager.writeFileText(rc.server, abs, content);
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-edit', details: { file: safeRelPath(rel), remote: true } });
      return res.json({ success: true });
    }
    const abs = safeProjectFile(req.params.project, rel);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-edit', details: { file: safeRelPath(rel) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE a single project file (not the compose file, not protected). Remote project → SFTP unlink.
router.delete('/:project/filecontent', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rel = safeRelPath(req.query.path);
    if (COMPOSE_FILENAMES.includes(rel)) return res.status(400).json({ error: 'Cannot delete the compose file itself' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = safeRemoteProjectPath(rc.remotePath, req.query.path);
      if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
      await fileManager.remove(rc.server, abs, false);
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-delete', details: { file: rel, remote: true } });
      return res.json({ success: true });
    }
    const abs = safeProjectFile(req.params.project, req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
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

// ---- Background deploy jobs ----
// Once the post-upload phase starts (SFTP to the remote + docker compose up), it runs as a tracked
// job that keeps going even if the browser/modal closes. The UI polls GET /deploy-job/:id for live
// phase + log, and can safely close at any time.
const deployJobs = new Map();
const DEPLOY_JOB_TTL_MS = 30 * 60 * 1000;
function gcDeployJobs() {
  const now = Date.now();
  for (const [id, j] of deployJobs) { if (j.finishedAt && now - j.finishedAt > DEPLOY_JOB_TTL_MS) deployJobs.delete(id); }
}
function jobLog(job, line) { job.log += line + '\n'; }
// Append streamed command output verbatim (control chars like \r preserved for the terminal viewer).
function jobStream(job, chunk) { job.log += chunk; }
// Update one step's status in the job's per-step list (drives the UI status indicators).
function setStep(job, id, status) { const s = (job.steps || []).find(x => x.id === id); if (s) s.status = status; }

// Ensure an external network exists on the deploy's target daemon (idempotent) — so stacks sharing an
// `external: true` network don't fail with "network ... not found". Failure (already exists) is ignored.
async function ensureNetwork(deploy, name, stream) {
  if (deploy && deploy.mode === 'remote') {
    const q = remoteCompose.shq(name);
    await remoteCompose.execRemote(deploy.server, `docker network inspect ${q} >/dev/null 2>&1 || docker network create ${q}`, stream);
    return;
  }
  // Local: create via the same CLI env/transport compose uses; swallow the "already exists" error.
  const { env } = buildCliEnv(dockerService.getActiveServerId(), 'compose');
  await new Promise((resolve) => {
    const child = spawn('docker', ['network', 'create', name], { env });
    let out = ''; const ch = d => { out += d.toString(); };
    child.stdout.on('data', ch); child.stderr.on('data', ch);
    child.on('error', () => { if (stream) stream(`network ${name}: create skipped\n`); resolve(); });
    child.on('close', () => { if (stream) stream(/already exists/i.test(out) ? `network ${name} already exists\n` : `network ${name} ready\n`); resolve(); });
  });
}

// The async worker: upload to the remote (or promote locally), then either run a multi-stack PLAN
// (user-selected compose files + services + build flags, each its own project) or the classic single up.
async function runDeployJob(job, u, composeFile, up, reqIp) {
  const isRemote = !!(u.deploy && u.deploy.mode === 'remote');
  const isUpdate = !!(u.deploy && u.deploy.update);
  const wantClean = !!(u.deploy && u.deploy.clean);
  const plan = (u.plan && Array.isArray(u.plan.stacks) && u.plan.stacks.length) ? u.plan : null;
  // Per-step status list so the UI shows exactly WHERE the deploy is (mirrors the provisioning step view).
  job.steps = [];
  if (isRemote && isUpdate && wantClean) job.steps.push({ id: 'clean', label: 'Clean remote folder', status: 'pending' });
  job.steps.push({ id: 'upload', label: isRemote ? 'Upload files to the server' : 'Stage project files', status: 'pending' });
  if (plan) {
    for (const n of (plan.createNets || [])) job.steps.push({ id: 'net:' + n, label: 'Ensure network ' + n, status: 'pending' });
    if (up) for (const s of plan.stacks) job.steps.push({ id: 'stack:' + s.name, label: 'Deploy ' + s.name + (s.services && s.services.length ? ' (' + s.services.join(', ') + ')' : ''), status: 'pending' });
  } else if (up) {
    job.steps.push({ id: 'deploy', label: isUpdate ? 'docker compose up --build --force-recreate' : 'docker compose up -d', status: 'pending' });
  }
  let current = null;
  const stream = (chunk) => jobStream(job, chunk);
  try {
    const serverId = dockerService.getActiveServerId();
    const server = isRemote ? u.deploy.server : null;

    // --- 1. Prepare files: upload to the remote, or promote into the local managed dir ---
    let baseDir, uploaded = u.files;
    if (isRemote) {
      const { remotePath, update, clean } = u.deploy;
      if (update && clean) { current = 'clean'; setStep(job, 'clean', 'running'); job.phase = 'clean'; jobLog(job, `Cleaning ${remotePath} on the server…`); try { await remoteCompose.removeRemoteDir(server, remotePath); } catch (e) {} setStep(job, 'clean', 'done'); }
      current = 'upload'; setStep(job, 'upload', 'running'); job.phase = 'upload'; jobLog(job, `Uploading files to ${remotePath} on the server…`);
      uploaded = await remoteCompose.uploadDirToRemote(server, u.dir, remotePath);
      jobLog(job, `Uploaded ${uploaded} file(s).`); setStep(job, 'upload', 'done');
      fs.rmSync(u.dir, { recursive: true, force: true });
      baseDir = remotePath;
    } else {
      const dir = managedDir(u.project);
      current = 'upload'; setStep(job, 'upload', 'running'); job.phase = 'promote'; jobLog(job, 'Staging project files…');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(u.dir, dir);
      setStep(job, 'upload', 'done'); baseDir = dir;
    }

    // --- 2/3. PLAN (multi-stack) OR the classic single-compose path ---
    if (plan) {
      for (const netName of (plan.createNets || [])) {
        current = 'net:' + netName; setStep(job, current, 'running'); job.phase = 'network'; jobLog(job, `\n$ ensure network ${netName}`);
        await ensureNetwork(u.deploy, netName, stream);
        setStep(job, current, 'done');
      }
      const deployed = [];
      if (up) for (const s of plan.stacks) {
        current = 'stack:' + s.name; setStep(job, current, 'running'); job.phase = 'up';
        const fileBase = path.posix.basename(s.composeFile);
        const subdir = path.posix.dirname(s.composeFile);
        const upArgs = ['-f', fileBase, 'up', '-d'];
        if (s.build && !s.noCache) upArgs.push('--build');
        if (s.pull) upArgs.push('--pull', 'always');
        if (s.noDeps) upArgs.push('--no-deps');
        if (Array.isArray(s.services) && s.services.length) upArgs.push(...s.services);
        jobLog(job, `\n$ [${s.name}] docker compose ${upArgs.join(' ')}`);
        if (isRemote) {
          const cwd = subdir === '.' ? baseDir : baseDir.replace(/\/+$/, '') + '/' + subdir;
          if (s.build && s.noCache) await remoteCompose.runComposeInRemoteDir(server, cwd, s.name, ['-f', fileBase, 'build', '--no-cache', ...(s.services || [])], stream);
          await remoteCompose.runComposeInRemoteDir(server, cwd, s.name, upArgs, stream);
          writeDeployMeta(s.name, { mode: 'remote', serverId, remotePath: cwd, composeFile: fileBase, source: 'folder' });
        } else {
          const cwd = subdir === '.' ? baseDir : path.join(baseDir, subdir);
          if (s.build && s.noCache) await runCompose(s.name, ['-f', fileBase, 'build', '--no-cache', ...(s.services || [])], cwd, stream);
          await runCompose(s.name, upArgs, cwd, stream);
        }
        setStep(job, current, 'done'); deployed.push(s.name);
      }
      job.result = { plan: true, stacks: deployed, nets: plan.createNets || [] };
      logAction({ sourceIp: reqIp, server: isRemote ? serverId : undefined, resourceId: u.project, resourceType: 'compose', resourceName: u.project, action: 'deploy-folder-plan', details: { stacks: deployed, nets: plan.createNets || [] } });
    } else if (isRemote) {
      const { remotePath, update } = u.deploy;
      writeDeployMeta(u.project, { mode: 'remote', serverId, remotePath, composeFile, source: 'folder' });
      if (up) {
        // On update: rebuild AND force-recreate so the new image/files actually land in the running container.
        // u.rebuildServices (optional) → rebuild ONLY those services (+ --no-deps so deps aren't recreated).
        const upArgs = update ? ['up', '-d', '--build', '--force-recreate'] : ['up', '-d'];
        if (update && u.rebuildServices && u.rebuildServices.length) upArgs.push('--no-deps', ...u.rebuildServices);
        current = 'deploy'; setStep(job, 'deploy', 'running'); job.phase = 'up'; jobLog(job, `$ docker compose ${upArgs.join(' ')}`);
        await remoteCompose.runComposeInRemoteDir(server, remotePath, u.project, upArgs, stream);
        setStep(job, 'deploy', 'done');
      }
      job.result = { composeFile, remotePath, updated: !!update };
      logAction({ sourceIp: reqIp, server: serverId, resourceId: u.project, resourceType: 'compose', resourceName: u.project, action: update ? 'update-folder' : 'deploy-folder', details: { files: uploaded, composeFile, remotePath, clean: !!wantClean } });
    } else {
      if (up) { current = 'deploy'; setStep(job, 'deploy', 'running'); job.phase = 'up'; jobLog(job, '$ docker compose up -d'); await runCompose(u.project, ['up', '-d'], baseDir, stream); setStep(job, 'deploy', 'done'); }
      job.result = { composeFile };
      logAction({ sourceIp: reqIp, resourceId: u.project, resourceType: 'compose', resourceName: u.project, action: 'deploy-folder', details: { files: u.files, composeFile } });
    }
    job.phase = 'done'; job.status = 'done'; jobLog(job, '✓ Done'); job.finishedAt = Date.now();
  } catch (err) {
    if (current) setStep(job, current, 'failed');
    job.status = 'error'; job.phase = 'error'; job.error = (err.stderr || err.message || 'deploy failed').toString();
    jobLog(job, '✗ ' + job.error); job.finishedAt = Date.now();
    try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Background worker for Git deploy — clone (streamed) → [transfer to the remote] → up, with per-step status.
async function runGitDeployJob(job, p) {
  const stream = (c) => jobStream(job, c);
  let current = null;
  job.steps = [{ id: 'clone', label: 'git clone', status: 'pending' }];
  if (remoteCompose.getActiveRemoteServer()) job.steps.push({ id: 'transfer', label: 'Transfer to the server', status: 'pending' });
  if (p.up) job.steps.push({ id: 'up', label: 'docker compose up -d', status: 'pending' });
  try {
    const dir = managedDir(p.project);
    fs.rmSync(dir, { recursive: true, force: true });
    current = 'clone'; setStep(job, 'clone', 'running'); job.phase = 'clone';
    jobLog(job, `$ git clone ${p.branch ? '-b ' + p.branch + ' ' : ''}${redactToken(p.repoUrl, p.token)}`);
    const cloneArgs = ['clone', '--depth', '1', '--progress'];
    if (p.branch) cloneArgs.push('--branch', p.branch);
    cloneArgs.push(p.keyId ? p.repoUrl : gitUrlWithToken(p.repoUrl, p.token), dir);
    await gitWithKey(p.keyId, cloneArgs, { onData: stream });
    setStep(job, 'clone', 'done'); current = null; // clone succeeded; a post-clone validation error isn't a clone failure

    const relSub = safeRelPath(p.subdir);
    const projectDir = relSub ? path.join(dir, relSub) : dir;
    const composeFile = findComposeFile(projectDir);
    if (!composeFile) throw Object.assign(new Error(`No docker-compose.yml in the repo${relSub ? ' subdir "' + relSub + '"' : ''}`), { statusCode: 400 });
    fs.writeFileSync(gitMetaPath(p.project), JSON.stringify({ repoUrl: p.repoUrl, branch: p.branch, token: p.keyId ? '' : p.token, keyId: p.keyId || '', subdir: relSub, composeFile, secret: p.secret }, null, 2), { mode: 0o600 });
    try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: projectDir }); }
    catch (e) { throw Object.assign(new Error('Invalid compose file: ' + (e.stderr || e.message)), { statusCode: 400 }); }

    const server = remoteCompose.getActiveRemoteServer();
    if (server) {
      const serverId = dockerService.getActiveServerId();
      const remotePath = await remoteCompose.resolveRemotePath(server, `~/.dockgate/projects/${p.project}`);
      current = 'transfer'; setStep(job, 'transfer', 'running'); job.phase = 'transfer'; jobLog(job, `\nUploading to ${remotePath} on the server…`);
      const n = await remoteCompose.uploadDirToRemote(server, projectDir, remotePath);
      jobLog(job, `Uploaded ${n} file(s).`); setStep(job, 'transfer', 'done');
      writeDeployMeta(p.project, { mode: 'remote', serverId, remotePath, composeFile, source: 'git' });
      if (p.up) { current = 'up'; setStep(job, 'up', 'running'); job.phase = 'up'; jobLog(job, '\n$ docker compose up -d'); await remoteCompose.runComposeInRemoteDir(server, remotePath, p.project, ['up', '-d'], stream); setStep(job, 'up', 'done'); }
    } else if (p.up) {
      current = 'up'; setStep(job, 'up', 'running'); job.phase = 'up'; jobLog(job, '\n$ docker compose up -d'); await runCompose(p.project, ['up', '-d'], projectDir, stream); setStep(job, 'up', 'done');
    }
    job.result = { composeFile, webhookSecret: p.secret };
    job.phase = 'done'; job.status = 'done'; jobLog(job, '✓ Done'); job.finishedAt = Date.now();
    logAction({ sourceIp: p.reqIp, server: server ? dockerService.getActiveServerId() : 'local', resourceId: p.project, resourceType: 'compose', resourceName: p.project, action: 'deploy-git', details: { repoUrl: p.repoUrl, branch: p.branch || 'default', auth: p.keyId ? 'ssh-key' : (p.token ? 'token' : 'public') } });
  } catch (err) {
    if (current) setStep(job, current, 'failed');
    job.status = 'error'; job.phase = 'error';
    job.error = redactToken((err.stderr || err.message || 'deploy failed').toString(), p.token);
    jobLog(job, '✗ ' + job.error); job.finishedAt = Date.now();
  }
}

// Poll a deploy job's live status + log.
router.get('/deploy-job/:id', (req, res) => {
  const job = deployJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Deploy job not found (it may have finished and expired)' });
  res.json({ id: job.id, project: job.project, status: job.status, phase: job.phase, steps: job.steps || [], log: job.log, error: job.error, result: job.result });
});

router.post('/deploy-folder-start', async (req, res) => {
  try {
    gcFolderUploads();
    const { project, target, update } = req.body || {};
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (a-z, 0-9, _, -)' });
    let deploy = { mode: 'local' };

    if (update) {
      // Re-upload an EXISTING remote folder-deployed project to its stored path, then rebuild.
      const meta = readDeployMeta(project);
      if (!meta || meta.mode !== 'remote') return res.status(400).json({ error: 'Update from folder is only for remote folder-deployed projects.' });
      const server = remoteCompose.getActiveRemoteServer();
      if (!server || meta.serverId !== dockerService.getActiveServerId()) {
        return res.status(400).json({ error: 'Switch to the server this project was deployed to, then update.' });
      }
      deploy = { mode: 'remote', server, remotePath: meta.remotePath, update: true, clean: !!(target && target.clean), source: meta.source || 'folder' };
    } else {
      if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
        return res.status(409).json({ error: `A project named "${project}" already exists` });
      }
      // target: { mode: 'remote', remotePath } → files land on the active remote host. Default: local (DockGate).
      if (target && target.mode === 'remote') {
        const server = remoteCompose.getActiveRemoteServer();
        if (!server) return res.status(400).json({ error: 'Remote deploy needs a remote SSH server active in the header.' });
        if (!(await remoteCompose.checkComposeAvailable(server))) {
          return res.status(400).json({ error: 'docker compose (v2) is not available on the remote host — install it there first.' });
        }
        const remotePath = await remoteCompose.resolveRemotePath(server, (target.remotePath || `~/.dockgate/projects/${project}`));
        deploy = { mode: 'remote', server, remotePath, source: 'folder' };
      }
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    const dir = path.join(STAGING_DIR, `${project}-${uploadId}`);
    fs.mkdirSync(dir, { recursive: true });
    folderUploads.set(uploadId, { project, dir, total: 0, files: 0, created: Date.now(), deploy });
    res.json({ uploadId, target: deploy.mode, remotePath: deploy.remotePath, update: !!deploy.update });
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

// After upload, scan the staged tree for ALL compose files + their services/networks so the UI can let the
// user PICK which file(s), which services, and how to build — instead of auto-detecting a single root file.
router.post('/deploy-folder-scan', async (req, res) => {
  try {
    const u = folderUploads.get((req.body || {}).uploadId);
    if (!u) return res.status(410).json({ error: 'Upload session expired — start over' });
    if (!u.files) return res.status(400).json({ error: 'No files uploaded yet' });
    const files = findComposeFiles(u.dir);
    const scanned = [];
    for (const f of files) scanned.push(await scanComposeFile(u.dir, f));
    res.json({ files: scanned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/deploy-folder-finish', async (req, res) => {
  const u = folderUploads.get((req.body || {}).uploadId);
  try {
    gcDeployJobs();
    const { uploadId, up = true, plan = null } = req.body || {};
    if (!u) return res.status(410).json({ error: 'Upload session expired — start over' });
    if (!u.files) return res.status(400).json({ error: 'No files uploaded' });
    // On an update, an optional services list rebuilds ONLY those services (see runDeployJob).
    if (u.deploy && u.deploy.update) u.rebuildServices = parseServices(req.body && req.body.services);

    let composeFile;
    if (plan && Array.isArray(plan.stacks) && plan.stacks.length) {
      // Multi-stack PLAN: validate each selected stack's compose file (exists in staging + parses).
      for (const s of plan.stacks) {
        if (!validateProjectName(s.name || '')) throw Object.assign(new Error(`Invalid stack name "${s.name}" (a-z, 0-9, _, -)`), { statusCode: 400 });
        const rel = safeRelPath(s.composeFile || '');
        const abs = path.join(u.dir, rel);
        if (!rel || !(abs === u.dir || abs.startsWith(u.dir + path.sep)) || !fs.existsSync(abs)) throw Object.assign(new Error(`Compose file not found in upload: ${s.composeFile}`), { statusCode: 400 });
        s.composeFile = rel; // normalized POSIX-relative
        try { await execFileAsync('docker', ['compose', '-f', path.posix.basename(rel), 'config', '-q'], { cwd: path.join(u.dir, path.posix.dirname(rel)) }); }
        catch (e) { throw Object.assign(new Error(`Invalid compose (${rel}): ` + (e.stderr || e.message)), { statusCode: 400 }); }
      }
      u.plan = { createNets: Array.isArray(plan.createNets) ? plan.createNets.filter(n => typeof n === 'string' && n) : [], stacks: plan.stacks };
      composeFile = plan.stacks[0].composeFile;
    } else {
      composeFile = findComposeFile(u.dir);
      if (!composeFile) { throw Object.assign(new Error('No docker-compose.yml (or compose.yaml) found in the folder'), { statusCode: 400 }); }
      // Validate synchronously so a bad compose fails fast (before the background job starts).
      try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: u.dir }); }
      catch (e) { throw Object.assign(new Error('Invalid compose file: ' + (e.stderr || e.message)), { statusCode: 400 }); }
    }

    // Hand the staging session to a background job: the upload + `docker compose up` continue on the
    // backend even if the client/modal closes. Return the job id immediately so the UI can poll it.
    folderUploads.delete(uploadId); // the job now owns u.dir
    const job = { id: crypto.randomBytes(8).toString('hex'), project: u.project, status: 'running', phase: 'starting', log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null };
    deployJobs.set(job.id, job);
    runDeployJob(job, u, composeFile, up, req.ip); // not awaited — runs in the background
    res.json({ jobId: job.id, project: u.project });
  } catch (err) {
    // Validation/setup failure → clean the staging dir so a retry starts fresh.
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
    gcDeployJobs();
    const { project, repoUrl, branch = '', subdir = '', up = true, keyId = '' } = req.body || {};
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (a-z, 0-9, _, -)' });
    const isHttp = /^https?:\/\//i.test(repoUrl || '');
    const isSsh = /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(repoUrl || '');
    if (!repoUrl || !(isHttp || isSsh)) return res.status(400).json({ error: 'A git URL is required (https://… or git@host:owner/repo.git for an SSH key)' });
    if (keyId && !isSsh) return res.status(400).json({ error: 'With an SSH key, use the SSH clone URL (git@host:owner/repo.git)' });
    if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
      return res.status(409).json({ error: `A project named "${project}" already exists` });
    }
    // Hand off to a background job (clone → transfer → up) with live per-step status, like folder deploy.
    const secret = crypto.randomBytes(18).toString('hex');
    const job = { id: crypto.randomBytes(8).toString('hex'), project, status: 'running', phase: 'starting', log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null };
    deployJobs.set(job.id, job);
    runGitDeployJob(job, { project, repoUrl, branch, subdir, up, keyId, token, secret, reqIp: req.ip });
    res.json({ jobId: job.id, project, webhookSecret: secret });
  } catch (err) { res.status(err.statusCode || 500).json({ error: redactToken(err.message, token) }); }
});

// Re-deploy a git project: fetch latest → hard reset → up --build (rebuild from new source).
async function gitRedeploy(project) {
  const meta = readGitMeta(project);
  if (!meta) { const e = new Error('Not a Git-managed project'); e.statusCode = 400; throw e; }
  const dir = managedDir(project);
  const projectDir = meta.subdir ? path.join(dir, meta.subdir) : dir;
  await gitWithKey(meta.keyId, ['-C', dir, 'fetch', '--depth', '1', 'origin', meta.branch || 'HEAD']);
  await gitWithKey(meta.keyId, ['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
  const composeFile = meta.composeFile || findComposeFile(projectDir);
  // Remote git project (Model A) → re-transfer the updated tree + rebuild THERE.
  const dm = readDeployMeta(project);
  const server = remoteCompose.getActiveRemoteServer();
  if (dm && dm.mode === 'remote' && server && dm.serverId === dockerService.getActiveServerId()) {
    await remoteCompose.uploadDirToRemote(server, projectDir, dm.remotePath);
    const output = await remoteCompose.runComposeInRemoteDir(server, dm.remotePath, project, ['up', '-d', '--build', '--force-recreate']);
    return { output, composeFile };
  }
  const output = await runCompose(project, ['up', '-d', '--build'], projectDir);
  return { output, composeFile };
}

// Git info for a project (used by the UI to show redeploy + webhook). No token returned.
router.get('/:project/git', (req, res) => {
  if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
  const meta = readGitMeta(req.params.project);
  if (!meta) return res.json({ gitManaged: false });
  res.json({ gitManaged: true, repoUrl: meta.repoUrl, branch: meta.branch || 'default', subdir: meta.subdir || '', hasToken: !!meta.token, hasKey: !!meta.keyId, webhookSecret: meta.secret });
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
