// Which proxies may tell DockGate the real client IP (X-Forwarded-For). One setting for HTTP (Express
// `trust proxy`) AND WebSocket handshakes, so the login rate limit and the audit IP cannot be spoofed.
//
// TRUST_PROXY (env), same values as Express:
//   unset / "false"      — trust nobody (default): the IP is the TCP peer. Use when DockGate is reached directly.
//   "loopback"           — a reverse proxy on the same host (nginx/caddy/traefik on 127.0.0.1)
//   "uniquelocal"        — a proxy on a private network (10/8, 172.16/12, 192.168/16, fc00::/7)
//   "10.0.0.5,10.0.0.6"  — specific proxy addresses / CIDRs
//   "1", "2", …          — trust that many hops
//   "true"               — trust every hop (only when DockGate is NEVER reachable without the proxy)
const proxyaddr = require('proxy-addr');

function parseTrustProxy(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

const setting = parseTrustProxy(process.env.TRUST_PROXY);
const trustFn = setting === true ? () => true
  : setting === false ? () => false
  : typeof setting === 'number' ? (addr, i) => i < setting
  : proxyaddr.compile(setting);

/** Client IP of a Socket.IO handshake, honouring the same trust setting as Express. */
function socketClientIp(handshake) {
  if (!handshake) return null;
  const fakeReq = { headers: handshake.headers || {}, connection: { remoteAddress: handshake.address }, socket: { remoteAddress: handshake.address } };
  try { return proxyaddr(fakeReq, trustFn); } catch (e) { return handshake.address || null; }
}

module.exports = { setting, parseTrustProxy, socketClientIp };
