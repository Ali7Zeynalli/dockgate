// Express gate: every request that reaches it must carry a valid session cookie, else 401.
// Mounted on /api (after the open /api/auth routes) in server/index.js.
const { verifyToken, readSessionToken } = require('./session');

function requireAuth(req, res, next) {
  const uid = verifyToken(readSessionToken(req));
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  req.userId = uid;
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defense-in-depth: reject a cross-origin browser request on state-changing methods.
// (SameSite=Lax already blocks cross-site cookies; this is a second layer.)
function checkOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ error: 'cross-origin request blocked' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'bad origin' });
    }
  }
  // No Origin header (non-browser client) — allowed; the session cookie + SameSite still gate it.
  next();
}

module.exports = { requireAuth, checkOrigin };
