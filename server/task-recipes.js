// Deploy → Tasks → Recipes: a deploy as steps — git pull, a task of the folder, any command, docker compose up,
// checks (a URL answers, a container is healthy), a wait — then, when a step fails, the recovery steps (back to
// the commit before the pull, a rollback task, …). One run covers one or more servers (one after another; stops
// at the first that fails unless told to go on). Triggers: Run, a schedule, a webhook (task-hooks.js), CI.
//   list / get / save / remove      the recipes of a folder
//   run(id, { trigger, by, git })   a run in the background → { id }; git = { sha, branch, message, author } from a push
const { db, stmts } = require('./db');
const T = require('./task-parse');
const TK = require('./tasks');
const remoteExec = require('./remote-compose');
const secrets = require('./auth/secrets');
const { logAction } = require('./audit');
const shq = remoteExec.shq;

db.exec(`CREATE TABLE IF NOT EXISTS task_recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, dir TEXT NOT NULL, name TEXT NOT NULL,
  steps TEXT NOT NULL, on_fail TEXT, settings TEXT, schedule TEXT, last_sched INTEGER, hook_id TEXT UNIQUE, hook_secret TEXT, hook_branch TEXT,
  status_token TEXT, created_at INTEGER, updated_at INTEGER)`);
const rule = db.prepare('INSERT OR IGNORE INTO notification_rules (event_type, description, cooldown_minutes, enabled, params) VALUES (?, ?, 0, 1, ?)');
rule.run('deploy_failed', 'Deploy failed', '{}');
rule.run('deploy_ok', 'Deploy finished', '{}');

const q = {
  list: db.prepare('SELECT * FROM task_recipes WHERE server_id = ? AND dir = ? ORDER BY name'),
  all: db.prepare('SELECT * FROM task_recipes'),
  get: db.prepare('SELECT * FROM task_recipes WHERE id = ?'),
  byHook: db.prepare('SELECT * FROM task_recipes WHERE hook_id = ?'),
  ins: db.prepare(`INSERT INTO task_recipes (server_id, dir, name, steps, on_fail, settings, schedule, hook_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upd: db.prepare('UPDATE task_recipes SET name = ?, steps = ?, on_fail = ?, settings = ?, schedule = ?, hook_branch = ?, updated_at = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM task_recipes WHERE id = ?'),
  sched: db.prepare('UPDATE task_recipes SET last_sched = ? WHERE id = ?'),
  hook: db.prepare('UPDATE task_recipes SET hook_id = ?, hook_secret = ? WHERE id = ?'),
  token: db.prepare('UPDATE task_recipes SET status_token = ? WHERE id = ?'),
};
const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});

// ---------- steps ----------
const KINDS = {
  git_pull: { label: 'Git pull', fields: ['branch'] },
  task: { label: 'A task of the folder', fields: ['source', 'name', 'vars', 'args'] },
  command: { label: 'Command', fields: ['cmd'] },
  compose_up: { label: 'docker compose up', fields: ['build', 'pull'] },
  check_url: { label: 'Check a URL', fields: ['url', 'status', 'contains', 'tries', 'every'] },
  container_healthy: { label: 'Wait until a container is healthy', fields: ['container', 'timeout'] },
  wait: { label: 'Wait', fields: ['seconds'] },
  git_back: { label: 'Back to the commit before the pull', fields: [] },
};
const URL_RE = /^https?:\/\/[^\s'"`]+$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function checkStep(s, i, where) {
  const n = `${where} step ${i + 1}`;
  if (!s || !KINDS[s.type]) throw err(`${n}: unknown kind`);
  if (s.type === 'task') { try { T.command({ source: s.source, name: s.name, params: s.params }, { vars: s.vars, args: s.args }); } catch (e) { throw err(`${n}: ${e.message}`); } }
  if (s.type === 'command' && !String(s.cmd || '').trim()) throw err(`${n}: a command is needed`);
  if (s.type === 'check_url' && !URL_RE.test(String(s.url || ''))) throw err(`${n}: an http(s) URL is needed`);
  if (s.type === 'container_healthy' && !CONTAINER_RE.test(String(s.container || ''))) throw err(`${n}: a container name is needed`);
  if (s.type === 'git_pull' && s.branch && !/^[\w./-]{1,200}$/.test(s.branch)) throw err(`${n}: bad branch name`);
  if (s.type === 'git_back' && where !== 'Recovery') throw err(`${n}: "back to the commit" is a recovery step`);
  return { ...s, runAs: s.runAs === 'root' ? 'root' : 'user' };
}
/** The shell line of a step (null: done by DockGate itself). ctx.before is the commit before git pull. */
function stepShell(s, ctx) {
  switch (s.type) {
    case 'git_pull': return s.branch ? `git fetch --prune origin ${shq(s.branch)} && git checkout ${shq(s.branch)} && git pull --ff-only origin ${shq(s.branch)}` : 'git pull --ff-only';
    case 'task': return T.command({ source: s.source, name: s.name, params: s.params, pm: s.pm, inventory: s.inventory }, { vars: s.vars, args: s.args });
    case 'command': return String(s.cmd);
    case 'compose_up': return `${s.pull ? 'docker compose pull && ' : ''}docker compose up -d --remove-orphans${s.build !== false ? ' --build' : ''}`;
    case 'check_url': {
      const tries = Math.max(1, Math.min(120, Number(s.tries) || 10)), every = Math.max(1, Math.min(60, Number(s.every) || 3));
      const st = String(s.status || '200-399'); const [lo, hi] = st.includes('-') ? st.split('-').map(Number) : [Number(st), Number(st)];
      return `for i in $(seq 1 ${tries}); do out=$(curl -sk --max-time 10 -w '\\n%{http_code}' ${shq(s.url)} 2>/dev/null); code=$(printf '%s' "$out" | tail -n1); `
        + `if [ "$code" -ge ${lo || 200} ] 2>/dev/null && [ "$code" -le ${hi || 399} ]${s.contains ? ` && printf '%s' "$out" | grep -qF ${shq(s.contains)}` : ''}; then echo "✓ ${String(s.url).replace(/["`$\\]/g, '')} answered $code"; exit 0; fi; `
        + `echo "… try $i: $code"; sleep ${every}; done; echo "✗ no good answer from the URL"; exit 1`;
    }
    case 'container_healthy': {
      const t = Math.max(5, Math.min(1800, Number(s.timeout) || 120));
      return `end=$(( $(date +%s) + ${t} )); while :; do st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${shq(s.container)} 2>/dev/null); `
        + `case "$st" in healthy|running) echo "✓ ${s.container} is $st"; exit 0;; unhealthy|exited|dead) echo "✗ ${s.container} is $st"; exit 1;; esac; [ $(date +%s) -ge $end ] && { echo "✗ ${s.container} is still \${st:-missing} after ${t} s"; exit 1; }; sleep 3; done`;
    }
    case 'wait': return `sleep ${Math.max(1, Math.min(3600, Number(s.seconds) || 10))}`;
    case 'git_back': return ctx.before ? `git reset --hard ${shq(ctx.before)} && echo "Back at ${ctx.before.slice(0, 10)}"` : 'echo "No commit to go back to (no git pull ran)"; exit 1';
    default: throw err('Unknown step');
  }
}
const describe = (s) => {
  switch (s.type) {
    case 'git_pull': return `git pull${s.branch ? ` (${s.branch})` : ''}`;
    case 'task': return `${s.source} ${s.name}`;
    case 'command': return String(s.cmd).split('\n')[0].slice(0, 80);
    case 'compose_up': return `docker compose up${s.build !== false ? ' --build' : ''}`;
    case 'check_url': return `check ${s.url}`;
    case 'container_healthy': return `${s.container} healthy`;
    case 'wait': return `wait ${s.seconds || 10} s`;
    case 'git_back': return 'back to the commit before the pull';
    default: return s.type;
  }
};

// ---------- storage ----------
const row = (r) => r && ({
  id: r.id, serverId: r.server_id, dir: r.dir, name: r.name, steps: JSON.parse(r.steps), onFail: JSON.parse(r.on_fail || '[]'), settings: JSON.parse(r.settings || '{}'),
  schedule: r.schedule || null, lastSched: r.last_sched, hook: r.hook_id ? { id: r.hook_id, branch: r.hook_branch || null } : null, hookBranch: r.hook_branch || null, hasStatusToken: !!r.status_token,
});
function list(serverId, dir) { const s = TK.server(serverId); return q.list.all(s.id, TK.okDir(dir)).map(row); }
function get(id) { const r = row(q.get.get(Number(id))); if (!r) throw err('Recipe not found', 404); return r; }
function save(serverId, dir, body, id = null) {
  const s = TK.server(serverId); const d = TK.okDir(dir);
  const name = String(body.name || '').trim().slice(0, 80); if (!name) throw err('A name is needed');
  const steps = (body.steps || []).map((x, i) => checkStep(x, i, 'Deploy')); if (!steps.length) throw err('Add at least one step');
  if (steps.length > 40) throw err('At most 40 steps');
  const onFail = (body.onFail || []).map((x, i) => checkStep(x, i, 'Recovery'));
  const servers = [...new Set((body.settings && body.settings.servers && body.settings.servers.length ? body.settings.servers : [s.id]).map(String))];
  servers.forEach(x => TK.server(x));
  const settings = { servers, continueServers: !!(body.settings && body.settings.continueServers), notify: { fail: body.settings?.notify?.fail !== false, ok: !!body.settings?.notify?.ok }, timeoutMin: Math.max(1, Math.min(720, Number(body.settings?.timeoutMin) || 60)), runAs: body.settings?.runAs === 'root' ? 'root' : 'user' };
  let schedule = body.schedule ? String(body.schedule).trim() : null;
  if (schedule) { try { require('./cron-parse').parseSchedule(schedule); } catch (e) { throw err(`Schedule: ${e.message}`); } }
  const branch = body.hookBranch ? String(body.hookBranch).trim().slice(0, 200) : null;
  const now = Date.now();
  if (id) { const cur = get(id); if (cur.serverId !== s.id || cur.dir !== d) throw err('Recipe not found', 404); q.upd.run(name, JSON.stringify(steps), JSON.stringify(onFail), JSON.stringify(settings), schedule, branch, now, cur.id); return get(cur.id); }
  return get(q.ins.run(s.id, d, name, JSON.stringify(steps), JSON.stringify(onFail), JSON.stringify(settings), schedule, branch, now, now).lastInsertRowid);
}
function remove(id) { const r = get(id); q.del.run(r.id); return { ok: true }; }

// ---------- running ----------
const running = new Map(); // recipe id → run id
async function run(id, { trigger = 'manual', by = null, git = null, status = null, req = null } = {}) {
  const r = get(id);
  if (running.has(r.id)) { const j = TK.jobs.get(running.get(r.id)); if (j && j.status === 'running') throw err(`This recipe is running (run ${running.get(r.id)})`, 409, { code: 'BUSY', run: running.get(r.id) }); }
  const main = TK.server(r.serverId);
  for (const sid of r.settings.servers) { const k = `${sid}|${r.dir}`; const j = TK.locks.has(k) && TK.jobs.get(TK.locks.get(k)); if (j && j.status === 'running') throw err(`Something runs in ${r.dir} on ${sid} already`, 409, { code: 'BUSY', run: j.id }); }
  const job = TK.openRun(main, r.dir, { kind: 'recipe', name: r.name, trigger, by, meta: { recipe: r.id, servers: r.settings.servers, git } });
  running.set(r.id, job.id);
  r.settings.servers.forEach(sid => TK.locks.set(`${sid}|${r.dir}`, job.id));
  if (req) logAction({ req, server: main.id, resourceType: 'task', resourceName: r.dir, action: 'recipe_run', details: { recipe: r.name, trigger } });
  (async () => {
    const results = []; let ok = true;
    if (status) await status('pending', `DockGate: ${r.name} is running`).catch((e) => TK.append(job, `(commit status not sent: ${e.message})\n`));
    const t0 = Date.now();
    if (git && git.sha) TK.append(job, `Triggered by ${trigger}${git.author ? ` — ${git.author}` : ''}: ${git.branch || ''} ${String(git.sha).slice(0, 10)}${git.message ? ` “${String(git.message).split('\n')[0].slice(0, 120)}”` : ''}\n`);
    for (const sid of r.settings.servers) {
      if (job.cancelled) break;
      let s; try { s = TK.server(sid); } catch (e) { TK.append(job, `\n✗ server ${sid}: ${e.message}\n`); ok = false; results.push({ server: sid, ok: false }); if (!r.settings.continueServers) break; continue; }
      job.server = s; // the steps run on this server
      if (r.settings.servers.length > 1) TK.append(job, `\n━━━━ ${s.host || s.id} ━━━━\n`);
      const res = await runOn(job, r, s);
      results.push({ server: sid, ok: res.ok, failedAt: res.failedAt });
      if (!res.ok) { ok = false; if (!r.settings.continueServers) { const rest = r.settings.servers.slice(r.settings.servers.indexOf(sid) + 1); if (rest.length) TK.append(job, `\nStopped: not deployed to ${rest.join(', ')}\n`); break; } }
    }
    job.server = main; job.meta.results = results;
    r.settings.servers.forEach(sid => { if (TK.locks.get(`${sid}|${r.dir}`) === job.id) TK.locks.delete(`${sid}|${r.dir}`); });
    running.delete(r.id);
    const status2 = job.cancelled ? (job.timedOut ? 'timeout' : 'cancelled') : ok ? 'ok' : 'failed';
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    TK.append(job, `\n${status2 === 'ok' ? '✓ Deployed' : status2 === 'cancelled' ? '■ Cancelled' : status2 === 'timeout' ? '⏱ Stopped (time limit)' : '✗ Deploy failed'} · ${secs} s\n`);
    TK.closeRun(job, status2, ok ? 0 : 1);
    if (status) await status(ok ? 'success' : 'failure', `DockGate: ${r.name} ${ok ? 'deployed' : 'failed'} in ${secs} s`).catch(() => {});
    logAction({ server: main.id, resourceType: 'task', resourceName: projectName(r.dir), action: 'deploy', details: { recipe: r.name, status: status2 } }); // keeps Uptime quiet a little longer
    notify(r, job, status2, secs).catch(() => {});
  })();
  return { id: job.id };
}
const projectName = (dir) => String(dir).split('/').filter(Boolean).pop();

async function runOn(job, r, s) {
  const env = TK.envValues(s.id, r.dir);
  const ctx = {};
  logAction({ server: s.id, resourceType: 'task', resourceName: projectName(r.dir), action: 'deploy', details: { recipe: r.name } }); // Uptime: busy, no false alarms
  const exec1 = async (st, i, label) => {
    TK.append(job, `\n▶ ${label} ${i + 1}. ${describe(st)}\n`);
    let cmd; try { cmd = stepShell(st, ctx); } catch (e) { TK.append(job, `✗ ${e.message}\n`); return 1; }
    if (st.type === 'git_pull') { const b = await remoteExec.execRemote(s, `cd ${shq(r.dir)} && git rev-parse HEAD`); ctx.before = String(b.stdout).trim().split('\n').pop() || null; }
    const code = await TK.runShell(job, cmd, { runAs: st.runAs === 'root' || r.settings.runAs === 'root' ? 'root' : 'user', env, timeoutMin: r.settings.timeoutMin });
    if (st.type === 'git_pull' && code === 0) { const a = await remoteExec.execRemote(s, `cd ${shq(r.dir)} && git log -1 --format='%h %s'`); TK.append(job, `   now at ${String(a.stdout).trim()}${ctx.before ? ` (was ${ctx.before.slice(0, 7)})` : ''}\n`); }
    if (code !== 0) TK.append(job, `✗ step ${i + 1} failed (exit ${code})\n`);
    return code;
  };
  for (let i = 0; i < r.steps.length; i++) {
    if (job.cancelled) return { ok: false, failedAt: i };
    const code = await exec1(r.steps[i], i, 'Step');
    if (code !== 0) {
      if (r.onFail.length && !job.cancelled) {
        TK.append(job, `\n↺ Recovering (${r.onFail.length} step${r.onFail.length > 1 ? 's' : ''})\n`);
        for (let k = 0; k < r.onFail.length; k++) await exec1(r.onFail[k], k, 'Recovery');
      }
      return { ok: false, failedAt: i };
    }
  }
  return { ok: true };
}

async function notify(r, job, status, secs) {
  if (status === 'ok' && !r.settings.notify.ok) return;
  if (status !== 'ok' && !r.settings.notify.fail) return;
  const HM = require('./notifications/health-monitor');
  const tail = TK.runLog(job.id).text.split('\n').filter(Boolean).slice(-12).join('\n');
  const type = status === 'ok' ? 'deploy_ok' : 'deploy_failed';
  const subject = status === 'ok' ? `Deployed — ${r.name}` : `Deploy failed — ${r.name}`;
  const text = `${status === 'ok' ? '🟢' : '🔴'} ${subject}\n${r.dir} on ${r.settings.servers.join(', ')} · ${secs} s · run ${job.id}\n${status === 'ok' ? '' : tail}`;
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  await HM.deliver(type, { id: `recipe:${r.id}`, name: r.name }, subject, text, `<p><b>${esc(subject)}</b><br>${esc(r.dir)} · ${secs} s · run ${job.id}</p>${status === 'ok' ? '' : `<pre>${esc(tail)}</pre>`}`, { always: true, retry: true });
}

// ---------- webhook / CI token ----------
const crypto = require('crypto');
/** Make (or make new) the recipe's hook id and secret. The secret is shown to the admin to paste into the provider. */
function enableHook(id) { const r = get(id); const hid = crypto.randomBytes(12).toString('hex'); const sec = crypto.randomBytes(24).toString('base64url'); q.hook.run(hid, secrets.encrypt(sec), r.id); return { hookId: hid, secret: sec }; }
function disableHook(id) { const r = get(id); q.hook.run(null, null, r.id); return { ok: true }; }
function hookSecret(id) { const x = q.get.get(Number(id)); if (!x || !x.hook_id) throw err('No webhook for this recipe', 404); return { hookId: x.hook_id, secret: secrets.decrypt(x.hook_secret) }; }
function setStatusToken(id, token) { const r = get(id); q.token.run(token ? secrets.encrypt(String(token).trim()) : null, r.id); return { ok: true }; }
function hookTarget(hookId) { const x = q.byHook.get(String(hookId)); if (!x) return null; return { recipe: row(x), secret: secrets.decrypt(x.hook_secret), statusToken: x.status_token ? secrets.decrypt(x.status_token) : null }; }

// ---------- schedule ----------
function offsetMin(tz, at = Date.now()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at) / 60000);
  } catch (e) { return 0; }
}
let timer = null;
function tick(now = Date.now()) {
  const C = require('./cron-parse');
  const tz = require('./schedules').timezone();
  for (const x of q.all.all()) {
    if (!x.schedule) continue;
    try {
      const from = x.last_sched || x.updated_at || x.created_at || now;
      const next = C.nextRuns(x.schedule, from, offsetMin(tz, now), 1)[0];
      if (next && next <= now) { q.sched.run(now, x.id); if (!running.has(x.id)) run(x.id, { trigger: 'schedule', by: 'schedule' }).catch(() => {}); }
    } catch (e) { /* a bad schedule waits for an edit */ }
  }
}
function start() { if (!timer) { timer = setInterval(() => { try { tick(); } catch (e) {} }, 30000); if (timer.unref) timer.unref(); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { KINDS, list, get, save, remove, run, tick, start, stop, stepShell, describe, offsetMin, running, enableHook, disableHook, hookSecret, setStatusToken, hookTarget };
