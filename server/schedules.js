// Scheduled tasks (Tools → Schedules): jobs DockGate runs by itself on a chosen server.
//   prune          — the same cleanup as Resources → Prune (stopped containers, unused images, unused
//                    networks, build cache). Unused volumes are never offered: deleting data on a timer is
//                    too easy to regret.
//   volume_backup  — tar.gz of a volume written to a folder on that server (default /var/backups/dockgate),
//                    the newest N kept.
//   git_sync       — DockGate-managed Git stacks of that server: redeploy when the branch has a new commit.
// Times are wall-clock times in the timezone from Settings → General (UTC when it is "auto").
const { db, stmts } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  kind TEXT NOT NULL,
  server_id TEXT NOT NULL,
  params TEXT,
  freq TEXT NOT NULL,          -- daily | weekly | hourly
  at TEXT,                     -- HH:MM (daily, weekly) or :MM (hourly → minute only)
  weekday INTEGER,             -- 0 = Sunday (weekly)
  enabled INTEGER DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_status TEXT,
  last_message TEXT,
  last_duration_ms INTEGER,
  created_at INTEGER
)`);
const q = {
  all: db.prepare('SELECT * FROM schedules ORDER BY id'),
  get: db.prepare('SELECT * FROM schedules WHERE id = ?'),
  insert: db.prepare('INSERT INTO schedules (name, kind, server_id, params, freq, at, weekday, enabled, next_run_at, created_at) VALUES (@name, @kind, @server_id, @params, @freq, @at, @weekday, @enabled, @next_run_at, @created_at)'),
  update: db.prepare('UPDATE schedules SET name = @name, kind = @kind, server_id = @server_id, params = @params, freq = @freq, at = @at, weekday = @weekday, enabled = @enabled, next_run_at = @next_run_at WHERE id = @id'),
  setEnabled: db.prepare('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?'),
  setNext: db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?'),
  result: db.prepare('UPDATE schedules SET last_run_at = ?, last_status = ?, last_message = ?, last_duration_ms = ?, next_run_at = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM schedules WHERE id = ?'),
  delServer: db.prepare('DELETE FROM schedules WHERE server_id = ?'),
};

const KINDS = ['prune', 'volume_backup', 'git_sync'];
const FREQS = ['daily', 'weekly', 'hourly'];
const PRUNE_KEYS = ['containers', 'images', 'networks', 'build_cache'];

function timezone() {
  try { const v = stmts.getSetting.get('timezone')?.value; if (v && v !== 'auto') { new Intl.DateTimeFormat('en', { timeZone: v }); return v; } } catch (e) { /* invalid */ }
  return 'UTC';
}
/** Wall-clock parts of an instant in a timezone. */
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
/** The instant when the wall clock in tz shows y-m-d h:min (DST-safe to the minute). */
function zoned(y, m, d, h, min, tz) {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) { const p = partsIn(t, tz); t += (Date.UTC(y, m - 1, d, h, min) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)); }
  return t;
}
/** Next run strictly after `from` (ms). */
function nextRun(s, from = Date.now(), tz = timezone()) {
  const [hh, mm] = String(s.at || '03:00').split(':').map(Number);
  if (s.freq === 'hourly') {
    const p = partsIn(from, tz);
    let t = zoned(p.y, p.m, p.d, p.h, mm || 0, tz);
    while (t <= from) t += 3600000;
    return t;
  }
  for (let i = 0; i < 9; i++) {
    const p = partsIn(from + i * 86400000, tz);
    if (s.freq === 'weekly' && p.wd !== Number(s.weekday)) continue;
    const t = zoned(p.y, p.m, p.d, hh || 0, mm || 0, tz);
    if (t > from) return t;
  }
  return from + 86400000;
}

/** Clean and check what the user sent; throws a readable 400. */
function validate(body) {
  const bad = (m) => { throw Object.assign(new Error(m), { statusCode: 400 }); };
  const kind = body.kind; if (!KINDS.includes(kind)) bad('Choose what the task does');
  const freq = body.freq; if (!FREQS.includes(freq)) bad('Choose how often it runs');
  const server_id = String(body.server_id || ''); if (!server_id) bad('Choose a server');
  if (server_id !== 'local' && !stmts.getServer.get(server_id)) bad('That server does not exist');
  const at = String(body.at || (freq === 'hourly' ? '00:00' : '03:00'));
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) bad('Time must look like 03:30');
  const weekday = freq === 'weekly' ? Number(body.weekday) : null;
  if (freq === 'weekly' && !(weekday >= 0 && weekday <= 6)) bad('Choose a day of the week');
  const p = body.params || {};
  let params;
  if (kind === 'prune') {
    params = {}; for (const k of PRUNE_KEYS) params[k] = !!p[k];
    if (!Object.values(params).some(Boolean)) bad('Tick at least one thing to prune');
  } else if (kind === 'volume_backup') {
    const volume = String(p.volume || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(volume)) bad('Choose a volume');
    const dir = String(p.dir || '/var/backups/dockgate').replace(/\/+$/, '');
    if (!/^\/[\w./-]+$/.test(dir) || dir.split('/').includes('..') || dir.split('/').filter(Boolean).length < 2) bad('The backup folder must be an absolute path at least two levels deep, e.g. /var/backups/dockgate');
    const keep = Math.round(Number(p.keep || 7)); if (!(keep >= 1 && keep <= 365)) bad('Keep between 1 and 365 copies');
    params = { volume, dir, keep };
  } else {
    params = { projects: Array.isArray(p.projects) ? p.projects.filter(x => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(x)) : [] };
  }
  const name = String(body.name || '').trim().slice(0, 80) || defaultName(kind, params);
  return { name, kind, server_id, params: JSON.stringify(params), freq, at, weekday, enabled: body.enabled === false ? 0 : 1 };
}
function defaultName(kind, p) {
  if (kind === 'prune') return 'Prune ' + PRUNE_KEYS.filter(k => p[k]).map(k => ({ containers: 'stopped containers', images: 'unused images', networks: 'unused networks', build_cache: 'build cache' }[k])).join(', ');
  if (kind === 'volume_backup') return `Back up volume ${p.volume}`;
  return p.projects && p.projects.length ? `Sync Git stacks ${p.projects.join(', ')}` : 'Sync Git stacks';
}

function dockerFor(serverId) {
  const ds = require('./docker');
  if (serverId === 'local') return ds.createLocalClient();
  const s = stmts.getServer.get(serverId);
  if (!s) throw new Error('The server no longer exists');
  return ds.createSshClient(s);
}
const fmtBytes = (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };

// ---- what each kind does ----
async function runPrune(docker, p) {
  let freed = 0; const parts = [];
  if (p.containers) { const r = await docker.pruneContainers(); freed += r.SpaceReclaimed || 0; parts.push(`${(r.ContainersDeleted || []).length} containers`); }
  if (p.images) { const r = await docker.pruneImages({ filters: { dangling: { false: true } } }); freed += r.SpaceReclaimed || 0; parts.push(`${(r.ImagesDeleted || []).filter(x => x.Deleted).length} images`); }
  if (p.networks) { const r = await docker.pruneNetworks(); parts.push(`${(r.NetworksDeleted || []).length} networks`); }
  if (p.build_cache) { const r = await docker.pruneBuilder(); freed += r.SpaceReclaimed || 0; parts.push('build cache'); }
  return { ok: true, message: `freed ${fmtBytes(freed)} · ${parts.join(', ')}` };
}

async function ensureImage(docker, image) {
  try { await docker.getImage(image).inspect(); return; } catch (e) { /* pull it */ }
  await new Promise((resolve, reject) => docker.pull(image, (err, stream) => {
    if (err) return reject(err);
    docker.modem.followProgress(stream, (e2) => (e2 ? reject(e2) : resolve()));
  }));
}
async function runVolumeBackup(docker, p) {
  try { await docker.getVolume(p.volume).inspect(); } catch (e) { return { ok: false, message: `volume ${p.volume} not found on this server` }; }
  await ensureImage(docker, 'alpine:3.20');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = `${p.volume}-${stamp}.tar.gz`;
  // Names are validated (no quotes or spaces), so plain single quotes are safe here.
  const script = `set -e; tar czf '/backup/${file}' -C /volume .; ls -1t /backup/'${p.volume}'-*.tar.gz | tail -n +${p.keep + 1} | xargs -r rm -f; stat -c %s '/backup/${file}'`;
  const c = await docker.createContainer({ Image: 'alpine:3.20', Cmd: ['sh', '-c', script], HostConfig: { Binds: [`${p.volume}:/volume:ro`, `${p.dir}:/backup`], AutoRemove: false }, Labels: { 'dockgate.task': 'volume-backup' } });
  try {
    await c.start();
    const r = await c.wait();
    const logs = (await c.logs({ stdout: true, stderr: true })).toString('utf8').replace(/[\x00-\x08]/g, '').trim();
    if (r.StatusCode !== 0) return { ok: false, message: (logs.split('\n').pop() || `exit ${r.StatusCode}`).slice(0, 200) };
    const size = parseInt(logs.split('\n').pop(), 10);
    return { ok: true, message: `${fmtBytes(size)} · ${p.dir}/${file} · keeps ${p.keep}` };
  } finally { try { await c.remove({ force: true }); } catch (e) { /* gone */ } }
}

async function runGitSync(serverId, p) {
  const sync = require('./routes/compose').scheduledGitSync;
  const r = await sync(serverId, p.projects || []);
  if (!r.length) return { ok: true, message: 'no DockGate-managed Git stacks on this server' };
  const failed = r.filter(x => x.status === 'error');
  const deployed = r.filter(x => x.status === 'deployed');
  const msg = [deployed.length ? `deployed ${deployed.map(x => `${x.project} ${x.commit}`).join(', ')}` : '', r.filter(x => x.status === 'unchanged').length ? `${r.filter(x => x.status === 'unchanged').length} without a new commit` : '', failed.map(x => `${x.project}: ${x.message}`).join('; ')].filter(Boolean).join(' · ');
  return { ok: !failed.length, message: msg || 'nothing to do' };
}

const running = new Set();
async function runOne(id, { manual = false } = {}) {
  const s = q.get.get(id);
  if (!s) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  if (running.has(id)) throw Object.assign(new Error('This task is running already'), { statusCode: 409 });
  running.add(id);
  const t0 = Date.now();
  let res;
  try {
    const p = JSON.parse(s.params || '{}');
    if (s.kind === 'git_sync') res = await runGitSync(s.server_id, p);
    else {
      const docker = dockerFor(s.server_id);
      res = s.kind === 'prune' ? await runPrune(docker, p) : await runVolumeBackup(docker, p);
    }
  } catch (e) {
    res = { ok: false, message: /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|connect/i.test(e.message) ? `server not reachable: ${e.message}` : e.message };
  } finally { running.delete(id); }
  const next = s.enabled ? nextRun(s) : null;
  q.result.run(Date.now(), res.ok ? 'ok' : 'failed', String(res.message || '').slice(0, 500), Date.now() - t0, next, id);
  try { require('./audit').logAction({ server: s.server_id, resourceType: 'schedule', resourceName: s.name, action: manual ? 'schedule_run_now' : 'schedule_run', details: { status: res.ok ? 'ok' : 'failed', message: res.message } }); } catch (e) { /* audit is best effort */ }
  if (!res.ok) {
    try {
      const HM = require('./notifications/health-monitor');
      const srv = s.server_id === 'local' ? { id: 'local' } : (stmts.getServer.get(s.server_id) || { id: s.server_id });
      const name = HM.serverLabel(srv);
      await HM.deliver('schedule_failed', srv, `Scheduled task failed: ${s.name}`, `🔴 Scheduled task failed on ${name}\n${s.name}\n${res.message}`,
        `<p>The scheduled task <b>${String(s.name).replace(/</g, '&lt;')}</b> on ${String(name).replace(/</g, '&lt;')} failed:</p><p>${String(res.message).replace(/</g, '&lt;')}</p>`);
    } catch (e) { /* alerts are best effort */ }
  }
  return { ...q.get.get(id), result: res };
}

let timer = null;
function tick() {
  const now = Date.now();
  for (const s of q.all.all()) {
    if (!s.enabled) continue;
    if (!s.next_run_at) { q.setNext.run(nextRun(s), s.id); continue; }
    if (s.next_run_at <= now && !running.has(s.id)) runOne(s.id).catch(e => console.warn('[schedules]', e.message));
  }
}
function start() { if (!timer) { timer = setInterval(tick, 30000); setTimeout(tick, 5000); } }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { q, KINDS, FREQS, PRUNE_KEYS, validate, nextRun, partsIn, zoned, runOne, start, stop, timezone, isRunning: (id) => running.has(id) };
