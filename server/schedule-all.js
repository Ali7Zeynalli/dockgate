// Everything scheduled on one server, in one list (Tools > Schedules -> "Everything on a server"):
//   DockGate's own tasks (Tools > Schedules), deploy recipes with a schedule (Deploy > Tasks), and - on an SSH
//   server - its cron jobs and systemd timers (Server Console > Cron). Nothing is moved: each row links to the page
//   where it is changed. Every time is an instant (ms); `clock` says which clock the schedule is written in.
const { db, stmts } = require('./db');
require('./task-recipes'); // makes task_recipes and task_runs (read below)
const S = require('./schedules');
const C = require('./cron-parse');

const CLASH_MS = 10 * 60000; // two heavy jobs starting within 10 minutes of each other
const KIND = { prune: 'Prune unused data', volume_backup: 'Back up a volume', db_backup: 'Back up a database', git_sync: 'Sync Git stacks' };
const recipes = db.prepare("SELECT * FROM task_recipes WHERE server_id = ? AND schedule IS NOT NULL AND schedule != ''");
const lastRecipeRun = db.prepare("SELECT status, started_at FROM task_runs WHERE server_id = ? AND dir = ? AND kind = 'recipe' AND name = ? ORDER BY started_at DESC LIMIT 1");
const when = (s) => s.freq === 'hourly' ? `every hour at :${(s.at || '00:00').slice(3)}` : s.freq === 'weekly' ? `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.weekday]} ${s.at}` : `every day ${s.at}`;

async function forServer(serverId, { now = Date.now() } = {}) {
  const id = serverId || 'local';
  const server = id === 'local' ? null : stmts.getServer.get(id);
  if (id !== 'local' && !server) throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  const tz = S.timezone();
  const items = [], notes = [];

  for (const s of S.q.all.all().filter(x => x.server_id === id)) {
    items.push({ source: 'dockgate', sourceLabel: 'DockGate, Schedules', name: s.name, what: KIND[s.kind] || s.kind, when: when(s), clock: tz,
      enabled: !!s.enabled, next: s.enabled ? s.next_run_at : null, last: s.last_run_at || null, lastOk: s.last_status ? s.last_status === 'ok' : null,
      lastNote: s.last_message || '', link: { page: 'schedules' } });
  }

  const TR = require('./task-recipes');
  for (const r of recipes.all(id)) {
    let next = null, human = r.schedule;
    try { human = C.describe(r.schedule); next = C.nextRuns(r.schedule, now, TR.offsetMin(tz, now), 1)[0] || null; } catch (e) { /* a bad schedule shows as written */ }
    const lr = lastRecipeRun.get(id, r.dir, r.name);
    items.push({ source: 'recipe', sourceLabel: 'DockGate, Deploy recipe', name: r.name, what: `Recipe in ${r.dir}`, when: human, clock: tz, enabled: true, next,
      last: lr ? lr.started_at : null, lastOk: lr && lr.status && lr.status !== 'running' ? lr.status === 'ok' : null, lastNote: '', link: { page: 'tasks', params: { dir: r.dir } } });
  }

  if (server) {
    try {
      const d = await require('./cron').read(server);
      const clock = `server clock (UTC${d.tz.replace(/^([+-]\d\d)(\d\d)$/, '$1:$2')})`;
      for (const src of d.sources) for (const j of src.jobs) {
        items.push({ source: 'cron', sourceLabel: `Cron, ${src.label.replace(/ - .*/, '')}`, name: (j.meta && j.meta.name) || String(j.command).replace(/^\S*dg-cron\s+\S+\s+/, '').slice(0, 80),
          what: String(j.command).slice(0, 200), when: j.human || j.schedule, clock, enabled: !!j.enabled, next: (j.next || [])[0] || null,
          last: j.lastRun || null, lastOk: j.lastCode == null ? null : j.lastCode === 0, lastNote: j.lastCode ? `exit ${j.lastCode}` : '', link: { page: 'srv-automation', params: { tab: 'srv-cron' } } });
      }
      for (const t of d.timers) {
        items.push({ source: 'timer', sourceLabel: 'systemd timer', name: t.unit, what: `runs ${t.runs}`, when: t.calendar || '-', clock: 'server clock', enabled: t.state ? t.state === 'enabled' : t.active === 'active',
          next: t.next || null, last: t.last || null, lastOk: null, lastNote: '', link: { page: 'srv-automation', params: { tab: 'srv-timers' } } });
      }
      if (!d.cronRunning) notes.push('No cron daemon is running on this server: its cron jobs do not run.');
    } catch (e) { notes.push(`Cron and timers could not be read: ${e.message}`); }
  } else notes.push('Cron jobs and timers are shown for SSH servers (Server Console > Cron).');

  // starts that fall within 10 minutes of each other (only switched-on DockGate tasks, recipes and cron jobs)
  const timed = items.filter(x => x.enabled && x.next && x.source !== 'timer').sort((a, b) => a.next - b.next);
  for (let i = 0; i < timed.length; i++) for (let k = i + 1; k < timed.length && timed[k].next - timed[i].next < CLASH_MS; k++) { timed[i].clash = true; timed[k].clash = true; }

  items.sort((a, b) => (a.next || Infinity) - (b.next || Infinity) || a.name.localeCompare(b.name));
  return { server: id, timezone: tz, items, notes, failed: items.filter(x => x.lastOk === false).length };
}

module.exports = { forServer, CLASH_MS };
