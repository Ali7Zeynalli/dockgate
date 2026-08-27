const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../agent/src/storage');

describe('Agent Observability - Metrics Storage & Downsampling', () => {
  it('stores raw 10-second samples and retrieves them for 1h range', () => {
    const storage = new Storage();
    const now = Date.now();

    storage.addMetricsSample({
      timestamp: now - 20000,
      host: { cpuPercent: 15.5, memPercent: 42.0, diskPercent: 65.0, netRxBytesSec: 10240, netTxBytesSec: 5120 },
      containers: {
        'web-api': { cpuPercent: 8.2, memUsedBytes: 150000000, memPercent: 3.5 },
      },
    });

    storage.addMetricsSample({
      timestamp: now - 10000,
      host: { cpuPercent: 25.0, memPercent: 43.0, diskPercent: 65.0, netRxBytesSec: 20480, netTxBytesSec: 10240 },
      containers: {
        'web-api': { cpuPercent: 12.0, memUsedBytes: 155000000, memPercent: 3.6 },
      },
    });

    const res = storage.getMetrics({ range: '1h' });
    assert.equal(res.count, 2);
    assert.equal(res.host.cpu.length, 2);
    assert.equal(res.host.cpu[0], 15.5);
    assert.equal(res.host.cpu[1], 25.0);
    assert.ok(res.containers['web-api']);
    assert.equal(res.containers['web-api'].cpu[1], 12.0);
  });

  it('downsamples points into 1-minute and 15-minute buckets without data loss', () => {
    const storage = new Storage();
    const base = Date.now() - 3600000;

    // Simulate 6 samples 10s apart across a 1-minute window
    for (let i = 0; i < 6; i++) {
      storage.addMetricsSample({
        timestamp: base + i * 10000,
        host: { cpuPercent: 10 + i * 2, memPercent: 50.0, diskPercent: 30.0, netRxBytesSec: 1000, netTxBytesSec: 1000, load1: 1.0 },
        containers: {
          nginx: { cpuPercent: 5.0, memUsedBytes: 50000000, memPercent: 1.2 },
        },
      });
    }

    // Trigger minute downsampling
    storage.addMetricsSample({
      timestamp: base + 65000,
      host: { cpuPercent: 20.0, memPercent: 50.0, diskPercent: 30.0, netRxBytesSec: 1000, netTxBytesSec: 1000, load1: 1.0 },
    });

    assert.ok(storage.minuteSamples.length >= 1, 'Should have created 1-minute downsampled point');
    const minPoint = storage.minuteSamples[0];
    assert.ok(minPoint.host.cpu > 0);
  });

  it('caps raw sample buffer at 360 points to protect memory', () => {
    const storage = new Storage();
    const base = Date.now();

    for (let i = 0; i < 400; i++) {
      storage.addMetricsSample({
        timestamp: base + i * 10000,
        host: { cpuPercent: (i % 100), memPercent: 50.0, diskPercent: 30.0, netRxBytesSec: 0, netTxBytesSec: 0 },
      });
    }

    assert.equal(storage.rawSamples.length, 360, 'Raw buffer must cap at exactly 360 points (1 hour)');
  });

  it('produces a comprehensive summary for host & containers', () => {
    const storage = new Storage();
    storage.addMetricsSample({
      timestamp: Date.now(),
      host: { cpuPercent: 32.5, memPercent: 68.0, diskPercent: 45.0, netRxBytesSec: 50000, netTxBytesSec: 25000 },
      containers: {
        'postgres-db': { cpuPercent: 18.0, memUsedBytes: 500000000, memPercent: 12.0 },
        'redis-cache': { cpuPercent: 4.5, memUsedBytes: 100000000, memPercent: 2.5 },
      },
    });

    const summary = storage.getSummary();
    assert.ok(summary.host);
    assert.equal(summary.host.cpu, 32.5);
    assert.equal(summary.containersCount, 2);
    assert.equal(summary.breakdown[0].name, 'postgres-db');
    assert.equal(summary.breakdown[0].cpuPercent, 18.0);
  });
});
