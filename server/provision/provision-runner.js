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
// The running job for a server, if any (one provisioning run per server at a time — two parallel runs
// would fight over the package manager lock).
function runningJobFor(serverId) {
  for (const j of provisionJobs.values()) if (j.serverId === serverId && j.status === 'running') return j;
  return null;
}

function startProvision(server, opts = {}) {
  const busy = runningJobFor(server.id);
  if (busy) { const e = new Error('Provisioning is already running on this server — wait for it to finish or cancel it.'); e.statusCode = 409; e.jobId = busy.id; throw e; }
  const planned = planItems(server, opts); // may throw 409
  const skipped = planned.skipped;
  // Special items run after the shell steps, as their own guarded jobs (see runSpecialItems).
  const specials = planned.itemIds.filter(id => catalog.byId[id] && catalog.byId[id].special);
  const itemIds = planned.itemIds.filter(id => !specials.includes(id));
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { id: jobId, serverId: server.id, preset: opts.preset, status: 'running', phase: 'starting', distro: null, log: '', items: [], startedAt: Date.now(), finishedAt: null, dbInserted: false, _skipped: skipped, _ip: opts.sourceIp || null, error: null, rebootRequired: false, cancelled: false, _child: null, _specials: specials };
  provisionJobs.set(jobId, job);
  gc();

  const cfg = {
    host: server.host, port: server.port, username: server.username,
    keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null, hostKey: server.host_key || null,
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
  job._child = child;
  child.stderr.on('data', () => {});
  child.on('close', () => runSpecialItems(job).then(() => finalize(job), () => finalize(job)));
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
  else if (evt.type === 'reboot-required') { job.rebootRequired = true; jobLog(job, '⚠ A reboot is required to finish applying updates'); }
  else if (evt.type === 'cancelled') { job.cancelled = true; }
}

// Deploy user (and future special items): runs after the shell steps succeeded. Skipped when DockGate
// already connects as a non-root user with a key — there is nothing to create.
async function runSpecialItems(job) {
  if (!job._specials || !job._specials.includes('deploy-user')) return;
  const label = catalog.byId['deploy-user'].label;
  const record = (state, extra = {}) => {
    job.items.push({ id: 'deploy-user', label, state, error: extra.error || null });
    try { stmts.insertProvisionItem.run(job.id, job.serverId, 'deploy-user', catalog.byId['deploy-user'].seq, label, state, null, null, null, extra.log || '', extra.durationMs || 0, extra.error || null, extra.reason || null); } catch (e) {}
  };
  if (job.error || job.cancelled || job.items.some(i => i.state === 'failed')) { record('skipped', { reason: 'earlier steps did not complete' }); return; }
  const row = stmts.getServer.get(job.serverId);
  if (!row) return;
  if (row.username !== 'root' && row.key_path) { record('present', { log: `DockGate already connects as ${row.username} with a key` }); jobLog(job, `▶ ${label}\n  ✓ already present — DockGate connects as ${row.username}`); return; }
  const t0 = Date.now();
  job.phase = 'deploy-user';
  jobLog(job, `▶ ${label}`);
  let secJobId;
  try { secJobId = require('../security/service').startDeployUser(row, { username: 'deploy' }, { sourceIp: job._ip }); }
  catch (e) { record('failed', { error: e.message }); jobLog(job, '  ✗ ' + e.message); return; }
  const runner = require('../security/runner');
  let sj;
  for (;;) {
    await new Promise(r => setTimeout(r, 500));
    sj = runner.getJob(secJobId);
    if (!sj || sj.status !== 'running') break;
  }
  for (const st of (sj ? sj.steps : [])) jobLog(job, `  ${st.state === 'done' ? '✓' : st.state === 'failed' ? '✗' : '·'} ${st.label}`);
  if (sj && sj.status === 'done') { record('verified', { durationMs: Date.now() - t0 }); jobLog(job, '  ✓ DockGate now connects as deploy (SSH key)'); }
  else record('failed', { error: (sj && sj.error) || 'deploy user failed', durationMs: Date.now() - t0 });
}

function finalize(job) {
  if (job.finishedAt) return;
  ensureRun(job, job.distro, 0);
  const ok = job.items.filter(i => i.state === 'verified' || i.state === 'present').length;
  const failed = job.items.filter(i => i.state === 'failed').length;
  job.status = job.error ? 'error' : (job.cancelled ? 'cancelled' : (failed ? 'partial' : 'done'));
  job.finishedAt = Date.now();
  job._child = null;
  try { stmts.updateProvisionRunStatus.run(job.status, ok, failed, job.error || null, job.id); } catch (e) {}
  try { stmts.appendProvisionRunLog.run(job.log, job.id); } catch (e) {}
  logAction({ server: 'local', resourceType: 'server', resourceId: job.serverId, resourceName: job.serverId, action: 'provision-finish', sourceIp: job._ip, details: { status: job.status, ok, failed } });
}

// Public view of a job (no child-process handle).
function getJob(id) {
  const j = provisionJobs.get(id);
  if (!j) return null;
  const { _child, _skipped, _ip, _specials, ...pub } = j;
  return pub;
}

// Ask a running job to stop before its next item (the current install finishes first).
function cancelJob(id) {
  const j = provisionJobs.get(id);
  if (!j) { const e = new Error('Job not found'); e.statusCode = 404; throw e; }
  if (j.status !== 'running' || !j._child) return { status: j.status };
  try { j._child.kill('SIGTERM'); } catch (e) {}
  jobLog(j, '■ Cancel requested — stopping after the current item');
  return { status: 'cancelling' };
}

// Read-only live scan — runs every catalog item's detect over SSH (isolated worker, no install, no DB).
// Resolves { distro, items:[{id,label,present,na,reason}] }. Used when the Setup UI opens.
function scanServer(server) {
  return new Promise((resolve, reject) => {
    const cfg = {
      host: server.host, port: server.port, username: server.username,
      keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null, hostKey: server.host_key || null,
      mode: 'scan', itemIds: catalog.ITEMS.map(i => i.id),
    };
    const child = execFile(process.execPath, [path.join(__dirname, 'provision-worker.js'), JSON.stringify(cfg)], { maxBuffer: 8 * 1024 * 1024 });
    const to = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('scan timed out')); }, 60000);
    let buf = '', distro = null, error = null;
    const items = [];
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch (_) { continue; }
        if (e.type === 'meta') distro = e.distro;
        else if (e.type === 'scan-item') items.push({ id: e.id, label: e.label, present: !!e.present, na: !!e.na, reason: e.reason || null });
        else if (e.type === 'scan-done') distro = e.distro || distro;
        else if (e.type === 'fatal') error = e.error;
      }
    });
    child.on('close', () => { clearTimeout(to); if (error && !items.length) return reject(new Error(error)); resolve({ distro, items, error }); });
    child.on('error', (err) => { clearTimeout(to); reject(err); });
  });
}

module.exports = { startProvision, planItems, getJob, cancelJob, runningJobFor, scanServer };
