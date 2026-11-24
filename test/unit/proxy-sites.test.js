'use strict';
// Proxies & SSL - where a new nginx site goes (a folder nginx really loads), the include DockGate adds when there is
// none, the listen port, Caddy JSON configs.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../server/proxy-parse');
const G = require('../../server/proxy-gen');

const target = (txt) => { const t = P.nginxSiteTarget(P.parseNginxT(txt)); return t ? t.path('new.test') : null; };

test('nginxSiteTarget: a folder included in http { }, not one only named conf.d', () => {
  assert.equal(target('# configuration file /etc/nginx/nginx.conf:\ninclude /etc/nginx/modules-enabled/*.conf;\nevents {}\nhttp {\n  include mime.types;\n  include /etc/nginx/vhosts/*.conf;\n}\n'), '/etc/nginx/vhosts/new.test.conf');
  assert.equal(target('# configuration file /config/nginx/nginx.conf:\nhttp {\n  include /config/nginx/site-confs/*.conf;\n  include /etc/nginx/http.d/*.conf;\n}\n'), '/config/nginx/site-confs/new.test.conf', 'SWAG');
  assert.equal(target('# configuration file /etc/nginx/nginx.conf:\nhttp { server { listen 80; } }\n'), null, 'no folder of sites: DockGate adds one');
});

test('nginxSiteTarget: the folder that already holds sites wins; includes inside server blocks are not site folders', () => {
  assert.equal(target('# configuration file /etc/nginx/nginx.conf:\nhttp {\n  include /etc/nginx/conf.d/*.conf;\n  include /etc/nginx/sites-enabled/*;\n}\n# configuration file /etc/nginx/sites-enabled/x:\nserver { listen 80; server_name x.test; include /etc/nginx/locations/*.conf; }\n'), '/etc/nginx/sites-enabled/new.test.conf');
  assert.equal(target('# configuration file /etc/nginx/nginx.conf:\nhttp {\n  include conf.d/default.conf;\n}\n# configuration file /etc/nginx/conf.d/default.conf:\ninclude /etc/nginx/sites/*.vhost;\nserver { listen 80; server_name d.test; }\n'), '/etc/nginx/sites/new.test.vhost', 'one level down, its own suffix');
});

test('nginxAddHttpInclude: the line goes inside http { }, before its closing brace', () => {
  const t = G.nginxAddHttpInclude('events {}\nhttp {\n  server { listen 80; } # } in a comment\n}\n# end\n', 'include /etc/nginx/conf.d/*.conf;');
  assert.match(t, /server \{ listen 80; \} # \} in a comment\n {4}include \/etc\/nginx\/conf\.d\/\*\.conf;\n\}\n# end/);
  assert.throws(() => G.nginxAddHttpInclude('events {}\n', 'include x;'), /No http/);
});

test('nginxSite listens where the proxy listens', () => {
  const t = G.nginxSite({ domain: 'u.test', targets: ['web:80'], https: 'existing', certPath: '/c.pem', keyPath: '/k.pem', redirect: false, httpPort: 8080, httpsPort: 8443 });
  assert.match(t, /listen 8080;/); assert.match(t, /listen 8443 ssl;/);
  assert.match(G.nginxSite({ domain: 'u.test', targets: ['web:80'], https: 'none' }), /listen 80;/);
});

test('Caddy JSON: told apart from a Caddyfile, its sites read through subroutes', () => {
  const json = JSON.stringify({ apps: { http: { servers: { srv0: { listen: [':443'], routes: [{ match: [{ host: ['a.test', 'www.a.test'] }], handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'web:8080' }] }] }] }] }] } } } } });
  assert.equal(P.isCaddyJson(json), true);
  assert.equal(P.isCaddyJson('{\n  email a@b.c\n}\na.test {\n  reverse_proxy web:80\n}\n'), false, 'a Caddyfile with a global options block');
  assert.deepEqual(P.parseCaddyJson(json).map(s => [s.domain, s.https, s.targets.join(',')]), [['a.test', true, 'web:8080'], ['www.a.test', true, 'web:8080']]);
});

test('sites without a domain are listed by their address (server_name _, an IP, a port, a path)', () => {
  const t = P.parseNginxT('# configuration file /etc/nginx/conf.d/default.conf:\nserver { listen 80 default_server; server_name _; location / { proxy_pass http://app:3000; } }\nserver { listen 8080; location / { proxy_pass http://api:8000; } }\nserver { listen 80; server_name 192.168.1.10; location / { proxy_pass http://web:80; } }\nserver { listen 81; server_name _; root /usr/share/nginx/html; }\n');
  const n = P.nginxSites(t).filter(s => s.nameless);
  assert.deepEqual(n.map(s => [s.domain, s.port, s.anyName, s.targets.join()]), [[':80', 80, true, 'app:3000'], [':8080', 8080, true, 'api:8000'], ['192.168.1.10', 80, false, 'web:80']], 'a default page without proxy_pass is not a site');
  assert.deepEqual(P.parseCaddyfile(':8080 {\n  reverse_proxy api:8000\n}\nhttp://10.0.0.5 {\n  reverse_proxy web:80\n}\n').map(s => [s.domain, !!s.nameless]), [[':8080', true], ['10.0.0.5', true]]);
  assert.deepEqual(P.traefikSites({ 'traefik.http.routers.a.rule': 'PathPrefix(`/api`)' }).map(s => [s.domain, s.nameless]), [['/api', true]]);
  assert.deepEqual(P.parseHaproxy('frontend web\n  bind *:80\n  default_backend app\nbackend app\n  server a1 app:3000\n').map(s => [s.domain, s.nameless, s.targets.join()]), [[':80', true, 'app:3000']]);
});

test('nginx whose config check fails: its files are found by following the include lines (sites-enabled too)', () => {
  assert.deepEqual(P.nginxIncludes('events {}\nhttp {\n  include mime.types;\n  include /etc/nginx/conf.d/*.conf; # include /off;\n  include "/etc/nginx/sites-enabled/*";\n  include $dyn;\n}', '/etc/nginx'),
    ['/etc/nginx/mime.types', '/etc/nginx/conf.d/*.conf', '/etc/nginx/sites-enabled/*']);
  const re = P.globRe('/etc/nginx/sites-enabled/*');
  assert.equal(re.test('/etc/nginx/sites-enabled/shop.example.com'), true);
  assert.equal(re.test('/etc/nginx/sites-enabled/a/b'), false, '* stays in one folder');
  assert.equal(P.globRe('/x/site?.conf').test('/x/site1.conf'), true);
  const files = [
    { path: '/etc/nginx/nginx.conf', text: 'http { include conf.d/*.conf; include /etc/nginx/sites-enabled/*; }' },
    { path: '/etc/nginx/conf.d/default.conf', text: 'server { listen 80; server_name a.example.test; location / { proxy_pass http://a:1; } }' },
    { path: '/etc/nginx/sites-enabled/shop.example.test', text: 'server { listen 80; server_name shop.example.test; location / { proxy_pass http://gone:3000; } }' },
    { path: '/etc/nginx/sites-available/old.example.test', text: 'server { listen 80; server_name old.example.test; }' },
  ];
  const reach = P.nginxReachable(files);
  assert.deepEqual(reach.map(f => f.path), ['/etc/nginx/nginx.conf', '/etc/nginx/conf.d/default.conf', '/etc/nginx/sites-enabled/shop.example.test'], 'sites-available is not loaded by nginx');
  const sites = P.nginxSites(P.parseNginxT(reach.map(f => `# configuration file ${f.path}:\n${f.text}`).join('\n')));
  assert.deepEqual(sites.map(s => s.domain).sort(), ['a.example.test', 'shop.example.test']);
  assert.deepEqual(P.nginxReachable([{ path: '/etc/nginx/conf.d/x.conf', text: '' }, { path: '/etc/nginx/x.txt', text: '' }]).map(f => f.path), ['/etc/nginx/conf.d/x.conf'], 'no nginx.conf: the .conf files');
});
