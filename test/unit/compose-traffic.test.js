'use strict';
// Proxies and replicas (server/compose-traffic.js) — pure parts, no Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../server/compose-traffic');

test('kindOf tells proxy images apart', () => {
  assert.equal(T.kindOf('nginx:1.27-alpine'), 'nginx');
  assert.equal(T.kindOf('docker.io/library/nginx'), 'nginx');
  assert.equal(T.kindOf('openresty/openresty:alpine'), 'nginx');
  assert.equal(T.kindOf('caddy:2'), 'caddy');
  assert.equal(T.kindOf('traefik:v3'), 'traefik');
  assert.equal(T.kindOf('mynginx-app:1'), null, 'only the image name, not a part of it');
  assert.equal(T.kindOf('traefik/whoami:v1.10'), null);
});

test('nginxUsesResolver: static proxy_pass needs a reload, resolver + variable or resolve does not', () => {
  assert.equal(T.nginxUsesResolver('location / { proxy_pass http://api:8080; }', 'api'), false);
  assert.equal(T.nginxUsesResolver('resolver 127.0.0.11 valid=10s; location / { proxy_pass http://api:8080; }', 'api'), false, 'resolver alone does not help a static proxy_pass');
  assert.equal(T.nginxUsesResolver('resolver 127.0.0.11 valid=10s; set $u http://api:8080; location / { proxy_pass $u; }', 'api'), true);
  assert.equal(T.nginxUsesResolver('resolver 127.0.0.11; upstream b { zone b 64k; server api:8080 resolve; }', 'api'), true);
  assert.equal(T.nginxUsesResolver('# resolver 127.0.0.11;\nset $u http://api:8080; proxy_pass $u;', 'api'), false, 'a commented resolver does not count');
});
