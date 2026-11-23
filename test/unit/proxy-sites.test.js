'use strict';
// Proxies & SSL — where a new nginx site goes (a folder nginx really loads), the include DockGate adds when there is
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
