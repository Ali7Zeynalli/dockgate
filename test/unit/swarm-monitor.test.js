'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swmon-test-'));
const M = require('../../server/swarm-monitor');

const node = (id, host, st, role = 'worker', reach = 'reachable') => ({ ID: id, Description: { Hostname: host }, Status: { State: st, Addr: '10.0.0.' + id.length }, Spec: { Role: role }, ...(role === 'manager' ? { ManagerStatus: { Reachability: reach } } : {}) });
const svc = (id, name, run, want, us) => ({ ID: id, Spec: { Name: name, Mode: { Replicated: { Replicas: want } } }, ServiceStatus: { RunningTasks: run, DesiredTasks: want }, ...(us ? { UpdateStatus: us } : {}) });
const types = (a) => a.map(x => `${x.type}:${x.subject}`);

test('the first look only records; a node going down and coming back alerts once each', () => {
  M._state.clear();
  const t = 1e12;
  assert.deepEqual(M.evaluate('c1', { nodes: [node('m1', 'vps1', 'ready', 'manager'), node('w1', 'vps2', 'down')], services: [svc('s1', 'web', 1, 3)] }, 'prod', { now: t }), [], 'nothing on the first look (DockGate restarted)');
  M._state.clear();
  M.evaluate('c1', { nodes: [node('m1', 'vps1', 'ready', 'manager'), node('w1', 'vps2', 'ready')], services: [] }, 'prod', { now: t });
  let a = M.evaluate('c1', { nodes: [node('m1', 'vps1', 'ready', 'manager'), node('w1', 'vps2', 'down')], services: [] }, 'prod', { now: t + 30000 });
  assert.deepEqual(types(a), ['swarm_node_down:prod: server vps2 is down']);
  assert.deepEqual(M.evaluate('c1', { nodes: [node('m1', 'vps1', 'ready', 'manager'), node('w1', 'vps2', 'down')], services: [] }, 'prod', { now: t + 60000 }), [], 'not again');
  a = M.evaluate('c1', { nodes: [node('m1', 'vps1', 'ready', 'manager'), node('w1', 'vps2', 'ready')], services: [] }, 'prod', { now: t + 600000 });
  assert.deepEqual(types(a), ['swarm_node_down:prod: server vps2 is back']);
  assert.match(a[0].text, /Rebalance/);
});

test('a service short of replicas alerts after the rule minutes, and when it is back', () => {
  M._state.clear();
  const t = 1e12, nodes = [node('m1', 'vps1', 'ready', 'manager')];
  M.evaluate('c2', { nodes, services: [svc('s1', 'web', 3, 3)] }, 'prod', { now: t, minutes: 2 });
  assert.deepEqual(M.evaluate('c2', { nodes, services: [svc('s1', 'web', 1, 3)], reasons: { s1: 'no suitable node' } }, 'prod', { now: t + 30000, minutes: 2 }), []);
  let a = M.evaluate('c2', { nodes, services: [svc('s1', 'web', 1, 3)], reasons: { s1: 'no suitable node' } }, 'prod', { now: t + 30000 + 120000, minutes: 2 });
  assert.deepEqual(types(a), ['swarm_service_down:prod: web runs 1/3']);
  assert.match(a[0].text, /no suitable node/);
  assert.deepEqual(M.evaluate('c2', { nodes, services: [svc('s1', 'web', 1, 3)] }, 'prod', { now: t + 300000, minutes: 2 }), []);
  a = M.evaluate('c2', { nodes, services: [svc('s1', 'web', 3, 3)] }, 'prod', { now: t + 400000, minutes: 2 });
  assert.deepEqual(types(a), ['swarm_service_down:prod: web is back to 3/3']);
  // a short dip under the limit sends nothing
  M.evaluate('c2', { nodes, services: [svc('s1', 'web', 2, 3)] }, 'prod', { now: t + 500000, minutes: 2 });
  assert.deepEqual(M.evaluate('c2', { nodes, services: [svc('s1', 'web', 3, 3)] }, 'prod', { now: t + 530000, minutes: 2 }), []);
});

test('a rolled back update alerts once per update; lost manager majority alerts', () => {
  M._state.clear();
  const t = 1e12;
  const nodes3 = (r) => [node('a', 'm1', 'ready', 'manager'), node('bb', 'm2', r ? 'ready' : 'down', 'manager', r ? 'reachable' : 'unreachable'), node('ccc', 'm3', r ? 'ready' : 'down', 'manager', r ? 'reachable' : 'unreachable')];
  M.evaluate('c3', { nodes: nodes3(true), services: [svc('s1', 'api', 2, 2)] }, 'prod', { now: t });
  const rb = { State: 'rollback_completed', Message: 'rollback completed', CompletedAt: '2026-11-11T10:00:00Z' };
  let a = M.evaluate('c3', { nodes: nodes3(true), services: [svc('s1', 'api', 2, 2, rb)] }, 'prod', { now: t + 30000 });
  assert.deepEqual(types(a), ['swarm_update_rollback:prod: api: update rolled back']);
  assert.deepEqual(M.evaluate('c3', { nodes: nodes3(true), services: [svc('s1', 'api', 2, 2, rb)] }, 'prod', { now: t + 60000 }), []);
  a = M.evaluate('c3', { nodes: nodes3(false), services: [svc('s1', 'api', 2, 2, rb)] }, 'prod', { now: t + 90000 });
  assert.ok(types(a).includes('swarm_quorum:prod: Swarm managers lost their majority'));
  a = M.evaluate('c3', { nodes: nodes3(true), services: [svc('s1', 'api', 2, 2, rb)] }, 'prod', { now: t + 120000 });
  assert.ok(types(a).includes('swarm_quorum:prod: Swarm managers are back'));
});

test('alerts that fail to send are queued and retried', async () => {
  const HM = require('../../server/notifications/health-monitor');
  const telegram = require('../../server/notifications/telegram');
  const realC = telegram.isConfigured, realS = telegram.sendMessage;
  let calls = 0;
  telegram.isConfigured = () => true;
  telegram.sendMessage = async () => { calls++; return calls >= 2 ? { success: true } : { success: false }; };
  try {
    const ok = await HM.deliver('swarm_node_down', { id: 'local' }, 'prod: server vps2 is down', '🔴 prod: vps2 is down', '<p>x</p>', { always: true, retry: true });
    assert.equal(ok, false);
    assert.equal(HM._retryQueue.length, 1);
    await HM._flushRetries();
    assert.equal(calls, 2);
    assert.equal(HM._retryQueue.length, 0, 'sent on the retry');
  } finally { telegram.isConfigured = realC; telegram.sendMessage = realS; }
});
