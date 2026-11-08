'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-backup-test-'));
process.env.DATA_DIR = DIR;
const { stmts } = require('../../server/db');
const B = require('../../server/backup');
const { encrypt } = require('../../server/auth/secrets');

test('backup → wrong password refused → restore applied on next start, old data kept aside', async () => {
  stmts.insertServer.run('keep-me', 'ssh', '192.0.2.1', 22, 'deploy', null, encrypt('s3cret-pass'), null, '', 'keep-me', 1);
  fs.mkdirSync(path.join(DIR, 'ssh-keys'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'ssh-keys', 'keep-me.pem'), 'KEY');
  fs.mkdirSync(path.join(DIR, 'compose', 'shop', '.git'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'compose', 'shop', 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(DIR, 'compose', 'shop', '.git', 'HEAD'), 'ref');

  const file = B.seal(await B.createBundle({ includeCompose: true }), 'correct horse battery');
  assert.throws(() => B.open(file, 'wrong password!!'), /Wrong password/);
  assert.throws(() => B.open(Buffer.from('hello world')), /not a DockGate backup/);
  const bundle = B.open(file, 'correct horse battery');
  const sum = B.summary(bundle);
  assert.equal(sum.sshKeys, 1);
  assert.equal(sum.composeFiles, 1, '.git is left out');

  // Change things after the backup, then restore.
  stmts.deleteServer.run('keep-me');
  stmts.insertServer.run('later', 'ssh', '192.0.2.2', 22, 'deploy', null, null, null, '', 'later', 1);
  fs.writeFileSync(path.join(DIR, 'compose', 'shop', 'docker-compose.yml'), 'changed\n');
  B.stage(bundle);

  // A fresh process opens the database → the staged backup is applied first.
  const out = execFileSync(process.execPath, ['-e', `
    const { stmts } = require(${JSON.stringify(path.join(__dirname, '../../server/db'))});
    const { decrypt } = require(${JSON.stringify(path.join(__dirname, '../../server/auth/secrets'))});
    const s = stmts.getServers.all().map(x => x.id).sort();
    const pw = decrypt(stmts.getServer.get('keep-me').password);
    console.log(JSON.stringify({ s, pw }));`], { env: { ...process.env, DATA_DIR: DIR }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.s, ['keep-me']);
  assert.equal(r.pw, 's3cret-pass', 'secrets readable after restore (master key restored too)');
  assert.equal(fs.readFileSync(path.join(DIR, 'compose', 'shop', 'docker-compose.yml'), 'utf8'), 'services: {}\n');
  assert.ok(!fs.existsSync(path.join(DIR, 'restore-pending')));
  const kept = fs.readdirSync(path.join(DIR, 'backups')).filter(n => n.startsWith('pre-restore-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(DIR, 'backups', kept[0], 'compose', 'shop', 'docker-compose.yml'), 'utf8'), 'changed\n');
});

test('nightly copies: plain format, newest kept, readable without a password', async () => {
  const name = await B.autoBackup();
  assert.match(name, /^auto-\d{4}-\d{2}-\d{2}\.dgbak$/);
  const b = B.open(B.readAuto(name));
  assert.ok(b.files['docker-panel.db']);
  assert.throws(() => B.readAuto('../docker-panel.db'), /No such copy/);
});
