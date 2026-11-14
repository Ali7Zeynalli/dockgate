// Keep running on servers whose Edge agent does not run the rules (none, or an old one): DockGate does what the
// agent would (agent/src/control/keep.js) while it is online — a stopped service is started, a removed one made
// again from its kept config. The kept config holds the environment, so it is stored encrypted.
const { db, stmts } = require('./db');
const { keepAlive } = require('../agent/src/control/keep');
require('./compose-scale'); // the compose_scaling table

db.exec(`CREATE TABLE IF NOT EXISTS compose_keep_snap (
  server_id TEXT NOT NULL, project TEXT NOT NULL, service TEXT NOT NULL, at INTEGER, data TEXT NOT NULL, PRIMARY KEY (server_id, project, service)
)`);
const secrets = require('./auth/secrets');
const TICK_MS = 30000;
const states = new Map(); // server → { short, snaps }
let timer = null, running = false;

function clientFor(serverId) {
  const ds = require('./docker');
  if (serverId === 'local') return ds.createLocalClient();
  const row = stmts.getServer.get(serverId);
  return row ? ds.createSshClient(row) : null;
}
function loadSnaps(serverId) {
  const snaps = {};
  for (const r of db.prepare('SELECT project, service, at, data FROM compose_keep_snap WHERE server_id = ?').all(serverId)) {
    try { snaps[`${r.project}/${r.service}`] = { at: r.at, inspect: JSON.parse(secrets.decryptStrict(r.data)) }; } catch (e) { /* unreadable: kept again while it runs */ }
  }
  return snaps;
}
async function notify(serverId, text) {
  try {
    const HM = require('./notifications/health-monitor');
    const s = serverId === 'local' ? { id: 'local', name: 'Local' } : stmts.getServer.get(serverId);
    if (s) await HM.deliver('compose_heal', s, text.slice(0, 120), text, `<p>${text}</p>`, { always: true });
  } catch (e) { /* best effort */ }
}

async function tick(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const control = require('./agent/control');
    const rows = db.prepare('SELECT * FROM compose_scaling WHERE keep_running = 1').all();
    for (const r of rows) {
      if (control.executorFor(r.server_id) === 'agent') continue; // the agent does it (and keeps its own config)
      if (require('./routes/compose').composeHelpers.busy(r.project)) continue; // a deploy is running
      const docker = clientFor(r.server_id); if (!docker) continue;
      let st = states.get(r.server_id);
      if (!st) { st = { short: {}, snaps: loadSnaps(r.server_id) }; states.set(r.server_id, st); }
      const key = `${r.project}/${r.service}`, before = st.snaps[key] && st.snaps[key].at;
      let target = Number.isInteger(r.replicas) && r.replicas > 0 ? r.replicas : 1;
      if (r.mode === 'auto' && Number.isInteger(r.min_r)) target = r.min_r;
      const res = await keepAlive({ docker, project: r.project, service: r.service, target, state: st, now }).catch(e => ({ action: 'keep', ok: false, reason: e.message }));
      const snap = st.snaps[key];
      if (snap && snap.at !== before) {
        db.prepare('INSERT INTO compose_keep_snap (server_id, project, service, at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, project, service) DO UPDATE SET at = excluded.at, data = excluded.data')
          .run(r.server_id, r.project, r.service, snap.at, secrets.encrypt(JSON.stringify(snap.inspect)));
      }
      if (res) {
        try { require('./audit').logAction({ sourceIp: 'keep-running', server: r.server_id, resourceType: 'compose', resourceId: r.project, resourceName: `${r.project}/${r.service}`, action: 'compose_keep_' + res.action, details: { ok: res.ok, reason: res.reason, container: res.container } }); } catch (e) { /* best effort */ }
        await notify(r.server_id, `${res.ok ? '♻️' : '⚠️'} ${r.project}/${r.service}: ${res.reason}${res.container ? ` (${res.container})` : ''} — DockGate${res.ok ? '' : ' could not bring it back'}.`);
      }
    }
  } catch (e) { console.warn('[compose-keep]', e.message); } finally { running = false; }
}
function start() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), TICK_MS); if (timer.unref) timer.unref(); } }
module.exports = { tick, start };
