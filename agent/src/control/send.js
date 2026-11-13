// The way in for DockGate: `docker exec -i dockgate-agent node src/control/send.js` with one signed message on
// stdin. It is passed to the control socket inside this container; the reply is printed. No network involved.
const net = require('net');
const { SOCK } = require('./index');
let input = '';
process.stdin.on('data', d => { input += d; if (input.length > 300 * 1024) process.exit(2); });
process.stdin.on('end', () => {
  const c = net.connect(SOCK);
  let out = '';
  c.on('connect', () => c.write(input.trim() + '\n'));
  c.on('data', d => { out += d; });
  c.on('end', () => { process.stdout.write(out.trim() + '\n'); process.exit(0); });
  c.on('error', (e) => { process.stdout.write(JSON.stringify({ ok: false, reason: `control socket: ${e.code || e.message}` }) + '\n'); process.exit(1); });
  setTimeout(() => { process.stdout.write(JSON.stringify({ ok: false, reason: 'timeout' }) + '\n'); process.exit(1); }, 25000);
});
