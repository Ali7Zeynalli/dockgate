// Server Console → System: the server's own settings, each through a form, never by hand-editing:
//   hostname · /etc/hosts · DNS · kernel (sysctl) · open-file limit · journald size · network interfaces · /etc/fstab
// Every change is a "plan" for the security worker (server/security/worker.js): back up, write, validate with the
// tool that owns the file, apply — and restore the backup when the check fails. Network changes also arm a root
// rollback timer and keep the change only when a NEW SSH login works (the same lifeline as SSH and the firewall).
// DockGate writes its own drop-in files where the system has a .d folder, so distribution files stay untouched.
// Everything here builds text and commands from validated values only (pure, unit tested).
const P = require('./security/parse');
const plans = require('./security/plans');
const SWAP = require('./swap');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const writeFile = (path, content, mode = '0644') => `echo ${b64(content)} | base64 -d | {{S}}tee ${path} >/dev/null && {{S}}chmod ${mode} ${path}`;
const backup = (f) => `if {{S}}test -e ${f}; then {{S}}cp -pP ${f} ${f}.dockgate-prev; else {{S}}rm -f ${f}.dockgate-prev; fi`;
const restore = (f) => `if {{S}}test -e ${f}.dockgate-prev; then {{S}}mv -f ${f}.dockgate-prev ${f}; else {{S}}rm -f ${f}; fi`;
const drop = (f) => `{{S}}rm -f ${f}.dockgate-prev`;
const bad = (msg) => P.httpError(400, msg);
/**
 * Shell that runs findmnt --verify on a tab file and sets bad=1 when it found a problem. findmnt versions report
 * differently: newer ones print "[E] …" lines and a summary ("0 parse errors, 1 error"), older ones only
 * "parse error at line N -- ignored" — any of them, or a non-zero exit, counts. Output is in $out.
 */
const fstabVerify = (file, sudo = '') => `out=$(${sudo}findmnt --verify --tab-file ${file} 2>&1); rc=$?; bad=0; [ $rc -ne 0 ] && bad=1; echo "$out" | grep -qE '^\\s*\\[E\\]|parse error at' && bad=1; echo "$out" | grep -qE '(^|[^0-9])[1-9][0-9]* (parse )?errors?' && bad=1`;

const F = {
  hosts: '/etc/hosts',
  resolvedDrop: '/etc/systemd/resolved.conf.d/99-dockgate.conf',
  resolv: '/etc/resolv.conf',
  sysctl: '/etc/sysctl.d/99-dockgate.conf',
  limits: '/etc/security/limits.d/99-dockgate.conf',
  systemdLimits: '/etc/systemd/system.conf.d/99-dockgate-limits.conf',
  journald: '/etc/systemd/journald.conf.d/99-dockgate.conf',
  netplan: '/etc/netplan/99-dockgate.yaml',
  fstab: '/etc/fstab',
};

// ---------------------------------------------------------------- reading (one round trip)
const READ = [
  'echo @@uid; id -u',
  'echo @@hostname; hostname 2>/dev/null; hostnamectl --static 2>/dev/null | head -1',
  `echo @@hosts; cat ${F.hosts} 2>/dev/null`,
  'echo @@resolved; systemctl is-active systemd-resolved 2>/dev/null',
  `echo @@resolvedDrop; cat ${F.resolvedDrop} 2>/dev/null`,
  'echo @@resolvectl; resolvectl dns 2>/dev/null | head -20; resolvectl domain 2>/dev/null | head -10',
  `echo @@resolv; cat ${F.resolv} 2>/dev/null; echo "@@resolvLink"; readlink -f ${F.resolv} 2>/dev/null`,
  `echo @@sysctlDrop; cat ${F.sysctl} 2>/dev/null`,
  'echo @@sysctl; for k in net.ipv4.ip_forward net.core.somaxconn vm.swappiness fs.file-max fs.inotify.max_user_watches fs.inotify.max_user_instances vm.max_map_count net.ipv4.tcp_tw_reuse net.ipv4.ip_local_port_range net.core.netdev_max_backlog vm.overcommit_memory; do printf "%s=%s\\n" "$k" "$(sysctl -n $k 2>/dev/null | tr \'\\t\' \' \')"; done',
  'echo @@nofile; ulimit -n; ulimit -Hn',
  `echo @@limitsDrop; {{S}}cat ${F.limits} 2>/dev/null`,
  'echo @@journal; journalctl --disk-usage 2>/dev/null | tail -1',
  `echo @@journalDrop; cat ${F.journald} 2>/dev/null`,
  'echo @@netstack; command -v netplan >/dev/null 2>&1 && echo netplan; command -v nmcli >/dev/null 2>&1 && systemctl is-active NetworkManager >/dev/null 2>&1 && echo nm; [ -f /etc/network/interfaces ] && echo ifupdown; systemctl is-active systemd-networkd >/dev/null 2>&1 && echo networkd; true',
  'echo @@ipaddr; ip -j addr 2>/dev/null',
  'echo @@iproute; ip -j route 2>/dev/null',
  'echo @@sshconn; echo "$SSH_CONNECTION"',
  `echo @@netplanFiles; for f in /etc/netplan/*.yaml /etc/netplan/*.yml; do [ -f "$f" ] && { echo "__FILE__$f"; {{S}}cat "$f" 2>/dev/null; }; done; true`,
  `echo @@fstab; cat ${F.fstab} 2>/dev/null`,
  'echo @@mounts; findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null | head -100',
  'echo @@df; df -PhT 2>/dev/null | tail -n +2 | head -50',
  'echo @@blk; lsblk -J -o NAME,SIZE,TYPE,FSTYPE,UUID,MOUNTPOINT 2>/dev/null',
  'echo @@swaps; cat /proc/swaps 2>/dev/null',
  "echo @@meminfo; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
  'echo @@virt; systemd-detect-virt -c 2>/dev/null; true',
  `echo @@swapLegacy; cat ${SWAP.LEGACY_FILE} 2>/dev/null`,
  "echo @@rootFree; stat -f -c %T / 2>/dev/null; df -Pm / 2>/dev/null | awk 'NR==2{print $4}'",
  'echo @@os; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"',
].join('; ');

const SYSCTL_INFO = {
  'net.ipv4.ip_forward': ['Packet forwarding', 'Docker and VPNs need 1', ['0', '1']],
  'net.core.somaxconn': ['Listen queue', 'Busy web servers: 4096 or more', null],
  'vm.swappiness': ['Swappiness', '10 keeps apps in RAM; 60 is the kernel default', null],
  'fs.file-max': ['Open files (system)', 'The whole system’s limit', null],
  'fs.inotify.max_user_watches': ['inotify watches', 'File watchers (Node, IDEs, log shippers): 524288', null],
  'fs.inotify.max_user_instances': ['inotify instances', 'Many containers watching files: 1024', null],
  'vm.max_map_count': ['Memory maps', 'Elasticsearch / OpenSearch need 262144', null],
  'net.ipv4.tcp_tw_reuse': ['Reuse TIME_WAIT', 'Many outgoing connections: 1', ['0', '1', '2']],
  'net.ipv4.ip_local_port_range': ['Local port range', 'e.g. 1024 65535', null],
  'net.core.netdev_max_backlog': ['Network backlog', 'High traffic: 16384', null],
  'vm.overcommit_memory': ['Memory overcommit', 'Redis recommends 1', ['0', '1', '2']],
};

function sections(out) {
  const res = {}; let cur = null;
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; res[cur] = []; continue; }
    if (cur) res[cur].push(line);
  }
  for (const k of Object.keys(res)) res[k] = res[k].join('\n').replace(/\n+$/, '');
  return res;
}
const json = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

function parseHosts(text) {
  return String(text || '').split('\n').map((raw, i) => {
    const s = raw.replace(/#.*$/, '').trim();
    if (!s) return { i, raw, kind: raw.trim() ? 'comment' : 'blank' };
    const [ip, ...names] = s.split(/\s+/);
    return { i, raw, kind: 'entry', ip, names, comment: (/#\s*(.*)$/.exec(raw) || [])[1] || '' };
  });
}
function parseKv(text) { const o = {}; for (const l of String(text || '').split('\n')) { const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2]; } return o; }
function parseFstab(text) {
  return String(text || '').split('\n').map((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith('#')) return { i, raw, kind: s ? 'comment' : 'blank' };
    const p = s.split(/\s+/);
    return { i, raw, kind: 'entry', source: p[0], target: p[1], fstype: p[2], options: p[3] || 'defaults', dump: p[4] || '0', pass: p[5] || '0' };
  });
}

/** The page's data from the read script. */
function parseRead(out) {
  const S = sections(out);
  const sysNow = parseKv(S.sysctl);
  const addrs = json(S.ipaddr, []) || [], routes = json(S.iproute, []) || [];
  const ssh = String(S.sshconn || '').trim().split(/\s+/); // client ip, client port, server ip, server port
  const dns = { resolved: String(S.resolved).trim() === 'active', drop: parseKv(S.resolvedDrop), resolvectl: S.resolvectl || '', resolv: (S.resolv || '').split('@@resolvLink')[0].trim(), resolvLink: ((S.resolv || '').split('@@resolvLink')[1] || '').trim() };
  dns.servers = [...new Set(((dns.resolv.match(/^nameserver\s+(\S+)/gm) || []).map(l => l.split(/\s+/)[1])))];
  const files = []; let cur = null;
  for (const l of String(S.netplanFiles || '').split('\n')) { if (l.startsWith('__FILE__')) { cur = { path: l.slice(8), text: '' }; files.push(cur); } else if (cur) cur.text += (cur.text ? '\n' : '') + l; }
  const [hn, hnStatic] = String(S.hostname || '').split('\n');
  return {
    root: String(S.uid).trim() === '0', os: (S.os || '').trim(),
    hostname: (hnStatic || hn || '').trim(),
    hosts: parseHosts(S.hosts), hostsText: S.hosts || '',
    dns,
    sysctl: Object.entries(SYSCTL_INFO).map(([k, [label, hint, choices]]) => ({ key: k, label, hint, choices, now: sysNow[k] || '', dockgate: parseKv(S.sysctlDrop)[k] || null })),
    sysctlDrop: parseKv(S.sysctlDrop),
    nofile: (() => { const [soft, hard] = String(S.nofile || '').split('\n'); return { soft: soft || '', hard: hard || '', dockgate: (/\bnofile\s+(\d+)/.exec(S.limitsDrop || '') || [])[1] || null }; })(),
    journal: { usage: (S.journal || '').trim(), maxUse: parseKv(S.journalDrop).SystemMaxUse || null },
    net: {
      stack: String(S.netstack || '').split('\n').map(s => s.trim()).filter(Boolean),
      interfaces: addrs.filter(a => a.ifname !== 'lo').map(a => ({
        name: a.ifname, state: a.operstate, mtu: a.mtu, mac: a.address,
        v4: (a.addr_info || []).filter(x => x.family === 'inet').map(x => ({ ip: x.local, prefix: x.prefixlen, dynamic: !!x.dynamic })),
        v6: (a.addr_info || []).filter(x => x.family === 'inet6' && x.scope === 'global').map(x => ({ ip: x.local, prefix: x.prefixlen })),
        docker: /^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|tun|wg)/.test(a.ifname),
      })),
      defaultRoute: (routes.find(r => r.dst === 'default') || null),
      sshServerIp: ssh[2] || null,
      netplanFiles: files,
    },
    fstab: parseFstab(S.fstab), fstabText: S.fstab || '',
    mounts: String(S.mounts || '').split('\n').filter(Boolean).map(l => { const [target, source, fstype, options] = l.split(' '); return { target, source, fstype, options }; }),
    df: String(S.df || '').split('\n').filter(Boolean).map(l => { const p = l.trim().split(/\s+/); return { source: p[0], fstype: p[1], size: p[2], used: p[3], avail: p[4], pct: p[5], target: p[6] }; }),
    blk: (json(S.blk, {}) || {}).blockdevices || [],
    swap: (() => {
      const mem = {}; for (const l of String(S.meminfo || '').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(l); if (m) mem[m[1]] = Math.round(Number(m[2]) / 1024); }
      const [fs, free] = String(S.rootFree || '').split('\n').map(x => x.trim());
      const virt = String(S.virt || '').trim();
      return {
        devices: SWAP.parseSwaps(S.swaps), ramMb: mem.MemTotal || null, availMb: mem.MemAvailable || null,
        swappiness: sysNow['vm.swappiness'] || '', dockgate: parseKv(S.sysctlDrop)['vm.swappiness'] || null,
        legacy: parseKv(S.swapLegacy)['vm.swappiness'] || null,
        container: /^(lxc|openvz)/.test(virt) ? virt : null, rootFs: fs || '', rootFreeMb: Number(free) || null,
        fstab: parseFstab(S.fstab).filter(e => e.kind === 'entry' && e.fstype === 'swap').map(e => e.source),
        defaultMb: SWAP.DEFAULT_MB,
      };
    })(),
  };
}

// ---------------------------------------------------------------- validation
const HOST_RE = /^(?=.{1,63}$)[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const FQDN_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const isIp = (s) => require('net').isIP(String(s || '')) !== 0;
function cidr(s, label) {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(String(s || '').trim());
  if (!m || !isIp(m[1]) || Number(m[2]) > (m[1].includes(':') ? 128 : 32)) throw bad(`${label}: an address with its prefix, e.g. 203.0.113.10/24`);
  return `${m[1]}/${Number(m[2])}`;
}

// ---------------------------------------------------------------- plans
/** hostname: hostnamectl + the 127.0.1.1 line of /etc/hosts (sudo resolves the name, so they must agree). */
function hostnamePlan(name, hostsText) {
  const n = String(name || '').trim();
  if (!HOST_RE.test(n.split('.')[0]) || !FQDN_RE.test(n)) throw bad('Hostname: letters, digits and -, up to 63 per part (e.g. web-1 or web-1.example.com)');
  const short = n.split('.')[0];
  const lines = String(hostsText || '').split('\n');
  const i = lines.findIndex(l => /^\s*127\.0\.1\.1\s/.test(l));
  const line = `127.0.1.1\t${n === short ? short : `${n} ${short}`}`;
  if (i >= 0) lines[i] = line; else lines.splice(Math.min(1, lines.length), 0, line);
  const hosts = lines.join('\n').replace(/\n*$/, '\n');
  return { steps: [
    { label: `Back up ${F.hosts}`, cmd: backup(F.hosts) },
    { label: `Point 127.0.1.1 at ${n} in ${F.hosts}`, cmd: writeFile(F.hosts, hosts) },
    { label: `Set the hostname to ${n}`, cmd: `if command -v hostnamectl >/dev/null 2>&1; then {{S}}hostnamectl set-hostname ${shq(n)}; else echo ${shq(n)} | {{S}}tee /etc/hostname >/dev/null && {{S}}hostname ${shq(short)}; fi || { ${restore(F.hosts)}; echo "Could not set the hostname — restored"; exit 1; }` },
    { label: 'Check that sudo still resolves the name', cmd: `{{S}}true && getent hosts ${shq(short)} >/dev/null || echo "note: ${short} does not resolve yet"; ${drop(F.hosts)}` },
  ] };
}

/** /etc/hosts as a table: rows [{ ip, names[], comment }]; comments and localhost lines that are not rows stay. */
function hostsPlan(rows, currentText) {
  const keep = parseHosts(currentText).filter(l => l.kind !== 'entry' || /^(127\.|::1$|fe00:|ff0[0-9]:)/.test(l.ip));
  const out = keep.map(l => l.raw);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const r of rows || []) {
    if (!isIp(r.ip)) throw bad(`Hosts: "${r.ip}" is not an IP address`);
    const names = (Array.isArray(r.names) ? r.names : String(r.names || '').split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
    if (!names.length || names.some(x => !FQDN_RE.test(x))) throw bad(`Hosts: names for ${r.ip} — letters, digits, - and .`);
    if (/^(127\.|::1$)/.test(r.ip)) continue; // localhost lines stay as they are
    out.push(`${r.ip}\t${names.join(' ')}${r.comment ? `\t# ${String(r.comment).replace(/[\r\n#]/g, ' ').slice(0, 80)}` : ''}`);
  }
  const text = out.join('\n').replace(/\n*$/, '\n');
  return { text, plan: { steps: [
    { label: `Back up ${F.hosts}`, cmd: backup(F.hosts) },
    { label: `Write ${F.hosts}`, cmd: writeFile(F.hosts, text) },
    { label: 'Check: localhost still resolves', cmd: `getent hosts localhost >/dev/null || { ${restore(F.hosts)}; echo "localhost stopped resolving — restored"; exit 1; }; ${drop(F.hosts)}` },
  ] } };
}

/** DNS: systemd-resolved drop-in when resolved runs, else /etc/resolv.conf (when it is a plain file). Tested with a lookup. */
function dnsPlan({ servers, domains, resolved, resolvLink, testName = 'cloudflare.com' }) {
  const list = (Array.isArray(servers) ? servers : String(servers || '').split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
  if (!list.length) throw bad('DNS: at least one server address');
  if (list.length > 6) throw bad('DNS: at most 6 servers');
  for (const s of list) if (!isIp(s)) throw bad(`DNS: "${s}" is not an IP address`);
  const doms = (Array.isArray(domains) ? domains : String(domains || '').split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
  for (const d of doms) if (!FQDN_RE.test(d)) throw bad(`Search domain: "${d}" is not a domain`);
  if (!FQDN_RE.test(testName)) throw bad('Test name: a domain');
  const test = `getent ahosts ${shq(testName)} >/dev/null 2>&1`;
  if (resolved) {
    const text = `# Managed by DockGate (Server Console → System → DNS)\n[Resolve]\nDNS=${list.join(' ')}\n${doms.length ? `Domains=${doms.join(' ')}\n` : ''}`;
    return { file: F.resolvedDrop, text, plan: { steps: [
      { label: `Back up ${F.resolvedDrop}`, cmd: `{{S}}mkdir -p /etc/systemd/resolved.conf.d && ${backup(F.resolvedDrop)}` },
      { label: `Write ${F.resolvedDrop}`, cmd: writeFile(F.resolvedDrop, text) },
      { label: 'Restart systemd-resolved', cmd: `{{S}}systemctl restart systemd-resolved || { ${restore(F.resolvedDrop)}; {{S}}systemctl restart systemd-resolved; echo "systemd-resolved did not start — restored"; exit 1; }` },
      { label: `Test: resolve ${testName}`, cmd: `sleep 1; ${test} || { ${restore(F.resolvedDrop)}; {{S}}systemctl restart systemd-resolved; echo "Names do not resolve with these servers — restored"; exit 1; }; ${drop(F.resolvedDrop)}` },
    ] } };
  }
  if (resolvLink && resolvLink !== F.resolv) throw bad(`${F.resolv} is a link to ${resolvLink} (managed by another program) — change DNS there, or in the network settings below`);
  const text = `# Managed by DockGate (Server Console → System → DNS)\n${list.map(s => `nameserver ${s}`).join('\n')}\n${doms.length ? `search ${doms.join(' ')}\n` : ''}`;
  return { file: F.resolv, text, plan: { steps: [
    { label: `Back up ${F.resolv}`, cmd: backup(F.resolv) },
    { label: `Write ${F.resolv}`, cmd: writeFile(F.resolv, text) },
    { label: `Test: resolve ${testName}`, cmd: `${test} || { ${restore(F.resolv)}; echo "Names do not resolve with these servers — restored"; exit 1; }; ${drop(F.resolv)}` },
  ] } };
}

/** Kernel settings in DockGate's own sysctl.d file; values are checked by sysctl itself before they are kept. */
function sysctlPlan(values) {
  const lines = [];
  for (const [k, v] of Object.entries(values || {})) {
    if (!SYSCTL_INFO[k]) throw bad(`Kernel setting "${k}" is not offered here — edit /etc/sysctl.d yourself in Files`);
    if (v === '' || v == null) continue;
    const val = String(v).trim();
    if (!/^[0-9]+( [0-9]+)?$/.test(val)) throw bad(`${k}: a number (or two numbers for a range)`);
    const choices = SYSCTL_INFO[k][2]; if (choices && !choices.includes(val)) throw bad(`${k}: one of ${choices.join(', ')}`);
    lines.push(`${k} = ${val}`);
  }
  const text = `# Managed by DockGate (Server Console → System → Kernel)\n${lines.join('\n')}\n`;
  return { text, plan: { steps: [
    { label: `Back up ${F.sysctl}`, cmd: backup(F.sysctl) },
    { label: `Write ${F.sysctl}`, cmd: writeFile(F.sysctl, text) },
    { label: 'Apply (sysctl -p) — an unknown value restores the file', cmd: `out=$({{S}}sysctl -p ${F.sysctl} 2>&1) || { ${restore(F.sysctl)}; {{S}}sysctl --system >/dev/null 2>&1; echo "The kernel refused: $out — restored"; exit 1; }; echo "$out"; ${drop(F.sysctl)}` },
    ...(lines.some(l => l.startsWith('vm.swappiness ')) ? [{ label: `Remove ${SWAP.LEGACY_FILE} (an older swappiness file that would win at boot)`, cmd: `if {{S}}test -f ${SWAP.LEGACY_FILE} && ! {{S}}grep -vqE '^[[:space:]]*(#|$|vm\\.swappiness[[:space:]]*=)' ${SWAP.LEGACY_FILE}; then {{S}}rm -f ${SWAP.LEGACY_FILE}; fi; true` }] : []),
  ] } };
}

/** Swap: set (make / resize a swap file) or remove one. `current` = parseRead().swap, so only swap DockGate can see is touched. */
function swapPlan(op, current) {
  const cur = current || { devices: [], fstab: [] };
  if (op.action === 'set') {
    if (cur.container) throw bad(`This server is a container (${cur.container}): its host decides swap`);
    const path = SWAP.checkPath(op.path || '/swapfile'), size = SWAP.checkSize(op.sizeMb == null ? SWAP.DEFAULT_MB : op.sizeMb);
    const dev = cur.devices.find(d => d.path === path);
    if (dev && dev.type !== 'file') throw bad(`${path} is a ${dev.type}, not a file — it is not changed here`);
    return { steps: [{ label: dev ? `Resize ${path} to ${size} MB` : `Make a ${size} MB swap file at ${path}`, cmd: SWAP.asRoot(SWAP.createScript(path, size), '{{S}}') }] };
  }
  if (op.action === 'remove') {
    const path = SWAP.checkPath(op.path);
    const dev = cur.devices.find(d => d.path === path);
    if (dev && dev.type !== 'file') throw bad(`${path} is a ${dev.type}, not a file — it is not removed here`);
    if (!dev && !(cur.fstab || []).includes(path)) throw bad(`${path} is not a swap file on this server`);
    return { steps: [{ label: `Turn off and remove ${path}`, cmd: SWAP.asRoot(SWAP.removeScript(path), '{{S}}') }] };
  }
  throw bad('Unknown change');
}

/** Open-file limit for logins (limits.d) and for services (systemd DefaultLimitNOFILE). Takes effect for new sessions / restarted services. */
function nofilePlan(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1024 || v > 1048576) throw bad('Open files: 1024 – 1048576');
  const limits = `# Managed by DockGate (Server Console → System → Limits)\n*    soft nofile ${v}\n*    hard nofile ${v}\nroot soft nofile ${v}\nroot hard nofile ${v}\n`;
  const sys = `# Managed by DockGate (Server Console → System → Limits)\n[Manager]\nDefaultLimitNOFILE=${v}\n`;
  return { steps: [
    { label: 'Back up', cmd: `${backup(F.limits)}; {{S}}mkdir -p /etc/systemd/system.conf.d && ${backup(F.systemdLimits)}` },
    { label: `Write ${F.limits} and ${F.systemdLimits}`, cmd: `${writeFile(F.limits, limits)} && ${writeFile(F.systemdLimits, sys)}` },
    { label: 'Reload systemd (services get it when they restart)', cmd: `{{S}}systemctl daemon-reexec 2>/dev/null || true; ${drop(F.limits)}; ${drop(F.systemdLimits)}` },
  ] };
}

/** journald: the most disk the journal may use. */
function journaldPlan(maxUse) {
  const m = /^(\d{1,5})(M|G)$/i.exec(String(maxUse || '').trim());
  if (!m) throw bad('Journal size: a number with M or G, e.g. 500M or 2G');
  const text = `# Managed by DockGate (Server Console → System → Logs)\n[Journal]\nSystemMaxUse=${m[1]}${m[2].toUpperCase()}\n`;
  return { steps: [
    { label: `Write ${F.journald}`, cmd: `{{S}}mkdir -p /etc/systemd/journald.conf.d && ${backup(F.journald)} && ${writeFile(F.journald, text)}` },
    { label: 'Restart journald and shrink the journal', cmd: `{{S}}systemctl restart systemd-journald || { ${restore(F.journald)}; {{S}}systemctl restart systemd-journald; echo "journald did not start — restored"; exit 1; }; {{S}}journalctl --vacuum-size=${m[1]}${m[2].toUpperCase()} >/dev/null 2>&1; ${drop(F.journald)}` },
  ] };
}

/**
 * Network interface (netplan or NetworkManager): DHCP or static addresses, gateway, DNS, MTU.
 * The change is kept only when a NEW SSH login works; otherwise the root rollback timer restores it after 120 s.
 * cfg: { iface, stack: 'netplan'|'nm', dhcp, addresses[], gateway, dns[], mtu, sshIp, newSshIp? }
 */
function networkPlan(cfg, { id, test }) {
  const iface = String(cfg.iface || '');
  if (!/^[a-zA-Z0-9_.:-]{1,15}$/.test(iface)) throw bad('Interface name');
  const dhcp = !!cfg.dhcp;
  const addresses = dhcp ? [] : (cfg.addresses || []).map(a => cidr(a, 'Address'));
  if (!dhcp && !addresses.length) throw bad('A static interface needs at least one address');
  const gw = cfg.gateway ? String(cfg.gateway).trim() : '';
  if (gw && !isIp(gw)) throw bad('Gateway: an IP address');
  const dns = (cfg.dns || []).map(s => String(s).trim()).filter(Boolean);
  for (const s of dns) if (!isIp(s)) throw bad(`DNS: "${s}" is not an IP address`);
  const mtu = cfg.mtu ? Number(cfg.mtu) : null;
  if (mtu != null && (!Number.isInteger(mtu) || mtu < 576 || mtu > 9216)) throw bad('MTU: 576 – 9216');
  // The address DockGate connects to must stay, unless the new address is given (DockGate then switches to it).
  const keepsSsh = dhcp || !cfg.sshIp || addresses.some(a => a.split('/')[0] === cfg.sshIp) || cfg.sshIp === cfg.newSshIp;
  if (!keepsSsh && !cfg.newSshIp) throw bad(`DockGate connects to ${cfg.sshIp} — keep that address, or give the new address DockGate should use after the change`);
  let steps, restoreRoot, text = null;
  if (cfg.stack === 'netplan') {
    const y = [`# Managed by DockGate (Server Console → System → Network)`, 'network:', '  version: 2', '  ethernets:', `    ${iface}:`];
    if (dhcp) y.push('      dhcp4: true'); else { y.push('      dhcp4: false', '      addresses:', ...addresses.map(a => `        - ${a}`)); if (gw) y.push('      routes:', '        - to: default', `          via: ${gw}`); }
    if (dns.length) y.push('      nameservers:', `        addresses: [${dns.join(', ')}]`);
    if (mtu) y.push(`      mtu: ${mtu}`);
    text = y.join('\n') + '\n';
    const bk = '/var/lib/dockgate/netplan-prev';
    restoreRoot = `rm -rf /etc/netplan && cp -a ${bk} /etc/netplan && netplan apply`;
    steps = [
      { label: 'Back up /etc/netplan', cmd: `{{S}}mkdir -p /var/lib/dockgate && {{S}}rm -rf ${bk} && {{S}}cp -a /etc/netplan ${bk}` },
      { label: `Write ${F.netplan}`, cmd: `${writeFile(F.netplan, text, '0600')}` },
      { label: 'Check (netplan generate)', cmd: `out=$({{S}}netplan generate 2>&1) || { {{S}}rm -rf /etc/netplan && {{S}}cp -a ${bk} /etc/netplan; echo "netplan refused: $out — restored"; exit 1; }` },
    ];
  } else if (cfg.stack === 'nm') {
    const bk = '/var/lib/dockgate/nm-prev';
    restoreRoot = `rm -rf /etc/NetworkManager/system-connections && cp -a ${bk} /etc/NetworkManager/system-connections && nmcli connection reload && nmcli device reapply ${iface} || nmcli connection up ifname ${iface}`;
    const mods = dhcp ? ['ipv4.method auto', 'ipv4.addresses ""', 'ipv4.gateway ""'] : ['ipv4.method manual', `ipv4.addresses ${shq(addresses.filter(a => !a.includes(':')).join(','))}`, `ipv4.gateway ${shq(gw)}`];
    if (dns.length) mods.push(`ipv4.dns ${shq(dns.join(','))}`, 'ipv4.ignore-auto-dns yes');
    if (mtu) mods.push(`802-3-ethernet.mtu ${mtu}`);
    steps = [
      { label: 'Back up the NetworkManager connections', cmd: `{{S}}mkdir -p /var/lib/dockgate && {{S}}rm -rf ${bk} && {{S}}cp -a /etc/NetworkManager/system-connections ${bk}` },
      { label: `Find the connection of ${iface}`, cmd: `C=$(nmcli -g GENERAL.CONNECTION device show ${iface} 2>/dev/null); [ -n "$C" ] || { echo "No NetworkManager connection on ${iface}"; exit 1; }; echo "$C" | {{S}}tee /var/lib/dockgate/nm-conn >/dev/null` },
      { label: 'Change it', cmd: `C=$(cat /var/lib/dockgate/nm-conn); {{S}}nmcli connection modify "$C" ${mods.join(' ')} || { echo "NetworkManager refused the settings"; exit 1; }` },
    ];
  } else throw bad('This server\'s network is not managed by netplan or NetworkManager — edit its files in Files');
  return { text, plan: { steps: [
    ...steps,
    { label: 'Arm automatic rollback (120 s)', cmd: plans._armRollback(id, restoreRoot) },
    { label: 'Apply', cmd: cfg.stack === 'netplan' ? '{{S}}sh -c "nohup netplan apply >/dev/null 2>&1 &"; sleep 4' : `{{S}}sh -c ${shq(`nohup sh -c 'nmcli device reapply ${iface} || nmcli connection up "$(cat /var/lib/dockgate/nm-conn)"' >/dev/null 2>&1 &`)}; sleep 4`, rollbackOnFail: true },
    { label: `Open a NEW SSH connection${cfg.newSshIp && cfg.newSshIp !== cfg.sshIp ? ` to ${cfg.newSshIp}` : ''} to test`, test, rollbackOnFail: true },
    { label: 'Keep the change and cancel the rollback', cmd: plans._commitRollback(id) },
  ], rollback: plans._rollbackNow(id) } };
}

/** /etc/fstab: add or remove one line; checked with findmnt --verify (and mount -a for a new line) before it is kept. */
function fstabPlan(op, currentText) {
  const lines = String(currentText || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let mountTarget = null;
  if (op.action === 'remove') {
    const l = lines[op.index];
    if (l == null || l !== op.raw) throw P.httpError(409, '/etc/fstab changed after it was read — reload and try again');
    const e = parseFstab(l)[0];
    if (e.kind === 'entry' && ['/', '/boot', '/boot/efi', '/usr', '/var'].includes(e.target)) throw bad(`${e.target} is needed to start the server — not removed here`);
    lines.splice(op.index, 1);
  } else if (op.action === 'add') {
    const e = op.entry || {};
    if (!/^(UUID=[0-9a-fA-F-]{8,}|LABEL=[\w.-]+|\/dev\/[\w./-]+|[\w.-]+:\/[\w./-]*|\/\/[\w.-]+\/[\w.$-]+|tmpfs)$/.test(String(e.source || ''))) throw bad('Source: UUID=…, /dev/…, server:/path (NFS), //server/share (SMB) or tmpfs');
    if (!/^\/[\w./-]*$/.test(String(e.target || '')) || e.target === '/') throw bad('Mount point: an absolute path, not /');
    if (!/^[a-z0-9.]{2,12}$/.test(String(e.fstype || ''))) throw bad('File system: ext4, xfs, btrfs, nfs, cifs, tmpfs …');
    const opts = String(e.options || 'defaults').trim();
    if (!/^[\w.,=:/@-]+$/.test(opts)) throw bad('Options: e.g. defaults,nofail');
    if (lines.some(l => parseFstab(l)[0].target === e.target)) throw bad(`${e.target} is already in /etc/fstab`);
    lines.push(`${e.source}\t${e.target}\t${e.fstype}\t${opts}\t0\t${e.fstype === 'ext4' || e.fstype === 'xfs' ? 2 : 0}`);
    mountTarget = e.target;
  } else throw bad('Unknown change');
  const text = lines.join('\n') + '\n';
  return { text, plan: { steps: [
    { label: 'Back up /etc/fstab', cmd: backup(F.fstab) },
    ...(mountTarget ? [{ label: `Create ${mountTarget}`, cmd: `{{S}}mkdir -p ${shq(mountTarget)}` }] : []),
    { label: 'Write /etc/fstab', cmd: writeFile(F.fstab, text) },
    { label: 'Check (findmnt --verify)', cmd: `${fstabVerify(F.fstab, '{{S}}')}; if [ "$bad" = 1 ]; then ${restore(F.fstab)}; echo "findmnt found errors — restored: $(echo "$out" | grep -E '\\[E\\]|parse error at|[1-9][0-9]* (parse )?errors?' | head -3)"; exit 1; fi` },
    ...(mountTarget ? [{ label: `Mount ${mountTarget} now (a failure restores the file)`, cmd: `{{S}}systemctl daemon-reload 2>/dev/null; out=$({{S}}mount ${shq(mountTarget)} 2>&1) || { ${restore(F.fstab)}; {{S}}systemctl daemon-reload 2>/dev/null; echo "mount failed — restored: $out"; exit 1; }` }] : []),
    { label: 'Done', cmd: `{{S}}systemctl daemon-reload 2>/dev/null; ${drop(F.fstab)}` },
  ] } };
}

// Known config files: where they are, what they do, and the check the editor runs (file-extras.js).
const CATALOG = [
  { group: 'SSH and access', items: [['/etc/ssh/sshd_config', 'SSH server (use Access & SSH for the usual settings)', 'sshd'], ['/etc/sudoers', 'Who may use sudo (checked with visudo)', 'sudoers'], ['/etc/security/limits.conf', 'Per-user limits', null]] },
  { group: 'Network', items: [['/etc/hosts', 'Names → addresses', null], ['/etc/resolv.conf', 'DNS (often written by another program)', null], ['/etc/netplan', 'Ubuntu network settings (folder)', 'netplan'], ['/etc/network/interfaces', 'Debian network settings (ifupdown)', null], ['/etc/NetworkManager/system-connections', 'NetworkManager connections (folder)', null]] },
  { group: 'System', items: [['/etc/fstab', 'Disks mounted at boot (checked with findmnt)', 'fstab'], ['/etc/sysctl.d', 'Kernel settings (folder)', null], ['/etc/systemd/journald.conf', 'Journal size and retention', null], ['/etc/logrotate.d', 'Log rotation (folder)', null], ['/etc/environment', 'Variables for every login', null], ['/etc/crontab', 'System cron (see the Cron tab)', null]] },
  { group: 'Docker', items: [['/etc/docker/daemon.json', 'Docker daemon (log limits in Services → Docker)', 'json'], ['/etc/systemd/system/docker.service.d', 'Docker service overrides (folder)', null]] },
  { group: 'Web servers', items: [['/etc/nginx/nginx.conf', 'nginx (checked with nginx -t)', 'nginx'], ['/etc/nginx/sites-available', 'nginx sites (folder)', 'nginx'], ['/etc/caddy/Caddyfile', 'Caddy', null], ['/etc/haproxy/haproxy.cfg', 'HAProxy', null]] },
];

module.exports = { swapPlan, fstabVerify, F, READ, SYSCTL_INFO, CATALOG, sections, parseRead, parseHosts, parseFstab, hostnamePlan, hostsPlan, dnsPlan, sysctlPlan, nofilePlan, journaldPlan, networkPlan, fstabPlan };
