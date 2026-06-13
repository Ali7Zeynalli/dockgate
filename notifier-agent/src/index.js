// Entry point. Loads cfg, fails fast if NO channel is configured, optionally sends a startup
// self-test, constructs + starts the Monitor, starts the loopback health server, and wires
// graceful shutdown on SIGTERM/SIGINT so the event stream and timers tear down cleanly.
const { cfg } = require('./config');
const Monitor = require('./monitor');
const { startHealthServer } = require('./health');
const mailer = require('./mailer');
const telegram = require('./telegram');
const templates = require('./templates');

(async () => {
  console.log(`[agent] DockGate Notifier starting — host=${cfg.serverLabel} tz=${cfg.timezone} disk>${cfg.diskThresholdGb}GB`);

  if (!mailer.isConfigured() && !telegram.isConfigured()) {
    console.error('[agent] FATAL: no channel configured (need TG_TOKEN+TG_CHAT_ID or SMTP_HOST+SMTP_PORT+SMTP_FROM+SMTP_TO)');
    process.exit(1);
  }

  if (process.env.SEND_TEST_ON_START === 'true') {
    try {
      if (mailer.isConfigured()) await mailer.sendEmail({ subject: 'Test Email', html: templates.testEmailTemplate() });
      if (telegram.isConfigured()) await telegram.sendMessage({ text: `🐳 <b>DockGate Notifier active</b>\n\nWatching <code>${cfg.serverLabel}</code>` });
    } catch (e) {
      console.warn('[agent] startup test failed:', e && e.message);
    }
  }

  const mon = new Monitor();
  mon.start();
  const health = startHealthServer(() => ({
    streamConnected: !!mon.stream && !mon.stopped,
    lastEventAt: mon.lastEventAt,
  }));

  const shutdown = () => {
    console.log('[agent] shutting down');
    try { mon.stop(); } catch (e) {}
    try { health.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // The daemon socket dropping must NOT kill the agent — the stream's own reconnect handles it.
  process.on('uncaughtException', (e) => console.error('[agent] uncaught:', e && e.message));
  process.on('unhandledRejection', (e) => console.error('[agent] unhandledRejection:', e && (e.message || e)));
})();
