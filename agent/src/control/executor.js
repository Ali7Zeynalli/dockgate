// The only things the agent does to a server, whoever asks. A signed command from DockGate and the agent's own
// loops both come through here; anything not in this list is refused. Limits are checked again on this side,
// so a mistake (or a stolen DockGate) can never go past them.
const MAX_REPLICAS = 20;
const ACTIONS = ['restart', 'add-replica', 'remove-replica', 'reload-proxy', 'state'];
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const PROXY = /(^|\/)(nginx|openresty|caddy)(:|@|$)/i;

const label = (ct, k) => ((ct.Config && ct.Config.Labels) || ct.Labels || {})[k];
const short = (n) => String(n || '').replace(/^\//, '');

/** Running containers of one compose service, by replica number. */
async function replicasOf(docker, project, service, { all = false } = {}) {
  const list = await docker.listContainers({ all, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`] }) });
  return list.map(c => ({ id: c.Id, name: short(c.Names[0]), number: Number(c.Labels['com.docker.compose.container-number']) || 0, state: c.State, labels: c.Labels }))
    .sort((a, b) => a.number - b.number);
}

/** The rule for a service, or an error if DockGate gave none (the agent only touches what it was told about). */
function ruleOf(rules, project, service) {
  if (!NAME.test(String(project || '')) || !NAME.test(String(service || ''))) throw new Error('bad name');
  const r = rules && rules.projects && rules.projects[project] && rules.projects[project][service];
  if (!r) throw new Error(`no rule for ${project}/${service}`);
  return r;
}
const maxOf = (r) => Math.min(MAX_REPLICAS, Number.isInteger(r.max) ? r.max : (Number.isInteger(r.replicas) ? r.replicas : 1));
const minOf = (r) => Math.max(0, Number.isInteger(r.min) ? r.min : (Number.isInteger(r.replicas) ? r.replicas : 1));

/**
 * A new replica made the way Compose makes one: the config of a running replica, the next container number,
 * the same networks with the service's aliases. Compose later sees it as one of its own.
 */
async function cloneReplica(docker, from, project, service, number, opts = {}) {
  // from: a container id, or a saved inspect (Keep running: the container is gone, its config was kept)
  const src = typeof from === 'string' ? await docker.getContainer(from).inspect() : from;
  const name = opts.name || `${project}-${service}-${number}`;
  const labels = { ...(src.Config.Labels || {}), 'com.docker.compose.container-number': String(number), 'com.docker.compose.oneoff': 'False' };
  delete labels['com.docker.compose.replace']; // says which container the template replaced; not true of the copy
  const nets = Object.entries(src.NetworkSettings.Networks || {});
  const endpoint = ([, ep]) => ({ Aliases: [...new Set((ep.Aliases || []).filter(a => a !== short(src.Name) && a !== src.Id.slice(0, 12) && a !== src.Config.Hostname).concat([service, name]))] });
  const hc = { ...src.HostConfig }; delete hc.Links;
  if (!opts.keepPorts) delete hc.PortBindings; // a second replica can not take the same host port; the only one keeps it
  const spec = {
    name, Image: src.Config.Image, Env: src.Config.Env, Cmd: src.Config.Cmd, Entrypoint: src.Config.Entrypoint, WorkingDir: src.Config.WorkingDir,
    User: src.Config.User, Labels: labels, ExposedPorts: src.Config.ExposedPorts, Healthcheck: src.Config.Healthcheck, StopSignal: src.Config.StopSignal,
    StopTimeout: src.Config.StopTimeout, Tty: src.Config.Tty, OpenStdin: src.Config.OpenStdin, Volumes: src.Config.Volumes,
    HostConfig: hc,
    NetworkingConfig: nets.length ? { EndpointsConfig: { [nets[0][0]]: endpoint(nets[0]) } } : undefined,
  };
  const ct = await docker.createContainer(spec);
  for (const n of nets.slice(1)) await docker.getNetwork(n[0]).connect({ Container: ct.id, EndpointConfig: endpoint(n) });
  await ct.start();
  return { id: ct.id, name };
}

/** Run a command in a container; { code, out }. */
async function run(docker, id, cmd) {
  const ex = await docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({ hijack: true, stdin: false });
  let out = '';
  await new Promise((res) => { stream.on('data', d => { out += d.toString('utf8'); }); stream.on('end', res); stream.on('close', res); setTimeout(res, 15000); });
  const info = await ex.inspect().catch(() => ({ ExitCode: -1 }));
  return { code: info.ExitCode, out: out.replace(/[\x00-\x08]/g, '').trim() };
}

/** nginx / Caddy containers on the networks of a project: reload them so they see the replicas now running. */
async function reloadProxies(docker, project) {
  const mine = await docker.listContainers({ filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) });
  const nets = new Set(mine.flatMap(c => Object.keys((c.NetworkSettings || {}).Networks || {})).filter(n => !['host', 'none', 'bridge'].includes(n)));
  const done = [];
  for (const n of nets) {
    const info = await docker.getNetwork(n).inspect().catch(() => null);
    for (const id of Object.keys((info && info.Containers) || {})) {
      if (done.includes(id)) continue;
      const ct = await docker.getContainer(id).inspect().catch(() => null);
      if (!ct || !ct.State.Running || !PROXY.test(String(ct.Config.Image).replace(/^docker\.io\//, '').replace(/^library\//, ''))) continue;
      done.push(id);
      if (/caddy/i.test(ct.Config.Image)) await run(docker, id, ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
      else if ((await run(docker, id, ['nginx', '-t'])).code === 0) await run(docker, id, ['nginx', '-s', 'reload']);
    }
  }
  return done.length;
}

/**
 * Do one whitelisted action. ctx = { docker, rules }. args by action:
 *   restart { project, service, container }   add-replica { project, service }   remove-replica { project, service }
 *   reload-proxy { project }                  state {}
 */
async function execute(action, args, ctx) {
  if (!ACTIONS.includes(action)) return { ok: false, reason: 'not allowed', action };
  const { docker, rules } = ctx;
  const a = args || {};
  if (action === 'state') return { ok: true };
  if (action === 'reload-proxy') { ruleOfProject(rules, a.project); return { ok: true, reloaded: await reloadProxies(docker, a.project) }; }
  const r = ruleOf(rules, a.project, a.service);
  const reps = await replicasOf(docker, a.project, a.service);
  if (action === 'restart') {
    const t = reps.find(x => x.id === a.container || x.name === a.container);
    if (!t) return { ok: false, reason: 'not a replica of that service' };
    await docker.getContainer(t.id).restart({ t: 10 });
    return { ok: true, container: t.name };
  }
  if (action === 'add-replica') {
    if (reps.length >= maxOf(r)) return { ok: false, reason: `at the maximum (${maxOf(r)})` };
    const from = reps.find(x => x.state === 'running');
    if (!from) return { ok: false, reason: 'no running replica to copy' };
    const used = new Set((await replicasOf(docker, a.project, a.service, { all: true })).map(x => x.number));
    let n = 1; while (used.has(n)) n++;
    const made = await cloneReplica(docker, from.id, a.project, a.service, n);
    await reloadProxies(docker, a.project);
    return { ok: true, container: made.name, replicas: reps.length + 1 };
  }
  if (action === 'remove-replica') {
    if (reps.length <= Math.max(1, minOf(r))) return { ok: false, reason: `at the minimum (${Math.max(1, minOf(r))})` };
    const go = reps[reps.length - 1];
    const ct = await docker.getContainer(go.id).inspect().catch(() => null);
    await docker.getContainer(go.id).stop({ t: Math.max(1, (ct && ct.Config.StopTimeout) || 10) }).catch(() => {});
    await docker.getContainer(go.id).remove({ force: true }).catch(() => {});
    await reloadProxies(docker, a.project);
    return { ok: true, container: go.name, replicas: reps.length - 1 };
  }
  return { ok: false, reason: 'not allowed' };
}
function ruleOfProject(rules, project) {
  if (!NAME.test(String(project || '')) || !(rules && rules.projects && rules.projects[project])) throw new Error(`no rule for ${project}`);
}

module.exports = { ACTIONS, MAX_REPLICAS, execute, cloneReplica, replicasOf, reloadProxies, maxOf, minOf, label };
