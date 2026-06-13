// Provisioning job runner — owns the in-memory job registry (live log / status), spawns the isolated
// worker, and persists each completed item + the run outcome to SQLite. Mirrors the deploy-job pattern
// (compose.js): the run keeps going if the browser closes; clients poll GET /provision/job/:id.
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const catalog = require('./catalog');

const provisionJobs = new Map(); // jobId -> job
const TTL_MS = 30 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, j] of provisionJobs) if (j.finishedAt && now - j.finishedAt > TTL_MS) provisionJobs.delete(id);
}

function jobLog(job, line) { job.log += line + '\n'; }

// Resolve the items for a request and apply the lockout/risk guards (pure logic lives in catalog).
// Throws statusCode 409 (with .risks) when high-risk items need explicit confirmation.
function planItems(server, { preset, only, confirm } = {}) {
  return catalog.guardedResolve({ hasKey: !!server.key_path, preset, only, confirm });
}

// server: a prepared config { id, host, port, username, key_path, keyPath, password, passphrase } —
// keyPath absolute + secrets decrypted by the caller (route).
function startProvision(server, opts = {}) {
  const { itemIds, skipped } = planItems(server, opts); // may throw 409
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { id: jobId, serverId: server.id, preset: opts.preset, status: 'running', phase: 'starting', distro: null, log: '', items: [], startedAt: Date.now(), finishedAt: null, dbInserted: false, _skipped: skipped, _ip: opts.sourceIp || null, error: null };
  provisionJobs.set(jobId, job);
  gc();

  const cfg = {
    host: server.host, port: server.port, username: server.username,
    keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null,
    itemIds,
  };

  let buf = '';
  const child = execFile(process.execPath, [path.join(__dirname, 'provision-worker.js'), JSON.stringify(cfg)], { maxBuffer: 16 * 1024 * 1024 });
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) { try { handleEvent(job, JSON.parse(line)); } catch (e) { /* ignore non-JSON */ } }
    }
  });
  child.stderr.on('data', () => {});
  child.on('close', (code) => finalize(job));
  child.on('error', (err) => { jobLog(job, 'worker error: ' + err.message); job.error = job.error || err.message; finalize(job); });

  return { jobId, runId: jobId };
}

function ensureRun(job, distro, total) {
  if (job.dbInserted) return;
  job.dbInserted = true;
  try {
    stmts.insertProvisionRun.run(job.id, job.serverId, job.preset, distro || null, 'running', total || 0, job._ip);
    for (const s of (job._skipped || [])) {
      stmts.insertProvisionItem.run(job.id, job.serverId, s.id, catalog.byId[s.id] ? catalog.byId[s.id].seq : 0, s.label, 'skipped', null, null, null, '', 0, null, s.reason);
      job.items.push({ id: s.id, label: s.label, state: 'skipped', reason: s.reason });
    }
    logAction({ server: 'local', resourceType: 'server', resourceId: job.serverId, resourceName: job.serverId, action: 'provision-start', sourceIp: job._ip, details: { preset: job.preset, distro: distro || null, total: total || 0 } });
  } catch (e) { jobLog(job, '[db] ' + e.message); }
}

function handleEvent(job, evt) {
  if (evt.type === 'meta') { job.distro = evt.distro; ensureRun(job, evt.distro, evt.total); }
  else if (evt.type === 'log') { jobLog(job, evt.line); }
  else if (evt.type === 'item') {
    ensureRun(job, job.distro, 0);
    job.phase = evt.id;
    job.items.push({ id: evt.id, label: evt.label, state: evt.state, error: evt.error || null });
    try {
      stmts.insertProvisionItem.run(job.id, job.serverId, evt.id, catalog.byId[evt.id] ? catalog.byId[evt.id].seq : 0, evt.label || evt.id, evt.state, evt.detect || null, evt.install || null, evt.verify || null, evt.log || '', evt.durationMs || 0, evt.error || null, evt.reason || null);
    } catch (e) { jobLog(job, '[db] ' + e.message); }
  }
  else if (evt.type === 'fatal') { job.error = evt.error; jobLog(job, '✗ ' + evt.error); }
}

function finalize(job) {
  if (job.finishedAt) return;
  ensureRun(job, job.distro, 0);
  const ok = job.items.filter(i => i.state === 'verified' || i.state === 'present').length;
  const failed = job.items.filter(i => i.state === 'failed').length;
  job.status = job.error ? 'error' : (failed ? 'partial' : 'done');
  job.finishedAt = Date.now();
  try { stmts.updateProvisionRunStatus.run(job.status, ok, failed, job.error || null, job.id); } catch (e) {}
  try { stmts.appendProvisionRunLog.run(job.log, job.id); } catch (e) {}
  logAction({ server: 'local', resourceType: 'server', resourceId: job.serverId, resourceName: job.serverId, action: 'provision-finish', sourceIp: job._ip, details: { status: job.status, ok, failed } });
}

function getJob(id) { return provisionJobs.get(id); }

module.exports = { startProvision, planItems, getJob };
