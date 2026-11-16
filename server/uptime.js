// Observe → Uptime: checks DockGate runs every 30 s – 1 h (uptime-probe.js does one check), their results,
// uptime per period, incidents, and the alerts (site down / back up / slow, certificate expiring / invalid)
// through the notification channels of Settings → Notifications.
// Results: every check for 48 hours, then one row per hour for 90 days (so 7 / 30 / 90 day figures stay cheap).
const { db } = require('./db');
const P = require('./uptime-probe');

db.exec(`
CREATE TABLE IF NOT EXISTS uptime_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL,
  config TEXT, interval_s INTEGER NOT NULL DEFAULT 60, fails INTEGER NOT NULL DEFAULT 2,
  enabled INTEGER NOT NULL DEFAULT 1, paused_until INTEGER, state TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS uptime_results (check_id INTEGER NOT NULL, t INTEGER NOT NULL, ok INTEGER NOT NULL, ms INTEGER, code INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS uptime_results_ct ON uptime_results (check_id, t);
CREATE TABLE IF NOT EXISTS uptime_hourly (check_id INTEGER NOT NULL, hour INTEGER NOT NULL, n INTEGER, ok INTEGER, ms_sum INTEGER, ms_max INTEGER, PRIMARY KEY (check_id, hour));
CREATE TABLE IF NOT EXISTS uptime_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, check_id INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER, cause TEXT);
CREATE INDEX IF NOT EXISTS uptime_incidents_c ON uptime_incidents (check_id, start);
`);
// Alert rules (Settings → Notifications): state changes, so no quiet period.
const rule = db.prepare('INSERT OR IGNORE INTO notification_rules (event_type, description, cooldown_minutes, enabled, params) VALUES (?, ?, 0, 1, ?)');
rule.run('site_down', 'Site down', '{}');
rule.run('site_up', 'Site back up', '{}');
rule.run('site_slow', 'Site slow', '{}');
rule.run('cert_expiring', 'Certificate expires soon', '{}');
rule.run('cert_invalid', 'Certificate invalid', '{}');

const HOUR = 3600000, DAY = 86400000, RAW_KEEP = 2 * DAY, HOURLY_KEEP = 90 * DAY;
const q = {
  all: db.prepare('SELECT * FROM uptime_checks ORDER BY name COLLATE NOCASE'),
  get: db.prepare('SELECT * FROM uptime_checks WHERE id = ?'),
  insert: db.prepare('INSERT INTO uptime_checks (name, type, target, config, interval_s, fails, enabled, created_at) VALUES (@name, @type, @target, @config, @interval, @fails, 1, @now)'),
  update: db.prepare('UPDATE uptime_checks SET name = @name, type = @type, target = @target, config = @config, interval_s = @interval, fails = @fails WHERE id = @id'),
  setState: db.prepare('UPDATE uptime_checks SET state = ? WHERE id = ?'),
  setEnabled: db.prepare('UPDATE uptime_checks SET enabled = ?, paused_until = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM uptime_checks WHERE id = ?'),
  addResult: db.prepare('INSERT INTO uptime_results (check_id, t, ok, ms, code, error) VALUES (?, ?, ?, ?, ?, ?)'),
  addHour: db.prepare(`INSERT INTO uptime_hourly (check_id, hour, n, ok, ms_sum, ms_max) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(check_id, hour) DO UPDATE SET n = n + 1, ok = ok + excluded.ok, ms_sum = ms_sum + excluded.ms_sum, ms_max = MAX(ms_max, excluded.ms_max)`),
  openIncident: db.prepare('SELECT * FROM uptime_incidents WHERE check_id = ? AND end IS NULL ORDER BY start DESC LIMIT 1'),
  addIncident: db.prepare('INSERT INTO uptime_incidents (check_id, start, cause) VALUES (?, ?, ?)'),
  closeIncident: db.prepare('UPDATE uptime_incidents SET end = ? WHERE id = ?'),
  incidents: db.prepare('SELECT * FROM uptime_incidents WHERE check_id = ? ORDER BY start DESC LIMIT ?'),
  raw: db.prepare('SELECT t, ok, ms, code, error FROM uptime_results WHERE check_id = ? AND t >= ? ORDER BY t'),
  hourly: db.prepare('SELECT hour, n, ok, ms_sum, ms_max FROM uptime_hourly WHERE check_id = ? AND hour >= ? ORDER BY hour'),
  pruneRaw: db.prepare('DELETE FROM uptime_results WHERE t < ?'),
  pruneHourly: db.prepare('DELETE FROM uptime_hourly WHERE hour < ?'),
  pruneInc: db.prepare('DELETE FROM uptime_incidents WHERE end IS NOT NULL AND end < ?'),
};
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const row = (r) => !r ? null : ({ id: r.id, name: r.name, type: r.type, target: r.target, config: parse(r.config, {}), interval: r.interval_s, fails: r.fails, enabled: !!r.enabled, pausedUntil: r.paused_until || null, state: parse(r.state, {}), createdAt: r.created_at });

function list() { return q.all.all().map(row); }
function get(id) { return row(q.get.get(Number(id))); }
function create(input) {
  const v = P.normalize(input);
  const id = q.insert.run({ ...v, config: JSON.stringify(v.config), now: Date.now() }).lastInsertRowid;
  return get(id);
}
function update(id, input) {
  const cur = get(id); if (!cur) throw Object.assign(new Error('Check not found'), { statusCode: 404 });
  const v = P.normalize({ ...cur, ...input, config: { ...cur.config, ...(input.config || {}) } });
  q.update.run({ ...v, id: cur.id, config: JSON.stringify(v.config) });
  return get(id);
}
function remove(id) {
  db.prepare('DELETE FROM uptime_results WHERE check_id = ?').run(Number(id));
  db.prepare('DELETE FROM uptime_hourly WHERE check_id = ?').run(Number(id));
  db.prepare('DELETE FROM uptime_incidents WHERE check_id = ?').run(Number(id));
  q.del.run(Number(id));
}
/** Pause for minutes (0 / null = until resumed), or resume. Paused time does not count against uptime. */
function setPaused(id, paused, minutes) {
  const until = paused && minutes ? Date.now() + Number(minutes) * 60000 : null;
  q.setEnabled.run(paused ? 0 : 1, until, Number(id));
  const c = get(id);
  if (c && paused) { const inc = q.openIncident.get(c.id); if (inc) q.closeIncident.run(Date.now(), inc.id); q.setState.run(JSON.stringify({ ...c.state, status: 'paused' }), c.id); }
  if (c && !paused) q.setState.run(JSON.stringify({ ...c.state, status: 'pending', fails: 0 }), c.id);
  return get(id);
}

// ---- alerts ----
const fmtDur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function message(type, c, d) {
  const t = c.target;
  switch (type) {
    case 'site_down': return [`Site down — ${c.name}`, `🔴 Site down — ${c.name}\n${d.error || 'failed'} (${d.fails} checks in a row)\n${t}`, `<p><b>${esc(c.name)}</b> is down: ${esc(d.error || 'failed')} (${d.fails} checks in a row).</p><p>${esc(t)}</p>`];
    case 'site_up': return [`Back up — ${c.name}`, `🟢 Back up — ${c.name}\nDown for ${fmtDur(d.until - d.since)}. Now ${d.status ? d.status + ' in ' : ''}${d.ms} ms.`, `<p><b>${esc(c.name)}</b> is back up after ${fmtDur(d.until - d.since)}.</p>`];
    case 'site_slow': return [`Slow — ${c.name}`, `🟠 Slow — ${c.name}\n${d.ms} ms on ${d.count} checks in a row (limit ${d.limit} ms)`, `<p><b>${esc(c.name)}</b> answers slowly: ${d.ms} ms on ${d.count} checks in a row (limit ${d.limit} ms).</p>`];
    case 'cert_expiring': { const x = d.cert; const day = new Date(x.validTo).toISOString().slice(0, 10); return [`Certificate expires in ${x.daysLeft} days — ${c.name}`, `🟡 Certificate expires in ${x.daysLeft} days — ${c.name}\n${x.issuer || 'certificate'} · until ${day}. Check that auto-renewal (certbot / Traefik / Caddy) works.`, `<p>The certificate of <b>${esc(c.name)}</b> expires in <b>${x.daysLeft} days</b> (${day}, ${esc(x.issuer)}).</p>`]; }
    case 'cert_invalid': { const x = d.cert; const why = x.daysLeft < 0 ? 'it has expired' : !x.nameOk ? `it is not for this name (${(x.names || []).slice(0, 3).join(', ')})` : (x.error || 'not trusted'); return [`Certificate invalid — ${c.name}`, `🔴 Certificate invalid — ${c.name}\n${why}`, `<p>The certificate of <b>${esc(c.name)}</b> is invalid: ${esc(why)}.</p>`]; }
  }
  return [type, type, type];
}
async function alert(type, c, d) {
  const [subject, text, body] = message(type, c, d);
  try { await require('./notifications/health-monitor').deliver(type, { id: `uptime:${c.id}`, name: c.name }, subject, text, body, { always: true, retry: type === 'site_down' || type === 'site_up' }); }
  catch (e) { console.warn('[uptime] alert failed:', e.message); }
}

// ---- running checks ----
async function runOne(c, { record = true } = {}) {
  const r = await P.probe(c);
  const now = Date.now();
  if (!record) return r;
  const { state, alerts } = P.evaluate(c.state && c.state.status !== 'paused' ? c.state : {}, r, c, now);
  q.addResult.run(c.id, now, r.ok ? 1 : 0, r.ms || 0, r.status || null, r.ok ? null : String(r.error || '').slice(0, 300));
  q.addHour.run(c.id, Math.floor(now / HOUR) * HOUR, r.ok ? 1 : 0, r.ms || 0, r.ms || 0);
  for (const a of alerts) {
    if (a.type === 'site_down') q.addIncident.run(c.id, state.since, String(a.data.error || '').slice(0, 300));
    if (a.type === 'site_up') { const inc = q.openIncident.get(c.id); if (inc) q.closeIncident.run(now, inc.id); }
  }
  q.setState.run(JSON.stringify(state), c.id);
  for (const a of alerts) alert(a.type, c, a.data);
  return { ...r, state };
}

let timer = null, running = false, pruneAt = 0;
const CONCURRENCY = 6;
async function tick() {
  if (running) return; running = true;
  try {
    const now = Date.now();
    const rows = list();
    for (const c of rows) if (!c.enabled && c.pausedUntil && c.pausedUntil <= now) setPaused(c.id, false);
    const due = list().filter(c => c.enabled && (!c.state.lastAt || now - c.state.lastAt >= c.interval * 1000 - 1000));
    for (let i = 0; i < due.length; i += CONCURRENCY) await Promise.all(due.slice(i, i + CONCURRENCY).map(c => runOne(c).catch(e => console.warn('[uptime]', c.name, e.message))));
    if (now > pruneAt) { pruneAt = now + HOUR; q.pruneRaw.run(now - RAW_KEEP); q.pruneHourly.run(now - HOURLY_KEEP); q.pruneInc.run(now - HOURLY_KEEP); }
  } finally { running = false; }
}
function start() { if (!timer) { timer = setInterval(tick, 5000); if (timer.unref) timer.unref(); setTimeout(tick, 3000); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

// ---- figures ----
/** Uptime % and response time for the last `ms`: raw results for up to 48 h, hourly rows before that. */
function stats(id, ms, now = Date.now()) {
  const from = now - ms;
  let n = 0, ok = 0, msSum = 0;
  const rawFrom = Math.max(from, now - RAW_KEEP);
  for (const r of q.raw.all(id, rawFrom)) { n++; ok += r.ok; msSum += r.ms || 0; }
  if (from < rawFrom) {
    // hours fully before the raw window
    for (const h of q.hourly.all(id, Math.floor(from / HOUR) * HOUR)) { if (h.hour + HOUR > rawFrom) continue; n += h.n; ok += h.ok; msSum += h.ms_sum; }
  }
  return { n, uptime: n ? Math.round((ok / n) * 100000) / 1000 : null, avgMs: n ? Math.round(msSum / n) : null };
}
/** Points for the graph: raw for ≤ 48 h (grouped into ≤ 288 buckets), hourly before. */
function series(id, ms, now = Date.now()) {
  const from = now - ms;
  if (ms <= RAW_KEEP) {
    const rows = q.raw.all(id, from);
    const buckets = Math.min(288, Math.max(24, Math.round(ms / 300000)));
    const size = ms / buckets, out = [];
    for (let i = 0; i < buckets; i++) out.push({ t: Math.round(from + i * size), n: 0, ok: 0, ms: 0, max: 0 });
    for (const r of rows) { const b = out[Math.min(buckets - 1, Math.floor((r.t - from) / size))]; b.n++; b.ok += r.ok; b.ms += r.ms || 0; b.max = Math.max(b.max, r.ms || 0); }
    return out.map(b => ({ t: b.t, n: b.n, ok: b.ok, avg: b.n ? Math.round(b.ms / b.n) : null, max: b.max || null }));
  }
  return q.hourly.all(id, Math.floor(from / HOUR) * HOUR).map(h => ({ t: h.hour, n: h.n, ok: h.ok, avg: h.n ? Math.round(h.ms_sum / h.n) : null, max: h.ms_max }));
}
/** Last 24 hours as 24 hourly squares for the list: up / down / mixed / none. */
function bar24(id, now = Date.now()) {
  const from = Math.floor((now - 23 * HOUR) / HOUR) * HOUR;
  const map = new Map(q.hourly.all(id, from).map(h => [h.hour, h]));
  const out = [];
  for (let h = from; h <= now; h += HOUR) { const x = map.get(h); out.push(!x ? 0 : x.ok === x.n ? 1 : x.ok === 0 ? 3 : 2); }
  return out;
}
function summary(c, now = Date.now()) {
  return { ...c, uptime24: stats(c.id, DAY, now).uptime, uptime30: stats(c.id, 30 * DAY, now).uptime, bar: bar24(c.id, now) };
}
function detail(id, range = DAY) {
  const c = get(id); if (!c) return null;
  const now = Date.now();
  return { ...c, periods: { d1: stats(c.id, DAY, now), d7: stats(c.id, 7 * DAY, now), d30: stats(c.id, 30 * DAY, now), d90: stats(c.id, 90 * DAY, now) }, series: series(c.id, range, now), incidents: q.incidents.all(c.id, 50) };
}

module.exports = { list, get, create, update, remove, setPaused, runOne, tick, start, stop, stats, series, bar24, summary, detail, message, RAW_KEEP, HOUR, DAY };
