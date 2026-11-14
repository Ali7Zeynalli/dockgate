// DockGate's side of the agent control channel. A signed message goes in through `docker exec -i dockgate-agent
// node src/control/send.js` (no network port; on a remote server over SSH), the agent's reply comes back.
// Rules (replicas to keep, healing) are pushed whenever they change and every 10 minutes; one executor per
// server: the agent once it has acknowledged the current rules and answers, else DockGate.
const { db, stmts } = require('../db');
const keys = require('./keys');

db.exec(`CREATE TABLE IF NOT EXISTS agent_control (
  server_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, pushed_at INTEGER, acked_version INTEGER, acked_at INTEGER, last_error TEXT
)`);
const q = {
  get: db.prepare('SELECT * FROM agent_control WHERE server_id = ?'),
  bump: db.prepare("INSERT INTO agent_control (server_id, version) VALUES (?, 1) ON CONFLICT(server_id) DO UPDATE SET version = version + 1 RETURNING version"),
  ack: db.prepare('UPDATE agent_control SET pushed_at = ?, acked_version = ?, acked_at = ?, last_error = NULL WHERE server_id = ?'),
  err: db.prepare('INSERT INTO agent_control (server_id, version, last_error) VALUES (?, 0, ?) ON CONFLICT(server_id) DO UPDATE SET last_error = excluded.last_error'),
};
const FRESH_MS = 2 * 60 * 1000;
const PUSH_EVERY_MS = 10 * 60 * 1000;

/** Hand one signed message to the agent on a server; resolves its JSON reply. */
async function deliver(serverId, message) {
  const line = JSON.stringify(message);
  const b64 = Buffer.from(line, 'utf8').toString('base64');
  const inner = 'docker exec -i dockgate-agent node src/control/send.js';
  if (serverId === 'local') {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
      const p = execFile('docker', ['exec', '-i', 'dockgate-agent', 'node', 'src/control/send.js'], { timeout: 30000 }, (e, out) => {
        if (e && !out) return reject(new Error(`The agent did not answer: ${e.message.split('\n')[0]}`));
        try { resolve(JSON.parse(String(out).trim().split('\n').pop())); } catch (pe) { reject(new Error('The agent sent an answer DockGate could not read')); }
      });
      p.stdin.end(line + '\n');
    });
  }
  const server = stmts.getServer.get(serverId);
  if (!server) throw new Error(`Server not found: ${serverId}`);
  const rc = require('../remote-compose');
  const cmd = `printf %s ${rc.shq(b64)} | base64 -d | ${inner} 2>/dev/null || printf %s ${rc.shq(b64)} | base64 -d | sudo -n ${inner} 2>/dev/null`;
  const r = await rc.execRemote(server, cmd);
  const out = String(r.stdout || '').trim().split('\n').pop();
  if (!out) throw new Error('The agent did not answer (is the dockgate-agent container running, and up to date?)');
  try { return JSON.parse(out); } catch (e) { throw new Error('The agent sent an answer DockGate could not read'); }
}

/** A signed command (one of the agent's whitelisted actions). */
async function command(serverId, action, args = {}) { return deliver(serverId, keys.sign(serverId, 'cmd', { action, args })); }

/** What the agent should do on this server: per project/service, the replicas to keep and whether to heal. */
function buildRules(serverId) {
  const projects = {};
  require('../compose-scale'); // owns the compose_scaling table
  for (const r of db.prepare('SELECT * FROM compose_scaling WHERE server_id = ?').all(serverId)) {
    const keep = Number.isInteger(r.replicas) && r.replicas > 0;
    const auto = r.mode && r.mode !== 'off' ? require('../compose-autoscale').ruleOf(serverId, r.project, r.service) : null;
    if (!keep && !r.heal && !auto && !r.keep_running) continue;
    (projects[r.project] = projects[r.project] || {})[r.service] = {
      ...(keep ? { replicas: r.replicas } : {}), ...(Number.isInteger(r.min_r) ? { min: r.min_r } : {}), ...(Number.isInteger(r.max_r) ? { max: r.max_r } : {}),
      heal: !!r.heal, healPerHour: r.heal_per_hour || 3, keep, ...(auto ? { auto } : {}), ...(r.keep_running ? { keepRunning: true } : {}),
    };
  }
  return { projects };
}

/** Push the current rules to the agent of a server (if it has one with a key). Returns the acknowledged version or null. */
async function pushRules(serverId) {
  if (!keys.hasKey(serverId)) return null;
  const { version } = q.bump.get(serverId);
  try {
    const reply = await deliver(serverId, keys.sign(serverId, 'rules', { version, ...buildRules(serverId) }));
    if (!reply.ok) throw new Error(reply.reason || 'refused');
    q.ack.run(Date.now(), reply.version, Date.now(), serverId);
    return reply.version;
  } catch (e) { q.err.run(serverId, String(e.message).slice(0, 300)); return null; }
}
/** Push, but do not wait or fail (after a change in the panel). */
function pushSoon(serverId) { setImmediate(() => pushRules(serverId).catch(() => {})); }

/** Who runs the rules on this server right now. */
function executorFor(serverId) {
  const r = q.get.get(serverId);
  if (!r || !r.acked_version || r.acked_version !== r.version || !r.acked_at || Date.now() - r.acked_at > PUSH_EVERY_MS + FRESH_MS) return 'dockgate';
  return 'agent';
}
function statusOf(serverId) {
  const r = q.get.get(serverId) || {};
  return { hasKey: keys.hasKey(serverId), executor: executorFor(serverId), version: r.version || 0, ackedVersion: r.acked_version || null, ackedAt: r.acked_at || null, error: r.last_error || null };
}
/** The agent's own view: rules it has and what it did (history). */
async function readState(serverId) {
  const reply = await command(serverId, 'state');
  return reply.control || null;
}

let timer = null;
/** Every 10 minutes: push the rules to every server that has a keyed agent (so they stay fresh and acknowledged). */
function start() {
  if (timer) return;
  const tick = async () => {
    for (const r of db.prepare('SELECT server_id FROM agent_keys').all()) {
      if (await pushRules(r.server_id).catch(() => null)) await require('../compose-autoscale').importAgent(r.server_id).catch(() => {}); // what it scaled meanwhile
    }
  };
  timer = setInterval(tick, PUSH_EVERY_MS); if (timer.unref) timer.unref();
  setTimeout(tick, 15000).unref?.();
}

module.exports = { deliver, command, buildRules, pushRules, pushSoon, executorFor, statusOf, readState, start };
