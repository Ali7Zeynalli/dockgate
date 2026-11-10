const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// The time a host log line was written, read from the line itself. Falls back to now.
//   RFC 3339 (rsyslog on current Ubuntu/Debian):  2026-11-09T10:15:30.123456+00:00 host sshd[1]: …
//   classic syslog:                                Nov  9 10:15:30 host sshd[1]: …
//   nginx access:                                  … [09/Nov/2026:10:15:30 +0000] "GET / …"
//   nginx error:                                   2026/11/09 10:15:30 [error] …
//   dmesg -T:                                      [Sun Nov  9 10:15:30 2026] …
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function lineTime(line, now = Date.now()) {
  let m;
  if ((m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s/.exec(line))) { const t = Date.parse(m[1].replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); if (Number.isFinite(t)) return t; }
  if ((m = /\[(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d\d)(\d\d)\]/.exec(line))) {
    const mo = MON[m[2].toLowerCase()]; if (mo != null) { const t = Date.parse(`${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`); if (Number.isFinite(t)) return t; }
  }
  if ((m = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\s/.exec(line))) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  if ((m = /^\[?(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d)(?: (\d{4}))?\]?\s/.exec(line))) {
    const mo = MON[m[1].toLowerCase()];
    if (mo != null) {
      const y = m[6] ? +m[6] : new Date(now).getFullYear();
      let t = new Date(y, mo, +m[2], +m[3], +m[4], +m[5]).getTime();
      if (!m[6] && t > now + 86400000) t = new Date(y - 1, mo, +m[2], +m[3], +m[4], +m[5]).getTime(); // December line read in January
      return t;
    }
  }
  return now;
}

class HostLogHarvester {
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.intervalMs = opts.intervalMs || 10000;
    this.logDir = fs.existsSync('/host/var/log') ? '/host/var/log' : '/var/log';
    this.fileOffsets = new Map(); // filePath -> byte offset
    this.dmesgSeen = new Set(); // kernel lines already added
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.harvest();
    this.timer = setInterval(() => this.harvest(), this.intervalMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async harvest() {
    if (this.stopped) return;
    try {
      this.harvestFile('nginx/error.log', 'nginx', 'error');
      this.harvestFile('nginx/access.log', 'nginx', 'info');
      this.harvestFile('auth.log', 'auth', 'info');
      this.harvestFile('secure', 'auth', 'info');
      this.harvestFile('syslog', 'system', 'info');
      this.harvestFile('messages', 'system', 'info');
      this.harvestDmesg();
    } catch (e) {
      // Non-blocking log harvest
    }
  }

  harvestFile(relPath, sourceTag, defaultLevel) {
    const fullPath = path.join(this.logDir, relPath);
    if (!fs.existsSync(fullPath)) return;

    try {
      const stats = fs.statSync(fullPath);
      let offset = this.fileOffsets.get(fullPath);

      // On first run, only read the last 8 KB
      if (offset === undefined) {
        offset = Math.max(0, stats.size - 8192);
      } else if (stats.size < offset) {
        // File rotated
        offset = 0;
      }

      if (stats.size > offset) {
        const toRead = stats.size - offset;
        const buf = Buffer.alloc(toRead);
        const fd = fs.openSync(fullPath, 'r');
        fs.readSync(fd, buf, 0, toRead, offset);
        fs.closeSync(fd);

        this.fileOffsets.set(fullPath, stats.size);

        const text = buf.toString('utf8');
        const lines = text.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          this.storage.addLog({
            containerName: sourceTag,
            source: sourceTag,
            stream: 'stdout',
            message: trimmed,
            timestamp: lineTime(trimmed), // when it was written (it used to be the time the agent read it)
          });
        }
      }
    } catch (e) {
      // File permission / read error
    }
  }

  harvestDmesg() {
    // Kernel errors (OOM kills, disk errors). dmesg prints its whole recent buffer every time, so only lines not
    // seen before are added; before, the same 20 lines were added again every 10 s and filled the 10,000-line buffer.
    exec('dmesg -T --level=err,crit,alert,emerg 2>/dev/null | tail -n 50', (err, stdout) => {
      if (err || !stdout) return;
      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || this.dmesgSeen.has(trimmed)) continue;
        this.dmesgSeen.add(trimmed);
        if (this.dmesgSeen.size > 500) this.dmesgSeen.delete(this.dmesgSeen.values().next().value);
        this.storage.addLog({ containerName: 'kernel', source: 'kernel', stream: 'stderr', message: trimmed, level: 'error', timestamp: lineTime(trimmed) });
      }
    });
  }
}

module.exports = HostLogHarvester;
module.exports.lineTime = lineTime;
