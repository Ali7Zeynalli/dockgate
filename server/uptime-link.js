// Uptime ↔ Docker: a check can be linked to a container, a Compose project or a Swarm service on a server.
//   context(link)     the linked containers' state and the last log lines of the one that looks broken
//   restart(link)     restart the linked containers (or force-update the Swarm service)
//   busy(link)        DockGate is deploying / restarting / updating it right now (or did in the last 3 minutes):
//                     the check waits, so a planned restart is not reported as "down"
//   suggestions(list) domains found in proxy labels (Traefik, Caddy, nginx-proxy) that have no check yet
// link = { server: 'local' | serverId, kind: 'container' | 'compose' | 'swarm', name }
const { db, stmts } = require('./db');

const KINDS = ['container', 'compose', 'swarm'];
const BUSY_MS = 3 * 60000;
// Actions that change what runs. Automatic keep-running / auto-heal restarts are not here: those are what an alert is for.
const CHANGE = /^(up|down|start|stop|restart|kill|recreate|rebuild|redeploy|redeploy_version|deploy|deploy_\w+|pull|update|update_service|compose_rollout|compose_scale\w*|image_update\w*|rollback\w*|create|edit|scale|move_\w+)$/;

let clientImpl = null; // tests put a fake Docker client here
function clientFor(serverId) {
  if (clientImpl) return clientImpl(serverId);
  const ds = require('./docker');
  if (!serverId || serverId === 'local') return ds.createLocalClient();
  const row = stmts.getServer.get(serverId);
  return row ? ds.createSshClient(row) : null;
}

/** Clean a link from the form; null when there is none. */
function normalizeLink(l) {
  if (!l || !l.name) return null;
  const kind = KINDS.includes(l.kind) ? l.kind : 'container';
  const name = String(l.name).trim().slice(0, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(name)) throw new Error('Linked to: a container, project or service name');
  const server = String(l.server || 'local').slice(0, 100);
  if (server !== 'local' && !stmts.getServer.get(server)) throw new Error('Linked to: that server is not in DockGate');
  return { server, kind, name };
}

async function containersOf(docker, link) {
  if (link.kind === 'compose') return docker.listContainers({ all: true, filters: JSON.stringify({ label: [`com.docker.compose.project=${link.name}`] }) });
  if (link.kind === 'container') return (await docker.listContainers({ all: true, filters: JSON.stringify({ name: [link.name] }) })).filter(c => (c.Names || []).some(n => n.replace(/^\//, '') === link.name));
  return [];
}

/** State of what the check is linked to, plus the last lines of the container that looks broken. */
async function context(link, { lines = 8 } = {}) {
  if (!link) return null;
  const docker = clientFor(link.server);
  if (!docker) return { error: 'The linked server is gone' };
  try {
    if (link.kind === 'swarm') {
      const svc = await docker.getService(link.name).inspect();
      const tasks = await docker.listTasks({ filters: JSON.stringify({ service: [svc.ID] }) });
      const want = svc.Spec.Mode && svc.Spec.Mode.Replicated ? svc.Spec.Mode.Replicated.Replicas : null;
      const running = tasks.filter(t => t.Status && t.Status.State === 'running').length;
      const failed = tasks.filter(t => t.Status && /failed|rejected|shutdown/.test(t.Status.State) && t.DesiredState !== 'shutdown').slice(0, 3);
      return { kind: 'swarm', name: link.name, summary: `${running}/${want == null ? 'global' : want} tasks running`, items: failed.map(t => ({ name: `task ${String(t.ID).slice(0, 12)}`, state: t.Status.State, detail: t.Status.Err || t.Status.Message || '' })), logs: '' };
    }
    const list = await containersOf(docker, link);
    if (!list.length) return { kind: link.kind, name: link.name, summary: 'no container found', items: [], logs: '' };
    const items = list.map(c => ({ id: c.Id, name: (c.Names || [''])[0].replace(/^\//, ''), state: c.State, detail: c.Status }));
    const broken = list.find(c => c.State !== 'running' || /unhealthy|restarting/i.test(c.Status)) || list[0];
    let logs = '';
    try {
      const buf = await docker.getContainer(broken.Id).logs({ stdout: true, stderr: true, tail: lines, timestamps: false });
      logs = require('./docker').demuxLogs(buf).split('\n').filter(Boolean).slice(-lines).join('\n').slice(0, 2000);
    } catch (e) { /* no logs */ }
    const up = list.filter(c => c.State === 'running').length;
    return { kind: link.kind, name: link.name, summary: `${up}/${list.length} running`, items, logs, from: (broken.Names || [''])[0].replace(/^\//, '') };
  } catch (e) { return { kind: link.kind, name: link.name, error: e.message }; }
}

async function restart(link) {
  const docker = clientFor(link.server);
  if (!docker) throw new Error('The linked server is gone');
  if (link.kind === 'swarm') {
    const svc = docker.getService(link.name);
    const info = await svc.inspect();
    const spec = info.Spec;
    spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
    await svc.update({ version: info.Version.Index, ...spec });
    return { restarted: [link.name] };
  }
  const list = await containersOf(docker, link);
  if (!list.length) throw new Error('No container found for this link');
  for (const c of list) await docker.getContainer(c.Id).restart({ t: 10 });
  return { restarted: list.map(c => (c.Names || [''])[0].replace(/^\//, '')) };
}

const recent = db.prepare(`SELECT action FROM activity WHERE server = ? AND (resource_name = ? OR resource_name LIKE ?) AND created_at >= ? ORDER BY id DESC LIMIT 20`);
/** DockGate changed it in the last 3 minutes, or a deploy job of the project is running. */
function busy(link, now = Date.now()) {
  if (!link) return false;
  try {
    if (link.kind === 'compose' && link.server === require('./docker').getActiveServerId() && require('./routes/compose').composeHelpers.busy(link.name)) return true;
  } catch (e) { /* compose routes not loaded */ }
  const since = new Date(now - BUSY_MS).toISOString().replace('T', ' ').slice(0, 19);
  const like = link.kind === 'compose' ? `${link.name}-%` : link.name;
  return recent.all(link.server, link.name, like, since).some(r => CHANGE.test(r.action));
}

/** Domains in proxy labels of the active server's containers (Traefik Host(), caddy, VIRTUAL_HOST is env — not read). */
async function suggestions(existing, serverId) {
  const docker = clientFor(serverId);
  if (!docker) return [];
  const have = new Set((existing || []).map(c => { try { return new URL(c.target).hostname; } catch (e) { return String(c.target).split(':')[0]; } }));
  const out = new Map();
  for (const c of await docker.listContainers({ all: false })) {
    const L = c.Labels || {};
    const name = (c.Names || [''])[0].replace(/^\//, '');
    const project = L['com.docker.compose.project'];
    const link = project ? { server: serverId, kind: 'compose', name: project } : L['com.docker.swarm.service.name'] ? { server: serverId, kind: 'swarm', name: L['com.docker.swarm.service.name'] } : { server: serverId, kind: 'container', name };
    const add = (host, via) => { host = String(host || '').trim().toLowerCase(); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || have.has(host) || out.has(host)) return; out.set(host, { host, via, container: name, link }); };
    for (const [k, v] of Object.entries(L)) {
      if (/^traefik\.http\.routers\.[^.]+\.rule$/.test(k)) for (const m of String(v).matchAll(/Host\(([^)]*)\)/g)) for (const h of m[1].split(',')) add(h.replace(/[`'"\s]/g, ''), 'Traefik label');
      if (k === 'caddy' || /^caddy_\d+$/.test(k)) for (const h of String(v).split(/[\s,]+/)) add(h.replace(/^https?:\/\//, '').replace(/[:/].*$/, ''), 'Caddy label');
    }
  }
  return [...out.values()].slice(0, 20);
}

module.exports = { KINDS, CHANGE, normalizeLink, context, restart, busy, suggestions, clientFor, _setClient: (fn) => { clientImpl = fn; } };
