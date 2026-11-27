const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');

router.get('/', async (req, res) => {
  try { res.json(await dockerService.listNetworks()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// The server's own interfaces and routes (for the parent of a macvlan network, and for subnets that would clash).
const hostCache = new Map(); // serverId -> { at, host }
async function hostNet() {
  const id = dockerService.getActiveServerId() || 'local';
  const c = hostCache.get(id);
  if (c && Date.now() - c.at < 60000) return c.host;
  const host = require('../network-map').parseHostNet(await dockerService.runHelperOnce(require('../network-map').HOST_CMD, { network: 'host' }));
  hostCache.set(id, { at: Date.now(), host });
  return host;
}
router.get('/host-info', async (req, res) => {
  try { res.json(await hostNet()); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
// What a subnet would clash with: other Docker networks, and the server's own networks and routes outside Docker.
router.post('/check-subnet', async (req, res) => {
  try {
    const { subnets = [], except } = req.body || {};
    const [host, nets] = await Promise.all([hostNet().catch(() => null), dockerService.listNetworks()]);
    const list = nets.map(n => ({ name: n.name, subnets: ((n.ipam && n.ipam.Config) || []).map(x => x.Subnet).filter(Boolean) }));
    const NMod = require('../network-map');
    res.json({ hostRead: !!host, conflicts: (Array.isArray(subnets) ? subnets : [subnets]).filter(Boolean).flatMap(sn => NMod.subnetConflicts(String(sn).trim(), host, list, { except }).map(c => ({ ...c, for: sn }))) });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// A network's page: members with addresses, aliases, ports and compose project (server/network-map.js).
const NM = require('../network-map');
async function readNetwork(id) {
  const [net, ctrs] = await Promise.all([dockerService.inspectNetwork(id), dockerService.docker.listContainers({ all: true })]);
  // aliases and fixed addresses are only in a container's inspect; read the members (at most 60)
  const mine = ctrs.filter(c => Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).some(([k, n]) => k === net.Name || (n && n.NetworkID === net.Id)));
  for (let i = 0; i < mine.length; i += 10) { // 10 at a time, every member
    await Promise.all(mine.slice(i, i + 10).map(async (c) => { try { c.inspect = await dockerService.docker.getContainer(c.Id).inspect(); } catch (e) { /* gone meanwhile */ } }));
  }
  return { net, ctrs, desc: NM.describe(net, ctrs) };
}

// Change settings: Docker can not change a network in place, so it is made again (server/network-recreate.js).
const NR = require('../network-recreate');
router.get('/:id/recreate-check', async (req, res) => {
  try {
    const { net, desc } = await readNetwork(req.params.id);
    const services = (await dockerService.listNetworks()).find(n => n.id === net.Id);
    res.json({ refusal: NR.refusal(net, services ? services.services : 0), members: desc.members.map(m => ({ name: m.name, state: m.state, aliases: m.aliases, fixedIp: m.fixedIp, project: m.project })) });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.post('/:id/recreate', async (req, res) => {
  try {
    const ch = (req.body && req.body.changes) || {};
    const allowed = ['subnet', 'gateway', 'ipRange', 'ipv6', 'subnet6', 'gateway6', 'internal', 'attachable', 'mtu', 'icc', 'masquerade', 'labels'];
    const changes = Object.fromEntries(Object.entries(ch).filter(([k]) => allowed.includes(k)));
    const reqIp = req.ip, server = dockerService.isLocalActive() ? undefined : dockerService.getActiveServerId();
    const jobId = NR.start(dockerService.docker, req.params.id, changes, { onDone: ({ old, members }) => logAction({ sourceIp: reqIp, server, resourceId: req.params.id, resourceType: 'network', resourceName: old, action: 'recreate', details: { changes, members } }) });
    res.json({ jobId });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.get('/jobs/:jobId', (req, res) => {
  const j = NR.getJob(req.params.jobId);
  if (!j) return res.status(404).json({ error: 'Job not found (it may have expired)' });
  res.json(j);
});

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
    const { container, aliases, ipv4, ipv6 } = req.body || {};
    if (!container) return res.status(400).json({ error: 'container required' });
    // optional: names the others reach it by on this network, and a fixed address
    const net = require('net');
    const al = (Array.isArray(aliases) ? aliases : String(aliases || '').split(/[\s,]+/)).map(a => String(a).trim()).filter(Boolean);
    if (al.some(a => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(a))) return res.status(400).json({ error: 'Aliases: letters, digits, _ . - (up to 63 each)' });
    if (ipv4 && net.isIP(String(ipv4)) !== 4) return res.status(400).json({ error: 'Fixed IPv4 address: like 172.30.0.10' });
    if (ipv6 && net.isIP(String(ipv6)) !== 6) return res.status(400).json({ error: 'Fixed IPv6 address: like fd00::10' });
    const ep = {};
    if (al.length) ep.Aliases = al;
    if (ipv4 || ipv6) ep.IPAMConfig = { ...(ipv4 ? { IPv4Address: String(ipv4) } : {}), ...(ipv6 ? { IPv6Address: String(ipv6) } : {}) };
    await dockerService.connectNetwork(req.params.id, container, Object.keys(ep).length ? { EndpointConfig: ep } : {});
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
