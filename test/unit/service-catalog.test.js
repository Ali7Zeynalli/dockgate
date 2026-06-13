const { test } = require('node:test');
const assert = require('node:assert');
const cat = require('../../server/provision/catalog');

test('service: manageableItems() = the 6 service items in seq order', () => {
  assert.deepEqual(cat.manageableItems(), ['timesync', 'firewall', 'ssh-hardening', 'fail2ban', 'unattended-upgrades', 'docker']);
});

test('service: serviceFor resolves unit + verbs per distro; na where no variant; null for non-services; throws on unknown distro', () => {
  const docker = cat.serviceFor('docker', 'ubuntu');
  assert.equal(docker.unit, 'docker');
  assert.equal(docker.verbs.restart, 'sudo systemctl restart docker');
  assert.deepEqual(docker.configPaths, ['/etc/docker/daemon.json']);

  const ssh = cat.serviceFor('ssh-hardening', 'rocky');
  assert.equal(ssh.unit, 'sshd');
  assert.equal(ssh.reload, true);
  assert.equal(ssh.verbs.restart, 'sudo systemctl reload sshd', 'reload-mode service maps restart→reload');
  assert.equal(ssh.validate, 'sudo sshd -t');
  assert.equal(ssh.requiresKeyForConfig, true);

  assert.equal(cat.serviceFor('firewall', 'alpine').na, true, 'firewall has no alpine variant');
  assert.equal(cat.serviceFor('update', 'ubuntu'), null, 'non-service item');
  assert.throws(() => cat.serviceFor('docker', 'plan9'), /Unsupported distro/);
});

test('service: openrc verbs on alpine (docker)', () => {
  const d = cat.serviceFor('docker', 'alpine');
  assert.equal(d.manager, 'openrc');
  assert.equal(d.verbs.start, 'sudo rc-service docker start');
  assert.ok(d.verbs.enable.includes('rc-update add docker default'));
});

test('service: serviceAction returns the fixed command; unknown action/item throws 400', () => {
  assert.equal(cat.serviceAction('fail2ban', 'ubuntu', 'restart'), 'sudo systemctl restart fail2ban');
  assert.equal(cat.serviceAction('ssh-hardening', 'ubuntu', 'restart'), 'sudo systemctl reload ssh');
  assert.throws(() => cat.serviceAction('docker', 'ubuntu', 'rm -rf /'), (e) => e.statusCode === 400);
  assert.throws(() => cat.serviceAction('update', 'ubuntu', 'restart'), (e) => e.statusCode === 400);
});

test('service: isConfigPathAllowed exact-match allowlist; rejects traversal / non-absolute / non-listed', () => {
  assert.equal(cat.isConfigPathAllowed('fail2ban', 'ubuntu', '/etc/fail2ban/jail.local'), true);
  assert.equal(cat.isConfigPathAllowed('ssh-hardening', 'ubuntu', '/etc/ssh/sshd_config.d/99-dockgate.conf'), true);
  assert.equal(cat.isConfigPathAllowed('fail2ban', 'ubuntu', '/etc/passwd'), false, 'not in allowlist');
  assert.equal(cat.isConfigPathAllowed('fail2ban', 'ubuntu', '/etc/fail2ban/../shadow'), false, 'traversal');
  assert.equal(cat.isConfigPathAllowed('fail2ban', 'ubuntu', 'etc/fail2ban/jail.local'), false, 'non-absolute');
  assert.equal(cat.isConfigPathAllowed('update', 'ubuntu', '/etc/fail2ban/jail.local'), false, 'non-service item');
});

test('service.guardedServiceAction: config write requires confirm (409)', () => {
  assert.throws(
    () => cat.guardedServiceAction({ hasKey: true, itemId: 'fail2ban', osId: 'ubuntu', isConfigWrite: true, confirm: false }),
    (e) => e.statusCode === 409 && e.risks.some(r => r.id === 'fail2ban')
  );
  assert.doesNotThrow(() => cat.guardedServiceAction({ hasKey: true, itemId: 'fail2ban', osId: 'ubuntu', isConfigWrite: true, confirm: true }));
});

test('service.guardedServiceAction: SSH config write over a password login is refused (400 lockout)', () => {
  assert.throws(
    () => cat.guardedServiceAction({ hasKey: false, itemId: 'ssh-hardening', osId: 'ubuntu', isConfigWrite: true, confirm: true }),
    (e) => e.statusCode === 400 && /lock you out/i.test(e.message)
  );
  assert.doesNotThrow(() => cat.guardedServiceAction({ hasKey: true, itemId: 'ssh-hardening', osId: 'ubuntu', isConfigWrite: true, confirm: true }));
});

test('service.guardedServiceAction: stopping/disabling SSH over a password login is refused (400 lockout)', () => {
  for (const action of ['stop', 'disable']) {
    assert.throws(
      () => cat.guardedServiceAction({ hasKey: false, itemId: 'ssh-hardening', action, confirm: true }),
      (e) => e.statusCode === 400 && /lock you out/i.test(e.message),
      `${action} ssh over password must 400`
    );
  }
  // restart maps to reload for ssh (keeps the connection) → allowed with confirm even over a password login
  assert.doesNotThrow(() => cat.guardedServiceAction({ hasKey: false, itemId: 'ssh-hardening', action: 'restart', confirm: true }));
  // with a key, stop/disable is allowed (still confirm-gated, which the caller satisfies here)
  assert.doesNotThrow(() => cat.guardedServiceAction({ hasKey: true, itemId: 'ssh-hardening', action: 'disable', confirm: true }));
});

test('service.validateParam: accepts valid, rejects shell-metachar / out-of-range', () => {
  // ip
  assert.equal(cat.validateParam('ip', '203.0.113.4'), '203.0.113.4');
  assert.equal(cat.validateParam('ip', '10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(cat.validateParam('ip', '2001:db8::1'), '2001:db8::1');
  assert.equal(cat.validateParam('ip', '999.1.1.1'), null);
  assert.equal(cat.validateParam('ip', '1.2.3.4; rm -rf /'), null, 'injection rejected');
  assert.equal(cat.validateParam('ip', '$(reboot)'), null);
  // port
  assert.equal(cat.validateParam('port', '8080'), '8080');
  assert.equal(cat.validateParam('port', '70000'), null);
  assert.equal(cat.validateParam('port', '80; ls'), null);
  // proto
  assert.equal(cat.validateParam('proto', 'tcp'), 'tcp');
  assert.equal(cat.validateParam('proto', 'icmp'), null);
  // jail
  assert.equal(cat.validateParam('jail', 'sshd'), 'sshd');
  assert.equal(cat.validateParam('jail', 'a b'), null);
  assert.equal(cat.validateParam('jail', '`id`'), null);
  // rulenum
  assert.equal(cat.validateParam('rulenum', '3'), '3');
  assert.equal(cat.validateParam('rulenum', '0'), null);
});

test('service.buildServiceOp: builds validated command; rejects bad params (400) + confirm gate (409)', () => {
  // fail2ban unban (no confirm) — valid
  const un = cat.buildServiceOp('fail2ban', 'ubuntu', 'unban', { jail: 'sshd', ip: '203.0.113.4' }, {});
  assert.equal(un.cmd, 'sudo fail2ban-client set sshd unbanip 203.0.113.4');
  // fail2ban ban requires confirm
  assert.throws(() => cat.buildServiceOp('fail2ban', 'ubuntu', 'ban', { jail: 'sshd', ip: '203.0.113.4' }, {}), (e) => e.statusCode === 409);
  assert.doesNotThrow(() => cat.buildServiceOp('fail2ban', 'ubuntu', 'ban', { jail: 'sshd', ip: '203.0.113.4' }, { confirm: true }));
  // bad ip rejected (400) — never reaches the shell
  assert.throws(() => cat.buildServiceOp('fail2ban', 'ubuntu', 'ban', { jail: 'sshd', ip: '1;rm -rf /' }, { confirm: true }), (e) => e.statusCode === 400);
  // ufw allow (debian) valid; firewalld add (rhel) valid
  assert.equal(cat.buildServiceOp('firewall', 'ubuntu', 'allow', { port: '8080', proto: 'tcp' }, {}).cmd, 'sudo ufw allow 8080/tcp');
  assert.ok(cat.buildServiceOp('firewall', 'rocky', 'allow', { port: '8080', proto: 'tcp' }, {}).cmd.includes('firewall-cmd --permanent --add-port=8080/tcp'));
  // ufw delete requires confirm
  assert.throws(() => cat.buildServiceOp('firewall', 'ubuntu', 'delete', { num: '2' }, {}), (e) => e.statusCode === 409);
  // unknown op
  assert.throws(() => cat.buildServiceOp('fail2ban', 'ubuntu', 'nuke', {}, { confirm: true }), (e) => e.statusCode === 400);
});

test('service.guardedServiceAction: destructive on high-risk/docker needs confirm; harmless restart does not', () => {
  // high-risk firewall stop → confirm
  assert.throws(() => cat.guardedServiceAction({ hasKey: true, itemId: 'firewall', osId: 'ubuntu', action: 'stop', confirm: false }), (e) => e.statusCode === 409);
  // docker restart → confirm (stops containers)
  assert.throws(() => cat.guardedServiceAction({ hasKey: true, itemId: 'docker', osId: 'ubuntu', action: 'restart', confirm: false }), (e) => e.statusCode === 409);
  // low-risk fail2ban restart → no confirm
  assert.doesNotThrow(() => cat.guardedServiceAction({ hasKey: true, itemId: 'fail2ban', osId: 'ubuntu', action: 'restart', confirm: false }));
  // non-destructive start even on high-risk firewall → no confirm
  assert.doesNotThrow(() => cat.guardedServiceAction({ hasKey: true, itemId: 'firewall', osId: 'ubuntu', action: 'start', confirm: false }));
});
