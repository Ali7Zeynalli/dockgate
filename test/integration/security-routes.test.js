// Integration tests for the server-security routes (/api/servers/:id/...). The SSH runner is replaced
// by a fake server: reads answer from a fixture, plans are recorded instead of executed. That checks the
// safety rules that live in the routes (SSH stays reachable, confirm gates, UFW vs firewalld) end to end.
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
app.use('/api/servers', require('../../server/routes/security'));
stmts.insertServer.run('srv', 'ssh', '203.0.113.10', 22, 'deploy', null, null, null, '', 'test', 0);

const SS = [
  'tcp   LISTEN 0 4096 0.0.0.0:22   0.0.0.0:* users:(("sshd",pid=1,fd=3))',
  'tcp   LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=2,fd=3))',
  'tcp   LISTEN 0 4096 0.0.0.0:8081 0.0.0.0:* users:(("docker-proxy",pid=3,fd=3))',
].join('\n');
const UFW_FIXTURE = {
  ufwbin: '/usr/sbin/ufw',
  ufw: 'Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] 22/tcp                     ALLOW IN    Anywhere\n[ 2] 80/tcp                     ALLOW IN    Anywhere\n[ 3] 22/tcp (v6)                ALLOW IN    Anywhere (v6)\n',
  firewalld: '', iso: '0', ss: SS, docker: 'web|0.0.0.0:8081->80/tcp', sshdT: 'port 22',
};
const FWD_FIXTURE = {
  ufwbin: '', ufw: '', firewalld: 'running', iso: '', ss: SS, docker: 'web|0.0.0.0:8081->80/tcp', sshdT: 'port 22',
  fwd: 'public (active)\n  target: default\n  services: http ssh\n  ports: 8443/tcp\n  rich rules: \n',
  fwdsvc: 'http 80/tcp\nssh 22/tcp',
};
beforeEach(() => { ran.length = 0; started.length = 0; fixture = { ...UFW_FIXTURE }; });

test('unknown server → 404; the local server is refused', async () => {
  assert.strictEqual((await request(app).get('/api/servers/nope/firewall')).status, 404);
  stmts.insertServer.run('loc', 'local', 'localhost', 22, 'root', null, null, null, '', 'local', 0);
  assert.strictEqual((await request(app).get('/api/servers/loc/firewall')).status, 400);
});

test('UFW: firewall state — container port bypasses UFW until isolation is on', async () => {
  const r = await request(app).get('/api/servers/srv/firewall');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.backend, 'ufw');
  assert.strictEqual(r.body.managed, true);
  const by = (p) => r.body.ports.find(x => x.port === p);
  assert.strictEqual(by(22).exposure, 'public');
  assert.strictEqual(by(5432).exposure, 'internal');
  assert.strictEqual(by(8081).exposure, 'bypass');
});

test('UFW: opening a port runs `ufw allow`; the SSH port and bypassing container ports are refused', async () => {
  const ok = await request(app).post('/api/servers/srv/firewall/expose').send({ port: 5432, proto: 'tcp', open: true, scope: 'ip', ip: '198.51.100.7' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.match(cmds(ran[0]), /ufw allow proto tcp from 198\.51\.100\.7 to any port 5432/);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/expose').send({ port: 22, proto: 'tcp', open: false })).status, 400);
  const c = await request(app).post('/api/servers/srv/firewall/expose').send({ port: 8081, proto: 'tcp', open: true });
  assert.strictEqual(c.status, 400);
  assert.match(c.body.error, /isolation/);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/expose').send({ port: 5432, proto: 'tcp', open: true, scope: 'ip', ip: '1.2.3.4; reboot' })).status, 400, 'source validated');
});

test('UFW: the last rule keeping SSH open cannot be deleted; deny on the SSH port is refused', async () => {
  const d = await request(app).delete('/api/servers/srv/firewall/rules/1');
  assert.strictEqual(d.status, 400);
  assert.match(d.body.error, /SSH/);
  const ok = await request(app).delete('/api/servers/srv/firewall/rules/2');
  assert.strictEqual(ok.status, 200);
  assert.match(cmds(ran[0]), /ufw --force delete 2/);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/rules').send({ port: 22, proto: 'tcp', from: 'any', action: 'deny' })).status, 400);
});

test('risky jobs need confirm: Docker isolation, firewall on/off, reboot', async () => {
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/docker-isolation').send({ enable: true })).status, 409);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/ufw').send({ enable: false })).status, 409);
  assert.strictEqual((await request(app).post('/api/servers/srv/reboot').send({})).status, 409);
  const iso = await request(app).post('/api/servers/srv/firewall/docker-isolation').send({ enable: true, keepPublic: ['8081/tcp'], confirm: true });
  assert.strictEqual(iso.status, 200, JSON.stringify(iso.body));
  assert.ok(iso.body.jobId);
  assert.match(cmds(started[0]), /ufw route allow proto tcp from any to any port 80\b/, 'keep-public uses the container port');
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/docker-isolation').send({ enable: true, keepPublic: ['9999/tcp'], confirm: true })).status, 400);
});

test('firewalld: state, rich rules for one IP, container ports refused, service rows deleted together', async () => {
  fixture = { ...FWD_FIXTURE };
  const r = await request(app).get('/api/servers/srv/firewall');
  assert.strictEqual(r.body.backend, 'firewalld');
  assert.strictEqual(r.body.zone, 'public');
  assert.strictEqual(r.body.isolationSupported, false);
  assert.strictEqual(r.body.ports.find(x => x.port === 8081).exposure, 'bypass');

  const add = await request(app).post('/api/servers/srv/firewall/rules').send({ port: 5432, proto: 'tcp', from: '10.1.0.0/16', action: 'allow' });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  assert.match(cmds(ran[0]), /--zone=public --add-rich-rule='rule family="ipv4" source address="10\.1\.0\.0\/16" port port="5432" protocol="tcp" accept'.*--reload/);

  assert.match((await request(app).post('/api/servers/srv/firewall/expose').send({ port: 8081, proto: 'tcp', open: true })).body.error, /past firewalld/);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/docker-isolation').send({ enable: true, confirm: true })).status, 400);
  assert.strictEqual((await request(app).post('/api/servers/srv/firewall/ufw').send({ enable: true, confirm: true })).status, 400, 'UFW must not start next to firewalld');

  const rules = r.body.rules;
  const ssh = rules.find(x => x.key === 'ssh'), http = rules.find(x => x.key === 'http');
  assert.strictEqual((await request(app).delete(`/api/servers/srv/firewall/rules/${ssh.n}`)).status, 400, 'ssh service keeps SSH reachable');
  ran.length = 0;
  assert.strictEqual((await request(app).delete(`/api/servers/srv/firewall/rules/${http.n}`)).status, 200);
  assert.match(cmds(ran[0]), /--remove-service=http/);
});

test('auto updates: RHEL family goes to dnf-automatic, choices validated', async () => {
  const ok = await request(app).post('/api/servers/srv/services/unattended-upgrades/settings').send({ family: 'rhel', enabled: true, upgradeType: 'security', reboot: 'never' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.match(cmds(ran[0]), /upgrade_type = security/);
  assert.strictEqual((await request(app).post('/api/servers/srv/services/unattended-upgrades/settings').send({ family: 'rhel', enabled: true, upgradeType: 'x', reboot: 'never' })).status, 400);
  assert.strictEqual((await request(app).post('/api/servers/srv/services/unattended-upgrades/settings').send({ enabled: true, autoReboot: true, rebootTime: '25:00' })).status, 400);
});
