// Swarm with several servers — phase 2: nodes.
//
// Which DockGate server is which node: swarm_node_servers (written when DockGate creates or joins a node;
// for nodes joined elsewhere it is found by asking each DockGate server for its node ID).
// Joining servers (Create with several servers, Add servers…) is one job: checks → firewall rules on each
// server, allowing the Swarm ports only from the other cluster servers → docker swarm join, one server at
// a time → check each is Ready. If a step fails the job undoes what it did: joined servers leave, their
// nodes are removed, the firewall rules it added are deleted.
// Node actions (pause / drain / activate, promote / demote, labels) have guards: no drain without another
// server, the last manager is not demoted, the node DockGate talks to is not demoted or removed.
const { db, stmts } = require('./db');
const dns = require('dns').promises;
const dockerService = require('./docker');
const swarm = require('./swarm');
const { logAction } = require('./audit');

db.exec(`CREATE TABLE IF NOT EXISTS swarm_node_servers (
  cluster_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  fw_rules TEXT,                 -- JSON: firewall rules DockGate added on this server for the cluster
  PRIMARY KEY (cluster_id, node_id)
)`);
const q = {
  all: db.prepare('SELECT * FROM swarm_node_servers WHERE cluster_id = ?'),
  set: db.prepare(`INSERT INTO swarm_node_servers (cluster_id, node_id, server_id) VALUES (?, ?, ?)
    ON CONFLICT(cluster_id, node_id) DO UPDATE SET server_id = excluded.server_id`),
  del: db.prepare('DELETE FROM swarm_node_servers WHERE cluster_id = ? AND node_id = ?'),
  byServer: db.prepare('SELECT * FROM swarm_node_servers WHERE cluster_id = ? AND server_id = ?'),
  setFw: db.prepare('UPDATE swarm_node_servers SET fw_rules = ? WHERE cluster_id = ? AND node_id = ?'),
};
function remember(clusterId, nodeId, serverId) { if (clusterId && nodeId && serverId) q.set.run(clusterId, nodeId, serverId); }

/** A node's address: the manager advertise address when it has one (what other nodes use), else the address the manager sees. */
const nodeAddr = (n) => (n.ManagerStatus && n.ManagerStatus.Addr ? String(n.ManagerStatus.Addr).replace(/:\d+$/, '') : n.Status.Addr);
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const short = (id) => String(id || '').slice(0, 12);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not answer in ${Math.round(ms / 1000)}s`)), ms))]);

// ---- servers ----

function serverRow(id) {
  if (!id || id === 'local') return { id: 'local', type: 'local', name: 'Local' };
  return stmts.getServer.get(id) || null;
}
function allServers() {
  return [{ id: 'local', type: 'local', name: 'Local' }, ...stmts.getServers.all().filter(s => s.id !== 'local' && s.type !== 'local')];
}
function clientFor(id) {
  const row = serverRow(id);
  if (!row) throw bad(404, `Server ${id} not found`);
  return row.id === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(row);
}
const label = (row) => (row ? row.name || row.id : '?');

/** The manager DockGate talks to: the server in use, which must be a manager. */
async function manager() {
  const st = await swarm.status();
  if (st.state !== 'active') throw bad(409, 'Swarm is not active on the server in use');
  if (!st.manager) throw bad(409, 'The server in use is a worker — switch to a manager at the top');
  const c = dockerService.docker;
  const sw = await c.swarmInspect();
  return { client: c, serverId: st.serverId, nodeId: st.nodeId, addr: st.nodeAddr, clusterId: sw.ID, swarm: sw, status: st };
}

// ---- node ↔ server mapping ----

const deepCache = new Map(); // clusterId → time of the last full lookup
/** Map node ID → server ID for the cluster. Unknown nodes are looked up by asking every DockGate server (every 2 min at most). */
async function mapping(clusterId, nodes, { deep = true } = {}) {
  const m = new Map(q.all.all(clusterId).map(r => [r.node_id, r.server_id]));
  const missing = nodes.filter(n => !m.has(n.ID));
  const last = deepCache.get(clusterId) || 0;
  if (missing.length && deep && Date.now() - last > 120000) {
    deepCache.set(clusterId, Date.now());
    const known = new Set(m.values());
    await Promise.all(allServers().filter(s => !known.has(s.id)).map(async (s) => {
      try {
        const info = await withTimeout(clientFor(s.id).info(), 6000, s.id);
        const sw = info.Swarm || {};
        if (sw.NodeID && sw.Cluster && sw.Cluster.ID === clusterId) { remember(clusterId, sw.NodeID, s.id); m.set(sw.NodeID, s.id); }
        else if (sw.NodeID && nodes.some(n => n.ID === sw.NodeID)) { remember(clusterId, sw.NodeID, s.id); m.set(sw.NodeID, s.id); } // workers do not see the cluster ID
      } catch (e) { /* unreachable server */ }
    }));
  }
  return m;
}

// ---- nodes view ----

/** Placement constraints of a service, e.g. ["node.labels.db==true", "node.hostname==vps1"]. */
const constraintsOf = (svc) => ((svc.Spec.TaskTemplate || {}).Placement || {}).Constraints || [];
/** A service that can only run on one node (pinned by hostname or ID, or global). */
function pinnedTo(svc, nodes) {
  for (const c of constraintsOf(svc)) {
    const m = /^node\.(hostname|id)\s*==\s*(\S+)$/.exec(c.trim());
    if (m) return nodes.filter(n => (m[1] === 'id' ? n.ID === m[2] : n.Description.Hostname === m[2])).map(n => n.ID);
  }
  return null;
}
const hasVolume = (svc) => (((svc.Spec.TaskTemplate || {}).ContainerSpec || {}).Mounts || []).some(mt => mt.Type === 'volume');

async function nodes() {
  const mgr = await manager();
  const [list, services, tasks] = await Promise.all([mgr.client.listNodes(), mgr.client.listServices(), mgr.client.listTasks({ filters: JSON.stringify({ 'desired-state': ['running'] }) })]);
  const map = await mapping(mgr.clusterId, list);
  const servers = new Map(allServers().map(s => [s.id, s]));
  const running = new Map();
  for (const t of tasks) if (t.Status.State === 'running') running.set(t.NodeID, (running.get(t.NodeID) || 0) + 1);
  const labelUse = {};
  for (const s of services) for (const c of constraintsOf(s)) { const m = /node\.labels\.([\w.-]+)/.exec(c); if (m) (labelUse[m[1]] = labelUse[m[1]] || []).push(s.Spec.Name); }
  const managers = list.filter(n => n.Spec.Role === 'manager');
  return {
    self: mgr.nodeId,
    managerServer: mgr.serverId,
    labelUse,
    managers: managers.length,
    nodes: list.map(n => {
      const sid = map.get(n.ID) || null;
      return {
        id: n.ID, hostname: n.Description.Hostname, role: n.Spec.Role, availability: n.Spec.Availability, state: n.Status.State,
        addr: nodeAddr(n), leader: !!(n.ManagerStatus && n.ManagerStatus.Leader), reachability: n.ManagerStatus ? n.ManagerStatus.Reachability : null,
        engine: n.Description.Engine && n.Description.Engine.EngineVersion, arch: n.Description.Platform && n.Description.Platform.Architecture,
        labels: n.Spec.Labels || {}, tasks: running.get(n.ID) || 0, self: n.ID === mgr.nodeId,
        cpus: n.Description.Resources ? Math.round(n.Description.Resources.NanoCPUs / 1e8) / 10 : null, memBytes: n.Description.Resources ? n.Description.Resources.MemoryBytes : null,
        serverId: sid, serverName: sid && servers.get(sid) ? label(servers.get(sid)) : null,
      };
    }).sort((a, b) => (b.role === 'manager') - (a.role === 'manager') || a.hostname.localeCompare(b.hostname)),
  };
}

/** One node with everything the node page shows: what Nodes lists, plus OS, times, status message and
 *  the tasks Swarm placed on it (newest first, also ended ones still in Swarm's history). */
async function nodeDetail(nodeId) {
  const all = await nodes();
  const n = all.nodes.find(x => x.id === nodeId || x.hostname === nodeId);
  if (!n) throw bad(404, 'Node not found');
  const mgr = await manager();
  const [raw, tasks, services] = await Promise.all([
    mgr.client.getNode(n.id).inspect(),
    mgr.client.listTasks({ filters: JSON.stringify({ node: [n.id] }) }),
    mgr.client.listServices(),
  ]);
  const svc = new Map(services.map(s => [s.ID, s.Spec.Name]));
  const d = raw.Description || {};
  return {
    ...n, managers: all.managers, labelUse: all.labelUse, managerServer: all.managerServer, nodes: all.nodes.length,
    os: d.Platform ? d.Platform.OS : null, engineLabels: (d.Engine && d.Engine.Labels) || {},
    plugins: ((d.Engine && d.Engine.Plugins) || []).map(p => `${p.Type}: ${p.Name}`),
    createdAt: raw.CreatedAt, updatedAt: raw.UpdatedAt, message: raw.Status && raw.Status.Message || null,
    tasks: tasks.sort((a, b) => new Date(b.Status.Timestamp) - new Date(a.Status.Timestamp)).slice(0, 200).map(t => ({
      id: t.ID, serviceId: t.ServiceID, service: svc.get(t.ServiceID) || t.ServiceID.slice(0, 12), slot: t.Slot || null,
      state: t.Status.State, desired: t.DesiredState, error: t.Status.Err || null, message: t.Status.Message || null,
      image: String((t.Spec && t.Spec.ContainerSpec && t.Spec.ContainerSpec.Image) || '').split('@')[0], at: t.Status.Timestamp,
      container: t.Status.ContainerStatus && t.Status.ContainerStatus.ContainerID ? t.Status.ContainerStatus.ContainerID.slice(0, 12) : null,
    })),
  };
}

/** Docker events about this node (state, availability, role, labels), newest first. */
async function nodeEvents(nodeId, hours = 24) {
  const mgr = await manager();
  const now = Math.floor(Date.now() / 1000);
  const stream = await mgr.client.getEvents({ since: now - Math.min(Number(hours) || 24, 168) * 3600, until: now, filters: JSON.stringify({ type: ['node'], node: [nodeId] }) });
  return new Promise((resolve) => {
    let buf = ''; const out = [];
    const end = () => resolve(out.reverse().slice(0, 200));
    const t = setTimeout(() => { try { stream.destroy(); } catch (e) { /* gone */ } end(); }, 4000);
    stream.on('data', (chunk) => {
      buf += chunk.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const e = JSON.parse(line); const a = (e.Actor && e.Actor.Attributes) || {};
          out.push({ time: e.time, action: e.Action, detail: Object.entries(a).filter(([k]) => k !== 'name').map(([k, v]) => `${k}=${v}`).join(' ') });
        } catch (err) { /* partial line */ }
      }
    });
    stream.on('end', () => { clearTimeout(t); end(); });
    stream.on('error', () => { clearTimeout(t); end(); });
  });
}

/** What was done to this node from DockGate (audit log). */
function nodeAudit(hostname) {
  const { db } = require('./db');
  return db.prepare("SELECT action, details, created_at FROM activity WHERE resource_type = 'swarm-node' AND resource_name = ? ORDER BY id DESC LIMIT 50").all(hostname)
    .map(r => ({ action: r.action, details: (() => { try { return JSON.parse(r.details || '{}'); } catch (e) { return {}; } })(), at: r.created_at }));
}

/** DockGate servers that are not nodes of this cluster (for Add servers…). */
async function candidates() {
  const mgr = await manager();
  const list = await mgr.client.listNodes();
  const map = await mapping(mgr.clusterId, list);
  const inCluster = new Set(map.values());
  return allServers().filter(s => !inCluster.has(s.id)).map(s => ({ id: s.id, name: label(s), host: s.host || null, local: s.id === 'local' }));
}

// ---- checks before joining ----

/**
 * Checks for servers that should join. servers: [{ id, role }]. ref: the manager's facts
 * ({ version, arch, addr, hostnames:[] }) — for "Create with several servers" the first server is the manager.
 * Returns [{ id, name, checks:[…], addresses:[…], suggested, facts }] and ok.
 */
async function checkServers(servers, ref) {
  const out = [];
  const hostnames = new Map((ref.hostnames || []).map(h => [h, 'cluster']));
  const taken = new Set([ref.addr, ...(ref.addrs || [])].filter(Boolean)); // addresses other nodes already use
  for (const want of servers) {
    const row = serverRow(want.id);
    const r = { id: want.id, name: label(row), role: want.role, checks: [], addresses: [], suggested: null, facts: {} };
    const push = (id, lbl, st, detail, fix) => r.checks.push({ id, label: lbl, status: st, detail, fix: fix || null });
    out.push(r);
    if (!row) { push('server', 'Server', 'bad', 'This server is not in DockGate.'); continue; }
    let info;
    try { info = await withTimeout(clientFor(want.id).info(), 15000, label(row)); }
    catch (e) { push('reach', 'Docker on the server', 'bad', `DockGate can not reach Docker on ${label(row)}: ${e.message}`, 'Check the server in Servers → Test.'); continue; }
    const sw = info.Swarm || {};
    r.facts = { version: info.ServerVersion, arch: info.Architecture, hostname: info.Name };
    const mj = (v) => String(v || '').split('.').slice(0, 2).join('.');
    push('docker', 'Docker Engine', mj(info.ServerVersion) === mj(ref.version) ? 'ok' : 'warn', `Docker ${info.ServerVersion}${ref.version ? ` (the manager has ${ref.version})` : ''}.`,
      mj(info.ServerVersion) === mj(ref.version) ? null : 'Different Docker versions work, but keep them the same: update the older one.');
    if ((sw.LocalNodeState || 'inactive') !== 'inactive') push('state', 'Already in a swarm', 'bad', `${label(row)} is already ${sw.ControlAvailable ? 'a manager' : 'a node'} in a swarm.`, 'Leave that swarm first (docker swarm leave), or remove the node there.');
    else push('state', 'Not in a swarm', 'ok', 'The server can join.');
    if (info.LiveRestoreEnabled) push('live-restore', 'live-restore is on', 'bad', 'Swarm does not run while "live-restore" is on.', 'Set "live-restore": false in /etc/docker/daemon.json and restart Docker.');
    if (hostnames.has(info.Name)) push('hostname', 'Same host name', 'warn', `"${info.Name}" is already used by ${hostnames.get(info.Name) === 'cluster' ? 'a node in the cluster' : hostnames.get(info.Name)}. Swarm accepts it, but nodes are hard to tell apart and hostname placement rules match both.`, 'Give the server its own name: sudo hostnamectl set-hostname <name>, then restart Docker.');
    else push('hostname', 'Host name', 'ok', `"${info.Name}".`);
    hostnames.set(info.Name, label(row));
    if (ref.arch && info.Architecture !== ref.arch) push('arch', 'Different CPU', 'info', `${info.Architecture} while the manager is ${ref.arch}. Every image a service runs must exist for both (most official images do).`);
    // addresses
    r.addresses = (await swarm.addressCandidates(want.id).catch(() => [])).filter(a => !taken.has(a.ip));
    const mgrPrivate = ref.addr && swarm.isPrivate(ref.addr);
    const sameNet = (ip) => ref.addr && ip.split('.').slice(0, 2).join('.') === ref.addr.split('.').slice(0, 2).join('.');
    const pick = r.addresses.find(a => a.private && sameNet(a.ip)) || (mgrPrivate ? r.addresses.find(a => a.private) : null) || r.addresses.find(a => a.private) || r.addresses[0] || null;
    r.suggested = pick ? pick.ip : null;
    if (r.suggested) taken.add(r.suggested);
    if (!r.addresses.length) push('address', 'Address', 'warn', 'DockGate could not read the server\'s addresses; enter the one Swarm should use.');
    else push('address', 'Address', 'ok', `Suggested: ${r.suggested}${pick && pick.private ? ' (private network)' : ' (public — the overlay traffic should be encrypted)'}.`);
    if (want.id !== 'local') {
      const rc = require('./remote-compose');
      // clock: Swarm certificates and Raft need clocks within a few seconds
      try {
        const t0 = Date.now();
        const res = await rc.execRemote(row, 'date +%s; (timedatectl show -p NTPSynchronized --value 2>/dev/null || chronyc tracking 2>/dev/null | grep -c "Leap status *: Normal" || echo unknown)');
        const [secs, sync] = String(res.stdout || '').trim().split('\n');
        const diff = Math.abs(Number(secs) * 1000 - (t0 + Date.now()) / 2) / 1000;
        if (!Number.isFinite(diff)) push('clock', 'Clock', 'info', 'The clock could not be read.');
        else if (diff > 5 || /^(no|0)$/.test(String(sync).trim())) push('clock', 'Clock', 'warn', `The clock is ${diff > 5 ? `${Math.round(diff)}s off` : 'not synchronised (NTP)'}.`, 'Turn on time sync: Server Console → Setup → Time sync (chrony).');
        else push('clock', 'Clock', 'ok', `In sync${diff >= 1 ? ` (${diff.toFixed(1)}s)` : ''}.`);
      } catch (e) { push('clock', 'Clock', 'info', 'The clock could not be read over SSH.'); }
      // can it reach the manager's Swarm port?
      if (ref.preInit) push('ports', 'Reaches the manager', 'info', `Tested in the job, after the swarm is created on ${ref.addr}.`);
      else if (ref.addr) {
        try {
          const res = await rc.execRemote(row, `for p in 2377 7946; do (timeout 3 bash -c "</dev/tcp/${ref.addr}/$p" 2>/dev/null && echo "$p ok") || echo "$p fail"; done`);
          const okPorts = String(res.stdout || '');
          if (/2377 ok/.test(okPorts)) push('ports', 'Reaches the manager', 'ok', `${ref.addr}:2377 and :7946 answer.`.replace(':7946 answer', /7946 ok/.test(okPorts) ? ':7946 answer' : ' answers (7946 not yet)'));
          else push('ports', 'Manager not reachable yet', 'warn', `${label(row)} can not open ${ref.addr}:2377 now. DockGate opens the manager's firewall for this server before joining; if a cloud firewall (Hetzner, AWS…) is in front, allow 2377/tcp, 7946/tcp+udp and ${ref.dataPort || 4789}/udp between the servers there.`);
        } catch (e) { push('ports', 'Reaches the manager', 'info', 'Could not test over SSH.'); }
      }
      // firewall on this server
      try {
        const fw = await require('./routes/firewall').firewallOf(row);
        r.facts.firewall = fw.managed ? fw.backend : 'none';
        push('firewall', 'Firewall', fw.managed ? 'ok' : 'warn', fw.managed ? `${fw.backend === 'ufw' ? 'UFW' : 'firewalld'} is on: DockGate adds the Swarm ports for the other cluster servers only.` : 'No firewall is on: the Swarm ports would be open to the internet.', fw.managed ? null : 'Turn the firewall on in Server Console → Firewall (DockGate then adds the cluster rules).');
      } catch (e) { r.facts.firewall = 'unknown'; push('firewall', 'Firewall', 'info', 'The firewall could not be read; no rules will be added on this server.'); }
    } else {
      r.facts.firewall = 'local';
      push('firewall', 'Firewall', 'info', 'DockGate does not manage the firewall of the server it runs on. Allow 2377/tcp, 7946/tcp+udp and the data port (udp) from the other cluster servers yourself.');
    }
  }
  return { servers: out, ok: !out.some(s => s.checks.some(c => c.status === 'bad')) };
}

// ---- firewall ----

/** Rules a member needs: the Swarm ports from every other member's address. */
function rulesFor(peers, dataPort, encrypt) {
  const out = [];
  for (const ip of peers) {
    out.push({ ip, port: 2377, proto: 'tcp' }, { ip, port: 7946, proto: 'tcp' }, { ip, port: 7946, proto: 'udp' }, { ip, port: dataPort || 4789, proto: 'udp' });
    if (encrypt) out.push({ ip, port: null, proto: 'esp' });
  }
  return out;
}
/** Shell commands (run with sudo via {{S}}) that add or delete rules. */
function fwCommands(backend, zone, rules, remove = false) {
  const cmds = [];
  for (const r of rules) {
    if (!swarm.isIPv4(r.ip)) continue; // only IPv4 addresses are ever put in a command
    if (backend === 'ufw') {
      const spec = r.proto === 'esp' ? `proto esp from ${r.ip}` : `proto ${r.proto} from ${r.ip} to any port ${Number(r.port)}`;
      cmds.push(remove ? `({{S}}ufw delete allow ${spec} >/dev/null 2>&1 || true)` : `{{S}}ufw allow ${spec} comment 'dockgate:swarm' >/dev/null`);
    } else if (backend === 'firewalld') {
      const z = String(zone || 'public').replace(/[^\w-]/g, '');
      const rule = r.proto === 'esp' ? `rule family="ipv4" source address="${r.ip}" protocol value="esp" accept` : `rule family="ipv4" source address="${r.ip}" port port="${Number(r.port)}" protocol="${r.proto}" accept`;
      cmds.push(`${remove ? '(' : ''}{{S}}firewall-cmd --permanent --zone=${z} --${remove ? 'remove' : 'add'}-rich-rule='${rule}' >/dev/null${remove ? ' 2>&1 || true)' : ''}`);
    }
  }
  if (backend === 'firewalld' && cmds.length) cmds.push('{{S}}firewall-cmd --reload >/dev/null');
  return cmds;
}
/** Add (or remove) rules on one remote server. Returns the rules actually changed ([] when the firewall is off). */
async function applyFirewall(serverId, rules, log, remove = false) {
  if (!rules.length || serverId === 'local') return [];
  const row = serverRow(serverId);
  if (!row) return [];
  const fw = await require('./routes/firewall').firewallOf(row);
  if (!fw.managed) { if (!remove) log(`  ${label(row)}: no firewall is on — nothing to add`); return []; }
  const cmds = fwCommands(fw.backend, fw.zone, rules, remove);
  if (!cmds.length) return [];
  const { runOrThrow } = require('./security/route-helpers');
  await runOrThrow(row, { steps: [{ label: `${remove ? 'Remove' : 'Add'} Swarm firewall rules`, cmd: cmds.join(' && ') }] }, 'Swarm firewall');
  log(`  ${label(row)}: ${remove ? 'removed' : 'allowed'} ${[...new Set(rules.map(r => r.ip))].join(', ')} (${[...new Set(rules.map(r => r.proto === 'esp' ? 'esp' : `${r.port}/${r.proto}`))].join(', ')})`);
  return rules;
}
function storeFw(clusterId, nodeId, rules, add = true) {
  const row = q.all.all(clusterId).find(r => r.node_id === nodeId);
  if (!row) return;
  let have = []; try { have = JSON.parse(row.fw_rules || '[]'); } catch (e) { /* reset */ }
  const key = (r) => `${r.ip}|${r.port}|${r.proto}`;
  const set = new Map(have.map(r => [key(r), r]));
  for (const r of rules) { if (add) set.set(key(r), r); else set.delete(key(r)); }
  q.setFw.run(JSON.stringify([...set.values()]), clusterId, nodeId);
}
const storedFw = (clusterId, nodeId) => { const row = q.all.all(clusterId).find(r => r.node_id === nodeId); try { return JSON.parse((row && row.fw_rules) || '[]'); } catch (e) { return []; } };

// ---- join ----

/**
 * Join servers to the cluster of `mgrClient`, inside a job. servers: [{ id, role, addr }].
 * Undoes its own work (joins, nodes, firewall rules) and rethrows when a step fails.
 */
async function joinServers({ job, log, step, mgrClient, mgrServerId, servers, encrypt = false, sourceIp }) {
  const sw = await mgrClient.swarmInspect();
  const clusterId = sw.ID;
  const info = await mgrClient.info();
  const mgrAddr = info.Swarm.NodeAddr;
  const dataPort = sw.DataPathPort || 4789;
  const existing = await mgrClient.listNodes();
  const map = await mapping(clusterId, existing);
  const members = existing.map(n => ({ nodeId: n.ID, serverId: map.get(n.ID) || null, ip: nodeAddr(n) }));
  const newIps = servers.map(s => s.addr);
  const allIps = [...members.map(m => m.ip), ...newIps];
  const done = []; // { serverId, nodeId, fw: [] }
  const fwAdded = []; // { serverId, nodeId, rules }
  try {
    // 1. firewall: every member allows the others (existing members only need the new addresses)
    step(job, 'firewall', 'running', 'Open the Swarm ports between the servers');
    for (const m of members) {
      if (!m.serverId) { log(`  node ${m.ip}: not in DockGate — open its firewall yourself for ${newIps.join(', ')}`); continue; }
      const rules = await applyFirewall(m.serverId, rulesFor(newIps.filter(ip => ip !== m.ip), dataPort, encrypt), log);
      if (rules.length) { fwAdded.push({ serverId: m.serverId, nodeId: m.nodeId, rules }); storeFw(clusterId, m.nodeId, rules); }
    }
    const pendingFw = new Map();
    for (const s of servers) {
      const rules = await applyFirewall(s.id, rulesFor(allIps.filter(ip => ip !== s.addr), dataPort, encrypt), log);
      if (rules.length) { fwAdded.push({ serverId: s.id, nodeId: null, rules }); pendingFw.set(s.id, rules); }
    }
    step(job, 'firewall', 'done');
    // 2. join one by one
    for (const s of servers) {
      const row = serverRow(s.id);
      step(job, `join-${s.id}`, 'running', `${label(row)} joins as ${s.role}`);
      const c = clientFor(s.id);
      log(`$ docker swarm join --advertise-addr ${s.addr} --token <${s.role} token> ${mgrAddr}:2377   (on ${label(row)})`);
      const local = (await swarm.addressCandidates(s.id).catch(() => [])).some(a => a.ip === s.addr);
      try { await withTimeout(c.swarmJoin({ ListenAddr: `${local ? s.addr : '0.0.0.0'}:2377`, AdvertiseAddr: s.addr, RemoteAddrs: [`${mgrAddr}:2377`], JoinToken: s.role === 'manager' ? sw.JoinTokens.Manager : sw.JoinTokens.Worker }), 60000, `Join on ${label(row)}`); }
      catch (e) { throw new Error(`${label(row)} could not join: ${swarm.dockerMsg(e)}`); }
      const nodeId = (await c.info()).Swarm.NodeID;
      done.push({ serverId: s.id, nodeId });
      remember(clusterId, nodeId, s.id);
      if (pendingFw.has(s.id)) { storeFw(clusterId, nodeId, pendingFw.get(s.id)); const f = fwAdded.find(x => x.serverId === s.id && !x.nodeId); if (f) f.nodeId = nodeId; }
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) {
        const n = (await mgrClient.listNodes()).find(x => x.ID === nodeId);
        if (n && n.Status.State === 'ready') { ready = true; log(`✓ ${label(row)} (${n.Description.Hostname}): ${n.Spec.Role}, ready, ${s.addr}`); }
        else await new Promise(r => setTimeout(r, 1000));
      }
      if (!ready) throw new Error(`${label(row)} joined but did not become Ready — the servers probably can not reach each other on 7946 or the data port`);
      step(job, `join-${s.id}`, 'done');
    }
    // Stacks and new networks use encrypted overlays from now on when it was chosen here.
    if (encrypt) stmts.setSetting.run(`swarm_overlay_encrypt:${clusterId}`, '1');
    logAction({ sourceIp, server: mgrServerId, resourceType: 'swarm', resourceName: 'nodes', action: 'swarm_join', details: { servers: servers.map(s => ({ id: s.id, role: s.role, addr: s.addr })), encrypt } });
  } catch (e) {
    step(job, 'undo-join', 'running', 'Undo: remove the servers that joined and the firewall rules');
    for (const d of done.reverse()) {
      try { await withTimeout(clientFor(d.serverId).swarmLeave({ force: true }), 30000, d.serverId); log(`  ${label(serverRow(d.serverId))} left the swarm`); } catch (u) { log(`  ✗ ${d.serverId} could not leave: ${swarm.dockerMsg(u)}`); }
      try { await new Promise(r => setTimeout(r, 1500)); await mgrClient.getNode(d.nodeId).remove({ force: true }); } catch (u) { /* gone already */ }
      q.del.run(clusterId, d.nodeId);
    }
    for (const f of fwAdded) {
      try { await applyFirewall(f.serverId, f.rules, log, true); if (f.nodeId) storeFw(clusterId, f.nodeId, f.rules, false); } catch (u) { log(`  ✗ firewall on ${f.serverId}: ${u.message}`); }
    }
    step(job, 'undo-join', 'done');
    throw e;
  }
}

function validateServers(list) {
  if (!Array.isArray(list) || !list.length) throw bad(400, 'Choose at least one server');
  if (list.length > 20) throw bad(400, 'At most 20 servers at a time');
  const seen = new Set();
  return list.map(s => {
    const id = String(s.id || '');
    if (!serverRow(id)) throw bad(400, `Server ${id} not found`);
    if (seen.has(id)) throw bad(400, `${id} is listed twice`);
    seen.add(id);
    const role = s.role === 'manager' ? 'manager' : 'worker';
    const addr = String(s.addr || '').trim();
    if (!swarm.isIPv4(addr)) throw bad(400, `Enter the address ${label(serverRow(id))} should use`);
    if (list.filter(x => String(x.addr || '').trim() === addr).length > 1) throw bad(400, `${addr} is given for two servers — each server needs its own address`);
    return { id, role, addr };
  });
}

/** Add servers to the running cluster (Add servers…). */
async function startAddServers(body, { sourceIp } = {}) {
  const servers = validateServers(body.servers);
  const mgr = await manager();
  if (servers.some(s => s.id === mgr.serverId)) throw bad(400, 'The server in use is already in the cluster');
  const used = (await mgr.client.listNodes()).map(nodeAddr);
  const clash = servers.find(s => used.includes(s.addr));
  if (clash) throw bad(400, `${clash.addr} is already used by a node in the cluster`);
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const job = swarm._jobs.newJob('join', servers.map(s => s.name || s.addr).join(', '));
  swarm._jobs.setCurrent(job);
  const log = swarm._jobs.logTo(job), step = swarm._jobs.step;
  (async () => {
    try {
      await joinServers({ job, log, step, mgrClient: mgr.client, mgrServerId: mgr.serverId, servers, encrypt: !!body.encrypt, sourceIp });
      job.status = 'done';
      log(`✓ ${servers.length} server${servers.length > 1 ? 's' : ''} added.`);
    } catch (e) {
      job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      job.status = 'error'; job.error = e.message; log('✗ ' + e.message);
    } finally { job.finishedAt = Date.now(); }
  })();
  return job;
}

/** Create a swarm with several servers: init on the server in use, then join the others in the same job. */
async function startCreateCluster(body, { sourceIp } = {}) {
  const servers = validateServers(body.servers || []);
  const me = dockerService.getActiveServerId() || 'local';
  if (servers.some(s => s.id === me)) throw bad(400, 'The server in use is the first manager — do not list it again');
  if (body.advertiseAddr && servers.some(s => s.addr === body.advertiseAddr)) throw bad(400, `${body.advertiseAddr} is the first manager's address — each server needs its own`);
  if (servers.length && !body.advertiseAddr) throw bad(400, 'With several servers, choose the address the first manager uses');
  return swarm.startInit(body, {
    sourceIp,
    join: async ({ job, log, step, client }) => joinServers({ job, log, step, mgrClient: client, mgrServerId: me, servers, encrypt: !!body.encrypt, sourceIp }),
  });
}

// ---- node actions ----

const LABEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
function parseLabels(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(400, 'labels must be an object');
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!LABEL_KEY.test(k)) throw bad(400, `Label "${k}": use letters, digits, dot, dash or underscore`);
    const val = String(v == null ? '' : v);
    if (/[\r\n]/.test(val) || val.length > 200) throw bad(400, `Label "${k}": the value must be one line, at most 200 characters`);
    out[k] = val;
  }
  if (Object.keys(out).length > 50) throw bad(400, 'At most 50 labels per node');
  return out;
}

/** What draining a node would do: tasks that move, services that would have nowhere to run. */
async function drainImpact(nodeId) {
  const mgr = await manager();
  const [list, services, tasks] = await Promise.all([mgr.client.listNodes(), mgr.client.listServices(), mgr.client.listTasks({ filters: JSON.stringify({ node: [nodeId], 'desired-state': ['running'] }) })]);
  const target = list.find(n => n.ID === nodeId);
  if (!target) throw bad(404, 'Node not found');
  const others = list.filter(n => n.ID !== nodeId && n.Status.State === 'ready' && n.Spec.Availability === 'active');
  const svcById = new Map(services.map(s => [s.ID, s]));
  const moves = [], stuck = [];
  for (const t of tasks) {
    const s = svcById.get(t.ServiceID); if (!s) continue;
    const name = s.Spec.Name;
    const pin = pinnedTo(s, list);
    if (s.Spec.Mode && s.Spec.Mode.Global) stuck.push({ service: name, why: 'global service: it simply stops on this server' });
    else if (pin && pin.length === 1 && pin[0] === nodeId) stuck.push({ service: name, why: 'pinned to this server (placement rule) — it stops until the server is active again' });
    else if (!others.length) stuck.push({ service: name, why: 'no other active server' });
    else moves.push({ service: name, volume: hasVolume(s) });
  }
  return { node: target.Description.Hostname, others: others.length, moves, stuck };
}

async function updateNode(nodeId, change, { sourceIp } = {}) {
  const mgr = await manager();
  const list = await mgr.client.listNodes();
  const n = list.find(x => x.ID === nodeId);
  if (!n) throw bad(404, 'Node not found');
  const spec = { ...n.Spec };
  const what = [];
  if (change.availability) {
    if (!['active', 'pause', 'drain'].includes(change.availability)) throw bad(400, 'availability must be active, pause or drain');
    if (change.availability === 'drain' && !list.some(x => x.ID !== nodeId && x.Status.State === 'ready' && x.Spec.Availability === 'active')) {
      throw bad(400, 'No other active server: draining would stop every service (they would wait as Pending). Use Pause instead, or add a server first.');
    }
    spec.Availability = change.availability; what.push(`availability ${n.Spec.Availability} → ${change.availability}`);
  }
  if (change.role) {
    if (!['manager', 'worker'].includes(change.role)) throw bad(400, 'role must be manager or worker');
    const managers = list.filter(x => x.Spec.Role === 'manager');
    if (change.role === 'worker' && n.Spec.Role === 'manager') {
      if (managers.length === 1) throw bad(400, 'This is the last manager — promote another server first');
      if (nodeId === mgr.nodeId) throw bad(400, 'DockGate manages the cluster through this server — switch DockGate to another manager first (server picker at the top)');
    }
    spec.Role = change.role; what.push(`role ${n.Spec.Role} → ${change.role}`);
  }
  if (change.labels !== undefined) { spec.Labels = parseLabels(change.labels); what.push('labels'); }
  if (!what.length) throw bad(400, 'Nothing to change');
  await mgr.client.getNode(nodeId).update({ version: n.Version.Index, ...spec });
  logAction({ sourceIp, server: mgr.serverId, resourceType: 'swarm-node', resourceId: nodeId, resourceName: n.Description.Hostname, action: 'swarm_node_update', details: { change: what, labels: change.labels } });
  return { ok: true, changed: what };
}

/** Rebalance: restart the tasks of services that can move, one service at a time. */
async function startRebalance({ sourceIp } = {}) {
  const mgr = await manager();
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const job = swarm._jobs.newJob('rebalance'); swarm._jobs.setCurrent(job);
  const log = swarm._jobs.logTo(job), step = swarm._jobs.step;
  (async () => {
    try {
      const [list, services] = await Promise.all([mgr.client.listNodes(), mgr.client.listServices()]);
      const movable = services.filter(s => s.Spec.Mode && s.Spec.Mode.Replicated && !pinnedTo(s, list) && !hasVolume(s));
      for (const s of services) if (!movable.includes(s)) log(`· ${s.Spec.Name}: left alone (${s.Spec.Mode && s.Spec.Mode.Global ? 'global' : hasVolume(s) ? 'has a data volume' : 'pinned to a server'})`);
      if (!movable.length) log('Nothing to move.');
      for (const s of movable) {
        step(job, `svc-${s.ID}`, 'running', `Spread ${s.Spec.Name}`);
        const cur = await mgr.client.getService(s.ID).inspect();
        const tt = { ...cur.Spec.TaskTemplate, ForceUpdate: ((cur.Spec.TaskTemplate || {}).ForceUpdate || 0) + 1 };
        await require('./swarm-services').writeSpec(mgr.client, s.ID, cur.Version.Index, { ...cur.Spec, TaskTemplate: tt }); // spec in the body, registry login sent
        log(`$ docker service update --force ${s.Spec.Name}`);
        for (let i = 0; i < 90; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const x = await mgr.client.getService(s.ID).inspect();
          const us = x.UpdateStatus || {};
          if (['completed', 'paused', 'rollback_completed', 'rollback_paused'].includes(us.State)) { log(`  ${s.Spec.Name}: ${us.State}${us.Message ? ` — ${us.Message}` : ''}`); break; }
          if (i === 89) log(`  ${s.Spec.Name}: still updating, going on`);
        }
        step(job, `svc-${s.ID}`, 'done');
      }
      job.status = 'done'; log('✓ Rebalanced');
      logAction({ sourceIp, server: mgr.serverId, resourceType: 'swarm', resourceName: 'cluster', action: 'swarm_rebalance', details: { services: movable.map(s => s.Spec.Name) } });
    } catch (e) {
      job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      job.status = 'error'; job.error = swarm.dockerMsg(e) || e.message; log('✗ ' + job.error);
    } finally { job.finishedAt = Date.now(); }
  })();
  return job;
}

/** Remove a node: demote (manager) → drain → leave on the server → remove from the list → delete its firewall rules. */
async function startRemoveNode(nodeId, { sourceIp } = {}) {
  const mgr = await manager();
  const list = await mgr.client.listNodes();
  const n = list.find(x => x.ID === nodeId);
  if (!n) throw bad(404, 'Node not found');
  if (nodeId === mgr.nodeId) throw bad(400, 'DockGate manages the cluster through this node — switch to another manager first, or turn Swarm off in Cluster settings');
  if (n.ManagerStatus && n.ManagerStatus.Leader) throw bad(400, 'This node is the leader — demote it first (leadership moves to another manager)');
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const map = await mapping(mgr.clusterId, list);
  const sid = map.get(nodeId) || null;
  const name = n.Description.Hostname;
  const job = swarm._jobs.newJob('remove', name); swarm._jobs.setCurrent(job);
  const log = swarm._jobs.logTo(job), step = swarm._jobs.step;
  (async () => {
    try {
      const node = () => mgr.client.getNode(nodeId);
      if (n.Spec.Role === 'manager') {
        step(job, 'demote', 'running', `Demote ${name}`);
        const x = await node().inspect();
        await node().update({ version: x.Version.Index, ...x.Spec, Role: 'worker' });
        step(job, 'demote', 'done');
      }
      if (n.Status.State === 'ready') {
        step(job, 'drain', 'running', `Drain ${name}: move its tasks`);
        const x = await node().inspect();
        if (x.Spec.Availability !== 'drain') await node().update({ version: x.Version.Index, ...x.Spec, Availability: 'drain' });
        for (let i = 0; i < 60; i++) {
          const t = await mgr.client.listTasks({ filters: JSON.stringify({ node: [nodeId], 'desired-state': ['running'] }) });
          if (!t.length) break;
          if (i === 59) log(`  ${t.length} task(s) still on ${name}, going on`);
          await new Promise(r => setTimeout(r, 1000));
        }
        step(job, 'drain', 'done');
      }
      if (sid) {
        step(job, 'leave', 'running', `${name} leaves the swarm`);
        try { await withTimeout(clientFor(sid).swarmLeave({ force: false }), 30000, name); log(`$ docker swarm leave   (on ${label(serverRow(sid))})`); }
        catch (e) { log(`  could not leave on the server (${swarm.dockerMsg(e)}) — removing it from the list anyway`); }
        step(job, 'leave', 'done');
      } else log(`${name} is not in DockGate: it is removed from the list; run "docker swarm leave" on it yourself.`);
      step(job, 'remove', 'running', 'Remove it from the node list');
      for (let i = 0; i < 20; i++) {
        const x = await node().inspect().catch(() => null);
        if (!x || x.Status.State === 'down') break;
        await new Promise(r => setTimeout(r, 1000));
      }
      await node().remove({ force: true }).catch(e => { if (e.statusCode !== 404) throw e; });
      step(job, 'remove', 'done');
      step(job, 'firewall', 'running', 'Delete its firewall rules');
      const rows = q.all.all(mgr.clusterId);
      for (const r of rows) {
        if (r.node_id === nodeId) { await applyFirewall(r.server_id, storedFw(mgr.clusterId, nodeId), log, true).catch(e => log(`  ✗ ${e.message}`)); continue; }
        const mine = storedFw(mgr.clusterId, r.node_id).filter(x => x.ip === nodeAddr(n));
        if (mine.length) { await applyFirewall(r.server_id, mine, log, true).catch(e => log(`  ✗ ${e.message}`)); storeFw(mgr.clusterId, r.node_id, mine, false); }
      }
      q.del.run(mgr.clusterId, nodeId);
      step(job, 'firewall', 'done');
      job.status = 'done'; log(`✓ ${name} removed`);
      logAction({ sourceIp, server: mgr.serverId, resourceType: 'swarm-node', resourceId: nodeId, resourceName: name, action: 'swarm_node_remove', details: { serverId: sid } });
    } catch (e) {
      job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      job.status = 'error'; job.error = swarm.dockerMsg(e) || e.message; log('✗ ' + job.error);
    } finally { job.finishedAt = Date.now(); }
  })();
  return job;
}

/**
 * Allow ESP (encrypted overlay traffic) between every pair of cluster servers DockGate manages, where it is not
 * allowed yet. Called when an encrypted network is created. Returns what was done per server.
 */
async function ensureEsp() {
  const mgr = await manager();
  const nodesNow = await mgr.client.listNodes();
  if (nodesNow.length < 2) return { servers: [], note: 'one server: nothing to open' };
  const map = await mapping(mgr.clusterId, nodesNow);
  const members = nodesNow.map(n => ({ nodeId: n.ID, serverId: map.get(n.ID) || null, ip: nodeAddr(n) }));
  const out = [];
  const lines = [];
  for (const m of members) {
    if (!m.serverId || m.serverId === 'local') { out.push({ node: m.ip, done: false, why: m.serverId ? 'DockGate\'s own server: allow ESP (protocol 50) yourself' : 'not in DockGate' }); continue; }
    const have = new Set(storedFw(mgr.clusterId, m.nodeId).filter(r => r.proto === 'esp').map(r => r.ip));
    const want = members.filter(o => o !== m && !have.has(o.ip)).map(o => ({ ip: o.ip, port: null, proto: 'esp' }));
    if (!want.length) { out.push({ node: m.ip, server: m.serverId, done: true, why: 'already allowed' }); continue; }
    const added = await applyFirewall(m.serverId, want, (l) => lines.push(l));
    if (added.length) storeFw(mgr.clusterId, m.nodeId, added);
    out.push({ node: m.ip, server: m.serverId, done: !!added.length, why: added.length ? `ESP allowed from ${added.map(r => r.ip).join(', ')}` : 'no firewall is on' });
  }
  stmts.setSetting.run(`swarm_overlay_encrypt:${mgr.clusterId}`, '1');
  return { servers: out, log: lines };
}

/** Extra Overview warnings for several servers: nodes not in DockGate, uneven task spread. */
async function overviewExtras(ov) {
  if (!ov || !ov.nodes || ov.nodes.length < 2) return ov;
  try {
    const mgr = await manager();
    const raw = await mgr.client.listNodes();
    const map = await mapping(mgr.clusterId, raw, { deep: false });
    const servers = new Map(allServers().map(s => [s.id, s]));
    for (const n of ov.nodes) { const sid = map.get(n.id); n.serverId = sid || null; n.serverName = sid && servers.get(sid) ? label(servers.get(sid)) : null; }
    const unknown = ov.nodes.filter(n => !n.serverId);
    if (unknown.length) ov.warnings.push({ level: 'warn', text: `${unknown.length} node${unknown.length > 1 ? 's are' : ' is'} not in DockGate (${unknown.map(n => `${n.hostname} ${n.addr}`).join(', ')}): terminal, logs and firewall do not work there. Swarm → Nodes → Add to DockGate…`, action: 'nodes' });
    const usable = ov.nodes.filter(n => n.state === 'ready' && n.availability === 'active');
    const counts = usable.map(n => n.tasks.filter(t => t.state === 'running').length);
    if (usable.length > 1 && Math.min(...counts) === 0 && Math.max(...counts) >= 2) ov.warnings.push({ level: 'warn', text: 'Tasks are not spread evenly: a server that came back gets no tasks by itself.', action: 'rebalance' });
  } catch (e) { /* the overview works without it */ }
  return ov;
}

module.exports = { ensureEsp, remember, nodes, nodeDetail, nodeEvents, nodeAudit, candidates, checkServers, startAddServers, startCreateCluster, drainImpact, updateNode, startRebalance, startRemoveNode, overviewExtras, rulesFor, fwCommands, parseLabels, pinnedTo };
