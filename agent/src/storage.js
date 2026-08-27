// In-memory time-series and circular log storage with downsampling retention.
// Zero dependencies, ultra-fast, capped memory footprint (<20 MB).

class Storage {
  constructor(opts = {}) {
    this.maxLogs = opts.maxLogs || 10000;
    this.logs = []; // FIFO circular buffer of log objects

    // Metrics retention tiers:
    // Tier 1: Raw 10s samples -> 360 points (1 hour)
    this.rawSamples = [];
    // Tier 2: 1-minute downsampled -> 1440 points (24 hours)
    this.minuteSamples = [];
    // Tier 3: 15-minute downsampled -> 672 points (7 days)
    this.fifteenMinSamples = [];

    // Bucket accumulators for downsampling
    this._minuteBucket = [];
    this._fifteenMinBucket = [];
    this._lastMinuteTimestamp = 0;
    this._lastFifteenMinTimestamp = 0;
  }

  // ---- METRICS INGESTION ----

  addMetricsSample(sample) {
    const ts = sample.timestamp || Date.now();
    const point = {
      timestamp: ts,
      host: {
        cpu: sample.host?.cpuPercent ?? 0,
        memUsedBytes: sample.host?.memUsedBytes ?? 0,
        memTotalBytes: sample.host?.memTotalBytes ?? 0,
        memPercent: sample.host?.memPercent ?? 0,
        diskUsedBytes: sample.host?.diskUsedBytes ?? 0,
        diskTotalBytes: sample.host?.diskTotalBytes ?? 0,
        diskPercent: sample.host?.diskPercent ?? 0,
        netRxBytesSec: sample.host?.netRxBytesSec ?? 0,
        netTxBytesSec: sample.host?.netTxBytesSec ?? 0,
        load1: sample.host?.load1 ?? 0,
      },
      containers: sample.containers || {}, // { [name]: { cpuPercent, memUsedBytes, memPercent, netRxSec, netTxSec } }
    };

    // 1. Add to raw 10s tier (keep last 360 points = 1 hour)
    this.rawSamples.push(point);
    if (this.rawSamples.length > 360) this.rawSamples.shift();

    // 2. Accumulate for 1-minute downsampling
    this._minuteBucket.push(point);
    if (ts - this._lastMinuteTimestamp >= 60000) {
      if (this._minuteBucket.length > 0) {
        const avgPoint = this._aggregatePoints(this._minuteBucket, ts);
        this.minuteSamples.push(avgPoint);
        if (this.minuteSamples.length > 1440) this.minuteSamples.shift(); // 24h
        this._minuteBucket = [];
      }
      this._lastMinuteTimestamp = ts;
    }

    // 3. Accumulate for 15-minute downsampling
    this._fifteenMinBucket.push(point);
    if (ts - this._lastFifteenMinTimestamp >= 15 * 60000) {
      if (this._fifteenMinBucket.length > 0) {
        const avgPoint = this._aggregatePoints(this._fifteenMinBucket, ts);
        this.fifteenMinSamples.push(avgPoint);
        if (this.fifteenMinSamples.length > 672) this.fifteenMinSamples.shift(); // 7 days
        this._fifteenMinBucket = [];
      }
      this._lastFifteenMinTimestamp = ts;
    }
  }

  _aggregatePoints(bucket, timestamp) {
    const count = bucket.length;
    if (count === 0) return { timestamp, host: {}, containers: {} };

    let cpuSum = 0, memPctSum = 0, memUsedSum = 0, memTotal = 0;
    let diskPctSum = 0, diskUsedSum = 0, diskTotal = 0;
    let netRxSum = 0, netTxSum = 0, load1Sum = 0;

    const contAgg = {}; // name -> { cpuSum, memUsedSum, memPctSum, netRxSum, netTxSum, count }

    for (const p of bucket) {
      cpuSum += p.host.cpu;
      memPctSum += p.host.memPercent;
      memUsedSum += p.host.memUsedBytes;
      memTotal = p.host.memTotalBytes;
      diskPctSum += p.host.diskPercent;
      diskUsedSum += p.host.diskUsedBytes;
      diskTotal = p.host.diskTotalBytes;
      netRxSum += p.host.netRxBytesSec;
      netTxSum += p.host.netTxBytesSec;
      load1Sum += p.host.load1;

      for (const [name, c] of Object.entries(p.containers || {})) {
        if (!contAgg[name]) contAgg[name] = { cpuSum: 0, memUsedSum: 0, memPctSum: 0, netRxSum: 0, netTxSum: 0, count: 0 };
        contAgg[name].cpuSum += c.cpuPercent || 0;
        contAgg[name].memUsedSum += c.memUsedBytes || 0;
        contAgg[name].memPctSum += c.memPercent || 0;
        contAgg[name].netRxSum += c.netRxSec || 0;
        contAgg[name].netTxSum += c.netTxSec || 0;
        contAgg[name].count += 1;
      }
    }

    const containers = {};
    for (const [name, ca] of Object.entries(contAgg)) {
      const cCount = ca.count || 1;
      containers[name] = {
        cpuPercent: Math.round((ca.cpuSum / cCount) * 10) / 10,
        memUsedBytes: Math.round(ca.memUsedSum / cCount),
        memPercent: Math.round((ca.memPctSum / cCount) * 10) / 10,
        netRxSec: Math.round(ca.netRxSum / cCount),
        netTxSec: Math.round(ca.netTxSum / cCount),
      };
    }

    return {
      timestamp,
      host: {
        cpu: Math.round((cpuSum / count) * 10) / 10,
        memPercent: Math.round((memPctSum / count) * 10) / 10,
        memUsedBytes: Math.round(memUsedSum / count),
        memTotalBytes: memTotal,
        diskPercent: Math.round((diskPctSum / count) * 10) / 10,
        diskUsedBytes: Math.round(diskUsedSum / count),
        diskTotalBytes: diskTotal,
        netRxBytesSec: Math.round(netRxSum / count),
        netTxBytesSec: Math.round(netTxSum / count),
        load1: Math.round((load1Sum / count) * 100) / 100,
      },
      containers,
    };
  }

  // ---- METRICS QUERY ----

  getMetrics({ range = '1h', container = '' } = {}) {
    let source = this.rawSamples;
    const now = Date.now();
    let cutoff = now - 3600000; // 1 hour default

    if (range === '6h') {
      source = this.minuteSamples;
      cutoff = now - 6 * 3600000;
    } else if (range === '24h') {
      source = this.minuteSamples;
      cutoff = now - 24 * 3600000;
    } else if (range === '7d') {
      source = this.fifteenMinSamples;
      cutoff = now - 7 * 86400000;
    }

    const filtered = source.filter(p => p.timestamp >= cutoff);
    const resultPoints = filtered.length > 0 ? filtered : (this.rawSamples.length > 0 ? this.rawSamples : []);

    const timestamps = [];
    const hostCpu = [], hostMem = [], hostDisk = [], hostNetRx = [], hostNetTx = [], hostLoad = [];
    const containerMetrics = {}; // [name] -> { cpu: [], mem: [] }

    for (const p of resultPoints) {
      timestamps.push(p.timestamp);
      hostCpu.push(p.host.cpu);
      hostMem.push(p.host.memPercent);
      hostDisk.push(p.host.diskPercent);
      hostNetRx.push(p.host.netRxBytesSec);
      hostNetTx.push(p.host.netTxBytesSec);
      hostLoad.push(p.host.load1);

      if (container && p.containers && p.containers[container]) {
        if (!containerMetrics[container]) containerMetrics[container] = { cpu: [], mem: [], memBytes: [] };
        containerMetrics[container].cpu.push(p.containers[container].cpuPercent || 0);
        containerMetrics[container].mem.push(p.containers[container].memPercent || 0);
        containerMetrics[container].memBytes.push(p.containers[container].memUsedBytes || 0);
      } else if (!container && p.containers) {
        for (const [cName, cStats] of Object.entries(p.containers)) {
          if (!containerMetrics[cName]) containerMetrics[cName] = { cpu: [], mem: [], memBytes: [] };
          containerMetrics[cName].cpu.push(cStats.cpuPercent || 0);
          containerMetrics[cName].mem.push(cStats.memPercent || 0);
          containerMetrics[cName].memBytes.push(cStats.memUsedBytes || 0);
        }
      }
    }

    const latest = resultPoints.length > 0 ? resultPoints[resultPoints.length - 1] : null;

    return {
      range,
      count: timestamps.length,
      timestamps,
      host: {
        cpu: hostCpu,
        memPercent: hostMem,
        diskPercent: hostDisk,
        netRxBytesSec: hostNetRx,
        netTxBytesSec: hostNetTx,
        load1: hostLoad,
        latest: latest ? latest.host : null,
      },
      containers: containerMetrics,
      latestContainers: latest ? latest.containers : {},
    };
  }

  // ---- LOGS INGESTION & QUERY ----

  addLog(entry) {
    const logItem = {
      id: entry.id || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp || Date.now(),
      containerId: entry.containerId || '',
      containerName: entry.containerName || 'system',
      source: entry.source || (entry.containerName === 'system' || entry.containerName === 'auth' || entry.containerName === 'nginx' || entry.containerName === 'kernel' ? entry.containerName : 'container'),
      stream: entry.stream || 'stdout', // 'stdout' | 'stderr'
      message: String(entry.message || '').trim(),
      level: entry.level || this._detectLogLevel(entry.message, entry.stream),
    };

    if (!logItem.message) return;

    this.logs.push(logItem);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  _detectLogLevel(msg, stream) {
    const lower = String(msg).toLowerCase();
    if (stream === 'stderr' || lower.includes('error') || lower.includes('fatal') || lower.includes('panic') || lower.includes('exception') || lower.includes('fail') || /\b5\d{2}\b/.test(msg)) {
      return 'error';
    }
    if (lower.includes('warn') || lower.includes('deprecated') || /\b4\d{2}\b/.test(msg)) {
      return 'warn';
    }
    if (lower.includes('debug') || lower.includes('trace')) {
      return 'debug';
    }
    return 'info';
  }

  getLogs({ container = '', source = '', level = '', search = '', limit = 100, since = 0 } = {}) {
    const term = search ? search.toLowerCase() : '';
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));

    let matched = this.logs;

    if (since > 0) {
      matched = matched.filter(l => l.timestamp >= since);
    }
    if (source) {
      matched = matched.filter(l => l.source === source);
    }
    if (container) {
      matched = matched.filter(l => l.containerName === container || l.containerId === container);
    }
    if (level && level !== 'all') {
      matched = matched.filter(l => l.level === level);
    }
    if (term) {
      matched = matched.filter(l => l.message.toLowerCase().includes(term));
    }

    const total = matched.length;
    const slice = matched.slice(-lim); // most recent logs

    // Compute error counts for the last 24h timeline
    const now = Date.now();
    const oneDayAgo = now - 24 * 3600000;
    const errorLogs24h = this.logs.filter(l => l.level === 'error' && l.timestamp >= oneDayAgo);

    return {
      total,
      returned: slice.length,
      logs: slice,
      errorCount24h: errorLogs24h.length,
      availableContainers: [...new Set(this.logs.map(l => l.containerName))],
    };
  }

  // Summary breakdown for host & containers
  getSummary() {
    const latestRaw = this.rawSamples.length > 0 ? this.rawSamples[this.rawSamples.length - 1] : null;
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const recentErrors = this.logs.filter(l => l.level === 'error' && l.timestamp >= oneHourAgo).length;

    const breakdown = [];
    if (latestRaw && latestRaw.containers) {
      for (const [name, stats] of Object.entries(latestRaw.containers)) {
        breakdown.push({
          name,
          cpuPercent: stats.cpuPercent || 0,
          memUsedBytes: stats.memUsedBytes || 0,
          memPercent: stats.memPercent || 0,
          netRxSec: stats.netRxSec || 0,
          netTxSec: stats.netTxSec || 0,
        });
      }
    }
    breakdown.sort((a, b) => b.cpuPercent - a.cpuPercent);

    return {
      host: latestRaw ? latestRaw.host : null,
      containersCount: breakdown.length,
      breakdown,
      recentErrors1h: recentErrors,
      totalBufferedLogs: this.logs.length,
      samplesCount: this.rawSamples.length,
    };
  }
}

module.exports = Storage;
