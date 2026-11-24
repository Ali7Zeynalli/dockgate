'use strict';
// SSH honeypot (server/honeypot.js + honeypot/src): what it logs, how DockGate reads it back, the checks that keep it
// from taking the real SSH's place, the job that turns it on, and the program itself refusing every login.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const HP = require('../../server/honeypot');

const decoded = (cmd) => [...String(cmd).matchAll(/echo ([A-Za-z0-9+/=]{8,}) \| base64 -d/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));

test('log: lines are read back; a password that looks like a log line stays a password', () => {
  const log = [
    '2026-11-24T10:00:00Z connect 203.0.113.9 {"port":5001}',
    '2026-11-24T10:00:00Z ident 203.0.113.9 {"client":"SSH-2.0-Go"}',
    '2026-11-24T10:00:01Z auth 203.0.113.9 {"method":"password","user":"root","password":"x\\" connect 1.2.3.4 {"}',
    'garbage line',
    '2026-11-24T10:00:02Z close 203.0.113.9 {"secs":2}',
    '2026-11-24T10:05:00Z connect 198.51.100.4 {"port":7}',
  ].join('\n');
  const ev = HP.parseLog(log);
  assert.equal(ev.length, 5);
  assert.equal(ev[2].password, 'x" connect 1.2.3.4 {');
  const s = HP.stats(ev, Date.parse('2026-11-24T12:00:00Z'));
  assert.equal(s.connects, 2); assert.equal(s.ips, 2); assert.equal(s.connects24h, 2); assert.equal(s.logins, 1);
  assert.deepEqual(s.topUsers, [{ value: 'root', count: 1 }]);
  assert.deepEqual(s.topClients, [{ value: 'SSH-2.0-Go', count: 1 }]);
  assert.equal(s.recent[0].ev, 'auth');
});

test('fail2ban filter: bans on "connect" only, at the start of the line', () => {
  assert.match(HP.FILTER_TEXT, /^failregex = \^\\s\*connect <HOST> \\\{$/m);
  assert.match(HP.FILTER_TEXT, /^datepattern = \^%%Y-%%m-%%dT%%H:%%M:%%SZ$/m);
});

const READ_OUT = (o = {}) => [
  '@@uid', '0', '@@sshdPort', o.sshd || '2299', '@@listen22', o.listen || '', '@@docker', o.docker === undefined ? '29.0.1' : o.docker,
  '@@container', o.container || '', '@@f2b', o.f2b === undefined ? 'installed\nactive' : o.f2b, '@@jail', o.jail || '', '@@jailFile', o.jailFile || '',
  '@@ipset', 'yes', '@@logSize', '120', '@@log', o.log || '',
].join('\n');

test('status: not ready while SSH (or DockGate) is still on 22, port 22 is taken, or fail2ban is missing', () => {
  const ok = HP.parseStatus(READ_OUT(), { serverPort: 2299 });
  assert.equal(ok.ready, true); assert.equal(ok.on, false);
  assert.equal(HP.parseStatus(READ_OUT({ sshd: '22' }), { serverPort: 2299 }).ready, false);
  assert.equal(HP.parseStatus(READ_OUT({ sshd: '22\n2299' }), { serverPort: 2299 }).ready, false);
  assert.equal(HP.parseStatus(READ_OUT(), { serverPort: 22 }).ready, false);
  assert.equal(HP.parseStatus(READ_OUT({ listen: 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1))' }), { serverPort: 2299 }).ready, false);
  assert.equal(HP.parseStatus(READ_OUT({ f2b: 'installed' }), { serverPort: 2299 }).ready, false);
  assert.equal(HP.parseStatus(READ_OUT({ docker: '' }), { serverPort: 2299 }).ready, false);
});

test('status: on, with its bans, ban time and allowed addresses', () => {
  const s = HP.parseStatus(READ_OUT({
    container: 'running|dockgate-honeypot:1.0.0-abc|2026-11-24T10:00:00.1Z|HP_ALLOW=203.0.113.7,198.51.100.0/24\nPATH=/usr/bin',
    jail: 'Status for the jail: dockgate-honeypot\n|- Actions\n   |- Currently banned:\t2\n   |- Total banned:\t5\n   `- Banned IP list:\t203.0.113.9 198.51.100.4',
    jailFile: '[dockgate-honeypot]\nbantime = 7d\n', listen: 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("docker-proxy",pid=9))',
  }), { serverPort: 2299 });
  assert.equal(s.on, true); assert.equal(s.ready, true);
  assert.equal(s.bannedNow, 2); assert.equal(s.bannedTotal, 5); assert.deepEqual(s.banned, ['203.0.113.9', '198.51.100.4']);
  assert.equal(s.bantime, '7d'); assert.deepEqual(s.allow, ['203.0.113.7', '198.51.100.0/24']);
});

test('allowed addresses: IPs and networks only', () => {
  assert.deepEqual(HP.checkAllow('203.0.113.7, 2001:db8::/32'), ['203.0.113.7', '2001:db8::/32']);
  assert.throws(() => HP.checkAllow(['1.2.3.4; rm -rf /']), /Allowed address/);
  assert.throws(() => HP.checkAllow(['10.0.0.0/33']), /Allowed address/);
  assert.throws(() => HP.checkAllow(['example.com']), /Allowed address/);
});

test('turn-on job: checks first, image source in pieces that fit a command, locked-down container, jail, test, undo on failure', async () => {
  const files = HP.contextFiles();
  assert.ok(files.some(([r]) => r === 'node_modules/ssh2/lib/server.js'));
  assert.ok(!files.some(([r]) => /crypto\/(build|src)\//.test(r)), 'no native parts of ssh2');
  const tag = HP.imageTag(files);
  assert.match(tag, /^dockgate-honeypot:\d+\.\d+\.\d+-[0-9a-f]{10}$/);
  assert.equal(HP.imageTag(files), tag, 'same files, same tag');
  const tarGz = await HP.contextTarGz(files);
  const plan = HP.installPlan({ tag, tarGz, bantime: '7d', allow: ['203.0.113.7'] });
  assert.match(plan.steps[0].cmd, /still listens on port 22/);
  for (const s of plan.steps) assert.ok(s.cmd.length < 120 * 1024, `${s.label}: ${s.cmd.length} bytes`);
  const run = plan.steps.find(s => /Start the honeypot/.test(s.label)).cmd;
  for (const flag of ['--read-only', '--cap-drop ALL', 'no-new-privileges', '--memory 96m', '--pids-limit 64', '-p 22:2222', "HP_ALLOW='203.0.113.7'"]) assert.ok(run.includes(flag), flag);
  const jail = plan.steps.find(s => /jail/.test(s.label));
  assert.ok(jail.rollbackOnFail);
  assert.match(decoded(jail.cmd).join('\n'), /bantime = 7d/);
  assert.match(jail.cmd, /DOCKER-USER/);
  assert.match(plan.rollback, /docker rm -f dockgate-honeypot/);
  assert.match(plan.rollback, /rm -f \/etc\/fail2ban\/jail\.d\/dockgate-honeypot\.conf/);
  assert.throws(() => HP.installPlan({ tag, tarGz, bantime: '-1' }), /Ban time/);
  assert.doesNotMatch(HP.removePlan({ keepLog: true }).steps[0].cmd, /rm -rf/);
  assert.match(HP.removePlan({ keepLog: false }).steps[0].cmd, /rm -rf \/var\/log\/dockgate-honeypot/);
});

test('honeypot program: logs the connection, the greeting and the password, and refuses the login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-hp-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'honeypot', 'src', 'index.js')], {
    env: { ...process.env, HP_PORT: String(port), HP_LOG: path.join(dir, 'h.log'), HP_KEY: path.join(dir, 'key'), HP_QUIET_PRIVATE: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((res, rej) => { child.stdout.on('data', (d) => /listening/.test(String(d)) && res()); child.on('exit', () => rej(new Error('honeypot exited'))); setTimeout(() => rej(new Error('no start')), 8000); });
    const { Client } = require('ssh2');
    const result = await new Promise((res) => {
      const c = new Client();
      c.on('ready', () => { c.end(); res('logged in'); });
      c.on('error', (e) => res(e.level || e.message));
      c.connect({ host: '127.0.0.1', port, username: 'admin', password: 'hunter2', readyTimeout: 8000 });
    });
    assert.equal(result, 'client-authentication');
    await new Promise(r => setTimeout(r, 400));
    const ev = HP.parseLog(fs.readFileSync(path.join(dir, 'h.log'), 'utf8'));
    assert.deepEqual(ev.map(e => e.ev).filter(e => e !== 'close'), ['connect', 'ident', 'auth']);
    assert.equal(ev[2].user, 'admin'); assert.equal(ev[2].password, 'hunter2');
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
