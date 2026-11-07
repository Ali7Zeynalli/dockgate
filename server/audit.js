// Central audit log helper.
// Records every mutation performed on DockGate to the `activity` table — with the context of which
// host (server) and where from (source_ip). Since there is no auth, this is a "what was done + from where"
// audit, not a "who did it" one.
//
// Usage (HTTP route):   logAction({ req, resourceType:'container', resourceId:id, resourceName:name, action:'stop', details })
// Usage (WebSocket):    logAction({ socket, resourceType:'container', resourceName:id, action:'terminal_open', server:'local' })

const { stmts } = require('./db');

// Source IP from req — req.ip already applies the TRUST_PROXY setting (server/trust-proxy.js). The raw
// X-Forwarded-For header is never read directly: any client can send one.
function ipFromReq(req) {
  if (!req) return null;
  return req.ip || (req.socket && req.socket.remoteAddress) || null;
}

// Source IP from a socket.io handshake, with the same proxy trust as HTTP.
function ipFromSocket(socket) {
  if (!socket || !socket.handshake) return null;
  return require('./trust-proxy').socketClientIp(socket.handshake);
}

/**
 * Write an audit record. Never throws — logging must not break the main operation.
 * If `server` is not provided, the active Docker server is picked up automatically (correct for resource operations).
 * Control-plane operations (server management, settings, self-update) must explicitly pass `server:'local'`.
 */
function logAction({
  resourceId = '',
  resourceType = 'system',
  resourceName = '',
  action,
  details = '',
  server,
  sourceIp,
  req,
  socket,
} = {}) {
  try {
    if (!action) return;
    let srv = server;
    if (srv === undefined) {
      // late require — avoid circular dependency
      try { srv = require('./docker').getActiveServerId() || 'local'; }
      catch (e) { srv = 'local'; }
    }
    const ip = sourceIp || ipFromReq(req) || ipFromSocket(socket) || null;
    const det = typeof details === 'string' ? details : JSON.stringify(details);
    stmts.logActivityFull.run(resourceId, resourceType, resourceName || resourceId, action, det, srv, ip);
  } catch (e) {
    console.warn('[audit] log failed:', e.message);
  }
}

module.exports = { logAction, ipFromReq, ipFromSocket };
