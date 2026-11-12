// Swarm autoscale: Docker Swarm has no autoscaler, so DockGate scales replicated services by CPU.
//
// A rule per service: min / max replicas, scale up when the average CPU per task stays at or above `cpuUp`
// for `upMinutes`, scale down when it stays at or below `cpuDown` for `downMinutes`, one replica at a time,
// and no change within `cooldownMinutes` of the last one. CPU per task is the % of the task's CPU limit when
// the service has one, else the % of one CPU core (docker stats: 100% = one core).
//
// The engine runs every minute for every enabled rule, on the manager the rule was saved on — whatever server
// is picked at the top of DockGate. CPU is read with `docker stats` on each node's DockGate server, so nodes
// that are not in DockGate are not measured (their tasks are left out of the average). Every change goes to
// the audit log and the "Swarm autoscale" notification rule.
const { db } = require('./db');
const dockerService = require('./docker');

db.exec(`CREATE TABLE IF NOT EXISTS swarm_autoscale (
  cluster_id TEXT NOT NULL, service_id TEXT NOT NULL, service_name TEXT, server_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, min_r INTEGER NOT NULL, max_r INTEGER NOT NULL,
  cpu_up INTEGER NOT NULL, cpu_down INTEGER NOT NULL, up_min INTEGER NOT NULL, down_min INTEGER NOT NULL, cooldown_min INTEGER NOT NULL,
  last_at INTEGER, last_action TEXT, last_reason TEXT, updated_at INTEGER,
  PRIMARY KEY (cluster_id, service_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS swarm_autoscale_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, service_id TEXT NOT NULL, t INTEGER NOT NULL,
  from_r INTEGER, to_r INTEGER, reason TEXT, ok INTEGER NOT NULL DEFAULT 1
)`);
db.exec('CREATE INDEX IF NOT EXISTS swarm_autoscale_log_idx ON swarm_autoscale_log (cluster_id, service_id, t)');
const q = {
  get: db.prepare('SELECT * FROM swarm_autoscale WHERE cluster_id = ? AND service_id = ?'),
  all: db.prepare('SELECT * FROM swarm_autoscale WHERE cluster_id = ?'),
  enabled: db.prepare('SELECT * FROM swarm_autoscale WHERE enabled = 1'),
  upsert: db.prepare(`INSERT INTO swarm_autoscale (cluster_id, service_id, service_name, server_id, enabled, min_r, max_r, cpu_up, cpu_down, up_min, down_min, cooldown_min, updated_at)
    VALUES (@cluster_id, @service_id, @service_name, @server_id, @enabled, @min_r, @max_r, @cpu_up, @cpu_down, @up_min, @down_min, @cooldown_min, @updated_at)
    ON CONFLICT(cluster_id, service_id) DO UPDATE SET service_name = excluded.service_name, server_id = excluded.server_id, enabled = excluded.enabled,
      min_r = excluded.min_r, max_r = excluded.max_r, cpu_up = excluded.cpu_up, cpu_down = excluded.cpu_down, up_min = excluded.up_min,
      down_min = excluded.down_min, cooldown_min = excluded.cooldown_min, updated_at = excluded.updated_at`),
  del: db.prepare('DELETE FROM swarm_autoscale WHERE cluster_id = ? AND service_id = ?'),
  last: db.prepare('UPDATE swarm_autoscale SET last_at = ?, last_action = ?, last_reason = ? WHERE cluster_id = ? AND service_id = ?'),
  log: db.prepare('INSERT INTO swarm_autoscale_log (cluster_id, service_id, t, from_r, to_r, reason, ok) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  recent: db.prepare('SELECT t, from_r, to_r, reason, ok FROM swarm_autoscale_log WHERE cluster_id = ? AND service_id = ? ORDER BY t DESC LIMIT 50'),
  trim: db.prepare('DELETE FROM swarm_autoscale_log WHERE t < ?'),
};

const DEFAULTS = { min: 1, max: 5, cpuUp: 75, cpuDown: 25, upMinutes: 5, downMinutes: 10, cooldownMinutes: 5 };
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });

/** Check and normalise a rule from the form. Throws 400 with the reason. */
function validate(body = {}) {
  const int = (v, name, lo, hi, def) => {
    const n = v === undefined || v === null || v === '' ? def : Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw bad(400, `${name}: a whole number from ${lo} to ${hi}`);
    return n;
  };
  const r = {
    enabled: body.enabled === undefined ? true : !!body.enabled,
    min: int(body.min, 'Minimum replicas', 1, 100, DEFAULTS.min),
    max: int(body.max, 'Maximum replicas', 1, 100, DEFAULTS.max),
    cpuUp: int(body.cpuUp, 'Scale up at CPU %', 10, 100, DEFAULTS.cpuUp),
    cpuDown: int(body.cpuDown, 'Scale down at CPU %', 1, 90, DEFAULTS.cpuDown),
    upMinutes: int(body.upMinutes, 'Scale up after (minutes)', 1, 30, DEFAULTS.upMinutes),
    downMinutes: int(body.downMinutes, 'Scale down after (minutes)', 2, 60, DEFAULTS.downMinutes),
    cooldownMinutes: int(body.cooldownMinutes, 'Wait between changes (minutes)', 1, 60, DEFAULTS.cooldownMinutes),
  };
  if (r.max < r.min) throw bad(400, 'The maximum must be at least the minimum');
  if (r.cpuDown > r.cpuUp - 10) throw bad(400, 'Scale down at a CPU % at least 10 below the scale-up %, or the service would go up and down');
  return r;
}

const fromRow = (row) => row && ({
  serviceId: row.service_id, serviceName: row.service_name, serverId: row.server_id, enabled: !!row.enabled,
  min: row.min_r, max: row.max_r, cpuUp: row.cpu_up, cpuDown: row.cpu_down, upMinutes: row.up_min, downMinutes: row.down_min, cooldownMinutes: row.cooldown_min,
  lastAt: row.last_at || null, lastAction: row.last_action || null, lastReason: row.last_reason || null,
});

/**
 * The change due now, or null. Pure (unit tested). samples: [{ t, cpu }] CPU per task, one a minute.
 * Out of the min–max range is put right at once; otherwise one replica at a time after the cooldown,
 * on the average of the window, when the window is (almost) full of samples.
 */
function decide(rule, samples, replicas, now = Date.now(), lastAt = null) {
  if (replicas < rule.min) return { to: rule.min, action: 'up', reason: `below the minimum of ${rule.min}` };
  if (replicas > rule.max) return { to: rule.max, action: 'down', reason: `above the maximum of ${rule.max}` };
  if (lastAt && now - lastAt < rule.cooldownMinutes * 60000) return null;
  const win = (m) => samples.filter(s => s.t > now - m * 60000 && Number.isFinite(s.cpu));
  const avg = (l) => Math.round(l.reduce((a, s) => a + s.cpu, 0) / l.length);
  const enough = (l, m) => l.length >= Math.max(2, m - 1); // one sample a minute; allow one missed
  const up = win(rule.upMinutes);
  if (replicas < rule.max && enough(up, rule.upMinutes) && avg(up) >= rule.cpuUp) {
    return { to: replicas + 1, action: 'up', reason: `CPU ${avg(up)}% per task for ${rule.upMinutes} min (scale up at ${rule.cpuUp}%)` };
  }
  const down = win(rule.downMinutes);
  if (replicas > rule.min && enough(down, rule.downMinutes) && avg(down) <= rule.cpuDown) {
    return { to: replicas - 1, action: 'down', reason: `CPU ${avg(down)}% per task for ${rule.downMinutes} min (scale down at ${rule.cpuDown}%)` };
  }
  return null;
}

// ---- reading a service on the rule's manager ----
function serverRow(id) { return !id || id === 'local' ? { id: 'local', type: 'local', name: 'Local' } : require('./db').stmts.getServer.get(id); }
function clientFor(id) { const row = serverRow(id); if (!row) throw bad(404, 'The manager server of this rule is no longer in DockGate'); return row.id === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(row); }

/** CPU per task of a service: { cpu, tasks, measured } — cpu in % of the limit (or of one core). */
async function measure(mgrClient, clusterId, managerServerId, svc) {
  const limit = (((svc.Spec.TaskTemplate || {}).Resources || {}).Limits || {}).NanoCPUs || 0;
  const tasks = await mgrClient.listTasks({ filters: JSON.stringify({ service: [svc.ID], 'desired-state': ['running'] }) });
  const running = tasks.filter(t => t.Status.State === 'running');
  const info = await mgrClient.info();
  const selfNode = info.Swarm && info.Swarm.NodeID;
  const map = new Map();
  try { for (const r of db.prepare('SELECT node_id, server_id FROM swarm_node_servers WHERE cluster_id = ?').all(clusterId)) map.set(r.node_id, r.server_id); } catch (e) { /* no table yet */ }
  if (selfNode) map.set(selfNode, managerServerId);
  const byNode = new Map();
  for (const t of running) { const sid = map.get(t.NodeID); if (sid) byNode.set(sid, (byNode.get(sid) || 0) + 1); }
  let sum = 0, measured = 0;
  await Promise.all([...byNode.keys()].map(async (sid) => {
    try {
      const c = sid === managerServerId ? mgrClient : clientFor(sid);
      const list = await c.listContainers({ filters: JSON.stringify({ label: [`com.docker.swarm.service.id=${svc.ID}`] }) });
      await Promise.all(list.map(async (ct) => {
        try { const st = dockerService.parseStats(await c.getContainer(ct.Id).stats({ stream: false })); sum += st.cpuPercent || 0; measured++; } catch (e) { /* stopped meanwhile */ }
      }));
    } catch (e) { /* that server is not reachable now */ }
  }));
  if (!measured) return { cpu: null, tasks: running.length, measured: 0, limit: limit / 1e9 || null };
  const perTask = sum / measured; // % of one core
  return { cpu: Math.round((limit ? perTask / (limit / 1e9) : perTask) * 10) / 10, tasks: running.length, measured, limit: limit / 1e9 || null };
}

// ---- the engine ----
const buffers = new Map(); // `${cluster}:${service}` → [{ t, cpu }] last hour
const lastSeen = new Map(); // same key → { cpu, tasks, measured, at }
let timer = null, busy = false;

async function scaleTo(c, svc, to) {
  const spec = JSON.parse(JSON.stringify(svc.Spec));
  spec.Mode = { Replicated: { Replicas: to } };
  await c.getService(svc.ID).update({ version: svc.Version.Index, ...spec });
}

async function tickRule(row, now) {
  const key = `${row.cluster_id}:${row.service_id}`;
  const rule = fromRow(row);
  const c = clientFor(row.server_id);
  let svc;
  try { svc = await c.getService(row.service_id).inspect(); }
  catch (e) { if (e.statusCode === 404) { q.del.run(row.cluster_id, row.service_id); buffers.delete(key); } return; } // the service is gone: so is its rule
  if (!svc.Spec.Mode.Replicated) return;
  const us = svc.UpdateStatus && svc.UpdateStatus.State;
  if (us === 'updating' || us === 'rollback_started') return; // never scale during a rolling update
  const m = await measure(c, row.cluster_id, row.server_id, svc);
  lastSeen.set(key, { ...m, at: now });
  const buf = (buffers.get(key) || []).filter(s => s.t > now - 3600000);
  if (m.cpu !== null) buf.push({ t: now, cpu: m.cpu });
  buffers.set(key, buf);
  const replicas = svc.Spec.Mode.Replicated.Replicas;
  const d = decide(rule, buf, replicas, now, rule.lastAt);
  if (!d || d.to === replicas) return;
  let ok = 1, reason = d.reason;
  try { await scaleTo(c, svc, d.to); }
  catch (e) { ok = 0; reason = `${d.reason} — scaling failed: ${String(e.message || e).slice(0, 200)}`; }
  q.last.run(now, ok ? `${replicas} → ${d.to}` : 'failed', reason, row.cluster_id, row.service_id);
  q.log.run(row.cluster_id, row.service_id, now, replicas, d.to, reason, ok);
  buffers.set(key, []); // measure the new number of tasks from scratch
  try {
    require('./audit').logAction({ sourceIp: 'autoscale', server: row.server_id, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: 'swarm_autoscale', details: { from: replicas, to: d.to, reason, ok: !!ok } });
  } catch (e) { /* audit is best effort */ }
  try {
    const HM = require('./notifications/health-monitor');
    const where = HM.serverLabel ? HM.serverLabel(serverRow(row.server_id)) : row.server_id;
    const verb = !ok ? '🔴 could not scale' : d.action === 'up' ? '🔼 scaled up' : '🔽 scaled down';
    const subject = `${svc.Spec.Name} ${ok ? `${replicas} → ${d.to} replicas` : 'autoscale failed'}`;
    await HM.deliver('swarm_autoscale', serverRow(row.server_id), subject, `${verb}: ${svc.Spec.Name} on ${where}\n${replicas} → ${d.to} replicas\n${reason}`, `<p><b>${verb}</b>: ${svc.Spec.Name} on ${where}</p><p>${replicas} → ${d.to} replicas</p><p>${reason}</p>`, { always: true });
  } catch (e) { /* notifications are best effort */ }
}

async function tick(now = Date.now()) {
  if (busy) return;
  busy = true;
  try {
    for (const row of q.enabled.all()) {
      try { await tickRule(row, now); } catch (e) { console.warn('[autoscale]', row.service_name, e.message); }
    }
    q.trim.run(now - 30 * 24 * 3600000);
  } finally { busy = false; }
}
function start() { if (!timer) { timer = setInterval(() => tick(), 60000); if (timer.unref) timer.unref(); } }

// ---- API helpers (the server in use must be a manager: the rule is saved for its cluster) ----
async function context() {
  const swarm = require('./swarm');
  const st = await swarm.status();
  if (st.state !== 'active' || !st.manager || !st.clusterId) throw bad(409, 'Swarm must be active and the server in use a manager');
  return { clusterId: st.clusterId, serverId: st.serverId || dockerService.getActiveServerId() || 'local', c: dockerService.docker };
}

async function getRule(serviceId) {
  const { clusterId, c } = await context();
  const svc = await c.getService(serviceId).inspect();
  const row = q.get.get(clusterId, svc.ID);
  const key = `${clusterId}:${svc.ID}`;
  const img = svc.Spec.TaskTemplate.ContainerSpec.Image || '';
  const prefs = (svc.Spec.TaskTemplate.Placement || {}).Preferences || [];
  return {
    rule: fromRow(row), defaults: DEFAULTS,
    replicas: svc.Spec.Mode.Replicated ? svc.Spec.Mode.Replicated.Replicas : null, global: !svc.Spec.Mode.Replicated,
    database: require('./swarm-services').isDatabase(img),
    hasVolume: (svc.Spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume' || m.Type === 'bind'),
    cpuLimit: (((svc.Spec.TaskTemplate || {}).Resources || {}).Limits || {}).NanoCPUs / 1e9 || null,
    spread: prefs.some(p => p.Spread && p.Spread.SpreadDescriptor === 'node.id'),
    now: lastSeen.get(key) || null,
    samples: (buffers.get(key) || []).slice(-60),
    log: q.recent.all(clusterId, svc.ID).map(r => ({ t: r.t, from: r.from_r, to: r.to_r, reason: r.reason, ok: !!r.ok })),
  };
}

async function saveRule(serviceId, body, { sourceIp } = {}) {
  const { clusterId, serverId, c } = await context();
  const svc = await c.getService(serviceId).inspect();
  if (!svc.Spec.Mode.Replicated) throw bad(400, 'Global services run one task on every server — autoscale works for replicated services');
  const img = svc.Spec.TaskTemplate.ContainerSpec.Image || '';
  if (require('./swarm-services').isDatabase(img)) throw bad(400, `${img.split(':')[0].split('@')[0]} looks like a database. More replicas would be separate databases, not copies — autoscale is not offered for it.`);
  const r = validate(body);
  q.upsert.run({ cluster_id: clusterId, service_id: svc.ID, service_name: svc.Spec.Name, server_id: serverId, enabled: r.enabled ? 1 : 0, min_r: r.min, max_r: r.max,
    cpu_up: r.cpuUp, cpu_down: r.cpuDown, up_min: r.upMinutes, down_min: r.downMinutes, cooldown_min: r.cooldownMinutes, updated_at: Date.now() });
  // Spread the replicas over the servers (placement preference), unless the service already says how.
  if (body.spread) {
    const fresh = await c.getService(svc.ID).inspect();
    const spec = JSON.parse(JSON.stringify(fresh.Spec));
    spec.TaskTemplate.Placement = spec.TaskTemplate.Placement || {};
    const prefs = spec.TaskTemplate.Placement.Preferences || [];
    if (!prefs.some(p => p.Spread && p.Spread.SpreadDescriptor === 'node.id')) {
      spec.TaskTemplate.Placement.Preferences = [...prefs, { Spread: { SpreadDescriptor: 'node.id' } }];
      await c.getService(svc.ID).update({ version: fresh.Version.Index, ...spec });
    }
  }
  require('./audit').logAction({ sourceIp, server: serverId, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: 'swarm_autoscale_rule', details: { ...r, spread: !!body.spread } });
  return getRule(svc.ID);
}

async function removeRule(serviceId, { sourceIp } = {}) {
  const { clusterId, serverId, c } = await context();
  const svc = await c.getService(serviceId).inspect().catch(() => ({ ID: serviceId, Spec: { Name: serviceId } }));
  q.del.run(clusterId, svc.ID);
  buffers.delete(`${clusterId}:${svc.ID}`);
  require('./audit').logAction({ sourceIp, server: serverId, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: 'swarm_autoscale_off', details: {} });
  return { ok: true };
}

/** The rules of the swarm in use, by service ID (for the Services list). */
async function listRules() {
  const { clusterId } = await context();
  const out = {};
  for (const row of q.all.all(clusterId)) out[row.service_id] = fromRow(row);
  return out;
}

module.exports = { DEFAULTS, validate, decide, getRule, saveRule, removeRule, listRules, tick, start, _measure: measure };
