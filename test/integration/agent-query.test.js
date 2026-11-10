// DockGate asks the on-host Edge agent over SSH (docker exec … wget). execRemote resolves { code, stdout, stderr };
// reading that as a string threw, so every remote agent query failed and pages silently fell back to Docker.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-agentq-test-'));
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const remoteCompose = require('../../server/remote-compose');
const { stmts } = require('../../server/db');
let reply = { code: 0, stdout: '', stderr: '' }; const sent = [];
remoteCompose.execRemote = async (server, cmd) => { sent.push(cmd); return reply; };
const monitoring = require('../../server/routes/monitoring');
const app = express(); app.use(express.json()); app.use('/api/monitoring', monitoring);
stmts.insertServer.run('edge1', 'ssh', '203.0.113.20', 22, 'deploy', null, null, null, '', 'test', 0);

test('parseAgentReply reads stdout of the SSH result', () => {
  assert.deepEqual(monitoring.parseAgentReply({ code: 0, stdout: ' {"a":1}\n', stderr: '' }), { a: 1 });
  assert.throws(() => monitoring.parseAgentReply({ code: 1, stdout: '', stderr: 'no such container' }), /did not answer/);
  assert.throws(() => monitoring.parseAgentReply({ code: 0, stdout: '<html>', stderr: '' }), /could not read/);
});

test('remote logs come from the agent, with the asked limit', async () => {
  reply = { code: 0, stdout: JSON.stringify({ total: 2, returned: 2, logs: [{ timestamp: 1, containerName: 'api', message: 'hi', level: 'info' }, { timestamp: 2, containerName: 'api', message: 'boom', level: 'error' }] }), stderr: '' };
  const r = await request(app).get('/api/monitoring/edge1/logs?limit=5000');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'agent');
  assert.equal(r.body.logs.length, 2);
  assert.match(sent.at(-1), /docker exec dockgate-agent wget -qO- "http:\/\/127\.0\.0\.1:9000\/logs\?limit=5000"/);
});

test('remote summary comes from the agent', async () => {
  reply = { code: 0, stdout: JSON.stringify({ host: { cpu: 12 }, containersCount: 3 }), stderr: '' };
  const r = await request(app).get('/api/monitoring/edge1/summary');
  assert.equal(r.body.source, 'agent');
  assert.equal(r.body.containersCount, 3);
});
