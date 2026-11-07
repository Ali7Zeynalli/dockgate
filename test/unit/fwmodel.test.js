const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-fwmodel-test-'));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const FW = require('../../server/security/fwmodel');
const P = require('../../server/security/parse');

test('fwmodel: ports and rules are validated', () => {
  assert.equal(FW.normPort(''), null);
  assert.equal(FW.normPort('8000:8100'), '8000-8100');
  assert.throws(() => FW.normPort('9000-8000'), /low to high/);
  assert.throws(() => FW.normPort('22;id'), /Port/);
  assert.throws(() => FW.normRule({ dir: 'in', action: 'allow', port: '8000-8100' }), /protocol/);
  assert.throws(() => FW.normRule({ dir: 'in', action: 'limit', proto: 'udp', port: '53' }), /Limit/);
  assert.throws(() => FW.normRule({ dir: 'in', action: 'allow', description: '<script>' }), /Description/);
  assert.equal(FW.ruleKey(FW.normRule({ dir: 'out', action: 'deny', proto: 'tcp', port: 25 })), 'out|deny|tcp|25|h');
});

test('fwmodel: UFW lines → meaning (in, out, route marker, locked entries)', () => {
  const u = P.parseUfwNumbered([
    'Status: active',
    '[ 1] 22/tcp                     ALLOW IN    Anywhere',
    '[ 2] 203.0.113.9 25/tcp         DENY OUT    Anywhere                   (out)',
    '[ 3] 25/tcp                     DENY FWD    Anywhere                   # dockgate:out:any',
    '[ 4] 80                         ALLOW FWD   198.51.100.0/24',
    '[ 5] OpenSSH                    ALLOW IN    Anywhere',
    '[ 6] 22/tcp                     ALLOW IN    10.0.0.1 1234/tcp',
    '[ 7] 2001:db8::/32 443/tcp      DENY OUT    Anywhere (v6)              (out)',
  ].join('\n')).rules.map(FW.ufwSemantic);
  assert.deepEqual([u[0].dir, u[0].remote, u[0].port, u[0].proto], ['in', 'any4', '22', 'tcp']);
  assert.deepEqual([u[1].dir, u[1].remote, u[1].port], ['out', '203.0.113.9', '25']);
  assert.deepEqual([u[2].dir, u[2].route], ['out', true], 'route rule marked by DockGate is outbound');
  assert.deepEqual([u[3].dir, u[3].container, u[3].remote], ['in', 80, '198.51.100.0/24'], 'route rule without marker = container port');
  assert.match(u[4].locked, /app profile/);
  assert.match(u[5].locked, /source port/);
  assert.deepEqual([u[6].dir, u[6].remote, u[6].v6], ['out', '2001:db8::/32', true]);
});

test('fwmodel: change plan merges Any IPv4 + IPv6 into "any", adds before removes, keeps the action on delete', () => {
  const rules = P.parseUfwNumbered('Status: active\n[ 1] 22/tcp                     LIMIT IN    Anywhere\n[ 2] 22/tcp (v6)                LIMIT IN    Anywhere (v6)').rules;
  const { groups } = FW.groupRules({ backend: 'ufw', rules, lists: [], dockgateIp: null });
  const old = groups[0];
  const want = { ...FW.normRule({ dir: 'in', action: 'limit', proto: 'tcp', port: '22' }), remotes: [{ remote: '192.0.2.44', tag: 'dockgate' }] };
  const plan = FW.planChange({ backend: 'ufw', old, want });
  assert.match(plan.cmds[0], /ufw limit proto tcp from 192\.0\.2\.44 to any port 22 comment 'dockgate:dockgate'/);
  assert.match(plan.cmds[1], /ufw delete limit proto tcp from any to any port 22/);
  assert.equal(plan.cmds.length, 2);
});

test('fwmodel: SSH reachability follows ranges, families and the default policy', () => {
  const g = (remotes, port = '22', extra = {}) => ({ dir: 'in', action: 'allow', proto: 'tcp', port, remotes, ...extra });
  assert.ok(FW.sshReachable([g(['any4'])], 22, '192.0.2.44', 'deny'));
  assert.ok(!FW.sshReachable([g(['any6'])], 22, '192.0.2.44', 'deny'), 'IPv6 rule does not help an IPv4 client');
  assert.ok(FW.sshReachable([g(['192.0.2.0/24'])], 22, '192.0.2.44', 'deny'));
  assert.ok(FW.sshReachable([g(['10.0.0.0/8'], '20-30')], 22, '10.1.1.1', 'deny'), 'a range of ports');
  assert.ok(!FW.sshReachable([g(['any4'], '22', { container: 22 })], 22, '192.0.2.44', 'deny'), 'container rules do not count');
  assert.ok(FW.sshReachable([], 22, '192.0.2.44', 'allow'));
});
