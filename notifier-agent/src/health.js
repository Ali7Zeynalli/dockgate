// Local HTTP query endpoint for metrics, logs, summary and health checks.
// Accessible from Docker exec or local query socket / port.
const http = require('http');
const url = require('url');
const { cfg } = require('./config');

function startQueryServer(storage, getState) {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query || {};

    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && pathname === '/healthz') {
      const s = getState() || {};
      const ok = !!s.streamConnected;
      res.writeHead(ok ? 200 : 503);
      res.end(JSON.stringify({
        status: ok ? 'ok' : 'degraded',
        streamConnected: ok,
        lastEventAt: s.lastEventAt ? new Date(s.lastEventAt).toISOString() : null,
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/metrics') {
      const metrics = storage.getMetrics({
        range: query.range || '1h',
        container: query.container || '',
      });
      res.writeHead(200);
      res.end(JSON.stringify(metrics));
      return;
    }

    if (req.method === 'GET' && pathname === '/logs') {
      const logs = storage.getLogs({
        container: query.container || '',
        source: query.source || '',
        level: query.level || '',
        search: query.search || '',
        limit: query.limit || 100,
        since: Number(query.since) || 0,
      });
      res.writeHead(200);
      res.end(JSON.stringify(logs));
      return;
    }

    if (req.method === 'GET' && pathname === '/summary') {
      const summary = storage.getSummary();
      res.writeHead(200);
      res.end(JSON.stringify(summary));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Listen on health port
  server.listen(cfg.healthPort, '0.0.0.0');
  return server;
}

module.exports = { startQueryServer };
