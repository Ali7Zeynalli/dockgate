'use strict';
// DockGate must start on a brand-new data folder and answer — every background module it starts at boot (scaling,
// healing, Swarm firewall, agent control…) loads in whatever order index.js gives. Regression: 2.53.1 crashed at
// boot because a module read a table another module had not made yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawn } = require('child_process');

function get(port, p) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0)); r.on('timeout', () => { r.destroy(); resolve(0); });
  });
}

test('the server starts on an empty data folder, with its background modules, and answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-boot-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), NODE_ENV: 'production', DOCKER_HOST: 'unix:///nonexistent.sock' };
  const child = spawn(process.execPath, [path.join(__dirname, '../../server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  let exited = null; child.on('exit', (code) => { exited = code; });
  try {
    let status = 0;
    for (let i = 0; i < 40 && !status && exited === null; i++) { await new Promise(r => setTimeout(r, 250)); status = await get(port, '/api/auth/status'); }
    assert.equal(exited, null, `the server exited at boot:\n${out.slice(-1500)}`);
    assert.equal(status, 200, `no answer:\n${out.slice(-1500)}`);
    await new Promise(r => setTimeout(r, 1500)); // the modules started after listen
    assert.equal(exited, null, `the server exited after it started listening:\n${out.slice(-1500)}`);
    assert.doesNotMatch(out, /SqliteError|no such table/, out.slice(-1500));
  } finally { child.kill('SIGKILL'); }
});
