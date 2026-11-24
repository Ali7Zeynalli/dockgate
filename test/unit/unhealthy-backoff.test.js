'use strict';
// A container that stays unhealthy: DockGate tells at once, then after 1 h, 6 h, then once a day (kept in the
// database, so a restart of DockGate does not start the alerts over), and says why when it is its own Edge agent
// that lost Docker's socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const EM = require('../../server/notifications/event-monitor');
const telegram = require('../../server/notifications/telegram');
const { stmts } = require('../../server/db');

test('unhealthy sweep: thinned out alerts, a hint for the agent, a restart of DockGate keeps the pace', async (t) => {
  const EventMonitor = EM.EventMonitor || EM;
  const origCfg = telegram.isConfigured; telegram.isConfigured = () => true;
  t.after(() => { telegram.isConfigured = origCfg; });
  try { stmts.upsertRule && stmts.upsertRule.run; } catch (e) { /* not needed */ }
  const rule = stmts.getRule.get('container_unhealthy'); assert.ok(rule && rule.enabled, 'the rule exists and is on by default');
  let list = [{ Id: 'abc123456789', Names: ['/dockgate-agent'], Image: 'ghcr.io/x/dockgate-agent:1' }];
  const docker = { listContainers: async () => list, getContainer: () => ({ inspect: async () => ({ State: { Health: { FailingStreak: 20307, Log: [] } } }) }) };
  const mk = () => { const m = new EventMonitor('test-ub', docker); m.isNotificationEnabled = () => true; m._tailLogs = async () => '[agent:x] failed to connect: connect ECONNREFUSED /var/run/docker.sock'; m.sent = []; m._sendNotification = async (type, name, p) => { m.sent.push(p); }; return m; };
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const m = mk();
  await m._checkUnhealthy(); assert.equal(m.sent.length, 1, 'told at once');
  assert.match(m.sent[0].telegramText, /restart/i); assert.match(m.sent[0].telegramText, /socket/i);
  now += 30 * 60e3; await m._checkUnhealthy(); assert.equal(m.sent.length, 1, 'not again after 30 min');
  const m2 = mk(); // DockGate restarted
  now += 31 * 60e3; await m2._checkUnhealthy(); assert.equal(m2.sent.length, 1, 'after 1 h — even after a restart');
  assert.match(m2.sent[0].telegramText, /#2/);
  now += 5 * 3600e3; await m2._checkUnhealthy(); assert.equal(m2.sent.length, 1, 'the next one waits 6 h');
  now += 3600e3; await m2._checkUnhealthy(); assert.equal(m2.sent.length, 2);
  list = []; now += 60e3; await m2._checkUnhealthy(); // healthy again
  list = [{ Id: 'abc123456789', Names: ['/dockgate-agent'], Image: 'x' }]; now += 60e3; await m2._checkUnhealthy();
  assert.equal(m2.sent.length, 3, 'a new problem is told at once');
  assert.doesNotMatch(m2.sent[2].telegramText, /#\d/);
});
