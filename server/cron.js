// Server Console → Cron: the scheduled jobs of a server, over its SSH login.
//   read(server)                  every source in one round trip: the SSH user's crontab, root's crontab (sudo),
//                                 /etc/cron.d/dockgate (DockGate's own file), /etc/crontab, /etc/cron.d/*,
//                                 cron.hourly/daily/weekly/monthly, systemd timers, whether cron runs, the clock
//   change(server, source, op)    add / edit / turn off / delete a job in one of the editable sources, with
//                                 { preview } returning the text before and after; the old text is kept (Versions)
//   runNow(server, source, job)   run a job's command once, as its user, and return its output
// Editable sources: 'user' (crontab -), 'root' (sudo crontab -u root -), 'dockgate' (/etc/cron.d/dockgate, root, 0644).
// Everything else is read only: system and package files are not rewritten.
const remoteExec = require('./remote-compose');
const C = require('./cron-parse');
const shq = remoteExec.shq;
const SECT = '__DGCRON__';
const SOURCES = ['user', 'root', 'dockgate'];
const DG_FILE = '/etc/cron.d/dockgate';

// Wrapper that records each run of a job (exit code, start, end, last output) for the "failed / did not run"
// alerts. Root jobs use a root-owned copy, so a job of root never runs a file another user could change.
const WRAP_ROOT = '/usr/local/lib/dockgate/dg-cron', STATE_ROOT = '/var/lib/dockgate/cron';
const WRAP_USER = '$HOME/.dockgate/bin/dg-cron', STATE_USER = '$HOME/.dockgate/cron';
const wrapper = (stateDir) => `#!/bin/sh
# DockGate: runs a cron job and records how it ended (Server Console -> Cron). Usage: dg-cron NAME COMMAND...
n="$1"; shift
d="${stateDir}"; mkdir -p "$d" 2>/dev/null
s=$(date +%s); o=$(mktemp 2>/dev/null || echo "/tmp/dg-cron.$$")
sh -c "$*" > "$o" 2>&1; rc=$?
e=$(date +%s)
cat "$o"; tail -c 4000 "$o" > "$d/$n.out" 2>/dev/null; rm -f "$o"
printf '%s %s %s\\n' "$s" "$e" "$rc" > "$d/$n.last"
exit $rc
`;

function readScript() {
  const s = (name) => `echo "${SECT}${name}"`;
  return [
    s('id'), 'id -un; date +%s; date +%z; date +%Z',
    s('cronrun'), '(pgrep -x cron || pgrep -x crond || pgrep -f "busybox crond" || pgrep -x cronie) >/dev/null 2>&1 && echo yes || echo no',
    s('sudo'), 'sudo -n true 2>/dev/null && echo yes || echo no',
    s('user'), 'crontab -l 2>&1; echo "__RC__$?"',
    s('root'), '[ "$(id -u)" = 0 ] && { crontab -l 2>&1; echo "__RC__$?"; } || { sudo -n crontab -l -u root 2>&1; echo "__RC__$?"; }',
    s('etccrontab'), 'cat /etc/crontab 2>/dev/null || sudo -n cat /etc/crontab 2>/dev/null',
    s('crond'), `for f in /etc/cron.d/*; do [ -f "$f" ] || continue; echo "__FILE__$f"; cat "$f" 2>/dev/null || sudo -n cat "$f" 2>/dev/null; done`,
    s('periodic'), 'for p in hourly daily weekly monthly; do [ -d /etc/cron.$p ] && for f in /etc/cron.$p/*; do [ -f "$f" ] && echo "$p $(basename "$f")"; done; done',
    s('timers'), 'command -v systemctl >/dev/null 2>&1 && systemctl show --all --property=Id,ActiveState,NextElapseUSecRealtime,LastTriggerUSec,TimersCalendar,Unit "*.timer" --no-pager 2>/dev/null',
    s('runs'), `{ command -v journalctl >/dev/null 2>&1 && journalctl -t CRON -t crond -t cron --since "-2 days" -o short-unix --no-pager -q 2>/dev/null || sudo -n journalctl -t CRON -t crond --since "-2 days" -o short-unix --no-pager -q 2>/dev/null; } | grep -E "CMD|CMDEND" | tail -n 800`,
    s('state'), `for f in ${STATE_USER}/*.last; do [ -f "$f" ] && echo "user $(basename "$f" .last) $(cat "$f")"; done; for f in ${STATE_ROOT}/*.last; do [ -f "$f" ] && echo "root $(basename "$f" .last) $(cat "$f" 2>/dev/null || sudo -n cat "$f" 2>/dev/null)"; done; true`,
    s('end'),
  ].join('\n');
}

function sections(out) {
  const res = {}; let cur = null;
  for (const line of String(out || '').split('\n')) {
    if (line.startsWith(SECT)) { cur = line.slice(SECT.length).trim(); res[cur] = []; continue; }
    if (cur) res[cur].push(line);
  }
  for (const k of Object.keys(res)) res[k] = res[k].join('\n').replace(/\n$/, '');
  return res;
}
function rc(text) { const m = /__RC__(\d+)\s*$/.exec(text || ''); return { code: m ? Number(m[1]) : 1, text: String(text || '').replace(/__RC__\d+\s*$/, '').replace(/\n$/, '') }; }
const noCrontab = (t) => /no crontab for/i.test(t);

// systemd timers: blocks of key=value separated by a blank line
function parseTimers(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const o = {}; block.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); });
    if (!o.Id || !o.Id.endsWith('.timer')) continue;
    const cal = /OnCalendar=([^;]+?)\s*;/.exec(o.TimersCalendar || '');
    const ts = (v) => { const t = Date.parse(String(v || '').replace(/^\w{3} /, '').replace(/ ([A-Z]{2,5})$/, '')); return Number.isFinite(t) ? t : null; };
    out.push({ unit: o.Id, runs: o.Unit || '', active: o.ActiveState, calendar: cal ? cal[1].trim() : '', next: ts(o.NextElapseUSecRealtime), last: ts(o.LastTriggerUSec) });
  }
  return out.filter(t => t.active === 'active' || t.next);
}
// Last run of each command from the cron log: "<unix> host CRON[pid]: (root) CMD (command)"
function parseRuns(text) {
  const last = new Map();
  for (const l of String(text || '').split('\n')) {
    const m = /^(\d+(?:\.\d+)?)\s.*?\((\S+)\) CMD \((.*)\)\s*$/.exec(l);
    if (m) last.set(`${m[2]}\u0000${m[3]}`, Math.round(Number(m[1]) * 1000));
  }
  return last;
}
function parseState(text) {
  const out = {};
  for (const l of String(text || '').split('\n')) { const p = l.trim().split(/\s+/); if (p.length >= 5) out[`${p[0]}:${p[1]}`] = { start: Number(p[2]) * 1000, end: Number(p[3]) * 1000, code: Number(p[4]) }; }
  return out;
}
function splitFiles(text) {
  const files = []; let cur = null;
  for (const l of String(text || '').split('\n')) { if (l.startsWith('__FILE__')) { cur = { path: l.slice(8), lines: [] }; files.push(cur); } else if (cur) cur.lines.push(l); }
  return files.map(f => ({ path: f.path, text: f.lines.join('\n') }));
}
const offsetMin = (z) => { const m = /^([+-])(\d\d)(\d\d)$/.exec(String(z || '').trim()); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0; };

/** Everything about the server's cron, ready for the page. */
async function read(server) {
  const r = await remoteExec.execRemote(server, readScript());
  const S = sections(r.stdout);
  const [sshUser, nowS, tz, tzName] = String(S.id || '').split('\n');
  const now = Number(nowS) * 1000 || Date.now(), off = offsetMin(tz);
  const runs = parseRuns(S.runs), state = parseState(S.state);
  const sources = [];
  const decorate = (j, user, source) => {
    let next = [], human = j.schedule, error = null;
    try { next = j.enabled ? C.nextRuns(j.schedule, now, off, 5) : []; human = C.describe(j.schedule); } catch (e) { error = e.message; }
    const st = j.meta && j.meta.name ? state[`${source === 'user' ? 'user' : 'root'}:${j.meta.name}`] : null;
    const logRun = runs.get(`${j.user || user}\u0000${j.command}`) || null;
    return { ...j, user: j.user || user, source, human, next, error, lastRun: st ? st.start : logRun, lastEnd: st ? st.end : null, lastCode: st ? st.code : null };
  };
  const add = (id, label, text, { editable, system = false, user, note } = {}) => {
    const parsed = C.parseCrontab(text, { system });
    sources.push({ id, label, editable: !!editable, system, note: note || null, text, jobs: C.jobs(parsed).map(j => decorate(j, user, id)) });
  };
  const u = rc(S.user);
  add('user', `${sshUser} (SSH user) — crontab`, u.code === 0 ? u.text : '', { editable: true, user: sshUser, note: u.code !== 0 && !noCrontab(u.text) ? u.text.slice(0, 200) : null });
  const sudo = String(S.sudo).trim() === 'yes' || sshUser === 'root';
  if (sshUser !== 'root') {
    const ro = rc(S.root);
    add('root', 'root — crontab', ro.code === 0 ? ro.text : '', { editable: sudo, user: 'root', note: !sudo ? 'Needs passwordless sudo to read and change root\'s crontab' : ro.code !== 0 && !noCrontab(ro.text) ? ro.text.slice(0, 200) : null });
  }
  const files = splitFiles(S.crond);
  const dg = files.find(f => f.path === DG_FILE);
  add('dockgate', `${DG_FILE} — DockGate's file`, dg ? dg.text : '', { editable: sudo, system: true, user: 'root', note: !sudo ? 'Needs passwordless sudo' : null });
  if (S.etccrontab) add('etc', '/etc/crontab (system)', S.etccrontab, { system: true, user: 'root' });
  for (const f of files.filter(f => f.path !== DG_FILE)) add(`file:${f.path}`, `${f.path} (package / system)`, f.text, { system: true, user: 'root' });
  const periodic = String(S.periodic || '').split('\n').filter(Boolean).map(l => { const [p, name] = l.split(' '); return { period: p, name }; });
  return {
    sshUser, sudo, cronRunning: String(S.cronrun).trim() === 'yes', now, tz: tz || '+0000', tzName: tzName || '', offsetMin: off,
    sources, periodic, timers: parseTimers(S.timers), dgFile: DG_FILE,
  };
}

async function sourceText(server, source) {
  if (source === 'user') { const r = await remoteExec.execRemote(server, 'crontab -l 2>&1; echo "__RC__$?"'); const x = rc(r.stdout); return x.code === 0 ? x.text + (x.text ? '\n' : '') : (noCrontab(x.text) ? '' : Promise.reject(Object.assign(new Error(x.text), { statusCode: 500 }))); }
  if (source === 'root') { const r = await remoteExec.execRemote(server, '[ "$(id -u)" = 0 ] && crontab -l 2>&1 || sudo -n crontab -l -u root 2>&1; echo "__RC__$?"'); const x = rc(r.stdout); if (x.code === 0) return x.text + (x.text ? '\n' : ''); if (noCrontab(x.text)) return ''; throw Object.assign(new Error(/password/i.test(x.text) ? 'sudo asks for a password — root\'s crontab needs passwordless sudo' : x.text.slice(0, 200)), { statusCode: 403 }); }
  if (source === 'dockgate') { const r = await remoteExec.execRemote(server, `cat ${DG_FILE} 2>/dev/null || sudo -n cat ${DG_FILE} 2>/dev/null; true`); return String(r.stdout || ''); }
  throw Object.assign(new Error('This source is read only'), { statusCode: 400 });
}

async function writeSource(server, source, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  let cmd;
  if (source === 'user') cmd = `printf %s ${shq(b64)} | base64 -d | crontab - 2>&1`;
  else if (source === 'root') cmd = `printf %s ${shq(b64)} | base64 -d | { [ "$(id -u)" = 0 ] && crontab - || sudo -n crontab -u root -; } 2>&1`;
  else if (source === 'dockgate') cmd = `t=$(mktemp) && printf %s ${shq(b64)} | base64 -d > "$t" && sudo -n install -o root -g root -m 0644 "$t" ${DG_FILE} 2>&1; rc=$?; rm -f "$t"; exit $rc`;
  else throw Object.assign(new Error('This source is read only'), { statusCode: 400 });
  const r = await remoteExec.execRemote(server, cmd);
  if (r.code !== 0) throw Object.assign(new Error(`Could not save: ${String(r.stdout || r.stderr || '').trim().slice(0, 300) || 'error'}`), { statusCode: /password/i.test(r.stdout || '') ? 403 : 500 });
}

/** Wrap a command so its end is recorded (notify) and / or its output is kept in a log file. */
function wrapCommand(cmd, meta, source) {
  let c = String(cmd).trim();
  const root = source !== 'user';
  if (meta && meta.name && meta.notify && meta.notify.length) c = `${root ? WRAP_ROOT : WRAP_USER.replace('$HOME', '~')} ${meta.name} ${c}`;
  if (meta && meta.name && meta.log) c += ` >> ${root ? '/var/log/dockgate-cron' : '~/.dockgate/cron-logs'}/${meta.name}.log 2>&1`;
  return c;
}
/** The command as the person wrote it (without DockGate's wrapper and log redirect). */
function unwrapCommand(cmd) {
  return String(cmd).replace(/^(\/usr\/local\/lib\/dockgate\/dg-cron|~\/\.dockgate\/bin\/dg-cron)\s+\S+\s+/, '').replace(/\s+>>\s+(\/var\/log\/dockgate-cron|~\/\.dockgate\/cron-logs)\/[\w.-]+\.log 2>&1$/, '');
}
async function ensureHelpers(server, source, meta) {
  if (!meta || !meta.name) return;
  const root = source !== 'user';
  const parts = [];
  if (meta.notify && meta.notify.length) {
    const b64 = Buffer.from(wrapper(root ? STATE_ROOT : STATE_USER.replace('$HOME', '$HOME')), 'utf8').toString('base64');
    parts.push(root ? `t=$(mktemp) && printf %s ${shq(b64)} | base64 -d > "$t" && sudo -n install -D -o root -g root -m 0755 "$t" ${WRAP_ROOT} && sudo -n mkdir -p ${STATE_ROOT}; rm -f "$t"`
      : `mkdir -p "$HOME/.dockgate/bin" "$HOME/.dockgate/cron" && printf %s ${shq(b64)} | base64 -d > "$HOME/.dockgate/bin/dg-cron" && chmod 0755 "$HOME/.dockgate/bin/dg-cron"`);
  }
  if (meta.log) parts.push(root ? 'sudo -n mkdir -p /var/log/dockgate-cron' : 'mkdir -p "$HOME/.dockgate/cron-logs"');
  if (!parts.length) return;
  const r = await remoteExec.execRemote(server, parts.join(' && ') + ' 2>&1');
  if (r.code !== 0) throw Object.assign(new Error(`Could not set up the job's helpers: ${String(r.stdout || '').trim().slice(0, 200)}`), { statusCode: 500 });
}

/** Apply one change to an editable source. preview → { before, after } without writing. */
async function change(server, source, op, { preview = false, serverId } = {}) {
  if (!SOURCES.includes(source)) throw Object.assign(new Error('This source is read only — open it in Files to edit it yourself'), { statusCode: 400 });
  const system = source === 'dockgate';
  const entry = op.entry ? { ...op.entry } : null;
  if (entry) {
    const meta = entry.meta && entry.meta.name ? { name: String(entry.meta.name).trim(), ...(entry.meta.notify && entry.meta.notify.length ? { notify: entry.meta.notify.filter(x => x === 'fail' || x === 'missed') } : {}), ...(entry.meta.log ? { log: true } : {}) } : null;
    if ((entry.meta && (entry.meta.log || (entry.meta.notify || []).length)) && !meta) throw new Error('Give the job a name to keep its log or to be notified');
    if (meta && !C.NAME_RE.test(meta.name)) throw new Error('Name: letters, digits, . _ - (up to 41)');
    entry.meta = meta;
    entry.command = wrapCommand(unwrapCommand(entry.command), meta, source);
    if (system && !entry.user) entry.user = 'root';
  }
  const before = await sourceText(server, source);
  const after = C.apply(before, { ...op, entry }, { system });
  if (preview) return { before, after };
  if (entry && entry.meta) await ensureHelpers(server, source, entry.meta);
  await writeSource(server, source, after);
  try { require('./file-versions').save(serverId || server.id, `cron:${source}`, before); } catch (e) { /* versions are best effort */ }
  try { require('./cron-monitor').remember(serverId || server.id); } catch (e) { /* monitor optional */ }
  return { before, after };
}

/** Run a job's command once as its user (root jobs with sudo). Up to 2 minutes. */
async function runNow(server, source, command, user) {
  const cmd = unwrapCommand(command);
  const asRoot = source !== 'user' && user === 'root';
  const script = `s=$(date +%s%N); ${asRoot ? `sudo -n sh -c ${shq(cmd)}` : `sh -c ${shq(cmd)}`} 2>&1 | tail -c 20000; rc=\${PIPESTATUS[0]:-$?}; e=$(date +%s%N); echo "__DGRUN__$rc $(( (e - s) / 1000000 ))"`;
  let timer;
  const r = await Promise.race([
    remoteExec.execRemote(server, `bash -c ${shq(script)}`),
    new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Still running after 2 minutes — it goes on on the server; see its log'), { statusCode: 504 })), 120000); }),
  ]).finally(() => clearTimeout(timer));
  const out = String(r.stdout || '') + String(r.stderr || '');
  const m = /__DGRUN__(\d+) (\d+)\s*$/.exec(out);
  return { output: out.replace(/__DGRUN__\d+ \d+\s*$/, '').trimEnd(), code: m ? Number(m[1]) : r.code, ms: m ? Number(m[2]) : null };
}

module.exports = { read, change, runNow, sourceText, wrapCommand, unwrapCommand, wrapper, readScript, sections, parseTimers, parseRuns, parseState, offsetMin, SOURCES, DG_FILE, WRAP_ROOT, STATE_ROOT };
