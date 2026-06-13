// Isolated host-stats worker — connects over ssh2, runs the one-shot stats command, parses it with the
// shared parsers, and writes the snapshot JSON to stdout. Forked (like grant-docker/provision workers)
// so its connection never contends with the main-process EventMonitor connections to the same host.
delete process.env.SSH_AUTH_SOCK;
const { Client } = require('ssh2');
const fs = require('fs');
const { STATS_CMD, parseSnapshot } = require('./host-stats');

const cfg = JSON.parse(process.argv[2] || '{}');
const conn = new Client();
const opts = { host: cfg.host, port: cfg.port || 22, username: cfg.username, readyTimeout: 20000, agent: false, tryKeyboard: false };
if (cfg.keyPath) { opts.privateKey = fs.readFileSync(cfg.keyPath); if (cfg.passphrase) opts.passphrase = cfg.passphrase; }
else if (cfg.password) opts.password = cfg.password;

const fail = (m) => { process.stderr.write(String(m) + '\n'); try { conn.end(); } catch (e) {} process.exit(1); };
const wd = setTimeout(() => fail('host stats timed out'), 22000);

conn.on('ready', () => {
  conn.exec(STATS_CMD, (err, stream) => {
    if (err) return fail(err.message);
    let out = '';
    stream.on('data', d => { out += d.toString(); }).stderr.on('data', () => {});
    stream.on('close', () => {
      clearTimeout(wd); conn.end();
      try { process.stdout.write(JSON.stringify(parseSnapshot(out))); process.exit(0); }
      catch (e) { fail(e.message); }
    });
  });
}).on('error', e => fail(e.message)).connect(opts);
