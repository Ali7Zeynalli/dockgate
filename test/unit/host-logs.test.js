const { test } = require('node:test');
const assert = require('node:assert');
const hl = require('../../server/host-logs');

test('host-logs: curated quick-pick sources exist', () => {
  for (const k of ['journald', 'auth', 'syslog', 'kernel', 'boot']) {
    assert.ok(hl.SOURCES[k], `source ${k} present`);
    assert.ok(hl.SOURCES[k].includes('%N'), `${k} has the clamped-lines placeholder`);
  }
});

test('host-logs.isLogFile: only /var/log, no traversal, no shell metachars', () => {
  // valid
  assert.equal(hl.isLogFile('/var/log/fail2ban.log'), true);
  assert.equal(hl.isLogFile('/var/log/nginx/access.log'), true);
  assert.equal(hl.isLogFile('/var/log/syslog'), true);
  // invalid — outside /var/log
  assert.equal(hl.isLogFile('/etc/passwd'), false);
  assert.equal(hl.isLogFile('/var/logs/x'), false, 'prefix must be exactly /var/log/');
  // invalid — traversal
  assert.equal(hl.isLogFile('/var/log/../../etc/shadow'), false);
  // invalid — injection / metacharacters
  assert.equal(hl.isLogFile("/var/log/x; rm -rf /"), false);
  assert.equal(hl.isLogFile('/var/log/$(reboot)'), false);
  assert.equal(hl.isLogFile('/var/log/`id`'), false);
  // invalid — non-absolute / non-string
  assert.equal(hl.isLogFile('var/log/syslog'), false);
  assert.equal(hl.isLogFile(null), false);
});

test('host-logs.isValidUnit: systemd unit charset only (injection-safe)', () => {
  assert.equal(hl.isValidUnit('fail2ban.service'), true);
  assert.equal(hl.isValidUnit('docker'), true);
  assert.equal(hl.isValidUnit('user@1000.service'), true);
  assert.equal(hl.isValidUnit('a b'), false);
  assert.equal(hl.isValidUnit('x;rm -rf /'), false);
  assert.equal(hl.isValidUnit('`id`'), false);
  assert.equal(hl.isValidUnit('$(reboot)'), false);
  assert.equal(hl.isValidUnit(''), false);
  assert.equal(hl.isValidUnit(null), false);
});

test('host-logs.collectHostLogs: rejects an invalid unit / file before spawning', async () => {
  await assert.rejects(() => hl.collectHostLogs({ host: 'x' }, { unit: 'a;b' }, 100), /invalid unit/);
  await assert.rejects(() => hl.collectHostLogs({ host: 'x' }, { file: '/etc/passwd' }, 100), /under \/var\/log/);
  await assert.rejects(() => hl.collectHostLogs({ host: 'x' }, { source: 'nope' }, 100), /unknown log source/);
});
