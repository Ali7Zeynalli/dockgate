'use strict';
// Agent command channel, DockGate side: what it signs is what the agent's own check takes (server/agent/keys.js
// with agent/src/control/verify.js) — no Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-agentctl-test-'));
const keys = require('../../server/agent/keys');
const { verify } = require('../../agent/src/control/verify');

test('a signed command passes the agent check once, and only for its server', () => {
  const pub = keys.publicKeyFor('web-1');
  const m = keys.sign('web-1', 'cmd', { action: 'state' });
  const raw = JSON.stringify(m);
  const ok = verify(raw, pub, 'web-1', { lastSeq: 0 });
  assert.equal(ok.ok, true);
  assert.equal(verify(raw, pub, 'web-1', { lastSeq: ok.msg.seq }).reason, 'replay');
  assert.equal(verify(raw, pub, 'web-2', { lastSeq: 0 }).reason, 'server');
  const tampered = JSON.stringify({ ...m, payload: m.payload.replace('"state"', '"add-replica"') });
  assert.equal(verify(tampered, pub, 'web-1', { lastSeq: 0 }).reason, 'signature');
});
test('sequence numbers grow and never fall below the clock', () => {
  keys.publicKeyFor('web-3');
  const a = JSON.parse(keys.sign('web-3', 'cmd', {}).payload).seq;
  const b = JSON.parse(keys.sign('web-3', 'cmd', {}).payload).seq;
  assert.ok(b > a); assert.ok(a >= Date.now() - 5000);
});
test('another key can not command an agent', () => {
  const pub1 = keys.publicKeyFor('a');
  keys.publicKeyFor('b');
  const fromB = JSON.stringify({ ...keys.sign('b', 'cmd', {}), payload: keys.sign('b', 'cmd', {}).payload.replace('"serverId":"b"', '"serverId":"a"') });
  assert.equal(verify(fromB, pub1, 'a', { lastSeq: 0 }).reason, 'signature');
  assert.throws(() => keys.sign('nobody', 'cmd', {}), /no key yet/);
});
