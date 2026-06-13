// Express gate: every request that reaches it must carry a valid session cookie, else 401.
// Mounted on /api (after the open /api/auth routes) in server/index.js.
const { verifyToken, readSessionToken } = require('./session');

function requireAuth(req, res, next) {
  const uid = verifyToken(readSessionToken(req));
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  req.userId = uid;
  next();
}

module.exports = { requireAuth };
