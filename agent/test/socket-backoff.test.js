'use strict';
// Docker restarted under a running agent (its socket mount went dead): the agent exits after 2 minutes so Docker
// starts it again with a fresh mount. And a container that stays unhealthy is told at once, then after 1 h, 6 h,
// then once a day — not every cooldown.
const test = require('node:test');
const assert = require('node:assert/strict');
const { backoff, STEPS_MS } = require('../src/backoff');

test('the agent exits after Docker\'s socket has refused it for 2 minutes, not before', () => {
  const { Monitor } = (() => { const m = require('../src/monitor'); return { Monitor: m.Monitor || m }; })();
  const mon = typeof Monitor === 'function' ? new Monitor() : Monitor;
  const exits = []; mon.exit = (c) => exits.push(c);
  const refused = Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' });
  const t0 = 1_000_000;
  assert.equal(mon._socketGone(refused, t0), false);
  assert.equal(mon._socketGone(refused, t0 + 119_000), false);
  assert.deepEqual(exits, []);
  assert.equal(mon._socketGone(refused, t0 + 120_000), true);
  assert.deepEqual(exits, [1]);
  mon.stopped = false; mon.failSince = null; exits.length = 0;
  assert.equal(mon._socketGone(new Error('some other error'), t0), false, 'only socket errors count');
  assert.equal(mon.failSince, null);
});

test('backoff: at once, then 1 h, 6 h, 24 h; a healthy container starts over', () => {
  const b = backoff(new Map());
  const H = 3600e3; let t = 0;
  const due = (at) => b.check('web', at).due;
  assert.equal(due(t), true); b.sent('web', t);
  assert.equal(due(t + 59 * 60e3), false); assert.equal(due(t + H), true); b.sent('web', t += H);
  assert.equal(due(t + 5 * H), false); assert.equal(due(t + 6 * H), true); b.sent('web', t += 6 * H);
  assert.equal(due(t + 23 * H), false); assert.equal(due(t + 24 * H), true); b.sent('web', t += 24 * H);
  assert.equal(due(t + 24 * H), true, 'then once a day');
  assert.equal(b.check('web', t).n, 5);
  b.keepOnly([]); // healthy again
  assert.equal(b.check('web', t + 1).n, 1); assert.equal(due(t + 1), true);
  assert.equal(b.check('db', 0, 2 * H).due, true, 'a first alert is never held back');
  b.sent('db', 0); assert.equal(b.check('db', H, 2 * H).due, false, 'a longer cooldown still counts');
  assert.deepEqual(STEPS_MS, [0, H, 6 * H, 24 * H]);
});
