const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class MetricsCollector {
  constructor(docker, storage, opts = {}) {
    this.docker = docker;
    this.storage = storage;
    this.intervalMs = opts.intervalMs || 10000; // 10s default
    this.procPath = fs.existsSync('/host/proc') ? '/host/proc' : '/proc';
    this.sysPath = fs.existsSync('/host/sys') ? '/host/sys' : '/sys';
    this.timer = null;
    this.prevCpu = null;
    this.prevNet = null;
    this.prevNetTime = 0;
  }

  start() {
    this.collect(); // immediate first collect
    this.timer = setInterval(() => this.collect(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async collect() {
    try {
      const now = Date.now();
      const hostStats = await this.getHostStats(now);
      const containerStats = await this.getContainerStats();

      this.storage.addMetricsSample({
        timestamp: now,
        host: hostStats,
        containers: containerStats,
      });
    } catch (e) {
      // Non-blocking collection error
    }
  }

  // ---- HOST METRICS PARSING ----

  readProcFile(filename) {
    try {
      return fs.readFileSync(path.join(this.procPath, filename), 'utf8');
    } catch (e) {
      return '';
    }
  }

  getHostStats(now) {
    return new Promise((resolve) => {
      // 1. CPU
      const statTxt = this.readProcFile('stat');
      let cpuPercent = 0;
      const cpuLine = (statTxt || '').split('\n').find(l => /^cpu\s/.test(l));
      if (cpuLine) {
        const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
        const idle = (parts[3] || 0) + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + (b || 0), 0);
        if (this.prevCpu) {
          const dt = total - this.prevCpu.total;
          const di = idle - this.prevCpu.idle;
          if (dt > 0) cpuPercent = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 1000) / 10));
        }
        this.prevCpu = { idle, total };
      }

      // 2. Memory
      const memTxt = this.readProcFile('meminfo');
      let memTotalBytes = 0, memAvailBytes = 0, memUsedBytes = 0, memPercent = 0;
      if (memTxt) {
        const m = {};
        for (const l of memTxt.split('\n')) {
          const match = l.match(/^(\w+):\s+(\d+)/);
          if (match) m[match[1]] = parseInt(match[2], 10) * 1024;
        }
        memTotalBytes = m.MemTotal || 0;
        memAvailBytes = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0);
        memUsedBytes = Math.max(0, memTotalBytes - memAvailBytes);
        if (memTotalBytes > 0) memPercent = Math.round((memUsedBytes / memTotalBytes) * 1000) / 10;
      }

      // 3. Load
      const loadTxt = this.readProcFile('loadavg');
      let load1 = 0;
      if (loadTxt) {
        load1 = parseFloat(loadTxt.trim().split(/\s+/)[0]) || 0;
      }

      // 4. Network
      const netTxt = this.readProcFile('net/dev');
      let netRxBytesSec = 0, netTxBytesSec = 0;
      if (netTxt) {
        let rxTotal = 0, txTotal = 0;
        for (const line of netTxt.split('\n')) {
          const match = line.match(/^\s*([\w@.:-]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
          if (match && match[1] !== 'lo') {
            rxTotal += parseInt(match[2], 10) || 0;
            txTotal += parseInt(match[3], 10) || 0;
          }
        }
        if (this.prevNet && this.prevNetTime > 0) {
          const dtSec = Math.max(0.5, (now - this.prevNetTime) / 1000);
          netRxBytesSec = Math.max(0, Math.round((rxTotal - this.prevNet.rx) / dtSec));
          netTxBytesSec = Math.max(0, Math.round((txTotal - this.prevNet.tx) / dtSec));
        }
        this.prevNet = { rx: rxTotal, tx: txTotal };
        this.prevNetTime = now;
      }

      // 5. Disk df
      exec('df -B1 / 2>/dev/null', (err, stdout) => {
        let diskTotalBytes = 0, diskUsedBytes = 0, diskPercent = 0;
        if (!err && stdout) {
          const lines = stdout.trim().split('\n');
          if (lines.length >= 2) {
            const cols = lines[1].trim().split(/\s+/);
            diskTotalBytes = parseInt(cols[1], 10) || 0;
            diskUsedBytes = parseInt(cols[2], 10) || 0;
            if (diskTotalBytes > 0) diskPercent = Math.round((diskUsedBytes / diskTotalBytes) * 1000) / 10;
          }
        }

        resolve({
          cpuPercent,
          memPercent,
          memUsedBytes,
          memTotalBytes,
          diskPercent,
          diskUsedBytes,
          diskTotalBytes,
          netRxBytesSec,
          netTxBytesSec,
          load1,
        });
      });
    });
  }

  // ---- PER-CONTAINER METRICS VIA DOCKERODE ----

  async getContainerStats() {
    const out = {};
    try {
      const containers = await this.docker.listContainers({ all: false });
      const fetches = containers.map(async (c) => {
        try {
          const name = (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, '');
          // Exclude the dockgate-agent container itself if desired or keep it lightweight
          const containerObj = this.docker.getContainer(c.Id);
          const stats = await containerObj.stats({ stream: false });

          // Calculate CPU %
          let cpuPercent = 0;
          const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
          const systemDelta = (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
          const numCpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

          if (systemDelta > 0 && cpuDelta > 0) {
            cpuPercent = Math.round(((cpuDelta / systemDelta) * numCpus * 100) * 10) / 10;
          }

          // Calculate Memory
          const memUsed = Math.max(0, (stats.memory_stats?.usage || 0) - (stats.memory_stats?.stats?.cache || 0));
          const memLimit = stats.memory_stats?.limit || 1;
          const memPercent = Math.round((memUsed / memLimit) * 1000) / 10;

          // Calculate Network
          let netRx = 0, netTx = 0;
          if (stats.networks) {
            for (const n of Object.values(stats.networks)) {
              netRx += n.rx_bytes || 0;
              netTx += n.tx_bytes || 0;
            }
          }

          out[name] = {
            id: c.Id.slice(0, 12),
            cpuPercent: Math.min(100 * numCpus, Math.max(0, cpuPercent)),
            memUsedBytes: memUsed,
            memPercent: Math.min(100, Math.max(0, memPercent)),
            netRxSec: netRx,
            netTxSec: netTx,
          };
        } catch (e) {
          // Individual container stats read timeout / container stopping
        }
      });

      await Promise.all(fetches);
    } catch (e) {
      // List containers error
    }
    return out;
  }
}

module.exports = MetricsCollector;
