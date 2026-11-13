// Keeping traffic right when replicas change: proxies (nginx, Caddy) on the project's networks are reloaded after
// a change, so they see new replicas and forget removed ones; a replica that goes is stopped gracefully, so the
// requests it is serving finish and the proxy sends new ones to the others.
const PROXY = /(^|\/)(nginx|openresty|caddy|traefik|haproxy)(:|@|$)/i;
const kindOf = (image) => { const m = PROXY.exec(String(image || '').replace(/^docker\.io\//, '').replace(/^library\//, '')); return m ? m[2].toLowerCase().replace('openresty', 'nginx') : null; };

/** Proxy containers that share a network with the project's containers (its own networks and shared ones). */
async function findProxies(c, project) {
  const mine = await c.listContainers({ all: false, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) });
  const nets = new Set();
  for (const ct of mine) for (const n of Object.keys((ct.NetworkSettings || {}).Networks || {})) if (!['host', 'none', 'bridge'].includes(n)) nets.add(n);
  const seen = new Map();
  for (const n of nets) {
    let info; try { info = await c.getNetwork(n).inspect(); } catch (e) { continue; }
    for (const id of Object.keys(info.Containers || {})) {
      if (seen.has(id)) continue;
      const ct = await c.getContainer(id).inspect().catch(() => null);
      if (!ct || !ct.State.Running) continue;
      const kind = kindOf(ct.Config.Image);
      if (kind) seen.set(id, { id, name: ct.Name.replace(/^\//, ''), kind, image: ct.Config.Image });
    }
  }
  return [...seen.values()];
}

/**
 * Does an nginx config find new replicas by itself? True when Docker's resolver is set and the upstream is used
 * through a variable (resolved per request) or an upstream server marked resolve.
 */
function nginxUsesResolver(conf, upstream) {
  const text = String(conf || '').replace(/#[^\n]*/g, '');
  if (!/\bresolver\s+127\.0\.0\.11\b/.test(text)) return false;
  const name = String(upstream || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const viaVar = new RegExp(`set\\s+\\$\\w+\\s+["']?https?://${name}[:/;"']`).test(text) && /proxy_pass\s+\$/.test(text);
  const viaResolve = new RegExp(`server\\s+${name}(:\\d+)?[^;]*\\bresolve\\b`).test(text);
  return viaVar || viaResolve;
}

/** Run a command in a container; resolves { code, out }. */
async function run(c, id, cmd) {
  const ex = await c.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({ hijack: true, stdin: false });
  let out = '';
  await new Promise((res) => { stream.on('data', d => { out += d.toString('utf8').replace(/[\x00-\x08]/g, ''); }); stream.on('end', res); stream.on('close', res); setTimeout(res, 15000); });
  const info = await ex.inspect().catch(() => ({ ExitCode: -1 }));
  return { code: info.ExitCode, out: out.trim() };
}

/** Reload the proxies so they see the replicas now running. A config that does not pass its check is left alone. */
// opts.tested: { [proxyId]: true } — nginx -t already passed (a rolling update checks once, then reloads fast).
async function reloadProxies(c, proxies, log = () => {}, opts = {}) {
  await Promise.all(proxies.map(async (p) => {
    try {
      if (p.kind === 'nginx') {
        if (!(opts.tested && opts.tested[p.id])) {
          const t = await run(c, p.id, ['nginx', '-t']);
          if (t.code !== 0) { log(`  ! ${p.name}: nginx -t failed — not reloaded: ${t.out.split('\n').pop()}`); return; }
        }
        const r = await run(c, p.id, ['nginx', '-s', 'reload']);
        log(r.code === 0 ? `  ${p.name}: nginx reloaded` : `  ! ${p.name}: reload failed: ${r.out}`);
      } else if (p.kind === 'caddy') {
        const r = await run(c, p.id, ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
        log(r.code === 0 ? `  ${p.name}: caddy reloaded` : `  ! ${p.name}: caddy reload failed: ${r.out.split('\n').pop()}`);
      } // traefik and haproxy (with Docker DNS) follow Docker by themselves
    } catch (e) { log(`  ! ${p.name}: ${e.message}`); }
  }));
}
/** nginx -t on each nginx; returns { [id]: true } for those that pass (for reloadProxies' opts.tested). */
async function testProxies(c, proxies, log = () => {}) {
  const ok = {};
  for (const p of proxies.filter(x => x.kind === 'nginx')) {
    const t = await run(c, p.id, ['nginx', '-t']).catch(e => ({ code: 1, out: e.message }));
    if (t.code === 0) ok[p.id] = true; else log(`  ! ${p.name}: nginx -t failed — it will not be reloaded: ${t.out.split('\n').pop()}`);
  }
  return ok;
}
/**
 * How long nginx waits to connect to a replica (proxy_connect_timeout, seconds; nginx's default is 60). A replica
 * that just went away does not refuse — the connection hangs this long before nginx tries another one.
 */
function connectTimeoutOf(conf) {
  const m = [...String(conf || '').matchAll(/^\s*proxy_connect_timeout\s+(\d+)(ms|s|m)?\s*;/gm)];
  if (!m.length) return 60;
  return Math.max(...m.map(x => (x[2] === 'ms' ? Number(x[1]) / 1000 : x[2] === 'm' ? Number(x[1]) * 60 : Number(x[1]))));
}

/**
 * Stop replicas without cutting requests: a graceful stop (SIGTERM, then the service's grace period) lets each one
 * finish what it is doing and refuse new connections — a proxy then retries the request on another replica
 * (nginx proxy_next_upstream). Taking it off its networks first would cut the connections in flight.
 * Then the containers are removed; the caller reloads the proxies.
 */
async function drainAndStop(c, ids, log = () => {}) {
  for (const id of ids) {
    const ct = await c.getContainer(id).inspect().catch(() => null);
    if (!ct) continue;
    const grace = Math.max(1, Math.round((ct.Config.StopTimeout ?? 10)));
    try { await c.getContainer(id).stop({ t: grace }); log(`  ${ct.Name.replace(/^\//, '')}: stopped gracefully`); } catch (e) { /* stopped already */ }
    try { await c.getContainer(id).remove({ force: true }); } catch (e) { /* removed already */ }
  }
}

module.exports = { kindOf, findProxies, nginxUsesResolver, reloadProxies, testProxies, connectTimeoutOf, drainAndStop };
