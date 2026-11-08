'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-webhook-test-'));
const W = require('../../server/notifications/webhook');

test('plain: Telegram HTML becomes plain text', () => {
  assert.equal(W.plain('🐳 <b>Container died</b>\n<b>Exit:</b> <code>137</code> &amp; &lt;oom&gt;'), '🐳 Container died\nExit: 137 & <oom>');
});

test('build: each format gets the body its service expects', () => {
  const m = { title: 'db-1 is not reachable', text: 'No answer since 14:02', event: 'server_down', server: 'db-1' };
  assert.deepEqual(JSON.parse(W.build('slack', m).body), { text: '*db-1 is not reachable*\nNo answer since 14:02' });
  assert.deepEqual(JSON.parse(W.build('discord', m).body), { content: '**db-1 is not reachable**\nNo answer since 14:02' });
  assert.match(JSON.parse(W.build('teams', m).body).text, /^\*\*db-1 is not reachable\*\*/);
  const n = W.build('ntfy', m);
  assert.equal(n.headers.Title, 'db-1 is not reachable'); assert.equal(n.body, 'No answer since 14:02');
  const j = JSON.parse(W.build('json', m).body);
  assert.equal(j.event, 'server_down'); assert.equal(j.server, 'db-1'); assert.equal(j.source, 'dockgate'); assert.ok(j.time);
});

test('validUrl: only http and https', () => {
  assert.ok(W.validUrl('https://hooks.slack.com/services/x'));
  assert.ok(W.validUrl('http://10.0.0.5:8080/hook'));
  assert.ok(!W.validUrl('ftp://x')); assert.ok(!W.validUrl('file:///etc/passwd')); assert.ok(!W.validUrl('not a url'));
});
