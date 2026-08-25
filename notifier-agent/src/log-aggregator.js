const { PassThrough } = require('stream');

class LogAggregator {
  constructor(docker, storage, notifier = {}, opts = {}) {
    this.docker = docker;
    this.storage = storage;
    this.notifier = notifier; // { telegram, mailer }
    this.streams = new Map(); // containerId -> stream
    this.errorCounts = new Map(); // containerName -> [timestamps]
    this.stopped = false;
    this.pollTimer = null;
  }

  start() {
    this.stopped = false;
    this.syncActiveContainers();
    this.pollTimer = setInterval(() => this.syncActiveContainers(), 15000);
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [id, stream] of this.streams.entries()) {
      try { stream.destroy(); } catch (e) {}
    }
    this.streams.clear();
  }

  async syncActiveContainers() {
    if (this.stopped) return;
    try {
      const running = await this.docker.listContainers({ all: false });
      const currentIds = new Set(running.map(c => c.Id));

      // Clean up stopped streams
      for (const [id, stream] of this.streams.entries()) {
        if (!currentIds.has(id)) {
          try { stream.destroy(); } catch (e) {}
          this.streams.delete(id);
        }
      }

      // Attach new streams
      for (const c of running) {
        if (!this.streams.has(c.Id)) {
          this.attachContainerLogs(c);
        }
      }
    } catch (e) {
      // Docker socket error
    }
  }

  async attachContainerLogs(containerInfo) {
    if (this.stopped) return;
    const cid = containerInfo.Id;
    const cname = (containerInfo.Names && containerInfo.Names[0] ? containerInfo.Names[0] : cid).replace(/^\//, '');

    // Skip agent container itself to avoid log loops
    if (cname.includes('dockgate-notifier') || cname.includes('dockgate-agent')) return;

    try {
      const container = this.docker.getContainer(cid);
      const sinceSec = Math.floor((Date.now() - 30000) / 1000); // last 30s
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        since: sinceSec,
      });

      this.streams.set(cid, logStream);

      let buffer = Buffer.alloc(0);

      logStream.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Docker multiplex header format: 8 bytes [STREAM_TYPE, 0, 0, 0, SIZE_3, SIZE_2, SIZE_1, SIZE_0]
        while (buffer.length >= 8) {
          const streamType = buffer[0]; // 1 = stdout, 2 = stderr
          const streamName = streamType === 2 ? 'stderr' : 'stdout';
          const size = buffer.readUInt32BE(4);

          if (buffer.length < 8 + size) {
            break; // wait for more data
          }

          const frame = buffer.slice(8, 8 + size);
          buffer = buffer.slice(8 + size);

          this.processLogLine(cid, cname, streamName, frame.toString('utf8'));
        }
      });

      logStream.on('error', () => {
        try { logStream.destroy(); } catch (e) {}
        this.streams.delete(cid);
      });

      logStream.on('end', () => {
        this.streams.delete(cid);
      });
    } catch (e) {
      // Container might have stopped before log attach
    }
  }

  processLogLine(containerId, containerName, stream, text) {
    if (!text || !text.trim()) return;

    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      let timestamp = Date.now();
      let message = line;

      // Extract Docker RFC3339 timestamp prefix if present (e.g. 2026-08-25T01:23:45.678901234Z message)
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/);
      if (tsMatch) {
        const parsed = Date.parse(tsMatch[1]);
        if (!isNaN(parsed)) timestamp = parsed;
        message = tsMatch[2];
      }

      const logItem = {
        timestamp,
        containerId: containerId.slice(0, 12),
        containerName,
        stream,
        message,
      };

      this.storage.addLog(logItem);

      // Error Anomaly Spike Detection
      if (logItem.level === 'error') {
        this.trackErrorSpike(containerName, message);
      }
    }
  }

  trackErrorSpike(containerName, sampleMsg) {
    const now = Date.now();
    let timestamps = this.errorCounts.get(containerName) || [];
    timestamps = timestamps.filter(t => now - t <= 60000); // last 60s
    timestamps.push(now);
    this.errorCounts.set(containerName, timestamps);

    // If more than 30 errors in 60s, emit spike notification once per 5 minutes
    if (timestamps.length === 30) {
      const tg = this.notifier.telegram;
      if (tg && tg.isConfigured) {
        tg.sendMessage({
          text: `🚨 <b>High Error Spike on [${containerName}]</b>\n\n` +
                `Over 30 errors detected in the last 60 seconds.\n` +
                `<b>Sample:</b> <code>${sampleMsg.slice(0, 160)}</code>`,
        }).catch(() => {});
      }
    }
  }
}

module.exports = LogAggregator;
