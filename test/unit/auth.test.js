const { test } = require('node:test');
const assert = require('node:assert');

// session.js takes its signing secret from this env when set, so these tests need no DB.
process.env.DG_SESSION_SECRET = 'unit-test-signing-secret';

const { hashPassword, verifyPassword } = require('../../server/auth/password');
const session = require('../../server/auth/session');

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
