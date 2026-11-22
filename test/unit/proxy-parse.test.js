'use strict';
// Proxies & SSL (server/proxy-parse.js): reading nginx, Caddy, Traefik, HAProxy and Apache configs, access log
// lines and certificates into "which domain goes where".
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../../server/proxy-parse');

const NGINX_T = `nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# configuration file /etc/nginx/nginx.conf:
events {}
http {
  include /etc/nginx/conf.d/*.conf;
}
# configuration file /etc/nginx/conf.d/shop.conf:
upstream api_pool {
  server gitdemo-web-1:80;
  server blog-site-1:80 backup;
}
server {
  listen 80;
  server_name shop.example.test api.example.test;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  server_name shop.example.test;
  ssl_certificate /certs/shop.crt;
  location / { proxy_pass http://shop-site-web-1:80; }
}
server {
  listen 443 ssl;
  server_name api.example.test;
  ssl_certificate /certs/api.crt;
  location /v1/ { proxy_pass http://api_pool/; }
}
# configuration file /etc/nginx/conf.d/blog.conf:
server {
  listen 80;
  server_name old.example.test localhost;
  location / { proxy_pass http://127.0.0.1:8081; }
}
`;

test('isDomain: names yes, IPs and bare words no', () => {
  assert.ok(P.isDomain('shop.example.test'));
  assert.ok(P.isDomain('*.example.com'));
  assert.ok(!P.isDomain('10.0.0.1'));
  assert.ok(!P.isDomain('localhost'));
  assert.ok(!P.isDomain('_'));
});

test('nginx -T: files, servers, upstreams and one site per domain', () => {
  const parsed = P.parseNginxT(NGINX_T);
  assert.deepEqual(parsed.files.map(f => f.path), ['/etc/nginx/nginx.conf', '/etc/nginx/conf.d/shop.conf', '/etc/nginx/conf.d/blog.conf']);
  assert.deepEqual(parsed.upstreams.api_pool, ['gitdemo-web-1:80', 'blog-site-1:80']);
  const sites = P.nginxSites(parsed);
  const shop = sites.find(s => s.domain === 'shop.example.test');
  assert.equal(shop.https, true); assert.equal(shop.redirect, true);
  assert.equal(shop.cert, '/certs/shop.crt');
  assert.deepEqual(shop.targets, ['shop-site-web-1:80']);
  assert.match(shop.file, /shop\.conf$/);
  const api = sites.find(s => s.domain === 'api.example.test');
  assert.deepEqual(api.targets, ['gitdemo-web-1:80', 'blog-site-1:80']);
  const old = sites.find(s => s.domain === 'old.example.test');
  assert.equal(old.https, false); assert.deepEqual(old.targets, ['127.0.0.1:8081']);
});

test('nginx files read directly (the check failed) parse the same way', () => {
  const direct = NGINX_T.split('\n').slice(1).join('\n'); // no "syntax is ok" line
  assert.equal(P.nginxSites(P.parseNginxT(direct)).filter(s => P.isDomain(s.domain)).length, 3);
});

test('upstreamOf: URL, upstream name, unix socket, nothing', () => {
  assert.deepEqual(P.upstreamOf('http://app:3000/x'), ['app:3000']);
  assert.deepEqual(P.upstreamOf('http://pool', { pool: ['a:1', 'b:1'] }), ['a:1', 'b:1']);
  assert.deepEqual(P.upstreamOf('http://unix:/run/app.sock'), ['unix']);
  assert.deepEqual(P.upstreamOf(null), []);
});

test('Caddyfile: reverse_proxy, root, http:// sites, snippets and globals skipped', () => {
  const sites = P.parseCaddyfile(`{
  email admin@example.test
}
(common) {
  encode gzip
}
grafana.example.test {
  import common
  reverse_proxy gitdemo-web-1:80
}
http://files.example.test, www.files.example.test {
  root * /srv
  file_server
}
api.example.test {
  reverse_proxy /api/* a:1 b:1 {
    lb_policy round_robin
  }
}`);
  const g = sites.find(s => s.domain === 'grafana.example.test');
  assert.deepEqual(g.targets, ['gitdemo-web-1:80']); assert.equal(g.https, true);
  const f = sites.find(s => s.domain === 'files.example.test');
  assert.equal(f.https, false); assert.equal(f.root, '/srv');
  assert.ok(sites.find(s => s.domain === 'www.files.example.test'));
  assert.deepEqual(sites.find(s => s.domain === 'api.example.test').targets, ['a:1', 'b:1']);
});

test('Traefik labels: hosts, port, TLS and resolver; traefik.enable=false hides', () => {
  const labels = {
    'traefik.enable': 'true',
    'traefik.http.routers.web.rule': 'Host(`status.example.test`) || Host(`www.status.example.test`)',
    'traefik.http.routers.web.tls.certresolver': 'le',
    'traefik.http.services.web.loadbalancer.server.port': '8080',
    'traefik.http.routers.web.service': 'web',
  };
  const s = P.traefikSites(labels);
  assert.deepEqual(s.map(x => x.domain), ['status.example.test', 'www.status.example.test']);
  assert.equal(s[0].port, '8080'); assert.equal(s[0].tls, true); assert.equal(s[0].resolver, 'le');
  assert.deepEqual(P.traefikSites({ ...labels, 'traefik.enable': 'false' }), []);
});

test('caddy-docker-proxy labels', () => {
  assert.deepEqual(P.caddyLabelSites({ caddy: 'app.example.test', 'caddy.reverse_proxy': '{{upstreams 3000}}' }), [{ domain: 'app.example.test', port: '3000' }]);
});

test('HAProxy: host ACLs → backends', () => {
  const s = P.parseHaproxy(`frontend web
  bind *:443 ssl crt /etc/ssl/site.pem
  acl is_shop hdr(host) -i shop.example.test
  use_backend shop if is_shop
  default_backend shop
backend shop
  server s1 10.0.0.5:80 check
  server s2 10.0.0.6:80 check`);
  assert.deepEqual(s, [{ domain: 'shop.example.test', targets: ['10.0.0.5:80', '10.0.0.6:80'], backend: 'shop', https: true, line: 1 }]);
});

test('apachectl -S: name vhosts and aliases', () => {
  const s = P.parseApacheS(`VirtualHost configuration:
*:443                  is a NameVirtualHost
         default server site.example.test (/etc/apache2/sites-enabled/site.conf:2)
         port 443 namevhost site.example.test (/etc/apache2/sites-enabled/site.conf:2)
                 alias www.site.example.test`);
  assert.deepEqual(s.map(x => [x.domain, x.port]), [['site.example.test', 443], ['www.site.example.test', 443]]);
});

test('access log lines: combined, with host first, Caddy JSON, junk', () => {
  const a = P.parseAccessLine('203.0.113.9 - - [21/Nov/2026:10:00:00 +0000] "GET /cart HTTP/1.1" 502 157 "-" "curl/8"');
  assert.equal(a.ip, '203.0.113.9'); assert.equal(a.status, 502); assert.equal(a.path, '/cart'); assert.equal(a.bytes, 157);
  const b = P.parseAccessLine('shop.example.test 203.0.113.9 - - [21/Nov/2026:10:00:00 +0000] "POST /pay HTTP/2.0" 200 - "-" "x" 0.120');
  assert.equal(b.host, 'shop.example.test'); assert.equal(b.ip, '203.0.113.9'); assert.equal(b.bytes, 0); assert.equal(b.ms, 120);
  const c = P.parseCaddyJsonLine(JSON.stringify({ ts: 1795000000, request: { remote_ip: '198.51.100.2', host: 'files.example.test', method: 'GET', uri: '/' }, status: 404, size: 9, duration: 0.004 }));
  assert.equal(c.status, 404); assert.equal(c.host, 'files.example.test'); assert.equal(c.ms, 4);
  assert.equal(P.parseAccessLine('2026/11/21 [error] something'), null);
  assert.equal(P.parseCaddyJsonLine('{"level":"info"}'), null);
});

test('certificates: a real self-signed PEM, names from SAN, days left; Traefik acme.json', (t) => {
  let pem;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=blog.example.test',
      '-addext', 'subjectAltName=DNS:blog.example.test,DNS:www.blog.example.test', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    pem = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  } catch (e) { t.skip('openssl not available'); return; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const c = P.parseCertPem('junk before\n' + pem);
  assert.deepEqual(c.names, ['blog.example.test', 'www.blog.example.test']);
  assert.equal(c.selfSigned, true);
  assert.ok(c.daysLeft >= 28 && c.daysLeft <= 30, String(c.daysLeft));
  assert.match(c.fingerprint, /^[0-9A-F:]+$/);
  assert.equal(P.parseCertPem('no cert here'), null);
  const acme = P.traefikAcme(JSON.stringify({ le: { Certificates: [{ domain: { main: 'blog.example.test' }, certificate: Buffer.from(pem).toString('base64') }] } }));
  assert.equal(acme.length, 1); assert.equal(acme[0].resolver, 'le'); assert.equal(P.parseCertPem(acme[0].pem).names[0], 'blog.example.test');
  assert.deepEqual(P.traefikAcme('not json'), []);
});

test('kindOf: which images are proxies', () => {
  const { kindOf } = require('../../server/proxies');
  assert.equal(kindOf('nginx:1.27-alpine'), 'nginx');
  assert.equal(kindOf('jc21/nginx-proxy-manager:latest'), 'npm');
  assert.equal(kindOf('nginxproxy/nginx-proxy'), 'nginx-proxy');
  assert.equal(kindOf('caddy:2-alpine'), 'caddy');
  assert.equal(kindOf('lucaslorentz/caddy-docker-proxy:ci-alpine'), 'caddy-docker-proxy');
  assert.equal(kindOf('traefik:v3.1'), 'traefik');
  assert.equal(kindOf('haproxy:2.9'), 'haproxy');
  assert.equal(kindOf('httpd:2.4'), 'apache');
  assert.equal(kindOf('postgres:16'), null);
});

test('who renews a certificate, and which issuers are internal or for tests', () => {
  const PXm = require('../../server/proxies');
  assert.equal(PXm.isInternalIssuer('Caddy Local Authority - ECC Intermediate'), true);
  assert.equal(PXm.isInternalIssuer("Let's Encrypt R11"), false);
  assert.equal(PXm.isStagingIssuer('(STAGING) Ersatz Edamame E1'), true);
  assert.equal(PXm.isStagingIssuer("Let's Encrypt E6"), false);
});
