// Loaded before every test file (npm test → node --test --import ./test/setup-env.js).
// node --test runs the files in parallel processes; each one gets its own empty DATA_DIR, so no two files
// share data/docker-panel.db (they raced on it: "SQLITE_BUSY: database is locked" when a fresh database was
// switched to WAL by several processes at once). A test file may still set DATA_DIR itself before requiring
// the server code.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-test-'));
