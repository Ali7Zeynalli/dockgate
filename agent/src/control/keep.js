// Keep running: a Compose service that should always run. Its config is kept while a replica runs; if every replica
// is stopped they are started again, if they were removed one is made again from the kept config — the same name,
// ports, environment, limits, networks and volumes. Used by the Edge agent and, without one, by DockGate.
// Two checks in a row before acting, so a deploy or a restart in between is not mistaken for a loss.
const ex = require('./executor');

const SNAP_EVERY_MS = 10 * 60 * 1000;
const STARTABLE = ['exited', 'created', 'dead'];

/**
 * One check of one service. state: { short: {key: n}, snaps: {key: { at, inspect }} } (kept by the caller).
 * target: how many replicas must run (at least 1). Returns { action, ok, container, reason } or null.
 */
async function keepAlive({ docker, project, service, target = 1, state, now = Date.now() }) {
  const key = `${project}/${service}`;
  state.short = state.short || {}; state.snaps = state.snaps || {};
  const all = await ex.replicasOf(docker, project, service, { all: true });
  const running = all.filter(r => r.state === 'running');
  if (running.length) { // keep the config fresh while one runs
    const s = state.snaps[key];
    if (!s || now - s.at > SNAP_EVERY_MS || s.inspect.Id !== running[0].id) {
      const inspect = await docker.getContainer(running[0].id).inspect().catch(() => null);
      if (inspect) state.snaps[key] = { at: now, inspect };
    }
  }
  if (running.length >= target) { delete state.short[key]; return null; }
  if (all.some(r => r.state === 'restarting' || r.state === 'removing')) return null; // on its way
  state.short[key] = (state.short[key] || 0) + 1;
  if (state.short[key] < 2) return null;
  delete state.short[key];
  // stopped replicas: start them
  const stopped = all.filter(r => STARTABLE.includes(r.state)).slice(0, target - running.length);
  if (stopped.length) {
    for (const r of stopped) await docker.getContainer(r.id).start().catch(() => {});
    return { action: 'start', ok: true, container: stopped.map(r => r.name).join(', '), reason: `${stopped.length} stopped replica${stopped.length === 1 ? '' : 's'} started` };
  }
  // some still run: copy one (as Compose would for another replica, without the host ports)
  if (running.length) {
    const used = new Set(all.map(r => r.number)); let n = 1; while (used.has(n)) n++;
    const made = await ex.cloneReplica(docker, running[0].id, project, service, n);
    return { action: 'add', ok: true, container: made.name, reason: `${running.length} of ${target} replicas ran` };
  }
  // none left: make it again from the kept config
  const snap = state.snaps[key];
  if (!snap) return { action: 'recreate', ok: false, reason: 'every replica is gone and no config was kept yet (it is kept while one runs)' };
  const src = snap.inspect;
  const number = Number((src.Config.Labels || {})['com.docker.compose.container-number']) || 1;
  try {
    const made = await ex.cloneReplica(docker, src, project, service, number, { keepPorts: true, name: String(src.Name || '').replace(/^\//, '') || undefined });
    return { action: 'recreate', ok: true, container: made.name, reason: 'it was removed — made again from its kept config' };
  } catch (e) { return { action: 'recreate', ok: false, reason: e.message.split('\n')[0] }; }
}

module.exports = { keepAlive };
