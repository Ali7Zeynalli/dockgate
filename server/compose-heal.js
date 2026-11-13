// Auto-heal on servers whose agent does not run the rules (no agent, or an old one): DockGate restarts a container
// that its own health check reports unhealthy, with the same rule as the agent (agent/src/control/heal-decision.js).
// Probing images without a health check needs the agent (it has a helper on the server); here only the image's own
// health check counts.
const { db, stmts } = require('./db');
const { healDecision } = require('../agent/src/control/heal-decision');

const TICK_MS = 30000;
const memory = new Map(); // container id → { fails, restarts, stopped }
let timer = null, busy = false;

function clientFor(serverId) {
  const ds = require('./docker');
  if (serverId === 'local') return ds.createLocalClient();
  const row = stmts.getServer.get(serverId);
  return row ? ds.createSshClient(row) : null;
}
async function notify(serverId, subject, text) {
  try {
    const HM = require('./notifications/health-monitor');
    const s = serverId === 'local' ? { id: 'local', name: 'Local' } : stmts.getServer.get(serverId);
    if (s) await HM.deliver('compose_heal', s, subject, text, `<p>${text}</p>`, { always: true });
  } catch (e) { /* best effort */ }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const control = require('./agent/control');
    const rows = db.prepare('SELECT * FROM compose_scaling WHERE heal = 1').all();
    for (const r of rows) {
      if (control.executorFor(r.server_id) === 'agent') continue; // the agent does it
      const c = clientFor(r.server_id); if (!c) continue;
      const list = await c.listContainers({ filters: JSON.stringify({ label: [`com.docker.compose.project=${r.project}`, `com.docker.compose.service=${r.service}`] }) }).catch(() => []);
      for (const x of list) {
        const ct = await c.getContainer(x.Id).inspect().catch(() => null);
        if (!ct || !ct.State.Health) continue;
        const h = memory.get(x.Id) || { fails: 0, restarts: [], stopped: false };
        memory.set(x.Id, h);
        h.since = new Date(ct.State.StartedAt).getTime();
        if (ct.State.Health.Status !== 'unhealthy') { h.fails = 0; h.stopped = false; continue; }
        h.fails++;
        const d = healDecision(h, Date.now(), { healPerHour: r.heal_per_hour || 3 });
        const name = ct.Name.replace(/^\//, '');
        if (d === 'restart') {
          await c.getContainer(x.Id).restart({ t: 10 }).catch(() => {});
          h.restarts = [...h.restarts.filter(t => Date.now() - t < 3600000), Date.now()]; h.fails = 0;
          try { require('./audit').logAction({ sourceIp: 'auto-heal', server: r.server_id, resourceType: 'compose', resourceId: r.project, resourceName: name, action: 'compose_heal_restart', details: { restartsLastHour: h.restarts.length } }); } catch (e) { /* best effort */ }
          await notify(r.server_id, `${name} restarted`, `🩺 ${name} was unhealthy — DockGate restarted it (${h.restarts.length} in the last hour).`);
        } else if (d !== 'wait' && !h.stopped) {
          h.stopped = true;
          await notify(r.server_id, `${name} stays unhealthy`, `🛑 ${name} is still unhealthy after ${r.heal_per_hour || 3} restarts in an hour — DockGate stopped restarting it. Look at its logs.`);
        }
      }
    }
  } catch (e) { console.warn('[compose-heal]', e.message); } finally { busy = false; }
}
function start() { if (!timer) { timer = setInterval(tick, TICK_MS); if (timer.unref) timer.unref(); } }
module.exports = { tick, start };
