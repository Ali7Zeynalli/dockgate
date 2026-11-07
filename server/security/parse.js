// Pure helpers for the server-security features (Access & SSH, Users, Firewall): input validation,
// parsing of the raw command output the security worker returns, and the derived state the UI shows.
// No I/O here — everything is unit-tested in test/unit/security.test.js.
const crypto = require('crypto');
const { isIpOrCidr } = require('../provision/catalog');

// ---------------------------------------------------------------- validation
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const RESERVED_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'docker', 'sudo', 'wheel', 'admin', 'adm', 'syslog', 'polkitd']);

function httpError(status, message, extra) { return Object.assign(new Error(message), { statusCode: status }, extra || {}); }

/** A Linux username that is safe to put in a shell command unquoted. */
function validUsername(name) { return typeof name === 'string' && USERNAME_RE.test(name); }

/** Validate a NEW username (not root / system / group names). Throws 400. */
function assertNewUsername(name) {
  if (!validUsername(name)) throw httpError(400, 'Username: lowercase letters, digits, _ and - (max 32), starting with a letter or _');
  if (RESERVED_USERS.has(name)) throw httpError(400, `"${name}" is a reserved system name — pick another`);
}

const KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']);

/** SHA256 fingerprint of a base64 key blob, in OpenSSH form. */
function keyFingerprint(b64) {
  return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
}

/**
 * Parse ONE OpenSSH public key line ("type base64 [comment]", optionally preceded by options).
 * Returns { type, b64, comment, fingerprint, line } with a normalised, shell-safe line, or null.
 * The blob must decode and start with its own type string — garbage and injection attempts are rejected.
 */
function parsePublicKey(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('\n') || raw.includes('\r')) return null;
  const parts = raw.split(/\s+/);
  const i = parts.findIndex(p => KEY_TYPES.has(p));
  if (i < 0 || !parts[i + 1]) return null;
  const type = parts[i], b64 = parts[i + 1];
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(b64) || b64.length < 60) return null;
  const blob = Buffer.from(b64, 'base64');
  try {
    const len = blob.readUInt32BE(0);
    if (blob.slice(4, 4 + len).toString('ascii') !== type) return null;
  } catch (e) { return null; }
  // Comments are informational — keep a safe subset so the stored line can never break out.
  const comment = parts.slice(i + 2).join(' ').replace(/[^A-Za-z0-9 @._+:-]/g, '').slice(0, 80);
  return { type, b64, comment, fingerprint: keyFingerprint(b64), line: `${type} ${b64}${comment ? ' ' + comment : ''}`, options: i > 0 };
}

/** Throws 400 unless the text is a valid public key. */
function assertPublicKey(text) {
  const k = parsePublicKey(text);
  if (!k) throw httpError(400, 'Paste a valid OpenSSH public key (ssh-ed25519 AAAA… / ssh-rsa AAAA…), one line');
  return k;
}

function validPort(p) { const n = Number(p); return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null; }
function assertPort(p) { const n = validPort(p); if (!n) throw httpError(400, 'Port must be a whole number 1–65535'); return n; }
function assertProto(p) { if (p !== 'tcp' && p !== 'udp') throw httpError(400, 'Protocol must be tcp or udp'); return p; }
/** "any" or an IPv4/IPv6 address / CIDR. Returns the normalised value. */
function assertSource(src) {
  const s = String(src == null ? 'any' : src).trim();
  if (!s || s.toLowerCase() === 'any' || s === 'Anywhere') return 'any';
  if (!isIpOrCidr(s)) throw httpError(400, 'Source must be "any" or an IP address / CIDR, e.g. 198.51.100.24 or 10.0.0.0/24');
  return s;
}

// ---------------------------------------------------------------- sectioned script output
/** Split "@@name\n...lines" output into { name: text }. Section names may carry an argument ("@@keys alice"). */
function sections(out) {
  const res = {};
  let cur = null, buf = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\S+(?: \S+)?)\s*$/.exec(line);
    if (m) { if (cur) res[cur] = buf.join('\n').trim(); cur = m[1]; buf = []; }
    else if (cur) buf.push(line);
  }
  if (cur) res[cur] = buf.join('\n').trim();
  return res;
}

// ---------------------------------------------------------------- sshd
/** Parse `sshd -T` output into a map (lower-case keys; `port` is a list). */
function parseSshdT(out) {
  const r = { port: [] };
  for (const line of String(out || '').split('\n')) {
    const m = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'port') r.port.push(Number(v));
    else if (!(k in r)) r[k] = v;
  }
  return r;
}

const ACCESS_KEYS = { PermitRootLogin: 'rootLogin', PasswordAuthentication: 'passwordAuth', KbdInteractiveAuthentication: 'kbdInteractive', Port: 'port', MaxAuthTries: 'maxAuthTries', ClientAliveInterval: 'clientAliveInterval', ClientAliveCountMax: 'clientAliveCountMax', X11Forwarding: 'x11' };

/** Parse DockGate's own sshd drop-in into settings ({} when absent). */
function parseAccessConf(text) {
  const s = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\w+)\s+(\S+)/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = ACCESS_KEYS[m[1]];
    if (!key) continue;
    const v = m[2];
    if (key === 'port') (s.ports = s.ports || []).push(Number(v));
    else if (key === 'passwordAuth' || key === 'kbdInteractive' || key === 'x11') s[key] = v === 'yes';
    else if (key === 'rootLogin') s.rootLogin = v;
    else s[key] = Number(v);
  }
  return s;
}

const ROOT_LOGIN_VALUES = ['yes', 'prohibit-password', 'no'];

/** Build DockGate's sshd drop-in from settings. Only keys present are written (the rest keep sshd defaults). */
function buildAccessConf(s) {
  const lines = ['# Managed by DockGate (Server Console → Access & SSH). Edit there, not by hand.',
    '# Loaded before the distro/cloud drop-ins, so these values win (sshd uses the first value it reads).'];
  if (s.ports && s.ports.length) for (const p of s.ports) lines.push(`Port ${assertPort(p)}`);
  if (s.rootLogin) { if (!ROOT_LOGIN_VALUES.includes(s.rootLogin)) throw httpError(400, 'Invalid root login value'); lines.push(`PermitRootLogin ${s.rootLogin}`); }
  if (typeof s.passwordAuth === 'boolean') {
    lines.push(`PasswordAuthentication ${s.passwordAuth ? 'yes' : 'no'}`);
    lines.push(`KbdInteractiveAuthentication ${s.passwordAuth ? 'yes' : 'no'}`);
  }
  if (s.maxAuthTries != null) { const n = Number(s.maxAuthTries); if (!Number.isInteger(n) || n < 1 || n > 10) throw httpError(400, 'Max auth tries must be 1–10'); lines.push(`MaxAuthTries ${n}`); }
  if (s.clientAliveInterval != null) { const n = Number(s.clientAliveInterval); if (!Number.isInteger(n) || n < 0 || n > 7200) throw httpError(400, 'Idle timeout out of range'); lines.push(`ClientAliveInterval ${n}`); lines.push(`ClientAliveCountMax ${Number.isInteger(Number(s.clientAliveCountMax)) ? Number(s.clientAliveCountMax) : 2}`); }
  if (typeof s.x11 === 'boolean') lines.push(`X11Forwarding ${s.x11 ? 'yes' : 'no'}`);
  return lines.join('\n') + '\n';
}

/** The Access & SSH view from the read script sections. */
function accessState(sec) {
  const t = parseSshdT(sec.sshdT);
  const dropin = parseAccessConf(sec.dropin);
  const interval = Number(t.clientaliveinterval || 0), count = Number(t.clientalivecountmax || 3);
  return {
    sshPort: t.port[0] || 22,
    ports: t.port.length ? t.port : [22],
    rootLogin: t.permitrootlogin === 'without-password' ? 'prohibit-password' : (t.permitrootlogin || 'prohibit-password'),
    passwordAuth: (t.passwordauthentication || 'yes') === 'yes',
    maxAuthTries: Number(t.maxauthtries || 6),
    idleTimeoutMin: interval > 0 ? Math.round((interval * count) / 60) : 0,
    x11: (t.x11forwarding || 'no') === 'yes',
    dropin,
    includesDropins: /sshd_config\.d/i.test(sec.include || ''),
    readable: !!(sec.sshdT && t.port.length),
    rebootRequired: /yes/.test(sec.reboot || ''),
    isRoot: String(sec.uid || '').trim() === '0',
  };
}

// ---------------------------------------------------------------- users
/** Parse authorized_keys content into keys (index = position among KEY lines, used for deletion). */
function parseAuthorizedKeys(text) {
  const keys = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const k = parsePublicKey(t);
    if (k) keys.push({ type: k.type, fingerprint: k.fingerprint, comment: k.comment, options: k.options, raw: t });
  }
  return keys;
}

/** Remove the key with this fingerprint from authorized_keys content (comments/other lines kept). */
function removeAuthorizedKey(text, fingerprint) {
  let removed = 0;
  const kept = String(text || '').split('\n').filter((line) => {
    const k = parsePublicKey(line.trim());
    if (k && k.fingerprint === fingerprint) { removed++; return false; }
    return true;
  });
  return { content: kept.join('\n').replace(/\n*$/, '\n'), removed };
}

/**
 * Users view from the read script sections. `today` = days since epoch (for account expiry).
 * Human accounts (uid 0 and 1000–59999) only.
 */
function usersState(sec, today = Math.floor(Date.now() / 86400000)) {
  const groups = {};
  for (const line of String(sec.groups || '').split('\n')) {
    const p = line.split(':');
    if (p.length >= 4) groups[p[0]] = new Set(p[3].split(',').filter(Boolean));
  }
  const shadow = {};
  for (const line of String(sec.shadow || '').split('\n')) {
    const p = line.split(':');
    if (p.length >= 3) shadow[p[0]] = { first: p[1], expire: p[2] };
  }
  const sudoersFiles = new Set(String(sec.sudoersd || '').split('\n').map(s => s.trim()).filter(Boolean));
  const t = parseSshdT(sec.sshd);
  const passwordAuth = (t.passwordauthentication || 'yes') === 'yes';
  const rootLogin = t.permitrootlogin === 'without-password' ? 'prohibit-password' : (t.permitrootlogin || 'prohibit-password');
  const lastlog = {};
  for (const line of String(sec.lastlog || '').split('\n')) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (m && !/Never logged in/i.test(m[2])) lastlog[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  const inGroup = (g, u) => !!(groups[g] && groups[g].has(u));
  const users = [];
  for (const line of String(sec.passwd || '').split('\n')) {
    const p = line.split(':');
    if (p.length < 7) continue;
    const [name, , uidS, , , home, shell] = p;
    const uid = Number(uidS);
    if (!(uid === 0 || (uid >= 1000 && uid < 60000))) continue;
    const sh = shadow[name] || {};
    const expired = sh.expire && /^\d+$/.test(sh.expire) && Number(sh.expire) <= today;
    const hasPassword = sh.first === '$';
    const locked = !!expired;
    const keys = parseAuthorizedKeys(sec['keys ' + name]).map(({ raw, ...k }) => k);
    // Service accounts (nologin/false shell, no keys) are not people — keep them out of the list.
    if (uid !== 0 && /(nologin|\/false)$/.test(shell || '') && !keys.length) continue;
    users.push({
      name, uid, home, shell,
      sudo: uid === 0 || inGroup('sudo', name) || inGroup('wheel', name) || inGroup('admin', name) || sudoersFiles.has('90-dockgate-' + name),
      docker: uid === 0 || inGroup('docker', name),
      keys, hasPassword, locked,
      passwordLogin: hasPassword && !locked && passwordAuth && (uid !== 0 || rootLogin === 'yes'),
      lastLogin: lastlog[name] || null,
      dockgateSudoers: sudoersFiles.has('90-dockgate-' + name),
    });
  }
  return { users, passwordAuth, rootLogin };
}

// ---------------------------------------------------------------- firewall
/** Parse `ufw status numbered`. Rules carry n, to, action (ALLOW/DENY/REJECT/LIMIT), dir (IN/OUT/FWD), from, v6. */
function parseUfwNumbered(out) {
  const text = String(out || '');
  const active = /Status:\s*active/i.test(text);
  const rules = [];
  for (const line of text.split('\n')) {
    const m = /^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(.+?)\s*(?:#\s*(.*))?$/.exec(line.trim());
    if (!m) continue;
    const to = m[2].trim(), from = m[5].trim();
    rules.push({ n: Number(m[1]), to: to.replace(/\s*\(v6\)$/, ''), action: m[3], dir: m[4] || 'IN', from: from.replace(/\s*\(v6\)$/, ''), v6: /\(v6\)/.test(to) || /\(v6\)/.test(from), note: (m[6] || '').trim() });
  }
  return { active, rules };
}

/** "8080" / "8080/tcp" / "Anywhere" → { port, proto } (proto null = both). Non-port targets → null. */
function ruleTarget(to) {
  const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(String(to).trim());
  return m ? { port: Number(m[1]), proto: m[2] || null } : null;
}

/** Listening sockets from `ss -H -tulpn` (or `netstat -tulpn` on hosts without iproute2). */
function parseSs(out) {
  const res = [];
  const seen = new Set();
  for (const line of String(out || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const proto = f[0].startsWith('tcp') ? 'tcp' : (f[0].startsWith('udp') ? 'udp' : null);
    if (!proto) continue;
    const netstat = /^\d+$/.test(f[1]); // netstat: proto recv-q send-q local foreign [state] pid/prog
    if (netstat && proto === 'tcp' && f[5] !== 'LISTEN') continue;
    const local = netstat ? f[3] : f[4];
    const i = local.lastIndexOf(':');
    if (i < 0) continue;
    const port = Number(local.slice(i + 1));
    let bind = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (bind === '*') bind = '0.0.0.0';
    if (!port) continue;
    const proc = netstat ? ((/\d+\/(\S+)/.exec(f[f.length - 1]) || [])[1] || null) : ((/\(\("([^"]+)"/.exec(line) || [])[1] || null);
    const key = `${proto}|${port}|${bind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    res.push({ proto, port, bind, process: proc });
  }
  return res;
}

/** Published ports from `docker ps --format '{{.Names}}|{{.Ports}}'`. */
function parseDockerPorts(out) {
  const res = [];
  for (const line of String(out || '').split('\n')) {
    const [name, ports] = line.split('|');
    if (!name || !ports) continue;
    for (const part of ports.split(',')) {
      const m = /^\s*(?:\[?([0-9a-fA-F:.]*)\]?:)?(\d+)(?:-\d+)?->(\d+)(?:-\d+)?\/(tcp|udp)/.exec(part);
      if (!m) continue;
      res.push({ container: name.trim(), hostIp: m[1] || '0.0.0.0', hostPort: Number(m[2]), containerPort: Number(m[3]), proto: m[4] });
    }
  }
  return res;
}

const isLoopback = (bind) => /^127\./.test(bind) || bind === '::1' || bind === 'localhost';

/** Does a rule set (non-v6 side wins) allow this port/proto? Returns { allowed, from } or null. */
function findAllow(rules, port, proto, dir) {
  for (const r of rules) {
    if (r.action !== 'ALLOW' && r.action !== 'LIMIT') continue;
    if (dir === 'FWD' ? r.dir !== 'FWD' : r.dir === 'FWD') continue;
    const t = ruleTarget(r.to);
    if (!t || t.port !== port || (t.proto && t.proto !== proto)) continue;
    return { from: r.from === 'Anywhere' ? 'any' : r.from };
  }
  return null;
}

/**
 * The "Listening ports" table: every listener with who uses it and where it is reachable from.
 * exposure: local (loopback) · bypass (container port while Docker isolation is off) · public · restricted · internal
 */
function computePorts({ listeners, dockerPorts, ufw, isolation, sshPort }) {
  const rows = [];
  const byHostPort = new Map(dockerPorts.map(d => [`${d.proto}|${d.hostPort}`, d]));
  const seen = new Set();
  const add = (row) => { const k = `${row.proto}|${row.port}`; if (seen.has(k)) return; seen.add(k); rows.push(row); };
  for (const d of dockerPorts) {
    if (isLoopback(d.hostIp)) { add({ port: d.hostPort, proto: d.proto, bind: d.hostIp, usedBy: d.container, kind: 'container', container: d.container, containerPort: d.containerPort, exposure: 'local' }); continue; }
    let exposure, restrictedTo = null;
    if (!ufw.active) exposure = 'public';
    else if (!isolation) exposure = 'bypass';
    else {
      const a = findAllow(ufw.rules, d.containerPort, d.proto, 'FWD');
      exposure = a ? (a.from === 'any' ? 'public' : 'restricted') : 'internal';
      if (a && a.from !== 'any') restrictedTo = a.from;
    }
    add({ port: d.hostPort, proto: d.proto, bind: d.hostIp, usedBy: d.container, kind: 'container', container: d.container, containerPort: d.containerPort, exposure, restrictedTo });
  }
  for (const l of listeners) {
    if (byHostPort.has(`${l.proto}|${l.port}`)) continue;
    if (l.process === 'docker-proxy') continue; // its container row is already there
    let exposure, restrictedTo = null;
    if (isLoopback(l.bind)) exposure = 'local';
    else if (!ufw.active) exposure = 'public';
    else {
      const a = findAllow(ufw.rules, l.port, l.proto, 'IN');
      exposure = a ? (a.from === 'any' ? 'public' : 'restricted') : 'internal';
      if (a && a.from !== 'any') restrictedTo = a.from;
    }
    add({ port: l.port, proto: l.proto, bind: l.bind, usedBy: l.process || 'unknown', kind: 'host', isSsh: l.port === sshPort && l.proto === 'tcp', exposure, restrictedTo });
  }
  return rows.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

/** Rule numbers (descending — numbers shift on delete) that allow port/proto [from src] for dir. */
function ruleNumbersFor(rules, { port, proto, dir, from }) {
  return rules.filter((r) => {
    if (r.action !== 'ALLOW' && r.action !== 'LIMIT') return false;
    if (dir === 'FWD' ? r.dir !== 'FWD' : r.dir === 'FWD') return false;
    const t = ruleTarget(r.to);
    if (!t || t.port !== port || (t.proto && t.proto !== proto)) return false;
    if (from && from !== 'any' && r.from !== from) return false;
    return true;
  }).map(r => r.n).sort((a, b) => b - a);
}

module.exports = {
  httpError, validUsername, assertNewUsername, parsePublicKey, assertPublicKey, keyFingerprint,
  validPort, assertPort, assertProto, assertSource,
  sections, parseSshdT, parseAccessConf, buildAccessConf, accessState, ROOT_LOGIN_VALUES,
  parseAuthorizedKeys, removeAuthorizedKey, usersState,
  parseUfwNumbered, ruleTarget, parseSs, parseDockerPorts, computePorts, ruleNumbersFor, isLoopback,
};
