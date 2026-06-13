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
