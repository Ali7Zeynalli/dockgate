'use strict';
// Proxies & SSL — finding proxies the way servers really run them: images built FROM a proxy image (compose
// `build:`), Caddy `import`s, Traefik's file provider, log files named in the config, and the local host.
const test = require('node:test');
const assert = require('node:assert/strict');
const PX = require('../../server/proxies');
const P = require('../../server/proxy-parse');
const LH = require('../../server/local-host');

test('kindOfConfig: images built FROM a proxy image keep its env / command', () => {
  assert.equal(PX.kindOfConfig({ Env: ['PATH=/bin', 'NGINX_VERSION=1.27.5'], Cmd: ['nginx', '-g', 'daemon off;'] }), 'nginx');
  assert.equal(PX.kindOfConfig({ Env: ['CADDY_VERSION=v2.8.4'] }), 'caddy');
  assert.equal(PX.kindOfConfig({ Env: ['HAPROXY_VERSION=2.9.1'] }), 'haproxy');
  assert.equal(PX.kindOfConfig({ Env: ['HTTPD_VERSION=2.4.62'], Cmd: ['httpd-foreground'] }), 'apache');
  assert.equal(PX.kindOfConfig({ Cmd: ['apache2-foreground'] }), 'apache');
  assert.equal(PX.kindOfConfig({ Entrypoint: ['/entrypoint.sh'], Cmd: ['traefik'] }), 'traefik');
  assert.equal(PX.kindOfConfig({ Env: ['NODE_VERSION=22'], Cmd: ['node', 'server.js'] }), null);
  assert.equal(PX.kindOfConfig({}), null);
  assert.equal(PX.kindOf('webshop-proxy'), null, 'the name alone says nothing — the image config does');
});

test('caddyImports: files and globs relative to the Caddyfile, not snippets', () => {
  assert.deepEqual(P.caddyImports('(common) {\n  encode gzip\n}\nimport common\nimport sites/*.caddy\nimport /srv/extra.caddy\nimport sites/*.caddy\n', '/etc/caddy'), ['/etc/caddy/sites/*.caddy', '/srv/extra.caddy']);
});

test('traefikFileSites: YAML and TOML routers with their services and TLS', () => {
  const yml = 'http:\n  routers:\n    shop:\n      rule: "Host(`shop.example.com`) || Host(`www.shop.example.com`)"\n      service: shop-svc\n      tls:\n        certResolver: le\n    api:\n      rule: "Host(`api.example.com`)"\n      service: api@docker\n  services:\n    shop-svc:\n      loadBalancer:\n        servers:\n          - url: "http://shop-web:8080"\n';
  const y = P.traefikFileSites(yml);
  assert.deepEqual(y.map(s => [s.domain, s.router, s.tls, s.targets.join(',')]), [['shop.example.com', 'shop', true, 'shop-web:8080'], ['www.shop.example.com', 'shop', true, 'shop-web:8080'], ['api.example.com', 'api', false, '']]);
  const toml = '[http.routers.blog]\n  rule = "Host(`blog.example.com`)"\n  service = "blog"\n  [http.routers.blog.tls]\n[http.services.blog.loadBalancer]\n  [[http.services.blog.loadBalancer.servers]]\n    url = "http://blog:80/"\n';
  assert.deepEqual(P.traefikFileSites(toml).map(s => [s.domain, s.tls, s.targets.join(',')]), [['blog.example.com', true, 'blog:80']]);
});

test('logPaths: the files the config names, not the console or variables', () => {
  const raw = { files: { n: [{ path: '/etc/nginx/nginx.conf', text: 'http {\n  access_log /var/log/nginx/access.log main;\n  error_log stderr;\n  server { listen 80; server_name a.test; access_log /var/log/nginx/a.log; }\n  server { access_log /dev/stdout; access_log off; access_log /var/log/nginx/$host.log; access_log logs/rel.log; }\n}' }],
    a: [{ path: '/etc/apache2/sites-enabled/x.conf', text: 'CustomLog ${APACHE_LOG_DIR}/access.log combined\nErrorLog "logs/error_log"\n' }] } };
  assert.deepEqual(PX.logPaths(raw, { id: 'n', kind: 'nginx', where: 'container' }, 'access'), ['/var/log/nginx/access.log', '/var/log/nginx/a.log', '/etc/nginx/logs/rel.log']);
  assert.deepEqual(PX.logPaths(raw, { id: 'n', kind: 'nginx', where: 'container' }, 'error'), []);
  assert.deepEqual(PX.logPaths(raw, { id: 'a', kind: 'apache', where: 'container', apacheRoot: '/etc/apache2' }, 'access'), ['/var/log/apache2/access.log']);
  assert.deepEqual(PX.logPaths(raw, { id: 'a', kind: 'apache', where: 'container', apacheRoot: '/usr/local/apache2' }, 'error'), ['/usr/local/apache2/logs/error_log']);
  assert.deepEqual(PX.logPaths({ files: {} }, { id: 'h', kind: 'nginx', where: 'host' }, 'access'), ['/var/log/nginx/access.log'], 'a host proxy without log lines: the distribution default');
});

test('local host: on by default, DG_HOST_ACCESS=off turns it off; runs through sh when DockGate is not in a container', async () => {
  const old = process.env.DG_HOST_ACCESS; const oldIn = process.env.DG_IN_CONTAINER;
  try {
    process.env.DG_HOST_ACCESS = 'off'; assert.equal(LH.forLocal({}), null);
    delete process.env.DG_HOST_ACCESS; const h = LH.forLocal({}); assert.equal(h.local, true);
    if (!LH.inContainer()) { const r = await h.exec('echo hi; echo err >&2; exit 3'); assert.deepEqual([r.code, r.stdout.trim(), r.stderr.trim()], [3, 'hi', 'err']); }
  } finally { if (old == null) delete process.env.DG_HOST_ACCESS; else process.env.DG_HOST_ACCESS = old; if (oldIn == null) delete process.env.DG_IN_CONTAINER; else process.env.DG_IN_CONTAINER = oldIn; }
});

test('local host in a container: a helper that shares the host\'s processes and network runs the command in the host root', async () => {
  const old = process.env.DG_IN_CONTAINER; process.env.DG_IN_CONTAINER = '1';
  let spec = null;
  const frame = (type, s) => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const ct = { start: async () => {}, wait: async () => ({ StatusCode: 0 }), logs: async () => Buffer.concat([frame(1, 'out\n'), frame(2, 'warn\n')]), remove: async () => {}, kill: async () => {} };
  const c = { getImage: () => ({ inspect: async () => ({}) }), createContainer: async (o) => { spec = o; return ct; } };
  try {
    const r = await LH.forLocal(c).exec('nginx -T');
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, 'out\n', 'warn\n']);
    assert.deepEqual(spec.Cmd, ['chroot', '/host', 'sh', '-c', 'nginx -T']);
    assert.equal(spec.HostConfig.PidMode, 'host'); assert.equal(spec.HostConfig.NetworkMode, 'host'); assert.deepEqual(spec.HostConfig.Binds, ['/:/host']);
  } finally { if (old == null) delete process.env.DG_IN_CONTAINER; else process.env.DG_IN_CONTAINER = old; }
});

test('nginxAllCerts: certificates in included snippets and at http level, not only in the server block', () => {
  const parsed = P.parseNginxT(`# configuration file /etc/nginx/nginx.conf:
http {
  ssl_certificate /etc/ssl/default.crt;
  include /etc/nginx/sites-enabled/*;
}
# configuration file /etc/nginx/sites-enabled/app.conf:
server { listen 443 ssl; server_name app.test; include snippets/app-ssl.conf; }
server { listen 443 ssl; server_name b.test; ssl_certificate /etc/letsencrypt/live/b.test/fullchain.pem; }
server { listen 443 ssl; server_name *.c.test; ssl_certificate /etc/ssl/$ssl_server_name.crt; }
# configuration file /etc/nginx/snippets/app-ssl.conf:
ssl_certificate snippets/../ssl/app.crt; # relative to /etc/nginx
ssl_certificate_key /etc/nginx/ssl/app.key;
# ssl_certificate /old/commented.crt;
`);
  assert.deepEqual(P.nginxAllCerts(parsed).sort(), ['/etc/letsencrypt/live/b.test/fullchain.pem', '/etc/nginx/snippets/../ssl/app.crt', '/etc/ssl/default.crt'].sort());
});
