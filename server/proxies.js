// Web → Proxies & SSL (PX1, read-only): the web servers in front of the apps of the server in use — nginx,
// OpenResty, Nginx Proxy Manager, nginx-proxy, Caddy (also caddy-docker-proxy), Traefik, HAProxy, Apache — in
// containers and as host services (SSH servers, and the local host through local-host.js); which domain goes where, the certificates, config files and
// logs. Nothing is changed here: configs are read (nginx -T, the Caddyfile, labels…), "Test config" runs the
// proxy's own check (nginx -t, caddy validate…).
const P = require('./proxy-parse');
const dockerService = require('./docker');
const RC = require('./remote-compose');
const LH = require('./local-host');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const err = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });

/** image → kind */
function kindOf(image) {
  const i = String(image || '').toLowerCase().replace(/^docker\.io\//, '').replace(/@.*$/, '');
  if (/(^|\/)nginx-proxy-manager(:|$)/.test(i)) return 'npm';
  if (/(^|\/)(nginx-proxy|nginxproxy\/nginx-proxy)(:|$)/.test(i) || /^jwilder\/nginx-proxy/.test(i)) return 'nginx-proxy';
  if (/caddy-docker-proxy/.test(i)) return 'caddy-docker-proxy';
  if (/(^|\/)(nginx|openresty)(:|$)|(^|\/)openresty\//.test(i) || /^nginxinc\//.test(i) || /(^|\/)swag(:|$)/.test(i)) return 'nginx';
  if (/(^|\/)caddy(:|$)/.test(i)) return 'caddy';
  if (/(^|\/)traefik(:|$)/.test(i)) return 'traefik';
  if (/(^|\/)haproxy(:|$)/.test(i) || /haproxytech\//.test(i)) return 'haproxy';
  if (/(^|\/)(httpd|apache2?)(:|$)/.test(i)) return 'apache';
  if (/(^|\/)certbot(:|$)/.test(i)) return 'certbot';
  if (/acme-companion|letsencrypt-nginx-proxy-companion/.test(i)) return 'acme-companion';
  return null;
}
/**
 * The kind of an image that is not named after its proxy (built with `build:` → "shop-proxy", or a private
 * registry): from what the official images leave in their config, which images built FROM them inherit —
 * NGINX_VERSION, CADDY_VERSION, HAPROXY_VERSION, HTTPD_VERSION — or the program they start.
 */
function kindOfConfig(cfg = {}) {
  const env = (cfg.Env || []).map(e => String(e).split('=')[0]);
  const cmd = [...(cfg.Entrypoint || []), ...(cfg.Cmd || [])].map(String).join(' ');
  if (env.includes('NGINX_VERSION') || /(^|[\s/])(nginx|openresty)(\s|$)/.test(cmd)) return 'nginx';
  if (env.includes('CADDY_VERSION') || /(^|[\s/])caddy(\s|$)/.test(cmd)) return 'caddy';
  if (env.includes('HAPROXY_VERSION') || /(^|[\s/])haproxy(\s|$)/.test(cmd)) return 'haproxy';
  if (/(^|[\s/])traefik(\s|$)/.test(cmd)) return 'traefik';
  if (env.includes('HTTPD_VERSION') || /httpd-foreground|apache2ctl|apachectl|apache2-foreground/.test(cmd)) return 'apache';
  return null;
}
const imageKinds = new Map(); // image id → kind (or null): an image does not change under its id
async function kindOfContainer(c, ct) {
  const byName = kindOf(ct.Image); if (byName) return { kind: byName, derived: false };
  const id = ct.ImageID || ct.Image;
  if (!imageKinds.has(id)) { const info = await c.getImage(id).inspect().catch(() => null); imageKinds.set(id, info ? kindOfConfig(info.Config || {}) : null); }
  const kind = imageKinds.get(id);
  return { kind, derived: !!kind };
}
const LABEL = { nginx: 'nginx', npm: 'Nginx Proxy Manager', 'nginx-proxy': 'nginx-proxy', caddy: 'Caddy', 'caddy-docker-proxy': 'Caddy (docker-proxy)', traefik: 'Traefik', haproxy: 'HAProxy', apache: 'Apache' };
const NGINXISH = new Set(['nginx', 'npm', 'nginx-proxy']);

/** docker exec with stdout / stderr kept apart (demuxed). */
async function execIn(c, id, cmd, { timeout = 15000, user } = {}) {
  const ex = await c.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, ...(user ? { User: user } : {}) });
  const stream = await ex.start({ hijack: true, stdin: false });
  let out = '', er = '';
  const w = (fn) => ({ write: (b) => { fn(b.toString('utf8')); return true; }, end() {}, on() {}, once() {}, emit() {} });
  await new Promise((res) => {
    try { c.modem.demuxStream(stream, w(s => { out += s; }), w(s => { er += s; })); } catch (e) { stream.on('data', d => { out += d.toString('utf8'); }); }
    stream.on('end', res); stream.on('close', res); setTimeout(res, timeout);
  });
  const info = await ex.inspect().catch(() => ({ ExitCode: -1 }));
  return { code: info.ExitCode, out, err: er };
}
async function hostExec(server, cmd) {
  if (!server) return null;
  const r = server.local ? await server.exec(cmd) : await RC.execRemote(server, cmd); // the local host (local-host.js) or an SSH server
  return { code: r.code, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** A shell loop that prints each file of the globs as "@@F path" + its text (paths with odd characters are left out). */
const catGlobs = (globs) => `for f in ${globs.filter(g => /^[\w./*@+-]+$/.test(g)).join(' ')}; do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; echo; }; done; true`;
const splitCat = (out) => String(out || '').split(/^@@F /m).slice(1).map(ch => { const nl = ch.indexOf('\n'); return { path: ch.slice(0, nl).trim(), text: ch.slice(nl + 1).replace(/\n$/, '') }; });
/** A script run as root on a host: root already (the local helper, a root SSH login), sudo when it works, else as is. */
const rootSh = (script) => `if [ "$(id -u)" = 0 ]; then sh -c ${shq(script)}; elif sudo -n true 2>/dev/null; then sudo -n sh -c ${shq(script)}; else sh -c ${shq(script)}; fi`;
const sudoTry = (cmd) => `sudo -n ${cmd} 2>&1 || ${cmd} 2>&1`;

// ---------- the scan ----------
const cache = new Map(); // serverId → { at, data, raw }
/** Where to look: the server in use, or (for the daily certificate check) any server: { serverId, c, server }. */
function activeCtx() {
  const c = dockerService.docker; const remote = RC.getActiveRemoteServer();
  return { serverId: dockerService.getActiveServerId() || 'local', c, server: remote || LH.forLocal(c) };
}
async function scan({ fresh = false, ctx = activeCtx() } = {}) {
  const serverId = ctx.serverId;
  const hit = cache.get(serverId);
  if (!fresh && hit && Date.now() - hit.at < 20000) return hit.data;
  const c = ctx.c;
  const server = ctx.server;
  const containers = await c.listContainers({ all: true });
  const raw = { files: {}, nginx: {}, certPaths: {} }; // per proxy id: config files etc. (for the other tabs)
  const proxies = []; const sites = []; const warnings = [];

  // index of containers for resolving targets
  const byName = new Map(); const byIp = new Map(); const byHostPort = new Map(); // host port → the container that publishes it
  for (const ct of containers) {
    const name = (ct.Names || [''])[0].replace(/^\//, '');
    const L = ct.Labels || {};
    const info = { id: ct.Id, name, running: ct.State === 'running', state: ct.State, project: L['com.docker.compose.project'] || null, service: L['com.docker.compose.service'] || L['com.docker.swarm.service.name'] || null };
    byName.set(name, info);
    if (info.service && !byName.has(info.service)) byName.set(info.service, info);
    if (L['com.docker.swarm.service.name']) byName.set(L['com.docker.swarm.service.name'], info);
    for (const n of Object.values((ct.NetworkSettings || {}).Networks || {})) if (n.IPAddress) byIp.set(n.IPAddress, info);
    for (const pt of ct.Ports || []) if (pt.PublicPort) byHostPort.set(String(pt.PublicPort), info);
  }
  const resolve = (target, proxy) => {
    if (!target) return null;
    const t = String(target).replace(/^https?:\/\//, '');
    if (t === 'unix') return { label: 'unix socket', kind: 'socket' };
    const [host, port] = t.split(':');
    const ct = byName.get(host) || byIp.get(host) || byName.get(host.replace(/\.\d+\..*$/, ''));
    if (ct) return { label: `${ct.name}${port ? ':' + port : ''}`, kind: 'container', container: { name: ct.name, running: ct.running, state: ct.state, project: ct.project, id: ct.id } };
    const pub = (/^(127\.0\.0\.1|localhost|::1|host\.docker\.internal|172\.17\.0\.1)$/.test(host) && (proxy.where === 'host' || proxy.hostNet || host === 'host.docker.internal' || host === '172.17.0.1')) ? byHostPort.get(String(port || '')) : null;
    if (pub) return { label: `${pub.name} (port ${port} on the host)`, kind: 'container', container: { name: pub.name, running: pub.running, state: pub.state, project: pub.project, id: pub.id }, via: 'published' };
    if (/^(127\.0\.0\.1|localhost|::1)$/.test(host)) return { label: t, kind: proxy.where === 'host' ? 'host' : 'self', note: proxy.where === 'host' ? 'a program on the server' : 'the proxy container itself' };
    if (host === 'host.docker.internal' || /^172\.17\.0\.1$/.test(host)) return { label: t, kind: 'host', note: 'a program on the server' };
    return { label: t, kind: 'other', note: 'not a container of this server' };
  };
  const helpers = []; // certbot / acme-companion containers: they renew certificates, they are not proxies
  const addSite = (s, proxy) => {
    const same = sites.find(x => x.proxy === proxy.id && x.domain === s.domain);
    if (same) { // one domain, two entries of one proxy (Traefik's http → https router, two server blocks): one row
      if (s.https && !same.https) { same.https = true; same.redirect = true; same.file = s.file || same.file; same.line = s.line || same.line; } else if (!s.https && same.https) same.redirect = true;
      if (!same.target && s.targets && s.targets.length) { same.target = resolve(s.targets[0], proxy); same.targetsAll = s.targets.map(t => resolve(t, proxy)); }
      return;
    }
    sites.push({ ...s, proxy: proxy.id, proxyName: proxy.name, proxyKind: proxy.kind, target: s.targets && s.targets.length ? resolve(s.targets[0], proxy) : (s.root ? { label: `files: ${s.root}`, kind: 'files' } : null), targetsAll: (s.targets || []).map(t => resolve(t, proxy)) });
  };

  // ---- proxies in containers ----
  const labelled = []; // containers with Traefik / caddy labels
  const jobs = [];
  for (const ct of containers) {
    const L = ct.Labels || {};
    if (Object.keys(L).some(k => k.startsWith('traefik.http.routers.')) || Object.keys(L).some(k => /^caddy(_\d+)?$/.test(k))) labelled.push(ct);
    const { kind, derived } = await kindOfContainer(c, ct);
    if (kind === 'certbot' || kind === 'acme-companion') { helpers.push({ kind, name: (ct.Names || [''])[0].replace(/^\//, ''), cid: ct.Id, running: ct.State === 'running', state: ct.State }); continue; }
    if (!kind) continue;
    const name = (ct.Names || [''])[0].replace(/^\//, '');
    const p = { id: 'c:' + ct.Id.slice(0, 12), cid: ct.Id, name, kind, label: LABEL[kind], image: ct.Image, where: 'container', project: L['com.docker.compose.project'] || L['com.docker.stack.namespace'] || null, state: ct.State, running: ct.State === 'running',
      ports: [...new Set((ct.Ports || []).filter(x => x.PublicPort).map(x => x.PublicPort))].sort((a, b) => a - b), version: derived ? null : (ct.Image.split(':')[1] || 'latest'), derived,
      hostNet: ((ct.HostConfig || {}).NetworkMode || '') === 'host', config: null, sites: 0, managedBy: kind === 'npm' ? 'Nginx Proxy Manager' : kind === 'nginx-proxy' ? 'nginx-proxy (from container env)' : null, problem: null };
    proxies.push(p); jobs.push({ ct, p, kind, derived, name });
  }
  // each proxy is read with a few `docker exec`s: four at a time, so a server with many containers is not read one by one
  const readOne = async ({ ct, p, kind, derived, name }) => {
    if (!p.running) { // a stopped proxy: why (its last log lines), and its config read through the archive API, so its sites stay listed
      try { await stoppedProxy(c, ct, p, kind, raw, addSite, warnings); } catch (e) { p.problem = p.problem || `stopped (${e.message})`; }
      return;
    }
    try {
      if (NGINXISH.has(kind)) {
        const r = await execIn(c, ct.Id, ['nginx', '-T']);
        let parsed = P.parseNginxT(r.out + '\n' + r.err);
        if (!parsed.files.length) { // the config does not pass its check (nginx -T then prints nothing): read the files directly, and say why
          const why = (r.err || r.out).split('\n').filter(l => /emerg|error|failed/i.test(l))[0] || (r.err || r.out).split('\n').filter(Boolean).pop() || 'nginx -T gave nothing';
          const f = await execIn(c, ct.Id, ['sh', '-c', 'for f in $(find /etc/nginx /etc/nginx/conf.d -maxdepth 2 -name "*.conf" 2>/dev/null | sort -u); do echo "# configuration file $f:"; cat "$f"; echo; done']);
          parsed = P.parseNginxT(f.out);
          p.problem = `config check fails: ${why.replace(/^nginx: \[emerg\]\s*/, '').replace(/^\S+ \S+ \[emerg\] \d+#\d+: /, '')}`;
          warnings.push({ level: 'bad', text: `${name}: the nginx config does not pass its check — ${p.problem.replace('config check fails: ', '')}. A reload or restart would fail.` });
        }
        raw.files[p.id] = parsed.files; raw.nginx[p.id] = parsed;
        p.config = parsed.files[0] ? parsed.files[0].path.replace(/\/[^/]+$/, '') : '/etc/nginx';
        // nginx that only serves its own app (no proxy_pass, no domain, no published web port) is a web server, not a proxy
        const realNames = parsed.servers.some(sv => sv.names.some(nm => P.isDomain(nm)));
        if (kind === 'nginx' && !realNames && !parsed.servers.some(sv => sv.proxyPass || sv.locations.some(l => l.proxyPass)) && !p.ports.some(x => [80, 443].includes(x))) { p.appServer = true; return; }
        const v = await execIn(c, ct.Id, ['nginx', '-v']).catch(() => null); const vm = v && (v.err + v.out).match(/nginx\/(\S+)|openresty\/(\S+)/); if (vm) p.version = vm[1] || vm[2];
        for (const s of P.nginxSites(parsed).filter(x => x.domain !== 'localhost')) addSite({ ...s, managed: kind === 'npm' && /^\/data\//.test(s.file) ? 'Nginx Proxy Manager' : kind === 'nginx-proxy' ? 'nginx-proxy' : null }, p);
        raw.certPaths[p.id] = P.nginxAllCerts(parsed);
      } else if (kind === 'caddy') {
        const path = (() => { const cmd = (ct.Command || '') + ''; const m = cmd.match(/--config\s+(\S+)/); return m ? m[1] : '/etc/caddy/Caddyfile'; })();
        const r = await execIn(c, ct.Id, ['cat', path]);
        p.config = path; raw.files[p.id] = r.code === 0 ? [{ path, text: r.out }] : [];
        if (r.code !== 0) p.problem = `${path} could not be read`;
        const v = await execIn(c, ct.Id, ['caddy', 'version']).catch(() => null); if (v && v.code === 0) p.version = v.out.trim().split(/\s+/)[0];
        for (const s of P.parseCaddyfile(r.out)) addSite({ ...s, file: path }, p);
        const imp = P.caddyImports(r.out, path.replace(/\/[^/]+$/, '')); // files the Caddyfile imports: their sites too
        if (imp.length) { const ir = await execIn(c, ct.Id, ['sh', '-c', catGlobs(imp)]); for (const f of splitCat(ir.out)) { raw.files[p.id].push(f); for (const s of P.parseCaddyfile(f.text)) addSite({ ...s, file: f.path }, p); } }
      } else if (kind === 'haproxy') {
        const r = await execIn(c, ct.Id, ['sh', '-c', 'for f in /usr/local/etc/haproxy/haproxy.cfg /etc/haproxy/haproxy.cfg; do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; break; }; done']);
        const m = r.out.match(/^@@F (\S+)\n([\s\S]*)$/);
        if (m) { p.config = m[1]; raw.files[p.id] = [{ path: m[1], text: m[2] }]; for (const s of P.parseHaproxy(m[2])) addSite({ ...s, file: m[1] }, p); } else p.problem = 'haproxy.cfg not found';
      } else if (kind === 'apache') {
        // the official image has httpd in /usr/local/apache2; Debian / Ubuntu based ones (ubuntu/apache2, php:apache,
        // bitnami) have apache2ctl and /etc/apache2: the program and the folder are found, not assumed
        const r = await execIn(c, ct.Id, ['sh', '-c', 'for b in httpd apache2ctl apachectl; do if command -v $b >/dev/null 2>&1; then echo "@@B $b"; $b -S 2>&1; exit 0; fi; done; echo "@@B none"']);
        const bin = (r.out.match(/@@B (\S+)/) || [])[1] || 'none';
        if (bin === 'none') throw new Error('no httpd or apache2ctl in the container');
        const root = (r.out.match(/ServerRoot: "([^"]+)"/) || [])[1] || (bin === 'httpd' ? '/usr/local/apache2' : '/etc/apache2');
        const main = root === '/etc/apache2' || /\/etc\/apache2/.test(root) ? `${root}/apache2.conf` : `${root}/conf/httpd.conf`;
        p.apacheBin = bin; p.apacheRoot = root; p.apacheMain = main;
        const vh = P.parseApacheS(r.out);
        for (const s of vh) addSite({ domain: s.domain, https: s.port === 443, file: s.file, line: s.line, targets: [] }, p);
        p.config = main.replace(/\/[^/]+$/, '');
        const list = [...new Set([main, ...vh.map(x => x.file)])].slice(0, 30);
        const fr = await execIn(c, ct.Id, ['sh', '-c', list.map(f => `[ -f ${shq(f)} ] && { echo "# configuration file ${f}:"; cat ${shq(f)}; echo; }`).join('; ') + '; true']);
        raw.files[p.id] = P.parseNginxT(fr.out).files;
        // an image built FROM httpd / php:apache that only serves its own app is a web server, not a proxy
        if (derived && !raw.files[p.id].some(f => /^\s*(ProxyPass|ProxyPassMatch|RewriteRule\s.*\[[^\]]*\bP\b)/m.test(f.text)) && !p.ports.some(x => [80, 443].includes(x))) { p.appServer = true; return; }
      } else if (kind === 'traefik' || kind === 'caddy-docker-proxy') {
        p.config = kind === 'traefik' ? 'labels of the containers and services' : 'caddy labels of the containers';
        if (kind === 'traefik') { // the file provider: dynamic config files named on the command line or in traefik.yml / .toml
          const info = await c.getContainer(ct.Id).inspect().catch(() => null);
          const args = info ? [...(info.Config.Cmd || []), ...(info.Args || [])].join(' ') : '';
          const st = await execIn(c, ct.Id, ['sh', '-c', catGlobs(['/etc/traefik/traefik.yml', '/etc/traefik/traefik.yaml', '/etc/traefik/traefik.toml'])]).catch(() => ({ out: '' }));
          const statics = splitCat(st.out);
          const stText = statics.map(f => f.text).join('\n');
          const fname = (args.match(/--providers\.file\.filename[= ](\S+)/) || stText.match(/^\s*filename\s*[:=]\s*["']?([^"'\s]+)/m) || [])[1];
          const fdir = (args.match(/--providers\.file\.directory[= ](\S+)/) || stText.match(/^\s*directory\s*[:=]\s*["']?([^"'\s]+)/m) || [])[1];
          const globs = [...(fname ? [fname] : []), ...(fdir ? ['yml', 'yaml', 'toml'].map(x => `${fdir.replace(/\/$/, '')}/*.${x}`) : [])];
          const dyn = globs.length ? splitCat((await execIn(c, ct.Id, ['sh', '-c', catGlobs(globs)]).catch(() => ({ out: '' }))).out) : [];
          raw.files[p.id] = [...statics, ...dyn];
          for (const f of dyn) for (const s of P.traefikFileSites(f.text)) addSite({ domain: s.domain, https: s.tls, targets: s.targets, file: f.path, router: s.router, fileProvider: true }, p);
          if (dyn.length) p.config = `labels and ${fname || fdir}`;
        }
      }
    } catch (e) { p.problem = e.message; }
  };
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(readOne));

  // ---- Traefik / caddy-docker-proxy labels: containers and Swarm services ----
  const traefik = proxies.find(p => p.kind === 'traefik'); const cdp = proxies.find(p => p.kind === 'caddy-docker-proxy');
  let services = []; try { services = await c.listServices(); } catch (e) { /* not a Swarm manager */ }
  const labelSources = [...labelled.map(ct => ({ labels: ct.Labels || {}, name: (ct.Names || [''])[0].replace(/^\//, ''), swarm: !!(ct.Labels || {})['com.docker.swarm.service.name'] })),
    ...services.map(s => ({ labels: (s.Spec && s.Spec.Labels) || {}, name: s.Spec.Name, swarm: true, service: true }))];
  for (const src of labelSources) {
    if (src.swarm && !src.service) continue; // a task container: its service carries the labels
    if (traefik) for (const s of P.traefikSites(src.labels)) addSite({ domain: s.domain, https: s.tls, resolver: s.resolver, targets: [src.name + (s.port ? ':' + s.port : '')], file: `labels of ${src.name}`, router: s.router }, traefik);
    if (cdp) for (const s of P.caddyLabelSites(src.labels)) addSite({ domain: s.domain, https: true, targets: [src.name + (s.port ? ':' + s.port : '')], file: `labels of ${src.name}` }, cdp);
  }
  if (traefik && !labelSources.some(s => Object.keys(s.labels).some(k => k.startsWith('traefik.http.routers.'))) && !sites.some(s => s.proxy === traefik.id)) traefik.problem = traefik.problem || 'no routers found in labels or in its file provider';

  // ---- nginx-proxy: VIRTUAL_HOST of the containers ----
  const np = proxies.find(p => p.kind === 'nginx-proxy');
  if (np && !sites.some(s => s.proxy === np.id)) {
    for (const ct of containers.filter(x => x.State === 'running').slice(0, 200)) {
      const info = await c.getContainer(ct.Id).inspect().catch(() => null); if (!info) continue;
      const env = Object.fromEntries((info.Config.Env || []).map(e => [e.split('=')[0], e.slice(e.indexOf('=') + 1)]));
      if (!env.VIRTUAL_HOST) continue;
      for (const h of env.VIRTUAL_HOST.split(',')) addSite({ domain: h.trim(), https: !!env.LETSENCRYPT_HOST, targets: [info.Name.replace(/^\//, '') + (env.VIRTUAL_PORT ? ':' + env.VIRTUAL_PORT : '')], file: `env of ${info.Name.replace(/^\//, '')}`, managed: 'nginx-proxy' }, np);
    }
  }

  // ---- host services: SSH servers, and the local host (local-host.js) ----
  let ports = [];
  if (server) {
    const tag = '@@PX';
    // a systemd unit, or (no systemd) the program installed and its processes — not the ones of containers, which
    // share the host's process list
    const script = `hostproc() { for pid in $(pgrep -x "$1" 2>/dev/null); do grep -qE 'docker|containerd|kubepods|libpod|lxc' /proc/$pid/cgroup 2>/dev/null || { echo y; return; }; done; }
for s in nginx caddy apache2 httpd haproxy traefik; do if command -v systemctl >/dev/null 2>&1 && systemctl cat "$s.service" >/dev/null 2>&1; then echo "${tag}S $s $(systemctl is-active $s 2>/dev/null) $(systemctl is-enabled $s 2>/dev/null)";
elif command -v "$s" >/dev/null 2>&1 || [ -x "/usr/sbin/$s" ]; then if [ -n "$(hostproc $s)" ]; then echo "${tag}S $s active manual"; else echo "${tag}S $s inactive manual"; fi; fi; done
echo "${tag}P"; (sudo -n ss -ltnpH 2>/dev/null || ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null) | awk '{print $4" "$6}' | grep -E ':(80|443|8080|8443) |"(nginx|caddy|apache2|httpd|haproxy|traefik)"' | while read a pr; do pid=$(echo "$pr" | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'); if [ -n "$pid" ] && grep -qE 'docker|containerd|kubepods|libpod' /proc/$pid/cgroup 2>/dev/null; then echo "$a $pr C"; else echo "$a $pr"; fi; done; echo "${tag}E"`; // C: the process is in a container (host network)
    const r = await hostExec(server, script).catch(() => null);
    const out = r ? r.out : '';
    for (const m of out.matchAll(/@@PXS (\S+) (\S+) (\S+)/g)) {
      const kind = m[1] === 'apache2' || m[1] === 'httpd' ? 'apache' : m[1];
      const p = { id: 'h:' + m[1], name: m[1], kind, label: LABEL[kind], where: 'host', unit: m[1], state: m[2], running: m[2] === 'active', enabled: m[3], ports: [], version: null, config: null, sites: 0, problem: null };
      proxies.push(p);
      if (!p.running) continue;
      try {
        if (kind === 'nginx') {
          const t = await hostExec(server, sudoTry('nginx -T'));
          const parsed = P.parseNginxT(t.out); raw.files[p.id] = parsed.files; raw.nginx[p.id] = parsed;
          p.config = '/etc/nginx'; if (!parsed.files.length) p.problem = 'nginx -T needs root: give the SSH user passwordless sudo';
          const v = await hostExec(server, 'nginx -v 2>&1'); const vm = v && v.out.match(/nginx\/(\S+)/); if (vm) p.version = vm[1];
          for (const s of P.nginxSites(parsed).filter(x => x.domain !== 'localhost')) addSite(s, p);
          raw.certPaths[p.id] = P.nginxAllCerts(parsed);
        } else if (kind === 'caddy') {
          const t = await hostExec(server, sudoTry('cat /etc/caddy/Caddyfile'));
          p.config = '/etc/caddy/Caddyfile'; raw.files[p.id] = [{ path: p.config, text: t.out }];
          const v = await hostExec(server, 'caddy version 2>/dev/null'); if (v && v.code === 0) p.version = v.out.trim().split(/\s+/)[0];
          for (const s of P.parseCaddyfile(t.out)) addSite({ ...s, file: p.config }, p);
          const imp = P.caddyImports(t.out, '/etc/caddy');
          if (imp.length) { const ir = await hostExec(server, sudoTry(`sh -c ${shq(catGlobs(imp))}`)); for (const f of splitCat(ir.out)) { raw.files[p.id].push(f); for (const s of P.parseCaddyfile(f.text)) addSite({ ...s, file: f.path }, p); } }
        } else if (kind === 'haproxy') {
          const t = await hostExec(server, sudoTry('cat /etc/haproxy/haproxy.cfg'));
          p.config = '/etc/haproxy/haproxy.cfg'; raw.files[p.id] = [{ path: p.config, text: t.out }];
          for (const s of P.parseHaproxy(t.out)) addSite({ ...s, file: p.config }, p);
        } else if (kind === 'apache') {
          const t = await hostExec(server, sudoTry('apachectl -S'));
          p.config = '/etc/apache2 or /etc/httpd';
          const vh = P.parseApacheS(t.out);
          for (const s of vh) addSite({ domain: s.domain, https: s.port === 443, file: s.file, line: s.line, targets: [] }, p);
          const list = [...new Set(vh.map(x => x.file))].slice(0, 30);
          if (list.length) { const fr = await hostExec(server, rootSh(list.map(f => `[ -f '${f}' ] && { echo "# configuration file ${f}:"; cat '${f}'; echo; }`).join('; ') + '; true')); raw.files[p.id] = P.parseNginxT(fr.out).files; }
        }
      } catch (e) { p.problem = e.message; }
    }
    const psec = (out.match(/@@PXP\n([\s\S]*?)@@PXE/) || [])[1] || '';
    for (const line of psec.split('\n').filter(Boolean)) {
      const [addr, proc, inCt] = line.split(' ');
      const port = Number(addr.split(':').pop());
      const who = (String(proc || '').match(/\("([^"]+)"/) || [])[1] || (proc ? '' : 'unknown (needs sudo to see)');
      if (!ports.some(x => x.port === port && x.process === who)) ports.push({ port, addr, process: who || 'unknown', container: inCt === 'C' });
    }
    for (const p of proxies.filter(x => x.where === 'host')) p.ports = [...new Set(ports.filter(x => !x.container && (x.process === p.unit || (p.unit === 'apache2' && x.process === 'apache2'))).map(x => x.port))];
    const BIN = { nginx: ['nginx'], caddy: ['caddy'], haproxy: ['haproxy'], apache: ['httpd', 'apache2'], traefik: ['traefik'] };
    for (const p of proxies.filter(x => x.where === 'container' && x.hostNet && x.running)) p.ports = [...new Set(ports.filter(x => x.container && (BIN[p.kind] || []).includes(x.process)).map(x => x.port))];
  }
  for (const x of ports.filter(y => y.container)) { const own = proxies.find(p => p.hostNet && (p.ports || []).includes(x.port)); x.process = `${x.process} (${own ? `container ${own.name}` : 'a container'}, host network)`; }
  for (const x of ports) if (x.process === 'docker-proxy') { const ct = byHostPort.get(String(x.port)); if (ct) x.process = `docker → ${ct.name}`; } // the container that publishes it, not Docker's forwarder
  // published ports of the proxy containers (local server, or when ss could not tell)
  for (const p of proxies.filter(x => x.where === 'container' && x.running)) for (const port of p.ports) if ([80, 443, 8080, 8443].includes(port) && !ports.some(x => x.port === port && /docker/.test(x.process))) ports.push({ port, addr: `*:${port}`, process: `docker → ${p.name}` });
  ports.sort((a, b) => a.port - b.port);

  const appServers = proxies.filter(p => p.appServer).map(p => p.name);
  for (let i = proxies.length - 1; i >= 0; i--) if (proxies[i].appServer) proxies.splice(i, 1);
  // ---- counts and warnings ----
  for (const p of proxies) p.sites = sites.filter(s => s.proxy === p.id).length;
  for (const port of [80, 443]) {
    const holders = proxies.filter(p => p.running && p.ports.includes(port));
    const idle = proxies.filter(p => !p.running && p.where === 'host' && p.enabled === 'enabled');
    if (holders.length > 1) warnings.push({ level: 'bad', text: `${holders.map(h => h.name).join(' and ')} both want port ${port}.` });
    for (const i of idle) warnings.push({ level: 'warn', text: `${i.name} is installed and enabled but not running — at boot it would also want ports 80 / 443.` });
  }
  const dup = new Map(); for (const s of sites) dup.set(s.domain, (dup.get(s.domain) || new Set()).add(s.proxyName));
  for (const [d, set] of dup) if (set.size > 1) warnings.push({ level: 'warn', text: `${d} is configured in ${[...set].join(' and ')}.` });
  for (const s of sites) if (s.target && s.target.container && !s.target.container.running) warnings.push({ level: 'bad', text: `${s.domain} goes to ${s.target.container.name}, which is ${s.target.container.state}.`, site: s.domain });

  const data = { server: serverId, remote: !!server && !server.local, hostAccess: !!server, appServers, helpers, proxies, sites: sites.sort((a, b) => a.domain.localeCompare(b.domain)), ports: [...new Map([...ports.map(x => [x.port + x.process, x])]).values()], warnings: [...new Map(warnings.map(w => [w.text, w])).values()], at: Date.now() };
  cache.set(serverId, { at: Date.now(), data, raw });
  return data;
}
/** Why a container stopped: the last error lines of its log. */
async function stopReason(c, cid) {
  try {
    const buf = await c.getContainer(cid).logs({ stdout: true, stderr: true, tail: 60, timestamps: false });
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); const parts = []; let i = 0;
    if (b.length > 8 && (b[0] === 1 || b[0] === 2) && b[1] === 0) { while (i + 8 <= b.length) { const n = b.readUInt32BE(i + 4); parts.push(b.slice(i + 8, i + 8 + n).toString('utf8')); i += 8 + n; } } else parts.push(b.toString('utf8'));
    const lines = parts.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const bad = lines.filter(l => /\[emerg\]|\[alert\]|\[crit\]|"level":"(error|fatal)"|level=(error|fatal)|\bERR\b|\[ALERT\]|AH0\d{4}.*(error|unable)|fatal|error/i.test(l));
    // the same error is often logged twice (stderr, and the error log with a time in front): kept once, the last ones
    const seen = new Set(); const out = [];
    for (const l of (bad.length ? bad : lines).reverse()) { const k = l.replace(/^\S+ \S+ \[(\w+)\] \d+#\d+: /, 'nginx: [$1] '); if (!seen.has(k)) { seen.add(k); out.unshift(l.slice(0, 300)); } if (out.length === 3) break; }
    return out;
  } catch (e) { return []; }
}
/** Config files of a stopped container, read with the archive API (docker cp): [{ path, text }]. */
async function archiveFiles(c, cid, dir, filter = () => true, limit = 80) {
  const T = require('./tar-lite');
  let stream; try { stream = await c.getContainer(cid).getArchive({ path: dir }); } catch (e) { return []; }
  const entries = T.parseTar(await T.collect(stream));
  const base = dir.replace(/\/[^/]*$/, ''); // the archive holds the last part of dir as its root
  return entries.filter(x => x.type === 'file' && x.data.length < 512 * 1024).map(x => ({ path: `${base}/${x.name}`.replace(/\/+/g, '/'), text: x.data.toString('utf8') })).filter(f => filter(f.path)).slice(0, limit);
}
async function stoppedProxy(c, ct, p, kind, raw, addSite, warnings) {
  const reason = await stopReason(c, ct.Id);
  p.stopReason = reason;
  const info = await c.getContainer(ct.Id).inspect().catch(() => null);
  p.restarting = !!(info && info.State && info.State.Restarting);
  let files = [];
  if (NGINXISH.has(kind)) {
    files = await archiveFiles(c, ct.Id, '/etc/nginx', f => /\.conf$/.test(f) && !/\/(mime\.types|fastcgi|scgi|uwsgi)/.test(f));
    const main = files.find(f => /\/nginx\.conf$/.test(f.path)); if (main) files = [main, ...files.filter(f => f !== main)];
    const parsed = P.parseNginxT(files.map(f => `# configuration file ${f.path}:\n${f.text}`).join('\n'));
    raw.files[p.id] = parsed.files; raw.nginx[p.id] = parsed; raw.certPaths[p.id] = [...new Set(parsed.servers.map(x => x.cert).filter(Boolean))];
    p.config = '/etc/nginx/conf.d';
    for (const st of P.nginxSites(parsed).filter(x => x.domain !== 'localhost')) addSite({ ...st, proxyStopped: true }, p);
  } else if (kind === 'caddy') {
    const cfg = ((ct.Command || '').match(/--config\s+(\S+)/) || [])[1] || '/etc/caddy/Caddyfile';
    files = await archiveFiles(c, ct.Id, cfg); p.config = cfg; raw.files[p.id] = files;
    for (const st of P.parseCaddyfile((files[0] || {}).text || '')) addSite({ ...st, file: cfg, proxyStopped: true }, p);
  } else if (kind === 'haproxy') {
    for (const d of ['/usr/local/etc/haproxy/haproxy.cfg', '/etc/haproxy/haproxy.cfg']) { files = await archiveFiles(c, ct.Id, d); if (files.length) { p.config = d; break; } }
    raw.files[p.id] = files;
    for (const st of P.parseHaproxy((files[0] || {}).text || '')) addSite({ ...st, file: p.config, proxyStopped: true }, p);
  } else if (kind === 'apache') {
    files = await archiveFiles(c, ct.Id, '/usr/local/apache2/conf', f => /\.conf$/.test(f)); raw.files[p.id] = files; p.config = '/usr/local/apache2/conf';
  }
  const n = files.length ? '' : ' (its config could not be read)';
  p.problem = `stopped${reason.length ? ': ' + reason[reason.length - 1] : ''}`;
  warnings.push({ level: 'bad', proxy: p.id, stopped: true, text: `${p.name} is ${p.restarting ? 'restarting again and again' : 'stopped'} — its sites do not answer${reason.length ? `. It says: ${reason[reason.length - 1]}` : ''}${n}.` });
}
async function rawFor(ctx = activeCtx()) { await scan({ ctx }); const hit = cache.get(ctx.serverId); return hit ? hit.raw : { files: {}, nginx: {}, certPaths: {} }; }
async function proxyById(id) { const d = await scan(); const p = d.proxies.find(x => x.id === id); if (!p) throw err('Proxy not found — refresh', 404); return p; }

// ---------- certificates ----------
const CERT_DIRS = 'for d in /data/caddy/certificates /root/.local/share/caddy/certificates /var/lib/caddy/.local/share/caddy/certificates; do [ -d "$d" ] && find "$d" -name "*.crt" 2>/dev/null; done | head -80 | while IFS= read -r f; do echo "@@F $f"; cat "$f"; done';
/** Read certificate files (a path may be a folder of .pem / .crt, as HAProxy's crt allows): "@@F path\n<pem>" chunks. */
const catCerts = (paths) => `for p in ${paths.map(shq).join(' ')}; do if [ -d "$p" ]; then for f in "$p"/*.pem "$p"/*.crt; do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; }; done; elif [ -f "$p" ]; then echo "@@F $p"; cat "$p"; else echo "@@M $p"; fi; done`;
const chunks = (out) => String(out || '').split(/^@@F /m).slice(1).map(part => { const nl = part.indexOf('\n'); return { path: part.slice(0, nl).trim(), pem: part.slice(nl + 1).replace(/^@@M .*$/gm, '') }; });
const missing = (out) => [...String(out || '').matchAll(/^@@M (.+)$/gm)].map(m => m[1].trim());
const isInternalIssuer = (iss) => /Caddy Local Authority|Traefik Default|TRAEFIK DEFAULT/i.test(iss || '');
const isStagingIssuer = (iss) => /STAGING|Fake LE|\(STAGING\)|Pebble|minica/i.test(iss || '');

/** The certificate a proxy really serves for each name (asked on 127.0.0.1:443 from inside it): { name: { notAfter, fp } }. */
async function servedCerts(ctx, p, names) {
  const list = [...new Set(names)].filter(n => P.isDomain(n) && !n.startsWith('*.')).slice(0, 15);
  if (!list.length) return {};
  const sc = `sv() { n=$1; if command -v openssl >/dev/null 2>&1; then r=$(echo | timeout 6 openssl s_client -connect 127.0.0.1:443 -servername "$n" 2>/dev/null | openssl x509 -noout -enddate -fingerprint -sha256 2>/dev/null | tr '\\n' ' '); [ -n "$r" ] && echo "@@S $n $r"; elif command -v curl >/dev/null 2>&1; then r=$(curl -vk -m 6 -o /dev/null --resolve "$n:443:127.0.0.1" "https://$n/" 2>&1 | grep -i 'expire date' | head -1); [ -n "$r" ] && echo "@@S $n $r"; fi; }; ${list.map(n => `sv ${shq(n)}`).join('; ')}; true`;
  const r = p.where === 'container' ? await execIn(ctx.c, p.cid, ['sh', '-c', sc], { timeout: 60000, user: 'root' }).catch(() => null) : await hostExec(ctx.server, sc).catch(() => null);
  const out = {};
  for (const m of String(r ? r.out : '').matchAll(/^@@S (\S+) (.*)$/gm)) {
    const na = (m[2].match(/notAfter=([^=]+?GMT)/) || m[2].match(/expire date:\s*(.+?GMT)/i) || [])[1];
    const fp = (m[2].match(/Fingerprint=([0-9A-F:]+)/i) || [])[1];
    if (na) out[m[1]] = { notAfter: new Date(na).toISOString(), fp: fp ? fp.toUpperCase() : null };
  }
  return out;
}
/** Recent certificate (ACME) errors in the logs of Caddy / Traefik, which renew by themselves. */
async function acmeErrors(ctx, p) {
  let text = '';
  try {
    if (p.where === 'container') {
      const buf = await ctx.c.getContainer(p.cid).logs({ stdout: true, stderr: true, tail: 3000, timestamps: false });
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); let i = 0; const parts = [];
      if (b.length > 8 && (b[0] === 1 || b[0] === 2) && b[1] === 0) { while (i + 8 <= b.length) { const n = b.readUInt32BE(i + 4); parts.push(b.slice(i + 8, i + 8 + n).toString('utf8')); i += 8 + n; } } else parts.push(b.toString('utf8'));
      text = parts.join('');
    } else if (ctx.server) text = (await hostExec(ctx.server, `sudo -n journalctl -u ${shq(p.unit)} -n 3000 --no-pager -o cat 2>/dev/null || journalctl -u ${shq(p.unit)} -n 3000 --no-pager -o cat 2>/dev/null`)).out;
  } catch (e) { return []; }
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n')
    .filter(l => /acme|obtain|certificate|challenge|renew/i.test(l) && /"level":"error"|level=error|\bERR\b|\berror\b|failed/i.test(l) && !/no OCSP/i.test(l))
    .slice(-5).map(l => l.slice(0, 400));
}

async function certificates({ ctx = activeCtx(), fresh = false, served = true } = {}) {
  const d = await scan({ ctx, fresh }); const raw = await rawFor(ctx);
  const c = ctx.c; const server = ctx.server;
  const found = []; // { pem, source, path, proxy, auto, renewer }
  const notes = []; const errors = []; // errors: { proxy, lines }
  const helper = (k) => (d.helpers || []).find(h => h.kind === k);
  const readIn = async (p, paths) => p.where === 'container' ? execIn(c, p.cid, ['sh', '-c', catCerts(paths)], { user: 'root' }) : hostExec(server, rootSh(catCerts(paths)));
  for (const p of d.proxies.filter(x => x.running)) {
    try {
      const texts = (raw.files[p.id] || []).map(f => f.text).join('\n');
      let paths = [];
      if (PX_FILE_CERTS[p.kind]) paths = PX_FILE_CERTS[p.kind](raw, p, texts);
      if (paths.length) {
        const r = await readIn(p, paths);
        for (const ch of chunks(r && r.out)) if (/BEGIN CERTIFICATE/.test(ch.pem)) found.push({ pem: ch.pem, path: ch.path, proxy: p.name, proxyId: p.id, kind: p.kind, ...renewerOf(p, ch.path, helper) });
        for (const m of missing(r && r.out)) notes.push(`${p.name}: ${m} could not be read`);
      }
      if (p.kind === 'caddy' || p.kind === 'caddy-docker-proxy') {
        const r = p.where === 'container' ? await execIn(c, p.cid, ['sh', '-c', CERT_DIRS], { user: 'root' }) : await hostExec(server, rootSh(CERT_DIRS));
        for (const ch of chunks(r && r.out)) found.push({ pem: ch.pem, path: ch.path, proxy: p.name, proxyId: p.id, kind: p.kind, source: 'Caddy', renewer: 'caddy', auto: true });
      } else if (p.kind === 'traefik' && p.where === 'container') {
        const r = await execIn(c, p.cid, ['sh', '-c', 'for f in /letsencrypt/acme.json /acme.json /data/acme.json /etc/traefik/acme.json /etc/traefik/acme/acme.json /certs/acme.json $(find / -maxdepth 4 -name acme.json -not -path "/proc/*" 2>/dev/null | head -3); do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; break; }; done'], { user: 'root' });
        const m = r.out.match(/^@@F (\S+)\n([\s\S]*)$/);
        if (m) for (const x of P.traefikAcme(m[2])) found.push({ pem: x.pem, source: `Traefik (${x.resolver})`, path: m[1], proxy: p.name, proxyId: p.id, kind: p.kind, renewer: 'traefik', auto: true });
        else notes.push(`${p.name}: no acme.json found (Traefik serves its default certificate, or keeps acme.json somewhere DockGate does not look)`);
      }
      if (['caddy', 'caddy-docker-proxy', 'traefik'].includes(p.kind)) { const lines = await acmeErrors(ctx, p); if (lines.length) errors.push({ proxy: p.name, proxyId: p.id, lines }); }
    } catch (e) { notes.push(`${p.name}: ${e.message}`); }
  }
  // certbot on the host (SSH servers and the local host): its certificates, its timer, and whether anything reloads the proxy after a renewal
  let certbot = null;
  if (server) {
    const cmd = 'for d in /etc/letsencrypt/live/*/; do [ -f "$d/cert.pem" ] && { echo "@@F ${d}fullchain.pem"; cat "$d/cert.pem"; }; done; for f in /root/.acme.sh/*/fullchain.cer /home/*/.acme.sh/*/fullchain.cer; do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; }; done; echo "@@HOOKS"; ls /etc/letsencrypt/renewal-hooks/deploy/ 2>/dev/null; grep -lE "^(renew_hook|deploy_hook|post_hook)" /etc/letsencrypt/renewal/*.conf 2>/dev/null; echo "@@END"';
    const r = await hostExec(server, rootSh(cmd)).catch(() => null); // not sudo only: a server without sudo, logged in as root, has certbot too
    const out = r ? r.out : '';
    const head = out.split('@@HOOKS')[0];
    for (const ch of chunks(head)) {
      if (found.some(f => f.path === ch.path)) continue;
      if (/\/\.acme\.sh\//.test(ch.path)) found.push({ pem: ch.pem, path: ch.path, proxy: 'host', source: 'acme.sh', renewer: 'acme.sh', auto: true, label: 'acme.sh — its own cron' });
      else found.push({ pem: ch.pem, path: ch.path, proxy: 'host', source: 'certbot', renewer: 'certbot', auto: true });
    }
    const hooks = ((out.split('@@HOOKS')[1] || '').split('@@END')[0] || '').split('\n').map(x => x.trim()).filter(Boolean);
    const t = await hostExec(server, 'systemctl is-active certbot.timer snap.certbot.renew.timer 2>/dev/null | head -2; ls /etc/cron.d/certbot 2>/dev/null; crontab -l 2>/dev/null | grep -c certbot; sudo -n crontab -l 2>/dev/null | grep -c certbot').catch(() => null);
    const tout = t ? t.out : '';
    const timer = /^active/m.test(tout) ? 'timer' : /cron\.d\/certbot/.test(tout) || tout.split('\n').slice(-3).some(x => /^[1-9]/.test(x.trim())) ? 'cron' : null;
    certbot = { installed: !!r && (head.includes('@@F') || timer != null), timer, hooks, reloads: hooks.length > 0 };
    if (found.some(f => f.renewer === 'certbot') && !certbot.reloads) notes.push('certbot renews, but no deploy hook reloads the web server: after a renewal the old certificate is still served until a reload. "Add a reload hook" fixes it.');
  }
  const certbotLabel = certbot ? (certbot.timer ? `certbot ${certbot.timer} — on` : 'certbot — no timer or cron found') : null;
  // one entry per certificate
  const byFp = new Map();
  for (const f of found) {
    const cert = P.parseCertPem(f.pem); if (!cert) continue;
    const cur = byFp.get(cert.fingerprint);
    if (cur) { if (!cur.paths.includes(f.path)) cur.paths.push(f.path); if (!cur.proxies.includes(f.proxy)) cur.proxies.push(f.proxy); continue; }
    const internal = isInternalIssuer(cert.issuer); const staging = isStagingIssuer(cert.issuer) && !internal;
    let renewal = f.label || (f.renewer === 'caddy' ? 'Caddy — automatic' : f.renewer === 'traefik' ? 'Traefik — automatic' : f.renewer === 'certbot' ? (certbotLabel || 'certbot — not checked') : 'none (a file)');
    if (internal) renewal = `${f.renewer === 'traefik' ? 'Traefik' : 'Caddy'} — internal (automatic)`;
    byFp.set(cert.fingerprint, { ...cert, source: f.source || (f.renewer === 'certbot' ? 'certbot' : 'file'), paths: [f.path], proxies: [f.proxy], proxyIds: f.proxyId ? [f.proxyId] : [], kind: f.kind || null, renewer: internal ? 'internal' : f.renewer || 'none', auto: !!f.auto || internal, renewal, internal, staging, watch: !internal, certbotContainer: f.certbotContainer || null });
  }
  const certs = [...byFp.values()].sort((a, b) => a.daysLeft - b.daysLeft);
  // what each proxy really serves: a certificate renewed on disk but not loaded is still the old one
  if (served) {
    for (const p of d.proxies.filter(x => x.running && ['nginx', 'npm', 'nginx-proxy', 'apache', 'haproxy'].includes(x.kind))) {
      const mine = certs.filter(ct => ct.proxies.includes(p.name));
      if (!mine.length) continue;
      const sv = await servedCerts(ctx, p, mine.flatMap(ct => ct.names.filter(n => d.sites.some(s => s.proxy === p.id && s.domain === n && s.https)).slice(0, 2)));
      for (const ct of mine) for (const n of ct.names) {
        const x = sv[n]; if (!x) continue;
        const stale = x.fp ? x.fp !== ct.fingerprint && new Date(x.notAfter) < new Date(ct.validTo) : new Date(x.notAfter).getTime() < new Date(ct.validTo).getTime() - 86400000;
        ct.served = { name: n, notAfter: x.notAfter, stale, proxy: p.name, proxyId: p.id };
        break;
      }
    }
  }
  const covered = (dom) => certs.some(ct => ct.names.some(n => n === dom || (n.startsWith('*.') && dom.endsWith(n.slice(1)) && dom.split('.').length === n.split('.').length)));
  const uncovered = d.sites.filter(s => s.https && !covered(s.domain)).map(s => s.domain);
  return { server: ctx.serverId, certs, uncovered: [...new Set(uncovered)], notes, errors, certbot, helpers: d.helpers || [], certbotRenew: certbotLabel };
}
/** Certificate files named in each proxy's config. */
const PX_FILE_CERTS = {
  nginx: (raw, p) => raw.certPaths[p.id] || [],
  npm: (raw, p) => raw.certPaths[p.id] || [],
  'nginx-proxy': (raw, p) => raw.certPaths[p.id] || [],
  apache: (raw, p, t) => [...new Set([...t.matchAll(/^\s*SSLCertificateFile\s+"?([^"\s]+)"?/gim)].map(m => m[1]))].slice(0, 60),
  traefik: (raw, p, t) => [...new Set([...t.matchAll(/certFile\s*[:=]\s*["']?([^"'\s]+)/g)].map(m => m[1]))].slice(0, 40), // file provider tls.certificates
  haproxy: (raw, p, t) => [...new Set([...t.matchAll(/^\s*bind\s[^#\n]*?\bcrt\s+(\S+)/gim)].map(m => m[1].replace(/\/+$/, '')))].slice(0, 20),
};
/** Who renews a certificate file found in a proxy's config. */
function renewerOf(p, path, helper) {
  if (p.kind === 'npm') return /letsencrypt/.test(path) ? { source: 'Nginx Proxy Manager', renewer: 'npm', auto: true, label: 'Nginx Proxy Manager — automatic' } : { source: 'Nginx Proxy Manager', renewer: 'none', label: 'uploaded in Nginx Proxy Manager (not renewed)' };
  if (p.kind === 'nginx-proxy') { const h = helper('acme-companion'); return h ? { source: 'acme-companion', renewer: 'acme-companion', auto: true, label: `acme-companion — automatic${h.running ? '' : ' (container stopped!)'}` } : { source: 'file', renewer: 'none' }; }
  if (/\/letsencrypt\//.test(path)) { const h = helper('certbot'); return h ? { source: 'certbot', renewer: 'certbot', auto: true, label: `certbot container ${h.name}${h.running ? '' : ' (stopped!)'}`, certbotContainer: h.name } : { source: 'certbot', renewer: 'certbot', auto: true }; }
  if (/\/dockgate-certs\/|\/etc\/dockgate\/certs\//.test(path)) return { source: 'DockGate', renewer: 'dockgate', auto: true, label: 'DockGate — automatic' };
  return { source: 'file', renewer: 'none' };
}

// ---------- config files ----------
async function files(id) {
  const p = await proxyById(id); const raw = await rawFor();
  if (raw.files[id] && raw.files[id].length && p.kind !== 'traefik') return { proxy: p.name, kind: p.kind, files: raw.files[id].map(f => ({ ...f, managed: p.kind === 'npm' && /^\/data\//.test(f.path) ? 'Nginx Proxy Manager' : /letsencrypt/.test(f.path) ? 'certbot' : null })) };
  if (p.kind === 'traefik' || p.kind === 'caddy-docker-proxy') {
    const d = await scan();
    const text = d.sites.filter(s => s.proxy === id).map(s => `# ${s.domain}  (${s.file})\n${s.router ? `traefik.http.routers.${s.router}.rule=Host(\`${s.domain}\`)\n` : ''}→ ${s.target ? s.target.label : '?'}${s.https ? '   (HTTPS' + (s.resolver ? ', ' + s.resolver : '') + ')' : ''}\n`).join('\n');
    return { proxy: p.name, kind: p.kind, files: [...(raw.files[id] || []), { path: `${p.kind === 'traefik' ? 'Traefik' : 'Caddy'} labels (read-only summary)`, text: text || '# no labels found' }] };
  }
  return { proxy: p.name, kind: p.kind, files: [], note: p.problem || 'No config files read for this proxy.' };
}

// ---------- logs ----------
/**
 * The log files a proxy's config names (nginx access_log / error_log, Apache CustomLog / ErrorLog), so a proxy that
 * logs to files and not to the console is read too. /dev/stdout, syslog and "off" are left out (docker logs has them).
 */
function logPaths(raw, p, which) {
  const files = (raw.files[p.id] || []).map(f => f.text).join('\n');
  const re = NGINXISH.has(p.kind) ? (which === 'error' ? /(?:^|[;{\s])error_log\s+([^\s;]+)/gm : /(?:^|[;{\s])access_log\s+([^\s;]+)/gm) // also in one-line blocks
    : p.kind === 'apache' ? (which === 'error' ? /^\s*ErrorLog\s+"?([^\s"]+)/gm : /^\s*CustomLog\s+"?([^\s"]+)/gm) : null;
  if (!re) return [];
  const root = p.apacheRoot || (p.where === 'host' ? '/etc/apache2' : '/usr/local/apache2');
  const out = new Set();
  for (const m of files.matchAll(re)) {
    let f = m[1];
    if (/^(off|stderr|syslog:|\||\/dev\/|\/proc\/)/.test(f) || /\$(?!\{APACHE_LOG_DIR\})/.test(f)) continue; // nginx variables in a path: one file per value, not read
    f = f.replace('${APACHE_LOG_DIR}', '/var/log/apache2');
    if (!f.startsWith('/')) f = p.kind === 'apache' ? `${root}/${f}` : `/etc/nginx/${f}`;
    out.add(f);
  }
  if (!out.size && p.where === 'host') { // the distribution's defaults
    const d = { nginx: { access: ['/var/log/nginx/access.log'], error: ['/var/log/nginx/error.log'] }, apache: { access: ['/var/log/apache2/access.log', '/var/log/httpd/access_log'], error: ['/var/log/apache2/error.log', '/var/log/httpd/error_log'] } }[p.kind];
    if (d) (d[which] || d.access).forEach(x => out.add(x));
  }
  return [...out].slice(0, 12);
}
const tailFiles = (paths, n) => paths.map(f => `[ -f ${shq(f)} ] && tail -n ${n} ${shq(f)}`).join('; ') + '; true'; // -f: not a link to /dev/stdout (that would never end)

async function logs(id, which = 'access', tail = 400) {
  const p = await proxyById(id); const c = dockerService.docker; const server = activeCtx().server; const raw = await rawFor();
  const n = Math.max(50, Math.min(2000, Number(tail) || 400));
  const paths = which === 'all' ? [...new Set([...logPaths(raw, p, 'access'), ...logPaths(raw, p, 'error')])] : logPaths(raw, p, which);
  let lines = []; const sources = [];
  if (p.where === 'container') {
    const buf = await c.getContainer(p.cid).logs({ stdout: which !== 'error', stderr: which !== 'access', tail: n, timestamps: false });
    const out = []; let i = 0; const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
    if (b.length > 8 && (b[0] === 1 || b[0] === 2) && b[1] === 0) { while (i + 8 <= b.length) { const len = b.readUInt32BE(i + 4); out.push(b.slice(i + 8, i + 8 + len).toString('utf8')); i += 8 + len; } } else out.push(b.toString('utf8'));
    lines = out.join('').split('\n'); if (lines.some(l => l.trim())) sources.push('the container\'s output');
    if (paths.length && p.running) {
      const r = await execIn(c, p.cid, ['sh', '-c', tailFiles(paths, n)], { user: 'root' }).catch(() => null);
      const fl = r ? r.out.split('\n') : [];
      if (fl.some(l => l.trim())) { lines = lines.concat(fl); sources.push(paths.join(', ')); }
    }
  } else if (server) {
    const cmd = paths.length ? rootSh(tailFiles(paths, n)) : `sudo -n journalctl -u ${shq(p.unit)} -n ${n} --no-pager -o cat 2>/dev/null || journalctl -u ${shq(p.unit)} -n ${n} --no-pager -o cat`;
    lines = (await hostExec(server, cmd)).out.split('\n'); sources.push(paths.length ? paths.join(', ') : `journal of ${p.unit}`);
  }
  lines = lines.map(l => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).filter(l => l.trim()); // no terminal colour codes
  let entries = lines.map(l => ({ line: l.slice(0, 2000), ...(P.parseAccessLine(l) || P.parseCaddyJsonLine(l) || {}) }));
  if (sources.length > 1) { // two sources: in time order where the time is known, then the last n
    const t = (e) => { if (!e.time) return 0; const d = Date.parse(String(e.time).replace(/^(\d+)\/(\w+)\/(\d+):(\d+:\d+:\d+)\s*/, '$2 $1 $3 $4 ')); return Number.isNaN(d) ? 0 : d; };
    entries = entries.map((e, i) => ({ e, i, t: t(e) })).sort((a, b) => (a.t && b.t ? a.t - b.t : a.i - b.i)).map(x => x.e).slice(-n);
  }
  const parsed = entries.filter(e => e.status);
  const stats = parsed.length ? { requests: parsed.length, s5xx: parsed.filter(e => e.status >= 500).length, s4xx: parsed.filter(e => e.status >= 400 && e.status < 500).length } : null;
  return { proxy: p.name, which, entries, stats, sources };
}

// ---------- check (read-only) ----------
async function testConfig(id) {
  const p = await proxyById(id); const c = dockerService.docker; const server = activeCtx().server;
  const cmd = NGINXISH.has(p.kind) ? 'nginx -t' : p.kind === 'caddy' ? `caddy validate --config ${p.config || '/etc/caddy/Caddyfile'} --adapter caddyfile` : p.kind === 'haproxy' ? `haproxy -c -f ${p.config}` : p.kind === 'apache' ? (p.where === 'container' ? 'httpd -t' : 'apachectl configtest') : null;
  if (!cmd) throw err(`${LABEL[p.kind] || p.kind} has no config check here (its config is in labels)`);
  const r = p.where === 'container' ? await execIn(c, p.cid, ['sh', '-c', cmd + ' 2>&1']) : await hostExec(server, sudoTry(cmd));
  return { ok: r.code === 0, command: cmd, output: (r.out + r.err).trim().slice(-4000) };
}

module.exports = { logPaths, kindOfConfig, stopReason, activeCtx, servedCerts, acmeErrors, isInternalIssuer, isStagingIssuer, scan, certificates, files, logs, testConfig, kindOf, execIn, hostExec, rawFor, proxyById, LABEL, NGINXISH, invalidate: () => cache.clear(), _cache: cache };
