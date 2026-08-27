const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../agent/src/storage');

describe('Agent Observability - Centralized Log Storage & Classification', () => {
  it('correctly classifies log levels based on message content and stream', () => {
    const storage = new Storage();

    storage.addLog({ containerName: 'backend', stream: 'stderr', message: 'Something went wrong on port 3000' });
    storage.addLog({ containerName: 'api', stream: 'stdout', message: 'HTTP 500 Internal Server Error in /api/users' });
    storage.addLog({ containerName: 'web', stream: 'stdout', message: 'Warning: Deprecated API version v1' });
    storage.addLog({ containerName: 'worker', stream: 'stdout', message: 'Job 42 processed successfully' });
    storage.addLog({ containerName: 'service', stream: 'stdout', message: 'DEBUG [cache] Cache hit for key user_1' });

    const all = storage.getLogs({ limit: 10 });
    assert.equal(all.returned, 5);

    const errors = storage.getLogs({ level: 'error' });
    assert.equal(errors.returned, 2, 'Should detect 2 errors (stderr and HTTP 500)');

    const warnings = storage.getLogs({ level: 'warn' });
    assert.equal(warnings.returned, 1, 'Should detect 1 warning');

    const debugs = storage.getLogs({ level: 'debug' });
    assert.equal(debugs.returned, 1, 'Should detect 1 debug log');
  });

  it('filters logs by search keywords and container names', () => {
    const storage = new Storage();

    storage.addLog({ containerName: 'auth-svc', message: 'Token verified for user alice' });
    storage.addLog({ containerName: 'auth-svc', message: 'Token verification failed for user bob' });
    storage.addLog({ containerName: 'payment-svc', message: 'Payment of $50 charged for user alice' });

    const searchAlice = storage.getLogs({ search: 'alice' });
    assert.equal(searchAlice.returned, 2);

    const authOnly = storage.getLogs({ container: 'auth-svc' });
    assert.equal(authOnly.returned, 2);

    const authBob = storage.getLogs({ container: 'auth-svc', search: 'bob' });
    assert.equal(authBob.returned, 1);
    assert.ok(authBob.logs[0].message.includes('bob'));
  });

  it('enforces circular FIFO log buffer capping', () => {
    const storage = new Storage({ maxLogs: 50 });

    for (let i = 1; i <= 80; i++) {
      storage.addLog({ containerName: 'app', message: `Log line number ${i}` });
    }

    const res = storage.getLogs({ limit: 100 });
    assert.equal(res.returned, 50, 'Log buffer must cap at maxLogs limit');
    assert.equal(res.logs[0].message, 'Log line number 31', 'Oldest entries (1..30) should have been evicted');
    assert.equal(res.logs[49].message, 'Log line number 80', 'Newest entries must remain');
  });
});
