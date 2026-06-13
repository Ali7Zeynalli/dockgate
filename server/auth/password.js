// Password hashing for the admin login — uses Node's built-in scrypt (no external dependency).
// The hash + salt live in the settings table (auth_password_hash / auth_salt), written by first-run setup.
const crypto = require('crypto');

const KEYLEN = 64;       // scrypt output length (bytes)

/**
 * Hash a plaintext password with a fresh random salt.
 * @param {string} plain
 * @returns {{ salt: string, hash: string }} hex-encoded salt + scrypt hash
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN).toString('hex');
  return { salt, hash };
}

/**
 * Constant-time verify a plaintext password against a stored salt+hash.
 * @returns {boolean}
 */
function verifyPassword(plain, salt, hash) {
  if (!salt || !hash) return false;
  let expected;
  try { expected = Buffer.from(hash, 'hex'); } catch (e) { return false; }
  const candidate = crypto.scryptSync(String(plain), salt, KEYLEN);
  // Length mismatch would make timingSafeEqual throw — guard first (still constant per-branch).
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };
