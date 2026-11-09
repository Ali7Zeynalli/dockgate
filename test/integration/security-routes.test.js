// Integration tests for the server security + firewall routes (/api/servers/:id/...). The SSH runner is
// replaced by a fake server: reads answer from a fixture, plans are recorded instead of executed. That
// checks the safety rules that live in the routes (SSH stays reachable, confirm gates, UFW vs firewalld).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-secroutes-test-'));

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const runner = require('../../server/security/runner');
const { stmts } = require('../../server/db');
const IPL = require('../../server/security/iplists');

// ---- fake server
let fixture = {};
const ran = [];     // plans passed to runAndWait (immediate ops)
const started = []; // plans passed to startPlan (lifeline jobs)
runner.read = async (cfg, script) => {
  const out = [];
  for (const m of script.matchAll(/echo "?@@([A-Za-z0-9]+)/g)) out.push('@@' + m[1], fixture[m[1]] || '');
  return out.join('\n');
};
runner.runAndWait = async (cfg, plan) => { ran.push(plan); return { status: 'done' }; };
runner.startPlan = (cfg, plan) => { started.push(plan); return 'job-' + started.length; };
const cmds = (plan) => plan.steps.map(s => s.cmd || '').join('\n');

const app = express();
app.use(express.json());
app.use('/api/servers', require('../../server/routes/firewall'));
app.use('/api/servers', require('../../server/routes/security'));
stmts.insertServer.run('srv', 'ssh', '203.0.113.10', 22, 'deploy', null, null, null, '', 'test', 0);

const CF = IPL.get('cloudflare').items;
const ufwStatus = (lines) => 'Status: active\n\n     To                         Action      From\n     --                         ------      ----\n' + lines.map((l, i) => `[${String(i + 1).padStart(2)}] ${l}`).join('\n') + '\n';
const SS = [
  'tcp   LISTEN 0 4096 0.0.0.0:22   0.0.0.0:* users:(("sshd",pid=1,fd=3))',
  'tcp   LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=2,fd=3))',
  'tcp   LISTEN 0 4096 0.0.0.0:443  0.0.0.0:* users:(("nginx",pid=5,fd=3))',
  'tcp   LISTEN 0 4096 0.0.0.0:8081 0.0.0.0:* users:(("docker-proxy",pid=3,fd=3))',
].join('\n');
const UFW_FIXTURE = () => ({
  ufwbin: '/usr/sbin/ufw', firewalld: '', iso: '0', ss: SS, docker: 'web|0.0.0.0:8081->80/tcp', sshdT: 'port 22',
  me: '192.0.2.44', ufw6: 'IPV6=yes', ufwv: 'Default: deny (incoming), allow (outgoing), deny (routed)',
  ufw: ufwStatus([
    '22/tcp                     ALLOW IN    Anywhere',
    ...CF.filter(x => !x.includes(':')).map(x => `443/tcp                    ALLOW IN    ${x.padEnd(26)} # dockgate:cloudflare`),
    '25/tcp                     DENY OUT    Anywhere                   (out) # dockgate:out:any',
    '22/tcp (v6)                ALLOW IN    Anywhere (v6)',
    ...CF.filter(x => x.includes(':')).map(x => `443/tcp (v6)               ALLOW IN    ${x.padEnd(26)} # dockgate:cloudflare`),
    '25/tcp (v6)                DENY OUT    Anywhere (v6)              (out) # dockgate:out:any',
  ]),
});
const FWD_FIXTURE = () => ({
  ufwbin: '', ufw: '', firewalld: 'running', iso: '', ss: SS, docker: 'web|0.0.0.0:8081->80/tcp', sshdT: 'port 22', me: '192.0.2.44',
  fwd: 'public (active)\n  target: default\n  services: http ssh\n  ports: 8443/tcp\n  rich rules: \n\trule family="ipv4" source address="10.0.0.0/8" port port="5432" protocol="tcp" accept\n',
  fwdsvc: 'http 80/tcp\nssh 22/tcp',
});
beforeEach(() => { ran.length = 0; started.length = 0; fixture = UFW_FIXTURE(); });
const saveRule = (body) => request(app).post('/api/servers/srv/firewall/rule').send(body);

test('unknown server → 404; the local server is refused', async () => {
  assert.strictEqual((await request(app).get('/api/servers/nope/firewall')).status, 404);
  stmts.insertServer.run('loc', 'local', 'localhost', 22, 'root', null, null, null, '', 'local', 0);
  assert.strictEqual((await request(app).get('/api/servers/loc/firewall')).status, 400);
});

test('firewall state: inbound and outbound rules, Any IPv4/IPv6, lists, defaults, idle and bypassing ports', async () => {
  const r = await request(app).get('/api/servers/srv/firewall');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fw = r.body;
  assert.deepStrictEqual(fw.defaults, { incoming: 'deny', outgoing: 'allow', routed: 'deny' });
  const ssh = fw.inbound.find(g => g.port === '22');
  assert.deepStrictEqual(ssh.sources, ['any4', 'any6']);
  assert.strictEqual(ssh.isSsh, true);
  assert.strictEqual(ssh.usedBy, 'sshd');
  const web = fw.inbound.find(g => g.port === '443');
  assert.deepStrictEqual(web.sources, ['@cloudflare']);
  assert.strictEqual(web.family, 'IPv4 + IPv6');
  assert.strictEqual(web.addressCount, 22);
  const mail = fw.outbound[0];
  assert.deepStrictEqual([mail.dir, mail.action, mail.port, mail.proto], ['out', 'deny', '25', 'tcp']);
  assert.deepStrictEqual(mail.sources, ['any4', 'any6']);
  assert.ok(fw.idle.some(p => p.port === 5432), 'postgres listens with no rule');
  assert.ok(fw.bypass.some(p => p.port === 8081), 'container port bypasses UFW without isolation');
  assert.ok(!('entries' in web), 'raw entries are not sent');
});

test('add inbound rule: pasted addresses normalised, comment written, dry run touches nothing', async () => {
  const body = { rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '5432', description: 'Postgres for the office' }, sources: ['10.1.2.3/24', '2001:DB8::1'] };
  const dry = await saveRule({ ...body, dryRun: true });
  assert.strictEqual(dry.status, 200, JSON.stringify(dry.body));
  assert.deepStrictEqual(dry.body.add, ['10.1.2.0/24', '2001:db8::1']);
  assert.strictEqual(ran.length, 0);
  const ok = await saveRule(body);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const c = cmds(ran[0]);
  assert.match(c, /ufw allow proto tcp from 10\.1\.2\.0\/24 to any port 5432 comment 'dockgate:manual'/);
  assert.match(c, /ufw allow proto tcp from 2001:db8::1 to any port 5432/);
});

test('edit: only the difference runs (adds first, deletes by spec); Any IPv4 + IPv6 merge into "any"', async () => {
  const r = await saveRule({ original: 'in|allow|tcp|443|h', rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '443' }, sources: ['any4', 'any6'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const c = cmds(ran[0]).split(' && ');
  assert.match(c[0], /ufw allow proto tcp from any to any port 443 comment 'dockgate:any'/);
  assert.strictEqual(c.filter(x => /ufw delete allow proto tcp from .* to any port 443/.test(x)).length, 22);
});

test('outbound rule: ufw out + route for containers, range needs a protocol, containers need isolation', async () => {
  fixture.iso = '1';
  const r = await saveRule({ rule: { dir: 'out', action: 'deny', proto: 'tcp', port: '6660-6669', containers: true, description: 'No IRC' }, sources: ['any4', 'any6'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const c = cmds(ran[0]);
  assert.match(c, /ufw deny out proto tcp to any port 6660:6669 comment 'dockgate:out:any'/);
  assert.match(c, /ufw route deny proto tcp from any to any port 6660:6669 comment 'dockgate:out:any'/);
  assert.strictEqual((await saveRule({ rule: { dir: 'out', action: 'deny', port: '7000-7010' }, sources: ['any4'] })).status, 400, 'range without protocol');
  fixture.iso = '0';
  assert.match((await saveRule({ rule: { dir: 'out', action: 'deny', proto: 'tcp', port: '25', containers: true }, sources: ['1.2.3.4'] })).body.error, /isolation/);
});

test('delete an outbound rule removes both families; a clash with an existing rule is refused', async () => {
  const r = await saveRule({ original: 'out|deny|tcp|25|h', sources: [] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.match(cmds(ran[0]), /ufw delete deny out proto tcp to any port 25/);
  const clash = await saveRule({ rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '443' }, sources: ['1.2.3.4'] });
  assert.strictEqual(clash.status, 400);
  assert.match(clash.body.error, /already exists/);
});

test('SSH: DockGate must stay reachable; changing the SSH rule runs as a lifeline job', async () => {
  const lock = await saveRule({ original: 'in|allow|tcp|22|h', rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '22' }, sources: ['203.0.113.5'] });
  assert.strictEqual(lock.status, 400);
  assert.match(lock.body.error, /192\.0\.2\.44/);
  assert.strictEqual((await saveRule({ original: 'in|allow|tcp|22|h', sources: [] })).status, 400, 'deleting the only SSH rule');
  const ok = await saveRule({ original: 'in|allow|tcp|22|h', rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '22', description: 'SSH' }, sources: ['@dockgate', '198.51.100.0/24'] });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.jobId);
  assert.match(cmds(started[0]), /cp -p \/etc\/ufw\/user\.rules/);
  assert.match(cmds(started[0]), /from 192\.0\.2\.44 to any port 22 comment 'dockgate:dockgate'/);
  assert.ok(started[0].steps.some(s => s.test && s.rollbackOnFail));
  assert.strictEqual((await saveRule({ original: 'in|allow|tcp|22|h', rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '22' }, sources: ['192.0.2.0/24'], dryRun: true })).status, 200, 'a range containing DockGate is enough');
});

test('IPv6 refused when UFW has IPv6 off; bad addresses and unknown lists refused', async () => {
  fixture.ufw6 = 'IPV6=no';
  assert.match((await saveRule({ rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '5432' }, sources: ['@cloudflare'], dryRun: true })).body.error, /IPV6=no/);
  fixture.ufw6 = 'IPV6=yes';
  assert.strictEqual((await saveRule({ rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '5432' }, sources: ['1.2.3.4; reboot'] })).status, 400);
  assert.strictEqual((await saveRule({ rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '5432' }, sources: ['@nope'] })).status, 400);
  assert.strictEqual((await saveRule({ rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '70000' }, sources: ['1.2.3.4'] })).status, 400);
});

test('an outdated list is recognised and saving applies the new version', async () => {
  const before = IPL.get('cloudflare').items;
  IPL.saveOfficial('cloudflare', [...before, '104.30.0.0/19']);
  try {
    const r = await request(app).get('/api/servers/srv/firewall');
    const web = r.body.inbound.find(g => g.port === '443');
    assert.deepStrictEqual(web.outdated, ['cloudflare']);
    const dry = await saveRule({ original: web.key, rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '443' }, sources: ['@cloudflare'], dryRun: true });
    assert.deepStrictEqual(dry.body.add, ['104.30.0.0/19']);
    assert.deepStrictEqual(dry.body.remove, []);
  } finally { IPL.saveOfficial('cloudflare', before); }
});

test('default policy: confirm needed, incoming deny needs an SSH rule, outgoing change runs ufw default', async () => {
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/default').send({ direction: 'outgoing', policy: 'deny' })).status, 409);
  const ok = await request(app).post('/api/servers/srv/firewall/default').send({ direction: 'outgoing', policy: 'deny', confirm: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.match(cmds(ran[0]), /ufw default deny outgoing/);
  fixture.ufw = ufwStatus(['443/tcp                    ALLOW IN    Anywhere']);
  fixture.ufwv = 'Default: allow (incoming), allow (outgoing), deny (routed)';
  const r = await request(app).post('/api/servers/srv/firewall/default').send({ direction: 'incoming', policy: 'deny', confirm: true });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /SSH/);
});

test('risky jobs need confirm: Docker isolation, firewall on/off, reboot', async () => {
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/docker-isolation').send({ enable: true })).status, 409);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/ufw').send({ enable: false })).status, 409);
  assert.strictEqual((await request(app).post('/api/servers/srv/reboot').send({})).status, 409);
});

test('firewalld: inbound rules from ports, services (read-only) and rich rules; outbound refused', async () => {
  fixture = FWD_FIXTURE();
  const r = await request(app).get('/api/servers/srv/firewall');
  assert.strictEqual(r.body.backend, 'firewalld');
  assert.deepStrictEqual(r.body.outbound, []);
  assert.deepStrictEqual(r.body.inbound.find(g => g.port === '8443').sources, ['any4', 'any6']);
  assert.deepStrictEqual(r.body.inbound.find(g => g.port === '5432').sources, ['10.0.0.0/8']);
  assert.ok(r.body.locked.some(l => /service "ssh"/.test(l.reason)), 'services are listed as read-only entries');
  const add = await saveRule({ rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '9000' }, sources: ['2606:4700::/32'] });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  assert.match(cmds(ran[0]), /--add-rich-rule='rule family="ipv6" source address="2606:4700::\/32" port port="9000" protocol="tcp" accept'/);
  assert.match(cmds(ran[0]), /firewall-cmd --reload/);
  ran.length = 0;
  const any = await saveRule({ original: 'in|allow|tcp|8443|h', rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '8443' }, sources: ['10.0.0.0/8'] });
  assert.strictEqual(any.status, 200, JSON.stringify(any.body));
  assert.match(cmds(ran[0]), /--remove-port=8443\/tcp/);
  assert.strictEqual((await saveRule({ original: 'in|allow|tcp|8443|h', rule: { dir: 'in', action: 'allow', proto: 'tcp', port: '8443' }, sources: ['any4'] })).status, 400, 'half of a plain port');
  assert.match((await saveRule({ rule: { dir: 'out', action: 'deny', proto: 'tcp', port: '25' }, sources: ['any4'] })).body.error, /need UFW/);
});

test('auto updates: RHEL family goes to dnf-automatic, choices validated', async () => {
  const ok = await request(app).post('/api/servers/srv/services/unattended-upgrades/settings').send({ family: 'rhel', enabled: true, upgradeType: 'security', reboot: 'never' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.match(cmds(ran[0]), /upgrade_type = security/);
  assert.strictEqual((await request(app).post('/api/servers/srv/services/unattended-upgrades/settings').send({ family: 'rhel', enabled: true, upgradeType: 'x', reboot: 'never' })).status, 400);
  assert.strictEqual((await request(app).post('/api/servers/srv/services/unattended-upgrades/settings').send({ enabled: true, autoReboot: true, rebootTime: '25:00' })).status, 400);
});

test('fail2ban: the files on the server are returned; preview builds what Save would write, bad values refused', async () => {
  const F2B = require('../../server/security/fail2ban');
  const s = F2B.normalizeSettings(F2B.DEFAULTS);
  fixture = { installed: 'yes', active: 'active', status: 'Jail list:\tsshd', sshport: '2222', dockgate: F2B.buildJailConf(s, 2222), daemon: F2B.buildDaemonConf(s) };
  const r = await request(app).get('/api/servers/srv/fail2ban');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.files.map(x => x.path), [F2B.JAIL_FILE, F2B.DAEMON_FILE]);
  assert.match(r.body.files[0].text, /\[sshd\][\s\S]*port = 2222/);
  const before = started.length + ran.length;
  const p = await request(app).post('/api/servers/srv/fail2ban/preview').send({ settings: { ...s, sshd: { ...s.sshd, maxretry: 5 } }, sshPort: 2222 });
  assert.strictEqual(p.status, 200);
  assert.match(p.body.files[0].text, /maxretry = 5/);
  assert.strictEqual(p.body.files[0].text, F2B.buildJailConf({ ...s, sshd: { ...s.sshd, maxretry: 5 } }, 2222));
  assert.strictEqual(started.length + ran.length, before); // preview runs nothing on the server
  const bad = await request(app).post('/api/servers/srv/fail2ban/preview').send({ settings: { ...s, sshd: { ...s.sshd, maxretry: 0 } } });
  assert.strictEqual(bad.status, 400);
});
