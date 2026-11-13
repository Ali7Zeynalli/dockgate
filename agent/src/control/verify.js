// Is a message really from the DockGate that installed this agent? Pure: the caller keeps the state.
// msg = { payload, sig }: payload is the signed JSON text { v, kind, serverId, seq, issuedAt, body }.
const crypto = require('crypto');

const CMD_MAX_AGE_MS = 10 * 60 * 1000;        // a command is used at once; an old one is a replay
const RULES_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // rules are state; still, a week-old file is not taken
const SKEW_MS = 5 * 60 * 1000;                 // clocks of DockGate and the server may differ a little

/**
 * state = { lastSeq }. Returns { ok: true, msg } or { ok: false, reason: 'format'|'signature'|'server'|'replay'|'stale'|'future'|'kind' }.
 */
function verify(raw, publicKeyPem, serverId, state, now = Date.now()) {
  let m;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return { ok: false, reason: 'format' }; }
  if (!m || typeof m.payload !== 'string' || typeof m.sig !== 'string' || m.payload.length > 256 * 1024) return { ok: false, reason: 'format' };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(m.payload, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(m.sig, 'base64')); } catch (e) { good = false; }
  if (!good) return { ok: false, reason: 'signature' };
  let p; try { p = JSON.parse(m.payload); } catch (e) { return { ok: false, reason: 'format' }; }
  if (p.v !== 1 || !['cmd', 'rules'].includes(p.kind)) return { ok: false, reason: 'kind' };
  if (p.serverId !== serverId) return { ok: false, reason: 'server' };
  if (!Number.isInteger(p.seq) || p.seq <= (state.lastSeq || 0)) return { ok: false, reason: 'replay' };
  if (!Number.isFinite(p.issuedAt) || p.issuedAt > now + SKEW_MS) return { ok: false, reason: 'future' };
  if (now - p.issuedAt > (p.kind === 'cmd' ? CMD_MAX_AGE_MS : RULES_MAX_AGE_MS) + SKEW_MS) return { ok: false, reason: 'stale' };
  return { ok: true, msg: p };
}

module.exports = { verify, CMD_MAX_AGE_MS };
