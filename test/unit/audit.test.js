// Unit tests for the source-IP extraction helpers in server/audit.js.
// Requiring audit.js loads db.js (opens SQLite), so point it at a throwaway dir first.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-audit-test-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { ipFromReq, ipFromSocket } = require('../../server/audit');

test('ipFromReq prefers req.ip', () => {
  assert.strictEqual(ipFromReq({ ip: '10.0.0.1' }), '10.0.0.1');
});

test('ipFromReq never trusts a raw x-forwarded-for header (any client can send one)', () => {
  assert.strictEqual(ipFromReq({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '203.0.113.5' } }), '203.0.113.5');
});

test('ipFromReq falls back to socket.remoteAddress', () => {
  assert.strictEqual(ipFromReq({ socket: { remoteAddress: '7.7.7.7' } }), '7.7.7.7');
});

test('ipFromReq returns null when nothing is available', () => {
  assert.strictEqual(ipFromReq({}), null);
  assert.strictEqual(ipFromReq(null), null);
});

test('ipFromSocket reads the handshake address', () => {
  assert.strictEqual(ipFromSocket({ handshake: { address: '9.9.9.9', headers: {} } }), '9.9.9.9');
});

test('ipFromSocket ignores x-forwarded-for unless TRUST_PROXY trusts the peer (default: nobody)', () => {
  assert.strictEqual(ipFromSocket({ handshake: { address: '203.0.113.5', headers: { 'x-forwarded-for': '1.1.1.1' } } }), '203.0.113.5');
});

test('trust-proxy: parsing and a trusted loopback proxy', () => {
  const { parseTrustProxy } = require('../../server/trust-proxy');
  assert.strictEqual(parseTrustProxy(undefined), false);
  assert.strictEqual(parseTrustProxy('false'), false);
  assert.strictEqual(parseTrustProxy('true'), true);
  assert.strictEqual(parseTrustProxy('2'), 2);
  assert.deepStrictEqual(parseTrustProxy('loopback, 10.0.0.5'), ['loopback', '10.0.0.5']);
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "const t=require('./server/trust-proxy');console.log(t.socketClientIp({address:'127.0.0.1',headers:{'x-forwarded-for':'1.2.3.4'}}),t.socketClientIp({address:'203.0.113.5',headers:{'x-forwarded-for':'1.2.3.4'}}))"], { env: { ...process.env, TRUST_PROXY: 'loopback' } }).toString().trim();
  assert.strictEqual(out, '1.2.3.4 203.0.113.5', 'only the trusted proxy may set the client IP');
});

test('ipFromSocket returns null without a handshake', () => {
  assert.strictEqual(ipFromSocket({}), null);
  assert.strictEqual(ipFromSocket(null), null);
});
