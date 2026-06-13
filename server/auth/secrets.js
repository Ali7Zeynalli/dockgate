// At-rest encryption for stored secrets (SSH passwords/passphrases, registry passwords) using
// AES-256-GCM. No external dependency. The master key comes from env DG_MASTER_KEY (64 hex chars),
// else a random key is generated once and persisted to data/.master.key (mode 0600).
//
// Format:  enc:v1:<ivHex>:<tagHex>:<ciphertextHex>
// Both functions are IDEMPOTENT: encrypt() leaves already-encrypted values untouched; decrypt()
// passes plaintext (no enc: prefix) straight through — so a half-migrated DB never breaks.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

let _key = null;
function getKey() {
  if (_key) return _key;
  if (process.env.DG_MASTER_KEY) {
    const k = Buffer.from(process.env.DG_MASTER_KEY, 'hex');
    if (k.length !== 32) throw new Error('DG_MASTER_KEY must be 32 bytes (64 hex chars)');
    _key = k;
    return _key;
  }
  const keyFile = path.join(DATA_DIR, '.master.key');
  try {
    if (fs.existsSync(keyFile)) {
      const k = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
      if (k.length === 32) { _key = k; return _key; }
    }
  } catch (e) { /* fall through to generate */ }
  _key = crypto.randomBytes(32);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(keyFile, _key.toString('hex'), { mode: 0o600 });
  } catch (e) { console.warn('[secrets] could not persist master key, using in-memory:', e.message); }
  return _key;
}

function isEncrypted(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

/** Encrypt a string. Empty/null and already-encrypted values are returned unchanged (idempotent). */
function encrypt(plain) {
  if (plain == null || plain === '' || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + ct.toString('hex');
}

/** Decrypt a value. Non-encrypted (plaintext / null) values pass through unchanged (idempotent). */
function decrypt(value) {
  if (!isEncrypted(value)) return value;
  try {
    const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(':');
    if (!ivHex || !tagHex || !dataHex) return value;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    // Wrong key / corrupt value — return as-is rather than crash the auth path.
    return value;
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
