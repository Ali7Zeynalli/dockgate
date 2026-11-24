// Deploy > Tasks: the task files of project folders on SSH servers (Makefile, justfile, Taskfile, package.json
// scripts, *.sh, Ansible playbooks, Kamal) and runs of them - live log, dry run, variables, one run per folder
// at a time, cancel, time limit, history. Project env (encrypted) is handed to every run in a file the run
// reads and deletes, never on the command line; its secret values are masked in the log.
//   projects(serverId)          Compose project folders of the server + folders added here
//   discover(serverId, dir)     task-parse.discover of the folder
//   start(serverId, dir, spec)  a run; spec { source, name, vars, args, dry, runAs, timeoutMin } or { source: 'custom', cmd }
//   runShell(...)               the engine (used by recipes too)
const crypto = require('crypto');
const { db, stmts } = require('./db');
const remoteExec = require('./remote-compose');
const T = require('./task-parse');
const secrets = require('./auth/secrets');
const { logAction } = require('./audit');
const shq = remoteExec.shq;
const fs = require('fs');
const { spawn } = require('child_process');
const LOCAL_SH = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
/** Run a shell line on the server: over SSH, or here for the local server. Resolves { code, stdout, stderr }. */
function exec(s, cmd, onData) {
  if (!s || !s.local) return remoteExec.execRemote(s, cmd, onData);
  return new Promise((resolve) => {
    const ch = spawn(LOCAL_SH, ['-c', cmd], { env: { ...process.env } });
    let out = '', er = '';
    ch.stdout.on('data', (d) => { const t = d.toString(); out += t; if (onData) onData(t); });
    ch.stderr.on('data', (d) => { const t = d.toString(); er += t; if (onData) onData(t); });
    ch.on('error', (e) => resolve({ code: 127, stdout: out, stderr: er + e.message }));
    ch.on('close', (code) => resolve({ code: code == null ? 1 : code, stdout: out, stderr: er }));
  });
}

db.exec(`CREATE TABLE IF NOT EXISTS task_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, dir TEXT NOT NULL, name TEXT, created_at INTEGER, UNIQUE(server_id, dir))`);
db.exec(`CREATE TABLE IF NOT EXISTS task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, dir TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, cmd TEXT,
  trigger TEXT, by TEXT, started_at INTEGER, finished_at INTEGER, status TEXT, code INTEGER, log TEXT, meta TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS task_runs_dir ON task_runs (server_id, dir, started_at)');
db.exec(`CREATE TABLE IF NOT EXISTS task_env (server_id TEXT NOT NULL, dir TEXT NOT NULL, key TEXT NOT NULL, value TEXT, secret INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (server_id, dir, key))`);

const q = {
  projects: db.prepare('SELECT * FROM task_projects WHERE server_id = ? ORDER BY name, dir'),
  addProject: db.prepare('INSERT OR IGNORE INTO task_projects (server_id, dir, name, created_at) VALUES (?, ?, ?, ?)'),
  delProject: db.prepare('DELETE FROM task_projects WHERE server_id = ? AND dir = ?'),
  insRun: db.prepare('INSERT INTO task_runs (server_id, dir, kind, name, cmd, trigger, by, started_at, status, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  endRun: db.prepare('UPDATE task_runs SET finished_at = ?, status = ?, code = ?, log = ?, meta = ? WHERE id = ?'),
  runs: db.prepare('SELECT id, kind, name, cmd, trigger, by, started_at, finished_at, status, code, meta FROM task_runs WHERE server_id = ? AND dir = ? ORDER BY id DESC LIMIT ?'),
  run: db.prepare('SELECT * FROM task_runs WHERE id = ?'),
  trim: db.prepare('DELETE FROM task_runs WHERE server_id = ? AND dir = ? AND id NOT IN (SELECT id FROM task_runs WHERE server_id = ? AND dir = ? ORDER BY id DESC LIMIT 300)'),
  env: db.prepare('SELECT key, value, secret FROM task_env WHERE server_id = ? AND dir = ? ORDER BY key'),
  putEnv: db.prepare('INSERT INTO task_env (server_id, dir, key, value, secret) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, dir, key) DO UPDATE SET value = excluded.value, secret = excluded.secret'),
  delEnv: db.prepare('DELETE FROM task_env WHERE server_id = ? AND dir = ? AND key = ?'),
};
// a run interrupted by a restart of DockGate is not running any more
db.prepare("UPDATE task_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(Date.now());

const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const DIR_RE = /^\/(?!.*\/\.\.?(\/|$))[\w./@+ :=-]{0,1000}$/;
function okDir(d) { const s = String(d || '').trim().replace(/\/+$/, '') || '/'; if (!DIR_RE.test(s) || s === '/') throw err('A full folder path is needed (not /)'); return s; }
// The local server: tasks run on the machine (or container) DockGate runs on, as DockGate's user.
const LOCAL = Object.freeze({ id: 'local', name: 'Local', host: 'local', local: true });
function server(id) {
  if (!id || id === 'local') return LOCAL;
  const s = stmts.getServer.get(id); if (!s) throw err('Server not found', 404);
  return s;
}

// ---------- projects ----------
async function projects(serverId) {
  const s = server(serverId);
  const out = new Map();
  for (const r of q.projects.all(s.id)) out.set(r.dir, { dir: r.dir, name: r.name || r.dir.split('/').pop(), added: true });
  try {
    const dk = require('./docker');
    if (dk.getActiveServerId() === s.id) for (const p of await dk.listComposeProjects()) if (p.workingDir && DIR_RE.test(p.workingDir) && !out.has(p.workingDir)) out.set(p.workingDir, { dir: p.workingDir, name: p.name, compose: true });
  } catch (e) { /* docker not reachable: the added folders still show */ }
  const last = db.prepare('SELECT dir, status, started_at, name FROM task_runs WHERE server_id = ? AND id IN (SELECT max(id) FROM task_runs WHERE server_id = ? GROUP BY dir)').all(s.id, s.id);
  last.forEach(l => { const p = out.get(l.dir); if (p) p.last = { status: l.status, at: l.started_at, name: l.name }; });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function addProject(serverId, dir, name) { const s = server(serverId); const d = okDir(dir); q.addProject.run(s.id, d, String(name || '').trim().slice(0, 80) || d.split('/').pop(), Date.now()); return { dir: d }; }
function removeProject(serverId, dir) { const s = server(serverId); q.delProject.run(s.id, okDir(dir)); return { ok: true }; }

async function discover(serverId, dir) {
  const s = server(serverId); const d = okDir(dir);
  const r = await exec(s, T.DISCOVER_SH(d));
  const res = T.discover(r.stdout);
  if (res.missing) throw err(`The folder ${d} is not on the server`, 404);
  res.tasks.forEach(t => { t.risky = T.RISKY.test(t.name); });
  res.dir = d; res.running = [...jobs.values()].filter(j => j.serverId === s.id && j.dir === d && j.status === 'running').map(j => ({ id: j.id, name: j.name }));
  return res;
}

// ---------- env ----------
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function envList(serverId, dir) { const s = server(serverId); return q.env.all(s.id, okDir(dir)).map(r => ({ key: r.key, secret: !!r.secret, value: r.secret ? null : dec(r.value) })); }
const dec = (v) => { try { return secrets.decrypt(v); } catch (e) { return ''; } };
function envSet(serverId, dir, items) {
  const s = server(serverId); const d = okDir(dir);
  for (const it of items || []) {
    const k = String(it.key || '').trim(); if (!ENV_KEY.test(k)) throw err(`Bad variable name: ${k || '(empty)'}`);
    if (it.remove) { q.delEnv.run(s.id, d, k); continue; }
    const cur = q.env.all(s.id, d).find(r => r.key === k);
    if (it.value === undefined || it.value === null) { if (!cur) throw err(`A value for ${k} is needed`); q.putEnv.run(s.id, d, k, cur.value, it.secret ? 1 : 0); continue; }
    if (String(it.value).includes('\0') || String(it.value).length > 65536) throw err(`The value of ${k} is not allowed`);
    q.putEnv.run(s.id, d, k, secrets.encrypt(String(it.value)), it.secret ? 1 : 0);
  }
  return envList(serverId, dir);
}
function envValues(serverId, dir) { return q.env.all(serverId, dir).map(r => ({ key: r.key, value: dec(r.value), secret: !!r.secret })); }
const envFileText = (vars) => vars.map(v => `${v.key}=${shq(v.value)}`).join('\n') + '\n';
const SHELL_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The variables of the env files chosen for the folder (task-envfiles.js), for a run on server s; logs which. */
async function envFileVars(s, dir, configServerId, job) {
  let fv = [];
  try { fv = await require('./task-envfiles').varsForRun({ exec }, s, dir, configServerId || s.id); } catch (e) { return []; }
  const missing = fv.filter(x => x.missing).map(x => x.missing);
  const got = fv.filter(x => !x.missing && SHELL_KEY.test(x.key));
  if (job && (got.length || missing.length)) append(job, `env files: ${[...new Set(got.map(x => x.from))].join(', ') || '-'}${missing.length ? ` (not found: ${missing.join(', ')})` : ''}\n`);
  return got.map(x => ({ key: x.key, value: x.value, secret: x.secret }));
}
/** File variables first, DockGate's own values on top (they win). */
function mergeEnv(fileVars, own) { const m = new Map(fileVars.map(v => [v.key, v])); for (const o of own) m.set(o.key, o); return [...m.values()]; }

// ---------- runs ----------
const jobs = new Map(); // live runs: id -> { id, serverId, dir, name, status, chunks, size, secretValues, ... }
const locks = new Map(); // `${serverId}|${dir}` -> run id
const MAX_LIVE = 4 * 1024 * 1024, KEEP_LOG = 400 * 1024;
const homes = new Map();
async function homeOf(s) { if (homes.has(s.id)) return homes.get(s.id); const r = await exec(s, 'printf %s "$HOME"'); const h = String(r.stdout).trim(); if (!h.startsWith('/')) throw err('Could not find the home folder of the SSH user'); homes.set(s.id, h); return h; }
function mask(text, secretValues) { let t = String(text); for (const v of secretValues) if (v && v.length >= 4) t = t.split(v).join('••••'); return t; }
function append(job, text) {
  if (!text) return;
  const t = mask(text, job.secretValues);
  job.chunks.push(t); job.size += t.length;
  while (job.size > MAX_LIVE && job.chunks.length > 1) { job.size -= job.chunks[0].length; job.chunks.shift(); job.dropped = true; }
  job.listeners.forEach(f => { try { f(t); } catch (e) {} });
}
const logText = (job) => (job.dropped ? '... (the start of the log was dropped)\n' : '') + job.chunks.join('');

/** Open a run record + live job. kind: task | recipe. */
function openRun(s, dir, { kind, name, cmd, trigger = 'manual', by = null, meta = {} }) {
  const id = Number(q.insRun.run(s.id, dir, kind, name, cmd || null, trigger, by, Date.now(), 'running', JSON.stringify(meta)).lastInsertRowid);
  const job = { id, serverId: s.id, server: s, dir, kind, name, status: 'running', chunks: [], size: 0, listeners: new Set(), secretValues: [], started: Date.now(), trigger, meta, cancel: null, cancelled: false };
  jobs.set(id, job);
  return job;
}
function closeRun(job, status, code) {
  job.status = status; job.code = code; job.finished = Date.now();
  const log = logText(job); const keep = log.length > KEEP_LOG ? '... (the log was cut to its last 400 KB)\n' + log.slice(-KEEP_LOG) : log;
  q.endRun.run(job.finished, status, code == null ? null : code, keep, JSON.stringify(job.meta || {}), job.id);
  q.trim.run(job.serverId, job.dir, job.serverId, job.dir);
  job.listeners.forEach(f => { try { f(null); } catch (e) {} });
  const t = setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000); if (t.unref) t.unref();
}

/**
 * Run one shell line in the folder, streaming into the job's log. Resolves the exit code (44: no folder).
 * The run's process group can be stopped (cancel); env is passed in a 0600 file the run reads and deletes.
 */
async function runShell(job, cmd, { runAs = 'user', login = true, env = [], timeoutMin = 60 } = {}) {
  const s = job.server; if (s.local) runAs = 'user'; // locally: DockGate's own user
  const home = await homeOf(s);
  const tag = `${job.id}-${crypto.randomBytes(3).toString('hex')}`;
  const pidf = `${home}/.dockgate/run/${tag}.pid`; const envf = env.length ? `${home}/.dockgate/run/${tag}.env` : '';
  job.secretValues = [...new Set([...job.secretValues, ...env.filter(e => e.secret).map(e => e.value)])];
  await exec(s, 'mkdir -p "$HOME/.dockgate/run" && chmod 700 "$HOME/.dockgate" "$HOME/.dockgate/run"');
  if (envf && s.local) fs.writeFileSync(envf, envFileText(env), { mode: 0o600 });
  else if (envf) await require('./ssh-pool').withSftp(s, (sftp) => new Promise((res, rej) => sftp.writeFile(envf, envFileText(env), { mode: 0o600 }, (e) => (e ? rej(e) : res()))));
  const script = 'echo $$ > "$1"; if [ -n "$4" ]; then set -a; . "$4"; set +a; rm -f "$4"; fi; cd "$2" 2>/dev/null || { echo "The folder $2 is not there"; exit 44; }; exec bash ' + (login ? '-lc' : '-c') + ' "$3"';
  const line = `${runAs === 'root' ? 'sudo -n ' : ''}setsid bash -c ${shq(script)} _ ${shq(pidf)} ${shq(job.dir)} ${shq(cmd)} ${shq(envf)} 2>&1; rc=$?; ${runAs === 'root' ? 'sudo -n ' : ''}rm -f ${shq(pidf)} ${envf ? shq(envf) : ''}; exit $rc`;
  job.cancel = async () => { job.cancelled = true; await exec(s, `p=$(cat ${shq(pidf)} 2>/dev/null) || exit 0; ${runAs === 'root' ? 'sudo -n ' : ''}kill -TERM -- -$p 2>/dev/null; sleep 5; ${runAs === 'root' ? 'sudo -n ' : ''}kill -KILL -- -$p 2>/dev/null; true`).catch(() => {}); };
  let timer = null;
  if (timeoutMin > 0) timer = setTimeout(() => { append(job, `\n⏱ Over ${timeoutMin} minutes - stopping it\n`); job.timedOut = true; job.cancel(); }, timeoutMin * 60000);
  try {
    const r = await exec(s, line, (chunk) => append(job, chunk));
    if (r.code === 1 && /sudo: a (terminal|password) is required|a password is required/.test(String(r.stdout) + String(r.stderr))) append(job, '\nsudo asks for a password - running as root needs passwordless sudo\n');
    return r.code;
  } finally { if (timer) clearTimeout(timer); job.cancel = null; }
}

/** Start a task. Returns the run id at once; the run goes on in the background. */
async function start(serverId, dir, spec, { trigger = 'manual', by = null, req = null } = {}) {
  const s = server(serverId); const d = okDir(dir);
  let cmd, label;
  if (spec.source === 'custom') { cmd = String(spec.cmd || '').trim(); if (!cmd) throw err('A command is needed'); if (cmd.length > 20000) throw err('The command is too long'); label = spec.label || cmd.slice(0, 80); }
  else { cmd = T.command(spec, { vars: spec.vars, args: spec.args, dry: !!spec.dry, pm: spec.pm, inventory: spec.inventory }); label = `${spec.source} ${spec.name}${spec.dry ? ' (dry run)' : ''}`; }
  const key = `${s.id}|${d}`;
  if (!spec.dry && locks.has(key) && jobs.get(locks.get(key)) && jobs.get(locks.get(key)).status === 'running') throw err(`Something runs in this folder already (run ${locks.get(key)}) - wait or cancel it`, 409, { code: 'BUSY', run: locks.get(key) });
  const job = openRun(s, d, { kind: 'task', name: label, cmd, trigger, by, meta: { source: spec.source, task: spec.name || null, vars: spec.vars || {}, dry: !!spec.dry, runAs: spec.runAs || 'user' } });
  if (!spec.dry) locks.set(key, job.id);
  if (req) logAction({ req, server: s.id, resourceType: 'task', resourceName: d, action: spec.dry ? 'task_dry_run' : 'task_run', details: { task: label, trigger } });
  (async () => {
    append(job, `$ ${cmd}\n`);
    let code = null;
    try { code = await runShell(job, cmd, { runAs: spec.runAs === 'root' ? 'root' : 'user', login: spec.login !== false, env: mergeEnv(await envFileVars(s, d, s.id, job), envValues(s.id, d)), timeoutMin: Math.max(1, Math.min(720, Number(spec.timeoutMin) || 60)) }); }
    catch (e) { append(job, `\n✗ ${e.message}\n`); }
    if (locks.get(key) === job.id) locks.delete(key);
    const status = job.cancelled ? (job.timedOut ? 'timeout' : 'cancelled') : code === 0 ? 'ok' : 'failed';
    append(job, `\n${status === 'ok' ? '✓ Done' : status === 'cancelled' ? '■ Cancelled' : status === 'timeout' ? '⏱ Stopped (time limit)' : `✗ Exit code ${code}`}, ${((Date.now() - job.started) / 1000).toFixed(1)} s\n`);
    closeRun(job, status, code);
  })();
  return { id: job.id };
}

async function cancel(id) { const j = jobs.get(Number(id)); if (!j || j.status !== 'running') return { cancelled: false }; append(j, '\n■ Cancel asked - stopping the process group\n'); if (j.cancel) await j.cancel(); else j.cancelled = true; return { cancelled: true }; }

function runs(serverId, dir, limit = 50) { const s = server(serverId); return q.runs.all(s.id, okDir(dir), Math.max(1, Math.min(300, Number(limit) || 50))).map(r => ({ ...r, meta: JSON.parse(r.meta || '{}'), live: jobs.has(r.id) && jobs.get(r.id).status === 'running' })); }
/** A run's log from a position on (the UI polls with the size it has). */
function runLog(id, from = 0) {
  const j = jobs.get(Number(id));
  if (j) { const t = logText(j); const f = Math.max(0, Math.min(t.length, Number(from) || 0)); return { id: j.id, name: j.name, status: j.status, code: j.code ?? null, size: t.length, text: t.slice(f), started: j.started, finished: j.finished || null, trigger: j.trigger || null, meta: j.meta }; }
  const r = q.run.get(Number(id)); if (!r) throw err('Run not found', 404);
  const t = r.log || ''; const f = Math.max(0, Math.min(t.length, Number(from) || 0));
  return { id: r.id, name: r.name, status: r.status, code: r.code, size: t.length, text: t.slice(f), started: r.started_at, finished: r.finished_at, trigger: r.trigger || null, meta: JSON.parse(r.meta || '{}') };
}

// ---------- templates ----------
const TEMPLATES = {
  Makefile: { file: 'Makefile', text: `# Tasks of this project - DockGate (Deploy > Tasks) lists every target with its "## text".
.DEFAULT_GOAL := help
COMPOSE ?= docker compose
SERVICE ?=

help: ## Show the tasks
\t@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\\n", $$1, $$2}'

pull: ## Pull the latest code
\tgit pull --ff-only

build: ## Build the images
\t$(COMPOSE) build $(SERVICE)

up: ## Start (or update) the containers
\t$(COMPOSE) up -d --remove-orphans $(SERVICE)

deploy: pull build up ## Pull, build and start
\t@echo "Deployed $$(git rev-parse --short HEAD)"

logs: ## The last log lines
\t$(COMPOSE) logs --tail=200 $(SERVICE)

ps: ## What runs
\t$(COMPOSE) ps

down: ## Stop and remove the containers
\t$(COMPOSE) down

.PHONY: help pull build up deploy logs ps down
` },
  'deploy.sh': { file: 'deploy.sh', mode: '755', text: `#!/usr/bin/env bash
# Deploy: pull the code, build, start, and check - go back to the previous commit when the check fails.
set -euo pipefail
cd "$(dirname "$0")"
HEALTH_URL="\${HEALTH_URL:-}"          # e.g. http://localhost:8080/health (empty = no check)
before=$(git rev-parse HEAD)
git pull --ff-only
docker compose build
docker compose up -d --remove-orphans
if [ -n "$HEALTH_URL" ]; then
  for i in $(seq 1 20); do curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null && { echo "✓ healthy"; exit 0; }; sleep 3; done
  echo "✗ $HEALTH_URL does not answer - going back to $before"
  git reset --hard "$before"
  docker compose up -d --build --remove-orphans
  exit 1
fi
echo "✓ deployed $(git rev-parse --short HEAD)"
` },
  justfile: { file: 'justfile', text: `# Tasks of this project - DockGate (Deploy > Tasks) lists every recipe with the comment above it.
compose := "docker compose"

# Show the tasks
default:
    @just --list

# Pull, build and start
deploy:
    git pull --ff-only
    {{compose}} up -d --build --remove-orphans

# The last log lines
logs service="":
    {{compose}} logs --tail=200 {{service}}

# Stop and remove the containers
down:
    {{compose}} down
` },
};
/** Kamal: the app versions on the servers (from `kamal app containers`), for Rollback. versions: newest first as Kamal lists them. */
async function kamalVersions(serverId, dir) {
  const s = server(serverId); const d = okDir(dir);
  const r = await exec(s, `cd ${shq(d)} && timeout 90 bash -lc 'kamal app containers' 2>&1; echo "@@EXIT $?"`);
  const out = String(r.stdout || '') + String(r.stderr || '');
  const code = Number((/@@EXIT (\d+)/.exec(out) || [])[1] || 1);
  const text = out.replace(/@@EXIT \d+\s*$/, '').trim();
  const versions = [];
  for (const m of text.matchAll(/[A-Za-z0-9_.-]+-([0-9a-f]{7,40}(?:_uncommitted_[0-9a-f]+)?)(?=\s|$)/g)) if (!versions.includes(m[1])) versions.push(m[1]);
  return { ok: code === 0, versions, output: text.slice(-20000) };
}
async function addTemplate(serverId, dir, name, { overwrite = false } = {}) {
  const s = server(serverId); const d = okDir(dir); const t = TEMPLATES[name]; if (!t) throw err('Unknown template');
  const path = `${d}/${t.file}`;
  const b64 = Buffer.from(t.text).toString('base64');
  const r = await exec(s, `cd ${shq(d)} || exit 44; ${overwrite ? '' : `[ -e ${shq(t.file)} ] && exit 17; `}printf %s ${shq(b64)} | base64 -d > ${shq(t.file)}${t.mode ? ` && chmod ${t.mode} ${shq(t.file)}` : ''}`);
  if (r.code === 17) throw err(`${t.file} is there already`, 409, { code: 'EXISTS' });
  if (r.code === 44) throw err(`The folder ${d} is not on the server`, 404);
  if (r.code !== 0) throw err(String(r.stderr || 'Could not write the file').trim(), 500);
  return { path };
}

module.exports = { exec, LOCAL, envFileVars, mergeEnv, projects, addProject, removeProject, discover, envList, envSet, envValues, start, cancel, runs, runLog, addTemplate, kamalVersions, TEMPLATES,
  openRun, closeRun, append, runShell, server, okDir, jobs, locks };
