'use strict';
// Live firewall (server/firewall-live.js): parsing iptables-save, where each rule comes from, "will this connection
// pass?" through Docker's NAT, and the differences between the files and the live firewall. The fixture is the case
// where isolation rules stayed in DOCKER-USER after isolation was turned off and Cloudflare could not reach port 443.
const test = require('node:test');
const assert = require('node:assert/strict');
const FL = require('../../server/firewall-live');

const FILTER = (isolation) => `*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER - [0:0]
:DOCKER-USER - [0:0]
:ufw-user-input - [0:0]
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -j ufw-user-input
-A FORWARD -j DOCKER-USER
-A FORWARD -o br-web -j DOCKER
-A DOCKER -d 172.24.0.2/32 ! -i br-web -o br-web -p tcp -m tcp --dport 80 -j ACCEPT
-A DOCKER-USER -m set --match-set f2b-dockgate-honeypot src -j DROP
${isolation ? `-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -p udp -m udp --sport 53 --dport 1024:65535 -j RETURN
-A DOCKER-USER -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -j ufw-docker-logging-deny
-A DOCKER-USER -j RETURN
-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP
` : ''}-A ufw-user-input -p tcp -m tcp --dport 22 -j ACCEPT
COMMIT`;

const NAT = `*nat
:PREROUTING ACCEPT [0:0]
:DOCKER - [0:0]
-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-A DOCKER ! -i br-web -p tcp -m tcp --dport 443 -j DNAT --to-destination 172.24.0.2:80
COMMIT`;

const read = ({ isolation = true, block = false, routes = '', drops = '' } = {}) => [
  '@@iptv', 'iptables v1.8.10 (nf_tables)', '@@backend', '',
  '@@filter4', FILTER(isolation), '@@nat4', NAT, '@@filter6', '',
  '@@ipset', 'create f2b-dockgate-honeypot hash:ip\nadd f2b-dockgate-honeypot 192.0.2.66',
  '@@ufwstatus', 'Status: active', '@@userrules', routes, '@@afterblock', block ? '1' : '0', '@@afterkeep', '',
  '@@ports', 'caddy|0.0.0.0:443->80/tcp, [::]:443->80/tcp', '@@ifaces', 'lo 127.0.0.1/8\neth0 203.0.113.10/24\ndocker0 172.17.0.1/16',
  '@@drops', drops,
].join('\n');

const DROP_LINE = (src, dpt) => `Nov 27 10:00:01 kraton kernel: [UFW DOCKER BLOCK] IN=eth0 OUT=br-web MAC=x SRC=${src} DST=172.24.0.2 LEN=60 PROTO=TCP SPT=41000 DPT=${dpt} WINDOW=64240 SYN`;

test('reading: chains, NAT to the container, the server address, port owners, sets', () => {
  const st = FL.parseState(read());
  assert.equal(st.extIface, 'eth0'); assert.equal(st.hostIp, '203.0.113.10');
  assert.deepEqual(st.dnat, [{ hostPort: 443, proto: 'tcp', ip: '172.24.0.2', port: 80, bridge: 'br-web' }]);
  assert.equal(st.portOwner['443/tcp'], 'caddy');
  assert.ok(st.sets['f2b-dockgate-honeypot'].has('192.0.2.66'));
  assert.equal(st.filter4.chains.INPUT.policy, 'DROP');
  assert.equal(st.filter4.chains.DOCKER.policy, null);
  const log = st.filter4.chains['ufw-docker-logging-deny'].rules[0];
  assert.equal(log.target, 'LOG', 'a quoted log prefix stays one word');
});

test('where a rule comes from', () => {
  const st = FL.parseState(read());
  const du = st.filter4.chains['DOCKER-USER'].rules.map(r => FL.sourceOf(r));
  assert.equal(du[0].label, 'fail2ban: dockgate-honeypot');
  assert.ok(du.slice(1).every(s => s.kind === 'dockgate'), 'every isolation rule is DockGate\'s');
  assert.equal(FL.sourceOf(st.filter4.chains['ufw-user-input'].rules[0]).label, 'UFW rule (yours)');
  assert.equal(FL.sourceOf(st.filter4.chains.DOCKER.rules[0]).kind, 'docker');
  assert.equal(FL.sourceOf(FL.parseRule('-A DOCKER-USER -s 198.51.100.0/24 -j DROP')).kind, 'unknown');
  assert.equal(FL.sourceOf(FL.parseRule('-A DOCKER-USER -p tcp -m tcp --dport 443 -m comment --comment dockgate-keep -j RETURN')).label, 'DockGate: port kept public');
});

test('left behind isolation: Cloudflare to 443 is blocked by it, and the page says why and what to do', () => {
  const st = FL.parseState(read({ drops: [DROP_LINE('172.68.234.207', 80), DROP_LINE('172.68.234.207', 80), DROP_LINE('162.158.1.1', 80)].join('\n') }));
  const r = FL.simulate(st, { src: '172.68.234.207', port: 443 });
  assert.equal(r.verdict, 'blocked');
  assert.match(r.path, /container \(172\.24\.0\.2:80, caddy\).*FORWARD/);
  assert.equal(r.rule.chain, 'ufw-docker-logging-deny');
  assert.equal(r.rule.source.label, 'DockGate: Docker port isolation');
  assert.ok(r.trace.some(t => /logged/.test(t.note)), 'the LOG rule is passed by');
  const ids = FL.problems(st).map(p => p.id);
  assert.deepEqual(ids, ['leftover-isolation', 'web-drops'], 'the drop log shows the container port (80) after NAT');
  assert.equal(FL.problems(st)[0].fix, 'remove-leftover');
  assert.equal(st.drops[0].count, 3); assert.equal(st.drops[0].sources[0].src, '172.68.234.207');
  // a private address is let through by the isolation's RETURN, then Docker accepts it
  assert.equal(FL.simulate(st, { src: '10.0.0.5', port: 443 }).verdict, 'pass');
  // a honeypot ban drops before anything else
  const ban = FL.simulate(st, { src: '192.0.2.66', port: 443 });
  assert.equal(ban.verdict, 'blocked'); assert.equal(ban.rule.source.kind, 'fail2ban');
});

test('after removal: 443 passes by Docker\'s rule, the host follows INPUT, and nothing is left to fix', () => {
  const st = FL.parseState(read({ isolation: false }));
  const r = FL.simulate(st, { src: '172.68.234.207', port: 443 });
  assert.equal(r.verdict, 'pass'); assert.equal(r.rule.source.kind, 'docker');
  assert.deepEqual(FL.problems(st), []);
  assert.equal(FL.simulate(st, { src: '8.8.8.8', port: 22 }).verdict, 'pass');
  const closed = FL.simulate(st, { src: '8.8.8.8', port: 3306 });
  assert.equal(closed.verdict, 'blocked'); assert.match(closed.rule.text, /policy DROP/);
  assert.equal(FL.simulate(st, { src: '2001:db8::1', port: 22 }).verdict, 'unknown', 'no IPv6 rules read');
  assert.throws(() => FL.simulate(st, { src: 'x', port: 22 }), /IP address/);
  assert.throws(() => FL.simulate(st, { src: '8.8.8.8', port: 0 }), /1-65535/);
});

test('differences: block in the file but not live, a route rule not live, web drops', () => {
  const st = FL.parseState(read({ isolation: false, block: true, routes: '### tuple ### route:allow tcp 8080 0.0.0.0/0 any 0.0.0.0/0 in', drops: DROP_LINE('198.51.100.4', 443) }));
  const ids = FL.problems(st).map(p => p.id);
  assert.deepEqual(ids, ['isolation-not-live', 'route-8080', 'web-drops']);
  const v = FL.view(st);
  assert.equal(v.ports[0].owner, 'caddy');
  assert.ok(v.tables[0].chains.some(c => c.name === 'DOCKER-USER'));
  assert.equal(v.sets['f2b-dockgate-honeypot'], 1);
});
