const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const dockerService = require('../docker');
const { logAction } = require('../audit');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

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

// Validate a compose file with `docker compose config -q` (throws with stderr if invalid)
async function validateComposeFile(cwd) {
  await execFileAsync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '-q'], { cwd });
}

// Run docker compose command safely using execFile (no shell injection)
// Docker compose əmrini təhlükəsiz şəkildə execFile ilə işlət (shell injection yoxdur)
async function runCompose(project, action, cwd) {
  const args = ['compose', '-p', project, ...action];
  const { stdout, stderr } = await execFileAsync('docker', args, { cwd });
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

// Compose commands run the host `docker compose` CLI against a working dir on the host filesystem —
// this only makes sense for the local daemon (a remote SSH host's compose files are not reachable).
// Verify the active server is local before every mutation.
async function runComposeAction(req, res, action, label) {
  try {
    dockerService.assertLocalActive(`Compose ${label}`);
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const project = await dockerService.getComposeProject(req.params.project);
    // Working dir from labels; fall back to the DockGate-managed dir (also lets a fully-down
    // managed project be brought back up — the label-only path could not).
    let cwd = project.workingDir;
    if (!cwd && fs.existsSync(path.join(managedDir(req.params.project), 'docker-compose.yml'))) {
      cwd = managedDir(req.params.project);
    }
    if (!cwd) {
      return res.status(400).json({ error: 'Working directory not found — this project has no running containers and is not DockGate-managed. Bring it up from its compose folder.' });
    }
    const output = await runCompose(req.params.project, action, cwd);
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: label, details: output });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
}

router.post('/:project/up', (req, res) => runComposeAction(req, res, ['up', '-d'], 'up'));
router.post('/:project/down', (req, res) => runComposeAction(req, res, ['down'], 'down'));
router.post('/:project/restart', (req, res) => runComposeAction(req, res, ['restart'], 'restart'));
router.post('/:project/pull', (req, res) => runComposeAction(req, res, ['pull'], 'pull'));

// ---- DockGate-managed compose files (create / read / edit) — local host only ----

// Create a new managed project: write YAML → validate → up -d
router.post('/create', async (req, res) => {
  try {
    dockerService.assertLocalActive('Compose create');
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
    dockerService.assertLocalActive('Compose edit');
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

module.exports = router;
