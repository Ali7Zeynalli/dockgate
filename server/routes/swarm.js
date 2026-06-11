const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const dockerService = require('../docker');
const { logAction } = require('../audit');

// Managed stack compose files (deploy uses the host `docker stack deploy` CLI — local only).
const STACKS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'stacks');
function validateStackName(name) { return /^[a-zA-Z0-9_-]+$/.test(name || ''); }

// Every endpoint except GET / and POST /init requires the active daemon to be a swarm MANAGER
// (workers are 'active' but can't run any control-plane operation — ControlAvailable=false).
async function assertSwarm() {
  const info = await dockerService.getSwarmInfo();
  if (!info.active) {
    const e = new Error('The active host is not in Swarm mode. Run "docker swarm init" on it first.');
    e.statusCode = 400;
    throw e;
  }
  if (!info.isManager) {
    const e = new Error('The active host is a swarm WORKER — control operations need a manager node. Switch to a manager (or promote this node).');
    e.statusCode = 400;
    throw e;
  }
}

// GET /api/swarm — swarm state (used by the UI to gate the Swarm page)
router.get('/', async (req, res) => {
  try { res.json(await dockerService.getSwarmInfo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Cluster bootstrap ----
// Initialize the active daemon as a swarm manager (works on local or a remote SSH host)
router.post('/init', async (req, res) => {
  try {
    const r = await dockerService.swarmInit((req.body || {}).advertiseAddr);
    logAction({ req, resourceType: 'swarm', resourceName: 'swarm', action: 'init' });
    res.json(r);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Leave the swarm (force required on the last manager)
router.post('/leave', async (req, res) => {
  try {
    await dockerService.swarmLeave((req.body || {}).force);
    logAction({ req, resourceType: 'swarm', resourceName: 'swarm', action: 'leave' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Worker & manager join tokens + manager address (for `docker swarm join` on another VPS)
router.get('/jointokens', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.getSwarmJoinTokens()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// AUTO-JOIN: bir DockGate SSH serverini swarm-a bir-klik qoş (manual əmr lazım deyil).
// body: { serverId, role: 'worker'|'manager' }
router.post('/nodes/join', async (req, res) => {
  try {
    await assertSwarm();
    const { serverId, role } = req.body || {};
    if (!serverId) return res.status(400).json({ error: 'serverId required' });
    const tokens = await dockerService.getSwarmJoinTokens();
    if (!tokens.address) return res.status(400).json({ error: 'Manager address is unknown — re-initialize the swarm with a reachable IP (not 127.0.0.1).' });
    const token = role === 'manager' ? tokens.manager : tokens.worker;
    const r = await dockerService.joinServerToSwarm(serverId, token, tokens.address);
    logAction({ req, resourceType: 'node', resourceName: serverId, action: 'join', details: { role: role || 'worker', manager: tokens.address } });
    res.json(r);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ---- Services ----
router.get('/services', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listServices()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Create a new service (SW-a)
router.post('/services', async (req, res) => {
  try {
    await assertSwarm();
    const b = req.body || {};
    if (!b.name || !b.image) return res.status(400).json({ error: 'name and image are required' });
    const r = await dockerService.createService(b);
    logAction({ req, resourceType: 'service', resourceName: b.name, action: 'create', details: { image: b.image } });
    res.json(r);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/services/:id', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.inspectService(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/services/:id/tasks', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listServiceTasks(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Aggregated service logs (SW-a)
router.get('/services/:id/logs', async (req, res) => {
  try { await assertSwarm(); res.json({ logs: await dockerService.getServiceLogs(req.params.id, parseInt(req.query.tail) || 200) }); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Rolling image update (SW-a)
router.post('/services/:id/update', async (req, res) => {
  try {
    await assertSwarm();
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image required' });
    await dockerService.updateServiceImage(req.params.id, image);
    logAction({ req, resourceType: 'service', resourceName: req.params.id.substring(0, 12), action: 'update', details: { image } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/services/:id/scale', async (req, res) => {
  try {
    await assertSwarm();
    const { replicas } = req.body || {};
    if (replicas === undefined || replicas === '') return res.status(400).json({ error: 'replicas required' });
    await dockerService.scaleService(req.params.id, replicas);
    logAction({ req, resourceType: 'service', resourceName: req.params.id.substring(0, 12), action: 'scale', details: { replicas } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/services/:id', async (req, res) => {
  try {
    await assertSwarm();
    await dockerService.removeService(req.params.id);
    logAction({ req, resourceType: 'service', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ---- Nodes ----
router.get('/nodes', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listNodes()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/nodes/:id/availability', async (req, res) => {
  try {
    await assertSwarm();
    const { availability } = req.body || {};
    if (!['active', 'pause', 'drain'].includes(availability)) return res.status(400).json({ error: 'availability must be active | pause | drain' });
    await dockerService.updateNodeAvailability(req.params.id, availability);
    logAction({ req, resourceType: 'node', resourceName: req.params.id.substring(0, 12), action: 'availability', details: { availability } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Remove a node from the swarm (drain it first; ?force=1 for an unreachable/down node)
router.delete('/nodes/:id', async (req, res) => {
  try {
    await assertSwarm();
    await dockerService.removeNode(req.params.id, req.query.force === '1' || req.query.force === 'true');
    logAction({ req, resourceType: 'node', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ---- Stacks ----
// Listing groups services by the stack namespace label (Engine API — works on any active daemon).
router.get('/stacks', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listStacks()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Deploy a stack from a pasted compose file via the host `docker stack deploy` CLI (local only, SW-b).
router.post('/stacks/deploy', async (req, res) => {
  try {
    await assertSwarm();
    dockerService.assertLocalActive('Stack deploy');
    const { name, compose } = req.body || {};
    if (!validateStackName(name)) return res.status(400).json({ error: 'Valid stack name required (a-z A-Z 0-9 _ -)' });
    if (!compose || !compose.trim()) return res.status(400).json({ error: 'compose file required' });
    const dir = path.join(STACKS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
    const { stdout, stderr } = await execFileAsync('docker', ['stack', 'deploy', '-c', 'docker-compose.yml', '--detach=true', name], { cwd: dir, maxBuffer: 2 * 1024 * 1024 });
    logAction({ req, resourceType: 'stack', resourceName: name, action: 'deploy' });
    res.json({ success: true, output: stdout || stderr });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || 'Deploy failed').toString() }); }
});

// Remove a stack via the host `docker stack rm` CLI (local only, SW-b).
router.delete('/stacks/:name', async (req, res) => {
  try {
    await assertSwarm();
    dockerService.assertLocalActive('Stack remove');
    if (!validateStackName(req.params.name)) return res.status(400).json({ error: 'Invalid stack name' });
    const { stdout, stderr } = await execFileAsync('docker', ['stack', 'rm', req.params.name], { maxBuffer: 2 * 1024 * 1024 });
    logAction({ req, resourceType: 'stack', resourceName: req.params.name, action: 'remove' });
    res.json({ success: true, output: stdout || stderr });
  } catch (err) { res.status(err.statusCode || 500).json({ error: (err.stderr || err.message || 'Remove failed').toString() }); }
});

// ---- Secrets & Configs (SW-c) ----
router.get('/secrets', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listSecrets()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.post('/secrets', async (req, res) => {
  try {
    await assertSwarm();
    const { name, data } = req.body || {};
    if (!name || data === undefined || data === '') return res.status(400).json({ error: 'name and data are required' });
    // Swarm secret limiti ~500KB (raw bytes) — daemon-a getmədən aydın mesajla rədd et
    if (Buffer.byteLength(String(data), 'utf8') > 500 * 1024) return res.status(400).json({ error: 'Secret data exceeds the 500KB swarm limit' });
    const r = await dockerService.createSecret(name, data);
    logAction({ req, resourceType: 'secret', resourceName: name, action: 'create' });
    res.json(r);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.delete('/secrets/:id', async (req, res) => {
  try {
    await assertSwarm();
    await dockerService.removeSecret(req.params.id);
    logAction({ req, resourceType: 'secret', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/configs', async (req, res) => {
  try { await assertSwarm(); res.json(await dockerService.listConfigs()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.post('/configs', async (req, res) => {
  try {
    await assertSwarm();
    const { name, data } = req.body || {};
    if (!name || data === undefined || data === '') return res.status(400).json({ error: 'name and data are required' });
    // Config limiti Docker versiyasına görə 500KB-1000KB arası dəyişir — 1000KB-da pre-flight rədd
    if (Buffer.byteLength(String(data), 'utf8') > 1000 * 1024) return res.status(400).json({ error: 'Config data exceeds the 1000KB swarm limit' });
    const r = await dockerService.createConfig(name, data);
    logAction({ req, resourceType: 'config', resourceName: name, action: 'create' });
    res.json(r);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.delete('/configs/:id', async (req, res) => {
  try {
    await assertSwarm();
    await dockerService.removeConfig(req.params.id);
    logAction({ req, resourceType: 'config', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
