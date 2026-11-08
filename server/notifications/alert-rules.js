// Server-health alert rules — pure logic, no I/O, so it can be unit tested.
//
// A rule has shared limits (notification_rules.params, JSON). A server can keep them ('default'), use its
// own ('custom', alert_overrides.params) or turn the rule off ('off'). evaluate() takes one sample of a
// server (reachable or not, CPU / memory / disk) plus the remembered state and returns the alerts that are
// due. Quiet periods (cooldowns) are applied by the sender, not here.

// Limits each rule accepts: [min, max] per field.
const LIMITS = {
  server_down: { minutes: [1, 120] },
  server_up: {},
  host_disk: { percent: [50, 99] },
  host_mem: { percent: [50, 100], minutes: [1, 120] },
  host_cpu: { percent: [50, 100], minutes: [1, 240] },
  disk_threshold: { gb: [1, 100000] },
};
const HEALTH_TYPES = ['server_down', 'server_up', 'host_disk', 'host_mem', 'host_cpu'];
const MODES = ['default', 'custom', 'off'];

function parseJson(s, fallback = {}) {
  if (s && typeof s === 'object') return s;
  try { const v = JSON.parse(s || ''); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
}

/** Clean user input for a rule's limits; throws with a readable message when a value is out of range. */
function validateParams(type, params) {
  const spec = LIMITS[type];
  if (!spec) throw new Error(`This rule has no limits to set (${type})`);
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(spec)) {
    const raw = params ? params[k] : undefined;
    if (raw === undefined || raw === null || raw === '') throw new Error(`${k} is required`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
    out[k] = Math.round(n);
  }
  return out;
}

/** What applies on one server: { on, params, source } from the shared rule and the server's override. */
function effective(rule, override) {
  if (!rule) return { on: false, params: {}, source: 'missing' };
  const shared = parseJson(rule.params);
  const mode = override && MODES.includes(override.mode) ? override.mode : 'default';
  if (!rule.enabled) return { on: false, params: shared, source: 'shared-off' };
  if (mode === 'off') return { on: false, params: shared, source: 'off' };
  if (mode === 'custom') return { on: true, params: { ...shared, ...parseJson(override.params) }, source: 'custom' };
  return { on: true, params: shared, source: 'default' };
}

const fullestDisk = (disks) => (disks || []).reduce((a, d) => (!a || (d.usePct || 0) > (a.usePct || 0) ? d : a), null);

/**
 * One step. sample: { ok, error?, cpu?, memPct?, disks? }. state is the per-server memory returned by the
 * previous call ({} the first time). rules: { type: effective(...) }. Returns { state, alerts: [{ type, data }] }.
 */
function evaluate(state, sample, now, rules) {
  const st = { ...(state || {}) };
  const alerts = [];
  const on = (t) => rules[t] && rules[t].on;
  const p = (t) => (rules[t] && rules[t].params) || {};

  if (!sample.ok) {
    if (!st.failSince) st.failSince = now;
    st.lastError = sample.error || 'no answer';
    const mins = Number(p('server_down').minutes) || 3;
    if (on('server_down') && !st.down && now - st.failSince >= mins * 60000) {
      st.down = true;
      st.downSince = st.failSince;
      alerts.push({ type: 'server_down', data: { since: st.failSince, error: st.lastError, last: st.last || null } });
    }
    // Resource timers restart once the server answers again.
    st.memSince = null; st.cpuSince = null;
    return { state: st, alerts };
  }

  if (st.down) {
    if (on('server_up')) alerts.push({ type: 'server_up', data: { since: st.downSince, until: now } });
    st.down = false; st.downSince = null;
  }
  st.failSince = null; st.lastError = null;
  st.last = { cpu: sample.cpu, memPct: sample.memPct, diskPct: (fullestDisk(sample.disks) || {}).usePct };

  // Disk: the fullest disk above the limit (one reading is enough — disks do not fill and empty in a minute).
  const d = fullestDisk(sample.disks);
  if (on('host_disk') && d && d.usePct >= Number(p('host_disk').percent)) {
    alerts.push({ type: 'host_disk', data: { disk: d, limit: Number(p('host_disk').percent) } });
  }

  // Memory and CPU: above the limit for the whole period.
  for (const [type, key, val] of [['host_mem', 'memSince', sample.memPct], ['host_cpu', 'cpuSince', sample.cpu]]) {
    const lim = Number(p(type).percent), mins = Number(p(type).minutes) || 5;
    if (!on(type) || val == null || !(val >= lim)) { st[key] = null; continue; }
    if (!st[key]) st[key] = now;
    if (now - st[key] >= mins * 60000) alerts.push({ type, data: { value: val, limit: lim, minutes: mins } });
  }
  return { state: st, alerts };
}

module.exports = { LIMITS, HEALTH_TYPES, MODES, parseJson, validateParams, effective, evaluate, fullestDisk };
