// Central audit log helper.
// Records every mutation performed on DockGate to the `activity` table — with the context of which
// host (server) and where from (source_ip). Since there is no auth, this is a "what was done + from where"
// audit, not a "who did it" one.
//
// Usage (HTTP route):   logAction({ req, resourceType:'container', resourceId:id, resourceName:name, action:'stop', details })
// Usage (WebSocket):    logAction({ socket, resourceType:'container', resourceName:id, action:'terminal_open', server:'local' })

const { stmts } = require('./db');

// Source IP from req (req.ip is correct when Express trust-proxy is ON)
function ipFromReq(req) {
  if (!req) return null;
  const xff = req.headers && req.headers['x-forwarded-for'];
  return req.ip
    || (xff ? String(xff).split(',')[0].trim() : null)
    || (req.socket && req.socket.remoteAddress)
    || null;
}

// Source IP from socket.io handshake
function ipFromSocket(socket) {
  if (!socket || !socket.handshake) return null;
  const xff = socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : null) || socket.handshake.address || null;
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
