// Builds the environment for host-CLI commands (`docker compose`, `docker stack deploy`) so they can
// target EITHER the local daemon or a remote SSH host's daemon.
//
//   - Registry credentials (DOCKER_CONFIG) are always attached so private images pull.
//   - When the active server is a remote SSH host, DOCKER_HOST=ssh://user@host points the CLI at the
//     remote daemon, and a temp HOME with an ssh config makes ssh use DockGate's stored key.
//
// Limitations (honest):
//   - The SSH connhelper runs in BatchMode, so only KEY auth WITHOUT a passphrase works for remote CLI
//     (password / passphrase-protected servers throw and the caller falls back to "switch to Local").
//   - Bind-mount paths and build contexts in a compose/stack file are interpreted on the REMOTE host.
const fs = require('fs');
const path = require('path');
const { stmts } = require('./db');
const { decrypt } = require('./auth/secrets');

const SSH_KEYS_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

/**
 * Write the registry credentials into a DOCKER_CONFIG dir (so the CLI pulls private images).
 * @returns {string|null} the config dir, or null if no registries are stored.
 */
function writeRegistryConfig(subdir) {
  try {
    const regs = stmts.getRegistries.all();
    if (!regs.length) return null;
    const auths = {};
    for (const r of regs) {
      auths[r.server_address] = { auth: Buffer.from(`${r.username}:${decrypt(r.password)}`).toString('base64') };
      if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(r.server_address)) {
        auths['https://index.docker.io/v1/'] = auths[r.server_address];
      }
    }
    const dir = path.join(DATA_DIR, subdir, '.docker-config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths }), { mode: 0o600 });
    return dir;
  } catch (e) { return null; }
}

/**
 * Build the env for a host-CLI command given the active server.
 * @param {string} activeServerId
 * @param {string} subdir  where temp config/ssh files live (e.g. 'compose' or 'stacks')
 * @returns {{ env: object, remote: boolean }}
 * @throws {Error} (statusCode 400) when the active server is remote but not key-auth/passphrase-less
 */
function buildCliEnv(activeServerId, subdir) {
  const env = { ...process.env };
  const cfg = writeRegistryConfig(subdir);
  if (cfg) env.DOCKER_CONFIG = cfg;

  if (!activeServerId || activeServerId === 'local') return { env, remote: false };

  const s = stmts.getServer.get(activeServerId);
  if (!s) return { env, remote: false };

  if (!s.key_path || s.passphrase) {
    const e = new Error('Remote Compose/Stack needs a key-based SSH server with no passphrase. Switch to Local, or re-add the server with a passphrase-less key.');
    e.statusCode = 400;
    throw e;
  }

  const keyPath = path.isAbsolute(s.key_path) ? s.key_path : path.join(SSH_KEYS_DIR, s.key_path);
  // The docker ssh connhelper invokes `ssh` from PATH with no way to pass `-i`. So we put a tiny `ssh`
  // wrapper first on PATH that injects our stored key + non-interactive options. (A temp HOME/.ssh/config
  // is NOT honored reliably by the connhelper, but a PATH-shadowed wrapper always is.)
  const realSsh = ['/usr/bin/ssh', '/bin/ssh', '/usr/local/bin/ssh'].find(p => fs.existsSync(p)) || 'ssh';
  const binDir = path.join(DATA_DIR, subdir, '.ssh-wrap', activeServerId);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'ssh'),
    `#!/bin/sh\nexec ${realSsh} -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o BatchMode=yes "$@"\n`,
    { mode: 0o755 }
  );
  env.PATH = `${binDir}:${env.PATH || ''}`;
  delete env.SSH_AUTH_SOCK; // ssh relies solely on our IdentityFile
  env.DOCKER_HOST = `ssh://${s.username}@${s.host}:${s.port || 22}`;
  return { env, remote: true };
}

module.exports = { buildCliEnv };
