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
db.exec(`CREATE TABLE IF NOT EXISTS proxy_cert_snapshots (server_id TEXT PRIMARY KEY, data TEXT, at INTEGER, error TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS proxy_cert_alerts (key TEXT PRIMARY KEY, at INTEGER)`);
const q = {
  snapPut: db.prepare('INSERT INTO proxy_cert_snapshots (server_id, data, at, error) VALUES (?, ?, ?, ?) ON CONFLICT(server_id) DO UPDATE SET data = COALESCE(excluded.data, proxy_cert_snapshots.data), at = excluded.at, error = excluded.error'),
  snaps: db.prepare('SELECT * FROM proxy_cert_snapshots'),
  alerted: db.prepare('SELECT at FROM proxy_cert_alerts WHERE key = ?'),
  alertPut: db.prepare('INSERT OR REPLACE INTO proxy_cert_alerts (key, at) VALUES (?, ?)'),
  alertPrune: db.prepare('DELETE FROM proxy_cert_alerts WHERE at < ?'),
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
// ---- a stopped proxy container: `exec` can not run; files go through the archive API (docker cp) or a helper on the mount ----
const isStopped = (p) => p.where === 'container' && p.running === false;
async function onMount(ctx, p, path) {
  return (await mountsOf(ctx, p)).filter(x => path === x.Destination || path.startsWith(x.Destination.replace(/\/$/, '') + '/')).sort((a, b) => b.Destination.length - a.Destination.length)[0] || null;
}
async function stoppedRead(ctx, p, path) {
  const T = require('./tar-lite');
  let stream; try { stream = await ctx.c.getContainer(p.cid).getArchive({ path }); } catch (e) { if (/404|no such|not found/i.test(e.message)) return { exists: false, text: '' }; throw err(`${path} could not be read: ${e.message}`, 502); }
  const f = T.parseTar(await T.collect(stream)).find(x => x.type === 'file');
  return f ? { exists: true, text: f.data.toString('utf8') } : { exists: false, text: '' };
}
async function stoppedWrite(ctx, p, path, text, mode) {
  const m = await onMount(ctx, p, path);
  if (m) { // on a mount: a helper writes it on the source (the same as a running container with a read-only mount)
    const pl = { exec: (sc) => helper(ctx, m.Type === 'volume' ? m.Name : m.Source, sc), path: '/w' + path.slice(m.Destination.length) || '/w', via: 'helper' };
    const b64 = Buffer.from(String(text), 'utf8').toString('base64'); const dir = pl.path.replace(/\/[^/]*$/, '') || '/';
    const r = await pl.exec(`mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(pl.path)}.dgtmp && cat ${shq(pl.path)}.dgtmp > ${shq(pl.path)} && rm -f ${shq(pl.path)}.dgtmp${mode ? ` && chmod ${mode} ${shq(pl.path)}` : ''}`);
    if (r.code !== 0) throw err(`${path} could not be written: ${(r.out || '').trim().slice(0, 300)}`, 502);
    return { persistent: true, via: 'helper (the proxy is stopped)' };
  }
  const T = require('./tar-lite'); const dir = path.replace(/\/[^/]*$/, '') || '/'; const name = path.split('/').pop();
  await ctx.c.getContainer(p.cid).putArchive(T.makeTar(name, text, mode ? parseInt(mode, 8) : 0o644), { path: dir });
  return { persistent: false, via: 'container archive (the proxy is stopped)' };
}
async function readFile(ctx, p, path) {
  if (isStopped(p)) { checkPath(path); return stoppedRead(ctx, p, path); }
  const pl = await place(ctx, p, path);
  const r = await pl.exec(`if [ -f ${shq(pl.path)} ]; then echo @@DGY; cat ${shq(pl.path)}; else echo @@DGN; fi`);
  const out = r.out || '';
  if (out.startsWith('@@DGY\n')) return { exists: true, text: out.slice(6) };
  if (out.startsWith('@@DGN')) return { exists: false, text: '' };
  throw err(`${path} could not be read: ${(r.err || out).trim().slice(0, 200)}`, 502);
}
async function writeFile(ctx, p, path, text, { mode = null } = {}) {
  if (isStopped(p)) { checkPath(path); return stoppedWrite(ctx, p, path, text, mode); }
  const pl = await place(ctx, p, path);
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const CH = 60000; const dir = pl.path.replace(/\/[^/]*$/, '') || '/';
  const fin = mode ? ` && chmod ${mode} ${shq(pl.path)}` : '';
  const fail = (r) => { if (r.code !== 0) throw err(`${path} could not be written: ${(r.err || r.out).trim().slice(0, 300)}`, 502); };
  // `cat > file` keeps the file itself (a bind-mounted single file can not be replaced by a rename)
  if (b64.length <= CH) fail(await pl.exec(`mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(pl.path)}.dgtmp && cat ${shq(pl.path)}.dgtmp > ${shq(pl.path)} && rm -f ${shq(pl.path)}.dgtmp${fin}`));
  else if (/helper/.test(pl.via) && pl.path === '/w') { // a single bind-mounted file through helpers: no folder to stage in (each run is a new container); apply() puts the old file back on failure
    for (let i = 0; i < b64.length; i += CH) fail(await pl.exec(`printf %s ${shq(b64.slice(i, i + CH))} | base64 -d ${i ? '>>' : '>'} ${shq(pl.path)}${i + CH >= b64.length ? fin : ''}`));
  } else {
    const tmp = `${pl.path}.dgtmp`;
    for (let i = 0; i < b64.length; i += CH) fail(await pl.exec(`${i ? '' : `mkdir -p ${shq(dir)} && `}printf %s ${shq(b64.slice(i, i + CH))} | base64 -d ${i ? '>>' : '>'} ${shq(tmp)}`));
    fail(await pl.exec(`cat ${shq(tmp)} > ${shq(pl.path)} && rm -f ${shq(tmp)}${fin}`));
  }
  return { persistent: pl.persistent, via: pl.via };
}
async function removeFile(ctx, p, path) {
  if (isStopped(p)) { const m = await onMount(ctx, p, path); if (!m) throw err('A file inside a stopped container can not be removed — start it first'); await helper(ctx, m.Type === 'volume' ? m.Name : m.Source, `rm -f ${shq('/w' + path.slice(m.Destination.length))}`); return; }
  const pl = await place(ctx, p, path); await pl.exec(`rm -f ${shq(pl.path)}`);
}

/** Start a stopped proxy container and watch it for a few seconds: { ok, state, reason } */
async function startAndWatch(ctx, p, seconds = 4) {
  try { await ctx.c.getContainer(p.cid).start(); } catch (e) { if (!/already started|304/i.test(e.message)) return { ok: false, state: 'error', reason: [e.message] }; }
  await sleep(seconds * 1000);
  const info = await ctx.c.getContainer(p.cid).inspect().catch(() => null);
  const st = info && info.State ? info.State : {};
  if (st.Running && !st.Restarting) return { ok: true, state: 'running' };
  return { ok: false, state: st.Restarting ? 'restarting' : (st.Status || 'exited'), reason: await PX.stopReason(ctx.c, p.cid) };
}
async function startProxy(id, user) {
  const p = await PX.proxyById(id); const ctx = activeCtx();
  if (p.where !== 'container') throw err('Start a host service from Server → Software → Services');
  if (p.running) return { ok: true, state: 'running', steps: [{ t: `${p.name} is already running`, ok: true }] };
  const r = await startAndWatch(ctx, p);
  PX.invalidate();
  return { ok: r.ok, ...(r.ok ? {} : { stage: 'run' }), steps: [{ t: r.ok ? `${p.name} started and keeps running` : `${p.name} stopped again (${r.state})`, ok: r.ok }], output: (r.reason || []).join('\n') };
}

// ---------- the proxy's own commands ----------
function cmds(p) {
  const cont = p.where === 'container';
  if (PX.NGINXISH.has(p.kind)) return { test: 'nginx -t', reload: cont ? 'nginx -s reload' : 'systemctl reload nginx 2>/dev/null || nginx -s reload' };
  if (p.kind === 'caddy') { const cfg = p.config || '/etc/caddy/Caddyfile'; return { test: `caddy validate --config ${shq(cfg)} --adapter caddyfile`, reload: `caddy reload --config ${shq(cfg)} --adapter caddyfile${cont ? '' : ' 2>/dev/null || systemctl reload caddy'}` }; }
  if (p.kind === 'haproxy') return { test: `haproxy -c -f ${shq(p.config)}`, reload: cont ? 'kill -USR2 1' : 'systemctl reload haproxy' };
  if (p.kind === 'apache') return { test: cont ? 'httpd -t' : 'apachectl configtest', reload: cont ? 'httpd -k graceful' : 'apachectl graceful 2>/dev/null || systemctl reload apache2 2>/dev/null || systemctl reload httpd' };
  return null;
}
/**
 * HTTP status of each site asked from the proxy itself (127.0.0.1), before and after a change. Items are a domain
 * (https first, then http) or { domain, https } — asked only the way the site is served, so a site without HTTPS
 * is not answered by another site's TLS server. Up to 20 sites, asked at the same time.
 */
async function probe(ctx, p, items) {
  const list = []; const seen = new Set();
  for (const it of items) { const o = typeof it === 'string' ? { domain: it, https: null } : it; if (!o || !P.isDomain(o.domain) || o.domain.startsWith('*.') || seen.has(o.domain)) continue; seen.add(o.domain); list.push(o); }
  if (!list.length) return {};
  const ask = (o) => `pr ${shq(o.domain)} ${o.https === true ? 'https:443' : o.https === false ? 'http:80' : "'https:443 http:80'"} &`;
  const script = `pr() { d=$1; if command -v curl >/dev/null 2>&1; then for sp in $2; do s=\${sp%%:*}; po=\${sp##*:}; c=$(curl -sk -o /dev/null -m 6 -w '%{http_code}' --resolve "$d:$po:127.0.0.1" "$s://$d/" 2>/dev/null); if [ -n "$c" ] && [ "$c" != 000 ]; then echo "@@P $d $c"; return; fi; done; echo "@@P $d 000"; elif command -v wget >/dev/null 2>&1; then c=$(wget -q -S -O /dev/null -T 6 --header "Host: $d" "http://127.0.0.1/" 2>&1 | awk '/HTTP\\//{c=$2} END{print c}'); echo "@@P $d \${c:-000}"; else echo "@@P $d 000"; fi; }; ${list.slice(0, 20).map(ask).join(' ')} wait`;
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
async function apply(ctx, p, changes, opts = {}) {
  if (isStopped(p)) return applyStopped(ctx, p, changes, opts);
  return applyRunning(ctx, p, changes, opts);
}
/** A stopped proxy: write the files (earlier versions kept), start it, watch it; if it stops again, the earlier files go back. */
async function applyStopped(ctx, p, changes, { user = null, note = '', versions = true } = {}) {
  const key = ctx.serverId + p.name; if (locks.has(key)) throw err(`A change to ${p.name} is running — wait for it`, 409);
  locks.add(key);
  const steps = []; const step = (t, ok = true) => steps.push({ t, ok }); const old = [];
  try {
    for (const ch of changes) { const cur = await readFile(ctx, p, ch.path); old.push({ path: ch.path, existed: cur.exists, text: cur.text }); }
    for (const ch of changes) { if (ch.text == null) { await removeFile(ctx, p, ch.path); step(`Removed ${ch.path}`); } else { const w = await writeFile(ctx, p, ch.path, ch.text, { mode: ch.mode }); step(`Wrote ${ch.path} (${w.via})`); } }
    const r = await startAndWatch(ctx, p);
    if (!r.ok) {
      step(`${p.name} does not start with it — ${r.state}`, false);
      const failed = [];
      for (const o of [...old].reverse()) { try { if (o.existed) await writeFile(ctx, p, o.path, o.text); else await removeFile(ctx, p, o.path); } catch (e) { failed.push(o.path); } }
      step(failed.length ? `COULD NOT put back ${failed.join(', ')}` : 'Put the earlier files back (the proxy stays stopped, as before)', !failed.length);
      return { ok: false, stage: 'start', steps, output: (r.reason || []).join('\n') };
    }
    step(`${p.name} started and keeps running`);
    if (versions) for (const o of old) { q.addVer.run(ctx.serverId, p.name, o.path, o.text, o.existed ? 1 : 0, Date.now(), user, note || null); q.prune.run(ctx.serverId, p.name, o.path, ctx.serverId, p.name, o.path); }
    PX.invalidate();
    return { ok: true, steps, output: '' };
  } catch (e) { step(e.message, false); return { ok: false, stage: 'error', steps, output: e.message }; } finally { locks.delete(key); }
}
async function applyRunning(ctx, p, changes, { domains = [], user = null, note = '', versions = true, probeSites = true } = {}) {
  const C = cmds(p); if (!C) throw err(`${PX.LABEL[p.kind] || p.kind} is configured by labels, not files`);
  const key = ctx.serverId + p.name; if (locks.has(key)) throw err(`A change to ${p.name} is running — wait for it`, 409);
  locks.add(key);
  const steps = []; const step = (t, ok = true) => steps.push({ t, ok });
  const old = [];
  // put the earlier files back; a file that could not be put back is said plainly (never "put back" when it was not)
  const restore = async () => {
    const failed = [];
    for (const o of [...old].reverse()) { try { if (o.existed) await writeFile(ctx, p, o.path, o.text); else await removeFile(ctx, p, o.path); } catch (e) { failed.push(`${o.path} (${e.message})`); } }
    if (failed.length) step(`COULD NOT put back ${failed.join(', ')} — the new text is still there. Restore it from History.`, false);
    return !failed.length;
  };
  const saveVersions = () => { if (versions) for (const o of old) { q.addVer.run(ctx.serverId, p.name, o.path, o.text, o.existed ? 1 : 0, Date.now(), user, note || null); q.prune.run(ctx.serverId, p.name, o.path, ctx.serverId, p.name, o.path); } };
  try {
    for (const ch of changes) { const cur = await readFile(ctx, p, ch.path); old.push({ path: ch.path, existed: cur.exists, text: cur.text }); }
    const before = probeSites ? await probe(ctx, p, domains) : {};
    let notPersistent = [];
    for (const ch of changes) {
      if (ch.text == null) { await removeFile(ctx, p, ch.path); step(`Removed ${ch.path}`); }
      else { const w = await writeFile(ctx, p, ch.path, ch.text, { mode: ch.mode }); step(`Wrote ${ch.path}${w.via !== 'container' && w.via !== 'host' ? ` (through a ${w.via})` : ''}`); if (!w.persistent) notPersistent.push(ch.path); }
    }
    const t = await run(ctx, p, `${C.test} 2>&1`);
    const out = (t.out + t.err).trim();
    if (t.code !== 0) { step(`${C.test} — failed`, false); if (await restore()) step('Put the earlier files back'); return { ok: false, stage: 'test', steps, output: out.slice(-4000) }; }
    step(`${C.test} — ok`);
    const r = await run(ctx, p, `${C.reload} 2>&1`);
    if (r.code !== 0) { step('Reload — failed', false); const back = await restore(); await run(ctx, p, `${C.reload} 2>&1`).catch(() => {}); if (back) step('Put the earlier files back and reloaded'); return { ok: false, stage: 'reload', steps, output: (r.out + r.err).trim().slice(-4000) }; }
    step('Reloaded');
    let after = {};
    if (probeSites && Object.keys(before).length && Object.values(before).every(c => !c)) step(`The sites could not be asked from inside ${p.name} (no curl or wget there, or none answered before) — open them to check`);
    else if (probeSites && Object.keys(before).length) {
      await sleep(1500); after = await probe(ctx, p, domains.filter(x => (typeof x === 'string' ? x : x.domain) in before));
      const broke = Object.keys(before).filter(d => healthy(before[d]) && !healthy(after[d] || 0));
      if (broke.length) {
        step(`Sites stopped answering: ${broke.map(d => `${d} (${before[d]} → ${after[d] || 'no answer'})`).join(', ')}`, false);
        const back = await restore(); await run(ctx, p, `${C.reload} 2>&1`).catch(() => {}); if (back) step('Put the earlier files back and reloaded');
        return { ok: false, stage: 'check', steps, output: '', probe: { before, after } };
      }
      step(`Sites answer as before: ${Object.keys(before).map(d => `${d} ${after[d] || '—'}`).join(', ')}`);
    }
    saveVersions();
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
  return { path, text: f.text, base: sha(f.text), locked: lockReason(p, path), persistent: pl.persistent, via: isStopped(p) ? 'stopped' : pl.via, stopped: isStopped(p), dockgate: G.isDockgateFile(f.text) };
}
function domainsFor(d, p, path) {
  const mine = d.sites.filter(s => s.proxy === p.id);
  const inFile = mine.filter(s => s.file === path);
  return [...inFile, ...mine.filter(s => s.file !== path)].map(s => ({ domain: s.domain, https: !!s.https })).slice(0, 20);
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
/** nginx's real version (the image tag says little: nginx:1.27-alpine): NGINX_VERSION of the official image, else `nginx -v`. */
const versionCache = new Map();
async function nginxVersion(ctx, p) {
  const key = ctx.serverId + (p.cid || p.id); if (versionCache.has(key)) return versionCache.get(key);
  let v = null;
  if (p.where === 'container') { const info = await ctx.c.getContainer(p.cid).inspect().catch(() => null); const env = ((info && info.Config && info.Config.Env) || []).find(x => x.startsWith('NGINX_VERSION=')); if (env) v = env.split('=')[1]; }
  if (!v && p.running !== false) { const r = await run(ctx, p, 'nginx -v 2>&1').catch(() => null); v = r && ((r.out || '').match(/nginx\/(\d+\.\d+\.\d+)/) || [])[1] || null; }
  if (v) versionCache.set(key, v);
  return v;
}
/** Can this proxy resolve upstream names while it runs (nginx ≥ 1.27.3 in a container, with Docker's DNS)? */
async function resolveInfo(ctx, p) {
  if (p.kind !== 'nginx' || p.where !== 'container') return { resolves: false, version: null, why: p.where !== 'container' ? null : `${PX.LABEL[p.kind] || p.kind}: names in an upstream are read once, when it starts` };
  const version = await nginxVersion(ctx, p);
  const resolves = G.nginxResolves(version);
  return { resolves, version, why: resolves ? null : `nginx ${version || '(version unknown)'} reads the names in an upstream once, when it starts: if a container behind it is missing, nginx does not start, and a re-created container's new IP is not seen until a reload. nginx 1.27.3 or newer resolves them while it runs.` };
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
  if (join.length && p.where === 'container') {
    const me = await containerInfo(ctx, p.cid).catch(() => null);
    notes.push(me && me.project && me.service ? `${join.join(', ')} ${join.length === 1 ? 'is' : 'are'} written into DockGate's override of ${me.project}/${me.service} (your compose files are not changed), so ${p.name} keeps ${join.length === 1 ? 'it' : 'them'} when it is re-created.`
      : `${p.name} is not part of a Compose project: it leaves ${join.join(', ')} when the container is re-created. Add ${join.length === 1 ? 'it' : 'them'} to how you start it.`);
  }
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
    const pl = await place(ctx, p, sf.path);
    if (!pl.persistent) notes.push(`${sf.path} is inside the container, not on a mount: the site is lost when ${p.name} is re-created. Mount its config folder to keep it.`);
    let certPath = body.certPath, keyPath = body.keyPath;
    if (https === 'existing' && (!certPath || !keyPath)) throw err('Choose the certificate and key files');
    if (https === 'letsencrypt') { flow = 'letsencrypt'; ({ certPath, keyPath } = await certPlace(ctx, p, domain)); }
    const gen = p.kind === 'apache' ? G.apacheSite : G.nginxSite;
    const opt = { loadModules: p.kind === 'apache' && p.where === 'container' };
    if (PX.NGINXISH.has(p.kind) && base.dockerDns && (base.targets.length > 1 || (body.lb && body.lb !== 'round_robin'))) { // an upstream block
      const ri = await resolveInfo(ctx, p); opt.resolve = ri.resolves;
      if (!ri.resolves && ri.why) notes.push(ri.why);
    }
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
  if (plan.flow === 'letsencrypt' && !acmeSettings().tos) throw err("Accept the certificate authority's terms first", 409);
  const joined = [];
  for (const net of plan.join) {
    log(`Joining ${p.name} to the network ${net}…`);
    try { await ctx.c.getNetwork(net).connect({ Container: p.cid }); joined.push(net); } catch (e) { if (!/already exists|endpoint with name/i.test(e.message)) throw err(`Could not join ${net}: ${e.message}`, 502); }
    mountCache.delete(ctx.serverId + p.cid);
  }
  const leave = async (res) => { // the site did not go in: the proxy leaves the networks it joined for it
    for (const net of joined) { try { await ctx.c.getNetwork(net).disconnect({ Container: p.cid }); res.steps.push({ t: `${p.name} left the network ${net} again`, ok: true }); } catch (e) { res.steps.push({ t: `${p.name} is still on ${net}: ${e.message}`, ok: false }); } }
    mountCache.delete(ctx.serverId + p.cid); return res;
  };
  // a `docker network connect` is lost when the proxy is re-created: kept in its Compose project's override, or a warning
  const keep = async (res) => {
    if (!res.ok || !joined.length) return res;
    try {
      const me = await containerInfo(ctx, p.cid);
      if (!me.project || !me.service) { res.steps.push({ t: `${p.name} joined ${joined.join(', ')} with docker network connect — it leaves them when the container is re-created. Add them to how you start it.`, ok: true, warn: true }); return res; }
      await require('./compose-scale').addNetworks(me.project, me.service, joined);
      res.steps.push({ t: `${joined.join(', ')} kept in DockGate's override of ${me.project}/${me.service}, so ${p.name} stays on them when it is re-created`, ok: true });
    } catch (e) { res.steps.push({ t: `${p.name} is on ${joined.join(', ')} now, but they could not be kept for a re-create: ${e.message}`, ok: true, warn: true }); }
    return res;
  };
  if (plan.mode === 'labels') {
    if (!body.applyLabels) return { ok: true, labels: plan.labels, text: plan.text, steps: [{ t: 'Labels ready — add them to the container (they apply when it is re-created)', ok: true }] };
    // into the Compose project's override (the compose files are not changed), then the service is re-created
    const t0 = await containerInfo(ctx, plan.container);
    if (!t0.project || !t0.service) return leave({ ok: false, stage: 'labels', steps: [{ t: `${t0.name} is not part of a Compose project — add the labels yourself`, ok: false }], text: plan.text });
    const CS = require('./compose-scale');
    const kept = (CS.readRules(ctx.serverId, t0.project)[t0.service] || {}).labels || {};
    const steps = [];
    try {
      await CS.setLabels(t0.project, t0.service, { ...kept, ...plan.labels }, { log: (l) => steps.push({ t: l.trim(), ok: true }) });
      steps.push({ t: `${t0.project}/${t0.service} re-created with the labels (kept in DockGate's override — your compose files are not changed)`, ok: true });
      PX.invalidate();
      return keep({ ok: true, steps, labels: plan.labels });
    } catch (e) { steps.push({ t: e.message, ok: false }); return leave({ ok: false, stage: 'labels', steps, text: plan.text }); }
  }
  const domain = String(body.domain).toLowerCase();
  if (p.kind === 'apache' && p.where === 'host') await run(ctx, p, 'command -v a2enmod >/dev/null 2>&1 && a2enmod -q proxy proxy_http headers rewrite ssl proxy_balancer lbmethod_byrequests lbmethod_bybusyness proxy_wstunnel slotmem_shm socache_shmcb >/dev/null 2>&1; true');
  const res = await apply(ctx, p, plan.changes.map(c => ({ path: c.path, text: c.text })), { domains: [], user, note: `site ${domain}`, probeSites: false });
  if (!res.ok) return leave({ ...res, site: domain });
  await keep(res);
  if (plan.flow !== 'letsencrypt') return { ...res, site: domain };
  log('The HTTP site is live; asking Let\'s Encrypt for a certificate…');
  try {
    const names = [domain, ...G.siteInput({ ...body, domain, targets: ['x:1'] }).aliases];
    const got = await obtain(ctx, p, names, plan.certPath, plan.keyPath, log);
    recordCert(ctx, p, names, plan.certPath, plan.keyPath, got);
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
  if (p.kind === 'traefik' || p.kind === 'caddy-docker-proxy') return removeLabelSite(ctx, p, s, domain);
  const path = s.file && s.file.startsWith('/') ? s.file : p.config;
  const cur = await readFile(ctx, p, path);
  let change;
  if (G.isDockgateFile(cur.text) && (PX.NGINXISH.has(p.kind) || p.kind === 'apache')) change = { path, text: null };
  else { const r = G.removeMarked(cur.text, domain); if (!r.changed) throw err(`${domain} was not added by DockGate — remove it in the editor`, 409); change = { path, text: r.text }; }
  const r = await apply(ctx, p, [change], { domains: domainsFor(d, p, path).filter(x => x.domain !== domain), user, note: `removed ${domain}` });
  if (r.ok) for (const row of q.certs.all(ctx.serverId).filter(x => x.proxy === p.name && JSON.parse(x.names)[0] === domain)) { q.delCert.run(row.id); r.steps.push({ t: `DockGate stopped renewing the certificate of ${domain} (the files stay)`, ok: true }); }
  return r;
}

/** A Traefik / caddy-docker-proxy site whose labels DockGate put in the project's override: those labels go, the service is re-created. */
async function removeLabelSite(ctx, p, s, domain) {
  const cname = String(s.file || '').replace(/^labels of /, '');
  const t = await containerInfo(ctx, cname).catch(() => null);
  if (!t || !t.project || !t.service) throw err(`${domain} comes from labels of ${cname} — remove them from its compose file`, 409);
  const CS = require('./compose-scale');
  const kept = (CS.readRules(ctx.serverId, t.project)[t.service] || {}).labels || {};
  const id = p.kind === 'traefik' ? `dg-${G.slug(domain).replace(/_/g, '-')}` : null;
  const left = Object.fromEntries(Object.entries(kept).filter(([k, v]) => id ? !k.includes(`.${id}.`) && !k.includes(`.${id}-http.`) && !k.includes(`.${id}-https.`) : !(/^caddy(\.|$)/.test(k) && (k !== 'caddy' || String(v).split(/[\s,]+/).some(x => x.replace(/^https?:\/\//, '') === domain)))));
  if (Object.keys(left).length === Object.keys(kept).length) throw err(`${domain} was not added by DockGate — remove its labels from the compose file of ${t.project}`, 409);
  if (id && !Object.keys(left).some(k => k.startsWith('traefik.http.'))) delete left['traefik.enable']; // no DockGate router left on this service
  const steps = [];
  await CS.setLabels(t.project, t.service, left, { log: (l) => steps.push({ t: l.trim(), ok: true }) });
  steps.push({ t: `DockGate's labels for ${domain} removed from ${t.project}/${t.service} (re-created)`, ok: true });
  PX.invalidate();
  return { ok: true, steps };
}

// ---------- a site's settings as a form ----------
async function siteContext(id, domain) {
  const p = await PX.proxyById(id); const ctx = activeCtx(); const d = await PX.scan();
  const s = d.sites.find(x => x.proxy === id && x.domain === domain); if (!s) throw err('Site not found', 404);
  if (!['nginx', 'caddy'].includes(p.kind)) throw err(`${PX.LABEL[p.kind] || p.kind}: use the config editor`);
  const file = s.file && s.file.startsWith('/') ? s.file : p.config;
  const lock = lockReason(p, file); if (lock) throw err(lock, 409);
  return { p, ctx, d, s, file, text: (await readFile(ctx, p, file)).text };
}
async function siteSettings(id, domain) {
  const { p, file, text } = await siteContext(id, domain);
  return { kind: p.kind, file, settings: p.kind === 'caddy' ? G.caddySiteSettings(text, domain) : G.nginxSiteSettings(text, domain) };
}
async function siteSettingsPlan(id, domain, body) {
  const { p, file, text } = await siteContext(id, domain);
  const after = p.kind === 'caddy' ? G.caddyApplySettings(text, domain, body) : G.nginxApplySettings(text, domain, body);
  return { file, before: text, after, same: after === text };
}
async function saveSiteSettings(id, domain, body, user) {
  const { p, ctx, d, file, text } = await siteContext(id, domain);
  const after = p.kind === 'caddy' ? G.caddyApplySettings(text, domain, body) : G.nginxApplySettings(text, domain, body);
  if (after === text) return { ok: true, steps: [{ t: 'No change', ok: true }] };
  return apply(ctx, p, [{ path: file, text: after }], { domains: domainsFor(d, p, file), user, note: `settings of ${domain}` });
}

// ---------- certificates (Let's Encrypt through DockGate) ----------
function acmeSettings() {
  const dirKey = getSetting('proxy_acme_directory', 'letsencrypt');
  return { email: getSetting('proxy_acme_email', ''), directory: dirKey, directoryUrl: ACME.DIRECTORIES[dirKey] || dirKey, renewDays: Number(getSetting('proxy_acme_renew_days', '30')) || 30,
    tos: getSetting('proxy_acme_tos', null) === '1' || (getSetting('proxy_acme_tos', null) == null && q.allCerts.all().length > 0), terms: 'https://letsencrypt.org/repository/' };
}
function setAcmeSettings({ email, directory, renewDays, tos }) {
  if (tos != null) stmts.setSetting.run('proxy_acme_tos', tos ? '1' : '0');
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
  if (!st.tos) throw err("Accept the certificate authority's terms first (Certificates → Let's Encrypt account)", 409);
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
  return res;
}
/** Remember a certificate DockGate keeps (only once it is on the proxy and the proxy took it). */
function recordCert(ctx, p, names, certPath, keyPath, res) {
  q.upCert.run({ server_id: ctx.serverId, proxy: p.name, proxy_kind: p.kind, proxy_where: p.where, names: JSON.stringify(names), cert_path: certPath, key_path: keyPath,
    cert_pem: res.certPem, key_enc: encrypt(res.keyPem), not_after: res.notAfter, issued_at: Date.now(), last_try: Date.now(), directory: acmeSettings().directoryUrl });
}
/**
 * Get (or replace) a Let's Encrypt certificate for an existing nginx or Apache site: the HTTP server answers the
 * check (added if missing; an HTTPS-only nginx site gets an HTTP server), the certificate covers that server's own
 * names, then the site's certificate lines point to it (or an HTTPS server is added). Each step checks and reloads.
 */
async function certForSite(id, domain, { redirect = true } = {}, user, log = () => {}) {
  const p = await PX.proxyById(id); const ctx = activeCtx(); const d = await PX.scan({ fresh: true });
  if (p.kind === 'caddy' || p.kind === 'caddy-docker-proxy' || p.kind === 'traefik') throw err(`${PX.LABEL[p.kind]} gets its certificates itself`);
  if (p.kind === 'npm' || p.kind === 'nginx-proxy') throw err(`${PX.LABEL[p.kind]} keeps its own certificates`);
  if (p.kind === 'haproxy') throw err('HAProxy can not answer the certificate check itself (it serves no files). Put the site behind nginx or Caddy, or use certbot with a reload hook.');
  if (p.kind !== 'nginx' && p.kind !== 'apache') throw err('Not supported for this proxy');
  if (!acmeSettings().tos) throw err("Accept the certificate authority's terms first (Certificates → Let's Encrypt account)", 409); // before anything is changed
  const site = d.sites.find(s => s.proxy === id && s.domain === domain); if (!site) throw err('Site not found', 404);
  const file = site.file && site.file.startsWith('/') ? site.file : null; if (!file) throw err('The file of this site is not known');
  const apache = p.kind === 'apache';
  const steps = [];
  const cur = await readFile(ctx, p, file);
  const a = apache ? G.apacheEnsureAcme(cur.text, domain) : G.nginxEnsureAcme(cur.text, domain);
  if (a.changed) {
    const r = await apply(ctx, p, [{ path: file, text: a.text }], { domains: domainsFor(d, p, file), user, note: `certificate check for ${domain}` });
    steps.push(...r.steps); if (!r.ok) return { ...r, steps };
  }
  const now = (await readFile(ctx, p, file)).text;
  const names = apache ? G.apacheCertNames(now, domain) : G.nginxCertNames(now, domain);
  const { certPath, keyPath } = await certPlace(ctx, p, domain);
  let got;
  try { got = await obtain(ctx, p, names, certPath, keyPath, log); steps.push({ t: `Certificate for ${names.join(', ')} written to ${certPath}`, ok: true }); }
  catch (e) { steps.push({ t: `Certificate: ${e.message}`, ok: false }); return { ok: false, stage: 'certificate', steps, output: "Check that the domain's DNS points to this server and that port 80 reaches the proxy." }; }
  const next = apache ? G.apacheSetHttps(now, domain, certPath, keyPath) : G.nginxAddHttps(now, domain, certPath, keyPath, { redirect });
  const r = await apply(ctx, p, [{ path: file, text: next.text }], { domains: domainsFor(d, p, file), user, note: `HTTPS for ${domain}` });
  if (r.ok) { recordCert(ctx, p, names, certPath, keyPath, got); r.steps.push({ t: `DockGate renews it ${acmeSettings().renewDays} days before it expires`, ok: true }); }
  else r.steps.push({ t: `The certificate files stay at ${certPath}, but DockGate does not renew them until the site uses them. Fix what stopped the site, then press again.`, ok: true });
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
/** Renew one DockGate certificate: new certificate → files (the old ones kept) → check → reload; recorded only once the proxy took it. */
async function renew(rowId, { log = () => {}, ctx: given } = {}) {
  const row = q.cert.get(Number(rowId)); if (!row) throw err('Certificate not found', 404);
  const ctx = given || (row.server_id === activeCtx().serverId ? activeCtx() : ctxFor(row.server_id));
  const p = await findProxy(ctx, row);
  const C = cmds(p);
  const key = ctx.serverId + p.name; if (locks.has(key)) throw err(`A change to ${p.name} is running — the renewal waits for the next round`, 409);
  locks.add(key);
  const oldCert = await readFile(ctx, p, row.cert_path).catch(() => ({ exists: false, text: '' })); const oldKey = await readFile(ctx, p, row.key_path).catch(() => ({ exists: false, text: '' }));
  try {
    const names = JSON.parse(row.names);
    const got = await obtain(ctx, p, names, row.cert_path, row.key_path, log);
    const t = await run(ctx, p, `${C.test} 2>&1`);
    if (t.code !== 0) throw err(`${C.test}: ${(t.out + t.err).trim().slice(-300)}`);
    const r = await run(ctx, p, `${C.reload} 2>&1`); if (r.code !== 0) throw err(`reload: ${(r.out + r.err).trim().slice(-300)}`);
    recordCert(ctx, p, names, row.cert_path, row.key_path, got);
    PX.invalidate();
    return { ok: true, cert: certList(row.server_id).find(c => c.id === row.id) };
  } catch (e) {
    if (oldCert.exists) { await writeFile(ctx, p, row.cert_path, oldCert.text).catch(() => {}); await writeFile(ctx, p, row.key_path, oldKey.text, { mode: '600' }).catch(() => {}); }
    q.certTry.run(Date.now(), e.message.slice(0, 500), row.id);
    throw e;
  } finally { locks.delete(key); }
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
        if (e.statusCode === 409 && /running/.test(e.message)) continue; // an edit is running: next round
        console.warn(`[proxies] renewal of ${row.names} failed: ${e.message}`);
        const names = JSON.parse(row.names).join(', ');
        try { await require('./notifications/health-monitor').deliver('cert_renew_failed', { id: row.server_id, name: row.server_id }, `Certificate renewal failed — ${names}`, `🔴 Certificate renewal failed — ${names}\n${row.proxy}: ${e.message}\nIt expires in ${Math.floor(days)} days. DockGate tries again in 6 hours.`, `<p>The certificate for <b>${names}</b> (${row.proxy}) could not be renewed: ${String(e.message).replace(/</g, '&lt;')}</p><p>It expires in ${Math.floor(days)} days. DockGate tries again in 6 hours.</p>`, { retry: true }); } catch (e2) { /* no channel */ }
      }
    }
  } finally { busy = false; }
}
function start() { startCertCheck(); if (timer) return; setTimeout(() => renewDue().catch(() => {}), 120000); timer = setInterval(() => renewDue().catch(() => {}), 6 * 3600000); }

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
    const pp = block && ((block.text.match(/proxy_pass\s+https?:\/\/([^/;$\s]+)/) || [])[1] || (block.text.match(/set\s+\$\w+\s+https?:\/\/([^/;\s]+)/) || [])[1]);
    const up = G.nginxUpstreams(text).find(u => u.name === pp);
    const ri = await resolveInfo(ctx, p);
    const resolve = { resolves: ri.resolves, version: ri.version, why: ri.why };
    if (up) return { kind: 'nginx', file, upstream: up.name, method: up.method, servers: up.servers, methods: methods.nginx, resolve };
    if (pp) return { kind: 'nginx', file, upstream: null, method: 'round_robin', servers: [{ addr: pp, weight: 1, backup: false, down: false }], methods: methods.nginx, single: true, resolve };
    throw err(`${domain} has no proxy_pass to a host:port`);
  }
  if (p.kind === 'caddy') { const lb = G.caddyLb(text, domain); if (!lb) throw err(`${domain} has no reverse_proxy`); return { kind: 'caddy', file, method: lb.method, servers: lb.targets.map(a => ({ addr: a, weight: 1, backup: false, down: false })), methods: methods.caddy }; }
  if (p.kind === 'haproxy') { const b = G.haproxyBackends(text).find(x => x.name === site.backend); if (!b) throw err('Backend not found'); return { kind: 'haproxy', file, backend: b.name, method: b.method, servers: b.servers, methods: methods.haproxy }; }
  throw err(`${PX.LABEL[p.kind]}: not supported`);
}
async function lbSet(id, domain, body, user) {
  const cur = await lbGet(id, domain); const p = await PX.proxyById(id); const ctx = activeCtx();
  let text = (await readFile(ctx, p, cur.file)).text;
  if (cur.kind === 'nginx') {
    let name = cur.upstream; if (!name) { const r = G.nginxMakeUpstream(text, domain); text = r.text; name = r.name; }
    const ri = await resolveInfo(ctx, p);
    text = G.nginxSetUpstream(text, name, { ...body, resolve: ri.resolves ? true : undefined }); // an older nginx keeps what the upstream had
  }
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

// ---------- certificate center ----------
/** Every certificate of a server with who renews it — DockGate's own merged in. */
async function certOverview({ ctx = activeCtx(), fresh = false } = {}) {
  const r = await PX.certificates({ ctx, fresh });
  const managed = certList(ctx.serverId);
  for (const c of r.certs) {
    const m = managed.find(x => c.paths.includes(x.certPath));
    if (m) { c.source = 'DockGate'; c.renewer = 'dockgate'; c.auto = !!m.auto; c.renewal = m.auto ? 'DockGate — automatic' : 'DockGate — auto renew off'; c.managedId = m.id; if (m.lastError) c.renewError = m.lastError; }
    else if (c.renewer === 'dockgate') { c.auto = false; c.renewal = 'DockGate files — not renewed (forgotten)'; c.renewer = 'none'; }
  }
  return { ...r, managed, acme: acmeSettings() };
}
/** Run the proxy's check, then reload it (a certificate renewed on disk is served after this). */
async function reloadProxy(id) {
  const p = await PX.proxyById(id); const ctx = activeCtx(); const C = cmds(p);
  if (!C) throw err(`${PX.LABEL[p.kind] || p.kind} reloads by itself`);
  const t = await run(ctx, p, `${C.test} 2>&1`);
  if (t.code !== 0) return { ok: false, stage: 'test', output: (t.out + t.err).trim().slice(-3000) };
  const r = await run(ctx, p, `${C.reload} 2>&1`);
  PX.invalidate();
  return { ok: r.code === 0, stage: r.code === 0 ? null : 'reload', output: (r.out + r.err).trim().slice(-3000) };
}
/** Reload commands for the web servers that use certbot's certificates on this SSH server. */
async function certbotReloads(ctx) {
  const d = await PX.scan({ ctx, fresh: true }); const raw = await PX.rawFor(ctx);
  const cmdsOut = [];
  for (const p of d.proxies.filter(x => x.running)) {
    const usesLe = (raw.certPaths[p.id] || []).some(x => /\/letsencrypt\//.test(x)) || ((raw.files[p.id] || []).some(f => /\/etc\/letsencrypt\//.test(f.text)));
    if (!usesLe) continue;
    const C = cmds(p); if (!C) continue;
    cmdsOut.push(p.where === 'container' ? `docker exec ${shq(p.name)} sh -c ${shq(`${C.test} && ${C.reload}`)}` : `${C.test} && (${C.reload})`);
  }
  return cmdsOut;
}
/** certbot renew for one certificate now, then the web servers that use it are reloaded. */
async function certbotRenew(name) {
  const ctx = activeCtx(); if (!ctx.server) throw err('certbot on the host is reached on SSH servers');
  if (!/^[\w.-]{1,200}$/.test(String(name || ''))) throw err('Not a certificate name');
  const r = await PX.hostExec(ctx.server, asRoot(`certbot renew --cert-name ${shq(name)} --no-random-sleep-on-renew 2>&1`));
  const reloads = r.code === 0 ? await certbotReloads(ctx) : [];
  const outs = [];
  for (const c of reloads) { const x = await PX.hostExec(ctx.server, asRoot(`${c} 2>&1`)); outs.push(`$ ${c}\n${(x.out + x.err).trim()}`); }
  PX.invalidate();
  return { ok: r.code === 0, output: [(r.out + r.err).trim(), ...outs].join('\n\n').slice(-6000) };
}
/** A certbot deploy hook that reloads the web servers using its certificates (certbot runs it after each renewal). */
async function certbotHook(preview = false) {
  const ctx = activeCtx(); if (!ctx.server) throw err('certbot on the host is reached on SSH servers');
  const reloads = await certbotReloads(ctx);
  if (!reloads.length) throw err('No running web server here uses certbot\'s certificates');
  const path = '/etc/letsencrypt/renewal-hooks/deploy/dockgate-reload.sh';
  const text = `#!/bin/sh\n# Written by DockGate (Web → Proxies & SSL): after certbot renews a certificate, the web servers that use it are\n# checked and reloaded, so they serve the new one. Remove this file to stop it.\n${reloads.map(c => `${c} || echo "dockgate-reload: failed: ${c.replace(/"/g, '')}" >&2`).join('\n')}\nexit 0\n`;
  if (preview) return { path, text };
  const b64 = Buffer.from(text).toString('base64');
  const r = await PX.hostExec(ctx.server, asRoot(`mkdir -p /etc/letsencrypt/renewal-hooks/deploy && printf %s ${shq(b64)} | base64 -d > ${path} && chmod 755 ${path}`));
  if (r.code !== 0) throw err(`Could not write ${path}: ${(r.out + r.err).trim().slice(0, 300)}`, 502);
  PX.invalidate();
  return { ok: true, path, text };
}

/** The daily check of every certificate on every server, whoever renews it. Alerts once per threshold. */
const THRESHOLDS = [0, 1, 3, 7, 14]; // the smallest one the days left fall under
async function checkAllCerts({ notify = true } = {}) {
  const servers = [{ id: 'local', name: 'Local' }, ...stmts.getServers.all().map(x => ({ id: x.id, name: x.name || x.host }))];
  const out = [];
  for (const sv of servers) {
    let ctx;
    try { ctx = sv.id === activeCtx().serverId ? activeCtx() : ctxFor(sv.id); } catch (e) { continue; }
    try {
      const r = await certOverview({ ctx, fresh: true });
      const snap = { at: Date.now(), certs: r.certs.map(c => ({ names: c.names, issuer: c.issuer, validTo: c.validTo, daysLeft: c.daysLeft, renewal: c.renewal, renewer: c.renewer, auto: c.auto, internal: c.internal, staging: c.staging, proxies: c.proxies, served: c.served || null, renewError: c.renewError || null, fingerprint: c.fingerprint })),
        uncovered: r.uncovered, errors: r.errors, notes: r.notes, certbot: r.certbot };
      q.snapPut.run(sv.id, JSON.stringify(snap), Date.now(), null);
      out.push({ server: sv.id, name: sv.name, ok: true, ...snap });
      if (notify) await certAlerts(sv, snap);
    } catch (e) { q.snapPut.run(sv.id, null, Date.now(), e.message.slice(0, 300)); out.push({ server: sv.id, name: sv.name, ok: false, error: e.message }); }
  }
  q.alertPrune.run(Date.now() - 120 * 86400000);
  return out;
}
async function certAlerts(sv, snap) {
  const HM = require('./notifications/health-monitor');
  const once = async (key, type, subject, text, html) => { if (q.alerted.get(key)) return; q.alertPut.run(key, Date.now()); await HM.deliver(type, { id: sv.id, name: sv.name }, subject, text, html, { always: true, retry: true }).catch(() => {}); };
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const c of snap.certs) {
    if (c.internal || c.staging) continue;
    const t = THRESHOLDS.find(x => c.daysLeft <= x);
    if (t != null) {
      const who = c.auto ? `${c.renewal.replace(/ — .*/, '')} should have renewed it by now — check it` : 'nothing renews it — renew it or switch it to Let\'s Encrypt';
      const when = c.daysLeft < 0 ? `expired ${-c.daysLeft} days ago` : `expires in ${c.daysLeft} days`;
      await once(`exp:${c.fingerprint}:${t}`, 'cert_expiring', `Certificate ${when} — ${c.names[0]} on ${sv.name}`, `${c.daysLeft <= 3 ? '🔴' : '🟠'} Certificate ${when} — ${sv.name}\n${c.names.join(', ')} (${c.proxies.join(', ')})\n${who}.`, `<p>The certificate for <b>${esc(c.names.join(', '))}</b> on <b>${esc(sv.name)}</b> (${esc(c.proxies.join(', '))}) ${when}.</p><p>${esc(who)}.</p>`);
    }
    if (c.served && c.served.stale) await once(`stale:${c.fingerprint}`, 'cert_not_loaded', `Renewed certificate not loaded — ${c.names[0]} on ${sv.name}`, `🟠 Renewed certificate not loaded — ${sv.name}\n${c.served.proxy} still serves the one that ends ${c.served.notAfter.slice(0, 10)}; the file on disk is newer. Reload ${c.served.proxy} (Proxies & SSL → Certificates → Reload).`, `<p><b>${esc(c.served.proxy)}</b> on <b>${esc(sv.name)}</b> still serves the old certificate of ${esc(c.names[0])} (ends ${esc(c.served.notAfter.slice(0, 10))}); the renewed file is not loaded. Reload it.</p>`);
  }
  const day = new Date().toISOString().slice(0, 10);
  for (const e of snap.errors || []) await once(`acme:${sv.id}:${e.proxy}:${day}`, 'cert_acme_error', `Certificate errors in ${e.proxy} on ${sv.name}`, `🟠 ${e.proxy} could not get or renew a certificate — ${sv.name}\n${e.lines.slice(-2).join('\n').slice(0, 600)}`, `<p><b>${esc(e.proxy)}</b> on <b>${esc(sv.name)}</b> logged certificate errors:</p><pre>${esc(e.lines.join('\n'))}</pre>`);
}
function fleet() {
  const names = Object.fromEntries([['local', 'Local'], ...stmts.getServers.all().map(x => [x.id, x.name || x.host])]);
  return q.snaps.all().map(r => ({ server: r.server_id, name: names[r.server_id] || r.server_id, at: r.at, error: r.error, ...(r.data ? JSON.parse(r.data) : { certs: [] }) })).filter(x => names[x.server]);
}
let certTimer = null;
function startCertCheck() {
  if (certTimer) return;
  setTimeout(() => checkAllCerts().catch(e => console.warn('[proxies] certificate check:', e.message)), 10 * 60000);
  certTimer = setInterval(() => checkAllCerts().catch(e => console.warn('[proxies] certificate check:', e.message)), 24 * 3600000);
}

module.exports = { startProxy, startAndWatch, siteSettings, siteSettingsPlan, saveSiteSettings, certOverview, reloadProxy, certbotRenew, certbotHook, checkAllCerts, certAlerts, fleet, activeCtx, ctxFor, openFile, saveFile, versions, versionText, restoreVersion, targets, exposePlan, expose, removeSite, acmeSettings, setAcmeSettings, certForSite, certList, renew, redeploy, setAuto, forget,
  renewDue, start, lbGet, lbSet, traefikLive, stats, accessStats, logTime, apply, cmds, probe, sha, _q: q };
