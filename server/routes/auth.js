// Auth endpoints — open (not behind requireAuth): first-run setup, login, logout, status.
// The admin password (scrypt hash + salt) and the setup flag live in the settings table.
const express = require('express');
const router = express.Router();
const { stmts } = require('../db');
const { hashPassword, verifyPassword } = require('../auth/password');
const { issueToken, verifyToken, serializeSessionCookie, clearSessionCookie, readSessionToken } = require('../auth/session');
const { logAction } = require('../audit');

const MIN_PASSWORD_LEN = 8;

function getSetting(key) { return stmts.getSetting.get(key)?.value; }
function isSetupDone() { return getSetting('admin_setup_done') === 'true'; }

// In-memory login/setup rate limit per source IP (req.ip is correct — trust proxy is ON in index.js).
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 10;
const rlHits = new Map(); // ip -> { count, resetAt }
function rateLimited(req, res) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = rlHits.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + RL_WINDOW_MS }; rlHits.set(ip, rec); }
  rec.count++;
  if (rec.count > RL_MAX) { res.status(429).json({ error: 'Too many attempts — try again later' }); return true; }
  return false;
}
function clearRateLimit(req) { rlHits.delete(req.ip || 'unknown'); }

// GET /api/auth/status — used by the SPA on boot to decide setup vs login vs panel.
router.get('/status', (req, res) => {
  const uid = verifyToken(readSessionToken(req));
  res.json({ authenticated: !!uid, setupDone: isSetupDone() });
});

// POST /api/auth/setup — first-run only: set the admin password. Auto-logs-in on success.
router.post('/setup', (req, res) => {
  if (rateLimited(req, res)) return;
  if (isSetupDone()) return res.status(409).json({ error: 'Already configured' });
  const { password } = req.body || {};
  if (!password || String(password).length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  const { salt, hash } = hashPassword(String(password));
  stmts.setSetting.run('auth_salt', salt);
  stmts.setSetting.run('auth_password_hash', hash);
  stmts.setSetting.run('admin_setup_done', 'true');
  logAction({ req, server: 'local', resourceType: 'system', resourceName: 'auth', action: 'auth_setup' });
  res.setHeader('Set-Cookie', serializeSessionCookie(issueToken('admin')));
  res.json({ success: true });
});

// POST /api/auth/login — verify the password, set the session cookie.
router.post('/login', (req, res) => {
  if (rateLimited(req, res)) return;
  if (!isSetupDone()) return res.status(409).json({ error: 'Setup required' });
  const { password } = req.body || {};
  const ok = password && verifyPassword(String(password), getSetting('auth_salt'), getSetting('auth_password_hash'));
  if (!ok) {
    logAction({ req, server: 'local', resourceType: 'system', resourceName: 'auth', action: 'login_failed' });
    return res.status(401).json({ error: 'Incorrect password' });
  }
  clearRateLimit(req);
  res.setHeader('Set-Cookie', serializeSessionCookie(issueToken('admin')));
  logAction({ req, server: 'local', resourceType: 'system', resourceName: 'auth', action: 'login' });
  res.json({ success: true });
});

// POST /api/auth/logout — clear the session cookie.
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ success: true });
});

// POST /api/auth/change-password — requires a valid session; verify the current password, set a new one.
// (This route lives in the open /api/auth router, so it checks the session itself.)
router.post('/change-password', (req, res) => {
  const uid = verifyToken(readSessionToken(req));
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  if (rateLimited(req, res)) return;
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !verifyPassword(String(currentPassword), getSetting('auth_salt'), getSetting('auth_password_hash'))) {
    logAction({ req, server: 'local', resourceType: 'system', resourceName: 'auth', action: 'password_change_failed' });
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || String(newPassword).length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  const { salt, hash } = hashPassword(String(newPassword));
  stmts.setSetting.run('auth_salt', salt);
  stmts.setSetting.run('auth_password_hash', hash);
  clearRateLimit(req);
  logAction({ req, server: 'local', resourceType: 'system', resourceName: 'auth', action: 'password_change' });
  // Re-issue the session cookie so the current device stays logged in after the change.
  res.setHeader('Set-Cookie', serializeSessionCookie(issueToken(uid)));
  res.json({ success: true });
});

module.exports = router;
