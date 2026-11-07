// Unit tests for the server-security features (Access & SSH, Users, Firewall, host key pinning).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-sec-test-'));

const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../../server/security/parse');
const plans = require('../../server/security/plans');
const hostkey = require('../../server/ssh-hostkey');
const { utils } = require('ssh2');

const pub = utils.generateKeyPairSync('ed25519', { comment: 'me@laptop' }).public;

// ---------------------------------------------------------------- validation
test('security: usernames — only safe Linux names, system names reserved', () => {
  for (const ok of ['deploy', 'alice', '_svc', 'a-b_c1']) assert.ok(P.validUsername(ok), ok);
  for (const bad of ['', 'Root', '1abc', 'a b', 'a;rm', '$(id)', 'x'.repeat(33), '../etc']) assert.ok(!P.validUsername(bad), bad);
  assert.throws(() => P.assertNewUsername('root'), e => e.statusCode === 400);
  assert.throws(() => P.assertNewUsername('docker'), e => e.statusCode === 400);
  assert.doesNotThrow(() => P.assertNewUsername('deploy'));
});

test('security: public keys — valid keys parse with an OpenSSH fingerprint; garbage and injection are rejected', () => {
  const k = P.parsePublicKey(pub);
  assert.equal(k.type, 'ssh-ed25519');
  assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(k.comment, 'me@laptop');
  const parsed = utils.parseKey(pub);
  assert.equal(k.fingerprint, hostkey.fingerprint(parsed.getPublicSSH()), 'same fingerprint as the host-key helper');
  assert.equal(P.parsePublicKey('ssh-ed25519 AAAA$(id) x'), null);
  assert.equal(P.parsePublicKey(pub + '\nssh-ed25519 AAAA'), null, 'one line only');
  assert.equal(P.parsePublicKey('ssh-rsa ' + Buffer.from('not a key at all, just text padding padding padding').toString('base64')), null, 'blob must start with its own type');
  const evil = P.parsePublicKey(pub.replace('me@laptop', 'x"; rm -rf / #'));
  assert.ok(evil && !/[";#/]/.test(evil.comment), 'comment is reduced to a safe charset');
  assert.ok(P.parsePublicKey('command="/bin/true" ' + pub).options, 'options-prefixed lines still parse');
});

test('security: ports, protocols and sources are validated', () => {
  assert.equal(P.assertPort('2222'), 2222);
  for (const bad of [0, 65536, '22;id', 'abc', 1.5]) assert.throws(() => P.assertPort(bad), e => e.statusCode === 400);
  assert.throws(() => P.assertProto('icmp'));
  assert.equal(P.assertSource('any'), 'any');
  assert.equal(P.assertSource('10.0.0.0/24'), '10.0.0.0/24');
  assert.throws(() => P.assertSource('1.2.3.4;id'), e => e.statusCode === 400);
});

// ---------------------------------------------------------------- sshd
test('security: sshd -T parsing and the access view', () => {
  const sec = P.sections('@@uid\n0\n@@sshdT\nport 22\nport 2222\npermitrootlogin without-password\npasswordauthentication yes\nmaxauthtries 3\nclientaliveinterval 300\nclientalivecountmax 2\nx11forwarding no\n@@dropin\n@@include\nInclude /etc/ssh/sshd_config.d/*.conf\n@@reboot\nyes\n');
  const a = P.accessState(sec);
  assert.deepEqual(a.ports, [22, 2222]);
  assert.equal(a.rootLogin, 'prohibit-password', 'without-password is normalised');
  assert.equal(a.passwordAuth, true);
  assert.equal(a.idleTimeoutMin, 10);
  assert.equal(a.includesDropins, true);
  assert.equal(a.rebootRequired, true);
  assert.equal(a.isRoot, true);
});

test('security: the sshd drop-in round-trips and rejects bad values', () => {
  const conf = P.buildAccessConf({ rootLogin: 'no', passwordAuth: false, ports: [2222], maxAuthTries: 3, clientAliveInterval: 300, x11: false });
  assert.match(conf, /^PermitRootLogin no$/m);
  assert.match(conf, /^PasswordAuthentication no$/m);
  assert.match(conf, /^KbdInteractiveAuthentication no$/m, 'keyboard-interactive is turned off together with passwords');
  assert.match(conf, /^Port 2222$/m);
  const back = P.parseAccessConf(conf);
  assert.equal(back.rootLogin, 'no');
  assert.equal(back.passwordAuth, false);
  assert.deepEqual(back.ports, [2222]);
  assert.throws(() => P.buildAccessConf({ rootLogin: 'maybe' }), e => e.statusCode === 400);
  assert.throws(() => P.buildAccessConf({ maxAuthTries: 99 }), e => e.statusCode === 400);
});

// ---------------------------------------------------------------- users
test('security: users view — human accounts, sudo/docker/locked, keys; service accounts hidden', () => {
  const today = 20000;
  const out = [
    '@@passwd', 'root:x:0:0:root:/root:/bin/bash', 'ubuntu:x:1000:1000::/home/ubuntu:/bin/bash', 'deploy:x:1001:1001::/home/deploy:/bin/bash', 'old:x:1002:1002::/home/old:/bin/bash', 'nixbld1:x:30001:30000::/var/empty:/sbin/nologin', 'www-data:x:33:33::/var/www:/usr/sbin/nologin',
    '@@groups', 'sudo:x:27:ubuntu', 'docker:x:996:deploy',
    '@@sudoersd', '90-dockgate-deploy', 'README',
    '@@shadow', 'root:$:', 'ubuntu:!:', 'deploy:!:', 'old:$:1',
    '@@lastlog', 'deploy          pts/0    1.2.3.4          Fri Nov  7 01:00:00 +0000 2026', 'ubuntu                                     **Never logged in**',
    '@@sshd', 'passwordauthentication yes', 'permitrootlogin yes',
    '@@keys deploy', pub,
  ].join('\n');
  const st = P.usersState(P.sections(out), today);
  const names = st.users.map(u => u.name);
  assert.deepEqual(names, ['root', 'ubuntu', 'deploy', 'old'], 'uid 0 and 1000-59999 only; nologin service accounts hidden');
  const by = Object.fromEntries(st.users.map(u => [u.name, u]));
  assert.equal(by.ubuntu.sudo, true, 'sudo group');
  assert.equal(by.deploy.sudo, true, 'DockGate sudoers file');
  assert.equal(by.deploy.docker, true);
  assert.equal(by.deploy.keys.length, 1);
  assert.equal(by.old.locked, true, 'expired account = locked');
  assert.equal(by.root.passwordLogin, true, 'root has a password and PermitRootLogin yes');
  assert.equal(by.ubuntu.passwordLogin, false, 'no usable password hash');
  assert.match(by.deploy.lastLogin, /Nov/);
  assert.equal(by.ubuntu.lastLogin, null);
});

test('security: removing a key keeps every other line', () => {
  const other = utils.generateKeyPairSync('ed25519', { comment: 'other' }).public;
  const fp = P.parsePublicKey(pub).fingerprint;
  const { content, removed } = P.removeAuthorizedKey(`# my keys\n${pub}\n${other}\n`, fp);
  assert.equal(removed, 1);
  assert.match(content, /# my keys/);
  assert.ok(content.includes(other));
  assert.ok(!content.includes(pub));
});

// ---------------------------------------------------------------- firewall
const UFW = `Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 22/tcp                     ALLOW IN    Anywhere
[ 2] 80/tcp                     ALLOW IN    Anywhere
[ 3] 80/tcp                     ALLOW FWD   Anywhere
[ 4] 8080/tcp                   ALLOW IN    198.51.100.24
[ 5] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
`;

test('security: ufw status numbered parsing (IN / FWD / v6 / restricted source)', () => {
  const u = P.parseUfwNumbered(UFW);
  assert.equal(u.active, true);
  assert.equal(u.rules.length, 5);
  assert.deepEqual(u.rules[2], { n: 3, to: '80/tcp', action: 'ALLOW', dir: 'FWD', from: 'Anywhere', v6: false, note: '' });
  assert.equal(u.rules[4].v6, true);
  assert.equal(u.rules[3].from, '198.51.100.24');
  assert.equal(P.parseUfwNumbered('Status: inactive').active, false);
});

test('security: listening ports — docker bypass vs isolation, loopback, restricted, ssh', () => {
  const listeners = P.parseSs([
    'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
    'tcp LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* users:(("docker-proxy",pid=2,fd=4))',
    'tcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=3,fd=5))',
    'tcp LISTEN 0 4096 127.0.0.1:9100 0.0.0.0:* users:(("node_exporter",pid=4,fd=6))',
  ].join('\n'));
  const dockerPorts = P.parseDockerPorts('db|0.0.0.0:5432->5432/tcp, :::5432->5432/tcp\nweb|0.0.0.0:8081->80/tcp\nlocal|127.0.0.1:6379->6379/tcp');
  assert.deepEqual(dockerPorts.find(d => d.container === 'web'), { container: 'web', hostIp: '0.0.0.0', hostPort: 8081, containerPort: 80, proto: 'tcp' });
  const ufw = P.parseUfwNumbered(UFW);
  const off = P.computePorts({ listeners, dockerPorts, ufw, isolation: false, sshPort: 22 });
  const row = (rows, port) => rows.find(r => r.port === port);
  assert.equal(row(off, 5432).exposure, 'bypass', 'without isolation a container port skips UFW');
  assert.equal(row(off, 6379).exposure, 'local');
  assert.equal(row(off, 9100).exposure, 'local');
  assert.equal(row(off, 22).isSsh, true);
  assert.equal(row(off, 8080).exposure, 'restricted');
  assert.equal(row(off, 8080).restrictedTo, '198.51.100.24');
  const on = P.computePorts({ listeners, dockerPorts, ufw, isolation: true, sshPort: 22 });
  assert.equal(row(on, 5432).exposure, 'internal', 'isolated container port without a route rule');
  assert.equal(row(on, 8081).exposure, 'public', 'route allow on the CONTAINER port (80) opens host port 8081');
  const inactive = P.computePorts({ listeners, dockerPorts, ufw: { active: false, rules: [] }, isolation: false, sshPort: 22 });
  assert.equal(row(inactive, 8080).exposure, 'public');
});

test('security: rule numbers to delete are matched and returned highest first', () => {
  const ufw = P.parseUfwNumbered(UFW);
  assert.deepEqual(P.ruleNumbersFor(ufw.rules, { port: 22, proto: 'tcp', dir: 'IN' }), [5, 1]);
  assert.deepEqual(P.ruleNumbersFor(ufw.rules, { port: 80, proto: 'tcp', dir: 'FWD' }), [3]);
});

// ---------------------------------------------------------------- plans
test('plans: user content travels base64-encoded, never as raw text in the command', () => {
  const k = P.parsePublicKey(pub);
  const plan = plans.deployUserPlan({ username: 'deploy', keys: [k], test: { username: 'deploy', keyPath: '/x' } });
  const all = plan.steps.filter(s => s.cmd).map(s => s.cmd).join('\n');
  assert.ok(!all.includes('me@laptop'), 'the key line is base64-encoded');
  assert.ok(all.includes('visudo -cf /etc/sudoers.d/90-dockgate-deploy'), 'sudoers validated');
  assert.ok(plan.steps[plan.steps.length - 1].test, 'last step proves a NEW login');
});

test('plans: access change = validate → arm rollback → apply → test new login → commit', () => {
  const plan = plans.accessPlan({ id: 'abc', content: 'PasswordAuthentication no\n', test: { username: 'deploy' } });
  const labels = plan.steps.map(s => s.label);
  assert.match(labels[0], /validate/i);
  assert.match(labels[1], /rollback/i);
  assert.match(labels[2], /reload/i);
  assert.ok(plan.steps[3].test && plan.steps[3].rollbackOnFail);
  assert.match(labels[4], /Keep/);
  assert.match(plan.steps[0].cmd, /sshd -t/);
  assert.match(plan.rollback, /rollback-abc\.sh/);
});

test('plans: port change opens the new port first and closes the old one only after the test', () => {
  const plan = plans.accessPlan({ id: 'p1', content: 'Port 2222\n', test: { username: 'deploy', port: 2222 }, portChange: { from: 22, to: 2222 } });
  const i = (re) => plan.steps.findIndex(s => re.test(s.label));
  assert.ok(i(/^Open 2222/) < i(/NEW SSH/));
  assert.ok(i(/NEW SSH/) < i(/Close the old port 22/));
  assert.match(plan.steps[0].cmd, /semanage port/, 'SELinux handled');
});

test('plans: Docker isolation block = DOCKER-USER rules + ufw-user-forward; keep-public uses route allow', () => {
  const plan = plans.isolationPlan({ id: 'i1', enable: true, keepPublic: [{ port: 80, proto: 'tcp' }], test: { username: 'deploy' } });
  assert.match(plans.DOCKER_BLOCK, /-A DOCKER-USER -j ufw-user-forward/);
  assert.match(plans.DOCKER_BLOCK, /BEGIN DOCKGATE-DOCKER[\s\S]*COMMIT[\s\S]*END DOCKGATE-DOCKER/);
  assert.ok(plan.steps.some(s => /ufw route allow proto tcp from any to any port 80/.test(s.cmd || '')));
  assert.ok(plan.steps.some(s => s.test && s.rollbackOnFail));
});

// ---------------------------------------------------------------- host keys
test('ssh-hostkey: fingerprints, strict verifier and known_hosts line', () => {
  const blob = utils.parseKey(utils.generateKeyPairSync('ed25519').public).getPublicSSH();
  const fp = hostkey.fingerprint(blob);
  assert.match(fp, /^SHA256:/);
  assert.equal(hostkey.keyType(blob), 'ssh-ed25519');
  assert.equal(hostkey.keyTypeLabel('ssh-ed25519'), 'ED25519');
  assert.equal(hostkey.strictVerifier(fp)(blob), true);
  assert.equal(hostkey.strictVerifier('SHA256:other')(blob), false);
  assert.equal(hostkey.strictVerifier(null)(blob), true, 'nothing pinned yet → accept');
  assert.equal(hostkey.knownHostsLine({ host: 'h', port: 22, host_key_blob: blob.toString('base64') }), `h ssh-ed25519 ${blob.toString('base64')}`);
  assert.match(hostkey.knownHostsLine({ host: 'h', port: 2222, host_key_blob: blob.toString('base64') }), /^\[h\]:2222 /);
  assert.ok(hostkey.isHostKeyError(new Error('Host denied (verification failed)')));
  assert.ok(!hostkey.isHostKeyError(new Error('Handshake failed: signature verification failed')));
});

test('ssh-hostkey: main-process verifier pins on first use, then refuses a different key', () => {
  const { stmts } = require('../../server/db');
  stmts.insertServer.run('pin-test', 'ssh', 'h', 22, 'u', null, null, null, '', null, 1);
  const a = utils.parseKey(utils.generateKeyPairSync('ed25519').public).getPublicSSH();
  const b = utils.parseKey(utils.generateKeyPairSync('ed25519').public).getPublicSSH();
  const verify = hostkey.verifierFor({ id: 'pin-test' });
  assert.equal(verify(a), true, 'first key is pinned');
  assert.equal(stmts.getServer.get('pin-test').host_key, hostkey.fingerprint(a));
  assert.equal(verify(a), true, 'same key again');
  assert.equal(verify(b), false, 'different key refused');
  stmts.clearServerHostKey.run('pin-test');
  assert.equal(verify(b), true, 're-trust → the new key is pinned');
});
