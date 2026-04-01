const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

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
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const { stdout, stderr } = await execAsync(`docker compose -p ${req.params.project} up -d`, { cwd: project.workingDir });
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'up', stdout || stderr);
    res.json({ success: true, output: stdout || stderr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/down', async (req, res) => {
  try {
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const { stdout, stderr } = await execAsync(`docker compose -p ${req.params.project} down`, { cwd: project.workingDir });
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'down', stdout || stderr);
    res.json({ success: true, output: stdout || stderr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/restart', async (req, res) => {
  try {
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const { stdout, stderr } = await execAsync(`docker compose -p ${req.params.project} restart`, { cwd: project.workingDir });
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'restart', stdout || stderr);
    res.json({ success: true, output: stdout || stderr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:project/pull', async (req, res) => {
  try {
    const project = await dockerService.getComposeProject(req.params.project);
    if (!project.workingDir) return res.status(400).json({ error: 'Working directory not found' });
    const { stdout, stderr } = await execAsync(`docker compose -p ${req.params.project} pull`, { cwd: project.workingDir });
    stmts.logActivity.run(req.params.project, 'compose', req.params.project, 'pull', stdout || stderr);
    res.json({ success: true, output: stdout || stderr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
