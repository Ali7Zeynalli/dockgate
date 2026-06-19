// Named SSH key store (Coolify "Private Keys" model): reusable keypairs for git deploy (deploy keys /
// machine-user keys) and, later, server access. Keys are GENERATED with ssh-keygen so the private key is
// in the OpenSSH format git/ssh actually need. The private key is AES-256-GCM encrypted at rest
// (auth/secrets.js), NEVER returned by the API, and only ever written to a temp 0600 file during a single
// clone, then shredded.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { execFile } = require('child_process');
const execFileAsync = util.promisify(execFile);
const { stmts } = require('./db');
const { encrypt, decrypt } = require('./auth/secrets');

const TMP = os.tmpdir();

// Best-effort secure delete: overwrite with random bytes, then unlink.
function shred(file) {
  try { const sz = fs.statSync(file).size; if (sz > 0) fs.writeFileSync(file, crypto.randomBytes(sz)); } catch (e) {}
  try { fs.unlinkSync(file); } catch (e) {}
}
function tmpName() { return path.join(TMP, 'dgkey-' + crypto.randomBytes(12).toString('hex')); }

// Public API shape — NEVER returns the private key.
function mask(r) {
  return { id: r.id, name: r.name, description: r.description || '', key_type: r.key_type, public_key: r.public_key, fingerprint: r.fingerprint, created_at: r.created_at };
}

async function fingerprintOf(pubFile) {
  try { const { stdout } = await execFileAsync('ssh-keygen', ['-lf', pubFile]); const m = stdout.match(/SHA256:\S+/); return m ? m[0] : null; }
  catch (e) { return null; }
}

// Generate a new keypair via ssh-keygen (ed25519 default; rsa-4096 fallback).
async function generate({ type = 'ed25519', name, description }) {
  if (!name || !name.trim()) { const e = new Error('name is required'); e.statusCode = 400; throw e; }
  if (type !== 'ed25519' && type !== 'rsa') { const e = new Error('type must be ed25519 or rsa'); e.statusCode = 400; throw e; }
  const base = tmpName(), pub = base + '.pub';
  const args = type === 'rsa' ? ['-t', 'rsa', '-b', '4096'] : ['-t', 'ed25519'];
  args.push('-C', `dockgate:${name.trim()}`.slice(0, 100), '-f', base, '-N', '', '-q');
  try {
    await execFileAsync('ssh-keygen', args);
    const priv = fs.readFileSync(base, 'utf8');
    const publicKey = fs.readFileSync(pub, 'utf8').trim();
    const fingerprint = await fingerprintOf(pub);
    const info = stmts.insertSshKey.run(name.trim(), (description || '').trim() || null, type, encrypt(priv), publicKey, fingerprint);
    return mask(stmts.getSshKey.get(info.lastInsertRowid));
  } finally { shred(base); shred(pub); }
}

// Import an existing private key (paste). Derives the public key + fingerprint via ssh-keygen.
async function importKey({ name, description, privateKey }) {
  if (!name || !name.trim()) { const e = new Error('name is required'); e.statusCode = 400; throw e; }
  if (!privateKey || !privateKey.trim()) { const e = new Error('privateKey is required'); e.statusCode = 400; throw e; }
  const base = tmpName();
  try {
    fs.writeFileSync(base, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
    let publicKey;
    try { const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', base]); publicKey = stdout.trim(); }
    catch (e) { const er = new Error('Invalid private key, or it is passphrase-protected (not supported)'); er.statusCode = 400; throw er; }
    fs.writeFileSync(base + '.pub', publicKey + '\n', { mode: 0o600 });
    const fingerprint = await fingerprintOf(base + '.pub');
    const type = /ed25519/i.test(publicKey) ? 'ed25519' : /rsa/i.test(publicKey) ? 'rsa' : 'imported';
    const info = stmts.insertSshKey.run(name.trim(), (description || '').trim() || null, type, encrypt(privateKey), publicKey, fingerprint);
    return mask(stmts.getSshKey.get(info.lastInsertRowid));
  } finally { shred(base); shred(base + '.pub'); }
}

// Decrypt + write the private key to a temp 0600 file for a single SSH/git operation. Caller MUST cleanup().
function materializeToTemp(id) {
  const row = stmts.getSshKey.get(id);
  if (!row) { const e = new Error('SSH key not found'); e.statusCode = 404; throw e; }
  const file = tmpName();
  let priv = decrypt(row.private_key);
  if (!priv.endsWith('\n')) priv += '\n';
  fs.writeFileSync(file, priv, { mode: 0o600 });
  return { path: file, cleanup: () => shred(file), row };
}

module.exports = { generate, importKey, materializeToTemp, mask };
