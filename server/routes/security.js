// Server security routes — Server Console → Overview (security status), Access & SSH, Users, Firewall,
// the deploy-user wizard and reboot. Mounted under /api/servers (behind requireAuth).
//
// Every safety rule is enforced HERE, not only in the UI: DockGate never locks itself out (it keeps
// the user/key it connects with), the last sudo user keeps sudo, the SSH port stays open, and sshd /
// firewall changes run as lifeline jobs that test a NEW login and roll back on failure.
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const { stmts } = require('../db');
const { logAction } = require('../audit');
const { decrypt } = require('../auth/secrets');
const { verifyPassword } = require('../auth/password');
const P = require('../security/parse');
const plans = require('../security/plans');
const runner = require('../security/runner');
const hostkey = require('../ssh-hostkey');

const paths = require('../paths');
paths.ensureKeysDir();

// ---------------------------------------------------------------- helpers
const absKey = (p) => paths.keyPath(p);

function loadServer(req) {
  const row = stmts.getServer.get(req.params.id);
  if (!row) throw P.httpError(404, 'Server not found');
  if (row.id === 'local' || row.type === 'local') throw P.httpError(400, 'These settings apply to remote SSH servers');
  return row;
}
function cfgOf(row) {
  return { ...row, keyPath: absKey(row.key_path), password: decrypt(row.password), passphrase: decrypt(row.passphrase) };
}
function requireConfirm(body) {
  if (!body || body.confirm !== true) throw P.httpError(409, 'Confirmation required', { risks: [] });
}
const send = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) {
    const status = err.statusCode || (hostkey.isHostKeyError(err) ? 502 : 500);
    const message = hostkey.isHostKeyError(err) ? hostkey.MISMATCH_MESSAGE : err.message;
    res.status(status).json({ error: message, ...(err.risks ? { risks: err.risks } : {}) });
  }
};
const audit = (req, row, action, details) => logAction({ req, server: row.id, resourceType: 'server', resourceId: row.id, resourceName: row.name || row.id, action, details });
const newId = () => crypto.randomBytes(5).toString('hex');
const safeForLockdown = (row) => !!row.key_path && row.username !== 'root';

const { refreshConnections, generateKey, removeKeyFile, startDeployUser } = require('../security/service');

async function readState(row, script) { return P.sections(await runner.read(cfgOf(row), script)); }

function hostKeyInfo(row) {
  if (!row.host_key) return { pinned: false };
  const type = row.host_key_blob ? hostkey.keyTypeLabel(hostkey.keyType(Buffer.from(row.host_key_blob, 'base64'))) : '';
  return { pinned: true, type, fingerprint: row.host_key, pinnedAt: row.host_key_at };
}

// ---------------------------------------------------------------- jobs
router.get('/:id/jobs/:jobId', send((req) => {
  const row = loadServer(req);
  const job = runner.getJob(req.params.jobId);
  if (!job || job.serverId !== row.id) throw P.httpError(404, 'Job not found (it may have expired)');
  return job;
}));

// ---------------------------------------------------------------- posture (Overview)
router.get('/:id/security/posture', send(async (req) => {
  const row = loadServer(req);
  // fail2ban is read in parallel (its own worker) — a failure there must not hide the rest.
  const [sec, f2b] = await Promise.all([readState(row, plans.READ_POSTURE), fail2banOf(row).catch(() => null)]);
  const a = P.accessState(sec);
  const ufw = P.parseUfwNumbered(sec.ufw);
  const firewalld = /running/.test(sec.firewalld || '');
  const isolation = Number(sec.iso || 0) > 0;
  const published = P.parseDockerPorts(sec.docker).filter(d => !P.isLoopback(d.hostIp));
  const checks = [];
  const dep = safeForLockdown(row);
  checks.push({ id: 'deploy-user', label: 'Deploy user', level: dep ? 'ok' : 'warn', value: dep ? `${row.username} · SSH key` : `DockGate connects as ${row.username} with ${row.key_path ? 'a key' : 'a password'}`, action: dep ? null : 'deploy-wizard' });
  checks.push({ id: 'password-auth', label: 'Password login', level: a.passwordAuth ? 'warn' : 'ok', value: a.passwordAuth ? 'Enabled — brute-force target' : 'Disabled · keys only', action: a.passwordAuth ? 'access' : null });
  checks.push({ id: 'root-login', label: 'Root SSH login', level: a.rootLogin === 'yes' ? 'crit' : (a.rootLogin === 'no' ? 'ok' : 'warn'), value: { yes: 'Allowed with password', 'prohibit-password': 'Key only', no: 'Blocked' }[a.rootLogin] || a.rootLogin, action: a.rootLogin === 'no' ? null : 'access' });
  checks.push({ id: 'firewall', label: 'Firewall', level: ufw.active || firewalld ? 'ok' : 'crit', value: ufw.active ? 'UFW active' : (firewalld ? 'firewalld active' : 'Inactive — every port is open'), action: ufw.active || firewalld ? null : 'firewall' });
  let dp;
  if (!published.length) dp = { level: 'ok', value: 'No published container ports' };
  else if (ufw.active && isolation) dp = { level: 'ok', value: 'Isolated · only ports you open are public' };
  else if (ufw.active) dp = { level: 'crit', value: `${published.length} container port(s) bypass UFW and are public`, action: 'firewall' };
  else if (firewalld) dp = { level: 'warn', value: `${published.length} published port(s) — isolation is available with UFW only` };
  else dp = { level: 'crit', value: `${published.length} published container port(s) are public`, action: 'firewall' };
  checks.push({ id: 'docker-ports', label: 'Docker ports', action: null, ...dp });
  const hk = hostKeyInfo(row);
  checks.push({ id: 'host-key', label: 'Host key', level: hk.pinned ? 'ok' : 'warn', value: hk.pinned ? `${hk.type} pinned` : 'Not pinned yet', action: null });
  checks.push(fail2banCheck(f2b));
  return { checks, rebootRequired: a.rebootRequired };
}));

/** The Overview's fail2ban line: not installed / stopped / has problems / running. */
function fail2banCheck(f) {
  const base = { id: 'fail2ban', label: 'Fail2ban' };
  if (!f) return { ...base, level: 'warn', value: 'State unavailable', action: 'fail2ban' };
  if (!f.installed) return { ...base, level: 'warn', value: 'Not installed — nothing bans brute-force IPs', action: 'setup' };
  if (!f.active) return { ...base, level: 'crit', value: 'Installed but not running', action: 'fail2ban' };
  const crit = f.problems.filter(p => p.level === 'crit').length, warn = f.problems.filter(p => p.level === 'warn').length;
  const banned = f.jails.reduce((n, j) => n + j.currentlyBanned, 0);
  if (crit) return { ...base, level: 'crit', value: `${crit} setting${crit > 1 ? 's' : ''} cannot work as configured`, action: 'fail2ban' };
  if (warn) return { ...base, level: 'warn', value: `Running · ${warn} thing${warn > 1 ? 's' : ''} to review`, action: 'fail2ban' };
  return { ...base, level: 'ok', value: `Running · ${banned} IP${banned === 1 ? '' : 's'} banned now`, action: null };
}

// ---------------------------------------------------------------- Access & SSH
router.get('/:id/access', send(async (req) => {
  const row = loadServer(req);
  const sec = await readState(row, `${plans.READ_ACCESS}; ${plans.READ_USERS}`);
  const a = P.accessState(sec);
  const u = P.usersState(sec);
  return {
    ...a,
    hostKey: hostKeyInfo(row),
    connection: { user: row.username, auth: row.key_path ? 'key' : 'password', host: row.host, port: row.port || 22 },
    keyHolders: u.users.filter(x => x.keys.length && !x.locked).map(x => x.name),
    safeForLockdown: safeForLockdown(row),
  };
}));

router.post('/:id/access', send(async (req) => {
  const row = loadServer(req);
  const { setting, value } = req.body || {};
  requireConfirm(req.body);
  const sec = await readState(row, plans.READ_ACCESS);
  const state = P.accessState(sec);
  if (!state.readable) throw P.httpError(502, 'Could not read the sshd configuration (sshd -T) — DockGate needs root or passwordless sudo on this server');
  if (!state.includesDropins) throw P.httpError(400, "/etc/ssh/sshd_config does not include sshd_config.d/*.conf — add 'Include /etc/ssh/sshd_config.d/*.conf' at the top, then retry");
  const next = { ...state.dropin };
  let title, successText, portChange = null, testPort = row.port || 22;

  if (setting === 'rootLogin') {
    if (!P.ROOT_LOGIN_VALUES.includes(value)) throw P.httpError(400, 'Root login must be yes, prohibit-password or no');
    if (value !== 'yes' && !safeForLockdown(row)) throw P.httpError(400, 'Create a deploy user first — DockGate must connect as a non-root user with an SSH key before root login can be restricted.');
    next.rootLogin = value;
    title = 'Root SSH login';
    successText = { yes: 'Root can log in over SSH again.', 'prohibit-password': 'Root can log in with an SSH key only.', no: 'Root can no longer log in over SSH. sudo still works.' }[value];
  } else if (setting === 'passwordAuth') {
    if (typeof value !== 'boolean') throw P.httpError(400, 'value must be true or false');
    if (value === false && !row.key_path) throw P.httpError(400, 'DockGate itself logs in with a password. Create a deploy user (SSH key) first.');
    next.passwordAuth = value;
    title = 'Password login';
    successText = value ? 'Password login is on again.' : 'Password login is off. Only SSH keys can log in now.';
  } else if (setting === 'sshPort') {
    const to = P.assertPort(value);
    if (to === state.sshPort) throw P.httpError(400, `SSH already listens on ${to}`);
    next.ports = [to];
    portChange = { from: state.sshPort, to };
    testPort = to;
    title = 'SSH port';
    successText = `SSH now listens on port ${to}. Use "-p ${to}" (or Port ${to} in ~/.ssh/config) from your own machine.`;
  } else if (setting === 'hardening') {
    const v = value || {};
    const tries = Number(v.maxAuthTries), grace = Number(v.loginGraceTime), dead = Number(v.deadTimeoutMin), idle = Number(v.idleTimeoutMin || 0);
    if (!Number.isInteger(tries) || tries < 1 || tries > 10) throw P.httpError(400, 'Max auth tries must be 1–10');
    if (!Number.isInteger(grace) || grace < 10 || grace > 600) throw P.httpError(400, 'Login grace time must be 10–600 seconds');
    if (!Number.isInteger(dead) || dead < 0 || dead > 240) throw P.httpError(400, 'Dead connection timeout must be 0–240 minutes (0 = off)');
    if (!Number.isInteger(idle) || idle < 0 || idle > 1440) throw P.httpError(400, 'Idle session timeout must be 0–1440 minutes (0 = off)');
    if (idle && !state.supportsIdleTimeout) throw P.httpError(400, `This server runs OpenSSH ${state.sshVersion || '(unknown)'} — an idle session timeout needs OpenSSH 9.2 or newer`);
    next.maxAuthTries = tries;
    next.loginGraceTime = grace;
    next.permitEmptyPasswords = false;
    // Dead connection = the client stops answering keepalives (network gone, laptop asleep):
    // probe every dead/2 minutes, give up after 2 unanswered probes.
    next.clientAliveInterval = dead ? Math.max(15, Math.round((dead * 60) / 2)) : 0;
    next.clientAliveCountMax = 2;
    next.idleTimeoutMin = idle || null;
    next.x11 = !!v.x11;
    title = 'SSH hardening';
    successText = 'Hardening saved.';
  } else throw P.httpError(400, 'Unknown setting');

  const content = P.buildAccessConf(next);
  const plan = plans.accessPlan({ id: newId(), content, test: { port: testPort, username: row.username }, portChange });
  const jobId = runner.startPlan(cfgOf(row), plan, {
    title, successText,
    onSuccess: () => {
      if (portChange) { stmts.setServerPort.run(portChange.to, row.id); refreshConnections(row.id); }
      audit(req, row, 'access-change', { setting, value });
    },
    onFailure: () => audit(req, row, 'access-change-failed', { setting, value }),
  });
  return { jobId };
}));

router.post('/:id/access/retrust-host-key', send((req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  stmts.clearServerHostKey.run(row.id);
  refreshConnections(row.id); // the next connection pins the key the server presents now
  audit(req, row, 'host-key-retrust', { previous: row.host_key });
  return { success: true };
}));

// ---------------------------------------------------------------- deploy user
router.post('/:id/deploy-user', send(async (req) => {
  const row = loadServer(req);
  const { username, keyMode = 'generate', publicKey } = req.body || {};
  return { jobId: startDeployUser(row, { username, keyMode, publicKey }, { req }) };
}));

// ---------------------------------------------------------------- users
// Fingerprint of the public half of the key DockGate connects with (works for imported keys too).
function connectionKeyFingerprint(row) {
  if (!row.key_path) return null;
  try {
    const k = require('ssh2').utils.parseKey(fs.readFileSync(absKey(row.key_path)), decrypt(row.passphrase) || undefined);
    const key = Array.isArray(k) ? k[0] : k;
    if (!key || key instanceof Error) return null;
    return P.keyFingerprint(key.getPublicSSH().toString('base64'));
  } catch (e) { return null; }
}

async function usersOf(row) {
  const sec = await readState(row, plans.READ_USERS);
  const st = P.usersState(sec);
  const gen = stmts.getGeneratedKeys.all(row.id);
  const connFp = connectionKeyFingerprint(row);
  for (const u of st.users) {
    u.isConnection = u.name === row.username;
    for (const k of u.keys) {
      k.dockgate = !!gen.find(x => x.username === u.name && x.fingerprint === k.fingerprint);
      k.connectionKey = u.isConnection && !!connFp && k.fingerprint === connFp;
    }
  }
  return st;
}
const findUser = (st, name) => { const u = st.users.find(x => x.name === name); if (!u) throw P.httpError(404, 'User not found'); return u; };
const activeSudoers = (st) => st.users.filter(x => x.uid !== 0 && x.sudo && !x.locked);
async function runOrThrow(row, plan, title) {
  const job = await runner.runAndWait(cfgOf(row), plan, { title });
  if (job.status !== 'done') throw P.httpError(400, String(job.error || 'Failed').trim().split('\n').slice(-3).join(' '));
  return job;
}

router.get('/:id/users', send(async (req) => {
  const row = loadServer(req);
  const st = await usersOf(row);
  return { connectionUser: row.username, passwordAuth: st.passwordAuth, rootLogin: st.rootLogin, users: st.users };
}));

router.post('/:id/users', send(async (req) => {
  const row = loadServer(req);
  const { name, sudo, docker, keyMode = 'generate', publicKey } = req.body || {};
  P.assertNewUsername(name);
  let gen = null, keys = [];
  if (keyMode === 'paste') keys = [P.assertPublicKey(publicKey)];
  else if (keyMode === 'generate') { gen = generateKey(row.id, name); keys = [gen.pub]; }
  else if (keyMode !== 'none') throw P.httpError(400, 'keyMode must be generate, paste or none');
  try { await runOrThrow(row, plans.createUserPlan({ username: name, sudo: !!sudo, docker: !!docker, keys }), `Create user ${name}`); }
  catch (e) { if (gen) removeKeyFile(gen.privatePath); throw e; }
  if (gen) stmts.insertGeneratedKey.run(row.id, name, gen.pub.fingerprint, gen.privatePath);
  audit(req, row, 'user-create', { name, sudo: !!sudo, docker: !!docker, keyMode });
  return { success: true, generated: gen ? { fingerprint: gen.pub.fingerprint } : null };
}));

router.put('/:id/users/:name', send(async (req) => {
  const row = loadServer(req);
  const name = req.params.name;
  if (!P.validUsername(name)) throw P.httpError(400, 'Invalid username');
  const st = await usersOf(row);
  const u = findUser(st, name);
  if (u.uid === 0) throw P.httpError(400, 'root cannot be changed here — use Access & SSH for root login');
  const { sudo, docker, locked } = req.body || {};
  if (locked === true) {
    if (u.isConnection) throw P.httpError(400, 'DockGate connects as this user — it cannot be locked.');
    if (u.sudo && !u.locked && activeSudoers(st).length <= 1) throw P.httpError(400, 'This is the last active sudo user — locking it would leave nobody who can administer the server.');
  }
  if (sudo === false && u.sudo) {
    if (u.isConnection) throw P.httpError(400, 'DockGate needs sudo on the user it connects as.');
    if (activeSudoers(st).length <= 1) throw P.httpError(400, 'This is the last sudo user — at least one must keep sudo.');
  }
  if (docker === false && u.isConnection) throw P.httpError(400, 'DockGate needs Docker access on the user it connects as.');
  const steps = [];
  if (typeof sudo === 'boolean' && sudo !== u.sudo) steps.push(...plans.setPermsPlan({ username: name, sudo }).steps);
  if (typeof docker === 'boolean' && docker !== u.docker) steps.push(...plans.setPermsPlan({ username: name, docker }).steps);
  if (typeof locked === 'boolean' && locked !== u.locked) steps.push(...plans.lockPlan(name, locked).steps);
  if (!steps.length) return { success: true, unchanged: true };
  await runOrThrow(row, { steps }, `Update ${name}`);
  audit(req, row, 'user-update', { name, sudo, docker, locked });
  return { success: true };
}));

router.delete('/:id/users/:name', send(async (req) => {
  const row = loadServer(req);
  const name = req.params.name;
  if (!P.validUsername(name)) throw P.httpError(400, 'Invalid username');
  const st = await usersOf(row);
  const u = findUser(st, name);
  if (u.uid === 0) throw P.httpError(400, 'root cannot be deleted');
  if (u.isConnection) throw P.httpError(400, 'DockGate connects as this user — it cannot be deleted.');
  if (u.sudo && !u.locked && activeSudoers(st).length <= 1) throw P.httpError(400, 'This is the last sudo user — deleting it would leave nobody who can administer the server.');
  const removeHome = req.query.removeHome === '1' || req.query.removeHome === 'true';
  await runOrThrow(row, plans.deleteUserPlan(name, removeHome), `Delete ${name}`);
  for (const g of stmts.getGeneratedKeys.all(row.id).filter(x => x.username === name)) { removeKeyFile(g.key_path); stmts.deleteGeneratedKey.run(g.id); }
  audit(req, row, 'user-delete', { name, removeHome });
  return { success: true };
}));

router.post('/:id/users/:name/keys', send(async (req) => {
  const row = loadServer(req);
  const name = req.params.name;
  if (!P.validUsername(name)) throw P.httpError(400, 'Invalid username');
  const st = await usersOf(row);
  findUser(st, name);
  const { mode = 'paste', publicKey } = req.body || {};
  let gen = null, key;
  if (mode === 'paste') key = P.assertPublicKey(publicKey);
  else if (mode === 'generate') { gen = generateKey(row.id, name); key = gen.pub; }
  else throw P.httpError(400, 'mode must be paste or generate');
  try { await runOrThrow(row, plans.addKeysPlan(name, [key]), `Add key for ${name}`); }
  catch (e) { if (gen) removeKeyFile(gen.privatePath); throw e; }
  if (gen) stmts.insertGeneratedKey.run(row.id, name, key.fingerprint, gen.privatePath);
  audit(req, row, 'user-key-add', { name, fingerprint: key.fingerprint, generated: !!gen });
  return { success: true, key: { type: key.type, fingerprint: key.fingerprint, comment: key.comment, dockgate: !!gen } };
}));

router.delete('/:id/users/:name/keys', send(async (req) => {
  const row = loadServer(req);
  const name = req.params.name;
  const fingerprint = String(req.query.fingerprint || '');
  if (!P.validUsername(name)) throw P.httpError(400, 'Invalid username');
  const st = await usersOf(row);
  const u = findUser(st, name);
  const k = u.keys.find(x => x.fingerprint === fingerprint);
  if (!k) throw P.httpError(404, 'Key not found');
  if (k.connectionKey) throw P.httpError(400, 'DockGate uses this key to connect — it cannot be removed.');
  const keysLeft = st.users.filter(x => !x.locked).reduce((n, x) => n + x.keys.length, 0) - 1;
  if (!st.passwordAuth && keysLeft <= 0) throw P.httpError(400, 'Password login is off and this is the last key — removing it would lock everyone out.');
  const current = await runner.read(cfgOf(row), plans.readKeysScript(name));
  const { content, removed } = P.removeAuthorizedKey(current, fingerprint);
  if (!removed) throw P.httpError(409, 'The key changed on the server — refresh and try again');
  await runOrThrow(row, plans.writeKeysPlan(name, content), `Remove key from ${name}`);
  const g = stmts.getGeneratedKey.get(row.id, name, fingerprint);
  if (g) { removeKeyFile(g.key_path); stmts.deleteGeneratedKey.run(g.id); }
  audit(req, row, 'user-key-remove', { name, fingerprint });
  return { success: true };
}));

// Download a private key DockGate generated — re-check the admin password (it grants server access).
router.post('/:id/users/:name/keys/private', send((req) => {
  const row = loadServer(req);
  const { fingerprint, adminPassword } = req.body || {};
  const salt = (stmts.getSetting.get('auth_salt') || {}).value, hash = (stmts.getSetting.get('auth_password_hash') || {}).value;
  if (!adminPassword || !verifyPassword(String(adminPassword), salt, hash)) throw P.httpError(403, 'Admin password is incorrect');
  const g = stmts.getGeneratedKey.get(row.id, req.params.name, String(fingerprint || ''));
  if (!g) throw P.httpError(404, 'DockGate did not generate this key, so it has no private half for it');
  audit(req, row, 'user-key-download', { name: req.params.name, fingerprint });
  return { privateKey: fs.readFileSync(absKey(g.key_path), 'utf8'), filename: `${row.id}-${req.params.name}-ed25519` };
}));

// ---------------------------------------------------------------- fail2ban
const F2B = require('../security/fail2ban');

async function fail2banOf(row) {
  const sec = await readState(row, plans.READ_FAIL2BAN);
  const installed = /yes/.test(sec.installed || '');
  const active = /^active/m.test(sec.active || '');
  const jailNames = F2B.parseJailList(sec.status);
  const jails = jailNames.map((name) => {
    const opts = F2B.parseKv(sec['opts ' + name]);
    const port = (/\['port', '([^']*)'\]/.exec(opts.port || '') || [])[1] || null;
    const ignore = String(opts.ignoreip || '').split(/\s+/).filter(x => /^[0-9a-fA-F:.\/]+$/.test(x) && /[.:]/.test(x));
    return {
      name, ...F2B.parseJailStatus(sec['jail ' + name]), banned: F2B.parseBanList(sec['bans ' + name]),
      maxretry: Number(opts.maxretry) || null, findtime: Number(opts.findtime) || null, bantime: Number(opts.bantime) || null,
      logpath: (opts.logpath || '').replace(/Current monitored log file\(s\):|`-|\|-/g, ' ').trim(), port, ignoreip: ignore,
      // bantime.* as fail2ban runs them (absent from the result when the jail does not set them)
      inc: Object.fromEntries([['increment', /^true$/i.test(opts['bantime.increment'] || '') ? true : /^false$/i.test(opts['bantime.increment'] || '') ? false : null],
        ['factor', /^[\d.]+$/.test(opts['bantime.factor'] || '') ? Number(opts['bantime.factor']) : null], ['maxtime', /^\d+$/.test(opts['bantime.maxtime'] || '') ? Number(opts['bantime.maxtime']) : null]].filter(([, v]) => v != null)),
    };
  });
  const managed = F2B.parseJailConf(sec.dockgate);
  const settings = managed || JSON.parse(JSON.stringify(F2B.DEFAULTS));
  const dp = F2B.parseDaemonConf(sec.daemon);
  if (dp) settings.dbpurgeage = dp;
  const sshPort = Number((sec.sshport || '').trim()) || row.port || 22;
  const dockgateIp = (sec.myip || '').trim() || null;
  const sshdJail = jails.find(j => j.name === 'sshd');
  const recidive = jails.find(j => j.name === 'recidive');
  const runtime = {
    dbpurgeage: (sec.dbpurgeage || '').trim() ? Number(sec.dbpurgeage) : null, jails: jailNames, recidiveLogpath: recidive ? recidive.logpath : null,
    jailOpts: Object.fromEntries(jails.filter(j => j.name === 'sshd' || j.name === 'recidive').map(j => [j.name, { maxretry: j.maxretry, findtime: j.findtime, bantime: j.bantime, ...j.inc }])),
    ignoreip: sshdJail ? sshdJail.ignoreip : null, // the allowlist fail2ban really uses (a later [DEFAULT] ignoreip replaces DockGate's)
  };
  const sources = F2B.parseSources(sec.f2bsrc);
  const problems = installed && active ? F2B.detectProblems({
    settings, runtime, sshPort, jailPort: sshdJail && sshdJail.port, jailLocal: (sec.jaillocal || '').trim() || null, dockgateIp,
    managed: !!managed, jailFileText: sec.dockgate || '', sources, active,
    banned: jails.flatMap(j => j.banned.map(b => b.ip)),
  }) : [];
  if (installed && !active) problems.unshift({ level: 'crit', text: 'fail2ban is installed but not running — nothing is being banned.', fix: 'start' });
  return {
    installed, active, version: (sec.version || '').trim(), jails, settings, managed: !!managed, runtime, sshPort, dockgateIp,
    jailLocal: (sec.jaillocal || '').trim() || null,
    overriding: F2B.overridingFiles(sources), // files that take precedence over DockGate's for what it manages
    origin: F2B.originsOf(sources), // which file sets each option fail2ban runs
    // DockGate's own files as they are on the server now (empty text = not written yet).
    files: [{ path: F2B.JAIL_FILE, text: sec.dockgate || '' }, { path: F2B.DAEMON_FILE, text: sec.daemon || '' }].map(x => ({ ...x, text: x.text.trim() ? x.text.replace(/\s*$/, '\n') : '' })),
    history: F2B.parseHistory(sec.history).slice(0, 100),
    sequence: F2B.banSequence(settings.sshd, 6).map(F2B.human),
    memory: F2B.human(F2B.memoryAfterBan(F2B.toSeconds(settings.sshd.bantime), runtime.dbpurgeage != null ? runtime.dbpurgeage : F2B.toSeconds(settings.dbpurgeage))),
    problems,
  };
}

const assertJail = (j) => { if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(String(j || ''))) throw P.httpError(400, 'Invalid jail name'); return j; };
const assertIp = (ip) => { const v = String(ip || '').trim(); if (!require('../provision/catalog').isIpOrCidr(v)) throw P.httpError(400, 'Enter an IP address or CIDR'); return v; };

router.get('/:id/fail2ban', send(async (req) => fail2banOf(loadServer(req))));

// POST /api/servers/:id/fail2ban/preview — the files Save would write for these settings, built by the same
// functions the save plan uses (nothing runs on the server). Invalid settings → 400 with the reason.
router.post('/:id/fail2ban/preview', send(async (req) => {
  loadServer(req);
  const settings = F2B.normalizeSettings((req.body || {}).settings);
  const sshPort = Number((req.body || {}).sshPort) || 22;
  return { files: [{ path: F2B.JAIL_FILE, text: F2B.buildJailConf(settings, sshPort) }, { path: F2B.DAEMON_FILE, text: F2B.buildDaemonConf(settings) }] };
}));

// Moving fail2ban's sshd / recidive / allowlist / history settings out of jail.local (and other files read after
// DockGate's) into DockGate's files. preview: what changes, nothing runs; takeover: one job — backup, rewrite,
// test, reload, restore everything on failure. Both read the files fresh, so the preview is what gets applied.
async function takeoverOf(row) {
  const cur = await fail2banOf(row);
  if (!cur.installed) throw P.httpError(400, 'fail2ban is not installed — install it in Setup first');
  const sec = await readState(row, plans.READ_FAIL2BAN);
  const sources = F2B.parseSources(sec.f2bsrc);
  const paths = F2B.overridingFiles(sources);
  if (!paths.length) throw P.httpError(400, 'No other file overrides DockGate\'s fail2ban settings — nothing to move.');
  const raw = await readState(row, plans.readFilesScript(paths));
  const texts = Object.fromEntries(paths.map((p, i) => [p, raw['file' + i] || '']));
  return F2B.planTakeover({ settings: cur.settings, sources, texts, dockgateIp: cur.dockgateIp, sshPort: cur.sshPort });
}
router.post('/:id/fail2ban/takeover/preview', send(async (req) => takeoverOf(loadServer(req))));
router.post('/:id/fail2ban/takeover', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const t = await takeoverOf(row);
  const cur = await fail2banOf(row);
  const jobId = runner.startPlan(cfgOf(row), plans.fail2banSettingsPlan(t.settings, cur.sshPort, t.files.map(f => ({ path: f.path, text: f.after }))), {
    title: 'Move fail2ban settings to DockGate',
    successText: `Done — DockGate's files now hold the settings; backups: ${t.files.map(f => f.path + '.dockgate-backup').join(', ')}. Current bans were kept.`,
    onSuccess: () => audit(req, row, 'fail2ban-takeover', { files: t.files.map(f => f.path), adopted: t.adopted, corrected: t.corrected }),
  });
  return { jobId };
}));

// Configuration → Files: every fail2ban config file under jail.d / fail2ban.d plus jail.local / fail2ban.local.
router.get('/:id/fail2ban/files', send(async (req) => {
  const sec = await readState(loadServer(req), plans.READ_F2B_FILES);
  const files = Object.keys(sec).filter(k => k.startsWith('file ')).map(k => { const path = k.slice(5); return { path, text: sec[k] ? sec[k].replace(/\s*$/, '\n') : '', ...F2B.fileRole(path) }; });
  const order = (p) => p === F2B.JAIL_FILE ? 0 : p === F2B.DAEMON_FILE ? 1 : p.endsWith('/jail.local') ? 2 : p.includes('/jail.d/') ? 3 : 4;
  files.sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
  return { files, jailFile: F2B.JAIL_FILE, daemonFile: F2B.DAEMON_FILE };
}));
// Save one file from Configuration → Files: backup, write, test, reload, restore on failure. DockGate's own files
// must stay something DockGate can read back (its sections only, valid values, the log file recidive needs).
router.post('/:id/fail2ban/file', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const { path, content } = req.body || {};
  if (typeof content !== 'string' || content.length > 200000) throw P.httpError(400, 'content (text) is required');
  const sec = await readState(row, plans.READ_F2B_FILES);
  const known = Object.keys(sec).filter(k => k.startsWith('file ')).map(k => k.slice(5));
  const isOwn = path === F2B.JAIL_FILE || path === F2B.DAEMON_FILE;
  if (!known.includes(path) && !isOwn) throw P.httpError(400, 'Not a fail2ban file DockGate shows');
  if (!F2B.fileRole(path).editable) throw P.httpError(400, `${path} ships with fail2ban and is not edited here — put your change in jail.local`);
  if (path === F2B.JAIL_FILE) {
    const bad = F2B.sectionNames(content).filter(n => !['DEFAULT', 'sshd', 'recidive'].includes(n));
    if (bad.length) throw P.httpError(400, `DockGate's file holds [DEFAULT], [sshd] and [recidive] only — put [${bad.join('], [')}] in /etc/fail2ban/jail.local`);
    const parsed = F2B.parseJailConf(content);
    if (!parsed) throw P.httpError(400, "DockGate's file cannot be empty");
    F2B.normalizeSettings({ ...parsed, dbpurgeage: F2B.DEFAULTS.dbpurgeage }); // 400 with the field when a value is wrong
  }
  if (path === F2B.DAEMON_FILE) {
    const lt = /^\s*logtarget\s*=\s*(.+)$/m.exec(content);
    if (lt && lt[1].trim() !== F2B.LOG_FILE) throw P.httpError(400, `logtarget must stay ${F2B.LOG_FILE} — recidive reads that file`);
  }
  const jobId = runner.startPlan(cfgOf(row), plans.fail2banWritePlan([{ path, text: content.replace(/\s*$/, '\n') }], { label: `Write ${path}` }), {
    title: `Save ${path}`,
    successText: 'Saved, tested and reloaded — current bans were kept.',
    onSuccess: () => audit(req, row, 'fail2ban-file', { path, bytes: content.length }),
  });
  return { jobId };
}));

router.post('/:id/fail2ban/settings', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const settings = F2B.normalizeSettings(req.body.settings);
  const cur = await fail2banOf(row);
  if (!cur.installed) throw P.httpError(400, 'fail2ban is not installed — install it in Setup first');
  const jobId = runner.startPlan(cfgOf(row), plans.fail2banSettingsPlan(settings, cur.sshPort), {
    title: 'Fail2ban settings',
    successText: 'Saved and reloaded — current bans were kept.',
    onSuccess: () => audit(req, row, 'fail2ban-settings', { settings }),
  });
  return { jobId };
}));

router.post('/:id/fail2ban/ban', send(async (req) => {
  const row = loadServer(req);
  const jail = assertJail(req.body.jail), ip = assertIp(req.body.ip);
  const cur = await fail2banOf(row);
  if (cur.dockgateIp && ip === cur.dockgateIp) throw P.httpError(400, 'That is the IP DockGate connects from — banning it would cut DockGate off this server.');
  if (!cur.jails.some(j => j.name === jail)) throw P.httpError(404, `Jail "${jail}" is not running`);
  await runOrThrow(row, { steps: [{ label: `Ban ${ip}`, cmd: plans.f2bBanCmd(jail, ip) }] }, 'Fail2ban');
  audit(req, row, 'fail2ban-ban', { jail, ip });
  return { success: true };
}));

router.post('/:id/fail2ban/unban', send(async (req) => {
  const row = loadServer(req);
  const ip = assertIp(req.body.ip);
  const jail = req.body.jail ? assertJail(req.body.jail) : null;
  await runOrThrow(row, { steps: [{ label: `Unban ${ip}`, cmd: plans.f2bUnbanCmd(jail, ip) }] }, 'Fail2ban');
  if (req.body.whitelist) {
    const cur = await fail2banOf(row);
    const settings = F2B.normalizeSettings({ ...cur.settings, ignoreip: [...cur.settings.ignoreip, ip] });
    await runOrThrow(row, plans.fail2banSettingsPlan(settings, cur.sshPort), 'Fail2ban whitelist');
  }
  audit(req, row, 'fail2ban-unban', { jail, ip, whitelist: !!req.body.whitelist });
  return { success: true };
}));

// ---------------------------------------------------------------- Services sub-pages
router.get('/:id/services/:item/info', send(async (req) => {
  const row = loadServer(req);
  const item = req.params.item;
  if (!plans.SERVICE_INFO_ITEMS.includes(item)) throw P.httpError(404, 'No details for this service');
  const sec = await readState(row, plans.serviceInfoScript(item));
  // logsFor() prints "#unit=<name>" first: the unit whose journal the Recent log viewer reads (up to 10,000 lines)
  const um = /^#unit=([A-Za-z0-9@._-]+)\s*\n?/.exec(sec.logs || '');
  const out = { item, unit: um ? um[1] + '.service' : null, logs: um ? (sec.logs || '').slice(um[0].length) : (sec.logs || '') };
  if (item === 'docker') {
    let info = null; try { info = JSON.parse(sec.info || 'null'); } catch (e) {}
    let daemon = {}; try { daemon = sec.daemon ? JSON.parse(sec.daemon) : {}; } catch (e) { daemon = null; }
    const lo = (daemon && daemon['log-opts']) || {};
    out.summary = info && info.ServerVersion ? {
      version: info.ServerVersion, storageDriver: info.Driver, loggingDriver: info.LoggingDriver, cgroupDriver: info.CgroupDriver,
      containers: info.Containers, running: info.ContainersRunning, images: info.Images, liveRestore: !!info.LiveRestoreEnabled,
      swarm: info.Swarm ? info.Swarm.LocalNodeState : null, os: info.OperatingSystem,
    } : null;
    out.settings = { maxSize: lo['max-size'] || '', maxFile: Number(lo['max-file']) || 0, liveRestore: !!(daemon && daemon['live-restore']) };
    out.daemonJsonValid = daemon !== null;
    out.df = sec.df || '';
  } else if (item === 'timesync') {
    out.tracking = sec.tracking || ''; out.sources = sec.sources || ''; out.timedatectl = sec.timedatectl || '';
    out.synced = /System clock synchronized:\s*yes/i.test(sec.timedatectl || '') || /Leap status\s*:\s*Normal/i.test(sec.tracking || '');
    out.offset = (/System time\s*:\s*(.+)/.exec(sec.tracking || '') || [])[1] || null;
    Object.assign(out, P.parseChronyConf(sec.conf), { installed: !!(sec.conf || '').trim() });
  } else {
    const family = (sec.family || '').trim();
    const v = (re) => (re.exec(sec.auto || '') || [])[1];
    out.family = family;
    out.settings = {
      enabled: v(/Unattended-Upgrade\s+"(\d)"/) === '1',
      autoReboot: /Automatic-Reboot\s+"true"/.test(sec.dockgate || ''),
      rebootTime: (/Automatic-Reboot-Time\s+"([^"]+)"/.exec(sec.dockgate || '') || [])[1] || '04:00',
    };
    out.timer = sec.timer || ''; out.last = sec.last || ''; out.rhel = sec.rhel || '';
    if (family === 'rhel') {
      const k = (key) => (new RegExp('^' + key + '\\s*=\\s*(\\S+)', 'm').exec(sec.rhel || '') || [])[1];
      out.installed = !!(sec.rhpkg || '').trim();
      out.rhelSettings = {
        enabled: k('apply_updates') === 'yes' && /^enabled/.test((sec.rhtimer || '').trim()),
        upgradeType: k('upgrade_type') === 'security' ? 'security' : 'default',
        reboot: k('reboot') === 'when-needed' ? 'when-needed' : 'never',
        timerEnabled: /^enabled/.test((sec.rhtimer || '').trim()),
      };
    }
    out.pending = Number((sec.pending || '').trim()) || 0;
    out.rebootRequired = /yes/.test(sec.reboot || '');
  }
  return out;
}));

router.post('/:id/services/docker/settings', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const { maxSize, maxFile, liveRestore } = req.body || {};
  if (!/^\d{1,4}[kmg]$/.test(String(maxSize || ''))) throw P.httpError(400, 'Log size per file: a number with k, m or g, e.g. 10m');
  const mf = Number(maxFile);
  if (!Number.isInteger(mf) || mf < 1 || mf > 50) throw P.httpError(400, 'Log files to keep must be 1–50');
  // Docker does not start with live-restore on while the server is in a swarm — never write that.
  if (liveRestore) {
    let state = null;
    try { state = ((await require('../docker').createSshClient(row).info()).Swarm || {}).LocalNodeState; } catch (e) { /* Docker not reachable: the plan reports it */ }
    if (state && state !== 'inactive') throw P.httpError(400, 'This server is in a swarm: Docker would not start with live-restore on. Leave live-restore off (Swarm restarts failed tasks itself).');
  }
  const jobId = runner.startPlan(cfgOf(row), plans.dockerSettingsPlan({ maxSize, maxFile: mf, liveRestore: !!liveRestore }), {
    title: 'Docker settings', successText: 'Saved. New limits apply to containers created from now on (recreate a container to apply them to it).',
    onSuccess: () => audit(req, row, 'docker-settings', { maxSize, maxFile: mf, liveRestore: !!liveRestore }),
  });
  return { jobId };
}));

router.post('/:id/services/timesync/settings', send(async (req) => {
  const row = loadServer(req);
  const list = Array.isArray(req.body && req.body.servers) ? req.body.servers : [];
  if (list.length > 10) throw P.httpError(400, 'At most 10 NTP sources');
  const servers = list.map((x) => {
    const host = String((x && x.host) || '').trim(), type = x && x.type === 'server' ? 'server' : 'pool';
    if (!P.validHost(host)) throw P.httpError(400, `"${host}" is not a valid host name or IP address`);
    return { host, type };
  });
  const jobId = runner.startPlan(cfgOf(row), plans.ntpPlan({ servers }), {
    title: 'Time sync sources',
    successText: servers.length ? 'Saved — chrony restarted with the new sources. Sync can take a minute.' : "Back to the distro's own NTP sources — chrony restarted.",
    onSuccess: () => audit(req, row, 'timesync-sources', { servers }),
  });
  return { jobId };
}));

router.post('/:id/services/unattended-upgrades/settings', send(async (req) => {
  const row = loadServer(req);
  const { enabled, autoReboot, rebootTime, family } = req.body || {};
  if (family === 'rhel') {
    const { upgradeType, reboot } = req.body;
    await runOrThrow(row, plans.dnfAutomaticPlan({ enabled: !!enabled, upgradeType, reboot }), 'Auto updates');
    audit(req, row, 'auto-updates-settings', { family, enabled: !!enabled, upgradeType, reboot });
    return { success: true };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(rebootTime || ''))) throw P.httpError(400, 'Reboot time must be HH:MM (24-hour), e.g. 04:00');
  await runOrThrow(row, plans.unattendedSettingsPlan({ enabled: !!enabled, autoReboot: !!autoReboot, rebootTime }), 'Auto updates');
  audit(req, row, 'auto-updates-settings', { enabled: !!enabled, autoReboot: !!autoReboot, rebootTime });
  return { success: true };
}));

// ---------------------------------------------------------------- reboot
router.post('/:id/reboot', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  await runOrThrow(row, { steps: [{ label: 'Reboot', cmd: plans.REBOOT }] }, 'Reboot');
  audit(req, row, 'reboot', {});
  return { success: true };
}));

module.exports = router;
