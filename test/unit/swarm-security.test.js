'use strict';
// Protection before and after a move to Swarm (server/swarm-security.js) — pure parts, no Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const SEC = require('../../server/swarm-security');

const hardened = { user: '1000', read_only: true, cap_drop: ['ALL'], cap_add: ['NET_BIND_SERVICE'], security_opt: ['no-new-privileges:true'],
  volumes: [{ type: 'bind', source: '/srv/conf', target: '/etc/app', read_only: true }], ports: [{ published: '8080', target: 80, host_ip: '10.0.0.5', protocol: 'tcp' }] };

test('a compose service and its stack form: what the stack file drops shows as weaker', () => {
  const stack = { ...hardened, security_opt: undefined, ports: [{ published: 8080, target: 80, protocol: 'tcp', mode: 'host' }] };
  const rows = SEC.compareProfiles(SEC.profileOfService(hardened), SEC.profileOfService(stack, { onSwarm: true }));
  const weak = SEC.weakerRows(rows).map(r => r.field).sort();
  assert.deepEqual(weak, ['no-new-privileges', 'published ports']);
  assert.match(rows.find(r => r.field === 'published ports').why, /10\.0\.0\.5 → 0\.0\.0\.0/);
  assert.equal(rows.find(r => r.field === 'user').verdict, 'same');
});
test('DockGate keeps no-new-privileges and seccomp on the Swarm service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sec-'));
  fs.writeFileSync(path.join(dir, 'prof.json'), '{"defaultAction":"SCMP_ACT_ERRNO"}');
  const s = { security_opt: ['no-new-privileges:true', 'seccomp=prof.json', 'apparmor=my-profile'] };
  const k = await SEC.privilegesFor(s, { cwd: dir });
  assert.equal(k.privileges.NoNewPrivileges, true);
  assert.equal(k.privileges.Seccomp.Mode, 'custom'); assert.match(k.privileges.Seccomp.Profile, /SCMP_ACT_ERRNO/);
  assert.match(k.lost.join(), /AppArmor profile my-profile/);
  const rows = SEC.compareProfiles(SEC.profileOfService(s), SEC.predictOnSwarm({}, k));
  assert.deepEqual(SEC.weakerRows(rows).map(r => r.field), ['AppArmor'], 'only the custom AppArmor profile is lost');
});
test('ingress: 0.0.0.0 → every server is a change; one address → every server is weaker', () => {
  const a = SEC.profileOfService({ ports: [{ published: '80', target: 80, mode: 'ingress' }] }); // compose config writes mode: ingress too
  assert.equal(a.ports[0].ip, '0.0.0.0');
  const b = SEC.profileOfService({ ports: [{ published: 80, target: 80, mode: 'ingress' }] }, { onSwarm: true });
  const r = SEC.compareProfiles(a, b).find(x => x.field === 'published ports');
  assert.equal(r.verdict, 'changed'); assert.match(r.why, /every server of the cluster/);
  const one = SEC.profileOfService({ ports: [{ published: '80', target: 80, host_ip: '10.0.0.5' }] });
  assert.equal(SEC.compareProfiles(one, b).find(x => x.field === 'published ports').verdict, 'weaker');
});
test('more isolated is "changed", not weaker; lost cap_drop, rw mounts, root user and new caps are weaker', () => {
  const rows = SEC.compareProfiles(SEC.profileOfService({ pid: 'host', user: 'app', cap_drop: ['ALL'], volumes: [{ type: 'volume', target: '/d', read_only: true }] }),
    SEC.profileOfService({ cap_add: ['SYS_ADMIN'], volumes: [{ type: 'volume', target: '/d' }] }));
  const v = Object.fromEntries(rows.map(r => [r.field, r.verdict]));
  assert.equal(v['host PID namespace'], 'changed');
  assert.equal(v.user, 'weaker'); assert.equal(v['dropped capabilities'], 'weaker'); assert.equal(v['added capabilities'], 'weaker'); assert.equal(v.mounts, 'weaker');
});
test('a running container reads the same as its compose service', () => {
  const ct = { Config: { User: '1000' }, AppArmorProfile: 'docker-default',
    HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['NET_BIND_SERVICE'], SecurityOpt: ['no-new-privileges:true'], PortBindings: { '80/tcp': [{ HostIp: '10.0.0.5', HostPort: '8080' }] } },
    Mounts: [{ Type: 'bind', Destination: '/etc/app', RW: false }] };
  const rows = SEC.compareProfiles(SEC.profileOfService(hardened), SEC.profileOfContainer(ct));
  assert.deepEqual(rows.filter(r => r.verdict !== 'same'), []);
});
