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

// A `docker restart` emits die→…→restart. Hold a "Stopped/Crashed" alert this long so a following
// `restart` event can cancel it — otherwise a restart looks like Stop-then-Restart (two alerts).
const DIE_DEBOUNCE_MS = 3000;

class Monitor {
  constructor() {
    this.docker = new Docker({ socketPath: cfg.socketPath });
    this.stream = null;
    this.cooldowns = new Map(); // (label:event_type:resourceKey) → last_sent timestamp
    this.pendingDie = new Map(); // containerId → timer (debounced die alert, cancelled by a restart)
    this.pendingStart = new Map(); // containerId → timer (debounced start alert, cancelled by a restart)
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
    for (const t of this.pendingDie.values()) { try { clearTimeout(t); } catch (e) {} }
    this.pendingDie.clear();
    for (const t of this.pendingStart.values()) { try { clearTimeout(t); } catch (e) {} }
    this.pendingStart.clear();
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

  // Tail recent container logs (the WHY behind a failure). Best-effort — returns '' on any error.
  async _tailLogs(containerId, lines = 40) {
    if (!containerId) return '';
    try {
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

    // Container die — Docker emits 'die' on every exit (crash, manual stop, OOM).
    // We don't listen for 'stop' separately: it fires before 'die' and would double-count.
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
            html: templates.containerOomTemplate({ containerName: name, containerId: id, image, time, server: LABEL, logs }),
            telegramText: telegram.formatAlert(`${prefix}OOM Kill`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }) + telegram.formatLogs(logs),
          };
        } else {
          const verb = unexpected ? 'Crashed' : 'Stopped';
          eventType = 'container_die';
          payload = {
            subject: `${prefix}Container ${verb}: ${name}`,
            html: templates.containerDieTemplate({ containerName: name, containerId: id, image, time, exitCode: exitCode ?? '—', unexpected, server: LABEL, logs }),
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

      const logs = await this._tailLogs(event.Actor?.ID);
      await this._sendNotification('container_unhealthy', name, {
        subject: `${prefix}Container Unhealthy: ${name}`,
        html: templates.containerUnhealthyTemplate({ containerName: name, containerId: id, image, time, failingStreak, lastOutput, server: LABEL, logs }),
        telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: image, 'Failing Streak': failingStreak, Time: time }) + telegram.formatLogs(logs),
      });
    }

    // Container started — debounced, because a `docker restart` also fires start (die→…→start→restart);
    // the restart handler cancels it so a restart isn't reported as Started + Restarted.
    if (event.Type === 'container' && event.Action === 'start') {
      const scid = event.Actor?.ID;
      const startPayload = {
        subject: `${prefix}Container Started: ${name}`,
        html: templates.containerLifecycleTemplate({ title: 'Container Started', message: `Container <strong>${name}</strong> has started.`, containerName: name, containerId: id, image, time, server: LABEL }),
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
        html: templates.containerLifecycleTemplate({ title: 'Container Paused', message: `Container <strong>${name}</strong> was paused.`, containerName: name, containerId: id, image, time, server: LABEL }),
        telegramText: telegram.formatAlert(`${prefix}Container Paused`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
      });
    }

    // Container unpaused (resumed)
    if (event.Type === 'container' && event.Action === 'unpause') {
      await this._sendNotification('container_unpause', name, {
        subject: `${prefix}Container Resumed: ${name}`,
        html: templates.containerLifecycleTemplate({ title: 'Container Resumed', message: `Container <strong>${name}</strong> was unpaused (resumed).`, containerName: name, containerId: id, image, time, server: LABEL }),
        telegramText: telegram.formatAlert(`${prefix}Container Resumed`, { ...(serverDetail || {}), Container: name, Image: image, Time: time }),
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
            server: LABEL,
            logs,
          }),
          telegramText: telegram.formatAlert(`${prefix}Container Unhealthy`, { ...(serverDetail || {}), Container: name, Image: c.Image, 'Failing Streak': failingStreak }) + telegram.formatLogs(logs),
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

// Demultiplex Docker's multiplexed log stream (8-byte frame headers) into plain text.
// Copied from server/docker.js demuxLogs so the agent stays dependency-free.
function demuxLogs(buffer) {
  if (typeof buffer === 'string') return buffer;
  const lines = [];
  let offset = 0;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  while (offset < buf.length) {
    if (offset + 8 > buf.length) { lines.push(buf.slice(offset).toString('utf8')); break; }
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) { lines.push(buf.slice(offset + 8).toString('utf8')); break; }
    lines.push(buf.slice(offset + 8, offset + 8 + size).toString('utf8'));
    offset += 8 + size;
  }
  return lines.join('');
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
