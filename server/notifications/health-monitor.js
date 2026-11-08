// Server health monitor — once a minute every server is asked for one short snapshot (the same command the
// Monitoring page uses: CPU, memory, disks) over SSH; the local machine is read directly. A server that does
// not answer for a few minutes raises "Server not reachable", and "reachable again" when it is back. Disk,
// memory and CPU are compared with the rule limits (shared, or the server's own). Remote samples are also
// stored as metrics, so the Monitoring history keeps filling while nobody has the page open.
//
// The edge agent does not replace this: an agent cannot report that its own server is down, and it only
// watches Docker's disk use.
const { stmts } = require('../db');
const hostStats = require('../host-stats');
const paths = require('../paths');
const { decrypt } = require('../auth/secrets');
const mailer = require('./mailer');
const telegram = require('./telegram');
const webhook = require('./webhook');
const R = require('./alert-rules');

const INTERVAL_MS = 60 * 1000;
const CONCURRENCY = 3;
const state = new Map();     // serverId → evaluate() state
const lastSent = new Map();  // `${serverId}:${type}` → ms
let timer = null, running = false;

const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
// Times in the timezone chosen in Settings → General (UTC when it is "auto" — the server cannot know the browser's).
const hhmm = (ms) => {
  let tz = 'UTC';
  try { const v = stmts.getSetting.get('timezone')?.value; if (v && v !== 'auto') tz = v; } catch (e) { /* default */ }
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(ms)) + (tz === 'UTC' ? ' UTC' : ''); }
  catch (e) { return new Date(ms).toISOString().slice(11, 16) + ' UTC'; }
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

function serverLabel(s) { return s.id === 'local' ? 'This machine (DockGate host)' : (s.name || s.id); }

function notificationsOn(serverId) {
  if (serverId === 'local') { const row = stmts.getSetting.get('local_notifications_enabled'); return !row || row.value !== '0'; }
  const s = stmts.getServer.get(serverId);
  return !s || s.notifications_enabled !== 0;
}

/** Text of each alert: [subject, telegram text, html body]. */
function message(type, s, data) {
  const name = serverLabel(s);
  const where = s.host ? ` (${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''})` : '';
  const last = data.last ? `Last seen: CPU ${pct(data.last.cpu)} · memory ${pct(data.last.memPct)} · disk ${pct(data.last.diskPct)}` : '';
  switch (type) {
    case 'server_down':
      return [`${name} is not reachable`,
        `🔴 ${name} is not reachable\nNo answer since ${hhmm(data.since)} (${fmtDur(Date.now() - data.since)}). ${data.error || ''}\n${last}`.trim(),
        `<p><b>${esc(name)}</b>${esc(where)} has not answered since ${hhmm(data.since)} (${fmtDur(Date.now() - data.since)}).</p><p>${esc(data.error || '')}</p><p>${esc(last)}</p>`];
    case 'server_up':
      return [`${name} is reachable again`,
        `🟢 ${name} is reachable again\nIt was not reachable for ${fmtDur(data.until - data.since)} (${hhmm(data.since)} – ${hhmm(data.until)}).`,
        `<p><b>${esc(name)}</b>${esc(where)} answers again. It was not reachable for ${fmtDur(data.until - data.since)} (${hhmm(data.since)} – ${hhmm(data.until)}).</p>`];
    case 'host_disk': {
      const d = data.disk; const gb = (b) => (b / 1073741824).toFixed(1); // df -PB1 → bytes
      const size = d.size ? ` — ${gb(d.used)} GB of ${gb(d.size)} GB used` : '';
      return [`${name}: disk ${d.mount} is ${d.usePct}% full`,
        `🟠 ${name}: disk ${d.mount} is ${d.usePct}% full (limit ${data.limit}%)${size}\nFree space with Resources → Prune or remove old files.`,
        `<p>Disk <code>${esc(d.mount)}</code> on <b>${esc(name)}</b> is <b>${d.usePct}%</b> full (limit ${data.limit}%)${esc(size)}.</p><p>DockGate → Resources → Prune shows what Docker can free.</p>`];
    }
    case 'host_mem':
      return [`${name}: memory above ${data.limit}%`,
        `🟠 ${name}: memory above ${data.limit}% for ${data.minutes} min\nNow ${pct(data.value)}.`,
        `<p>Memory on <b>${esc(name)}</b> has been above ${data.limit}% for ${data.minutes} minutes. Now ${pct(data.value)}.</p>`];
    case 'host_cpu':
      return [`${name}: CPU above ${data.limit}%`,
        `🟠 ${name}: CPU above ${data.limit}% for ${data.minutes} min\nNow ${pct(data.value)}.`,
        `<p>CPU on <b>${esc(name)}</b> has been above ${data.limit}% for ${data.minutes} minutes. Now ${pct(data.value)}.</p>`];
    default: return [type, type, esc(type)];
  }
}

async function send(type, s, data) {
  const [subject, text, body] = message(type, s, data);
  return deliver(type, s, subject, text, body, { always: ['server_down', 'server_up'].includes(type) });
}

/**
 * Send one alert to every set-up channel (email, Telegram, webhook), respecting the server's mute and the
 * rule's switch and quiet period. text: Telegram text (first line = title); body: email HTML.
 */
async function deliver(type, s, subject, text, body, { always = false } = {}) {
  if (!notificationsOn(s.id)) return false;
  const rule = stmts.getRule.get(type);
  if (rule && !rule.enabled) return false;
  const key = `${s.id}:${type}`;
  const cd = rule && rule.cooldown_minutes != null ? Number(rule.cooldown_minutes) : 5;
  // Down / up are state changes and always go out; the quiet period applies to repeating alerts.
  if (!always && cd > 0 && lastSent.has(key) && Date.now() - lastSent.get(key) < cd * 60000) return false;
  let sent = false;
  try {
    if (mailer.isConfigured()) { const r = await mailer.sendEmail({ subject: `DockGate: ${subject}`, html: `<div style="font-family:system-ui,sans-serif;font-size:14px">${body}<p style="color:#888;font-size:12px">Sent by DockGate · rule "${esc(rule ? rule.description : type)}"</p></div>`, eventType: type }); if (r && r.success) sent = true; }
    if (telegram.isConfigured()) { const r = await telegram.sendMessage({ text, eventType: type }); if (r && r.success) sent = true; }
    if (webhook.isConfigured()) { const r = await webhook.sendMessage({ title: subject, text: text.split('\n').slice(1).join('\n'), eventType: type, server: s.id }); if (r && r.success) sent = true; }
  } catch (e) { console.warn('[alerts] send failed:', e.message); }
  if (sent) lastSent.set(key, Date.now());
  return sent;
}

function rulesFor(serverId) {
  const ov = {}; for (const o of stmts.getAlertOverrides.all(serverId)) ov[o.event_type] = o;
  const out = {};
  for (const t of R.HEALTH_TYPES) out[t] = R.effective(stmts.getRule.get(t), ov[t]);
  return out;
}

async function sampleServer(s) {
  if (s.id === 'local') {
    const x = await hostStats.collectLocalStats();
    return { ok: true, ...toSample(x) };
  }
  const cfg = { ...s, keyPath: s.key_path ? paths.keyPath(s.key_path) : null, password: decrypt(s.password), passphrase: decrypt(s.passphrase) };
  try {
    const x = await hostStats.collectHostStats(cfg);
    const smp = toSample(x);
    try {
      const swapPct = x.mem && x.mem.swapTotal ? Math.round(x.mem.swapUsed / x.mem.swapTotal * 100) : 0;
      const root = (x.disks || []).find(d => d.mount === '/') || (x.disks || [])[0];
      stmts.insertHostMetric.run(s.id, x.cpu ?? null, smp.memPct, root ? root.usePct : null, swapPct, x.load ? x.load.load1 : null, x.net ? Math.round(x.net.rxBytesSec) : null, x.net ? Math.round(x.net.txBytesSec) : null, x.load ? x.load.procsRunning : null);
      stmts.trimHostMetrics.run(s.id, s.id, 2000);
    } catch (e) { /* history is best effort */ }
    return { ok: true, ...smp };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 200) };
  }
}
function toSample(x) {
  return { cpu: x && x.cpu != null ? x.cpu : null, memPct: x && x.mem && x.mem.total ? Math.round(x.mem.used / x.mem.total * 100) : null, disks: (x && x.disks) || [] };
}

async function checkOne(s) {
  const rules = rulesFor(s.id);
  if (!Object.values(rules).some(r => r.on) && !state.get(s.id)?.down) return; // nothing to watch
  const sample = await sampleServer(s).catch(e => (s.id === 'local' ? null : { ok: false, error: e.message }));
  if (!sample) return; // local read failed (no /proc) — never report the DockGate host itself as down
  const { state: next, alerts } = R.evaluate(state.get(s.id), sample, Date.now(), rules);
  state.set(s.id, next);
  for (const a of alerts) await send(a.type, s, a.data);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const servers = [{ id: 'local', type: 'local' }, ...stmts.getServers.all().filter(s => s.id !== 'local' && s.type !== 'local')];
    let i = 0;
    const worker = async () => { while (i < servers.length) { const s = servers[i++]; try { await checkOne(s); } catch (e) { console.warn(`[health] ${s.id}:`, e.message); } } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, servers.length) }, worker));
  } finally { running = false; }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 15000); // first check shortly after startup
}
function stop() { if (timer) clearInterval(timer); timer = null; }
/** Current state for the UI: { reachable, since, error, last }. */
function statusOf(serverId) {
  const st = state.get(serverId);
  if (!st) return null;
  return { reachable: !st.failSince, since: st.failSince || null, down: !!st.down, error: st.lastError || null, last: st.last || null };
}
function forget(serverId) { state.delete(serverId); for (const k of [...lastSent.keys()]) if (k.startsWith(serverId + ':')) lastSent.delete(k); }

module.exports = { start, stop, tick, statusOf, forget, message, deliver, serverLabel, _state: state };
