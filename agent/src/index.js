// Entry point for DockGate Unified Observability Agent (Metrics, Logs & Alerting).
const { cfg } = require('./config');
const Storage = require('./storage');
const MetricsCollector = require('./metrics-collector');
const LogAggregator = require('./log-aggregator');
const Monitor = require('./monitor');
const { startQueryServer } = require('./health');
const mailer = require('./mailer');
const telegram = require('./telegram');
const templates = require('./templates');
const Docker = require('dockerode');

(async () => {
  console.log(`[agent] DockGate Observability Agent starting — host=${cfg.serverLabel} tz=${cfg.timezone} disk>${cfg.diskThresholdGb}GB`);

  const docker = new Docker({ socketPath: cfg.socketPath });
  const storage = new Storage({ maxLogs: 10000 });

  // Optional startup notification test
  if (process.env.SEND_TEST_ON_START === 'true') {
    try {
      if (mailer.isConfigured) await mailer.sendEmail({ subject: 'Test Email', html: templates.testEmailTemplate() });
      if (telegram.isConfigured) await telegram.sendMessage({ text: `🐳 <b>DockGate Agent active</b>\n\nWatching <code>${cfg.serverLabel}</code>` });
    } catch (e) {
      console.warn('[agent] startup test failed:', e && e.message);
    }
  }

  // 1. Start Event Alert Monitor
  const mon = new Monitor();
  mon.start();

  // 2. Start Time-Series Metrics Collector
  const metricsCollector = new MetricsCollector(docker, storage, { intervalMs: 10000 });
  metricsCollector.start();

  // 3. Start Container Log Aggregator
  const logAggregator = new LogAggregator(docker, storage, { telegram, mailer });
  logAggregator.start();

  // 4. Start Host & Web Proxy Log Harvester (syslog, auth.log, nginx, dmesg)
  const HostLogHarvester = require('./host-log-harvester');
  const hostHarvester = new HostLogHarvester(storage, { intervalMs: 10000 });
  hostHarvester.start();

  // 5. Start Query Server (Metrics, Logs, Health)
  const server = startQueryServer(storage, () => ({
    streamConnected: !!mon.stream && !mon.stopped,
    lastEventAt: mon.lastEventAt,
  }));

  const shutdown = () => {
    console.log('[agent] shutting down cleanly');
    try { mon.stop(); } catch (e) {}
    try { metricsCollector.stop(); } catch (e) {}
    try { logAggregator.stop(); } catch (e) {}
    try { hostHarvester.stop(); } catch (e) {}
    try { server.close(); } catch (e) {}
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (e) => console.error('[agent] uncaught:', e && e.message));
  process.on('unhandledRejection', (e) => console.error('[agent] unhandledRejection:', e && (e.message || e)));
})();
