// Fail2ban — pure helpers (no I/O): durations, the ban-time growth fail2ban really uses, DockGate's
// managed config files, parsing of fail2ban-client output, and detection of settings that cannot work.
//
// Facts this file relies on (fail2ban 0.11 / 1.0, server/jail.py + server/database.py):
//  - bantime.increment, default formula:  max(bantime, bantime * 2^count * factor), capped at maxtime,
//    where count = previous bans of that IP (1st ban → count 0 → plain bantime).
//  - The ban history used for that ("bips") is purged once a ban is older than
//    dbpurgeage + 3 × its bantime — so a 24h ban is remembered for about dbpurgeage + 3 days.
//  - recidive reads fail2ban's OWN log ("Ban <ip>" lines), by default /var/log/fail2ban.log.
const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const isIpOrCidr = (v) => require('../provision/catalog').isIpOrCidr(v); // lazy: catalog requires this module

const JAIL_FILE = '/etc/fail2ban/jail.d/dockgate.conf';
const DAEMON_FILE = '/etc/fail2ban/fail2ban.d/dockgate.conf';
const LOG_FILE = '/var/log/fail2ban.log';

// Defaults = the admin's own tuned config (kept as the starting point), with recidive made workable.
const DEFAULTS = {
  sshd: { maxretry: 3, findtime: '1d', bantime: '24h', increment: true, factor: 2, maxtime: '30d', mode: 'normal' },
  recidive: { enabled: true, maxretry: 3, findtime: '30d', bantime: '1w' },
  ignoreip: [],
  dbpurgeage: '30d',
};

// ---------------------------------------------------------------- durations
const UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
/** fail2ban duration ("1d", "24h", "1d12h", "600") → seconds, or null when invalid. */
function toSeconds(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^(\d+[smhdw])+$/.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+)([smhdw])/g)) total += Number(m[1]) * UNIT[m[2]];
  return total;
}
/** Seconds → short human text ("24h", "4d", "1w 2d"). */
function human(sec) {
  if (sec == null) return '—';
  if (sec < 0) return 'permanent';
  const d = Math.floor(sec / 86400), h = Math.round((sec % 86400) / 3600);
  if (d >= 1) return h ? `${d}d ${h}h` : `${d}d`;
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}
function assertDuration(v, label) {
  const s = toSeconds(v);
  if (s == null || s <= 0) throw httpError(400, `${label}: use a number of seconds or units like 30m, 24h, 1d, 1w`);
  return String(v).trim().toLowerCase();
}

/** The ban length of the 1st…nth ban of the same IP (seconds), as fail2ban computes it. */
function banSequence({ bantime, increment, factor, maxtime }, n = 6) {
  const b = toSeconds(bantime), max = toSeconds(maxtime);
  const f = Number(factor) || 1;
  const out = [];
  for (let count = 0; count < n; count++) {
    let t = increment ? Math.max(b, b * Math.pow(2, Math.min(count, 20)) * f) : b;
    if (count === 0) t = b;
    if (increment && max) t = Math.min(t, max);
    out.push(t);
  }
  return out;
}

/** How long fail2ban remembers a ban for the increment (seconds after the ban started). */
const memoryAfterBan = (bantimeSec, dbpurgeageSec) => dbpurgeageSec + 3 * bantimeSec;

// ---------------------------------------------------------------- validation + config files
const MODES = ['normal', 'aggressive', 'ddos', 'extra'];

/** Validate + normalise the settings form. Throws 400 with a field-specific message. */
function normalizeSettings(input) {
  const s = input || {};
  const sshd = s.sshd || {}, rec = s.recidive || {};
  const int = (v, lo, hi, label) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw httpError(400, `${label} must be ${lo}–${hi}`); return n; };
  const out = {
    sshd: {
      maxretry: int(sshd.maxretry, 1, 50, 'sshd max retries'),
      findtime: assertDuration(sshd.findtime, 'sshd find time'),
      bantime: assertDuration(sshd.bantime, 'sshd ban time'),
      increment: !!sshd.increment,
      factor: (() => { const f = Number(sshd.factor); if (!(f >= 0.5 && f <= 10)) throw httpError(400, 'Growth factor must be 0.5–10'); return f; })(),
      maxtime: assertDuration(sshd.maxtime, 'Max ban time'),
      mode: MODES.includes(sshd.mode) ? sshd.mode : (() => { throw httpError(400, 'Mode must be normal, aggressive, ddos or extra'); })(),
    },
    recidive: {
      enabled: !!rec.enabled,
      maxretry: int(rec.maxretry, 1, 50, 'recidive max bans'),
      findtime: assertDuration(rec.findtime, 'recidive window'),
      bantime: assertDuration(rec.bantime, 'recidive ban time'),
    },
    ignoreip: [],
    dbpurgeage: assertDuration(s.dbpurgeage || DEFAULTS.dbpurgeage, 'History kept'),
  };
  for (const ip of (Array.isArray(s.ignoreip) ? s.ignoreip : [])) {
    const v = String(ip).trim();
    if (!v) continue;
    if (!isIpOrCidr(v)) throw httpError(400, `Whitelist: "${v}" is not an IP address or CIDR`);
    if (!out.ignoreip.includes(v)) out.ignoreip.push(v);
  }
  if (out.ignoreip.length > 50) throw httpError(400, 'Whitelist: at most 50 entries');
  return out;
}

/** /etc/fail2ban/jail.d/dockgate.conf from settings. `sshPort` keeps the jail on sshd's real port. */
function buildJailConf(s, sshPort) {
  const L = ['# Managed by DockGate (Server Console → Fail2ban). Edit there, not by hand.',
    '# /etc/fail2ban/jail.local and jail.d/*.local are read after this file and override it.', ''];
  L.push('[DEFAULT]', `ignoreip = ${['127.0.0.1/8', '::1', ...s.ignoreip].join(' ')}`, '');
  L.push('[sshd]', 'enabled = true', 'backend = systemd', `port = ${Number(sshPort) || 22}`, `mode = ${s.sshd.mode}`,
    `maxretry = ${s.sshd.maxretry}`, `findtime = ${s.sshd.findtime}`, `bantime = ${s.sshd.bantime}`,
    `bantime.increment = ${s.sshd.increment ? 'true' : 'false'}`);
  if (s.sshd.increment) L.push(`bantime.factor = ${s.sshd.factor}`, `bantime.maxtime = ${s.sshd.maxtime}`);
  L.push('');
  L.push('[recidive]', `enabled = ${s.recidive.enabled ? 'true' : 'false'}`);
  if (s.recidive.enabled) {
    // recidive reads fail2ban's own log FILE — never the journal (fail2ban does not log there by default).
    L.push('backend = auto', `logpath = ${LOG_FILE}`, `maxretry = ${s.recidive.maxretry}`, `findtime = ${s.recidive.findtime}`, `bantime = ${s.recidive.bantime}`);
  }
  return L.join('\n') + '\n';
}

/** /etc/fail2ban/fail2ban.d/dockgate.conf — daemon settings the jails depend on. */
function buildDaemonConf(s) {
  return ['# Managed by DockGate. fail2ban.local (if present) is read after this file and overrides it.',
    '[Definition]', `logtarget = ${LOG_FILE}`, `dbpurgeage = ${s.dbpurgeage}`, ''].join('\n');
}

/** Read DockGate's jail file back into settings (unknown → defaults). */
function parseJailConf(text) {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (!text || !String(text).trim()) return null;
  let sec = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { sec = h[1]; continue; }
    const m = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1], v = m[2].trim();
    if (sec === 'DEFAULT' && k === 'ignoreip') s.ignoreip = v.split(/\s+/).filter(x => x && x !== '127.0.0.1/8' && x !== '::1');
    if (sec === 'sshd') {
      if (k === 'maxretry') s.sshd.maxretry = Number(v);
      if (k === 'findtime') s.sshd.findtime = v;
      if (k === 'bantime') s.sshd.bantime = v;
      if (k === 'bantime.increment') s.sshd.increment = v === 'true';
      if (k === 'bantime.factor') s.sshd.factor = Number(v);
      if (k === 'bantime.maxtime') s.sshd.maxtime = v;
      if (k === 'mode') s.sshd.mode = v;
    }
    if (sec === 'recidive') {
      if (k === 'enabled') s.recidive.enabled = v === 'true';
      if (k === 'maxretry') s.recidive.maxretry = Number(v);
      if (k === 'findtime') s.recidive.findtime = v;
      if (k === 'bantime') s.recidive.bantime = v;
    }
  }
  return s;
}
function parseDaemonConf(text) {
  const m = /^\s*dbpurgeage\s*=\s*(\S+)/m.exec(String(text || ''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- runtime parsing
/** `fail2ban-client status` → jail names. */
function parseJailList(out) {
  const m = /Jail list:\s*(.*)$/m.exec(String(out || ''));
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}
/** `fail2ban-client status <jail>` → counters. */
function parseJailStatus(out) {
  const n = (re) => { const m = re.exec(String(out || '')); return m ? Number(m[1]) : 0; };
  return {
    currentlyFailed: n(/Currently failed:\s*(\d+)/), totalFailed: n(/Total failed:\s*(\d+)/),
    currentlyBanned: n(/Currently banned:\s*(\d+)/), totalBanned: n(/Total banned:\s*(\d+)/),
  };
}
/** `fail2ban-client get <jail> banip --with-time` → [{ ip, bannedAt, until }]. Falls back to a plain IP list. */
function parseBanList(out) {
  const res = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*\+\s*(-?\d+)\s*=\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d|\S+)/.exec(line.trim());
    if (m && isIpOrCidr(m[1])) { res.push({ ip: m[1], bannedAt: m[2], seconds: Number(m[3]), until: m[4] }); continue; }
    for (const tok of line.trim().split(/\s+/)) if (tok && isIpOrCidr(tok)) res.push({ ip: tok, bannedAt: null, seconds: null, until: null });
  }
  return res;
}
/** "Ban"/"Unban" lines from fail2ban.log → history (newest first). */
function parseHistory(out) {
  const res = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)[,.\d]*\s.*?\[([\w.-]+)\]\s+(Increase Ban|Ban|Unban|Restore Ban)\s+(\S+)/.exec(line);
    if (m && isIpOrCidr(m[4])) res.push({ time: m[1], jail: m[2], action: m[3], ip: m[4] });
  }
  return res.reverse();
}
/** "key=value" lines (our per-jail getter dump). */
function parseKv(out) {
  const r = {};
  for (const line of String(out || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) r[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return r;
}

// ---------------------------------------------------------------- problems
/**
 * Settings that look right but cannot do what they say — computed from the EFFECTIVE runtime values.
 * ctx: { settings, runtime: { dbpurgeage (s), jails:[names], recidiveLogpath }, sshPort, jailPort, jailLocal, dockgateIp, banned:[ip] }
 */
function detectProblems(ctx) {
  const p = [];
  const s = ctx.settings;
  if (ctx.dockgateIp && (ctx.banned || []).includes(ctx.dockgateIp)) {
    p.push({ level: 'crit', text: `DockGate's own IP (${ctx.dockgateIp}) is banned — unban it, or add it to the whitelist.` });
  }
  if (ctx.jailPort && ctx.sshPort && !String(ctx.jailPort).split(/[,\s]+/).some(x => x === String(ctx.sshPort) || (x === 'ssh' && Number(ctx.sshPort) === 22))) {
    p.push({ level: 'crit', text: `The sshd jail bans port ${ctx.jailPort}, but SSH listens on ${ctx.sshPort} — banned IPs can still reach SSH. Save the settings to fix it.`, fix: 'save' });
  }
  if (s && s.sshd.increment) {
    const seq = banSequence(s.sshd, 3);
    const purge = ctx.runtime && ctx.runtime.dbpurgeage != null ? Number(ctx.runtime.dbpurgeage) : toSeconds(s.dbpurgeage);
    const mem = memoryAfterBan(seq[0], purge);
    if (purge < toSeconds(s.sshd.findtime) || mem < 7 * 86400) {
      p.push({ level: 'warn', text: `Ban history is kept only about ${human(mem)} after a first ban (dbpurgeage ${human(purge)}). An IP that comes back later starts again at ${human(seq[0])}. Raise "History kept" to remember repeat offenders longer.` });
    }
  }
  if (s && s.recidive.enabled) {
    const seq = banSequence(s.sshd, s.recidive.maxretry);
    const needed = seq.slice(0, Math.max(0, s.recidive.maxretry - 1)).reduce((a, b) => a + b, 0);
    if (needed >= toSeconds(s.recidive.findtime)) {
      p.push({ level: 'crit', text: `recidive can never trigger: ${s.recidive.maxretry} sshd bans of one IP take at least ${human(needed)} (each ban must expire first), but its window is ${human(toSeconds(s.recidive.findtime))}. Make the window longer than ${human(needed)} or lower "bans before".`, fix: 'save' });
    }
    if (ctx.runtime && ctx.runtime.jails && ctx.runtime.jails.includes('recidive') && ctx.runtime.recidiveLogpath != null && !/fail2ban\.log/.test(ctx.runtime.recidiveLogpath)) {
      p.push({ level: 'crit', text: 'recidive is not reading /var/log/fail2ban.log (it was set to the systemd journal, where fail2ban does not write its ban lines). Save the settings to fix it.', fix: 'save' });
    }
  }
  if (ctx.jailLocal) p.push({ level: 'info', text: '/etc/fail2ban/jail.local also sets sshd/recidive options — it is read after DockGate\'s file and wins where both set the same option.' });
  return p;
}

module.exports = {
  JAIL_FILE, DAEMON_FILE, LOG_FILE, DEFAULTS, MODES,
  toSeconds, human, banSequence, memoryAfterBan, normalizeSettings, buildJailConf, buildDaemonConf, parseJailConf, parseDaemonConf,
  parseJailList, parseJailStatus, parseBanList, parseHistory, parseKv, detectProblems,
};
