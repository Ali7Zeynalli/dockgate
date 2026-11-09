// Unit tests for the fail2ban helpers — the maths and parsing the Fail2ban tab relies on.
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../../server/security/fail2ban');

test('fail2ban: durations parse like fail2ban does', () => {
  assert.equal(F.toSeconds('600'), 600);
  assert.equal(F.toSeconds('24h'), 86400);
  assert.equal(F.toSeconds('1d12h'), 129600);
  assert.equal(F.toSeconds('1w'), 604800);
  assert.equal(F.toSeconds('1x'), null);
  assert.equal(F.toSeconds('1d; rm'), null);
});

test('fail2ban: ban lengths follow fail2ban\'s default increment formula (bantime × 2^n × factor, capped)', () => {
  const day = 86400;
  // factor 2 (the admin's config): 1d → 4d → 8d → 16d → 30d (cap)
  assert.deepEqual(F.banSequence({ bantime: '24h', increment: true, factor: 2, maxtime: '30d' }, 6).map(s => s / day), [1, 4, 8, 16, 30, 30]);
  // factor 1: 1d → 2d → 4d → 8d → 16d → 30d
  assert.deepEqual(F.banSequence({ bantime: '24h', increment: true, factor: 1, maxtime: '30d' }, 6).map(s => s / day), [1, 2, 4, 8, 16, 30]);
  // no increment: always the same
  assert.deepEqual(F.banSequence({ bantime: '1h', increment: false, factor: 2, maxtime: '30d' }, 3), [3600, 3600, 3600]);
});

test('fail2ban: ban history memory = dbpurgeage + 3 × bantime (fail2ban\'s bips purge rule)', () => {
  assert.equal(F.memoryAfterBan(86400, 86400), 4 * 86400);
});

test('fail2ban: settings are validated; whitelist accepts IPs/CIDRs only', () => {
  const ok = F.normalizeSettings({ ...F.DEFAULTS, ignoreip: ['198.51.100.24', '10.0.0.0/8', ' '] });
  assert.deepEqual(ok.ignoreip, ['198.51.100.24', '10.0.0.0/8']);
  assert.throws(() => F.normalizeSettings({ ...F.DEFAULTS, ignoreip: ['1.2.3.4; rm -rf /'] }), e => e.statusCode === 400);
  assert.throws(() => F.normalizeSettings({ ...F.DEFAULTS, sshd: { ...F.DEFAULTS.sshd, bantime: '1 day' } }), e => e.statusCode === 400);
  assert.throws(() => F.normalizeSettings({ ...F.DEFAULTS, sshd: { ...F.DEFAULTS.sshd, mode: 'evil' } }), e => e.statusCode === 400);
});

test('fail2ban: generated files — sshd on the real port, recidive reads the log FILE, history kept', () => {
  const s = F.normalizeSettings(F.DEFAULTS);
  const jail = F.buildJailConf(s, 2222);
  assert.match(jail, /^\[sshd\][\s\S]*^port = 2222$/m);
  assert.match(jail, /^\[recidive\][\s\S]*^backend = auto$[\s\S]*^logpath = \/var\/log\/fail2ban\.log$/m);
  assert.match(jail, /^bantime\.factor = 2$/m);
  assert.match(F.buildDaemonConf(s), /^dbpurgeage = 30d$/m);
  const back = F.parseJailConf(jail);
  assert.equal(back.sshd.maxretry, 3);
  assert.equal(back.recidive.findtime, '30d');
  assert.deepEqual(back.ignoreip, []);
});

test('fail2ban: problems — impossible recidive, wrong port, short memory, banned DockGate', () => {
  const user = { ...F.DEFAULTS, recidive: { enabled: true, maxretry: 5, findtime: '1d', bantime: '1w' }, dbpurgeage: '1d' };
  const p = F.detectProblems({ settings: user, runtime: { dbpurgeage: 86400, jails: ['sshd', 'recidive'], recidiveLogpath: 'No file is currently monitored' }, sshPort: 2222, jailPort: '22', dockgateIp: '192.0.2.1', banned: ['192.0.2.1'] });
  const text = p.map(x => x.text).join('\n');
  assert.match(text, /DockGate's own IP/);
  assert.match(text, /bans port 22, but SSH listens on 2222/);
  assert.match(text, /recidive can never trigger/);
  assert.match(text, /recidive reads the systemd journal, not a log file, instead of \/var\/log\/fail2ban\.log/);
  assert.match(text, /Ban history is kept only about 4d/);
  const good = F.detectProblems({ settings: F.normalizeSettings(F.DEFAULTS), runtime: { dbpurgeage: 2592000, jails: ['sshd', 'recidive'], recidiveLogpath: '`- /var/log/fail2ban.log' }, sshPort: 22, jailPort: '22', dockgateIp: '192.0.2.1', banned: [] });
  assert.deepEqual(good, [], 'DockGate defaults raise no problem');
});

test('fail2ban: parses status, bans with time and the ban log', () => {
  assert.deepEqual(F.parseJailList('Status\n|- Number of jail:\t2\n`- Jail list:\trecidive, sshd'), ['recidive', 'sshd']);
  const st = F.parseJailStatus('|  |- Currently failed:\t2\n|  |- Total failed:\t9\n   |- Currently banned:\t1\n   |- Total banned:\t4');
  assert.deepEqual(st, { currentlyFailed: 2, totalFailed: 9, currentlyBanned: 1, totalBanned: 4 });
  const bans = F.parseBanList('203.0.113.9 \t2026-11-07 02:20:27 + 86400 = 2026-11-08 02:20:27');
  assert.deepEqual(bans, [{ ip: '203.0.113.9', bannedAt: '2026-11-07 02:20:27', seconds: 86400, until: '2026-11-08 02:20:27' }]);
  const h = F.parseHistory('2026-11-07 02:20:27,387 fail2ban.actions        [17984]: NOTICE  [sshd] Ban 203.0.113.9\n2026-11-07 02:20:27,824 fail2ban.actions        [17984]: NOTICE  [sshd] Unban 198.51.100.7');
  assert.deepEqual(h[0], { time: '2026-11-07 02:20:27', jail: 'sshd', action: 'Unban', ip: '198.51.100.7' });
  assert.equal(h[1].action, 'Ban');
});

test('fail2ban: recidive on the journal — names the file that wins, or says Save / reload fixes it', () => {
  const set = F.normalizeSettings(F.DEFAULTS);
  const jailFile = F.buildJailConf(set, 22);
  const rt = { dbpurgeage: 2592000, jails: ['sshd', 'recidive'], recidiveLogpath: 'No file is currently monitored' };
  const base = { settings: set, runtime: rt, sshPort: 22, jailPort: '22', managed: true, jailFileText: jailFile, active: true };
  const src = F.parseSources([
    `${F.JAIL_FILE}|recidive|backend = auto`, `${F.JAIL_FILE}|recidive|logpath = /var/log/fail2ban.log`,
    '/etc/fail2ban/jail.d/defaults-debian.conf|sshd|backend = systemd',
    '/etc/fail2ban/jail.local|recidive|backend = systemd', '/etc/fail2ban/jail.local|recidive|# logpath = x',
  ].join('\n'));
  // 1) jail.local wins: named, Save is not offered, the jail.local editor is
  let p = F.detectProblems({ ...base, sources: src }).find(x => /recidive reads/.test(x.text));
  assert.match(p.text, /\/etc\/fail2ban\/jail\.local sets "backend = systemd" under \[recidive\]/);
  assert.match(p.text, /Save cannot fix it/);
  assert.equal(p.fix, 'editlocal');
  // a later jail.d/*.conf wins too; an earlier one does not
  assert.equal(F.readAfterDockgate('/etc/fail2ban/jail.d/zz-mine.conf'), true);
  assert.equal(F.readAfterDockgate('/etc/fail2ban/jail.d/defaults-debian.conf'), false);
  assert.equal(F.readAfterDockgate('/etc/fail2ban/jail.d/custom.local'), true);
  // 2) nothing overrides, DockGate's file lacks the logpath → Save fixes it
  p = F.detectProblems({ ...base, sources: [], jailFileText: '[recidive]\nenabled = true\nbackend = systemd\n' }).find(x => /recidive reads/.test(x.text));
  assert.match(p.text, /does not set it yet/); assert.equal(p.fix, 'save');
  // 3) the file is right but fail2ban was not reloaded
  p = F.detectProblems({ ...base, sources: [] }).find(x => /recidive reads/.test(x.text));
  assert.match(p.text, /not reloaded/); assert.equal(p.fix, 'save');
  // fixed: reads the log file → no recidive problem
  assert.equal(F.detectProblems({ ...base, sources: src, runtime: { ...rt, recidiveLogpath: '`- /var/log/fail2ban.log' } }).filter(x => /recidive/.test(x.text)).length, 0);
});

test('fail2ban: running values that differ from DockGate\'s file are reported with their source', () => {
  const set = F.normalizeSettings(F.DEFAULTS);
  const rt = { dbpurgeage: 2592000, jails: ['sshd', 'recidive'], recidiveLogpath: '/var/log/fail2ban.log',
    jailOpts: { sshd: { maxretry: 5, findtime: 86400, bantime: 86400 }, recidive: { maxretry: 3, findtime: 2592000, bantime: 604800 } } };
  const base = { settings: set, runtime: rt, sshPort: 22, jailPort: '22', managed: true, jailFileText: F.buildJailConf(set, 22), active: true };
  let p = F.detectProblems({ ...base, sources: F.parseSources('/etc/fail2ban/jail.local|sshd|maxretry = 5') });
  assert.equal(p.length, 1);
  assert.match(p[0].text, /sshd runs with maxretry 5 \(DockGate's file: 3\): \/etc\/fail2ban\/jail\.local sets "maxretry = 5"/);
  p = F.detectProblems({ ...base, sources: [] });
  assert.match(p[0].text, /not reloaded/); assert.equal(p[0].fix, 'save');
  // recidive enabled in DockGate's file but switched off by a later file
  p = F.detectProblems({ ...base, runtime: { ...rt, jails: ['sshd'], jailOpts: { sshd: rt.jailOpts.sshd } }, sources: F.parseSources('/etc/fail2ban/jail.local|recidive|enabled = false\n/etc/fail2ban/jail.local|sshd|maxretry = 5') });
  assert.ok(p.some(x => /recidive is on in DockGate's settings but not running: \/etc\/fail2ban\/jail\.local sets "enabled = false"/.test(x.text)));
  // all equal → nothing
  assert.deepEqual(F.detectProblems({ ...base, runtime: { ...rt, jailOpts: { ...rt.jailOpts, sshd: { maxretry: 3, findtime: 86400, bantime: 86400 } } }, sources: [] }), []);
});
