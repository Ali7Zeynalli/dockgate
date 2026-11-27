'use strict';
// A network's page (server/network-map.js): members with addresses, aliases and compose project, and the compose
// files compared with what is live.
const test = require('node:test');
const assert = require('node:assert/strict');
const NM = require('../../server/network-map');

const NET = {
  Id: 'n1', Name: 'shop_backend', Driver: 'bridge', Scope: 'local', Internal: false, EnableIPv6: false,
  IPAM: { Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] },
  Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.network': 'backend' },
  Containers: { c1: { IPv4Address: '172.30.0.2/16' } },
};
const ctr = (id, name, project, service, ip, extra = {}) => ({
  Id: id, Names: [`/${name}`], State: extra.state || 'running', Image: 'img',
  Labels: project ? { 'com.docker.compose.project': project, 'com.docker.compose.service': service } : {},
  Ports: extra.ports || [],
  NetworkSettings: { Networks: extra.net === false ? { other: { NetworkID: 'n2' } } : { shop_backend: { NetworkID: 'n1', IPAddress: ip, Aliases: extra.aliases || null } } },
  inspect: extra.inspect,
});

const CONTAINERS = [
  ctr('c1', 'shop-api-1', 'shop', 'api', '172.30.0.2', { ports: [{ PublicPort: 8080, PrivatePort: 80, Type: 'tcp', IP: '0.0.0.0' }, { PublicPort: 8080, PrivatePort: 80, Type: 'tcp', IP: '::' }],
    inspect: { NetworkSettings: { Networks: { shop_backend: { Aliases: ['shop-api-1', 'api', 'c1'], DNSNames: ['shop-api-1', 'api'], IPAMConfig: null } } } } }),
  ctr('c2', 'shop-db-1', 'shop', 'db', '172.30.0.3', { inspect: { NetworkSettings: { Networks: { shop_backend: { Aliases: ['db'] } } } } }),
  ctr('c3', 'debug', null, null, '172.30.0.9'),
  ctr('c4', 'blog-web-1', 'blog', 'web', '172.30.0.4'),
  ctr('c5', 'shop-old-1', 'shop', 'old', '172.30.0.5', { state: 'exited' }),
];

const CFG_SHOP = {
  name: 'shop',
  networks: { backend: { name: 'shop_backend', driver: 'bridge', ipam: { config: [{ subnet: '172.30.0.0/16' }] } }, default: { name: 'shop_default' } },
  services: {
    api: { networks: { backend: { aliases: ['api'] }, default: null } },
    db: { networks: { backend: { aliases: ['db', 'postgres'] } } },
    worker: { networks: ['backend'] },
    cron: { network_mode: 'host' },
  },
};
const CFG_BLOG = { name: 'blog', networks: { default: { name: 'blog_default' } }, services: { web: {} } };

test('describe: members with addresses, aliases, ports once, project and service; who made the network', () => {
  const d = NM.describe(NET, CONTAINERS);
  assert.deepEqual(d.definedBy, { project: 'shop', key: 'backend' });
  assert.deepEqual(d.projects, ['shop', 'blog']);
  assert.deepEqual(d.members.map(m => m.name), ['blog-web-1', 'shop-api-1', 'shop-db-1', 'shop-old-1', 'debug']);
  const api = d.members.find(m => m.name === 'shop-api-1');
  assert.deepEqual(api.aliases, ['api'], 'the container name and id are left out');
  assert.deepEqual(api.ports, [{ host: 8080, port: 80, proto: 'tcp', ip: '0.0.0.0' }]);
  assert.equal(api.service, 'api');
  assert.deepEqual(d.standalone, ['debug']);
  assert.deepEqual(d.subnets, [{ subnet: '172.30.0.0/16', gateway: '172.30.0.1', range: '' }]);
});

test('serviceNets: list, map, the default network, network_mode', () => {
  assert.deepEqual(NM.serviceNets({}), { default: {} });
  assert.deepEqual(NM.serviceNets({ networks: ['a', 'b'] }), { a: {}, b: {} });
  assert.deepEqual(NM.serviceNets({ networks: { a: { aliases: ['x'], ipv4_address: '10.0.0.5' } } }), { a: { aliases: ['x'], ipv4: '10.0.0.5' } });
  assert.deepEqual(NM.serviceNets({ network_mode: 'host', networks: ['a'] }), {});
});

test('compare: attached by hand, missing alias, service not in the file, missing container, docker run', () => {
  const d = NM.describe(NET, CONTAINERS);
  const others = [{ name: 'shop-worker-1', project: 'shop', service: 'worker', state: 'running' }];
  const r = NM.compare(d, { shop: { config: CFG_SHOP, files: ['compose.yml'] }, blog: { config: CFG_BLOG } }, others);
  const kinds = r.findings.map(f => `${f.kind}:${f.container || f.project}`);
  assert.deepEqual(kinds.sort(), ['alias:shop-db-1', 'manual:blog-web-1', 'missing:shop-worker-1', 'orphan:shop-old-1', 'standalone:debug'].sort());
  assert.equal(r.findings[0].level, 'crit', 'the missing container first');
  assert.deepEqual(r.findings.find(f => f.kind === 'manual').fix, { action: 'disconnect', container: 'blog-web-1' });
  assert.deepEqual(r.findings.find(f => f.kind === 'orphan').fix, { action: 'up-orphans', project: 'shop' });
  assert.match(r.findings.find(f => f.kind === 'alias').text, /postgres/);
  assert.deepEqual(r.findings.find(f => f.kind === 'alias').fix, { action: 'recreate', project: 'shop', service: 'db' });
  assert.equal(r.clean, false);
  const shop = r.projects.find(p => p.project === 'shop');
  assert.equal(shop.key, 'backend'); assert.deepEqual(shop.services, ['api', 'db', 'worker']);
});

test('compare: matches the file; the file changed the network; a file that can not be read; unused', () => {
  const d = NM.describe(NET, CONTAINERS.slice(0, 2).map(c => ({ ...c, inspect: { NetworkSettings: { Networks: { shop_backend: { Aliases: ['api', 'db', 'postgres'] } } } } })));
  const ok = NM.compare(d, { shop: { config: { ...CFG_SHOP, services: { api: CFG_SHOP.services.api, db: CFG_SHOP.services.db } } } });
  assert.deepEqual(ok.findings, []); assert.equal(ok.clean, true);
  const changed = NM.compare(d, { shop: { config: { ...CFG_SHOP, networks: { backend: { name: 'shop_backend', internal: true, ipam: { config: [{ subnet: '10.9.0.0/24' }] } } }, services: { api: CFG_SHOP.services.api, db: CFG_SHOP.services.db } } } });
  const def = changed.findings.find(f => f.kind === 'definition');
  assert.match(def.text, /internal on in the file, off live; subnet 10\.9\.0\.0\/24 in the file, 172\.30\.0\.0\/16 live/);
  const gone = NM.compare(d, { shop: { config: { name: 'shop', networks: {}, services: { api: {}, db: {} } } } });
  assert.ok(gone.findings.some(f => f.kind === 'gone-from-file'));
  const err = NM.compare(d, { shop: { error: 'no compose file found' } });
  assert.equal(err.findings[0].kind, 'no-file'); assert.equal(err.clean, true);
  const empty = NM.compare(NM.describe({ Id: 'x', Name: 'leftover', Driver: 'bridge', IPAM: {} }, []), {});
  assert.equal(empty.findings[0].kind, 'unused');
  assert.deepEqual(NM.compare(NM.describe({ Id: 'b', Name: 'bridge', Driver: 'bridge' }, []), {}).findings, []);
});
