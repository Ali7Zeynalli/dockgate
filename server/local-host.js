// Commands on the local server's own host (not in a container), for Proxies & SSL: nginx, Apache, Caddy or HAProxy
// installed with the package manager, certbot in /etc/letsencrypt, who holds ports 80 / 443.
//
// - DockGate runs straight on the host (node server/index.js): the command runs here, through sh.
// - DockGate runs in a container (the usual install): a short-lived helper container shares the host's processes
//   and network and runs the command in the host's root folder (chroot). DockGate can already do this through the
//   Docker socket it is given; the helper only makes it visible. DG_HOST_ACCESS=off turns it off.
const fs = require('fs');
const { execFile } = require('child_process');

const IMAGE = 'alpine';
const inContainer = () => process.env.DG_IN_CONTAINER === '1' || fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
const enabled = () => !/^(0|off|false|no)$/i.test(String(process.env.DG_HOST_ACCESS || ''));

function viaShell(cmd, timeout) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function viaHelper(c, cmd, timeout) {
  try { await c.getImage(IMAGE).inspect(); } catch (e) {
    await new Promise((res, rej) => c.pull(IMAGE, (e2, st) => e2 ? rej(e2) : c.modem.followProgress(st, (e3) => e3 ? rej(e3) : res())));
  }
  const ct = await c.createContainer({
    Image: IMAGE, Cmd: ['chroot', '/host', 'sh', '-c', cmd], Labels: { 'dockgate.helper': 'host-command' },
    HostConfig: { Binds: ['/:/host'], PidMode: 'host', NetworkMode: 'host', Privileged: true, AutoRemove: false },
  });
  let timer;
  try {
    await ct.start();
    const w = await Promise.race([ct.wait(), new Promise((res) => { timer = setTimeout(() => { ct.kill().catch(() => {}); res({ StatusCode: 124 }); }, timeout); })]);
    const buf = await ct.logs({ stdout: true, stderr: true });
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); let stdout = '', stderr = ''; let i = 0;
    if (b.length > 8 && (b[0] === 1 || b[0] === 2) && b[1] === 0) {
      while (i + 8 <= b.length) { const n = b.readUInt32BE(i + 4); const s = b.slice(i + 8, i + 8 + n).toString('utf8'); if (b[i] === 2) stderr += s; else stdout += s; i += 8 + n; }
    } else stdout = b.toString('utf8');
    return { code: w.StatusCode, stdout, stderr };
  } finally { clearTimeout(timer); await ct.remove({ force: true }).catch(() => {}); }
}

/** The local host as a "server" the Proxies code can run commands on, or null when host access is off. */
function forLocal(c) {
  if (!enabled()) return null;
  return { local: true, name: 'this server', exec: (cmd, { timeout = 60000 } = {}) => (inContainer() ? viaHelper(c, cmd, timeout) : viaShell(cmd, timeout)) };
}

module.exports = { forLocal, inContainer, enabled };
