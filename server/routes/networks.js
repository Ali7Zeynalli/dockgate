const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listNetworks()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// A network's page: members with addresses, aliases, ports and compose project (server/network-map.js).
const NM = require('../network-map');
async function readNetwork(id) {
  const [net, ctrs] = await Promise.all([dockerService.inspectNetwork(id), dockerService.docker.listContainers({ all: true })]);
  // aliases and fixed addresses are only in a container's inspect; read the members (at most 60)
  const mine = ctrs.filter(c => Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).some(([k, n]) => k === net.Name || (n && n.NetworkID === net.Id)));
  await Promise.all(mine.slice(0, 60).map(async (c) => { try { c.inspect = await dockerService.docker.getContainer(c.Id).inspect(); } catch (e) { /* gone meanwhile */ } }));
  return { net, ctrs, desc: NM.describe(net, ctrs) };
}

router.get('/:id/details', async (req, res) => {
  try { res.json((await readNetwork(req.params.id)).desc); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Compare with the compose files: `docker compose config` of every project on the network.
router.get('/:id/compare', async (req, res) => {
  try {
    const { ctrs, desc } = await readNetwork(req.params.id);
    const h = require('./compose').composeHelpers;
    const configs = {};
    await Promise.all(desc.projects.map(async (p) => {
      try {
        if (!h.validateProjectName(p)) { configs[p] = { error: 'not a project name DockGate works with' }; return; }
        const r = await h.resolveComposeFiles(p);
        if (!r.files || !r.files.length) { configs[p] = { error: r.reason || 'no compose file found' }; return; }
        const out = String(await h.runResolved(r, p, ['config', '--format', 'json'], null));
        const a = out.indexOf('{'), b = out.lastIndexOf('}');
        if (a < 0 || b < a) throw new Error(out.trim().split('\n').pop().slice(0, 200) || 'no output');
        configs[p] = { config: JSON.parse(out.slice(a, b + 1)), files: r.files, source: r.source || null };
      } catch (e) { configs[p] = { error: String(e.stderr || e.message || e).trim().split('\n').pop().slice(0, 240) }; }
    }));
    const memberIds = new Set(desc.members.map(m => m.id));
    const others = ctrs.filter(c => !memberIds.has(c.Id) && c.Labels && c.Labels[NM.LABELS.PROJECT])
      .map(c => ({ name: String((c.Names || [])[0] || '').replace(/^\//, ''), project: c.Labels[NM.LABELS.PROJECT], service: c.Labels[NM.LABELS.SERVICE] || null, state: c.State }));
    res.json({ network: desc.name, ...NM.compare(desc, configs, others) });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await dockerService.inspectNetwork(req.params.id)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await dockerService.createNetwork(req.body);
    logAction({ req, resourceId: result.id || '', resourceType: 'network', resourceName: req.body.Name || '', action: 'create' });
    res.json(result);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dockerService.removeNetwork(req.params.id);
    logAction({ req, resourceId: req.params.id, resourceType: 'network', resourceName: req.params.id.substring(0, 12), action: 'remove' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Attach / detach a container to/from a network (membership is live; the network itself is immutable).
router.post('/:id/connect', async (req, res) => {
  try {
    const { container } = req.body || {};
    if (!container) return res.status(400).json({ error: 'container required' });
    await dockerService.connectNetwork(req.params.id, container);
    logAction({ req, resourceId: req.params.id, resourceType: 'network', resourceName: req.params.id.substring(0, 12), action: 'connect', details: { container } });
    // Dual-log from the container's perspective - the action is usually initiated from the container
    // detail page, so it must also be visible when auditing that container's history.
    logAction({ req, resourceId: container, resourceType: 'container', resourceName: String(container).substring(0, 12), action: 'network-connect', details: { network: req.params.id.substring(0, 12) } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/:id/disconnect', async (req, res) => {
  try {
    const { container, force } = req.body || {};
    if (!container) return res.status(400).json({ error: 'container required' });
    await dockerService.disconnectNetwork(req.params.id, container, force);
    logAction({ req, resourceId: req.params.id, resourceType: 'network', resourceName: req.params.id.substring(0, 12), action: 'disconnect', details: { container } });
    logAction({ req, resourceId: container, resourceType: 'container', resourceName: String(container).substring(0, 12), action: 'network-disconnect', details: { network: req.params.id.substring(0, 12) } });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
