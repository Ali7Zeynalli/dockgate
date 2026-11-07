// SSH host key pinning (trust-on-first-use, then enforced).
//
// The first successful connection to a server records its host key fingerprint in the servers table.
// Every later ssh2 connection — in the main process AND in the isolated worker processes — refuses to
// talk to a host that presents a different key, so a man-in-the-middle cannot capture the stored
// password / sudo commands. A rebuilt server legitimately changes its key: the admin re-trusts it in
// Server Console → Access & SSH, which clears the pin (the next connection pins the new key).
//
// Workers have no DB access, so the parent passes the expected fingerprint in their config
// (cfg.hostKey) and the worker only enforces it (strictVerifier). Pinning itself happens in the main
// process (verifierFor) — on the connection test, the SSH pool, the terminal, the Docker client, etc.
const crypto = require('crypto');

/** OpenSSH-style SHA256 fingerprint of a raw (wire format) host key. */
function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

/** Key algorithm name from a raw host key blob (first SSH string), e.g. "ssh-ed25519". */
function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    if (len > 0 && len < 64) return keyBuf.slice(4, 4 + len).toString('ascii');
  } catch (e) { /* fall through */ }
  return 'unknown';
}

/** Short display name for a key type ("ssh-ed25519" → "ED25519"). */
function keyTypeLabel(type) {
  const t = String(type || '');
  if (t === 'ssh-ed25519') return 'ED25519';
  if (t === 'ssh-rsa') return 'RSA';
  if (t.startsWith('ecdsa-')) return 'ECDSA';
  return t.toUpperCase() || 'UNKNOWN';
}

/** Error raised (via ssh2) when the presented host key does not match the pinned one. */
const MISMATCH_MESSAGE = 'Host key mismatch — this server presented a different SSH host key than the one DockGate pinned. If you rebuilt or reinstalled the server, re-trust it in Server Console → Access & SSH; otherwise do NOT connect (possible man-in-the-middle).';

/**
 * ssh2 `hostVerifier` for the MAIN process. Pins on first use, enforces afterwards.
 * `server` may lack an id (connection test before the server is saved) → accept, nothing to pin to.
 * Returns the verifier function; `onMismatch` (optional) is called with the observed fingerprint.
 */
function verifierFor(server, onMismatch) {
  return (key) => {
    const fp = fingerprint(key);
    if (!server || !server.id || server.id === 'local') return true;
    let row;
    try { row = require('./db').stmts.getServer.get(server.id); } catch (e) { return true; }
    if (!row) return true; // not saved yet (test before add)
    if (!row.host_key) {
      try { require('./db').stmts.setServerHostKey.run(fp, key.toString('base64'), server.id); } catch (e) { /* pin best-effort */ }
      return true;
    }
    if (row.host_key === fp) return true;
    if (typeof onMismatch === 'function') { try { onMismatch(fp, row.host_key); } catch (e) {} }
    console.warn(`[ssh-hostkey] ${server.id}: host key mismatch (pinned ${row.host_key}, presented ${fp}) — connection refused`);
    return false;
  };
}

/** ssh2 `hostVerifier` for WORKER processes: enforce `expected` when set; no pin → accept. */
function strictVerifier(expected) {
  return (key) => !expected || fingerprint(key) === expected;
}

/** A known_hosts line for the pinned key (for the OpenSSH CLI), or null when nothing is pinned yet. */
function knownHostsLine(server) {
  if (!server || !server.host_key_blob) return null;
  const blob = Buffer.from(server.host_key_blob, 'base64');
  const port = Number(server.port || 22);
  const hostPart = port === 22 ? server.host : `[${server.host}]:${port}`;
  return `${hostPart} ${keyType(blob)} ${server.host_key_blob}`;
}

/** True when an error came from a refused (mismatching) host key. */
function isHostKeyError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  return /host denied|host key mismatch/.test(m);
}

module.exports = { fingerprint, keyType, keyTypeLabel, verifierFor, strictVerifier, knownHostsLine, isHostKeyError, MISMATCH_MESSAGE };
