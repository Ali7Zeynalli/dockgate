const { test } = require('node:test');
const assert = require('node:assert');
const cat = require('../../server/provision/catalog');

test('catalog: presets resolve to ordered, dependency-closed item ids', () => {
  assert.deepEqual(cat.resolveItems('just-docker'), ['update', 'docker', 'docker-group']);
  const sec = cat.resolveItems('secure-baseline');
  assert.ok(sec.includes('docker') && sec.includes('docker-group') && sec.includes('firewall'));
  const seqs = sec.map(id => cat.byId[id].seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); // ordered by seq
  assert.equal(cat.resolveItems('full').length, cat.ITEMS.length);
});

test('catalog: custom only-list pulls in dependsOn (docker-group needs docker)', () => {
  const r = cat.resolveItems('custom', ['docker-group']);
  assert.ok(r.includes('docker'), 'docker auto-added as a dependency');
  assert.ok(r.indexOf('docker') < r.indexOf('docker-group'), 'dependency ordered first');
});

test('catalog: custom only-list ignores unknown ids (no free-form injection)', () => {
  assert.deepEqual(cat.resolveItems('custom', ['rm -rf /', 'docker']), ['docker']);
});

test('catalog: distroFamily maps os-release ids, null for unknown', () => {
  assert.equal(cat.distroFamily('ubuntu'), 'debian');
  assert.equal(cat.distroFamily('debian'), 'debian');
  assert.equal(cat.distroFamily('rocky'), 'rhel');
  assert.equal(cat.distroFamily('alpine'), 'alpine');
  assert.equal(cat.distroFamily('plan9'), null);
});

test('catalog: buildPlanForDistro returns concrete commands; throws on unknown distro', () => {
  const plan = cat.buildPlanForDistro(cat.resolveItems('just-docker'), 'ubuntu');
  assert.equal(plan.length, 3);
  for (const step of plan) {
    assert.ok(step.detect && step.install && step.verify, `step ${step.id} has all 3 commands`);
  }
  assert.throws(() => cat.buildPlanForDistro(['docker'], 'plan9'), /Unsupported distro/);
});

test('catalog: ssh-hardening is now SAFE (no requiresKey, low risk); firewall stays high risk', () => {
  assert.ok(!cat.byId['ssh-hardening'].requiresKey, 'no key requirement — safe hardening cannot lock you out');
  assert.equal(cat.byId['ssh-hardening'].risk, 'low');
  assert.equal(cat.byId['firewall'].risk, 'high');
});

test('catalog.guardedResolve: safe ssh-hardening runs even without a key (no longer dropped)', () => {
  const noKey = cat.guardedResolve({ hasKey: false, preset: 'secure-baseline', confirm: true });
  assert.ok(noKey.itemIds.includes('ssh-hardening'), 'included even for a password login (it never disables passwords)');
  assert.ok(!noKey.skipped.some(s => s.id === 'ssh-hardening'), 'not skipped anymore');
  const withKey = cat.guardedResolve({ hasKey: true, preset: 'secure-baseline', confirm: true });
  assert.ok(withKey.itemIds.includes('ssh-hardening'));
});

test('catalog.guardedResolve: high-risk items require confirm (409); just-docker does not', () => {
  assert.throws(
    () => cat.guardedResolve({ hasKey: true, preset: 'secure-baseline', confirm: false }),
    (e) => e.statusCode === 409 && Array.isArray(e.risks) && e.risks.some(r => r.id === 'firewall')
  );
  assert.doesNotThrow(() => cat.guardedResolve({ hasKey: true, preset: 'just-docker', confirm: false }));
});

test('catalog: swap + docker-group are OPTIONAL (do not nag as missing); docker itself is required', () => {
  assert.ok(cat.byId.swap.optional, 'swap is optional (OOM net)');
  assert.ok(cat.byId['docker-group'].optional, 'docker-group is optional (sudo-less convenience)');
  assert.ok(!cat.byId.docker.optional, 'docker engine is required');
  assert.ok(!cat.byId.firewall.optional, 'firewall is not optional');
});

test('catalog: System update is alwaysRun (an action, detect is `false` so it never reports "installed")', () => {
  assert.ok(cat.byId.update.alwaysRun, 'update marked alwaysRun');
  assert.equal(cat.byId.update.distro.debian.detect, 'false', 'detect always fails → never skipped, never "present"');
});

test('catalog: ssh-hardening is SAFE — no PasswordAuthentication/PermitRootLogin disable; sets MaxAuthTries', () => {
  for (const fam of ['debian', 'rhel']) {
    const inst = cat.byId['ssh-hardening'].distro[fam].install;
    assert.ok(!/PasswordAuthentication\s+no/i.test(inst), `${fam}: must NOT disable password auth (lockout)`);
    assert.ok(!/PermitRootLogin/i.test(inst), `${fam}: must NOT change root login (lockout)`);
    assert.ok(/MaxAuthTries/i.test(inst), `${fam}: should set MaxAuthTries (safe hardening)`);
    assert.ok(/X11Forwarding\s+no/i.test(inst), `${fam}: should disable X11 forwarding`);
  }
});
