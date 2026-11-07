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

// ssh2's ed25519 generator occasionally emits a truncated public key (~1/200) — tests use valid ones only.
function validPair(comment) {
  for (;;) { const k = utils.generateKeyPairSync('ed25519', comment ? { comment } : undefined); if (!(utils.parseKey(k.public) instanceof Error)) return k; }
}
const pub = validPair('me@laptop').public;
const blobOf = () => utils.parseKey(validPair().public).getPublicSSH();

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
  assert.equal(a.deadTimeoutMin, 10, 'ClientAlive = dead-connection detection, not an idle limit');
  assert.equal(a.idleTimeoutMin, 0, 'no ChannelTimeout → no idle limit');
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
  const other = validPair('other').public;
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

test('plans: Docker isolation covers IPv6 (after6.rules) when UFW manages it, and rollback restores both files', () => {
  assert.match(plans.DOCKER_BLOCK6, /-A DOCKER-USER -j ufw6-user-forward/);
  assert.match(plans.DOCKER_BLOCK6, /fc00::\/7/);
  assert.doesNotMatch(plans.DOCKER_BLOCK6, /\b10\.0\.0\.0|192\.168/, 'no IPv4 ranges in the v6 table');
  const on = plans.isolationPlan({ id: 'i6', enable: true, keepPublic: [], test: { username: 'deploy' } });
  const all = on.steps.map(s => s.cmd || '').join('\n');
  assert.match(all, /if \{\{S\}\}test -f \/etc\/ufw\/after6\.rules; then/, 'v6 step is guarded by file existence');
  assert.match(all, /tee -a \/etc\/ufw\/after6\.rules/);
  assert.match(all, /cp -p \/etc\/ufw\/after6\.rules \/etc\/ufw\/after6\.rules\.dockgate-prev/);
  const decoded = all.match(/echo ([A-Za-z0-9+/=]{20,}) \| base64 -d/g).map(m => Buffer.from(m.split(' ')[1], 'base64').toString()).join('\n');
  assert.match(decoded, /mv -f \/etc\/ufw\/after6\.rules\.dockgate-prev \/etc\/ufw\/after6\.rules/, 'rollback restores after6.rules');
  assert.match(decoded, /mv -f \/etc\/ufw\/after\.rules\.dockgate-prev \/etc\/ufw\/after\.rules/, 'rollback restores after.rules');
  const off = plans.isolationPlan({ id: 'i7', enable: false, keepPublic: [], test: { username: 'deploy' } });
  assert.ok(off.steps.some(s => /after6\.rules/.test(s.cmd || '') && /sed -i/.test(s.cmd)), 'turning off strips the v6 block too');
});

// ---------------------------------------------------------------- host keys
test('ssh-hostkey: fingerprints, strict verifier and known_hosts line', () => {
  const blob = blobOf();
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
  const a = blobOf();
  const b = blobOf();
  const verify = hostkey.verifierFor({ id: 'pin-test' });
  assert.equal(verify(a), true, 'first key is pinned');
  assert.equal(stmts.getServer.get('pin-test').host_key, hostkey.fingerprint(a));
  assert.equal(verify(a), true, 'same key again');
  assert.equal(verify(b), false, 'different key refused');
  stmts.clearServerHostKey.run('pin-test');
  assert.equal(verify(b), true, 're-trust → the new key is pinned');
});

test('security: a truncated ed25519 public key (ssh2 generator bug) is rejected', () => {
  const good = P.parsePublicKey(pub);
  const blob = Buffer.from(good.b64, 'base64');
  const truncated = Buffer.concat([blob.slice(0, 15), Buffer.from([0, 0, 0, 31]), blob.slice(20, 51)]);
  assert.equal(P.parsePublicKey('ssh-ed25519 ' + truncated.toString('base64')), null);
});

test('security: generateKey only returns pairs whose public key really matches the private key', () => {
  const svc = require('../../server/security/service');
  for (let i = 0; i < 50; i++) {
    const g = svc.generateKey('unit', 'u');
    const priv = utils.parseKey(require('node:fs').readFileSync(g.abs, 'utf8'));
    assert.equal(priv.getPublicSSH().toString('base64'), g.pub.b64);
    svc.removeKeyFile(g.privatePath);
  }
});

test('security: hardening drop-in — grace time, empty passwords, real idle limit (ChannelTimeout)', () => {
  const conf = P.buildAccessConf({ maxAuthTries: 3, loginGraceTime: 30, permitEmptyPasswords: false, clientAliveInterval: 300, clientAliveCountMax: 2, idleTimeoutMin: 15, x11: false });
  assert.match(conf, /^LoginGraceTime 30$/m);
  assert.match(conf, /^PermitEmptyPasswords no$/m);
  assert.match(conf, /^ChannelTimeout session=15m$/m);
  assert.match(conf, /^UnusedConnectionTimeout 15m$/m);
  assert.equal(P.parseAccessConf(conf).idleTimeoutMin, 15);
  const st = P.accessState(P.sections('@@sshdT\nport 22\nchanneltimeout session=15m\n@@sshver\nOpenSSH_9.6p1 Ubuntu\n@@legacy\nMaxAuthTries 4\n@@dropin\nX11Forwarding no\n'));
  assert.equal(st.idleTimeoutMin, 15);
  assert.equal(st.supportsIdleTimeout, true);
  assert.equal(st.dropin.maxAuthTries, 4, 'values from the old 99-dockgate.conf are carried over');
  assert.equal(st.legacyFile, true);
  assert.equal(P.accessState(P.sections('@@sshver\nOpenSSH_8.9p1\n')).supportsIdleTimeout, false);
});

test('time sync: host validation and chrony.conf parsing', () => {
  for (const ok of ['pool.ntp.org', 'time.cloudflare.com', '192.0.2.1', 'ntp1']) assert.ok(P.validHost(ok), ok);
  for (const bad of ['', 'a b', 'x;rm', 'bad..host', '-x.org', '10.0.0.0/8', 'a'.repeat(254)]) assert.ok(!P.validHost(bad), bad);
  const c = P.parseChronyConf('#dockgate# pool ntp.ubuntu.com iburst\n# BEGIN DOCKGATE-NTP\npool pool.ntp.org iburst\nserver 192.0.2.1 iburst\n# END DOCKGATE-NTP\n');
  assert.deepEqual(c.servers, [{ type: 'pool', host: 'pool.ntp.org' }, { type: 'server', host: '192.0.2.1' }]);
  assert.equal(c.managed, true);
  assert.equal(P.parseChronyConf('pool ntp.ubuntu.com iburst').managed, false);
});

test('plans: NTP change = backup → write → validate (chronyd -p) → restart, restore on failure', () => {
  const plan = plans.ntpPlan({ servers: [{ type: 'pool', host: 'pool.ntp.org' }] });
  const labels = plan.steps.map(s => s.label);
  assert.match(labels[0], /Back up/);
  assert.match(plan.steps[2].cmd, /chronyd -p -f \$C/);
  assert.match(plan.steps[2].cmd, /dockgate-prev/, 'restores the backup when chrony rejects the file');
  assert.ok(!plan.steps[1].cmd.includes('pool.ntp.org'), 'the new lines travel base64-encoded');
  assert.match(plans.ntpPlan({ servers: [] }).steps[1].cmd, /s\/\^#dockgate# \/\//, 'defaults: the distro lines are uncommented');
});

test('plans: switching UFW on allows SSH first, tests a new login, rolls back with ufw disable', () => {
  const plan = plans.ufwEnablePlan({ id: 'u1', sshPorts: [2222, 22], webPorts: [80, 443], test: { username: 'deploy' } });
  const i = (re) => plan.steps.findIndex(s => re.test(s.label));
  assert.ok(i(/^Allow 2222\/tcp, 22\/tcp, 80\/tcp, 443\/tcp/) >= 0);
  assert.ok(i(/^Allow/) < i(/Switch the firewall on/));
  assert.ok(i(/Switch the firewall on/) < i(/NEW SSH/));
  assert.ok(plan.steps[i(/NEW SSH/)].rollbackOnFail);
  const armed = Buffer.from(/echo (\S+) \| base64 -d/.exec(plan.steps[i(/^Arm/)].cmd)[1], 'base64').toString();
  assert.match(armed, /ufw --force disable/, 'the server-side rollback script switches UFW off');
  assert.throws(() => plans.ufwEnablePlan({ id: 'u2', sshPorts: ['22;id'], webPorts: [], test: {} }), e => e.statusCode === 400);
});

// ---------------------------------------------------------------- firewalld
const FWD_LIST = `public (active)
  target: default
  interfaces: eth0
  sources: 
  services: dhcpv6-client ssh
  ports: 8080/tcp 9000-9010/udp
  forward-ports: 
  rich rules: 
\trule family="ipv4" source address="203.0.113.5" port port="5432" protocol="tcp" accept
\trule port port="3306" protocol="tcp" reject`;
const FWD_SVC = 'dhcpv6-client 546/udp\nssh 22/tcp';

test('firewalld: --list-all → zone + UFW-shaped rules (deny first, services resolved to ports)', () => {
  const f = P.parseFirewalld(FWD_LIST, FWD_SVC);
  assert.equal(f.zone, 'public');
  assert.equal(f.active, true);
  assert.deepEqual(f.rules.map(r => `${r.n} ${r.to} ${r.action} ${r.from} ${r.kind}`), [
    '1 3306/tcp DENY Anywhere rich',
    '2 546/udp ALLOW Anywhere service',
    '3 22/tcp ALLOW Anywhere service',
    '4 8080/tcp ALLOW Anywhere port',
    '5 9000-9010/udp ALLOW Anywhere port',
    '6 5432/tcp ALLOW 203.0.113.5 rich',
  ]);
  assert.equal(f.rules[2].key, 'ssh');
  assert.match(f.rules[5].key, /^rule family="ipv4" source address="203\.0\.113\.5"/);
  assert.equal(P.parseFirewalld('', '').active, false);
});

test('firewall: port ranges count as open, but only single-port rules are deleted by "Close"', () => {
  assert.deepEqual(P.ruleTarget('9000:9010/tcp'), { port: 9000, portEnd: 9010, proto: 'tcp' });
  assert.deepEqual(P.ruleTarget('9000-9010/udp'), { port: 9000, portEnd: 9010, proto: 'udp' });
  assert.ok(P.targetCovers(P.ruleTarget('9000-9010/udp'), 9005, 'udp', false));
  assert.ok(!P.targetCovers(P.ruleTarget('9000-9010/udp'), 9005, 'udp', true));
  assert.ok(!P.targetCovers(P.ruleTarget('9000-9010/udp'), 9005, 'tcp', false));
  const ufw = P.parseUfwNumbered('Status: active\n[ 1] 9000:9010/tcp              ALLOW IN    Anywhere\n');
  assert.deepEqual(P.ruleNumbersFor(ufw.rules, { port: 9005, proto: 'tcp', dir: 'IN' }), []);
});

test('firewalld: exposure — services/ports/rich rules, container ports always bypass', () => {
  const f = P.parseFirewalld(FWD_LIST, FWD_SVC);
  const listeners = [
    { port: 22, proto: 'tcp', bind: '0.0.0.0', process: 'sshd' },
    { port: 5432, proto: 'tcp', bind: '0.0.0.0', process: 'postgres' },
    { port: 9005, proto: 'udp', bind: '0.0.0.0', process: 'app' },
    { port: 6379, proto: 'tcp', bind: '0.0.0.0', process: 'redis' },
  ];
  const dockerPorts = [{ hostIp: '0.0.0.0', hostPort: 8081, containerPort: 80, proto: 'tcp', container: 'web' }];
  const rows = P.computePorts({ listeners, dockerPorts, ufw: f, isolation: false, sshPort: 22 });
  const by = (p) => rows.find(r => r.port === p);
  assert.equal(by(22).exposure, 'public');
  assert.equal(by(5432).exposure, 'restricted');
  assert.equal(by(5432).restrictedTo, '203.0.113.5');
  assert.equal(by(9005).exposure, 'public', 'inside a range');
  assert.equal(by(6379).exposure, 'internal');
  assert.equal(by(8081).exposure, 'bypass');
});

test('firewalld: commands — permanent + reload, rich rules for sources/deny, quoted removal', () => {
  assert.equal(plans.fwdAddCmd({ zone: 'public', port: 8443, proto: 'tcp', from: 'any', action: 'allow' }),
    '{{S}}firewall-cmd --permanent --zone=public --add-port=8443/tcp >/dev/null && {{S}}firewall-cmd --reload >/dev/null');
  assert.match(plans.fwdAddCmd({ zone: 'public', port: 5432, proto: 'tcp', from: '10.0.0.0/24', action: 'allow' }),
    /--add-rich-rule='rule family="ipv4" source address="10\.0\.0\.0\/24" port port="5432" protocol="tcp" accept'/);
  assert.match(plans.fwdAddCmd({ zone: 'public', port: 25, proto: 'tcp', from: 'any', action: 'deny' }),
    /--add-rich-rule='rule port port="25" protocol="tcp" reject'/);
  assert.match(plans.fwdRichRule({ port: 80, proto: 'tcp', from: '2001:db8::/32', action: 'allow' }), /family="ipv6"/);
  assert.throws(() => plans.fwdAddCmd({ zone: 'pub;rm', port: 80, proto: 'tcp', from: 'any', action: 'allow' }), /zone/);
  assert.throws(() => plans.fwdAddCmd({ zone: 'public', port: 80, proto: 'tcp', from: '1.2.3.4;id', action: 'allow' }));
  const f = P.parseFirewalld(FWD_LIST, FWD_SVC);
  const rm = plans.fwdRemoveCmd('public', [f.rules[5], f.rules[2], f.rules[2]]);
  assert.match(rm, /--remove-rich-rule='rule family="ipv4" source address="203\.0\.113\.5" port port="5432" protocol="tcp" accept'/);
  assert.equal((rm.match(/--remove-service=ssh/g) || []).length, 1, 'one removal per service');
  assert.match(rm, /firewall-cmd --reload/);
  assert.throws(() => plans.fwdRemoveCmd('public', [{ kind: 'rich', key: "rule accept'\n; id" }]), /rich rule/);
  assert.equal(plans.fwdRemoveCmd('public', []), 'true');
});
