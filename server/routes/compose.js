const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
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

router.post('/:project/up', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const output = await runCompose(req.params.project, ['up', '-d'], project.workingDir);
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'up', output);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/down', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const output = await runCompose(req.params.project, ['down'], project.workingDir);
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'down', output);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/restart', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const output = await runCompose(req.params.project, ['restart'], project.workingDir);
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'restart', output);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/pull', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const output = await runCompose(req.params.project, ['pull'], project.workingDir);
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'pull', output);
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
