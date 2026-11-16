// Cron, without I/O (unit tested): read crontab text into jobs, write it back, the next run times of a schedule
// and the schedule in words.
//   parseCrontab(text, { system })   → { lines: [{ raw, kind: 'job'|'env'|'comment'|'blank', job? }] }
//       system: /etc/crontab and /etc/cron.d files have a user field after the schedule
//   jobs(parsed)                      → [{ index, schedule, user?, command, enabled, meta }]
//   nextRuns(schedule, fromMs, offsetMin, n)   next n run times (ms), offsetMin = server UTC offset in minutes
//   describe(schedule)                "Every day at 03:30"
//   buildLine(entry, { system })      one crontab line (plus its "# dockgate:" meta line)
// A job DockGate manages carries a comment line above it:  # dockgate: {"name":"db-backup","notify":["fail"]}
// A turned-off job is kept as a comment:                    #dg-off# 30 3 * * * /opt/backup.sh
const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const OFF = '#dg-off# ';
const META = /^#\s*dockgate:\s*(\{.*\})\s*$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

function field(spec, idx) {
  const [lo, hi] = FIELDS[idx];
  const names = idx === 3 ? MON : idx === 4 ? DOW : null;
  const out = new Set();
  for (const part of String(spec).toLowerCase().split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a cron value`);
    const num = (v) => { const n = names && names[v] != null ? names[v] : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`"${v}" is out of range ${lo}-${hi}`); return n; };
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; } else if (m[1].includes('-')) { [a, b] = m[1].split('-').map(num); if (a > b) throw new Error(`"${part}": start after end`); } else { a = num(m[1]); b = m[2] ? hi : a; }
    const step = m[2] ? Number(m[2]) : 1;
    if (!step) throw new Error(`"${part}": step 0`);
    for (let v = a; v <= b; v += step) out.add(idx === 4 && v === 7 ? 0 : v);
  }
  return out;
}

/** "30 3 * * *" or "@daily" → { min, hour, dom, mon, dow, domStar, dowStar, reboot } — throws on a bad schedule. */
function parseSchedule(s) {
  const t = String(s || '').trim().toLowerCase();
  if (t === '@reboot') return { reboot: true };
  const exp = MACROS[t] || t;
  const p = exp.split(/\s+/);
  if (p.length !== 5) throw new Error('A schedule has 5 fields: minute hour day-of-month month day-of-week (or @daily, @hourly…)');
  return { min: field(p[0], 0), hour: field(p[1], 1), dom: field(p[2], 2), mon: field(p[3], 3), dow: field(p[4], 4), domStar: p[2] === '*', dowStar: p[4] === '*' };
}
function matches(c, d) { // d: Date in "server local" terms via UTC getters
  if (!c.min.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.mon.has(d.getUTCMonth() + 1)) return false;
  const dm = c.dom.has(d.getUTCDate()), dw = c.dow.has(d.getUTCDay());
  if (c.domStar || c.dowStar) return dm && dw; // when either is *, both must match (the * always does)
  return dm || dw;                            // both set: either one (cron's rule)
}
/** Next n run times after fromMs, in a server whose clock is offsetMin minutes from UTC. */
function nextRuns(schedule, fromMs, offsetMin = 0, n = 5) {
  const c = parseSchedule(schedule);
  if (c.reboot) return [];
  const out = [];
  let t = Math.floor((fromMs + offsetMin * 60000) / 60000) * 60000 + 60000; // server-local, next whole minute
  const limit = t + 366 * 86400000 * 5;
  while (out.length < n && t < limit) {
    const d = new Date(t);
    if (!c.mon.has(d.getUTCMonth() + 1)) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); continue; }
    if (!(c.domStar || c.dowStar ? c.dom.has(d.getUTCDate()) && c.dow.has(d.getUTCDay()) : c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay()))) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); continue; }
    if (!c.hour.has(d.getUTCHours())) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (matches(c, d)) out.push(t - offsetMin * 60000);
    t += 60000;
  }
  return out;
}
/** The last run time at or before fromMs (for "it should have run by now"). */
function prevRun(schedule, fromMs, offsetMin = 0) {
  const c = parseSchedule(schedule);
  if (c.reboot) return null;
  let t = Math.floor((fromMs + offsetMin * 60000) / 60000) * 60000;
  const limit = t - 400 * 86400000;
  while (t > limit) { if (matches(c, new Date(t))) return t - offsetMin * 60000; t -= 60000; }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The schedule in words; falls back to the expression when it is unusual. */
function describe(schedule) {
  const t = String(schedule || '').trim().toLowerCase();
  if (t === '@reboot') return 'At every reboot';
  const exp = MACROS[t] || t;
  const p = exp.split(/\s+/);
  if (p.length !== 5) return schedule;
  const [mi, h, dom, mon, dow] = p;
  const num = /^\d+$/;
  const at = num.test(mi) && num.test(h) ? `at ${pad(h)}:${pad(mi)}` : null;
  if (mi === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  let m = /^\*\/(\d+)$/.exec(mi);
  if (m && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} minutes`;
  if (num.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return mi === '0' ? 'Every hour' : `Every hour at :${pad(mi)}`;
  m = /^\*\/(\d+)$/.exec(h);
  if (m && num.test(mi) && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} hours at :${pad(mi)}`;
  if (at && dom === '*' && mon === '*' && dow === '*') return `Every day ${at}`;
  if (at && dom === '*' && mon === '*' && /^[0-7a-z,-]+$/.test(dow)) {
    try { const days = [...field(dow, 4)].sort(); if (days.join() === '1,2,3,4,5') return `Weekdays ${at}`; return `${days.map(d => DAYS[d] + 's').join(', ')} ${at}`; } catch (e) { return schedule; }
  }
  if (at && num.test(dom) && mon === '*' && dow === '*') return `Every month on day ${dom} ${at}`;
  if (at && num.test(dom) && num.test(mon) && dow === '*') return `Every year on ${Number(dom)} ${MONTHS[Number(mon) - 1] || mon} ${at}`;
  return schedule;
}

/** Split one job line: schedule (5 fields or @macro), user (system files), command. null when it is not a job. */
function splitJob(line, system) {
  const s = line.trim();
  const at = /^(@\w+)\s+(.*)$/.exec(s);
  let schedule, rest;
  if (at) { if (!MACROS[at[1].toLowerCase()] && at[1].toLowerCase() !== '@reboot') return null; schedule = at[1]; rest = at[2]; }
  else { const p = s.split(/\s+/); if (p.length < 6) return null; schedule = p.slice(0, 5).join(' '); rest = s.replace(/^(\S+\s+){5}/, ''); }
  try { parseSchedule(schedule); } catch (e) { return null; }
  let user = null;
  if (system) { const m = /^(\S+)\s+(.*)$/.exec(rest); if (!m) return null; user = m[1]; rest = m[2]; }
  return { schedule, user, command: rest };
}

function parseCrontab(text, { system = false } = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { system, lines: lines.map(raw => {
    const s = raw.trim();
    if (!s) return { raw, kind: 'blank' };
    if (s.startsWith(OFF.trim())) { const j = splitJob(s.slice(OFF.trim().length), system); if (j) return { raw, kind: 'job', job: { ...j, enabled: false } }; }
    if (s.startsWith('#')) return { raw, kind: 'comment' };
    if (ENV.test(s)) return { raw, kind: 'env' };
    const j = splitJob(s, system);
    return j ? { raw, kind: 'job', job: { ...j, enabled: true } } : { raw, kind: 'comment', bad: true };
  }) };
}
function jobs(parsed) {
  const out = [];
  parsed.lines.forEach((l, i) => {
    if (l.kind !== 'job') return;
    const prev = i > 0 ? parsed.lines[i - 1] : null;
    let meta = null;
    if (prev && prev.kind === 'comment') { const m = META.exec(prev.raw.trim()); if (m) { try { meta = JSON.parse(m[1]); } catch (e) { meta = null; } } }
    out.push({ index: i, raw: l.raw, ...l.job, meta });
  });
  return out;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** entry { schedule, command, user?, enabled, meta? } → [metaLine?, jobLine]. Throws on bad input. */
function buildLines(entry, { system = false } = {}) {
  parseSchedule(entry.schedule);
  const cmd = String(entry.command || '').trim();
  if (!cmd) throw new Error('Command is required');
  if (/[\r\n]/.test(cmd)) throw new Error('The command must be one line');
  if (system && !USER_RE.test(String(entry.user || ''))) throw new Error('User: a user name like root');
  const meta = entry.meta && entry.meta.name ? entry.meta : null;
  if (meta && !NAME_RE.test(meta.name)) throw new Error('Name: letters, digits, . _ - (up to 41)');
  const line = `${entry.schedule.trim()} ${system ? entry.user + ' ' : ''}${cmd}`;
  return [...(meta ? [`# dockgate: ${JSON.stringify(meta)}`] : []), entry.enabled === false ? OFF + line : line];
}

/**
 * Apply one change to crontab text. op: { action: 'add'|'update'|'delete'|'toggle', index, raw, entry }.
 * index + raw name the job as it was read; a changed file refuses the change (someone edited it meanwhile).
 */
function apply(text, op, { system = false } = {}) {
  const parsed = parseCrontab(text, { system });
  const L = parsed.lines.map(l => l.raw);
  const target = op.action === 'add' ? null : parsed.lines[op.index];
  if (op.action !== 'add' && (!target || target.kind !== 'job' || target.raw !== op.raw)) throw Object.assign(new Error('The crontab changed after it was read — reload and try again'), { statusCode: 409, code: 'CHANGED' });
  const hasMeta = op.action !== 'add' && op.index > 0 && META.test((L[op.index - 1] || '').trim());
  const start = hasMeta ? op.index - 1 : op.index;
  if (op.action === 'add') { if (L.length && L[L.length - 1].trim() !== '') L.push(''); L.push(...buildLines(op.entry, { system })); }
  else if (op.action === 'delete') L.splice(start, op.index - start + 1);
  else if (op.action === 'toggle') { const j = target.job; L[op.index] = j.enabled ? OFF + L[op.index].trim() : L[op.index].trim().slice(OFF.trim().length).trim(); }
  else if (op.action === 'update') L.splice(start, op.index - start + 1, ...buildLines(op.entry, { system }));
  else throw new Error('Unknown change');
  return L.join('\n') + '\n';
}

module.exports = { MACROS, OFF, parseSchedule, nextRuns, prevRun, describe, parseCrontab, jobs, buildLines, apply, splitJob, NAME_RE };
