const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// Validate compose project name — only allow safe characters
// Compose project adını yoxla — yalnız təhlükəsiz simvollara icazə ver
function validateProjectName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
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
    if (!project.workingDir) {
      return res.status(400).json({ error: 'Working directory not found — once a project is fully down, the working dir cannot be read from labels. Bring it up manually from the compose folder.' });
    }
    const output = await runCompose(req.params.project, action, project.workingDir);
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: label, details: output });
    res.json({ success: true, output });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
}

router.post('/:project/up', (req, res) => runComposeAction(req, res, ['up', '-d'], 'up'));
router.post('/:project/down', (req, res) => runComposeAction(req, res, ['down'], 'down'));
router.post('/:project/restart', (req, res) => runComposeAction(req, res, ['restart'], 'restart'));
router.post('/:project/pull', (req, res) => runComposeAction(req, res, ['pull'], 'pull'));

module.exports = router;
