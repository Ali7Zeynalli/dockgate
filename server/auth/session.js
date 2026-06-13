// Stateless session tokens for the admin login — an HMAC-signed cookie, no external dependency.
// Token format:  base64url(JSON{uid,exp}) "." base64url(HMAC-SHA256(payload))
// The signing secret is taken from env DG_SESSION_SECRET, else a random one is generated once and
// persisted in the settings table (key: session_secret) so tokens survive restarts.
const crypto = require('crypto');

const COOKIE_NAME = 'dg_session';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _secret = null;

// Resolve (and lazily create) the server-side signing secret.
function getSecret() {
  if (_secret) return _secret;
  if (process.env.DG_SESSION_SECRET) { _secret = String(process.env.DG_SESSION_SECRET); return _secret; }
  // late require — avoid load-order coupling with db.js
  const { stmts } = require('../db');
  let s = stmts.getSetting.get('session_secret')?.value;
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    stmts.setSetting.run('session_secret', s);
  }
  _secret = s;
  return s;
}

function sign(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Issue a signed session token for a user id. */
function issueToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: String(userId), exp: Date.now() + TOKEN_TTL_MS }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Verify a token's signature + expiry. Returns the user id, or null if invalid/expired. */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.exp || Date.now() > data.exp) return null;
    return data.uid || null;
  } catch (e) { return null; }
}

// ---- Cookie helpers (HttpOnly, SameSite=Lax; Secure behind HTTPS via env) ----
const SECURE = process.env.COOKIE_SECURE === 'true';

function serializeSessionCookie(token, { maxAgeMs = TOKEN_TTL_MS } = {}) {
  const parts = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (SECURE) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (SECURE) parts.push('Secure');
  return parts.join('; ');
}

/** Read the raw session token from a request's Cookie header (no cookie-parser dependency). */
function readSessionToken(req) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return null;
}

module.exports = {
  COOKIE_NAME, TOKEN_TTL_MS,
  issueToken, verifyToken,
  serializeSessionCookie, clearSessionCookie, readSessionToken,
};
