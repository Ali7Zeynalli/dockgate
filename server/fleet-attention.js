// What needs attention on every server (Dashboard -> "Needs attention on all servers"):
//   updates   images with a newer version in their registry (from the daily newer-image check, nothing is asked now)
//   problems  containers that are restarting, unhealthy, or stopped with an error (exit code other than 0)
//   jobs      scheduled work whose last run failed: DockGate's tasks, deploy recipes, cron jobs with alerts
// A server with an access password this session has not typed shows only that it is locked.
const { db, stmts } = require('./db');
require('./task-recipes'); // makes task_recipes and task_runs (read below)

const TIMEOUT = 12000;
const failedSchedules = db.prepare("SELECT name, last_run_at, last_message FROM schedules WHERE server_id = ? AND enabled = 1 AND last_status = 'failed'");
const recipeRuns = db.prepare(`SELECT r.name, r.dir, t.status, t.started_at FROM task_recipes r
  JOIN task_runs t ON t.id = (SELECT id FROM task_runs WHERE server_id = r.server_id AND dir = r.dir AND kind = 'recipe' AND name = r.name ORDER BY started_at DESC LIMIT 1)
  WHERE r.server_id = ?`);
// DockGate's own short-lived helpers, and Swarm's task containers (Swarm keeps old ones as history; Swarm > Services shows a service in trouble)
const isHelper = (c) => { const l = c.Labels || {}; return !!(l['dockgate.helper'] || l['dockgate.task'] || l['com.docker.swarm.task.id']); };
const nameOf = (c) => String((c.Names && c.Names[0]) || c.Id || '').replace(/^\//, '');

/** A container's trouble, or null: restarting, unhealthy, or exited with an error. */
function problemOf(c) {
  const st = String(c.Status || '');
  if (c.State === 'restarting') return 'restarting';
  if (/\(unhealthy\)/.test(st)) return 'unhealthy';
  if (c.State === 'exited' || c.State === 'dead') { const m = /Exited \((\d+)\)/.exec(st); if (c.State === 'dead' || (m && m[1] !== '0' && m[1] !== '137' && m[1] !== '143')) return m ? `stopped with exit ${m[1]}` : 'dead'; }
  return null;
}

function jobsFor(id) {
  const out = failedSchedules.all(id).map(s => ({ source: 'DockGate task', name: s.name, at: s.last_run_at, note: s.last_message || '' }));
  try { for (const r of recipeRuns.all(id)) if (r.status === 'failed' || r.status === 'error') out.push({ source: 'Deploy recipe', name: r.name, at: r.started_at, note: r.dir }); } catch (e) { /* no recipes table yet */ }
  try { const f = require('./cron-monitor').lastFailed(id); if (f) for (const j of f.jobs || []) out.push({ source: 'Cron', name: j.name, at: j.at, note: `exit ${j.code}` }); } catch (e) { /* cron alerts not used */ }
  return out;
}

async function forServer(sv, { locked }) {
  const base = { id: sv.id, name: sv.name, locked: false, reachable: true, error: null, updates: [], problems: [], jobs: [] };
  if (locked) return { ...base, locked: true };
  base.jobs = jobsFor(sv.id);
  let containers = [];
  try {
    const ds = require('./docker');
    const client = sv.id === 'local' ? ds.createLocalClient() : ds.createSshClient(stmts.getServer.get(sv.id));
    containers = await Promise.race([client.listContainers({ all: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 12 s')), TIMEOUT))]);
  } catch (e) { base.reachable = false; base.error = e.message; }
  containers = containers.filter(c => !isHelper(c));
  for (const c of containers) { const p = problemOf(c); if (p) base.problems.push({ name: nameOf(c), image: c.Image, problem: p, status: c.Status, project: (c.Labels || {})['com.docker.compose.project'] || null }); }
  const IU = require('./image-updates');
  for (const r of IU.resultsFor(sv.id).filter(x => x.status === 'update')) {
    const users = containers.filter(c => c.Image === r.image || c.Image === `${r.image}:latest`).map(nameOf);
    base.updates.push({ image: r.image, from: r.local_version || null, to: r.remote_version || null, checkedAt: r.checked_at, containers: users });
  }
  return base;
}

/** Every server; isLocked(id) says whether this session may see inside it. */
async function summary(isLocked = () => false) {
  const servers = [{ id: 'local', name: 'Local' }, ...stmts.getServers.all().filter(x => x.id !== 'local').map(x => ({ id: x.id, name: x.name || x.host || x.id }))];
  const list = await Promise.all(servers.map(sv => forServer(sv, { locked: isLocked(sv.id) })));
  const n = (k) => list.reduce((a, x) => a + x[k].length, 0);
  return { servers: list, totals: { updates: n('updates'), problems: n('problems'), jobs: n('jobs'), unreachable: list.filter(x => !x.reachable).length } };
}

module.exports = { summary, problemOf };
