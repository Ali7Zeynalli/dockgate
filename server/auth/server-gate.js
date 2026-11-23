// Per-server access password (the 2nd gate on top of the DockGate login), enforced for every way into a server.
//
// A server with an access password is unlocked per DockGate session (not for everyone): this browser session typed
// the password, so this session may use it — for 12 hours, until it signs out, or until DockGate restarts. Another
// session, a new login or a restart asks again. Checked on:
//   - every API that works on the server in use (containers, compose, proxies, files, …);
//   - /api/servers/<id>/… (Server Console: security, cron, system, scripts, firewall, …);
//   - live streams over the websocket (terminals, logs, stats, events, builds, pushes).
const { readSessionToken } = require('./session');

const TTL_MS = 12 * 3600 * 1000;
const unlocked = new Map(); // session key → Map(serverId → unlockedAt)

/** A session's key: the signature part of its token (the token itself is never kept). */
function keyOf(token) { if (!token || typeof token !== 'string') return null; const i = token.lastIndexOf('.'); return i < 0 ? null : token.slice(i + 1); }
const keyOfReq = (req) => keyOf(readSessionToken(req));

function serverRow(id) { try { return require('../db').stmts.getServer.get(String(id)); } catch (e) { return null; } }
/** Does server `id` have an access password? (Local never does.) */
function isGated(id) { if (!id || id === 'local') return false; const r = serverRow(id); return !!(r && r.access_pass); }

function isUnlocked(key, id) {
  if (!isGated(id)) return true;
  const m = key && unlocked.get(key); const at = m && m.get(String(id));
  if (!at) return false;
  if (Date.now() - at > TTL_MS) { m.delete(String(id)); return false; }
  return true;
}
function unlock(key, id) { if (!key) return; if (!unlocked.has(key)) unlocked.set(key, new Map()); unlocked.get(key).set(String(id), Date.now()); }
function forget(key) { if (key) unlocked.delete(key); }
function prune() { const now = Date.now(); for (const [k, m] of unlocked) { for (const [id, at] of m) if (now - at > TTL_MS) m.delete(id); if (!m.size) unlocked.delete(k); } }
setInterval(prune, 3600 * 1000).unref();

const activeId = () => { try { return require('../docker').getActiveServerId() || 'local'; } catch (e) { return 'local'; } };
const locked = (res, id) => { const name = (serverRow(id) || {}).name || id; return res.status(403).json({ error: `This server (${name}) needs its access password in this session`, needsAccessPassword: true, serverId: id, serverName: name }); };

// APIs that work on the server in use. The others (the servers list, settings, SSH keys, help, uptime, templates,
// schedules, the fleet views) do not touch a server's Docker or files.
const ACTIVE_SCOPED = /^\/(containers|images|builds|volumes|networks|compose|git-connect|proxies|swarm|files|system|cleanup|databases|tasks|dashboard)(\/|$)/;
// /api/servers/<id> itself (details, edit with its own check, delete) and these are not the server's insides
const SERVER_OPEN = new Set(['active', 'test', 'local']);
// health numbers shown for every server on the dashboards (no control, no files): not behind the gate
const OPEN_SUB = /^(host\/metrics|host\/stats|alerts|docker\/summary)$/;

/** Express middleware, mounted on /api after the login check. */
function requireServerGate(req, res, next) {
  const p = req.path;
  const m = p.match(/^\/servers\/([^/]+)\/(.+)$/);
  if (m && !SERVER_OPEN.has(m[1]) && m[2] !== 'unlock' && !OPEN_SUB.test(m[2])) {
    if (!isUnlocked(keyOfReq(req), m[1])) return locked(res, m[1]);
    return next();
  }
  if (ACTIVE_SCOPED.test(p)) { const id = activeId(); if (!isUnlocked(keyOfReq(req), id)) return locked(res, id); }
  next();
}

// Websocket events that open something on a server: the target is payload.serverId, else the server in use
const SOCKET_SCOPED = new Set(['image:push', 'build:start', 'logs:subscribe', 'stats:subscribe', 'events:subscribe', 'terminal:start', 'hostterm:start']);
/** socket.use() packet middleware: a locked server answers "gate:locked" instead of opening the stream. */
function socketGate(socket) {
  const key = keyOf(readSessionToken({ headers: socket.handshake.headers }));
  return ([event, payload], next) => {
    if (!SOCKET_SCOPED.has(event)) return next();
    const id = (payload && payload.serverId) || activeId();
    if (isUnlocked(key, id)) return next();
    socket.emit('gate:locked', { event, serverId: id, error: `This server (${(serverRow(id) || {}).name || id}) needs its access password in this session` });
    return next(new Error('access password needed'));
  };
}

module.exports = { keyOf, keyOfReq, isGated, isUnlocked, unlock, forget, requireServerGate, socketGate, TTL_MS, _unlocked: unlocked };
