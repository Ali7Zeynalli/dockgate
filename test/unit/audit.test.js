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

test('ipFromReq falls back to the first x-forwarded-for hop', () => {
  assert.strictEqual(ipFromReq({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
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

test('ipFromSocket prefers the first x-forwarded-for hop', () => {
  assert.strictEqual(ipFromSocket({ handshake: { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } } }), '1.1.1.1');
});

test('ipFromSocket returns null without a handshake', () => {
  assert.strictEqual(ipFromSocket({}), null);
  assert.strictEqual(ipFromSocket(null), null);
});
