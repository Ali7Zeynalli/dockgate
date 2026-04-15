// Docker event monitor — watches events and sends email notifications
const dockerService = require('../docker');
const { stmts } = require('../db');
const mailer = require('./mailer');
const templates = require('./templates');

class EventMonitor {
  constructor() {
    this.stream = null;
    this.cooldowns = new Map(); // event_type → last_sent timestamp
    this.reconnectTimer = null;
    this.diskCheckTimer = null;
  }

  start() {
    this._startEventStream();
    // Disk threshold check every 5 minutes
    this.diskCheckTimer = setInterval(() => this.checkDiskThreshold(), 5 * 60 * 1000);
    console.log('[EventMonitor] Started — watching Docker events');
  }

  stop() {
    if (this.stream) { try { this.stream.destroy(); } catch(e) {} this.stream = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.diskCheckTimer) { clearInterval(this.diskCheckTimer); this.diskCheckTimer = null; }
  }

  _startEventStream() {
    if (this.stream) { try { this.stream.destroy(); } catch(e) {} this.stream = null; }

    dockerService.docker.getEvents({}, (err, stream) => {
      if (err) {
        console.error('[EventMonitor] Failed to connect:', err.message);
        this._scheduleReconnect();
        return;
      }

      this.stream = stream;

      stream.on('data', (chunk) => {
        try {
          const event = JSON.parse(chunk.toString());
          this._handleEvent(event);
        } catch(e) { /* ignore parse errors */ }
      });

      stream.on('error', (err) => {
        console.error('[EventMonitor] Stream error:', err.message);
        this._scheduleReconnect();
      });

      stream.on('end', () => {
        console.log('[EventMonitor] Stream ended, reconnecting...');
        this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._startEventStream();
    }, 5000);
  }

  _isThrottled(eventType) {
    const lastSent = this.cooldowns.get(eventType);
    if (!lastSent) return false;

    const rule = stmts.getRule.get(eventType);
    if (!rule) return false;

    const cooldownMs = (rule.cooldown_minutes || 5) * 60 * 1000;
    return (Date.now() - lastSent) < cooldownMs;
  }

  async _handleEvent(event) {
    if (!mailer.isConfigured()) return;
    if (!event.Type || !event.Action) return;

    // Container die/stop events
    if (event.Type === 'container' && (event.Action === 'die' || event.Action === 'stop')) {
      const attrs = event.Actor?.Attributes || {};
      const exitCode = attrs.exitCode;

      // OOM kill — exitCode 137
      if (exitCode === '137') {
        await this._sendNotification('container_oom', {
          subject: `OOM Kill: ${attrs.name || event.Actor?.ID?.substring(0, 12)}`,
          html: templates.containerOomTemplate({
            containerName: attrs.name || 'unknown',
            containerId: event.Actor?.ID?.substring(0, 12) || '',
            image: attrs.image || '',
            time: new Date(event.time * 1000).toLocaleString(),
          }),
        });
      }

      // Container died
      await this._sendNotification('container_die', {
        subject: `Container Stopped: ${attrs.name || event.Actor?.ID?.substring(0, 12)}`,
        html: templates.containerDieTemplate({
          containerName: attrs.name || 'unknown',
          containerId: event.Actor?.ID?.substring(0, 12) || '',
          image: attrs.image || '',
          time: new Date(event.time * 1000).toLocaleString(),
          exitCode: exitCode ?? '—',
        }),
      });
    }
  }

  async _sendNotification(eventType, { subject, html }) {
    // Check if rule is enabled
    const rule = stmts.getRule.get(eventType);
    if (!rule || !rule.enabled) return;

    // Check throttle
    if (this._isThrottled(eventType)) return;

    const result = await mailer.sendEmail({ subject, html, eventType });
    if (result.success) {
      this.cooldowns.set(eventType, Date.now());
    }
  }

  // Called from build handler when build fails
  async triggerBuildFailed({ imageTag, buildId, error, duration }) {
    if (!mailer.isConfigured()) return;

    await this._sendNotification('build_failed', {
      subject: `Build Failed: ${imageTag || 'untagged'}`,
      html: templates.buildFailTemplate({ imageTag, buildId, error, duration }),
    });
  }

  // Periodic disk usage check
  async checkDiskThreshold() {
    if (!mailer.isConfigured()) return;

    const rule = stmts.getRule.get('disk_threshold');
    if (!rule || !rule.enabled) return;
    if (this._isThrottled('disk_threshold')) return;

    try {
      const diskUsage = await dockerService.getDiskUsage();
      const systemInfo = await dockerService.getSystemInfo();

      // Calculate total Docker disk usage
      const imagesSize = diskUsage.Images?.reduce((a, i) => a + (i.Size || 0), 0) || 0;
      const containersSize = diskUsage.Containers?.reduce((a, c) => a + (c.SizeRw || 0), 0) || 0;
      const volumesSize = diskUsage.Volumes?.reduce((a, v) => a + (v.UsageData?.Size || 0), 0) || 0;
      const cacheSize = diskUsage.BuildCache?.reduce((a, b) => a + (b.Size || 0), 0) || 0;
      const totalUsed = imagesSize + containersSize + volumesSize + cacheSize;

      // Use system memory as rough disk reference, or fall back to total used * percentage estimation
      // In practice, we check if Docker data root partition usage is high
      // Simple approach: alert if total Docker usage > threshold GB
      const thresholdGB = 50; // Default 50GB threshold
      const usedGB = totalUsed / (1024 * 1024 * 1024);

      if (usedGB > thresholdGB) {
        const usagePercent = Math.round((usedGB / thresholdGB) * 100);
        await this._sendNotification('disk_threshold', {
          subject: `Disk Usage Alert: ${formatBytes(totalUsed)} used`,
          html: templates.diskAlertTemplate({
            usagePercent: Math.min(usagePercent, 100),
            totalSpace: thresholdGB + ' GB (threshold)',
            usedSpace: formatBytes(totalUsed),
            threshold: thresholdGB,
          }),
        });
      }
    } catch(e) {
      console.error('[EventMonitor] Disk check failed:', e.message);
    }
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = EventMonitor;
