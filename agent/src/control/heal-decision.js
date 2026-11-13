// When to restart an unhealthy container — one rule for the agent and DockGate (which requires this file).
// history: { fails: consecutive failed checks, restarts: [timestamps], since: container start (ms) }
// rule: { healPerHour (default 3), rollback: bool, recentImageUpdate: bool, startPeriodMs (default 60000), failsNeeded (default 3) }
function healDecision(h, now, rule = {}) {
  const startPeriod = rule.startPeriodMs ?? 60000;
  const need = rule.failsNeeded ?? 3;
  const perHour = rule.healPerHour ?? 3;
  if (h.since && now - h.since < startPeriod) return 'wait';           // still starting
  if ((h.fails || 0) < need) return 'wait';                             // not yet consecutive enough
  const lastHour = (h.restarts || []).filter(t => now - t < 3600000).length;
  if (lastHour < perHour) return 'restart';
  return rule.rollback && rule.recentImageUpdate ? 'rollback' : 'stop'; // restarting does not help: stop and tell
}
module.exports = { healDecision };
