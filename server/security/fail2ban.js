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
  recidive: { enabled: true, maxretry: 3, findtime: '30d', bantime: '1w', increment: false, factor: 2, maxtime: '90d' },
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
      // Longer recidive bans for IPs that come back (off by default). Older clients send nothing → defaults.
      increment: !!rec.increment,
      factor: rec.factor == null ? DEFAULTS.recidive.factor : (() => { const f = Number(rec.factor); if (!(f >= 0.5 && f <= 10)) throw httpError(400, 'recidive growth factor must be 0.5–10'); return f; })(),
      maxtime: assertDuration(rec.maxtime == null ? DEFAULTS.recidive.maxtime : rec.maxtime, 'recidive longest ban'),
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
    // Always explicit, so a bantime.* line under [DEFAULT] in another file cannot change recidive behind DockGate's back.
    L.push(`bantime.increment = ${s.recidive.increment ? 'true' : 'false'}`);
    if (s.recidive.increment) L.push(`bantime.factor = ${s.recidive.factor}`, `bantime.maxtime = ${s.recidive.maxtime}`);
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
      if (k === 'bantime.increment') s.recidive.increment = v === 'true';
      if (k === 'bantime.factor') s.recidive.factor = Number(v);
      if (k === 'bantime.maxtime') s.recidive.maxtime = v;
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


// ---------------------------------------------------------------- where a jail option comes from
/** "file|jail|key = value" lines (READ_FAIL2BAN @@f2bsrc) → [{ file, jail, key, value }]. */
function parseSources(out) {
  const res = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^([^|]+)\|(sshd|recidive|DEFAULT|Definition)\|\s*([A-Za-z][A-Za-z.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !m[4].startsWith('#')) res.push({ file: m[1], jail: m[2], key: m[3].toLowerCase(), value: m[4] });
  }
  return res;
}
/**
 * fail2ban reads jail.conf, jail.d/*.conf (sorted), jail.local, jail.d/*.local (sorted) — and the same order for
 * fail2ban.conf / fail2ban.d / fail2ban.local; a later file wins. True when `file` is read after DockGate's own.
 */
function readAfterDockgate(file) {
  if (file === JAIL_FILE || file === DAEMON_FILE) return false;
  if (file.endsWith('.local')) return true;
  const dir = file.slice(0, file.lastIndexOf('/') + 1), base = file.slice(file.lastIndexOf('/') + 1);
  return (dir === '/etc/fail2ban/jail.d/' || dir === '/etc/fail2ban/fail2ban.d/') && base.endsWith('.conf') && base > 'dockgate.conf';
}
const isDaemonFile = (file) => /\/fail2ban\.(local|conf)$|\/fail2ban\.d\//.test(file);
/** Files read after DockGate's that set one of `keys` for `jail` — they override DockGate's value. */
function overridesOf(sources, jail, keys) {
  return (sources || []).filter(x => x.jail === jail && keys.includes(x.key) && readAfterDockgate(x.file));
}
const named = (list) => [...new Map(list.map(x => [x.file + x.key, x])).values()].map(x => `${x.file} sets "${x.key} = ${x.value}"`).join('; ');
/** One jail section of an INI text as { key: value }. */
function sectionOf(text, name) {
  const out = {}; let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const h = /^\[([^\]]+)\]$/.exec(l); if (h) { cur = h[1].trim(); continue; }
    const kv = /^([A-Za-z][A-Za-z.]*)\s*=\s*(.*)$/.exec(l);
    if (kv && cur === name) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}


/** The values fail2ban really runs with (runtime), falling back to DockGate's settings where unknown. */
function effectiveOf(ctx) {
  const s = ctx.settings, o = (ctx.runtime && ctx.runtime.jailOpts) || {};
  const sh = o.sshd || {}, rc = o.recidive || {};
  const pick = (v, d) => (v == null || Number.isNaN(v) ? d : v);
  return {
    sshd: { bantime: pick(sh.bantime, toSeconds(s.sshd.bantime)), increment: pick(sh.increment, s.sshd.increment), factor: pick(sh.factor, s.sshd.factor), maxtime: pick(sh.maxtime, toSeconds(s.sshd.maxtime)) },
    recidive: { maxretry: pick(rc.maxretry, s.recidive.maxretry), findtime: pick(rc.findtime, toSeconds(s.recidive.findtime)) },
  };
}
/** Seconds the first `n` sshd bans of one IP take, back to back — recidive needs maxretry bans inside its window. */
function recidiveNeeds(sshd, maxretry) {
  const seq = banSequence(sshd, maxretry);
  return seq.slice(0, Math.max(0, maxretry - 1)).reduce((a, b) => a + b, 0);
}
const ip4 = (ip) => { const p = String(ip).split('.').map(Number); return p.length === 4 && p.every(n => n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; };
/** Is `ip` inside one of the entries (exact IPs or IPv4 CIDRs; 127.0.0.1/8 also matches its 127.0.0.0/8 form). */
function coveredBy(ip, list) {
  const n = ip4(ip);
  return (list || []).some(e => {
    if (e === ip) return true;
    const [net, bits] = String(e).split('/');
    if (n == null || bits == null) return false;
    const base = ip4(net), b = Number(bits);
    if (base == null || !(b >= 0 && b <= 32)) return false;
    const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

// ---------------------------------------------------------------- take over [sshd] / [recidive] from other files
const LOCALHOST = ['127.0.0.1/8', '::1', '127.0.0.0/8'];
/** Files read after DockGate's that change what DockGate manages: [sshd], [recidive], the [DEFAULT] ignoreip, the daemon's dbpurgeage / logtarget. */
function overridingFiles(sources) {
  const out = [];
  for (const x of sources || []) {
    if (!readAfterDockgate(x.file)) continue;
    const hit = isDaemonFile(x.file) ? (x.jail === 'Definition' && ['dbpurgeage', 'logtarget'].includes(x.key))
      : (x.jail === 'sshd' || x.jail === 'recidive' || (x.jail === 'DEFAULT' && x.key === 'ignoreip'));
    if (hit && !out.includes(x.file)) out.push(x.file);
  }
  return out;
}
/**
 * The text of `text` without what DockGate takes over. Jail files: the [sshd] and [recidive] sections and the
 * [DEFAULT] ignoreip line; daemon files: dbpurgeage and logtarget under [Definition]. Comments, other jails and
 * other options stay exactly as they are (continuation lines of a removed option go with it).
 */
function stripTakenOver(text, file) {
  const daemon = isDaemonFile(file);
  const out = []; let sec = null, dropping = false;
  for (const line of String(text).split('\n')) {
    const h = /^\s*\[([^\]]+)\]/.exec(line);
    if (h) { sec = h[1].trim(); dropping = false; if (!daemon && (sec === 'sshd' || sec === 'recidive')) continue; out.push(line); continue; }
    if (!daemon && (sec === 'sshd' || sec === 'recidive')) continue;
    if (dropping && /^[ \t]+\S/.test(line) && !/^\s*[#;]/.test(line)) continue; // continuation of a removed option
    dropping = false;
    const kv = /^([A-Za-z][A-Za-z.]*)\s*[=:]/.exec(line);
    if (kv && ((!daemon && sec === 'DEFAULT' && kv[1].toLowerCase() === 'ignoreip') || (daemon && sec === 'Definition' && ['dbpurgeage', 'logtarget'].includes(kv[1].toLowerCase())))) { dropping = true; continue; }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
const SSHD_MAP = { maxretry: 'maxretry', findtime: 'findtime', bantime: 'bantime', 'bantime.increment': 'increment', 'bantime.factor': 'factor', 'bantime.maxtime': 'maxtime', mode: 'mode' };
const REC_MAP = { enabled: 'enabled', maxretry: 'maxretry', findtime: 'findtime', bantime: 'bantime', 'bantime.increment': 'increment', 'bantime.factor': 'factor', 'bantime.maxtime': 'maxtime' };
const WHY_NOT = {
  port: 'DockGate bans the port SSH really listens on and moves it when the port changes',
  backend: 'DockGate writes the backend that works (systemd for sshd, auto for recidive)',
  logpath: 'DockGate writes the log recidive must read (/var/log/fail2ban.log)',
  filter: 'the filter is named after the jail already',
  banaction: "the distro's default ban action is used",
  logtarget: 'recidive reads /var/log/fail2ban.log, so fail2ban must log there',
};
/**
 * Moving fail2ban's sshd / recidive / allowlist / history settings out of other files into DockGate's own.
 * Values DockGate manages are carried over (when valid); a recidive that could never trigger is corrected;
 * DockGate's own IP is added to the allowlist. Returns the new settings and every file before → after.
 */
function planTakeover({ settings, sources, texts, dockgateIp, sshPort }) {
  const files = overridingFiles(sources);
  let cur = JSON.parse(JSON.stringify(settings));
  const adopted = [], removed = [], corrected = [], kept = [];
  const tryApply = (mut, item) => {
    const next = JSON.parse(JSON.stringify(cur)); mut(next);
    try { cur = normalizeSettings(next); adopted.push(item); } catch (e) { removed.push({ ...item, reason: `not valid: ${e.message}` }); }
  };
  for (const x of (sources || []).filter(y => files.includes(y.file))) {
    const item = { file: x.file, jail: x.jail, key: x.key, value: x.value };
    if (x.jail === 'sshd' && SSHD_MAP[x.key]) {
      const k = SSHD_MAP[x.key];
      tryApply(n => { n.sshd[k] = k === 'increment' ? /^(true|yes|1)$/i.test(x.value) : (k === 'maxretry' || k === 'factor') ? Number(x.value) : x.value; }, item);
    } else if (x.jail === 'recidive' && REC_MAP[x.key]) {
      const k = REC_MAP[x.key];
      tryApply(n => { n.recidive[k] = (k === 'enabled' || k === 'increment') ? /^(true|yes|1)$/i.test(x.value) : (k === 'maxretry' || k === 'factor') ? Number(x.value) : x.value; }, item);
    } else if (x.jail === 'DEFAULT' && x.key === 'ignoreip') {
      const ips = x.value.split(/[\s,]+/).filter(v => v && !LOCALHOST.includes(v));
      if (ips.length) tryApply(n => { for (const ip of ips) if (!n.ignoreip.includes(ip)) n.ignoreip.push(ip); }, { ...item, value: ips.join(' ') });
      else removed.push({ ...item, reason: "only localhost, which DockGate's allowlist always contains — this line was hiding DockGate's allowlist" });
    } else if (x.key === 'enabled' && x.jail === 'sshd') {
      removed.push({ ...item, reason: "the sshd jail is always on in DockGate's file" });
    } else if (x.jail === 'Definition' && x.key === 'dbpurgeage') {
      tryApply(n => { n.dbpurgeage = x.value; }, item);
    } else if (x.jail === 'DEFAULT') {
      kept.push(item); // other [DEFAULT] options stay where they are (they also apply to the user's other jails)
    } else {
      removed.push({ ...item, reason: WHY_NOT[x.key] || 'DockGate does not manage this option; it goes with the section' });
    }
  }
  if (dockgateIp && !coveredBy(dockgateIp, cur.ignoreip) && cur.ignoreip.length < 50) {
    cur.ignoreip.push(dockgateIp);
    corrected.push({ what: 'Allowlist', from: '—', to: `+ ${dockgateIp}`, why: "DockGate's own address, so fail2ban never bans the connection that manages it" });
  }
  if (cur.recidive.enabled) {
    const need = recidiveNeeds(cur.sshd, cur.recidive.maxretry);
    if (need >= toSeconds(cur.recidive.findtime)) {
      const from = `${cur.recidive.maxretry} bans within ${cur.recidive.findtime}`;
      cur.recidive.maxretry = DEFAULTS.recidive.maxretry; cur.recidive.findtime = DEFAULTS.recidive.findtime;
      const need2 = recidiveNeeds(cur.sshd, cur.recidive.maxretry);
      if (need2 >= toSeconds(cur.recidive.findtime)) cur.recidive.findtime = `${Math.ceil(need2 * 1.5 / 86400)}d`;
      cur = normalizeSettings(cur);
      corrected.push({ what: 'recidive', from, to: `${cur.recidive.maxretry} bans within ${cur.recidive.findtime}`, why: `${from.split(' ')[0]} sshd bans of one IP take at least ${human(need)} — each ban must end before the next — so it could never trigger` });
    }
  }
  return {
    settings: cur, adopted, removed, corrected, kept,
    files: files.map(path => ({ path, before: texts[path] || '', after: stripTakenOver(texts[path] || '', path).replace(/\s*$/, '\n') })),
    dockgate: [{ path: JAIL_FILE, text: buildJailConf(cur, sshPort) }, { path: DAEMON_FILE, text: buildDaemonConf(cur) }],
  };
}

// ---------------------------------------------------------------- problems
/**
 * Settings that look right but cannot do what they say — computed from the EFFECTIVE runtime values.
 * ctx: { settings, runtime: { dbpurgeage (s), jails:[names], recidiveLogpath, jailOpts:{sshd,recidive} }, sshPort, jailPort,
 *        jailLocal (files), dockgateIp, banned:[ip], managed, jailFileText (DockGate's jail file), sources (parseSources), active }
 */
function detectProblems(ctx) {
  const p = [];
  const s = ctx.settings;
  const rt = ctx.runtime || {};
  const later = (jail, keys) => overridesOf(ctx.sources, jail, keys);
  const takeoverFix = (list) => (list.length ? 'takeover' : undefined);
  if (ctx.dockgateIp && (ctx.banned || []).includes(ctx.dockgateIp)) {
    p.push({ level: 'crit', text: `DockGate's own IP (${ctx.dockgateIp}) is banned — unban it, or add it to the whitelist.` });
  }
  if (ctx.jailPort && ctx.sshPort && !String(ctx.jailPort).split(/[,\s]+/).some(x => x === String(ctx.sshPort) || (x === 'ssh' && Number(ctx.sshPort) === 22))) {
    const o = later('sshd', ['port']);
    p.push(o.length
      ? { level: 'crit', text: `The sshd jail bans port ${ctx.jailPort}, but SSH listens on ${ctx.sshPort} — banned IPs can still reach SSH. Cause: ${named(o)} under [sshd], read after DockGate's file. Move the settings to DockGate to fix it.`, fix: 'takeover' }
      : { level: 'crit', text: `The sshd jail bans port ${ctx.jailPort}, but SSH listens on ${ctx.sshPort} — banned IPs can still reach SSH. Save the settings to fix it.`, fix: 'save' });
  }
  // The allowlist fail2ban really uses: a [DEFAULT] ignoreip in a later file replaces DockGate's.
  const runIgnore = rt.ignoreip;
  if (s && ctx.managed && Array.isArray(runIgnore)) {
    const missing = (s.ignoreip || []).filter(ip => !coveredBy(ip, runIgnore));
    if (missing.length) {
      const o = later('DEFAULT', ['ignoreip']);
      p.push({ level: 'crit', text: `The allowlist is not in effect: fail2ban can still ban ${missing.join(', ')}. ${o.length ? `Cause: ${named(o)} under [DEFAULT], read after DockGate's file, so it replaces DockGate's allowlist. Move the settings to DockGate to fix it.` : 'fail2ban was not reloaded after the allowlist changed. Fix now writes it again and reloads.'}`, fix: o.length ? 'takeover' : 'save' });
    }
  }
  if (ctx.dockgateIp && Array.isArray(runIgnore) && !(ctx.banned || []).includes(ctx.dockgateIp) && !coveredBy(ctx.dockgateIp, runIgnore) && !(s && coveredBy(ctx.dockgateIp, s.ignoreip))) {
    p.push({ level: 'warn', text: `DockGate's address (${ctx.dockgateIp}) is not in the allowlist. If its key login fails a few times, fail2ban bans DockGate itself — for up to the longest ban.`, fix: 'allowdg' });
  }
  if (s && s.sshd.increment) {
    const seq = banSequence(s.sshd, 3);
    const purge = rt.dbpurgeage != null ? Number(rt.dbpurgeage) : toSeconds(s.dbpurgeage);
    const mem = memoryAfterBan(seq[0], purge);
    if (purge < toSeconds(s.sshd.findtime) || mem < 7 * 86400) {
      p.push({ level: 'warn', text: `Ban history is kept only about ${human(mem)} after a first ban (dbpurgeage ${human(purge)}). An IP that comes back later starts again at ${human(seq[0])}. Raise "History kept" to remember repeat offenders longer.` });
    }
  }
  // Daemon options DockGate needs, replaced by fail2ban.local / fail2ban.d/*.local.
  const dOver = (ctx.sources || []).filter(x => x.jail === 'Definition' && ['dbpurgeage', 'logtarget'].includes(x.key) && readAfterDockgate(x.file));
  const badLog = dOver.filter(x => x.key === 'logtarget' && x.value !== LOG_FILE);
  if (badLog.length) p.push({ level: 'crit', text: `fail2ban does not log to ${LOG_FILE}: ${named(badLog)}. recidive reads that file, so it never sees a ban. Move the settings to DockGate to fix it.`, fix: 'takeover' });
  const purgeOver = ctx.managed && s ? dOver.filter(x => x.key === 'dbpurgeage' && toSeconds(x.value) !== toSeconds(s.dbpurgeage)) : [];
  if (purgeOver.length) p.push({ level: 'warn', text: `History kept is ${purgeOver[purgeOver.length - 1].value}, not ${s.dbpurgeage} as set in DockGate: ${named(purgeOver)}, read after DockGate's file.`, fix: 'takeover' });

  const recRunning = rt.jails && rt.jails.includes('recidive');
  if (s && (s.recidive.enabled || recRunning)) {
    // Checked with the values fail2ban runs with — another file may have changed them.
    const eff = effectiveOf(ctx);
    const needed = recidiveNeeds(eff.sshd, eff.recidive.maxretry);
    if ((recRunning || s.recidive.enabled) && needed >= eff.recidive.findtime) {
      const fromRun = rt.jailOpts && rt.jailOpts.recidive && (eff.recidive.maxretry !== s.recidive.maxretry || eff.recidive.findtime !== toSeconds(s.recidive.findtime));
      const o = later('recidive', ['maxretry', 'findtime']);
      p.push({ level: 'crit', text: `recidive can never trigger: ${eff.recidive.maxretry} sshd bans of one IP take at least ${human(needed)} (each ban must expire first), but its window is ${human(eff.recidive.findtime)}${fromRun ? ' — these are the values fail2ban runs with' + (o.length ? `, from ${named(o)}` : '') : ''}. ${o.length ? 'Move the settings to DockGate: it carries your values over and corrects this one.' : `Make the window longer than ${human(needed)} or lower "bans before".`}`, fix: o.length ? 'takeover' : 'save' });
    }
  }
  if (s && s.recidive.enabled) {
    if (recRunning && rt.recidiveLogpath != null && !/fail2ban\.log/.test(rt.recidiveLogpath)) {
      // recidive counts fail2ban's own "Ban" lines, which only go to /var/log/fail2ban.log. Say why it reads
      // something else: a file read after DockGate's wins, DockGate's file lacks the line, or no reload yet.
      const now = String(rt.recidiveLogpath).replace(/^[`|\-\s]+/, '').trim();
      const head = `recidive ${!now || /no file/i.test(now) ? 'reads the systemd journal, not a log file,' : `reads ${now}`} instead of /var/log/fail2ban.log, so it never sees a ban and never triggers.`;
      const o = later('recidive', ['backend', 'logpath']);
      const own = sectionOf(ctx.jailFileText, 'recidive');
      if (o.length) p.push({ level: 'crit', text: `${head} Cause: ${named(o)} under [recidive]. fail2ban reads that file after DockGate's, so it wins and Save alone cannot fix it. Move the settings to DockGate: the [recidive] section is taken out of that file (a backup is kept) and DockGate's values apply.`, fix: 'takeover' });
      else if (!/fail2ban\.log/.test(own.logpath || '')) p.push({ level: 'crit', text: `${head} DockGate's file does not set it yet. Fix now writes backend = auto and logpath = /var/log/fail2ban.log for recidive, tests the configuration and reloads (bans are kept).`, fix: 'save' });
      else p.push({ level: 'crit', text: `${head} DockGate's file already sets it, but fail2ban is still running older settings (it was not reloaded after the file changed). Fix now writes the file again and reloads (bans are kept).`, fix: 'save' });
    }
    if (ctx.managed && rt.jails && ctx.active !== false && !recRunning) {
      const off = later('recidive', ['enabled']).filter(x => /^(false|no|0)$/i.test(x.value));
      const other = later('recidive', ['backend', 'logpath']);
      p.push(off.length
        ? { level: 'warn', text: `recidive is on in DockGate's settings but not running: ${named(off)} under [recidive], and that file wins over DockGate's. Move the settings to DockGate to use recidive.`, fix: 'takeover' }
        : other.length
          ? { level: 'crit', text: `recidive is on in DockGate's settings but not running: ${named(other)} under [recidive], that file wins over DockGate's, and fail2ban could not start recidive with it. Move the settings to DockGate to fix it.`, fix: 'takeover' }
          : { level: 'warn', text: 'recidive is on in DockGate\'s settings but not running: fail2ban was not reloaded after the file changed, or the jail failed to start (its reason is in the fail2ban log under Services). Fix now writes the file again, tests it and reloads.', fix: 'save' });
    }
  }
  // Running values that differ from DockGate's file: another file wins, or fail2ban was not reloaded.
  if (s && ctx.managed && rt.jailOpts) {
    const want = { sshd: { maxretry: s.sshd.maxretry, findtime: toSeconds(s.sshd.findtime), bantime: toSeconds(s.sshd.bantime) } };
    if (s.recidive.enabled) want.recidive = { maxretry: s.recidive.maxretry, findtime: toSeconds(s.recidive.findtime), bantime: toSeconds(s.recidive.bantime) };
    for (const [jail, w] of Object.entries(want)) {
      const got = rt.jailOpts[jail];
      if (!got) continue;
      const diff = Object.keys(w).filter(k => got[k] != null && w[k] != null && Number(got[k]) !== Number(w[k]));
      if (!diff.length) continue;
      const shown = diff.map(k => `${k} ${k === 'maxretry' ? got[k] : human(got[k])} (DockGate's file: ${k === 'maxretry' ? w[k] : human(w[k])})`).join(', ');
      const o = later(jail, diff);
      p.push(o.length
        ? { level: 'warn', text: `${jail} runs with ${shown}: ${named(o)}, and that file wins over DockGate's. The Jails table shows DockGate's values, not these. Move the settings to DockGate to use one set of values.`, fix: takeoverFix(o) }
        : { level: 'warn', text: `${jail} runs with ${shown} — fail2ban was not reloaded after DockGate's file changed. Fix now writes it again and reloads (bans are kept).`, fix: 'save' });
    }
  }
  if (ctx.jailLocal && !p.some(x => x.fix === 'takeover')) {
    const files = typeof ctx.jailLocal === 'string' ? ctx.jailLocal.trim().split(/\s+/) : ['/etc/fail2ban/jail.local'];
    p.push({ level: 'info', text: `${files.join(', ')} also set${files.length > 1 ? '' : 's'} sshd/recidive options — read after DockGate's file, so ${files.length > 1 ? 'they win' : 'it wins'} where both set the same option.`, fix: 'takeover' });
  }
  return p;
}

module.exports = {
  JAIL_FILE, DAEMON_FILE, LOG_FILE, DEFAULTS, MODES,
  parseSources, overridesOf, readAfterDockgate, sectionOf, effectiveOf, recidiveNeeds, coveredBy, overridingFiles, stripTakenOver, planTakeover, isDaemonFile,
  toSeconds, human, banSequence, memoryAfterBan, normalizeSettings, buildJailConf, buildDaemonConf, parseJailConf, parseDaemonConf,
  parseJailList, parseJailStatus, parseBanList, parseHistory, parseKv, detectProblems,
};
