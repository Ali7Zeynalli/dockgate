// Keys of the agent command channel. Each agent install gets its own Ed25519 key pair: the private key stays in
// DockGate (encrypted at rest like every other secret), the agent only gets the public key. Every command and
// rules file DockGate sends is signed; the agent checks the signature, the server id, that the sequence number
// grows, and (for commands) that it is fresh. A stolen server holds no key that can command anything.
const crypto = require('crypto');
const { db } = require('../db');
const secrets = require('../auth/secrets');

db.exec(`CREATE TABLE IF NOT EXISTS agent_keys (
  server_id TEXT PRIMARY KEY, public_pem TEXT NOT NULL, private_enc TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, rotated_at INTEGER
)`);
const q = {
  get: db.prepare('SELECT * FROM agent_keys WHERE server_id = ?'),
  put: db.prepare('INSERT INTO agent_keys (server_id, public_pem, private_enc, seq, created_at, rotated_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(server_id) DO UPDATE SET public_pem = excluded.public_pem, private_enc = excluded.private_enc, seq = 0, rotated_at = excluded.rotated_at'),
  // Never below the clock (ms): a DockGate restored from an older backup still sends numbers the agent takes.
  bump: db.prepare('UPDATE agent_keys SET seq = MAX(seq + 1, ?) WHERE server_id = ? RETURNING seq'),
  del: db.prepare('DELETE FROM agent_keys WHERE server_id = ?'),
};

/** Make a new key pair for a server (on install, or to rotate). Returns the public key (PEM). */
function createKeyPair(serverId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = Date.now();
  q.put.run(serverId, pub, secrets.encrypt(priv), now, now);
  return pub;
}
/** The public key of a server, creating the pair on first use. */
function publicKeyFor(serverId) { const r = q.get.get(serverId); return r ? r.public_pem : createKeyPair(serverId); }
function hasKey(serverId) { return !!q.get.get(serverId); }
function forget(serverId) { q.del.run(serverId); }

/**
 * Sign a message for one server. kind: 'cmd' | 'rules'. Returns { payload, sig } — payload is the exact JSON text
 * that was signed: { v: 1, kind, serverId, seq, issuedAt, body }.
 */
function sign(serverId, kind, body) {
  const row = q.get.get(serverId);
  if (!row) throw Object.assign(new Error('This agent has no key yet — update the agent (Servers → Edge agent)'), { statusCode: 409 });
  const { seq } = q.bump.get(Date.now(), serverId);
  const payload = JSON.stringify({ v: 1, kind, serverId, seq, issuedAt: Date.now(), body });
  const key = crypto.createPrivateKey(secrets.decryptStrict(row.private_enc));
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
  return { payload, sig };
}

module.exports = { createKeyPair, publicKeyFor, hasKey, forget, sign };
