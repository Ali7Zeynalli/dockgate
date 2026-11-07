'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-paths-test-'));
const paths = require('../../server/paths');

test('paths: SSH keys live under DATA_DIR; absolute paths pass through; legacy location still read', () => {
  assert.equal(paths.SSH_KEYS_DIR, path.join(process.env.DATA_DIR, 'ssh-keys'));
  paths.ensureKeysDir();
  assert.equal(fs.statSync(paths.SSH_KEYS_DIR).mode & 0o777, 0o700);
  assert.equal(paths.keyPath(null), null);
  assert.equal(paths.keyPath('/abs/k.pem'), '/abs/k.pem');
  assert.equal(paths.keyPath('new.pem'), path.join(paths.SSH_KEYS_DIR, 'new.pem'), 'missing everywhere → new location');
  // a key written by an older version to <app>/data/ssh-keys is still found
  const name = `_legacy_test_${process.pid}.pem`;
  fs.mkdirSync(paths.LEGACY_SSH_KEYS_DIR, { recursive: true });
  const legacy = path.join(paths.LEGACY_SSH_KEYS_DIR, name);
  fs.writeFileSync(legacy, 'x');
  try {
    assert.equal(paths.keyPath(name), legacy);
    fs.writeFileSync(path.join(paths.SSH_KEYS_DIR, name), 'y');
    assert.equal(paths.keyPath(name), path.join(paths.SSH_KEYS_DIR, name), 'the DATA_DIR copy wins');
  } finally { fs.rmSync(legacy, { force: true }); }
});
