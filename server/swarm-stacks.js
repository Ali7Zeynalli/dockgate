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
// yaml: the stack file kept in DockGate (origin yaml / container); env: KEY=VALUE lines for ${VAR}, encrypted;
// from_container: JSON { name, id, restart } of the container a stack replaced (origin container).
for (const col of ['yaml TEXT', 'env TEXT', 'from_container TEXT']) { try { db.exec(`ALTER TABLE swarm_stacks ADD COLUMN ${col}`); } catch (e) { /* already there */ } }
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
// A Compose network several projects share (declared external) is a local bridge; a stack can only join an
// overlay. DockGate gives it an attachable overlay twin: moved services join the twin, and the containers still
// in Compose on the bridge are connected to it too (the keeper reconnects any that Compose re-creates).
db.exec(`CREATE TABLE IF NOT EXISTS swarm_bridges (
  server_id TEXT NOT NULL, bridge TEXT NOT NULL, overlay TEXT NOT NULL, created_at INTEGER,
  PRIMARY KEY (server_id, bridge)
)`);
const qb = {
  all: db.prepare('SELECT * FROM swarm_bridges WHERE server_id = ?'),
  put: db.prepare('INSERT OR IGNORE INTO swarm_bridges (server_id, bridge, overlay, created_at) VALUES (?, ?, ?, ?)'),
};
const twinName = (bridge) => `${bridge}-swarm`.slice(0, 63);
/** bridge → overlay twin already made on this server. */
function twinsMap(sid = serverId()) { return Object.fromEntries(qb.all.all(sid).map(r => [r.bridge, r.overlay])); }

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

/** { project, services } when the stack row is part of a compose project moved to Swarm (the rest stays in Compose). */
function partialOf(row) { try { const st = JSON.parse(row.settings || '{}'); return st.partial && st.partial.project ? st.partial : null; } catch (e) { return null; } }
/** The stack row that holds (all or part of) this compose project, or null. */
function stackOfProject(project, sid = serverId()) {
  const direct = q.get.get(sid, project);
  if (direct && direct.origin === 'compose') return direct;
  return q.all.all(sid).find(r => r.origin === 'compose' && (partialOf(r) || {}).project === project) || null;
}
/** Is this compose project (or a part of it) running as a stack on the server in use? (Compose Up is blocked then.) */
function isOnSwarm(project, sid = serverId()) { return !!stackOfProject(project, sid); }
function stackRows(sid = serverId()) { return q.all.all(sid); }

// ---- reading a compose project ----

const DB_IMAGE = /(^|\/)(postgres|postgis|mysql|mariadb|mongo|mongodb|redis|valkey|keydb|elasticsearch|opensearch|cassandra|clickhouse|influxdb|timescaledb|couchdb|neo4j|rabbitmq|minio|etcd|zookeeper)(:|@|$)/i;
const isDatabase = (image) => DB_IMAGE.test(String(image || '').replace(/^docker\.io\//, '').replace(/^library\//, ''));
// Fields Swarm has no place for (each one is named in the plan, never dropped silently).
const IGNORED_BY_SWARM = ['security_opt', 'cgroup_parent', 'pid', 'ipc', 'userns_mode', 'external_links', 'mac_address', 'oom_score_adj', 'oom_kill_disable', 'cpuset', 'cpu_shares', 'memswap_limit', 'storage_opt', 'device_cgroup_rules', 'domainname', 'cpu_rt_runtime', 'cpu_rt_period', 'blkio_config', 'mem_swappiness'];
// Fields DockGate turns into their Swarm form (see swarmShape).
const CONVERTED = ['mem_limit', 'mem_reservation', 'cpus', 'cpu_quota', 'cpu_period', 'pids_limit', 'shm_size', 'links', 'volumes_from'];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;
const HOST_NET = 'host_net'; // the stack's name for Docker's predefined "host" network
const bytesOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
const mbText = (b) => `${Math.round(b / 1048576)} MB`;
/** Memory for a stack file: whole MiB when it is one, else bytes. */
const memSpec = (b) => (b % 1048576 === 0 ? `${b / 1048576}M` : `${b}b`);

/**
 * What the compose fields Swarm does not take become (resources, /dev/shm, names, shared mounts).
 * Pure: used by analyze (to tell) and adapt (to do). Returns { limits, reservations, shm, notes }.
 */
function resourcesOf(s) {
  const limits = {}, reservations = {}, notes = [];
  const mem = bytesOf(s.mem_limit), memRes = bytesOf(s.mem_reservation);
  if (mem) { limits.memory = memSpec(mem); notes.push(`mem_limit ${mbText(mem)} → memory limit`); }
  if (memRes) { reservations.memory = memSpec(memRes); notes.push(`mem_reservation ${mbText(memRes)} → memory reservation`); }
  let cpus = Number(s.cpus);
  if (!(cpus > 0) && Number(s.cpu_quota) > 0) { cpus = Number(s.cpu_quota) / (Number(s.cpu_period) || 100000); notes.push(`cpu_quota ${s.cpu_quota} / cpu_period ${s.cpu_period || 100000} → ${Math.round(cpus * 100) / 100} CPU limit`); }
  else if (cpus > 0) notes.push(`cpus ${cpus} → CPU limit`);
  if (cpus > 0) limits.cpus = String(Math.round(cpus * 1000) / 1000);
  if (Number(s.pids_limit) > 0) { limits.pids = Number(s.pids_limit); notes.push(`pids_limit ${s.pids_limit} → pids limit`); }
  const shm = bytesOf(s.shm_size);
  if (shm) notes.push(`shm_size ${mbText(shm)} → a ${mbText(shm)} tmpfs at /dev/shm`);
  return { limits, reservations, shm, notes };
}
/** Extra names each service answers to: its old container_name and the aliases other services gave it with links. */
function aliasesOf(cfg) {
  const out = {};
  const add = (svc, name) => { if (!svc || !name || name === svc || !(cfg.services || {})[svc]) return; (out[svc] = out[svc] || new Set()).add(name); };
  for (const [name, s] of Object.entries(cfg.services || {})) {
    if (s.container_name) add(name, s.container_name);
    for (const l of s.links || []) { const [svc, alias] = String(l).split(':'); add(svc, alias || svc); }
  }
  return out;
}
/** Is a port only for this server (loopback) or tied to one address of it? */
const portScope = (p) => (!p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::' ? 'any' : LOOPBACK.test(p.host_ip) ? 'local' : 'address');

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
async function analyze(project, { nodes = 1, localImages = null, location = null, settings = null, privilegesOk = false } = {}) {
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
  // External networks that are local bridges (shared with other Compose projects): they get an overlay twin.
  out.bridges = [];
  for (const [k, v] of Object.entries(cfg.networks || {})) {
    if (!v || !v.external) continue;
    const name = v.name || k;
    const n = await netByName(name).catch(() => null);
    if (!n || n.Scope !== 'local' || ['host', 'none'].includes(n.Name) || n.Driver !== 'bridge') continue;
    let users = [];
    try {
      const info = await dockerService.docker.getNetwork(n.Id).inspect();
      for (const id of Object.keys(info.Containers || {})) {
        const ct = await dockerService.docker.getContainer(id).inspect().catch(() => null);
        const pr = ct && ct.Config.Labels && ct.Config.Labels['com.docker.compose.project'];
        if (pr && pr !== project) users.push(pr);
      }
    } catch (e) { /* listing who uses it is only for the plan */ }
    users = [...new Set(users)];
    out.bridges.push({ key: k, name, twin: twinName(name), users });
  }
  const block = (m) => { out.status = 'impossible'; out.reasons.push(m); };
  // What each service will look like on Swarm, to compare its protection with what it has in Compose.
  const SEC = require('./swarm-security');
  let onSwarm = { services: {} };
  try { onSwarm = adapt(cfg, settings || {}, { nodes }); } catch (e) { /* the plan shows the other findings */ }
  const readFile = r.remote && r.server ? async (f) => { const rc = require('./remote-compose'); const x = await rc.execRemote(r.server, `cat ${rc.shq(f)}`); if (x.code !== 0) throw new Error('not readable'); return x.stdout; } : null;
  out.privileges = {}; // server side only: what DockGate sets on each Swarm service
  out.security = {};   // server side only: the predicted comparison (rows)
  for (const [name, s] of Object.entries(cfg.services || {})) {
    const f = []; // findings: { level: info|warn|bad, text }
    const add = (level, text) => f.push({ level, text });
    if (s.privileged) add('bad', 'privileged: Swarm services can not be privileged — it stays in Compose. Often only some rights are needed: give them with cap_add (e.g. NET_ADMIN) and it can move');
    if (s.devices && s.devices.length) add('bad', 'devices: Swarm services can not use host devices — it stays in Compose (a GPU can use Swarm generic resources instead)');
    if (s.network_mode === 'host') add('warn', 'network_mode: host → the service joins Docker\'s host network on Swarm (same as before); it can have no other network and no published ports');
    else if (s.network_mode && s.network_mode !== 'bridge') add('bad', `network_mode: ${s.network_mode} shares another container's network — Swarm has no such mode, so it stays in Compose`);
    let image = s.image || null;
    const push = settings && settings.build && settings.build.registryId ? (() => { try { return require('./swarm-build').registryById(settings.build.registryId); } catch (e) { return null; } })() : null;
    if (s.build && push) {
      const ref = require('./swarm-build').repoFor(push, project, name);
      image = `${ref}:<time>`;
      add('info', `build: built with Compose and pushed to ${push.name || push.server_address} as ${ref}:<time> on every move and Redeploy — every server pulls it from there`);
    } else if (s.build) {
      const built = `${project}-${name}`;
      if (!image) {
        if (nodes > 1) add('bad', 'build: without image — on several servers the image must be in a registry: choose one under "Build & push" in the plan (Deploy → Registries holds the logins)');
        else if (localImages && localImages.has(built)) { image = built; add('warn', `build: the image built by Compose (${built}) is used; Swarm does not build`); }
        else add('bad', `build: without image and no built image ${built} here — build it first (Compose → Build)`);
      } else add('warn', `build: Swarm does not build — the image ${image} is used${nodes > 1 ? ' (it must be in a registry for the other servers — or choose one under "Build & push" in the plan)' : ''}`);
    }
    if (s.container_name && s.container_name !== name) add('info', `container_name ${s.container_name}: Swarm names tasks ${project}_${name}.1 …, but ${s.container_name} stays a name other services reach it by`);
    for (const l of s.links || []) { const [svc, alias] = String(l).split(':'); if (alias && alias !== svc) add('info', `links ${l}: ${svc} also answers as ${alias}`); }
    for (const vf of s.volumes_from || []) {
      const src = String(vf).split(':')[0];
      if (/^container:/.test(String(vf))) add('warn', `volumes_from ${vf}: a container outside the project — not possible on Swarm, mount its volumes by name instead`);
      else add('info', `volumes_from ${src}: the volumes of ${src} are mounted here too, and both stay on this server`);
    }
    for (const [net, v] of Object.entries(s.networks || {})) {
      const ip = v && (v.ipv4_address || v.ipv6_address);
      if (!ip) continue;
      const users = Object.entries(cfg.services || {}).filter(([n2, s2]) => n2 !== name && JSON.stringify(s2.environment || {}).includes(ip)).map(([n2]) => n2);
      add('warn', `fixed address ${ip} on ${net}: Swarm gives addresses itself, so it is dropped — reach it by name (${name})${users.length ? `. ${users.join(', ')} use${users.length === 1 ? 's' : ''} ${ip} in environment: change it to ${name}` : ''}`);
    }
    const res = resourcesOf(s);
    for (const n of res.notes) add('info', n);
    if (s.depends_on && Object.keys(s.depends_on).length) {
      const healthy = Object.entries(s.depends_on).filter(([, d]) => d && d.condition === 'service_healthy').map(([k]) => k);
      add('info', `depends_on ${Object.keys(s.depends_on).join(', ')}: on the move DockGate starts it after ${Object.keys(s.depends_on).length === 1 ? 'that service runs' : 'those run'}${healthy.length ? ` (${healthy.join(', ')} healthy)` : ''}. Later, when a task restarts, Swarm does not wait — the app should retry its connections`);
    }
    if (s.restart) add('info', `restart: ${s.restart} → restart policy ${restartPolicy(s.restart).condition}`);
    for (const p of s.ports || []) {
      const sc = portScope(p);
      if (sc === 'local') add('warn', `port ${p.host_ip}:${p.published}: only this server could reach it. On Swarm it is not published — other services reach it inside as ${name}:${p.target}. If something on the server itself needs it, choose "this server only"`);
      else if (sc === 'address') add('warn', `port ${p.host_ip}:${p.published}: tied to one address. Swarm can not bind an address, so it is published on this server only (host mode) — allow it only from that network in the firewall`);
    }
    if (isDatabase(image)) add('warn', 'database: stays at 1 replica');
    const ignored = IGNORED_BY_SWARM.filter(k => k !== 'security_opt' && s[k] !== undefined && s[k] !== null && !(Array.isArray(s[k]) && !s[k].length));
    if (ignored.length) add('warn', `Swarm has no place for ${ignored.join(', ')} — ${ignored.length === 1 ? 'it is' : 'they are'} left out`);
    const binds = (s.volumes || []).filter(v => v.type === 'bind');
    const vols = (s.volumes || []).filter(v => v.type === 'volume');
    if (nodes > 1 && (binds.length || vols.length)) add('info', 'has data on this server: it is kept on this server (placement rule)');
    for (const sec of [...(s.secrets || []), ...(s.configs || [])]) { const top = (cfg.secrets || {})[sec.source] || (cfg.configs || {})[sec.source]; if (top && top.file && r.remote) add('bad', `secret/config ${sec.source} from a file: not possible for a project on a remote server yet`); }
    if (s.environment && Object.keys(s.environment).length) add('info', `environment (${Object.keys(s.environment).length}) taken from the files and .env`);
    const secretish = Object.keys(s.environment || {}).filter(k => /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)$/i.test(k) && !/_FILE$/i.test(k));
    if (secretish.length) add('info', `${secretish.join(', ')} look${secretish.length === 1 ? 's' : ''} like a password in plain environment. If the image reads ${secretish[0]}_FILE (postgres, mysql and many others do), it can become a Swarm secret later (Secrets & configs) — DockGate does not change it by itself.`);
    // Protection: the same on Swarm, or weaker? Weaker keeps the service in Compose unless "move anyway" was chosen.
    const otherBad = f.some(x => x.level === 'bad');
    let secRows = [], weaker = [];
    if (!otherBad && onSwarm.services[name]) {
      const kept = privilegesOk ? await SEC.privilegesFor(s, { cwd: r.cwd, readFile }) : { privileges: null, kept: [], lost: [] };
      if (!privilegesOk && (s.security_opt || []).length) add('warn', 'security_opt: this Docker is older than 25 (API 1.44), so DockGate can not put it back on the Swarm service');
      if (kept.privileges) out.privileges[name] = kept.privileges;
      if (kept.kept.length) add('info', `kept on Swarm: ${kept.kept.join(', ')} — stack files drop security_opt, so DockGate sets ${kept.kept.length === 1 ? 'it' : 'them'} on the Swarm service itself`);
      secRows = SEC.compareProfiles(SEC.profileOfService(s), SEC.predictOnSwarm(onSwarm.services[name], kept));
      weaker = SEC.weakerRows(secRows);
      out.security[name] = secRows;
      const anyway = !!(settings && settings.services && settings.services[name] && settings.services[name].moveAnyway);
      for (const w of weaker) add(anyway ? 'warn' : 'bad', `less protected on Swarm — ${w.field}: ${w.before} → ${w.after}${w.why ? ` (${w.why})` : ''}${anyway ? ' — moving anyway, as chosen' : ' — it stays in Compose unless you choose "Move anyway"'}`);
      for (const c of secRows.filter(x => x.verdict === 'changed')) add('info', `${c.field}: ${c.before} → ${c.after}${c.why ? ` (${c.why})` : ''}`);
    }
    const stays = f.some(x => x.level === 'bad'); // this service can not run on Swarm: it stays in Compose
    if (!stays && out.status === 'ready' && f.some(x => x.level === 'warn')) out.status = 'attention';
    out.services.push({ name, image, database: isDatabase(image), findings: f, ports: (s.ports || []).map(p => ({ published: Number(p.published) || null, target: p.target, protocol: p.protocol || 'tcp', hostIp: p.host_ip || null, scope: portScope(p) })), hostNetwork: s.network_mode === 'host', healthcheck: !!(s.healthcheck && !s.healthcheck.disable), volumes: vols.map(v => v.source), binds: binds.map(v => v.source), build: !!s.build, stays, security: secRows.filter(x => x.verdict !== 'same'), weaker: weaker.length > 0, securityOnly: !otherBad && weaker.length > 0 });
  }
  if (!out.services.length) block('The project has no services.');
  if (out.bridges.length && out.status === 'ready') out.status = 'attention';
  out.stays = out.services.filter(x => x.stays).map(x => x.name);
  if (out.status !== 'impossible' && out.stays.length) {
    // Only "less protected" keeps them all: still plannable, so "Move anyway" can be chosen per service.
    if (out.stays.length === out.services.length && !out.services.every(x => x.securityOnly)) { out.status = 'impossible'; out.reasons.push('No service of this project can run on Swarm.'); }
    else out.status = 'partial'; // the others move; these stay in Compose and are connected to the stack network
  }
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
  const only = ctx.only ? new Set(ctx.only) : null; // part of a project: only these services
  const aliases = aliasesOf(cfg);
  let usesHostNet = false;
  for (const [name, s0] of Object.entries(cfg.services || {})) {
    if (only && !only.has(name)) continue;
    const s = JSON.parse(JSON.stringify(s0));
    const my = set[name] || {};
    const res = resourcesOf(s0);
    // volumes_from: the other service's volumes and folders, mounted here too
    for (const vf of s0.volumes_from || []) {
      const [src, mode] = String(vf).split(':');
      const from = (cfg.services || {})[src];
      if (!from || /^container$/.test(src)) continue;
      const have = new Set((s.volumes || []).map(v => v.target));
      for (const v of from.volumes || []) if ((v.type === 'volume' || v.type === 'bind') && !have.has(v.target)) (s.volumes = s.volumes || []).push(mode === 'ro' ? { ...v, read_only: true } : { ...v });
    }
    for (const k of ['container_name', 'build', 'profiles', 'pull_policy', 'restart', 'scale', ...CONVERTED]) delete s[k];
    for (const k of IGNORED_BY_SWARM) delete s[k];
    // /dev/shm: Swarm has no shm_size; a tmpfs of that size does the same
    if (res.shm && !(s.volumes || []).some(v => v.target === '/dev/shm')) (s.volumes = s.volumes || []).push({ type: 'tmpfs', target: '/dev/shm', tmpfs: { size: res.shm } });
    // network_mode: host → Docker's predefined host network (no other network, no published ports)
    if (s0.network_mode === 'host') { delete s.network_mode; s.networks = { [HOST_NET]: {} }; delete s.ports; usesHostNet = true; }
    else if (s.network_mode === 'bridge') delete s.network_mode;
    // fixed addresses are Swarm's to give; old container names and link aliases stay reachable as aliases
    if (s.networks && !Array.isArray(s.networks) && !s.networks[HOST_NET]) {
      for (const k of Object.keys(s.networks)) {
        const v = s.networks[k] = { ...(s.networks[k] || {}) };
        delete v.ipv4_address; delete v.ipv6_address; delete v.link_local_ips;
        if (aliases[name]) v.aliases = [...new Set([...(v.aliases || []), ...aliases[name]])];
      }
    }
    if (ctx.images && ctx.images[name]) s.image = ctx.images[name];
    if (s.depends_on && !Array.isArray(s.depends_on)) s.depends_on = Object.keys(s.depends_on);
    if (only && s.depends_on) { s.depends_on = s.depends_on.filter(x => only.has(x)); if (!s.depends_on.length) delete s.depends_on; }
    if (s.networks && !Array.isArray(s.networks)) for (const k of Object.keys(s.networks)) if (s.networks[k] === null) s.networks[k] = {};
    // Ports: a loopback port stays inside unless "this server only" was chosen; one tied to an address is host mode.
    let hostPorts = my.portMode === 'host';
    if (s.ports) {
      s.ports = s.ports.filter(p => portScope(p) !== 'local' || my.localPorts === 'host').map(p => {
        const sc = portScope(p);
        const host = hostPorts || sc !== 'any';
        if (host) hostPorts = true;
        return clean({ target: Number(p.target), published: p.published !== undefined && p.published !== '' ? Number(p.published) : undefined, protocol: p.protocol || 'tcp', mode: host ? 'host' : 'ingress' });
      });
      if (!s.ports.length) delete s.ports;
    }
    const d = s.deploy || {};
    if (Object.keys(res.limits).length || Object.keys(res.reservations).length) {
      const r = d.resources = d.resources || {};
      if (Object.keys(res.limits).length) r.limits = { ...res.limits, ...(r.limits || {}) }; // what deploy: already says wins
      if (Object.keys(res.reservations).length) r.reservations = { ...res.reservations, ...(r.reservations || {}) };
    }
    const db = isDatabase(s.image);
    const want = [my.replicas, d.replicas, 1].map(v => (v === '' || v === null || v === undefined ? NaN : Number(v))).find(v => Number.isInteger(v) && v >= 0 && v <= 100);
    if (!d.mode || d.mode === 'replicated') d.replicas = db ? 1 : (want ?? 1);
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
  if (usesHostNet) out.networks[HOST_NET] = { external: true, name: 'host' };
  for (const [k, n0] of Object.entries(cfg.networks || {})) {
    if (usesHostNet && k === HOST_NET) continue;
    const n = { ...(n0 || {}) };
    if (n.external) {
      const twin = ctx.twins && ctx.twins[n.name || k];
      out.networks[k] = twin ? { external: true, name: twin } : clean(n); // a shared Compose bridge → its overlay twin
      continue;
    }
    delete n.ipam; if (n.driver === 'bridge' || !n.driver) n.driver = 'overlay';
    if (ctx.project) delete n.name; // part of a project: the Compose network keeps its name; the stack makes its own
    n.attachable = true;
    if (ctx.encrypt && n.driver === 'overlay') n.driver_opts = { ...(n.driver_opts || {}), encrypted: '' };
    out.networks[k] = clean(n);
  }
  for (const [k, v] of Object.entries(cfg.volumes || {})) {
    // Part of a project: the stack has another name, so its volumes are named by their Compose name (the data stays).
    if (ctx.project && !(v && v.external)) out.volumes[k] = { external: true, name: (v && v.name) || `${ctx.project}_${k}` };
    else out.volumes[k] = clean(v || {});
  }
  for (const [k, v] of Object.entries(cfg.secrets || {})) out.secrets[k] = clean(v || {});
  for (const [k, v] of Object.entries(cfg.configs || {})) out.configs[k] = clean(v || {});
  for (const k of ['networks', 'volumes', 'secrets', 'configs']) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}

// ---- running Swarm commands ----

/** docker stack deploy with the stack file on stdin, against the server in use. stack: object or YAML text;
 * vars: { KEY: value } for ${KEY} in the file. */
/** The server in use when it is a remote SSH host (stack commands then run on it over the SSH session). */
function remoteServer() {
  const sid = serverId();
  if (sid === 'local') return null;
  const row = require('./db').stmts.getServer.get(sid);
  return row && row.type !== 'local' && row.host ? row : null;
}
async function stackDeploy(name, stack, log, vars = null) {
  const text = typeof stack === 'string' ? stack : JSON.stringify(stack);
  const remote = remoteServer();
  if (remote) {
    // On the server itself over the SSH session: works with a password or a key with passphrase too.
    log(`$ docker stack deploy -c <stack file> --prune --with-registry-auth --detach=true ${name}   (on ${remote.name || remote.host})`);
    let buf = '';
    const r = await require('./remote-compose').runDockerRemote(remote, ['stack', 'deploy', '-c', '@stack.yml', '--prune', '--with-registry-auth', '--detach=true', name],
      { files: { 'stack.yml': text }, vars, registryJson: require('./remote-cli-env').registryConfigJson() },
      (t) => { buf += t; const lines = buf.split('\n'); buf = lines.pop(); lines.filter(Boolean).forEach(l => log('  ' + l)); });
    if (buf.trim()) log('  ' + buf.trim());
    if (r.code !== 0) throw new Error(`docker stack deploy exited with code ${r.code}${require('./remote-compose').composeReason(r.out)}`);
    return r.out;
  }
  return new Promise((resolve, reject) => {
    const { env: base } = buildCliEnv(serverId(), 'stack');
    const env = vars ? { ...base, ...vars } : base;
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
    child.stdin.end(text);
  });
}

const stackFilter = (name) => JSON.stringify({ label: [`com.docker.stack.namespace=${name}`] });

/** Remove a stack's services and networks (secrets, configs and volumes stay), then wait until its networks are gone. */
async function stackRemove(name, log) {
  const c = dockerService.docker;
  let services;
  try { services = await c.listServices({ filters: stackFilter(name) }); }
  catch (e) {
    // The swarm itself is gone (left outside DockGate): so is the stack — nothing to remove.
    if (e.statusCode === 503 || /not part of a swarm|not a swarm manager/i.test(swarm.dockerMsg(e) || '')) { log('  the server is not in a swarm any more — the stack is already gone'); return; }
    throw e;
  }
  for (const s of services) { await c.getService(s.ID).remove().catch(() => {}); log(`  removed service ${s.Spec.Name}`); }
  for (let i = 0; i < 60; i++) {
    const nets = await c.listNetworks({ filters: stackFilter(name) });
    if (!nets.length) { if (i) log(`  stack network gone after ${i * 2}s`); return; }
    if (i === 0) for (const n of nets) { // Compose containers DockGate connected to it (part of a project)
      const info = await c.getNetwork(n.Id).inspect().catch(() => null);
      for (const [cid, ct] of Object.entries((info && info.Containers) || {})) if (!/^lb-|\.\d+\.[a-z0-9]{25}$/.test(ct.Name || '')) await c.getNetwork(n.Id).disconnect({ Container: cid, Force: true }).then(() => log(`  disconnected ${ct.Name} from ${n.Name}`)).catch(() => {});
    }
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

/**
 * depends_on as start levels, e.g. [["db"], ["api"], ["web"]] (a service starts after everything it depends on).
 * null when nothing depends on anything, or the dependencies loop.
 */
function startLevels(stack) {
  const svcs = Object.keys(stack.services || {});
  const deps = Object.fromEntries(svcs.map(n => [n, (stack.services[n].depends_on || []).filter(d => svcs.includes(d) && d !== n)]));
  if (!svcs.some(n => deps[n].length)) return null;
  const levels = [], placed = new Set();
  while (placed.size < svcs.length) {
    const next = svcs.filter(n => !placed.has(n) && deps[n].every(d => placed.has(d)));
    if (!next.length) return null; // a loop: start them all at once, as Swarm does
    levels.push(next); next.forEach(n => placed.add(n));
  }
  return levels;
}
/** Wait until these services of a stack run all their tasks (a task with a health check counts once healthy). */
async function waitServices(name, names, log, { since = Date.now(), timeoutMs = 180000 } = {}) {
  const c = dockerService.docker;
  const want = new Set(names.map(n => `${name}_${n}`));
  const t0 = Date.now();
  for (;;) {
    const services = (await c.listServices({ filters: stackFilter(name), status: true })).filter(s => want.has(s.Spec.Name));
    const tasks = await c.listTasks({ filters: stackFilter(name) });
    const ids = new Set(services.map(s => s.ID));
    const failed = tasks.find(t => ids.has(t.ServiceID) && ['failed', 'rejected'].includes(t.Status.State) && new Date(t.CreatedAt).getTime() >= since - 2000);
    if (failed) throw new Error(`${(services.find(s => s.ID === failed.ServiceID) || { Spec: { Name: '?' } }).Spec.Name} failed while starting: ${failed.Status.Err || failed.Status.State}`);
    const notReady = services.filter(s => s.ServiceStatus && s.ServiceStatus.RunningTasks < s.ServiceStatus.DesiredTasks);
    if (services.length === want.size && !notReady.length) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`not running (healthy) in time: ${notReady.map(s => s.Spec.Name).join(', ') || [...want].join(', ')} — what depends on it can not start`);
    await sleep(2000);
  }
}
/**
 * First deploy in the order of depends_on (Swarm starts every service at once): the services that depend on
 * others start with 0 replicas, then each level is raised once the one before runs (healthy, if it has a check).
 * Only for a new stack — a redeploy keeps everything running.
 */
async function deployInOrder(name, stack, log, opts = {}) {
  const levels = startLevels(stack);
  if (!levels || levels.length < 2) return stackDeploy(name, stack, log);
  log(`Starting in the order of depends_on: ${levels.map(l => l.join(' + ')).join(' → ')}`);
  const staged = JSON.parse(JSON.stringify(stack));
  const held = new Set(levels.slice(1).flat().filter(n => (staged.services[n].deploy || {}).mode !== 'global'));
  for (const n of held) staged.services[n].deploy.replicas = 0;
  await stackDeploy(name, staged, log);
  // Raise each level by its replica count only: a second stack deploy would touch (and may restart) the rest.
  const c = dockerService.docker;
  for (let i = 1; i < levels.length; i++) {
    log(`Waiting for ${levels[i - 1].join(', ')} before ${levels[i].join(', ')}…`);
    await waitServices(name, levels[i - 1], log, opts);
    for (const n of levels[i]) {
      if (!held.has(n)) continue;
      const want = stack.services[n].deploy.replicas;
      const svc = await c.getService(`${name}_${n}`).inspect();
      const spec = { ...svc.Spec, Mode: { Replicated: { Replicas: want } } };
      await c.getService(svc.ID).update({ version: svc.Version.Index, ...spec });
      log(`  ${name}_${n} → ${want} replica${want === 1 ? '' : 's'}`);
    }
  }
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
  let privilegesOk = false; // Swarm services take no-new-privileges / seccomp / AppArmor from API 1.44 (Docker 25)
  try { const v = await c.version(); const [ma, mi] = String(v.ApiVersion || '0.0').split('.').map(Number); privilegesOk = ma > 1 || (ma === 1 && mi >= 44); } catch (e) { /* older */ }
  return { st, nodes, hostname: st.serverName, encrypt, localImages: images, privilegesOk };
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
    try { a = await analyze(p.name, { nodes: ctx.nodes, localImages: ctx.localImages, privilegesOk: ctx.privilegesOk }); } catch (e) { a = { project: p.name, status: 'impossible', reasons: [e.message], services: [] }; }
    delete a.cfg; delete a.privileges; delete a.security;
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
    return { ...x, managed: !!r, origin: r ? r.origin : 'outside', location: r ? JSON.parse(r.location || 'null') : null, hasFile: !!(r && r.yaml), fromContainer: r && r.from_container ? JSON.parse(r.from_container).name : null, partial: r ? partialOf(r) : null, last };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function history(name) { return q.history.all(serverId(), name); }

// ---- jobs ----

function newJob(kind, subject = null) {
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const job = swarm._jobs.newJob(kind, subject); swarm._jobs.setCurrent(job);
  return { job, log: swarm._jobs.logTo(job), step: swarm._jobs.step };
}
function finish(job, err) {
  if (err) { job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; }); job.status = 'error'; job.error = err.message; }
  else job.status = 'done';
  job.finishedAt = Date.now();
}

/**
 * Part of a project on Swarm: connect its Compose containers (the services that stay) to the stack's
 * networks, with their service name as alias, so both sides reach each other by name as before.
 */
async function connectStaying(project, stackName, stays, log) {
  const c = dockerService.docker;
  const nets = await c.listNetworks({ filters: stackFilter(stackName) });
  const cts = await c.listContainers({ all: false, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) });
  for (const ct of cts) {
    const svc = ct.Labels['com.docker.compose.service'];
    if (!stays.includes(svc)) continue;
    if (ct.HostConfig && ct.HostConfig.NetworkMode === 'host') { log(`  ${svc}: host network — it reaches the stack through published ports only`); continue; }
    for (const n of nets) {
      if (((ct.NetworkSettings || {}).Networks || {})[n.Name]) continue;
      try { await c.getNetwork(n.Id).connect({ Container: ct.Id, EndpointConfig: { Aliases: [svc] } }); log(`  ${svc} connected to ${n.Name}`); }
      catch (e) { log(`  ! ${svc} could not join ${n.Name}: ${swarm.dockerMsg(e)}`); }
    }
  }
}

/** A network by name on the server in use, or null. */
async function netByName(name) {
  const list = await dockerService.docker.listNetworks({ filters: JSON.stringify({ name: [name] }) });
  return list.find(n => n.Name === name) || null;
}
/** Make (or find) the overlay twin of a shared bridge. */
async function ensureTwin(bridge, encrypt, log) {
  const twin = twinName(bridge);
  const have = await netByName(twin);
  if (have && have.Driver !== 'overlay') throw new Error(`A network ${twin} already exists and is not an overlay — rename or remove it first`);
  if (!have) {
    await dockerService.docker.createNetwork({ Name: twin, Driver: 'overlay', Attachable: true, CheckDuplicate: true, ...(encrypt ? { Options: { encrypted: '' } } : {}), Labels: { 'dockgate.twin-of': bridge } });
    log(`  created overlay ${twin} — the Swarm twin of ${bridge}`);
  }
  qb.put.run(serverId(), bridge, twin, Date.now());
  return twin;
}
/** Connect the running containers on a bridge to its twin, by their Compose service and container names. */
async function connectToTwin(bridge, twin, log = () => {}, { except = null } = {}) {
  const c = dockerService.docker;
  const [b, t] = [await netByName(bridge), await netByName(twin)];
  if (!b || !t) return 0;
  const info = await c.getNetwork(b.Id).inspect();
  let n = 0;
  for (const id of Object.keys(info.Containers || {})) {
    let ct;
    try { ct = await c.getContainer(id).inspect(); } catch (e) { continue; }
    const L = (ct.Config && ct.Config.Labels) || {};
    if (!ct.State || !ct.State.Running || L['com.docker.swarm.task.id']) continue;
    if (except && L['com.docker.compose.project'] === except) continue;
    if ((ct.NetworkSettings.Networks || {})[twin]) continue;
    const name = ct.Name.replace(/^\//, '');
    const aliases = [...new Set([L['com.docker.compose.service'], name].filter(Boolean))];
    try { await c.getNetwork(t.Id).connect({ Container: ct.Id, EndpointConfig: { Aliases: aliases } }); n++; log(`  ${name} (still in Compose) connected to ${twin} as ${aliases.join(', ')}`); }
    catch (e) { log(`  ! ${name} could not join ${twin}: ${swarm.dockerMsg(e)}`); }
  }
  return n;
}
/** Every 30 s: containers Compose re-created on a shared bridge join its twin again. */
let keeper = null;
async function keepTwins() {
  try {
    const st = await swarm.status();
    if (st.state !== 'active' || !st.manager) return;
    for (const r of qb.all.all(serverId())) await connectToTwin(r.bridge, r.overlay).catch(() => {});
  } catch (e) { /* the server is not reachable now */ }
}
function startBridgeKeeper() { if (!keeper) { keeper = setInterval(keepTwins, 30000); if (keeper.unref) keeper.unref(); } }

/**
 * Move compose projects to Swarm, one at a time. plans: [{ project, hash, settings }].
 * A project that fails its check is put back in Compose; the others go on.
 */
// ---- protection before and after a move (server/swarm-security.js) ----
const NGINX = /(^|\/)(nginx|openresty)(:|@|$)/i;
/** { service: { profile, image, imageName, id } } of the running Compose containers of these services (first replica). */
async function snapshotCompose(project, services) {
  const SEC = require('./swarm-security'), out = {};
  for (const svc of services) {
    const list = await dockerService.docker.listContainers({ filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${svc}`] }) }).catch(() => []);
    if (!list.length) continue;
    const ct = await dockerService.docker.getContainer(list[0].Id).inspect().catch(() => null);
    if (ct) out[svc] = { profile: SEC.profileOfContainer(ct), image: ct.Image, imageName: ct.Config.Image, id: ct.Id };
  }
  return out;
}
/** The same for the running tasks of a stack on this server, keyed by the service name inside the stack. */
async function snapshotTasks(stackName) {
  const SEC = require('./swarm-security'), out = {}, c = dockerService.docker;
  for (const svc of await c.listServices({ filters: stackFilter(stackName) }).catch(() => [])) {
    const short = svc.Spec.Name.replace(new RegExp(`^${stackName}_`), '');
    const list = await c.listContainers({ filters: JSON.stringify({ label: [`com.docker.swarm.service.id=${svc.ID}`] }) }).catch(() => []);
    if (!list.length) continue;
    const ct = await c.getContainer(list[0].Id).inspect().catch(() => null);
    if (ct) out[short] = { profile: SEC.profileOfContainer(ct, SEC.portsOfServiceSpec(svc)), image: ct.Image, imageName: ct.Config.Image, id: ct.Id };
  }
  return out;
}
/** Put no-new-privileges / seccomp / AppArmor on the Swarm services (stack files can not say them). */
async function applyPrivileges(stackName, privileges, log) {
  for (const [svc, priv] of Object.entries(privileges || {})) {
    if (!priv) continue;
    const s = dockerService.docker.getService(`${stackName}_${svc}`);
    const info = await s.inspect().catch(() => null);
    if (!info) continue;
    const spec = info.Spec;
    const cs = spec.TaskTemplate.ContainerSpec = spec.TaskTemplate.ContainerSpec || {};
    cs.Privileges = { ...(cs.Privileges || {}), ...priv };
    await s.update({ version: info.Version.Index, ...spec });
    log(`  ${svc}: ${[priv.NoNewPrivileges ? 'no-new-privileges' : null, priv.Seccomp ? `seccomp ${priv.Seccomp.Mode}` : null, priv.AppArmor ? `AppArmor ${priv.AppArmor.Mode}` : null].filter(Boolean).join(', ')} set on the Swarm service`);
  }
}
/**
 * After a move: compare each running task with the Compose container it replaced. Weaker than the plan said (or
 * than allowed with "move anyway") fails the move, so it is put back; so does nginx -t failing in a task.
 */
async function securityCheck(stackName, snap, planned, log) {
  const SEC = require('./swarm-security');
  const now = await snapshotTasks(stackName);
  const failed = [], rows = {};
  for (const [svc, b] of Object.entries(snap)) {
    const a = now[svc];
    if (!a) { log(`  ${svc}: its task runs on another server — checked by plan only`); continue; }
    const cmp = SEC.compareProfiles(b.profile, a.profile);
    rows[svc] = cmp.filter(x => x.verdict !== 'same');
    const allowed = new Set(SEC.weakerRows((planned && planned[svc]) || []).map(x => x.field));
    const bad = SEC.weakerRows(cmp).filter(x => !allowed.has(x.field));
    for (const x of bad) failed.push(`${svc}: ${x.field} ${x.before} → ${x.after}`);
    if (b.image !== a.image) log(`  ${svc}: runs image ${String(a.image).slice(7, 19)} (${String(a.imageName).split('@')[0]}); it ran ${String(b.image).slice(7, 19)} in Compose — pulled again, or built and pushed`);
    if (NGINX.test(String(a.imageName).replace(/^docker\.io\//, '').replace(/^library\//, ''))) {
      const t = await execIn(a.id, ['nginx', '-t']).catch(e => ({ code: 1, out: e.message }));
      if (t.code !== 0) failed.push(`${svc}: nginx -t fails in the Swarm task (${t.out.split('\n').pop()})`);
      else log(`  ${svc}: nginx -t passes`);
    }
    if (!bad.length) log(`  ${svc}: protected as in Compose${SEC.weakerRows(cmp).length ? ' (apart from what you chose to accept)' : ''}`);
  }
  return { failed, rows };
}
async function execIn(id, cmd) {
  const ex = await dockerService.docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({ hijack: true, stdin: false });
  let out = '';
  await new Promise((res) => { stream.on('data', d => { out += d.toString('utf8').replace(/[\x00-\x08]/g, ''); }); stream.on('end', res); stream.on('close', res); setTimeout(res, 15000); });
  const info = await ex.inspect().catch(() => ({ ExitCode: -1 }));
  return { code: info.ExitCode, out: out.trim() };
}

async function startMove(plans, { sourceIp } = {}) {
  if (!Array.isArray(plans) || !plans.length) throw bad(400, 'Choose at least one project');
  if (plans.length > 20) throw bad(400, 'At most 20 projects at a time');
  const ctx = await context();
  const { job, log, step } = newJob('move', plans.map(p => p.project).join(', '));
  job.result = { projects: [] };
  const sid = serverId();
  (async () => {
    for (const plan of plans) {
      const p = String(plan.project || '');
      const res = { project: p, status: 'failed', error: null, downtimeMs: null };
      job.result.projects.push(res);
      const sk = (id, st, label) => step(job, `${p}:${id}`, st, label ? `${p}: ${label}` : undefined);
      let deployId = null, downAt = null, r = null, deployed = false, partial = null, stackName = p;
      try {
        log(`\n=== ${p} ===`);
        sk('check', 'running', 'read the compose files again');
        if (isOnSwarm(p, sid)) throw new Error('already runs on Swarm');
        const a = await analyze(p, { nodes: ctx.nodes, localImages: ctx.localImages, settings: plan.settings || {}, privilegesOk: ctx.privilegesOk });
        if (a.status === 'impossible') throw new Error(a.reasons.concat(a.services.flatMap(s => s.findings.filter(f => f.level === 'bad').map(f => `${s.name}: ${f.text}`))).join('; '));
        if (plan.hash && a.hash !== plan.hash) { res.status = 'changed'; throw new Error('the compose files changed after the plan was made — review it again'); }
        r = { files: a.location.files, cwd: a.location.cwd, remote: a.location.remote, server: a.location.serverId ? require('./db').stmts.getServer.get(a.location.serverId) : null };
        partial = a.status === 'partial' ? { project: p, services: a.services.filter(x => !x.stays).map(x => x.name), stays: a.stays } : null;
        if (partial && !partial.services.length) throw new Error('nothing moves — every service would be less protected on Swarm (choose "Move anyway" for the ones that may)');
        stackName = partial ? `${p}-swarm` : p;
        if (partial) {
          if (q.get.get(sid, stackName) || (await dockerService.docker.listServices({ filters: stackFilter(stackName) })).length) throw new Error(`a stack named ${stackName} already exists`);
          log(`Part of ${p} moves: ${partial.services.join(', ')} → stack ${stackName}. ${partial.stays.join(', ')} stay${partial.stays.length === 1 ? 's' : ''} in Compose and ${partial.stays.length === 1 ? 'is' : 'are'} connected to the stack network.`);
        }
        const images = {};
        for (const s of a.services) if (s.image && !(a.cfg.services[s.name] || {}).image) images[s.name] = s.image;
        const reg = plan.settings && plan.settings.build && plan.settings.build.registryId;
        if (reg && a.services.some(x => x.build && !x.stays)) { // build & push before anything stops
          sk('build', 'running', 'build and push the images');
          Object.assign(images, await require('./swarm-build').buildAll({ project: p, cfg: a.cfg, r, registryId: reg, only: a.services.filter(x => !x.stays).map(x => x.name), log }));
          sk('build', 'done');
        }
        const twins = { ...twinsMap(sid), ...Object.fromEntries((a.bridges || []).map(x => [x.name, x.twin])) };
        const stack = adapt(a.cfg, plan.settings || {}, { nodes: ctx.nodes, hostname: ctx.hostname, encrypt: ctx.encrypt, images, twins, only: partial ? partial.services : null, project: partial ? p : null });
        sk('check', 'done');
        deployId = q.addDeploy.run(sid, stackName, 'move', a.hash, JSON.stringify(stack), sourceIp || null, Date.now()).lastInsertRowid;
        if ((a.bridges || []).length) {
          sk('bridge', 'running', `Swarm twin of the shared network${a.bridges.length > 1 ? 's' : ''} ${a.bridges.map(x => x.name).join(', ')}`);
          for (const br of a.bridges) { await ensureTwin(br.name, ctx.encrypt, log); await connectToTwin(br.name, br.twin, log, { except: partial ? null : p }); }
          sk('bridge', 'done');
        }
        const moving = partial ? partial.services : a.services.filter(x => !x.stays).map(x => x.name);
        const snap = await snapshotCompose(p, moving); // the protection it has now, to check the Swarm tasks against
        sk('down', 'running', partial ? `docker compose rm -s -f ${partial.services.join(' ')} (volumes stay)` : 'docker compose down (volumes stay)');
        downAt = Date.now();
        await helpers().runResolved(r, p, partial ? ['rm', '-s', '-f', ...partial.services] : ['down'], (c) => String(c).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
        sk('down', 'done');
        sk('deploy', 'running', 'docker stack deploy');
        deployed = true; // from here a failure removes the stack again
        await deployInOrder(stackName, stack, log, { since: downAt });
        await applyPrivileges(stackName, a.privileges, log);
        sk('deploy', 'done');
        sk('verify', 'running', 'check every service runs');
        const readyAt = await verify(stackName, log, { since: downAt });
        sk('verify', 'done');
        sk('secure', 'running', 'check the Swarm tasks are protected as before');
        const report = await securityCheck(stackName, snap, a.security, log);
        res.security = report;
        if (report.failed.length) throw new Error(`less protected on Swarm than planned — ${report.failed.join('; ')}`);
        sk('secure', 'done');
        if (partial) { sk('connect', 'running', 'connect the services that stay in Compose'); await connectStaying(p, stackName, partial.stays, log); sk('connect', 'done'); }
        res.status = 'moved'; res.downtimeMs = readyAt - downAt;
        q.put.run({ server_id: sid, name: stackName, origin: 'compose', location: JSON.stringify({ files: r.files, cwd: r.cwd, remote: r.remote, serverId: a.location.serverId }), settings: JSON.stringify({ ...(plan.settings || {}), ...(partial ? { partial: { project: p, services: partial.services } } : {}) }), now: Date.now() });
        q.endDeploy.run('done', null, res.downtimeMs, Date.now(), deployId);
        log(`✓ ${partial ? `${partial.services.join(', ')} of ${p} run` : `${p} runs`} on Swarm (down for about ${Math.round(res.downtimeMs / 1000)}s)`);
        logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: stackName, action: 'swarm_move_to_swarm', details: { services: Object.keys(stack.services), downtimeMs: res.downtimeMs, ...(partial ? { project: p, stays: partial.stays } : {}), movedAnyway: Object.entries((plan.settings || {}).services || {}).filter(([, v]) => v && v.moveAnyway).map(([k]) => k), security: res.security ? res.security.rows : undefined } });
      } catch (e) {
        res.error = e.message;
        log(`✗ ${p}: ${e.message}`);
        job.steps.filter(s => s.id.startsWith(`${p}:`) && s.status === 'running').forEach(s => { s.status = 'failed'; });
        if (downAt && r) {
          sk('back', 'running', 'put it back in Compose');
          try {
            if (deployed) await stackRemove(stackName, log);
            else await stackRemove(stackName, log).catch(() => {});
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
      if (deployId) q.trim.run(sid, stackName, sid, stackName);
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
  let vars = null;
  if (row.yaml) vars = require('./swarm-yaml').envOf(row); // ${VAR}s of a kept stack file
  if (deployId) {
    const d = q.deployRow.get(Number(deployId), sid);
    if (!d || d.name !== name || !d.stack) throw bad(404, 'That deploy has no stored stack file');
    try { stack = JSON.parse(d.stack); } catch (e) { stack = d.stack; } // a kept YAML file
    hash = d.hash;
  } else if (row.yaml) { stack = row.yaml; hash = hashOf(row.yaml); }
  const { job, log, step } = newJob('redeploy', name);
  (async () => {
    let id = null;
    try {
      if (!stack) {
        step(job, 'read', 'running', 'Read the compose files');
        const loc = JSON.parse(row.location || 'null');
        if (!loc) throw new Error('The location of the compose files is not known');
        const r = { files: loc.files, cwd: loc.cwd, remote: loc.remote, server: loc.serverId ? require('./db').stmts.getServer.get(loc.serverId) : null };
        const part = partialOf(row);
        const proj = part ? part.project : name;
        const cfg = await readConfig(r, proj);
        hash = hashOf(cfg);
        const set = settings ? { ...settings, ...(part ? { partial: part } : {}) } : JSON.parse(row.settings || '{}');
        let images = imagesForBuilt(cfg, proj, ctx);
        if (set.build && set.build.registryId && Object.values(cfg.services || {}).some(x => x.build)) { // build & push what the files say now
          step(job, 'read', 'done'); step(job, 'build', 'running', 'Build and push the images');
          images = { ...images, ...(await require('./swarm-build').buildAll({ project: proj, cfg, r, registryId: set.build.registryId, only: part ? part.services : null, log })) };
          step(job, 'build', 'done');
        }
        stack = adapt(cfg, set, { nodes: ctx.nodes, hostname: ctx.hostname, encrypt: ctx.encrypt, twins: twinsMap(), images, only: part ? part.services.filter(x => cfg.services && cfg.services[x]) : null, project: part ? proj : null });
        if (settings) q.put.run({ server_id: sid, name, origin: row.origin, location: row.location, settings: JSON.stringify(set), now: Date.now() });
        step(job, 'read', 'done');
      }
      id = q.addDeploy.run(sid, name, deployId ? 'previous' : 'redeploy', hash, JSON.stringify(stack), sourceIp || null, Date.now()).lastInsertRowid;
      step(job, 'deploy', 'running', 'docker stack deploy');
      const t = Date.now();
      await stackDeploy(name, stack, log, vars);
      // stack deploy wrote the services without no-new-privileges / seccomp / AppArmor: put them back
      if (row.origin === 'compose' && row.location && ctx.privilegesOk) {
        const part = partialOf(row);
        const cfg2 = await readConfigSafe(row, part ? part.project : name);
        const loc = JSON.parse(row.location || 'null') || {};
        const priv = {};
        for (const svcName of Object.keys((typeof stack === 'object' && stack.services) || cfg2.services || {})) {
          const s0 = (cfg2.services || {})[svcName]; if (!s0) continue;
          const k = await require('./swarm-security').privilegesFor(s0, { cwd: loc.cwd }).catch(() => null);
          if (k && k.privileges) priv[svcName] = k.privileges;
        }
        await applyPrivileges(name, priv, log);
      }
      step(job, 'deploy', 'done');
      step(job, 'verify', 'running', 'Check every service runs');
      await verify(name, log, { since: t });
      step(job, 'verify', 'done');
      const part = partialOf(row);
      if (part) { // a new network in the file: connect the Compose part to it too
        const others = Object.keys((await readConfigSafe(row, part.project)).services || {}).filter(x => !part.services.includes(x));
        if (others.length) await connectStaying(part.project, name, others, log);
      }
      q.endDeploy.run('done', null, null, Date.now(), id);
      if (row.yaml && deployId && typeof stack === 'string') db.prepare('UPDATE swarm_stacks SET yaml = ?, updated_at = ? WHERE server_id = ? AND name = ?').run(stack, Date.now(), sid, name); // the earlier file is the kept one now
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
async function readConfigSafe(row, project) {
  try { const loc = JSON.parse(row.location || 'null'); return await readConfig({ files: loc.files, cwd: loc.cwd, remote: loc.remote, server: loc.serverId ? require('./db').stmts.getServer.get(loc.serverId) : null }, project); }
  catch (e) { return { services: {} }; }
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
  const { job, log, step } = newJob('move-back', name);
  (async () => {
    const id = q.addDeploy.run(sid, name, 'move-back', null, null, sourceIp || null, Date.now()).lastInsertRowid;
    const t = Date.now();
    try {
      const r = { files: loc.files, cwd: loc.cwd, remote: loc.remote, server: loc.serverId ? require('./db').stmts.getServer.get(loc.serverId) : null };
      const part = partialOf(row);
      const proj = part ? part.project : name;
      step(job, 'read', 'running', 'Check the compose files are still there');
      await readConfig(r, proj);
      step(job, 'read', 'done');
      const before = await snapshotTasks(name);
      step(job, 'rm', 'running', 'Remove the stack (volumes stay)');
      await stackRemove(name, log);
      step(job, 'rm', 'done');
      step(job, 'up', 'running', part ? `docker compose up -d (${part.services.join(', ')} come back to ${proj})` : 'docker compose up -d');
      await helpers().runResolved(r, proj, ['up', '-d'], (c) => String(c).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
      await keepTwins(); // back on a shared bridge: it joins the twin, so the projects still on Swarm reach it
      step(job, 'up', 'done');
      // Back in Compose: report any protection the services had on Swarm and lost (the compose files decide; nothing is undone)
      const after = await snapshotCompose(proj, Object.keys(before));
      const backRows = [];
      for (const [svcName, b] of Object.entries(before)) {
        if (!after[svcName]) continue;
        const w = require('./swarm-security').weakerRows(require('./swarm-security').compareProfiles(b.profile, after[svcName].profile));
        for (const x of w) { backRows.push(`${svcName}: ${x.field} ${x.before} → ${x.after}`); log(`  ! ${svcName} is less protected in Compose — ${x.field}: ${x.before} → ${x.after}${x.why ? ` (${x.why})` : ''}`); }
      }
      if (!backRows.length && Object.keys(before).length) log('  ✓ protected as on Swarm');
      job.result = { ...(job.result || {}), security: backRows };
      q.del.run(sid, name);
      q.endDeploy.run('done', null, Date.now() - t, Date.now(), id);
      logAction({ sourceIp, server: sid, resourceType: 'swarm-stack', resourceName: name, action: 'swarm_move_back', details: { downtimeMs: Date.now() - t, lessProtected: (job.result && job.result.security) || [] } });
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
  const row = q.get.get(serverId(), project); // a stack DockGate keeps (Swarm settings of a moved project)
  const part = row ? partialOf(row) : null;
  const proj = part ? part.project : project;
  if (row && !settings) settings = JSON.parse(row.settings || '{}');
  const a = await analyze(proj, { nodes: ctx.nodes, localImages: ctx.localImages, location: row ? JSON.parse(row.location || 'null') : null, settings, privilegesOk: ctx.privilegesOk });
  if (a.status === 'impossible') return { ...a, cfg: undefined, privileges: undefined, security: undefined, stack: null };
  if (part) { a.services = a.services.filter(x => part.services.includes(x.name)); a.status = 'partial'; }
  const images = {};
  for (const s of a.services) if (s.image && !(a.cfg.services[s.name] || {}).image) images[s.name] = s.image;
  const only = part ? part.services : a.status === 'partial' ? a.services.filter(x => !x.stays).map(x => x.name) : null;
  const stack = adapt(a.cfg, settings || {}, { nodes: ctx.nodes, hostname: ctx.hostname, encrypt: ctx.encrypt, images, twins: { ...twinsMap(), ...Object.fromEntries((a.bridges || []).map(x => [x.name, x.twin])) }, only, project: only ? proj : null });
  const { cfg, privileges, security, ...rest } = a;
  return { ...rest, stack, settings: settings || {} };
}

module.exports = { startBridgeKeeper, keepTwins, twinName, startLevels, resourcesOf, aliasesOf, portScope, isOnSwarm, stackOfProject, partialOf, stackRows, analyze, adapt, restartPolicy, candidates, list, history, preview, startMove, startRedeploy, startMoveBack, removeStack, _clean: clean, _internal: { q, remoteServer, stackDeploy, stackRemove, verify, newJob, finish, context, serverId, hashOf, securityCheck, snapshotTasks } };
