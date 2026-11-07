// Firewall rule model shared by UFW and firewalld, in the shape cloud firewalls use (Hetzner, GCP):
// a rule = direction · action · protocol · port (or range) · a set of remote addresses (sources for
// inbound, destinations for outbound) · description. On the server one rule is many firewall entries
// (one per address, v4 and v6 separately); this module groups them back into rules and turns an
// edited rule into the exact commands that get the server there.
//
// Remote addresses: 'any4' (0.0.0.0/0), 'any6' (::/0) or a canonical IP / CIDR.
const P = require('./parse');
const IPL = require('./iplists');

const httpError = P.httpError;
const PORT_RE = /^(\d{1,5})(?:[:-](\d{1,5}))?$/;

// ---------------------------------------------------------------- validation
/** '' → null (any port) · '443' · '8000-8100' (stored with '-'). */
function normPort(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.toLowerCase() === 'any') return null;
  const m = PORT_RE.exec(s);
  if (!m) throw httpError(400, 'Port: a number like 443, or a range like 8000-8100');
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : null;
  if (a < 1 || a > 65535 || (b != null && (b < 1 || b > 65535 || b <= a))) throw httpError(400, 'Ports go from 1 to 65535, and a range runs from low to high');
  return b ? `${a}-${b}` : String(a);
}
function normRule(r) {
  const dir = r.dir === 'out' ? 'out' : (r.dir === 'in' ? 'in' : null);
  if (!dir) throw httpError(400, 'dir must be in or out');
  const action = ['allow', 'deny', 'limit'].includes(r.action) ? r.action : null;
  if (!action) throw httpError(400, 'action must be allow or deny');
  const proto = r.proto === 'any' || r.proto == null || r.proto === '' ? null : P.assertProto(r.proto);
  const port = normPort(r.port);
  if (port && port.includes('-') && !proto) throw httpError(400, 'A port range needs a protocol (TCP or UDP)');
  if (action === 'limit' && (dir !== 'in' || proto !== 'tcp' || !port || port.includes('-'))) throw httpError(400, 'Limit works for one inbound TCP port');
  const description = String(r.description || '').trim().slice(0, 80);
  if (/[<>]/.test(description)) throw httpError(400, 'Description cannot contain < or >');
  return { dir, action, proto, port, containers: !!r.containers, container: r.container ? Number(r.container) || null : null, description };
}

/** The identity of a rule: two rules with the same key are one rule. */
const ruleKey = (r) => `${r.dir}|${r.action}|${r.proto || 'any'}|${r.port || 'any'}|${r.dir === 'in' && r.container ? 'c' + r.container : 'h'}`;

// ---------------------------------------------------------------- reading UFW
const ADDR_ANY = /^Anywhere(?:\/(tcp|udp))?$/;
const PORTTOK = /^(\d{1,5}(?::\d{1,5})?)(?:\/(tcp|udp))?$/;
/** "Anywhere" · "443/tcp" · "1.2.3.4" · "1.2.3.4/tcp" · "10.0.0.0/8 8000:8100/tcp" → { addr, port, proto } | { bad } */
function parseLoc(loc, v6) {
  const s = String(loc || '').replace(/\s*\(v6\)/g, '').trim();
  if (/ on \S+/.test(s)) return { bad: 'an interface-specific rule' };
  const parts = s.split(/\s+/);
  let addrTok = 'Anywhere', portTok = null;
  if (parts.length === 2) { addrTok = parts[0]; portTok = parts[1]; }
  else if (parts.length === 1) { if (PORTTOK.test(parts[0])) portTok = parts[0]; else addrTok = parts[0]; }
  else return { bad: `"${s}"` };
  let proto = null, port = null, addr;
  if (portTok) { const m = PORTTOK.exec(portTok); if (!m) return { bad: `the port "${portTok}"` }; port = m[1].replace(':', '-'); proto = m[2] || null; }
  const any = ADDR_ANY.exec(addrTok);
  if (any) { addr = v6 ? 'any6' : 'any4'; if (any[1]) proto = any[1]; }
  else {
    const withProto = /^(.+)\/(tcp|udp)$/.exec(addrTok);
    const raw = withProto ? withProto[1] : addrTok;
    if (withProto) proto = withProto[2];
    addr = IPL.normalizeSource(raw);
    if (!addr) return { bad: `"${addrTok}" (an app profile or a name)` };
    if (addr === '0.0.0.0/0') addr = 'any4'; else if (addr === '::/0') addr = 'any6';
  }
  return { addr, port, proto };
}

/** One `ufw status numbered` rule → its meaning, or { locked } when DockGate cannot edit it. */
function ufwSemantic(r) {
  const action = { ALLOW: 'allow', DENY: 'deny', REJECT: 'deny', LIMIT: 'limit' }[r.action];
  const route = r.dir === 'FWD';
  const marker = /^dockgate:out\b/.test(r.note || '');
  const to = parseLoc(r.to, r.v6), from = parseLoc(r.from, r.v6);
  const base = { n: r.n, v6: r.v6, action, route, raw: r, tag: (/^dockgate:(?:in:|out:)?(.+)$/.exec(r.note || '') || [])[1] || null };
  if (r.action === 'REJECT') base.locked = 'a REJECT rule';
  if (to.bad || from.bad) return { ...base, dir: r.dir === 'OUT' ? 'out' : 'in', locked: `has ${to.bad || from.bad}` };
  // outbound: local side is the source, the remote is the destination
  const out = r.dir === 'OUT' || (route && (marker || (to.addr !== 'any4' && to.addr !== 'any6')));
  if (out) {
    if (from.port) return { ...base, dir: 'out', locked: 'has a source port' };
    if (!route && from.addr !== 'any4' && from.addr !== 'any6') return { ...base, dir: 'out', locked: 'is limited to a local address' };
    return { ...base, dir: 'out', remote: to.addr, port: to.port, proto: to.proto || from.proto };
  }
  if (from.port) return { ...base, dir: 'in', locked: 'has a source port' };
  if (to.addr !== 'any4' && to.addr !== 'any6') return { ...base, dir: 'in', locked: 'is limited to a local address' };
  return { ...base, dir: 'in', remote: from.addr, port: to.port, proto: to.proto || from.proto, container: route ? (to.port && !to.port.includes('-') ? Number(to.port) : null) : null };
}

// ---------------------------------------------------------------- reading firewalld
function fwdSemantic(r) {
  const t = P.ruleTarget(r.to);
  const base = { n: r.n, v6: false, dir: 'in', action: r.action === 'DENY' ? 'deny' : 'allow', route: false, raw: r, fwd: { kind: r.kind, key: r.key } };
  if (r.kind === 'service') return { ...base, locked: `is the firewalld service "${r.key}"`, port: t ? (t.port === t.portEnd ? String(t.port) : `${t.port}-${t.portEnd}`) : null, proto: t ? t.proto : null, remote: 'any4' };
  if (r.action === 'OTHER') return { ...base, locked: 'is a rich rule DockGate cannot edit' };
  if (/^not /.test(r.from)) return { ...base, locked: 'uses "source NOT"' };
  const port = t ? (t.port === t.portEnd ? String(t.port) : `${t.port}-${t.portEnd}`) : null;
  if (!t && r.to !== 'Anywhere') return { ...base, locked: `targets "${r.to}"` };
  // "Anywhere" in firewalld (a plain port, or a rich rule without a source) covers both families
  if (r.from === 'Anywhere') {
    const fam = r.kind === 'rich' ? (/family="ipv6"/.test(r.key) ? ['any6'] : /family="ipv4"/.test(r.key) ? ['any4'] : ['any4', 'any6']) : ['any4', 'any6'];
    return fam.map(f => ({ ...base, remote: f, port, proto: t ? t.proto : null }));
  }
  const addr = IPL.normalizeSource(r.from);
  if (!addr) return { ...base, locked: `has the source "${r.from}"` };
  return { ...base, remote: addr, port, proto: t ? t.proto : null };
}

/**
 * Group firewall entries into rules.
 *   backend: 'ufw' | 'firewalld' · rules: parsed rules · lists: IP lists · dockgateIp
 * Returns { groups: [...], locked: [...entries DockGate cannot edit] }.
 */
function groupRules({ backend, rules, lists, dockgateIp }) {
  const sem = backend === 'firewalld' ? rules.flatMap(fwdSemantic) : rules.map(ufwSemantic);
  const groups = new Map(), locked = [];
  for (const s of sem) {
    if (s.locked) { locked.push(s); continue; }
    const key = ruleKey({ dir: s.dir, action: s.action, proto: s.proto, port: s.port, container: s.dir === 'in' && s.route ? s.container : null });
    if (!groups.has(key)) groups.set(key, { key, dir: s.dir, action: s.action, proto: s.proto || null, port: s.port || null, container: s.dir === 'in' && s.route ? s.container : null, entries: [] });
    groups.get(key).entries.push(s);
  }
  const out = [];
  for (const g of groups.values()) {
    const remotes = [...new Set(g.entries.map(e => e.remote))];
    const hostRemotes = new Set(g.entries.filter(e => !e.route).map(e => e.remote));
    g.containers = g.dir === 'out' && g.entries.some(e => e.route);
    // display sources: any4/any6 first, then lists / DockGate's IP / addresses
    const addrs = remotes.filter(r => r !== 'any4' && r !== 'any6');
    const inf = IPL.inferSources(addrs, lists, dockgateIp);
    g.sources = [...['any4', 'any6'].filter(a => remotes.includes(a)), ...inf.sources];
    g.outdated = inf.outdated;
    g.remotes = remotes;
    g.addressCount = addrs.length;
    g.family = familyOf(remotes);
    g.hostOnlyRemotes = g.dir === 'out' && g.containers ? remotes.filter(r => !hostRemotes.has(r)) : [];
    out.push(g);
  }
  return { groups: out, locked };
}
function familyOf(remotes) {
  if (!remotes.length) return null;
  const v4 = remotes.some(r => r === 'any4' || (r !== 'any6' && !IPL.isV6(r)));
  const v6 = remotes.some(r => r === 'any6' || (r !== 'any4' && IPL.isV6(r)));
  return v4 && v6 ? 'IPv4 + IPv6' : (v6 ? 'IPv6 only' : 'IPv4 only');
}

// ---------------------------------------------------------------- display sources → remotes
/** ['any4','any6','@cloudflare','1.2.3.4', 'any'(= both)] → [{ remote, tag }] (deduplicated, validated). */
function expandRemotes(sources, lists, dockgateIp) {
  const out = [], seen = new Set();
  const push = (remote, tag) => { if (!seen.has(remote)) { seen.add(remote); out.push({ remote, tag }); } };
  const rest = [];
  for (const s of sources || []) {
    if (s === 'any' || s === 'any4') push('any4', 'any');
    if (s === 'any' || s === 'any6') push('any6', 'any');
    if (s !== 'any' && s !== 'any4' && s !== 'any6') rest.push(s);
  }
  for (const x of IPL.expandSources(rest, lists, dockgateIp)) {
    if (x.src === '0.0.0.0/0') push('any4', 'any'); else if (x.src === '::/0') push('any6', 'any'); else push(x.src, x.tag);
  }
  return out;
}

// ---------------------------------------------------------------- commands
const ufwAddr = (remote) => (remote === 'any4' ? '0.0.0.0/0' : remote === 'any6' ? '::/0' : P.assertSource(remote));
/** UFW spec: one entry = (route?, remote). Two "any" halves of the same route flag merge into "any". */
function ufwCmds(rule, specs, { remove }) {
  const out = [];
  const byRoute = [false, true].map(route => specs.filter(s => s.route === route));
  for (const list of byRoute) {
    if (!list.length) continue;
    const route = list[0].route;
    const has4 = list.find(s => s.remote === 'any4'), has6 = list.find(s => s.remote === 'any6');
    const items = list.filter(s => !(has4 && has6 && (s.remote === 'any4' || s.remote === 'any6')));
    if (has4 && has6) items.unshift({ ...has4, remote: 'any', tag: 'any' });
    for (const s of items) out.push(ufwCmd(rule, s, route, remove));
  }
  return out;
}
function ufwCmd(rule, s, route, remove) {
  const action = remove && s.action ? s.action : rule.action;
  const proto = rule.proto ? ` proto ${rule.proto}` : '';
  const port = rule.port ? ` port ${rule.port.replace('-', ':')}` : '';
  const addr = s.remote === 'any' ? 'any' : ufwAddr(s.remote);
  const comment = remove ? '' : ` comment '${rule.dir === 'out' ? 'dockgate:out:' : 'dockgate:'}${String(s.tag || 'manual').replace(/[^A-Za-z0-9_-]/g, '')}'`;
  const del = remove ? ' delete' : '';
  if (rule.dir === 'out') {
    return route
      ? `{{S}}ufw route${del} ${action}${proto} from any to ${addr}${port}${comment} >/dev/null`
      : `{{S}}ufw${del} ${action} out${proto} to ${addr}${port}${comment} >/dev/null`;
  }
  return route
    ? `{{S}}ufw route${del} ${action}${proto} from ${addr} to any${port}${comment} >/dev/null`
    : `{{S}}ufw${del} ${action}${proto} from ${addr} to any${port}${comment} >/dev/null`;
}

/**
 * The commands that turn the current entries of a rule (old, may be null) into the wanted rule.
 * want: normalized rule + remotes [{ remote, tag }] (empty = delete the rule).
 * Adds run first (a kept address is never interrupted), removes after.
 */
function planChange({ backend, zone, old, want }) {
  const cur = old ? old.entries : [];
  const sameIdentity = old && want && ruleKey(old) === ruleKey(want);
  const wantSpecs = [];
  if (want) for (const r of want.remotes) {
    if (want.dir === 'in') wantSpecs.push({ route: !!want.container, remote: r.remote, tag: r.tag });
    else { wantSpecs.push({ route: false, remote: r.remote, tag: r.tag }); if (want.containers) wantSpecs.push({ route: true, remote: r.remote, tag: r.tag }); }
  }
  const id = (s) => `${s.route ? 'r' : 'h'}|${s.remote}`;
  const curIds = new Set(sameIdentity ? cur.map(id) : []);
  const wantIds = new Set(wantSpecs.map(id));
  const add = wantSpecs.filter(s => !curIds.has(id(s)));
  const remove = cur.filter(s => !(sameIdentity && wantIds.has(id(s))));
  if (backend === 'firewalld') {
    // a plain firewalld port is ONE entry for both families: removing one half would remove both
    const keptKeys = new Set(cur.filter(e => !remove.includes(e) && e.fwd).map(e => e.fwd.kind + '|' + e.fwd.key));
    if (remove.some(e => e.fwd && keptKeys.has(e.fwd.kind + '|' + e.fwd.key))) throw httpError(400, 'On firewalld "Any IPv4" and "Any IPv6" of a port are one entry — keep or remove both');
    return { add, remove, cmds: fwdCmds({ zone, want, add, remove }) };
  }
  const cmds = [
    ...(add.length ? ufwCmds(want, add, { remove: false }) : []),
    ...(remove.length ? ufwCmds(old, remove.map(e => ({ route: e.route, remote: e.remote, action: e.action })), { remove: true }) : []),
  ];
  return { add, remove, cmds };
}
function fwdCmds({ zone, want, add, remove }) {
  const plans = require('./plans');
  const out = [];
  if (want && want.dir === 'out') throw httpError(400, 'Outbound rules need UFW — firewalld filters incoming traffic here');
  if (want && add.length) {
    const port = want.port, proto = want.proto;
    if (!port) { if (add.some(a => a.remote === 'any4' || a.remote === 'any6')) throw httpError(400, 'Allowing every port from anyone is the zone default — change the default instead'); }
    if (port && !proto) throw httpError(400, 'firewalld needs a protocol (TCP or UDP) for a port');
    const has4 = add.some(a => a.remote === 'any4'), has6 = add.some(a => a.remote === 'any6');
    const zoneArg = `--zone=${zone}`;
    if (has4 && has6 && want.action === 'allow') out.push(`{{S}}firewall-cmd --permanent ${zoneArg} --add-port=${port}/${proto} >/dev/null`);
    for (const a of add) {
      if ((a.remote === 'any4' || a.remote === 'any6') && has4 && has6 && want.action === 'allow') continue;
      const fam = a.remote === 'any4' ? ' family="ipv4"' : a.remote === 'any6' ? ' family="ipv6"' : ` family="${IPL.isV6(a.remote) ? 'ipv6' : 'ipv4'}" source address="${P.assertSource(a.remote)}"`;
      const bothAny = has4 && has6 && (a.remote === 'any4' || a.remote === 'any6');
      if (bothAny && a.remote === 'any6') continue; // one family-less deny rule covers both
      const famPart = bothAny ? '' : fam;
      const portPart = port ? ` port port="${port}" protocol="${proto}"` : '';
      out.push(`{{S}}firewall-cmd --permanent ${zoneArg} --add-rich-rule=${shq(`rule${famPart}${portPart} ${want.action === 'allow' ? 'accept' : 'reject'}`)} >/dev/null`);
    }
  }
  const rm = plans.fwdRemoveCmd(zone, [...new Map(remove.filter(e => e.fwd).map(e => [e.fwd.kind + '|' + e.fwd.key, e.fwd])).values()]);
  if (rm !== 'true') out.push(rm.replace(/ && \{\{S\}\}firewall-cmd --reload >\/dev\/null$/, ''));
  if (out.length) out.push('{{S}}firewall-cmd --reload >/dev/null');
  return out;
}
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// ---------------------------------------------------------------- safety
const coversPort = (rule, port, proto) => {
  if (rule.proto && rule.proto !== proto) return false;
  if (!rule.port) return true;
  const [a, b] = rule.port.split('-').map(Number);
  return port >= a && port <= (b || a);
};
/** After the change, can DockGate still reach SSH? groups: all inbound host rules as they will be. */
function sshReachable(groups, sshPort, dockgateIp, defaultIncoming) {
  if (defaultIncoming === 'allow') return true;
  const ip = IPL.normalizeSource(dockgateIp);
  const v6 = ip && IPL.isV6(ip);
  for (const g of groups) {
    if (g.dir !== 'in' || g.container || (g.action !== 'allow' && g.action !== 'limit') || !coversPort(g, sshPort, 'tcp')) continue;
    for (const r of g.remotes) {
      if (r === (v6 ? 'any6' : 'any4')) return true;
      if (ip && r !== 'any4' && r !== 'any6' && IPL.sourceContains(r, ip)) return true;
    }
  }
  return false;
}

module.exports = { normPort, normRule, ruleKey, parseLoc, ufwSemantic, fwdSemantic, groupRules, familyOf, expandRemotes, planChange, coversPort, sshReachable };
