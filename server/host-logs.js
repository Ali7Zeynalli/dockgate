// Host log viewer — reads the last N lines of a log over SSH via an isolated worker (one-shot, like
// host-stats). Three ways to pick a log, all built into SAFE server-side commands (never free shell):
//   • source: a curated quick-pick (journald / auth / syslog / kernel / boot)
//   • unit:   a systemd unit  → journalctl -u <unit>   (unit validated to a no-metachar charset)
//   • file:   a path under /var/log → tail <file>      (path validated: /var/log prefix, no traversal)
// discoverLogSources() lists the units + /var/log files that actually exist, so the UI can offer them all.
const { execFile } = require('child_process');
const path = require('path');

// %N is replaced with a clamped integer. Each tries non-sudo, then sudo -n, then a fallback; never hangs.
const SOURCES = {
  journald: 'journalctl -n %N --no-pager -o short-iso 2>/dev/null || sudo -n journalctl -n %N --no-pager -o short-iso 2>&1 || echo "(journald unavailable)"',
  auth:     'sudo -n tail -n %N /var/log/auth.log 2>/dev/null || sudo -n tail -n %N /var/log/secure 2>/dev/null || echo "(auth log unavailable — needs passwordless sudo)"',
  syslog:   'sudo -n tail -n %N /var/log/syslog 2>/dev/null || sudo -n tail -n %N /var/log/messages 2>/dev/null || echo "(syslog unavailable — needs passwordless sudo)"',
  kernel:   'dmesg --color=never 2>/dev/null | tail -n %N || sudo -n dmesg --color=never 2>/dev/null | tail -n %N || echo "(dmesg unavailable — needs passwordless sudo)"',
  boot:     'journalctl -b -n %N --no-pager -o short-iso 2>/dev/null || sudo -n journalctl -b -n %N --no-pager -o short-iso 2>&1 || echo "(boot log unavailable)"',
};

const VALID_UNIT = /^[A-Za-z0-9@:._-]+$/;                         // systemd unit — no shell metacharacters
const isValidUnit = (u) => typeof u === 'string' && VALID_UNIT.test(u);
const isLogFile = (p) => typeof p === 'string' && /^\/var\/log\/[A-Za-z0-9._/-]+$/.test(p) && !p.includes('..');

// Run a SERVER-BUILT command through the isolated worker and resolve its stdout.
function runWorkerCmd(server, cmd) {
  return new Promise((resolve, reject) => {
    const cfg = { host: server.host, port: server.port, username: server.username, keyPath: server.keyPath || null, password: server.password || null, passphrase: server.passphrase || null, cmd };
    const child = execFile(process.execPath, [path.join(__dirname, 'host-logs-worker.js'), JSON.stringify(cfg)], { maxBuffer: 8 * 1024 * 1024 });
    const to = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('host logs timed out')); }, 25000);
    let buf = '', err = '';
    child.stdout.on('data', d => { buf += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(to); if (code !== 0) return reject(new Error(err.trim() || 'host logs failed')); resolve(buf); });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Discover the log sources that exist on the host: systemd service units + files under /var/log.
// The command is a server-side constant; results are re-validated before being returned.
async function discoverLogSources(server) {
  const cmd = "echo '@@U@@'; systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '{print $1}' | grep '\\.service$' | sort -u | head -200; "
            + "echo '@@F@@'; find /var/log -maxdepth 2 -type f 2>/dev/null | grep -iE '(\\.log|/syslog|/messages|/auth\\.log|/secure|/kern\\.log)$' | sort -u | head -200";
  const out = await runWorkerCmd(server, cmd);
  const u = out.indexOf('@@U@@'), f = out.indexOf('@@F@@');
  const unitsRaw = (u >= 0 && f > u) ? out.slice(u + 5, f) : '';
  const filesRaw = (f >= 0) ? out.slice(f + 5) : '';
  const units = unitsRaw.split('\n').map(s => s.trim()).filter(s => /^[A-Za-z0-9@:._-]+\.service$/.test(s));
  const files = filesRaw.split('\n').map(s => s.trim()).filter(isLogFile);
  return { units, files };
}

// opts: { source } | { unit } | { file }. Builds the validated read command.
function collectHostLogs(server, opts, lines) {
  return new Promise((resolve, reject) => {
    const n = Math.min(2000, Math.max(10, parseInt(lines, 10) || 200));
    let cmd, label;
    if (opts && opts.unit) {
      if (!VALID_UNIT.test(opts.unit)) return reject(new Error('invalid unit name'));
      label = opts.unit;
      cmd = `journalctl -u '${opts.unit}' -n ${n} --no-pager -o short-iso 2>/dev/null || sudo -n journalctl -u '${opts.unit}' -n ${n} --no-pager -o short-iso 2>&1 || echo "(no journal for ${opts.unit})"`;
    } else if (opts && opts.file) {
      if (!isLogFile(opts.file)) return reject(new Error('log file must be under /var/log'));
      label = opts.file;
      cmd = `sudo -n tail -n ${n} '${opts.file}' 2>/dev/null || tail -n ${n} '${opts.file}' 2>/dev/null || echo "(cannot read ${opts.file} — needs passwordless sudo)"`;
    } else {
      const tpl = SOURCES[opts && opts.source];
      if (!tpl) return reject(new Error('unknown log source'));
      label = opts.source;
      cmd = tpl.replace(/%N/g, String(n));
    }
    runWorkerCmd(server, cmd).then(text => resolve({ label, lines: n, text: text.slice(-200000) })).catch(reject);
  });
}

module.exports = { SOURCES, discoverLogSources, collectHostLogs, isValidUnit, isLogFile };
