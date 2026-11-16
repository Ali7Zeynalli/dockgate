'use strict';
// Server Console → System: what each change writes (hostname, hosts, DNS, sysctl, limits, journald, network, fstab),
// the checks and rollbacks in each plan, input validation, reading the server, and the editor's system-file checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const X = require('../../server/sysconf');
const cmds = (plan) => plan.steps.map(s => s.cmd || '').join('\n');
const decoded = (plan) => [...cmds(plan).matchAll(/echo ([A-Za-z0-9+/=]+) \| base64 -d/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));

test('hostname: hostnamectl and the 127.0.1.1 line agree; bad names are refused', () => {
  const p = X.hostnamePlan('web-1.example.com', '127.0.0.1 localhost\n127.0.1.1 old\n::1 ip6-localhost\n');
  assert.match(decoded(p)[0], /^127\.0\.1\.1\tweb-1\.example\.com web-1$/m);
  assert.match(decoded(p)[0], /^::1 ip6-localhost$/m);
  assert.match(cmds(p), /hostnamectl set-hostname 'web-1\.example\.com'/);
  assert.match(cmds(p), /restored/);
  assert.throws(() => X.hostnamePlan('bad name;rm -rf /', ''), /Hostname/);
  assert.throws(() => X.hostnamePlan('-web', ''), /Hostname/);
});

test('/etc/hosts: rows written, localhost kept, comments cleaned, bad input refused', () => {
  const r = X.hostsPlan([{ ip: '10.0.0.5', names: 'db db.internal', comment: 'data#base' }, { ip: '127.0.0.1', names: 'evil' }], '127.0.0.1 localhost\n# my note\n10.0.0.9 old\n\n');
  assert.equal(r.text, '127.0.0.1 localhost\n# my note\n10.0.0.5\tdb db.internal\t# data base\n');
  assert.throws(() => X.hostsPlan([{ ip: '10.0.0.300', names: 'x' }], ''), /not an IP/);
  assert.throws(() => X.hostsPlan([{ ip: '10.0.0.1', names: 'a b$(id)' }], ''), /names/);
  assert.match(cmds(r.plan), /getent hosts localhost/);
});

test('DNS: resolved drop-in or resolv.conf, tested with a lookup and restored when names stop resolving', () => {
  const a = X.dnsPlan({ servers: '1.1.1.1 9.9.9.9', domains: 'internal.example.com', resolved: true });
  assert.equal(a.file, '/etc/systemd/resolved.conf.d/99-dockgate.conf');
  assert.match(a.text, /^DNS=1\.1\.1\.1 9\.9\.9\.9$/m); assert.match(a.text, /^Domains=internal\.example\.com$/m);
  assert.match(cmds(a.plan), /getent ahosts 'cloudflare\.com'.*restored/s);
  const b = X.dnsPlan({ servers: ['8.8.8.8'], resolved: false, resolvLink: '/etc/resolv.conf' });
  assert.equal(b.text, '# Managed by DockGate (Server Console → System → DNS)\nnameserver 8.8.8.8\n');
  assert.throws(() => X.dnsPlan({ servers: '8.8.8.8', resolved: false, resolvLink: '/run/NetworkManager/resolv.conf' }), /managed by another program/);
  assert.throws(() => X.dnsPlan({ servers: 'dns.google', resolved: true }), /not an IP/);
  assert.throws(() => X.dnsPlan({ servers: '', resolved: true }), /at least one/);
});

test('kernel, open files, journald: only offered keys and sane values; the kernel checks before it is kept', () => {
  const s = X.sysctlPlan({ 'vm.swappiness': '10', 'net.ipv4.ip_local_port_range': '1024 65535', 'vm.max_map_count': '' });
  assert.match(s.text, /^vm\.swappiness = 10$/m); assert.match(s.text, /^net\.ipv4\.ip_local_port_range = 1024 65535$/m); assert.ok(!/max_map_count/.test(s.text));
  assert.match(cmds(s.plan), /sysctl -p \/etc\/sysctl\.d\/99-dockgate\.conf.*restored/s);
  assert.throws(() => X.sysctlPlan({ 'kernel.core_pattern': '|/tmp/x' }), /not offered/);
  assert.throws(() => X.sysctlPlan({ 'vm.swappiness': '10; reboot' }), /a number/);
  assert.throws(() => X.sysctlPlan({ 'net.ipv4.ip_forward': '5' }), /one of 0, 1/);
  assert.match(decoded(X.nofilePlan(65536)).join('\n'), /\* +soft nofile 65536[\s\S]*DefaultLimitNOFILE=65536/);
  assert.throws(() => X.nofilePlan(10), /1024/);
  assert.match(decoded(X.journaldPlan('500m'))[0], /SystemMaxUse=500M/);
  assert.throws(() => X.journaldPlan('lots'), /Journal size/);
});

test('network: netplan / NetworkManager, rollback armed before apply, NEW login tested, DockGate\'s address protected', () => {
  const r = X.networkPlan({ iface: 'eth0', stack: 'netplan', dhcp: false, addresses: ['203.0.113.10/24'], gateway: '203.0.113.1', dns: ['1.1.1.1'], mtu: 1500, sshIp: '203.0.113.10' }, { id: 'ab12', test: { username: 'deploy' } });
  assert.match(r.text, /eth0:\n {6}dhcp4: false\n {6}addresses:\n {8}- 203\.0\.113\.10\/24\n {6}routes:\n {8}- to: default\n {10}via: 203\.0\.113\.1/);
  const labels = r.plan.steps.map(s => s.label);
  assert.ok(labels.indexOf('Arm automatic rollback (120 s)') < labels.indexOf('Apply'));
  assert.ok(labels.findIndex(l => /NEW SSH/.test(l)) > labels.indexOf('Apply'));
  assert.equal(labels[labels.length - 1], 'Keep the change and cancel the rollback');
  assert.ok(r.plan.steps.find(s => s.test).rollbackOnFail);
  assert.match(cmds(r.plan), /netplan generate/);
  assert.ok(r.plan.rollback);
  assert.throws(() => X.networkPlan({ iface: 'eth0', stack: 'netplan', addresses: ['10.0.0.2/24'], sshIp: '203.0.113.10' }, { id: 'x', test: {} }), /DockGate connects to 203\.0\.113\.10/);
  const moved = X.networkPlan({ iface: 'eth0', stack: 'netplan', addresses: ['10.0.0.2/24'], sshIp: '203.0.113.10', newSshIp: '10.0.0.2' }, { id: 'x', test: { host: '10.0.0.2' } });
  assert.match(moved.plan.steps.find(s => s.test).label, /to 10\.0\.0\.2/);
  // another interface than DockGate's: no address rule
  assert.ok(X.networkPlan({ iface: 'eth1', stack: 'netplan', addresses: ['10.0.0.8/24'], sshIp: null }, { id: 'q', test: {} }).text.includes('10.0.0.8/24'));
  const nm = X.networkPlan({ iface: 'ens3', stack: 'nm', dhcp: true, sshIp: '1.2.3.4' }, { id: 'y', test: {} });
  assert.match(cmds(nm.plan), /nmcli connection modify "\$C" ipv4\.method auto/);
  assert.throws(() => X.networkPlan({ iface: 'eth0;id', stack: 'netplan', dhcp: true }, { id: 'z', test: {} }), /Interface/);
  assert.throws(() => X.networkPlan({ iface: 'eth0', stack: 'netplan', addresses: ['10.0.0.2'] }, { id: 'z', test: {} }), /prefix/);
  assert.throws(() => X.networkPlan({ iface: 'eth0', stack: 'ifupdown', dhcp: true }, { id: 'z', test: {} }), /netplan or NetworkManager/);
});

test('fstab: add (checked with findmnt, mounted once) and remove; root is protected; changed file refused', () => {
  const cur = 'UUID=aaaa-bbbb / ext4 errors=remount-ro 0 1\n/swap.img none swap sw 0 0\n';
  const a = X.fstabPlan({ action: 'add', entry: { source: 'UUID=1234-abcd', target: '/mnt/data', fstype: 'ext4', options: 'defaults,nofail' } }, cur);
  assert.match(a.text, /^UUID=1234-abcd\t\/mnt\/data\text4\tdefaults,nofail\t0\t2$/m);
  assert.match(cmds(a.plan), /findmnt --verify --tab-file \/etc\/fstab/);
  const L = a.plan.steps.map(s => s.label); assert.ok(L.indexOf('Create /mnt/data') < L.findIndex(l => /findmnt/.test(l)), 'mount point exists before the check'); assert.match(cmds(a.plan), /mount '\/mnt\/data'.*restored/s);
  assert.throws(() => X.fstabPlan({ action: 'remove', index: 0, raw: 'UUID=aaaa-bbbb / ext4 errors=remount-ro 0 1' }, cur), /needed to start/);
  assert.throws(() => X.fstabPlan({ action: 'remove', index: 1, raw: 'something else' }, cur), /changed/);
  assert.equal(X.fstabPlan({ action: 'remove', index: 1, raw: '/swap.img none swap sw 0 0' }, cur).text, 'UUID=aaaa-bbbb / ext4 errors=remount-ro 0 1\n');
  assert.throws(() => X.fstabPlan({ action: 'add', entry: { source: 'UUID=1234-abcd', target: '/', fstype: 'ext4' } }, cur), /not \//);
  assert.throws(() => X.fstabPlan({ action: 'add', entry: { source: '$(id)', target: '/mnt/x', fstype: 'ext4' } }, cur), /Source/);
});

test('reading the server: hostname, DNS, kernel, interfaces with the SSH address, fstab', () => {
  const out = ['@@uid', '1000', '@@hostname', 'web-1', 'web-1', '@@hosts', '127.0.0.1 localhost', '10.0.0.5 db', '@@resolved', 'active', '@@resolvedDrop', '[Resolve]', 'DNS=1.1.1.1', '@@resolvectl', '', '@@resolv', 'nameserver 127.0.0.53', '@@resolvLink', '/run/systemd/resolve/stub-resolv.conf',
    '@@sysctlDrop', 'vm.swappiness = 10', '@@sysctl', 'net.ipv4.ip_forward=1', 'vm.swappiness=10', '@@nofile', '1024', '1048576', '@@limitsDrop', '', '@@journal', 'Archived and active journals take up 1.2G in the file system.', '@@journalDrop', '',
    '@@netstack', 'netplan', '@@ipaddr', JSON.stringify([{ ifname: 'lo', addr_info: [] }, { ifname: 'eth0', operstate: 'UP', mtu: 1500, address: 'aa:bb', addr_info: [{ family: 'inet', local: '203.0.113.10', prefixlen: 24, dynamic: true }] }, { ifname: 'docker0', operstate: 'DOWN', mtu: 1500, addr_info: [] }]),
    '@@iproute', JSON.stringify([{ dst: 'default', gateway: '203.0.113.1', dev: 'eth0' }]), '@@sshconn', '198.51.100.7 51000 203.0.113.10 22', '@@netplanFiles', '__FILE__/etc/netplan/50-cloud-init.yaml', 'network: {}',
    '@@fstab', 'UUID=a / ext4 defaults 0 1', '@@mounts', '/ /dev/sda1 ext4 rw', '@@df', '/dev/sda1 ext4 40G 12G 26G 32% /', '@@blk', '{"blockdevices":[]}', '@@os', 'Ubuntu 24.04 LTS'].join('\n');
  const d = X.parseRead(out);
  assert.equal(d.hostname, 'web-1'); assert.equal(d.os, 'Ubuntu 24.04 LTS');
  assert.equal(d.dns.resolved, true); assert.equal(d.dns.drop.DNS, '1.1.1.1');
  assert.equal(d.sysctl.find(s => s.key === 'vm.swappiness').dockgate, '10');
  assert.equal(d.nofile.soft, '1024');
  assert.deepEqual(d.net.stack, ['netplan']); assert.equal(d.net.sshServerIp, '203.0.113.10');
  assert.equal(d.net.interfaces.find(i => i.name === 'eth0').v4[0].dynamic, true);
  assert.equal(d.net.interfaces.find(i => i.name === 'docker0').docker, true);
  assert.equal(d.net.defaultRoute.gateway, '203.0.113.1');
  assert.equal(d.net.netplanFiles[0].path, '/etc/netplan/50-cloud-init.yaml');
  assert.equal(d.fstab.find(l => l.kind === 'entry').target, '/');
  assert.equal(d.df[0].pct, '32%');
});

// The editor's checks of system files run on the server; here with bash (findmnt / visudo when present).
const runSh = (cmd) => new Promise((res) => execFile('bash', ['-c', cmd], { timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code || 1) : 0, stdout: String(so), stderr: String(se) })));
test('editor: /etc/fstab checked with findmnt before saving', async () => {
  const rcPath = require.resolve('../../server/remote-compose');
  const real = require(rcPath);
  require.cache[rcPath].exports = { ...real, execRemote: async (_s, cmd) => runSh(cmd) };
  delete require.cache[require.resolve('../../server/file-extras')];
  const fx = require('../../server/file-extras');
  const A = { id: 's1', s: { id: 's1' } };
  try {
    const hasFindmnt = (await runSh('command -v findmnt')).code === 0;
    if (!hasFindmnt) return;
    const good = await fx.checkFile(A, 'fstab', 'tmpfs /tmp tmpfs defaults,nofail 0 0\n');
    assert.equal(good.ok, true, good.output);
    const bad = await fx.checkFile(A, 'fstab', 'UUID=0000-not-there /mnt/x ext4 defaults 0 2\n/dev/nope\n');
    assert.equal(bad.ok, false, bad.output);
    assert.ok(!/\.dg-check-/.test(bad.output));
    assert.deepEqual(fs.readdirSync('/tmp').filter(n => /^\.dg-check-[0-9a-f]+$/.test(n)), [], 'temporary file removed, also when the check fails');
  } finally { require.cache[rcPath].exports = real; delete require.cache[require.resolve('../../server/file-extras')]; }
});

// findmnt versions answer differently (CI runners and servers have older or newer ones): every form must count.
test('fstab check: errors from old and new findmnt versions are caught; a clean summary passes', async () => {
  const cases = [
    ['Entry /tmp\n0 parse errors, 0 errors, 1 warning', 0, 0],
    ['findmnt: f: parse error at line 2 -- ignored', 1, 0],          // older findmnt: parse error only
    ['   [E] unreachable source\n0 parse errors, 1 error, 0 warnings', 1, 0],
    ['1 parse error, 0 errors, 0 warnings', 1, 0],
    ['all fine', 1, 1],                                               // a non-zero exit counts too
  ];
  for (const [out, want, rc] of cases) {
    const f = path.join(os.tmpdir(), `dg-fm-${process.pid}.txt`);
    fs.writeFileSync(f, out + '\n');
    const cmd = X.fstabVerify('/x').replace(/^out=\$\(findmnt --verify --tab-file \/x 2>&1\); rc=\$\?/, `out=$(cat ${f}); (exit ${rc}); rc=$?`);
    const r = await runSh(`${cmd}; echo "bad=$bad"`);
    fs.unlinkSync(f);
    assert.match(r.stdout, new RegExp(`bad=${want}`), `${JSON.stringify(out)} → ${r.stdout}`);
  }
});
