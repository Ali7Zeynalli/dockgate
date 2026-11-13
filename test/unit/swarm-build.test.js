'use strict';
// Build & push for Swarm (server/swarm-build.js) — where an image goes. No Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../../server/swarm-build');

test('a private registry gets host/project-service; Docker Hub gets user/project-service', () => {
  assert.equal(B.repoFor({ server_address: 'registry.example.com:5000' }, 'Shop', 'api'), 'registry.example.com:5000/shop-api');
  assert.equal(B.repoFor({ server_address: 'https://ghcr.io/' }, 'shop', 'web_1'), 'ghcr.io/shop-web_1');
  assert.equal(B.repoFor({ server_address: 'docker.io', username: 'Ali' }, 'shop', 'api'), 'ali/shop-api');
});
test('tags sort by time', () => {
  assert.equal(B.tagNow(new Date('2026-11-13T10:15:30Z')), '20261113-101530');
});
