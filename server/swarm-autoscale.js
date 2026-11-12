// Swarm autoscale: Docker Swarm has no autoscaler, so DockGate scales replicated services by their own load.
//
// A rule per service:
//   - min / max replicas, and how many replicas one change adds or removes (step);
//   - add when CPU is at or above `cpuUp` — and/or memory at or above `memUp` — for `upMinutes`;
//     measured as the average of the replicas, or "every replica is busy" (the least busy one is over);
//   - remove when CPU is at or below `cpuDown` and memory at or below `memDown` (both) for `downMinutes`;
//   - wait `coolUpMinutes` after adding and `coolDownMinutes` after removing before the next change.
// CPU per replica is the % of its CPU limit (or of one core without one); memory is the % of its memory
// limit (no limit → memory is not used). Only the service under load changes; the others are left alone.
//
// The engine runs on the manager the rule was saved on, whatever server is picked at the top. CPU and
// memory come from `docker stats` on each node's DockGate server: tasks on nodes not in DockGate are left
// out of the numbers. A replica that fits on no server waits as pending; that is recorded and notified.
const { db, stmts } = require('./db');
const dockerService = require('./docker');

db.exec(`CREATE TABLE IF NOT EXISTS swarm_autoscale (
  cluster_id TEXT NOT NULL, service_id TEXT NOT NULL, service_name TEXT, server_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, min_r INTEGER NOT NULL, max_r INTEGER NOT NULL,
  cpu_up INTEGER NOT NULL, cpu_down INTEGER NOT NULL, up_min INTEGER NOT NULL, down_min INTEGER NOT NULL, cooldown_min INTEGER NOT NULL,
  last_at INTEGER, last_action TEXT, last_reason TEXT, updated_at INTEGER,
  PRIMARY KEY (cluster_id, service_id)
)`);
// v2 columns (added to tables made by 2.41)
for (const [col, def] of [['mem_up', 'INTEGER'], ['mem_down', 'INTEGER'], ['logic', "TEXT NOT NULL DEFAULT 'or'"], ['basis', "TEXT NOT NULL DEFAULT 'average'"],
  ['step', 'INTEGER NOT NULL DEFAULT 1'], ['cool_up', 'INTEGER'], ['cool_down', 'INTEGER'], ['last_dir', 'TEXT']]) {
  try { db.exec(`ALTER TABLE swarm_autoscale ADD COLUMN ${col} ${def}`); } catch (e) { /* already there */ }
}
db.exec('UPDATE swarm_autoscale SET cool_up = cooldown_min WHERE cool_up IS NULL');
db.exec('UPDATE swarm_autoscale SET cool_down = MAX(cooldown_min, 5) WHERE cool_down IS NULL');
db.exec(`CREATE TABLE IF NOT EXISTS swarm_autoscale_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, service_id TEXT NOT NULL, t INTEGER NOT NULL,
  from_r INTEGER, to_r INTEGER, reason TEXT, ok INTEGER NOT NULL DEFAULT 1
)`);
try { db.exec('ALTER TABLE swarm_autoscale_log ADD COLUMN service_name TEXT'); } catch (e) { /* already there */ }
db.exec('CREATE INDEX IF NOT EXISTS swarm_autoscale_log_idx ON swarm_autoscale_log (cluster_id, service_id, t)');
const q = {
  get: db.prepare('SELECT * FROM swarm_autoscale WHERE cluster_id = ? AND service_id = ?'),
  all: db.prepare('SELECT * FROM swarm_autoscale WHERE cluster_id = ? ORDER BY service_name'),
  enabled: db.prepare('SELECT * FROM swarm_autoscale WHERE enabled = 1'),
  upsert: db.prepare(`INSERT INTO swarm_autoscale (cluster_id, service_id, service_name, server_id, enabled, min_r, max_r, cpu_up, cpu_down, mem_up, mem_down, logic, basis, step,
      up_min, down_min, cooldown_min, cool_up, cool_down, updated_at)
    VALUES (@cluster_id, @service_id, @service_name, @server_id, @enabled, @min_r, @max_r, @cpu_up, @cpu_down, @mem_up, @mem_down, @logic, @basis, @step,
      @up_min, @down_min, @cool_up, @cool_up, @cool_down, @updated_at)
    ON CONFLICT(cluster_id, service_id) DO UPDATE SET service_name = excluded.service_name, server_id = excluded.server_id, enabled = excluded.enabled,
      min_r = excluded.min_r, max_r = excluded.max_r, cpu_up = excluded.cpu_up, cpu_down = excluded.cpu_down, mem_up = excluded.mem_up, mem_down = excluded.mem_down,
      logic = excluded.logic, basis = excluded.basis, step = excluded.step, up_min = excluded.up_min, down_min = excluded.down_min,
      cooldown_min = excluded.cooldown_min, cool_up = excluded.cool_up, cool_down = excluded.cool_down, updated_at = excluded.updated_at`),
  setEnabled: db.prepare('UPDATE swarm_autoscale SET enabled = ?, updated_at = ? WHERE cluster_id = ? AND service_id = ?'),
  del: db.prepare('DELETE FROM swarm_autoscale WHERE cluster_id = ? AND service_id = ?'),
  last: db.prepare('UPDATE swarm_autoscale SET last_at = ?, last_action = ?, last_reason = ?, last_dir = ? WHERE cluster_id = ? AND service_id = ?'),
  log: db.prepare('INSERT INTO swarm_autoscale_log (cluster_id, service_id, service_name, t, from_r, to_r, reason, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  recent: db.prepare('SELECT service_id, service_name, t, from_r, to_r, reason, ok FROM swarm_autoscale_log WHERE cluster_id = ? AND service_id = ? ORDER BY t DESC LIMIT 50'),
  recentAll: db.prepare('SELECT service_id, service_name, t, from_r, to_r, reason, ok FROM swarm_autoscale_log WHERE cluster_id = ? ORDER BY t DESC LIMIT 200'),
  trim: db.prepare('DELETE FROM swarm_autoscale_log WHERE t < ?'),
};

const DEFAULTS = { min: 1, max: 5, cpuUp: 75, cpuDown: 25, memUp: null, memDown: null, logic: 'or', basis: 'average', step: 1, upMinutes: 5, downMinutes: 10, coolUpMinutes: 3, coolDownMinutes: 10 };
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const setting = (k, def) => { try { const r = stmts.getSetting.get(k); return r ? r.value : def; } catch (e) { return def; } };
const isPaused = () => setting('swarm_autoscale_paused', 'false') === 'true';
const intervalSec = () => (Number(setting('swarm_autoscale_interval', '60')) === 30 ? 30 : 60);
const pendingPolicy = () => (setting('swarm_autoscale_pending', 'wait') === 'skip' ? 'skip' : 'wait');

/** Check and normalise a rule from the form. Throws 400 with the reason. */
function validate(body = {}) {
  const int = (v, name, lo, hi, def) => {
    const n = v === undefined || v === null || v === '' ? def : Number(v);
    if (n === null) return null;
    if (!Number.isInteger(n) || n < lo || n > hi) throw bad(400, `${name}: a whole number from ${lo} to ${hi}`);
    return n;
  };
  const coolLegacy = body.cooldownMinutes; // 2.41 forms sent one wait
  const r = {
    enabled: body.enabled === undefined ? true : !!body.enabled,
    min: int(body.min, 'Minimum replicas', 1, 100, DEFAULTS.min),
    max: int(body.max, 'Maximum replicas', 1, 100, DEFAULTS.max),
    cpuUp: int(body.cpuUp, 'Add at CPU %', 10, 100, DEFAULTS.cpuUp),
    cpuDown: int(body.cpuDown, 'Remove at CPU %', 1, 90, DEFAULTS.cpuDown),
    memUp: body.memUp === '' || body.memUp === undefined || body.memUp === null || body.memUp === false ? null : int(body.memUp, 'Add at memory %', 10, 100, null),
    memDown: body.memDown === '' || body.memDown === undefined || body.memDown === null ? null : int(body.memDown, 'Remove at memory %', 1, 90, null),
    logic: body.logic === 'and' ? 'and' : 'or',
    basis: body.basis === 'every' ? 'every' : 'average',
    step: int(body.step, 'Replicas per change', 1, 5, DEFAULTS.step),
    upMinutes: int(body.upMinutes, 'Add after (minutes)', 1, 30, DEFAULTS.upMinutes),
    downMinutes: int(body.downMinutes, 'Remove after (minutes)', 2, 60, DEFAULTS.downMinutes),
    coolUpMinutes: int(body.coolUpMinutes ?? coolLegacy, 'Wait after adding (minutes)', 1, 60, DEFAULTS.coolUpMinutes),
    coolDownMinutes: int(body.coolDownMinutes ?? coolLegacy, 'Wait after removing (minutes)', 1, 60, DEFAULTS.coolDownMinutes),
  };
  if (r.max < r.min) throw bad(400, 'The maximum must be at least the minimum');
  if (r.cpuDown > r.cpuUp - 10) throw bad(400, 'Remove at a CPU % at least 10 below the add %, or the service would go up and down');
  if (r.memUp !== null) {
    if (r.memDown === null) r.memDown = Math.max(1, r.memUp - 30);
    if (r.memDown > r.memUp - 10) throw bad(400, 'Remove at a memory % at least 10 below the add %, or the service would go up and down');
  } else r.memDown = null;
  return r;
}

const fromRow = (row) => row && ({
  serviceId: row.service_id, serviceName: row.service_name, serverId: row.server_id, enabled: !!row.enabled,
  min: row.min_r, max: row.max_r, cpuUp: row.cpu_up, cpuDown: row.cpu_down, memUp: row.mem_up ?? null, memDown: row.mem_down ?? null,
  logic: row.logic || 'or', basis: row.basis || 'average', step: row.step || 1, upMinutes: row.up_min, downMinutes: row.down_min,
  coolUpMinutes: row.cool_up ?? row.cooldown_min, coolDownMinutes: row.cool_down ?? row.cooldown_min,
  lastAt: row.last_at || null, lastAction: row.last_action || null, lastReason: row.last_reason || null, lastDir: row.last_dir || null,
});

/**
 * The change due now, or null. Pure (unit tested).
 * samples: [{ t, cpu, cpuMin, cpuMax, mem, memMin, memMax }] one per check (cpu/mem are averages; mem null = no limit).
 * last: { at, dir: 'up'|'down' } of the last change. Out of the min–max range is put right at once.
 */
function decide(rule, samples, replicas, now = Date.now(), last = {}, everyMs = 60000) {
  if (replicas < rule.min) return { to: rule.min, action: 'up', reason: `below the minimum of ${rule.min}` };
  if (replicas > rule.max) return { to: rule.max, action: 'down', reason: `above the maximum of ${rule.max}` };
  if (last.at) {
    const wait = (last.dir === 'down' ? rule.coolDownMinutes : rule.coolUpMinutes) * 60000;
    if (now - last.at < wait) return null;
  }
  const win = (m) => samples.filter(s => s.t > now - m * 60000 && Number.isFinite(s.cpu));
  const enough = (l, m) => l.length >= Math.max(2, Math.floor(m * 60000 / everyMs) - 1); // allow one missed check
  const avg = (l, k) => Math.round(l.reduce((a, s) => a + (s[k] ?? 0), 0) / l.length);
  const every = rule.basis === 'every';
  const memOn = rule.memUp !== null && rule.memUp !== undefined;
  const up = win(rule.upMinutes);
  if (replicas < rule.max && enough(up, rule.upMinutes)) {
    const cpuV = avg(up, every ? 'cpuMin' : 'cpu');
    const memL = up.filter(s => Number.isFinite(s.mem));
    const memV = memOn && memL.length >= Math.ceil(up.length / 2) ? avg(memL, every ? 'memMin' : 'mem') : null;
    const cpuHot = cpuV >= rule.cpuUp, memHot = memV !== null && memV >= rule.memUp;
    const hot = rule.logic === 'and' && memOn ? (cpuHot && memHot) : (cpuHot || memHot);
    if (hot) {
      const what = [cpuHot ? `CPU ${cpuV}%` : null, memHot ? `memory ${memV}%` : null].filter(Boolean).join(' and ');
      return { to: Math.min(rule.max, replicas + rule.step), action: 'up', reason: `${what} ${every ? 'on every replica' : 'per replica'} for ${rule.upMinutes} min (add at CPU ${rule.cpuUp}%${memOn ? ` ${rule.logic} memory ${rule.memUp}%` : ''})` };
    }
  }
  const down = win(rule.downMinutes);
  if (replicas > rule.min && enough(down, rule.downMinutes)) {
    const cpuV = avg(down, every ? 'cpuMax' : 'cpu');
    const memL = down.filter(s => Number.isFinite(s.mem));
    const memV = memOn && memL.length ? avg(memL, every ? 'memMax' : 'mem') : null;
    const cpuLow = cpuV <= rule.cpuDown, memLow = !memOn || (memV !== null && memV <= rule.memDown);
    if (cpuLow && memLow) {
      return { to: Math.max(rule.min, replicas - rule.step), action: 'down', reason: `CPU ${cpuV}%${memOn ? ` and memory ${memV}%` : ''} ${every ? 'on every replica' : 'per replica'} for ${rule.downMinutes} min (remove at CPU ${rule.cpuDown}%${memOn ? ` and memory ${rule.memDown}%` : ''})` };
    }
  }
  return null;
}

// ---- reading on the rule's manager ----
function serverRow(id) { return !id || id === 'local' ? { id: 'local', type: 'local', name: 'Local' } : stmts.getServer.get(id); }
function clientFor(id) { const row = serverRow(id); if (!row) throw bad(404, 'The manager server of this rule is no longer in DockGate'); return row.id === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(row); }
function nodeServers(clusterId, selfNode, managerServerId) {
  const map = new Map();
  try { for (const r of db.prepare('SELECT node_id, server_id FROM swarm_node_servers WHERE cluster_id = ?').all(clusterId)) map.set(r.node_id, r.server_id); } catch (e) { /* no table yet */ }
  if (selfNode) map.set(selfNode, managerServerId);
  return map;
}
const limitsOf = (svc) => { const r = ((svc.Spec.TaskTemplate || {}).Resources) || {}; return { cpu: ((r.Limits || {}).NanoCPUs || 0) / 1e9, mem: (r.Limits || {}).MemoryBytes || 0, cpuRes: ((r.Reservations || {}).NanoCPUs || 0) / 1e9, memRes: (r.Reservations || {}).MemoryBytes || 0 }; };

/** CPU and memory per replica of a service: averages, least and most busy replica. */
async function measure(mgrClient, clusterId, managerServerId, svc) {
  const lim = limitsOf(svc);
  const tasks = await mgrClient.listTasks({ filters: JSON.stringify({ service: [svc.ID], 'desired-state': ['running'] }) });
  const running = tasks.filter(t => t.Status.State === 'running');
  const info = await mgrClient.info();
  const map = nodeServers(clusterId, info.Swarm && info.Swarm.NodeID, managerServerId);
  const servers = new Set(running.map(t => map.get(t.NodeID)).filter(Boolean));
  const cpu = [], mem = [];
  await Promise.all([...servers].map(async (sid) => {
    try {
      const c = sid === managerServerId ? mgrClient : clientFor(sid);
      const list = await c.listContainers({ filters: JSON.stringify({ label: [`com.docker.swarm.service.id=${svc.ID}`] }) });
      await Promise.all(list.map(async (ct) => {
        try {
          const st = dockerService.parseStats(await c.getContainer(ct.Id).stats({ stream: false }));
          cpu.push(lim.cpu ? (st.cpuPercent || 0) / lim.cpu : (st.cpuPercent || 0));
          if (lim.mem) mem.push((st.memoryUsage || 0) / lim.mem * 100);
        } catch (e) { /* stopped meanwhile */ }
      }));
    } catch (e) { /* that server is not reachable now */ }
  }));
  const r1 = (v) => Math.round(v * 10) / 10;
  const stat = (l) => (l.length ? { avg: r1(l.reduce((a, b) => a + b, 0) / l.length), min: r1(Math.min(...l)), max: r1(Math.max(...l)) } : null);
  const c = stat(cpu), m = stat(mem);
  const pending = tasks.filter(t => t.Status.State === 'pending' && t.Status.Err).map(t => t.Status.Err)[0] || null;
  return { tasks: running.length, measured: cpu.length, pending, cpu: c ? c.avg : null, cpuMin: c ? c.min : null, cpuMax: c ? c.max : null, mem: m ? m.avg : null, memMin: m ? m.min : null, memMax: m ? m.max : null, limits: lim };
}

/** Free CPU and memory on the active, ready servers (capacity minus reservations of what runs there). */
async function capacity(c) {
  const [list, tasks] = await Promise.all([c.listNodes(), c.listTasks({ filters: JSON.stringify({ 'desired-state': ['running'] }) })]);
  const used = new Map();
  for (const t of tasks) {
    if (!['running', 'starting', 'assigned', 'accepted', 'preparing', 'ready'].includes(t.Status.State)) continue;
    const res = ((t.Spec || {}).Resources || {}).Reservations || {};
    const u = used.get(t.NodeID) || { cpu: 0, mem: 0 }; u.cpu += (res.NanoCPUs || 0) / 1e9; u.mem += res.MemoryBytes || 0; used.set(t.NodeID, u);
  }
  const nodes = list.map(n => {
    const r = n.Description.Resources || {}; const u = used.get(n.ID) || { cpu: 0, mem: 0 };
    const active = n.Status.State === 'ready' && n.Spec.Availability === 'active';
    return { id: n.ID, hostname: n.Description.Hostname, active, cpu: (r.NanoCPUs || 0) / 1e9, mem: r.MemoryBytes || 0, cpuReserved: Math.round(u.cpu * 100) / 100, memReserved: u.mem };
  });
  const act = nodes.filter(n => n.active);
  const sum = (k) => act.reduce((a, n) => a + n[k], 0);
  return { nodes, cpu: sum('cpu'), mem: sum('mem'), cpuReserved: Math.round(sum('cpuReserved') * 100) / 100, memReserved: sum('memReserved'),
    cpuFree: Math.max(0, Math.round((sum('cpu') - sum('cpuReserved')) * 100) / 100), memFree: Math.max(0, sum('mem') - sum('memReserved')) };
}
/** How many more replicas with this guarantee fit, server by server. null = no guarantee set (unknown). */
function room(cap, cpuRes, memRes) {
  if (!cpuRes && !memRes) return null;
  return cap.nodes.filter(n => n.active).reduce((a, n) => {
    const byCpu = cpuRes ? Math.floor((n.cpu - n.cpuReserved) / cpuRes + 1e-9) : Infinity;
    const byMem = memRes ? Math.floor((n.mem - n.memReserved) / memRes) : Infinity;
    return a + Math.max(0, Math.min(byCpu, byMem));
  }, 0);
}


// ---- suggestions from the last 48 hours (Services → Graphs samples, every 2 minutes) ----
const MBy = 1048576;
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p / 100 * a.length) - 1))]; };
const up = (v, step) => Math.ceil(v / step - 1e-9) * step;
const r2 = (v) => Math.round(v * 100) / 100;
/**
 * Values for a rule from what the services really used. list: [{ name, replicas, samples: [{ t, cpu (% of a core, all tasks), mem (bytes, all tasks), tasks }] }].
 * Pure: the caller passes the capacity. Returns { enough, hours, values, why, notes }.
 */
function suggestFrom(list, cap, thresholds = { cpuUp: 80, memUp: 70 }) {
  const per = list.map((svc) => {
    const rows = (svc.samples || []).filter(s => s.tasks > 0 && Number.isFinite(s.cpu));
    const taskCpu = rows.map(s => s.cpu / 100 / s.tasks), taskMem = rows.map(s => (s.mem || 0) / s.tasks);
    const totCpu = rows.map(s => s.cpu / 100), totMem = rows.map(s => s.mem || 0);
    const span = rows.length ? (rows[rows.length - 1].t - rows[0].t) / 3600000 : 0;
    return { name: svc.name, replicas: svc.replicas, n: rows.length, span,
      cpu50: pct(taskCpu, 50), cpu95: pct(taskCpu, 95), mem50: pct(taskMem, 50), memMax: taskMem.length ? Math.max(...taskMem) : 0,
      tot50: pct(totCpu, 50), tot95: pct(totCpu, 95), totMem50: pct(totMem, 50), totMemMax: totMem.length ? Math.max(...totMem) : 0 };
  });
  const enough = per.length > 0 && per.every(x => x.n >= 30); // about an hour of readings
  const hours = per.length ? Math.round(Math.min(...per.map(x => x.span)) * 10) / 10 : 0;
  if (!enough) return { enough, hours, per: per.map(x => ({ name: x.name, readings: x.n })), values: null, why: {}, notes: [] };
  const big = per.reduce((a, x) => (x.cpu95 > a.cpu95 ? x : a), per[0]);
  const bigMem = per.reduce((a, x) => (x.memMax > a.memMax ? x : a), per[0]);
  const maxNode = Math.max(0.1, ...cap.nodes.filter(n => n.active).map(n => n.cpu));
  const cpuLimit = r2(Math.min(maxNode, Math.max(0.1, up(big.cpu95 * 1.5, 0.05))));
  const cpuReserve = r2(Math.min(cpuLimit, Math.max(0.05, up(big.cpu50, 0.05))));
  const memLimitMb = Math.max(64, up(bigMem.memMax * 1.5 / MBy, 64));
  const memReserveMb = Math.min(memLimitMb, Math.max(32, up(bigMem.mem50 / MBy, 32)));
  const atCpu = cpuLimit * thresholds.cpuUp / 100, atMem = memLimitMb * MBy * thresholds.memUp / 100;
  // memory counts towards the number of replicas only when it rises with load: a fixed amount per replica does not split
  const memSwing = bigMem.mem50 > 0 && bigMem.memMax > bigMem.mem50 * 1.5;
  const byMem = (v) => (memSwing ? Math.ceil(v / atMem - 1e-9) : 0);
  const min = Math.max(1, ...per.map(x => Math.max(Math.ceil(x.tot50 / atCpu - 1e-9), byMem(x.totMem50))));
  const need = Math.max(1, ...per.map(x => Math.max(Math.ceil(x.tot95 / atCpu - 1e-9), byMem(x.totMemMax))));
  let max = Math.max(min + 1, 2, Math.ceil(need * 1.5));
  const fit = room(cap, cpuReserve, memReserveMb * MBy);
  const notes = [];
  const running = per.reduce((a, x) => a + x.replicas, 0);
  if (fit !== null && max > min && max - min > fit) {
    const capped = Math.max(min, min + fit);
    notes.push(`Only ${fit} more replica${fit === 1 ? '' : 's'} fit on the servers, so the maximum is ${capped} instead of ${max}.`);
    max = capped;
  }
  if (per.length > 1) notes.push(`One rule gives every chosen service the same limits; they are sized for the busiest (${big.name}${bigMem !== big ? `, memory for ${bigMem.name}` : ''}).`);
  if (big.cpu95 < 0.02) notes.push('These services were almost idle: the numbers are a safe start, check them again after a busy day.');
  const cores = (v) => (v < 0.01 ? 'under 0.01 CPU' : `${r2(v)} CPU`);
  const mbs = (v) => (v < MBy ? 'under 1 MB' : `${Math.round(v / MBy)} MB`);
  const cpuFloor = big.cpu95 * 1.5 < 0.1, memFloor = bigMem.memMax * 1.5 / MBy < 64;
  return {
    enough, hours, notes,
    values: { cpuLimit, cpuReserve, memLimit: memLimitMb, memReserve: memReserveMb, min, max, memOn: memSwing },
    why: {
      cpuLimit: `${big.name} used up to ${cores(big.cpu95)} per replica (95% of the time) — ${cpuFloor ? 'the smallest sensible limit' : 'limit is 1.5×'}`,
      cpuReserve: `usual use per replica: ${cores(big.cpu50)}${big.cpu50 < 0.05 ? ' — the smallest sensible guarantee' : ''}`,
      memLimit: `peak ${mbs(bigMem.memMax)} per replica — ${memFloor ? 'the smallest sensible limit' : 'limit is 1.5×'}`,
      memReserve: `usual memory per replica: ${mbs(bigMem.mem50)}${bigMem.mem50 < 32 * MBy ? ' — the smallest sensible guarantee' : ''}`,
      min: `the usual load fits in ${min} replica${min === 1 ? '' : 's'} at ${thresholds.cpuUp}% CPU`,
      max: `the busiest moment needed ${need} — maximum is 1.5× that${notes.length && /fit on the servers/.test(notes[0]) ? ', cut to what fits' : ''}`,
      memOn: memSwing ? `memory went from ${mbs(bigMem.mem50)} to ${mbs(bigMem.memMax)}: it rises with load` : 'memory stayed about the same: CPU alone is enough',
    },
    running,
  };
}
async function suggest(serviceIds) {
  const { clusterId, c } = await context();
  const ids = [...new Set((Array.isArray(serviceIds) ? serviceIds : [serviceIds]).filter(Boolean))];
  if (!ids.length) throw bad(400, 'Choose at least one service');
  const since = Date.now() - 48 * 3600000;
  const list = [];
  for (const id of ids) {
    const svc = await c.getService(id).inspect();
    const samples = db.prepare('SELECT t, cpu, mem, tasks FROM swarm_service_samples WHERE cluster_id = ? AND service_id = ? AND t >= ? ORDER BY t').all(clusterId, svc.ID, since);
    list.push({ name: svc.Spec.Name, replicas: svc.Spec.Mode.Replicated ? svc.Spec.Mode.Replicated.Replicas : 0, samples });
  }
  return suggestFrom(list, await capacity(c));
}

// ---- the engine ----
const buffers = new Map(); // `${cluster}:${service}` → samples, last hour
const lastSeen = new Map(); // same key → last measure
let timer = null, busy = false;

async function scaleTo(c, svc, to) {
  const spec = JSON.parse(JSON.stringify(svc.Spec));
  spec.Mode = { Replicated: { Replicas: to } };
  await c.getService(svc.ID).update({ version: svc.Version.Index, ...spec });
}
async function notify(row, svc, subject, text, html) {
  try { const HM = require('./notifications/health-monitor'); await HM.deliver('swarm_autoscale', serverRow(row.server_id), subject, text, html, { always: true }); } catch (e) { /* best effort */ }
}
function record(row, svc, now, from, to, reason, ok, dir) {
  if (dir) q.last.run(now, ok ? `${from} → ${to}` : 'failed', reason, dir, row.cluster_id, row.service_id);
  q.log.run(row.cluster_id, row.service_id, svc.Spec.Name, now, from, to, reason, ok ? 1 : 0);
  try { require('./audit').logAction({ sourceIp: 'autoscale', server: row.server_id, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: 'swarm_autoscale', details: { from, to, reason, ok: !!ok } }); } catch (e) { /* best effort */ }
}

async function tickRule(row, now) {
  const key = `${row.cluster_id}:${row.service_id}`;
  const rule = fromRow(row);
  const c = clientFor(row.server_id);
  let svc;
  try { svc = await c.getService(row.service_id).inspect(); }
  catch (e) { if (e.statusCode === 404) { q.del.run(row.cluster_id, row.service_id); buffers.delete(key); } return; } // service gone: so is its rule
  if (!svc.Spec.Mode.Replicated) return;
  const us = svc.UpdateStatus && svc.UpdateStatus.State;
  if (us === 'updating' || us === 'rollback_started') return; // never during a rolling update
  const m = await measure(c, row.cluster_id, row.server_id, svc);
  const prev = lastSeen.get(key);
  lastSeen.set(key, { ...m, at: now });
  // A replica added earlier that fits nowhere: say so once.
  if (m.pending && !(prev && prev.pending)) {
    record(row, svc, now, m.tasks, svc.Spec.Mode.Replicated.Replicas, `not placed: ${m.pending}`, 0, null);
    await notify(row, svc, `${svc.Spec.Name}: a replica does not fit`, `🟠 ${svc.Spec.Name}: a new replica waits — ${m.pending}`, `<p><b>${svc.Spec.Name}</b>: a new replica waits.</p><p>${m.pending}</p>`);
  }
  const buf = (buffers.get(key) || []).filter(s => s.t > now - 3600000);
  if (m.cpu !== null) buf.push({ t: now, cpu: m.cpu, cpuMin: m.cpuMin, cpuMax: m.cpuMax, mem: m.mem, memMin: m.memMin, memMax: m.memMax });
  buffers.set(key, buf);
  const replicas = svc.Spec.Mode.Replicated.Replicas;
  const d = decide(rule, buf, replicas, now, { at: rule.lastAt, dir: rule.lastDir }, intervalSec() * 1000);
  if (!d || d.to === replicas) return;
  if (d.action === 'up' && pendingPolicy() === 'skip' && m.pending) return; // the last one does not fit yet: do not ask for more
  let ok = 1, reason = d.reason;
  try { await scaleTo(c, svc, d.to); }
  catch (e) { ok = 0; reason = `${d.reason} — scaling failed: ${String(e.message || e).slice(0, 200)}`; }
  record(row, svc, now, replicas, d.to, reason, ok, d.action);
  buffers.set(key, []); // measure the new number of replicas from scratch
  const verb = !ok ? '🔴 could not scale' : d.action === 'up' ? '🔼 scaled up' : '🔽 scaled down';
  await notify(row, svc, `${svc.Spec.Name} ${ok ? `${replicas} → ${d.to} replicas` : 'autoscale failed'}`, `${verb}: ${svc.Spec.Name}\n${replicas} → ${d.to} replicas\n${reason}`, `<p><b>${verb}</b>: ${svc.Spec.Name}</p><p>${replicas} → ${d.to} replicas</p><p>${reason}</p>`);
}

async function tick(now = Date.now()) {
  if (busy || isPaused()) return;
  busy = true;
  try {
    for (const row of q.enabled.all()) {
      try { await tickRule(row, now); } catch (e) { console.warn('[autoscale]', row.service_name, e.message); }
    }
    q.trim.run(now - 30 * 24 * 3600000);
  } finally { busy = false; }
}
function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick(), intervalSec() * 1000);
  if (timer.unref) timer.unref();
}

// ---- API (the server in use must be a manager: rules are saved for its cluster) ----
async function context() {
  const st = await require('./swarm').status();
  if (st.state !== 'active' || !st.manager || !st.clusterId) throw bad(409, 'Swarm must be active and the server in use a manager');
  return { clusterId: st.clusterId, serverId: st.serverId || dockerService.getActiveServerId() || 'local', c: dockerService.docker };
}
const isDb = (img) => require('./swarm-services').isDatabase(img);

/** What a rule's row shows: replicas, numbers now, room, and a state in words. */
function stateOf(rule, svc, seen, rm, now) {
  const replicas = svc.Spec.Mode.Replicated ? svc.Spec.Mode.Replicated.Replicas : null;
  if (isPaused()) return ['off', 'all paused'];
  if (!rule.enabled) return ['off', 'paused'];
  if (seen && seen.pending) return ['bad', 'a replica does not fit'];
  if (seen && seen.measured === 0) return ['warn', 'not measured'];
  if (rule.lastAt) { const wait = (rule.lastDir === 'down' ? rule.coolDownMinutes : rule.coolUpMinutes) * 60000; if (now - rule.lastAt < wait) return ['info', `next change in ${Math.ceil((wait - (now - rule.lastAt)) / 60000)} min`]; }
  const hotCpu = seen && seen.cpu !== null && seen.cpu >= rule.cpuUp, hotMem = seen && rule.memUp !== null && seen.mem !== null && seen.mem >= rule.memUp;
  if ((hotCpu || hotMem) && replicas >= rule.max) return ['warn', 'busy, at the maximum'];
  if ((hotCpu || hotMem) && rm === 0) return ['bad', 'busy, no room'];
  if (hotCpu || hotMem) return ['warn', `busy: adds after ${rule.upMinutes} min`];
  if (!seen) return ['info', 'first reading soon'];
  const coldMem = rule.memDown === null || seen.mem === null || seen.mem <= rule.memDown;
  if (seen.cpu !== null && seen.cpu <= rule.cpuDown && coldMem && replicas > rule.min) return ['info', `quiet: removes after ${rule.downMinutes} min`];
  return ['ok', 'steady'];
}

async function overview() {
  const { clusterId, c } = await context();
  const cap = await capacity(c);
  const now = Date.now();
  const rows = q.all.all(clusterId);
  const rules = [];
  for (const row of rows) {
    const rule = fromRow(row);
    const svc = await c.getService(row.service_id).inspect().catch(() => null);
    if (!svc) continue;
    const lim = limitsOf(svc);
    const seen = lastSeen.get(`${clusterId}:${row.service_id}`) || null;
    const rm = room(cap, lim.cpuRes, lim.memRes);
    rules.push({ ...rule, replicas: svc.Spec.Mode.Replicated ? svc.Spec.Mode.Replicated.Replicas : null, limits: lim, now: seen, room: rm, state: stateOf(rule, svc, seen, rm, now) });
  }
  const services = (await c.listServices()).filter(s => s.Spec.Mode.Replicated).map(s => ({ id: s.ID, name: s.Spec.Name, replicas: s.Spec.Mode.Replicated.Replicas,
    image: s.Spec.TaskTemplate.ContainerSpec.Image.split('@')[0], database: isDb(s.Spec.TaskTemplate.ContainerSpec.Image), hasVolume: (s.Spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume' || m.Type === 'bind'),
    limits: limitsOf(s), hasRule: rows.some(r => r.service_id === s.ID) })).sort((a, b) => a.name.localeCompare(b.name));
  // entries logged before 2.42 have no name: take it from the service or the rule
  const nameOf = id => (services.find(s => s.id === id) || {}).name || (rows.find(r => r.service_id === id) || {}).service_name || id.slice(0, 12);
  return {
    paused: isPaused(), interval: intervalSec(), pending: pendingPolicy(), defaults: DEFAULTS, capacity: cap, rules, services,
    history: q.recentAll.all(clusterId).map(r => ({ serviceId: r.service_id, service: r.service_name || nameOf(r.service_id), t: r.t, from: r.from_r, to: r.to_r, reason: r.reason, ok: !!r.ok })),
  };
}

async function getRule(serviceId) {
  const { clusterId, c } = await context();
  const svc = await c.getService(serviceId).inspect();
  const key = `${clusterId}:${svc.ID}`;
  const img = svc.Spec.TaskTemplate.ContainerSpec.Image || '';
  const prefs = (svc.Spec.TaskTemplate.Placement || {}).Preferences || [];
  return {
    rule: fromRow(q.get.get(clusterId, svc.ID)), defaults: DEFAULTS, paused: isPaused(),
    replicas: svc.Spec.Mode.Replicated ? svc.Spec.Mode.Replicated.Replicas : null, global: !svc.Spec.Mode.Replicated,
    database: isDb(img), hasVolume: (svc.Spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume' || m.Type === 'bind'),
    limits: limitsOf(svc), cpuLimit: limitsOf(svc).cpu || null,
    spread: prefs.some(p => p.Spread && p.Spread.SpreadDescriptor === 'node.id'),
    now: lastSeen.get(key) || null, samples: (buffers.get(key) || []).slice(-60),
    log: q.recent.all(clusterId, svc.ID).map(r => ({ t: r.t, from: r.from_r, to: r.to_r, reason: r.reason, ok: !!r.ok })),
  };
}

/** Set limits and guarantees per replica (only the ones given), and the spread preference. */
async function applyResources(c, svcId, res, spread) {
  const fresh = await c.getService(svcId).inspect();
  const spec = JSON.parse(JSON.stringify(fresh.Spec));
  let changed = false;
  if (res) {
    const R = spec.TaskTemplate.Resources = spec.TaskTemplate.Resources || {};
    const set = (grp, k, v) => { if (v === undefined || v === null || v === '') return; R[grp] = R[grp] || {}; if (R[grp][k] !== v) { R[grp][k] = v; changed = true; } };
    const cpu = (v, name) => { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); if (!Number.isFinite(n) || n < 0.01 || n > 256) throw bad(400, `${name}: CPU from 0.01 to 256`); return Math.round(n * 1e9); };
    const mb = (v, name) => { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); if (!Number.isFinite(n) || n < 6 || n > 1048576) throw bad(400, `${name}: MB from 6`); return Math.round(n * 1048576); };
    const lc = cpu(res.cpuLimit, 'CPU limit'), lm = mb(res.memLimit, 'Memory limit'), rc = cpu(res.cpuReserve, 'CPU guaranteed'), rm = mb(res.memReserve, 'Memory guaranteed');
    if (lc && rc && rc > lc) throw bad(400, 'The CPU guarantee can not be above the CPU limit');
    if (lm && rm && rm > lm) throw bad(400, 'The memory guarantee can not be above the memory limit');
    set('Limits', 'NanoCPUs', lc); set('Limits', 'MemoryBytes', lm); set('Reservations', 'NanoCPUs', rc); set('Reservations', 'MemoryBytes', rm);
  }
  if (spread) {
    spec.TaskTemplate.Placement = spec.TaskTemplate.Placement || {};
    const prefs = spec.TaskTemplate.Placement.Preferences || [];
    if (!prefs.some(p => p.Spread && p.Spread.SpreadDescriptor === 'node.id')) { spec.TaskTemplate.Placement.Preferences = [...prefs, { Spread: { SpreadDescriptor: 'node.id' } }]; changed = true; }
  }
  if (changed) await c.getService(svcId).update({ version: fresh.Version.Index, ...spec });
  return changed;
}

/** Save one rule for one or several services (each judged by its own load). */
async function saveRules(serviceIds, body, { sourceIp } = {}) {
  const { clusterId, serverId, c } = await context();
  const ids = [...new Set((Array.isArray(serviceIds) ? serviceIds : [serviceIds]).filter(Boolean))];
  if (!ids.length) throw bad(400, 'Choose at least one service');
  const r = validate(body);
  const res = body.resources || null;
  const svcs = [];
  for (const id of ids) {
    const svc = await c.getService(id).inspect();
    if (!svc.Spec.Mode.Replicated) throw bad(400, `${svc.Spec.Name} is global: it runs one task on every server — autoscale works for replicated services`);
    const img = svc.Spec.TaskTemplate.ContainerSpec.Image || '';
    if (isDb(img)) throw bad(400, `${svc.Spec.Name}: ${img.split(':')[0].split('@')[0]} looks like a database. More replicas would be separate databases, not copies — autoscale is not offered for it.`);
    const lim = limitsOf(svc);
    if (r.memUp !== null && !lim.mem && !(res && res.memLimit)) throw bad(400, `${svc.Spec.Name} has no memory limit: set one (Each replica) so memory % can be measured`);
    svcs.push(svc);
  }
  for (const svc of svcs) {
    await applyResources(c, svc.ID, res, !!body.spread);
    q.upsert.run({ cluster_id: clusterId, service_id: svc.ID, service_name: svc.Spec.Name, server_id: serverId, enabled: r.enabled ? 1 : 0, min_r: r.min, max_r: r.max,
      cpu_up: r.cpuUp, cpu_down: r.cpuDown, mem_up: r.memUp, mem_down: r.memDown, logic: r.logic, basis: r.basis, step: r.step,
      up_min: r.upMinutes, down_min: r.downMinutes, cool_up: r.coolUpMinutes, cool_down: r.coolDownMinutes, updated_at: Date.now() });
    require('./audit').logAction({ sourceIp, server: serverId, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: 'swarm_autoscale_rule', details: { ...r, resources: res || undefined, spread: !!body.spread } });
  }
  return { ok: true, saved: svcs.map(s => s.Spec.Name) };
}
async function saveRule(serviceId, body, opts) { await saveRules([serviceId], body, opts); return getRule(serviceId); }

async function setEnabled(serviceId, on, { sourceIp } = {}) {
  const { clusterId, serverId, c } = await context();
  const svc = await c.getService(serviceId).inspect().catch(() => ({ ID: serviceId, Spec: { Name: serviceId } }));
  if (!q.get.get(clusterId, svc.ID)) throw bad(404, 'This service has no autoscale rule');
  q.setEnabled.run(on ? 1 : 0, Date.now(), clusterId, svc.ID);
  require('./audit').logAction({ sourceIp, server: serverId, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: on ? 'swarm_autoscale_on' : 'swarm_autoscale_pause', details: {} });
  return { ok: true };
}

async function removeRule(serviceId, { sourceIp } = {}) {
  const { clusterId, serverId, c } = await context();
  const svc = await c.getService(serviceId).inspect().catch(() => ({ ID: serviceId, Spec: { Name: serviceId } }));
  q.del.run(clusterId, svc.ID);
  buffers.delete(`${clusterId}:${svc.ID}`);
  require('./audit').logAction({ sourceIp, server: serverId, resourceType: 'swarm-service', resourceId: svc.ID, resourceName: svc.Spec.Name, action: 'swarm_autoscale_off', details: {} });
  return { ok: true };
}

/** Pause all, check interval, what to do when a replica does not fit. */
function saveSettings(body = {}, { sourceIp } = {}) {
  if (body.paused !== undefined) stmts.setSetting.run('swarm_autoscale_paused', body.paused ? 'true' : 'false');
  if (body.interval !== undefined) { if (![30, 60].includes(Number(body.interval))) throw bad(400, 'Check every 30 or 60 seconds'); stmts.setSetting.run('swarm_autoscale_interval', String(Number(body.interval))); start(); }
  if (body.pending !== undefined) stmts.setSetting.run('swarm_autoscale_pending', body.pending === 'skip' ? 'skip' : 'wait');
  try { require('./audit').logAction({ sourceIp, resourceType: 'swarm', resourceName: 'autoscale', action: 'swarm_autoscale_settings', details: body }); } catch (e) { /* best effort */ }
  return { paused: isPaused(), interval: intervalSec(), pending: pendingPolicy() };
}

/** The rules of the swarm in use, by service ID (for the Services list). */
async function listRules() {
  const { clusterId } = await context();
  const out = {};
  for (const row of q.all.all(clusterId)) out[row.service_id] = fromRow(row);
  return out;
}

module.exports = { DEFAULTS, validate, decide, room, suggestFrom, suggest, overview, getRule, saveRule, saveRules, setEnabled, removeRule, saveSettings, listRules, tick, start, _measure: measure, _capacity: capacity };
