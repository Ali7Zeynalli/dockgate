// Runs security worker processes: one-shot reads, and mutating "plans" tracked as pollable jobs.
// One mutating job per server at a time (two parallel sshd/firewall edits could race each other's
// backups and rollback timers).
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const jobs = new Map(); // id -> job
const TTL_MS = 30 * 60 * 1000;
const WORKER = path.join(__dirname, 'worker.js');

function workerCfg(server) {
  return {
    host: server.host, port: server.port, username: server.username,
    keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null,
    hostKey: server.host_key || null,
  };
}

/** Run a read script; resolves the raw output text. Rejects with the worker's error. */
function read(server, script) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [WORKER, JSON.stringify({ ...workerCfg(server), mode: 'read', script })], { maxBuffer: 16 * 1024 * 1024, timeout: 90000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || 'read failed').trim()));
      try { resolve(JSON.parse(stdout).out); } catch (e) { reject(new Error('bad worker output')); }
    });
    child.on('error', reject);
  });
}

function gc() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > TTL_MS) jobs.delete(id);
}

function runningFor(serverId) {
  for (const j of jobs.values()) if (j.serverId === serverId && j.status === 'running') return j;
  return null;
}

/**
 * Start a plan as a job. hooks.onSuccess(job) / hooks.onFailure(job) run in the main process after the
 * worker ends (e.g. switch DockGate's connection, update the stored port). Returns the job id.
 */
function startPlan(server, plan, { title, onSuccess, onFailure, successText } = {}) {
  const busy = runningFor(server.id);
  if (busy) { const e = new Error(`"${busy.title}" is still running on this server — wait for it to finish.`); e.statusCode = 409; throw e; }
  gc();
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, serverId: server.id, title: title || 'Change', status: 'running', error: null, rolledBack: null, result: null, successText: successText || null,
    steps: plan.steps.map(s => ({ label: s.label, state: 'pending', out: null })),
    startedAt: Date.now(), finishedAt: null,
  };
  jobs.set(id, job);
  // test steps never carry free text — only connection parameters
  const child = execFile(process.execPath, [WORKER, JSON.stringify({ ...workerCfg(server), mode: 'plan', plan })], { maxBuffer: 16 * 1024 * 1024 });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (e.type === 'step' && job.steps[e.i]) { job.steps[e.i].state = e.state; if (e.out) job.steps[e.i].out = e.out; if (e.state === 'failed') job.error = e.out; }
      else if (e.type === 'rolledback') job.rolledBack = !!e.ok;
      else if (e.type === 'end') job._ok = !!e.ok;
      else if (e.type === 'fatal') job.error = e.error;
    }
  });
  child.stderr.on('data', () => {});
  const finish = async () => {
    if (job.finishedAt) return;
    const ok = job._ok === true && !job.error;
    try {
      if (ok && onSuccess) job.result = (await onSuccess(job)) || null;
      if (!ok && onFailure) await onFailure(job);
    } catch (e) { job.error = job.error || e.message; }
    job.status = ok && !job.error ? 'done' : 'failed';
    if (job.status === 'failed' && !job.error) job.error = 'Failed';
    job.finishedAt = Date.now();
  };
  child.on('close', finish);
  child.on('error', (e) => { job.error = e.message; finish(); });
  return id;
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { _ok, ...pub } = j;
  return pub;
}

module.exports = { read, startPlan, getJob, runningFor };

/** Start a plan and resolve with the finished job (for short operations answered in one request). */
function runAndWait(server, plan, opts = {}) {
  const id = startPlan(server, plan, opts);
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const j = jobs.get(id);
      if (j && j.finishedAt) { clearInterval(t); resolve(getJob(id)); }
    }, 150);
  });
}

module.exports.runAndWait = runAndWait;
