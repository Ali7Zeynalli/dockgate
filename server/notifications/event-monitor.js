// Per-server Docker event monitor — watches one Docker daemon's events
// Multiple instances run simultaneously (one per registered server) so notifications
// arrive for incidents on any host, not just the active one.

const { stmts } = require('../db');
const mailer = require('./mailer');
const telegram = require('./telegram');
const templates = require('./templates');

// A `docker restart` emits die→…→restart. Hold a "Stopped/Crashed" alert this long so a following
// `restart` event can cancel it — otherwise a restart looks like Stop-then-Restart (two alerts).
const DIE_DEBOUNCE_MS = 3000;

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
    this.pendingDie = new Map(); // containerId → timer (debounced die alert, cancelled by a restart)
    this.pendingStart = new Map(); // containerId → timer (debounced start alert, cancelled by a restart)
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
    for (const t of this.pendingDie.values()) { try { clearTimeout(t); } catch (e) {} }
    this.pendingDie.clear();
    for (const t of this.pendingStart.values()) { try { clearTimeout(t); } catch (e) {} }
    this.pendingStart.clear();
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

    // cooldown_minutes === 0 means "no throttle — send every occurrence". (`|| 5` used to turn 0 back
    // into 5, so consecutive events of the same type were silently dropped.)
    const cd = rule.cooldown_minutes == null ? 5 : Number(rule.cooldown_minutes);
    if (!(cd > 0)) return false;
    return (Date.now() - lastSent) < cd * 60 * 1000;
  }

  _markSent(eventType, resourceKey = '') {
    this.cooldowns.set(this._cooldownKey(eventType, resourceKey), Date.now());
  }

  // Tail recent container logs (the WHY behind a failure). Best-effort — returns '' on any error.
  async _tailLogs(containerId, lines = 40) {
    if (!containerId) return '';
    try {
      const { demuxLogs } = require('../docker');
      const buf = await this.docker.getContainer(containerId).logs({ stdout: true, stderr: true, tail: lines, timestamps: false, follow: false });
      const text = demuxLogs(buf) || '';
      return text.length > 6000 ? text.slice(-6000) : text;
    } catch (e) { return ''; }
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

    // Container die — Docker emits a 'die' event on every exit (crash, manual stop, OOM).
    // We don't listen for 'stop' separately: it fires before 'die' and would double-count the same event.
    if (event.Type === 'container' && event.Action === 'die') {
      const exitCode = attrs.exitCode;
      // "Unexpected" only for a non-zero exit code — exit 0 is a clean/intentional stop.
      const unexpected = exitCode !== undefined && exitCode !== '0' && exitCode !== 0;
      const cid = event.Actor?.ID;

      // Build + send the death alert LAZILY (logs fetched only when the debounce fires). Keeping the
      // log-fetch out of the synchronous path is what lets the debounce work: pendingDie is set with
      // NO prior await, so a concurrent `restart` handler reliably finds and cancels it.
      const send = async () => {
        const logs = (exitCode === '137' || unexpected) ? await this._tailLogs(cid) : '';
        let eventType, payload;
        if (exitCode === '137') {
          eventType = 'container_oom';
          payload = {
            subject: `${prefix}OOM Kill: ${name}`,
            html: templates.containerOomTemplate({ containerName: name, containerId: id, image, time, server: this.serverId, logs }),
            telegramText: telegram.formatAlert(`${prefix}OOM Kill`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }) + telegram.formatLogs(logs),
          };
        } else {
          const verb = unexpected ? 'Crashed' : 'Stopped';
          eventType = 'container_die';
          payload = {
            subject: `${prefix}Container ${verb}: ${name}`,
            html: templates.containerDieTemplate({ containerName: name, containerId: id, image, time, exitCode: exitCode ?? '—', unexpected, server: this.serverId, logs }),
            telegramText: telegram.formatAlert(`${prefix}Container ${verb}`, { ...(serverDetail || {}), Container: name, Image: image, 'Exit Code': exitCode ?? '—', Time: time }) + telegram.formatLogs(logs),
          };
        }
        await this._sendNotification(eventType, name, payload);
      };

      // Debounce: a `docker restart` fires die→…→restart (an unresponsive container is SIGKILLed=137).
      // Hold the alert; the restart handler cancels it so one restart isn't reported as Stop+Restart.
      if (cid) {
        if (this.pendingDie.has(cid)) clearTimeout(this.pendingDie.get(cid));
        this.pendingDie.set(cid, setTimeout(() => { this.pendingDie.delete(cid); send(); }, DIE_DEBOUNCE_MS));
      } else {
        await send();
      }
    }

    // Container restart
    if (event.Type === 'container' && event.Action === 'restart') {
      // Cancel the pending "Stopped/Crashed" + "Started" alerts from the die/start events that
      // preceded this restart (a `docker restart` fires die→…→start→restart).
      const rcid = event.Actor?.ID;
      if (rcid && this.pendingDie.has(rcid)) { clearTimeout(this.pendingDie.get(rcid)); this.pendingDie.delete(rcid); }
      if (rcid && this.pendingStart.has(rcid)) { clearTimeout(this.pendingStart.get(rcid)); this.pendingStart.delete(rcid); }
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

      const logs = await this._tailLogs(event.Actor?.ID);
      await this._sendNotification('container_unhealthy', name, {
        subject: `${prefix}Container Unhealthy: ${name}`,
        html: templates.containerUnhealthyTemplate({ containerName: name, containerId: id, image, time, failingStreak, lastOutput, server: this.serverId, logs }),
        telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: image, 'Failing Streak': failingStreak, Time: time }) + telegram.formatLogs(logs),
      });
    }

    // Container started — debounced, because a `docker restart` also fires start (die→…→start→restart);
    // the restart handler cancels it so a restart isn't reported as Started + Restarted.
    if (event.Type === 'container' && event.Action === 'start') {
      const scid = event.Actor?.ID;
      const startPayload = {
        subject: `${prefix}Container Started: ${name}`,
        html: templates.containerLifecycleTemplate({ title: 'Container Started', message: `Container <strong>${name}</strong> has started.`, containerName: name, containerId: id, image, time, server: this.serverId }),
        telegramText: telegram.formatAlert(`${prefix}Container Started`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
      };
      if (scid) {
        if (this.pendingStart.has(scid)) clearTimeout(this.pendingStart.get(scid));
        this.pendingStart.set(scid, setTimeout(() => { this.pendingStart.delete(scid); this._sendNotification('container_start', name, startPayload); }, DIE_DEBOUNCE_MS));
      } else {
        await this._sendNotification('container_start', name, startPayload);
      }
    }

    // Container paused
    if (event.Type === 'container' && event.Action === 'pause') {
      await this._sendNotification('container_pause', name, {
        subject: `${prefix}Container Paused: ${name}`,
        html: templates.containerLifecycleTemplate({ title: 'Container Paused', message: `Container <strong>${name}</strong> was paused.`, containerName: name, containerId: id, image, time, server: this.serverId }),
        telegramText: telegram.formatAlert(`${prefix}Container Paused`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
      });
    }

    // Container unpaused (resumed)
    if (event.Type === 'container' && event.Action === 'unpause') {
      await this._sendNotification('container_unpause', name, {
        subject: `${prefix}Container Resumed: ${name}`,
        html: templates.containerLifecycleTemplate({ title: 'Container Resumed', message: `Container <strong>${name}</strong> was unpaused (resumed).`, containerName: name, containerId: id, image, time, server: this.serverId }),
        telegramText: telegram.formatAlert(`${prefix}Container Resumed`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
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

        const logs = await this._tailLogs(c.Id);
        await this._sendNotification('container_unhealthy', name, {
          subject: `${prefix}Container Unhealthy: ${name}`,
          html: templates.containerUnhealthyTemplate({
            containerName: name,
            containerId: c.Id?.substring(0, 12) || '',
            image: c.Image || '',
            time: fmtTime(Date.now()),
            failingStreak,
            lastOutput,
            server: this.serverId,
            logs,
          }),
          telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: c.Image, 'Failing Streak': failingStreak }) + telegram.formatLogs(logs),
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

      // thresholdGB is an ABSOLUTE size limit on what Docker uses (NOT a disk-fullness percentage).
      // Previously the GB/50GB ratio was shown as a "percent" and was misleading — now it's in absolute GB.
      const thresholdGB = 50;
      const usedGB = totalUsed / (1024 * 1024 * 1024);

      if (usedGB > thresholdGB) {
        const prefix = this._prefix();
        const serverDetail = this._serverDetail();
        await this._sendNotification('disk_threshold', this.serverId, {
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
            server: this.serverId,
          }),
          telegramText: telegram.formatAlert(`${prefix}Disk Usage Alert`, { ...(serverDetail || {}), Used: formatBytes(totalUsed), Threshold: thresholdGB + ' GB' }),
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

// Format a time for notifications in the user-selected timezone (settings.timezone).
// The container runs in UTC; Intl converts correctly regardless of the host TZ.
// 'auto' (or unset) falls back to the container/process timezone.
function fmtTime(date) {
  try {
    const tz = stmts.getSetting.get('timezone')?.value;
    return new Date(date).toLocaleString('en-US', (tz && tz !== 'auto') ? { timeZone: tz } : {});
  } catch (e) {
    return new Date(date).toLocaleString('en-US');
  }
}

module.exports = EventMonitor;
