// Rolling update of one Compose service, without downtime. Compose itself makes each new replica
// (`up -d --no-deps --no-recreate --scale <svc>=N+1`: one more container with the current config, the running ones
// untouched); when it is ready (healthy, or running steadily without a health check) the proxies are reloaded and
// one old replica is stopped gracefully. Repeat until every replica is new. If the first new replica is not ready,
// it is removed and nothing old was touched.
const helpers = () => require('./routes/compose').composeHelpers;
const CS = () => require('./compose-scale');
const traffic = () => require('./compose-traffic');
const bad = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Can this service be updated replica by replica? { ok, why, replicas } */
async function canRoll(project, service) {
  const S = CS(), h = helpers();
  const c = require('./docker').docker;
  const reps = await S.replicasOf(c, project, service);
  if (!reps.length) return { ok: false, why: 'it is not running', replicas: 0 };
  const r = await h.resolveComposeFiles(project);
  if (!r.files || !r.files.length) return { ok: false, why: r.reason || 'compose files not found', replicas: reps.length };
  const s = ((await S.configOf(r, project)).services || {})[service];
  if (!s) return { ok: false, why: `no service ${service}`, replicas: reps.length };
  const chk = S.checkScalable(s, service, await S.composeVersion(r));
  if (!chk.ok) return { ok: false, why: chk.block, replicas: reps.length };
  const rule = S.readRules(require('./docker').getActiveServerId() || 'local', project)[service] || {};
  const missing = chk.fixes.filter(f => !rule[f]);
  if (missing.length) return { ok: false, why: missing.includes('dropPorts') ? 'it takes a host port, so a second copy can not start next to it (Scaling & health can move the port behind the proxy)' : 'it has a container_name, so a second copy can not start next to it (Scaling & health can drop it)', replicas: reps.length };
  return { ok: true, replicas: reps.length };
}

/** Wait until a new container is ready: healthy by its own check, or running for `steady` ms without restarting. */
async function waitReady(c, id, log, { timeoutMs = 180000, steadyMs = 10000 } = {}) {
  const start = Date.now();
  let since = null, restarts = null;
  while (Date.now() - start < timeoutMs) {
    const ct = await c.getContainer(id).inspect().catch(() => null);
    if (!ct) throw new Error('the new container is gone');
    const st = ct.State;
    if (st.Status === 'exited' || st.Status === 'dead') throw new Error(`the new container stopped (exit code ${st.ExitCode})`);
    if (restarts === null) restarts = ct.RestartCount;
    if (ct.RestartCount > restarts || st.Status === 'restarting') throw new Error('the new container keeps restarting');
    if (st.Health) {
      if (st.Health.Status === 'healthy') return 'healthy';
      if (st.Health.Status === 'unhealthy') throw new Error('the new container is unhealthy');
    } else if (st.Running) {
      since = since || Date.now();
      if (Date.now() - since >= steadyMs) return 'running';
    }
    await sleep(1000);
  }
  throw new Error(`the new container was not ready within ${Math.round(timeoutMs / 1000)} s`);
}

/**
 * Replace every replica of a service with a new one, one at a time. opts: { log, pull, sourceIp, record (default true) }.
 * Returns { replaced, ids } (ids: the new containers).
 */
async function rollout(project, service, opts = {}) {
  const S = CS(), h = helpers(), T = traffic();
  const log = opts.log || (() => {});
  if (!h.validateProjectName(project)) throw bad('Invalid project name');
  S.checkName(service, 'Service');
  if (h.busy(project)) throw bad('A deploy of this project is running — try again when it ends', 409);
  const can = await canRoll(project, service);
  if (!can.ok) throw bad(`${service} can not be updated without downtime: ${can.why}`, 409);
  const c = require('./docker').docker;
  const r = await h.resolveComposeFiles(project);
  const run = (args) => { log(`$ docker compose ${args.join(' ')}`); return h.runResolved(r, project, args, (d) => String(d).split('\n').filter(Boolean).forEach(l => log('  ' + l))); };
  const started = Date.now();
  if (opts.pull) await run(['pull', service]);
  const old = await S.replicasOf(c, project, service);
  const proxies = await T.findProxies(c, project).catch(() => []);
  const tested = await T.testProxies(c, proxies, log); // once: the reloads during the switch are then immediate
  const reload = () => T.reloadProxies(c, proxies, log, { tested });
  const fresh = [];
  try {
    for (let i = 0; i < old.length; i++) {
      const before = new Set((await S.replicasOf(c, project, service)).map(x => x.id));
      await run(['up', '-d', '--no-deps', '--no-recreate', '--scale', `${service}=${before.size + 1}`, service]);
      const made = (await S.replicasOf(c, project, service)).find(x => !before.has(x.id));
      if (!made) throw new Error('compose made no new replica');
      fresh.push(made.id);
      log(`  ${made.name}: started, waiting until it is ready…`);
      const how = await waitReady(c, made.id, log);
      log(`  ${made.name}: ${how === 'healthy' ? 'healthy' : 'running steadily'}`);
      await reload();
      log(`  replacing ${old[i].name} (${i + 1} of ${old.length})`);
      // Stop it gracefully, reload the proxies at once (its address is gone now), and only then remove it.
      const ct = await c.getContainer(old[i].id).inspect().catch(() => null);
      await c.getContainer(old[i].id).stop({ t: Math.max(1, (ct && ct.Config.StopTimeout) ?? 10) }).catch(() => {});
      log(`  ${old[i].name}: stopped gracefully`);
      await reload();
      await c.getContainer(old[i].id).remove({ force: true }).catch(() => {});
    }
  } catch (e) {
    const last = fresh[fresh.length - 1];
    if (last) { log(`✗ ${e.message} — removing the new replica`); await T.drainAndStop(c, [last], log).catch(() => {}); await reload().catch(() => {}); }
    const replaced = Math.max(0, fresh.length - 1);
    const msg = replaced ? `${service}: ${e.message} after ${replaced} of ${old.length} replicas were updated — the others still run the previous version` : `${service}: ${e.message} — nothing was changed, the previous replicas keep running`;
    if (opts.record !== false) h.recordDeploy({ project, kind: 'rollout', status: 'error', error: msg, sourceIp: opts.sourceIp, startedAt: started, finishedAt: Date.now(), details: { service, replicas: old.length, replaced } });
    throw Object.assign(bad(msg, 500), { replaced, kept: !replaced });
  }
  if (opts.record !== false) h.recordDeploy({ project, kind: 'rollout', status: 'done', sourceIp: opts.sourceIp, startedAt: started, finishedAt: Date.now(), details: { service, replicas: old.length } });
  try { require('./audit').logAction({ sourceIp: opts.sourceIp || 'dockgate', server: require('./docker').getActiveServerId() || 'local', resourceType: 'compose', resourceId: project, resourceName: `${project}/${service}`, action: 'compose_rollout', details: { replicas: old.length } }); } catch (e) { /* best effort */ }
  log(`✓ ${old.length} replica${old.length === 1 ? '' : 's'} of ${service} updated without downtime`);
  return { replaced: old.length, ids: fresh };
}

module.exports = { canRoll, waitReady, rollout };
