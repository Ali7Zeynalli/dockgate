// Isolated host-logs worker — connects over ssh2, runs the (server-built, allowlisted) log command from
// cfg.cmd, and writes the output to stdout. Forked like host-stats-worker so its connection never
// contends with the main-process EventMonitor connections to the same host.
delete process.env.SSH_AUTH_SOCK;
const { Client } = require('ssh2');
const fs = require('fs');

const cfg = JSON.parse(process.argv[2] || '{}');
const conn = new Client();
const opts = { host: cfg.host, port: cfg.port || 22, username: cfg.username, readyTimeout: 20000, agent: false, tryKeyboard: false };
if (cfg.keyPath) { opts.privateKey = fs.readFileSync(cfg.keyPath); if (cfg.passphrase) opts.passphrase = cfg.passphrase; }
else if (cfg.password) opts.password = cfg.password;

const fail = (m) => { process.stderr.write(String(m) + '\n'); try { conn.end(); } catch (e) {} process.exit(1); };
const wd = setTimeout(() => fail('host logs timed out'), 22000);

conn.on('ready', () => {
  conn.exec(cfg.cmd, (err, stream) => {
    if (err) return fail(err.message);
    let out = '';
    stream.on('data', d => { out += d.toString(); }).stderr.on('data', d => { out += d.toString(); });
    stream.on('close', () => { clearTimeout(wd); conn.end(); process.stdout.write(out); process.exit(0); });
  });
}).on('error', e => fail(e.message)).connect(opts);
