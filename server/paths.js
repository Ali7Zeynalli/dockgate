'use strict';
// One place for DockGate's data locations. DATA_DIR (tests, custom deploys) moves all of them together.
const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const SSH_KEYS_DIR = path.join(DATA_DIR, 'ssh-keys');
// Before 2.9 SSH keys always went to <app>/data/ssh-keys, even with DATA_DIR set — still read from there.
const LEGACY_SSH_KEYS_DIR = path.join(DEFAULT_DATA_DIR, 'ssh-keys');

function ensureKeysDir() {
  if (!fs.existsSync(SSH_KEYS_DIR)) fs.mkdirSync(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
  return SSH_KEYS_DIR;
}

/** Absolute path of a stored key (key_path is a file name inside the keys dir, or an absolute path). */
function keyPath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  const file = path.join(SSH_KEYS_DIR, p);
  if (SSH_KEYS_DIR !== LEGACY_SSH_KEYS_DIR && !fs.existsSync(file)) {
    const legacy = path.join(LEGACY_SSH_KEYS_DIR, p);
    if (fs.existsSync(legacy)) return legacy;
  }
  return file;
}

module.exports = { DATA_DIR, SSH_KEYS_DIR, LEGACY_SSH_KEYS_DIR, ensureKeysDir, keyPath };
