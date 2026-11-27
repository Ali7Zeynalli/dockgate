'use strict';
// Firewall alerts (server/firewall-monitor.js): web ports dropped, isolation rules left behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../../server/firewall-monitor');

const drop = (src, dpt, docker = true) => `Nov 27 10:00:01 h kernel: [${docker ? 'UFW DOCKER BLOCK' : 'UFW BLOCK'}] IN=eth0 OUT=br-x SRC=${src} DST=172.18.0.6 PROTO=TCP SPT=4000 DPT=${dpt} SYN`;
const out = ({ drops = [], du = 0, block = 0, ufw = true } = {}) => ['@@drops', ...drops, '@@du', String(du), '@@block', String(block), '@@ufw', ufw ? 'yes' : ''].join('\n');

test('reading: drops to 80/443 with the addresses seen most, live isolation and the file', () => {
  const r = FM.parse(out({ drops: [drop('104.23.1.1', 443), drop('104.23.1.1', 443), drop('172.68.2.2', 443), drop('8.8.8.8', 80, false)], du: 1, block: 0 }));
  assert.equal(r.drops, 4); assert.equal(r.toContainer, 3);
  assert.deepEqual(r.ports, { 443: 3, 80: 1 });
  assert.deepEqual(r.sources[0], { ip: '104.23.1.1', n: 2 });
  assert.equal(r.liveIso, true); assert.equal(r.blockInFile, false); assert.equal(r.ufw, true);
  assert.equal(FM.parse(out({ ufw: false })).ufw, false);
});

test('alerts: web drops over the threshold every time (the rule limits repeats); leftover once until it is gone', () => {
  const st = {};
  const kraton = FM.parse(out({ drops: [drop('104.23.1.1', 443), drop('172.68.2.2', 443), drop('162.159.3.3', 443)], du: 1, block: 0 }));
  assert.deepEqual(FM.evaluate(kraton, st).map(a => a.type), ['firewall_web_blocked', 'firewall_leftover']);
  assert.deepEqual(FM.evaluate(kraton, st).map(a => a.type), ['firewall_web_blocked'], 'leftover is not repeated');
  assert.deepEqual(FM.evaluate(FM.parse(out({ du: 0 })), st), [], 'fixed');
  assert.equal(st.leftover, false);
  assert.deepEqual(FM.evaluate(FM.parse(out({ drops: [drop('1.2.3.4', 443)] })), {}), [], 'one stray packet is not an outage');
  assert.deepEqual(FM.evaluate(FM.parse(out({ du: 1, block: 1 })), {}), [], 'isolation that is on and in the file is fine');
  const m = FM.message({ type: 'firewall_web_blocked', data: kraton }, 'kraton');
  assert.match(m.text, /3 connections to 443 \(3\).*Docker port isolation.*104\.23\.1\.1/);
  assert.doesNotMatch(m.text + m.body, /[—–→…·]/);
});
