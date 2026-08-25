const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const LogDoctor = require('../../server/diagnostics/log-doctor');

describe('Log Doctor & Diagnostics Engine', () => {
  it('returns healthy status when logs contain no errors', () => {
    const logs = [
      { timestamp: Date.now(), message: 'Server listening on port 3000', source: 'container' },
      { timestamp: Date.now(), message: 'HTTP 200 GET /api/v1/health', source: 'nginx' },
    ];

    const res = LogDoctor.analyze(logs);
    assert.equal(res.healthScore, 100);
    assert.equal(res.status, 'healthy');
    assert.equal(res.issuesCount, 0);
  });

  it('detects Linux Kernel OOM Killer termination and creates actionable issue', () => {
    const logs = [
      { timestamp: Date.now(), message: 'kernel: [12345.67] Out of memory: Kill process 9182 (node) score 850 or sacrifice child', source: 'kernel' },
    ];

    const res = LogDoctor.analyze(logs);
    assert.ok(res.healthScore < 100);
    assert.ok(res.issuesCount >= 1);
    const oomIssue = res.issues.find(i => i.id === 'oom_killer_detected');
    assert.ok(oomIssue);
    assert.equal(oomIssue.severity, 'critical');
    assert.ok(oomIssue.title.includes('OOM Killer'));
    assert.ok(oomIssue.action.label.includes('Memory'));
  });

  it('detects Nginx 502 Bad Gateway upstream connection refusal', () => {
    const logs = [
      { timestamp: Date.now(), message: '2026/08/25 03:00:01 [error] 1234#1234: *5 connect() failed (111: Connection refused) while connecting to upstream, client: 1.2.3.4, server: myapp.com, request: "GET /api HTTP/1.1", upstream: "http://127.0.0.1:3000/api"', source: 'nginx' },
    ];

    const res = LogDoctor.analyze(logs);
    const nginxIssue = res.issues.find(i => i.id.startsWith('nginx_502_'));
    assert.ok(nginxIssue);
    assert.equal(nginxIssue.severity, 'critical');
    assert.ok(nginxIssue.title.includes('502 Bad Gateway'));
    assert.ok(nginxIssue.action.label.includes('Restart'));
  });

  it('detects SSH brute-force attack and flags attacker IP', () => {
    const logs = [];
    const attackerIp = '194.26.29.112';

    for (let i = 0; i < 16; i++) {
      logs.push({
        timestamp: Date.now(),
        message: `Aug 25 03:10:00 server sshd[${1000 + i}]: Failed password for root from ${attackerIp} port ${40000 + i} ssh2`,
        source: 'auth',
      });
    }

    const res = LogDoctor.analyze(logs);
    const sshIssue = res.issues.find(i => i.id === `ssh_brute_force_${attackerIp}`);
    assert.ok(sshIssue);
    assert.equal(sshIssue.severity, 'critical');
    assert.ok(sshIssue.title.includes(attackerIp));
    assert.ok(sshIssue.action.label.includes('Firewall'));
  });

  it('detects port collision and disk space exhaustion', () => {
    const logs = [
      { timestamp: Date.now(), message: 'Error: listen EADDRINUSE: address already in use :::8080', source: 'container' },
      { timestamp: Date.now(), message: 'write /var/lib/docker/overlay2/abc: No space left on device', source: 'system' },
    ];

    const res = LogDoctor.analyze(logs);
    const portIssue = res.issues.find(i => i.id.startsWith('port_conflict_'));
    const diskIssue = res.issues.find(i => i.id === 'disk_space_exhausted');

    assert.ok(portIssue, 'Should identify port conflict on 8080');
    assert.ok(diskIssue, 'Should identify disk space exhausted');
    assert.equal(diskIssue.severity, 'critical');
    assert.ok(diskIssue.action.label.includes('Prune'));
  });
});
