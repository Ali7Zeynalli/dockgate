// Proxies & SSL → Certificates: why a certificate expired (or is about to), and the fix for whoever keeps it.
//
// diagnose(fingerprint) runs the checks a renewal depends on — the domain's DNS, port 80 and the ACME challenge path
// from outside (a real token, fetched by name), the renewer itself (certbot's method and timer, its container,
// DockGate's last error, Caddy's / Traefik's logged errors, Let's Encrypt's rate limit) and whether the proxy serves
// the newest file — and lists the fixes that apply. fix(fingerprint, action) runs one of them.
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const PX = require('./proxies');
const PE = require('./proxy-edit');
const P = require('./proxy-parse');
const G = require('./proxy-gen');

const err = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const rootSh = (script) => `if [ "$(id -u)" = 0 ]; then sh -c ${shq(script)}; elif sudo -n true 2>/dev/null; then sudo -n sh -c ${shq(script)}; else sh -c ${shq(script)}; fi`;

// Cloudflare's proxy ranges: a domain behind them is answered by Cloudflare, not by this server
const CF = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const ip4 = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
const inCidr = (ip, cidr) => { const [base, bits] = cidr.split('/'); const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return (ip4(ip) & mask) === (ip4(base) & mask); };
const isCloudflare = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && CF.some(c => inCidr(ip, c));
const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || /^(::1|fe80:|fc|fd)/i.test(ip);

/** The server's own addresses (its interfaces, and the host it is reached at). */
async function serverAddresses(ctx) {
  const out = new Set();
  if (ctx.server) {
    const r = await PX.hostExec(ctx.server, "hostname -I 2>/dev/null; ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1").catch(() => null);
    for (const t of String(r ? r.out : '').split(/\s+/)) if (/^\d+\.\d+\.\d+\.\d+$/.test(t) || /^[0-9a-f]*:[0-9a-f:]+$/i.test(t)) out.add(t);
    if (ctx.server.host) { try { for (const a of await dns.lookup(ctx.server.host, { all: true })) out.add(a.address); } catch (e) { /* a name that does not resolve here */ } }
  }
  return [...out].filter(Boolean);
}

/** GET a URL the way Let's Encrypt does: by name, following up to 3 redirects (to https too, any certificate). */
function fetchLikeAcme(url, hops = 3) {
  return new Promise((resolve) => {
    const u = new URL(url); const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: 8000, rejectUnauthorized: false, headers: { 'User-Agent': 'DockGate certificate check' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) { res.resume(); return resolve(fetchLikeAcme(new URL(res.headers.location, url).toString(), hops - 1)); }
      let body = ''; res.on('data', (d) => { if (body.length < 4096) body += d; }); res.on('end', () => resolve({ status: res.statusCode, body, url }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'no answer in 8 s', url }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, url }));
  });
}

/** certbot's renewal settings of a certificate: { authenticator, webroot } (from /etc/letsencrypt/renewal/<name>.conf). */
async function certbotConf(ctx, c, name) {
  const read = `cat /etc/letsencrypt/renewal/${name}.conf 2>/dev/null; echo; echo @@LOG; tail -n 300 /var/log/letsencrypt/letsencrypt.log 2>/dev/null | grep -iE 'error|failed|problem|too many|rateLimited|unauthorized|connection' | tail -n 4`;
  let out = '';
  if (c.certbotContainer && !c.proxies.includes('host')) {
    const d = await PX.scan(); const h = (d.helpers || []).find(x => x.name === c.certbotContainer);
    if (h && h.running) out = (await PX.execIn(ctx.c, h.cid, ['sh', '-c', read], { user: 'root' }).catch(() => ({ out: '' }))).out;
  } else if (ctx.server) out = (await PX.hostExec(ctx.server, rootSh(read)).catch(() => ({ out: '' }))).out;
  const [conf, log] = out.split('@@LOG');
  const get = (k) => ((conf || '').match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'm')) || [])[1];
  const map = ((conf || '').match(/\[\[webroot_map\]\]([\s\S]*?)(\n\[|$)/) || [])[1] || '';
  const webroot = get('webroot_path') ? get('webroot_path').split(',')[0].trim() : ((map.match(/=\s*(\S+)/) || [])[1] || null);
  return { found: !!(conf || '').trim(), authenticator: get('authenticator') || null, webroot, logErrors: String(log || '').split('\n').map(x => x.trim()).filter(Boolean) };
}

/** The proxy and site file that use certificate c for `name` (nginx / Apache: DockGate can answer the challenge there). */
async function siteFor(c, name) {
  const d = await PX.scan();
  for (const id of c.proxyIds || []) {
    const p = d.proxies.find(x => x.id === id); if (!p || !['nginx', 'apache'].includes(p.kind)) continue;
    const s = d.sites.find(x => x.proxy === id && x.domain === name); if (s && s.file && s.file.startsWith('/')) return { p, s };
  }
  return null;
}

/** Put a token where `root` serves /.well-known/acme-challenge/, fetch it by name from outside, take it away. */
async function challengeTest(ctx, where, name) {
  const token = 'dockgate-check-' + crypto.randomBytes(8).toString('hex'); const value = crypto.randomBytes(12).toString('hex');
  const dir = `${where.root.replace(/\/$/, '')}/.well-known/acme-challenge`;
  const put = `mkdir -p ${shq(dir)} && printf %s ${shq(value)} > ${shq(dir + '/' + token)} && chmod 644 ${shq(dir + '/' + token)}`;
  const del = `rm -f ${shq(dir + '/' + token)}`;
  const exec = (s) => (where.proxy ? PE.run(ctx, where.proxy, s) : PX.hostExec(ctx.server, rootSh(s)));
  const w = await exec(put).catch((e) => ({ code: 1, err: e.message }));
  if (w.code !== 0) return { ok: null, detail: `could not put a test file in ${dir} (${String(w.err || w.out || '').trim().slice(0, 120)})` };
  const r = await fetchLikeAcme(`http://${name}/.well-known/acme-challenge/${token}`);
  await exec(del).catch(() => {});
  if (r.status === 200 && r.body.trim() === value) return { ok: true, detail: `http://${name}/.well-known/acme-challenge/… answers with the test file${r.url.startsWith('https') ? ' (after a redirect to https, which Let\'s Encrypt follows)' : ''}` };
  if (!r.status) return { ok: false, detail: `http://${name}/ gives no answer (${r.error}): port 80 does not reach this server — a firewall, the router, or the DNS points elsewhere` };
  return { ok: false, detail: `http://${name}/.well-known/acme-challenge/… answers ${r.status}${r.status === 200 ? ' with other content' : ''}, not the test file: another server or another site answers this name on port 80` };
}

async function diagnose(fingerprint) {
  const ctx = PE.activeCtx();
  const ov = await PE.certOverview({ ctx });
  const c = ov.certs.find(x => x.fingerprint === fingerprint); if (!c) throw err('Certificate not found — refresh the list', 404);
  const names = c.names.filter(n => P.isDomain(n) && !n.startsWith('*.'));
  const wildcard = c.names.some(n => n.startsWith('*.'));
  const checks = []; const fixes = [];
  const add = (ok, title, detail) => checks.push({ ok, title, detail });
  add(c.daysLeft < 0 ? false : c.daysLeft <= 14 ? null : true, c.daysLeft < 0 ? `Expired ${-c.daysLeft} days ago` : `Expires in ${c.daysLeft} days`, `${c.names.join(', ')} · ${c.selfSigned ? 'self-signed' : c.issuer} · kept by ${c.renewal}`);

  // who renews it, and is it able to
  let cb = null; let rateLimited = false;
  if (c.internal) add(true, 'Internal certificate', `${c.renewal}: renewed by itself, not a public certificate`);
  else if (c.managedId) {
    const m = (ov.managed || []).find(x => x.id === c.managedId) || {};
    add(m.auto ? true : null, m.auto ? 'DockGate renews it' : 'DockGate keeps it, automatic renewal is off', m.lastError ? `last try: ${m.lastError}` : m.lastTry ? `last try ${new Date(m.lastTry).toLocaleString()} — no error` : 'no renewal tried yet');
    if (m.lastError && /too many|rateLimited|rate limit/i.test(m.lastError)) rateLimited = true;
  } else if (c.renewer === 'certbot') {
    const name = (c.paths.map(x => (x.match(/\/letsencrypt\/live\/([^/]+)\//) || [])[1]).find(Boolean)) || null;
    cb = name ? await certbotConf(ctx, c, name) : { found: false, logErrors: [] };
    const inCt = c.certbotContainer && !c.proxies.includes('host');
    if (inCt) { const d = await PX.scan(); const h = (d.helpers || []).find(x => x.name === c.certbotContainer); add(h && h.running ? true : false, `certbot runs in the container ${c.certbotContainer}`, h && h.running ? 'it is running' : 'it is stopped: nothing renews the certificate'); }
    else add(ov.certbot && ov.certbot.timer ? true : false, 'certbot on the server', ov.certbot && ov.certbot.timer ? `renews by its ${ov.certbot.timer}` : 'no timer or cron runs certbot renew: nothing renews the certificate on its own');
    if (cb.found) {
      const holds80 = (await PX.scan()).ports.some(x => x.port === 80);
      if (cb.authenticator === 'standalone') add(holds80 ? false : null, 'certbot method: standalone', holds80 ? 'certbot starts its own server on port 80 to answer the check, but a proxy holds port 80 — every renewal fails. Let DockGate renew it, or switch certbot to webroot.' : 'certbot needs port 80 free at renewal time');
      else if (cb.authenticator === 'webroot') add(true, 'certbot method: webroot', `the check is answered from ${cb.webroot || '(no folder set)'}`);
      else if (/^dns/.test(cb.authenticator || '')) add(null, `certbot method: ${cb.authenticator}`, 'the check is a DNS record: its API credentials must still be valid');
      else if (cb.authenticator) add(null, `certbot method: ${cb.authenticator}`, 'certbot changes the web server config itself at renewal');
    } else if (name) add(null, 'certbot renewal settings', `/etc/letsencrypt/renewal/${name}.conf could not be read`);
    if (cb.logErrors.length) { add(false, 'certbot logged errors', cb.logErrors.join('\n')); if (cb.logErrors.some(l => /too many|rateLimited/i.test(l))) rateLimited = true; }
  } else if (c.renewer === 'acme.sh') add(null, 'acme.sh renews it', 'by its own cron (crontab -l shows it)');
  else if (['caddy', 'traefik'].includes(c.renewer)) {
    const e = (ov.errors || []).find(x => c.proxies.includes(x.proxy));
    add(e ? false : true, `${c.renewal}`, e ? e.lines.join('\n') : 'no certificate errors in its log');
    if (e && e.lines.some(l => /too many|rateLimited|rate limit/i.test(l))) rateLimited = true;
  } else if (c.renewer === 'npm') add(null, 'Nginx Proxy Manager keeps it', 'renew it in Nginx Proxy Manager (SSL Certificates → ⋯ → Renew)');
  else add(false, 'Nobody renews it', 'a certificate file in the config: when it expires, nothing makes a new one');
  if (rateLimited) add(false, "Let's Encrypt rate limit", "too many certificates for these names this week (5 per week): wait, then try again — another try now fails the same way");
  if (wildcard) add(null, 'Wildcard name', `${c.names.find(n => n.startsWith('*.'))} needs a DNS check: DockGate can not renew wildcards (certbot or acme.sh with a DNS plugin can)`);

  // DNS of each name → this server?
  const mine = await serverAddresses(ctx);
  for (const n of names.slice(0, 4)) {
    let ips = []; try { ips = (await dns.lookup(n, { all: true })).map(a => a.address); } catch (e) { add(false, `DNS of ${n}`, `${n} does not resolve (${e.code}): Let's Encrypt can not reach it`); continue; }
    const cf = ips.filter(isCloudflare);
    if (cf.length) { add(null, `DNS of ${n}`, `${ips.join(', ')} — Cloudflare's proxy answers it. The check works only if Cloudflare passes http://${n}/.well-known/acme-challenge/ to this server (the test below shows it).`); continue; }
    if (!mine.length) { add(null, `DNS of ${n}`, `${ips.join(', ')} (this server's addresses are not known here — the test below shows whether it is this server)`); continue; }
    const hit = ips.some(ip => mine.includes(ip));
    add(hit ? true : null, `DNS of ${n}`, hit ? `${ips.join(', ')} — this server` : `${ips.join(', ')}, and this server has ${mine.filter(x => !x.startsWith('127.') && x !== '::1').slice(0, 4).join(', ')}${ips.some(x => !isPrivate(x)) && mine.every(isPrivate) ? ' — fine if the first is the public address of this server behind a router' : ' — it may point to another server'}`);
  }

  // the challenge path, the way Let's Encrypt asks it
  const n0 = names[0];
  if (n0 && !c.internal && !['npm'].includes(c.renewer)) {
    let where = null; let how = '';
    const sf = await siteFor(c, n0);
    if (sf) {
      const text = (await PE.readFile(ctx, sf.p, sf.s.file).catch(() => ({ text: '' }))).text;
      if (text.includes(G.ACME_ROOT)) { where = { proxy: sf.p, root: G.ACME_ROOT }; how = `through ${sf.p.name}`; }
    }
    if (!where && cb && cb.authenticator === 'webroot' && cb.webroot && !c.certbotContainer) { where = { root: cb.webroot }; how = `from certbot's webroot ${cb.webroot}`; }
    if (where) { const t = await challengeTest(ctx, where, n0); add(t.ok, `Challenge path (asked by name, ${how})`, t.detail + (t.ok === false && mine.length ? '. Asked from DockGate on this server: a router without "hairpin" can also cause this — Let\'s Encrypt asks from outside.' : '')); }
    else {
      const r = await fetchLikeAcme(`http://${n0}/.well-known/acme-challenge/dockgate-check`);
      add(r.status ? null : false, `Port 80 of ${n0}`, r.status ? `answers ${r.status} (DockGate could not put a test file here, so only the answer is checked)` : `no answer (${r.error}): port 80 does not reach it`);
    }
  }

  // served: a renewed file that the proxy does not load
  if (c.served && c.served.stale) add(false, 'The proxy serves an older certificate', `${c.served.proxy} still serves the one that ends ${String(c.served.notAfter).slice(0, 10)}; the file is newer — a reload fixes it`);

  // the fixes that apply
  const canTakeOver = !c.managedId && !c.internal && !wildcard && ['certbot', 'acme.sh', 'none'].includes(c.renewer) && !!(n0 && await siteFor(c, n0));
  if (c.served && c.served.stale) fixes.push({ id: 'reload', label: 'Reload the proxy', desc: 'Check its config and reload it, so it serves the newer file.' });
  if (c.managedId) fixes.push({ id: 'putback', label: 'Put the files back, then renew', desc: 'Writes DockGate\'s copy of the certificate to the proxy again (after a re-create), then asks Let\'s Encrypt for a new one.' });
  if (c.managedId || c.renewer === 'certbot' || c.renewer === 'acme.sh') fixes.push({ id: 'renew', label: 'Renew now', desc: `${c.managedId ? 'DockGate asks Let\'s Encrypt' : c.renewer} for a new certificate now, then the proxies using it are reloaded.` });
  if (c.renewer === 'certbot') fixes.push({ id: 'certbot-dry-run', label: 'certbot test run', desc: 'certbot renew --dry-run: tries the whole renewal against Let\'s Encrypt\'s test service, changes nothing.' });
  if (canTakeOver) fixes.push({ id: 'takeover', label: 'Let DockGate get and renew it', desc: 'DockGate gets a new certificate from Let\'s Encrypt through the proxy, switches the site to it and renews it from now on. The old files stay.' });
  if (c.renewer === 'caddy' && !c.internal) fixes.push({ id: 'caddy-reissue', label: 'Make Caddy get it again', desc: 'Moves Caddy\'s stored certificate aside (kept) and reloads Caddy, which then asks for a new one.' });
  if (c.renewer === 'traefik') fixes.push({ id: 'traefik-reissue', label: 'Make Traefik get it again', desc: 'Copies acme.json, takes this certificate out of it and restarts Traefik, which then asks for a new one.' });
  const firstBad = checks.find(x => x.ok === false && !/^Expire/.test(x.title));
  return { fingerprint, names: c.names, daysLeft: c.daysLeft, renewal: c.renewal, verdict: firstBad ? `${firstBad.title}: ${firstBad.detail.split('\n')[0]}` : c.daysLeft < 0 ? 'Nothing found that blocks a renewal — renew it now.' : 'Nothing found that blocks a renewal.', checks, fixes };
}

const FIXES = ['reload', 'renew', 'putback', 'certbot-dry-run', 'takeover', 'caddy-reissue', 'traefik-reissue'];
async function fix(fingerprint, action, user) {
  if (!FIXES.includes(action)) throw err('Unknown fix');
  const ctx = PE.activeCtx();
  const ov = await PE.certOverview({ ctx });
  const c = ov.certs.find(x => x.fingerprint === fingerprint); if (!c) throw err('Certificate not found — refresh the list', 404);
  const names = c.names.filter(n => P.isDomain(n) && !n.startsWith('*.'));
  const steps = []; const out = [];
  const reloadAll = async () => { for (const id of c.proxyIds || []) { try { const r = await PE.reloadProxy(id); steps.push({ t: `${(await PX.proxyById(id)).name}: ${r.ok ? 'checked and reloaded' : 'reload failed'}`, ok: r.ok }); if (!r.ok) out.push(r.output); } catch (e) { steps.push({ t: e.message, ok: false }); } } };
  if (action === 'reload') { await reloadAll(); PX.invalidate(); return { ok: steps.every(s => s.ok), steps, output: out.join('\n') }; }
  if (action === 'renew') return PE.renewNow(fingerprint, user);
  if (action === 'putback') {
    if (!c.managedId) throw err('Not a certificate DockGate keeps');
    const r = await PE.redeploy(c.managedId); steps.push({ t: r.ok ? 'Certificate files written again and the proxy reloaded' : 'Files written, but the config check failed', ok: r.ok });
    const r2 = await PE.renewNow(fingerprint, user).catch(e => ({ ok: false, steps: [{ t: e.message, ok: false }] }));
    return { ok: r.ok && r2.ok, steps: [...steps, ...(r2.steps || [])], output: [r.output, r2.output].filter(Boolean).join('\n') };
  }
  if (action === 'certbot-dry-run') {
    const name = (c.paths.map(x => (x.match(/\/letsencrypt\/live\/([^/]+)\//) || [])[1]).find(Boolean)); if (!name) throw err('No certbot name in the path');
    const cmd = `certbot renew --cert-name ${shq(name)} --dry-run --no-random-sleep-on-renew 2>&1`;
    let r;
    if (c.certbotContainer && !c.proxies.includes('host')) { const d = await PX.scan(); const h = (d.helpers || []).find(x => x.name === c.certbotContainer); if (!h || !h.running) throw err(`The certbot container ${c.certbotContainer} is not running`); r = await PX.execIn(ctx.c, h.cid, ['sh', '-c', cmd], { timeout: 180000, user: 'root' }); }
    else { if (!ctx.server) throw err('DockGate has no access to the host here (DG_HOST_ACCESS is off)'); r = await PX.hostExec(ctx.server, rootSh(cmd)); }
    const text = (r.out + r.err).trim(); const ok = r.code === 0 && /succeeded|Congratulations/i.test(text) && !/fail/i.test(text.split('\n').slice(-6).join('\n'));
    return { ok, steps: [{ t: ok ? 'certbot test run: the renewal works (nothing was changed)' : 'certbot test run failed — the reason is below', ok }], output: text.slice(-6000) };
  }
  if (action === 'takeover') {
    const sf = await siteFor(c, names[0]); if (!sf) throw err('No nginx or Apache site uses this certificate for its first name: DockGate can not answer the check for it');
    const r = await PE.certForSite(sf.p.id, names[0], { redirect: true }, user);
    if (r.ok) r.steps.push({ t: `${names[0]} now uses DockGate's certificate. The old ${c.renewer === 'certbot' ? 'certbot' : c.renewer} certificate is no longer used (it stays on disk).`, ok: true });
    PX.invalidate(); return r;
  }
  if (action === 'caddy-reissue') {
    const p = await PX.proxyById((c.proxyIds || [])[0]); if (p.kind !== 'caddy') throw err('Not a Caddy certificate');
    const certFile = c.paths.find(x => /\/certificates\//.test(x)); if (!certFile) throw err('Caddy\'s certificate file is not known');
    const dir = certFile.replace(/\/[^/]+$/, ''); const bak = `${dir.replace(/\/certificates\/.*$/, '')}/dockgate-backup/${Date.now()}`;
    const mv = await PE.run(ctx, p, `mkdir -p ${shq(bak)} && mv ${shq(dir)} ${shq(bak + '/')} && echo moved`);
    if (!/moved/.test(mv.out)) throw err(`Could not move ${dir}: ${(mv.out + mv.err).trim().slice(0, 200)}`);
    steps.push({ t: `Caddy's stored certificate moved to ${bak} (kept)`, ok: true });
    const C = PE.cmds(p); const rl = await PE.run(ctx, p, `${C.reload} --force 2>&1`);
    steps.push({ t: rl.code === 0 ? 'Caddy reloaded: it asks for a new certificate now' : 'Caddy reload failed', ok: rl.code === 0 });
    await new Promise(r => setTimeout(r, 20000));
    const ls = await PE.run(ctx, p, `ls ${shq(dir)} 2>/dev/null`);
    const got = /\.crt/.test(ls.out);
    steps.push(got ? { t: 'Caddy has a new certificate', ok: true } : { t: 'No new certificate yet — Caddy keeps trying; its log (Logs tab) says why', ok: true, warn: true });
    PX.invalidate(); return { ok: rl.code === 0, steps, output: (rl.out + rl.err).trim().slice(-3000) };
  }
  if (action === 'traefik-reissue') {
    const p = await PX.proxyById((c.proxyIds || [])[0]); if (p.kind !== 'traefik') throw err('Not a Traefik certificate');
    const file = c.paths.find(x => /acme\.json$/.test(x)); if (!file) throw err('Traefik\'s acme.json is not known');
    const cur = await PE.readFile(ctx, p, file); let j; try { j = JSON.parse(cur.text); } catch (e) { throw err('acme.json could not be read as JSON'); }
    let removed = 0;
    for (const res of Object.values(j || {})) { if (!res || !Array.isArray(res.Certificates)) continue; const before = res.Certificates.length; res.Certificates = res.Certificates.filter(x => !(x.domain && [x.domain.main, ...(x.domain.sans || [])].some(d => c.names.includes(d)))); removed += before - res.Certificates.length; }
    if (!removed) throw err('This certificate is not in acme.json');
    const bak = `${file}.dockgate-${Date.now()}`;
    const cp = await PE.run(ctx, p, `cp -p ${shq(file)} ${shq(bak)} && echo copied`); if (!/copied/.test(cp.out)) throw err(`Could not copy acme.json: ${(cp.out + cp.err).trim().slice(0, 200)}`);
    steps.push({ t: `acme.json copied to ${bak}`, ok: true });
    await PE.writeFile(ctx, p, file, JSON.stringify(j, null, 2), { mode: '600' });
    steps.push({ t: `Took ${removed} certificate(s) for ${c.names[0]} out of acme.json`, ok: true });
    await ctx.c.getContainer(p.cid).restart({ t: 10 });
    steps.push({ t: `${p.name} restarted: it asks for a new certificate now (its log says how it goes)`, ok: true });
    PX.invalidate(); return { ok: true, steps };
  }
  throw err('Unknown fix');
}

module.exports = { diagnose, fix, isCloudflare, isPrivate, fetchLikeAcme };
