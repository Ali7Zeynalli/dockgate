// Firewall alerts: every 5 minutes DockGate reads each server's kernel log and live DOCKER-USER chain (one short SSH
// command) and sends:
//   firewall_web_blocked   connections to port 80 or 443 were dropped by the firewall in the last 5 minutes
//                          (visitors or Cloudflare could not reach the sites: the Kraton case)
//   firewall_leftover      DockGate's Docker port isolation rules are in the live firewall but not in the UFW files
//                          (left behind; they drop new connections to containers)
// Both rules are on by default and go to the channels set up in Settings > Notifications. The web alert repeats at
// most once an hour per server; the leftover alert once until the rules are gone.
const { db, stmts } = require('./db');
const runner = require('./security/runner');
const paths = require('./paths');
const { decrypt } = require('./auth/secrets');

db.exec('CREATE TABLE IF NOT EXISTS firewall_monitor (key TEXT PRIMARY KEY, value TEXT)');
db.prepare('INSERT OR IGNORE INTO notification_rules (event_type, description, cooldown_minutes, enabled, params) VALUES (?, ?, ?, 1, ?)').run('firewall_web_blocked', 'Web traffic blocked by the firewall', 60, '{}');
db.prepare('INSERT OR IGNORE INTO notification_rules (event_type, description, cooldown_minutes, enabled, params) VALUES (?, ?, ?, 1, ?)').run('firewall_leftover', 'Docker port isolation rules left behind', 0, '{}');
const q = {
  get: db.prepare('SELECT value FROM firewall_monitor WHERE key = ?'),
  set: db.prepare('INSERT INTO firewall_monitor (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
const getJ = (k, d) => { try { const r = q.get.get(k); return r ? JSON.parse(r.value) : d; } catch (e) { return d; } };
const setJ = (k, v) => q.set.run(k, JSON.stringify(v));
const INTERVAL = 5 * 60000;
const MIN_DROPS = 3; // a few stray packets are not an outage

// journalctl only: dmesg has no time filter, so old drops would be counted again on every check
const READ = [
  "echo @@drops; {{S}}journalctl -k --since -5min --no-pager 2>/dev/null | grep -E '\\[UFW (DOCKER )?BLOCK\\]' | grep -E ' DPT=(80|443) ' | tail -n 500",
  "echo @@du; {{S}}iptables -S DOCKER-USER 2>/dev/null | grep -c -- '-j ufw-user-forward'",
  "echo @@block; {{S}}grep -c 'BEGIN DOCKGATE-DOCKER' /etc/ufw/after.rules 2>/dev/null",
  'echo @@ufw; command -v ufw >/dev/null 2>&1 && echo yes',
].join('; ');

function parse(out) {
  const S = {}; let cur = null;
  for (const l of String(out || '').split('\n')) { const m = /^@@(\w+)$/.exec(l.trim()); if (m) { cur = m[1]; S[cur] = []; } else if (cur && l.trim()) S[cur].push(l.trim()); }
  const lines = S.drops || [];
  const srcs = {}, ports = {};
  for (const l of lines) {
    const src = (/\bSRC=(\S+)/.exec(l) || [])[1] || '?'; const dpt = (/\bDPT=(\d+)/.exec(l) || [])[1] || '?';
    srcs[src] = (srcs[src] || 0) + 1; ports[dpt] = (ports[dpt] || 0) + 1;
  }
  return {
    ufw: (S.ufw || [])[0] === 'yes',
    drops: lines.length, toContainer: lines.filter(l => /UFW DOCKER BLOCK/.test(l)).length,
    ports, sources: Object.entries(srcs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, n]) => ({ ip, n })),
    liveIso: Number((S.du || ['0'])[0]) > 0, blockInFile: Number((S.block || ['0'])[0]) > 0,
  };
}

/** What to send for one reading. state: { leftover } (changed in place). Pure, so it is unit tested. */
function evaluate(r, state) {
  const out = [];
  if (r.drops >= MIN_DROPS) out.push({ type: 'firewall_web_blocked', data: r });
  const leftover = r.liveIso && !r.blockInFile;
  if (leftover && !state.leftover) out.push({ type: 'firewall_leftover', data: r });
  state.leftover = leftover;
  return out;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function message(a, where) {
  const r = a.data;
  if (a.type === 'firewall_web_blocked') {
    const ports = Object.entries(r.ports).map(([p, n]) => `${p} (${n})`).join(', ');
    const from = r.sources.map(s => `${s.ip} (${s.n})`).join(', ');
    const how = r.toContainer ? 'Docker port isolation (to a container)' : 'UFW';
    return {
      subject: `Web traffic blocked by the firewall on ${where}`,
      text: `Web traffic blocked - ${where}\n${r.drops} connections to ${ports} were dropped in the last 5 minutes by ${how}. Most from: ${from}. Visitors or Cloudflare may not reach your sites. Check Security > Live firewall.`,
      body: `<p>On <b>${esc(where)}</b>, <b>${r.drops}</b> connections to ${esc(ports)} were dropped in the last 5 minutes by ${esc(how)}.</p><p>Most from: ${esc(from)}</p><p>Visitors or Cloudflare may not reach your sites. Open Server Console > Security > Live firewall and use "Will this connection pass?".</p>`,
    };
  }
  return {
    subject: `Docker port isolation rules left behind on ${where}`,
    text: `Isolation rules left behind - ${where}\nDockGate's Docker port isolation rules are in the live firewall but not in /etc/ufw/after.rules. They drop new connections to your containers. Remove them in Security > Live firewall.`,
    body: `<p>On <b>${esc(where)}</b>, DockGate's Docker port isolation rules are in the live firewall (DOCKER-USER) but not in /etc/ufw/after.rules. They drop new connections to your containers.</p><p>Open Server Console > Security > Live firewall and use <b>Remove them...</b>.</p>`,
  };
}

const cfgOf = (row) => ({ ...row, keyPath: row.key_path ? paths.keyPath(row.key_path) : null, password: decrypt(row.password), passphrase: decrypt(row.passphrase) });
let timer = null, busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    const HM = require('./notifications/health-monitor');
    for (const row of stmts.getServers.all()) {
      try {
        const r = parse(await runner.read(cfgOf(row), READ));
        if (!r.ufw) continue;
        const state = getJ(`state:${row.id}`, {});
        const alerts = evaluate(r, state);
        setJ(`state:${row.id}`, state);
        setJ(`last:${row.id}`, { at: Date.now(), drops: r.drops, leftover: state.leftover });
        for (const a of alerts) { const m = message(a, row.name || row.id); await HM.deliver(a.type, { id: row.id, name: row.name || row.id }, m.subject, m.text, m.body, { retry: true }); }
      } catch (e) { /* not reachable: the health monitor reports that */ }
    }
  } finally { busy = false; }
}
function start() { if (!timer) { timer = setInterval(tick, INTERVAL); if (timer.unref) timer.unref(); setTimeout(tick, 90000); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { READ, parse, evaluate, message, tick, start, stop, MIN_DROPS };
