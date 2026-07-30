// Per-server SSH connection POOL — the FileZilla model: connect once, reuse the session for many ops,
// keep it warm with keepalives, and reconnect when it dies. Replaces the old "new Client() per operation"
// design (a full SSH handshake per list/mkdir/file). A bounded pool of K warm connections gives parallel
// throughput while staying well under a typical sshd's MaxStartups/MaxSessions.
//
// A "lease" is one live ssh2 Client with its single SFTP channel already open. Callers borrow a lease
// (acquire), use lease.sftp, and return it (release) — or destroy it on a transport error.
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { decrypt } = require('./auth/secrets');

const SSH_KEYS_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');
const POOL_MAX = 8;               // max live connections per server (the real concurrency cap — a few, FileZilla-style)
const IDLE_TTL_MS = 60 * 1000;    // close a connection left idle this long
const ACQUIRE_TIMEOUT_MS = 25000; // fail a borrow if no connection frees up in time (never hang forever)
const CONNECT_OPTS = { readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3 };

// Build ssh2 connect options from a server row (same auth as host-terminal.js/docker.js). Throws (sync) on a
// missing key file or a decrypt failure — callers wrap this so the throw rejects the borrower, never escapes.
function authFor(s) {
  const opts = { host: s.host, port: s.port || 22, username: s.username, ...CONNECT_OPTS };
  if (s.key_path) {
    const keyPath = path.isAbsolute(s.key_path) ? s.key_path : path.join(SSH_KEYS_DIR, s.key_path);
    if (!fs.existsSync(keyPath)) throw new Error(`SSH key not found: ${keyPath}`);
    opts.privateKey = fs.readFileSync(keyPath);
    if (s.passphrase) opts.passphrase = decrypt(s.passphrase);
  } else if (s.password) {
    opts.password = decrypt(s.password);
  }
  return opts;
}

// Pool key includes the server id AND its auth material, so editing host/port/user/key/password transparently
// misses the stale pool entry (belt) and invalidate(serverId) drops it explicitly (suspenders).
function keyOf(s) {
  return [s.id, s.host, s.port || 22, s.username, s.key_path || '', s.password ? 'pw' : 'nopw'].join('|');
}

const pools = new Map(); // key -> { idle:[lease], busy:Set<lease>, waiters:[{resolve,reject,server,timer}], creating:int }
function poolFor(key) {
  let p = pools.get(key);
  if (!p) { p = { idle: [], busy: new Set(), waiters: [], creating: 0 }; pools.set(key, p); }
  return p;
}

// Open one connection + its SFTP channel. Lifecycle listeners are attached ONCE here (an ssh2 Client with no
// 'error' listener crashes Node on any mid-session drop); they flip lease.alive so a dead lease is never reused.
function createLease(key, server) {
  return new Promise((resolve, reject) => {
    let opts; try { opts = authFor(server); } catch (e) { return reject(e); }
    const conn = new Client();
    const lease = { conn, sftp: null, key, alive: true, idleTimer: null };
    let settled = false;
    conn.on('error', (e) => { lease.alive = false; if (!settled) { settled = true; reject(e); } });
    conn.on('close', () => { lease.alive = false; });
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { lease.alive = false; try { conn.end(); } catch (e) {} if (!settled) { settled = true; reject(err); } return; }
        lease.sftp = sftp;
        sftp.on('error', () => { lease.alive = false; });
        sftp.on('close', () => { lease.alive = false; });
        if (!settled) { settled = true; resolve(lease); }
      });
    });
    try { conn.connect(opts); } catch (e) { lease.alive = false; if (!settled) { settled = true; reject(e); } }
  });
}

function endLease(lease) { try { lease.conn.end(); } catch (e) {} try { lease.conn.destroy && lease.conn.destroy(); } catch (e) {} }

// Serve queued waiters by creating fresh leases up to POOL_MAX (called after a slot frees via destroy).
function serveWaiters(p) {
  while (p.waiters.length && p.busy.size + p.creating < POOL_MAX) {
    const w = p.waiters.shift(); clearTimeout(w.timer);
    p.creating++;
    createLease(w.key, w.server)
      .then((lease) => { p.busy.add(lease); w.resolve(lease); })
      .catch((e) => w.reject(e))
      .finally(() => { p.creating--; serveWaiters(p); });
  }
}

async function acquire(server) {
  const key = keyOf(server);
  const p = poolFor(key);
  // reuse a healthy idle lease
  while (p.idle.length) {
    const lease = p.idle.pop();
    if (lease.idleTimer) { clearTimeout(lease.idleTimer); lease.idleTimer = null; }
    if (lease.alive) { p.busy.add(lease); return lease; }
    endLease(lease);
  }
  // create a new one if under the cap
  if (p.busy.size + p.creating < POOL_MAX) {
    p.creating++;
    try { const lease = await createLease(key, server); p.busy.add(lease); return lease; }
    finally { p.creating--; }
  }
  // otherwise wait (FIFO) for a release, with a timeout so a wedged server never hangs a request forever
  return await new Promise((resolve, reject) => {
    const w = { resolve, reject, server, key, timer: null };
    w.timer = setTimeout(() => { const i = p.waiters.indexOf(w); if (i >= 0) p.waiters.splice(i, 1); reject(new Error('Timed out waiting for an SSH connection')); }, ACQUIRE_TIMEOUT_MS);
    p.waiters.push(w);
  });
}

function release(lease) {
  const p = pools.get(lease.key);
  if (!p) { endLease(lease); return; }
  p.busy.delete(lease);
  if (lease.alive && p.waiters.length) { const w = p.waiters.shift(); clearTimeout(w.timer); p.busy.add(lease); w.resolve(lease); return; }
  if (!lease.alive) { endLease(lease); serveWaiters(p); return; }
  p.idle.push(lease);
  lease.idleTimer = setTimeout(() => { const i = p.idle.indexOf(lease); if (i >= 0) { p.idle.splice(i, 1); endLease(lease); } }, IDLE_TTL_MS);
}

function destroyLease(lease) {
  const p = pools.get(lease.key);
  lease.alive = false;
  endLease(lease);
  if (p) { p.busy.delete(lease); serveWaiters(p); }
}

// A transport-level failure means the connection is dead → destroy the lease. Application errors (ENOENT,
// permission, mkdir-already-exists, 409) leave the connection healthy → just release it. The lease.alive flag
// (set by the conn/sftp listeners) is the real guard, so a misclassification here is still safe on next acquire.
function isTransportError(e) {
  if (!e || e.name === 'AuthError') return false;
  return /econnreset|epipe|not connected|no sftp|no response|channel|socket|closed|disconnect|timed out|timeout|broken/i.test(String(e.message || ''));
}

// Drop-in replacement for the old file-manager withSftp: borrow a lease, run fn(sftp), return it. Retries ONCE
// on a transport error with a fresh lease (safe only for idempotent metadata ops — NOT used by streaming ops).
async function withSftp(server, fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = await acquire(server);
    try { const v = await fn(lease.sftp); release(lease); return v; }
    catch (e) {
      lastErr = e;
      if (isTransportError(e)) { destroyLease(lease); continue; } // retry with a fresh connection
      release(lease); throw e;
    }
  }
  throw lastErr;
}

// Drop all pooled connections for a server (call on server edit/delete so a live connection can't keep talking
// to the OLD host/credentials). In-use leases are marked dead so they're destroyed on release.
function invalidate(serverId) {
  for (const [key, p] of [...pools]) {
    if (key.split('|')[0] !== String(serverId)) continue;
    p.idle.forEach((l) => { if (l.idleTimer) clearTimeout(l.idleTimer); endLease(l); });
    p.busy.forEach((l) => { l.alive = false; });
    p.waiters.forEach((w) => { clearTimeout(w.timer); w.reject(new Error('Server connection was invalidated')); });
    pools.delete(key);
  }
}

// Close every connection (call on process shutdown so DockGate leaves no zombie SSH sessions on hosts).
function drainAll() {
  for (const [, p] of pools) { [...p.idle, ...p.busy].forEach(endLease); p.waiters.forEach((w) => { clearTimeout(w.timer); try { w.reject(new Error('shutting down')); } catch (e) {} }); }
  pools.clear();
}

module.exports = { withSftp, acquire, release, destroyLease, isTransportError, invalidate, drainAll, authFor, POOL_MAX };
