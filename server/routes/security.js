// Server security routes — Server Console → Overview (security status), Access & SSH, Users, Firewall,
// the deploy-user wizard and reboot. Mounted under /api/servers (behind requireAuth).
//
// Every safety rule is enforced HERE, not only in the UI: DockGate never locks itself out (it keeps
// the user/key it connects with), the last sudo user keeps sudo, the SSH port stays open, and sshd /
// firewall changes run as lifeline jobs that test a NEW login and roll back on failure.
const express = require('express');
const fs = require('fs');
const path = require('path');
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

const SSH_KEYS_DIR = path.join(__dirname, '..', '..', 'data', 'ssh-keys');
if (!fs.existsSync(SSH_KEYS_DIR)) fs.mkdirSync(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- helpers
const absKey = (p) => (p ? (path.isAbsolute(p) ? p : path.join(SSH_KEYS_DIR, p)) : null);

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
  const sec = await readState(row, plans.READ_POSTURE);
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
  return { checks, rebootRequired: a.rebootRequired };
}));

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
    const tries = Number(v.maxAuthTries), idle = Number(v.idleTimeoutMin);
    if (!Number.isInteger(tries) || tries < 1 || tries > 10) throw P.httpError(400, 'Max auth tries must be 1–10');
    if (!Number.isInteger(idle) || idle < 0 || idle > 240) throw P.httpError(400, 'Idle timeout must be 0–240 minutes (0 = off)');
    next.maxAuthTries = tries;
    next.clientAliveInterval = idle ? Math.max(30, Math.round((idle * 60) / 2)) : 0;
    next.clientAliveCountMax = 2;
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

// ---------------------------------------------------------------- firewall
async function firewallOf(row) {
  const sec = await readState(row, plans.READ_FIREWALL);
  const ufw = P.parseUfwNumbered(sec.ufw);
  const firewalld = /running/.test(sec.firewalld || '');
  const isolation = Number(sec.iso || 0) > 0;
  const t = P.parseSshdT(sec.sshdT);
  const sshPort = t.port[0] || row.port || 22;
  const ports = P.computePorts({ listeners: P.parseSs(sec.ss), dockerPorts: P.parseDockerPorts(sec.docker), ufw, isolation, sshPort });
  const backend = (sec.ufwbin || '').trim() ? 'ufw' : (firewalld ? 'firewalld' : 'none');
  return { backend, active: ufw.active || firewalld, ufwActive: ufw.active, firewalld, dockerIsolation: isolation, isolationSupported: backend === 'ufw', sshPort, rules: ufw.rules, ports };
}
const requireUfw = (fw) => { if (!fw.ufwActive) throw P.httpError(400, fw.backend === 'firewalld' ? 'This server uses firewalld — port management here works with UFW. Use Services → Firewall for firewalld ports.' : 'UFW is not active — enable the firewall in Setup first'); };

router.get('/:id/firewall', send(async (req) => firewallOf(loadServer(req))));

router.post('/:id/firewall/docker-isolation', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const enable = req.body.enable !== false;
  const fw = await firewallOf(row);
  requireUfw(fw);
  const keepPublic = [];
  for (const k of (Array.isArray(req.body.keepPublic) ? req.body.keepPublic : [])) {
    const [port, proto] = String(k).split('/');
    const p = fw.ports.find(x => x.kind === 'container' && x.port === Number(port) && x.proto === proto);
    if (!p) throw P.httpError(400, `${k} is not a published container port`);
    keepPublic.push({ port: p.containerPort, proto: p.proto });
  }
  const plan = plans.isolationPlan({ id: newId(), enable, keepPublic, test: { username: row.username } });
  const jobId = runner.startPlan(cfgOf(row), plan, {
    title: enable ? 'Docker port isolation' : 'Turn off Docker port isolation',
    successText: enable ? `Isolation is on. Public container ports: ${(req.body.keepPublic || []).join(', ') || 'none'}.` : 'Isolation is off — published container ports bypass UFW again.',
    onSuccess: () => audit(req, row, 'firewall-docker-isolation', { enable, keepPublic: req.body.keepPublic || [] }),
  });
  return { jobId };
}));

router.post('/:id/firewall/expose', send(async (req) => {
  const row = loadServer(req);
  const { port, proto, open, scope, ip } = req.body || {};
  const portN = P.assertPort(port); P.assertProto(proto);
  const from = scope === 'ip' ? P.assertSource(ip) : 'any';
  if (scope === 'ip' && from === 'any') throw P.httpError(400, 'Enter an IP address or CIDR');
  const fw = await firewallOf(row);
  requireUfw(fw);
  const p = fw.ports.find(x => x.port === portN && x.proto === proto);
  if (!p) throw P.httpError(404, `Nothing listens on ${portN}/${proto}`);
  if (p.exposure === 'local') throw P.httpError(400, 'This port only listens on localhost — it cannot be reached from outside anyway');
  if (p.isSsh) throw P.httpError(400, 'This is the SSH port — change it in Access & SSH instead');
  let cmd;
  if (p.kind === 'container') {
    if (!fw.dockerIsolation) throw P.httpError(400, 'Turn on Docker port isolation first — until then every container port is public');
    cmd = open ? plans.exposeCmd({ kind: 'container', port: p.containerPort, proto, from })
      : plans.deleteRulesCmd(P.ruleNumbersFor(fw.rules, { port: p.containerPort, proto, dir: 'FWD' }));
  } else {
    cmd = open ? plans.exposeCmd({ kind: 'host', port: portN, proto, from })
      : plans.deleteRulesCmd(P.ruleNumbersFor(fw.rules, { port: portN, proto, dir: 'IN' }));
  }
  await runOrThrow(row, { steps: [{ label: open ? `Open ${portN}/${proto}` : `Close ${portN}/${proto}`, cmd }] }, 'Firewall');
  audit(req, row, open ? 'firewall-open' : 'firewall-close', { port: portN, proto, from, kind: p.kind, containerPort: p.containerPort || null });
  return { success: true };
}));

router.post('/:id/firewall/rules', send(async (req) => {
  const row = loadServer(req);
  const { port, proto, from, action } = req.body || {};
  const portN = P.assertPort(port); P.assertProto(proto);
  const src = P.assertSource(from);
  if (action !== 'allow' && action !== 'deny') throw P.httpError(400, 'action must be allow or deny');
  const fw = await firewallOf(row);
  requireUfw(fw);
  if (action === 'deny' && portN === fw.sshPort) throw P.httpError(400, 'Denying the SSH port would lock you out — change the port in Access & SSH instead');
  await runOrThrow(row, { steps: [{ label: 'Add rule', cmd: plans.addRuleCmd({ port: portN, proto, from: src, action }) }] }, 'Firewall');
  audit(req, row, 'firewall-rule-add', { port: portN, proto, from: src, action });
  return { success: true };
}));

router.delete('/:id/firewall/rules/:n', send(async (req) => {
  const row = loadServer(req);
  const n = Number(req.params.n);
  const fw = await firewallOf(row);
  requireUfw(fw);
  const rule = fw.rules.find(r => r.n === n);
  if (!rule) throw P.httpError(404, 'Rule not found — refresh the list');
  const t = P.ruleTarget(rule.to);
  if (t && t.port === fw.sshPort && rule.dir === 'IN' && rule.action !== 'DENY') {
    const others = fw.rules.filter(r => r.n !== n && !r.v6 && r.dir === 'IN' && r.action !== 'DENY' && (P.ruleTarget(r.to) || {}).port === fw.sshPort && r.from === 'Anywhere');
    if (!rule.v6 && !others.length) throw P.httpError(400, 'This rule keeps SSH reachable — change the SSH port in Access & SSH instead');
  }
  // Delete the IPv4 rule together with its (v6) twin; highest number first (numbers shift).
  const nums = fw.rules.filter(r => r.n === n || (r.to === rule.to && r.action === rule.action && r.dir === rule.dir && r.from === rule.from && r.v6 !== rule.v6)).map(r => r.n).sort((a, b) => b - a);
  await runOrThrow(row, { steps: [{ label: `Delete rule #${n}`, cmd: plans.deleteRulesCmd(nums) }] }, 'Firewall');
  audit(req, row, 'firewall-rule-delete', { n, to: rule.to, action: rule.action, from: rule.from });
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
