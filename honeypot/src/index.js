// DockGate SSH honeypot: listens where SSH used to be (port 22, mapped to 2222 in the container), records who
// connects and what they try, and refuses every login. There is no shell, no command, no file: a client never gets
// past authentication. Each event is one line in /log/honeypot.log, which fail2ban on the host reads to ban the
// address on every port (DockGate → Server Console → Security → Honeypot).
//   <ISO time> <event> <ip> <json>      event: connect (TCP) | ident (SSH greeting) | auth (a login attempt) | close
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Server, utils } = require('ssh2');

const PORT = Number(process.env.HP_PORT) || 2222;
const LOG = process.env.HP_LOG || '/log/honeypot.log';
const KEY = process.env.HP_KEY || '/data/host_ed25519';
const IDENT = process.env.HP_IDENT || 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5';
const MAX_CONN = Number(process.env.HP_MAX_CONN) || 100;
const MAX_TRIES = 6;            // auth attempts per connection, then it is closed
const IDLE_MS = 60000;          // a connection lives at most this long
// Addresses that are never written down (so never banned): loopback, private networks, and HP_ALLOW
const ALLOW = String(process.env.HP_ALLOW || '').split(/[\s,]+/).filter(Boolean);
const blocks = new net.BlockList();
if (process.env.HP_QUIET_PRIVATE !== '0') for (const [a, p, f] of [['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6']]) blocks.addSubnet(a, p, f);
for (const a of ALLOW) {
  const [ip, bits] = a.split('/'); const f = net.isIP(ip) === 6 ? 'ipv6' : net.isIP(ip) === 4 ? 'ipv4' : null;
  if (!f) continue;
  if (bits) blocks.addSubnet(ip, Number(bits), f); else blocks.addAddress(ip, f);
}
const plainIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
const allowed = (ip) => { const p = plainIp(ip); const f = net.isIP(p) === 6 ? 'ipv6' : 'ipv4'; try { return blocks.check(p, f); } catch (e) { return false; } };

// Whatever a client sends is printable ASCII in the log, never longer than it needs to be
const clean = (s, n = 64) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
let out = null;
function openLog() { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); out = fs.createWriteStream(LOG, { flags: 'a' }); out.on('error', () => { out = null; }); } catch (e) { out = null; } }
openLog();
// logrotate uses copytruncate; a log removed by hand is opened again
setInterval(() => { if (!fs.existsSync(LOG)) { try { out && out.end(); } catch (e) {} openLog(); } }, 30000).unref();
function log(ev, ip, data) {
  const line = `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${ev} ${plainIp(ip)} ${JSON.stringify(data || {})}\n`;
  if (out) out.write(line); else process.stdout.write(line);
}

function hostKey() {
  try { return fs.readFileSync(KEY); } catch (e) { /* first start */ }
  const k = utils.generateKeyPairSync('ed25519');
  try { fs.mkdirSync(path.dirname(KEY), { recursive: true }); fs.writeFileSync(KEY, k.private, { mode: 0o600 }); } catch (e) { /* read-only: a new key each start */ }
  return Buffer.from(k.private);
}

// Every TCP connection is written down the moment it opens ("connect"), before any SSH is spoken: port scanners
// that never send a greeting are banned too. The SSH layer then adds the client's greeting ("ident") and each
// login attempt ("auth"); "close" ends it.
let open = 0;
const ssh = new Server({ hostKeys: [hostKey()], ident: IDENT }, (client, info) => {
  const ip = info.ip; const quiet = allowed(ip);
  let tries = 0;
  if (!quiet) log('ident', ip, { client: clean(info.header && info.header.identRaw, 120) });
  client.on('authentication', (ctx) => {
    tries++;
    if (!quiet) {
      const d = { method: ctx.method, user: clean(ctx.username) };
      if (ctx.method === 'password') d.password = clean(ctx.password);
      if (ctx.method === 'publickey' && ctx.key) d.key = clean(ctx.key.algo, 40);
      if (ctx.method !== 'none') log('auth', ip, d);
    }
    // a small, varying delay, like a real server checking a password
    setTimeout(() => { try { tries >= MAX_TRIES ? client.end() : ctx.reject(['publickey', 'password']); } catch (e) { /* gone */ } }, 600 + Math.floor(Math.random() * 900));
  });
  client.on('ready', () => client.end()); // never reached: nothing is accepted
  client.on('error', () => {});
});
ssh.on('error', (e) => { process.stderr.write(`honeypot: ${e.message}\n`); });

const tcp = net.createServer((sock) => {
  const ip = sock.remoteAddress; const quiet = allowed(ip);
  if (open >= MAX_CONN) { sock.destroy(); return; }
  open++;
  const started = Date.now();
  if (!quiet) log('connect', ip, { port: sock.remotePort });
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  sock.on('error', () => {});
  sock.once('close', () => { open--; if (!quiet) log('close', ip, { secs: Math.round((Date.now() - started) / 1000) }); });
  try { ssh.injectSocket(sock); } catch (e) { sock.destroy(); }
});
tcp.maxConnections = MAX_CONN + 10;
tcp.on('error', (e) => { process.stderr.write(`honeypot: ${e.message}\n`); process.exit(1); });
tcp.listen(PORT, '0.0.0.0', () => process.stdout.write(`honeypot listening on ${PORT}\n`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { tcp.close(); process.exit(0); });
