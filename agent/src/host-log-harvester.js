const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class HostLogHarvester {
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.intervalMs = opts.intervalMs || 10000;
    this.logDir = fs.existsSync('/host/var/log') ? '/host/var/log' : '/var/log';
    this.fileOffsets = new Map(); // filePath -> byte offset
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
            timestamp: Date.now(),
          });
        }
      }
    } catch (e) {
      // File permission / read error
    }
  }

  harvestDmesg() {
    // Collect OOM and kernel alerts from dmesg
    exec('dmesg -T --level=err,crit,alert,emerg 2>/dev/null | tail -n 20', (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          this.storage.addLog({
            containerName: 'kernel',
            source: 'kernel',
            stream: 'stderr',
            message: trimmed,
            level: 'error',
            timestamp: Date.now(),
          });
        }
      }
    });
  }
}

module.exports = HostLogHarvester;
