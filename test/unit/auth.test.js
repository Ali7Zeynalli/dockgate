const { test } = require('node:test');
const assert = require('node:assert');

// session.js takes its signing secret from this env when set, so these tests need no DB.
process.env.DG_SESSION_SECRET = 'unit-test-signing-secret';
process.env.DG_MASTER_KEY = 'a'.repeat(64); // 32-byte hex master key for secrets.js tests

const { hashPassword, verifyPassword } = require('../../server/auth/password');
const session = require('../../server/auth/session');
const secrets = require('../../server/auth/secrets');

test('password: verifies the correct password, rejects wrong/empty', () => {
  const { salt, hash } = hashPassword('s3cret-pw');
  assert.equal(verifyPassword('s3cret-pw', salt, hash), true);
  assert.equal(verifyPassword('wrong', salt, hash), false);
  assert.equal(verifyPassword('s3cret-pw', '', ''), false);
});

test('password: same password yields a different salt+hash each time', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  // both still verify
  assert.equal(verifyPassword('same', a.salt, a.hash), true);
  assert.equal(verifyPassword('same', b.salt, b.hash), true);
});

test('session: an issued token verifies back to its uid', () => {
  const t = session.issueToken('admin');
  assert.equal(session.verifyToken(t), 'admin');
});

test('session: tampered / garbage / empty tokens are rejected', () => {
  const t = session.issueToken('admin');
  const tampered = t.slice(0, -1) + (t.slice(-1) === 'a' ? 'b' : 'a');
  assert.equal(session.verifyToken(tampered), null);
  assert.equal(session.verifyToken('not.a.token'), null);
  assert.equal(session.verifyToken('nodothere'), null);
  assert.equal(session.verifyToken(''), null);
  assert.equal(session.verifyToken(null), null);
});

test('secrets: encrypt/decrypt round-trips; plaintext + null + already-encrypted pass through (idempotent)', () => {
  const enc = secrets.encrypt('s3cret-value');
  assert.ok(enc.startsWith('enc:v1:'));
  assert.notEqual(enc, 's3cret-value');
  assert.equal(secrets.decrypt(enc), 's3cret-value');           // round-trips
  assert.equal(secrets.decrypt('plain-legacy'), 'plain-legacy'); // not enc: -> passthrough (pre-migration safe)
  assert.equal(secrets.encrypt(enc), enc);                       // already encrypted -> unchanged
  assert.equal(secrets.encrypt(''), '');                          // empty passthrough
  assert.equal(secrets.encrypt(null), null);                      // null passthrough
  assert.equal(secrets.isEncrypted(enc), true);
  assert.equal(secrets.isEncrypted('plain'), false);
  // a second encrypt of the same plaintext uses a fresh IV -> different ciphertext, same decrypt
  assert.notEqual(secrets.encrypt('dup'), secrets.encrypt('dup'));
});

test('session: cookie is HttpOnly+SameSite=Lax and round-trips through readSessionToken', () => {
  const t = session.issueToken('admin');
  const cookie = session.serializeSessionCookie(t);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  const req = { headers: { cookie: `foo=1; ${session.COOKIE_NAME}=${t}; bar=2` } };
  assert.equal(session.readSessionToken(req), t);
  assert.equal(session.readSessionToken({ headers: {} }), null);
  assert.match(session.clearSessionCookie(), /Max-Age=0/);
});
