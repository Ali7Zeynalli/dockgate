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
  assert.match(p.text, /Save alone cannot fix it/);
  assert.equal(p.fix, 'takeover');
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

const USER_JAIL_LOCAL = `[DEFAULT]
ignoreip = 127.0.0.1/8 ::1

usedns = no

bantime = 24h
findtime = 1d
maxretry = 3

bantime.increment = true
bantime.factor = 2
bantime.maxtime = 30d
bantime.overalljails = true
bantime.rndtime = 30m

banaction = nftables


[sshd]
enabled = true
backend = systemd
port = ssh
mode = aggressive

maxretry = 3
findtime = 1d
bantime = 24h

bantime.increment = true
bantime.factor = 2
bantime.maxtime = 30d
bantime.rndtime = 30m


[recidive]
enabled = true
filter = recidive
logpath = /var/log/fail2ban.log
backend = auto

maxretry = 5
findtime = 1d
bantime = 1w

bantime.increment = true
bantime.factor = 2
bantime.maxtime = 90d

banaction = nftables[type=allports]
`;
// What the server-side awk probe prints for a file (same rules: [DEFAULT]/[sshd]/[recidive], key = value lines).
const probe = (file, text) => { let sec = null; const out = []; for (const l of text.split('\n')) { const h = /^[ \t]*\[([^\]]*)\]/.exec(l); if (h) { sec = h[1].replace(/[ \t]/g, ''); continue; } if (['sshd', 'recidive', 'DEFAULT'].includes(sec) && /^[ \t]*[A-Za-z][A-Za-z.]*[ \t]*=/.test(l)) out.push(`${file}|${sec}|${l}`); } return out.join('\n'); };

test('fail2ban takeover: the user\'s jail.local is carried over, corrected and stripped of what DockGate manages', () => {
  const set = F.normalizeSettings({ ...F.DEFAULTS, ignoreip: ['198.51.100.10'] });
  const sources = F.parseSources(probe(F.JAIL_FILE, F.buildJailConf(set, 22)) + '\n' + probe('/etc/fail2ban/jail.local', USER_JAIL_LOCAL));
  assert.deepEqual(F.overridingFiles(sources), ['/etc/fail2ban/jail.local']);
  const t = F.planTakeover({ settings: set, sources, texts: { '/etc/fail2ban/jail.local': USER_JAIL_LOCAL }, dockgateIp: '192.0.2.44', sshPort: 22 });
  // carried over: aggressive mode and the recidive increment the user chose
  assert.equal(t.settings.sshd.mode, 'aggressive');
  assert.equal(t.settings.recidive.increment, true);
  assert.equal(t.settings.recidive.maxtime, '90d');
  // corrected: 5 bans in 1d can never happen → 3 in 30d; DockGate's IP added; existing allowlist kept
  assert.equal(t.settings.recidive.maxretry, 3);
  assert.equal(t.settings.recidive.findtime, '30d');
  assert.ok(t.corrected.some(c => c.what === 'recidive'));
  assert.deepEqual(t.settings.ignoreip, ['198.51.100.10', '192.0.2.44']);
  // removed with a reason: port, backend, logpath, filter, banaction, rndtime
  for (const k of ['port', 'backend', 'logpath', 'filter', 'banaction']) assert.ok(t.removed.some(r => r.key === k), `${k} listed as removed`);
  // an option DockGate has no field for moves into DockGate's file as an "other option"
  assert.deepEqual(t.settings.extra.sshd, ['bantime.rndtime = 30m']);
  assert.match(t.dockgate[0].text, /\[sshd\][\s\S]*bantime\.rndtime = 30m\n\n\[recidive\]/);
  // left in place: [DEFAULT] options other than ignoreip
  assert.ok(t.kept.some(r => r.key === 'usedns') && t.kept.some(r => r.key === 'bantime.overalljails'));
  // the new jail.local: no [sshd] / [recidive] / ignoreip, the rest untouched
  const after = t.files[0].after;
  assert.doesNotMatch(after, /\[sshd\]|\[recidive\]|ignoreip|mode = aggressive|maxretry = 5/);
  assert.match(after, /\[DEFAULT\][\s\S]*usedns = no[\s\S]*bantime\.rndtime = 30m[\s\S]*banaction = nftables\n$/);
  // DockGate's new file: recidive writes its increment explicitly, so [DEFAULT] bantime.* cannot leak into it
  assert.match(t.dockgate[0].text, /\[recidive\][\s\S]*maxretry = 3\nfindtime = 30d\nbantime = 1w\nbantime\.increment = true\nbantime\.factor = 2\nbantime\.maxtime = 90d/);
  assert.match(t.dockgate[0].text, /ignoreip = 127\.0\.0\.1\/8 ::1 198\.51\.100\.10 192\.0\.2\.44/);
  // after the takeover nothing overrides DockGate any more
  const sources2 = F.parseSources(probe(F.JAIL_FILE, t.dockgate[0].text) + '\n' + probe('/etc/fail2ban/jail.local', after));
  assert.deepEqual(F.overridingFiles(sources2), []);
});

test('fail2ban takeover: other jails and continuation lines survive; daemon files lose only dbpurgeage/logtarget', () => {
  const txt = '# mine\n[DEFAULT]\nignoreip = 127.0.0.1/8\n    203.0.113.0/24\nbantime = 1h\n\n[nginx-http-auth]\nenabled = true\n\n[sshd]\nmaxretry = 9\n  # note\n[recidive]\nenabled = false\n';
  const out = F.stripTakenOver(txt, '/etc/fail2ban/jail.local');
  assert.equal(out, '# mine\n[DEFAULT]\nbantime = 1h\n\n[nginx-http-auth]\nenabled = true\n');
  assert.equal(F.stripTakenOver('[Definition]\nloglevel = INFO\ndbpurgeage = 1d\nlogtarget = SYSLOG\n', '/etc/fail2ban/fail2ban.local'), '[Definition]\nloglevel = INFO\n');
  assert.equal(F.readAfterDockgate('/etc/fail2ban/fail2ban.local'), true);
  assert.equal(F.readAfterDockgate(F.DAEMON_FILE), false);
});

test('fail2ban: allowlist not in effect, DockGate\'s IP missing, impossible recidive from running values', () => {
  const set = F.normalizeSettings({ ...F.DEFAULTS, ignoreip: ['198.51.100.10'] });
  const base = { settings: set, sshPort: 22, jailPort: '22', managed: true, jailFileText: F.buildJailConf(set, 22), active: true, dockgateIp: '192.0.2.44', banned: [] };
  const rt = { dbpurgeage: 2592000, jails: ['sshd', 'recidive'], recidiveLogpath: '/var/log/fail2ban.log', ignoreip: ['127.0.0.0/8', '::1'],
    jailOpts: { sshd: { maxretry: 3, findtime: 86400, bantime: 86400, increment: true, factor: 2, maxtime: 2592000 }, recidive: { maxretry: 5, findtime: 86400, bantime: 604800 } } };
  const src = F.parseSources('/etc/fail2ban/jail.local|DEFAULT|ignoreip = 127.0.0.1/8 ::1\n/etc/fail2ban/jail.local|recidive|maxretry = 5\n/etc/fail2ban/jail.local|recidive|findtime = 1d');
  const p = F.detectProblems({ ...base, runtime: rt, sources: src });
  const allow = p.find(x => /allowlist is not in effect/.test(x.text));
  assert.match(allow.text, /198\.51\.100\.10[\s\S]*jail\.local sets "ignoreip/); assert.equal(allow.fix, 'takeover');
  assert.ok(p.some(x => x.fix === 'allowdg'), "DockGate's IP offered");
  const never = p.find(x => /recidive can never trigger/.test(x.text));
  assert.match(never.text, /5 sshd bans[\s\S]*window is 1d — these are the values fail2ban runs with/); assert.equal(never.fix, 'takeover');
  // covered by a CIDR → no DockGate-IP warning
  assert.equal(F.coveredBy('192.0.2.44', ['192.0.2.0/24']), true);
  assert.equal(F.coveredBy('192.0.3.1', ['192.0.2.0/24']), false);
  // recidive increment is validated and written explicitly even when off
  assert.match(F.buildJailConf(set, 22), /\[recidive\][\s\S]*bantime\.increment = false/);
  assert.throws(() => F.normalizeSettings({ ...F.DEFAULTS, recidive: { ...F.DEFAULTS.recidive, factor: 50 } }), /recidive growth factor/);
});

test('fail2ban: other options survive a save, cannot shadow DockGate fields, and file roles are right', () => {
  const s0 = F.normalizeSettings({ ...F.DEFAULTS, extra: { DEFAULT: ['usedns=no'], sshd: ['bantime.rndtime = 30m'] } });
  const text = F.buildJailConf(s0, 22);
  const back = F.parseJailConf(text);
  assert.deepEqual(back.extra, { DEFAULT: ['usedns = no'], sshd: ['bantime.rndtime = 30m'], recidive: [] });
  // a form save (settings from the parsed file) writes them again
  assert.equal(F.buildJailConf(F.normalizeSettings(back), 22), text);
  // a hand-edited DockGate file: new option kept, managed value read into the form
  const edited = text.replace('maxretry = 3\nfindtime = 1d', 'maxretry = 4\nfindtime = 1d\nignorecommand = /bin/true');
  const p = F.parseJailConf(edited);
  assert.equal(p.sshd.maxretry, 4); assert.ok(p.extra.sshd.includes('ignorecommand = /bin/true'));
  assert.throws(() => F.normalizeSettings({ ...F.DEFAULTS, extra: { recidive: ['logpath = /tmp/x'] } }), /set with DockGate's own field/);
  assert.throws(() => F.normalizeSettings({ ...F.DEFAULTS, extra: { DEFAULT: ['not an option'] } }), /option = value/);
  assert.equal(F.fileRole(F.JAIL_FILE).role, 'dockgate');
  assert.equal(F.fileRole('/etc/fail2ban/jail.d/defaults-debian.conf').editable, false);
  assert.equal(F.fileRole('/etc/fail2ban/jail.local').editable, true);
  assert.deepEqual(F.sectionNames('[DEFAULT]\n[sshd]\n [nginx-x]\n'), ['DEFAULT', 'sshd', 'nginx-x']);
  const o = F.originsOf(F.parseSources(`${F.JAIL_FILE}|sshd|maxretry = 3\n/etc/fail2ban/jail.local|sshd|maxretry = 5`));
  assert.equal(o['sshd.maxretry'], '/etc/fail2ban/jail.local');
});
