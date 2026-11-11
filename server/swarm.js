// Docker Swarm on the server in use — phase 1: one server.
//
// status()     what the Docker daemon says about Swarm (inactive / active / locked / error), manager or worker
// checks()     what is looked at before "Create Swarm": Docker version, already in a swarm, live-restore,
//              the address to advertise, overlap of the overlay address pool with this server's networks,
//              the firewall note, compose projects that keep running
// startInit()  a job (live log, can be reopened): swarm init with the chosen options, verify the node is
//              Ready, keep the autolock key (encrypted); if the check after init fails, leave again
// overview()   nodes, services, tasks per node, warnings, last Swarm events — read from the manager
// settings(), unlock(), leave()
//
// Compose projects are not touched in this phase: `docker swarm init` does not stop or change containers.
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const dns = require('dns').promises;
const dockerService = require('./docker');
const { stmts } = require('./db');
const { encrypt, decrypt } = require('./auth/secrets');
const { logAction } = require('./audit');

const serverId = () => dockerService.getActiveServerId() || 'local';
const client = () => dockerService.docker;

// ---- small helpers ----

/** A raw Docker API call through the client's modem (for endpoints dockerode has no method for). */
function dial(c, path, method = 'GET', options = {}) {
  return new Promise((resolve, reject) => {
    c.modem.dial({ path, method, options, statusCodes: { 200: true, 204: true, 400: 'bad parameter', 403: 'forbidden', 500: 'server error', 503: 'node is not part of a swarm' } }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}
/** Docker's own message from a dockerode error ("(HTTP code 400) … - <message>"). */
function dockerMsg(e) {
  if (!e) return '';
  if (e.json && e.json.message) return String(e.json.message);
  const m = /- (.+)$/.exec(String(e.message || '')); return m ? m[1] : String(e.message || e);
}

function ipToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
function parseCidr(c) {
  const m = /^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/.exec(String(c || '').trim());
  if (!m || m[1].split('.').some(x => Number(x) > 255)) return null;
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const base = (ipToInt(m[1]) & mask) >>> 0;
  return { base, end: (base + (2 ** (32 - bits)) - 1) >>> 0, bits };
}
function overlaps(a, b) { const x = parseCidr(a), y = parseCidr(b); return !!(x && y && x.base <= y.end && y.base <= x.end); }
const isPrivate = (ip) => ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].some(c => overlaps(c, ip));
const isIPv4 = (s) => !!parseCidr(s) && !String(s).includes('/');

/** Pools to suggest when the default one overlaps something on the server. */
const POOL_CANDIDATES = ['10.0.0.0/8', '10.200.0.0/16', '10.201.0.0/16', '10.150.0.0/16', '172.30.0.0/16', '172.31.0.0/16', '192.168.240.0/20'];

// ---- status ----

/** Swarm state of the server in use, from `docker info`. */
async function status() {
  const info = await client().info();
  const sw = info.Swarm || {};
  const st = sw.LocalNodeState || 'inactive';
  return {
    serverId: serverId(),
    serverName: info.Name,
    state: st, // inactive | pending | active | error | locked
    manager: !!sw.ControlAvailable,
    nodeId: sw.NodeID || null,
    nodeAddr: sw.NodeAddr || null,
    nodes: sw.Nodes || 0,
    managers: sw.Managers || 0,
    error: sw.Error || null,
    clusterId: sw.Cluster && sw.Cluster.ID || null,
    dockerVersion: info.ServerVersion,
    arch: info.Architecture,
    liveRestore: !!info.LiveRestoreEnabled,
    hasStoredKey: !!((stmts.getSetting.get(`swarm_unlock_key:${serverId()}`) || {}).value),
  };
}

// ---- checks ----

/** IPv4 addresses of the server, for --advertise-addr. [{ ip, iface, private }] */
async function addressCandidates(forServer) {
  const sid = forServer || serverId();
  const out = [];
  const add = (ip, iface) => { if (isIPv4(ip) && !ip.startsWith('127.') && !out.some(a => a.ip === ip)) out.push({ ip, iface: iface || '', private: isPrivate(ip) }); };
  if (sid === 'local') {
    // DockGate in a container sees its own interfaces, not the host's — then Docker chooses (or says which to pick).
    if (!fs.existsSync('/.dockerenv')) for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) add(a.address, name);
  } else {
    const rc = require('./remote-compose');
    const srv = stmts.getServer.get(sid);
    try {
      const r = await rc.execRemote(srv, "ip -o -4 addr show scope global 2>/dev/null | awk '{print $2\" \"$4}'");
      for (const line of String(r.stdout || '').split('\n')) { const [iface, cidr] = line.trim().split(/\s+/); if (cidr) add(cidr.split('/')[0], iface); }
    } catch (e) { /* SSH failed: fall back to the host name */ }
    if (srv && srv.host) {
      if (isIPv4(srv.host)) add(srv.host, 'SSH address');
      else { try { const r = await dns.lookup(srv.host, { family: 4 }); add(r.address, `SSH address (${srv.host})`); } catch (e) { /* unresolved */ } }
    }
  }
  // Interfaces Docker makes (docker0, br-…, veth) are not addresses to advertise.
  return out.filter(a => !/^(docker|br-|veth|virbr|cni|flannel|cali|tun|wg)/.test(a.iface) || a.iface.startsWith('SSH'));
}

/**
 * Checks before "Create Swarm" on the server in use. Each: { id, label, status: ok|warn|bad|info, detail, fix? }.
 * Also returns the address candidates and a pool to use.
 */
async function checks({ pool, multi = false } = {}) {
  const c = client();
  const info = await c.info();
  const sw = info.Swarm || {};
  const list = [];
  const push = (id, label, st, detail, fix) => list.push({ id, label, status: st, detail, fix: fix || null });

  const major = Number(String(info.ServerVersion || '0').split('.')[0]);
  push('docker', 'Docker Engine', major >= 20 ? 'ok' : 'bad', `Docker ${info.ServerVersion} on ${info.OperatingSystem || info.OSType} (${info.Architecture}).`,
    major >= 20 ? null : 'Update Docker to version 20.10 or newer.');

  const st = sw.LocalNodeState || 'inactive';
  if (st === 'inactive') push('state', 'Not in a swarm yet', 'ok', 'This server is not part of a swarm.');
  else push('state', 'Already in a swarm', 'bad', `This server is ${st === 'active' ? (sw.ControlAvailable ? 'a manager' : 'a worker') : st} in a swarm${sw.Cluster ? ` (cluster ${String(sw.Cluster.ID).slice(0, 12)})` : ''}.`,
    st === 'active' ? 'Open Swarm → Overview, or leave the swarm in Cluster settings first.' : 'Leave the swarm first: docker swarm leave --force');

  if (info.LiveRestoreEnabled) {
    push('live-restore', 'live-restore is on', 'bad', 'Docker does not allow Swarm while "live-restore" is on in /etc/docker/daemon.json.',
      'Set "live-restore": false in /etc/docker/daemon.json and restart Docker (sudo systemctl restart docker). Containers with a restart policy start again; others stay stopped.');
  } else push('live-restore', 'live-restore is off', 'ok', 'Swarm can run with this Docker configuration.');

  push('hostname', 'Server name', 'ok', `The node will be called "${info.Name}".`);

  const addrs = await addressCandidates().catch(() => []);
  if (addrs.length) {
    const pick = addrs.find(a => a.private) || addrs[0];
    push('address', 'Address for Swarm', 'ok', `${addrs.length} address${addrs.length > 1 ? 'es' : ''} found: ${addrs.map(a => `${a.ip}${a.iface ? ` (${a.iface})` : ''}`).join(', ')}. Suggested: ${pick.ip}${pick.private ? ' (private network)' : ''}. You can change it in the next step.`);
  } else {
    push('address', 'Address for Swarm', 'info', 'DockGate can not list this server\'s addresses (it runs in a container). Docker chooses the address; if the server has several, DockGate asks you which one.');
  }

  // Overlay address pool: overlay networks (and the ingress network) take /24s from it. If it overlaps a
  // network the server already uses (a cloud private network such as 10.0.0.0/16, a Docker bridge, a VPN),
  // traffic to that network breaks.
  const used = [];
  for (const a of addrs) used.push({ cidr: `${a.ip}/32`, what: `server address ${a.ip}${a.iface ? ` (${a.iface})` : ''}` });
  try {
    for (const n of await c.listNetworks()) for (const cfg of (n.IPAM && n.IPAM.Config) || []) if (cfg.Subnet && isIPv4(cfg.Subnet.split('/')[0])) used.push({ cidr: cfg.Subnet, what: `Docker network ${n.Name} (${cfg.Subnet})` });
  } catch (e) { /* ignore */ }
  const want = pool || '10.0.0.0/8';
  const clash = (p) => used.filter(u => overlaps(p, u.cidr));
  const hits = clash(want);
  const free = POOL_CANDIDATES.find(p => !clash(p).length) || null;
  if (!parseCidr(want)) push('pool', 'Overlay address pool', 'bad', `"${want}" is not a valid network (example: 10.200.0.0/16).`);
  else if (hits.length) {
    push('pool', 'Overlay address pool overlaps', 'warn', `The pool ${want} overlaps ${hits.slice(0, 3).map(h => h.what).join(', ')}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}. Containers could not reach those addresses.`,
      free ? `Use ${free} (it is set in the next step).` : 'Pick a pool that is not used on this server.');
  } else push('pool', 'Overlay address pool', 'ok', `${want} does not overlap this server's networks.`);

  if (multi) push('firewall', 'Firewall', 'info', 'Several servers: DockGate opens 2377/tcp, 7946/tcp+udp and the data port (udp) on each server for the other cluster servers only.');
  else push('firewall', 'Firewall', 'info', 'One server: no ports are opened. Docker listens on 2377/tcp for Swarm management (mutual TLS; joining needs a token). Keep it closed to the internet in the server\'s firewall (Server Console → Firewall) — with UFW\'s default "deny incoming" it is.');

  try {
    const projects = await dockerService.listComposeProjects();
    push('compose', 'Compose projects keep running', 'info', projects.length
      ? `${projects.length} compose project${projects.length > 1 ? 's' : ''} (${projects.slice(0, 5).map(p => p.name).join(', ')}${projects.length > 5 ? ', …' : ''}) ${projects.length > 1 ? 'keep' : 'keeps'} running as they are. Moving them to Swarm is a separate, later step.`
      : 'No compose projects on this server.');
  } catch (e) { /* ignore */ }

  return { checks: list, addresses: addrs, pool: hits.length && free ? free : want, ok: !list.some(x => x.status === 'bad') };
}

// ---- init job ----

const jobs = new Map();
let currentJob = null;
function newJob(kind) {
  const job = { id: crypto.randomBytes(8).toString('hex'), kind, serverId: serverId(), status: 'running', steps: [], log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > 6 * 3600000) jobs.delete(k);
  return job;
}
const logTo = (job) => (line) => { job.log += line + '\n'; };
function step(job, id, st, label) {
  let s = job.steps.find(x => x.id === id);
  if (!s) { s = { id, label: label || id, status: 'pending' }; job.steps.push(s); }
  if (label) s.label = label;
  s.status = st;
}

/** Validate and normalise the Create Swarm options. Throws a 400 with the reason. */
function initOptions(body = {}) {
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  const o = {};
  const adv = String(body.advertiseAddr || '').trim();
  if (adv && !isIPv4(adv)) throw bad('The address must be an IPv4 address of this server');
  o.advertiseAddr = adv || null;
  const pool = String(body.pool || '10.0.0.0/8').trim();
  const pc = parseCidr(pool);
  if (!pc || !pool.includes('/') || pc.bits > 24) throw bad('The address pool must be a network such as 10.200.0.0/16 (a /24 or bigger)');
  o.pool = pool;
  o.subnetSize = Number(body.subnetSize || 24);
  if (!Number.isInteger(o.subnetSize) || o.subnetSize < pc.bits || o.subnetSize > 29) throw bad(`Each overlay network size must be between /${pc.bits} and /29`);
  o.dataPort = Number(body.dataPort || 4789);
  if (!Number.isInteger(o.dataPort) || o.dataPort < 1024 || o.dataPort > 49151) throw bad('The data port must be between 1024 and 49151');
  o.autolock = !!body.autolock;
  o.certDays = Number(body.certDays || 90);
  if (!Number.isInteger(o.certDays) || o.certDays < 1 || o.certDays > 3650) throw bad('Certificate lifetime must be 1–3650 days');
  o.taskHistory = Number(body.taskHistory ?? 5);
  if (!Number.isInteger(o.taskHistory) || o.taskHistory < 0 || o.taskHistory > 100) throw bad('Task history must be 0–100');
  return o;
}

/** Start "Create Swarm" on the server in use. Returns the job. */
/**
 * Start "Create Swarm" on the server in use. Returns the job. join (optional): async ({ job, log, step, client, nodeId })
 * that adds more servers in the same job; if it throws, the whole swarm is undone.
 */
async function startInit(body, { sourceIp, join } = {}) {
  const o = initOptions(body);
  if (currentJob && !currentJob.finishedAt) throw Object.assign(new Error('A Swarm job is already running'), { statusCode: 409 });
  const c = client();
  const job = newJob('init');
  currentJob = job;
  const log = logTo(job);
  const sid = job.serverId;
  (async () => {
    let inited = false;
    try {
      step(job, 'check', 'running', 'Check the server again');
      const ck = await checks({ pool: o.pool, multi: !!join });
      for (const x of ck.checks) log(`${{ ok: '✓', warn: '!', bad: '✗', info: '·' }[x.status]} ${x.label}: ${x.detail}`);
      if (!ck.ok) throw new Error('A check failed: ' + ck.checks.filter(x => x.status === 'bad').map(x => x.label).join(', '));
      step(job, 'check', 'done');

      step(job, 'init', 'running', 'docker swarm init');
      const spec = {
        Orchestration: { TaskHistoryRetentionLimit: o.taskHistory },
        CAConfig: { NodeCertExpiry: o.certDays * 24 * 3600 * 1e9 },
        EncryptionConfig: { AutoLockManagers: o.autolock },
      };
      // Listen on the chosen address when it is one of the server's own (a private address keeps 2377 off the
      // public interface); 0.0.0.0 otherwise (an address behind NAT).
      const own = o.advertiseAddr && (await addressCandidates().catch(() => [])).some(a => a.ip === o.advertiseAddr);
      const req = { ListenAddr: `${own ? o.advertiseAddr : '0.0.0.0'}:2377`, DataPathPort: o.dataPort, DefaultAddrPool: [o.pool], SubnetSize: o.subnetSize, Spec: spec };
      if (o.advertiseAddr) req.AdvertiseAddr = o.advertiseAddr;
      log(`$ docker swarm init${o.advertiseAddr ? ` --advertise-addr ${o.advertiseAddr}` : ''} --default-addr-pool ${o.pool} --default-addr-pool-mask-length ${o.subnetSize} --data-path-port ${o.dataPort} --cert-expiry ${o.certDays * 24}h --task-history-limit ${o.taskHistory}${o.autolock ? ' --autolock' : ''}`);
      let nodeId;
      try { nodeId = await c.swarmInit(req); }
      catch (e) {
        const msg = dockerMsg(e);
        // "could not choose an IP address to advertise since this system has multiple addresses on interface eth0 (10.0.0.2 and 1.2.3.4)"
        const ips = (msg.match(/\b\d+\.\d+\.\d+\.\d+\b/g) || []).filter(isIPv4);
        if (/could not choose an IP address/i.test(msg) && ips.length) {
          job.result = { needAddress: true, addresses: [...new Set(ips)].map(ip => ({ ip, private: isPrivate(ip) })) };
          throw new Error(`The server has several addresses (${[...new Set(ips)].join(', ')}). Choose the one Swarm should use and start again.`);
        }
        throw new Error(msg);
      }
      inited = true;
      nodeId = String(nodeId).replace(/"/g, '');
      log(`Swarm created. Node ID ${nodeId.slice(0, 12)}`);
      try { const ci = await c.swarmInspect(); require('./swarm-cluster').remember(ci.ID, nodeId, sid); } catch (e) { /* mapping is rebuilt later */ }
      step(job, 'init', 'done');

      step(job, 'verify', 'running', 'Check the node is Ready');
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) {
        const nodes = await c.listNodes().catch(() => []);
        const me = nodes.find(n => n.Status && n.Status.State === 'ready');
        if (me) { ready = true; log(`✓ ${me.Description.Hostname}: ${me.Spec.Role}, ${me.Status.State}, ${me.Spec.Availability} (${me.Status.Addr})`); }
        else await new Promise(r => setTimeout(r, 1000));
      }
      if (!ready) throw new Error('The node did not become Ready');
      step(job, 'verify', 'done');

      if (o.autolock) {
        step(job, 'key', 'running', 'Keep the unlock key');
        const k = await dial(c, '/swarm/unlockkey');
        const key = k && (k.UnlockKey || (typeof k === 'string' ? JSON.parse(k).UnlockKey : null));
        if (key) {
          stmts.setSetting.run(`swarm_unlock_key:${sid}`, encrypt(key));
          job.result = { ...(job.result || {}), unlockKey: key };
          log('The unlock key is stored in DockGate (encrypted). Keep a copy somewhere safe too — it is shown once at the end.');
        }
        step(job, 'key', 'done');
      }
      if (join) await join({ job, log, step, client: c, nodeId });
      job.status = 'done';
      log('✓ Swarm is on. Compose projects were not changed.');
      logAction({ sourceIp, server: sid, resourceType: 'swarm', resourceName: sid, action: 'swarm_init', details: { advertiseAddr: o.advertiseAddr, pool: o.pool, subnetSize: o.subnetSize, dataPort: o.dataPort, autolock: o.autolock, certDays: o.certDays } });
    } catch (e) {
      job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      job.status = 'error';
      job.error = e.message;
      log('✗ ' + e.message);
      if (inited) {
        step(job, 'undo', 'running', 'Undo: leave the swarm again');
        try { await c.swarmLeave({ force: true }); step(job, 'undo', 'done'); log('The server left the swarm again; nothing else was changed.'); }
        catch (u) { step(job, 'undo', 'failed'); log('✗ Leaving failed: ' + dockerMsg(u)); }
      }
      logAction({ sourceIp, server: sid, resourceType: 'swarm', resourceName: sid, action: 'swarm_init_failed', details: { error: e.message } });
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  // The unlock key is handed out while the job is fresh only.
  if (j.result && j.result.unlockKey && j.finishedAt && Date.now() - j.finishedAt > 10 * 60000) { j.result = { ...j.result, unlockKey: undefined }; }
  return j;
}
function runningJob() { return currentJob && !currentJob.finishedAt && currentJob.serverId === serverId() ? currentJob : null; }

// ---- overview ----

/** Swarm events of the last day (newest first, at most `limit`). */
async function recentEvents(c, limit = 20) {
  const now = Math.floor(Date.now() / 1000);
  const stream = await c.getEvents({ since: now - 86400, until: now, filters: JSON.stringify({ type: ['service', 'node', 'secret', 'config'] }) });
  return new Promise((resolve) => {
    let buf = '';
    const out = [];
    const t = setTimeout(() => { try { stream.destroy(); } catch (e) {} resolve(out.slice(-limit).reverse()); }, 4000);
    stream.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const e = JSON.parse(line);
          const a = e.Actor && e.Actor.Attributes || {};
          out.push({ time: e.time, type: e.Type, action: e.Action, id: e.Actor && e.Actor.ID, name: a.name || '', detail: Object.entries(a).filter(([k]) => /^updatestate\.|^state\.|^availability\.|^role\./.test(k)).map(([k, v]) => `${k}=${v}`).join(' ') });
        } catch (err) { /* partial */ }
      }
    });
    stream.on('end', () => { clearTimeout(t); resolve(out.slice(-limit).reverse()); });
    stream.on('error', () => { clearTimeout(t); resolve(out.slice(-limit).reverse()); });
  });
}

/** Everything the Overview shows. Only for a manager (workers can not read the cluster). */
async function overview() {
  const c = client();
  const st = await status();
  if (st.state !== 'active' || !st.manager) return { status: st };
  let nodes, services, tasks, events;
  try { [nodes, services, tasks, events] = await Promise.all([c.listNodes(), c.listServices({ status: true }), c.listTasks(), recentEvents(c).catch(() => [])]); }
  catch (e) {
    const msg = dockerMsg(e) || e.message;
    // Most managers gone: the cluster can not be read or changed (services keep running).
    if (/leader|quorum|deadline exceeded/i.test(msg)) return { status: st, quorumLost: true, error: msg };
    throw e;
  }
  const svcName = new Map(services.map(s => [s.ID, s.Spec.Name]));
  // A slot with no live task shows its newest failed task (red), so a crashing service is visible on its node.
  const live = (t) => t.DesiredState !== 'shutdown' && !['shutdown', 'complete', 'failed', 'rejected', 'orphaned'].includes(t.Status.State);
  const slotKey = (t) => `${t.ServiceID}:${t.Slot || t.NodeID}`;
  const liveSlots = new Set(tasks.filter(live).map(slotKey));
  const lastFailed = new Map();
  for (const t of tasks) {
    if (live(t) || !['failed', 'rejected'].includes(t.Status.State) || liveSlots.has(slotKey(t))) continue;
    const prev = lastFailed.get(slotKey(t));
    if (!prev || new Date(t.Status.Timestamp) > new Date(prev.Status.Timestamp)) lastFailed.set(slotKey(t), t);
  }
  const shown = [...tasks.filter(live), ...lastFailed.values()];
  const nodeList = nodes.map(n => ({
    id: n.ID,
    hostname: n.Description.Hostname,
    role: n.Spec.Role,
    availability: n.Spec.Availability,
    state: n.Status.State,
    addr: n.ManagerStatus && n.ManagerStatus.Addr ? String(n.ManagerStatus.Addr).replace(/:\d+$/, '') : n.Status.Addr,
    arch: n.Description.Platform && n.Description.Platform.Architecture,
    os: n.Description.Platform && n.Description.Platform.OS,
    engine: n.Description.Engine && n.Description.Engine.EngineVersion,
    leader: !!(n.ManagerStatus && n.ManagerStatus.Leader),
    reachability: n.ManagerStatus && n.ManagerStatus.Reachability || null,
    self: n.ID === st.nodeId,
    labels: n.Spec.Labels || {},
    tasks: shown.filter(t => t.NodeID === n.ID)
      .map(t => ({ id: t.ID, service: svcName.get(t.ServiceID) || t.ServiceID.slice(0, 12), slot: t.Slot || null, state: t.Status.State, desired: t.DesiredState, error: t.Status.Err || null, image: String((t.Spec.ContainerSpec || {}).Image || '').split('@')[0] })),
  }));
  let desired = 0, running = 0;
  for (const s of services) {
    if (s.ServiceStatus) { desired += s.ServiceStatus.DesiredTasks || 0; running += s.ServiceStatus.RunningTasks || 0; }
  }
  const ready = nodeList.filter(n => n.state === 'ready').length;
  const managers = nodeList.filter(n => n.role === 'manager');
  const reachable = managers.filter(m => m.reachability === 'reachable').length;
  const tolerates = Math.floor((managers.length - 1) / 2);
  const warnings = [];
  if (st.error) warnings.push({ level: 'bad', text: `Swarm reports an error: ${st.error}` });
  if (managers.length && reachable <= managers.length / 2) warnings.push({ level: 'bad', text: 'Most managers can not be reached: the cluster can not be changed until they are back.' });
  if (nodeList.length > 1 && managers.length === 1) warnings.push({ level: 'warn', text: 'One manager for several servers: if it is lost, the cluster can not be changed.' });
  if (managers.length === 2) warnings.push({ level: 'warn', text: 'Two managers tolerate no loss — use 1 or 3.' });
  if (running < desired) warnings.push({ level: 'warn', text: `${desired - running} task${desired - running > 1 ? 's are' : ' is'} not running.` });
  try {
    const projects = (await dockerService.listComposeProjects()).filter(p => p.total > 0);
    if (projects.length) warnings.push({ level: 'info', text: `${projects.length} compose project${projects.length > 1 ? 's run' : ' runs'} outside Swarm (${projects.slice(0, 4).map(p => p.name).join(', ')}${projects.length > 4 ? ', …' : ''}). They keep running as they are; Swarm → Migrate moves them when you choose.`, action: 'migrate' });
  } catch (e) { /* ignore */ }
  return {
    status: st,
    nodes: nodeList,
    counts: { nodes: nodeList.length, ready, managers: managers.length, tolerates, services: services.length, desired, running },
    warnings,
    events,
  };
}

// ---- settings, unlock, leave ----

async function settings() {
  const c = client();
  const st = await status();
  if (st.state !== 'active' || !st.manager) return { status: st };
  const sw = await c.swarmInspect();
  const spec = sw.Spec || {};
  return {
    status: st,
    cluster: {
      id: sw.ID,
      createdAt: sw.CreatedAt,
      updatedAt: sw.UpdatedAt,
      defaultAddrPool: sw.DefaultAddrPool || [],
      subnetSize: sw.SubnetSize || null,
      dataPort: sw.DataPathPort || 4789,
      certExpiryDays: spec.CAConfig && spec.CAConfig.NodeCertExpiry ? Math.round(spec.CAConfig.NodeCertExpiry / 1e9 / 86400) : null,
      taskHistory: spec.Orchestration ? spec.Orchestration.TaskHistoryRetentionLimit : null,
      autolock: !!(spec.EncryptionConfig && spec.EncryptionConfig.AutoLockManagers),
      rootRotation: !!sw.RootRotationInProgress,
    },
  };
}

/**
 * Change cluster settings after the swarm was created: { autolock, certDays, taskHistory }.
 * Turning autolock on stores the new unlock key (encrypted) and returns it once.
 */
async function updateSettings(body = {}) {
  const c = client();
  const st = await status();
  if (st.state !== 'active' || !st.manager) throw Object.assign(new Error('Swarm must be active and this server a manager'), { statusCode: 409 });
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  const sw = await c.swarmInspect();
  const spec = JSON.parse(JSON.stringify(sw.Spec || {}));
  const before = { autolock: !!(spec.EncryptionConfig && spec.EncryptionConfig.AutoLockManagers), certDays: spec.CAConfig && spec.CAConfig.NodeCertExpiry ? Math.round(spec.CAConfig.NodeCertExpiry / 1e9 / 86400) : null, taskHistory: spec.Orchestration ? spec.Orchestration.TaskHistoryRetentionLimit : null };
  if (body.certDays !== undefined) {
    const d = Number(body.certDays);
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw bad('Certificate lifetime must be 1–3650 days');
    spec.CAConfig = { ...(spec.CAConfig || {}), NodeCertExpiry: d * 86400 * 1e9 };
  }
  if (body.taskHistory !== undefined) {
    const n = Number(body.taskHistory);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw bad('Task history must be 0–100');
    spec.Orchestration = { ...(spec.Orchestration || {}), TaskHistoryRetentionLimit: n };
  }
  if (body.autolock !== undefined) spec.EncryptionConfig = { ...(spec.EncryptionConfig || {}), AutoLockManagers: !!body.autolock };
  try { await dial(c, '/swarm/update?', 'POST', { _query: { version: sw.Version.Index }, _body: spec }); }
  catch (e) { throw bad(dockerMsg(e) || 'Swarm update failed'); }
  const out = { before, after: { autolock: !!(spec.EncryptionConfig && spec.EncryptionConfig.AutoLockManagers), certDays: spec.CAConfig && spec.CAConfig.NodeCertExpiry ? Math.round(spec.CAConfig.NodeCertExpiry / 1e9 / 86400) : null, taskHistory: spec.Orchestration ? spec.Orchestration.TaskHistoryRetentionLimit : null } };
  if (out.after.autolock && !before.autolock) {
    const k = await dial(c, '/swarm/unlockkey').catch(() => null);
    const key = k && (k.UnlockKey || (typeof k === 'string' ? JSON.parse(k).UnlockKey : null));
    if (key) { stmts.setSetting.run(`swarm_unlock_key:${serverId()}`, encrypt(key)); out.unlockKey = key; }
  }
  if (!out.after.autolock && before.autolock) stmts.setSetting.run(`swarm_unlock_key:${serverId()}`, '');
  return out;
}

/** Join tokens and the manager address, for adding a server by hand (`docker swarm join`). */
async function joinTokens() {
  const c = client();
  const st = await status();
  if (st.state !== 'active' || !st.manager) throw Object.assign(new Error('Swarm must be active and this server a manager'), { statusCode: 409 });
  const sw = await c.swarmInspect();
  const info = await c.info();
  const addr = ((info.Swarm || {}).RemoteManagers || []).find(m => m.NodeID === (info.Swarm || {}).NodeID) || ((info.Swarm || {}).RemoteManagers || [])[0] || {};
  const manager = addr.Addr || `${(info.Swarm || {}).NodeAddr}:2377`;
  return { worker: sw.JoinTokens.Worker, manager: sw.JoinTokens.Manager, addr: manager };
}

/** Make a new join token for workers or managers; the old one stops working (servers already in stay). */
async function rotateToken(role) {
  if (!['worker', 'manager'].includes(role)) throw Object.assign(new Error('role must be worker or manager'), { statusCode: 400 });
  const c = client();
  const sw = await c.swarmInspect();
  const q = { version: sw.Version.Index, [role === 'worker' ? 'rotateWorkerToken' : 'rotateManagerToken']: true };
  try { await dial(c, '/swarm/update?', 'POST', { _query: q, _body: sw.Spec }); }
  catch (e) { throw Object.assign(new Error(dockerMsg(e) || 'Rotate failed'), { statusCode: 400 }); }
  return joinTokens();
}

/** The stored unlock key (for "Show unlock key"); null if none. */
function storedUnlockKey() {
  const row = stmts.getSetting.get(`swarm_unlock_key:${serverId()}`);
  return row && row.value ? decrypt(row.value) : null;
}

/** Unlock a locked swarm with the given key, or the stored one. */
async function unlock(key) {
  const k = String(key || '').trim() || storedUnlockKey();
  if (!k) throw Object.assign(new Error('No unlock key stored — enter it'), { statusCode: 400 });
  try { await dial(client(), '/swarm/unlock', 'POST', { UnlockKey: k }); }
  catch (e) { throw Object.assign(new Error(dockerMsg(e) || 'Unlock failed'), { statusCode: 400 }); }
  if (key) stmts.setSetting.run(`swarm_unlock_key:${serverId()}`, encrypt(k)); // a key typed in works: keep it
  return true;
}

/** Leave the swarm (one server: this removes the swarm with its services). */
async function leave() {
  const c = client();
  const st = await status();
  if (st.state === 'inactive') return { left: false };
  let services = 0;
  try { services = (await c.listServices()).length; } catch (e) { /* worker */ }
  if (st.manager) {
    const nodes = await c.listNodes().catch(() => []);
    if (nodes.length > 1) throw Object.assign(new Error(`The swarm has ${nodes.length} servers — remove the others first (Swarm → Nodes → Remove), then turn Swarm off here`), { statusCode: 400 });
  }
  // Projects moved to Swarm are down in Compose: removing the swarm would leave them stopped everywhere.
  const { db } = require('./db');
  const moved = db.prepare('SELECT name FROM swarm_stacks WHERE server_id = ?').all(serverId()).map(r => r.name);
  if (moved.length) throw Object.assign(new Error(`${moved.join(', ')} run${moved.length === 1 ? 's' : ''} on Swarm — move ${moved.length === 1 ? 'it' : 'them'} back to Compose first (Swarm → Stacks), or remove ${moved.length === 1 ? 'it' : 'them'} there`), { statusCode: 409 });
  await c.swarmLeave({ force: true });
  stmts.setSetting.run(`swarm_unlock_key:${serverId()}`, '');
  if (st.clusterId) db.prepare('DELETE FROM swarm_node_servers WHERE cluster_id = ?').run(st.clusterId);
  return { left: true, services };
}

// Shared with server/swarm-cluster.js (one Swarm job at a time per DockGate).
const _jobs = { newJob, logTo, step, setCurrent: (j) => { currentJob = j; }, busy: () => !!(currentJob && !currentJob.finishedAt) };

module.exports = { _jobs, addressCandidates, isIPv4, isPrivate, dial, status, checks, startInit, getJob, runningJob, overview, settings, updateSettings, joinTokens, rotateToken, storedUnlockKey, unlock, leave, initOptions, _overlaps: overlaps, _parseCidr: parseCidr, _isPrivate: isPrivate, dockerMsg };
