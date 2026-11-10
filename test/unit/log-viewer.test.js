// The shared log viewer (public/js/log-viewer.js) reads text lines from many sources. Its line reader and the
// limits behind "Last 1,000 … 10,000" are checked here without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const hl = require('../../server/host-logs');
const Storage = require('../../agent/src/storage');

const ctx = { window: {}, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/log-viewer.js'), 'utf8'), ctx);
const LV = ctx.window.LogViewer;

test('limits offered: 1,000 / 2,000 / 5,000 / 8,000 / 10,000', () => {
  assert.deepEqual([...LV.LIMITS], [1000, 2000, 5000, 8000, 10000]);
});

test('Docker line: RFC 3339 time, message kept whole', () => {
  const r = LV.parseLine('2026-11-09T10:15:30.123456789Z GET /api 500 error: db down', 'docker');
  assert.equal(r.t, Date.parse('2026-11-09T10:15:30.123Z'));
  assert.equal(r.src, '');
  assert.equal(r.msg, 'GET /api 500 error: db down');
  assert.equal(r.l, 'E');
});

test('journald short-iso: time, unit as source, PID dropped', () => {
  const r = LV.parseLine('2026-11-09T10:15:30+0400 web1 sshd[812]: Invalid user admin from 1.2.3.4 port 5022');
  assert.equal(r.t, Date.parse('2026-11-09T10:15:30+04:00'));
  assert.equal(r.src, 'sshd');
  assert.equal(r.msg, 'Invalid user admin from 1.2.3.4 port 5022');
  assert.equal(r.l, 'W');
});

test('fail2ban log: jail as source, Ban = warning, Unban = info, ERROR = error', () => {
  const ban = LV.parseLine('2026-11-09 10:15:30,123 fail2ban.actions        [811]: NOTICE  [sshd] Ban 1.2.3.4');
  assert.equal(ban.src, 'sshd'); assert.equal(ban.msg, 'Ban 1.2.3.4'); assert.equal(ban.l, 'W');
  assert.equal(ban.t, new Date(2026, 10, 9, 10, 15, 30).getTime(), 'fail2ban writes local time');
  assert.equal(LV.parseLine('2026-11-09 10:20:30,123 fail2ban.actions        [811]: NOTICE  [sshd] Unban 1.2.3.4').l, 'I');
  assert.equal(LV.parseLine('2026-11-09 10:20:30,123 fail2ban.filter         [811]: ERROR   [recidive] cannot read log').l, 'E');
});

test('classic syslog: month day time host program[pid]: message', () => {
  const r = LV.parseLine('Nov  9 10:15:30 web1 kernel: Out of memory: Killed process 4242 (node)');
  assert.equal(r.src, 'kernel');
  assert.equal(r.msg, 'Out of memory: Killed process 4242 (node)');
  assert.equal(r.l, 'E');
  assert.equal(new Date(r.t).getDate(), 9);
});

test('plain lines: no time, level from words', () => {
  assert.equal(LV.parseLine('Step 3/9 : RUN npm ci').t, null);
  assert.equal(LV.levelOf('npm WARN deprecated foo'), 'W');
  assert.equal(LV.levelOf('DEBUG cache hit'), 'D');
  assert.equal(LV.levelOf('Server listening on 3000'), 'I');
  assert.equal(LV.levelOf('{"level":"error","msg":"x"}'), 'E');
  assert.equal(LV.levelOf('a profile was loaded'), 'I', '"error" inside another word does not count');
});

test('host logs: up to 10,000 lines, cut by lines (a long line never pushes the newest out)', () => {
  assert.equal(hl.MAX_LINES, 10000);
  const text = Array.from({ length: 12000 }, (_, i) => (i === 11990 ? 'x'.repeat(300000) : `line ${i}`)).join('\n') + '\n';
  const out = hl.lastLines(text, 10000).split('\n');
  assert.equal(out.length, 10000);
  assert.equal(out[out.length - 1], 'line 11999');
  assert.equal(out[0], 'line 2000');
});

test('Edge agent returns up to its whole buffer (10,000), not 1,000', () => {
  const s = new Storage({ maxLogs: 10000 });
  for (let i = 0; i < 6000; i++) s.addLog({ containerName: 'a', stream: 'stdout', message: `m ${i}` });
  assert.equal(s.getLogs({ limit: 5000 }).returned, 5000);
  assert.equal(s.getLogs({ limit: 99999 }).returned, 6000);
});
