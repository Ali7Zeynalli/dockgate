// SSH honeypot on an SSH server (Server Console > Security > Honeypot).
// Once the real SSH listens elsewhere, nobody with a reason to be there connects to port 22. A small container
// (honeypot/) answers there like OpenSSH, writes down who connects and which user names and passwords they try, and
// refuses every login. fail2ban on the server reads its log and bans each address that connects, on every port -
// the host's ports and the ports Docker publishes (DOCKER-USER chain) - with an ipset when one is available.
// Turning it on is one job: checks -> image (built on the server from honeypot/ and the ssh2 library DockGate
// already ships; nothing is pulled but node:22-alpine) -> container -> fail2ban jail -> test. A failure removes it again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const HP_DIR = path.join(__dirname, '..', 'honeypot');
const NAME = 'dockgate-honeypot';
const UID = 10001;
const LOG_DIR = '/var/log/dockgate-honeypot';
const LOG_FILE = `${LOG_DIR}/honeypot.log`;
const DATA_DIR = '/var/lib/dockgate-honeypot';
const FILTER = '/etc/fail2ban/filter.d/dockgate-honeypot.conf';
const JAIL = '/etc/fail2ban/jail.d/dockgate-honeypot.conf';
const LOGROTATE = '/etc/logrotate.d/dockgate-honeypot';
const BANTIMES = { '1d': 'one day', '7d': 'a week', '30d': '30 days' };
// node_modules the honeypot needs: ssh2 and its pure-JavaScript dependencies (its optional native parts are left out)
const MODULES = ['ssh2', 'asn1', 'bcrypt-pbkdf', 'tweetnacl', 'safer-buffer'];
const SKIP = /[\\/]ssh2[\\/]lib[\\/]protocol[\\/]crypto[\\/](build|src|binding\.gyp)|[\\/]ssh2[\\/](install\.js|test|examples)|\.md$/i;

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const writeFile = (p, content, mode = '0644') => `echo ${b64(content)} | base64 -d | {{S}}tee ${p} >/dev/null && {{S}}chmod ${mode} ${p}`;
const moduleDir = (m) => path.dirname(require.resolve(`${m}/package.json`));

/** Files of the build context: [relative path in the context, absolute source]. */
function contextFiles() {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const a = path.join(abs, e.name), r = path.posix.join(rel, e.name);
      if (SKIP.test(a)) continue;
      if (e.isDirectory()) walk(a, r); else if (e.isFile()) out.push([r, a]);
    }
  };
  for (const f of ['Dockerfile', 'package.json']) out.push([f, path.join(HP_DIR, f)]);
  walk(path.join(HP_DIR, 'src'), 'src');
  for (const m of MODULES) walk(moduleDir(m), `node_modules/${m}`);
  return out;
}
/** The image tag: the honeypot's version and a hash of everything in its build context. */
function imageTag(files = contextFiles()) {
  const h = crypto.createHash('sha256');
  for (const [r, a] of files) { h.update(r + '\0'); h.update(fs.readFileSync(a)); h.update('\0'); }
  const v = JSON.parse(fs.readFileSync(path.join(HP_DIR, 'package.json'), 'utf8')).version;
  return `${NAME}:${v}-${h.digest('hex').slice(0, 10)}`;
}
/** The build context as a gzipped tar (what `docker build -` reads). */
async function contextTarGz(files = contextFiles()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-hp-'));
  try {
    for (const [r, a] of files) { const d = path.join(tmp, r); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(a, d); }
    const pack = require('tar-fs').pack(tmp, { map: (h) => { h.uid = 0; h.gid = 0; h.uname = ''; h.gname = ''; h.mtime = new Date(0); return h; } });
    const chunks = [];
    await new Promise((res, rej) => pack.pipe(zlib.createGzip({ level: 9 })).on('data', c => chunks.push(c)).on('end', res).on('error', rej));
    return Buffer.concat(chunks);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- what is on the server (one round trip)
const READ = [
  'echo @@uid; id -u',
  "echo @@sshdPort; {{S}}sshd -T 2>/dev/null | awk '/^port /{print $2}'",
  "echo @@listen22; (ss -Htlnp 'sport = :22' 2>/dev/null || {{S}}ss -Htln 'sport = :22' 2>/dev/null) | head -5",
  'echo @@docker; command -v docker >/dev/null 2>&1 && {{S}}docker version --format "{{.Server.Version}}" 2>/dev/null',
  `echo @@container; {{S}}docker inspect -f '{{.State.Status}}|{{.Config.Image}}|{{.State.StartedAt}}|{{range .Config.Env}}{{println .}}{{end}}' ${NAME} 2>/dev/null`,
  'echo @@f2b; command -v fail2ban-client >/dev/null 2>&1 && echo installed; {{S}}fail2ban-client ping >/dev/null 2>&1 && echo active; true',
  `echo @@jail; {{S}}fail2ban-client status ${NAME} 2>/dev/null`,
  `echo @@jailFile; {{S}}cat ${JAIL} 2>/dev/null`,
  "echo @@ipset; {{S}}sh -c 'command -v ipset' >/dev/null 2>&1 && echo yes; true",
  `echo @@logSize; {{S}}stat -c %s ${LOG_FILE} 2>/dev/null`,
  `echo @@log; {{S}}tail -n 5000 ${LOG_FILE} 2>/dev/null`,
].join('; ');

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

/** honeypot.log lines -> events (newest last). Anything that is not one of its lines is skipped. */
function parseLog(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (connect|ident|auth|close) (\S+) (\{.*\})$/.exec(l);
    if (!m) continue;
    let d = {}; try { d = JSON.parse(m[4]); } catch (e) { continue; }
    out.push({ ts: Date.parse(m[1]), ev: m[2], ip: m[3], ...d });
  }
  return out;
}
const top = (arr, n = 10) => Object.entries(arr.reduce((a, k) => { if (k) a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));

function stats(events, now = Date.now()) {
  const connects = events.filter(e => e.ev === 'connect'), auths = events.filter(e => e.ev === 'auth');
  const day = now - 86400000;
  return {
    events: events.length, since: events.length ? events[0].ts : null,
    connects: connects.length, connects24h: connects.filter(e => e.ts >= day).length,
    ips: new Set(connects.map(e => e.ip)).size, ips24h: new Set(connects.filter(e => e.ts >= day).map(e => e.ip)).size,
    logins: auths.length,
    topUsers: top(auths.map(e => e.user)), topPasswords: top(auths.filter(e => e.method === 'password').map(e => e.password)),
    topIps: top(connects.map(e => e.ip)), topClients: top(events.filter(e => e.ev === 'ident').map(e => e.client)),
    // newest first: login attempts, and connections that never tried one
    recent: events.filter(e => e.ev === 'auth' || e.ev === 'ident').slice(-200).reverse(),
  };
}

/** The page's data from the read script. `serverPort` is the port DockGate connects on. */
function parseStatus(out, { serverPort = 22 } = {}) {
  const S = sections(out);
  const [state, image, startedAt, ...env] = String(S.container || '').split('|');
  const envKv = Object.fromEntries(env.join('|').split('\n').map(l => l.split('=')).filter(p => p[0]).map(([k, ...v]) => [k, v.join('=')]));
  const jail = S.jail || '';
  const banned = ((/Banned IP list:\s*(.*)$/m.exec(jail) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
  const f2b = String(S.f2b || '');
  const sshdPorts = String(S.sshdPort || '').split('\n').map(Number).filter(Boolean);
  const listen = String(S.listen22 || '').trim();
  const running = state === 'running';
  const events = parseLog(S.log);
  const jailText = S.jailFile || '';
  const checks = [
    { id: 'ssh-moved', ok: sshdPorts.length ? !sshdPorts.includes(22) : null, label: 'Real SSH is not on port 22', fix: 'Change the SSH port first: Security > Access & SSH', value: sshdPorts.length ? `sshd listens on ${sshdPorts.join(', ')}` : 'could not read sshd\'s port (needs sudo)' },
    { id: 'dockgate-port', ok: Number(serverPort) !== 22, label: 'DockGate connects on the new port', fix: 'DockGate still connects on 22 - change the SSH port in Access & SSH (DockGate follows it)', value: `port ${serverPort}` },
    { id: 'port-free', ok: !listen || /docker-proxy/.test(listen) || running, label: 'Port 22 is free', fix: 'Something else listens on port 22 - stop it first', value: listen ? listen.split('\n')[0].replace(/\s+/g, ' ').slice(0, 120) : 'free' },
    { id: 'docker', ok: !!String(S.docker || '').trim(), label: 'Docker is installed', fix: 'Install Docker: Server Console > Setup', value: String(S.docker || '').trim() || 'not found' },
    { id: 'fail2ban', ok: /installed/.test(f2b) && /^active$/m.test(f2b), label: 'fail2ban is running', fix: 'Install fail2ban: Server Console > Setup > Fail2ban', value: /installed/.test(f2b) ? (/^active$/m.test(f2b) ? 'running' : 'installed, not running') : 'not installed' },
  ];
  return {
    on: running && !!jailText, running, state: state || null, image: image || null, startedAt: startedAt && !/^0001/.test(startedAt) ? Date.parse(startedAt) : null,
    jailActive: /Status for the jail/.test(jail), jailFile: !!jailText,
    bantime: (/^bantime\s*=\s*(\S+)/m.exec(jailText) || [])[1] || null,
    allow: String(envKv.HP_ALLOW || '').split(/[\s,]+/).filter(Boolean),
    bannedNow: Number((/Currently banned:\s*(\d+)/.exec(jail) || [])[1] || 0), bannedTotal: Number((/Total banned:\s*(\d+)/.exec(jail) || [])[1] || 0), banned: banned.slice(0, 500),
    ipset: /yes/.test(S.ipset || ''), logBytes: Number(S.logSize) || 0,
    sshPorts: sshdPorts, checks, ready: checks.every(c => c.ok !== false),
    stats: stats(events),
  };
}

// ---------------------------------------------------------------- turning it on / off
function checkAllow(list) {
  const net = require('net');
  const out = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean)) {
    const [ip, bits] = raw.split('/');
    const v = net.isIP(ip);
    if (!v || (bits != null && !(/^\d+$/.test(bits) && Number(bits) <= (v === 4 ? 32 : 128)))) throw bad(`Allowed address "${raw}": an IP address or a network such as 203.0.113.0/24`);
    out.push(raw);
  }
  if (out.length > 50) throw bad('At most 50 allowed addresses');
  return out;
}

const FILTER_TEXT = `# Managed by DockGate (Server Console > Security > Honeypot)
# ${LOG_FILE}: 2026-01-01T10:00:00Z connect 203.0.113.9 {"client":"SSH-2.0-Go"}
[Definition]
datepattern = ^%%Y-%%m-%%dT%%H:%%M:%%SZ
failregex = ^\\s*connect <HOST> \\{
ignoreregex =
`;
const LOGROTATE_TEXT = `# Managed by DockGate (Server Console > Security > Honeypot)
${LOG_FILE} {
  weekly
  rotate 4
  maxsize 5M
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
`;

/** Shell that writes the jail with the right actions for this server (ipset or not, firewalld or not, Docker chain). */
function jailCmd(bantime) {
  const head = `# Managed by DockGate (Server Console > Security > Honeypot)\n# Any address that connects to the honeypot on port 22 is banned on every port.\n[${NAME}]\nenabled = true\nbackend = auto\nfilter = ${NAME}\nlogpath = ${LOG_FILE}\nlogtimezone = UTC\nmaxretry = 1\nfindtime = 1d\nbantime = ${bantime}\n`;
  return [
    "if {{S}}sh -c 'command -v ipset' >/dev/null 2>&1; then A=iptables-ipset-proto6-allports; else A=iptables-allports; fi",
    `if {{S}}firewall-cmd --state >/dev/null 2>&1; then H="firewallcmd-ipset[name=${NAME}, actiontype=<allports>]"; else H="$A[name=${NAME}]"; fi`,
    `D=''; if {{S}}iptables -n -L DOCKER-USER >/dev/null 2>&1; then D="         $A[name=hp-docker, chain=DOCKER-USER]"; fi`,
    `{ echo ${b64(head)} | base64 -d; printf 'action = %s\\n' "$H"; [ -n "$D" ] && printf '%s\\n' "$D"; true; } | {{S}}tee ${JAIL} >/dev/null && {{S}}chmod 0644 ${JAIL}`,
    `echo "bans with: $H\${D:+ + Docker ports (DOCKER-USER)}"`,
  ].join('; ');
}

// Docker port isolation (Firewall tab, UFW) closes every published container port that has no `ufw route allow`
// rule. The honeypot opens its own port there (marked with a comment so only DockGate's rule is removed later).
const ISOLATED = `{{S}}ufw status 2>/dev/null | grep -q 'Status: active' && {{S}}grep -q 'BEGIN DOCKGATE-DOCKER' /etc/ufw/after.rules 2>/dev/null`;
const ROUTE_OPEN = `if ${ISOLATED}; then if {{S}}ufw status | grep -q '${NAME}'; then echo "port already open behind Docker port isolation"; else {{S}}ufw route allow proto tcp from any to any port 2222 comment '${NAME}' >/dev/null && echo "opened behind Docker port isolation"; fi; else echo "Docker port isolation is off - nothing to open"; fi`;
const ROUTE_CLOSE = `if command -v ufw >/dev/null 2>&1 && {{S}}ufw status 2>/dev/null | grep -q '${NAME}'; then {{S}}ufw route delete allow proto tcp from any to any port 2222 >/dev/null 2>&1; fi`;

/** Shell that removes everything the honeypot added (bans already made stay until they expire). */
function removeCmd({ keepLog = true } = {}) {
  return [
    `{{S}}docker rm -f ${NAME} >/dev/null 2>&1`,
    ROUTE_CLOSE,
    `for i in $({{S}}docker images -q --filter label=dockgate.role=honeypot-image 2>/dev/null | sort -u); do {{S}}docker rmi -f $i >/dev/null 2>&1; done`,
    `{{S}}rm -f ${JAIL} ${FILTER} ${LOGROTATE}`,
    `if command -v fail2ban-client >/dev/null 2>&1 && {{S}}fail2ban-client ping >/dev/null 2>&1; then {{S}}fail2ban-client reload >/dev/null 2>&1; fi`,
    keepLog ? '' : `{{S}}rm -rf ${LOG_DIR} ${DATA_DIR}`,
    'true',
  ].filter(Boolean).join('; ');
}

const CHUNK = 96 * 1024; // base64 characters per step command

/**
 * The job that turns the honeypot on (or applies new settings: the same steps, the image is kept when it is current).
 * opts: { tag, tarGz (Buffer), bantime, allow[] }
 */
function installPlan({ tag, tarGz, bantime = '30d', allow = [] }) {
  if (!BANTIMES[bantime]) throw bad('Ban time: 1d, 7d or 30d');
  const allowList = checkAllow(allow);
  const id = crypto.randomBytes(4).toString('hex');
  const tmp = `/tmp/dockgate-honeypot-${id}.b64`;
  const data = tarGz.toString('base64');
  const chunks = []; for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  const have = `{{S}}docker image inspect ${tag} >/dev/null 2>&1`;
  const steps = [
    { label: 'Checks: SSH is not on 22, port 22 is free, Docker and fail2ban are there', cmd: [
      `P=$({{S}}sshd -T 2>/dev/null | awk '/^port /{print $2}'); if echo "$P" | grep -qx 22; then echo "The real SSH still listens on port 22 - change its port first (Access & SSH)"; exit 1; fi`,
      `L=$( (ss -Htlnp 'sport = :22' 2>/dev/null || {{S}}ss -Htln 'sport = :22' 2>/dev/null) | grep -v docker-proxy); if [ -n "$L" ] && ! {{S}}docker inspect ${NAME} >/dev/null 2>&1; then echo "Port 22 is in use: $L"; exit 1; fi`,
      `{{S}}docker version >/dev/null 2>&1 || { echo "Docker is not installed or not running"; exit 1; }`,
      `{{S}}fail2ban-client ping >/dev/null 2>&1 || { echo "fail2ban is not running - install it in Setup > Fail2ban"; exit 1; }`,
      'echo ok',
    ].join('; ') },
    { label: `Folders: ${LOG_DIR} (its log), ${DATA_DIR} (its host key)`, cmd: `{{S}}mkdir -p ${LOG_DIR} ${DATA_DIR} && {{S}}chown ${UID}:${UID} ${LOG_DIR} ${DATA_DIR} && {{S}}chmod 0750 ${LOG_DIR} ${DATA_DIR}` },
    ...chunks.map((c, i) => ({ label: chunks.length > 1 ? `Send the honeypot's source (${i + 1}/${chunks.length})` : `Send the honeypot's source (${Math.round(tarGz.length / 1024)} KB)`,
      cmd: `if ${have}; then echo "image ${tag} is already here"; exit 0; fi; printf '%s' '${c}' >> ${tmp}` })),
    { label: `Build the image ${tag} (node:22-alpine + the honeypot)`, cmd: `if ${have}; then rm -f ${tmp}; echo "already built"; exit 0; fi; out=$(base64 -d ${tmp} | {{S}}docker build -q -t ${tag} - 2>&1); rc=$?; rm -f ${tmp}; [ $rc -eq 0 ] || { echo "$out" | tail -20; exit 1; }; echo "built $out"` },
    { label: 'Start the honeypot on port 22 (read-only, no capabilities, 96 MB, 0.25 CPU)', rollbackOnFail: true, cmd: [
      `{{S}}docker rm -f ${NAME} >/dev/null 2>&1`,
      `{{S}}docker run -d --name ${NAME} --restart unless-stopped -p 22:2222 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 96m --cpus 0.25 --pids-limit 64 --log-opt max-size=5m --log-opt max-file=2 --label dockgate.role=honeypot -e HP_ALLOW=${allowList.length ? `'${allowList.join(',')}'` : "''"} -v ${LOG_DIR}:/log -v ${DATA_DIR}:/data ${tag} >/dev/null || exit 1`,
      'sleep 3',
      `[ "$({{S}}docker inspect -f '{{.State.Status}}' ${NAME})" = running ] || { {{S}}docker logs --tail 20 ${NAME} 2>&1; exit 1; }`,
      `for i in $({{S}}docker images -q --filter label=dockgate.role=honeypot-image 2>/dev/null | sort -u); do [ "$i" = "$({{S}}docker image inspect -f '{{.Id}}' ${tag} | cut -c8-19)" ] || {{S}}docker rmi $i >/dev/null 2>&1; done; true`,
      'echo running',
    ].join('; ') },
    { label: 'Docker port isolation: keep port 22 reachable (UFW only, when isolation is on)', cmd: ROUTE_OPEN },
    { label: 'ipset (fast bans when the list grows)', cmd: 'HAS="{{S}}sh -c \'command -v ipset\'"; if eval "$HAS" >/dev/null 2>&1; then echo "already installed"; exit 0; fi; if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive {{S}}apt-get install -y -qq ipset >/dev/null 2>&1; elif command -v dnf >/dev/null 2>&1; then {{S}}dnf -y -q install ipset >/dev/null 2>&1; elif command -v apk >/dev/null 2>&1; then {{S}}apk add -q ipset >/dev/null 2>&1; fi; eval "$HAS" >/dev/null 2>&1 && echo installed || echo "not available - plain iptables rules are used"; true' },
    { label: `fail2ban: the ${NAME} jail (1 connection = banned for ${BANTIMES[bantime]}, every port)`, rollbackOnFail: true, cmd: [
      writeFile(FILTER, FILTER_TEXT),
      jailCmd(bantime),
      writeFile(LOGROTATE, LOGROTATE_TEXT),
      `{{S}}touch ${LOG_FILE} && {{S}}chown ${UID}:${UID} ${LOG_FILE}`,
      `out=$({{S}}fail2ban-client reload 2>&1) || { J=$(echo "$out" | grep -o "Jail '[^']*'" | head -1); echo "fail2ban did not reload\${J:+ - $J is broken (it is not the honeypot jail): fix or turn it off in the Fail2ban tab, then try again}: $(echo "$out" | grep -v WARNING | tail -3)"; exit 1; }`,
      `for i in 1 2 3 4 5; do {{S}}fail2ban-client status ${NAME} >/dev/null 2>&1 && break; sleep 1; done`,
      `{{S}}fail2ban-client status ${NAME} >/dev/null 2>&1 || { echo "the jail did not start: $({{S}}tail -n 5 /var/log/fail2ban.log 2>/dev/null)"; exit 1; }`,
    ].join('; ') },
    { label: 'Test: port 22 answers like an SSH server (from the server itself - not logged, not banned)', rollbackOnFail: true, cmd: [
      "if command -v bash >/dev/null 2>&1; then B=$(timeout 6 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22; head -c 8 <&3' 2>/dev/null);",
      "elif command -v nc >/dev/null 2>&1; then B=$(timeout 6 nc 127.0.0.1 22 </dev/null 2>/dev/null | head -c 8); else echo 'no bash or nc to test with - skipped'; exit 0; fi",
      'case "$B" in SSH-2.0*) echo "port 22 answers: $B";; *) echo "port 22 did not answer like SSH (got: $B)"; exit 1;; esac',
    ].join('\n') },
  ];
  return { steps, rollback: removeCmd({ keepLog: true }) };
}

function removePlan({ keepLog = true } = {}) {
  return { steps: [{ label: `Stop and remove the honeypot${keepLog ? ' (its log is kept)' : ' and its log'}; remove its fail2ban jail`, cmd: removeCmd({ keepLog }) }] };
}

module.exports = { NAME, LOG_FILE, JAIL, FILTER, BANTIMES, READ, FILTER_TEXT, contextFiles, imageTag, contextTarGz, parseLog, stats, parseStatus, checkAllow, installPlan, removePlan, jailCmd, removeCmd };
