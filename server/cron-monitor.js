// Cron alerts: every 5 minutes, for the servers that have jobs with "notify" (Server Console → Cron), DockGate
// reads how each job ended (the dg-cron wrapper records start, end and exit code) and sends:
//   cron_failed   a job ended with an exit code other than 0 — with its last output lines
//   cron_missed   a job did not start within 30 minutes of its time (cron stopped, the server was off…)
const { db, stmts } = require('./db');
const C = require('./cron-parse');

db.exec('CREATE TABLE IF NOT EXISTS cron_monitor (key TEXT PRIMARY KEY, value TEXT)');
const rule = db.prepare('INSERT OR IGNORE INTO notification_rules (event_type, description, cooldown_minutes, enabled, params) VALUES (?, ?, 0, 1, ?)');
rule.run('cron_failed', 'Cron job failed', '{}');
rule.run('cron_missed', 'Cron job did not run', '{}');
const q = {
  get: db.prepare('SELECT value FROM cron_monitor WHERE key = ?'),
  set: db.prepare('INSERT INTO cron_monitor (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
const getJ = (k, d) => { try { const r = q.get.get(k); return r ? JSON.parse(r.value) : d; } catch (e) { return d; } };
const setJ = (k, v) => q.set.run(k, JSON.stringify(v));
const MISSED_GRACE = 30 * 60000, INTERVAL = 5 * 60000;

/** A server got a job with notify: watch it. */
function remember(serverId) { const l = new Set(getJ('servers', [])); l.add(serverId); setJ('servers', [...l]); }

/**
 * Decide what to send for one server's read() result. seen: { 'source:name': { end, missed } } (changed in place).
 * Returns [{ type, job, data }]. Pure apart from `seen`, so it is unit tested.
 */
function evaluate(info, seen, now = Date.now()) {
  const out = [];
  for (const src of info.sources) {
    for (const j of src.jobs) {
      const n = j.meta && j.meta.notify; if (!n || !n.length || !j.enabled) continue;
      const key = `${src.id}:${j.meta.name}`;
      const s = seen[key] || (seen[key] = { since: now, end: j.lastEnd || 0, missed: 0 });
      if (n.includes('fail') && j.lastEnd && j.lastEnd > (s.end || 0)) {
        if (j.lastCode !== 0) out.push({ type: 'cron_failed', job: j, data: { code: j.lastCode, start: j.lastRun, end: j.lastEnd } });
        s.end = j.lastEnd;
      } else if (j.lastEnd && j.lastEnd > (s.end || 0)) s.end = j.lastEnd;
      if (n.includes('missed')) {
        let prev = null; try { prev = C.prevRun(j.schedule, now - MISSED_GRACE, info.offsetMin || 0); } catch (e) { prev = null; }
        if (prev && prev > s.since && prev > (s.missed || 0) && !(j.lastRun && j.lastRun >= prev - 90000)) { out.push({ type: 'cron_missed', job: j, data: { due: prev } }); s.missed = prev; }
      }
    }
  }
  return out;
}

async function lastOutput(server, job) {
  try {
    const dir = job.source === 'user' ? '$HOME/.dockgate/cron' : '/var/lib/dockgate/cron';
    const r = await require('./remote-compose').execRemote(server, `tail -c 1500 "${dir}/${job.meta.name}.out" 2>/dev/null || sudo -n tail -c 1500 "${dir}/${job.meta.name}.out" 2>/dev/null; true`);
    return String(r.stdout || '').trim().split('\n').slice(-6).join('\n');
  } catch (e) { return ''; }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function send(server, a) {
  const HM = require('./notifications/health-monitor');
  const where = server.name || server.id;
  const j = a.job, when = `${j.human} (${j.schedule})`;
  let subject, text, body;
  if (a.type === 'cron_failed') {
    const out = await lastOutput(server, j);
    const secs = a.data.end && a.data.start ? Math.round((a.data.end - a.data.start) / 1000) : null;
    subject = `Cron job failed — ${j.meta.name} on ${where}`;
    text = `🔴 Cron job failed — ${where}\n${j.meta.name} (${j.user}, ${when}) ended with exit ${a.data.code}${secs != null ? ` after ${secs} s` : ''}.${out ? `\n${out}` : ''}`;
    body = `<p>Cron job <b>${esc(j.meta.name)}</b> on <b>${esc(where)}</b> (${esc(j.user)}, ${esc(when)}) ended with exit ${a.data.code}.</p>${out ? `<pre>${esc(out)}</pre>` : ''}`;
  } else {
    subject = `Cron job did not run — ${j.meta.name} on ${where}`;
    text = `🟠 Cron job did not run — ${where}\n${j.meta.name} (${j.user}, ${when}) was due at ${new Date(a.data.due).toISOString().slice(0, 16).replace('T', ' ')} UTC and has not started. Is cron running? Was the server off?`;
    body = `<p>Cron job <b>${esc(j.meta.name)}</b> on <b>${esc(where)}</b> was due at ${esc(new Date(a.data.due).toISOString())} and has not started.</p>`;
  }
  await HM.deliver(a.type, { id: `cron:${server.id}:${j.meta.name}`, name: where }, subject, text, body, { always: true, retry: true });
}

let timer = null, busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    for (const id of getJ('servers', [])) {
      const server = stmts.getServer.get(id); if (!server) continue;
      try {
        const info = await require('./cron').read(server);
        const seen = getJ(`seen:${id}`, {});
        const alerts = evaluate(info, seen);
        setJ(`seen:${id}`, seen);
        for (const a of alerts) await send(server, a);
      } catch (e) { /* server not reachable: the health monitor reports that */ }
    }
  } finally { busy = false; }
}
function start() { if (!timer) { timer = setInterval(tick, INTERVAL); if (timer.unref) timer.unref(); setTimeout(tick, 60000); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { remember, evaluate, tick, start, stop };
