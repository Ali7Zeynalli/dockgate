// Compose Auto Scaling — one loop for both executors: the Edge agent (also while DockGate is offline) and DockGate
// (on servers without an up-to-date agent). It measures each service that has a rule, decides with the same rule as
// Swarm (scale-decision.js), only adds what the server has room for, and changes replicas only through the
// whitelisted executor, so the limits are checked there again.
//   off       nothing
//   suggest   writes what it would do; a person applies it
//   simulate  the first 24 h after Auto is turned on: writes "would scale", changes nothing
//   auto      changes the replicas, one service at a time, never while the project is being deployed
const ex = require('./executor');
const { decideHost } = require('./scale-decision');
const { measureService } = require('./measure');

const KEEP_MS = 65 * 60 * 1000;

class Scaler {
  /**
   * opts: { docker, readCap: () => Promise<cap>, everyMs, notify(text), record(entry), onChange(project, service, to),
   *         state: persisted object (samples, last, full, suggested) }
   */
  constructor(opts) {
    Object.assign(this, opts);
    const s = this.state;
    for (const k of ['samples', 'last', 'full', 'suggested', 'nolimit']) s[k] = s[k] || {};
  }

  /** One round over the rules ({ projects: { p: { s: { min, max, auto: {...} } } } }). busy(project) → skip it. */
  async tick(rules, now = Date.now(), busy = async () => false) {
    const out = [];
    let cap = null;
    for (const [project, svcs] of Object.entries((rules && rules.projects) || {})) {
      const auto = Object.entries(svcs).filter(([, r]) => r.auto && r.auto.mode && r.auto.mode !== 'off');
      if (!auto.length) continue;
      if (await busy(project).catch(() => true)) continue;
      for (const [service, r] of auto) {
        const key = `${project}/${service}`;
        const m = await measureService(this.docker, project, service).catch(() => null);
        if (!m) continue;
        if (!m.lim.cpu && !m.lim.mem) { // the rule needs a limit to mean anything
          if (!this.state.nolimit[key]) { this.state.nolimit[key] = true; out.push(this.write({ mode: 'off', project, service, from: m.replicas, to: m.replicas, ok: false, reason: 'no CPU or memory limit on the running containers — nothing to measure against' })); }
          continue;
        }
        delete this.state.nolimit[key];
        const buf = (this.state.samples[key] = (this.state.samples[key] || []).filter(x => now - x.t < KEEP_MS));
        buf.push({ t: now, cpu: m.cpu, cpuMin: m.cpuMin, cpuMax: m.cpuMax, mem: m.mem, memMin: m.memMin, memMax: m.memMax });
        const rule = { ...r.auto, min: r.min ?? r.auto.min, max: Math.min(ex.MAX_REPLICAS, r.max ?? r.auto.max) };
        cap = cap || await this.readCap().catch(() => ({ cpu: 1, mem: 0, memAvail: null, load: null }));
        const d = decideHost(rule, buf, m.replicas, now, this.state.last[key] || {}, cap, m.lim, this.everyMs);
        if (!d) { delete this.state.full[key]; continue; }
        if (d.action === 'full') {
          if (!this.state.full[key]) { // once per episode
            this.state.full[key] = true;
            out.push(this.write({ mode: 'full', project, service, from: m.replicas, to: m.replicas, ok: false, reason: d.reason }));
            await this.notify(`⚠️ ${key} needs more replicas, but the server is full: ${d.reason}`).catch(() => {});
          }
          continue;
        }
        delete this.state.full[key];
        const mode = r.auto.mode === 'auto' && r.auto.simulateUntil && now < r.auto.simulateUntil ? 'simulate' : r.auto.mode;
        if (mode === 'suggest') {
          const sig = `${m.replicas}>${d.to}`;
          if (this.state.suggested[key] !== sig) { this.state.suggested[key] = sig; out.push(this.write({ mode, project, service, from: m.replicas, to: d.to, ok: true, reason: d.reason })); }
          continue;
        }
        if (mode === 'simulate') { // as if it had acted: the same waits, so the log reads like the real thing would
          this.state.last[key] = { at: now, dir: d.action };
          out.push(this.write({ mode, project, service, from: m.replicas, to: d.to, ok: true, reason: d.reason }));
          continue;
        }
        // auto
        const action = d.action === 'up' ? 'add-replica' : 'remove-replica';
        let n = m.replicas, err = null;
        while (n !== d.to) {
          const res = await ex.execute(action, { project, service }, { docker: this.docker, rules }).catch(e => ({ ok: false, reason: e.message }));
          if (!res.ok) { err = res.reason; break; }
          n += d.action === 'up' ? 1 : -1;
        }
        this.state.last[key] = { at: now, dir: d.action };
        delete this.state.suggested[key];
        out.push(this.write({ mode, project, service, from: m.replicas, to: n, ok: !err, reason: err ? `${d.reason} — stopped at ${n}: ${err}` : d.reason }));
        if (n !== m.replicas) {
          await this.onChange(project, service, n);
          await this.notify(`${d.action === 'up' ? '📈' : '📉'} ${key}: ${m.replicas} → ${n} replicas — ${d.reason}`).catch(() => {});
        }
        break; // one change per project per round
      }
    }
    return out;
  }

  write(e) { const entry = { t: Date.now(), kind: 'autoscale', ...e }; this.record(entry); return entry; }
}

/** Only the known shape and limits of an Auto Scaling rule (both sides call it). */
function cleanAuto(a) {
  if (!a || typeof a !== 'object' || !['off', 'suggest', 'auto'].includes(a.mode)) return undefined;
  const int = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);
  const out = {
    mode: a.mode, min: int(a.min, 1, ex.MAX_REPLICAS, 1), max: int(a.max, 1, ex.MAX_REPLICAS, 3),
    cpuUp: int(a.cpuUp, 10, 100, 75), cpuDown: int(a.cpuDown, 1, 90, 25), memUp: int(a.memUp, 10, 100, null), memDown: int(a.memDown, 1, 90, null),
    logic: a.logic === 'and' ? 'and' : 'or', basis: a.basis === 'every' ? 'every' : 'average', step: int(a.step, 1, 5, 1),
    upMinutes: int(a.upMinutes, 1, 30, 5), downMinutes: int(a.downMinutes, 2, 60, 10), coolUpMinutes: int(a.coolUpMinutes, 1, 60, 3), coolDownMinutes: int(a.coolDownMinutes, 1, 60, 10),
    simulateUntil: int(a.simulateUntil, 0, 8.64e15, 0),
  };
  if (out.max < out.min) out.max = out.min;
  return out;
}

module.exports = { Scaler, cleanAuto };
