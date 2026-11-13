// Compose Auto Scaling, DockGate's side. The rule of a service (Off / Suggest / Auto, min–max, when to add and
// remove) is kept in compose_scaling and sent to the server's Edge agent with the other rules; the agent runs it,
// also while DockGate is offline. On a server without an up-to-date agent DockGate runs the very same loop
// (agent/src/control/autoscale.js) itself. Every decision lands in compose_scaling_log, and the number of replicas
// Auto Scaling chose is written to DockGate's override, so a later `docker compose up` through DockGate keeps it.
const fs = require('fs');
const { db, stmts } = require('./db');
const { Scaler, cleanAuto } = require('../agent/src/control/autoscale');
const { hostCapFrom } = require('../agent/src/control/measure');

for (const col of ['auto_json TEXT', 'sim_until INTEGER']) { try { db.exec(`ALTER TABLE compose_scaling ADD COLUMN ${col}`); } catch (e) { /* there */ } }
db.exec(`CREATE TABLE IF NOT EXISTS compose_scaling_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, project TEXT NOT NULL, service TEXT NOT NULL, t INTEGER NOT NULL,
  from_r INTEGER, to_r INTEGER, reason TEXT, mode TEXT, ok INTEGER, executor TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS compose_scaling_log_p ON compose_scaling_log (server_id, project, t)');
// Every 2 minutes, for services with a row in Scaling & health: replicas and their use against their own limits (48 h).
db.exec(`CREATE TABLE IF NOT EXISTS compose_service_samples (
  server_id TEXT NOT NULL, project TEXT NOT NULL, service TEXT NOT NULL, t INTEGER NOT NULL,
  replicas INTEGER, cpu REAL, cpu_max REAL, mem REAL, mem_max REAL
)`);
db.exec('CREATE INDEX IF NOT EXISTS compose_service_samples_k ON compose_service_samples (server_id, project, service, t)');
const q = {
  log: db.prepare('INSERT INTO compose_scaling_log (server_id, project, service, t, from_r, to_r, reason, mode, ok, executor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  history: db.prepare('SELECT service, t, from_r, to_r, reason, mode, ok, executor FROM compose_scaling_log WHERE server_id = ? AND project = ? ORDER BY t DESC LIMIT 100'),
  lastAgent: db.prepare("SELECT MAX(t) AS t FROM compose_scaling_log WHERE server_id = ? AND executor = 'agent'"),
  trim: db.prepare('DELETE FROM compose_scaling_log WHERE t < ?'),
  row: db.prepare('SELECT * FROM compose_scaling WHERE server_id = ? AND project = ? AND service = ?'),
  active: db.prepare("SELECT DISTINCT server_id FROM compose_scaling WHERE mode IS NOT NULL AND mode != 'off'"),
};
const bad = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });
const CS = () => require('./compose-scale');
const control = () => require('./agent/control');
const SIM_MS = 24 * 3600 * 1000;

/** The rule of a service as the panel shows it (null = none). */
function ruleOf(serverId, project, service) {
  const r = q.row.get(serverId, project, service);
  if (!r || !r.mode || r.mode === 'off') return null;
  let a = {}; try { a = JSON.parse(r.auto_json || '{}'); } catch (e) { /* none */ }
  return { ...cleanAuto({ ...a, mode: r.mode }), simulateUntil: r.sim_until || 0 };
}

/**
 * Check a rule from the form. Swarm's checks (thresholds 10 apart, waits…), Compose's range (1–20), and a limit on the
 * service — without one there is nothing to measure against.
 */
function validateRule(body, lim) {
  const mode = ['off', 'suggest', 'auto'].includes(body.mode) ? body.mode : null;
  if (!mode) throw bad('Mode: Off, Suggest or Auto');
  if (mode === 'off') return { mode };
  const v = require('./swarm-autoscale').validate(body);
  if (v.max > CS().MAX_REPLICAS) throw bad(`Maximum replicas: up to ${CS().MAX_REPLICAS} on one server`);
  if (!lim.cpu && !lim.mem) throw bad('This service has no CPU or memory limit in its compose file — Auto Scaling needs one to measure against (cpus / mem_limit, or deploy.resources.limits)');
  if (!lim.mem && v.memUp !== null) throw bad('Add at memory % needs a memory limit on the service');
  return { mode, ...v };
}

/** Save the rule of a service on the active server. body: the form, plus skipSimulation / startNow. */
async function saveRule(project, service, body = {}, { sourceIp } = {}) {
  const S = CS(), h = require('./routes/compose').composeHelpers;
  S.checkName(project, 'Project'); S.checkName(service, 'Service');
  const sid = require('./docker').getActiveServerId() || 'local';
  const r = await h.resolveComposeFiles(project);
  if (!r.files || !r.files.length) throw bad(r.reason || 'DockGate can not find the compose files of this project');
  const cfg = await S.configOf(r, project);
  const s = (cfg.services || {})[service];
  if (!s) throw bad(`No service ${service} in ${project}`, 404);
  const rule = validateRule(body, S.limitsOf(s));
  const prev = q.row.get(sid, project, service) || {};
  if (rule.mode !== 'off' && rule.max > 1) {
    const chk = S.checkScalable(s, service, await S.composeVersion(r));
    if (!chk.ok) throw bad(`${service}: ${chk.block}`, 409);
    const missing = chk.fixes.filter(f => !(f === 'dropPorts' ? prev.fix_ports : prev.fix_name));
    if (missing.length) throw bad(`${service} needs ${missing.map(f => (f === 'dropPorts' ? 'its host port moved behind the proxy' : 'its container_name dropped')).join(' and ')} before it can have more than one replica — press + once and accept the fix, then set the rule`, 409);
  }
  let sim = prev.sim_until || 0;
  if (rule.mode === 'auto' && prev.mode !== 'auto') sim = body.skipSimulation ? 0 : Date.now() + SIM_MS;
  if (rule.mode !== 'auto' || body.startNow) sim = 0;
  const { mode, ...auto } = rule;
  db.prepare(`INSERT INTO compose_scaling (server_id, project, service, mode, min_r, max_r, cpu_up, cpu_down, mem_up, mem_down, up_min, down_min, cool_up, cool_down, auto_json, sim_until, updated_at)
    VALUES (@sid, @project, @service, @mode, @min, @max, @cpuUp, @cpuDown, @memUp, @memDown, @upMinutes, @downMinutes, @coolUpMinutes, @coolDownMinutes, @json, @sim, @now)
    ON CONFLICT(server_id, project, service) DO UPDATE SET mode = excluded.mode, min_r = excluded.min_r, max_r = excluded.max_r, cpu_up = excluded.cpu_up, cpu_down = excluded.cpu_down,
      mem_up = excluded.mem_up, mem_down = excluded.mem_down, up_min = excluded.up_min, down_min = excluded.down_min, cool_up = excluded.cool_up, cool_down = excluded.cool_down,
      auto_json = excluded.auto_json, sim_until = excluded.sim_until, updated_at = excluded.updated_at`)
    .run({ sid, project, service, mode, min: mode === 'off' ? null : auto.min, max: mode === 'off' ? null : auto.max, cpuUp: auto.cpuUp ?? null, cpuDown: auto.cpuDown ?? null,
      memUp: auto.memUp ?? null, memDown: auto.memDown ?? null, upMinutes: auto.upMinutes ?? null, downMinutes: auto.downMinutes ?? null, coolUpMinutes: auto.coolUpMinutes ?? null,
      coolDownMinutes: auto.coolDownMinutes ?? null, json: mode === 'off' ? null : JSON.stringify(auto), sim, now: Date.now() });
  try { require('./audit').logAction({ sourceIp: sourceIp || 'dockgate', server: sid, resourceType: 'compose', resourceId: project, resourceName: `${project}/${service}`, action: 'compose_autoscale_rule', details: { mode, ...auto } }); } catch (e) { /* best effort */ }
  control().pushSoon(sid);
  return ruleOf(sid, project, service) || { mode: 'off' };
}

/**
 * Write the number Auto Scaling chose into DockGate's override (and its saved choice), without running compose, so
 * a later `docker compose up` through DockGate keeps it. Only the replicas line of that service changes.
 */
async function syncOverride(serverId, project, service, n) {
  const S = CS();
  db.prepare('UPDATE compose_scaling SET replicas = ?, updated_at = ? WHERE server_id = ? AND project = ? AND service = ?').run(n, Date.now(), serverId, project, service);
  const p = S.overridePath(serverId, project);
  const server = serverId === 'local' ? null : stmts.getServer.get(serverId);
  if (serverId !== 'local' && !server) return;
  let text = '';
  if (p.local) { try { text = fs.readFileSync(p.local, 'utf8'); } catch (e) { text = ''; } } else {
    const rc = require('./remote-compose');
    const abs = await rc.resolveRemotePath(server, p.remote);
    const x = await rc.execRemote(server, `cat ${rc.shq(abs)} 2>/dev/null`);
    text = x.code === 0 ? x.stdout : '';
  }
  const re = new RegExp(`(^  ${service}:\\n    deploy:\\n      replicas: )\\d+`, 'm');
  if (re.test(text)) text = text.replace(re, `$1${S.checkReplicas(n)}`);
  else if (text.includes('\nservices:\n')) text = text.replace('\nservices:\n', `\nservices:\n  ${service}:\n    deploy:\n      replicas: ${S.checkReplicas(n)}\n`);
  else text = S.buildOverride({ [service]: { replicas: n } });
  await S.writeOverride(server ? { server, remote: true } : {}, serverId, project, text);
}

function record(serverId, e, executor) {
  q.log.run(serverId, e.project, e.service, e.t || Date.now(), e.from ?? null, e.to ?? null, String(e.reason || '').slice(0, 500), e.mode || null, e.ok ? 1 : 0, executor);
}
async function notify(serverId, text) {
  try {
    const HM = require('./notifications/health-monitor');
    const s = serverId === 'local' ? { id: 'local', name: 'Local' } : stmts.getServer.get(serverId);
    if (s) await HM.deliver('compose_autoscale', s, text.replace(/^\W+\s*/, '').slice(0, 120), text, `<p>${text}</p>`, { always: true });
  } catch (e) { /* best effort */ }
}

/** What the agent did since the last look: into the log, and its replica numbers into the override. */
async function importAgent(serverId) {
  const view = await control().readState(serverId).catch(() => null);
  if (!view || !Array.isArray(view.history)) return 0;
  const since = q.lastAgent.get(serverId).t || 0;
  const fresh = view.history.filter(e => e.kind === 'autoscale' && e.t > since).sort((a, b) => a.t - b.t);
  const latest = {};
  for (const e of fresh) { record(serverId, e, 'agent'); if (e.mode === 'auto' && e.to !== e.from) latest[`${e.project}/${e.service}`] = e; }
  for (const e of Object.values(latest)) await syncOverride(serverId, e.project, e.service, e.to).catch(() => {});
  return fresh.length;
}

function history(serverId, project) { return q.history.all(serverId, project).map(({ from_r, to_r, ...r }) => ({ ...r, from: from_r, to: to_r, ok: !!r.ok })); }

// ---- DockGate as the executor (servers without an up-to-date agent) ----
function clientFor(serverId) {
  const ds = require('./docker');
  if (serverId === 'local') return ds.createLocalClient();
  const row = stmts.getServer.get(serverId);
  return row ? ds.createSshClient(row) : null;
}
async function readCap(serverId, docker) {
  const info = await docker.info();
  if (serverId === 'local') {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
    return hostCapFrom(info, read('/proc/meminfo'), read('/proc/loadavg'));
  }
  const rc = require('./remote-compose');
  const x = await rc.execRemote(stmts.getServer.get(serverId), 'cat /proc/meminfo; echo ===; cat /proc/loadavg').catch(() => ({ stdout: '' }));
  const [mem, load] = String(x.stdout || '').split('===');
  return hostCapFrom(info, mem, load);
}
const EVERY_MS = 60000;
const scalers = new Map(); // server → Scaler (its samples and waits live in memory)
let timer = null, running = false;

async function tick(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    for (const { server_id: sid } of q.active.all()) {
      if (control().executorFor(sid) === 'agent') { scalers.delete(sid); continue; } // the agent does it
      const docker = clientFor(sid); if (!docker) continue;
      let sc = scalers.get(sid);
      if (!sc) {
        sc = new Scaler({ docker, everyMs: EVERY_MS, state: {}, readCap: () => readCap(sid, docker),
          notify: (t) => notify(sid, t), record: (e) => record(sid, e, 'dockgate'),
          onChange: async (project, service, n) => {
            await syncOverride(sid, project, service, n).catch(e => console.warn('[compose-autoscale] override:', e.message));
            try { require('./audit').logAction({ sourceIp: 'autoscale', server: sid, resourceType: 'compose', resourceId: project, resourceName: `${project}/${service}`, action: 'compose_autoscale', details: { to: n } }); } catch (e) { /* best effort */ }
          } });
        scalers.set(sid, sc);
      }
      const busy = async (project) => {
        if (require('./routes/compose').composeHelpers.busy(project)) return true;
        const all = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) });
        return all.some(c => c.State === 'created' || c.State === 'restarting' || (now / 1000 - c.Created) < 120);
      };
      await sc.tick(control().buildRules(sid), now, busy).catch(e => console.warn('[compose-autoscale]', e.message));
    }
    q.trim.run(now - 30 * 24 * 3600 * 1000);
  } finally { running = false; }
}
// ---- suggestions from the last 48 hours ----
const SAMPLE_MS = 2 * 60 * 1000;
async function sampleTick(now = Date.now()) {
  const { measureService } = require('../agent/src/control/measure');
  const ins = db.prepare('INSERT INTO compose_service_samples (server_id, project, service, t, replicas, cpu, cpu_max, mem, mem_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const rows = db.prepare('SELECT DISTINCT server_id, project, service FROM compose_scaling').all();
  const clients = {};
  for (const r of rows) {
    const c = clients[r.server_id] = clients[r.server_id] || clientFor(r.server_id);
    if (!c) continue;
    const m = await measureService(c, r.project, r.service).catch(() => null);
    if (m && Number.isFinite(m.cpu)) ins.run(r.server_id, r.project, r.service, now, m.replicas, m.cpu, m.cpuMax, m.mem, m.memMax);
  }
  db.prepare('DELETE FROM compose_service_samples WHERE t < ?').run(now - 48 * 3600 * 1000);
}
const pctl = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p / 100 * a.length) - 1))]; };
/**
 * Replicas for a rule from what the service really did. samples: [{ t, replicas, cpu, mem }] — cpu / mem as % of one
 * replica's own limit (mem null without a memory limit). lim: the limits from the compose file (never suggested: they
 * are the user's). fits: replicas more that fit on the server, or Infinity. Pure.
 */
function suggestFrom(samples, lim = {}, fits = Infinity, { cpuUp = 70, cpuDown = 25, current = 1 } = {}) {
  const rows = (samples || []).filter(s => s.replicas > 0 && Number.isFinite(s.cpu));
  const hours = rows.length > 1 ? Math.round((rows[rows.length - 1].t - rows[0].t) / 360000) / 10 : 0;
  if (rows.length < 30) return { enough: false, readings: rows.length, hours, values: null, why: {}, notes: [] };
  // the whole load counted in replicas running at 100 % of their limit
  const load = rows.map(s => s.cpu * s.replicas / 100), per = rows.map(s => s.cpu);
  const memRows = rows.filter(s => Number.isFinite(s.mem));
  const memLoad = memRows.map(s => s.mem * s.replicas / 100), memPer = memRows.map(s => s.mem);
  const memSwing = memPer.length >= 30 && pctl(memPer, 95) > 50 && pctl(memPer, 95) > pctl(memPer, 50) * 1.5;
  const memUp = memSwing ? 75 : null;
  const by = (v, at) => Math.ceil(v / (at / 100) - 1e-9);
  const min = Math.max(1, by(pctl(load, 50), cpuUp), memSwing ? by(pctl(memLoad, 50), memUp) : 0);
  const need = Math.max(1, by(pctl(load, 95), cpuUp), memSwing ? by(pctl(memLoad, 95), memUp) : 0);
  let max = Math.min(20, Math.max(min + 1, 2, Math.ceil(need * 1.5)));
  const notes = [];
  if (Number.isFinite(fits) && max > current + fits) { const capped = Math.max(min, current + fits); notes.push(`Only ${fits} more replica${fits === 1 ? '' : 's'} fit on the server, so the maximum is ${capped} instead of ${max}.`); max = capped; }
  const p95 = Math.round(pctl(per, 95));
  if (p95 < 20 && lim.cpu) notes.push(`Each replica used at most ${p95}% of its ${lim.cpu} CPU limit — the limit is much higher than it needs. That is your choice in the compose file; DockGate does not change it, but a lower limit would let more replicas fit.`);
  if (pctl(per, 95) < 2) notes.push('The service was almost idle: these numbers are a safe start — look again after a busy day.');
  return {
    enough: true, readings: rows.length, hours, notes,
    values: { min, max, cpuUp, cpuDown, memUp, memDown: memUp ? memUp - 30 : null },
    why: {
      min: `usually ${Math.round(pctl(load, 50) * 100)}% of one replica's CPU limit in all — fits in ${min} at ${cpuUp}%`,
      max: `at its busiest (95% of the time) ${Math.round(pctl(load, 95) * 100)}% — needs ${need}; the maximum is 1.5× that`,
      cpuUp: `per replica it used ${Math.round(pctl(per, 50))}% usually and ${p95}% at most`,
      memUp: memSwing ? `memory rose from ${Math.round(pctl(memPer, 50))}% to ${Math.round(pctl(memPer, 95))}% of its limit with load` : 'memory stayed about the same: CPU alone is enough',
    },
  };
}
async function suggest(project, service) {
  const S = CS();
  S.checkName(project, 'Project'); S.checkName(service, 'Service');
  const sid = require('./docker').getActiveServerId() || 'local';
  if (!q.row.get(sid, project, service)) db.prepare('INSERT OR IGNORE INTO compose_scaling (server_id, project, service, updated_at) VALUES (?, ?, ?, ?)').run(sid, project, service, Date.now()); // start collecting
  const samples = db.prepare('SELECT t, replicas, cpu, mem FROM compose_service_samples WHERE server_id = ? AND project = ? AND service = ? AND t >= ? ORDER BY t').all(sid, project, service, Date.now() - 48 * 3600 * 1000);
  const docker = require('./docker').docker;
  const reps = await S.replicasOf(docker, project, service).catch(() => []);
  let lim = { cpu: 0, mem: 0 }, fits = Infinity;
  if (reps.length) {
    lim = await require('../agent/src/control/measure').limitsOfContainer(docker, reps[0].id).catch(() => lim);
    const cap = await readCap(sid, docker).catch(() => null);
    if (cap && (lim.cpu || lim.mem)) fits = require('../agent/src/control/scale-decision').hostRoom(cap, lim).fits;
  }
  return suggestFrom(samples, lim, fits, { current: reps.length || 1 });
}

let sampler = null;
function start() {
  if (!timer) { timer = setInterval(() => tick().catch(() => {}), EVERY_MS); if (timer.unref) timer.unref(); }
  if (!sampler) { sampler = setInterval(() => sampleTick().catch(() => {}), SAMPLE_MS); if (sampler.unref) sampler.unref(); }
}

module.exports = { suggest, suggestFrom, sampleTick, ruleOf, validateRule, saveRule, syncOverride, importAgent, history, record, tick, start, SIM_MS };
