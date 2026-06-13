// Loopback-only health endpoint for the Docker HEALTHCHECK. Bound HARD to 127.0.0.1 and
// never published with -p, so it is NOT an inbound channel — it preserves the outbound-only guarantee.
const http = require('http');
const { cfg } = require('./config');

function startHealthServer(getState) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const s = getState() || {};
      const ok = !!s.streamConnected;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: ok ? 'ok' : 'degraded',
        streamConnected: ok,
        lastEventAt: s.lastEventAt ? new Date(s.lastEventAt).toISOString() : null,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // Bind address hardcoded to loopback — unreachable from outside the container.
  server.listen(cfg.healthPort, '127.0.0.1');
  return server;
}

module.exports = { startHealthServer };
