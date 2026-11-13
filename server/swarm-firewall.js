// Swarm → Firewall: the ports Swarm services publish, on every server of the cluster, in one table — and opening or
// closing one on all of them at once. A Swarm port is open on every server (ingress) or on the servers that run a
// task (host mode), and Docker sends the traffic past UFW's normal rules. With DockGate's Docker port isolation
// (Server Console → Firewall → Docker ports) such traffic is dropped unless a `ufw route allow` rule lets it
// through; this page writes those rules. Which port the rule names:
//   ingress  the published port (Docker forwards it to the ingress network on that same port)
//   host     the container port (Docker forwards straight to the task)
// What was asked is kept (swarm_fw_rules), so a server that joins later gets the same rules, and a rule whose
// service is gone is removed.
const { db, stmts } = require('./db');
const dockerService = require('./docker');
const FW = require('./security/fwmodel');
const IPL = require('./security/iplists');

db.exec(`CREATE TABLE IF NOT EXISTS swarm_fw_rules (
  cluster_id TEXT NOT NULL, port INTEGER NOT NULL, proto TEXT NOT NULL, mode TEXT NOT NULL, check_port INTEGER NOT NULL,
  sources TEXT NOT NULL, service TEXT, updated_at INTEGER, PRIMARY KEY (cluster_id, port, proto)
)`);
const q = {
  all: db.prepare('SELECT * FROM swarm_fw_rules WHERE cluster_id = ?'),
  put: db.prepare(`INSERT INTO swarm_fw_rules (cluster_id, port, proto, mode, check_port, sources, service, updated_at) VALUES (@cluster, @port, @proto, @mode, @check, @sources, @service, @now)
    ON CONFLICT(cluster_id, port, proto) DO UPDATE SET mode = excluded.mode, check_port = excluded.check_port, sources = excluded.sources, service = excluded.service, updated_at = excluded.updated_at`),
  del: db.prepare('DELETE FROM swarm_fw_rules WHERE cluster_id = ? AND port = ? AND proto = ?'),
};
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const fwRoutes = () => require('./routes/firewall');

/** The port a `ufw route allow` rule must name for a Swarm port. */
const checkPortOf = (p) => (p.mode === 'host' ? p.target : p.published);

/** Ports published by Swarm services: [{ service, published, target, proto, mode, checkPort }] */
async function publishedPorts(c = dockerService.docker) {
  const out = [];
  for (const s of await c.listServices()) {
    for (const p of ((s.Endpoint || {}).Spec || s.Spec.EndpointSpec || {}).Ports || []) {
      if (!p.PublishedPort) continue;
      const x = { service: s.Spec.Name, published: p.PublishedPort, target: p.TargetPort, proto: p.Protocol || 'tcp', mode: p.PublishMode === 'host' ? 'host' : 'ingress' };
      out.push({ ...x, checkPort: checkPortOf(x) });
    }
  }
  return out.sort((a, b) => a.published - b.published);
}

/** The DockGate servers of this cluster: [{ nodeId, hostname, role, row }] (row null when DockGate does not know it). */
async function clusterServers(c = dockerService.docker) {
  const info = await c.info();
  const clusterId = info.Swarm && info.Swarm.Cluster && info.Swarm.Cluster.ID;
  const map = new Map();
  try { for (const r of db.prepare('SELECT node_id, server_id FROM swarm_node_servers WHERE cluster_id = ?').all(clusterId)) map.set(r.node_id, r.server_id); } catch (e) { /* none */ }
  map.set(info.Swarm.NodeID, dockerService.getActiveServerId() || 'local');
  const nodes = await c.listNodes();
  return { clusterId, servers: nodes.map(n => {
    const sid = map.get(n.ID) || null;
    const row = !sid ? null : sid === 'local' ? { id: 'local', type: 'local', name: 'Local' } : stmts.getServer.get(sid);
    return { nodeId: n.ID, hostname: n.Description.Hostname, role: n.Spec.Role, ready: n.Status.State === 'ready', row: row || null };
  }) };
}

/** Where one Swarm port stands on one server's firewall (fw: firewallOf result). */
function portState(fw, port) {
  if (!fw) return { state: 'unknown', text: 'DockGate can not read this server' };
  if (!fw.managed) return { state: 'open', text: 'no firewall — open to everyone', risk: true };
  if (fw.backend === 'firewalld') return { state: 'open', text: 'Docker publishes past firewalld — open to everyone', risk: true };
  if (!fw.dockerIsolation) return { state: 'open', text: 'Docker publishes past UFW — open to everyone (turn on Docker port isolation)', risk: true };
  const g = (fw._groups || []).find(x => x.dir === 'in' && x.container === port.checkPort && (!x.proto || x.proto === port.proto) && x.action !== 'deny');
  if (!g) return { state: 'closed', text: 'closed' };
  const who = (g.remotes || g.entries.map(e => e.remote)).map(r => (r === 'any4' || r === 'any6' || r === 'any' ? 'anyone' : r));
  return { state: 'open', text: `open to ${[...new Set(who)].join(', ')}`, key: g.key };
}

/** The table: ports × servers, and what DockGate keeps asked. */
async function overview() {
  const c = dockerService.docker;
  const [ports, { clusterId, servers }] = await Promise.all([publishedPorts(c), clusterServers(c)]);
  const fws = await Promise.all(servers.map(async (s) => {
    if (!s.row) return { error: 'not a DockGate server — add it in Servers to manage its firewall' };
    if (s.row.id === 'local' || s.row.type === 'local') return { error: 'DockGate\'s own server — add it as an SSH server to manage its firewall' };
    try { return await fwRoutes().firewallOf(s.row); } catch (e) { return { error: e.message }; }
  }));
  const asked = Object.fromEntries(q.all.all(clusterId).map(r => [`${r.port}/${r.proto}`, { ...r, sources: JSON.parse(r.sources) }]));
  return {
    clusterId,
    servers: servers.map((s, i) => ({ nodeId: s.nodeId, hostname: s.hostname, role: s.role, ready: s.ready, serverId: s.row ? s.row.id : null, serverName: s.row ? s.row.name : null,
      firewall: fws[i].error ? { error: fws[i].error } : { backend: fws[i].backend, managed: fws[i].managed, isolation: !!fws[i].dockerIsolation } })),
    ports: ports.map(p => ({ ...p, asked: asked[`${p.published}/${p.proto}`] || null, on: servers.map((s, i) => (fws[i].error ? { state: 'unknown', text: fws[i].error } : portState(fws[i], p))) })),
  };
}

/**
 * Open (sources: ['any4','any6','@list','1.2.3.4', …]) or close (sources: []) one Swarm port on every server that
 * DockGate manages. Returns per server what happened.
 */
async function apply({ port, proto = 'tcp', sources = [] }, { sourceIp } = {}) {
  port = Number(port); proto = proto === 'udp' ? 'udp' : 'tcp';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad(400, 'Port: 1–65535');
  if (!Array.isArray(sources) || sources.length > 60) throw bad(400, 'Sources: a list of at most 60 entries (use an IP list for more)');
  const c = dockerService.docker;
  const p = (await publishedPorts(c)).find(x => x.published === port && x.proto === proto);
  if (!p) throw bad(404, `No Swarm service publishes ${port}/${proto}`);
  const { clusterId, servers } = await clusterServers(c);
  if (sources.length) q.put.run({ cluster: clusterId, port, proto, mode: p.mode, check: p.checkPort, sources: JSON.stringify(sources), service: p.service, now: Date.now() });
  else q.del.run(clusterId, port, proto);
  const results = [];
  for (const s of servers) results.push({ hostname: s.hostname, ...(await applyOn(s, p, sources)) });
  try { require('./audit').logAction({ sourceIp: sourceIp || 'dockgate', server: dockerService.getActiveServerId() || 'local', resourceType: 'swarm-firewall', resourceName: `${port}/${proto}`, action: sources.length ? 'swarm_fw_open' : 'swarm_fw_close', details: { service: p.service, mode: p.mode, sources, results } }); } catch (e) { /* best effort */ }
  return { port, proto, mode: p.mode, checkPort: p.checkPort, results };
}

/** The `ufw route allow` rule for a Swarm port (in DockGate's firewall model). */
const wantRule = (p) => FW.normRule({ dir: 'in', action: 'allow', proto: p.proto, port: String(p.checkPort), container: p.checkPort, description: `Swarm ${p.service}` });

/** Make one server's firewall match what is asked for one port. */
async function applyOn(s, p, sources) {
  if (!s.row) return { ok: false, skipped: true, text: 'not a DockGate server — add it in Servers' };
  if (s.row.id === 'local' || s.row.type === 'local') return { ok: false, skipped: true, text: 'DockGate\'s own server — add it as an SSH server to manage its firewall' };
  const R = fwRoutes();
  let fw;
  try { fw = await R.firewallOf(s.row); } catch (e) { return { ok: false, text: e.message }; }
  if (!fw.managed) return { ok: false, skipped: true, text: 'no firewall on this server — the port is open to everyone' };
  if (fw.backend !== 'ufw' || !fw.dockerIsolation) return { ok: false, skipped: true, text: fw.backend === 'firewalld' ? 'firewalld: Docker publishes past it — not managed here' : 'Docker port isolation is off — the port is open to everyone (Server Console → Firewall → Docker ports)' };
  if (p.checkPort === fw.sshPort) return { ok: false, text: 'that is the SSH port of this server — not changed here' };
  const want = sources.length ? wantRule(p) : null;
  const key = want ? FW.ruleKey(want) : null;
  const old = (fw._groups || []).find(g => g.dir === 'in' && g.container === p.checkPort && (g.proto || 'tcp') === p.proto && g.action !== 'deny') || null;
  if (want) {
    want.remotes = FW.expandRemotes(sources, IPL.all(), fw.dockgateIp);
    if (!fw.ipv6) want.remotes = want.remotes.filter(r => r.remote !== 'any6' && (r.remote === 'any4' || !IPL.isV6(r.remote)));
    want.key = key;
  } else if (!old) return { ok: true, text: 'closed already' };
  const plan = FW.planChange({ backend: fw.backend, zone: fw.zone, old, want });
  if (!plan.cmds.length) return { ok: true, text: want ? 'open already' : 'closed already' };
  try {
    await R.runFirewallOp(s.row, { steps: [{ label: `${want ? 'Open' : 'Close'} Swarm port ${p.published}/${p.proto}`, cmd: plan.cmds.join(' && ') }] }, 'Swarm firewall');
    return { ok: true, text: want ? `opened (${plan.add.length} added, ${plan.remove.length} removed)` : 'closed' };
  } catch (e) { return { ok: false, text: e.message }; }
}

/**
 * Keep the firewall following the cluster: a server that joined later gets the rules asked for; a rule whose port
 * no service publishes any more is removed (on every server) and forgotten.
 */
async function sync() {
  const c = dockerService.docker;
  const st = await require('./swarm').status().catch(() => null);
  if (!st || st.state !== 'active' || !st.manager) return { skipped: true };
  const [ports, { clusterId, servers }] = await Promise.all([publishedPorts(c), clusterServers(c)]);
  const out = [];
  for (const r of q.all.all(clusterId)) {
    const p = ports.find(x => x.published === r.port && x.proto === r.proto);
    const sources = JSON.parse(r.sources);
    if (!p) { // the service is gone: close it everywhere and forget it
      const gone = { service: r.service, published: r.port, target: r.check_port, proto: r.proto, mode: r.mode, checkPort: r.check_port };
      for (const s of servers) out.push({ port: r.port, hostname: s.hostname, ...(await applyOn(s, gone, [])) });
      q.del.run(clusterId, r.port, r.proto);
      continue;
    }
    if (p.checkPort !== r.check_port) { // the mode changed (ingress ↔ host): the old rule goes, the new one comes
      const was = { ...p, checkPort: r.check_port };
      for (const s of servers) await applyOn(s, was, []);
      q.put.run({ cluster: clusterId, port: p.published, proto: p.proto, mode: p.mode, check: p.checkPort, sources: r.sources, service: p.service, now: Date.now() });
    }
    for (const s of servers) { const x = await applyOn(s, p, sources); if (!/already/.test(x.text)) out.push({ port: r.port, hostname: s.hostname, ...x }); }
  }
  return { changed: out };
}
let timer = null;
function start() { if (!timer) { timer = setInterval(() => sync().catch(() => {}), 10 * 60 * 1000); if (timer.unref) timer.unref(); } }

module.exports = { wantRule, checkPortOf, publishedPorts, clusterServers, portState, overview, apply, sync, start };
