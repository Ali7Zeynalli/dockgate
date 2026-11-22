// Web → Proxies & SSL — changing proxies safely (PX2–PX4):
//   · edit a config file: earlier version kept → write → the proxy's own check → reload → the sites still
//     answer as before; any step fails → the earlier files are put back (and reloaded)
//   · put a container on a domain (nginx, Caddy, HAProxy, Apache files; Traefik / caddy-docker-proxy labels),
//     joining the proxy to the container's network when they share none
//   · Let's Encrypt certificates for nginx and Apache sites (DockGate is the ACME client; the challenge is
//     answered by the proxy from ACME_ROOT), stored and renewed by DockGate (30 days before expiry)
//   · load balancing (nginx upstream, Caddy reverse_proxy, HAProxy backend), Traefik's live API, access-log stats
// Files under a read-only mount of a proxy container are written through a short-lived helper container that
// mounts the same source read-write.
const crypto = require('crypto');
const { db, stmts } = require('./db');
const dockerService = require('./docker');
const RC = require('./remote-compose');
const PX = require('./proxies');
const G = require('./proxy-gen');
const P = require('./proxy-parse');
const ACME = require('./acme');
const { encrypt, decrypt } = require('./auth/secrets');

db.exec(`CREATE TABLE IF NOT EXISTS proxy_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, proxy TEXT NOT NULL, path TEXT NOT NULL,
  text TEXT, existed INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, user TEXT, note TEXT)`);
db.exec(`CREATE INDEX IF NOT EXISTS proxy_versions_path ON proxy_versions (server_id, proxy, path, at)`);
db.exec(`CREATE TABLE IF NOT EXISTS proxy_certs (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, proxy TEXT NOT NULL, proxy_kind TEXT, proxy_where TEXT,
  names TEXT NOT NULL, cert_path TEXT NOT NULL, key_path TEXT NOT NULL, cert_pem TEXT, key_enc TEXT, not_after TEXT, issued_at INTEGER, auto INTEGER NOT NULL DEFAULT 1,
  last_try INTEGER, last_error TEXT, directory TEXT, UNIQUE (server_id, proxy, cert_path))`);
const q = {
  addVer: db.prepare('INSERT INTO proxy_versions (server_id, proxy, path, text, existed, at, user, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  vers: db.prepare('SELECT id, path, existed, at, user, note, length(text) AS size FROM proxy_versions WHERE server_id = ? AND proxy = ? AND (? IS NULL OR path = ?) ORDER BY id DESC LIMIT 100'),
  ver: db.prepare('SELECT * FROM proxy_versions WHERE id = ? AND server_id = ?'),
  prune: db.prepare('DELETE FROM proxy_versions WHERE server_id = ? AND proxy = ? AND path = ? AND id NOT IN (SELECT id FROM proxy_versions WHERE server_id = ? AND proxy = ? AND path = ? ORDER BY id DESC LIMIT 30)'),
  certs: db.prepare('SELECT * FROM proxy_certs WHERE server_id = ? ORDER BY not_after'),
  allCerts: db.prepare('SELECT * FROM proxy_certs'),
  cert: db.prepare('SELECT * FROM proxy_certs WHERE id = ?'),
  upCert: db.prepare(`INSERT INTO proxy_certs (server_id, proxy, proxy_kind, proxy_where, names, cert_path, key_path, cert_pem, key_enc, not_after, issued_at, auto, last_try, last_error, directory)
    VALUES (@server_id, @proxy, @proxy_kind, @proxy_where, @names, @cert_path, @key_path, @cert_pem, @key_enc, @not_after, @issued_at, 1, @last_try, NULL, @directory)
    ON CONFLICT(server_id, proxy, cert_path) DO UPDATE SET names = excluded.names, key_path = excluded.key_path, cert_pem = excluded.cert_pem, key_enc = excluded.key_enc,
      not_after = excluded.not_after, issued_at = excluded.issued_at, last_try = excluded.last_try, last_error = NULL, directory = excluded.directory`),
  certTry: db.prepare('UPDATE proxy_certs SET last_try = ?, last_error = ? WHERE id = ?'),
  certAuto: db.prepare('UPDATE proxy_certs SET auto = ? WHERE id = ?'),
  delCert: db.prepare('DELETE FROM proxy_certs WHERE id = ?'),
};
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const err = (m, code = 400, extra = {}) => Object.assign(new Error(m), { statusCode: code }, extra);
const sha = (t) => crypto.createHash('sha256').update(String(t == null ? '' : t)).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getSetting = (k, d = null) => { const r = stmts.getSetting.get(k); return r ? r.value : d; };
const PATH_RE = /^\/[\w.@+\-/ ]{1,400}$/;
const checkPath = (p) => { if (!PATH_RE.test(String(p || '')) || /(^|\/)\.\.(\/|$)/.test(p)) throw err(`Not a file path: ${p}`); return p; };

// ---------- where commands run ----------
function activeCtx() { return { serverId: dockerService.getActiveServerId() || 'local', c: dockerService.docker, server: RC.getActiveRemoteServer() }; }
function ctxFor(serverId) {
  if (!serverId || serverId === 'local') return { serverId: 'local', c: dockerService.createLocalClient(), server: null };
  const s = stmts.getServer.get(serverId); if (!s) throw err(`Server ${serverId} is gone`, 404);
  return { serverId, c: dockerService.createSshClient(s), server: s };
}
const asRoot = (script) => `if [ "$(id -u)" = 0 ]; then sh -c ${shq(script)}; elif sudo -n true 2>/dev/null; then sudo -n sh -c ${shq(script)}; else sh -c ${shq(script)}; fi`;
async function run(ctx, p, script) {
  if (p.where === 'container') return PX.execIn(ctx.c, p.cid, ['sh', '-c', script], { timeout: 60000, user: 'root' }); // images like haproxy run as a user that may not write its own config
  if (!ctx.server) throw err('Host proxies are only reached on SSH servers');
  return PX.hostExec(ctx.server, asRoot(script));
}
/** A helper container with `source` (a host path or a volume) at /w, read-write. */
async function helper(ctx, source, script) {
  const img = 'alpine';
  try { await ctx.c.getImage(img).inspect(); } catch (e) {
    await new Promise((res, rej) => ctx.c.pull(img, (e2, st) => e2 ? rej(e2) : ctx.c.modem.followProgress(st, (e3) => e3 ? rej(e3) : res())));
  }
  const ct = await ctx.c.createContainer({ Image: img, Cmd: ['sh', '-c', script], Labels: { 'dockgate.helper': 'proxy-file' }, HostConfig: { Binds: [`${source}:/w`], NetworkMode: 'none' } });
  try {
    await ct.start(); const w = await ct.wait();
    const buf = await ct.logs({ stdout: true, stderr: true });
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); let out = ''; let i = 0;
    if (b.length > 8 && (b[0] === 1 || b[0] === 2) && b[1] === 0) { while (i + 8 <= b.length) { const n = b.readUInt32BE(i + 4); out += b.slice(i + 8, i + 8 + n).toString('utf8'); i += 8 + n; } } else out = b.toString('utf8');
    return { code: w.StatusCode, out, err: '' };
  } finally { await ct.remove({ force: true }).catch(() => {}); }
}
const mountCache = new Map();
async function mountsOf(ctx, p) {
  if (p.where !== 'container') return [];
  const k = ctx.serverId + p.cid; const hit = mountCache.get(k); if (hit && Date.now() - hit.at < 30000) return hit.m;
  const info = await ctx.c.getContainer(p.cid).inspect(); const m = info.Mounts || [];
  mountCache.set(k, { at: Date.now(), m, networks: Object.keys((info.NetworkSettings || {}).Networks || {}) }); return m;
}
/** How to reach `path` of proxy p: { exec(script), path, persistent, via } */
async function place(ctx, p, path) {
  checkPath(path);
  if (p.where !== 'container') return { exec: (s) => run(ctx, p, s), path, persistent: true, via: 'host' };
  const m = (await mountsOf(ctx, p)).filter(x => path === x.Destination || path.startsWith(x.Destination.replace(/\/$/, '') + '/')).sort((a, b) => b.Destination.length - a.Destination.length)[0];
  if (m && m.RW === false) {
    const src = m.Type === 'volume' ? m.Name : m.Source;
    const inner = '/w' + path.slice(m.Destination.length);
    return { exec: (s) => helper(ctx, src, s), path: inner || '/w', persistent: true, via: `helper (${m.Destination} is mounted read-only)` };
  }
  return { exec: (s) => run(ctx, p, s), path, persistent: !!m, via: 'container' };
}
async function readFile(ctx, p, path) {
  const pl = await place(ctx, p, path);
  const r = await pl.exec(`if [ -f ${shq(pl.path)} ]; then echo @@DGY; cat ${shq(pl.path)}; else echo @@DGN; fi`);
  const out = r.out || '';
  if (out.startsWith('@@DGY\n')) return { exists: true, text: out.slice(6) };
  if (out.startsWith('@@DGN')) return { exists: false, text: '' };
  throw err(`${path} could not be read: ${(r.err || out).trim().slice(0, 200)}`, 502);
}
async function writeFile(ctx, p, path, text, { mode = null } = {}) {
  const pl = await place(ctx, p, path);
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const CH = 60000; const dir = pl.path.replace(/\/[^/]*$/, '') || '/';
  const fin = mode ? ` && chmod ${mode} ${shq(pl.path)}` : '';
  const fail = (r) => { if (r.code !== 0) throw err(`${path} could not be written: ${(r.err || r.out).trim().slice(0, 300)}`, 502); };
  // `cat > file` keeps the file itself (a bind-mounted single file can not be replaced by a rename)
  if (b64.length <= CH) fail(await pl.exec(`mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(pl.path)}.dgtmp && cat ${shq(pl.path)}.dgtmp > ${shq(pl.path)} && rm -f ${shq(pl.path)}.dgtmp${fin}`));
  else if (/helper/.test(pl.via)) { // each helper run is a new container: no temp file between runs; apply() puts the old file back on failure
    for (let i = 0; i < b64.length; i += CH) fail(await pl.exec(`printf %s ${shq(b64.slice(i, i + CH))} | base64 -d ${i ? '>>' : '>'} ${shq(pl.path)}${i + CH >= b64.length ? fin : ''}`));
  } else {
    const tmp = `${pl.path}.dgtmp`;
    for (let i = 0; i < b64.length; i += CH) fail(await pl.exec(`${i ? '' : `mkdir -p ${shq(dir)} && `}printf %s ${shq(b64.slice(i, i + CH))} | base64 -d ${i ? '>>' : '>'} ${shq(tmp)}`));
    fail(await pl.exec(`cat ${shq(tmp)} > ${shq(pl.path)} && rm -f ${shq(tmp)}${fin}`));
  }
  return { persistent: pl.persistent, via: pl.via };
}
async function removeFile(ctx, p, path) { const pl = await place(ctx, p, path); await pl.exec(`rm -f ${shq(pl.path)}`); }

// ---------- the proxy's own commands ----------
function cmds(p) {
  const cont = p.where === 'container';
  if (PX.NGINXISH.has(p.kind)) return { test: 'nginx -t', reload: cont ? 'nginx -s reload' : 'systemctl reload nginx 2>/dev/null || nginx -s reload' };
  if (p.kind === 'caddy') { const cfg = p.config || '/etc/caddy/Caddyfile'; return { test: `caddy validate --config ${shq(cfg)} --adapter caddyfile`, reload: `caddy reload --config ${shq(cfg)} --adapter caddyfile${cont ? '' : ' 2>/dev/null || systemctl reload caddy'}` }; }
  if (p.kind === 'haproxy') return { test: `haproxy -c -f ${shq(p.config)}`, reload: cont ? 'kill -USR2 1' : 'systemctl reload haproxy' };
  if (p.kind === 'apache') return { test: cont ? 'httpd -t' : 'apachectl configtest', reload: cont ? 'httpd -k graceful' : 'apachectl graceful 2>/dev/null || systemctl reload apache2 2>/dev/null || systemctl reload httpd' };
  return null;
}
/** HTTP status of each domain asked from the proxy itself (127.0.0.1), before and after a change. */
async function probe(ctx, p, domains) {
  const list = [...new Set(domains)].filter(d => P.isDomain(d) && !d.startsWith('*.')).slice(0, 8);
  if (!list.length) return {};
  const script = `pr() { d=$1; if command -v curl >/dev/null 2>&1; then for sp in https:443 http:80; do s=\${sp%%:*}; po=\${sp##*:}; c=$(curl -sk -o /dev/null -m 6 -w '%{http_code}' --resolve "$d:$po:127.0.0.1" "$s://$d/" 2>/dev/null); if [ -n "$c" ] && [ "$c" != 000 ]; then echo "@@P $d $c"; return; fi; done; elif command -v wget >/dev/null 2>&1; then c=$(wget -q -S -O /dev/null -T 6 --header "Host: $d" "http://127.0.0.1/" 2>&1 | awk '/HTTP\\//{c=$2} END{print c}'); echo "@@P $d \${c:-000}"; return; fi; echo "@@P $d 000"; }; ${list.map(d => `pr ${shq(d)}`).join('; ')}`;
  const r = await run(ctx, p, script).catch(() => ({ out: '' }));
  const res = {}; for (const m of String(r.out).matchAll(/@@P (\S+) (\d{3})/g)) res[m[1]] = Number(m[2]);
  return res;
}
const healthy = (c) => c > 0 && c < 500;

const locks = new Set();
/**
 * Apply file changes to proxy p: [{ path, text }] (text null = remove). Earlier versions are kept, then the check,
 * reload and site probe run; on any failure the earlier files go back. → { ok, stage, steps, output, probe }
 */
async function apply(ctx, p, changes, { domains = [], user = null, note = '', versions = true, probeSites = true } = {}) {
  const C = cmds(p); if (!C) throw err(`${PX.LABEL[p.kind] || p.kind} is configured by labels, not files`);
  const key = ctx.serverId + p.name; if (locks.has(key)) throw err(`A change to ${p.name} is running — wait for it`, 409);
  locks.add(key);
  const steps = []; const step = (t, ok = true) => steps.push({ t, ok });
  const old = [];
  const restore = async () => { for (const o of old.reverse()) { if (o.existed) await writeFile(ctx, p, o.path, o.text).catch(() => {}); else await removeFile(ctx, p, o.path).catch(() => {}); } };
  try {
    for (const ch of changes) { const cur = await readFile(ctx, p, ch.path); old.push({ path: ch.path, existed: cur.exists, text: cur.text }); }
    const before = probeSites ? await probe(ctx, p, domains) : {};
    if (versions) for (const o of old) { q.addVer.run(ctx.serverId, p.name, o.path, o.text, o.existed ? 1 : 0, Date.now(), user, note || null); q.prune.run(ctx.serverId, p.name, o.path, ctx.serverId, p.name, o.path); }
    let notPersistent = [];
    for (const ch of changes) {
      if (ch.text == null) { await removeFile(ctx, p, ch.path); step(`Removed ${ch.path}`); }
      else { const w = await writeFile(ctx, p, ch.path, ch.text, { mode: ch.mode }); step(`Wrote ${ch.path}${w.via !== 'container' && w.via !== 'host' ? ` (through a ${w.via})` : ''}`); if (!w.persistent) notPersistent.push(ch.path); }
    }
    const t = await run(ctx, p, `${C.test} 2>&1`);
    const out = (t.out + t.err).trim();
    if (t.code !== 0) { step(`${C.test} — failed`, false); await restore(); step('Put the earlier files back'); return { ok: false, stage: 'test', steps, output: out.slice(-4000) }; }
    step(`${C.test} — ok`);
    const r = await run(ctx, p, `${C.reload} 2>&1`);
    if (r.code !== 0) { step('Reload — failed', false); await restore(); await run(ctx, p, `${C.reload} 2>&1`).catch(() => {}); step('Put the earlier files back and reloaded'); return { ok: false, stage: 'reload', steps, output: (r.out + r.err).trim().slice(-4000) }; }
    step('Reloaded');
    let after = {};
    if (probeSites && Object.keys(before).length && Object.values(before).every(c => !c)) step(`The sites could not be asked from inside ${p.name} (no curl or wget there, or none answered before) — open them to check`);
    else if (probeSites && Object.keys(before).length) {
      await sleep(1500); after = await probe(ctx, p, Object.keys(before));
      const broke = Object.keys(before).filter(d => healthy(before[d]) && !healthy(after[d] || 0));
      if (broke.length) {
        step(`Sites stopped answering: ${broke.map(d => `${d} (${before[d]} → ${after[d] || 'no answer'})`).join(', ')}`, false);
        await restore(); await run(ctx, p, `${C.reload} 2>&1`).catch(() => {}); step('Put the earlier files back and reloaded');
        return { ok: false, stage: 'check', steps, output: '', probe: { before, after } };
      }
      step(`Sites answer as before: ${Object.keys(before).map(d => `${d} ${after[d] || '—'}`).join(', ')}`);
    }
    PX.invalidate();
    return { ok: true, steps, output: out.slice(-2000), probe: { before, after }, notPersistent };
  } catch (e) {
    step(e.message, false); await restore().catch(() => {}); return { ok: false, stage: 'error', steps, output: e.message };
  } finally { locks.delete(key); }
}

// ---------- editing files ----------
function lockReason(p, path) {
  if (p.kind === 'traefik' || p.kind === 'caddy-docker-proxy') return `${PX.LABEL[p.kind]} is configured by container labels`;
  if (p.kind === 'nginx-proxy') return 'nginx-proxy writes its config from the containers\' VIRTUAL_HOST — change those instead';
  if (p.kind === 'npm') return 'Nginx Proxy Manager keeps this config — change it in its own web UI';
  if (/\/letsencrypt\//.test(path)) return 'certbot keeps this file';
  return null;
}
async function knownFiles(p) { const raw = await PX.rawFor(); return (raw.files[p.id] || []).map(f => f.path); }
async function openFile(id, path) {
  const p = await PX.proxyById(id); const ctx = activeCtx();
  if (!(await knownFiles(p)).includes(path)) throw err('Not a config file of this proxy', 404);
  const f = await readFile(ctx, p, path);
  const pl = await place(ctx, p, path);
  return { path, text: f.text, base: sha(f.text), locked: lockReason(p, path), persistent: pl.persistent, via: pl.via, dockgate: G.isDockgateFile(f.text) };
}
function domainsFor(d, p, path) {
  const mine = d.sites.filter(s => s.proxy === p.id);
  const inFile = mine.filter(s => s.file === path);
  return [...inFile, ...mine.filter(s => s.file !== path)].map(s => s.domain).slice(0, 8);
}
async function saveFile(id, { path, text, base, note }, user) {
  const p = await PX.proxyById(id); const ctx = activeCtx();
  if (!(await knownFiles(p)).includes(path)) throw err('Not a config file of this proxy', 404);
  const lock = lockReason(p, path); if (lock) throw err(lock, 409);
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw err('The file is too big (1 MB at most)');
  const cur = await readFile(ctx, p, path);
  if (base && sha(cur.text) !== base) throw err('The file changed on the server after you opened it', 409, { conflict: { text: cur.text, base: sha(cur.text) } });
  if (cur.text === text) return { ok: true, steps: [{ t: 'No change', ok: true }] };
  return apply(ctx, p, [{ path, text }], { domains: domainsFor(await PX.scan(), p, path), user, note: note || 'edited' });
}
function versions(id, path) {
  return PX.proxyById(id).then(p => q.vers.all(activeCtx().serverId, p.name, path || null, path || null));
}
async function versionText(id, vid) { const p = await PX.proxyById(id); const v = q.ver.get(Number(vid), activeCtx().serverId); if (!v || v.proxy !== p.name) throw err('Version not found', 404); return { ...v, text: v.existed ? v.text : '' }; }
async function restoreVersion(id, vid, user) {
  const p = await PX.proxyById(id); const ctx = activeCtx();
  const v = q.ver.get(Number(vid), ctx.serverId); if (!v || v.proxy !== p.name) throw err('Version not found', 404);
  return apply(ctx, p, [{ path: v.path, text: v.existed ? v.text : null }], { domains: domainsFor(await PX.scan(), p, v.path), user, note: `restored version ${v.id}` });
}

// ---------- the proxy's network and the target container ----------
async function containerInfo(ctx, name) {
  const info = await ctx.c.getContainer(name).inspect().catch(() => null);
  if (!info) throw err(`No container ${name}`, 404);
  const nets = (info.NetworkSettings || {}).Networks || {};
  return { name: info.Name.replace(/^\//, ''), id: info.Id, running: info.State.Running, networks: Object.keys(nets), ips: Object.fromEntries(Object.entries(nets).map(([k, v]) => [k, v.IPAddress])),
    exposed: Object.keys((info.Config || {}).ExposedPorts || {}).map(x => Number(x.split('/')[0])).filter(Boolean),
    published: Object.entries((info.NetworkSettings || {}).Ports || {}).flatMap(([k, v]) => (v || []).map(b => ({ port: Number(k.split('/')[0]), host: Number(b.HostPort), ip: b.HostIp }))),
    project: (info.Config.Labels || {})['com.docker.compose.project'] || null, service: (info.Config.Labels || {})['com.docker.compose.service'] || null, labels: info.Config.Labels || {} };
}
/** The containers a site can go to (running, not proxies), with their ports. */
async function targets() {
  const ctx = activeCtx(); const list = await ctx.c.listContainers({ all: false });
  return list.filter(ct => !PX.kindOf(ct.Image) || PX.kindOf(ct.Image) === 'nginx').map(ct => ({ name: (ct.Names || [''])[0].replace(/^\//, ''), image: ct.Image,
    project: (ct.Labels || {})['com.docker.compose.project'] || null, ports: [...new Set((ct.Ports || []).map(x => x.PrivatePort))].sort((a, b) => a - b) })).sort((a, b) => a.name.localeCompare(b.name));
}
/** How proxy p reaches container `name` on `port`: { addr, network?, join?, note? } */
async function route(ctx, p, name, port) {
  const t = await containerInfo(ctx, name);
  if (p.where === 'container') {
    await mountsOf(ctx, p); const pn = (mountCache.get(ctx.serverId + p.cid) || {}).networks || [];
    const shared = t.networks.filter(n => pn.includes(n) && n !== 'host' && n !== 'none');
    const named = shared.find(n => n !== 'bridge');
    if (named) return { addr: `${t.name}:${port}`, network: named, dns: true };
    const join = t.networks.find(n => !['bridge', 'host', 'none'].includes(n));
    if (join) return { addr: `${t.name}:${port}`, network: join, join, dns: true, note: `${p.name} joins the network ${join} (no restart) so it can reach ${t.name} by name.` };
    if (shared.includes('bridge') && t.ips.bridge) return { addr: `${t.ips.bridge}:${port}`, network: 'bridge', note: `Both are only on Docker's default network, where names do not work: the address ${t.ips.bridge} changes when ${t.name} is re-created. Put both on a shared network to use the name.` };
    throw err(`${p.name} can not reach ${t.name}: no shared network and ${t.name} is on no network ${p.name} could join`);
  }
  const pub = t.published.find(b => b.port === Number(port));
  if (pub) return { addr: `127.0.0.1:${pub.host}`, note: pub.ip && pub.ip !== '0.0.0.0' && pub.ip !== '127.0.0.1' && pub.ip !== '::' ? `Published on ${pub.ip}` : null };
  const ip = Object.values(t.ips).find(Boolean);
  if (ip) return { addr: `${ip}:${port}`, note: `${t.name} does not publish port ${port}; the host reaches it at ${ip}, which changes when the container is re-created. Publishing it on 127.0.0.1 is steadier.` };
  throw err(`The host can not reach ${t.name}:${port}`);
}

/** Where a new site file goes for an nginx / Apache proxy. */
async function siteFileFor(p, domain) {
  const files = await knownFiles(p); const raw = await PX.rawFor();
  const main = ((raw.files[p.id] || [])[0] || {}).text || '';
  if (PX.NGINXISH.has(p.kind)) {
    const inc = [...main.matchAll(/include\s+([^;]+);/g)].map(m => m[1].trim());
    const confd = inc.find(i => /conf\.d\/\*\.conf$/.test(i)); const sites = inc.find(i => /sites-enabled\/\*$/.test(i));
    const dir = confd ? confd.replace(/\/\*\.conf$/, '') : sites ? sites.replace(/\/\*$/, '') : (files.find(f => /\/conf\.d\//.test(f)) || '/etc/nginx/conf.d/x').replace(/\/[^/]+$/, '');
    return { path: `${dir.startsWith('/') ? dir : '/etc/nginx/' + dir}/${domain}.conf` };
  }
  if (p.kind === 'apache') {
    if (p.where === 'container') return { path: `/usr/local/apache2/conf/dockgate/${domain}.conf`, include: { file: '/usr/local/apache2/conf/httpd.conf', line: 'IncludeOptional conf/dockgate/*.conf' } };
    if (files.some(f => f.startsWith('/etc/apache2/'))) return { path: `/etc/apache2/sites-enabled/dg-${domain}.conf` };
    return { path: `/etc/httpd/conf.d/dg-${domain}.conf` };
  }
  return null;
}
async function traefikInfo(ctx, p) {
  const info = await ctx.c.getContainer(p.cid).inspect().catch(() => null);
  const args = info ? [...new Set([...(info.Config.Cmd || []), ...(info.Args || [])])].join(' ') : '';
  const entrypoints = [...new Map([...args.matchAll(/--entry[pP]oints\.([\w-]+)\.address=([^\s]*)/g)].map(m => [m[1], { name: m[1], port: Number((m[2].match(/:(\d+)/) || [])[1]) || null }])).values()];
  const resolvers = [...new Set([...args.matchAll(/--certificates[rR]esolvers\.([\w-]+)\./g)].map(m => m[1]))];
  const api = /--api\.insecure(=true)?(\s|$)/.test(args) ? 8080 : /--api(\.dashboard)?(=true)?(\s|$)/.test(args) ? 8080 : null;
  const apiPort = (entrypoints.find(e => e.name === 'traefik') || {}).port || api;
  return { entrypoints, resolvers, apiPort, networks: info ? Object.keys(info.NetworkSettings.Networks || {}) : [] };
}

// ---------- put a container on a domain ----------
async function exposePlan(body) {
  const ctx = activeCtx(); const d = await PX.scan({ fresh: true });
  const p = d.proxies.find(x => x.id === body.proxy); if (!p) throw err('Choose a proxy', 400);
  if (!p.running) throw err(`${p.name} is not running`);
  if (p.kind === 'npm') throw err('Nginx Proxy Manager adds sites in its own web UI (Hosts → Proxy Hosts)');
  if (p.kind === 'nginx-proxy') throw err('nginx-proxy: set VIRTUAL_HOST (and LETSENCRYPT_HOST) on the container instead');
  const targetsIn = (Array.isArray(body.targets) && body.targets.length ? body.targets : [{ container: body.container, port: body.port }]).filter(t => t && t.container);
  if (!targetsIn.length) throw err('Choose the container the domain goes to');
  const routes = []; for (const t of targetsIn) { const port = Number(t.port); if (!(port > 0 && port < 65536)) throw err(`Port of ${t.container}?`); routes.push({ ...(await route(ctx, p, t.container, port)), container: t.container, port }); }
  const domain = String(body.domain || '').trim().toLowerCase();
  const existing = d.sites.find(s => s.domain === domain);
  const notes = routes.map(r => r.note).filter(Boolean);
  if (existing) notes.push(`${domain} is already set up in ${existing.proxyName} — two proxies for one name is a conflict.`);
  if (p.kind === 'apache' && !d.sites.some(s => s.proxy === p.id)) notes.push('This is the first site on this Apache: Apache answers every unknown domain with its first site, so it replaces the default page.');
  if (p.ports.length && !p.ports.some(x => [80, 443].includes(x)) && p.where === 'container') notes.push(`${p.name} publishes ${p.ports.join(', ')}, not 80 / 443: the site will be at those ports, and Let's Encrypt needs port 80.`);
  const join = [...new Set(routes.filter(r => r.join).map(r => r.join))];
  const base = { ...body, domain, targets: routes.map(r => r.addr), dockerDns: p.where === 'container' && routes.every(r => r.dns) };
  if (p.kind === 'traefik' || p.kind === 'caddy-docker-proxy') {
    const ti = p.kind === 'traefik' ? await traefikInfo(ctx, p) : { entrypoints: [], resolvers: [] };
    const t0 = await containerInfo(ctx, targetsIn[0].container);
    const labels = p.kind === 'traefik' ? G.traefikLabels({ ...base, targets: [`${t0.name}:${targetsIn[0].port}`] }, { entrypoints: ti.entrypoints, resolver: body.resolver || ti.resolvers[0] || null }) : G.caddyLabels({ ...base, targets: [`${t0.name}:${targetsIn[0].port}`] });
    if (p.kind === 'traefik' && base.https !== 'none' && !ti.resolvers.length) notes.push('Traefik has no certificate resolver configured: it serves its default (self-signed) certificate until one is added.');
    return { mode: 'labels', proxy: p, labels, text: G.labelsText(t0.service || t0.name, labels), container: t0.name, project: t0.project, join, notes };
  }
  const https = p.kind === 'caddy' ? (body.https === 'none' ? 'none' : 'auto') : body.https;
  const input = { ...base, https };
  G.siteInput(input);
  const changes = []; let flow = null;
  if (PX.NGINXISH.has(p.kind) || p.kind === 'apache') {
    const sf = await siteFileFor(p, domain);
    const cur = await readFile(ctx, p, sf.path); if (cur.exists) throw err(`${sf.path} already exists`);
    let certPath = body.certPath, keyPath = body.keyPath;
    if (https === 'existing' && (!certPath || !keyPath)) throw err('Choose the certificate and key files');
    if (https === 'letsencrypt') { flow = 'letsencrypt'; ({ certPath, keyPath } = await certPlace(ctx, p, domain)); }
    const gen = p.kind === 'apache' ? G.apacheSite : G.nginxSite;
    const opt = { loadModules: p.kind === 'apache' && p.where === 'container' };
    changes.push({ path: sf.path, text: gen({ ...input, certPath, keyPath }, { ...opt, certReady: https !== 'letsencrypt' }), final: https === 'letsencrypt' ? gen({ ...input, certPath, keyPath }, { ...opt, certReady: true }) : null });
    if (p.kind === 'apache' && p.where === 'host') notes.push('Apache on the server: DockGate turns on the proxy modules it needs (a2enmod proxy proxy_http headers rewrite ssl proxy_balancer) before the check.');
    if (sf.include) { const inc = await readFile(ctx, p, sf.include.file); if (!inc.text.includes(sf.include.line)) changes.push({ path: sf.include.file, text: inc.text.replace(/\s*$/, `\n${sf.include.line}\n`) }); }
    return { mode: 'file', proxy: p, changes: await withBefore(ctx, p, changes), flow, certPath, keyPath, join, notes };
  }
  if (p.kind === 'caddy') { const cur = await readFile(ctx, p, p.config); changes.push({ path: p.config, text: G.caddyAdd(cur.text, input) }); }
  else if (p.kind === 'haproxy') { const cur = await readFile(ctx, p, p.config); changes.push({ path: p.config, text: G.haproxyAdd(cur.text, input) }); if (https !== 'none') notes.push('HAProxy: HTTPS works when its frontend already has a certificate (bind … ssl crt). DockGate adds the routing only.'); }
  else throw err(`${PX.LABEL[p.kind] || p.kind}: not supported`);
  return { mode: 'file', proxy: p, changes: await withBefore(ctx, p, changes), join, notes };
}
async function withBefore(ctx, p, changes) { for (const c of changes) c.before = (await readFile(ctx, p, c.path)).text; return changes; }

async function expose(body, user, log = () => {}) {
  const ctx = activeCtx(); const plan = await exposePlan(body);
  const p = plan.proxy;
  for (const net of plan.join) {
    log(`Joining ${p.name} to the network ${net}…`);
    try { await ctx.c.getNetwork(net).connect({ Container: p.cid }); } catch (e) { if (!/already exists|endpoint with name/i.test(e.message)) throw err(`Could not join ${net}: ${e.message}`, 502); }
    mountCache.delete(ctx.serverId + p.cid);
  }
  if (plan.mode === 'labels') return { ok: true, labels: plan.labels, text: plan.text, steps: [{ t: 'Labels ready — add them to the container (they apply when it is re-created)', ok: true }] };
  const domain = String(body.domain).toLowerCase();
  if (p.kind === 'apache' && p.where === 'host') await run(ctx, p, 'command -v a2enmod >/dev/null 2>&1 && a2enmod -q proxy proxy_http headers rewrite ssl proxy_balancer lbmethod_byrequests lbmethod_bybusyness proxy_wstunnel slotmem_shm socache_shmcb >/dev/null 2>&1; true');
  const res = await apply(ctx, p, plan.changes.map(c => ({ path: c.path, text: c.text })), { domains: [], user, note: `site ${domain}`, probeSites: false });
  if (!res.ok || plan.flow !== 'letsencrypt') return { ...res, site: domain };
  log('The HTTP site is live; asking Let\'s Encrypt for a certificate…');
  try {
    const names = [domain, ...G.siteInput({ ...body, domain, targets: ['x:1'] }).aliases];
    await obtain(ctx, p, names, plan.certPath, plan.keyPath, log);
    res.steps.push({ t: `Certificate for ${names.join(', ')} saved`, ok: true });
  } catch (e) {
    res.steps.push({ t: `Let's Encrypt: ${e.message}`, ok: false });
    return { ...res, ok: false, stage: 'certificate', site: domain, output: 'The site works over HTTP. Fix the reason above (DNS of the domain must point to this server; port 80 must be open) and press "Get certificate" on the site.' };
  }
  const fin = plan.changes[0];
  const r2 = await apply(ctx, p, [{ path: fin.path, text: fin.final }], { domains: [], user, note: `HTTPS for ${domain}`, probeSites: false });
  return { ...r2, steps: [...res.steps, ...r2.steps], site: domain };
}

/** Remove a site DockGate made. */
async function removeSite(id, domain, user) {
  const p = await PX.proxyById(id); const ctx = activeCtx(); const d = await PX.scan();
  const s = d.sites.find(x => x.proxy === id && x.domain === domain); if (!s) throw err('Site not found', 404);
  const path = s.file && s.file.startsWith('/') ? s.file : p.config;
  const cur = await readFile(ctx, p, path);
  let change;
  if (G.isDockgateFile(cur.text) && (PX.NGINXISH.has(p.kind) || p.kind === 'apache')) change = { path, text: null };
  else { const r = G.removeMarked(cur.text, domain); if (!r.changed) throw err(`${domain} was not added by DockGate — remove it in the editor`, 409); change = { path, text: r.text }; }
  return apply(ctx, p, [change], { domains: domainsFor(d, p, path).filter(x => x !== domain), user, note: `removed ${domain}` });
}

// ---------- certificates (Let's Encrypt through DockGate) ----------
function acmeSettings() {
  const dirKey = getSetting('proxy_acme_directory', 'letsencrypt');
  return { email: getSetting('proxy_acme_email', ''), directory: dirKey, directoryUrl: ACME.DIRECTORIES[dirKey] || dirKey, renewDays: Number(getSetting('proxy_acme_renew_days', '30')) || 30 };
}
function setAcmeSettings({ email, directory, renewDays }) {
  if (email != null) { const e = String(email).trim(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw err('Not an email address'); stmts.setSetting.run('proxy_acme_email', e); }
  if (directory != null) { const dd = String(directory).trim(); if (!ACME.DIRECTORIES[dd] && !/^https:\/\/\S+$/.test(dd) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(dd)) throw err('Directory: letsencrypt, letsencrypt-staging or an https:// URL (http:// only for a test CA on this machine)'); stmts.setSetting.run('proxy_acme_directory', dd); }
  if (renewDays != null) { const n = Number(renewDays); if (!(n >= 7 && n <= 60)) throw err('Renew: 7–60 days before expiry'); stmts.setSetting.run('proxy_acme_renew_days', String(n)); }
  return acmeSettings();
}
/** Where DockGate keeps a certificate of proxy p: next to the site config when that is on a mount, so it outlives the container. */
async function certPlace(ctx, p, domain) {
  let dir;
  if (p.where !== 'container') dir = `/etc/dockgate/certs/${domain}`;
  else {
    const sf = (await siteFileFor(p, domain)) || { path: '/etc/nginx/conf.d/x' };
    const base = sf.path.replace(/\/[^/]+$/, '');
    const pl = await place(ctx, p, base + '/x');
    dir = pl.persistent ? `${base}/dockgate-certs/${domain}` : `${PX.NGINXISH.has(p.kind) ? '/etc/nginx' : '/usr/local/apache2/conf'}/dockgate-certs/${domain}`;
  }
  return { certPath: `${dir}/fullchain.pem`, keyPath: `${dir}/privkey.pem` };
}
async function obtain(ctx, p, names, certPath, keyPath, log = () => {}) {
  const st = acmeSettings();
  const accKey = getSetting(`proxy_acme_account:${st.directoryUrl}`);
  const challengeDir = `${G.ACME_ROOT}/.well-known/acme-challenge`;
  const res = await ACME.issue({
    directory: st.directoryUrl, email: st.email || undefined, accountKeyPem: accKey ? decrypt(accKey) : null, domains: names, log,
    setChallenge: async (token, keyAuth) => { const r = await run(ctx, p, `mkdir -p ${shq(challengeDir)} && printf %s ${shq(keyAuth)} > ${shq(`${challengeDir}/${token}`)} && chmod 755 ${shq(G.ACME_ROOT)} ${shq(G.ACME_ROOT + '/.well-known')} ${shq(challengeDir)} && chmod 644 ${shq(`${challengeDir}/${token}`)}`); if (r.code !== 0) throw err(`Could not write the challenge: ${(r.err || r.out).trim()}`, 502); },
    clearChallenge: async (token) => { await run(ctx, p, `rm -f ${shq(`${challengeDir}/${token}`)}`); },
  });
  stmts.setSetting.run(`proxy_acme_account:${st.directoryUrl}`, encrypt(res.accountKeyPem));
  await writeFile(ctx, p, keyPath, res.keyPem, { mode: '600' });
  await writeFile(ctx, p, certPath, res.certPem, { mode: '644' });
  q.upCert.run({ server_id: ctx.serverId, proxy: p.name, proxy_kind: p.kind, proxy_where: p.where, names: JSON.stringify(names), cert_path: certPath, key_path: keyPath,
    cert_pem: res.certPem, key_enc: encrypt(res.keyPem), not_after: res.notAfter, issued_at: Date.now(), last_try: Date.now(), directory: st.directoryUrl });
  return res;
}
/** Get (or replace) a Let's Encrypt certificate for an existing nginx site: challenge location, certificate, HTTPS. */
async function certForSite(id, domain, { redirect = true } = {}, user, log = () => {}) {
  const p = await PX.proxyById(id); const ctx = activeCtx(); const d = await PX.scan({ fresh: true });
  if (!PX.NGINXISH.has(p.kind) || p.kind !== 'nginx') {
    if (p.kind === 'caddy' || p.kind === 'caddy-docker-proxy' || p.kind === 'traefik') throw err(`${PX.LABEL[p.kind]} gets its certificates itself`);
    throw err('DockGate gets certificates for nginx sites (Apache: sites DockGate made)');
  }
  const site = d.sites.find(s => s.proxy === id && s.domain === domain); if (!site) throw err('Site not found', 404);
  const file = site.file; const cur = await readFile(ctx, p, file);
  const names = [...new Set([domain, ...((d.sites.filter(s => s.proxy === id && s.file === file && s.domain !== domain && s.https === site.https)).map(s => s.domain))])].slice(0, 20);
  const steps = [];
  const a = G.nginxEnsureAcme(cur.text, domain);
  if (a.changed) {
    const r = await apply(ctx, p, [{ path: file, text: a.text }], { domains: names, user, note: `challenge location for ${domain}` });
    steps.push(...r.steps); if (!r.ok) return r;
  }
  const { certPath, keyPath } = await certPlace(ctx, p, domain);
  try { await obtain(ctx, p, names, certPath, keyPath, log); steps.push({ t: `Certificate for ${names.join(', ')} saved to ${certPath}`, ok: true }); }
  catch (e) { steps.push({ t: `Let's Encrypt: ${e.message}`, ok: false }); return { ok: false, stage: 'certificate', steps, output: 'Check that the domain\'s DNS points to this server and port 80 reaches the proxy.' }; }
  const now = (await readFile(ctx, p, file)).text;
  const next = G.nginxAddHttps(now, domain, certPath, keyPath, { redirect });
  const r = await apply(ctx, p, [{ path: file, text: next.text }], { domains: names, user, note: `HTTPS for ${domain}` });
  if (!r.ok) r.steps.push({ t: `The certificate is kept at ${certPath} (and renewed). Fix what stopped the site, then press again — or Forget it under Certificates.`, ok: true });
  return { ...r, steps: [...steps, ...r.steps] };
}
function certList(serverId = activeCtx().serverId) {
  return q.certs.all(serverId).map(r => ({ id: r.id, proxy: r.proxy, names: JSON.parse(r.names), certPath: r.cert_path, notAfter: r.not_after, daysLeft: r.not_after ? Math.floor((new Date(r.not_after) - Date.now()) / 86400000) : null,
    issuedAt: r.issued_at, auto: !!r.auto, lastTry: r.last_try, lastError: r.last_error, directory: r.directory }));
}
async function findProxy(ctx, row) {
  if (row.proxy_where === 'host') return { id: 'h:' + row.proxy, name: row.proxy, kind: row.proxy_kind, where: 'host', unit: row.proxy };
  const list = await ctx.c.listContainers({ all: false, filters: { name: [row.proxy] } });
  const ct = list.find(x => (x.Names || []).includes('/' + row.proxy)); if (!ct) throw err(`${row.proxy} is not running`, 404);
  return { id: 'c:' + ct.Id.slice(0, 12), cid: ct.Id, name: row.proxy, kind: row.proxy_kind, where: 'container' };
}
/** Renew one DockGate certificate: new certificate → files (the old ones kept in memory) → check → reload; a failed check puts them back. */
async function renew(rowId, { log = () => {}, ctx: given } = {}) {
  const row = q.cert.get(Number(rowId)); if (!row) throw err('Certificate not found', 404);
  const ctx = given || (row.server_id === activeCtx().serverId ? activeCtx() : ctxFor(row.server_id));
  const p = await findProxy(ctx, row);
  const C = cmds(p);
  const oldCert = await readFile(ctx, p, row.cert_path).catch(() => ({ exists: false, text: '' })); const oldKey = await readFile(ctx, p, row.key_path).catch(() => ({ exists: false, text: '' }));
  try {
    await obtain(ctx, p, JSON.parse(row.names), row.cert_path, row.key_path, log);
    const t = await run(ctx, p, `${C.test} 2>&1`);
    if (t.code !== 0) throw err(`${C.test}: ${(t.out + t.err).trim().slice(-300)}`);
    const r = await run(ctx, p, `${C.reload} 2>&1`); if (r.code !== 0) throw err(`reload: ${(r.out + r.err).trim().slice(-300)}`);
    PX.invalidate();
    return { ok: true, cert: certList(row.server_id).find(c => c.id === row.id) };
  } catch (e) {
    if (oldCert.exists) { await writeFile(ctx, p, row.cert_path, oldCert.text).catch(() => {}); await writeFile(ctx, p, row.key_path, oldKey.text, { mode: '600' }).catch(() => {}); }
    q.certTry.run(Date.now(), e.message.slice(0, 500), row.id);
    throw e;
  }
}
/** Put a DockGate certificate back on the proxy (after the container was re-created and the files were lost). */
async function redeploy(rowId) {
  const row = q.cert.get(Number(rowId)); if (!row || !row.cert_pem) throw err('Certificate not found', 404);
  const ctx = activeCtx(); const p = await findProxy(ctx, row);
  await writeFile(ctx, p, row.key_path, decrypt(row.key_enc), { mode: '600' }); await writeFile(ctx, p, row.cert_path, row.cert_pem, { mode: '644' });
  const C = cmds(p); const t = await run(ctx, p, `${C.test} 2>&1`); if (t.code === 0) await run(ctx, p, `${C.reload} 2>&1`);
  return { ok: t.code === 0, output: (t.out + t.err).trim().slice(-1000) };
}
function setAuto(rowId, on) { q.certAuto.run(on ? 1 : 0, Number(rowId)); return { ok: true }; }
function forget(rowId) { q.delCert.run(Number(rowId)); return { ok: true }; }

let timer = null; let busy = false;
async function renewDue() {
  if (busy) return; busy = true;
  try {
    const st = acmeSettings();
    for (const row of q.allCerts.all()) {
      if (!row.auto || !row.not_after) continue;
      const days = (new Date(row.not_after) - Date.now()) / 86400000;
      if (days > st.renewDays) continue;
      if (row.last_try && Date.now() - row.last_try < 6 * 3600000 && row.last_error) continue;
      try { await renew(row.id); console.log(`[proxies] renewed ${row.names} on ${row.server_id}`); }
      catch (e) {
        console.warn(`[proxies] renewal of ${row.names} failed: ${e.message}`);
        const names = JSON.parse(row.names).join(', ');
        try { await require('./notifications/health-monitor').deliver('cert_renew_failed', { id: row.server_id, name: row.server_id }, `Certificate renewal failed — ${names}`, `🔴 Certificate renewal failed — ${names}\n${row.proxy}: ${e.message}\nIt expires in ${Math.floor(days)} days. DockGate tries again in 6 hours.`, `<p>The certificate for <b>${names}</b> (${row.proxy}) could not be renewed: ${String(e.message).replace(/</g, '&lt;')}</p><p>It expires in ${Math.floor(days)} days. DockGate tries again in 6 hours.</p>`, { retry: true }); } catch (e2) { /* no channel */ }
      }
    }
  } finally { busy = false; }
}
function start() { if (timer) return; setTimeout(() => renewDue().catch(() => {}), 120000); timer = setInterval(() => renewDue().catch(() => {}), 6 * 3600000); }

// ---------- load balancing ----------
async function lbGet(id, domain) {
  const p = await PX.proxyById(id); const ctx = activeCtx(); const d = await PX.scan();
  const site = d.sites.find(s => s.proxy === id && s.domain === domain); if (!site) throw err('Site not found', 404);
  const file = site.file && site.file.startsWith('/') ? site.file : p.config;
  if (!file || p.kind === 'traefik' || p.kind === 'caddy-docker-proxy') throw err(`${PX.LABEL[p.kind]}: load balancing is set by labels (several replicas of one service are balanced by themselves)`);
  const text = (await readFile(ctx, p, file)).text;
  const methods = { nginx: ['round_robin', 'least_conn', 'ip_hash'], caddy: ['round_robin', 'least_conn', 'ip_hash', 'random', 'first'], haproxy: ['round_robin', 'least_conn', 'ip_hash'] };
  if (PX.NGINXISH.has(p.kind)) {
    const block = G.nginxBlocks(text, 'server').find(b => (b.text.match(/server_name\s+([^;]+);/) || [, ''])[1].split(/\s+/).includes(domain) && /proxy_pass/.test(b.text));
    const pp = block && (block.text.match(/proxy_pass\s+https?:\/\/([^/;$\s]+)/) || [])[1];
    const up = G.nginxUpstreams(text).find(u => u.name === pp);
    if (up) return { kind: 'nginx', file, upstream: up.name, method: up.method, servers: up.servers, methods: methods.nginx };
    if (pp) return { kind: 'nginx', file, upstream: null, method: 'round_robin', servers: [{ addr: pp, weight: 1, backup: false, down: false }], methods: methods.nginx, single: true };
    throw err(`${domain} has no proxy_pass to a host:port`);
  }
  if (p.kind === 'caddy') { const lb = G.caddyLb(text, domain); if (!lb) throw err(`${domain} has no reverse_proxy`); return { kind: 'caddy', file, method: lb.method, servers: lb.targets.map(a => ({ addr: a, weight: 1, backup: false, down: false })), methods: methods.caddy }; }
  if (p.kind === 'haproxy') { const b = G.haproxyBackends(text).find(x => x.name === site.backend); if (!b) throw err('Backend not found'); return { kind: 'haproxy', file, backend: b.name, method: b.method, servers: b.servers, methods: methods.haproxy }; }
  throw err(`${PX.LABEL[p.kind]}: not supported`);
}
async function lbSet(id, domain, body, user) {
  const cur = await lbGet(id, domain); const p = await PX.proxyById(id); const ctx = activeCtx();
  let text = (await readFile(ctx, p, cur.file)).text;
  if (cur.kind === 'nginx') { let name = cur.upstream; if (!name) { const r = G.nginxMakeUpstream(text, domain); text = r.text; name = r.name; } text = G.nginxSetUpstream(text, name, body); }
  else if (cur.kind === 'caddy') text = G.caddySetLb(text, domain, body);
  else if (cur.kind === 'haproxy') text = G.haproxySetBackend(text, cur.backend, body);
  return apply(ctx, p, [{ path: cur.file, text }], { domains: domainsFor(await PX.scan(), p, cur.file), user, note: `load balancing of ${domain}` });
}

// ---------- Traefik live ----------
async function traefikLive(id) {
  const p = await PX.proxyById(id); if (p.kind !== 'traefik' || p.where !== 'container') throw err('Not a Traefik container');
  const ctx = activeCtx(); const ti = await traefikInfo(ctx, p);
  const port = ti.apiPort || 8080;
  const get = async (path) => { const r = await PX.execIn(ctx.c, p.cid, ['sh', '-c', `wget -qO- -T 5 http://127.0.0.1:${port}${path} 2>/dev/null || curl -s -m 5 http://127.0.0.1:${port}${path}`]); try { return JSON.parse(r.out); } catch (e) { return null; } };
  const [overview, routers, services, middlewares] = [await get('/api/overview'), await get('/api/http/routers'), await get('/api/http/services'), await get('/api/http/middlewares')];
  if (!routers) return { available: false, entrypoints: ti.entrypoints, resolvers: ti.resolvers, note: `Traefik's API is not reachable on port ${port} inside the container. Start Traefik with --api.insecure=true (or an api@internal router) to see live routers and the state of each backend.` };
  return { available: true, port, entrypoints: ti.entrypoints, resolvers: ti.resolvers, overview,
    routers: routers.map(r => ({ name: r.name, rule: r.rule, status: r.status, entryPoints: r.entryPoints, service: r.service, tls: !!r.tls, resolver: r.tls && r.tls.certResolver, middlewares: r.middlewares || [], error: (r.error || []).join('; '), provider: r.provider })),
    services: (services || []).map(s => ({ name: s.name, status: s.status, type: s.type, provider: s.provider, servers: ((s.loadBalancer || {}).servers || []).map(x => ({ url: x.url, status: (s.serverStatus || {})[x.url] || 'unknown' })), usedBy: s.usedBy || [], error: (s.error || []).join('; ') })),
    middlewares: (middlewares || []).map(m => ({ name: m.name, type: m.type, status: m.status })) };
}

// ---------- stats from the access log ----------
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function logTime(t) {
  const m = String(t || '').match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (m) return Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) - (m[7] === '+' ? 1 : -1) * ((+m[8]) * 60 + (+m[9])) * 60000;
  const d = Date.parse(t); return Number.isNaN(d) ? null : d;
}
function accessStats(entries) {
  const e = entries.filter(x => x.status);
  if (!e.length) return null;
  const by = (f, n = 8) => { const m = new Map(); for (const x of e) { const k = f(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count })); };
  const times = e.map(x => logTime(x.time)).filter(Boolean);
  const per = new Map(); for (const x of e) { const t = logTime(x.time); if (!t) continue; const k = Math.floor(t / 60000) * 60000; const b = per.get(k) || { t: k, n: 0, s4: 0, s5: 0 }; b.n++; if (x.status >= 500) b.s5++; else if (x.status >= 400) b.s4++; per.set(k, b); }
  const ms = e.map(x => x.ms).filter(x => x != null).sort((a, b) => a - b);
  const pct = (q2) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(q2 * ms.length))] : null;
  const span = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 60000 : 0;
  return { requests: e.length, from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null, perMinute: span ? +(e.length / span).toFixed(1) : null,
    classes: ['2', '3', '4', '5'].map(c => ({ cls: c + 'xx', count: e.filter(x => String(x.status)[0] === c).length })),
    statuses: by(x => String(x.status)), paths: by(x => x.path && x.path.split('?')[0]), ips: by(x => x.ip), hosts: by(x => x.host), errors: by(x => x.status >= 500 ? `${x.status} ${x.path && x.path.split('?')[0]}` : null),
    ms: ms.length ? { avg: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), p50: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1] } : null,
    timeline: [...per.values()].sort((a, b) => a.t - b.t).slice(-120) };
}
async function stats(id, tail = 2000) { const l = await PX.logs(id, 'access', tail); return { proxy: l.proxy, ...(accessStats(l.entries) || { requests: 0 }) }; }

module.exports = { activeCtx, ctxFor, openFile, saveFile, versions, versionText, restoreVersion, targets, exposePlan, expose, removeSite, acmeSettings, setAcmeSettings, certForSite, certList, renew, redeploy, setAuto, forget,
  renewDue, start, lbGet, lbSet, traefikLive, stats, accessStats, logTime, apply, cmds, probe, sha, _q: q };
