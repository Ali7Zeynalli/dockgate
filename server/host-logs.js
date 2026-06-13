// Host log viewer — fetches the last N lines of an ALLOWLISTED log source over SSH via an isolated
// worker (one-shot, same pattern as host-stats). The client only picks a SOURCE key + a line count; the
// shell command is built HERE from a fixed allowlist (never from the client), with N clamped. Read-only.
const { execFile } = require('child_process');
const path = require('path');

// %N is replaced with a clamped integer. Each source tries non-sudo, then sudo -n, then a distro
// fallback, and never hangs (sudo -n fails fast). The command is a server-side constant — no free shell.
const SOURCES = {
  journald: 'journalctl -n %N --no-pager -o short-iso 2>/dev/null || sudo -n journalctl -n %N --no-pager -o short-iso 2>&1 || echo "(journald unavailable)"',
  auth:     'sudo -n tail -n %N /var/log/auth.log 2>/dev/null || sudo -n tail -n %N /var/log/secure 2>/dev/null || echo "(auth log unavailable — needs passwordless sudo)"',
  syslog:   'sudo -n tail -n %N /var/log/syslog 2>/dev/null || sudo -n tail -n %N /var/log/messages 2>/dev/null || echo "(syslog unavailable — needs passwordless sudo)"',
  dmesg:    'dmesg --color=never 2>/dev/null | tail -n %N || sudo -n dmesg --color=never 2>/dev/null | tail -n %N || echo "(dmesg unavailable — needs passwordless sudo)"',
};

// server: { host,port,username,keyPath?,password?,passphrase? }
function collectHostLogs(server, source, lines) {
  return new Promise((resolve, reject) => {
    const tpl = SOURCES[source];
    if (!tpl) return reject(new Error('unknown log source'));
    const n = Math.min(2000, Math.max(10, parseInt(lines, 10) || 200));
    const cmd = tpl.replace(/%N/g, String(n));
    const cfg = { host: server.host, port: server.port, username: server.username, keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null, cmd };
    const child = execFile(process.execPath, [path.join(__dirname, 'host-logs-worker.js'), JSON.stringify(cfg)], { maxBuffer: 8 * 1024 * 1024 });
    const to = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('host logs timed out')); }, 25000);
    let buf = '', err = '';
    child.stdout.on('data', d => { buf += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(to); if (code !== 0) return reject(new Error(err.trim() || 'host logs failed')); resolve({ source, lines: n, text: buf.slice(-200000) }); });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

module.exports = { SOURCES, collectHostLogs };
