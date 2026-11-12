// Swarm secrets, configs and networks — phase 5.
//
// Swarm can not change a secret or config. Rotate (Edit for configs) does it the safe way, as a job: a new
// version <name>_v2 is created → every service that uses it moves to the new one with a rolling update,
// keeping the same file path in the container → when every update finished, the old version is removed.
// If an update fails or rolls back, the job stops and the old version stays, so nothing is left without it.
// Secret values never go into DockGate's database or log; they are sent to Swarm and that is it.
const dockerService = require('./docker');
const swarm = require('./swarm');
const { logAction } = require('./audit');

const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mgr() {
  const st = await swarm.status();
  if (st.state !== 'active') throw bad(409, 'Swarm is not active on the server in use');
  if (!st.manager) throw bad(409, 'The server in use is a worker — switch to a manager at the top');
  return { c: dockerService.docker, st };
}
const stackOf = (labels) => (labels || {})['com.docker.stack.namespace'] || null;
/** "db_password_v3" → { base: "db_password", n: 3 }; "db_password" → { base, n: 1 }. */
function versionOf(name) { const m = /^(.*)_v(\d+)$/.exec(name); return m ? { base: m[1], n: Number(m[2]) } : { base: name, n: 1 }; }

// ---- secrets and configs ----

/** Which services use which secret / config (by ID), with the path in the container. */
async function usage(c) {
  const services = await c.listServices();
  const secrets = new Map(), configs = new Map();
  for (const s of services) {
    const cs = s.Spec.TaskTemplate.ContainerSpec || {};
    for (const x of cs.Secrets || []) (secrets.get(x.SecretID) || secrets.set(x.SecretID, []).get(x.SecretID)).push({ id: s.ID, name: s.Spec.Name, target: x.File ? x.File.Name : '' });
    for (const x of cs.Configs || []) (configs.get(x.ConfigID) || configs.set(x.ConfigID, []).get(x.ConfigID)).push({ id: s.ID, name: s.Spec.Name, target: x.File ? x.File.Name : '' });
  }
  return { secrets, configs };
}

async function list() {
  const { c } = await mgr();
  const [secrets, configs, use] = await Promise.all([c.listSecrets(), c.listConfigs(), usage(c)]);
  const row = (x, kind) => ({ id: x.ID, kind, name: x.Spec.Name, createdAt: x.CreatedAt, updatedAt: x.UpdatedAt, labels: x.Spec.Labels || {}, stack: stackOf(x.Spec.Labels), driver: x.Spec.Driver ? x.Spec.Driver.Name : null,
    usedBy: (kind === 'secret' ? use.secrets : use.configs).get(x.ID) || [], size: kind === 'config' && x.Spec.Data ? Buffer.from(x.Spec.Data, 'base64').length : null });
  return { secrets: secrets.map(x => row(x, 'secret')).sort((a, b) => a.name.localeCompare(b.name)), configs: configs.map(x => row(x, 'config')).sort((a, b) => a.name.localeCompare(b.name)) };
}

function checkValue(kind, value) {
  if (typeof value !== 'string' || !value.length) throw bad(400, `Enter the ${kind === 'secret' ? 'secret value' : 'file content'}`);
  if (Buffer.byteLength(value) > 500 * 1024) throw bad(400, 'At most 500 KB (a Swarm limit)');
}
async function create(kind, { name, value, labels = {} }, { sourceIp } = {}) {
  const { c, st } = await mgr();
  if (!['secret', 'config'].includes(kind)) throw bad(400, 'kind must be secret or config');
  if (!NAME.test(String(name || ''))) throw bad(400, 'Name: letters, digits, dot, dash or underscore (up to 63)');
  checkValue(kind, value);
  const spec = { Name: name, Data: Buffer.from(value).toString('base64'), Labels: { ...labels, 'dockgate.created': 'true' } };
  let r;
  try { r = kind === 'secret' ? await c.createSecret(spec) : await c.createConfig(spec); }
  catch (e) { throw bad(e.statusCode === 409 ? 409 : 400, e.statusCode === 409 ? `A ${kind} named ${name} already exists` : swarm.dockerMsg(e)); }
  logAction({ sourceIp, server: st.serverId, resourceType: `swarm-${kind}`, resourceName: name, action: `swarm_${kind}_create`, details: { bytes: Buffer.byteLength(value) } }); // never the value
  return { id: r.id || r.ID };
}

/** A config's content (configs are not secret; Swarm returns them). */
async function configContent(id) {
  const { c } = await mgr();
  const x = await c.getConfig(id).inspect();
  return { name: x.Spec.Name, content: Buffer.from(x.Spec.Data || '', 'base64').toString('utf8') };
}

async function remove(kind, id, { sourceIp } = {}) {
  const { c, st } = await mgr();
  const use = await usage(c);
  const users = (kind === 'secret' ? use.secrets : use.configs).get(id) || [];
  if (users.length) throw bad(409, `Still used by ${users.map(u => u.name).join(', ')} — rotate those services to another ${kind}, or remove them first`);
  const obj = kind === 'secret' ? c.getSecret(id) : c.getConfig(id);
  const x = await obj.inspect();
  await obj.remove();
  logAction({ sourceIp, server: st.serverId, resourceType: `swarm-${kind}`, resourceName: x.Spec.Name, action: `swarm_${kind}_remove` });
  return { ok: true };
}

/** Wait until a service's update finishes. Returns the final state (completed, paused, rollback_completed, …). */
async function waitUpdate(c, id, log, name) {
  const t0 = Date.now();
  await sleep(1500);
  for (;;) {
    const s = await c.getService(id).inspect();
    const us = s.UpdateStatus;
    if (!us || us.State === 'completed') return 'completed';
    if (['paused', 'rollback_completed', 'rollback_paused'].includes(us.State)) { log(`  ${name}: ${us.State}${us.Message ? ` — ${us.Message}` : ''}`); return us.State; }
    if (Date.now() - t0 > 600000) return 'timeout';
    await sleep(2000);
  }
}

/**
 * Rotate a secret or edit a config: new version → services move to it one by one → old one removed.
 * Runs as a Swarm job.
 */
async function startRotate(kind, id, value, { sourceIp } = {}) {
  const { c, st } = await mgr();
  checkValue(kind, value);
  const obj = kind === 'secret' ? c.getSecret(id) : c.getConfig(id);
  const old = await obj.inspect();
  const all = kind === 'secret' ? await c.listSecrets() : await c.listConfigs();
  const v = versionOf(old.Spec.Name);
  let n = v.n + 1;
  while (all.some(x => x.Spec.Name === `${v.base}_v${n}`)) n++;
  const newName = `${v.base}_v${n}`;
  const users = ((await usage(c))[kind === 'secret' ? 'secrets' : 'configs'].get(id)) || [];
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const job = swarm._jobs.newJob('rotate', v.base); swarm._jobs.setCurrent(job);
  const log = swarm._jobs.logTo(job), step = swarm._jobs.step;
  const K = kind === 'secret' ? 'Secret' : 'Config';
  (async () => {
    try {
      step(job, 'create', 'running', `Create ${newName}`);
      const spec = { Name: newName, Data: Buffer.from(value).toString('base64'), Labels: { ...(old.Spec.Labels || {}), 'dockgate.rotated-from': old.Spec.Name } };
      const created = kind === 'secret' ? await c.createSecret(spec) : await c.createConfig(spec);
      const newId = created.id || created.ID;
      log(`Created ${kind} ${newName}${kind === 'secret' ? ' (the value is not logged)' : ` (${Buffer.byteLength(value)} bytes)`}`);
      step(job, 'create', 'done');
      if (!users.length) log(`No service uses ${old.Spec.Name}.`);
      for (const u of users) {
        step(job, `svc-${u.id}`, 'running', `${u.name}: move to ${newName} (rolling update)`);
        const s = await c.getService(u.id).inspect();
        const spec2 = JSON.parse(JSON.stringify(s.Spec));
        const cs = spec2.TaskTemplate.ContainerSpec;
        cs[`${K}s`] = (cs[`${K}s`] || []).map(x => (x[`${K}ID`] === id ? { ...x, [`${K}ID`]: newId, [`${K}Name`]: newName, File: x.File || { Name: old.Spec.Name, UID: '0', GID: '0', Mode: 0o444 } } : x));
        await require('./swarm-services').writeSpec(c, u.id, s.Version.Index, spec2); // registry login sent: tasks may start on other servers
        log(`  ${u.name}: updating — the file stays at ${kind === 'secret' ? '/run/secrets/' : ''}${u.target || old.Spec.Name}`);
        const r = await waitUpdate(c, u.id, log, u.name);
        if (r !== 'completed') throw new Error(`${u.name} did not finish its update (${r}) — ${old.Spec.Name} is kept; fix the service, then rotate again`);
        step(job, `svc-${u.id}`, 'done');
      }
      step(job, 'remove', 'running', `Remove ${old.Spec.Name}`);
      await obj.remove().catch(e => log(`  could not remove ${old.Spec.Name}: ${swarm.dockerMsg(e)}`));
      step(job, 'remove', 'done');
      job.status = 'done'; job.result = { newName, services: users.map(u => u.name) };
      log(`✓ ${users.length} service${users.length === 1 ? '' : 's'} use ${newName}; ${old.Spec.Name} is removed.${stackOf(old.Spec.Labels) ? ` Note: it belongs to stack ${stackOf(old.Spec.Labels)} — update the compose file too, or the next stack deploy uses its own value again.` : ''}`);
      logAction({ sourceIp, server: st.serverId, resourceType: `swarm-${kind}`, resourceName: old.Spec.Name, action: `swarm_${kind}_rotate`, details: { to: newName, services: users.map(u => u.name) } });
    } catch (e) {
      job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      job.status = 'error'; job.error = swarm.dockerMsg(e) || e.message; log('✗ ' + job.error);
    } finally { job.finishedAt = Date.now(); }
  })();
  return job;
}

// ---- networks ----

async function networks() {
  const { c } = await mgr();
  const [nets, services] = await Promise.all([c.listNetworks({ filters: JSON.stringify({ scope: ['swarm'] }) }), c.listServices()]);
  const use = new Map();
  for (const s of services) for (const n of (s.Spec.TaskTemplate.Networks || s.Spec.Networks || [])) (use.get(n.Target) || use.set(n.Target, []).get(n.Target)).push(s.Spec.Name);
  const ingressPorts = services.filter(s => ((s.Endpoint && s.Endpoint.Ports) || []).some(p => p.PublishMode === 'ingress')).map(s => s.Spec.Name);
  return nets.map(n => ({
    id: n.Id, name: n.Name, driver: n.Driver, ingress: !!n.Ingress, internal: !!n.Internal, attachable: !!n.Attachable,
    encrypted: !!(n.Options && Object.prototype.hasOwnProperty.call(n.Options, 'encrypted')),
    subnets: ((n.IPAM && n.IPAM.Config) || []).map(x => x.Subnet).filter(Boolean),
    gateways: ((n.IPAM && n.IPAM.Config) || []).map(x => x.Gateway).filter(Boolean),
    usedBy: n.Ingress ? ingressPorts : (use.get(n.Id) || use.get(n.Name) || []), stack: stackOf(n.Labels), createdAt: n.Created,
  })).sort((a, b) => (b.ingress - a.ingress) || a.name.localeCompare(b.name));
}

async function createNetwork({ name, encrypted = false, attachable = true, internal = false, subnet = '' }, { sourceIp } = {}) {
  const { c, st } = await mgr();
  if (!NAME.test(String(name || ''))) throw bad(400, 'Name: letters, digits, dot, dash or underscore');
  const opts = { Name: name, Driver: 'overlay', Attachable: !!attachable, Internal: !!internal, CheckDuplicate: true, Labels: { 'dockgate.created': 'true' }, Options: encrypted ? { encrypted: '' } : {} };
  if (String(subnet || '').trim()) {
    const sn = String(subnet).trim();
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(sn)) throw bad(400, 'Subnet: write it like 10.210.0.0/24');
    opts.IPAM = { Driver: 'default', Config: [{ Subnet: sn }] };
  }
  let r;
  try { r = await c.createNetwork(opts); } catch (e) { throw bad(400, swarm.dockerMsg(e)); }
  let firewall = null;
  if (encrypted) { try { firewall = await require('./swarm-cluster').ensureEsp(); } catch (e) { firewall = { error: e.message }; } }
  logAction({ sourceIp, server: st.serverId, resourceType: 'swarm-network', resourceName: name, action: 'swarm_network_create', details: { encrypted, attachable, internal, subnet: opts.IPAM ? subnet : 'from the pool' } });
  return { id: r.id, firewall };
}

async function removeNetwork(id, { sourceIp } = {}) {
  const { c, st } = await mgr();
  const n = (await networks()).find(x => x.id === id || x.name === id);
  if (!n) throw bad(404, 'Network not found');
  if (n.ingress) throw bad(400, 'The ingress network is changed with Change subnet…, not removed');
  if (n.usedBy.length) throw bad(409, `Used by ${n.usedBy.join(', ')} — remove it from those services first`);
  try { await c.getNetwork(n.id).remove(); } catch (e) { throw bad(409, swarm.dockerMsg(e)); }
  logAction({ sourceIp, server: st.serverId, resourceType: 'swarm-network', resourceName: n.name, action: 'swarm_network_remove' });
  return { ok: true };
}

/** Recreate the ingress network with another subnet — only when no service publishes a port through it. */
async function changeIngress(subnet, { sourceIp } = {}) {
  const { c, st } = await mgr();
  const sn = String(subnet || '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+\/(1[6-9]|2[0-8])$/.test(sn)) throw bad(400, 'Subnet: write it like 10.250.0.0/24 (a /16 to /28)');
  const nets = await networks();
  const ing = nets.find(n => n.ingress);
  if (ing && ing.usedBy.length) throw bad(409, `${ing.usedBy.join(', ')} publish${ing.usedBy.length === 1 ? 'es' : ''} ports through ingress — change those ports to host mode or remove the services first`);
  if (ing) { await c.getNetwork(ing.id).remove(); for (let i = 0; i < 15; i++) { if (!(await c.listNetworks({ filters: JSON.stringify({ name: ['ingress'] }) })).some(n => n.Ingress)) break; await sleep(1000); } }
  try { await c.createNetwork({ Name: 'ingress', Driver: 'overlay', Ingress: true, IPAM: { Driver: 'default', Config: [{ Subnet: sn }] } }); }
  catch (e) { throw bad(400, `The ingress network was removed but could not be created again: ${swarm.dockerMsg(e)} — create it with: docker network create --driver overlay --ingress --subnet ${sn} ingress`); }
  logAction({ sourceIp, server: st.serverId, resourceType: 'swarm-network', resourceName: 'ingress', action: 'swarm_ingress_subnet', details: { from: ing ? ing.subnets : [], to: sn } });
  return { ok: true };
}

module.exports = { list, create, configContent, remove, startRotate, networks, createNetwork, removeNetwork, changeIngress, versionOf };
