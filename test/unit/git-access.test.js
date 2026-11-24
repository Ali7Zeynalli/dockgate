'use strict';
// Git → Access… (server/git-access.js): the access DockGate keeps for a stack it did not clone, the URL forms a
// token or a key need, and git's auth errors turned into what to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const GA = require('../../server/git-access');

test('URL forms: a token needs HTTPS, a key needs SSH', () => {
  assert.equal(GA.toHttps('git@github.com:me/app.git'), 'https://github.com/me/app.git');
  assert.equal(GA.toHttps('ssh://git@gitlab.example.com:2222/team/app.git'), 'https://gitlab.example.com/team/app.git');
  assert.equal(GA.toHttps('https://old-token@github.com/me/app.git'), 'https://github.com/me/app.git', 'an old token in the URL is dropped');
  assert.equal(GA.toSsh('https://github.com/me/app.git'), 'git@github.com:me/app.git');
  assert.equal(GA.withToken('git@github.com:me/app.git', 'ghp_X'), 'https://x-access-token:ghp_X@github.com/me/app.git');
  assert.equal(GA.withToken('https://gitlab.com/me/app.git', 'glpat-Y'), 'https://oauth2:glpat-Y@gitlab.com/me/app.git');
  assert.equal(GA.withToken('https://bitbucket.org/me/app.git', 'Z'), 'https://x-token-auth:Z@bitbucket.org/me/app.git');
  assert.equal(GA.withToken('https://git.example.com/me/app.git', 'user:pass word'), 'https://user:pass%20word@git.example.com/me/app.git', 'user:password is kept as given');
});

test('access is stored per server and project; the token is never described back', () => {
  assert.deepEqual(GA.describe('srv-a', 'shop'), { method: 'server', keyId: null, hasToken: false });
  GA.set('srv-a', 'shop', { method: 'token', token: 'ghp_secret123' });
  assert.deepEqual(GA.describe('srv-a', 'shop'), { method: 'token', keyId: null, hasToken: true });
  assert.equal(GA.get('srv-a', 'shop').token, 'ghp_secret123');
  assert.equal(GA.get('srv-b', 'shop').token, '', 'another server has its own');
  GA.set('srv-a', 'shop', { method: 'token', token: '' }); // empty keeps the saved one
  assert.equal(GA.get('srv-a', 'shop').token, 'ghp_secret123');
  GA.set('srv-a', 'shop', { method: 'key', keyId: '3' });
  assert.deepEqual(GA.get('srv-a', 'shop'), { keyId: '3', token: '' });
  GA.set('srv-a', 'shop', { method: 'server' });
  assert.deepEqual(GA.describe('srv-a', 'shop').method, 'server');
  assert.throws(() => GA.set('srv-a', 'x', { method: 'token', token: 'has space' }), /access token/);
  assert.throws(() => GA.set('srv-a', 'x', { method: 'key' }), /SSH key/);
  assert.throws(() => GA.set('srv-a', 'x', { method: 'nope' }), /Choose how/);
});

test("git's auth errors say what to do", () => {
  assert.match(GA.explain("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), /private and git has no access/);
  assert.match(GA.explain('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), /Deploy keys/);
  assert.match(GA.explain('remote: Invalid username or token. Password authentication is not supported\nfatal: Authentication failed for x'), /refused the access token/);
  assert.equal(GA.explain('fatal: not a git repository'), 'fatal: not a git repository');
  assert.doesNotMatch(GA.explain("fatal: could not read Password for 'https://OLDtok123@github.com': terminal prompts disabled"), /OLDtok123/, 'a token inside a URL is hidden');
  assert.equal(GA.hideUrlAuth('x https://user:pw@gitlab.com/a y'), 'x https://***@gitlab.com/a y');
});
