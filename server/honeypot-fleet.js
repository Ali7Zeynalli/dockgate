// Honeypot bans shared with every server (Server Console > Security > Honeypot > On all servers).
// A server whose honeypot catches an address "shares" it; every server that "receives" bans it too, in its own
// fail2ban jail `dockgate-fleet` (no log of its own, only the addresses DockGate gives it; every port, Docker's
// published ports included, ipset when there is one). DockGate syncs every 5 minutes: it reads the honeypot bans of
// the sharing servers (with the time each one ends), keeps them in fleet_bans and adds what a receiving server is
// missing. A ban ends on every server when it ends where it was caught (the jail's own 30 days are only a ceiling for
// when DockGate is away). Addresses of DockGate itself, of every managed server, private ranges and the allowlists
// are never spread.
const net = require('net');
const dns = require('dns').promises;
const { db, stmts } = require('./db');
const runner = require('./security/runner');
const paths = require('./paths');
const { decrypt } = require('./auth/secrets');
const HP = require('./honeypot');

const JAIL = 'dockgate-fleet';
const FILTER_FILE = '/etc/fail2ban/filter.d/dockgate-fleet.conf';
const JAIL_FILE = '/etc/fail2ban/jail.d/dockgate-fleet.conf';
const EVERY_MS = 5 * 60000;
const MAX_ACTIVE = 20000;
const CHUNK = 400;            // addresses per fail2ban-client call (well below a command line's limit)
const CEILING = '30d';        // the jail's own ban time; DockGate unbans earlier, when the ban ends where it was caught
const DAY = 86400000;

db.exec(`CREATE TABLE IF NOT EXISTS fleet_servers (
  server_id TEXT PRIMARY KEY, share INTEGER NOT NULL DEFAULT 1, receive INTEGER NOT NULL DEFAULT 0, installed INTEGER NOT NULL DEFAULT 0,
  has_honeypot INTEGER NOT NULL DEFAULT 0, has_fail2ban INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER, error TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS fleet_bans (
  ip TEXT PRIMARY KEY, source TEXT NOT NULL, first_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, unbanned_at INTEGER)`);
const q = {
  servers: db.prepare('SELECT * FROM fleet_servers'),
  server: db.prepare('SELECT * FROM fleet_servers WHERE server_id = ?'),
  ensure: db.prepare('INSERT OR IGNORE INTO fleet_servers (server_id) VALUES (?)'),
  setFlags: db.prepare('UPDATE fleet_servers SET share = ?, receive = ? WHERE server_id = ?'),
  setInstalled: db.prepare('UPDATE fleet_servers SET installed = ? WHERE server_id = ?'),
  seen: db.prepare('UPDATE fleet_servers SET has_honeypot = ?, has_fail2ban = ?, installed = CASE WHEN ? THEN 1 ELSE installed END, active = ?, last_sync = ?, error = ? WHERE server_id = ?'),
  ban: db.prepare('SELECT * FROM fleet_bans WHERE ip = ?'),
  upsert: db.prepare(`INSERT INTO fleet_bans (ip, source, first_seen, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at) WHERE unbanned_at IS NULL`),
  active: db.prepare('SELECT ip FROM fleet_bans WHERE unbanned_at IS NULL AND expires_at > ? ORDER BY first_seen DESC LIMIT ?'),
  recent: db.prepare('SELECT * FROM fleet_bans WHERE unbanned_at IS NULL AND expires_at > ? ORDER BY first_seen DESC LIMIT ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM fleet_bans WHERE unbanned_at IS NULL AND expires_at > ?'),
  unban: db.prepare('UPDATE fleet_bans SET unbanned_at = ? WHERE ip = ?'),
  prune: db.prepare('DELETE FROM fleet_bans WHERE (unbanned_at IS NOT NULL AND unbanned_at < ?) OR expires_at < ?'),
  dropServer: db.prepare('DELETE FROM fleet_servers WHERE server_id = ?'),
};

// ---------------------------------------------------------------- settings
const DEFAULTS = { enabled: false, allow: [] };
function settings() {
  try { return { ...DEFAULTS, ...JSON.parse((stmts.getSetting.get('fleet_bans') || {}).value || '{}') }; } catch (e) { return { ...DEFAULTS }; }
}
function saveSettings(patch) {
  const cur = settings();
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.allow !== undefined) next.allow = HP.checkAllow(patch.allow);
  stmts.setSetting.run('fleet_bans', JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------- servers
const remoteServers = () => stmts.getServers.all().filter(r => r.id !== 'local' && r.type !== 'local');
const cfgOf = (row) => ({ ...row, keyPath: row.key_path ? paths.keyPath(row.key_path) : null, password: decrypt(row.password), passphrase: decrypt(row.passphrase) });
function flagsOf(id) { q.ensure.run(id); return q.server.get(id); }
function setFlags(id, { share, receive }) {
  const cur = flagsOf(id);
  q.setFlags.run(share === undefined ? cur.share : (share ? 1 : 0), receive === undefined ? cur.receive : (receive ? 1 : 0), id);
  return flagsOf(id);
}

// ---------------------------------------------------------------- reading a server (one round trip)
const READ = [
  'echo @@conn; echo "$SSH_CONNECTION"',
  'echo @@addrs; hostname -I 2>/dev/null',
  "echo @@now; date '+%Y-%m-%d %H:%M:%S'",
  'echo @@f2b; {{S}}fail2ban-client ping >/dev/null 2>&1 && echo up; true',
  `echo @@hp; {{S}}fail2ban-client status ${HP.NAME} 2>/dev/null | grep 'Banned IP list'`,
  `echo @@hptime; {{S}}fail2ban-client get ${HP.NAME} banip --with-time 2>/dev/null`,
  `echo @@hpbantime; {{S}}fail2ban-client get ${HP.NAME} bantime 2>/dev/null`,
  `echo @@fleet; {{S}}fail2ban-client status ${JAIL} 2>/dev/null | grep 'Banned IP list'`,
].join('; ');

function sections(out) {
  const res = {}; let cur = null;
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; res[cur] = []; continue; }
    if (cur) res[cur].push(line);
  }
  for (const k of Object.keys(res)) res[k] = res[k].join('\n').trim();
  return res;
}
const validIp = (s) => net.isIP(String(s || '')) !== 0;
const listOf = (line) => (String(line || '').split(':').slice(1).join(':')).trim().split(/\s+/).filter(validIp);
const localTime = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(s || '').trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; };

/**
 * One server's read-out. Honeypot bans come with when they end: from `--with-time` (server time, compared with the
 * server's own clock, so its time zone does not matter), else from the jail's ban time.
 */
function parseRead(out, now = Date.now()) {
  const S = sections(out);
  const conn = String(S.conn || '').split(/\s+/);
  const hp = listOf(S.hp);
  const ends = {};
  const serverNow = localTime(S.now);
  for (const l of String(S.hptime || '').split('\n')) {
    const m = /^(\S+)\s+.*=\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(l.trim());
    if (m && validIp(m[1]) && Number.isFinite(serverNow)) ends[m[1]] = now + Math.max(0, localTime(m[2]) - serverNow);
  }
  const bantime = Number(String(S.hpbantime || '').trim()) || 0;
  return {
    up: /up/.test(S.f2b || ''),
    dockgateIp: validIp(conn[0]) ? conn[0] : null,
    ownIps: [conn[2], ...String(S.addrs || '').split(/\s+/)].filter(validIp),
    honeypot: /Banned IP list/.test(S.hp || ''),
    honeypotBans: hp.map(ip => ({ ip, endsAt: ends[ip] || (bantime > 0 ? now + bantime * 1000 : now + 30 * DAY) })),
    fleetInstalled: /Banned IP list/.test(S.fleet || ''),
    fleetBans: listOf(S.fleet),
  };
}

// ---------------------------------------------------------------- never spread
const PRIVATE = [['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6']];
/** A BlockList of what is never spread: private ranges, `ips` (DockGate, the servers) and the allowlist entries. */
function protectedList(ips, allow) {
  const b = new net.BlockList();
  for (const [a, p, f] of PRIVATE) b.addSubnet(a, p, f);
  for (const ip of ips) if (validIp(ip)) b.addAddress(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4');
  for (const a of allow || []) {
    const [ip, bits] = String(a).split('/'); const v = net.isIP(ip); if (!v) continue;
    if (bits) b.addSubnet(ip, Number(bits), v === 6 ? 'ipv6' : 'ipv4'); else b.addAddress(ip, v === 6 ? 'ipv6' : 'ipv4');
  }
  return (ip) => { const v = net.isIP(ip); try { return !v || b.check(ip, v === 6 ? 'ipv6' : 'ipv4'); } catch (e) { return true; } };
}
async function serverAddresses(rows) {
  const out = [];
  for (const r of rows) {
    if (validIp(r.host)) { out.push(r.host); continue; }
    try { for (const a of await dns.lookup(r.host, { all: true })) out.push(a.address); } catch (e) { /* not resolvable now */ }
  }
  return out;
}

// ---------------------------------------------------------------- the sync
let running = null;
let lastRun = null;
const read = (row) => runner.read(cfgOf(row), READ);
const sh = (row, cmd) => runner.read(cfgOf(row), cmd);

/**
 * One pass: read every server, record the sharing servers' honeypot bans, give each receiving server what it is
 * missing and take away what ended or was unbanned. `io` replaces the server calls in tests.
 */
async function syncOnce({ now = Date.now(), io = { read, sh }, rows = remoteServers() } = {}) {
  const st = settings();
  if (!st.enabled) return { skipped: 'off' };
  const reads = {};
  await Promise.all(rows.map(async (r) => {
    flagsOf(r.id);
    try { reads[r.id] = parseRead(await io.read(r), now); } catch (e) { reads[r.id] = { error: e.message }; }
  }));
  const ok = Object.entries(reads).filter(([, v]) => !v.error);
  const keep = protectedList([...ok.flatMap(([, v]) => [v.dockgateIp, ...v.ownIps]), ...(await serverAddresses(rows))], st.allow);

  // 1. what the sharing servers caught
  let added = 0;
  for (const [id, v] of ok) {
    const f = flagsOf(id);
    if (!f.share || !v.honeypot) continue;
    for (const b of v.honeypotBans) {
      if (keep(b.ip)) continue;
      const was = q.ban.get(b.ip);
      if (was && was.unbanned_at) continue; // unbanned everywhere: not spread again while the source still lists it
      q.upsert.run(b.ip, id, now, b.endsAt);
      if (!was) added++;
    }
  }
  q.prune.run(now - DAY, now - DAY);
  const desired = new Set(q.active.all(now, MAX_ACTIVE).map(r => r.ip).filter(ip => !keep(ip)));

  // 2. each receiving server: add what it is missing, remove what ended
  const results = {};
  for (const r of rows) {
    const v = reads[r.id]; const f = flagsOf(r.id);
    if (v.error) { q.seen.run(f.has_honeypot, f.has_fail2ban, 0, f.active, now, `not reachable: ${v.error.slice(0, 200)}`, r.id); results[r.id] = { error: v.error }; continue; }
    let error = null, active = v.fleetBans.length;
    if (f.receive && v.fleetInstalled) {
      const present = new Set(v.fleetBans);
      const toBan = [...desired].filter(ip => !present.has(ip));
      const toUnban = v.fleetBans.filter(ip => !desired.has(ip));
      try {
        for (let i = 0; i < toBan.length; i += CHUNK) await io.sh(r, `{{S}}fail2ban-client set ${JAIL} banip ${toBan.slice(i, i + CHUNK).join(' ')} >/dev/null`);
        for (let i = 0; i < toUnban.length; i += CHUNK) await io.sh(r, `{{S}}fail2ban-client set ${JAIL} unbanip ${toUnban.slice(i, i + CHUNK).join(' ')} >/dev/null 2>&1; true`);
        active = present.size + toBan.length - toUnban.length;
        results[r.id] = { banned: toBan.length, unbanned: toUnban.length };
      } catch (e) { error = e.message.slice(0, 200); results[r.id] = { error }; }
    } else if (f.receive && !v.fleetInstalled) error = v.up ? 'receiving is on, but its fail2ban jail is missing: turn receiving off and on again' : 'fail2ban is not running';
    q.seen.run(v.honeypot ? 1 : 0, v.up ? 1 : 0, v.fleetInstalled ? 1 : 0, active, now, error, r.id);
  }
  lastRun = { at: now, added, active: desired.size };
  return { added, active: desired.size, servers: results };
}
async function sync(opts) {
  if (running) return running;
  running = syncOnce(opts).catch(e => ({ error: e.message })).finally(() => { running = null; });
  return running;
}
let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => sync().catch(() => {}), 60000).unref();
  timer = setInterval(() => sync().catch(() => {}), EVERY_MS); timer.unref();
}

// ---------------------------------------------------------------- receiving: the jail on a server
const FILTER_TEXT = `# Managed by DockGate (Server Console > Security > Honeypot > On all servers)
# No log is read: DockGate adds the addresses caught by the honeypots of your other servers.
[Definition]
failregex =
ignoreregex =
`;
const JAIL_HEAD = `# Managed by DockGate (Server Console > Security > Honeypot > On all servers)
# Addresses caught by the honeypots of your other servers, banned on every port. DockGate removes each one when its
# ban ends where it was caught; ${CEILING} is only the ceiling for when DockGate is away.
[${JAIL}]
enabled = true
backend = auto
filter = ${JAIL}
logpath = /dev/null
maxretry = 1
bantime = ${CEILING}
`;
const write = (p, content) => `echo ${Buffer.from(content).toString('base64')} | base64 -d | {{S}}tee ${p} >/dev/null && {{S}}chmod 0644 ${p}`;
const REMOVE = `{{S}}rm -f ${JAIL_FILE} ${FILTER_FILE}; if {{S}}fail2ban-client ping >/dev/null 2>&1; then {{S}}fail2ban-client reload >/dev/null 2>&1; fi; true`;
function receivePlan() {
  return {
    steps: [
      { label: 'Check: fail2ban is running', cmd: '{{S}}fail2ban-client ping >/dev/null 2>&1 || { echo "fail2ban is not running - install it in Setup > Fail2ban"; exit 1; }; echo ok' },
      { label: `fail2ban: the ${JAIL} jail (bans from your other servers, every port)`, rollbackOnFail: true, cmd: [
        write(FILTER_FILE, FILTER_TEXT),
        HP.banJailCmd({ file: JAIL_FILE, head: JAIL_HEAD, name: JAIL, dockerName: 'fleet-docker' }),
        `out=$({{S}}fail2ban-client reload 2>&1) || { J=$(echo "$out" | grep -o "Jail '[^']*'" | head -1); echo "fail2ban did not reload\${J:+ - $J is broken (it is not this jail): fix or turn it off in the Fail2ban tab, then try again}: $(echo "$out" | grep -v WARNING | tail -3)"; exit 1; }`,
        `for i in 1 2 3 4 5; do {{S}}fail2ban-client status ${JAIL} >/dev/null 2>&1 && break; sleep 1; done`,
        `{{S}}fail2ban-client status ${JAIL} >/dev/null 2>&1 || { echo "the jail did not start: $({{S}}tail -n 5 /var/log/fail2ban.log 2>/dev/null)"; exit 1; }`,
      ].join('; ') },
    ],
    rollback: REMOVE,
  };
}
function stopReceivingPlan() {
  return { steps: [{ label: `Remove the ${JAIL} jail (the bans from other servers end here)`, cmd: REMOVE }] };
}

// ---------------------------------------------------------------- unban everywhere
/** Ends one address on every server: the fleet jails and the honeypot jail that caught it. */
async function unbanEverywhere(ip, { io = { sh }, rows = remoteServers(), now = Date.now() } = {}) {
  if (!validIp(ip)) throw Object.assign(new Error('Not an IP address'), { statusCode: 400 });
  if (!q.ban.get(ip)) q.upsert.run(ip, 'manual', now, now);
  q.unban.run(now, ip);
  const done = [], failed = [];
  await Promise.all(rows.map(async (r) => {
    try {
      await io.sh(r, `{{S}}fail2ban-client set ${JAIL} unbanip ${ip} >/dev/null 2>&1; {{S}}fail2ban-client set ${HP.NAME} unbanip ${ip} >/dev/null 2>&1; true`);
      done.push(r.name || r.id);
    } catch (e) { failed.push({ server: r.name || r.id, error: e.message.slice(0, 160) }); }
  }));
  return { ip, done, failed };
}

// ---------------------------------------------------------------- the page
function status({ now = Date.now() } = {}) {
  const st = settings();
  const rows = remoteServers();
  const flags = Object.fromEntries(q.servers.all().map(f => [f.server_id, f]));
  const names = Object.fromEntries(rows.map(r => [r.id, r.name || r.host || r.id]));
  return {
    ...st, everyMin: EVERY_MS / 60000, max: MAX_ACTIVE, lastRun,
    active: q.count.get(now).n,
    servers: rows.map(r => {
      const f = flags[r.id] || { share: 1, receive: 0, installed: 0, has_honeypot: 0, has_fail2ban: 0, active: 0, last_sync: null, error: null };
      return { id: r.id, name: names[r.id], share: !!f.share, receive: !!f.receive, installed: !!f.installed, honeypot: !!f.has_honeypot, fail2ban: !!f.has_fail2ban, active: f.active, lastSync: f.last_sync, error: f.error };
    }),
    recent: q.recent.all(now, 200).map(b => ({ ip: b.ip, source: names[b.source] || b.source, firstSeen: b.first_seen, expiresAt: b.expires_at })),
  };
}
function forget(serverId) { q.dropServer.run(serverId); }

module.exports = { JAIL, JAIL_FILE, FILTER_FILE, FILTER_TEXT, READ, EVERY_MS, MAX_ACTIVE, settings, saveSettings, flagsOf, setFlags, parseRead, protectedList, syncOnce, sync, start, receivePlan, stopReceivingPlan, unbanEverywhere, status, forget, q };
