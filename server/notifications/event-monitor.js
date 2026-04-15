// Docker event monitor — watches events and sends notifications
const dockerService = require('../docker');
const { stmts } = require('../db');
const mailer = require('./mailer');
const telegram = require('./telegram');
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
    // Health check every 60 seconds
    this.healthCheckTimer = setInterval(() => this._checkUnhealthy(), 60 * 1000);
    console.log('[EventMonitor] Started — watching Docker events');
  }

  stop() {
    if (this.stream) { try { this.stream.destroy(); } catch(e) {} this.stream = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.diskCheckTimer) { clearInterval(this.diskCheckTimer); this.diskCheckTimer = null; }
    if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = null; }
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
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;
    if (!event.Type || !event.Action) return;

    const attrs = event.Actor?.Attributes || {};
    const name = attrs.name || event.Actor?.ID?.substring(0, 12) || 'unknown';
    const id = event.Actor?.ID?.substring(0, 12) || '';
    const image = attrs.image || '';
    const time = new Date(event.time * 1000).toLocaleString();

    // Container die/stop events
    if (event.Type === 'container' && (event.Action === 'die' || event.Action === 'stop')) {
      const exitCode = attrs.exitCode;

      // OOM kill — exitCode 137
      if (exitCode === '137') {
        await this._sendNotification('container_oom', {
          subject: `OOM Kill: ${name}`,
          html: templates.containerOomTemplate({ containerName: name, containerId: id, image, time }),
          telegramText: telegram.formatAlert('OOM Kill', { Container: name, Image: image, Time: time }),
        });
      }

      // Container died
      await this._sendNotification('container_die', {
        subject: `Container Stopped: ${name}`,
        html: templates.containerDieTemplate({ containerName: name, containerId: id, image, time, exitCode: exitCode ?? '—' }),
        telegramText: telegram.formatAlert('Container Stopped', { Container: name, Image: image, 'Exit Code': exitCode ?? '—', Time: time }),
      });
    }

    // Container restart event
    if (event.Type === 'container' && event.Action === 'restart') {
      let restartCount = '—';
      try {
        const info = await dockerService.docker.getContainer(event.Actor?.ID).inspect();
        restartCount = info.RestartCount || 0;
      } catch(e) {}

      await this._sendNotification('container_restart', {
        subject: `Container Restarted: ${name}`,
        html: templates.containerRestartTemplate({ containerName: name, containerId: id, image, time, restartCount }),
        telegramText: telegram.formatAlert('Container Restarted', { Container: name, Image: image, Restarts: restartCount, Time: time }),
      });
    }

    // Container health_status events (unhealthy)
    if (event.Type === 'container' && event.Action === 'health_status: unhealthy') {
      let failingStreak = '—';
      let lastOutput = '';
      try {
        const info = await dockerService.docker.getContainer(event.Actor?.ID).inspect();
        const health = info.State?.Health;
        if (health) {
          failingStreak = health.FailingStreak || '—';
          const lastLog = health.Log?.[health.Log.length - 1];
          if (lastLog) lastOutput = lastLog.Output?.substring(0, 500) || '';
        }
      } catch(e) {}

      await this._sendNotification('container_unhealthy', {
        subject: `Container Unhealthy: ${name}`,
        html: templates.containerUnhealthyTemplate({ containerName: name, containerId: id, image, time, failingStreak, lastOutput }),
        telegramText: telegram.formatAlert('Container Unhealthy', { Container: name, Image: image, 'Failing Streak': failingStreak, Time: time }),
      });
    }
  }

  // Periodic check for unhealthy containers (catches cases where health_status event is missed)
  async _checkUnhealthy() {
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;
    const rule = stmts.getRule.get('container_unhealthy');
    if (!rule || !rule.enabled) return;
    if (this._isThrottled('container_unhealthy')) return;

    try {
      const containers = await dockerService.docker.listContainers({ filters: { health: ['unhealthy'] } });
      if (containers.length === 0) return;

      for (const c of containers) {
        const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.substring(0, 12);
        let failingStreak = '—', lastOutput = '';
        try {
          const info = await dockerService.docker.getContainer(c.Id).inspect();
          const health = info.State?.Health;
          if (health) {
            failingStreak = health.FailingStreak || '—';
            const lastLog = health.Log?.[health.Log.length - 1];
            if (lastLog) lastOutput = lastLog.Output?.substring(0, 500) || '';
          }
        } catch(e) {}

        await this._sendNotification('container_unhealthy', {
          subject: `Container Unhealthy: ${name}`,
          html: templates.containerUnhealthyTemplate({
            containerName: name,
            containerId: c.Id?.substring(0, 12) || '',
            image: c.Image || '',
            time: new Date().toLocaleString(),
            failingStreak,
            lastOutput,
          }),
          telegramText: telegram.formatAlert('Container Unhealthy', { Container: name, Image: c.Image, 'Failing Streak': failingStreak }),
        });
        break; // only one notification per cycle (cooldown handles the rest)
      }
    } catch(e) {
      // Docker unreachable — ignore
    }
  }

  async _sendNotification(eventType, { subject, html, telegramText }) {
    // Check if rule is enabled
    const rule = stmts.getRule.get(eventType);
    if (!rule || !rule.enabled) return;

    // Check throttle
    if (this._isThrottled(eventType)) return;

    let sent = false;

    // Send email
    if (mailer.isConfigured()) {
      const result = await mailer.sendEmail({ subject, html, eventType });
      if (result.success) sent = true;
    }

    // Send Telegram
    if (telegram.isConfigured() && telegramText) {
      const result = await telegram.sendMessage({ text: telegramText, eventType });
      if (result.success) sent = true;
    }

    if (sent) {
      this.cooldowns.set(eventType, Date.now());
    }
  }

  // Called from build handler when build fails
  async triggerBuildFailed({ imageTag, buildId, error, duration }) {
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;

    await this._sendNotification('build_failed', {
      subject: `Build Failed: ${imageTag || 'untagged'}`,
      html: templates.buildFailTemplate({ imageTag, buildId, error, duration }),
      telegramText: telegram.formatAlert('Build Failed', { Image: imageTag || 'untagged', 'Build ID': buildId, Error: error?.substring(0, 200) }),
    });
  }

  // Periodic disk usage check
  async checkDiskThreshold() {
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;

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
          telegramText: telegram.formatAlert('Disk Usage Alert', { Used: formatBytes(totalUsed), Threshold: thresholdGB + ' GB', Usage: usagePercent + '%' }),
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
