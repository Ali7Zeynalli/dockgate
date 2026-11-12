// Stacks from a stack file kept in DockGate — phase GC.
//   New stack:   paste a stack file (or start from an app template) with optional KEY=VALUE variables;
//                DockGate checks it with `docker stack config`, deploys it and keeps it for Redeploy / Edit.
//   Take over:   a stack deployed outside DockGate gets a stack file written from its running services, so
//                DockGate can edit and redeploy it. Nothing is deployed when it is taken over.
//   Container:   a container started with `docker run` becomes a one-service stack: the stack file is written
//                from the container (image, command, env, ports, volumes, restart, labels), the container is
//                stopped (kept, restart policy set to "no") and the stack deployed. If the stack does not come
//                up, the container is started again. Move back does the reverse. Named volumes are used by
//                their own name (external), so the data stays; bind mounts keep their host path.
const { spawn } = require('child_process');
const { db } = require('./db');
const dockerService = require('./docker');
const swarm = require('./swarm');
const ST = require('./swarm-stacks');
const { logAction } = require('./audit');
const { buildCliEnv } = require('./remote-cli-env');
const { encrypt, decrypt } = require('./auth/secrets');

const I = ST._internal;
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const putYaml = db.prepare(`INSERT INTO swarm_stacks (server_id, name, origin, location, settings, yaml, env, from_container, created_at, updated_at)
  VALUES (@server_id, @name, @origin, NULL, '{}', @yaml, @env, @from_container, @now, @now)
  ON CONFLICT(server_id, name) DO UPDATE SET origin = excluded.origin, yaml = excluded.yaml, env = excluded.env,
  from_container = COALESCE(excluded.from_container, swarm_stacks.from_container), updated_at = excluded.updated_at`);

// ---- a small YAML writer (strings always quoted, so nothing is read back as another type) ----
const plainKey = (k) => (/^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(k) ? k : JSON.stringify(k));
const scalar = (v) => (typeof v === 'string' ? JSON.stringify(v) : v === null || v === undefined ? 'null' : String(v));
function toYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return v.map(x => (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length
      ? `\n${pad}- ${toYaml(x, indent + 2).replace(/^\n\s*/, '')}`
      : `\n${pad}- ${x && typeof x === 'object' ? (Array.isArray(x) ? JSON.stringify(x) : '{}') : scalar(x)}`)).join('');
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (!keys.length) return ' {}';
    return keys.map(k => {
      const x = v[k];
      if (x && typeof x === 'object') return `\n${pad}${plainKey(k)}:${toYaml(x, indent + 2)}`;
      return `\n${pad}${plainKey(k)}: ${scalar(x)}`;
    }).join('');
  }
  return ' ' + scalar(v);
}
const dump = (obj) => toYaml(obj).replace(/^\n/, '') + '\n';

/** KEY=VALUE lines → { KEY: VALUE } (comments and blank lines skipped). */
function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) throw bad(400, `Variables: "${t.slice(0, 40)}" is not KEY=VALUE`);
    const k = t.slice(0, i).trim(), val = t.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw bad(400, `Variables: ${k} is not a valid name`);
    out[k] = val;
  }
  return out;
}
const envOf = (row) => (row && row.env ? parseEnv(decrypt(row.env)) : {});

/** `docker stack config -c -`: checks the file and fills in ${VAR}. Returns the rendered file. */
async function check(yaml, vars = {}) {
  const remote = I.remoteServer();
  if (remote) { // on the server itself over the SSH session (password or key)
    const r = await require('./remote-compose').runDockerRemote(remote, ['stack', 'config', '-c', '@stack.yml'], { files: { 'stack.yml': String(yaml) }, vars });
    if (r.code === 0) return r.out;
    if (/unknown command|is not a docker command/i.test(r.out)) return null; // old CLI there: deploy checks it
    throw bad(400, `The stack file is not valid: ${r.out.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  }
  return new Promise((resolve, reject) => {
    const { env } = buildCliEnv(I.serverId(), 'stack');
    const child = spawn('docker', ['stack', 'config', '-c', '-'], { env: { ...env, ...vars } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', (e) => reject(bad(500, `docker CLI: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      if (/unknown command|is not a docker command/i.test(err)) return resolve(null); // old CLI: deploy checks it
      reject(bad(400, `The stack file is not valid: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`));
    });
    child.stdin.end(String(yaml));
  });
}

// ---- a stack file from what runs ----

const dur = (ns) => (ns ? `${Math.round(ns / 1e9)}s` : undefined);
function servicePart(spec, { prefix, volumes, networks, secrets, configs, netNames }) {
  const cs = spec.TaskTemplate.ContainerSpec || {};
  const out = { image: String(cs.Image || '').split('@')[0] };
  if (cs.Command && cs.Command.length) out.entrypoint = cs.Command;
  if (cs.Args && cs.Args.length) out.command = cs.Args;
  if (cs.Env && cs.Env.length) out.environment = cs.Env;
  if (cs.Dir) out.working_dir = cs.Dir;
  if (cs.User) out.user = cs.User;
  if (cs.Hostname) out.hostname = cs.Hostname;
  if (cs.Init) out.init = true;
  if (cs.StopGracePeriod) out.stop_grace_period = dur(cs.StopGracePeriod);
  const labels = Object.fromEntries(Object.entries(cs.Labels || {}).filter(([k]) => !k.startsWith('com.docker.stack.')));
  if (Object.keys(labels).length) out.labels = labels;
  if (cs.Healthcheck && cs.Healthcheck.Test && cs.Healthcheck.Test.length) {
    const h = cs.Healthcheck;
    out.healthcheck = h.Test[0] === 'NONE' ? { disable: true } : { test: h.Test, interval: dur(h.Interval), timeout: dur(h.Timeout), retries: h.Retries || undefined, start_period: dur(h.StartPeriod) };
  }
  const mounts = [];
  for (const m of cs.Mounts || []) {
    if (m.Type === 'volume') {
      const key = prefix && m.Source && m.Source.startsWith(prefix) ? m.Source.slice(prefix.length) : null;
      if (key) volumes[key] = volumes[key] || {};
      else if (m.Source) { const k = m.Source.replace(/[^A-Za-z0-9_.-]/g, '_'); volumes[k] = { external: true, name: m.Source }; }
      mounts.push({ type: 'volume', source: key || (m.Source ? m.Source.replace(/[^A-Za-z0-9_.-]/g, '_') : undefined), target: m.Target, read_only: m.ReadOnly || undefined });
    } else if (m.Type === 'bind') mounts.push({ type: 'bind', source: m.Source, target: m.Target, read_only: m.ReadOnly || undefined });
    else if (m.Type === 'tmpfs') mounts.push({ type: 'tmpfs', target: m.Target });
  }
  if (mounts.length) out.volumes = mounts;
  const nets = [];
  for (const n of spec.TaskTemplate.Networks || []) {
    const full = netNames.get(n.Target) || n.Target;
    if (full === 'ingress') continue;
    const key = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!networks[key]) networks[key] = prefix && full.startsWith(prefix) ? { driver: 'overlay', attachable: true } : { external: true, name: full };
    nets.push(key);
  }
  if (nets.length) out.networks = nets;
  for (const [kind, store, list] of [['secrets', secrets, cs.Secrets], ['configs', configs, cs.Configs]]) {
    if (!list || !list.length) continue;
    out[kind] = list.map(x => { store[x.SecretName || x.ConfigName] = { external: true }; return { source: x.SecretName || x.ConfigName, target: x.File ? x.File.Name : undefined }; });
  }
  const ports = ((spec.EndpointSpec || {}).Ports || []).map(p => ({ target: p.TargetPort, published: p.PublishedPort || undefined, protocol: p.Protocol || 'tcp', mode: p.PublishMode || 'ingress' }));
  if (ports.length) out.ports = ports;
  const d = {};
  if (spec.Mode.Global) d.mode = 'global';
  else if (spec.Mode.Replicated) d.replicas = spec.Mode.Replicated.Replicas;
  const pl = spec.TaskTemplate.Placement || {};
  if (pl.Constraints && pl.Constraints.length) d.placement = { constraints: pl.Constraints };
  if (pl.MaxReplicas) d.placement = { ...(d.placement || {}), max_replicas_per_node: pl.MaxReplicas };
  const r = spec.TaskTemplate.Resources || {};
  const lim = {}, res = {};
  if (r.Limits && r.Limits.NanoCPUs) lim.cpus = String(r.Limits.NanoCPUs / 1e9);
  if (r.Limits && r.Limits.MemoryBytes) lim.memory = `${Math.round(r.Limits.MemoryBytes / 1048576)}M`;
  if (r.Reservations && r.Reservations.NanoCPUs) res.cpus = String(r.Reservations.NanoCPUs / 1e9);
  if (r.Reservations && r.Reservations.MemoryBytes) res.memory = `${Math.round(r.Reservations.MemoryBytes / 1048576)}M`;
  if (Object.keys(lim).length || Object.keys(res).length) d.resources = { ...(Object.keys(lim).length ? { limits: lim } : {}), ...(Object.keys(res).length ? { reservations: res } : {}) };
  const rp = spec.TaskTemplate.RestartPolicy;
  if (rp) d.restart_policy = { condition: rp.Condition || 'any', delay: dur(rp.Delay), max_attempts: rp.MaxAttempts || undefined };
  const uc = spec.UpdateConfig;
  if (uc) d.update_config = { parallelism: uc.Parallelism ?? 1, delay: dur(uc.Delay), order: uc.Order || undefined, failure_action: uc.FailureAction || undefined, monitor: dur(uc.Monitor) };
  const svcLabels = Object.fromEntries(Object.entries(spec.Labels || {}).filter(([k]) => !k.startsWith('com.docker.stack.')));
  if (Object.keys(svcLabels).length) d.labels = svcLabels;
  out.deploy = d;
  return out;
}

/** A stack file written from the services of a stack that runs now. */
async function yamlFromStack(name) {
  const c = dockerService.docker;
  const [services, nets] = await Promise.all([c.listServices({ filters: JSON.stringify({ label: [`com.docker.stack.namespace=${name}`] }) }), c.listNetworks()]);
  if (!services.length) throw bad(404, `No services of stack ${name}`);
  const ctx = { prefix: `${name}_`, volumes: {}, networks: {}, secrets: {}, configs: {}, netNames: new Map(nets.map(n => [n.Id, n.Name])) };
  const file = { services: {} };
  for (const s of services.sort((a, b) => a.Spec.Name.localeCompare(b.Spec.Name))) file.services[s.Spec.Name.startsWith(ctx.prefix) ? s.Spec.Name.slice(ctx.prefix.length) : s.Spec.Name] = servicePart(s.Spec, ctx);
  for (const k of ['networks', 'volumes', 'secrets', 'configs']) if (Object.keys(ctx[k]).length) file[k] = ctx[k];
  return `# Written by DockGate from the running services of stack ${name}.\n# Check it, then save: DockGate keeps it and deploys it on Redeploy.\n` + dump(file);
}

/** A stack file for a container started with docker run. Returns { name, yaml, notes }. */
async function yamlFromContainer(id) {
  const c = dockerService.docker;
  const ct = await c.getContainer(id).inspect().catch(() => { throw bad(404, 'Container not found'); });
  const labels = ct.Config.Labels || {};
  if (labels['com.docker.compose.project']) throw bad(400, 'This container belongs to a compose project — move the project with Migrate');
  if (labels['com.docker.swarm.service.id']) throw bad(400, 'This container is already a Swarm task');
  const notes = [];
  let image = ct.Config.Image;
  let img = null;
  try { img = await c.getImage(ct.Image).inspect(); } catch (e) { /* defaults unknown */ }
  const svc = { image };
  if (/^sha256:|^[0-9a-f]{12,64}$/.test(image)) notes.push({ level: 'bad', text: 'started from an image ID: write the image name (repo:tag) in the file' });
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  if (ct.Config.Entrypoint && !same(ct.Config.Entrypoint, img && img.Config.Entrypoint)) svc.entrypoint = ct.Config.Entrypoint;
  if (ct.Config.Cmd && !same(ct.Config.Cmd, img && img.Config.Cmd)) svc.command = ct.Config.Cmd;
  const imgEnv = new Set((img && img.Config.Env) || []);
  const env = (ct.Config.Env || []).filter(e => !imgEnv.has(e));
  if (env.length) svc.environment = env;
  if (ct.Config.WorkingDir && ct.Config.WorkingDir !== (img && img.Config.WorkingDir)) svc.working_dir = ct.Config.WorkingDir;
  if (ct.Config.User && ct.Config.User !== (img && img.Config.User)) svc.user = ct.Config.User;
  const imgLabels = (img && img.Config.Labels) || {};
  const myLabels = Object.fromEntries(Object.entries(labels).filter(([k, v]) => imgLabels[k] !== v && !k.startsWith('org.opencontainers.')));
  if (Object.keys(myLabels).length) svc.labels = myLabels;
  const hc = ct.Config.Healthcheck;
  if (hc && hc.Test && !same(hc, img && img.Config.Healthcheck)) svc.healthcheck = hc.Test[0] === 'NONE' ? { disable: true } : { test: hc.Test, interval: dur(hc.Interval), timeout: dur(hc.Timeout), retries: hc.Retries || undefined, start_period: dur(hc.StartPeriod) };
  const ports = [];
  for (const [cport, binds] of Object.entries(ct.HostConfig.PortBindings || {})) {
    const [target, proto] = cport.split('/');
    for (const b of binds || []) {
      if (b.HostIp && !['0.0.0.0', '::', ''].includes(b.HostIp)) notes.push({ level: 'warn', text: `port ${b.HostPort}: the address ${b.HostIp} is dropped (Swarm publishes on every address)` });
      ports.push({ target: Number(target), published: b.HostPort ? Number(b.HostPort) : undefined, protocol: proto || 'tcp', mode: 'ingress' });
    }
  }
  if (ports.length) svc.ports = ports;
  const volumes = {};
  const mounts = [];
  for (const m of ct.Mounts || []) {
    if (m.Type === 'volume') {
      const k = m.Name.length > 40 && /^[0-9a-f]+$/.test(m.Name) ? `data_${m.Name.slice(0, 8)}` : m.Name.replace(/[^A-Za-z0-9_.-]/g, '_');
      volumes[k] = { external: true, name: m.Name };
      mounts.push({ type: 'volume', source: k, target: m.Destination, read_only: m.RW === false ? true : undefined });
      if (/^[0-9a-f]{64}$/.test(m.Name)) notes.push({ level: 'info', text: `${m.Destination}: an anonymous volume — used by its ID, so the data stays` });
    } else if (m.Type === 'bind') mounts.push({ type: 'bind', source: m.Source, target: m.Destination, read_only: m.RW === false ? true : undefined });
    else if (m.Type === 'tmpfs') mounts.push({ type: 'tmpfs', target: m.Destination });
  }
  if (mounts.length) svc.volumes = mounts;
  const hcfg = ct.HostConfig;
  if (hcfg.Privileged) notes.push({ level: 'bad', text: 'privileged: Swarm services can not be privileged' });
  if ((hcfg.Devices || []).length) notes.push({ level: 'bad', text: 'devices: Swarm services can not use host devices' });
  if (hcfg.NetworkMode === 'host') notes.push({ level: 'bad', text: 'network host: not possible on Swarm' });
  const userNets = Object.keys((ct.NetworkSettings || {}).Networks || {}).filter(n => !['bridge', 'host', 'none'].includes(n));
  if (userNets.length) notes.push({ level: 'warn', text: `networks ${userNets.join(', ')}: bridge networks do not exist on Swarm — the service gets the stack network; services it talks to must be on Swarm too` });
  if ((hcfg.CapAdd || []).length) svc.cap_add = hcfg.CapAdd;
  const rp = hcfg.RestartPolicy || {};
  const d = { replicas: 1, restart_policy: { condition: rp.Name === 'no' ? 'none' : rp.Name === 'on-failure' ? 'on-failure' : 'any', delay: '5s' }, update_config: { order: 'stop-first', failure_action: 'rollback' } };
  const lim = {};
  if (hcfg.NanoCpus) lim.cpus = String(hcfg.NanoCpus / 1e9);
  if (hcfg.Memory) lim.memory = `${Math.round(hcfg.Memory / 1048576)}M`;
  if (Object.keys(lim).length) d.resources = { limits: lim };
  const st = await swarm.status();
  const nodes = (await c.listNodes().catch(() => [])).length;
  if (nodes > 1 && mounts.some(m => m.type !== 'tmpfs')) { d.placement = { constraints: [`node.hostname == ${st.serverName}`] }; notes.push({ level: 'info', text: `has data on this server: it is kept on ${st.serverName} (placement rule)` }); }
  svc.deploy = d;
  const name = ct.Name.replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'app';
  const file = { services: { [name]: svc } };
  if (Object.keys(volumes).length) file.volumes = volumes;
  return { name, container: ct.Name.replace(/^\//, ''), yaml: `# Written by DockGate from the container ${ct.Name.replace(/^\//, '')}.\n` + dump(file), notes, running: ct.State.Running };
}

// ---- jobs ----

/** Deploy a stack file kept in DockGate. body: { name, yaml, env, create } */
async function startDeploy(body, { sourceIp } = {}) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw bad(400, 'Name: lower-case letters, digits, - or _ (it starts the service names)');
  const sid = I.serverId();
  const row = I.q.get.get(sid, name);
  if (body.create && (row || (await dockerService.docker.listServices({ filters: JSON.stringify({ label: [`com.docker.stack.namespace=${name}`] }) })).length)) throw bad(409, `A stack named ${name} already exists`);
  if (!body.create && row && row.origin === 'compose') throw bad(400, 'This stack is deployed from its compose files — use Redeploy');
  if (body.create) {
    const projects = await dockerService.listComposeProjects().catch(() => []);
    if (projects.some(p => p.name === name)) throw bad(409, `A compose project named ${name} runs on this server — choose another name, or move that project with Migrate`);
  }
  const yaml = String(body.yaml || '');
  if (!yaml.trim()) throw bad(400, 'The stack file is empty');
  const vars = parseEnv(body.env);
  await I.context(); // Swarm active and a manager
  await check(yaml, vars);
  const { job, log, step } = I.newJob(body.create ? 'deploy' : 'redeploy', name);
  (async () => {
    const hash = I.hashOf(yaml);
    const id = I.q.addDeploy.run(sid, name, body.create ? 'deploy' : 'redeploy', hash, yaml, sourceIp || null, Date.now()).lastInsertRowid;
    try {
      putYaml.run({ server_id: sid, name, origin: row && row.origin === 'container' ? 'container' : 'yaml', yaml, env: Object.keys(vars).length ? encrypt(String(body.env)) : null, from_container: null, now: Date.now() });
      step(job, 'deploy', 'running', 'docker stack deploy');
      const t = Date.now();
      await I.stackDeploy(name, yaml, log, vars);
      step(job, 'deploy', 'done');
      step(job, 'verify', 'running', 'Check every service runs');
      await I.verify(name, log, { since: t });
      step(job, 'verify', 'done');
      I.q.endDeploy.run('done', null, null, Date.now(), id);
      logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: body.create ? 'swarm_stack_deploy' : 'swarm_stack_redeploy', details: { hash } });
      log('✓ Deployed. DockGate keeps the stack file: Stacks → Edit stack file… changes it.');
      I.finish(job);
    } catch (e) {
      log('✗ ' + e.message);
      I.q.endDeploy.run('failed', e.message, null, Date.now(), id);
      I.finish(job, e);
    } finally { I.q.trim.run(sid, name, sid, name); }
  })();
  return job;
}

/** The stack file kept for a stack (and its variables). */
function getFile(name) {
  const row = I.q.get.get(I.serverId(), name);
  if (!row || !row.yaml) throw bad(404, 'DockGate keeps no stack file for this stack');
  return { name, origin: row.origin, yaml: row.yaml, env: row.env ? decrypt(row.env) : '', fromContainer: row.from_container ? JSON.parse(row.from_container) : null };
}

/** Take over a stack deployed outside DockGate: keep the given (or written) stack file. Nothing is deployed. */
async function takeOver(name, { yaml, env } = {}, { sourceIp } = {}) {
  const sid = I.serverId();
  if (I.q.get.get(sid, name)) throw bad(409, 'DockGate already manages this stack');
  const text = String(yaml || '') || await yamlFromStack(name);
  const vars = parseEnv(env);
  await check(text, vars);
  putYaml.run({ server_id: sid, name, origin: 'yaml', yaml: text, env: Object.keys(vars).length ? encrypt(String(env)) : null, from_container: null, now: Date.now() });
  logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: 'swarm_stack_take_over', details: {} });
  return { ok: true };
}

/** Move a docker run container to Swarm. body: { containerId, name, yaml, env } */
async function startConvert(body, { sourceIp } = {}) {
  const c = dockerService.docker;
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw bad(400, 'Name: lower-case letters, digits, - or _');
  const sid = I.serverId();
  if (I.q.get.get(sid, name) || (await c.listServices({ filters: JSON.stringify({ label: [`com.docker.stack.namespace=${name}`] }) })).length) throw bad(409, `A stack named ${name} already exists`);
  if ((await dockerService.listComposeProjects().catch(() => [])).some(p => p.name === name)) throw bad(409, `A compose project named ${name} runs on this server — choose another name`);
  const ct = await c.getContainer(String(body.containerId || '')).inspect().catch(() => { throw bad(404, 'Container not found'); });
  const yaml = String(body.yaml || '');
  const vars = parseEnv(body.env);
  await I.context();
  await check(yaml, vars);
  const cname = ct.Name.replace(/^\//, '');
  const restart = (ct.HostConfig.RestartPolicy || {}).Name || 'no';
  const { job, log, step } = I.newJob('convert', cname);
  (async () => {
    const id = I.q.addDeploy.run(sid, name, 'move', I.hashOf(yaml), yaml, sourceIp || null, Date.now()).lastInsertRowid;
    let stopped = false, deployed = false; const t = Date.now();
    try {
      step(job, 'stop', 'running', `Stop ${cname} (it is kept)`);
      await c.getContainer(ct.Id).update({ RestartPolicy: { Name: 'no' } });
      if (ct.State.Running) { await c.getContainer(ct.Id).stop({ t: 20 }).catch(e => { if (e.statusCode !== 304) throw e; }); }
      stopped = true;
      step(job, 'stop', 'done');
      step(job, 'deploy', 'running', 'docker stack deploy');
      await I.stackDeploy(name, yaml, log, vars);
      deployed = true;
      step(job, 'deploy', 'done');
      step(job, 'verify', 'running', 'Check the service runs');
      const ready = await I.verify(name, log, { since: t });
      step(job, 'verify', 'done');
      putYaml.run({ server_id: sid, name, origin: 'container', yaml, env: Object.keys(vars).length ? encrypt(String(body.env)) : null, from_container: JSON.stringify({ id: ct.Id, name: cname, restart }), now: Date.now() });
      I.q.endDeploy.run('done', null, ready - t, Date.now(), id);
      logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: 'swarm_container_to_swarm', details: { container: cname, downtimeMs: ready - t } });
      log(`✓ ${cname} runs on Swarm as stack ${name} (down for about ${Math.round((ready - t) / 1000)}s). The container is kept, stopped; Move back starts it again.`);
      I.finish(job);
    } catch (e) {
      log('✗ ' + e.message);
      if (stopped) {
        step(job, 'back', 'running', `Start ${cname} again`);
        try {
          if (deployed) await I.stackRemove(name, log); else await I.stackRemove(name, log).catch(() => {});
          await c.getContainer(ct.Id).update({ RestartPolicy: { Name: restart } });
          if (ct.State.Running) await c.getContainer(ct.Id).start().catch(er => { if (er.statusCode !== 304) throw er; });
          step(job, 'back', 'done');
          log(`↩ ${cname} runs again`);
        } catch (u) { step(job, 'back', 'failed'); log(`✗ starting ${cname} again failed: ${u.message} — start it yourself`); }
      }
      I.q.endDeploy.run(stopped ? 'rolled_back' : 'failed', e.message, null, Date.now(), id);
      I.finish(job, e);
    }
  })();
  return job;
}

/** Move a stack made from a container back: remove the stack, give the container its restart policy, start it. */
async function startBackToContainer(name, { sourceIp } = {}) {
  const c = dockerService.docker;
  const sid = I.serverId();
  const row = I.q.get.get(sid, name);
  if (!row || row.origin !== 'container' || !row.from_container) throw bad(404, 'This stack was not made from a container');
  const from = JSON.parse(row.from_container);
  const ct = await c.getContainer(from.id).inspect().catch(() => null);
  if (!ct) throw bad(404, `The container ${from.name} is gone — remove the stack instead, or keep it on Swarm`);
  const { job, log, step } = I.newJob('move-back', name);
  (async () => {
    const id = I.q.addDeploy.run(sid, name, 'move-back', null, null, sourceIp || null, Date.now()).lastInsertRowid;
    const t = Date.now();
    try {
      step(job, 'rm', 'running', 'Remove the stack (volumes stay)');
      await I.stackRemove(name, log);
      step(job, 'rm', 'done');
      step(job, 'start', 'running', `Start ${from.name}`);
      await c.getContainer(from.id).update({ RestartPolicy: { Name: from.restart || 'no' } });
      await c.getContainer(from.id).start().catch(e => { if (e.statusCode !== 304) throw e; });
      step(job, 'start', 'done');
      I.q.del.run(sid, name);
      I.q.endDeploy.run('done', null, Date.now() - t, Date.now(), id);
      logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: 'swarm_back_to_container', details: { container: from.name } });
      log(`✓ ${from.name} runs as a container again`);
      I.finish(job);
    } catch (e) {
      log('✗ ' + e.message);
      I.q.endDeploy.run('failed', e.message, Date.now() - t, Date.now(), id);
      I.finish(job, e);
    }
  })();
  return job;
}

/** Containers started with docker run on the server in use (candidates for Move to Swarm). */
async function containers() {
  const list = await dockerService.docker.listContainers({ all: true });
  const moved = new Set(I.q.all.all(I.serverId()).filter(r => r.from_container).map(r => JSON.parse(r.from_container).id));
  return list.filter(x => !x.Labels['com.docker.compose.project'] && !x.Labels['com.docker.swarm.service.id'] && !x.Labels['dockgate.helper'] && !moved.has(x.Id))
    .map(x => ({ id: x.Id, name: (x.Names[0] || '').replace(/^\//, ''), image: x.Image, state: x.State, status: x.Status }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { toYaml: dump, parseEnv, envOf, check, yamlFromStack, yamlFromContainer, startDeploy, getFile, takeOver, startConvert, startBackToContainer, containers, _servicePart: servicePart };
