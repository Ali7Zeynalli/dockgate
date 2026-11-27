// Resources > Networks > a network > Change settings. Docker can not change a network in place (subnet, internal,
// options), so DockGate makes it again under the same name and puts every container back:
//   1. read the network and every container on it (aliases, fixed addresses), running or stopped
//   2. disconnect them all, 3. remove the network, 4. create it with the new settings
//   5. connect every container again with its aliases (a fixed address only when it fits the new subnet)
//   6. check every container is back
// When a step after the removal fails, the old network is made again with its old settings and the containers go
// back to it. Networks a compose project made are not changed here (the next compose up would undo it): the page
// sends you to the compose file instead. Docker's own networks and Swarm networks are refused.
const crypto = require('crypto');
const net = require('net');

const COMPOSE = 'com.docker.compose.project';
const jobs = new Map(); // id -> { id, network, status, steps, log, error, startedAt, finishedAt }

/** The create body for the network with `changes` applied. Name, driver and scope stay. */
function buildCreate(old, changes = {}) {
  const c = changes;
  const opts = { ...(old.Options || {}) };
  const setOpt = (k, v) => { if (v === undefined) return; if (v === '' || v === null) delete opts[k]; else opts[k] = String(v); };
  setOpt('com.docker.network.driver.mtu', c.mtu);
  if (old.Driver === 'bridge') {
    if (c.icc !== undefined) setOpt('com.docker.network.bridge.enable_icc', c.icc ? '' : 'false');
    if (c.masquerade !== undefined) setOpt('com.docker.network.bridge.enable_ip_masquerade', c.masquerade ? '' : 'false');
  }
  const oldCfg = (old.IPAM && old.IPAM.Config) || [];
  const old4 = oldCfg.find(x => x.Subnet && !x.Subnet.includes(':')) || {};
  const old6 = oldCfg.find(x => x.Subnet && x.Subnet.includes(':')) || {};
  const ipv6 = c.ipv6 !== undefined ? !!c.ipv6 : !!old.EnableIPv6;
  const cfg = [];
  const sub4 = c.subnet !== undefined ? c.subnet : old4.Subnet;
  if (sub4) {
    const same = sub4 === old4.Subnet;
    const x = { Subnet: sub4 };
    const gw = c.gateway !== undefined ? c.gateway : (same ? old4.Gateway : '');
    const rg = c.ipRange !== undefined ? c.ipRange : (same ? old4.IPRange : '');
    if (gw) x.Gateway = gw; if (rg) x.IPRange = rg;
    cfg.push(x);
  }
  const sub6 = ipv6 ? (c.subnet6 !== undefined ? c.subnet6 : old6.Subnet) : '';
  if (sub6) { const x = { Subnet: sub6 }; const g6 = c.gateway6 !== undefined ? c.gateway6 : (sub6 === old6.Subnet ? old6.Gateway : ''); if (g6) x.Gateway = g6; cfg.push(x); }
  const body = {
    Name: old.Name, Driver: old.Driver, CheckDuplicate: true,
    Internal: c.internal !== undefined ? !!c.internal : !!old.Internal,
    Attachable: c.attachable !== undefined ? !!c.attachable : !!old.Attachable,
    EnableIPv6: ipv6, Options: opts, Labels: c.labels !== undefined ? c.labels : (old.Labels || {}),
  };
  if (cfg.length) body.IPAM = { Driver: (old.IPAM && old.IPAM.Driver) || 'default', Config: cfg, Options: (old.IPAM && old.IPAM.Options) || {} };
  return body;
}

const inSubnet = (ip, cidr) => {
  if (!ip || !cidr) return false;
  const [b, l] = cidr.split('/'); const v = net.isIP(b);
  if (!v || v !== net.isIP(ip)) return false;
  try { const bl = new net.BlockList(); bl.addSubnet(b, Number(l), v === 6 ? 'ipv6' : 'ipv4'); return bl.check(ip, v === 6 ? 'ipv6' : 'ipv4'); } catch (e) { return false; }
};

/** How a container goes back: its aliases, and its fixed addresses when they fit the new subnets. */
function endpointFor(member, body) {
  const subs = ((body.IPAM && body.IPAM.Config) || []).map(x => x.Subnet);
  const cfg = {};
  const notes = [];
  if (member.fixed4) { if (subs.some(s => inSubnet(member.fixed4, s))) cfg.IPv4Address = member.fixed4; else notes.push(`${member.fixed4} is outside the new subnet: it gets a new address`); }
  if (member.fixed6) { if (subs.some(s => inSubnet(member.fixed6, s))) cfg.IPv6Address = member.fixed6; else notes.push(`${member.fixed6} is outside the new subnet: it gets a new address`); }
  const ep = { Aliases: member.aliases };
  if (Object.keys(cfg).length) ep.IPAMConfig = cfg;
  return { endpoint: ep, notes };
}

/** Why this network can not be changed here, or null. */
function refusal(old, services) {
  if (['bridge', 'host', 'none'].includes(old.Name) || old.Ingress || old.Name === 'docker_gwbridge') return 'Docker\'s own networks can not be made again.';
  if (old.Scope === 'swarm' || services > 0) return 'This network belongs to Swarm (it has services or spans servers). Change it in Swarm > Networks.';
  if (old.Labels && old.Labels[COMPOSE]) return `The compose project ${old.Labels[COMPOSE]} made this network. Change it in that project's compose file, then compose down and up: a change made here would be undone by its next compose up.`;
  return null;
}

/** The members with what is needed to put them back. `ctrs`: container inspect results. */
function membersOf(old, ctrs) {
  const out = [];
  for (const c of ctrs) {
    const nets = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
    const key = Object.keys(nets).find(k => k === old.Name || (nets[k] && nets[k].NetworkID === old.Id));
    if (!key) continue;
    const e = nets[key] || {};
    const name = String(c.Name || '').replace(/^\//, '');
    const ipam = e.IPAMConfig || {};
    out.push({ id: c.Id, name, running: !!(c.State && c.State.Running), aliases: (e.Aliases || []).filter(a => a && a !== name && !String(c.Id).startsWith(a)), fixed4: ipam.IPv4Address || '', fixed6: ipam.IPv6Address || '' });
  }
  return out;
}

function getJob(id) { return jobs.get(id) || null; }

/**
 * Starts the change as a job. docker: the dockerode client of the active server. Returns the job id.
 */
function start(docker, netId, changes, { onDone } = {}) {
  const job = { id: crypto.randomBytes(8).toString('hex'), network: netId, status: 'running', steps: [], log: '', error: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > 3600000) jobs.delete(k);
  const log = (l) => { job.log += l + '\n'; };
  const step = (label) => { const s = { label, status: 'running' }; job.steps.push(s); log(`> ${label}`); return s; };
  (async () => {
    let old, members = [], removed = false, created = false;
    const connectAll = async (netName, body, list) => {
      const failed = [];
      for (const m of list) {
        const { endpoint, notes } = endpointFor(m, body);
        notes.forEach(n => log(`  ${m.name}: ${n}`));
        try { await docker.getNetwork(netName).connect({ Container: m.id, EndpointConfig: endpoint }); log(`  ${m.name} connected${m.aliases.length ? ` (aliases ${m.aliases.join(', ')})` : ''}`); }
        catch (e) { failed.push(m.name); log(`  ${m.name}: ${e.message}`); }
      }
      return failed;
    };
    try {
      let s = step('Read the network and its containers');
      old = await docker.getNetwork(netId).inspect();
      const services = await docker.listServices().then(l => l.filter(sv => [...((sv.Spec.TaskTemplate || {}).Networks || []), ...(sv.Spec.Networks || [])].some(n => n.Target === old.Id || n.Target === old.Name)).length).catch(() => 0);
      const why = refusal(old, services);
      if (why) throw Object.assign(new Error(why), { refused: true });
      const list = await docker.listContainers({ all: true });
      const mine = list.filter(c => Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).some(([k, n]) => k === old.Name || (n && n.NetworkID === old.Id)));
      const ins = [];
      for (const c of mine) ins.push(await docker.getContainer(c.Id).inspect());
      members = membersOf(old, ins);
      const body = buildCreate(old, changes);
      // a subnet Docker would refuse is caught before anything is disconnected
      const others = (await docker.listNetworks()).filter(n => n.Id !== old.Id).map(n => ({ name: n.Name, subnets: ((n.IPAM && n.IPAM.Config) || []).map(x => x.Subnet).filter(Boolean) }));
      const clash = ((body.IPAM && body.IPAM.Config) || []).flatMap(x => require('./network-map').subnetConflicts(x.Subnet, null, others)).filter(c => c.kind === 'docker' || c.kind === 'invalid');
      if (clash.length) throw Object.assign(new Error(clash.map(c => c.text).join(' ')), { refused: true });
      log(`  ${members.length} container${members.length === 1 ? '' : 's'}: ${members.map(m => m.name).join(', ') || 'none'}`);
      log(`  new settings: ${JSON.stringify({ Internal: body.Internal, EnableIPv6: body.EnableIPv6, IPAM: (body.IPAM || {}).Config, Options: body.Options })}`);
      s.status = 'done';

      s = step('Disconnect the containers');
      for (const m of members) { await docker.getNetwork(old.Id).disconnect({ Container: m.id, Force: true }); log(`  ${m.name} disconnected`); }
      s.status = 'done';

      s = step('Remove the network');
      await docker.getNetwork(old.Id).remove(); removed = true;
      s.status = 'done';

      s = step('Create it with the new settings');
      await docker.createNetwork(body); created = true;
      s.status = 'done';

      s = step('Connect the containers again');
      const failed = await connectAll(old.Name, body, members);
      if (failed.length) throw new Error(`${failed.join(', ')} could not be connected again`);
      s.status = 'done';

      s = step('Check every container is back');
      const now = await docker.getNetwork(old.Name).inspect();
      const list2 = await docker.listContainers({ all: true });
      const back = list2.filter(c => Object.values((c.NetworkSettings && c.NetworkSettings.Networks) || {}).some(n => n && n.NetworkID === now.Id)).length;
      if (back < members.length) throw new Error(`${back} of ${members.length} containers are on the new network`);
      log(`  ${back} of ${members.length} back`);
      s.status = 'done';
      job.status = 'done';
      if (onDone) try { onDone({ old: old.Name, members: members.length }); } catch (e) { /* audit only */ }
    } catch (e) {
      const cur = job.steps[job.steps.length - 1]; if (cur && cur.status === 'running') cur.status = 'failed';
      job.error = e.message; log(`Failed: ${e.message}`);
      if (removed && old) {
        const r = step('Put the old network back');
        try {
          if (created) { try { const n = await docker.getNetwork(old.Name).inspect(); for (const id of Object.keys(n.Containers || {})) await docker.getNetwork(n.Id).disconnect({ Container: id, Force: true }).catch(() => {}); await docker.getNetwork(n.Id).remove(); } catch (x) { /* not there */ } }
          const back = buildCreate(old, {});
          await docker.createNetwork(back);
          const failed = await connectAll(old.Name, back, members);
          r.status = failed.length ? 'failed' : 'done';
          log(failed.length ? `  not back: ${failed.join(', ')}. Connect them on the network's page.` : '  the old network and its containers are back');
        } catch (x) { r.status = 'failed'; log(`  ${x.message}. Create the network again by hand and connect: ${members.map(m => m.name).join(', ')}`); }
      } else if (members.length && old && job.steps.some(st => st.label === 'Disconnect the containers')) {
        // failed while disconnecting: connect back the ones already off
        const n = await docker.getNetwork(old.Id).inspect().catch(() => null);
        if (n) { const on = new Set(Object.keys(n.Containers || {})); await connectAll(old.Id, buildCreate(old, {}), members.filter(m => !on.has(m.id))); }
      }
      job.status = 'failed';
    }
    job.finishedAt = Date.now();
  })();
  return job.id;
}

module.exports = { buildCreate, endpointFor, refusal, membersOf, start, getJob, inSubnet };
