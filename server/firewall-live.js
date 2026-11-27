// Server Console > Security > Live firewall: the rules as the kernel holds them, not as UFW describes them.
// One read (iptables-save / ip6tables-save, ipset, the UFW files, Docker's ports, the kernel's drop log) gives:
//   - every rule with where it comes from: UFW, Docker, fail2ban (which jail), DockGate's isolation, or unknown
//   - "will this connection pass?": a packet walked through the chains the kernel would use (NAT to a container ->
//     FORWARD, otherwise INPUT), with the rule that decides
//   - differences between the files and the live firewall (rules left behind, rules that should be there and are not)
//   - the connections the firewall dropped lately, grouped by port and source
// Everything here only reads. The one fix it offers (take DockGate's leftover rules out) is a plan in routes.
const net = require('net');

const READ = [
  'echo @@iptv; iptables -V 2>/dev/null',
  'echo @@backend; docker info --format "{{json .}}" 2>/dev/null | grep -o "\\"FirewallBackend\\":{[^}]*}" | head -1; true',
  'echo @@filter4; {{S}}iptables-save -t filter 2>/dev/null',
  'echo @@nat4; {{S}}iptables-save -t nat 2>/dev/null',
  'echo @@filter6; {{S}}ip6tables-save -t filter 2>/dev/null',
  "echo @@ipset; {{S}}ipset save 2>/dev/null | head -n 60000",
  'echo @@ufwstatus; {{S}}ufw status 2>/dev/null | head -1',
  "echo @@userrules; {{S}}grep -E '^### tuple ###' /etc/ufw/user.rules 2>/dev/null",
  "echo @@afterblock; {{S}}grep -c 'BEGIN DOCKGATE-DOCKER' /etc/ufw/after.rules 2>/dev/null",
  "echo @@afterkeep; {{S}}grep -E -- '--dport [0-9]+ .*dockgate-keep' /etc/ufw/after.rules 2>/dev/null",
  "echo @@ports; docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null",
  "echo @@ifaces; ip -o -4 addr show 2>/dev/null | awk '{print $2, $4}'",
  "echo @@drops; ({{S}}journalctl -k --since -1h --no-pager 2>/dev/null || {{S}}dmesg 2>/dev/null) | grep -E '\\[UFW (DOCKER )?BLOCK\\]' | tail -n 2000",
].join('; ');

function sections(out) {
  const res = {}; let cur = null;
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; res[cur] = []; continue; }
    if (cur) res[cur].push(line);
  }
  for (const k of Object.keys(res)) res[k] = res[k].join('\n');
  return res;
}

// ---------------------------------------------------------------- parsing iptables-save
/** Splits a rule line into words, keeping "quoted strings" together. */
function words(line) { return (String(line).match(/"[^"]*"|\S+/g) || []).map(w => w.replace(/^"|"$/g, '')); }

/** One rule: { chain, text, matches: {...}, target, targetArgs }. Unknown options are kept in `other`. */
function parseRule(line) {
  const w = words(line);
  const r = { chain: w[1], text: line.trim(), m: {}, other: [], target: null };
  for (let i = 2; i < w.length; i++) {
    let neg = false;
    if (w[i] === '!') { neg = true; i++; }
    const o = w[i], v = w[i + 1];
    const set = (k, val) => { r.m[k] = { v: val, neg }; i++; };
    switch (o) {
      case '-s': case '--source': set('src', v); break;
      case '-d': case '--destination': set('dst', v); break;
      case '-p': case '--protocol': set('proto', v); break;
      case '-i': case '--in-interface': set('in', v); break;
      case '-o': case '--out-interface': set('out', v); break;
      case '--dport': case '--destination-port': set('dport', v); break;
      case '--dports': case '--destination-ports': set('dports', v); break;
      case '--sport': case '--source-port': set('sport', v); break;
      case '--ctstate': case '--state': set('ctstate', v); break;
      case '--match-set': r.m.set = { v, dir: w[i + 2], neg }; i += 2; break;
      case '--dst-type': set('dsttype', v); break;
      case '--src-type': set('srctype', v); break;
      case '--tcp-flags': r.m.tcpflags = { v: `${v} ${w[i + 2]}`, neg }; i += 2; break;
      case '--comment': set('comment', v); break;
      case '-m': case '--match': i++; break; // the module name itself; its options are read above
      // matches may follow the target (DockGate's own rules are written `-j X -p tcp ...`), so parsing goes on
      case '-j': case '--jump': r.target = v; i++; break;
      case '-g': case '--goto': r.target = v; r.goto = true; i++; break;
      case '--limit': case '--limit-burst': case '--log-prefix': case '--log-level': case '--reject-with': case '--to-destination': case '--to-source': case '--to-ports': case '--set-xmark': case '--nflog-group': case '--nflog-prefix': i++; break;
      case '--log-tcp-sequence': case '--log-tcp-options': case '--log-ip-options': case '--log-uid': case '--random': case '--persistent': break;
      default: r.other.push(o);
    }
  }
  return r;
}

/** iptables-save text -> { chains: { NAME: { policy, rules: [] } } } (one table). */
function parseSave(text) {
  const chains = {};
  for (const line of String(text || '').split('\n')) {
    const l = line.trim();
    let m;
    if ((m = /^:(\S+)\s+(\S+)/.exec(l))) chains[m[1]] = chains[m[1]] || { policy: m[2] === '-' ? null : m[2], rules: [] };
    else if (l.startsWith('-A ')) { const r = parseRule(l); (chains[r.chain] = chains[r.chain] || { policy: null, rules: [] }).rules.push(r); }
  }
  return { chains };
}

/** ipset save -> { name: Set(addresses or cidrs) } */
function parseIpset(text) {
  const sets = {};
  for (const l of String(text || '').split('\n')) {
    const m = /^add (\S+) (\S+)/.exec(l.trim());
    if (m) (sets[m[1]] = sets[m[1]] || new Set()).add(m[2]);
  }
  return sets;
}

// ---------------------------------------------------------------- where a rule comes from
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10'];
/** { kind: ufw | docker | fail2ban | dockgate | unknown, label } */
function sourceOf(r) {
  const t = r.text, c = r.chain || '';
  const set = r.m.set ? r.m.set.v : '';
  if (/^f2b-/.test(c) || /^f2b-/.test(set) || /^f2b-/.test(r.target || '')) {
    const jail = (set || c || r.target).replace(/^f2b-/, '');
    const name = jail === 'hp-docker' ? 'dockgate-honeypot' : jail === 'fleet-docker' ? 'dockgate-fleet' : jail;
    return { kind: 'fail2ban', label: `fail2ban: ${name}` };
  }
  if (c === 'DOCKER-USER') {
    if (/dockgate-keep/.test(t)) return { kind: 'dockgate', label: 'DockGate: port kept public' };
    const only = (...keys) => Object.keys(r.m).every(k => keys.includes(k));
    const ours = /^ufw6?-(user-forward|docker-logging-deny)$/.test(r.target || '')
      || (r.target === 'RETURN' && (Object.keys(r.m).length === 0
        || (only('src') && PRIVATE.includes(r.m.src.v) && !r.m.src.neg)
        || (only('proto', 'sport', 'dport') && r.m.sport && r.m.sport.v === '53' && r.m.dport && r.m.dport.v === '1024:65535')));
    if (ours) return { kind: 'dockgate', label: 'DockGate: Docker port isolation' };
    return { kind: 'unknown', label: 'not DockGate, Docker or UFW (added by hand?)' };
  }
  if (/^ufw6?-docker-logging-deny$/.test(c)) return { kind: 'dockgate', label: 'DockGate: Docker port isolation' };
  if (/^ufw6?-/.test(c) || /^ufw6?-/.test(r.target || '')) return { kind: 'ufw', label: c === 'ufw-user-input' || c === 'ufw6-user-input' ? 'UFW rule (yours)' : c === 'ufw-user-forward' || c === 'ufw6-user-forward' ? 'UFW route rule (yours)' : 'UFW' };
  if (/^DOCKER/.test(c) || /^DOCKER/.test(r.target || '')) return { kind: 'docker', label: 'Docker' };
  return { kind: 'unknown', label: 'not DockGate, Docker or UFW (added by hand?)' };
}

// ---------------------------------------------------------------- will this connection pass?
function inCidr(ip, cidr) {
  if (!cidr || !net.isIP(ip)) return false;
  const [base, bits] = String(cidr).split('/');
  const v = net.isIP(base); if (!v || v !== net.isIP(ip)) return false;
  const b = new net.BlockList();
  try { if (bits) b.addSubnet(base, Number(bits), v === 6 ? 'ipv6' : 'ipv4'); else b.addAddress(base, v === 6 ? 'ipv6' : 'ipv4'); return b.check(ip, v === 6 ? 'ipv6' : 'ipv4'); } catch (e) { return false; }
}
function portIn(port, spec) {
  return String(spec || '').split(',').some(p => { const [a, b] = p.split(':').map(Number); return b ? port >= a && port <= b : port === a; });
}
const ifMatch = (name, pattern) => { if (!name) return false; if (pattern.endsWith('+')) return name.startsWith(pattern.slice(0, -1)); return name === pattern; };
const KNOWN_OTHER = new Set(['-w', '--wait']);

/**
 * Does rule `r` match packet `p` ({ src, dst, proto, dport, in, out, local, sets })? Returns true / false, or null when
 * the rule uses something this check cannot judge (it is then treated as not matching, and reported).
 */
function matches(r, p) {
  const m = r.m;
  const test = (k, ok) => (m[k] ? (m[k].neg ? !ok : ok) : true);
  if (!test('src', m.src && inCidr(p.src, m.src.v))) return false;
  if (!test('dst', m.dst && inCidr(p.dst, m.dst.v))) return false;
  if (m.proto && !test('proto', m.proto.v === p.proto || m.proto.v === 'all')) return false;
  if (m.dport && !test('dport', portIn(p.dport, m.dport.v))) return false;
  if (m.dports && !test('dports', portIn(p.dport, m.dports.v))) return false;
  if (m.sport && !test('sport', portIn(p.sport || 40000, m.sport.v))) return false;
  if (m.in && !test('in', ifMatch(p.in, m.in.v))) return false;
  if (m.out && !test('out', ifMatch(p.out, m.out.v))) return false;
  if (m.ctstate && !test('ctstate', String(m.ctstate.v).split(',').includes('NEW'))) return false; // a new connection
  if (m.dsttype && !test('dsttype', m.dsttype.v === 'LOCAL' ? !!p.local : false)) return false;
  if (m.tcpflags && !test('tcpflags', /SYN$/.test(m.tcpflags.v) && p.proto === 'tcp')) return false; // the first packet: SYN
  if (m.set) {
    const s = p.sets[m.set.v];
    const hit = s ? [...s].some(x => x.includes('/') ? inCidr(p.src, x) : x === p.src) : false;
    if (m.set.neg ? hit : !hit) return false;
  }
  if (r.other.some(o => !KNOWN_OTHER.has(o))) return null;
  return true;
}

/** Walks `chain` (and every chain it jumps to); returns { verdict, rule, trace } or null when the chain falls through. */
function walk(table, chain, p, trace, depth = 0) {
  const c = table.chains[chain];
  if (!c || depth > 30) return null;
  for (let i = 0; i < c.rules.length; i++) {
    const r = c.rules[i];
    const ok = matches(r, p);
    if (ok === null) { trace.push({ chain, n: i + 1, text: r.text, note: 'uses a match DockGate cannot judge: assumed not to apply', source: sourceOf(r) }); continue; }
    if (!ok) continue;
    const t = r.target;
    if (!t || t === 'LOG' || t === 'NFLOG' || t === 'MARK' || t === 'CONNMARK') { trace.push({ chain, n: i + 1, text: r.text, note: t ? 'logged, goes on' : 'counted, goes on', source: sourceOf(r) }); continue; }
    if (t === 'RETURN') { trace.push({ chain, n: i + 1, text: r.text, note: 'returns to the chain that jumped here', source: sourceOf(r) }); return null; }
    if (['ACCEPT', 'DROP', 'REJECT'].includes(t)) { trace.push({ chain, n: i + 1, text: r.text, note: t === 'ACCEPT' ? 'lets it in' : t === 'DROP' ? 'drops it (no answer)' : 'refuses it', source: sourceOf(r) }); return { verdict: t === 'ACCEPT' ? 'pass' : 'blocked', rule: { chain, n: i + 1, text: r.text, source: sourceOf(r) } }; }
    if (table.chains[t]) {
      trace.push({ chain, n: i + 1, text: r.text, note: `goes to ${t}`, source: sourceOf(r) });
      const res = walk(table, t, p, trace, depth + 1);
      if (res) return res;
      if (r.goto) return null;
      continue;
    }
    trace.push({ chain, n: i + 1, text: r.text, note: `target ${t}: not followed`, source: sourceOf(r) });
  }
  return null;
}

/** Docker's NAT: host port -> container { ip, port, bridge } for TCP/UDP. */
function dnatMap(nat) {
  const out = [];
  for (const r of ((nat.chains.DOCKER || {}).rules || [])) {
    if (r.target !== 'DNAT' || !r.m.dport) continue;
    const to = (r.text.match(/--to-destination (\S+)/) || [])[1] || '';
    const mm = /^\[?([0-9a-f:.]+)\]?:(\d+)$/i.exec(to);
    if (!mm) continue;
    out.push({ hostPort: Number(r.m.dport.v), proto: (r.m.proto || {}).v || 'tcp', ip: mm[1], port: Number(mm[2]), bridge: r.m.in && r.m.in.neg ? r.m.in.v : null });
  }
  return out;
}

/**
 * Will a NEW connection from `src` to this server's `port`/`proto` get through? Follows Docker's NAT to a container
 * (FORWARD chain) or stays on the host (INPUT chain), then walks the rules. ipv6 when `src` is an IPv6 address.
 */
function simulate(state, { src, port, proto = 'tcp' }) {
  port = Number(port);
  if (!net.isIP(src)) throw Object.assign(new Error('From: an IP address'), { statusCode: 400 });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Port: 1-65535'), { statusCode: 400 });
  if (!['tcp', 'udp'].includes(proto)) throw Object.assign(new Error('Protocol: tcp or udp'), { statusCode: 400 });
  const v6 = net.isIP(src) === 6;
  const filter = v6 ? state.filter6 : state.filter4;
  if (!filter || !Object.keys(filter.chains).length) return { verdict: 'unknown', why: `The ${v6 ? 'IPv6' : 'IPv4'} rules could not be read (needs sudo).`, trace: [] };
  const nat = !v6 && state.dnat.find(d => d.hostPort === port && d.proto === proto);
  const trace = [];
  let p, chain, path;
  if (nat) {
    p = { src, dst: nat.ip, proto, dport: nat.port, in: state.extIface || 'eth0', out: nat.bridge || 'docker0', local: false, sets: state.sets };
    chain = 'FORWARD'; path = `Docker sends port ${port} to a container (${nat.ip}:${nat.port}${state.portOwner[`${port}/${proto}`] ? `, ${state.portOwner[`${port}/${proto}`]}` : ''}), through the FORWARD chain`;
  } else {
    p = { src, dst: state.hostIp || '0.0.0.0', proto, dport: port, in: state.extIface || 'eth0', out: null, local: true, sets: state.sets };
    chain = 'INPUT'; path = `Port ${port} on the server itself, through the INPUT chain`;
  }
  const res = walk(filter, chain, p, trace);
  const policy = (filter.chains[chain] || {}).policy || 'ACCEPT';
  if (res) return { verdict: res.verdict, path, rule: res.rule, trace };
  return { verdict: policy === 'ACCEPT' ? 'pass' : 'blocked', path, rule: { chain, n: 0, text: `policy ${policy}`, source: { kind: 'system', label: `the ${chain} chain's default` } }, trace };
}

// ---------------------------------------------------------------- what a firewall change would do
/**
 * The live state with DockGate's isolation rules replaced by `blockText` (dockerBlock(keep) from security/plans), or
 * taken out when blockText is empty. fail2ban's rules and rules added by hand stay where they are, before ours (as they
 * do live: fail2ban inserts at the top). UFW's own chains (ufw-user-forward with route rules) stay as they are live.
 */
function withIsolation(state, blockText) {
  const f = { chains: {} };
  for (const [k, c] of Object.entries(state.filter4.chains)) f.chains[k] = { policy: c.policy, rules: c.rules.slice() };
  const du = (f.chains['DOCKER-USER'] || { policy: null, rules: [] });
  const keepRules = du.rules.filter(r => sourceOf(r).kind !== 'dockgate');
  f.chains['DOCKER-USER'] = { policy: null, rules: keepRules };
  f.chains['ufw-docker-logging-deny'] = { policy: null, rules: [] };
  if (blockText) {
    const planned = parseSave(blockText).chains;
    f.chains['DOCKER-USER'].rules = [...keepRules, ...((planned['DOCKER-USER'] || {}).rules || [])];
    f.chains['ufw-docker-logging-deny'].rules = (planned['ufw-docker-logging-deny'] || {}).rules || [];
    if (!f.chains['ufw-user-forward']) f.chains['ufw-user-forward'] = { policy: null, rules: [] };
  }
  if (!f.chains.FORWARD) return null;
  if (!f.chains.FORWARD.rules.some(r => r.target === 'DOCKER-USER')) f.chains.FORWARD.rules.unshift(parseRule('-A FORWARD -j DOCKER-USER'));
  return { ...state, filter4: f };
}

/** Every port Docker forwards, from the internet and from Cloudflare: now and after the change. */
function predictPorts(state, after) {
  const from = [['internet', '8.8.8.8'], ['cloudflare', '172.68.234.207']];
  return state.dnat.map(d => {
    const row = { hostPort: d.hostPort, proto: d.proto, owner: state.portOwner[`${d.hostPort}/${d.proto}`] || null, to: `${d.ip}:${d.port}`, now: {}, after: {} };
    for (const [k, ip] of from) {
      const a = simulate(state, { src: ip, port: d.hostPort, proto: d.proto });
      row.now[k] = a.verdict;
      if (after) { const b = simulate(after, { src: ip, port: d.hostPort, proto: d.proto }); row.after[k] = b.verdict; row.rule = row.rule || (b.verdict === 'blocked' ? b.rule : null); }
    }
    row.changes = !!after && from.some(([k]) => row.now[k] !== row.after[k]);
    return row;
  });
}

// ---------------------------------------------------------------- reading it all
function parseState(out) {
  const S = sections(out);
  const filter4 = parseSave(S.filter4), filter6 = parseSave(S.filter6), nat4 = parseSave(S.nat4);
  const ifaces = String(S.ifaces || '').split('\n').map(l => l.trim().split(/\s+/)).filter(x => x.length === 2);
  const ext = ifaces.find(([n, a]) => n !== 'lo' && !/^(docker|br-|veth)/.test(n) && !/^(127\.)/.test(a)) || [];
  const portOwner = {};
  for (const l of String(S.ports || '').split('\n')) {
    const [name, ports] = l.split('|'); if (!ports) continue;
    for (const m of ports.matchAll(/(?:0\.0\.0\.0|\[::\]|::):(\d+)->\d+\/(tcp|udp)/g)) portOwner[`${m[1]}/${m[2]}`] = name;
  }
  return {
    iptables: String(S.iptv || '').trim(), dockerBackend: /nftables/i.test(S.backend || '') ? 'nftables' : 'iptables',
    ufwActive: /Status: active/.test(S.ufwstatus || ''),
    filter4, filter6, nat4, dnat: dnatMap(nat4), sets: parseIpset(S.ipset), portOwner,
    extIface: ext[0] || null, hostIp: ext[1] ? ext[1].split('/')[0] : null,
    userRoutes: String(S.userrules || '').split('\n').map(l => /route:allow (tcp|udp|any) (\d+)/.exec(l)).filter(Boolean).map(m => ({ proto: m[1], port: Number(m[2]) })),
    blockInFile: Number(String(S.afterblock || '0').trim()) > 0,
    keepInFile: String(S.afterkeep || '').split('\n').map(l => /-p (tcp|udp) .*--dport (\d+)/.exec(l)).filter(Boolean).map(m => ({ proto: m[1], port: Number(m[2]) })),
    drops: parseDrops(S.drops),
  };
}

/** Kernel drop lines -> grouped { prefix, proto, dport, count, sources: [{ src, count }], last, toContainer } (newest first). */
function parseDrops(text) {
  const groups = {};
  for (const l of String(text || '').split('\n')) {
    const pre = (/\[(UFW (?:DOCKER )?BLOCK)\]/.exec(l) || [])[1]; if (!pre) continue;
    const f = (k) => (new RegExp(`\\b${k}=(\\S*)`).exec(l) || [])[1] || '';
    const src = f('SRC'), dpt = Number(f('DPT')) || 0, proto = f('PROTO').toLowerCase();
    const time = (/^(\w{3}\s+\d+\s+[\d:]+)/.exec(l) || [])[1] || '';
    const key = `${pre}|${proto}|${dpt}`;
    const g = groups[key] = groups[key] || { prefix: pre, proto, dport: dpt, count: 0, srcs: {}, last: '', out: f('OUT'), dst: f('DST') };
    g.count++; g.srcs[src] = (g.srcs[src] || 0) + 1; g.last = time || g.last;
  }
  return Object.values(groups).map(g => ({ ...g, srcs: undefined, sources: Object.entries(g.srcs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([src, count]) => ({ src, count })) })).sort((a, b) => b.count - a.count);
}

/** Differences between the files and the live firewall, each with what to do. */
function problems(st) {
  const out = [];
  const du = (st.filter4.chains['DOCKER-USER'] || { rules: [] }).rules;
  const liveIso = du.some(r => /-j ufw-user-forward$/.test(r.text));
  if (liveIso && !st.blockInFile) out.push({ id: 'leftover-isolation', level: 'crit', text: 'Docker port isolation rules are in the live firewall, but not in /etc/ufw/after.rules: they were left behind (an older DockGate did not remove them when isolation was turned off). They drop new connections to your containers.', fix: 'remove-leftover' });
  if (!liveIso && st.blockInFile && st.ufwActive) out.push({ id: 'isolation-not-live', level: 'warn', text: 'Docker port isolation is in /etc/ufw/after.rules but not in the live firewall. Reload the firewall (Firewall tab > Reload) to apply it.' });
  for (const k of st.keepInFile) {
    if (liveIso && !du.some(r => /dockgate-keep/.test(r.text) && r.m.dport && Number(r.m.dport.v) === k.port && (r.m.proto || {}).v === k.proto)) out.push({ id: `keep-${k.port}-${k.proto}`, level: 'crit', text: `${k.port}/${k.proto} should stay public behind Docker port isolation, but its rule is not in the live firewall.` });
  }
  const fwd = (st.filter4.chains['ufw-user-forward'] || { rules: [] }).rules;
  for (const r of st.userRoutes) {
    if (!fwd.some(x => x.m.dport && Number(x.m.dport.v) === r.port)) out.push({ id: `route-${r.port}`, level: liveIso ? 'warn' : 'info', text: `UFW holds a route rule for port ${r.port}, but it is not in the live firewall${liveIso ? ' (Docker port isolation does not let that port through by it)' : ''}.` });
  }
  if (st.dockerBackend === 'nftables' && st.blockInFile) out.push({ id: 'nft-backend', level: 'warn', text: 'Docker uses its nftables firewall backend: Docker port isolation (iptables DOCKER-USER) has no effect on its ports.' });
  const webDrops = st.drops.filter(d => [80, 443].includes(d.dport));
  if (webDrops.length) out.push({ id: 'web-drops', level: 'crit', text: `Connections to ${[...new Set(webDrops.map(d => `${d.dport}/${d.proto}`))].join(', ')} were dropped in the last hour (${webDrops.reduce((a, d) => a + d.count, 0)}): visitors (or Cloudflare) may not reach your sites.` });
  return out;
}

/** The page: chains with each rule's source, problems, drops. Chains with no rules are left out. */
function view(st) {
  const chainsOf = (t) => Object.entries(t.chains).filter(([, c]) => c.rules.length || c.policy).map(([name, c]) => ({ name, policy: c.policy, rules: c.rules.map((r, i) => ({ n: i + 1, text: r.text, source: sourceOf(r) })) }));
  return {
    iptables: st.iptables, dockerBackend: st.dockerBackend, ufwActive: st.ufwActive, extIface: st.extIface, hostIp: st.hostIp,
    problems: problems(st), drops: st.drops.slice(0, 50),
    tables: [{ name: 'IPv4 filter', chains: chainsOf(st.filter4) }, { name: 'IPv4 NAT', chains: chainsOf(st.nat4) }, { name: 'IPv6 filter', chains: chainsOf(st.filter6) }],
    ports: st.dnat.map(d => ({ ...d, owner: st.portOwner[`${d.hostPort}/${d.proto}`] || null })),
    sets: Object.fromEntries(Object.entries(st.sets).map(([k, v]) => [k, v.size])),
  };
}

module.exports = { READ, sections, parseRule, parseSave, parseIpset, sourceOf, matches, simulate, dnatMap, parseState, parseDrops, problems, view, withIsolation, predictPorts };
