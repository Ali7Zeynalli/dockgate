// Web → Proxies & SSL (PX1, read-only): the web servers in front of the apps of the server in use — nginx,
// OpenResty, Nginx Proxy Manager, nginx-proxy, Caddy (also caddy-docker-proxy), Traefik, HAProxy, Apache — in
// containers and (on SSH servers) as host services; which domain goes where, the certificates, config files and
// logs. Nothing is changed here: configs are read (nginx -T, the Caddyfile, labels…), "Test config" runs the
// proxy's own check (nginx -t, caddy validate…).
const P = require('./proxy-parse');
const dockerService = require('./docker');
const RC = require('./remote-compose');

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
  return null;
}
const LABEL = { nginx: 'nginx', npm: 'Nginx Proxy Manager', 'nginx-proxy': 'nginx-proxy', caddy: 'Caddy', 'caddy-docker-proxy': 'Caddy (docker-proxy)', traefik: 'Traefik', haproxy: 'HAProxy', apache: 'Apache' };
const NGINXISH = new Set(['nginx', 'npm', 'nginx-proxy']);

/** docker exec with stdout / stderr kept apart (demuxed). */
async function execIn(c, id, cmd, { timeout = 15000 } = {}) {
  const ex = await c.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
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
  const r = await RC.execRemote(server, cmd);
  return { code: r.code, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const sudoTry = (cmd) => `sudo -n ${cmd} 2>&1 || ${cmd} 2>&1`;

// ---------- the scan ----------
const cache = new Map(); // serverId → { at, data, raw }
async function scan({ fresh = false } = {}) {
  const serverId = dockerService.getActiveServerId() || 'local';
  const hit = cache.get(serverId);
  if (!fresh && hit && Date.now() - hit.at < 20000) return hit.data;
  const c = dockerService.docker;
  const server = RC.getActiveRemoteServer();
  const containers = await c.listContainers({ all: true });
  const raw = { files: {}, nginx: {}, certPaths: {} }; // per proxy id: config files etc. (for the other tabs)
  const proxies = []; const sites = []; const warnings = [];

  // index of containers for resolving targets
  const byName = new Map(); const byIp = new Map();
  for (const ct of containers) {
    const name = (ct.Names || [''])[0].replace(/^\//, '');
    const L = ct.Labels || {};
    const info = { id: ct.Id, name, running: ct.State === 'running', state: ct.State, project: L['com.docker.compose.project'] || null, service: L['com.docker.compose.service'] || L['com.docker.swarm.service.name'] || null };
    byName.set(name, info);
    if (info.service && !byName.has(info.service)) byName.set(info.service, info);
    if (L['com.docker.swarm.service.name']) byName.set(L['com.docker.swarm.service.name'], info);
    for (const n of Object.values((ct.NetworkSettings || {}).Networks || {})) if (n.IPAddress) byIp.set(n.IPAddress, info);
  }
  const resolve = (target, proxy) => {
    if (!target) return null;
    const t = String(target).replace(/^https?:\/\//, '');
    if (t === 'unix') return { label: 'unix socket', kind: 'socket' };
    const [host, port] = t.split(':');
    const ct = byName.get(host) || byIp.get(host) || byName.get(host.replace(/\.\d+\..*$/, ''));
    if (ct) return { label: `${ct.name}${port ? ':' + port : ''}`, kind: 'container', container: { name: ct.name, running: ct.running, state: ct.state, project: ct.project, id: ct.id } };
    if (/^(127\.0\.0\.1|localhost|::1)$/.test(host)) return { label: t, kind: proxy.where === 'host' ? 'host' : 'self', note: proxy.where === 'host' ? 'a program on the server' : 'the proxy container itself' };
    if (host === 'host.docker.internal' || /^172\.17\.0\.1$/.test(host)) return { label: t, kind: 'host', note: 'a program on the server' };
    return { label: t, kind: 'other', note: 'not a container of this server' };
  };
  const addSite = (s, proxy) => sites.push({ ...s, proxy: proxy.id, proxyName: proxy.name, proxyKind: proxy.kind, target: s.targets && s.targets.length ? resolve(s.targets[0], proxy) : (s.root ? { label: `files: ${s.root}`, kind: 'files' } : null), targetsAll: (s.targets || []).map(t => resolve(t, proxy)) });

  // ---- proxies in containers ----
  const labelled = []; // containers with Traefik / caddy labels
  for (const ct of containers) {
    const L = ct.Labels || {};
    if (Object.keys(L).some(k => k.startsWith('traefik.http.routers.')) || Object.keys(L).some(k => /^caddy(_\d+)?$/.test(k))) labelled.push(ct);
    const kind = kindOf(ct.Image);
    if (!kind || kind === 'certbot') continue;
    const name = (ct.Names || [''])[0].replace(/^\//, '');
    const p = { id: 'c:' + ct.Id.slice(0, 12), cid: ct.Id, name, kind, label: LABEL[kind], image: ct.Image, where: 'container', project: L['com.docker.compose.project'] || L['com.docker.stack.namespace'] || null, state: ct.State, running: ct.State === 'running',
      ports: [...new Set((ct.Ports || []).filter(x => x.PublicPort).map(x => x.PublicPort))].sort((a, b) => a - b), version: (ct.Image.split(':')[1] || 'latest'), config: null, sites: 0, managedBy: kind === 'npm' ? 'Nginx Proxy Manager' : kind === 'nginx-proxy' ? 'nginx-proxy (from container env)' : null, problem: null };
    proxies.push(p);
    if (!p.running) continue;
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
        if (kind === 'nginx' && !realNames && !parsed.servers.some(sv => sv.proxyPass || sv.locations.some(l => l.proxyPass)) && !p.ports.some(x => [80, 443].includes(x))) { p.appServer = true; continue; }
        const v = await execIn(c, ct.Id, ['nginx', '-v']).catch(() => null); const vm = v && (v.err + v.out).match(/nginx\/(\S+)|openresty\/(\S+)/); if (vm) p.version = vm[1] || vm[2];
        for (const s of P.nginxSites(parsed).filter(x => x.domain !== 'localhost')) addSite({ ...s, managed: kind === 'npm' && /^\/data\//.test(s.file) ? 'Nginx Proxy Manager' : kind === 'nginx-proxy' ? 'nginx-proxy' : null }, p);
        raw.certPaths[p.id] = [...new Set(parsed.servers.map(s => s.cert).filter(Boolean))];
      } else if (kind === 'caddy') {
        const path = (() => { const cmd = (ct.Command || '') + ''; const m = cmd.match(/--config\s+(\S+)/); return m ? m[1] : '/etc/caddy/Caddyfile'; })();
        const r = await execIn(c, ct.Id, ['cat', path]);
        p.config = path; raw.files[p.id] = r.code === 0 ? [{ path, text: r.out }] : [];
        if (r.code !== 0) p.problem = `${path} could not be read`;
        const v = await execIn(c, ct.Id, ['caddy', 'version']).catch(() => null); if (v && v.code === 0) p.version = v.out.trim().split(/\s+/)[0];
        for (const s of P.parseCaddyfile(r.out)) addSite({ ...s, file: path }, p);
      } else if (kind === 'haproxy') {
        const r = await execIn(c, ct.Id, ['sh', '-c', 'for f in /usr/local/etc/haproxy/haproxy.cfg /etc/haproxy/haproxy.cfg; do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; break; }; done']);
        const m = r.out.match(/^@@F (\S+)\n([\s\S]*)$/);
        if (m) { p.config = m[1]; raw.files[p.id] = [{ path: m[1], text: m[2] }]; for (const s of P.parseHaproxy(m[2])) addSite({ ...s, file: m[1] }, p); } else p.problem = 'haproxy.cfg not found';
      } else if (kind === 'apache') {
        const r = await execIn(c, ct.Id, ['sh', '-c', 'httpd -S 2>&1 || apachectl -S 2>&1']);
        for (const s of P.parseApacheS(r.out)) addSite({ domain: s.domain, https: s.port === 443, file: s.file, line: s.line, targets: [] }, p);
        p.config = '/usr/local/apache2/conf';
      } else if (kind === 'traefik' || kind === 'caddy-docker-proxy') {
        p.config = kind === 'traefik' ? 'labels of the containers and services' : 'caddy labels of the containers';
      }
    } catch (e) { p.problem = e.message; }
  }

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
  if (traefik && !labelSources.some(s => Object.keys(s.labels).some(k => k.startsWith('traefik.http.routers.')))) traefik.problem = traefik.problem || 'no router labels found (file provider configs are not read yet)';

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

  // ---- host services (SSH servers) ----
  let ports = [];
  if (server) {
    const tag = '@@PX';
    const script = `for s in nginx caddy apache2 httpd haproxy traefik; do if systemctl cat "$s.service" >/dev/null 2>&1; then echo "${tag}S $s $(systemctl is-active $s 2>/dev/null) $(systemctl is-enabled $s 2>/dev/null)"; fi; done
echo "${tag}P"; (sudo -n ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null) | awk '{print $4" "$6}' | grep -E ':(80|443|8080|8443) ' ; echo "${tag}E"`;
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
          raw.certPaths[p.id] = [...new Set(parsed.servers.map(s => s.cert).filter(Boolean))];
        } else if (kind === 'caddy') {
          const t = await hostExec(server, sudoTry('cat /etc/caddy/Caddyfile'));
          p.config = '/etc/caddy/Caddyfile'; raw.files[p.id] = [{ path: p.config, text: t.out }];
          const v = await hostExec(server, 'caddy version 2>/dev/null'); if (v && v.code === 0) p.version = v.out.trim().split(/\s+/)[0];
          for (const s of P.parseCaddyfile(t.out)) addSite({ ...s, file: p.config }, p);
        } else if (kind === 'haproxy') {
          const t = await hostExec(server, sudoTry('cat /etc/haproxy/haproxy.cfg'));
          p.config = '/etc/haproxy/haproxy.cfg'; raw.files[p.id] = [{ path: p.config, text: t.out }];
          for (const s of P.parseHaproxy(t.out)) addSite({ ...s, file: p.config }, p);
        } else if (kind === 'apache') {
          const t = await hostExec(server, sudoTry('apachectl -S'));
          p.config = '/etc/apache2 or /etc/httpd';
          for (const s of P.parseApacheS(t.out)) addSite({ domain: s.domain, https: s.port === 443, file: s.file, line: s.line, targets: [] }, p);
        }
      } catch (e) { p.problem = e.message; }
    }
    const psec = (out.match(/@@PXP\n([\s\S]*?)@@PXE/) || [])[1] || '';
    for (const line of psec.split('\n').filter(Boolean)) {
      const [addr, proc] = line.split(' ');
      const port = Number(addr.split(':').pop());
      const who = (String(proc || '').match(/\("([^"]+)"/) || [])[1] || (proc ? '' : 'unknown (needs sudo to see)');
      if (!ports.some(x => x.port === port && x.process === who)) ports.push({ port, addr, process: who || 'unknown' });
    }
    for (const p of proxies.filter(x => x.where === 'host')) p.ports = [...new Set(ports.filter(x => x.process === p.unit || (p.unit === 'apache2' && x.process === 'apache2')).map(x => x.port))];
  }
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

  const data = { server: serverId, remote: !!server, appServers, proxies, sites: sites.sort((a, b) => a.domain.localeCompare(b.domain)), ports: [...new Map([...ports.map(x => [x.port + x.process, x])]).values()], warnings: [...new Map(warnings.map(w => [w.text, w])).values()], at: Date.now() };
  cache.set(serverId, { at: Date.now(), data, raw });
  return data;
}
async function rawFor(id) { await scan(); const hit = cache.get(dockerService.getActiveServerId() || 'local'); return hit ? hit.raw : { files: {}, nginx: {}, certPaths: {} }; }
async function proxyById(id) { const d = await scan(); const p = d.proxies.find(x => x.id === id); if (!p) throw err('Proxy not found — refresh', 404); return p; }

// ---------- certificates ----------
async function certificates() {
  const d = await scan(); const raw = await rawFor();
  const c = dockerService.docker; const server = RC.getActiveRemoteServer();
  const found = []; // { pem, source, path, proxy }
  const notes = [];
  for (const p of d.proxies.filter(x => x.running)) {
    try {
      if (NGINXISH.has(p.kind)) {
        for (const path of raw.certPaths[p.id] || []) {
          const r = p.where === 'container' ? await execIn(c, p.cid, ['cat', path]) : await hostExec(server, sudoTry(`cat ${shq(path)}`));
          if (r && /BEGIN CERTIFICATE/.test(r.out)) found.push({ pem: r.out, source: /letsencrypt/.test(path) ? 'certbot' : 'file', path, proxy: p.name });
          else notes.push(`${p.name}: ${path} could not be read`);
        }
      } else if (p.kind === 'caddy' || p.kind === 'caddy-docker-proxy') {
        const cmd = 'for d in /data/caddy/certificates /root/.local/share/caddy/certificates /var/lib/caddy/.local/share/caddy/certificates; do [ -d "$d" ] && find "$d" -name "*.crt" 2>/dev/null; done | head -60 | while IFS= read -r f; do echo "@@F $f"; cat "$f"; done';
        const r = p.where === 'container' ? await execIn(c, p.cid, ['sh', '-c', cmd]) : await hostExec(server, `sudo -n sh -c ${shq(cmd)} 2>/dev/null || sh -c ${shq(cmd)}`);
        for (const part of (r ? r.out : '').split('@@F ').slice(1)) { const nl = part.indexOf('\n'); found.push({ pem: part.slice(nl + 1), source: 'Caddy', path: part.slice(0, nl), proxy: p.name, auto: true }); }
      } else if (p.kind === 'traefik' && p.where === 'container') {
        const r = await execIn(c, p.cid, ['sh', '-c', 'for f in /letsencrypt/acme.json /acme.json /data/acme.json /etc/traefik/acme.json /etc/traefik/acme/acme.json /certs/acme.json $(find / -maxdepth 3 -name acme.json 2>/dev/null | head -3); do [ -f "$f" ] && { echo "@@F $f"; cat "$f"; break; }; done']);
        const m = r.out.match(/^@@F (\S+)\n([\s\S]*)$/);
        if (m) for (const x of P.traefikAcme(m[2])) found.push({ pem: x.pem, source: `Traefik (${x.resolver})`, path: m[1], proxy: p.name, auto: true });
        else notes.push(`${p.name}: no acme.json found`);
      }
    } catch (e) { notes.push(`${p.name}: ${e.message}`); }
  }
  let certbotRenew = null;
  if (server) {
    const cmd = 'for d in /etc/letsencrypt/live/*/; do [ -f "$d/cert.pem" ] && { echo "@@F ${d}cert.pem"; cat "$d/cert.pem"; }; done';
    const r = await hostExec(server, `sudo -n sh -c ${shq(cmd)} 2>/dev/null`).catch(() => null);
    for (const part of (r ? r.out : '').split('@@F ').slice(1)) { const nl = part.indexOf('\n'); const path = part.slice(0, nl); if (!found.some(f => f.path === path)) found.push({ pem: part.slice(nl + 1), source: 'certbot', path, proxy: 'host' }); }
    const t = await hostExec(server, 'systemctl is-active certbot.timer snap.certbot.renew.timer 2>/dev/null | head -2; ls /etc/cron.d/certbot 2>/dev/null; crontab -l 2>/dev/null | grep -c certbot').catch(() => null);
    certbotRenew = t ? (/^active/m.test(t.out) ? 'certbot timer — on' : /cron\.d\/certbot/.test(t.out) || /^[1-9]/m.test(t.out.split('\n').pop() || '') ? 'certbot cron' : 'no renewal found') : null;
  }
  if (d.proxies.some(p => p.kind === 'certbot')) certbotRenew = certbotRenew || 'certbot container';
  const byFp = new Map();
  for (const f of found) {
    const cert = P.parseCertPem(f.pem); if (!cert) continue;
    const cur = byFp.get(cert.fingerprint);
    if (cur) { if (!cur.paths.includes(f.path)) cur.paths.push(f.path); if (!cur.proxies.includes(f.proxy)) cur.proxies.push(f.proxy); continue; }
    byFp.set(cert.fingerprint, { ...cert, source: f.source, paths: [f.path], proxies: [f.proxy], renewal: f.auto ? `${f.source.split(' ')[0]} — automatic` : f.source === 'certbot' ? (certbotRenew || 'certbot — not checked') : 'none (a file)' });
  }
  const certs = [...byFp.values()].sort((a, b) => a.daysLeft - b.daysLeft);
  // sites without a readable certificate
  const covered = (dom) => certs.some(c => c.names.some(n => n === dom || (n.startsWith('*.') && dom.endsWith(n.slice(1)) && dom.split('.').length === n.split('.').length)));
  const uncovered = d.sites.filter(s => s.https && !covered(s.domain)).map(s => s.domain);
  return { certs, uncovered: [...new Set(uncovered)], notes, certbotRenew };
}

// ---------- config files ----------
async function files(id) {
  const p = await proxyById(id); const raw = await rawFor();
  if (raw.files[id] && raw.files[id].length) return { proxy: p.name, kind: p.kind, files: raw.files[id].map(f => ({ ...f, managed: p.kind === 'npm' && /^\/data\//.test(f.path) ? 'Nginx Proxy Manager' : /letsencrypt/.test(f.path) ? 'certbot' : null })) };
  if (p.kind === 'traefik' || p.kind === 'caddy-docker-proxy') {
    const d = await scan();
    const text = d.sites.filter(s => s.proxy === id).map(s => `# ${s.domain}  (${s.file})\n${s.router ? `traefik.http.routers.${s.router}.rule=Host(\`${s.domain}\`)\n` : ''}→ ${s.target ? s.target.label : '?'}${s.https ? '   (HTTPS' + (s.resolver ? ', ' + s.resolver : '') + ')' : ''}\n`).join('\n');
    return { proxy: p.name, kind: p.kind, files: [{ path: `${p.kind === 'traefik' ? 'Traefik' : 'Caddy'} labels (read-only summary)`, text: text || '# no labels found' }] };
  }
  return { proxy: p.name, kind: p.kind, files: [], note: p.problem || 'No config files read for this proxy.' };
}

// ---------- logs ----------
async function logs(id, which = 'access', tail = 400) {
  const p = await proxyById(id); const c = dockerService.docker; const server = RC.getActiveRemoteServer();
  const n = Math.max(50, Math.min(2000, Number(tail) || 400));
  let lines = [];
  if (p.where === 'container') {
    const buf = await c.getContainer(p.cid).logs({ stdout: which !== 'error', stderr: which !== 'access', tail: n, timestamps: false });
    const out = []; let i = 0; const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
    if (b.length > 8 && (b[0] === 1 || b[0] === 2) && b[1] === 0) { while (i + 8 <= b.length) { const len = b.readUInt32BE(i + 4); out.push(b.slice(i + 8, i + 8 + len).toString('utf8')); i += 8 + len; } } else out.push(b.toString('utf8'));
    lines = out.join('').split('\n');
  } else if (server) {
    const files = { nginx: { access: '/var/log/nginx/access.log', error: '/var/log/nginx/error.log' }, apache: { access: '/var/log/apache2/access.log /var/log/httpd/access_log', error: '/var/log/apache2/error.log /var/log/httpd/error_log' } }[p.kind];
    const cmd = files ? `for f in ${files[which] || files.access}; do [ -f "$f" ] && { sudo -n tail -n ${n} "$f" 2>/dev/null || tail -n ${n} "$f"; break; }; done` : `sudo -n journalctl -u ${shq(p.unit)} -n ${n} --no-pager -o cat 2>/dev/null || journalctl -u ${shq(p.unit)} -n ${n} --no-pager -o cat`;
    lines = (await hostExec(server, cmd)).out.split('\n');
  }
  lines = lines.map(l => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).filter(l => l.trim()); // no terminal colour codes
  const entries = lines.map(l => ({ line: l.slice(0, 2000), ...(P.parseAccessLine(l) || P.parseCaddyJsonLine(l) || {}) }));
  const parsed = entries.filter(e => e.status);
  const stats = parsed.length ? { requests: parsed.length, s5xx: parsed.filter(e => e.status >= 500).length, s4xx: parsed.filter(e => e.status >= 400 && e.status < 500).length } : null;
  return { proxy: p.name, which, entries, stats };
}

// ---------- check (read-only) ----------
async function testConfig(id) {
  const p = await proxyById(id); const c = dockerService.docker; const server = RC.getActiveRemoteServer();
  const cmd = NGINXISH.has(p.kind) ? 'nginx -t' : p.kind === 'caddy' ? `caddy validate --config ${p.config || '/etc/caddy/Caddyfile'} --adapter caddyfile` : p.kind === 'haproxy' ? `haproxy -c -f ${p.config}` : p.kind === 'apache' ? (p.where === 'container' ? 'httpd -t' : 'apachectl configtest') : null;
  if (!cmd) throw err(`${LABEL[p.kind] || p.kind} has no config check here (its config is in labels)`);
  const r = p.where === 'container' ? await execIn(c, p.cid, ['sh', '-c', cmd + ' 2>&1']) : await hostExec(server, sudoTry(cmd));
  return { ok: r.code === 0, command: cmd, output: (r.out + r.err).trim().slice(-4000) };
}

module.exports = { scan, certificates, files, logs, testConfig, kindOf, _cache: cache };
