'use strict';
// Proxies & SSL — what DockGate writes into proxy configs (server/proxy-gen.js) and the access-log stats
// (server/proxy-edit.js accessStats): new sites, the ACME challenge, HTTPS, load balancing, removal.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../server/proxy-gen');
const P = require('../../server/proxy-parse');

const ONE_LINE = `server { listen 80; server_name shop.example.test api.example.test; return 301 https://$host$request_uri; }
server {
    listen 443 ssl;
    server_name shop.example.test;
    ssl_certificate     /etc/nginx/certs/shop.crt;
    ssl_certificate_key /etc/nginx/certs/shop.key;
    location / { proxy_pass http://shop-site-web-1:80; }
}
upstream api_pool { server gitdemo-web-1:80; server blog-site-1:80 backup; keepalive 8; }
server {
    listen 443 ssl;
    server_name api.example.test;
    location /v1/ { proxy_pass http://api_pool/; }
}
`;
const sitesOf = (text) => P.nginxSites(P.parseNginxT(`# configuration file /x.conf:\n${text}`));

test('siteInput checks names, targets, ports and limits', () => {
  assert.throws(() => G.siteInput({ domain: 'not a domain', targets: ['a:80'] }), /Not a domain/);
  assert.throws(() => G.siteInput({ domain: 'a.example.com', targets: [] }), /Choose the container/);
  assert.throws(() => G.siteInput({ domain: 'a.example.com', targets: ['a:99999'] }), /Bad port/);
  assert.throws(() => G.siteInput({ domain: 'a.example.com', targets: ['a b:80'] }), /host:port/);
  assert.throws(() => G.siteInput({ domain: 'a.example.com', targets: ['a:80'], maxBody: '1tb' }), /Upload limit/);
  const s = G.siteInput({ domain: 'A.Example.com', aliases: 'www.a.example.com, a.example.com', targets: ['app:3000'] });
  assert.equal(s.domain, 'a.example.com'); assert.deepEqual(s.aliases, ['www.a.example.com']);
});

test('nginx site: HTTP only, then HTTPS with redirect; the parser reads it back', () => {
  const http = G.nginxSite({ domain: 'app.example.com', targets: ['app:3000'], https: 'letsencrypt', certPath: '/c/f.pem', keyPath: '/c/k.pem', dockerDns: true }, { certReady: false });
  assert.ok(G.isDockgateFile(http));
  assert.match(http, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.match(http, /resolver 127\.0\.0\.11/); assert.match(http, /set \$dg_upstream http:\/\/app:3000;/);
  assert.doesNotMatch(http, /listen 443/); assert.doesNotMatch(http, /\[::\]/);
  const full = G.nginxSite({ domain: 'app.example.com', aliases: ['www.app.example.com'], targets: ['app:3000'], https: 'letsencrypt', certPath: '/c/f.pem', keyPath: '/c/k.pem', websocket: true, maxBody: '50m' });
  const s = sitesOf(full).find(x => x.domain === 'app.example.com');
  assert.equal(s.https, true); assert.equal(s.redirect, true); assert.equal(s.cert, '/c/f.pem'); assert.deepEqual(s.targets, ['app:3000']);
  assert.match(full, /Upgrade \$http_upgrade/); assert.match(full, /client_max_body_size 50m/);
  assert.ok(sitesOf(full).some(x => x.domain === 'www.app.example.com'));
  assert.throws(() => G.nginxSite({ domain: 'a.example.com', targets: ['a:1'], https: 'existing' }), /No certificate/);
});

test('nginx site with several containers: an upstream with the method', () => {
  const t = G.nginxSite({ domain: 'lb.example.com', targets: ['a:80', 'b:80'], lb: 'least_conn' });
  const up = G.nginxUpstreams(t)[0];
  assert.equal(up.name, 'dg_lb_example_com'); assert.equal(up.method, 'least_conn'); assert.deepEqual(up.servers.map(x => x.addr), ['a:80', 'b:80']);
  assert.match(t, /proxy_pass http:\/\/dg_lb_example_com;/);
});

test('fmtBlock writes one statement per line', () => {
  assert.equal(G.fmtBlock('server { listen 80; location / { return 301 "a;b"; } }'), 'server {\n  listen 80;\n  location / {\n    return 301 "a;b";\n  }\n}');
});

test('ACME challenge: added to the HTTP server, a server-level return moves into location /', () => {
  const a = G.nginxEnsureAcme(ONE_LINE, 'shop.example.test');
  assert.equal(a.changed, true);
  const http = G.nginxBlocks(a.text, 'server')[0].text;
  assert.match(http, /location \^~ \/\.well-known\/acme-challenge\/ \{\n\s+root \/var\/lib\/dockgate-acme;/);
  assert.match(http, /location \/ \{\n\s+return 301 https:\/\/\$host\$request_uri;\n\s+\}/);
  assert.doesNotMatch(http.replace(/location \/ \{[\s\S]*?\}/, ''), /^\s*return 301/m);
  assert.equal(G.nginxEnsureAcme(a.text, 'shop.example.test').changed, false); // once
  assert.ok(a.text.includes('upstream api_pool')); // the rest of the file stays
  // an HTTPS-only site gets an HTTP server that answers the check and sends the rest to https
  const only = G.nginxEnsureAcme('server { listen 443 ssl; server_name x.example.com www.x.example.com; }', 'x.example.com');
  assert.equal(only.added, true);
  const http2 = G.nginxBlocks(only.text, 'server')[1].text;
  assert.match(http2, /listen 80;/); assert.match(http2, /server_name x\.example\.com www\.x\.example\.com;/); assert.match(http2, /acme-challenge/); assert.match(http2, /return 301 https/);
  assert.deepEqual(G.nginxCertNames(only.text, 'x.example.com'), ['x.example.com', 'www.x.example.com']);
  assert.throws(() => G.nginxEnsureAcme('server { listen 80; server_name y.example.com; }', 'x.example.com'), /not in this file/);
});

test('HTTPS for an HTTP-only site; certificate paths swapped on a TLS site', () => {
  const src = 'server {\n  listen 80;\n  server_name old.example.test;\n  location / { proxy_pass http://127.0.0.1:8081; }\n}\n';
  const h = G.nginxAddHttps(src, 'old.example.test', '/c/f.pem', '/c/k.pem');
  const s = sitesOf(h.text).find(x => x.domain === 'old.example.test');
  assert.equal(s.https, true); assert.equal(s.redirect, true); assert.equal(s.cert, '/c/f.pem'); assert.deepEqual(s.targets, ['127.0.0.1:8081']);
  const c = G.nginxSetCert(ONE_LINE, 'shop.example.test', '/n/f.pem', '/n/k.pem');
  assert.equal(c.changed, 1);
  assert.equal(sitesOf(c.text).find(x => x.domain === 'shop.example.test').cert, '/n/f.pem');
  assert.ok(c.text.includes('ssl_certificate_key /n/k.pem;'));
});

test('nginx upstream: one-line blocks are read and rewritten without losing servers or keepalive', () => {
  const up = G.nginxUpstreams(ONE_LINE).find(u => u.name === 'api_pool');
  assert.deepEqual(up.servers.map(s => [s.addr, s.backup]), [['gitdemo-web-1:80', false], ['blog-site-1:80', true]]);
  const t = G.nginxSetUpstream(ONE_LINE, 'api_pool', { method: 'least_conn', servers: [...up.servers, { addr: 'c:80', weight: 3 }] });
  const up2 = G.nginxUpstreams(t).find(u => u.name === 'api_pool');
  assert.equal(up2.method, 'least_conn'); assert.deepEqual(up2.servers.map(s => s.addr), ['gitdemo-web-1:80', 'blog-site-1:80', 'c:80']); assert.equal(up2.servers[2].weight, 3);
  assert.match(t, /keepalive 8;/);
  assert.throws(() => G.nginxSetUpstream(ONE_LINE, 'api_pool', { servers: [{ addr: 'a:1', backup: true }] }), /must take traffic/);
  assert.throws(() => G.nginxSetUpstream(ONE_LINE, 'api_pool', { method: 'ip_hash', servers: [{ addr: 'a:1' }, { addr: 'b:1', backup: true }] }), /ip_hash/);
});

test('a single-target site becomes balanced: upstream made, proxy_pass pointed at it', () => {
  const r = G.nginxMakeUpstream(ONE_LINE, 'shop.example.test');
  assert.equal(r.name, 'dg_shop_example_test');
  assert.match(r.text, /upstream dg_shop_example_test \{\n  server shop-site-web-1:80;\n\}/);
  assert.match(r.text, /proxy_pass http:\/\/dg_shop_example_test;/);
  assert.deepEqual(sitesOf(r.text).find(x => x.domain === 'shop.example.test').targets, ['shop-site-web-1:80']);
});

test('Caddy: add a site, read and change its balancing, remove it', () => {
  const base = '{\n  email a@example.test\n}\ngrafana.example.test {\n  reverse_proxy grafana:3000\n}\n';
  let t = G.caddyAdd(base, { domain: 'app.example.test', targets: ['a:80', 'b:80'], lb: 'least_conn', https: 'auto' });
  assert.ok(P.parseCaddyfile(t).some(s => s.domain === 'app.example.test'));
  assert.deepEqual(G.caddyLb(t, 'app.example.test'), { targets: ['a:80', 'b:80'], method: 'least_conn' });
  assert.throws(() => G.caddyAdd(t, { domain: 'app.example.test', targets: ['a:80'] }), /already/);
  t = G.caddySetLb(t, 'app.example.test', { method: 'first', servers: [{ addr: 'a:80' }, { addr: 'c:80' }] });
  assert.deepEqual(G.caddyLb(t, 'app.example.test'), { targets: ['a:80', 'c:80'], method: 'first' });
  assert.match(t, /health_uri \//); // the rest of the block stays
  t = G.caddySetLb(t, 'grafana.example.test', { method: 'round_robin', servers: [{ addr: 'grafana:3000' }, { addr: 'grafana2:3000' }] });
  assert.deepEqual(G.caddyLb(t, 'grafana.example.test').targets, ['grafana:3000', 'grafana2:3000']);
  const r = G.removeMarked(t, 'app.example.test');
  assert.equal(r.changed, true); assert.ok(!r.text.includes('app.example.test')); assert.ok(r.text.includes('grafana.example.test'));
  assert.equal(G.removeMarked(r.text, 'grafana.example.test').changed, false); // not DockGate's
  assert.match(G.caddySite({ domain: 'p.example.test', targets: ['a:1'], https: 'none' }), /^# dockgate:begin p\.example\.test\nhttp:\/\/p\.example\.test \{/);
});

test('HAProxy: add a domain to the HTTP frontend, read it back, change the backend, remove it', () => {
  const cfg = 'global\n  log stdout local0\ndefaults\n  mode http\nfrontend web\n  bind *:80\n  acl is_shop hdr(host) -i shop.example.test\n  use_backend shop if is_shop\n  default_backend shop\nbackend shop\n  server s1 shop:80 check\n';
  let t = G.haproxyAdd(cfg, { domain: 'app.example.test', aliases: 'www.app.example.test', targets: ['a:80', 'b:80'], lb: 'least_conn' });
  const sites = P.parseHaproxy(t);
  assert.deepEqual(sites.find(s => s.domain === 'app.example.test').targets, ['a:80', 'b:80']);
  assert.ok(sites.some(s => s.domain === 'www.app.example.test'));
  assert.ok(t.indexOf('use_backend dg_app_example_test') < t.indexOf('default_backend shop')); // before the default
  let b = G.haproxyBackends(t).find(x => x.name === 'dg_app_example_test');
  assert.equal(b.method, 'least_conn');
  t = G.haproxySetBackend(t, 'dg_app_example_test', { method: 'round_robin', servers: [b.servers[0], { ...b.servers[1], backup: true }, { addr: 'c:80', weight: 2 }] });
  b = G.haproxyBackends(t).find(x => x.name === 'dg_app_example_test');
  assert.deepEqual(b.servers.map(s => [s.addr, s.backup, s.weight]), [['a:80', false, 1], ['b:80', true, 1], ['c:80', false, 2]]);
  assert.match(t, /option forwardfor/);
  const r = G.removeMarked(t, 'app.example.test');
  assert.equal(r.text.trim(), cfg.trim());
});

test('Apache site, Traefik and caddy-docker-proxy labels', () => {
  const a = G.apacheSite({ domain: 'ap.example.test', targets: ['app:80', 'app2:80'], https: 'letsencrypt', certPath: '/c/f.pem', keyPath: '/c/k.pem' }, { loadModules: true });
  assert.match(a, /<Proxy balancer:\/\/dg_ap_example_test>/); assert.match(a, /SSLCertificateFile \/c\/f\.pem/); assert.match(a, /LoadModule proxy_module modules\/mod_proxy\.so/);
  assert.match(a, /RedirectMatch 301 \^\/\(\?!\\\.well-known/);
  const L = G.traefikLabels({ domain: 'tr.example.test', targets: ['web:8080'], https: 'auto' }, { entrypoints: [{ name: 'web', port: 80 }, { name: 'websecure', port: 443 }], resolver: 'le' });
  assert.equal(L['traefik.http.routers.dg-tr-example-test.rule'], 'Host(`tr.example.test`)');
  assert.equal(L['traefik.http.routers.dg-tr-example-test.tls.certresolver'], 'le');
  assert.equal(L['traefik.http.routers.dg-tr-example-test.entrypoints'], 'websecure');
  assert.equal(L['traefik.http.services.dg-tr-example-test.loadbalancer.server.port'], '8080');
  assert.deepEqual(P.traefikSites(L).map(s => s.domain), ['tr.example.test', 'tr.example.test']); // router + its http redirect
  const txt = G.labelsText('web', L);
  assert.match(txt.compose, /traefik\.enable: "true"/); assert.match(txt.run, /--label 'traefik\.enable=true'/);
  assert.deepEqual(G.caddyLabels({ domain: 'c.example.test', targets: ['x:3000'], https: 'auto' }), { caddy: 'c.example.test', 'caddy.reverse_proxy': '{{upstreams 3000}}' });
});

test('access-log stats: classes, timeline, slow requests, top lists', () => {
  const { accessStats, logTime } = require('../../server/proxy-edit');
  assert.equal(new Date(logTime('21/Nov/2026:10:00:30 +0200')).toISOString(), '2026-11-21T08:00:30.000Z');
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`10.0.0.${i % 3} - - [21/Nov/2026:10:0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')} +0000] "GET /p${i % 2} HTTP/1.1" ${i % 10 === 0 ? 502 : i % 7 === 0 ? 404 : 200} 10 "-" "x" 0.0${i % 9 + 1}`);
  const s = accessStats(lines.map(l => P.parseAccessLine(l)));
  assert.equal(s.requests, 30);
  assert.equal(s.classes.find(c => c.cls === '5xx').count, 3);
  assert.equal(s.timeline.length, 3); assert.equal(s.timeline[0].n, 10);
  assert.ok(s.ms.p95 >= s.ms.p50); assert.equal(s.paths.length, 2);
  assert.equal(s.errors[0].key, '502 /p0');
  assert.equal(accessStats([{ line: 'junk' }]), null);
});

test('nothing a user types can add nginx directives', () => {
  assert.throws(() => G.nginxSite({ domain: 'a.example.com', targets: ['a:1'], https: 'existing', certPath: '/c/f.pem; include /etc/passwd', keyPath: '/c/k.pem' }), /Not a file path/);
  assert.throws(() => G.nginxSite({ domain: 'a.example.com', targets: ['a:1'], https: 'existing', certPath: '/c/../../etc/shadow', keyPath: '/c/k.pem' }), /Not a file path/);
  assert.throws(() => G.nginxSite({ domain: 'a.example.com', targets: ['a:1'], path: '/x { return 200; }' }), /Not a URL path/);
  assert.throws(() => G.siteInput({ domain: 'a.example.com;', targets: ['a:1'] }), /Not a domain/);
  assert.throws(() => G.siteInput({ domain: 'a.example.com', targets: ['a:1;'] }), /host:port/);
  assert.throws(() => G.nginxSetUpstream(ONE_LINE, 'api_pool', { servers: [{ addr: 'x:1; return 200' }] }), /host:port/);
});

test('a DockGate single-container site is read back with its target, and can be balanced', () => {
  const t = G.nginxSite({ domain: 'one.example.test', targets: ['app:80'], dockerDns: true });
  assert.deepEqual(sitesOf(t).find(x => x.domain === 'one.example.test').targets, ['app:80']);
  const r = G.nginxMakeUpstream(t, 'one.example.test');
  assert.match(r.text, /proxy_pass http:\/\/dg_one_example_test;/); assert.doesNotMatch(r.text, /\$dg_upstream/);
  assert.deepEqual(sitesOf(r.text).find(x => x.domain === 'one.example.test').targets, ['app:80']);
});

test('Apache existing site: challenge lines, HTTPS copy without them, certificate names', () => {
  const a = '<VirtualHost *:80>\n  ServerName ap.example.test\n  ServerAlias www.ap.example.test *.wild.example.test\n  ProxyPass / http://app:80/\n</VirtualHost>\n';
  const e1 = G.apacheEnsureAcme(a, 'ap.example.test');
  assert.equal(e1.changed, true);
  assert.ok(e1.text.indexOf('ProxyPass /.well-known/acme-challenge/ !') < e1.text.indexOf('ProxyPass / http://app:80/'), 'the exclusion comes before ProxyPass /');
  assert.equal(G.apacheEnsureAcme(e1.text, 'ap.example.test').changed, false);
  const h = G.apacheSetHttps(e1.text, 'ap.example.test', '/c/f.pem', '/c/k.pem').text;
  const tls = G.apacheVhosts(h).find(v => v.ssl);
  assert.match(tls.text, /<VirtualHost \*:443>/); assert.match(tls.text, /SSLCertificateFile \/c\/f\.pem/); assert.doesNotMatch(tls.text, /acme|Directory/);
  const h2 = G.apacheSetHttps(h, 'ap.example.test', '/n/f.pem', '/n/k.pem').text; // the existing *:443 is changed, not copied again
  assert.equal(G.apacheVhosts(h2).filter(v => v.ssl).length, 1); assert.match(h2, /SSLCertificateFile \/n\/f\.pem/);
  assert.deepEqual(G.apacheCertNames(a, 'ap.example.test'), ['ap.example.test', 'www.ap.example.test']);
  assert.throws(() => G.apacheEnsureAcme('<VirtualHost *:443>\n  ServerName x.example.test\n  SSLEngine on\n</VirtualHost>', 'x.example.test'), /No HTTP/);
});

test('site settings form (nginx): names, target, WebSockets, upload limit, redirect — shared servers keep the other names', () => {
  const st = G.nginxSiteSettings(ONE_LINE, 'shop.example.test');
  assert.deepEqual(st, { names: ['shop.example.test'], target: 'shop-site-web-1:80', upstream: null, websocket: false, maxBody: '', https: true, http: true, redirect: true });
  const t = G.nginxApplySettings(ONE_LINE, 'shop.example.test', { names: 'shop.example.test www.shop.example.test', target: 'app:8080', websocket: true, maxBody: '20m' });
  const st2 = G.nginxSiteSettings(t, 'shop.example.test');
  assert.deepEqual([st2.names, st2.target, st2.websocket, st2.maxBody], [['shop.example.test', 'www.shop.example.test'], 'app:8080', true, '20m']);
  assert.match(G.nginxBlocks(t, 'server')[0].text, /server_name shop\.example\.test api\.example\.test www\.shop\.example\.test;/, 'api keeps its place in the shared HTTP server');
  assert.deepEqual(G.nginxSiteSettings(t, 'api.example.test').upstream, 'api_pool');
  assert.throws(() => G.nginxApplySettings(ONE_LINE, 'shop.example.test', { redirect: false }), /shared with api\.example\.test/);
  const solo = 'server {\n  listen 80;\n  server_name a.example.test;\n  return 301 https://$host$request_uri;\n}\nserver {\n  listen 443 ssl;\n  server_name a.example.test;\n  location / {\n    proxy_pass http://app:80;\n  }\n}\n';
  const off = G.nginxApplySettings(solo, 'a.example.test', { redirect: false });
  assert.equal(G.nginxSiteSettings(off, 'a.example.test').redirect, false);
  assert.match(G.nginxBlocks(off, 'server')[0].text, /proxy_pass http:\/\/app:80;/);
  assert.equal(G.nginxSiteSettings(G.nginxApplySettings(off, 'a.example.test', { redirect: true }), 'a.example.test').redirect, true);
  assert.equal(G.nginxSiteSettings(G.nginxApplySettings(t, 'shop.example.test', { websocket: false, maxBody: '' }), 'shop.example.test').websocket, false);
  assert.throws(() => G.nginxApplySettings(ONE_LINE, 'shop.example.test', { target: 'x:1; return 200' }), /host:port/);
  assert.throws(() => G.nginxApplySettings(ONE_LINE, 'shop.example.test', { names: 'bad;name' }), /Not a domain/);
});

test('site settings form (Caddy): names and the single target', () => {
  const c = 'grafana.example.test {\n  tls internal\n  reverse_proxy gitdemo-web-1:80\n}\n';
  assert.deepEqual(G.caddySiteSettings(c, 'grafana.example.test'), { names: ['grafana.example.test'], plainHttp: false, target: 'gitdemo-web-1:80', upstream: null });
  const t = G.caddyApplySettings(c, 'grafana.example.test', { names: 'grafana.example.test g.example.test', target: 'app:3000' });
  assert.equal(t, 'grafana.example.test, g.example.test {\n  tls internal\n  reverse_proxy app:3000\n}\n');
});
