// Swarm stacks and moving compose projects to Swarm — phase 4.
//
// A stack is a compose project running on Swarm. Its compose files are never changed: on every deploy
// DockGate reads them with `docker compose config` (.env filled in, several files merged) and adapts the
// result in memory — container_name and build removed, restart → deploy.restart_policy, depends_on
// conditions → a plain list, ports as numbers, networks as attachable overlays — adds the Swarm settings kept
// in DockGate (replicas, update order, port mode) and runs `docker stack deploy --prune --with-registry-auth`.
// Volume names stay the same, so the data stays.
//
// Moving a project (one at a time): the files are read again (stop if they changed since the plan) →
// `docker compose down` (volumes stay) → stack deploy under the same name → every service must reach its
// replicas and stay up for 30 s (healthy, if it has a health check). If not, DockGate puts it back: stack
// rm → wait until the stack network is gone → `docker compose up -d`.
const crypto = require('crypto');
const { spawn } = require('child_process');
const { db } = require('./db');
const dockerService = require('./docker');
const swarm = require('./swarm');
const { logAction } = require('./audit');
const { buildCliEnv } = require('./remote-cli-env');

db.exec(`CREATE TABLE IF NOT EXISTS swarm_stacks (
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,            -- compose (moved from a compose project) | deploy
  location TEXT,                   -- JSON: where the compose files are ({ files, cwd, remote, serverId })
  settings TEXT,                   -- JSON: Swarm settings per service
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (server_id, name)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS swarm_stack_deploys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- move | deploy | redeploy | previous | move-back
  status TEXT NOT NULL,            -- running | done | rolled_back | failed
  hash TEXT,
  stack TEXT,                      -- the adapted stack file that was deployed (JSON)
  error TEXT,
  downtime_ms INTEGER,
  source_ip TEXT,
  started_at INTEGER,
  finished_at INTEGER
)`);
const q = {
  get: db.prepare('SELECT * FROM swarm_stacks WHERE server_id = ? AND name = ?'),
  all: db.prepare('SELECT * FROM swarm_stacks WHERE server_id = ?'),
  put: db.prepare(`INSERT INTO swarm_stacks (server_id, name, origin, location, settings, created_at, updated_at) VALUES (@server_id, @name, @origin, @location, @settings, @now, @now)
    ON CONFLICT(server_id, name) DO UPDATE SET location = excluded.location, settings = excluded.settings, updated_at = excluded.updated_at`),
  del: db.prepare('DELETE FROM swarm_stacks WHERE server_id = ? AND name = ?'),
  addDeploy: db.prepare(`INSERT INTO swarm_stack_deploys (server_id, name, kind, status, hash, stack, source_ip, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`),
  endDeploy: db.prepare('UPDATE swarm_stack_deploys SET status = ?, error = ?, downtime_ms = ?, finished_at = ? WHERE id = ?'),
  history: db.prepare('SELECT id, server_id, name, kind, status, hash, error, downtime_ms, source_ip, started_at, finished_at, stack IS NOT NULL AS has_stack FROM swarm_stack_deploys WHERE server_id = ? AND name = ? ORDER BY id DESC LIMIT 30'),
  deployRow: db.prepare('SELECT * FROM swarm_stack_deploys WHERE id = ? AND server_id = ?'),
  trim: db.prepare('DELETE FROM swarm_stack_deploys WHERE server_id = ? AND name = ? AND id NOT IN (SELECT id FROM swarm_stack_deploys WHERE server_id = ? AND name = ? ORDER BY id DESC LIMIT 30)'),
};
db.prepare("UPDATE swarm_stack_deploys SET status = 'failed', error = 'DockGate stopped during the job', finished_at = ? WHERE status = 'running'").run(Date.now());

const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const helpers = () => require('./routes/compose').composeHelpers;
const serverId = () => dockerService.getActiveServerId() || 'local';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WATCH_MS = () => Math.max(0, Number(process.env.SWARM_MOVE_WATCH_MS) || 30000);

/** Is this compose project running as a stack on the server in use? (Compose Up is blocked then.) */
function isOnSwarm(project, sid = serverId()) { return !!q.get.get(sid, project); }
function stackRows(sid = serverId()) { return q.all.all(sid); }

// ---- reading a compose project ----

const DB_IMAGE = /(^|\/)(postgres|postgis|mysql|mariadb|mongo|mongodb|redis|valkey|keydb|elasticsearch|opensearch|cassandra|clickhouse|influxdb|timescaledb|couchdb|neo4j|rabbitmq|minio|etcd|zookeeper)(:|@|$)/i;
const isDatabase = (image) => DB_IMAGE.test(String(image || '').replace(/^docker\.io\//, '').replace(/^library\//, ''));
const IGNORED_BY_SWARM = ['security_opt', 'cgroup_parent', 'pid', 'ipc', 'userns_mode', 'links', 'external_links', 'mac_address', 'oom_score_adj', 'oom_kill_disable', 'cpuset', 'cpu_shares', 'cpu_quota', 'cpu_period', 'mem_limit', 'memswap_limit', 'shm_size', 'storage_opt', 'device_cgroup_rules', 'volumes_from', 'domainname'];

/** `docker compose config --format json` of a resolved project; the JSON is cut out of any warnings around it. */
async function readConfig(r, project) {
  const out = String(await helpers().runResolved(r, project, ['config', '--format', 'json'], null));
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b < a) throw bad(400, `docker compose config gave no JSON: ${out.trim().split('\n').pop().slice(0, 200)}`);
  return JSON.parse(out.slice(a, b + 1));
}
const hashOf = (cfg) => crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);

/**
 * Look at a compose project: can it move, and what changes? Returns
 * { project, status: ready|attention|impossible, reasons, services:[…], volumes, hash, location }.
 */
async function analyze(project, { nodes = 1, localImages = null, location = null } = {}) {
  const h = helpers();
  if (!h.validateProjectName(project)) throw bad(400, 'Invalid project name');
  const out = { project, status: 'ready', reasons: [], services: [], volumes: [], hash: null, location: null };
  // A stack DockGate moved keeps where its files are (the compose container labels are gone after the move).
  const r = location ? { files: location.files, cwd: location.cwd, remote: location.remote, server: location.serverId ? require('./db').stmts.getServer.get(location.serverId) : null, source: 'stored' } : await h.resolveComposeFiles(project);
  if (!r.files.length) { out.status = 'impossible'; out.reasons.push(r.reason || 'DockGate can not find the compose file of this project (started with docker run, or the file is gone).'); return out; }
  out.location = { files: r.files, cwd: r.cwd, remote: !!r.remote, serverId: r.server ? r.server.id : null, source: r.source };
  let cfg;
  try { cfg = await readConfig(r, project); } catch (e) { out.status = 'impossible'; out.reasons.push(`docker compose config failed: ${e.message}`); return out; }
  out.hash = hashOf(cfg);
  out.volumes = Object.entries(cfg.volumes || {}).map(([k, v]) => ({ key: k, name: (v && v.name) || `${project}_${k}`, external: !!(v && v.external) }));
  const block = (m) => { out.status = 'impossible'; out.reasons.push(m); };
  for (const [name, s] of Object.entries(cfg.services || {})) {
    const f = []; // findings: { level: info|warn|bad, text }
    const add = (level, text) => f.push({ level, text });
    if (s.privileged) add('bad', 'privileged: Swarm services can not be privileged — this project stays in Compose (moving part of a project comes later)');
    if (s.devices && s.devices.length) add('bad', 'devices: Swarm services can not use host devices — this project stays in Compose');
    if (s.network_mode && s.network_mode !== 'bridge') add('bad', `network_mode: ${s.network_mode} is not possible on Swarm`);
    let image = s.image || null;
    if (s.build) {
      const built = `${project}-${name}`;
      if (!image) {
        if (nodes > 1) add('bad', 'build: without image — on several servers the image must be in a registry (build and push it, then add image: to the file)');
        else if (localImages && localImages.has(built)) { image = built; add('warn', `build: the image built by Compose (${built}) is used; Swarm does not build`); }
        else add('bad', `build: without image and no built image ${built} here — build it first (Compose → Build)`);
      } else add('warn', `build: Swarm does not build — the image ${image} is used${nodes > 1 ? ' (it must be in a registry for the other servers)' : ''}`);
    }
    if (s.container_name) add('info', `container_name ${s.container_name} is removed (Swarm names tasks ${project}_${name}.1 …)`);
    if (s.depends_on && Object.values(s.depends_on).some(d => d && d.condition && d.condition !== 'service_started')) add('warn', 'depends_on with a condition: Swarm starts services without waiting — the app must retry its connections');
    if (s.restart) add('info', `restart: ${s.restart} → restart policy ${restartPolicy(s.restart).condition}`);
    for (const p of s.ports || []) if (p.host_ip) add('warn', `port ${p.published}: the host address ${p.host_ip} is dropped (Swarm publishes on every address)`);
    if (isDatabase(image)) add('warn', 'database: stays at 1 replica');
    const ignored = IGNORED_BY_SWARM.filter(k => s[k] !== undefined && s[k] !== null);
    if (ignored.length) add('warn', `ignored by Swarm: ${ignored.join(', ')}`);
    const binds = (s.volumes || []).filter(v => v.type === 'bind');
    const vols = (s.volumes || []).filter(v => v.type === 'volume');
    if (nodes > 1 && (binds.length || vols.length)) add('info', 'has data on this server: it is kept on this server (placement rule)');
    for (const sec of [...(s.secrets || []), ...(s.configs || [])]) { const top = (cfg.secrets || {})[sec.source] || (cfg.configs || {})[sec.source]; if (top && top.file && r.remote) add('bad', `secret/config ${sec.source} from a file: not possible for a project on a remote server yet`); }
    if (s.environment && Object.keys(s.environment).length) add('info', `environment (${Object.keys(s.environment).length}) taken from the files and .env`);
    if (f.some(x => x.level === 'bad')) out.status = 'impossible';
    else if (out.status === 'ready' && f.some(x => x.level === 'warn')) out.status = 'attention';
    out.services.push({ name, image, database: isDatabase(image), findings: f, ports: (s.ports || []).map(p => ({ published: Number(p.published) || null, target: p.target, protocol: p.protocol || 'tcp' })), healthcheck: !!(s.healthcheck && !s.healthcheck.disable), volumes: vols.map(v => v.source), binds: binds.map(v => v.source) });
  }
  if (!out.services.length) block('The project has no services.');
  out.cfg = cfg; // server side only
  return out;
}

function restartPolicy(r) {
  const s = String(r || '');
  if (s === 'no') return { condition: 'none' };
  const m = /^on-failure(?::(\d+))?$/.exec(s);
  if (m) return { condition: 'on-failure', ...(m[1] ? { max_attempts: Number(m[1]) } : {}) };
  return { condition: 'any' };
}

// ---- adapting it for Swarm ----

/** Drop nulls and empty objects (stack deploy rejects some of them). */
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (x === null || x === undefined) continue; o[k] = clean(x); }
    return o;
  }
  return v;
}

/**
 * The stack file for `docker stack deploy`, built from compose config output.
 * settings: { services: { name: { replicas, portMode, order } } }; ctx: { nodes, hostname, encrypt, images: {name: image} }
 */
function adapt(cfg, settings = {}, ctx = {}) {
  const set = (settings && settings.services) || {};
  const out = { services: {}, networks: {}, volumes: {}, secrets: {}, configs: {} };
  for (const [name, s0] of Object.entries(cfg.services || {})) {
    const s = JSON.parse(JSON.stringify(s0));
    const my = set[name] || {};
    for (const k of ['container_name', 'build', 'profiles', 'pull_policy', 'links', 'external_links', 'restart', 'scale']) delete s[k];
    for (const k of IGNORED_BY_SWARM) delete s[k];
    if (ctx.images && ctx.images[name]) s.image = ctx.images[name];
    if (s.depends_on && !Array.isArray(s.depends_on)) s.depends_on = Object.keys(s.depends_on);
    if (s.networks && !Array.isArray(s.networks)) for (const k of Object.keys(s.networks)) if (s.networks[k] === null) s.networks[k] = {};
    const hostPorts = my.portMode === 'host';
    if (s.ports) s.ports = s.ports.map(p => clean({ target: Number(p.target), published: p.published !== undefined && p.published !== '' ? Number(p.published) : undefined, protocol: p.protocol || 'tcp', mode: hostPorts ? 'host' : 'ingress' }));
    const d = s.deploy || {};
    const db = isDatabase(s.image);
    if (!d.mode || d.mode === 'replicated') d.replicas = db ? 1 : Math.max(0, Number(my.replicas ?? d.replicas ?? 1));
    d.restart_policy = d.restart_policy || { ...restartPolicy(s0.restart), delay: '5s' };
    // Two copies at once would share the data (a database on one volume) or the host port: stop the old one first.
    const ownsData = db || (s.volumes || []).some(v => v.type === 'volume' || v.type === 'bind');
    const order = hostPorts || ownsData ? 'stop-first' : (my.order || 'start-first');
    d.update_config = { parallelism: 1, delay: '5s', order, failure_action: 'rollback', monitor: '15s', ...(d.update_config || {}), ...(my.order ? { order } : {}) };
    if (hostPorts || ownsData) d.update_config.order = 'stop-first';
    d.rollback_config = { parallelism: 1, order: 'stop-first', failure_action: 'pause', ...(d.rollback_config || {}) };
    if (ctx.nodes > 1 && ownsData && ctx.hostname) {
      d.placement = d.placement || {};
      const c = `node.hostname == ${ctx.hostname}`;
      d.placement.constraints = [...new Set([...(d.placement.constraints || []), c])];
    }
    s.deploy = d;
    out.services[name] = clean(s);
  }
  for (const [k, n0] of Object.entries(cfg.networks || {})) {
    const n = { ...(n0 || {}) };
    if (n.external) { out.networks[k] = clean(n); continue; }
    delete n.ipam; if (n.driver === 'bridge' || !n.driver) n.driver = 'overlay';
    n.attachable = true;
    if (ctx.encrypt && n.driver === 'overlay') n.driver_opts = { ...(n.driver_opts || {}), encrypted: '' };
    out.networks[k] = clean(n);
  }
  for (const [k, v] of Object.entries(cfg.volumes || {})) out.volumes[k] = clean(v || {});
  for (const [k, v] of Object.entries(cfg.secrets || {})) out.secrets[k] = clean(v || {});
  for (const [k, v] of Object.entries(cfg.configs || {})) out.configs[k] = clean(v || {});
  for (const k of ['networks', 'volumes', 'secrets', 'configs']) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}

// ---- running Swarm commands ----

/** docker stack deploy with the stack file on stdin, against the server in use. */
function stackDeploy(name, stack, log) {
  return new Promise((resolve, reject) => {
    const { env } = buildCliEnv(serverId(), 'stack');
    const args = ['stack', 'deploy', '-c', '-', '--prune', '--with-registry-auth', '--detach=true', name];
    log(`$ docker ${args.join(' ')}`);
    const child = spawn('docker', args, { env });
    let out = '';
    const on = (d) => { const t = d.toString(); out += t; t.split('\n').filter(Boolean).forEach(l => log('  ' + l)); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const reason = require('./remote-compose').composeReason(out);
      reject(new Error(`docker stack deploy exited with code ${code}${reason}`));
    });
    child.stdin.end(JSON.stringify(stack));
  });
}

const stackFilter = (name) => JSON.stringify({ label: [`com.docker.stack.namespace=${name}`] });

/** Remove a stack's services and networks (secrets, configs and volumes stay), then wait until its networks are gone. */
async function stackRemove(name, log) {
  const c = dockerService.docker;
  const services = await c.listServices({ filters: stackFilter(name) });
  for (const s of services) { await c.getService(s.ID).remove().catch(() => {}); log(`  removed service ${s.Spec.Name}`); }
  for (let i = 0; i < 60; i++) {
    const nets = await c.listNetworks({ filters: stackFilter(name) });
    if (!nets.length) { if (i) log(`  stack network gone after ${i * 2}s`); return; }
    for (const n of nets) await c.getNetwork(n.Id).remove().catch(() => {});
    await sleep(2000);
  }
  throw new Error('The stack network was not removed in 2 minutes — tasks may still be shutting down');
}

/**
 * Wait until every service of the stack runs its replicas, then watch it for WATCH_MS: no task may fail.
 * Throws with the reason.
 */
async function verify(name, log, { since = Date.now(), timeoutMs = 180000 } = {}) {
  const c = dockerService.docker;
  const t0 = Date.now();
  log(`Waiting for every service of ${name} to run…`);
  for (;;) {
    const services = await c.listServices({ filters: stackFilter(name), status: true });
    if (!services.length) throw new Error('The stack has no services');
    const tasks = await c.listTasks({ filters: stackFilter(name) });
    const failed = tasks.filter(t => ['failed', 'rejected'].includes(t.Status.State) && new Date(t.CreatedAt).getTime() >= since - 2000);
    if (failed.length) { const t = failed[0]; throw new Error(`a task of ${(services.find(s => s.ID === t.ServiceID) || { Spec: { Name: '?' } }).Spec.Name} failed: ${t.Status.Err || t.Status.State}`); }
    const pending = tasks.find(t => t.DesiredState === 'running' && ['pending'].includes(t.Status.State) && t.Status.Err);
    if (pending && Date.now() - t0 > 20000) throw new Error(`a task can not be placed: ${pending.Status.Err}`);
    const notReady = services.filter(s => s.ServiceStatus && s.ServiceStatus.RunningTasks < s.ServiceStatus.DesiredTasks);
    if (!notReady.length) break;
    if (Date.now() - t0 > timeoutMs) throw new Error(`not running in time: ${notReady.map(s => `${s.Spec.Name} ${s.ServiceStatus.RunningTasks}/${s.ServiceStatus.DesiredTasks}`).join(', ')}`);
    await sleep(2000);
  }
  const ready = Date.now();
  log(`✓ Every service runs (${Math.round((ready - t0) / 1000)}s). Watching for ${Math.round(WATCH_MS() / 1000)}s…`);
  while (Date.now() - ready < WATCH_MS()) {
    await sleep(2000);
    const tasks = await c.listTasks({ filters: stackFilter(name) });
    const failed = tasks.filter(t => ['failed', 'rejected'].includes(t.Status.State) && new Date(t.Status.Timestamp).getTime() >= ready);
    if (failed.length) throw new Error(`a task stopped while watching: ${failed[0].Status.Err || failed[0].Status.State}`);
  }
  log('✓ Stable');
  return ready;
}

async function context() {
  const st = await swarm.status();
  if (st.state !== 'active' || !st.manager) throw bad(409, 'Swarm must be active and the server in use a manager');
  const c = dockerService.docker;
  const nodes = (await c.listNodes()).length;
  let encrypt = false;
  try { encrypt = !!(require('./db').stmts.getSetting.get(`swarm_overlay_encrypt:${st.clusterId}`) || {}).value; } catch (e) { /* off */ }
  const images = new Set();
  for (const i of await c.listImages()) for (const t of i.RepoTags || []) images.add(t.replace(/:latest$/, ''));
  return { st, nodes, hostname: st.serverName, encrypt, localImages: images };
}

// ---- listing ----

/** Compose projects on the server in use, with whether and how they can move. */
async function candidates() {
  const ctx = await context();
  const projects = await dockerService.listComposeProjects();
  const out = [];
  for (const p of projects) {
    if (isOnSwarm(p.name)) continue;
    let a;
    try { a = await analyze(p.name, { nodes: ctx.nodes, localImages: ctx.localImages }); } catch (e) { a = { project: p.name, status: 'impossible', reasons: [e.message], services: [] }; }
    delete a.cfg;
    out.push({ ...a, running: p.running, total: p.total });
  }
  return { projects: out, nodes: ctx.nodes };
}

async function list() {
  const sid = serverId();
  const c = dockerService.docker;
  const rows = new Map(q.all.all(sid).map(r => [r.name, r]));
  const services = await c.listServices({ status: true });
  const stacks = new Map();
  for (const s of services) {
    const ns = (s.Spec.Labels || {})['com.docker.stack.namespace'];
    if (!ns) continue;
    const x = stacks.get(ns) || { name: ns, services: 0, running: 0, desired: 0 };
    x.services++; if (s.ServiceStatus) { x.running += s.ServiceStatus.RunningTasks; x.desired += s.ServiceStatus.DesiredTasks; }
    stacks.set(ns, x);
  }
  for (const r of rows.values()) if (!stacks.has(r.name)) stacks.set(r.name, { name: r.name, services: 0, running: 0, desired: 0 });
  return [...stacks.values()].map(x => {
    const r = rows.get(x.name);
    const last = q.history.all(sid, x.name)[0] || null;
    return { ...x, managed: !!r, origin: r ? r.origin : 'outside', location: r ? JSON.parse(r.location || 'null') : null, last };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function history(name) { return q.history.all(serverId(), name); }

// ---- jobs ----

function newJob(kind) {
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const job = swarm._jobs.newJob(kind); swarm._jobs.setCurrent(job);
  return { job, log: swarm._jobs.logTo(job), step: swarm._jobs.step };
}
function finish(job, err) {
  if (err) { job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; }); job.status = 'error'; job.error = err.message; }
  else job.status = 'done';
  job.finishedAt = Date.now();
}

/**
 * Move compose projects to Swarm, one at a time. plans: [{ project, hash, settings }].
 * A project that fails its check is put back in Compose; the others go on.
 */
async function startMove(plans, { sourceIp } = {}) {
  if (!Array.isArray(plans) || !plans.length) throw bad(400, 'Choose at least one project');
  if (plans.length > 20) throw bad(400, 'At most 20 projects at a time');
  const ctx = await context();
  const { job, log, step } = newJob('move');
  job.result = { projects: [] };
  const sid = serverId();
  (async () => {
    for (const plan of plans) {
      const p = String(plan.project || '');
      const res = { project: p, status: 'failed', error: null, downtimeMs: null };
      job.result.projects.push(res);
      const sk = (id, st, label) => step(job, `${p}:${id}`, st, label ? `${p}: ${label}` : undefined);
      let deployId = null, downAt = null, r = null, deployed = false;
      try {
        log(`\n=== ${p} ===`);
        sk('check', 'running', 'read the compose files again');
        if (isOnSwarm(p, sid)) throw new Error('already runs on Swarm');
        const a = await analyze(p, { nodes: ctx.nodes, localImages: ctx.localImages });
        if (a.status === 'impossible') throw new Error(a.reasons.concat(a.services.flatMap(s => s.findings.filter(f => f.level === 'bad').map(f => `${s.name}: ${f.text}`))).join('; '));
        if (plan.hash && a.hash !== plan.hash) { res.status = 'changed'; throw new Error('the compose files changed after the plan was made — review it again'); }
        r = { files: a.location.files, cwd: a.location.cwd, remote: a.location.remote, server: a.location.serverId ? require('./db').stmts.getServer.get(a.location.serverId) : null };
        const images = {};
        for (const s of a.services) if (s.image && !(a.cfg.services[s.name] || {}).image) images[s.name] = s.image;
        const stack = adapt(a.cfg, plan.settings || {}, { nodes: ctx.nodes, hostname: ctx.hostname, encrypt: ctx.encrypt, images });
        sk('check', 'done');
        deployId = q.addDeploy.run(sid, p, 'move', a.hash, JSON.stringify(stack), sourceIp || null, Date.now()).lastInsertRowid;
        sk('down', 'running', 'docker compose down (volumes stay)');
        downAt = Date.now();
        await helpers().runResolved(r, p, ['down'], (c) => String(c).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
        sk('down', 'done');
        sk('deploy', 'running', 'docker stack deploy');
        await stackDeploy(p, stack, log);
        deployed = true;
        sk('deploy', 'done');
        sk('verify', 'running', 'check every service runs');
        const readyAt = await verify(p, log, { since: downAt });
        sk('verify', 'done');
        res.status = 'moved'; res.downtimeMs = readyAt - downAt;
        q.put.run({ server_id: sid, name: p, origin: 'compose', location: JSON.stringify({ files: r.files, cwd: r.cwd, remote: r.remote, serverId: a.location.serverId }), settings: JSON.stringify(plan.settings || {}), now: Date.now() });
        q.endDeploy.run('done', null, res.downtimeMs, Date.now(), deployId);
        log(`✓ ${p} runs on Swarm (down for about ${Math.round(res.downtimeMs / 1000)}s)`);
        logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: p, action: 'swarm_move_to_swarm', details: { services: Object.keys(stack.services), downtimeMs: res.downtimeMs } });
      } catch (e) {
        res.error = e.message;
        log(`✗ ${p}: ${e.message}`);
        job.steps.filter(s => s.id.startsWith(`${p}:`) && s.status === 'running').forEach(s => { s.status = 'failed'; });
        if (downAt && r) {
          sk('back', 'running', 'put it back in Compose');
          try {
            if (deployed) await stackRemove(p, log);
            else await stackRemove(p, log).catch(() => {});
            await helpers().runResolved(r, p, ['up', '-d'], (c) => String(c).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
            res.status = 'rolled_back';
            sk('back', 'done');
            log(`↩ ${p} runs in Compose again`);
          } catch (u) {
            sk('back', 'failed');
            res.status = 'failed'; res.error += `; putting it back failed: ${u.message}`;
            log(`✗ putting ${p} back failed: ${u.message} — run docker compose up -d in its folder`);
          }
        } else if (res.status !== 'changed') res.status = 'skipped';
        if (deployId) q.endDeploy.run(res.status === 'rolled_back' ? 'rolled_back' : 'failed', res.error, downAt ? Date.now() - downAt : null, Date.now(), deployId);
        logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: p, action: 'swarm_move_failed', details: { status: res.status, error: res.error } });
      }
      if (deployId) q.trim.run(sid, p, sid, p);
    }
    const moved = job.result.projects.filter(x => x.status === 'moved').length;
    log(`\n${moved} of ${plans.length} project${plans.length > 1 ? 's' : ''} moved.`);
    finish(job, moved === plans.length ? null : new Error(`${plans.length - moved} project${plans.length - moved > 1 ? 's were' : ' was'} not moved — see the report`));
  })();
  return job;
}

/** Redeploy a stack from its compose files (kind 'redeploy') or a stored earlier deploy (kind 'previous', deployId). */
async function startRedeploy(name, { deployId = null, settings = null, sourceIp } = {}) {
  const sid = serverId();
  const row = q.get.get(sid, name);
  if (!row) throw bad(404, 'DockGate does not manage this stack');
  const ctx = await context();
  let stack, hash = null;
  if (deployId) {
    const d = q.deployRow.get(Number(deployId), sid);
    if (!d || d.name !== name || !d.stack) throw bad(404, 'That deploy has no stored stack file');
    stack = JSON.parse(d.stack); hash = d.hash;
  }
  const { job, log, step } = newJob('redeploy');
  (async () => {
    let id = null;
    try {
      if (!stack) {
        step(job, 'read', 'running', 'Read the compose files');
        const loc = JSON.parse(row.location || 'null');
        if (!loc) throw new Error('The location of the compose files is not known');
        const r = { files: loc.files, cwd: loc.cwd, remote: loc.remote, server: loc.serverId ? require('./db').stmts.getServer.get(loc.serverId) : null };
        const cfg = await readConfig(r, name);
        hash = hashOf(cfg);
        const set = settings || JSON.parse(row.settings || '{}');
        stack = adapt(cfg, set, { nodes: ctx.nodes, hostname: ctx.hostname, encrypt: ctx.encrypt, images: imagesForBuilt(cfg, name, ctx) });
        if (settings) q.put.run({ server_id: sid, name, origin: row.origin, location: row.location, settings: JSON.stringify(settings), now: Date.now() });
        step(job, 'read', 'done');
      }
      id = q.addDeploy.run(sid, name, deployId ? 'previous' : 'redeploy', hash, JSON.stringify(stack), sourceIp || null, Date.now()).lastInsertRowid;
      step(job, 'deploy', 'running', 'docker stack deploy');
      const t = Date.now();
      await stackDeploy(name, stack, log);
      step(job, 'deploy', 'done');
      step(job, 'verify', 'running', 'Check every service runs');
      await verify(name, log, { since: t });
      step(job, 'verify', 'done');
      q.endDeploy.run('done', null, null, Date.now(), id);
      logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: deployId ? 'swarm_stack_previous' : 'swarm_stack_redeploy', details: { hash } });
      log('✓ Deployed. Services that changed were updated one task at a time; a failed one goes back by itself.');
      finish(job);
    } catch (e) {
      log('✗ ' + e.message);
      if (id) q.endDeploy.run('failed', e.message, null, Date.now(), id);
      finish(job, e);
    } finally { q.trim.run(sid, name, sid, name); }
  })();
  return job;
}
function imagesForBuilt(cfg, project, ctx) {
  const images = {};
  for (const [n, s] of Object.entries(cfg.services || {})) if (s.build && !s.image && ctx.localImages.has(`${project}-${n}`)) images[n] = `${project}-${n}`;
  return images;
}

/** Move a stack back to Compose: stack rm → wait for its network → compose up -d. */
async function startMoveBack(name, { sourceIp } = {}) {
  const sid = serverId();
  const row = q.get.get(sid, name);
  if (!row || !row.location) throw bad(404, 'DockGate does not know the compose files of this stack');
  const loc = JSON.parse(row.location);
  const { job, log, step } = newJob('move-back');
  (async () => {
    const id = q.addDeploy.run(sid, name, 'move-back', null, null, sourceIp || null, Date.now()).lastInsertRowid;
    const t = Date.now();
    try {
      const r = { files: loc.files, cwd: loc.cwd, remote: loc.remote, server: loc.serverId ? require('./db').stmts.getServer.get(loc.serverId) : null };
      step(job, 'read', 'running', 'Check the compose files are still there');
      await readConfig(r, name);
      step(job, 'read', 'done');
      step(job, 'rm', 'running', 'Remove the stack (volumes stay)');
      await stackRemove(name, log);
      step(job, 'rm', 'done');
      step(job, 'up', 'running', 'docker compose up -d');
      await helpers().runResolved(r, name, ['up', '-d'], (c) => String(c).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
      step(job, 'up', 'done');
      q.del.run(sid, name);
      q.endDeploy.run('done', null, Date.now() - t, Date.now(), id);
      logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: 'swarm_move_back', details: { downtimeMs: Date.now() - t } });
      log(`✓ ${name} runs in Compose again (down for about ${Math.round((Date.now() - t) / 1000)}s)`);
      finish(job);
    } catch (e) {
      log('✗ ' + e.message);
      q.endDeploy.run('failed', e.message, Date.now() - t, Date.now(), id);
      finish(job, e);
    }
  })();
  return job;
}

/** Remove a stack (services and networks; volumes, secrets and configs stay). */
async function removeStack(name, { sourceIp } = {}) {
  const sid = serverId();
  const logLines = [];
  await stackRemove(name, (l) => logLines.push(l));
  q.del.run(sid, name);
  logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: 'swarm_stack_remove', details: {} });
  return { ok: true, log: logLines };
}

/** Plan for the Review step: per project, what the adapted stack file looks like. */
async function preview(project, settings) {
  const ctx = await context();
  const row = q.get.get(serverId(), project);
  const a = await analyze(project, { nodes: ctx.nodes, localImages: ctx.localImages, location: row ? JSON.parse(row.location || 'null') : null });
  if (row && !settings) settings = JSON.parse(row.settings || '{}');
  if (a.status === 'impossible') return { ...a, cfg: undefined, stack: null };
  const images = {};
  for (const s of a.services) if (s.image && !(a.cfg.services[s.name] || {}).image) images[s.name] = s.image;
  const stack = adapt(a.cfg, settings || {}, { nodes: ctx.nodes, hostname: ctx.hostname, encrypt: ctx.encrypt, images });
  const { cfg, ...rest } = a;
  return { ...rest, stack, settings: settings || {} };
}

module.exports = { isOnSwarm, stackRows, analyze, adapt, restartPolicy, candidates, list, history, preview, startMove, startRedeploy, startMoveBack, removeStack, _clean: clean };
