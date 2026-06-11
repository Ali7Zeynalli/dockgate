// Standalone worker — runs `sudo -n usermod -aG docker <user>` over an ISOLATED ssh2 connection.
// Run in its own process (forked by routes/servers.js) so it never contends with the long-lived
// EventMonitor ssh2 connections in the main server process (which made an in-process connection
// stall during authentication). Config arrives as JSON in argv[2].
// An inherited SSH_AUTH_SOCK makes ssh2 stall trying the (irrelevant) agent before our key — drop it
// so auth uses ONLY the provided private key / password. (Production containers have no agent anyway.)
delete process.env.SSH_AUTH_SOCK;

const { Client } = require('ssh2');
const fs = require('fs');

const cfg = JSON.parse(process.argv[2] || '{}');
const conn = new Client();
const opts = {
  host: cfg.host, port: cfg.port || 22, username: cfg.username,
  readyTimeout: 20000, agent: false, tryKeyboard: false,
};
if (cfg.keyPath) {
  opts.privateKey = fs.readFileSync(cfg.keyPath);
  if (cfg.passphrase) opts.passphrase = cfg.passphrase;
} else if (cfg.password) {
  opts.password = cfg.password;
}

let done = false;
const fail = (msg) => { if (done) return; done = true; process.stderr.write(String(msg) + '\n'); try { conn.end(); } catch (e) {} process.exit(1); };

conn.on('ready', () => {
  const user = String(cfg.username).replace(/[^a-zA-Z0-9._-]/g, ''); // shell-safe (our own username)
  conn.exec(`sudo -n usermod -aG docker ${user}`, (err, stream) => {
    if (err) return fail(err.message);
    let se = '';
    stream
      .on('data', () => {})                 // stdout-u boşalt — yoxsa 'close' event-i gəlmir (stream backpressure)
      .on('close', (code) => {
        conn.end();
        if (code === 0) { done = true; process.exit(0); }
        else fail(se.trim() || `usermod exited ${code} — passwordless sudo is required for "${user}"`);
      })
      .stderr.on('data', d => { se += d.toString(); });
  });
}).on('error', (e) => fail(e.message)).connect(opts);

setTimeout(() => fail('SSH timed out'), 25000);
