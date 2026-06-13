// Single config source — REPLACES every DB read in the ported modules.
// All values come from container ENV injected by DockGate at deploy time.
// (Panel reads these from the smtp_config / notification_rules tables; the agent has no DB.)

// Default notification rules, copied verbatim from server/db.js:189-196
// (event_type → cooldown_minutes), all enabled by default.
const DEFAULT_RULES = {
  container_die:       { enabled: true, cooldown_minutes: 5,  description: 'Container stopped or died' },
  container_restart:   { enabled: true, cooldown_minutes: 5,  description: 'Container restarted' },
  container_oom:       { enabled: true, cooldown_minutes: 5,  description: 'Container killed by OOM (out of memory)' },
  container_unhealthy: { enabled: true, cooldown_minutes: 10, description: 'Container health check failing' },
  disk_threshold:      { enabled: true, cooldown_minutes: 30, description: 'Disk usage exceeds threshold' },
  build_failed:        { enabled: true, cooldown_minutes: 5,  description: 'Image build failed' },
};

// RULES_JSON env: { event_type: { enabled, cooldown_minutes } } — merged over the defaults.
// Invalid / empty → defaults. Keeps the panel's per-rule toggles honored when re-pushed.
function parseRules(raw) {
  const merged = {};
  let overrides = {};
  if (raw) {
    try { overrides = JSON.parse(raw) || {}; }
    catch (e) { console.warn('[agent] RULES_JSON invalid — using defaults'); overrides = {}; }
  }
  for (const [key, def] of Object.entries(DEFAULT_RULES)) {
    const o = overrides[key] || {};
    merged[key] = {
      enabled: o.enabled !== undefined ? !!o.enabled : def.enabled,
      cooldown_minutes: Number.isFinite(Number(o.cooldown_minutes)) ? Number(o.cooldown_minutes) : def.cooldown_minutes,
      description: def.description,
    };
  }
  return merged;
}

const env = process.env;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const telegram = { token: env.TG_TOKEN || '', chatId: env.TG_CHAT_ID || '' };
telegram.isConfigured = !!(telegram.token && telegram.chatId);

const smtp = {
  host: env.SMTP_HOST || '',
  port: num(env.SMTP_PORT, 587),
  from: env.SMTP_FROM || '',
  to:   env.SMTP_TO || '',
  user: env.SMTP_USER || undefined,
  pass: env.SMTP_PASS || undefined,
};
smtp.isConfigured = !!(smtp.host && smtp.port && smtp.from && smtp.to);

const cfg = {
  telegram,
  smtp,
  serverLabel: env.SERVER_LABEL || 'server',
  timezone: env.TIMEZONE || 'auto',
  diskThresholdGb: num(env.DISK_THRESHOLD_GB, 50),
  rules: parseRules(env.RULES_JSON),
  intervals: {
    diskMs:      num(env.DISK_POLL_MIN, 5) * 60 * 1000,
    healthMs:    num(env.HEALTH_POLL_SEC, 60) * 1000,
    reconnectMs: num(env.RECONNECT_SEC, 5) * 1000,
  },
  healthPort: num(env.AGENT_HEALTH_PORT, 9000),
  socketPath: env.DOCKER_SOCKET || '/var/run/docker.sock',
};

// Drop-in for stmts.getRule.get(eventType) → { enabled, cooldown_minutes }
function getRule(eventType) { return cfg.rules[eventType]; }

module.exports = { cfg, getRule };
