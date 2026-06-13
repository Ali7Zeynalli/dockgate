// Docker event watcher — PORT of server/notifications/event-monitor.js for a single host.
// Talks to the LOCAL (read-only-mounted) socket; every stmts.* DB call is replaced by cfg/getRule;
// this.serverId becomes cfg.serverLabel; the hardcoded 50GB disk threshold becomes cfg.diskThresholdGb;
// timezone + intervals come from cfg. Classification logic (die→OOM/Crash/Stop, restart, unhealthy,
// periodic unhealthy + disk sweeps, cooldowns) is preserved exactly.

const Docker = require('dockerode');
const { cfg, getRule } = require('./config');
const mailer = require('./mailer');
const telegram = require('./telegram');
const templates = require('./templates');

const LABEL = cfg.serverLabel;

class Monitor {
  constructor() {
    this.docker = new Docker({ socketPath: cfg.socketPath });
    this.stream = null;
    this.cooldowns = new Map(); // (label:event_type:resourceKey) → last_sent timestamp
    this.reconnectTimer = null;
    this.diskCheckTimer = null;
    this.healthCheckTimer = null;
    this.stopped = false;
    this.lastEventAt = null;
  }

  start() {
    this.stopped = false;
    this._startEventStream();
    this.diskCheckTimer = setInterval(() => this.checkDiskThreshold(), cfg.intervals.diskMs);
    this.healthCheckTimer = setInterval(() => this._checkUnhealthy(), cfg.intervals.healthMs);
    console.log(`[agent:${LABEL}] started`);
  }

  stop() {
    this.stopped = true;
    if (this.stream) { try { this.stream.destroy(); } catch (e) {} this.stream = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.diskCheckTimer) { clearInterval(this.diskCheckTimer); this.diskCheckTimer = null; }
    if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = null; }
    console.log(`[agent:${LABEL}] stopped`);
  }

  // The agent always runs on a specific (non-local) host, so it is always prefixed.
  _prefix() { return `[${LABEL}] `; }
  _serverDetail() { return { Server: LABEL }; }

  _startEventStream() {
    if (this.stream) { try { this.stream.destroy(); } catch (e) {} this.stream = null; }
    if (this.stopped) return;

    this.docker.getEvents({}, (err, stream) => {
      if (this.stopped) {
        if (stream) try { stream.destroy(); } catch (e) {}
        return;
      }
      if (err) {
        console.error(`[agent:${LABEL}] failed to connect:`, err.message);
        this._scheduleReconnect();
        return;
      }

      this.stream = stream;

      stream.on('data', (chunk) => {
        this.lastEventAt = Date.now();
        try {
          const event = JSON.parse(chunk.toString());
          this._handleEvent(event);
        } catch (e) { /* ignore parse errors */ }
      });

      stream.on('error', (e) => {
        console.error(`[agent:${LABEL}] stream error:`, e.message);
        this._scheduleReconnect();
      });

      stream.on('end', () => {
        if (!this.stopped) {
          console.log(`[agent:${LABEL}] stream ended, reconnecting...`);
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
    }, cfg.intervals.reconnectMs);
  }

  _cooldownKey(eventType, resourceKey = '') {
    return `${LABEL}:${eventType}:${resourceKey}`;
  }

  _isThrottled(eventType, resourceKey = '') {
    const key = this._cooldownKey(eventType, resourceKey);
    const lastSent = this.cooldowns.get(key);
    if (!lastSent) return false;

    const rule = getRule(eventType);
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
    const time = fmtTime(event.time * 1000);
    const prefix = this._prefix();
    const serverDetail = this._serverDetail();

    // Container die — Docker emits 'die' on every exit (crash, manual stop, OOM).
    // We don't listen for 'stop' separately: it fires before 'die' and would double-count.
    if (event.Type === 'container' && event.Action === 'die') {
      const exitCode = attrs.exitCode;

      // OOM kill — exitCode 137. Send only the OOM notification, then return.
      if (exitCode === '137') {
        await this._sendNotification('container_oom', name, {
          subject: `${prefix}OOM Kill: ${name}`,
          html: templates.containerOomTemplate({ containerName: name, containerId: id, image, time, server: LABEL }),
          telegramText: telegram.formatAlert(`${prefix}OOM Kill`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
        });
        return;
      }

      // "Unexpected" only for a non-zero exit code — exit 0 is a clean/intentional stop.
      const unexpected = exitCode !== undefined && exitCode !== '0' && exitCode !== 0;
      const verb = unexpected ? 'Crashed' : 'Stopped';

      await this._sendNotification('container_die', name, {
        subject: `${prefix}Container ${verb}: ${name}`,
        html: templates.containerDieTemplate({ containerName: name, containerId: id, image, time, exitCode: exitCode ?? '—', unexpected, server: LABEL }),
        telegramText: telegram.formatAlert(`${prefix}Container ${verb}`, { ...(serverDetail || {}), Container: name, Image: image, 'Exit Code': exitCode ?? '—', Time: time }),
      });
    }

    // Container restart
    if (event.Type === 'container' && event.Action === 'restart') {
      let restartCount = '—';
      try {
        const info = await this.docker.getContainer(event.Actor?.ID).inspect();
        restartCount = info.RestartCount || 0;
      } catch (e) {}

      await this._sendNotification('container_restart', name, {
        subject: `${prefix}Container Restarted: ${name}`,
        html: templates.containerRestartTemplate({ containerName: name, containerId: id, image, time, restartCount, server: LABEL }),
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
      } catch (e) {}

      await this._sendNotification('container_unhealthy', name, {
        subject: `${prefix}Container Unhealthy: ${name}`,
        html: templates.containerUnhealthyTemplate({ containerName: name, containerId: id, image, time, failingStreak, lastOutput, server: LABEL }),
        telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: image, 'Failing Streak': failingStreak, Time: time }),
      });
    }
  }

  // Periodic check for unhealthy containers (catches missed events)
  async _checkUnhealthy() {
    if (this.stopped) return;
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;
    const rule = getRule('container_unhealthy');
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
        } catch (e) {}

        await this._sendNotification('container_unhealthy', name, {
          subject: `${prefix}Container Unhealthy: ${name}`,
          html: templates.containerUnhealthyTemplate({
            containerName: name,
            containerId: c.Id?.substring(0, 12) || '',
            image: c.Image || '',
            time: fmtTime(Date.now()),
            failingStreak,
            lastOutput,
            server: LABEL,
          }),
          telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: c.Image, 'Failing Streak': failingStreak }),
        });
        break; // one notification per cycle, cooldown handles others
      }
    } catch (e) {
      // Daemon unreachable — silent
    }
  }

  async _sendNotification(eventType, resourceKey, { subject, html, telegramText }) {
    const rule = getRule(eventType);
    if (!rule || !rule.enabled) return;
    if (this._isThrottled(eventType, resourceKey)) return;

    let sent = false;

    if (mailer.isConfigured()) {
      const r = await mailer.sendEmail({ subject, html });
      if (r.success) sent = true;
    }
    if (telegram.isConfigured() && telegramText) {
      const r = await telegram.sendMessage({ text: telegramText });
      if (r.success) sent = true;
    }

    if (sent) this._markSent(eventType, resourceKey);
  }

  // Periodic disk usage check
  async checkDiskThreshold() {
    if (this.stopped) return;
    if (!mailer.isConfigured() && !telegram.isConfigured()) return;

    const rule = getRule('disk_threshold');
    if (!rule || !rule.enabled) return;
    if (this._isThrottled('disk_threshold', LABEL)) return;

    try {
      const diskUsage = await this.docker.df();

      const imagesSize = diskUsage.Images?.reduce((a, i) => a + (i.Size || 0), 0) || 0;
      const containersSize = diskUsage.Containers?.reduce((a, c) => a + (c.SizeRw || 0), 0) || 0;
      const volumesSize = diskUsage.Volumes?.reduce((a, v) => a + (v.UsageData?.Size || 0), 0) || 0;
      const cacheSize = diskUsage.BuildCache?.reduce((a, b) => a + (b.Size || 0), 0) || 0;
      const totalUsed = imagesSize + containersSize + volumesSize + cacheSize;

      const thresholdGB = cfg.diskThresholdGb;
      const usedGB = totalUsed / (1024 * 1024 * 1024);

      if (usedGB > thresholdGB) {
        const prefix = this._prefix();
        const serverDetail = this._serverDetail();
        await this._sendNotification('disk_threshold', LABEL, {
          subject: `${prefix}Disk Usage Alert: ${formatBytes(totalUsed)} used (threshold ${thresholdGB} GB)`,
          html: templates.diskAlertTemplate({
            usedSpace: formatBytes(totalUsed),
            usedGB: usedGB.toFixed(1),
            thresholdGB,
            breakdown: {
              images: formatBytes(imagesSize),
              containers: formatBytes(containersSize),
              volumes: formatBytes(volumesSize),
              buildCache: formatBytes(cacheSize),
            },
            server: LABEL,
          }),
          telegramText: telegram.formatAlert(`${prefix}Disk Usage Alert`, { ...(serverDetail || {}), Used: formatBytes(totalUsed), Threshold: thresholdGB + ' GB' }),
        });
      }
    } catch (e) {
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

// Format a time in the configured timezone (cfg.timezone). 'auto'/unset → container/UTC.
function fmtTime(date) {
  try {
    const tz = cfg.timezone;
    return new Date(date).toLocaleString('en-US', (tz && tz !== 'auto') ? { timeZone: tz } : {});
  } catch (e) {
    return new Date(date).toLocaleString('en-US');
  }
}

module.exports = Monitor;
