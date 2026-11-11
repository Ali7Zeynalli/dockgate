// Swarm alerts — phase 6. Every 30 s each swarm DockGate knows is read from one of its managers:
//   swarm_service_down     a service runs fewer tasks than wanted for N minutes (rule limit), and when it is back
//   swarm_node_down        a node goes Down, and when it is Ready again
//   swarm_update_rollback  a service update was rolled back or paused (new tasks failed)
//   swarm_quorum           most managers can not be reached, and when they are back
// Alerts go through the usual channels (email, Telegram, webhook) and are retried when sending fails.
// After a DockGate restart the first look only records the state, so nothing already known is sent again.
const { stmts, db } = require('./db');
const dockerService = require('./docker');

const INTERVAL_MS = 30 * 1000;
const state = new Map(); // clusterId → { nodes, services, updates, quorumLost, first }
let timer = null, running = false;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function serverRow(id) { return !id || id === 'local' ? { id: 'local', type: 'local', name: 'Local' } : stmts.getServer.get(id); }
function clientFor(row) { return row.id === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(row); }
function ruleMinutes() {
  try { const r = stmts.getRule.get('swarm_service_down'); const p = JSON.parse((r && r.params) || '{}'); return Math.max(1, Number(p.minutes) || 2); } catch (e) { return 2; }
}

/** Servers to ask: the local Docker, the server in use and every server DockGate made a node. */
function candidates() {
  const ids = new Set(['local', dockerService.getActiveServerId() || 'local']);
  try { for (const r of db.prepare('SELECT DISTINCT server_id FROM swarm_node_servers').all()) ids.add(r.server_id); } catch (e) { /* no table yet */ }
  return [...ids].map(serverRow).filter(Boolean);
}

/**
 * Compare one look at a cluster with the last one and return the alerts due:
 * [{ type, subject, text, body }]. snapshot: { nodes, services, error } from a manager. Pure apart from `state`.
 */
function evaluate(clusterId, snap, where, { now = Date.now(), minutes = ruleMinutes() } = {}) {
  let st = state.get(clusterId);
  const first = !st;
  if (!st) { st = { nodes: new Map(), services: new Map(), updates: new Map(), quorumLost: false }; state.set(clusterId, st); }
  const out = [];
  const add = (type, subject, text, body) => out.push({ type, subject: `${where}: ${subject}`, text, body });
  // quorum
  const managers = snap.nodes.filter(n => n.Spec.Role === 'manager');
  const reachable = managers.filter(n => n.ManagerStatus && n.ManagerStatus.Reachability === 'reachable').length;
  const lost = !!snap.error || (managers.length > 0 && reachable <= managers.length / 2);
  if (lost !== st.quorumLost && !first) {
    if (lost) add('swarm_quorum', 'Swarm managers lost their majority', `🔴 Swarm on ${where}: most managers can not be reached\n${snap.error || `${reachable} of ${managers.length} managers reachable`}. Running services keep running, but nothing can be changed. Swarm → Overview.`, `<p>Swarm on <b>${esc(where)}</b>: most managers can not be reached (${esc(snap.error || `${reachable} of ${managers.length}`)}). Running services keep running, but the cluster can not be changed until they are back.</p>`);
    else add('swarm_quorum', 'Swarm managers are back', `🟢 Swarm on ${where}: the managers have their majority again (${reachable} of ${managers.length})`, `<p>Swarm on <b>${esc(where)}</b>: the managers have their majority again (${reachable} of ${managers.length}).</p>`);
  }
  st.quorumLost = lost;
  // nodes
  const seenNodes = new Set();
  for (const n of snap.nodes) {
    seenNodes.add(n.ID);
    const prev = st.nodes.get(n.ID);
    const s = n.Status.State, host = n.Description.Hostname, addr = n.Status.Addr;
    if (prev && !first) {
      if (prev.state === 'ready' && s === 'down') add('swarm_node_down', `server ${host} is down`, `🔴 Swarm on ${where}: ${host} (${addr}) is Down\nIts tasks are started on the other servers where they can run. A task pinned to it (data) waits until it is back.`, `<p>Swarm on <b>${esc(where)}</b>: <b>${esc(host)}</b> (${esc(addr)}) is Down. Its tasks are started on the other servers where they can run; tasks pinned to it wait.</p>`);
      if (prev.state === 'down' && s === 'ready') add('swarm_node_down', `server ${host} is back`, `🟢 Swarm on ${where}: ${host} is Ready again after ${mins(now - prev.since)}\nTasks do not move back by themselves — Swarm → Nodes → Rebalance.`, `<p>Swarm on <b>${esc(where)}</b>: <b>${esc(host)}</b> is Ready again after ${mins(now - prev.since)}. Tasks do not move back by themselves: Swarm → Nodes → Rebalance.</p>`);
    }
    st.nodes.set(n.ID, { state: s, since: prev && prev.state === s ? prev.since : now });
  }
  for (const id of [...st.nodes.keys()]) if (!seenNodes.has(id)) st.nodes.delete(id);
  // services and updates
  const seen = new Set();
  for (const sv of snap.services) {
    seen.add(sv.ID);
    const name = sv.Spec.Name;
    const mode = sv.Spec.Mode || {};
    if (mode.ReplicatedJob || mode.GlobalJob) continue; // jobs finish on purpose
    const ss = sv.ServiceStatus || { RunningTasks: 0, DesiredTasks: 0 };
    const cur = st.services.get(sv.ID) || { belowSince: null, alerted: false };
    if (ss.RunningTasks < ss.DesiredTasks) {
      if (!cur.belowSince) cur.belowSince = now;
      if (!cur.alerted && now - cur.belowSince >= minutes * 60000) {
        cur.alerted = true;
        const why = snap.reasons && snap.reasons[sv.ID] ? `\nWhy: ${snap.reasons[sv.ID]}` : '';
        add('swarm_service_down', `${name} runs ${ss.RunningTasks}/${ss.DesiredTasks}`, `🟠 Swarm on ${where}: ${name} runs ${ss.RunningTasks} of ${ss.DesiredTasks} tasks for ${mins(now - cur.belowSince)}${why}\nSwarm → Services → Tasks shows each try.`, `<p>Swarm on <b>${esc(where)}</b>: <b>${esc(name)}</b> runs ${ss.RunningTasks} of ${ss.DesiredTasks} tasks for ${mins(now - cur.belowSince)}.</p>${why ? `<p>${esc(why.trim())}</p>` : ''}`);
      }
    } else {
      if (cur.alerted) add('swarm_service_down', `${name} is back to ${ss.RunningTasks}/${ss.DesiredTasks}`, `🟢 Swarm on ${where}: ${name} runs all ${ss.DesiredTasks} tasks again (it was short for ${mins(now - cur.belowSince)})`, `<p>Swarm on <b>${esc(where)}</b>: <b>${esc(name)}</b> runs all ${ss.DesiredTasks} tasks again (short for ${mins(now - cur.belowSince)}).</p>`);
      cur.belowSince = null; cur.alerted = false;
    }
    st.services.set(sv.ID, cur);
    const us = sv.UpdateStatus;
    if (us && ['rollback_completed', 'rollback_paused', 'paused'].includes(us.State)) {
      const key = `${us.State}:${us.CompletedAt || us.StartedAt || ''}`;
      if (st.updates.get(sv.ID) !== key && !first) {
        const what = us.State === 'rollback_completed' ? 'update rolled back' : us.State === 'paused' ? 'update paused' : 'roll back paused';
        add('swarm_update_rollback', `${name}: ${what}`, `🟠 Swarm on ${where}: ${name} — ${what}\n${us.Message || ''}\n${us.State === 'rollback_completed' ? 'The previous version runs again.' : 'Some tasks run the new version, some the old one — Swarm → Services.'}`.trim(), `<p>Swarm on <b>${esc(where)}</b>: <b>${esc(name)}</b> — ${what}.</p><p>${esc(us.Message || '')}</p>`);
      }
      st.updates.set(sv.ID, key);
    }
  }
  for (const id of [...st.services.keys()]) if (!seen.has(id)) { st.services.delete(id); st.updates.delete(id); }
  return out;
}

/** Why a service is short: the newest error of its tasks. */
async function reasonsOf(c, services) {
  const short = services.filter(s => s.ServiceStatus && s.ServiceStatus.RunningTasks < s.ServiceStatus.DesiredTasks);
  if (!short.length) return {};
  const tasks = await c.listTasks().catch(() => []);
  const out = {};
  for (const s of short) {
    const t = tasks.filter(x => x.ServiceID === s.ID && x.Status.Err).sort((a, b) => new Date(b.Status.Timestamp) - new Date(a.Status.Timestamp))[0];
    if (t) out[s.ID] = t.Status.Err;
  }
  return out;
}

async function tick() {
  if (running) return;
  running = true;
  const HM = require('./notifications/health-monitor');
  try {
    const done = new Set();
    for (const row of candidates()) {
      let c, info;
      try { c = clientFor(row); info = await withTimeout(c.info(), 8000); } catch (e) { continue; }
      const sw = info.Swarm || {};
      if (sw.LocalNodeState !== 'active' || !sw.ControlAvailable || !sw.Cluster) continue;
      if (done.has(sw.Cluster.ID)) continue;
      done.add(sw.Cluster.ID);
      const where = HM.serverLabel(row);
      let alerts;
      try {
        const [nodes, services] = await Promise.all([withTimeout(c.listNodes(), 10000), withTimeout(c.listServices({ status: true }), 10000)]);
        alerts = evaluate(sw.Cluster.ID, { nodes, services, reasons: await reasonsOf(c, services) }, where);
      } catch (e) {
        const msg = String(e.message || e).slice(0, 200);
        if (!/leader|quorum|deadline exceeded/i.test(msg)) continue; // a transport problem, not the swarm
        alerts = evaluateQuorumOnly(sw.Cluster.ID, msg, where);
      }
      for (const a of alerts) await HM.deliver(a.type, row, a.subject, a.text, a.body, { always: true, retry: true });
    }
  } catch (e) { console.warn('[swarm-monitor]', e.message); }
  finally { running = false; }
}
function evaluateQuorumOnly(clusterId, error, where) {
  const st = state.get(clusterId);
  if (!st || st.quorumLost) return [];
  st.quorumLost = true;
  return [{ type: 'swarm_quorum', subject: `${where}: Swarm managers lost their majority`, text: `🔴 Swarm on ${where}: the cluster has no leader\n${error}. Running services keep running, but nothing can be changed.`, body: `<p>Swarm on <b>${esc(where)}</b>: the cluster has no leader (${esc(error)}). Running services keep running, but nothing can be changed.</p>` }];
}

function start() { if (!timer) { timer = setInterval(tick, INTERVAL_MS); if (timer.unref) timer.unref(); setTimeout(tick, 15000).unref?.(); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, evaluate, _state: state };
