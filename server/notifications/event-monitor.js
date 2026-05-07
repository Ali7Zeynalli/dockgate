// Per-server Docker event monitor — watches one Docker daemon's events
// Multiple instances run simultaneously (one per registered server) so notifications
// arrive for incidents on any host, not just the active one.

const { stmts } = require('../db');
const mailer = require('./mailer');
const telegram = require('./telegram');
const templates = require('./templates');

class EventMonitor {
  /**
   * @param {string} serverId — 'local' or registered SSH server id
   * @param {Docker} docker — dedicated dockerode client for this server
   */
  constructor(serverId, docker) {
    this.serverId = serverId || 'local';
    this.docker = docker;
    this.stream = null;
    this.cooldowns = new Map(); // (event_type + resourceKey) → last_sent timestamp
    this.reconnectTimer = null;
    this.diskCheckTimer = null;
    this.healthCheckTimer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._startEventStream();
    this.diskCheckTimer = setInterval(() => this.checkDiskThreshold(), 5 * 60 * 1000);
    this.healthCheckTimer = setInterval(() => this._checkUnhealthy(), 60 * 1000);
    console.log(`[EventMonitor:${this.serverId}] Started`);
  }

  stop() {
    this.stopped = true;
    if (this.stream) { try { this.stream.destroy(); } catch(e) {} this.stream = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.diskCheckTimer) { clearInterval(this.diskCheckTimer); this.diskCheckTimer = null; }
    if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = null; }
    console.log(`[EventMonitor:${this.serverId}] Stopped`);
  }

  // Server-prefixed identifiers
  _prefix() { return this.serverId === 'local' ? '' : `[${this.serverId}] `; }
  _serverDetail() { return this.serverId === 'local' ? null : { Server: this.serverId }; }

  _startEventStream() {
    if (this.stream) { try { this.stream.destroy(); } catch(e) {} this.stream = null; }
    if (this.stopped) return;

    this.docker.getEvents({}, (err, stream) => {
      if (this.stopped) {
        if (stream) try { stream.destroy(); } catch(e) {}
        return;
      }
      if (err) {
        console.error(`[EventMonitor:${this.serverId}] Failed to connect:`, err.message);
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

      stream.on('error', (e) => {
        console.error(`[EventMonitor:${this.serverId}] Stream error:`, e.message);
        this._scheduleReconnect();
      });

      stream.on('end', () => {
        if (!this.stopped) {
          console.log(`[EventMonitor:${this.serverId}] Stream ended, reconnecting...`);
          this._scheduleReconnect();
        }
      });
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._startEventStream();
    }, 5000);
  }

  // Cooldown key includes serverId so the same event on different servers
  // doesn't suppress each other.
  _cooldownKey(eventType, resourceKey = '') {
    return `${this.serverId}:${eventType}:${resourceKey}`;
  }

  _isThrottled(eventType, resourceKey = '') {
    const key = this._cooldownKey(eventType, resourceKey);
    const lastSent = this.cooldowns.get(key);
    if (!lastSent) return false;

    const rule = stmts.getRule.get(eventType);
    if (!rule) return false;

    const cooldownMs = (rule.cooldown_minutes || 5) * 60 * 1000;
    return (Date.now() - lastSent) < cooldownMs;
  }

  _markSent(eventType, resourceKey = '') {
    this.cooldowns.set(this._cooldownKey(eventType, resourceKey), Date.now());
  }

  async _handleEvent(event) {
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;
    if (!event.Type || !event.Action) return;

    const attrs = event.Actor?.Attributes || {};
    const name = attrs.name || event.Actor?.ID?.substring(0, 12) || 'unknown';
    const id = event.Actor?.ID?.substring(0, 12) || '';
    const image = attrs.image || '';
    const time = new Date(event.time * 1000).toLocaleString();
    const prefix = this._prefix();
    const serverDetail = this._serverDetail();

    // Container die/stop events
    if (event.Type === 'container' && (event.Action === 'die' || event.Action === 'stop')) {
      const exitCode = attrs.exitCode;

      // OOM kill — exitCode 137
      if (exitCode === '137') {
        await this._sendNotification('container_oom', name, {
          subject: `${prefix}OOM Kill: ${name}`,
          html: templates.containerOomTemplate({ containerName: name, containerId: id, image, time, server: this.serverId }),
          telegramText: telegram.formatAlert(`${prefix}OOM Kill`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
        });
      }

      // Container died
      await this._sendNotification('container_die', name, {
        subject: `${prefix}Container Stopped: ${name}`,
        html: templates.containerDieTemplate({ containerName: name, containerId: id, image, time, exitCode: exitCode ?? '—', server: this.serverId }),
        telegramText: telegram.formatAlert(`${prefix}Container Stopped`, { ...(serverDetail || {}), Container: name, Image: image, 'Exit Code': exitCode ?? '—', Time: time }),
      });
    }

    // Container restart
    if (event.Type === 'container' && event.Action === 'restart') {
      let restartCount = '—';
      try {
        const info = await this.docker.getContainer(event.Actor?.ID).inspect();
        restartCount = info.RestartCount || 0;
      } catch(e) {}

      await this._sendNotification('container_restart', name, {
        subject: `${prefix}Container Restarted: ${name}`,
        html: templates.containerRestartTemplate({ containerName: name, containerId: id, image, time, restartCount, server: this.serverId }),
        telegramText: telegram.formatAlert(`${prefix}Container Restarted`, { ...(serverDetail || {}), Container: name, Image: image, Restarts: restartCount, Time: time }),
      });
    }

    // Container unhealthy (event-based)
    if (event.Type === 'container' && event.Action === 'health_status: unhealthy') {
      let failingStreak = '—', lastOutput = '';
      try {
        const info = await this.docker.getContainer(event.Actor?.ID).inspect();
        const health = info.State?.Health;
        if (health) {
          failingStreak = health.FailingStreak || '—';
          const lastLog = health.Log?.[health.Log.length - 1];
          if (lastLog) lastOutput = lastLog.Output?.substring(0, 500) || '';
        }
      } catch(e) {}

      await this._sendNotification('container_unhealthy', name, {
        subject: `${prefix}Container Unhealthy: ${name}`,
        html: templates.containerUnhealthyTemplate({ containerName: name, containerId: id, image, time, failingStreak, lastOutput, server: this.serverId }),
        telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: image, 'Failing Streak': failingStreak, Time: time }),
      });
    }
  }

  // Periodic check for unhealthy containers (catches missed events)
  async _checkUnhealthy() {
    if (this.stopped) return;
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;
    const rule = stmts.getRule.get('container_unhealthy');
    if (!rule || !rule.enabled) return;

    try {
      const containers = await this.docker.listContainers({ filters: { health: ['unhealthy'] } });
      if (containers.length === 0) return;

      const prefix = this._prefix();
      const serverDetail = this._serverDetail();

      for (const c of containers) {
        const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.substring(0, 12);
        if (this._isThrottled('container_unhealthy', name)) continue;

        let failingStreak = '—', lastOutput = '';
        try {
          const info = await this.docker.getContainer(c.Id).inspect();
          const health = info.State?.Health;
          if (health) {
            failingStreak = health.FailingStreak || '—';
            const lastLog = health.Log?.[health.Log.length - 1];
            if (lastLog) lastOutput = lastLog.Output?.substring(0, 500) || '';
          }
        } catch(e) {}

        await this._sendNotification('container_unhealthy', name, {
          subject: `${prefix}Container Unhealthy: ${name}`,
          html: templates.containerUnhealthyTemplate({
            containerName: name,
            containerId: c.Id?.substring(0, 12) || '',
            image: c.Image || '',
            time: new Date().toLocaleString(),
            failingStreak,
            lastOutput,
            server: this.serverId,
          }),
          telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: c.Image, 'Failing Streak': failingStreak }),
        });
        break; // one notification per cycle, cooldown handles others
      }
    } catch(e) {
      // Daemon unreachable — silent
    }
  }

  async _sendNotification(eventType, resourceKey, { subject, html, telegramText }) {
    const rule = stmts.getRule.get(eventType);
    if (!rule || !rule.enabled) return;
    if (this._isThrottled(eventType, resourceKey)) return;

    let sent = false;

    if (mailer.isConfigured()) {
      const r = await mailer.sendEmail({ subject, html, eventType });
      if (r.success) sent = true;
    }
    if (telegram.isConfigured() && telegramText) {
      const r = await telegram.sendMessage({ text: telegramText, eventType });
      if (r.success) sent = true;
    }

    if (sent) this._markSent(eventType, resourceKey);
  }

  // Build failure trigger — called from local build handler in server/index.js
  // Builds happen on local Docker, so this is local-only by design
  async triggerBuildFailed({ imageTag, buildId, error, duration }) {
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;

    await this._sendNotification('build_failed', imageTag || 'untagged', {
      subject: `Build Failed: ${imageTag || 'untagged'}`,
      html: templates.buildFailTemplate({ imageTag, buildId, error, duration }),
      telegramText: telegram.formatAlert('Build Failed', { Image: imageTag || 'untagged', 'Build ID': buildId, Error: error?.substring(0, 200) }),
    });
  }

  // Periodic disk usage check
  async checkDiskThreshold() {
    if (this.stopped) return;
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;

    const rule = stmts.getRule.get('disk_threshold');
    if (!rule || !rule.enabled) return;
    if (this._isThrottled('disk_threshold', this.serverId)) return;

    try {
      const diskUsage = await this.docker.df();

      const imagesSize = diskUsage.Images?.reduce((a, i) => a + (i.Size || 0), 0) || 0;
      const containersSize = diskUsage.Containers?.reduce((a, c) => a + (c.SizeRw || 0), 0) || 0;
      const volumesSize = diskUsage.Volumes?.reduce((a, v) => a + (v.UsageData?.Size || 0), 0) || 0;
      const cacheSize = diskUsage.BuildCache?.reduce((a, b) => a + (b.Size || 0), 0) || 0;
      const totalUsed = imagesSize + containersSize + volumesSize + cacheSize;

      const thresholdGB = 50;
      const usedGB = totalUsed / (1024 * 1024 * 1024);

      if (usedGB > thresholdGB) {
        const usagePercent = Math.round((usedGB / thresholdGB) * 100);
        const prefix = this._prefix();
        const serverDetail = this._serverDetail();
        await this._sendNotification('disk_threshold', this.serverId, {
          subject: `${prefix}Disk Usage Alert: ${formatBytes(totalUsed)} used`,
          html: templates.diskAlertTemplate({
            usagePercent: Math.min(usagePercent, 100),
            totalSpace: thresholdGB + ' GB (threshold)',
            usedSpace: formatBytes(totalUsed),
            threshold: thresholdGB,
            server: this.serverId,
          }),
          telegramText: telegram.formatAlert(`${prefix}Disk Usage Alert`, { ...(serverDetail || {}), Used: formatBytes(totalUsed), Threshold: thresholdGB + ' GB', Usage: usagePercent + '%' }),
        });
      }
    } catch(e) {
      // Daemon unreachable — silent
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
