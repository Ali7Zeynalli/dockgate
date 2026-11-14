// Compose replicas without Swarm. DockGate never writes the user's compose files: its choices (replicas, and the
// fixes a replica needs — a host port moved behind the proxy, container_name kept as an alias) go into an
// override file kept in a DockGate folder and appended to every compose command (routes/compose.js
// resolveComposeFiles). Local: DATA_DIR/compose-overrides/<server>/<project>/docker-compose.dockgate.yml;
// remote: ~/.dockgate/overrides/<project>/docker-compose.dockgate.yml (never in the project folder or a checkout).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { db } = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = 'docker-compose.dockgate.yml';
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const MAX_REPLICAS = 20;
const bad = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });

db.exec(`CREATE TABLE IF NOT EXISTS compose_scaling (
  server_id TEXT NOT NULL, project TEXT NOT NULL, service TEXT NOT NULL,
  replicas INTEGER, fix_ports INTEGER DEFAULT 0, fix_name INTEGER DEFAULT 0, aliases TEXT,
  mode TEXT DEFAULT 'off', min_r INTEGER, max_r INTEGER, cpu_up INTEGER, cpu_down INTEGER, mem_up INTEGER, mem_down INTEGER,
  up_min INTEGER, down_min INTEGER, cool_up INTEGER, cool_down INTEGER,
  heal INTEGER DEFAULT 0, heal_per_hour INTEGER, heal_rollback INTEGER DEFAULT 0, last_at INTEGER, last_dir TEXT,
  updated_at INTEGER, PRIMARY KEY (server_id, project, service)
)`);
try { db.exec('ALTER TABLE compose_scaling ADD COLUMN keep_running INTEGER DEFAULT 0'); } catch (e) { /* there */ }
// Where the override of a project is (so resolveComposeFiles needs no SSH round trip to know).
db.exec(`CREATE TABLE IF NOT EXISTS compose_overrides (
  server_id TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (server_id, project)
)`);
const q = {
  rules: db.prepare('SELECT * FROM compose_scaling WHERE server_id = ? AND project = ?'),
  upsert: db.prepare(`INSERT INTO compose_scaling (server_id, project, service, replicas, fix_ports, fix_name, aliases, updated_at)
    VALUES (@server_id, @project, @service, @replicas, @fix_ports, @fix_name, @aliases, @updated_at)
    ON CONFLICT(server_id, project, service) DO UPDATE SET replicas = excluded.replicas, fix_ports = excluded.fix_ports, fix_name = excluded.fix_name,
      aliases = excluded.aliases, updated_at = excluded.updated_at`),
  delRules: db.prepare('DELETE FROM compose_scaling WHERE server_id = ? AND project = ?'),
  ovGet: db.prepare('SELECT path FROM compose_overrides WHERE server_id = ? AND project = ?'),
  ovPut: db.prepare('INSERT INTO compose_overrides (server_id, project, path, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(server_id, project) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at'),
  ovDel: db.prepare('DELETE FROM compose_overrides WHERE server_id = ? AND project = ?'),
};

function checkName(n, what) { if (!NAME.test(String(n || ''))) throw bad(`${what} "${String(n).slice(0, 40)}": letters, digits, dot, dash or underscore (up to 63)`); return n; }
function checkReplicas(n) { if (!Number.isInteger(n) || n < 0 || n > MAX_REPLICAS) throw bad(`Replicas: a whole number from 0–${MAX_REPLICAS}`); return n; }

/** Where the override of a project lives. Never inside the project folder. */
function overridePath(serverId, project) {
  checkName(serverId, 'Server'); checkName(project, 'Project');
  if (serverId === 'local') return { local: path.join(DATA_DIR, 'compose-overrides', 'local', project, FILE), remote: null };
  return { local: null, remote: `~/.dockgate/overrides/${project}/${FILE}` };
}

/**
 * The override's YAML. rules: { service: { replicas?, aliases?: [], networks?: [], dropPorts?, dropName? } }. Every name is
 * checked against NAME, so nothing a user typed reaches the file unchecked; numbers are integers.
 */
function buildOverride(rules = {}) {
  const lines = [];
  for (const [svc, r] of Object.entries(rules || {})) {
    checkName(svc, 'Service');
    const body = [];
    if (r.replicas !== undefined && r.replicas !== null) body.push('    deploy:', `      replicas: ${checkReplicas(r.replicas)}`);
    if (r.dropPorts) body.push('    ports: !reset []');
    if (r.dropName) body.push('    container_name: !reset null');
    // Aliases go on the networks the service already uses (adding "default" would join it to a network it is not on).
    const aliases = [...new Set((r.aliases || []).map(a => checkName(a, 'Alias')))];
    const nets = [...new Set((r.networks && r.networks.length ? r.networks : ['default']).map(n => checkName(n, 'Network')))];
    if (aliases.length) body.push('    networks:', ...nets.flatMap(n => [`      ${n}:`, '        aliases:', ...aliases.map(a => `          - ${a}`)]));
    if (body.length) lines.push(`  ${svc}:`, ...body);
  }
  return lines.length ? `# Written by DockGate — your compose files are not changed. Remove this file to go back.\nservices:\n${lines.join('\n')}\n` : '';
}

/** Saved choices of a project: { service: { replicas, dropPorts, dropName, aliases } }. */
function readRules(serverId, project) {
  const out = {};
  for (const r of q.rules.all(serverId, project)) {
    let aliases = []; try { aliases = JSON.parse(r.aliases || '[]'); } catch (e) { /* none */ }
    out[r.service] = { replicas: r.replicas, dropPorts: !!r.fix_ports, dropName: !!r.fix_name, aliases, mode: r.mode, heal: !!r.heal, keepRunning: !!r.keep_running };
  }
  return out;
}
function saveRule(serverId, project, service, rule) {
  checkName(service, 'Service');
  q.upsert.run({ server_id: serverId, project, service, replicas: rule.replicas ?? null, fix_ports: rule.dropPorts ? 1 : 0, fix_name: rule.dropName ? 1 : 0,
    aliases: JSON.stringify(rule.aliases || []), updated_at: Date.now() });
}

const remote = () => require('./remote-compose');
/** Write the override atomically (temp file + rename), private to its owner. Returns the previous text. */
async function writeOverride(r, serverId, project, text) {
  const p = overridePath(serverId, project);
  if (p.local) {
    const dir = path.dirname(p.local);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(dir), 0o700); fs.chmodSync(dir, 0o700); } catch (e) { /* best effort */ }
    const previous = fs.existsSync(p.local) ? fs.readFileSync(p.local, 'utf8') : null;
    if (!text) { if (previous !== null) fs.unlinkSync(p.local); q.ovDel.run(serverId, project); return { previous }; }
    const tmp = `${p.local}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, p.local);
    q.ovPut.run(serverId, project, p.local, Date.now());
    return { previous };
  }
  const rc = remote();
  const abs = await rc.resolveRemotePath(r.server, p.remote);
  const dir = path.posix.dirname(abs);
  const prev = await rc.execRemote(r.server, `cat ${rc.shq(abs)} 2>/dev/null`);
  const previous = prev.code === 0 ? prev.stdout : null;
  if (!text) {
    await rc.execRemote(r.server, `rm -f ${rc.shq(abs)}`);
    q.ovDel.run(serverId, project);
    return { previous };
  }
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const tmp = `${abs}.tmp`;
  const x = await rc.execRemote(r.server, `umask 077 && mkdir -p ${rc.shq(dir)} && printf %s ${rc.shq(b64)} | base64 -d > ${rc.shq(tmp)} && mv -f ${rc.shq(tmp)} ${rc.shq(abs)}`);
  if (x.code !== 0) throw bad(`Could not write the override on the server: ${(x.stderr || x.stdout || '').trim().slice(0, 200)}`, 500);
  q.ovPut.run(serverId, project, abs, Date.now());
  return { previous };
}
/** The override path to append to the compose -f list, or null. (Local: only when the file is there.) */
function overrideFor(serverId, project) {
  const row = q.ovGet.get(serverId || 'local', project);
  if (!row) return null;
  if (!row.path.startsWith('/')) return null;
  if ((serverId || 'local') === 'local' && !fs.existsSync(row.path)) return null;
  return row.path;
}
/** Forget a project's override and choices (Delete stack…, or "back to the files"). */
async function removeAll(r, serverId, project) {
  await writeOverride(r, serverId, project, '');
  q.delRules.run(serverId, project);
}

/** `docker compose version --short` where the project runs. */
async function composeVersion(r) {
  if (r && r.remote) { const x = await remote().execRemote(r.server, 'docker compose version --short 2>/dev/null'); return (x.stdout || '').trim().replace(/^v/, ''); }
  return new Promise((res) => execFile('docker', ['compose', 'version', '--short'], { timeout: 15000 }, (e, out) => res(e ? '' : String(out).trim().replace(/^v/, ''))));
}
const verAtLeast = (v, min) => { const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) > b[i]) return true; if ((a[i] || 0) < b[i]) return false; } return true; };

/**
 * Can this service run as several replicas? cfgService: the service in `docker compose config --format json`.
 * Returns { ok, block?, fixes: ['dropPorts'|'dropName'], needsReset, limits: { cpu, mem } }.
 */
function checkScalable(s, name, version) {
  const isDb = require('./swarm-services').isDatabase;
  const limits = limitsOf(s);
  const out = { ok: true, fixes: [], needsReset: false, limits };
  if (isDb(s.image)) return { ...out, ok: false, block: 'database: more replicas would be separate databases, not copies — it stays at 1' };
  const rw = (s.volumes || []).filter(v => (v.type === 'volume' || v.type === 'bind') && !v.read_only);
  if (rw.length) return { ...out, ok: false, block: `writes to ${rw.map(v => v.target).join(', ')}: two replicas would write the same data — it stays at 1` };
  if (s.network_mode === 'host') return { ...out, ok: false, block: 'network_mode: host — two replicas would take the same ports' };
  if ((s.ports || []).some(p => p.published !== undefined && p.published !== '')) out.fixes.push('dropPorts');
  if (s.container_name) out.fixes.push('dropName');
  if (out.fixes.length) {
    out.needsReset = true;
    if (!verAtLeast(version, '2.24.4')) return { ...out, ok: false, block: `needs ${out.fixes.includes('dropPorts') ? 'its host port moved behind the proxy' : 'its container_name dropped'}, which needs Docker Compose 2.24.4 or newer on the server (it has ${version || 'an unknown version'})` };
  }
  return out;
}
/** CPU (cores) and memory (bytes) limits from the compose file, whichever way they were written. */
function limitsOf(s) {
  const lim = ((s.deploy || {}).resources || {}).limits || {};
  let cpu = Number(lim.cpus) || Number(s.cpus) || 0;
  if (!cpu && Number(s.cpu_quota) > 0) cpu = Number(s.cpu_quota) / (Number(s.cpu_period) || 100000);
  const memOf = (v) => { if (v === undefined || v === null || v === '') return 0; if (/^\d+$/.test(String(v))) return Number(v); const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(String(v).trim()); return m ? Math.round(Number(m[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824, t: 1099511627776 })[m[2].toLowerCase()]) : 0; };
  return { cpu: Math.round(cpu * 1000) / 1000, mem: memOf(lim.memory) || memOf(s.mem_limit) };
}

// ---- changing replicas ----
const helpers = () => require('./routes/compose').composeHelpers;
const dockerService = () => require('./docker');
const serverIdNow = () => dockerService().getActiveServerId() || 'local';

/** The merged config (the user's files + the override) of a project. */
async function configOf(r, project) {
  const out = String(await helpers().runResolved(r, project, ['config', '--format', 'json'], null));
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b < a) throw bad(`docker compose config gave no JSON: ${out.trim().split('\n').pop().slice(0, 200)}`);
  return JSON.parse(out.slice(a, b + 1));
}
/** Running containers of a service, oldest replica number first. */
async function replicasOf(c, project, service) {
  const list = await c.listContainers({ all: false, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`] }) });
  return list.map(x => ({ id: x.Id, number: Number(x.Labels['com.docker.compose.container-number']) || 0, name: (x.Names[0] || '').replace(/^\//, '') })).sort((a, b) => a.number - b.number);
}

/**
 * Set the replicas of one service. Writes the override, then
 *   up -d --no-deps --no-recreate --scale <svc>=<n> <svc>   (--force-recreate when a fix changes the service)
 * Going down, the replicas that go are stopped gracefully first. The proxies on the project's networks are reloaded.
 * If compose fails, the previous override comes back and the service is brought up as it was.
 * opts: { acceptFixes: bool, sourceIp, log }
 */
async function setReplicas(project, service, n, opts = {}) {
  const h = helpers();
  if (!h.validateProjectName(project)) throw bad('Invalid project name');
  checkName(service, 'Service'); checkReplicas(n);
  if (h.busy(project)) throw bad('A deploy of this project is running — try again when it ends', 409);
  const log = opts.log || (() => {});
  const sid = serverIdNow();
  let r = await h.resolveComposeFiles(project);
  if (!r.files || !r.files.length) throw bad(r.reason || 'DockGate can not find the compose files of this project');
  const cfg = await configOf(r, project);
  const s = (cfg.services || {})[service];
  if (!s) throw bad(`No service ${service} in ${project}`, 404);
  const rules = readRules(sid, project);
  const rule = { ...(rules[service] || {}), replicas: n };
  let recreate = false;
  if (n > 1 || rule.dropPorts || rule.dropName) {
    const chk = checkScalable(s, service, await composeVersion(r));
    if (!chk.ok) throw bad(`${service}: ${chk.block}`, 409);
    const missing = chk.fixes.filter(f => !rule[f]);
    if (missing.length && n > 1) {
      if (!opts.acceptFixes) throw Object.assign(bad(`${service} needs ${missing.map(f => (f === 'dropPorts' ? 'its host port moved behind the proxy' : 'its container_name dropped (kept as a name others reach it by)')).join(' and ')} before it can run as several replicas`, 409), { needFixes: missing });
      for (const f of missing) rule[f] = true;
      recreate = true;
    }
  }
  if (rule.dropName && s.container_name) rule.aliases = [...new Set([...(rule.aliases || []), s.container_name])];
  rule.networks = Object.keys(s.networks || { default: null });
  const next = { ...Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, { ...v, networks: k === service ? rule.networks : Object.keys(((cfg.services || {})[k] || {}).networks || { default: null }) }])), [service]: rule };
  const c = dockerService().docker;
  const before = await replicasOf(c, project, service);
  const { previous } = await writeOverride(r, sid, project, buildOverride(next));
  r = await h.resolveComposeFiles(project);
  const started = Date.now();
  try {
    if (n < before.length && !recreate) {
      const going = before.slice(n).map(x => x.id); // the highest numbers go, as compose would choose
      log(`Stopping ${going.length} replica${going.length === 1 ? '' : 's'} of ${service} gracefully…`);
      await require('./compose-traffic').drainAndStop(c, going, log);
    }
    const args = ['up', '-d', '--no-deps', recreate ? '--force-recreate' : '--no-recreate', '--scale', `${service}=${n}`, service];
    log(`$ docker compose ${args.join(' ')}`);
    await h.runResolved(r, project, args, (d) => String(d).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
  } catch (e) {
    log(`✗ ${e.message} — putting the previous setting back`);
    await writeOverride(r, sid, project, previous || '');
    const back = await h.resolveComposeFiles(project);
    await h.runResolved(back, project, ['up', '-d', '--no-deps', '--no-recreate', service], null).catch(() => {});
    h.recordDeploy({ project, kind: 'scale', status: 'error', error: e.message, sourceIp: opts.sourceIp, startedAt: started, finishedAt: Date.now(), details: { service, from: before.length, to: n, rolledBack: true } });
    throw Object.assign(bad(`${service} could not run ${n} replica${n === 1 ? '' : 's'}: ${String(e.message).slice(0, 300)} — the previous setting is back`, 500), { rolledBack: true });
  }
  saveRule(sid, project, service, rule);
  require('./agent/control').pushSoon(sid); // the agent keeps this number from now on
  const traffic = require('./compose-traffic');
  await traffic.reloadProxies(c, await traffic.findProxies(c, project), log);
  h.recordDeploy({ project, kind: 'scale', status: 'done', sourceIp: opts.sourceIp, startedAt: started, finishedAt: Date.now(), details: { service, from: before.length, to: n, fixes: recreate ? ['dropPorts', 'dropName'].filter(f => rule[f]) : [] } });
  try { require('./audit').logAction({ sourceIp: opts.sourceIp || 'dockgate', server: sid, resourceType: 'compose', resourceId: project, resourceName: `${project}/${service}`, action: 'compose_scale', details: { from: before.length, to: n } }); } catch (e) { /* best effort */ }
  return { from: before.length, to: n };
}

/** Turn auto-heal on or off for a service. */
function setHeal(project, service, on, { sourceIp, perHour } = {}) {
  checkName(project, 'Project'); checkName(service, 'Service');
  const sid = serverIdNow();
  db.prepare(`INSERT INTO compose_scaling (server_id, project, service, heal, heal_per_hour, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, project, service) DO UPDATE SET heal = excluded.heal, heal_per_hour = excluded.heal_per_hour, updated_at = excluded.updated_at`)
    .run(sid, project, service, on ? 1 : 0, Number.isInteger(perHour) && perHour >= 1 && perHour <= 20 ? perHour : 3, Date.now());
  try { require('./audit').logAction({ sourceIp: sourceIp || 'dockgate', server: sid, resourceType: 'compose', resourceId: project, resourceName: `${project}/${service}`, action: on ? 'compose_heal_on' : 'compose_heal_off', details: {} }); } catch (e) { /* best effort */ }
  require('./agent/control').pushSoon(sid);
  return { ok: true, heal: !!on };
}

/** Keep running: a stopped service is started again, a removed one made again from its kept config. */
function setKeep(project, service, on, { sourceIp } = {}) {
  checkName(project, 'Project'); checkName(service, 'Service');
  const sid = serverIdNow();
  db.prepare(`INSERT INTO compose_scaling (server_id, project, service, keep_running, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(server_id, project, service) DO UPDATE SET keep_running = excluded.keep_running, updated_at = excluded.updated_at`).run(sid, project, service, on ? 1 : 0, Date.now());
  try { require('./audit').logAction({ sourceIp: sourceIp || 'dockgate', server: sid, resourceType: 'compose', resourceName: `${project}/${service}`, resourceId: project, action: on ? 'compose_keep_on' : 'compose_keep_off', details: {} }); } catch (e) { /* best effort */ }
  require('./agent/control').pushSoon(sid);
  return { ok: true, keepRunning: !!on };
}
/**
 * Before a Down or Delete from DockGate: Keep running is turned off for the project, and the agent is told at once,
 * so the containers that go are not made again. Returns the services that had it.
 */
async function pauseKeep(serverId, project) {
  const had = db.prepare('SELECT service FROM compose_scaling WHERE server_id = ? AND project = ? AND keep_running = 1').all(serverId, project).map(r => r.service);
  if (!had.length) return [];
  db.prepare('UPDATE compose_scaling SET keep_running = 0, updated_at = ? WHERE server_id = ? AND project = ?').run(Date.now(), serverId, project);
  await require('./agent/control').pushRules(serverId).catch(() => null);
  try { require('./audit').logAction({ sourceIp: 'dockgate', server: serverId, resourceType: 'compose', resourceName: project, resourceId: project, action: 'compose_keep_off', details: { services: had, reason: 'down' } }); } catch (e) { /* best effort */ }
  return had;
}

module.exports = { setKeep, pauseKeep, setHeal, setReplicas, configOf, replicasOf, FILE, MAX_REPLICAS, NAME, overridePath, buildOverride, readRules, saveRule, writeOverride, overrideFor, removeAll, composeVersion, verAtLeast, checkScalable, limitsOf, checkName, checkReplicas };
