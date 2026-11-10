'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../agent/src/storage.js');
const st = Object.create((S.prototype || S.Storage.prototype));
const { composeReason } = require('../../server/remote-compose');

test('a structured line\'s own level wins over words in it (Caddy warn with an "error" field)', () => {
  const caddy = '{"level":"warn","ts":1794321676.8,"logger":"http.handlers.reverse_proxy","msg":"aborting with incomplete response","upstream":"web:3000","error":"reading: context canceled"}';
  assert.equal(st._detectLogLevel(caddy, 'stderr'), 'warn');
  assert.equal(st._detectLogLevel('{"level":"error","msg":"dial tcp: refused"}'), 'error');
  assert.equal(st._detectLogLevel('{"level":"info","msg":"request failed, retrying"}'), 'info');
  assert.equal(st._detectLogLevel('time=1 level=info msg="cache miss error count reset"'), 'info');
  assert.equal(st._detectLogLevel('{"severity":"ERROR","message":"boom"}'), 'error');
  assert.equal(st._detectLogLevel('{"level":"debug","msg":"x"}'), 'debug');
});

test('lines without a level still go by their words', () => {
  assert.equal(st._detectLogLevel('ERROR: relation "x" does not exist'), 'error');
  assert.equal(st._detectLogLevel('GET /x HTTP/1.1" 502 12'), 'error');
  assert.equal(st._detectLogLevel('connection timed out'), 'warn');
  assert.equal(st._detectLogLevel('server started', 'stdout'), 'info');
});

test('composeReason picks the line that says why compose failed', () => {
  assert.equal(composeReason(' Container a Recreate\nError response from daemon: pull access denied for acme/api\n'), ': Error response from daemon: pull access denied for acme/api');
  assert.equal(composeReason('env file /srv/app/.env not found: stat /srv/app/.env: no such file or directory'), ': env file /srv/app/.env not found: stat /srv/app/.env: no such file or directory');
  assert.equal(composeReason('\x1b[31mno such service: worker\x1b[0m\n'), ': no such service: worker');
  assert.equal(composeReason(''), '');
});
