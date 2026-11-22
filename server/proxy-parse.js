// Reading proxy configs (Web → Proxies & SSL): nginx -T, a Caddyfile, Traefik labels, haproxy.cfg, apachectl -S,
// access log lines and certificates. Pure functions — the commands that produce the text are in proxies.js.
const crypto = require('crypto');

const isDomain = (h) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(h || '')) && !/^\d+(\.\d+){3}$/.test(h);

// ---------- nginx ----------
/** nginx -T output → { files: [{ path, text }], servers: [...], upstreams: { name: [addr] } }. */
function parseNginxT(out) {
  const text = String(out || '');
  const files = [];
  const re = /^# configuration file (.+?):\s*$/gm;
  const marks = []; let m;
  while ((m = re.exec(text))) marks.push({ path: m[1], start: m.index, body: re.lastIndex });
  for (let i = 0; i < marks.length; i++) files.push({ path: marks[i].path, text: text.slice(marks[i].body, i + 1 < marks.length ? marks[i + 1].start : text.length).replace(/^\n/, '').replace(/\n+$/, '\n') });
  const servers = []; const upstreams = {};
  for (const f of files) {
    const src = f.text.replace(/#[^\n]*/g, (c) => ' '.repeat(c.length)); // comments out, offsets kept
    walk(src, (block) => {
      if (block.name === 'upstream') upstreams[block.args[0]] = block.directives.filter(d => d.name === 'server').map(d => d.args[0]);
      if (block.name !== 'server') return;
      const d = (n) => block.directives.filter(x => x.name === n);
      const listen = d('listen').map(x => x.args.join(' '));
      const names = d('server_name').flatMap(x => x.args).filter(n => n && n !== '_' && n !== '""');
      const ssl = listen.some(l => /\bssl\b|(^|:)443(\s|$)/.test(l));
      const ret = d('return').map(x => x.args.join(' '))[0] || '';
      // proxy_pass $var: the value of `set $var …` in the location or the server (DockGate's own sites use this)
      const viaSet = (pp, ...scopes) => { if (!pp || !pp.startsWith('$')) return pp; for (const sc of scopes) { const st = sc.find(x => x.name === 'set' && x.args[0] === pp); if (st && st.args[1]) return st.args[1]; } return pp; };
      const locs = block.children.filter(c => c.name === 'location').map(c => ({
        path: c.args.join(' '),
        proxyPass: viaSet((c.directives.find(x => x.name === 'proxy_pass') || {}).args?.[0] || null, c.directives, block.directives),
        root: (c.directives.find(x => x.name === 'root') || {}).args?.[0] || null,
        ret: (c.directives.find(x => x.name === 'return') || {}).args?.join(' ') || null,
      }));
      servers.push({
        file: f.path, line: lineOf(f.text, block.at), names, listen, ssl,
        cert: (d('ssl_certificate')[0] || {}).args?.[0] || null,
        redirectHttps: /^30[18]\s+https:\/\//.test(ret) || locs.some(l => /^30[18]\s+https:\/\//.test(l.ret || '')),
        root: (d('root')[0] || {}).args?.[0] || null,
        proxyPass: viaSet((d('proxy_pass')[0] || {}).args?.[0] || null, block.directives),
        locations: locs,
      });
    });
  }
  return { files, servers, upstreams };
}
const lineOf = (text, at) => text.slice(0, at).split('\n').length;
/** A tiny nginx-style block parser: calls fn(block) for every block at any depth. */
function walk(src, fn) {
  let i = 0;
  const parseBlock = (name, args, at) => {
    const block = { name, args, at, directives: [], children: [] };
    let tok = []; let tokAt = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' || ch === "'") { const q = ch; let j = i + 1; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } tok.push(src.slice(i + 1, j)); i = j + 1; continue; }
      if (ch === ';') { if (tok.length) block.directives.push({ name: tok[0], args: tok.slice(1) }); tok = []; i++; tokAt = i; continue; }
      if (ch === '{') { i++; const child = parseBlock(tok[0] || '', tok.slice(1), tokAt); block.children.push(child); fn(child); tok = []; tokAt = i; continue; }
      if (ch === '}') { i++; return block; }
      if (/\s/.test(ch)) { i++; if (!tok.length) tokAt = i; continue; }
      let j = i; while (j < src.length && !/[\s;{}"']/.test(src[j])) j++;
      if (!tok.length) tokAt = i;
      tok.push(src.slice(i, j)); i = j;
    }
    return block;
  };
  parseBlock('main', [], 0);
}
/** nginx servers → one site per domain (the http server that only redirects is folded into the https one). */
function nginxSites(parsed) {
  const by = new Map();
  for (const s of parsed.servers) for (const n of s.names) {
    if (!isDomain(n) && n !== 'localhost') continue;
    const cur = by.get(n) || { domain: n, http: false, https: false, redirect: false, target: null, cert: null, file: s.file, line: s.line, root: null };
    if (s.ssl) { cur.https = true; cur.cert = s.cert || cur.cert; cur.file = s.file; cur.line = s.line; } else cur.http = true;
    if (s.redirectHttps && !s.ssl) cur.redirect = true;
    const pp = (s.locations.find(l => l.path === '/' && l.proxyPass) || s.locations.find(l => l.proxyPass) || {}).proxyPass || s.proxyPass;
    if (pp && (!cur.target || s.ssl)) cur.target = pp;
    if (!pp && (s.root || (s.locations.find(l => l.root) || {}).root) && !cur.target) cur.root = s.root || s.locations.find(l => l.root).root;
    by.set(n, cur);
  }
  return [...by.values()].map(x => ({ ...x, targets: upstreamOf(x.target, parsed.upstreams) }));
}
/** proxy_pass http://name:port/… → ['host:port', …] (an upstream name gives its servers). */
function upstreamOf(pp, upstreams = {}) {
  if (!pp) return [];
  const m = String(pp).match(/^(?:https?|grpcs?|uwsgi):\/\/([^/$]+)/i) || String(pp).match(/^([^/$\s]+)/);
  if (!m) return [];
  const host = m[1].replace(/^unix:.*/, 'unix');
  if (upstreams[host]) return upstreams[host];
  return [host];
}

// ---------- Caddy ----------
/** Caddyfile → sites [{ domain, targets, file root?, line }] (site blocks with reverse_proxy / root / redir). */
function parseCaddyfile(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const sites = []; let depth = 0; let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    const t = line.trim(); if (!t) continue;
    if (depth === 0 && t.endsWith('{') && !t.startsWith('(') && !/^\{$/.test(t)) {
      const addrs = t.slice(0, -1).split(/[\s,]+/).filter(Boolean);
      cur = { addrs, targets: [], root: null, line: i + 1 };
      sites.push(cur);
    }
    if (cur && depth >= 1) {
      const rp = t.match(/^reverse_proxy\s+(?:(\S+)\s+)?(.+?)\s*\{?$/);
      if (rp) { const parts = (rp[2] || '').split(/\s+/); const toks = rp[1] && !rp[1].startsWith('/') && !rp[1].startsWith('@') ? [rp[1], ...parts] : parts; cur.targets.push(...toks.filter(x => x && x !== '{' && !x.startsWith('/') && !x.startsWith('@'))); }
      const rt = t.match(/^root\s+(?:\*\s+)?(\S+)/); if (rt) cur.root = rt[1];
    }
    depth += (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length;
    if (depth <= 0) { depth = 0; if (t.includes('}')) cur = null; }
  }
  const out = [];
  for (const s of sites) for (const a of s.addrs) {
    const host = a.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    if (!isDomain(host) && host !== 'localhost') continue;
    out.push({ domain: host, https: !/^http:\/\//.test(a) && !/:80$/.test(a), targets: s.targets.map(x => x.replace(/^https?:\/\//, '')), root: s.root, line: s.line });
  }
  return out;
}

// ---------- Traefik (labels) ----------
/** Container / service labels → sites [{ domain, router, port, tls, resolver, entrypoints }]. */
function traefikSites(labels = {}) {
  if (String(labels['traefik.enable']).toLowerCase() === 'false') return [];
  const routers = {}; const ports = {};
  for (const [k, v] of Object.entries(labels)) {
    let m = k.match(/^traefik\.http\.routers\.([^.]+)\.(rule|tls|tls\.certresolver|entrypoints|service)$/);
    if (m) { (routers[m[1]] = routers[m[1]] || {})[m[2]] = v; continue; }
    m = k.match(/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/);
    if (m) ports[m[1]] = v;
  }
  const out = [];
  for (const [name, r] of Object.entries(routers)) {
    const hosts = []; for (const mm of String(r.rule || '').matchAll(/Host(?:SNI)?\(([^)]*)\)/g)) for (const h of mm[1].split(',')) hosts.push(h.replace(/[`'"\s]/g, ''));
    const port = ports[r.service] || Object.values(ports)[0] || null;
    for (const h of hosts) if (isDomain(h)) out.push({ domain: h, router: name, port, tls: String(r.tls).toLowerCase() === 'true' || !!r['tls.certresolver'], resolver: r['tls.certresolver'] || null, entrypoints: r.entrypoints || null });
  }
  return out;
}
/** caddy-docker-proxy labels (caddy=domain, caddy.reverse_proxy={{upstreams 80}}). */
function caddyLabelSites(labels = {}) {
  const out = [];
  for (const [k, v] of Object.entries(labels)) {
    const m = k.match(/^caddy(_\d+)?$/); if (!m) continue;
    const rp = labels[`caddy${m[1] || ''}.reverse_proxy`] || '';
    const port = (rp.match(/upstreams\s+(\d+)/) || [])[1] || null;
    for (const h of String(v).split(/[\s,]+/)) { const d = h.replace(/^https?:\/\//, ''); if (isDomain(d)) out.push({ domain: d, port }); }
  }
  return out;
}

// ---------- HAProxy ----------
function parseHaproxy(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const backends = {}; const fronts = []; let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/#.*$/, '').trim(); if (!t) continue;
    const h = t.match(/^(frontend|backend|listen|defaults|global)\s*(\S*)/);
    if (h) { sec = { kind: h[1], name: h[2], acls: {}, uses: [], binds: [], line: i + 1, def: null }; if (h[1] === 'backend' || h[1] === 'listen') backends[h[2]] = []; if (h[1] === 'frontend' || h[1] === 'listen') fronts.push(sec); continue; }
    if (!sec) continue;
    let m;
    if ((m = t.match(/^server\s+\S+\s+(\S+)/)) && backends[sec.name]) backends[sec.name].push(m[1]);
    if ((m = t.match(/^bind\s+(\S+)(.*)$/))) sec.binds.push({ addr: m[1], ssl: /\bssl\b/.test(m[2]) });
    if ((m = t.match(/^acl\s+(\S+)\s+(?:req\.)?hdr(?:_dom|_beg|_end)?\(host\)(?:,[\w.]+(?:\([^)]*\))?)*\s+(?:-[im]\s+)*(.+)$/))) sec.acls[m[1]] = m[2].split(/\s+/).filter(x => x !== '-i');
    if ((m = t.match(/^use_backend\s+(\S+)\s+if\s+(\S+)/))) sec.uses.push({ backend: m[1], acl: m[2] });
    if ((m = t.match(/^default_backend\s+(\S+)/))) sec.def = m[1];
  }
  const out = [];
  for (const f of fronts) for (const u of f.uses) for (const host of f.acls[u.acl] || []) if (isDomain(host)) out.push({ domain: host, targets: backends[u.backend] || [], backend: u.backend, https: f.binds.some(b => b.ssl), line: f.line });
  return out;
}

// ---------- Apache ----------
/** apachectl -S → [{ domain, port, file, line }] */
function parseApacheS(out) {
  const res = [];
  for (const line of String(out || '').split('\n')) {
    let m = line.match(/port\s+(\d+)\s+namevhost\s+(\S+)\s+\((.+?):(\d+)\)/);
    if (m && isDomain(m[2])) { res.push({ domain: m[2], port: Number(m[1]), file: m[3], line: Number(m[4]) }); continue; }
    m = line.match(/alias\s+(\S+)/); if (m && res.length && isDomain(m[1])) res.push({ ...res[res.length - 1], domain: m[1] });
    m = line.match(/^\*?:?(\d+)\s+(\S+)\s+\((.+?):(\d+)\)/); if (m && isDomain(m[2])) res.push({ domain: m[2], port: Number(m[1]), file: m[3], line: Number(m[4]) });
  }
  return res;
}

// ---------- access logs ----------
/** combined / common log format (with an optional host first) → { ip, time, method, path, status, bytes, ms, host }. */
function parseAccessLine(line) {
  const m = String(line).match(/^(?:(\S+)\s+)?(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)[^"]*"\s+(\d{3})\s+(\S+)(?:\s+"[^"]*"\s+"[^"]*")?(?:\s+(\S+))?/);
  if (!m) return null;
  let host = m[1] || null, ip = m[2];
  if (host && /^\d+\.\d+\.\d+\.\d+$|:/.test(host) && !/^\d+\.\d+\.\d+\.\d+$|:/.test(ip)) { const x = host; host = ip; ip = x; }
  const rt = m[8] && /^\d+(\.\d+)?$/.test(m[8]) ? Math.round(Number(m[8]) * (m[8].includes('.') ? 1000 : 1)) : null;
  return { ip, host, time: m[3], method: m[4], path: m[5], status: Number(m[6]), bytes: m[7] === '-' ? 0 : Number(m[7]) || 0, ms: rt };
}
/** Caddy JSON access log line → same shape. */
function parseCaddyJsonLine(line) {
  try {
    const j = JSON.parse(line); if (!j.request) return null;
    return { ip: j.request.remote_ip || j.request.client_ip || '', host: j.request.host || null, time: j.ts ? new Date(j.ts * 1000).toISOString() : '', method: j.request.method, path: j.request.uri, status: j.status, bytes: j.size || 0, ms: j.duration != null ? Math.round(j.duration * 1000) : null };
  } catch (e) { return null; }
}

// ---------- certificates ----------
/** PEM text (the first certificate of a chain) → { names, issuer, validTo, daysLeft, selfSigned }. */
function parseCertPem(pem) {
  const first = String(pem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!first) return null;
  try {
    const c = new crypto.X509Certificate(first[0]);
    const names = (c.subjectAltName || '').split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(s => s && !/^IP Address:/.test(s));
    const cn = (c.subject.match(/CN=([^\n,]+)/) || [])[1];
    if (cn && !names.includes(cn)) names.unshift(cn);
    const o = (c.issuer.match(/O=([^\n]+)/) || [])[1]; const icn = (c.issuer.match(/CN=([^\n]+)/) || [])[1];
    const validTo = new Date(c.validTo);
    return { names, issuer: [o, icn].filter(Boolean).join(' ') || c.issuer, validTo: validTo.toISOString(), daysLeft: Math.floor((validTo - Date.now()) / 86400000), selfSigned: c.issuer === c.subject, fingerprint: c.fingerprint256 };
  } catch (e) { return null; }
}
/** Traefik acme.json → [{ names, pem, resolver }]. */
function traefikAcme(json) {
  const out = [];
  try {
    const j = JSON.parse(json);
    for (const [resolver, v] of Object.entries(j || {})) for (const c of (v && v.Certificates) || []) {
      const pem = Buffer.from(c.certificate || '', 'base64').toString('utf8');
      out.push({ resolver, pem, main: c.domain && c.domain.main, sans: (c.domain && c.domain.sans) || [] });
    }
  } catch (e) { /* not JSON */ }
  return out;
}

module.exports = { isDomain, parseNginxT, nginxSites, upstreamOf, parseCaddyfile, traefikSites, caddyLabelSites, parseHaproxy, parseApacheS, parseAccessLine, parseCaddyJsonLine, parseCertPem, traefikAcme };
