'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-swyaml-test-'));
const SY = require('../../server/swarm-yaml');

test('parseEnv reads KEY=VALUE lines, skips comments, strips quotes and rejects bad lines', () => {
  assert.deepEqual(SY.parseEnv('# db\nTAG=1.27\nPW="a=b c"\n\n'), { TAG: '1.27', PW: 'a=b c' });
  assert.throws(() => SY.parseEnv('just text'), /KEY=VALUE/);
  assert.throws(() => SY.parseEnv('1BAD=x'), /not a valid name/);
});

test('toYaml quotes every string and nests maps and lists', () => {
  const y = SY.toYaml({ services: { web: { image: 'nginx:1.27', command: ['sh', '-c', 'echo "hi"'], ports: [{ target: 80, published: 8080 }], deploy: { replicas: 2 } } }, volumes: { data: {} } });
  assert.equal(y, [
    'services:',
    '  web:',
    '    image: "nginx:1.27"',
    '    command:',
    '      - "sh"',
    '      - "-c"',
    '      - "echo \\"hi\\""',
    '    ports:',
    '      - target: 80',
    '        published: 8080',
    '    deploy:',
    '      replicas: 2',
    'volumes:',
    '  data: {}',
    '',
  ].join('\n'));
});

test('a stack service spec becomes a compose service: own volumes and networks lose the stack prefix', () => {
  const ctx = { prefix: 'app_', volumes: {}, networks: {}, secrets: {}, configs: {}, netNames: new Map([['n1', 'app_back'], ['n2', 'shared']]) };
  const spec = {
    Name: 'app_api', Labels: { 'com.docker.stack.namespace': 'app' },
    Mode: { Replicated: { Replicas: 3 } },
    TaskTemplate: {
      ContainerSpec: { Image: 'api:2@sha256:abc', Env: ['A=1'], Mounts: [{ Type: 'volume', Source: 'app_data', Target: '/d' }, { Type: 'volume', Source: 'other', Target: '/o' }, { Type: 'bind', Source: '/srv/x', Target: '/x', ReadOnly: true }], Secrets: [{ SecretName: 'pw', File: { Name: 'pw' } }] },
      Networks: [{ Target: 'n1' }, { Target: 'n2' }],
      Placement: { Constraints: ['node.role == worker'] },
      Resources: { Limits: { MemoryBytes: 64 * 1048576 } },
    },
    EndpointSpec: { Ports: [{ TargetPort: 80, PublishedPort: 8080, Protocol: 'tcp', PublishMode: 'host' }] },
  };
  const s = SY._servicePart(spec, ctx);
  assert.equal(s.image, 'api:2', 'the digest is dropped: the tag is what the file names');
  assert.deepEqual(s.volumes.map(v => v.source), ['data', 'other', '/srv/x']);
  assert.deepEqual(ctx.volumes, { data: {}, other: { external: true, name: 'other' } });
  assert.deepEqual(s.networks, ['back', 'shared']);
  assert.deepEqual(ctx.networks.shared, { external: true, name: 'shared' });
  assert.deepEqual(ctx.secrets, { pw: { external: true } });
  assert.equal(s.deploy.replicas, 3);
  assert.deepEqual(s.deploy.placement, { constraints: ['node.role == worker'] });
  assert.equal(s.deploy.resources.limits.memory, '64M');
  assert.equal(s.ports[0].mode, 'host');
});
