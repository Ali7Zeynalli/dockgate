'use strict';
// Server Console → Cron: schedules (next runs, words), crontab parsing and editing, the scripts DockGate runs on a
// server (with crontab / sudo shims, so nothing on this machine changes), the dg-cron wrapper and the alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const C = require('../../server/cron-parse');

const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
const NOW = Date.parse('2026-11-16T12:40:00Z'); // a Monday

test('next runs and the schedule in words', () => {
  assert.deepEqual(C.nextRuns('30 3 * * *', NOW, 0, 2).map(iso), ['2026-11-17T03:30', '2026-11-18T03:30']);
  assert.deepEqual(C.nextRuns('*/5 * * * *', NOW, 0, 2).map(iso), ['2026-11-16T12:45', '2026-11-16T12:50']);
  assert.deepEqual(C.nextRuns('0 4 * * 1', NOW, 240, 1).map(iso), ['2026-11-23T00:00'], 'server clock UTC+4');
  assert.deepEqual(C.nextRuns('0 0 1,15 * 5', NOW, 0, 3).map(iso), ['2026-11-20T00:00', '2026-11-27T00:00', '2026-12-01T00:00'], 'day of month OR weekday');
  assert.deepEqual(C.nextRuns('@monthly', NOW, 0, 1).map(iso), ['2026-12-01T00:00']);
  assert.deepEqual(C.nextRuns('@reboot', NOW, 0, 3), []);
  assert.equal(iso(C.prevRun('30 3 * * *', NOW, 0)), '2026-11-16T03:30');
  assert.throws(() => C.parseSchedule('61 * * * *'), /out of range/);
  assert.throws(() => C.parseSchedule('* * *'), /5 fields/);
  assert.equal(C.describe('30 3 * * *'), 'Every day at 03:30');
  assert.equal(C.describe('0 9 * * 1-5'), 'Weekdays at 09:00');
  assert.equal(C.describe('0 4 * * mon'), 'Mondays at 04:00');
  assert.equal(C.describe('15 */2 * * *'), 'Every 2 hours at :15');
  assert.equal(C.describe('@reboot'), 'At every reboot');
});

test('crontab: read jobs (with DockGate names, turned-off jobs, system files) and change them', () => {
  const t = 'SHELL=/bin/bash\nMAILTO=""\n# backups\n30 3 * * * /opt/b.sh\n# dockgate: {"name":"ping","notify":["fail"]}\n*/5 * * * * curl -s x\n#dg-off# 0 * * * * /off.sh\nnot a job line\n';
  const p = C.parseCrontab(t);
  const j = C.jobs(p);
  assert.deepEqual(j.map(x => [x.index, x.schedule, x.command, x.enabled, x.meta && x.meta.name]), [[3, '30 3 * * *', '/opt/b.sh', true, null], [5, '*/5 * * * *', 'curl -s x', true, 'ping'], [6, '0 * * * *', '/off.sh', false, null]]);
  // toggle off, toggle on: everything else stays byte for byte
  const off = C.apply(t, { action: 'toggle', index: 3, raw: '30 3 * * * /opt/b.sh' });
  assert.match(off, /^#dg-off# 30 3 \* \* \* \/opt\/b\.sh$/m);
  assert.equal(C.apply(off, { action: 'toggle', index: 3, raw: '#dg-off# 30 3 * * * /opt/b.sh' }), t);
  // update keeps the meta line in place; delete removes it too
  const up = C.apply(t, { action: 'update', index: 5, raw: '*/5 * * * * curl -s x', entry: { schedule: '*/10 * * * *', command: 'curl -s y', meta: { name: 'ping' } } });
  assert.match(up, /# dockgate: \{"name":"ping"\}\n\*\/10 \* \* \* \* curl -s y\n/);
  const del = C.apply(t, { action: 'delete', index: 5, raw: '*/5 * * * * curl -s x' });
  assert.ok(!/ping|curl/.test(del));
  const add = C.apply('', { action: 'add', entry: { schedule: '@daily', command: '/x.sh' } });
  assert.equal(add, '@daily /x.sh\n');
  // someone changed it meanwhile
  assert.throws(() => C.apply(t, { action: 'delete', index: 3, raw: '30 4 * * * /opt/b.sh' }), (e) => e.code === 'CHANGED');
  assert.throws(() => C.apply(t, { action: 'add', entry: { schedule: '* * *', command: 'x' } }), /5 fields/);
  assert.throws(() => C.apply(t, { action: 'add', entry: { schedule: '* * * * *', command: 'a\nb' } }), /one line/);
  // system file: user field
  const sys = C.jobs(C.parseCrontab('17 * * * * root cd / && run-parts --report /etc/cron.hourly\n', { system: true }));
  assert.equal(sys[0].user, 'root'); assert.equal(sys[0].command, 'cd / && run-parts --report /etc/cron.hourly');
  assert.throws(() => C.buildLines({ schedule: '* * * * *', command: 'x', user: 'bad user' }, { system: true }), /User/);
});

// ---- the server side, run here with shims for crontab and sudo ----
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-cron-'));
const BIN = path.join(BASE, 'bin'), HOME = path.join(BASE, 'home'), STORE = path.join(BASE, 'store');
fs.mkdirSync(BIN); fs.mkdirSync(HOME); fs.mkdirSync(STORE);
// crontab [-u user] (-l | -): one file per user under STORE
fs.writeFileSync(path.join(BIN, 'crontab'), `#!/bin/bash
u=deploy; [ "$1" = "-u" ] && { u="$2"; shift 2; }; [ "$1" = "-l" ] && [ "$2" = "-u" ] && u="$3"
f="${STORE}/$u"
if [ "$1" = "-l" ]; then [ -f "$f" ] && cat "$f" || { echo "no crontab for $u" >&2; exit 1; }; exit 0; fi
if [ "$1" = "-" ]; then cat > "$f"; exit 0; fi
exit 2
`, { mode: 0o755 });
// sudo -n …: run it as is; "install -o root …" and /etc paths are mapped under BASE
fs.writeFileSync(path.join(BIN, 'sudo'), `#!/bin/bash
[ "$1" = "-n" ] && shift
if [ "$1" = "install" ]; then shift; args=(); while [ $# -gt 0 ]; do case "$1" in -o|-g|-m) shift 2;; -D) shift;; *) args+=("$1"); shift;; esac; done; mkdir -p "$(dirname "${BASE}\${args[1]}")"; cp "\${args[0]}" "${BASE}\${args[1]}" && chmod 755 "${BASE}\${args[1]}"; exit $?; fi
if [ "$1" = "mkdir" ]; then shift; [ "$1" = "-p" ] && shift; mkdir -p "${BASE}$1"; exit; fi
exec "$@"
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'id'), '#!/bin/bash\n[ "$1" = "-un" ] && echo deploy && exit 0; [ "$1" = "-u" ] && echo 1000 && exit 0; /usr/bin/id "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'pgrep'), '#!/bin/bash\n[ "$2" = "cron" ] && exit 0; exit 1\n', { mode: 0o755 });
const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, HOME };
const runLocal = (cmd) => new Promise((res) => execFile('bash', ['-c', cmd], { env, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code || 1) : 0, stdout: String(so), stderr: String(se) })));
const rcPath = require.resolve('../../server/remote-compose');
const realRc = require(rcPath);
require.cache[rcPath].exports = { ...realRc, execRemote: async (_s, cmd) => runLocal(cmd) };
const cron = require('../../server/cron');
const SRV = { id: 'srv1', name: 'prod-1' };

test('read and change crontabs on a server; turned off / deleted jobs; the wrapper records each run', async () => {
  fs.writeFileSync(path.join(STORE, 'deploy'), '# dockgate: {"name":"ping"}\n*/5 * * * * echo hi\n');
  let d = await cron.read(SRV);
  assert.equal(d.sshUser, 'deploy'); assert.equal(d.sudo, true); assert.equal(d.cronRunning, true);
  const user = d.sources.find(s => s.id === 'user');
  assert.equal(user.jobs[0].meta.name, 'ping'); assert.equal(user.jobs[0].human, 'Every 5 minutes'); assert.equal(user.jobs[0].next.length, 5);
  assert.equal(d.sources.find(s => s.id === 'root').jobs.length, 0, 'no crontab for root yet');
  // add a root job with log + notify: the preview changes nothing
  const op = { action: 'add', entry: { schedule: '30 3 * * *', command: 'echo backup; exit 3', meta: { name: 'db-backup', notify: ['fail', 'missed'], log: true } } };
  const pv = await cron.change(SRV, 'root', op, { preview: true });
  assert.equal(pv.before, ''); assert.match(pv.after, /\/usr\/local\/lib\/dockgate\/dg-cron db-backup echo backup; exit 3 >> \/var\/log\/dockgate-cron\/db-backup\.log 2>&1/);
  assert.equal(fs.existsSync(path.join(STORE, 'root')), false);
  await cron.change(SRV, 'root', op);
  assert.match(fs.readFileSync(path.join(STORE, 'root'), 'utf8'), /# dockgate: \{"name":"db-backup","notify":\["fail","missed"\],"log":true\}/);
  assert.ok(fs.existsSync(path.join(BASE, '/usr/local/lib/dockgate/dg-cron')), 'wrapper installed (root-owned copy)');
  // the wrapper: runs the command, keeps its output and how it ended
  const w = path.join(BASE, '/usr/local/lib/dockgate/dg-cron');
  const wr = fs.readFileSync(w, 'utf8').replace('/var/lib/dockgate/cron', path.join(BASE, 'state'));
  fs.writeFileSync(w, wr, { mode: 0o755 });
  const out = await runLocal(`${w} db-backup 'echo backup; exit 3'`);
  assert.match(out.stdout, /backup/); assert.equal(out.code, 3);
  const last = fs.readFileSync(path.join(BASE, 'state', 'db-backup.last'), 'utf8').trim().split(' ').map(Number);
  assert.equal(last[2], 3); assert.ok(last[1] >= last[0]);
  // edit shows the command without DockGate's wrapper; toggle and delete
  d = await cron.read(SRV);
  const job = d.sources.find(s => s.id === 'root').jobs[0];
  assert.equal(cron.unwrapCommand(job.command), 'echo backup; exit 3');
  await cron.change(SRV, 'root', { action: 'toggle', index: job.index, raw: job.raw });
  d = await cron.read(SRV);
  assert.equal(d.sources.find(s => s.id === 'root').jobs[0].enabled, false);
  const j2 = d.sources.find(s => s.id === 'root').jobs[0];
  await cron.change(SRV, 'root', { action: 'delete', index: j2.index, raw: j2.raw });
  assert.ok(!/db-backup/.test(fs.readFileSync(path.join(STORE, 'root'), 'utf8')));
  // DockGate's /etc/cron.d file (system format, with a user)
  await cron.change(SRV, 'dockgate', { action: 'add', entry: { schedule: '0 * * * *', command: '/opt/sync.sh', user: 'www-data' } });
  assert.equal(fs.readFileSync(path.join(BASE, '/etc/cron.d/dockgate'), 'utf8'), '0 * * * * www-data /opt/sync.sh\n');
  // read-only sources are refused
  await assert.rejects(cron.change(SRV, 'etc', { action: 'add', entry: { schedule: '* * * * *', command: 'x' } }), /read only/);
  // run now
  const r = await cron.runNow(SRV, 'user', 'echo one; echo two; exit 4', 'deploy');
  assert.equal(r.code, 4); assert.match(r.output, /one\ntwo/);
});

test('parsing systemd timers, cron log lines and the wrapper state', () => {
  const t = cron.parseTimers('Id=apt-daily.timer\nUnit=apt-daily.service\nActiveState=active\nNextElapseUSecRealtime=Mon 2026-11-16 18:12:00 UTC\nLastTriggerUSec=Mon 2026-11-16 06:02:00 UTC\nTimersCalendar={ OnCalendar=*-*-* 06,18:00:00 ; next_elapse=… }\n\nId=old.timer\nActiveState=inactive\n');
  assert.equal(t.length, 1); assert.equal(t[0].calendar, '*-*-* 06,18:00:00'); assert.equal(iso(t[0].next), '2026-11-16T18:12');
  const runs = cron.parseRuns('1794830400.123 host CRON[123]: (root) CMD (/opt/b.sh)\n');
  assert.equal(runs.get('root\u0000/opt/b.sh'), 1794830400123);
  assert.deepEqual(cron.parseState('root db-backup 100 104 3\n'), { 'root:db-backup': { start: 100000, end: 104000, code: 3 } });
  assert.equal(cron.offsetMin('+0400'), 240); assert.equal(cron.offsetMin('-0530'), -330);
});

test('alerts: failed once per run, did not run once per due time', () => {
  const M = require('../../server/cron-monitor');
  const job = (o) => ({ index: 1, enabled: true, schedule: '30 3 * * *', human: 'Every day at 03:30', user: 'root', meta: { name: 'db', notify: ['fail', 'missed'] }, ...o });
  const info = (j) => ({ offsetMin: 0, sources: [{ id: 'root', jobs: [j] }] });
  const seen = {};
  const t0 = Date.parse('2026-11-15T12:00:00Z');
  assert.deepEqual(M.evaluate(info(job({ lastRun: null, lastEnd: null })), seen, t0), [], 'first look: remember only');
  // it ran at 03:30 and failed
  let a = M.evaluate(info(job({ lastRun: Date.parse('2026-11-16T03:30:00Z'), lastEnd: Date.parse('2026-11-16T03:30:04Z'), lastCode: 1 })), seen, Date.parse('2026-11-16T03:40:00Z'));
  assert.deepEqual(a.map(x => x.type), ['cron_failed']);
  a = M.evaluate(info(job({ lastRun: Date.parse('2026-11-16T03:30:00Z'), lastEnd: Date.parse('2026-11-16T03:30:04Z'), lastCode: 1 })), seen, Date.parse('2026-11-16T03:50:00Z'));
  assert.deepEqual(a, [], 'same run: not again');
  // next day it did not start at all
  a = M.evaluate(info(job({ lastRun: Date.parse('2026-11-16T03:30:00Z'), lastEnd: Date.parse('2026-11-16T03:30:04Z'), lastCode: 1 })), seen, Date.parse('2026-11-17T04:10:00Z'));
  assert.deepEqual(a.map(x => x.type), ['cron_missed']);
  a = M.evaluate(info(job({ lastRun: Date.parse('2026-11-16T03:30:00Z'), lastEnd: Date.parse('2026-11-16T03:30:04Z'), lastCode: 1 })), seen, Date.parse('2026-11-17T05:00:00Z'));
  assert.deepEqual(a, [], 'same due time: not again');
  // ok run: nothing
  a = M.evaluate(info(job({ lastRun: Date.parse('2026-11-18T03:30:00Z'), lastEnd: Date.parse('2026-11-18T03:30:02Z'), lastCode: 0 })), seen, Date.parse('2026-11-18T04:10:00Z'));
  assert.deepEqual(a, []);
});
