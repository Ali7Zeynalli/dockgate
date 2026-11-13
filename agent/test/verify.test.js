'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verify } = require('../src/control/verify');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' });
const now = 1_800_000_000_000;
const make = (o = {}, key = privateKey) => {
  const payload = JSON.stringify({ v: 1, kind: 'cmd', serverId: 'web-1', seq: 5, issuedAt: now, body: { action: 'restart' }, ...o });
  return JSON.stringify({ payload, sig: crypto.sign(null, Buffer.from(payload), key).toString('base64') });
};

test('a message signed by the installing DockGate is taken', () => {
  const r = verify(make(), pub, 'web-1', { lastSeq: 4 }, now);
  assert.equal(r.ok, true); assert.equal(r.msg.body.action, 'restart');
});
test('anything else is refused, with the reason', () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(verify(make({}, other), pub, 'web-1', { lastSeq: 0 }, now).reason, 'signature');
  const m = JSON.parse(make()); m.payload = m.payload.replace('restart', 'exec');
  assert.equal(verify(JSON.stringify(m), pub, 'web-1', { lastSeq: 0 }, now).reason, 'signature', 'one changed byte');
  assert.equal(verify(make(), pub, 'web-2', { lastSeq: 0 }, now).reason, 'server');
  assert.equal(verify(make(), pub, 'web-1', { lastSeq: 5 }, now).reason, 'replay', 'same sequence again');
  assert.equal(verify(make({ issuedAt: now - 16 * 60000 }), pub, 'web-1', { lastSeq: 0 }, now).reason, 'stale');
  assert.equal(verify(make({ issuedAt: now + 10 * 60000 }), pub, 'web-1', { lastSeq: 0 }, now).reason, 'future');
  assert.equal(verify(make({ kind: 'rules', issuedAt: now - 3600000 }), pub, 'web-1', { lastSeq: 0 }, now).ok, true, 'rules may be an hour old');
  assert.equal(verify(make({ kind: 'shell' }), pub, 'web-1', { lastSeq: 0 }, now).reason, 'kind');
  assert.equal(verify('not json', pub, 'web-1', { lastSeq: 0 }, now).reason, 'format');
});

const { healDecision } = require('../src/control/heal-decision');
test('healDecision: start period, consecutive failures, hourly cap, then rollback (opt-in) or stop', () => {
  const now = 10_000_000;
  assert.equal(healDecision({ fails: 5, since: now - 30000 }, now), 'wait', 'inside the start period');
  assert.equal(healDecision({ fails: 2, since: now - 600000 }, now), 'wait');
  assert.equal(healDecision({ fails: 3, since: now - 600000 }, now), 'restart');
  const three = [now - 60000, now - 120000, now - 180000];
  assert.equal(healDecision({ fails: 3, restarts: three }, now), 'stop');
  assert.equal(healDecision({ fails: 3, restarts: three }, now, { rollback: true, recentImageUpdate: true }), 'rollback');
  assert.equal(healDecision({ fails: 3, restarts: three }, now, { rollback: true, recentImageUpdate: false }), 'stop');
  assert.equal(healDecision({ fails: 3, restarts: [now - 4000000] }, now), 'restart', 'an old restart does not count');
});
