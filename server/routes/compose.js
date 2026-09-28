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
      try { if (/^services:/m.test(fs.readFileSync(path.join(cur, e.name), 'utf8').slice(0, 65536))) out.push(r); } catch (e2) { }
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
    if (fs.existsSync(COMPOSE_DIR)) {
      // Annotate running remote folder-deployed projects so the UI can show Update/etc.
      if (activeId !== 'local') for (const p of list) {
        const meta = readDeployMeta(p.name);
        if (meta && meta.mode === 'remote' && meta.serverId === activeId) { p.remote = true; p.deploySource = meta.source || 'folder'; }
      }
      // Annotate RUNNING LOCAL projects too, so a local git/folder deploy shows its git badge + ⤓ Pull / Update.
      // (Without this a running local project — already in the daemon list — never gets deploySource and the
      // git affordances stay hidden.)
      if (activeId === 'local') for (const p of list) {
        const meta = readDeployMeta(p.name);
        if (meta && meta.mode === 'local') p.deploySource = meta.source || 'folder';
      }
      // Merge in DOWN deploy-pointer projects for the active server (no containers → not in the daemon list).
      // Covers staged (deployed with up:false) and stopped projects, both remote AND local.
      const seen = new Set(list.map(p => p.name));
      for (const name of fs.readdirSync(COMPOSE_DIR)) {
        if (seen.has(name) || !validateProjectName(name)) continue;
        const meta = readDeployMeta(name);
        if (!meta) continue;
        if (meta.mode === 'remote' && meta.serverId === activeId) {
          list.push({ name, workingDir: meta.remotePath, configFiles: meta.composeFile || '', services: [], running: 0, stopped: 0, total: 0, remote: true, deploySource: meta.source || 'folder' });
        } else if (meta.mode === 'local' && activeId === 'local') {
          list.push({ name, workingDir: meta.workingDir || '', configFiles: meta.composeFile || '', services: [], running: 0, stopped: 0, total: 0, deploySource: meta.source || 'folder' });
        }
      }
    }

    // Enrich all projects with accurate Git status (managed & external)
    for (const p of list) {
      const gitMeta = readGitMeta(p.name);
      if (gitMeta) {
        const targetServerId = gitMeta.serverId || 'local';
        if (targetServerId === activeId || (targetServerId === 'local' && activeId === 'local')) {
          p.isGit = true;
          p.deploySource = 'git';
          p.gitInfo = {
            repoUrl: gitMeta.repoUrl,
            branch: gitMeta.branch || 'main',
            deployedCommit: (gitMeta.deployedCommit || '').slice(0, 7),
            subdir: gitMeta.subdir || '',
            external: false
          };
        }
      } else if (p.deploySource === 'git') {
        p.isGit = true;
      } else if (activeId === 'local' && p.workingDir) {
        try {
          if (fs.existsSync(path.join(p.workingDir, '.git'))) {
            p.isGit = true;
            p.deploySource = p.deploySource || 'adopt';
            p.gitExternal = true;
            p.gitInfo = { external: true };
          }
        } catch (e) { }
      } else {
        const cached = externalGitCache.get(activeId + ':' + p.name);
        if (cached && cached.result && cached.result.isGit && !cached.result.managed) {
          p.isGit = true;
          p.deploySource = p.deploySource || 'adopt';
          p.gitExternal = true;
          p.gitInfo = {
            repoUrl: cached.result.remoteUrl,
            branch: cached.result.branch || 'HEAD',
            external: true
          };
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
// Resolve where a compose project's command runs (remote-native folder, legacy remote-managed, or local
// working/managed dir) and execute it — STREAMED when onData is given. Throws (with statusCode) on bad state.
// Resolve the compose file(s) + cwd to drive a per-project action — so every action passes `-f <file>` and
// works regardless of the file's NAME (docker-compose.greennec.yaml) or LOCATION (a subdir). Without this,
// `docker compose -p <project> <action>` auto-detects only the 4 standard names in the cwd and fails with
// "no configuration file provided: not found" for everything else. Precedence (most authoritative first):
//   1) deploy-meta .composeFile (survives a fully-down project)  2) git-meta .composeFile (+subdir)
//   3) docker config_files label (CSV → multi -f; running only; UNTRUSTED → isSafeHostPath-validated)
//   4) filesystem discovery (findComposeFile → recursive findComposeFiles; local only)  5) fail-closed.
// Each file is reduced to (cwd = its dir, -f = basename) so relative build contexts / bind-mounts resolve
// exactly as they did at deploy time.
async function resolveComposeFiles(project) {
  const isLocal = dockerService.isLocalActive();
  const server = remoteCompose.getActiveRemoteServer();
  const activeId = dockerService.getActiveServerId();
  const proj = await dockerService.getComposeProject(project).catch(() => ({}));
  const meta = readDeployMeta(project);
  const gitMeta = readGitMeta(project);
  const mDir = managedDir(project);
  const norm = (file, baseCwd) => {
    const abs = path.posix.isAbsolute(file) ? file : path.posix.join(String(baseCwd || '').replace(/\/+$/, ''), file);
    return { cwd: path.posix.dirname(abs), file: path.posix.basename(abs), abs };
  };
  // 1) deploy-meta
  if (meta && meta.composeFile) {
    if (meta.mode === 'remote' && server && meta.serverId === activeId) {
      const n = norm(meta.composeFile, meta.remotePath || '');
      return { files: [n.file], cwd: n.cwd || meta.remotePath, server, remote: true, source: 'deploy metadata' };
    }
    if (meta.mode === 'local' && isLocal) {
      const n = norm(meta.composeFile, meta.workingDir || mDir);
      return { files: [n.file], cwd: n.cwd, server: null, remote: false, source: 'deploy metadata' };
    }
  }
  // 2) git-meta (local managed git)
  if (gitMeta && gitMeta.composeFile && isLocal) {
    const n = norm(gitMeta.composeFile, gitMeta.subdir ? path.join(mDir, gitMeta.subdir) : mDir);
    return { files: [n.file], cwd: n.cwd, server: null, remote: false, source: 'git metadata' };
  }
  // 3) docker config_files label (running project) — CSV; untrusted → validate
  const cfg = String(proj.configFiles || '').split(',').map(s => s.trim()).filter(Boolean);
  const wd = proj.workingDir;
  if (cfg.length && wd) {
    const normd = cfg.map(f => norm(f, wd));
    if (!isSafeHostPath(wd) || !normd.every(n => isSafeHostPath(n.abs))) return { files: [], reason: 'The compose file path in the container labels is not safe to operate on.' };
    return { files: normd.map(n => n.file), cwd: normd[0].cwd, server: server || null, remote: !isLocal, source: 'docker label' };
  }
  // 4) filesystem discovery (LOCAL only — can't fs-scan an unknown remote path here)
  if (isLocal) {
    const base = (wd && isSafeHostPath(wd)) ? wd : (findComposeFile(mDir) ? mDir : null);
    if (base) {
      const std = findComposeFile(base);
      if (std) return { files: [std], cwd: base, server: null, remote: false, source: 'discovered on disk' };
      const found = findComposeFiles(base);
      if (found.length) { const n = norm(found[0], base); return { files: [n.file], cwd: n.cwd, server: null, remote: false, source: 'discovered on disk' }; }
    }
  }
  // 5) fail-closed — never fall through to a bare `docker compose` (the old cryptic-error bug)
  return { files: [], reason: `DockGate cannot determine which compose file to use for "${project}". It is down/external and there is no record — bring it up once from its folder, or adopt/redeploy it, so the compose file is recorded.` };
}

async function execComposeAction(projectName, action, onData) {
  const r = await resolveComposeFiles(projectName);
  if (!r.files.length) { const e = new Error(r.reason || 'Cannot determine the compose file for this project.'); e.statusCode = 400; throw e; }
  const fullAction = [...r.files.flatMap(f => ['-f', f]), ...action];
  if (r.remote) return await remoteCompose.runComposeInRemoteDir(r.server, r.cwd, projectName, fullAction, onData);
  return await runCompose(projectName, fullAction, r.cwd, onData);
}

// Synchronous compose action (fast ops: down/restart) → run and return the output as JSON.
async function runComposeAction(req, res, action, label) {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const output = await execComposeAction(req.params.project, action, null);
    logAction({ req, server: dockerService.isLocalActive() ? undefined : dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: label, details: output });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
}

// Background compose action (long ops: up/pull/build/rebuild) → live per-step console (deployJobs), like deploy.
function startComposeActionJob(req, res, action, label) {
  if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
  gcDeployJobs();
  const projectName = req.params.project, reqIp = req.ip;
  const job = { id: crypto.randomBytes(8).toString('hex'), project: projectName, status: 'running', phase: 'starting', log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null };
  deployJobs.set(job.id, job);
  (async () => {
    const stream = (c) => jobStream(job, c);
    job.steps = [{ id: 'action', label, status: 'pending' }];
    try {
      setStep(job, 'action', 'running'); job.phase = label; jobLog(job, `$ docker compose ${action.join(' ')}`);
      await execComposeAction(projectName, action, stream);
      setStep(job, 'action', 'done'); job.phase = 'done'; job.status = 'done'; jobLog(job, '✓ Done'); job.finishedAt = Date.now();
      logAction({ sourceIp: reqIp, server: dockerService.isLocalActive() ? 'local' : dockerService.getActiveServerId(), resourceId: projectName, resourceType: 'compose', resourceName: projectName, action: label });
    } catch (err) {
      setStep(job, 'action', 'failed'); job.status = 'error'; job.phase = 'error'; job.error = (err.stderr || err.message || 'failed').toString(); jobLog(job, '✗ ' + job.error); job.finishedAt = Date.now();
    }
  })();
  res.json({ jobId: job.id, project: projectName });
}

router.post('/:project/up', (req, res) => startComposeActionJob(req, res, ['up', '-d'], 'up'));
router.post('/:project/down', (req, res) => runComposeAction(req, res, ['down'], 'down'));
router.post('/:project/restart', (req, res) => runComposeAction(req, res, ['restart'], 'restart'));
router.post('/:project/pull', (req, res) => startComposeActionJob(req, res, ['pull'], 'pull'));
// docker compose build — compose faylındakı `build:` bölməli servislərin image-lərini qurur
router.post('/:project/build', (req, res) => startComposeActionJob(req, res, ['build'], 'build'));
// Parse a list of service names (?services=a,b or body.services=[...]) — safe charset only.
function parseServices(src) {
  let raw = src || [];
  if (typeof raw === 'string') raw = raw.split(',');
  return (Array.isArray(raw) ? raw : []).map(s => String(s).trim()).filter(s => /^[a-zA-Z0-9._-]+$/.test(s));
}
// Rebuild = rebuild images from source + force-recreate so the new image lands in the container.
// A `plan` body { stacks:[{ file, services[], noCache, force }] } rebuilds the EXACT compose file(s) the
// user picked (different name/location/services). Without a plan: ?services=a,b → rebuild only those via
// the resolved file(s) (+ --no-deps); empty → the whole project. Both pass -f (via execComposeAction / plan).
router.post('/:project/rebuild', (req, res) => {
  if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
  const plan = req.body && req.body.plan;
  if (plan && Array.isArray(plan.stacks) && plan.stacks.length) return startRebuildPlanJob(req, res, plan);
  const svc = parseServices((req.body && req.body.services) || (req.query && req.query.services));
  const action = ['up', '-d', '--build', '--force-recreate'];
  if (svc.length) action.push('--no-deps', ...svc);
  return startComposeActionJob(req, res, action, 'rebuild');
});

// Scan the project's tree for ALL compose files (any *.yml/.yaml with a services: block — non-standard names
// and subdirs included), each with its services, sorted shallowest-first, so the Rebuild picker can show
// "which services in which file". Scan root = the git repo root (if a checkout) else the resolved cwd.
// Local → fs walk (findComposeFiles); remote → one SSH grep + `docker compose config --services` per file.
async function scanComposeFilesForRebuild(project) {
  const r = await resolveComposeFiles(project);
  const server = remoteCompose.getActiveRemoteServer();
  const currentAbs = new Set();
  if (r.files && r.cwd) r.files.forEach(f => currentAbs.add(path.posix.join(r.cwd, f)));
  let scanRoot = r.cwd || null;
  if (!scanRoot) return { ok: false, reason: r.reason || 'Could not locate this project on the host' };
  try { const top = (await gitInDir(server, scanRoot, ['rev-parse', '--show-toplevel'])).trim(); if (top && isSafeHostPath(top)) scanRoot = top; } catch (e) { }
  const entries = [];
  if (!server) {
    for (const rel of findComposeFiles(scanRoot).slice(0, 40)) {
      let services = [];
      try { const sc = await scanComposeFile(scanRoot, rel); services = sc.services || []; } catch (e) { }
      entries.push({ path: rel, file: path.posix.join(scanRoot, rel), services });
    }
  } else {
    // Portable (busybox + GNU): find candidate *.yml/.yaml (pruning junk dirs), keep those with a top-level
    // services:, emit F:<path> + S:<service> lines. `< /dev/null` keeps `docker compose` from eating the loop's stdin.
    const inner = `cd ${remoteCompose.shq(scanRoot)} 2>/dev/null && find . -type d \\( -name .git -o -name node_modules -o -name .next -o -name dist -o -name build -o -name .dockgate \\) -prune -o -type f \\( -name '*.yml' -o -name '*.yaml' \\) -print 2>/dev/null | head -60 | while read f; do if head -c 65536 "$f" 2>/dev/null | grep -qE '^services:'; then echo "F:$f"; docker compose -f "$f" config --services < /dev/null 2>/dev/null | sed 's/^/S:/'; fi; done`;
    const out = await remoteCompose.execRemote(server, 'timeout 90 sh -c ' + remoteCompose.shq(inner));
    let cur = null;
    for (const line of String(out.stdout || '').split('\n')) {
      if (line.startsWith('F:')) { const rel = line.slice(2).replace(/^\.\//, ''); cur = { path: rel, file: scanRoot.replace(/\/+$/, '') + '/' + rel, services: [] }; entries.push(cur); }
      else if (line.startsWith('S:') && cur) { const s = line.slice(2).trim(); if (s) cur.services.push(s); }
    }
  }
  entries.forEach(e => { e.current = currentAbs.has(e.file); });
  entries.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return { ok: entries.length > 0, remote: !!server, scanRoot, source: r.source, files: entries, reason: entries.length ? '' : `No compose files (with a services: block) found under ${scanRoot}.` };
}

router.get('/:project/compose-files', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    res.json(await scanComposeFilesForRebuild(req.params.project));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rebuild the EXACT files/services the user picked → docker compose -p <project> -f <file> up -d --build
// [--force-recreate] [--no-deps svc…], optionally a `build --no-cache` first. Untrusted paths validated.
function startRebuildPlanJob(req, res, plan) {
  gcDeployJobs();
  const project = req.params.project, reqIp = req.ip;
  const stacks = (plan.stacks || []).filter(s => s && typeof s.file === 'string' && isSafeHostPath(s.file));
  if (!stacks.length) return res.status(400).json({ error: 'No valid compose file selected.' });
  const job = { id: crypto.randomBytes(8).toString('hex'), project, status: 'running', phase: 'starting', log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null, steps: stacks.map((s, i) => ({ id: 'stack:' + i, label: 'rebuild ' + path.posix.basename(s.file), status: 'pending' })) };
  deployJobs.set(job.id, job);
  runRebuildPlanJob(job, { project, stacks, reqIp });
  res.json({ jobId: job.id, project });
}

async function runRebuildPlanJob(job, p) {
  const stream = (c) => jobStream(job, c);
  try {
    const server = remoteCompose.getActiveRemoteServer();
    for (let i = 0; i < p.stacks.length; i++) {
      const st = p.stacks[i];
      const cwd = path.posix.dirname(st.file), file = path.posix.basename(st.file);
      const svc = (st.services || []).filter(s => /^[a-zA-Z0-9._-]+$/.test(s));
      setStep(job, 'stack:' + i, 'running'); job.phase = 'rebuild';
      const exec = async (args, echo) => { jobLog(job, '\n$ docker compose -p ' + p.project + ' ' + echo + '\n'); if (server) await remoteCompose.runComposeInRemoteDir(server, cwd, p.project, args, stream); else await runCompose(p.project, args, cwd, stream); };
      if (st.noCache) await exec(['-f', file, 'build', '--no-cache', ...svc], '-f ' + file + ' build --no-cache ' + svc.join(' '));
      const up = ['-f', file, 'up', '-d', '--build'];
      if (st.force) up.push('--force-recreate');
      if (svc.length) up.push('--no-deps', ...svc);
      await exec(up, up.join(' '));
      setStep(job, 'stack:' + i, 'done');
    }
    job.phase = 'done'; job.status = 'done'; jobLog(job, '\n✓ Done'); job.finishedAt = Date.now();
    logAction({ sourceIp: p.reqIp, server: remoteCompose.getActiveRemoteServer() ? dockerService.getActiveServerId() : 'local', resourceId: p.project, resourceType: 'compose', resourceName: p.project, action: 'rebuild', details: { files: p.stacks.map(s => path.posix.basename(s.file)) } });
  } catch (err) {
    job.status = 'error'; job.phase = 'error'; job.error = (err.stderr || err.message || 'rebuild failed').toString();
    const r = (job.steps || []).find(s => s.status === 'running'); if (r) r.status = 'failed';
    jobLog(job, '\n✗ ' + job.error); job.finishedAt = Date.now();
  }
}

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
    // ADOPTED-IN-PLACE projects point at the USER'S OWN existing folder (source:'adopt'). A normal delete
    // (removeFiles default true → removeRemoteDir → rm -rf) would destroy their data. NEVER remove files for
    // an adopted project: `docker compose down` + drop DockGate's pointer only (untrack). Non-overridable.
    const isAdopted = !!(meta && meta.source === 'adopt');
    const removeFilesEff = isAdopted ? false : removeFiles;

    if (!isLocal) {
      const server = remoteCompose.getActiveRemoteServer();
      const remoteDir = (meta && meta.mode === 'remote' && meta.serverId === dockerService.getActiveServerId() ? meta.remotePath : null) || proj.workingDir;
      if (!server || !remoteDir) return res.status(400).json({ error: 'Cannot resolve the remote project to delete.' });
      try { await remoteCompose.runComposeInRemoteDir(server, remoteDir, project, downArgs); } catch (e) { /* may already be down */ }
      let removedPath = null;
      if (removeFilesEff) removedPath = await remoteCompose.removeRemoteDir(server, remoteDir);
      fs.rmSync(mDir, { recursive: true, force: true }); // drop the local pointer → untrack
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: project, resourceType: 'compose', resourceName: project, action: 'delete', details: { removeVolumes, removeFiles: removeFilesEff, adopted: isAdopted, remoteDir: removedPath || remoteDir } });
      return res.json({ success: true, removedPath });
    }

    // Local daemon.
    const cwd = proj.workingDir || (meta && meta.mode === 'local' && meta.workingDir) || (fs.existsSync(mDir) ? mDir : null);
    if (cwd) { try { await runCompose(project, downArgs, cwd); } catch (e) { /* may already be down */ } }
    // mDir is always managedDir(project) — i.e. under COMPOSE_DIR — so removing the whole managed folder is
    // safe. The old `findComposeFile(mDir)` guard skipped subdir / non-standard-named compose layouts (e.g. a
    // repo whose compose file is deploy/docker-compose.greennec.yaml), leaving the folder behind.
    if (removeFilesEff && fs.existsSync(mDir)) fs.rmSync(mDir, { recursive: true, force: true });
    logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: 'delete', details: { removeVolumes, removeFiles: removeFilesEff, adopted: isAdopted } });
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
  return rel === '.dockgate-git.json' || rel === '.dockgate-deploy.json' || rel === '.git' || rel.startsWith('.git/');
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

// Lazy, ONE-folder listing for the project Files browser (fast: a single readdir, no recursive walk).
// `sub` is a project-relative folder path (jailed). Mirrors the standalone File Manager's listDir speed.
router.get('/:project/dir', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const sub = (req.query.sub || '').toString();
    const relSub = sub ? safeRelPath(sub) : '';
    if (sub && !relSub) return res.status(400).json({ error: 'Invalid path' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = rc.remotePath.replace(/\/+$/, '') + (relSub ? '/' + relSub : '');
      const { entries } = await fileManager.listDir(rc.server, abs);
      const out = entries.filter(e => !isProtectedProjectFile(relSub ? relSub + '/' + e.name : e.name))
        .map(e => ({ name: e.name, type: e.type, size: e.size }));
      return res.json({ project: req.params.project, sub: relSub, entries: out, composeFile: rc.composeFile, remote: true });
    }
    const base = managedDir(req.params.project);
    if (!fs.existsSync(base)) return res.status(404).json({ error: 'No DockGate-managed files for this project' });
    const dir = relSub ? path.join(base, relSub) : base;
    if (dir !== base && !dir.startsWith(base + path.sep)) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(404).json({ error: 'Not a folder' });
    const out = fs.readdirSync(dir).map(name => {
      const rel = relSub ? relSub + '/' + name : name;
      if (isProtectedProjectFile(rel)) return null;
      let st; try { st = fs.statSync(path.join(dir, name)); } catch (e) { return null; }
      return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size };
    }).filter(Boolean).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));
    res.json({ project: req.params.project, sub: relSub, entries: out, composeFile: findComposeFile(base) });
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
      if (total > 1024 * 1024 * 1024) return res.status(400).json({ error: 'Folder exceeds the 1GB upload limit — use pre-built images or git-based deploy for large projects' });
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
const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024; // 1GB total project size (uploaded file-by-file). Single file is JSON/V8-capped near ~384MB.

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
  job.steps.push({ id: 'upload', label: (isRemote && u.remoteReady) ? 'Verify project on server' : (isRemote ? 'Upload files to the server' : 'Stage project files'), status: 'pending' });
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
      if (u.remoteReady) {
        // Remote-native Git: repository was already cloned directly on the remote server -> NO SFTP upload needed!
        current = 'upload'; setStep(job, 'upload', 'running'); job.phase = 'upload';
        jobLog(job, `✓ Code ready on server (${server.host || 'remote'} at ${remotePath})\n`);
        setStep(job, 'upload', 'done');
        baseDir = remotePath;
      } else {
        if (update && clean) { current = 'clean'; setStep(job, 'clean', 'running'); job.phase = 'clean'; jobLog(job, `Cleaning ${remotePath} on the server…`); try { await remoteCompose.removeRemoteDir(server, remotePath); } catch (e) { } setStep(job, 'clean', 'done'); }
        current = 'upload'; setStep(job, 'upload', 'running'); job.phase = 'upload'; jobLog(job, `Uploading files to ${remotePath} on the server…\n`);
        uploaded = await remoteCompose.uploadDirToRemote(server, u.dir, remotePath, (d, t) => jobStream(job, `\ruploaded ${d}/${t} files`));
        jobLog(job, `\nUploaded ${uploaded} file(s).`); setStep(job, 'upload', 'done');
        if (u.dir) try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch (e) { }
        baseDir = remotePath;
      }
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
      const source = u.git ? 'git' : 'folder';
      for (const s of plan.stacks) {
        const fileBase = path.posix.basename(s.composeFile);
        const subdir = path.posix.dirname(s.composeFile);
        const cwd = isRemote
          ? (subdir === '.' ? baseDir : baseDir.replace(/\/+$/, '') + '/' + subdir)
          : (subdir === '.' ? baseDir : path.join(baseDir, subdir));
        // Track EVERY selected stack (even when not run) so a STAGED deploy shows in the list and can be Up'd later.
        writeDeployMeta(s.name, isRemote
          ? { mode: 'remote', serverId, remotePath: cwd, composeFile: fileBase, source }
          : { mode: 'local', serverId: 'local', workingDir: cwd, composeFile: fileBase, source });
        if (!up) continue; // staged only — files are placed, nothing started
        current = 'stack:' + s.name; setStep(job, current, 'running'); job.phase = 'up';
        const upArgs = ['-f', fileBase, 'up', '-d'];
        if (s.build && !s.noCache) upArgs.push('--build');
        if (s.pull) upArgs.push('--pull', 'always');
        if (s.noDeps) upArgs.push('--no-deps');
        if (Array.isArray(s.services) && s.services.length) upArgs.push(...s.services);
        jobLog(job, `\n$ [${s.name}] docker compose ${upArgs.join(' ')}`);
        if (isRemote) {
          if (s.build && s.noCache) await remoteCompose.runComposeInRemoteDir(server, cwd, s.name, ['-f', fileBase, 'build', '--no-cache', ...(s.services || [])], stream);
          await remoteCompose.runComposeInRemoteDir(server, cwd, s.name, upArgs, stream);
        } else {
          if (s.build && s.noCache) await runCompose(s.name, ['-f', fileBase, 'build', '--no-cache', ...(s.services || [])], cwd, stream);
          await runCompose(s.name, upArgs, cwd, stream);
        }
        setStep(job, current, 'done'); deployed.push(s.name);
      }
      const allNames = plan.stacks.map(s => s.name);
      job.result = { plan: true, staged: !up, stacks: up ? deployed : allNames, nets: plan.createNets || [] };
      if (!up) jobLog(job, `\n✓ Staged ${allNames.length} stack(s) — not started. Deploy each from the Compose list (Up) when ready.`);
      logAction({ sourceIp: reqIp, server: isRemote ? serverId : undefined, resourceId: u.project, resourceType: 'compose', resourceName: u.project, action: up ? 'deploy-folder-plan' : 'stage-folder-plan', details: { stacks: allNames, nets: plan.createNets || [], staged: !up } });
    } else if (isRemote) {
      const { remotePath, update } = u.deploy;
      writeDeployMeta(u.project, { mode: 'remote', serverId, remotePath, composeFile, source: u.git ? 'git' : 'folder' });
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
      // Local, single (non-plan) deploy → record the pointer so it shows as git/folder-managed (badge, Pull, delete-files).
      writeDeployMeta(u.project, { mode: 'local', serverId: 'local', workingDir: baseDir, composeFile, source: u.git ? 'git' : 'folder' });
      if (up) {
        const upArgs = (u.git || u.redeploy || isUpdate) ? ['up', '-d', '--build', '--force-recreate'] : ['up', '-d'];
        current = 'deploy'; setStep(job, 'deploy', 'running'); job.phase = 'up'; jobLog(job, `$ docker compose ${upArgs.join(' ')}`); await runCompose(u.project, upArgs, baseDir, stream); setStep(job, 'deploy', 'done');
      }
      job.result = { composeFile };
      logAction({ sourceIp: reqIp, resourceId: u.project, resourceType: 'compose', resourceName: u.project, action: 'deploy-folder', details: { files: u.files, composeFile } });
    }
    // Git-sourced deploy → remember the repo + the deployed plan so Redeploy can re-clone + re-apply it.
    if (u.git) {
      fs.mkdirSync(managedDir(u.project), { recursive: true });
      const gitComposeFile = plan ? ((plan.stacks[0] && plan.stacks[0].composeFile) || composeFile) : composeFile;
      // Record the commit we just deployed → the baseline a future redeploy diffs against ("what changed").
      let deployedCommit = u.git.deployedCommit || '';
      try { if (u.dir) deployedCommit = (await gitRun(['-C', u.dir, 'rev-parse', 'HEAD'])).stdout.trim() || deployedCommit; } catch (e) { }
      fs.writeFileSync(gitMetaPath(u.project), JSON.stringify({ ...u.git, serverId: isRemote ? serverId : 'local', deployedCommit, plan: plan || null, deployMode: isRemote ? 'remote' : 'local', remotePath: isRemote ? u.deploy.remotePath : '', composeFile: gitComposeFile }, null, 2), { mode: 0o600 });
    }
    job.phase = 'done'; job.status = 'done'; jobLog(job, '✓ Done'); job.finishedAt = Date.now();
  } catch (err) {
    if (current) setStep(job, current, 'failed');
    job.status = 'error'; job.phase = 'error'; job.error = (err.stderr || err.message || 'deploy failed').toString();
    jobLog(job, '✗ ' + job.error); job.finishedAt = Date.now();
    try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch (e) { }
  }
}

// Background worker for Git deploy — native git clone on host/remote → docker compose up, with live status.
async function runGitDeployJob(job, p) {
  const stream = (c) => jobStream(job, c);
  let current = null;
  const server = remoteCompose.getActiveRemoteServer();
  const isRemote = !!server;
  const serverId = isRemote ? dockerService.getActiveServerId() : 'local';

  job.steps = [{ id: 'clone', label: isRemote ? 'git clone (on server)' : 'git clone', status: 'pending' }];
  if (p.up) job.steps.push({ id: 'up', label: 'docker compose up -d', status: 'pending' });

  try {
    const relSub = safeRelPath(p.subdir);
    let composeFile = '';
    let deployedCommit = '';
    let remotePath = '';

    if (isRemote) {
      remotePath = await remoteCompose.resolveRemotePath(server, p.remotePath || `~/.dockgate/projects/${p.project}`);
      current = 'clone'; setStep(job, 'clone', 'running'); job.phase = 'clone';
      jobLog(job, `[${server.host}] $ git clone ${p.branch ? '-b ' + p.branch + ' ' : ''}${redactToken(p.repoUrl, p.token)} ${remotePath}\n`);

      // Ensure directory is clean and ready on remote server
      await remoteCompose.execRemote(server, `mkdir -p ${remoteCompose.shq(path.posix.dirname(remotePath))}`);
      await remoteCompose.execRemote(server, `rm -rf ${remoteCompose.shq(remotePath)}`);

      const cloneArgs = ['clone', '--depth', '1', '--progress'];
      if (p.branch) cloneArgs.push('--branch', p.branch);
      cloneArgs.push(p.keyId ? p.repoUrl : gitUrlWithToken(p.repoUrl, p.token), remotePath);

      await remoteCompose.runGitOnRemote(server, p.keyId, null, cloneArgs, stream);
      await persistSshConfigForRepo(server, remotePath, p.keyId);
      setStep(job, 'clone', 'done'); current = null;

      const projectDir = relSub ? path.posix.join(remotePath, relSub) : remotePath;
      const { files } = await remoteScanComposeFiles(server, projectDir, { maxdepth: 4 });
      const foundCompose = files.find(f => COMPOSE_FILENAMES.includes(f.path)) || files[0];
      if (!foundCompose) throw Object.assign(new Error(`No compose file (docker-compose.yml or *.yml with "services:") in the repo${relSub ? ' subdir "' + relSub + '"' : ''}`), { statusCode: 400 });
      composeFile = foundCompose.path;

      try {
        deployedCommit = (await remoteCompose.runGitOnRemote(server, null, remotePath, ['rev-parse', 'HEAD'])).trim();
      } catch (e) { }

      fs.mkdirSync(managedDir(p.project), { recursive: true });
      fs.writeFileSync(gitMetaPath(p.project), JSON.stringify({ repoUrl: p.repoUrl, branch: p.branch, token: p.keyId ? '' : p.token, keyId: p.keyId || '', subdir: relSub, composeFile, secret: p.secret, deployedCommit, serverId, deployMode: 'remote', remotePath }, null, 2), { mode: 0o600 });
      writeDeployMeta(p.project, { mode: 'remote', serverId, remotePath, composeFile, source: 'git' });

      if (p.up) {
        current = 'up'; setStep(job, 'up', 'running'); job.phase = 'up';
        jobLog(job, `\n[${server.host}] $ docker compose -f ${composeFile} up -d\n`);
        await remoteCompose.runComposeInRemoteDir(server, projectDir, p.project, ['-f', path.posix.basename(composeFile), 'up', '-d'], stream);
        setStep(job, 'up', 'done');
      }
    } else {
      const dir = managedDir(p.project);
      fs.rmSync(dir, { recursive: true, force: true });
      current = 'clone'; setStep(job, 'clone', 'running'); job.phase = 'clone';
      jobLog(job, `$ git clone ${p.branch ? '-b ' + p.branch + ' ' : ''}${redactToken(p.repoUrl, p.token)}\n`);
      const cloneArgs = ['clone', '--depth', '1', '--progress'];
      if (p.branch) cloneArgs.push('--branch', p.branch);
      cloneArgs.push(p.keyId ? p.repoUrl : gitUrlWithToken(p.repoUrl, p.token), dir);
      await gitWithKey(p.keyId, cloneArgs, { onData: stream });
      await persistSshConfigForRepo(null, dir, p.keyId);
      setStep(job, 'clone', 'done'); current = null;

      const projectDir = relSub ? path.join(dir, relSub) : dir;
      composeFile = findComposeFile(projectDir);
      if (!composeFile) { const found = findComposeFiles(projectDir); if (found.length) composeFile = found[0]; }
      if (!composeFile) throw Object.assign(new Error(`No compose file (docker-compose.yml or any *.yml with "services:") in the repo${relSub ? ' subdir "' + relSub + '"' : ''}`), { statusCode: 400 });

      try { deployedCommit = (await gitRun(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim(); } catch (e) { }
      fs.writeFileSync(gitMetaPath(p.project), JSON.stringify({ repoUrl: p.repoUrl, branch: p.branch, token: p.keyId ? '' : p.token, keyId: p.keyId || '', subdir: relSub, composeFile, secret: p.secret, deployedCommit, serverId: 'local', deployMode: 'local' }, null, 2), { mode: 0o600 });
      try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: projectDir }); }
      catch (e) { throw Object.assign(new Error('Invalid compose file: ' + (e.stderr || e.message)), { statusCode: 400 }); }

      writeDeployMeta(p.project, { mode: 'local', serverId: 'local', workingDir: projectDir, composeFile, source: 'git' });
      if (p.up) {
        current = 'up'; setStep(job, 'up', 'running'); job.phase = 'up';
        jobLog(job, '\n$ docker compose -f ' + composeFile + ' up -d\n');
        await runCompose(p.project, ['-f', composeFile, 'up', '-d'], projectDir, stream);
        setStep(job, 'up', 'done');
      }
    }

    job.result = { composeFile, webhookSecret: p.secret };
    job.phase = 'done'; job.status = 'done'; jobLog(job, '✓ Done'); job.finishedAt = Date.now();
    logAction({ sourceIp: p.reqIp, server: serverId, resourceId: p.project, resourceType: 'compose', resourceName: p.project, action: 'deploy-git', details: { repoUrl: p.repoUrl, branch: p.branch || 'default', auth: p.keyId ? 'ssh-key' : (p.token ? 'token' : 'public') } });
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
      // ADOPTED projects point at the USER'S OWN folder — re-uploading (and especially clean-replace, which
      // rm -rf's remotePath first) would destroy their files. Never update an adopted project in place; the
      // guard here mirrors the DELETE guard so no path can rm -rf an adopted folder. Edit on the server instead.
      if (meta.source === 'adopt') return res.status(400).json({ error: 'This project was adopted in place — DockGate never re-uploads or cleans an adopted folder. Edit the files on the server directly.' });
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
      return res.status(400).json({ error: 'Folder exceeds the 1GB upload limit — use pre-built images or git-based deploy for large projects' });
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
        if (u.remoteReady) {
          s.composeFile = rel || path.posix.basename(s.composeFile || 'docker-compose.yml');
        } else {
          const abs = path.join(u.dir, rel);
          if (!rel || !(abs === u.dir || abs.startsWith(u.dir + path.sep)) || !fs.existsSync(abs)) throw Object.assign(new Error(`Compose file not found in upload: ${s.composeFile}`), { statusCode: 400 });
          s.composeFile = rel; // normalized POSIX-relative
          try { await execFileAsync('docker', ['compose', '-f', path.posix.basename(rel), 'config', '-q'], { cwd: path.join(u.dir, path.posix.dirname(rel)) }); }
          catch (e) { throw Object.assign(new Error(`Invalid compose (${rel}): ` + (e.stderr || e.message)), { statusCode: 400 }); }
        }
      }
      u.plan = { createNets: Array.isArray(plan.createNets) ? plan.createNets.filter(n => typeof n === 'string' && n) : [], stacks: plan.stacks };
      composeFile = plan.stacks[0].composeFile;
    } else if (u.remoteReady) {
      composeFile = u.composeFile || 'docker-compose.yml';
    } else {
      composeFile = findComposeFile(u.dir);
      if (!composeFile) {
        if (!up) {
          composeFile = 'compose.yaml';
          try { fs.writeFileSync(path.join(u.dir, composeFile), `# DockGate — ${u.project}\nservices:\n  app:\n    image: alpine\n    command: echo "Configure services in compose.yaml"\n`); } catch (e) { }
        } else {
          throw Object.assign(new Error('No docker-compose.yml (or compose.yaml) found in the folder'), { statusCode: 400 });
        }
      }
      // Validate synchronously if bringing up
      if (up && composeFile) {
        try { await execFileAsync('docker', ['compose', '-f', composeFile, 'config', '-q'], { cwd: u.dir }); }
        catch (e) { throw Object.assign(new Error(`Invalid compose file: ` + (e.stderr || e.message)), { statusCode: 400 }); }
      }
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
    if (u) {
      if (u.dir) try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch (e) { }
      if (u.remoteReady && u.deploy && u.deploy.server && u.deploy.remotePath) {
        remoteCompose.removeRemoteDir(u.deploy.server, u.deploy.remotePath).catch(() => { });
      }
      folderUploads.delete((req.body || {}).uploadId);
    }
    res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() });
  }
});

// Cancel/close mid-upload — drop the staging dir or remote staged folder.
router.post('/deploy-folder-abort', (req, res) => {
  const u = folderUploads.get((req.body || {}).uploadId);
  if (u) {
    if (u.dir) try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch (e) { }
    if (u.remoteReady && u.deploy && u.deploy.server && u.deploy.remotePath) {
      remoteCompose.removeRemoteDir(u.deploy.server, u.deploy.remotePath).catch(() => { });
    }
    folderUploads.delete((req.body || {}).uploadId);
  }
  res.json({ success: true });
});

// ---- Adopt from server (existing on-server folder) ----
// Register a compose file that ALREADY lives on the active remote host IN PLACE (a deploy-meta pointer at
// its own path, source:'adopt') — no upload, no copy. Bind-mounts + relative .env resolve exactly as a hand
// `docker compose up` in that folder would. Unlike Deploy-from-folder (uploads FROM the user's computer) and
// Deploy-from-git (clones), the files are the user's own — so DELETE must NEVER remove them (see the guard).

// Scan an arbitrary on-server ROOT for every compose file (name-agnostic: any *.yml/*.yaml with a top-level
// `services:`), returning each with its ABSOLUTE path + services. ONE bounded remote command (no per-file SSH
// fan-out → no pool exhaustion), depth/count-limited + `timeout`. Mirrors the remote branch of
// scanComposeFilesForRebuild, generalized to a caller-supplied root.
async function remoteScanComposeFiles(server, root, opts = {}) {
  const maxdepth = Math.min(Math.max(parseInt(opts.maxdepth, 10) || 6, 1), 12);
  const cap = Math.min(Math.max(parseInt(opts.cap, 10) || 80, 1), 200);
  const base = String(root).replace(/\/+$/, '') || '/';
  // ONE bounded remote command. For each candidate *.yml/*.yaml with a top-level `services:`, emit F:<path>
  // then J:<base64 of `docker compose config --format json`> — parsed in Node (robust; no fragile shell JSON)
  // to recover services + external networks + build flags, exactly like scanComposeFile does for local/folder.
  // Truncation is measured on the CANDIDATE stream (pre-filter): fetch cap+1 and emit T:1 if the extra exists.
  // `< /dev/null` stops `docker compose` from consuming the loop's stdin.
  const inner = `cd ${remoteCompose.shq(base)} 2>/dev/null && find . -maxdepth ${maxdepth} -type d \\( -name .git -o -name node_modules -o -name .next -o -name dist -o -name build -o -name .dockgate \\) -prune -o -type f \\( -name '*.yml' -o -name '*.yaml' \\) -print 2>/dev/null | head -$((${cap}+1)) | { i=0; while read f; do i=$((i+1)); if [ "$i" -gt ${cap} ]; then echo 'T:1'; break; fi; if head -c 65536 "$f" 2>/dev/null | grep -qE '^services:'; then echo "F:$f"; printf 'J:'; docker compose -f "$f" config --format json < /dev/null 2>/dev/null | base64 2>/dev/null | tr -d '\\n'; echo; fi; done; }`;
  const out = await remoteCompose.execRemote(server, 'timeout 120 sh -c ' + remoteCompose.shq(inner));
  const files = []; let cur = null, truncated = false;
  for (const line of String(out.stdout || '').split('\n')) {
    if (line === 'T:1') { truncated = true; continue; }
    if (line.startsWith('F:')) {
      const rel = line.slice(2).replace(/^\.\//, '');
      const absFile = path.posix.join(base, rel);
      cur = { absFile, dir: path.posix.dirname(absFile), path: rel, services: [], externalNets: [], hasBuild: false, parseError: null };
      files.push(cur);
    } else if (line.startsWith('J:') && cur) {
      try {
        const cfg = JSON.parse(Buffer.from(line.slice(2).trim(), 'base64').toString('utf8'));
        const svc = cfg.services || {};
        cur.services = Object.keys(svc);
        cur.hasBuild = cur.services.some(s => svc[s] && svc[s].build);
        const nets = cfg.networks || {};
        cur.externalNets = Object.entries(nets).filter(([, v]) => v && v.external).map(([k, v]) => (v && v.name) || k);
      } catch (e) { cur.parseError = 'compose config could not be parsed (unresolved ${VAR} / missing .env?) — you can still adopt it'; }
      cur = null;
    }
  }
  files.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return { files, truncated };
}

// POST /adopt-scan { root, maxdepth?, cap? } → find compose files under an on-server folder, each annotated
// with a suggested unique project name, whether DockGate already manages that folder, and whether a compose
// project is already RUNNING there (so the UI can reuse its exact -p name and avoid a duplicate stack).
router.post('/adopt-scan', async (req, res) => {
  try {
    const server = remoteCompose.getActiveRemoteServer();
    if (!server) return res.status(400).json({ error: 'Adopt-from-server needs a remote SSH server active (the compose files live on the server).' });
    const root = String((req.body && req.body.root) || '').trim();
    if (!isSafeHostPath(root)) return res.status(400).json({ error: 'Invalid or unsafe folder path.' });
    if (!(await remoteCompose.checkComposeAvailable(server))) return res.status(400).json({ error: 'docker compose (v2) is not available on the remote host.' });
    const { files, truncated } = await remoteScanComposeFiles(server, root, req.body || {});

    const activeId = dockerService.getActiveServerId();
    const managedByDir = new Map();          // remote folder (normalized) → managing project name (on this server)
    const reserved = new Set();              // names already taken: managed-here + EVERY running project
    if (fs.existsSync(COMPOSE_DIR)) for (const name of fs.readdirSync(COMPOSE_DIR)) {
      if (!validateProjectName(name)) continue;
      reserved.add(name); // COMPOSE_DIR is a GLOBAL namespace — a managed project of ANY mode/server takes the name
      const meta = readDeployMeta(name);
      if (meta && meta.mode === 'remote' && meta.serverId === activeId && meta.remotePath) managedByDir.set(String(meta.remotePath).replace(/\/+$/, ''), name);
    }
    let running = [];
    try { running = await dockerService.listComposeProjects(); } catch (e) { /* daemon list is best-effort for badges */ }
    const runningByDir = new Map();
    running.forEach(p => { reserved.add(p.name); if (p.workingDir) runningByDir.set(String(p.workingDir).replace(/\/+$/, ''), p.name); });

    const sanitize = (s) => (String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project');
    const uniq = (b) => { let n = b, i = 2; while (reserved.has(n)) n = `${b}-${i++}`; reserved.add(n); return n; };
    for (const f of files) {
      const dirNorm = String(f.dir).replace(/\/+$/, '');
      f.alreadyManaged = managedByDir.get(dirNorm) || null;   // project name already pointing at this folder
      f.runningProject = runningByDir.get(dirNorm) || null;   // a compose project already up in this folder
      // (1) already-managing name → idempotent re-adopt; (2) the EXACT -p name of a project running in THIS
      // folder → Up/Down hit the same containers (no duplicate stack); (3) else the folder basename, uniquified
      // against managed + running names so it never clashes with an unrelated project.
      f.suggestedName = f.alreadyManaged || f.runningProject || uniq(sanitize(path.posix.basename(dirNorm)));
    }
    res.json({ root, files, truncated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /adopt-finish { up, createNets, stacks:[{ name, composeFile(ABSOLUTE), services, build, noCache, pull, noDeps }] }
// Registers each selected compose file as an adopted project (pointer at its own folder) and — if up — runs
// `docker compose up -d [...]` in that folder over SSH. Per-stack isolation: one failure never blocks the rest.
router.post('/adopt-finish', async (req, res) => {
  try {
    gcDeployJobs();
    const server = remoteCompose.getActiveRemoteServer();
    if (!server) return res.status(400).json({ error: 'Adopt-from-server needs a remote SSH server active.' });
    const serverId = dockerService.getActiveServerId();
    const up = !!(req.body && req.body.up);
    const createNets = (Array.isArray(req.body && req.body.createNets) ? req.body.createNets : []).filter(n => /^[a-zA-Z0-9._-]+$/.test(n));
    const rawStacks = (req.body && Array.isArray(req.body.stacks)) ? req.body.stacks : [];

    const stacks = [];
    const seen = new Set();
    for (const s of rawStacks) {
      if (!s || typeof s.composeFile !== 'string' || !isSafeHostPath(s.composeFile)) return res.status(400).json({ error: 'A selected compose file has an invalid or unsafe path.' });
      const name = String(s.name || '').trim();
      if (!validateProjectName(name)) return res.status(400).json({ error: `Invalid project name: "${name}" (only a-z, 0-9, _, -).` });
      if (seen.has(name)) return res.status(400).json({ error: `Duplicate project name in the selection: "${name}".` });
      seen.add(name);
      // Re-validate uniqueness vs an EXISTING project — allow only an idempotent re-adopt of the SAME folder.
      const existing = readDeployMeta(name);
      const wantDir = path.posix.dirname(s.composeFile).replace(/\/+$/, '');
      if (existing && !(existing.mode === 'remote' && existing.serverId === serverId && String(existing.remotePath).replace(/\/+$/, '') === wantDir)) {
        return res.status(409).json({ error: `A different project named "${name}" already exists — rename this one.` });
      }
      stacks.push({ name, composeFile: s.composeFile, services: parseServices(s.services), build: !!s.build, noCache: !!s.noCache, pull: !!s.pull, noDeps: !!s.noDeps });
    }
    if (!stacks.length) return res.status(400).json({ error: 'No valid compose files selected.' });

    const job = { id: crypto.randomBytes(8).toString('hex'), project: stacks.map(s => s.name).join(', '), status: 'running', phase: 'starting', log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null, steps: [] };
    for (const n of createNets) job.steps.push({ id: 'net:' + n, label: 'Ensure network ' + n, status: 'pending' });
    for (const s of stacks) job.steps.push({ id: 'stack:' + s.name, label: (up ? 'Adopt & deploy ' : 'Track ') + s.name, status: 'pending' });
    deployJobs.set(job.id, job);
    runAdoptJob(job, { server, serverId, up, createNets, stacks, reqIp: req.ip });
    res.json({ jobId: job.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Worker: per-stack, write the in-place pointer then (optionally) run compose in the stack's own remote folder.
// This is runDeployJob's per-stack loop MINUS the upload step (files already on the server), mirroring
// runRebuildPlanJob's remote path. A stack whose `up` fails still keeps its pointer, so it lists as DOWN.
async function runAdoptJob(job, p) {
  const stream = (c) => jobStream(job, c);
  const deploy = { mode: 'remote', server: p.server };
  try {
    for (const netName of p.createNets) {
      setStep(job, 'net:' + netName, 'running'); job.phase = 'network'; jobLog(job, `\n$ ensure network ${netName}`);
      try { await ensureNetwork(deploy, netName, stream); } catch (e) { jobLog(job, `\nnetwork ${netName}: ${e.message}`); }
      setStep(job, 'net:' + netName, 'done');
    }
    const tracked = [], deployed = [], failed = [];
    for (const s of p.stacks) {
      const cwd = path.posix.dirname(s.composeFile);
      const fileBase = path.posix.basename(s.composeFile);
      setStep(job, 'stack:' + s.name, 'running');
      try {
        // In-place pointer. source:'adopt' → the DELETE guard refuses to remove the user's own folder.
        writeDeployMeta(s.name, { mode: 'remote', serverId: p.serverId, remotePath: cwd, composeFile: fileBase, source: 'adopt' });
        tracked.push(s.name);
        if (p.up) {
          job.phase = 'up';
          const upArgs = ['-f', fileBase, 'up', '-d'];
          if (s.build && !s.noCache) upArgs.push('--build');
          if (s.pull) upArgs.push('--pull', 'always');
          if (s.noDeps) upArgs.push('--no-deps');
          if (s.services.length) upArgs.push(...s.services);
          jobLog(job, `\n$ [${s.name}] docker compose ${upArgs.join(' ')}`);
          if (s.build && s.noCache) await remoteCompose.runComposeInRemoteDir(p.server, cwd, s.name, ['-f', fileBase, 'build', '--no-cache', ...s.services], stream);
          await remoteCompose.runComposeInRemoteDir(p.server, cwd, s.name, upArgs, stream);
          deployed.push(s.name);
        }
        setStep(job, 'stack:' + s.name, 'done');
      } catch (e) {
        // Pointer is already written → the stack still lists (DOWN) and can be started later. Isolate the failure.
        failed.push(s.name);
        setStep(job, 'stack:' + s.name, 'failed');
        jobLog(job, `\n✗ [${s.name}] ${(e.stderr || e.message || 'failed').toString()}`);
      }
    }
    job.result = { adopt: true, up: p.up, tracked, deployed, failed };
    // tracked = pointers written (a failed-`up` stack is still tracked → lists as DOWN, startable later).
    const parts = [`${tracked.length} adopted`];
    if (p.up) parts.push(`${deployed.length} deployed`);
    if (failed.length) parts.push(`${failed.length} failed`);
    jobLog(job, `\n${failed.length ? '⚠' : '✓'} ${parts.join(' · ')}.`);
    job.status = failed.length ? 'error' : 'done'; job.phase = job.status; job.finishedAt = Date.now();
    logAction({ sourceIp: p.reqIp, server: p.serverId, resourceType: 'compose', resourceName: job.project, action: p.up ? 'adopt-deploy' : 'adopt-track', details: { tracked, deployed, failed, up: p.up } });
  } catch (err) {
    job.status = 'error'; job.phase = 'error'; job.error = (err.stderr || err.message || 'adopt failed').toString();
    jobLog(job, '\n✗ ' + job.error); job.finishedAt = Date.now();
  }
}

// Deploy from a Git repo (#2-B): clone → managed project → up. Stores repo/branch/token + a webhook
// secret for later re-deploys. Private repos: supply a token (embedded into the https URL; not logged).
// Scan a git repo for compose files BEFORE deploying — ephemeral shallow clone → list every compose file
// (with services), so the UI can let the user PICK which folder/compose instead of typing a subdir blind.
router.post('/deploy-git-scan', async (req, res) => {
  const { token = '', keyId = '', repoUrl, branch = '' } = req.body || {};
  try {
    const isSsh = /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(repoUrl || '');
    const isHttp = /^https?:\/\//i.test(repoUrl || '');
    if (!repoUrl || !(isHttp || isSsh)) return res.status(400).json({ error: 'A git URL is required' });
    if (keyId && !isSsh) return res.status(400).json({ error: 'With an SSH key, use the SSH clone URL (git@host:owner/repo.git)' });
    const tmp = path.join(STAGING_DIR, 'gitscan-' + crypto.randomBytes(10).toString('hex'));
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const cloneArgs = ['clone', '--depth', '1'];
      if (branch) cloneArgs.push('--branch', branch);
      cloneArgs.push(keyId ? repoUrl : gitUrlWithToken(repoUrl, token), tmp);
      try { await gitWithKey(keyId, cloneArgs); }
      catch (e) { return res.status(400).json({ error: 'git clone failed: ' + redactToken(e.stderr || e.message, token) }); }
      const files = findComposeFiles(tmp);
      const scanned = [];
      for (const f of files) scanned.push(await scanComposeFile(tmp, f));
      res.json({ files: scanned });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } catch (err) { res.status(500).json({ error: redactToken(err.message, token) }); }
});

// Step 1 of the unified Git deploy (same pipeline as folder deploy): clone the repo into a staging
// session, scan it for ALL compose files, and return them so the UI can show the "Choose what to deploy"
// picker (multi-stack). Step 2 is the shared POST /deploy-folder-finish with the chosen plan.
router.post('/deploy-git-prepare', async (req, res) => {
  const { token = '', keyId = '', repoUrl, branch = '', project, target } = req.body || {};
  try {
    gcFolderUploads();
    if (!validateProjectName(project || '')) return res.status(400).json({ error: 'Invalid project name (a-z, 0-9, _, -)' });
    const isHttp = /^https?:\/\//i.test(repoUrl || '');
    const isSsh = /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(repoUrl || '');
    if (!repoUrl || !(isHttp || isSsh)) return res.status(400).json({ error: 'A git URL is required (https://… or git@host:owner/repo.git for an SSH key)' });
    if (keyId && !isSsh) return res.status(400).json({ error: 'With an SSH key, use the SSH clone URL (git@host:owner/repo.git)' });
    if (await dockerService.getComposeProject(project).then(p => p.total > 0).catch(() => false)) {
      return res.status(409).json({ error: `A project named "${project}" already exists`, projectExists: true, project });
    }
    const uploadId = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(18).toString('hex');

    // Remote server deploy -> clone directly ON THE REMOTE SERVER (native, superfast, no SFTP upload needed later!)
    if (target && target.mode === 'remote') {
      const server = remoteCompose.getActiveRemoteServer();
      if (!server) return res.status(400).json({ error: 'Remote deploy needs a remote SSH server active in the header.' });
      if (!(await remoteCompose.checkComposeAvailable(server))) return res.status(400).json({ error: 'docker compose (v2) is not available on the remote host — install it there first.' });

      const remotePath = await remoteCompose.resolveRemotePath(server, (target.remotePath || `~/.dockgate/projects/${project}`));
      const deploy = { mode: 'remote', server, remotePath, source: 'git', serverId: server.id };

      // Ensure directory is clean and ready on remote server
      await remoteCompose.execRemote(server, `mkdir -p ${remoteCompose.shq(path.posix.dirname(remotePath))}`);
      await remoteCompose.execRemote(server, `rm -rf ${remoteCompose.shq(remotePath)}`);

      const cloneArgs = ['clone', '--depth', '1'];
      if (branch) cloneArgs.push('--branch', branch);
      cloneArgs.push(keyId ? repoUrl : gitUrlWithToken(repoUrl, token), remotePath);

      // Clone natively ON THE REMOTE SERVER (superfast gigabit network!)
      await remoteCompose.runGitOnRemote(server, keyId, null, cloneArgs);

      // Scan compose files directly on the remote server
      const { files } = await remoteScanComposeFiles(server, remotePath, { maxdepth: 6 });
      let deployedCommit = '';
      try { deployedCommit = (await remoteCompose.runGitOnRemote(server, null, remotePath, ['rev-parse', 'HEAD'])).trim(); } catch (e) { }

      folderUploads.set(uploadId, { project, remoteReady: true, total: 0, files: 1, created: Date.now(), deploy, git: { repoUrl, branch, keyId: keyId || '', token: keyId ? '' : token, secret, deployedCommit, serverId: server.id } });
      return res.json({ uploadId, files, target: deploy.mode, remotePath: deploy.remotePath, webhookSecret: secret });
    }

    // Local daemon deploy:
    const dir = path.join(STAGING_DIR, `${project}-${uploadId}`);
    fs.mkdirSync(dir, { recursive: true });
    let deploy = { mode: 'local', source: 'git', serverId: 'local' };
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(keyId ? repoUrl : gitUrlWithToken(repoUrl, token), dir);
    try { await gitWithKey(keyId, cloneArgs); }
    catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return res.status(400).json({ error: 'git clone failed: ' + redactToken(e.stderr || e.message, token) }); }
    const files = findComposeFiles(dir);
    const scanned = [];
    for (const f of files) scanned.push(await scanComposeFile(dir, f));
    let deployedCommit = '';
    try { deployedCommit = (await gitRun(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim(); } catch (e) { }
    folderUploads.set(uploadId, { project, dir, total: 0, files: 1, created: Date.now(), deploy, git: { repoUrl, branch, keyId: keyId || '', token: keyId ? '' : token, secret, deployedCommit, serverId: 'local' } });
    res.json({ uploadId, files: scanned, target: deploy.mode, remotePath: deploy.remotePath, webhookSecret: secret });
  } catch (err) { res.status(500).json({ error: redactToken(err.message, token) }); }
});

router.post('/deploy-git', async (req, res) => {
  const { token = '' } = req.body || {};
  try {
    gcDeployJobs();
    const { project, repoUrl, branch = '', subdir = '', up = true, keyId = '', remotePath = '' } = req.body || {};
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
    runGitDeployJob(job, { project, repoUrl, branch, subdir, up, keyId, token, remotePath, secret, reqIp: req.ip });
    res.json({ jobId: job.id, project, webhookSecret: secret });
  } catch (err) { res.status(err.statusCode || 500).json({ error: redactToken(err.message, token) }); }
});

// Re-deploy a git project: fetch latest → hard reset → up --build (rebuild from new source).
// onData (optional) streams the git/compose output for a live console.
async function gitRedeploy(project, onData) {
  const meta = readGitMeta(project);
  if (!meta) { const e = new Error('Not a Git-managed project'); e.statusCode = 400; throw e; }
  const dm = readDeployMeta(project);
  const targetServerId = meta.serverId || (dm && dm.serverId);
  const wantRemote = (targetServerId && targetServerId !== 'local') || meta.deployMode === 'remote' || (dm && dm.mode === 'remote');
  let server = null;
  if (wantRemote) {
    if (targetServerId && targetServerId !== 'local') {
      const { stmts } = require('../db');
      server = stmts.getServer.get(targetServerId);
    }
    if (!server) server = remoteCompose.getActiveRemoteServer();
  }

  if (wantRemote && server) {
    const remotePath = meta.remotePath || (dm && dm.remotePath);
    const composeFile = meta.composeFile || 'docker-compose.yml';
    if (onData) onData(`[${server.host}] Fetching latest code on server...\n`);
    await persistSshConfigForRepo(server, remotePath, meta.keyId);
    await remoteCompose.runGitOnRemote(server, meta.keyId, remotePath, ['fetch', '--depth', '1', 'origin', meta.branch || 'HEAD'], onData);
    await remoteCompose.runGitOnRemote(server, meta.keyId, remotePath, ['reset', '--hard', 'FETCH_HEAD'], onData);
    const output = await remoteCompose.runComposeInRemoteDir(server, remotePath, project, ['up', '-d', '--build'], onData);
    return { output, composeFile };
  }

  const dir = managedDir(project);
  const projectDir = meta.subdir ? path.join(dir, meta.subdir) : dir;
  await persistSshConfigForRepo(null, dir, meta.keyId);
  await gitWithKey(meta.keyId, ['-C', dir, 'fetch', '--depth', '1', '--progress', 'origin', meta.branch || 'HEAD'], { onData });
  await gitWithKey(meta.keyId, ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], { onData });
  const composeFile = meta.composeFile || findComposeFile(projectDir);
  const output = await runCompose(project, ['up', '-d', '--build'], projectDir, onData);
  return { output, composeFile };
}

// Git info for a project (used by the UI to show redeploy + webhook). No token returned.
router.get('/:project/git', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const ctx = await resolveProjectGitContext(req.params.project);
    if (!ctx || !ctx.isGit) return res.json({ gitManaged: false });
    res.json({
      gitManaged: true,
      repoUrl: ctx.repoUrl,
      branch: ctx.branch || 'HEAD',
      subdir: ctx.subdir || '',
      hasToken: !!ctx.token,
      hasKey: !!ctx.keyId,
      webhookSecret: ctx.secret || '',
      serverId: ctx.serverId || 'local',
      type: ctx.type,
      repoRoot: ctx.repoRoot
    });
  } catch (err) { res.json({ gitManaged: false, error: (err.message || '').toString() }); }
});

// Cheap "is the repo ahead of what we deployed?" check via `git ls-remote` (no clone). Cached 5 min/project
// so the list can poll it without hammering the remote. Powers the "update" badge on git projects.
const gitStatusCache = new Map();
const GIT_STATUS_TTL = 5 * 60 * 1000;
router.get('/:project/git-status', async (req, res) => {
  const project = req.params.project;
  try {
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const ctx = await resolveProjectGitContext(project);
    if (!ctx || !ctx.isGit) return res.json({ gitManaged: false });
    const cached = gitStatusCache.get(project);
    if (cached && Date.now() - cached.at < GIT_STATUS_TTL && req.query.fresh !== '1') return res.json(cached.result);
    const deployedSHA = (ctx.deployedCommit || '').trim();
    const ref = (ctx.branch && ctx.branch !== 'HEAD') ? ctx.branch : 'HEAD';
    let remoteSHA = '';
    try {
      if (ctx.isRemote && ctx.server) {
        const out = await remoteCompose.runGitOnRemote(ctx.server, ctx.keyId || null, ctx.repoRoot, ['ls-remote', 'origin', ref]);
        remoteSHA = ((String(out || '').split('\n').find(Boolean) || '').split(/\s+/)[0] || '').trim();
      } else {
        const url = ctx.keyId ? ctx.repoUrl : (ctx.token ? gitUrlWithToken(ctx.repoUrl, ctx.token) : ctx.repoUrl || 'origin');
        const out = (await gitWithKey(ctx.keyId || null, ['-C', ctx.repoRoot, 'ls-remote', url, ref])).stdout || '';
        remoteSHA = ((out.split('\n').find(Boolean) || '').split(/\s+/)[0] || '').trim();
      }
    } catch (e) { /* unreachable / auth — report unknown, not behind */ }
    const result = { gitManaged: true, deployedSHA, remoteSHA, hasBaseline: !!deployedSHA, behind: !!(deployedSHA && remoteSHA && deployedSHA !== remoteSHA) };
    gitStatusCache.set(project, { at: Date.now(), result });
    res.json(result);
  } catch (err) { res.json({ gitManaged: false, error: (err.message || '').toString() }); }
});

// Re-deploy a Git project: re-clone fresh → re-apply the stored plan/compose (re-transfer for remote) via
// Stream "what changed since the last deploy" into a job's console: the file list (added/modified/deleted)
// + line stat, computed from the freshly-cloned repo (`dir`) vs the commit we last deployed (meta.deployedCommit).
// Best-effort — never throws (the deploy must proceed regardless).
async function streamGitChanges(job, dir, meta) {
  let newSHA = '';
  try { newSHA = (await gitRun(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim(); } catch (e) { return; }
  const oldSHA = (meta.deployedCommit || '').trim();
  if (!oldSHA) { jobLog(job, `\nℹ️  First tracked deploy — baseline ${newSHA.slice(0, 7)} recorded; changed files will show from the next redeploy.`); return; }
  if (oldSHA === newSHA) { jobLog(job, `\n✓ Already at the latest commit ${newSHA.slice(0, 7)} — nothing new pulled.`); return; }
  // The shallow clone only has HEAD; bring in the old commit's tree so we can diff against it.
  const url = meta.keyId ? meta.repoUrl : gitUrlWithToken(meta.repoUrl, meta.token);
  try { await gitWithKey(meta.keyId, ['-C', dir, 'fetch', '--depth', '1', url, oldSHA]); } catch (e) { }
  let names = '', stat = '';
  try { names = (await gitRun(['-C', dir, 'diff', '--name-status', oldSHA, newSHA])).stdout.trim(); } catch (e) { }
  try { stat = (await gitRun(['-C', dir, 'diff', '--shortstat', oldSHA, newSHA])).stdout.trim(); } catch (e) { }
  jobLog(job, `\n📦 Changes pulled (${oldSHA.slice(0, 7)} → ${newSHA.slice(0, 7)}):`);
  if (names) {
    const icon = s => s.startsWith('A') ? '✚' : s.startsWith('D') ? '🗑' : s.startsWith('R') ? '➟' : '✎';
    for (const line of names.split('\n')) {
      const parts = line.split('\t');
      jobLog(job, `   ${icon(parts[0])} ${parts.slice(1).join(' → ')}`);
    }
    if (stat) jobLog(job, `  ${stat}`);
  } else {
    jobLog(job, `   (couldn't compute a file diff — the old commit may be gone after a force-push/rebase)`);
  }
}

// the shared runDeployJob → live console. Works for single AND multi-stack git deploys.
function gitRedeployJob(project, reqIp) {
  const meta = readGitMeta(project);
  if (!meta) { const e = new Error('Not a Git-managed project'); e.statusCode = 400; throw e; }
  gcDeployJobs();
  const dm = readDeployMeta(project);
  const targetServerId = meta.serverId || (dm && dm.serverId);
  const wantRemote = (targetServerId && targetServerId !== 'local') || meta.deployMode === 'remote' || (dm && dm.mode === 'remote');

  const job = { id: crypto.randomBytes(8).toString('hex'), project, status: 'running', phase: 'starting', log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null };
  deployJobs.set(job.id, job);

  (async () => {
    try {
      if (wantRemote) {
        let server = null;
        if (targetServerId && targetServerId !== 'local') {
          const { stmts } = require('../db');
          server = stmts.getServer.get(targetServerId);
        }
        if (!server) server = remoteCompose.getActiveRemoteServer();
        if (!server) throw Object.assign(new Error(`Target server ("${targetServerId || 'unknown'}") was not found in the database.`), { statusCode: 400 });

        const remotePath = await remoteCompose.resolveRemotePath(server, meta.remotePath || (dm && dm.remotePath) || `~/.dockgate/projects/${project}`);
        const composeFile = meta.composeFile || 'docker-compose.yml';
        const relSub = safeRelPath(meta.subdir);
        const projectDir = relSub ? path.posix.join(remotePath, relSub) : remotePath;
        const branch = meta.branch || 'HEAD';
        const url = meta.keyId ? meta.repoUrl : gitUrlWithToken(meta.repoUrl, meta.token);

        job.phase = 'pull';
        jobLog(job, `[${server.host}] $ git fetch --depth 1 origin ${branch}\n`);
        await remoteCompose.runGitOnRemote(server, meta.keyId, remotePath, ['fetch', '--depth', '1', '--progress', 'origin', branch], (c) => jobStream(job, c));

        const fromSHA = (meta.deployedCommit || '').trim();
        let toSHA = '';
        try { toSHA = (await remoteCompose.runGitOnRemote(server, null, remotePath, ['rev-parse', 'FETCH_HEAD'])).trim(); } catch (e) { }

        // Reset to FETCH_HEAD
        jobLog(job, `\n[${server.host}] $ git reset --hard FETCH_HEAD\n`);
        await remoteCompose.runGitOnRemote(server, meta.keyId, remotePath, ['reset', '--hard', 'FETCH_HEAD'], (c) => jobStream(job, c));

        // Diff output if we had a baseline
        if (fromSHA && toSHA && fromSHA !== toSHA) {
          try {
            await remoteCompose.runGitOnRemote(server, meta.keyId, remotePath, ['fetch', '--depth', '1', url, fromSHA]);
            const names = (await remoteCompose.runGitOnRemote(server, null, remotePath, ['diff', '--name-status', fromSHA, toSHA])).trim();
            const stat = (await remoteCompose.runGitOnRemote(server, null, remotePath, ['diff', '--shortstat', fromSHA, toSHA])).trim();
            jobLog(job, `\n📦 Changes pulled (${fromSHA.slice(0, 7)} → ${toSHA.slice(0, 7)}):\n`);
            if (names) {
              const icon = s => s.startsWith('A') ? '✚' : s.startsWith('D') ? '🗑' : s.startsWith('R') ? '➟' : '✎';
              for (const line of names.split('\n')) {
                const parts = line.split('\t');
                jobLog(job, `   ${icon(parts[0])} ${parts.slice(1).join(' → ')}\n`);
              }
            }
            if (stat) jobLog(job, `  ${stat}\n`);
          } catch (e) { }
        } else if (toSHA) {
          jobLog(job, `✓ At commit ${toSHA.slice(0, 7)}\n`);
        }

        // Persist updated commit & metadata
        fs.writeFileSync(gitMetaPath(project), JSON.stringify({ ...meta, serverId: server.id, deployedCommit: toSHA || fromSHA, deployMode: 'remote', remotePath }, null, 2), { mode: 0o600 });
        writeDeployMeta(project, { mode: 'remote', serverId: server.id, remotePath, composeFile, source: 'git' });

        // Run docker compose up -d --build
        job.phase = 'up';
        jobLog(job, `\n[${server.host}] $ docker compose -f ${composeFile} up -d --build\n`);
        await remoteCompose.runComposeInRemoteDir(server, projectDir, project, ['-f', path.posix.basename(composeFile), 'up', '-d', '--build', '--force-recreate'], (c) => jobStream(job, c));

        job.phase = 'done';
        job.status = 'done';
        jobLog(job, '\n✓ Redeploy completed successfully');
        job.finishedAt = Date.now();
        logAction({ sourceIp: reqIp, server: server.id, resourceId: project, resourceType: 'compose', resourceName: project, action: 'redeploy', details: { commit: toSHA } });
      } else {
        // Local redeploy
        const dir = path.join(STAGING_DIR, `${project}-${crypto.randomBytes(16).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true });
        let deploy = { mode: 'local', source: 'git' };
        const cloneArgs = ['clone', '--depth', '1', '--progress'];
        if (meta.branch) cloneArgs.push('--branch', meta.branch);
        cloneArgs.push(meta.keyId ? meta.repoUrl : gitUrlWithToken(meta.repoUrl, meta.token), dir);
        job.phase = 'clone'; jobLog(job, `$ git clone ${redactToken(meta.repoUrl, meta.token)}\n`);
        await gitWithKey(meta.keyId, cloneArgs, { onData: (c) => jobStream(job, c) });
        await streamGitChanges(job, dir, meta).catch(() => { });
        const u = { project, dir, files: 1, deploy, git: { repoUrl: meta.repoUrl, branch: meta.branch, keyId: meta.keyId, token: meta.token, secret: meta.secret, serverId: 'local' }, plan: meta.plan || null };
        await runDeployJob(job, u, meta.composeFile, true, reqIp);
      }
    } catch (err) {
      job.status = 'error'; job.phase = 'error'; job.error = redactToken((err.stderr || err.message || 'redeploy failed').toString(), meta.token); jobLog(job, '✗ ' + job.error); job.finishedAt = Date.now();
    }
  })();
  return job;
}

// Redeploy step 1 (change-aware): clone the latest with the project's STORED git creds, scan its compose
// files, and diff against the commit we last deployed → which stacks changed. The UI then shows the SAME
// "Choose what to deploy" picker (only changed stacks pre-selected) and finishes via /deploy-folder-finish.
router.post('/:project/redeploy-prepare', async (req, res) => {
  const project = req.params.project;
  try {
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const meta = readGitMeta(project);
    if (!meta) return res.status(400).json({ error: 'Not a Git-managed project' });
    gcFolderUploads();
    const dm = readDeployMeta(project);
    const targetServerId = meta.serverId || (dm && dm.serverId);
    const wantRemote = (targetServerId && targetServerId !== 'local') || meta.deployMode === 'remote' || (dm && dm.mode === 'remote');

    let deploy = { mode: 'local', source: 'git' };
    if (wantRemote) {
      let server = null;
      if (targetServerId && targetServerId !== 'local') {
        const { stmts } = require('../db');
        server = stmts.getServer.get(targetServerId);
      }
      if (!server) server = remoteCompose.getActiveRemoteServer();
      if (!server) return res.status(400).json({ error: `Target server ("${targetServerId || 'unknown'}") was not found in database.` });
      const remotePath = await remoteCompose.resolveRemotePath(server, meta.remotePath || (dm && dm.remotePath) || `~/.dockgate/projects/${project}`);
      deploy = { mode: 'remote', server, remotePath, source: 'git' };
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    const dir = path.join(STAGING_DIR, `${project}-${uploadId}`);
    fs.mkdirSync(dir, { recursive: true });
    const url = meta.keyId ? meta.repoUrl : gitUrlWithToken(meta.repoUrl, meta.token);
    const cloneArgs = ['clone', '--depth', '1'];
    if (meta.branch) cloneArgs.push('--branch', meta.branch);
    cloneArgs.push(url, dir);
    try { await gitWithKey(meta.keyId, cloneArgs); }
    catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return res.status(400).json({ error: 'git clone failed: ' + redactToken(e.stderr || e.message, meta.token) }); }
    const files = findComposeFiles(dir);
    const scanned = [];
    for (const f of files) scanned.push(await scanComposeFile(dir, f));
    // Diff vs the last-deployed commit → changed files → affected stacks (a compose whose folder has a change).
    const fromSHA = (meta.deployedCommit || '').trim();
    let toSHA = '', changedFiles = [], commits = [];
    try { toSHA = (await gitRun(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim(); } catch (e) { }
    if (fromSHA && toSHA && fromSHA !== toSHA) {
      try { await gitWithKey(meta.keyId, ['-C', dir, 'fetch', '--depth', '1', url, fromSHA]); } catch (e) { }
      try { const o = (await gitRun(['-C', dir, 'diff', '--name-only', fromSHA, toSHA])).stdout.trim(); changedFiles = o ? o.split('\n').map(s => s.trim()).filter(Boolean) : []; } catch (e) { }
      // The actual commits pulled (the "what/how") — deepen the branch so fromSHA..toSHA is walkable, then log. Best-effort.
      try { await gitWithKey(meta.keyId, ['-C', dir, 'fetch', '--depth', '200', url, meta.branch || toSHA]); } catch (e) { }
      try {
        const lo = (await gitRun(['-C', dir, 'log', '--pretty=format:%h\x1f%an\x1f%ad\x1f%s', '--date=short', `${fromSHA}..${toSHA}`])).stdout.trim();
        commits = lo ? lo.split('\n').map(l => { const p = l.split('\x1f'); return { hash: p[0], author: p[1], date: p[2], subject: p[3] }; }) : [];
      } catch (e) { }
    }
    // No baseline yet (project deployed before commit-tracking, or externally) → PERSIST the current
    // commit as the baseline so the NEXT pull can actually diff. (Pull never touches running containers;
    // this only sets the reference point. Without this, every pull was stuck on "first pull".)
    let baselineRecorded = false;
    if (!fromSHA && toSHA) {
      try { fs.writeFileSync(gitMetaPath(project), JSON.stringify({ ...meta, serverId: meta.serverId || (wantRemote ? targetServerId : 'local'), deployedCommit: toSHA }, null, 2), { mode: 0o600 }); baselineRecorded = true; } catch (e) { }
    }
    const affectedStacks = scanned.filter(s => {
      const d = s.dir === '.' ? '' : s.dir.replace(/\/+$/, '') + '/';
      return d === '' ? changedFiles.length > 0 : changedFiles.some(cf => cf.startsWith(d));
    }).map(s => s.path);
    const secret = meta.secret || crypto.randomBytes(18).toString('hex');
    folderUploads.set(uploadId, { project, dir, total: 0, files: 1, created: Date.now(), deploy, git: { repoUrl: meta.repoUrl, branch: meta.branch, keyId: meta.keyId || '', token: meta.keyId ? '' : (meta.token || ''), secret, serverId: meta.serverId || (wantRemote ? targetServerId : 'local') }, redeploy: true });
    res.json({
      uploadId, files: scanned, target: deploy.mode, remotePath: deploy.remotePath,
      diff: { fromSHA, toSHA, changedFiles, commits, affectedStacks, hasBaseline: !!fromSHA, baselineRecorded, upToDate: !!(fromSHA && toSHA && fromSHA === toSHA) }
    });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.message || 'redeploy prepare failed').toString() }); }
});

// Manual re-deploy → live per-step console.
router.post('/:project/redeploy', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const job = gitRedeployJob(req.params.project, req.ip);
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'redeploy' });
    res.json({ jobId: job.id, project: req.params.project });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() }); }
});

// Webhook: push-triggered re-deploy. Secured by the per-project secret in ?key= (no session needed).
// Automatically targets the server recorded in the project's metadata.
router.post('/webhook/:project', (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(404).json({ error: 'not found' });
    const meta = readGitMeta(req.params.project);
    if (!meta || !meta.secret || req.query.key !== meta.secret) return res.status(403).json({ error: 'invalid webhook key' });
    const job = gitRedeployJob(req.params.project, req.ip);
    logAction({ req, server: meta.serverId || 'local', resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'webhook-redeploy' });
    res.json({ success: true, jobId: job.id });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() }); }
});

// ============================================================================================
// Unified Git Context & External/Adopted Git Management
// ============================================================================================

// Docker labels (working_dir / config_files) are UNTRUSTED — anyone who can start a container can set
// them. Validate hard before a value reaches a shell, on top of shq() quoting.
function isSafeHostPath(p) {
  return typeof p === 'string' && p.length > 1 && p.length < 4096
    && p.startsWith('/') && !p.includes('..') && !/[\n\r\0]/.test(p) && /^[\w./@+ :=-]+$/.test(p);
}

// Run a git command in `cwd` on the project's host: local fs (server null) or the active remote (SSH).
// `args` are constant git tokens; `cwd` is validated. Returns stdout; throws (statusCode 400) on non-zero exit.
async function gitInDir(server, cwd, args, onData, keyId) {
  if (!server) {
    if (keyId) {
      return (await gitWithKey(keyId, ['-C', cwd, ...args])).stdout;
    }
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  return await remoteCompose.runGitOnRemote(server, keyId, cwd, args, onData);
}

// Persist SSH deploy key config into a repo's .git/config (core.sshCommand) so that
// `git pull` works BOTH from DockGate and from a manual terminal session on the server.
// Safe to call multiple times — idempotent.
async function persistSshConfigForRepo(server, repoRoot, keyId) {
  if (!keyId) return;
  try {
    if (server) {
      await remoteCompose.persistGitSshConfig(server, repoRoot, keyId);
    } else {
      const keyPath = sshKeys.persistDeployKey(keyId).replace(/\\/g, '/');
      const sshCmd = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
      await execFileAsync('git', ['-C', repoRoot, 'config', 'core.sshCommand', sshCmd], { env: GIT_ENV });
    }
  } catch (e) {
    console.warn('[git] Failed to persist SSH config for repo:', e.message);
  }
}

// Strip embedded credentials from a remote URL before display (https://user:tok@host → //***@host).
function redactRemoteUrl(u) { return String(u || '').replace(/\/\/[^@/]+@/, '//***@'); }

// Resolve complete Git context for ANY project (DockGate-managed, adopted from server, or external container).
async function resolveProjectGitContext(project) {
  if (!validateProjectName(project)) return { isGit: false, project };

  const activeServer = remoteCompose.getActiveRemoteServer();
  const activeId = dockerService.getActiveServerId();

  // 1) DockGate-managed Git metadata (.dockgate-git.json)
  const gm = readGitMeta(project);
  const dm = readDeployMeta(project);

  if (gm) {
    const targetServerId = gm.serverId || (dm && dm.serverId) || 'local';
    const wantRemote = (targetServerId && targetServerId !== 'local') || gm.deployMode === 'remote' || (dm && dm.mode === 'remote');
    let server = null;
    if (wantRemote) {
      if (targetServerId && targetServerId !== 'local') {
        const { stmts } = require('../db');
        server = stmts.getServer.get(targetServerId);
      }
      if (!server) server = activeServer;
    }
    const relSub = safeRelPath(gm.subdir);
    let repoRoot = '';
    if (wantRemote && server) {
      repoRoot = await remoteCompose.resolveRemotePath(server, gm.remotePath || (dm && dm.remotePath) || `~/.dockgate/projects/${project}`);
    } else {
      repoRoot = (dm && dm.workingDir) || managedDir(project);
    }
    const workingDir = relSub ? (wantRemote ? path.posix.join(repoRoot, relSub) : path.join(repoRoot, relSub)) : repoRoot;
    const composeFile = gm.composeFile || 'docker-compose.yml';
    return {
      isGit: true,
      type: 'managed',
      managed: true,
      project,
      repoRoot,
      workingDir,
      subdir: relSub,
      composeFile,
      branch: gm.branch || 'main',
      keyId: gm.keyId || '',
      token: gm.token || '',
      repoUrl: gm.repoUrl || '',
      secret: gm.secret || '',
      deployedCommit: (gm.deployedCommit || '').trim(),
      serverId: wantRemote && server ? server.id : 'local',
      server: wantRemote ? server : null,
      isRemote: wantRemote && !!server,
    };
  }

  // 2) Deploy metadata (.dockgate-deploy.json) — e.g. Adopted from server or Folder deploy
  if (dm) {
    const isRemote = dm.mode === 'remote';
    let server = null;
    if (isRemote) {
      if (dm.serverId && dm.serverId !== 'local') {
        const { stmts } = require('../db');
        server = stmts.getServer.get(dm.serverId);
      }
      if (!server) server = activeServer;
    }
    const candidatePath = isRemote ? dm.remotePath : (dm.workingDir || managedDir(project));
    if (candidatePath && (isRemote ? isSafeHostPath(candidatePath) : fs.existsSync(candidatePath))) {
      try {
        const root = (await gitInDir(server, candidatePath, ['rev-parse', '--show-toplevel'])).trim();
        if (root && isSafeHostPath(root)) {
          let branch = '';
          try { branch = (await gitInDir(server, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch (e) { }
          let repoUrl = '';
          try { repoUrl = redactRemoteUrl((await gitInDir(server, root, ['remote', 'get-url', 'origin'])).trim()); } catch (e) { }
          let deployedCommit = '';
          try { deployedCommit = (await gitInDir(server, root, ['rev-parse', 'HEAD'])).trim(); } catch (e) { }
          return {
            isGit: true,
            type: dm.source || 'adopt',
            managed: false,
            project,
            repoRoot: root,
            workingDir: candidatePath,
            subdir: root === candidatePath ? '' : (isRemote ? path.posix.relative(root, candidatePath) : path.relative(root, candidatePath)),
            composeFile: dm.composeFile || 'docker-compose.yml',
            branch: (!branch || branch === 'HEAD') ? 'HEAD' : branch,
            keyId: '',
            token: '',
            repoUrl,
            secret: '',
            deployedCommit,
            serverId: isRemote && server ? server.id : 'local',
            server: isRemote ? server : null,
            isRemote: isRemote && !!server,
          };
        }
      } catch (e) { /* not a git repo */ }
    }
  }

  // 3) Running Docker project container labels
  try {
    const proj = (await dockerService.listComposeProjects()).find(p => p.name === project);
    const wd = proj && proj.workingDir;
    if (wd && isSafeHostPath(wd)) {
      const server = activeServer;
      try {
        const root = (await gitInDir(server, wd, ['rev-parse', '--show-toplevel'])).trim();
        if (root && isSafeHostPath(root)) {
          let branch = '';
          try { branch = (await gitInDir(server, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch (e) { }
          let repoUrl = '';
          try { repoUrl = redactRemoteUrl((await gitInDir(server, root, ['remote', 'get-url', 'origin'])).trim()); } catch (e) { }
          let deployedCommit = '';
          try { deployedCommit = (await gitInDir(server, root, ['rev-parse', 'HEAD'])).trim(); } catch (e) { }
          const cfgFiles = String(proj.configFiles || '').split(',').map(s => s.trim()).filter(Boolean);
          const composeFile = cfgFiles.length ? path.posix.basename(cfgFiles[0]) : 'docker-compose.yml';
          return {
            isGit: true,
            type: 'external',
            managed: false,
            project,
            repoRoot: root,
            workingDir: wd,
            subdir: root === wd ? '' : (server ? path.posix.relative(root, wd) : path.relative(root, wd)),
            composeFile,
            branch: (!branch || branch === 'HEAD') ? 'HEAD' : branch,
            keyId: '',
            token: '',
            repoUrl,
            secret: '',
            deployedCommit,
            serverId: server ? server.id : 'local',
            server,
            isRemote: !!server,
          };
        }
      } catch (e) { /* not a git repo */ }
    }
  } catch (e) { }

  return { isGit: false, project };
}

// Probe whether `project` is a git checkout (managed, adopted, or external).
async function detectExternalGit(project) {
  const ctx = await resolveProjectGitContext(project);
  if (!ctx || !ctx.isGit) return { isGit: false, reason: 'Not a git checkout or working directory not found' };
  if (ctx.type === 'managed') return { managed: true, isGit: true };

  const server = ctx.server;
  const root = ctx.repoRoot;
  const out = {
    isGit: true,
    managed: false,
    remote: ctx.isRemote,
    repoRoot: root,
    workingDir: ctx.workingDir,
    configFiles: ctx.composeFile || '',
    branch: ctx.branch || '',
    remoteUrl: ctx.repoUrl || ''
  };
  out.detached = !out.branch || out.branch === 'HEAD';
  try { await gitInDir(server, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); out.hasUpstream = true; } catch (e) { out.hasUpstream = false; }
  let dirty = ''; try { dirty = (await gitInDir(server, root, ['status', '--porcelain'])).trim(); } catch (e) { }
  out.dirty = !!dirty;
  out.dirtyFiles = dirty ? dirty.split('\n').filter(Boolean).slice(0, 30) : [];
  out.canPull = !out.detached && !out.dirty;
  out.reason = out.detached ? 'Detached HEAD — pull unavailable'
    : out.dirty ? 'Uncommitted changes on the server — pull would not be safe (resolve them on the host first)'
      : '';
  return out;
}

// 90s cache keyed by active server + project
const externalGitCache = new Map();
function invalidateExternalGit(project) { externalGitCache.delete(dockerService.getActiveServerId() + ':' + project); }

router.get('/:project/git-detect', async (req, res) => {
  try {
    const project = req.params.project;
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const key = dockerService.getActiveServerId() + ':' + project;
    const cached = externalGitCache.get(key);
    if (cached && Date.now() - cached.at < 90000) return res.json(cached.result);
    const result = await detectExternalGit(project);
    externalGitCache.set(key, { at: Date.now(), result });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unified Git Pull (files-only — does NOT restart or redeploy containers)
router.post('/:project/git-pull', async (req, res) => {
  const project = req.params.project;
  try {
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const ctx = await resolveProjectGitContext(project);
    if (!ctx || !ctx.isGit) return res.status(400).json({ error: 'Not a Git-managed or Git-connected project' });

    const server = ctx.server;
    const root = ctx.repoRoot;
    const branch = ctx.branch || 'main';
    const keyId = ctx.keyId || null;
    const url = keyId ? ctx.repoUrl : gitUrlWithToken(ctx.repoUrl, ctx.token);
    const before = (await gitInDir(server, root, ['rev-parse', 'HEAD'], null, keyId)).trim();

    const force = req.body && (req.body.force === true || req.body.force === '1');

    // Ensure SSH key is persisted in the repo's .git/config so pull works
    await persistSshConfigForRepo(server, root, keyId);

    if (force) {
      if (ctx.type === 'managed') {
        if (ctx.isRemote && server) {
          await remoteCompose.runGitOnRemote(server, keyId, root, ['fetch', '--depth', '1', 'origin', branch]);
          await remoteCompose.runGitOnRemote(server, keyId, root, ['reset', '--hard', 'FETCH_HEAD']);
        } else {
          await gitWithKey(keyId, ['-C', root, 'fetch', '--depth', '1', 'origin', branch]);
          await gitWithKey(keyId, ['-C', root, 'reset', '--hard', 'FETCH_HEAD']);
        }
      } else {
        await gitInDir(server, root, ['fetch', '--all', '--quiet'], null, keyId);
        const targetRef = branch && branch !== 'HEAD' ? `origin/${branch}` : '@{u}';
        await gitInDir(server, root, ['reset', '--hard', targetRef], null, keyId);
      }
    } else {
      try {
        await gitInDir(server, root, ['pull'], null, keyId);
      } catch (e) {
        return res.status(409).json({ error: 'Git pull failed: ' + e.message + '. You may need to resolve conflicts manually on the server, or use ⚠️ Force Pull to overwrite local changes.' });
      }
    }

    const after = (await gitInDir(server, root, ['rev-parse', 'HEAD'], null, keyId)).trim();
    invalidateExternalGit(project);

    // If managed, persist the updated commit
    const meta = readGitMeta(project);
    if (meta) {
      fs.writeFileSync(gitMetaPath(project), JSON.stringify({ ...meta, deployedCommit: after }, null, 2), { mode: 0o600 });
    }

    let changed = [], commits = [];
    if (before !== after) {
      try {
        const diffOut = (await gitInDir(server, root, ['diff', '--name-status', before + '..' + after], null, keyId)).trim();
        changed = diffOut ? diffOut.split('\n').filter(Boolean).slice(0, 200) : [];
      } catch (e) { }
      try {
        const logOut = (await gitInDir(server, root, ['log', '--pretty=%h%x09%ad%x09%s', '--date=short', before + '..' + after], null, keyId)).trim();
        commits = logOut ? logOut.split('\n').filter(Boolean).slice(0, 100).map(l => {
          const parts = l.split('\t');
          return { hash: parts[0], date: parts[1], subject: parts.slice(2).join('\t') };
        }) : [];
      } catch (e) { }
    }

    logAction({
      req,
      server: server ? dockerService.getActiveServerId() : 'local',
      resourceId: project,
      resourceType: 'compose',
      resourceName: project,
      action: 'git-pull',
      details: { fromSHA: before, toSHA: after, files: changed.length, repoRoot: root }
    });

    res.json({
      success: true,
      repoRoot: root,
      fromSHA: before,
      toSHA: after,
      upToDate: before === after,
      changedFiles: changed,
      commits
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: (err.message || 'Git pull failed').toString() });
  }
});

// Unified Git Sync (Pull latest + docker compose up -d --build --force-recreate)
router.post('/:project/git-sync', async (req, res) => {
  const project = req.params.project;
  try {
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const force = !!(req.body && (req.body.force === true || req.body.force === '1'));
    const ctx = await resolveProjectGitContext(project);
    if (!ctx || !ctx.isGit) return res.status(400).json({ error: 'Not a Git-managed or Git-connected project' });

    if (ctx.type === 'managed') {
      const job = gitRedeployJob(project, req.ip);
      logAction({ req, resourceId: project, resourceType: 'compose', resourceName: project, action: force ? 'force-git-sync' : 'git-sync' });
      return res.json({ jobId: job.id, project });
    }

    // Adopted / external git project
    const r = await resolveComposeFiles(project);
    const server = ctx.server;
    const fileArgs = (r.files && r.files.length) ? r.files.flatMap(f => ['-f', f]) : ['-f', ctx.composeFile || 'docker-compose.yml'];
    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      project,
      status: 'running',
      phase: 'pull',
      log: '',
      error: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
      steps: [
        { id: 'pull', label: force ? 'git reset --hard' : 'git pull', status: 'pending' },
        { id: 'up', label: 'docker compose up -d --build --force-recreate', status: 'pending' }
      ],
    };
    deployJobs.set(job.id, job);

    (async () => {
      const stream = (c) => jobStream(job, c);
      try {
        setStep(job, 'pull', 'running');
        job.phase = 'pull';
        const root = ctx.repoRoot;
        const branch = ctx.branch || 'main';
        const keyId = ctx.keyId || null;
        const targetRef = branch && branch !== 'HEAD' ? `origin/${branch}` : '@{u}';

        jobLog(job, `$ git -C ${root} fetch --all\n`);
        await gitInDir(server, root, ['fetch', '--all', '--quiet'], stream, keyId);

        if (force) {
          jobLog(job, `$ git -C ${root} reset --hard ${targetRef}\n`);
          await gitInDir(server, root, ['reset', '--hard', targetRef], stream, keyId);
        } else {
          try {
            jobLog(job, `$ git -C ${root} merge --ff-only ${targetRef}\n`);
            await gitInDir(server, root, ['merge', '--ff-only', targetRef], stream, keyId);
          } catch (e) {
            jobLog(job, `Fast-forward failed, performing reset to ${targetRef}...\n`);
            await gitInDir(server, root, ['reset', '--hard', targetRef], stream, keyId);
          }
        }
        setStep(job, 'pull', 'done');

        setStep(job, 'up', 'running');
        job.phase = 'up';
        const upArgs = [...fileArgs, 'up', '-d', '--build', '--force-recreate'];
        const workingDir = r.cwd || ctx.workingDir;
        jobLog(job, `\n$ docker compose -p ${project} ${upArgs.join(' ')} (in ${workingDir})\n`);
        if (server) {
          await remoteCompose.runComposeInRemoteDir(server, workingDir, project, upArgs, stream);
        } else {
          await runCompose(project, upArgs, workingDir, stream);
        }
        setStep(job, 'up', 'done');

        invalidateExternalGit(project);
        job.phase = 'done';
        job.status = 'done';
        jobLog(job, '\n✓ Done');
        job.finishedAt = Date.now();
        logAction({ sourceIp: req.ip, server: server ? dockerService.getActiveServerId() : 'local', resourceId: project, resourceType: 'compose', resourceName: project, action: 'git-sync', details: { force } });
      } catch (err) {
        job.status = 'error';
        job.phase = 'error';
        job.error = (err.message || 'sync failed').toString();
        const cur = (job.steps || []).find(s => s.status === 'running');
        if (cur) cur.status = 'failed';
        jobLog(job, '\n✗ ' + job.error);
        job.finishedAt = Date.now();
      }
    })();

    res.json({ jobId: job.id, project });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || '').toString() });
  }
});

// Helper to collect all Git-connected projects (running + stopped/staged)
async function getAllGitProjects(activeId, server) {
  const seenNames = new Set();
  const candidates = [];

  // 1. Running projects from Docker daemon
  try {
    const running = await dockerService.listComposeProjects();
    for (const p of running) {
      if (validateProjectName(p.name)) {
        seenNames.add(p.name);
        candidates.push(p.name);
      }
    }
  } catch (e) { }

  // 2. Stopped / down projects in COMPOSE_DIR
  if (fs.existsSync(COMPOSE_DIR)) {
    for (const name of fs.readdirSync(COMPOSE_DIR)) {
      if (!validateProjectName(name) || seenNames.has(name)) continue;
      seenNames.add(name);
      candidates.push(name);
    }
  }

  const gitProjects = [];
  for (const name of candidates) {
    const ctx = await resolveProjectGitContext(name);
    if (ctx && ctx.isGit) {
      gitProjects.push({ name, ctx });
    }
  }
  return gitProjects;
}

// Global Git Pull All (files-only across all git-connected projects)
router.post('/git-pull-all', async (req, res) => {
  try {
    const activeId = dockerService.getActiveServerId();
    const server = remoteCompose.getActiveRemoteServer();
    const gitProjects = await getAllGitProjects(activeId, server);
    const results = [];

    for (const gp of gitProjects) {
      const ctx = gp.ctx;
      try {
        const root = ctx.repoRoot;
        const keyId = ctx.keyId || null;
        const branch = ctx.branch || 'main';
        const before = (await gitInDir(ctx.server, root, ['rev-parse', 'HEAD'], null, keyId)).trim();

        // Persist SSH config so pull works
        await persistSshConfigForRepo(ctx.server, root, keyId);

        // Native git pull (like single-project pull)
        const force = req.body && (req.body.force === true || req.body.force === '1');
        if (force) {
          await gitInDir(ctx.server, root, ['fetch', '--all', '--quiet'], null, keyId);
          const targetRef = branch && branch !== 'HEAD' ? `origin/${branch}` : '@{u}';
          await gitInDir(ctx.server, root, ['reset', '--hard', targetRef], null, keyId);
        } else {
          await gitInDir(ctx.server, root, ['pull'], null, keyId);
        }

        const after = (await gitInDir(ctx.server, root, ['rev-parse', 'HEAD'], null, keyId)).trim();
        invalidateExternalGit(gp.name);

        const meta = readGitMeta(gp.name);
        if (meta) {
          fs.writeFileSync(gitMetaPath(gp.name), JSON.stringify({ ...meta, deployedCommit: after }, null, 2), { mode: 0o600 });
        }

        // Collect changed files and commits (like single-project pull)
        let changedFiles = [], commits = [];
        if (before !== after) {
          try {
            const diffOut = (await gitInDir(ctx.server, root, ['diff', '--name-status', before + '..' + after], null, keyId)).trim();
            changedFiles = diffOut ? diffOut.split('\n').filter(Boolean).slice(0, 100) : [];
          } catch (e) {}
          try {
            const logOut = (await gitInDir(ctx.server, root, ['log', '--pretty=%h%x09%ad%x09%s', '--date=short', before + '..' + after], null, keyId)).trim();
            commits = logOut ? logOut.split('\n').filter(Boolean).slice(0, 50).map(l => {
              const parts = l.split('\t');
              return { hash: parts[0], date: parts[1], subject: parts.slice(2).join('\t') };
            }) : [];
          } catch (e) {}
        }

        results.push({ project: gp.name, path: root, fromSHA: before, toSHA: after, upToDate: before === after, success: true, changedFiles, commits });
      } catch (e) {
        results.push({ project: gp.name, path: ctx.repoRoot, error: e.message, success: false });
      }
    }
    res.json({ results, total: results.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Global Git Sync All (sequentially pulls & redeploys all git projects with live streaming console)
router.post('/git-sync-all', async (req, res) => {
  try {
    const activeId = dockerService.getActiveServerId();
    const server = remoteCompose.getActiveRemoteServer();
    const gitProjects = await getAllGitProjects(activeId, server);

    if (!gitProjects.length) return res.status(400).json({ error: 'No Git-connected compose projects found on this server.' });

    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      project: 'all-git-projects',
      status: 'running',
      phase: 'starting',
      log: '',
      error: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
      steps: gitProjects.map(g => ({ id: 'proj:' + g.name, label: `Sync ${g.name}`, status: 'pending' }))
    };
    deployJobs.set(job.id, job);

    (async () => {
      jobLog(job, `🚀 Starting Global Git Sync for ${gitProjects.length} project(s)...\n`);
      for (const gp of gitProjects) {
        const ctx = gp.ctx;
        setStep(job, 'proj:' + gp.name, 'running');
        jobLog(job, `\n========================================\n[${gp.name}] Starting Git Sync...\n========================================\n`);
        try {
          const root = ctx.repoRoot;
          const keyId = ctx.keyId || null;
          const branch = ctx.branch || 'main';
          const targetRef = branch && branch !== 'HEAD' ? `origin/${branch}` : '@{u}';

          jobLog(job, `Fetching latest code in ${root}...\n`);
          if (ctx.type === 'managed') {
            if (ctx.isRemote && ctx.server) {
              await remoteCompose.runGitOnRemote(ctx.server, keyId, root, ['fetch', '--depth', '1', 'origin', branch], (c) => jobStream(job, c));
              await remoteCompose.runGitOnRemote(ctx.server, keyId, root, ['reset', '--hard', 'FETCH_HEAD'], (c) => jobStream(job, c));
              let toSHA = '';
              try { toSHA = (await remoteCompose.runGitOnRemote(ctx.server, null, root, ['rev-parse', 'FETCH_HEAD'])).trim(); } catch (e) { }
              const meta = readGitMeta(gp.name);
              if (meta) fs.writeFileSync(gitMetaPath(gp.name), JSON.stringify({ ...meta, deployedCommit: toSHA || meta.deployedCommit }, null, 2), { mode: 0o600 });
              jobLog(job, `Running docker compose up -d --build...\n`);
              await remoteCompose.runComposeInRemoteDir(ctx.server, ctx.workingDir, gp.name, ['-f', path.posix.basename(ctx.composeFile), 'up', '-d', '--build', '--force-recreate'], (c) => jobStream(job, c));
            } else {
              await gitWithKey(keyId, ['-C', root, 'fetch', '--depth', '1', 'origin', branch], { onData: (c) => jobStream(job, c) });
              await gitWithKey(keyId, ['-C', root, 'reset', '--hard', 'FETCH_HEAD'], { onData: (c) => jobStream(job, c) });
              let toSHA = '';
              try { toSHA = (await gitRun(['-C', root, 'rev-parse', 'FETCH_HEAD'])).stdout.trim(); } catch (e) { }
              const meta = readGitMeta(gp.name);
              if (meta) fs.writeFileSync(gitMetaPath(gp.name), JSON.stringify({ ...meta, deployedCommit: toSHA || meta.deployedCommit }, null, 2), { mode: 0o600 });
              jobLog(job, `Running docker compose up -d --build in ${ctx.workingDir}...\n`);
              await runCompose(gp.name, ['-f', ctx.composeFile || 'docker-compose.yml', 'up', '-d', '--build', '--force-recreate'], ctx.workingDir, (c) => jobStream(job, c));
            }
          } else {
            // Adopted / external git
            await gitInDir(ctx.server, root, ['fetch', '--all', '--quiet'], (c) => jobStream(job, c), keyId);
            try {
              await gitInDir(ctx.server, root, ['merge', '--ff-only', targetRef], (c) => jobStream(job, c), keyId);
            } catch (e) {
              await gitInDir(ctx.server, root, ['reset', '--hard', targetRef], (c) => jobStream(job, c), keyId);
            }
            const r = await resolveComposeFiles(gp.name);
            const fileArgs = (r.files && r.files.length) ? r.files.flatMap(f => ['-f', f]) : ['-f', ctx.composeFile || 'docker-compose.yml'];
            const workingDir = r.cwd || ctx.workingDir;
            jobLog(job, `Running docker compose up -d --build in ${workingDir}...\n`);
            if (ctx.server) {
              await remoteCompose.runComposeInRemoteDir(ctx.server, workingDir, gp.name, [...fileArgs, 'up', '-d', '--build', '--force-recreate'], (c) => jobStream(job, c));
            } else {
              await runCompose(gp.name, [...fileArgs, 'up', '-d', '--build', '--force-recreate'], workingDir, (c) => jobStream(job, c));
            }
          }
          setStep(job, 'proj:' + gp.name, 'done');
          jobLog(job, `✓ [${gp.name}] Sync succeeded\n`);
        } catch (err) {
          setStep(job, 'proj:' + gp.name, 'failed');
          jobLog(job, `✗ [${gp.name}] Failed: ${err.message}\n`);
        }
      }
      job.phase = 'done';
      job.status = 'done';
      jobLog(job, '\n✓ Global Git Sync finished for all projects.\n');
      job.finishedAt = Date.now();
    })();

    res.json({ jobId: job.id, totalProjects: gitProjects.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pull & deploy any custom directory path on server where a git repo is located
router.post('/git-pull-path', async (req, res) => {
  try {
    let { targetPath, branch = '', force = false, up = true } = req.body || {};
    if (!targetPath) return res.status(400).json({ error: 'targetPath is required' });
    const server = remoteCompose.getActiveRemoteServer();
    if (server) targetPath = await remoteCompose.resolveRemotePath(server, targetPath);
    else targetPath = path.resolve(targetPath);

    let root = '';
    try { root = (await gitInDir(server, targetPath, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (e) { return res.status(400).json({ error: `Not a git repository at path: ${targetPath}` }); }

    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      project: path.posix.basename(root) || 'custom-git-pull',
      status: 'running',
      phase: 'pull',
      log: '',
      error: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
      steps: [{ id: 'pull', label: force ? 'git reset --hard' : 'git pull', status: 'pending' }]
    };
    if (up) job.steps.push({ id: 'up', label: 'docker compose up -d --build', status: 'pending' });
    deployJobs.set(job.id, job);

    (async () => {
      const stream = (c) => jobStream(job, c);
      try {
        setStep(job, 'pull', 'running');
        jobLog(job, `Pulling git repository at ${root}...\n`);
        if (force) {
          const targetRef = branch ? `origin/${branch}` : '@{u}';
          await gitInDir(server, root, ['fetch', '--all', '--quiet'], stream);
          jobLog(job, `$ git -C ${root} reset --hard ${targetRef}\n`);
          await gitInDir(server, root, ['reset', '--hard', targetRef], stream);
        } else {
          jobLog(job, `$ git -C ${root} pull\n`);
          await gitInDir(server, root, ['pull'], stream);
        }
        setStep(job, 'pull', 'done');

        if (up) {
          setStep(job, 'up', 'running'); job.phase = 'up';
          jobLog(job, `Scanning compose files under ${targetPath}...\n`);
          const composeFiles = server
            ? (await remoteScanComposeFiles(server, targetPath, { maxdepth: 4 })).files
            : findComposeFiles(targetPath);
          const found = composeFiles[0];
          const fileRel = found ? (found.path || found) : 'docker-compose.yml';
          const composeDir = found && found.dir ? (server ? path.posix.join(targetPath, found.dir) : path.join(targetPath, found.dir)) : targetPath;
          const composeFileBase = path.posix.basename(fileRel);
          jobLog(job, `Running docker compose -f ${composeFileBase} up -d --build in ${composeDir}...\n`);
          if (server) {
            await remoteCompose.runComposeInRemoteDir(server, composeDir, path.posix.basename(root), ['-f', composeFileBase, 'up', '-d', '--build', '--force-recreate'], stream);
          } else {
            await runCompose(path.basename(root), ['-f', composeFileBase, 'up', '-d', '--build', '--force-recreate'], composeDir, stream);
          }
          setStep(job, 'up', 'done');
        }
        job.phase = 'done'; job.status = 'done'; jobLog(job, '\n✓ Done'); job.finishedAt = Date.now();
      } catch (err) {
        job.status = 'error'; job.phase = 'error'; job.error = err.message;
        const r = (job.steps || []).find(s => s.status === 'running'); if (r) r.status = 'failed';
        jobLog(job, '\n✗ ' + err.message); job.finishedAt = Date.now();
      }
    })();

    res.json({ jobId: job.id, root });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/adopt-pull', async (req, res) => {
  try {
    const project = req.params.project;
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const ctx = await resolveProjectGitContext(project);
    if (!ctx || !ctx.isGit) return res.status(400).json({ error: 'Not an external or adopted git checkout' });
    const server = ctx.server;
    const root = ctx.repoRoot;
    const keyId = ctx.keyId || null;
    const before = (await gitInDir(server, root, ['rev-parse', 'HEAD'], null, keyId)).trim();
    await gitInDir(server, root, ['fetch', '--all', '--quiet'], null, keyId);
    const targetRef = ctx.branch && ctx.branch !== 'HEAD' ? `origin/${ctx.branch}` : '@{u}';
    try { await gitInDir(server, root, ['merge', '--ff-only', targetRef], null, keyId); }
    catch (e) { return res.status(409).json({ error: 'Not a fast-forward — your server checkout has diverged from the remote. Resolve it on the host or use Force Pull.' }); }
    const after = (await gitInDir(server, root, ['rev-parse', 'HEAD'], null, keyId)).trim();
    invalidateExternalGit(project);
    let changed = [], commits = [];
    if (before !== after) {
      try { changed = (await gitInDir(server, root, ['diff', '--name-status', before + '..' + after], null, keyId)).trim().split('\n').filter(Boolean).slice(0, 200); } catch (e) { }
      try {
        commits = (await gitInDir(server, root, ['log', '--pretty=%h%x09%ad%x09%s', '--date=short', before + '..' + after], null, keyId)).trim().split('\n').filter(Boolean).slice(0, 100)
          .map(l => { const parts = l.split('\t'); return { hash: parts[0], date: parts[1], subject: parts.slice(2).join('\t') }; });
      } catch (e) { }
    }
    logAction({ req, server: server ? dockerService.getActiveServerId() : 'local', resourceId: project, resourceType: 'compose', resourceName: project, action: 'adopt-pull', details: { fromSHA: before, toSHA: after, files: changed.length } });
    res.json({ success: true, repoRoot: root, fromSHA: before, toSHA: after, upToDate: before === after, changed, commits });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/:project/adopt-redeploy', async (req, res) => {
  try {
    const project = req.params.project;
    if (!validateProjectName(project)) return res.status(400).json({ error: 'Invalid project name' });
    const force = !!(req.body && (req.body.force === true || req.body.force === '1'));
    const ctx = await resolveProjectGitContext(project);
    if (!ctx || !ctx.isGit) return res.status(400).json({ error: 'Not an external or adopted git checkout' });
    const r = await resolveComposeFiles(project);
    const server = ctx.server;
    const fileArgs = (r.files && r.files.length) ? r.files.flatMap(f => ['-f', f]) : ['-f', ctx.composeFile || 'docker-compose.yml'];
    const job = {
      id: crypto.randomBytes(8).toString('hex'), project, status: 'running', phase: 'pull', log: '', error: null, result: null,
      startedAt: Date.now(), finishedAt: null,
      steps: [{ id: 'pull', label: force ? 'git reset --hard' : 'git pull --ff-only', status: 'pending' }, { id: 'up', label: 'docker compose up -d --build --force-recreate', status: 'pending' }],
    };
    deployJobs.set(job.id, job);
    runAdoptRedeployJob(job, { server, serverId: dockerService.getActiveServerId(), project, ctx, fileArgs, workingDir: r.cwd || ctx.workingDir, force, reqIp: req.ip });
    res.json({ jobId: job.id, project });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

async function runAdoptRedeployJob(job, p) {
  const stream = (c) => jobStream(job, c);
  try {
    setStep(job, 'pull', 'running'); job.phase = 'pull';
    const root = p.ctx.repoRoot;
    const branch = p.ctx.branch || 'main';
    const targetRef = branch && branch !== 'HEAD' ? `origin/${branch}` : '@{u}';
    if (p.force) {
      jobLog(job, '$ git -C ' + root + ' fetch && git reset --hard ' + targetRef);
      await gitInDir(p.server, root, ['fetch', '--all', '--quiet'], stream, p.ctx.keyId);
      await gitInDir(p.server, root, ['reset', '--hard', targetRef], stream, p.ctx.keyId);
    } else {
      jobLog(job, '$ git -C ' + root + ' fetch && git merge --ff-only ' + targetRef);
      await gitInDir(p.server, root, ['fetch', '--all', '--quiet'], stream, p.ctx.keyId);
      try { await gitInDir(p.server, root, ['merge', '--ff-only', targetRef], stream, p.ctx.keyId); }
      catch (e) { throw Object.assign(new Error('Not a fast-forward — the server checkout has diverged. Use ⚠️ Force Pull to reset.'), { statusCode: 409 }); }
    }
    setStep(job, 'pull', 'done');

    setStep(job, 'up', 'running'); job.phase = 'up';
    const upArgs = [...p.fileArgs, 'up', '-d', '--build', '--force-recreate'];
    jobLog(job, '\n$ docker compose -p ' + p.project + ' ' + upArgs.join(' ') + '\n');
    if (p.server) await remoteCompose.runComposeInRemoteDir(p.server, p.workingDir, p.project, upArgs, stream);
    else await runCompose(p.project, upArgs, p.workingDir, stream);
    setStep(job, 'up', 'done');

    invalidateExternalGit(p.project);
    job.phase = 'done'; job.status = 'done'; jobLog(job, '\n✓ Done'); job.finishedAt = Date.now();
    logAction({ sourceIp: p.reqIp, server: p.server ? p.serverId : 'local', resourceId: p.project, resourceType: 'compose', resourceName: p.project, action: 'adopt-redeploy', details: { force: p.force } });
  } catch (err) {
    job.status = 'error'; job.phase = 'error'; job.error = (err.message || 'redeploy failed').toString();
    const r = (job.steps || []).find(s => s.status === 'running'); if (r) r.status = 'failed';
    jobLog(job, '\n✗ ' + job.error); job.finishedAt = Date.now();
  }
}

module.exports = router;
