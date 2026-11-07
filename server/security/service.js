// Shared server-security operations used by the routes AND the provisioning runner (Setup → Deploy user).
const fs = require('fs');
const path = require('path');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const { decrypt } = require('../auth/secrets');
const P = require('./parse');
const plans = require('./plans');
const runner = require('./runner');

const paths = require('../paths');
const { SSH_KEYS_DIR } = paths;
const absKey = (p) => paths.keyPath(p);
const cfgOf = (row) => ({ ...row, keyPath: absKey(row.key_path), password: decrypt(row.password), passphrase: decrypt(row.passphrase) });

// After DockGate's own connection changes (user / key / port): drop pooled connections, restart the
// event monitor and, if this is the active server, rebuild the Docker client.
function refreshConnections(serverId) {
  try { require('../ssh-pool').invalidate(serverId); } catch (e) {}
  try { require('../notifications/monitor-manager').startMonitor(serverId); } catch (e) {}
  try {
    if ((stmts.getSetting.get('active_server') || {}).value === serverId) require('../docker').setActiveServer(serverId);
  } catch (e) {}
}

/** Generate an ed25519 key pair for `username` on this server; returns { privatePath (relative), abs, pub }. */
function generateKey(serverId, username) {
  const { utils } = require('ssh2');
  // ssh2's generator occasionally drops a leading zero byte from the ed25519 public key (~1 in 200),
  // producing a key that can never authenticate. Accept a pair only when the public key parses strictly
  // AND equals the public half derived from the private key.
  let kp, pub;
  for (let attempt = 0; attempt < 10; attempt++) {
    kp = utils.generateKeyPairSync('ed25519', { comment: `dockgate@${serverId}` });
    pub = P.parsePublicKey(kp.public);
    const priv = utils.parseKey(kp.private);
    if (pub && priv && !(priv instanceof Error) && priv.getPublicSSH().toString('base64') === pub.b64) break;
    pub = null;
  }
  if (!pub) throw new Error('Could not generate a valid SSH key pair — try again');
  if (!fs.existsSync(SSH_KEYS_DIR)) fs.mkdirSync(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
  const file = `${serverId}--${username}--${Date.now()}.pem`;
  fs.writeFileSync(path.join(SSH_KEYS_DIR, file), kp.private, { mode: 0o600 });
  return { privatePath: file, abs: path.join(SSH_KEYS_DIR, file), pub };
}
const removeKeyFile = (rel) => { try { fs.unlinkSync(absKey(rel)); } catch (e) {} };


/**
 * Start the deploy-user job: create the user, passwordless sudo, docker group, a generated ed25519 key
 * (+ the admin's own public key when pasted), prove it with a NEW login, then switch DockGate's
 * connection to that user. Returns the job id. Throws 400 on invalid input, 409 when busy.
 */
function startDeployUser(row, { username, keyMode = 'generate', publicKey }, { req, sourceIp } = {}) {
  P.assertNewUsername(username);
  const extra = keyMode === 'paste' ? P.assertPublicKey(publicKey) : null;
  if (!fs.existsSync(SSH_KEYS_DIR)) fs.mkdirSync(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
  const gen = generateKey(row.id, username);
  const keys = [gen.pub, ...(extra ? [extra] : [])];
  const plan = plans.deployUserPlan({ username, keys, test: { username, keyPath: gen.abs, cmd: 'sudo -n true && id -nG | grep -qw docker' } });
  const audit = (action, details) => logAction({ req, sourceIp, server: row.id, resourceType: 'server', resourceId: row.id, resourceName: row.name || row.id, action, details });
  try {
    return runner.startPlan(cfgOf(row), plan, {
      title: `Deploy user "${username}"`,
      successText: `DockGate now connects as ${username} with an SSH key. Password login is still on — turn it off in Access & SSH when you are ready.`,
      onSuccess: () => {
        stmts.setServerConnection.run(username, gen.privatePath, row.id);
        stmts.insertGeneratedKey.run(row.id, username, gen.pub.fingerprint, gen.privatePath);
        refreshConnections(row.id);
        audit('deploy-user', { username, keyFingerprint: gen.pub.fingerprint, ownKey: !!extra });
        return { user: username, keyFingerprint: gen.pub.fingerprint };
      },
      onFailure: () => { removeKeyFile(gen.privatePath); audit('deploy-user-failed', { username }); },
    });
  } catch (e) { removeKeyFile(gen.privatePath); throw e; }
}

module.exports = { refreshConnections, generateKey, removeKeyFile, startDeployUser, cfgOf, absKey };
