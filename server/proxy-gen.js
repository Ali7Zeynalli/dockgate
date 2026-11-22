// Proxies & SSL — the text DockGate writes into proxy configs (pure functions, no I/O):
//   · a new site for nginx / Caddy / HAProxy / Apache, labels for Traefik and caddy-docker-proxy
//   · load balancing: the servers and method of an nginx upstream, a Caddy reverse_proxy, an HAProxy backend
//   · nginx: the ACME challenge location in a site, HTTPS added to a site, certificate paths swapped
//   · removing a site DockGate made
// Blocks DockGate adds to a shared file (Caddyfile, haproxy.cfg) sit between "# dockgate:begin <domain>" and
// "# dockgate:end <domain>"; files DockGate makes start with MARK.
const MARK = '# Made by DockGate (Web → Proxies & SSL).';
const ACME_ROOT = '/var/lib/dockgate-acme';
const err = (m) => Object.assign(new Error(m), { statusCode: 400 });

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TARGET_RE = /^[a-z0-9]([a-z0-9_.-]{0,250}[a-z0-9])?:\d{1,5}$/i;
const slug = (d) => String(d).toLowerCase().replace(/^\*\./, 'wildcard.').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const LB = { nginx: { round_robin: '', least_conn: 'least_conn;', ip_hash: 'ip_hash;' }, caddy: { round_robin: 'round_robin', least_conn: 'least_conn', ip_hash: 'ip_hash', random: 'random', first: 'first' }, haproxy: { round_robin: 'roundrobin', least_conn: 'leastconn', ip_hash: 'source' } };

/** Check and normalise the input of a new site. */
function siteInput(o = {}) {
  const domain = String(o.domain || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) throw err(`Not a domain name: ${o.domain || '(empty)'}`);
  const aliases = [...new Set((Array.isArray(o.aliases) ? o.aliases : String(o.aliases || '').split(/[\s,]+/)).map(s => s.trim().toLowerCase()).filter(Boolean))].filter(a => a !== domain);
  for (const a of aliases) if (!DOMAIN_RE.test(a)) throw err(`Not a domain name: ${a}`);
  const targets = (Array.isArray(o.targets) ? o.targets : String(o.targets || '').split(/[\s,]+/)).map(t => String(t.addr || t).trim()).filter(Boolean);
  if (!targets.length) throw err('Choose the container (and port) the domain goes to');
  for (const t of targets) { if (!TARGET_RE.test(t)) throw err(`Not host:port — ${t}`); const port = Number(t.split(':').pop()); if (port < 1 || port > 65535) throw err(`Bad port in ${t}`); }
  const https = ['letsencrypt', 'existing', 'auto', 'none'].includes(o.https) ? o.https : 'none';
  const lb = Object.prototype.hasOwnProperty.call(LB.nginx, o.lb) || o.lb === 'random' || o.lb === 'first' ? o.lb : 'round_robin';
  const FILE = /^\/[\w.@+\-/]{1,300}$/;
  for (const k of ['certPath', 'keyPath']) if (o[k] && (!FILE.test(String(o[k])) || /(^|\/)\.\.(\/|$)/.test(o[k]))) throw err(`Not a file path: ${o[k]}`);
  if (o.path && o.path !== '/' && !/^\/[\w.\-/~%]{0,200}$/.test(String(o.path))) throw err(`Not a URL path: ${o.path}`);
  const maxBody = o.maxBody == null || o.maxBody === '' ? null : String(o.maxBody).trim();
  if (maxBody && !/^\d{1,5}[kmg]?$/i.test(maxBody)) throw err('Upload limit: a number with k, m or g (e.g. 50m)');
  return { domain, aliases, names: [domain, ...aliases], targets, https, redirect: o.redirect !== false, websocket: !!o.websocket, lb, maxBody,
    ipv6: !!o.ipv6, certPath: o.certPath ? String(o.certPath) : null, keyPath: o.keyPath ? String(o.keyPath) : null, dockerDns: !!o.dockerDns, path: o.path && o.path !== '/' ? String(o.path) : '/' };
}

// ---------- nginx ----------
const nginxAcme = (ind = '  ') => `${ind}location ^~ /.well-known/acme-challenge/ {\n${ind}  root ${ACME_ROOT};\n${ind}  default_type text/plain;\n${ind}}`;
function nginxProxyBlock(s, up, ind) {
  const L = [];
  if (s.dockerDns && s.targets.length === 1) { L.push(`set $dg_upstream http://${s.targets[0]};`, 'proxy_pass $dg_upstream;'); } // nginx starts even while the container is down
  else L.push(`proxy_pass http://${up};`);
  L.push('proxy_http_version 1.1;', 'proxy_set_header Host $host;', 'proxy_set_header X-Real-IP $remote_addr;', 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', 'proxy_set_header X-Forwarded-Proto $scheme;');
  if (s.websocket) L.push('proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection "upgrade";', 'proxy_read_timeout 3600s;');
  return `${ind}location ${s.path} {\n${L.map(l => `${ind}  ${l}`).join('\n')}\n${ind}}`;
}
/** A whole nginx site file. With https 'letsencrypt' and no certificate yet (certReady false) only the HTTP part is written. */
function nginxSite(input, { certReady = true } = {}) {
  const s = siteInput(input);
  const up = s.targets.length > 1 || s.lb !== 'round_robin' ? `dg_${slug(s.domain)}` : s.targets[0];
  const out = [`${MARK} Site ${s.domain} → ${s.targets.join(', ')}.`, '# DockGate keeps earlier versions of this file; edit it freely.'];
  if (up.startsWith('dg_')) out.push(`upstream ${up} {`, ...(LB.nginx[s.lb] ? [`  ${LB.nginx[s.lb]}`] : []), ...s.targets.map(t => `  server ${t};`), '}');
  const head = (ssl) => [ssl ? '  listen 443 ssl;' : '  listen 80;', ...(s.ipv6 ? [ssl ? '  listen [::]:443 ssl;' : '  listen [::]:80;'] : []), `  server_name ${s.names.join(' ')};`,
    ...(s.dockerDns && !up.startsWith('dg_') ? ['  resolver 127.0.0.11 valid=10s ipv6=off;'] : []), ...(s.maxBody ? [`  client_max_body_size ${s.maxBody};`] : [])];
  const wantsTls = s.https === 'letsencrypt' || s.https === 'existing';
  const tls = wantsTls && certReady;
  out.push('server {', ...head(false), nginxAcme());
  if (tls && s.redirect) out.push('  location / {', '    return 301 https://$host$request_uri;', '  }');
  else out.push(nginxProxyBlock(s, up, '  '));
  out.push('}');
  if (tls) {
    if (!s.certPath || !s.keyPath) throw err('No certificate chosen for HTTPS');
    out.push('server {', ...head(true), `  ssl_certificate ${s.certPath};`, `  ssl_certificate_key ${s.keyPath};`, '  ssl_protocols TLSv1.2 TLSv1.3;', '  ssl_session_cache shared:dg_ssl:10m;', nginxProxyBlock(s, up, '  '), '}');
  }
  return out.join('\n') + '\n';
}

/** The ranges of top-level blocks named `kind args {` (server / upstream) of an nginx file: [{ start, end, head, body }]. */
function nginxBlocks(text, kind) {
  const res = []; const re = new RegExp(`(^|\\n)([ \\t]*)${kind}\\b([^{;#]*)\\{`, 'g'); let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length; let i = re.lastIndex, depth = 1;
    while (i < text.length && depth) { const ch = text[i]; if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue; } if (ch === '"' || ch === "'") { const q = ch; i++; while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; } } else if (ch === '{') depth++; else if (ch === '}') depth--; i++; }
    res.push({ start, end: i, indent: m[2], args: m[3].trim(), text: text.slice(start, i) });
    re.lastIndex = i;
  }
  return res;
}
/** One nginx block re-written one statement per line (same meaning), so lines can be found and inserted. */
function fmtBlock(text, base = '') {
  let out = '', depth = 0, line = '', i = 0;
  const push = () => { const t = line.trim(); if (t) out += `${base}${'  '.repeat(depth)}${t}\n`; line = ''; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') { let j = i; while (j < text.length && text[j] !== '\n') j++; line += text.slice(i, j); push(); i = j; continue; }
    if (ch === '"' || ch === "'") { let j = i + 1; while (j < text.length && text[j] !== ch) { if (text[j] === '\\') j++; j++; } line += text.slice(i, j + 1); i = j + 1; continue; }
    if (ch === ';') { line += ';'; push(); }
    else if (ch === '{') { line += ' {'; line = line.replace(/\s+\{$/, ' {'); push(); depth++; }
    else if (ch === '}') { push(); depth = Math.max(0, depth - 1); line = '}'; push(); }
    else if (ch === '\n') { if (line.trim().startsWith('#')) push(); else line += ' '; }
    else line += ch;
    i++;
  }
  push();
  return out.replace(/\n$/, '');
}
const serverNames = (block) => ((block.match(/\bserver_name\s+([^;]+);/) || [])[1] || '').split(/\s+/).filter(Boolean);
const isSslServer = (block) => /\blisten\s+[^;]*\bssl\b/.test(block) || /\bssl_certificate\s/.test(block);

/** The HTTP (port 80) server of `domain` answers the ACME challenge from ACME_ROOT. A server-level `return` moves into `location /` (it would run first). */
function nginxEnsureAcme(text, domain) {
  const blocks = nginxBlocks(text, 'server').filter(b => serverNames(b.text).includes(domain) && !isSslServer(b.text));
  if (!blocks.length) throw err(`No HTTP (port 80) server for ${domain} in this file — the certificate check comes over HTTP`);
  const b = blocks[0];
  if (b.text.includes(ACME_ROOT)) return { text, changed: false };
  let body = fmtBlock(b.text, b.indent).replace(/^\s+/, '');
  const lines = body.split('\n'); let depth = 0; const out = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (depth === 1 && /^\s*return\s+30[12]\b/.test(l)) { const ind = (l.match(/^\s*/) || [''])[0]; out.push(`${ind}location / {`, `${ind}  ${l.trim()}`, `${ind}}`); }
    else out.push(l);
    depth += (l.replace(/#.*$/, '').match(/\{/g) || []).length - (l.replace(/#.*$/, '').match(/\}/g) || []).length;
  }
  body = out.join('\n');
  const ind = b.indent + '  ';
  body = body.replace(/(\bserver_name\s+[^;]+;[^\n]*\n)/, `$1${nginxAcme(ind)}\n`);
  return { text: text.slice(0, b.start) + body + text.slice(b.end), changed: true };
}

/** Swap the certificate of every TLS server of `domain` to certPath / keyPath. */
function nginxSetCert(text, domain, certPath, keyPath) {
  let n = 0; let out = text;
  for (const b of nginxBlocks(text, 'server').reverse()) {
    if (!serverNames(b.text).includes(domain) || !isSslServer(b.text)) continue;
    let t = fmtBlock(b.text, b.indent).replace(/^\s+/, '').replace(/(\bssl_certificate\s+)[^;]+;/, `$1${certPath};`).replace(/(\bssl_certificate_key\s+)[^;]+;/, `$1${keyPath};`);
    if (!/\bssl_certificate\s/.test(t)) t = t.replace(/(\bserver_name\s+[^;]+;[^\n]*\n)/, `$1${b.indent}  ssl_certificate ${certPath};\n${b.indent}  ssl_certificate_key ${keyPath};\n`);
    out = out.slice(0, b.start) + t + out.slice(b.end); n++;
  }
  return { text: out, changed: n };
}

/** Add HTTPS to an HTTP-only nginx site: a copy of its server on 443 with the certificate; with redirect the HTTP server sends to https. */
function nginxAddHttps(text, domain, certPath, keyPath, { redirect = true } = {}) {
  const all = nginxBlocks(text, 'server');
  if (all.some(b => serverNames(b.text).includes(domain) && isSslServer(b.text))) return nginxSetCert(text, domain, certPath, keyPath);
  const b0 = all.find(x => serverNames(x.text).includes(domain));
  if (!b0) throw err(`${domain} is not in this file`);
  const b = { ...b0, text: fmtBlock(b0.text, b0.indent).replace(/^\s+/, '') };
  const ind = b.indent + '  ';
  let tls = b.text.replace(/\blisten\s+([^;]*?)\b80\b([^;]*);/g, (m0, a, z) => `listen ${a}443${z} ssl;`).replace(/ ssl ssl;/g, ' ssl;');
  if (!/\blisten\s+[^;]*443/.test(tls)) tls = tls.replace(/\{/, `{\n${ind}listen 443 ssl;`);
  tls = tls.replace(/(\bserver_name\s+[^;]+;[^\n]*\n)/, `$1${ind}ssl_certificate ${certPath};\n${ind}ssl_certificate_key ${keyPath};\n`);
  tls = tls.replace(new RegExp(`\\n[ \\t]*location \\^~ /\\.well-known/acme-challenge/ \\{[^}]*\\}`), '');
  let http = b.text;
  if (redirect) {
    const head = http.slice(0, http.indexOf('{') + 1);
    const keep = (http.match(/^[ \t]*(listen|server_name)\b[^;]*;[^\n]*$/gm) || []).join('\n');
    http = `${head}\n${keep}\n${nginxAcme(ind)}\n${ind}location / {\n${ind}  return 301 https://$host$request_uri;\n${ind}}\n${b.indent}}`;
  }
  return { text: text.slice(0, b.start) + http + '\n' + b.indent + tls.trimStart() + text.slice(b.end), changed: 1 };
}

/** The statements inside an upstream block (comments dropped, one per `;`, on one line or many). */
const upstreamStatements = (blockText) => blockText.slice(blockText.indexOf('{') + 1, blockText.lastIndexOf('}')).split('\n').map(l => l.replace(/#.*$/, '')).join(' ').split(';').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
/** nginx upstream → { name, method, servers: [{ addr, weight, backup, down, maxFails, failTimeout }] } */
function nginxUpstreams(text) {
  return nginxBlocks(text, 'upstream').map(b => {
    const servers = []; let method = 'round_robin';
    for (const stmt of upstreamStatements(b.text)) {
      const t = stmt + ';'; let m;
      if ((m = t.match(/^server\s+(\S+)([^;]*);/))) {
        const o = m[2];
        servers.push({ addr: m[1], weight: Number((o.match(/weight=(\d+)/) || [])[1]) || 1, backup: /\bbackup\b/.test(o), down: /\bdown\b/.test(o), maxFails: (o.match(/max_fails=(\d+)/) || [])[1] || null, failTimeout: (o.match(/fail_timeout=(\S+)/) || [])[1] || null });
      } else if (/^least_conn;/.test(t)) method = 'least_conn'; else if (/^ip_hash;/.test(t)) method = 'ip_hash'; else if (/^(hash|random)\b/.test(t)) method = t.replace(/;$/, '');
    }
    return { name: b.args, method, servers };
  });
}
function lbServers(list) {
  const servers = (list || []).map(x => ({ addr: String(x.addr || '').trim(), weight: Math.max(1, Math.min(100, Number(x.weight) || 1)), backup: !!x.backup, down: !!x.down, maxFails: x.maxFails ? String(Number(x.maxFails) || 1) : null, failTimeout: x.failTimeout && /^\d+[smh]?$/.test(x.failTimeout) ? x.failTimeout : null })).filter(x => x.addr);
  if (!servers.length) throw err('Keep at least one server');
  for (const s of servers) if (!TARGET_RE.test(s.addr) && !/^unix:\//.test(s.addr)) throw err(`Not host:port — ${s.addr}`);
  if (!servers.some(s => !s.backup && !s.down)) throw err('At least one server must take traffic (not backup, not down)');
  return servers;
}
/** Write the servers and method of nginx upstream `name`. */
function nginxSetUpstream(text, name, { method = 'round_robin', servers }) {
  const list = lbServers(servers);
  const b = nginxBlocks(text, 'upstream').find(x => x.args === name);
  if (!b) throw err(`upstream ${name} is not in this file`);
  if (method === 'ip_hash' && list.some(s => s.backup)) throw err('nginx does not allow backup servers with ip_hash');
  const ind = b.indent + '  ';
  const keep = upstreamStatements(b.text).filter(l => /^(keepalive|keepalive_timeout|keepalive_requests|zone|resolver|hash|random)\b/.test(l) && !(method !== 'round_robin' && /^(hash|random)\b/.test(l))).map(l => `${ind}${l};`);
  const lines = [`${b.indent}upstream ${name} {`, ...(LB.nginx[method] ? [ind + LB.nginx[method]] : []), ...keep,
    ...list.map(s => `${ind}server ${s.addr}${s.weight > 1 ? ` weight=${s.weight}` : ''}${s.maxFails ? ` max_fails=${s.maxFails}` : ''}${s.failTimeout ? ` fail_timeout=${s.failTimeout}` : ''}${s.backup ? ' backup' : ''}${s.down ? ' down' : ''};`), `${b.indent}}`];
  return text.slice(0, b.start) + lines.join('\n') + text.slice(b.end);
}
/** Make a single-target nginx site balanced: an upstream with the current target, proxy_pass pointed at it. */
function nginxMakeUpstream(text, domain) {
  const name = `dg_${slug(domain)}`;
  if (nginxBlocks(text, 'upstream').some(b => b.args === name)) return { text, name };
  const b = nginxBlocks(text, 'server').find(x => serverNames(x.text).includes(domain) && /proxy_pass\s+https?:\/\/[^$;]+;/.test(x.text));
  if (!b) throw err(`${domain} has no proxy_pass to a host:port in this file`);
  const target = b.text.match(/proxy_pass\s+(https?):\/\/([^/;$]+)[^;]*;/);
  let out = text;
  for (const sb of nginxBlocks(text, 'server').reverse()) if (serverNames(sb.text).includes(domain)) out = out.slice(0, sb.start) + sb.text.replace(new RegExp(`(proxy_pass\\s+${target[1]}://)${target[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `$1${name}`) + out.slice(sb.end);
  const at = nginxBlocks(out, 'server').find(x => serverNames(x.text).includes(domain)).start;
  out = out.slice(0, at) + `upstream ${name} {\n  server ${target[2]};\n}\n` + out.slice(at);
  return { text: out, name };
}

// ---------- Caddy ----------
const caddyBlock = (domain, body) => `# dockgate:begin ${domain}\n${body.trimEnd()}\n# dockgate:end ${domain}\n`;
function caddySite(input) {
  const s = siteInput(input);
  const addrs = s.names.map(n => s.https === 'none' ? `http://${n}` : n).join(', ');
  const rp = s.targets.length > 1 || s.lb !== 'round_robin' ? `  reverse_proxy ${s.targets.join(' ')} {\n    lb_policy ${LB.caddy[s.lb] || 'round_robin'}\n    health_uri /\n    fail_duration 30s\n  }` : `  reverse_proxy ${s.targets[0]}`;
  const body = `${addrs} {\n${s.maxBody ? `  request_body {\n    max_size ${s.maxBody.toUpperCase()}B\n  }\n` : ''}${s.path !== '/' ? `  handle_path ${s.path.replace(/\/$/, '')}/* {\n  ${rp.replace(/\n/g, '\n  ')}\n  }` : rp}\n}`;
  return caddyBlock(s.domain, body);
}
/** Append a site to a Caddyfile (it must not be there yet). */
function caddyAdd(text, input) {
  const s = siteInput(input);
  if (caddySiteRange(text, s.domain)) throw err(`${s.domain} is already in the Caddyfile`);
  return String(text || '').replace(/\s*$/, '\n\n') + caddySite(input);
}
/** The lines of the site block of `domain` (start / end line index, inclusive). */
function caddySiteRange(text, domain) {
  const lines = String(text || '').split('\n'); let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trim();
    if (depth === 0 && t.endsWith('{') && !t.startsWith('(')) {
      const addrs = t.slice(0, -1).split(/[\s,]+/).filter(Boolean).map(a => a.replace(/^https?:\/\//, '').replace(/:\d+$/, ''));
      let d = 0, j = i;
      for (; j < lines.length; j++) { const u = lines[j].replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''); d += (u.match(/\{/g) || []).length - (u.match(/\}/g) || []).length; if (d <= 0) break; }
      if (addrs.includes(domain)) return { start: i, end: j, lines };
      i = j; continue;
    }
    depth += (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length; if (depth < 0) depth = 0;
  }
  return null;
}
/** The reverse_proxy of a Caddy site → { targets, method } */
function caddyLb(text, domain) {
  const r = caddySiteRange(text, domain); if (!r) return null;
  const block = r.lines.slice(r.start, r.end + 1).join('\n');
  const m = block.match(/^\s*reverse_proxy\s+([^{\n]*)/m); if (!m) return null;
  const toks = m[1].trim().split(/\s+/).filter(t => t && !t.startsWith('/') && !t.startsWith('@'));
  return { targets: toks.map(t => t.replace(/^https?:\/\//, '')), method: ((block.match(/lb_policy\s+(\S+)/) || [])[1] || 'random').replace('round_robin', 'round_robin') };
}
/** Write the targets and lb_policy of the first reverse_proxy of a Caddy site. */
function caddySetLb(text, domain, { method = 'round_robin', servers }) {
  const list = lbServers(servers).filter(s => !s.down);
  const r = caddySiteRange(text, domain); if (!r) throw err(`${domain} is not in the Caddyfile`);
  const L = r.lines;
  const i = L.findIndex((l, k) => k >= r.start && k <= r.end && /^\s*reverse_proxy\b/.test(l)); if (i < 0) throw err(`${domain} has no reverse_proxy`);
  const ind = (L[i].match(/^\s*/) || [''])[0];
  const matcher = (L[i].match(/^\s*reverse_proxy\s+((?:\/|@)\S*)\s/) || [])[1];
  let j = i; if (/\{\s*$/.test(L[i])) { let d = 0; for (j = i; j <= r.end; j++) { d += (L[j].match(/\{/g) || []).length - (L[j].match(/\}/g) || []).length; if (d <= 0) break; } }
  const inner = j > i ? L.slice(i + 1, j).filter(l => !/^\s*(lb_policy|to)\b/.test(l)) : [];
  const nl = [`${ind}reverse_proxy ${matcher ? matcher + ' ' : ''}${list.map(s => s.addr).join(' ')} {`, `${ind}  lb_policy ${LB.caddy[method] || method}`, ...inner, `${ind}}`];
  if (list.length === 1 && !inner.length && method === 'round_robin') nl.splice(0, nl.length, `${ind}reverse_proxy ${matcher ? matcher + ' ' : ''}${list[0].addr}`);
  return [...L.slice(0, i), ...nl, ...L.slice(j + 1)].join('\n');
}

// ---------- HAProxy ----------
const haLine = (domain) => ` # dockgate:${domain}`;
function haproxyAdd(text, input) {
  const s = siteInput(input); const id = `dg_${slug(s.domain)}`;
  if (new RegExp(`^backend ${id}\\b`, 'm').test(text)) throw err(`${s.domain} is already in haproxy.cfg`);
  const lines = String(text || '').split('\n');
  // the frontend that takes plain HTTP (bind :80), else the first frontend
  let fi = -1, firstFront = -1;
  for (let i = 0; i < lines.length; i++) { if (/^(frontend|listen)\s/.test(lines[i])) { if (firstFront < 0) firstFront = i; let j = i + 1; for (; j < lines.length && !/^\S/.test(lines[j]); j++) if (/^\s*bind\s+\S*:(80|443)\b/.test(lines[j]) && fi < 0) fi = i; } }
  if (fi < 0) fi = firstFront; if (fi < 0) throw err('haproxy.cfg has no frontend to add the domain to');
  let end = fi + 1; while (end < lines.length && (!/^\S/.test(lines[end]) || /^#/.test(lines[end]))) end++;
  let at = end; for (let k = fi + 1; k < end; k++) if (/^\s*default_backend\b/.test(lines[k])) { at = k; break; }
  while (at > fi + 1 && !lines[at - 1].trim()) at--;
  const ins = [`  acl ${id}_host hdr(host),field(1,:) -i ${s.names.join(' ')}${haLine(s.domain)}`, `  use_backend ${id} if ${id}_host${haLine(s.domain)}`];
  lines.splice(at, 0, ...ins);
  const back = ['', `# dockgate:begin ${s.domain}`, `backend ${id}`, `  balance ${LB.haproxy[s.lb] || 'roundrobin'}`, '  option forwardfor', '  http-request set-header X-Forwarded-Proto https if { ssl_fc }',
    ...s.targets.map((t, k) => `  server s${k + 1} ${t} check`), `# dockgate:end ${s.domain}`];
  return lines.join('\n').replace(/\s*$/, '\n') + back.join('\n') + '\n';
}
function haproxyBackends(text) {
  const out = []; let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^(backend|listen)\s+(\S+)/); if (h) { cur = { name: h[2], method: 'round_robin', servers: [] }; out.push(cur); continue; }
    if (/^\S/.test(line) && !/^#/.test(line)) { cur = null; continue; }
    if (!cur) continue; const t = line.replace(/#.*$/, '').trim(); let m;
    if ((m = t.match(/^balance\s+(\S+)/))) cur.method = { roundrobin: 'round_robin', leastconn: 'least_conn', source: 'ip_hash' }[m[1]] || m[1];
    if ((m = t.match(/^server\s+(\S+)\s+(\S+)(.*)$/))) cur.servers.push({ name: m[1], addr: m[2], weight: Number((m[3].match(/weight\s+(\d+)/) || [])[1]) || 1, backup: /\bbackup\b/.test(m[3]), down: /\bdisabled\b/.test(m[3]) });
  }
  return out;
}
function haproxySetBackend(text, name, { method = 'round_robin', servers }) {
  const list = lbServers(servers);
  const lines = String(text || '').split('\n');
  const i = lines.findIndex(l => new RegExp(`^(backend|listen)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(l)); if (i < 0) throw err(`backend ${name} is not in haproxy.cfg`);
  let end = i + 1; while (end < lines.length && (!/^\S/.test(lines[end]) || /^#/.test(lines[end])) && !/^# dockgate:end/.test(lines[end])) end++;
  const body = lines.slice(i + 1, end); const keep = body.filter(l => !/^\s*(server|balance)\b/.test(l) && l.trim());
  const opts = (k) => (body.find(l => new RegExp(`^\\s*server\\s+\\S+\\s+${list[k] ? list[k].addr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '#'}\\b`).test(l)) || '').replace(/.*?\s\S+:\d+/, '').replace(/\b(weight\s+\d+|backup|disabled)\b/g, '').replace(/\s+/g, ' ').trim();
  const nb = [`  balance ${LB.haproxy[method] || method}`, ...keep, ...list.map((s, k) => `  server s${k + 1} ${s.addr} ${opts(k) || 'check'}${s.weight > 1 ? ` weight ${s.weight}` : ''}${s.backup ? ' backup' : ''}${s.down ? ' disabled' : ''}`.replace(/\s+$/, ''))];
  return [...lines.slice(0, i + 1), ...nb, ...lines.slice(end)].join('\n');
}

// ---------- Apache ----------
const APACHE_MODS = [['proxy_module', 'mod_proxy.so'], ['proxy_http_module', 'mod_proxy_http.so'], ['headers_module', 'mod_headers.so'], ['alias_module', 'mod_alias.so'], ['rewrite_module', 'mod_rewrite.so'],
  ['proxy_wstunnel_module', 'mod_proxy_wstunnel.so'], ['slotmem_shm_module', 'mod_slotmem_shm.so'], ['proxy_balancer_module', 'mod_proxy_balancer.so'], ['lbmethod_byrequests_module', 'mod_lbmethod_byrequests.so'],
  ['lbmethod_bybusyness_module', 'mod_lbmethod_bybusyness.so'], ['socache_shmcb_module', 'mod_socache_shmcb.so'], ['ssl_module', 'mod_ssl.so']];
/** Apache site. loadModules: the modules it needs, loaded if missing (the httpd image ships them off). */
function apacheSite(input, { certReady = true, loadModules = false } = {}) {
  const s = siteInput(input);
  const bal = s.targets.length > 1 ? `dg_${slug(s.domain)}` : null;
  const dest = bal ? `balancer://${bal}/` : `http://${s.targets[0]}/`;
  const proxy = (ind) => [`${ind}ProxyPreserveHost On`, `${ind}ProxyPass /.well-known/acme-challenge/ !`, `${ind}Alias /.well-known/acme-challenge/ ${ACME_ROOT}/.well-known/acme-challenge/`,
    ...(s.websocket && !bal ? [`${ind}RewriteEngine On`, `${ind}RewriteCond %{HTTP:Upgrade} =websocket [NC]`, `${ind}RewriteRule /(.*) ws://${s.targets[0]}/$1 [P,L]`] : []),
    `${ind}ProxyPass ${s.path} ${dest}`, `${ind}ProxyPassReverse ${s.path} ${dest}`, `${ind}RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}`];
  const out = [`${MARK} Site ${s.domain} → ${s.targets.join(', ')}.`];
  if (loadModules) out.push(...APACHE_MODS.map(([m, f]) => `<IfModule !${m}>\n  LoadModule ${m} modules/${f}\n</IfModule>`));
  if (bal) out.push(`<Proxy balancer://${bal}>`, ...s.targets.map(t => `  BalancerMember http://${t}`), `  ProxySet lbmethod=${s.lb === 'least_conn' ? 'bybusyness' : 'byrequests'}`, '</Proxy>');
  const names = [`  ServerName ${s.domain}`, ...(s.aliases.length ? [`  ServerAlias ${s.aliases.join(' ')}`] : [])];
  const tls = (s.https === 'letsencrypt' || s.https === 'existing') && certReady;
  out.push('<VirtualHost *:80>', ...names, `  <Directory ${ACME_ROOT}>`, '    Require all granted', '  </Directory>');
  if (tls && s.redirect) out.push(`  ProxyPass /.well-known/acme-challenge/ !`, `  Alias /.well-known/acme-challenge/ ${ACME_ROOT}/.well-known/acme-challenge/`, '  RedirectMatch 301 ^/(?!\\.well-known/acme-challenge/)(.*)$ https://' + s.domain + '/$1');
  else out.push(...proxy('  '));
  out.push('</VirtualHost>');
  if (tls) out.push('<VirtualHost *:443>', ...names, '  SSLEngine on', `  SSLCertificateFile ${s.certPath}`, `  SSLCertificateKeyFile ${s.keyPath}`, ...proxy('  '), '</VirtualHost>');
  return out.join('\n') + '\n';
}

// ---------- labels ----------
function traefikLabels(input, { entrypoints = [], resolver = null } = {}) {
  const s = siteInput(input); const id = `dg-${slug(s.domain).replace(/_/g, '-')}`;
  const rule = s.names.map(n => `Host(\`${n}\`)`).join(' || ') + (s.path !== '/' ? ` && PathPrefix(\`${s.path}\`)` : '');
  const port = s.targets[0].split(':').pop();
  const web = entrypoints.find(e => /^(web|http)$/i.test(e.name)) || entrypoints.find(e => e.port === 80);
  const sec = entrypoints.find(e => /^(websecure|https)$/i.test(e.name)) || entrypoints.find(e => e.port === 443);
  const tls = s.https !== 'none';
  const L = { 'traefik.enable': 'true', [`traefik.http.routers.${id}.rule`]: rule, [`traefik.http.services.${id}.loadbalancer.server.port`]: port, [`traefik.http.routers.${id}.service`]: id };
  if (tls) { if (sec) L[`traefik.http.routers.${id}.entrypoints`] = sec.name; L[`traefik.http.routers.${id}.tls`] = 'true'; if (resolver) L[`traefik.http.routers.${id}.tls.certresolver`] = resolver; }
  else if (web) L[`traefik.http.routers.${id}.entrypoints`] = web.name;
  if (tls && s.redirect && web) { L[`traefik.http.routers.${id}-http.rule`] = rule; L[`traefik.http.routers.${id}-http.entrypoints`] = web.name; L[`traefik.http.routers.${id}-http.middlewares`] = `${id}-https`; L[`traefik.http.middlewares.${id}-https.redirectscheme.scheme`] = 'https'; }
  return L;
}
function caddyLabels(input) {
  const s = siteInput(input); const port = s.targets[0].split(':').pop();
  return { caddy: s.names.map(n => s.https === 'none' ? `http://${n}` : n).join(', '), 'caddy.reverse_proxy': `{{upstreams ${port}}}` };
}
/** Labels as a Compose snippet and as docker run flags. */
function labelsText(service, labels) {
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return { compose: `services:\n  ${service}:\n    labels:\n${Object.entries(labels).map(([k, v]) => `      ${k}: ${q(v)}`).join('\n')}\n`, run: Object.entries(labels).map(([k, v]) => `--label '${k}=${v.replace(/'/g, `'\\''`)}'`).join(' \\\n  ') };
}

// ---------- removing what DockGate added ----------
function removeMarked(text, domain) {
  const esc = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = String(text || '');
  let out = before.replace(new RegExp(`\\n*# dockgate:begin ${esc}\\n[\\s\\S]*?# dockgate:end ${esc}\\n?`, 'g'), '\n');
  out = out.split('\n').filter(l => !l.endsWith(haLine(domain))).join('\n');
  return { text: out.replace(/\n{3,}/g, '\n\n'), changed: out !== before };
}
const isDockgateFile = (text) => String(text || '').startsWith(MARK);

module.exports = { APACHE_MODS, fmtBlock, MARK, ACME_ROOT, slug, siteInput, nginxSite, nginxBlocks, nginxEnsureAcme, nginxSetCert, nginxAddHttps, nginxUpstreams, nginxSetUpstream, nginxMakeUpstream,
  caddySite, caddyAdd, caddySiteRange, caddyLb, caddySetLb, haproxyAdd, haproxyBackends, haproxySetBackend, apacheSite, traefikLabels, caddyLabels, labelsText, removeMarked, isDockgateFile, lbServers };
