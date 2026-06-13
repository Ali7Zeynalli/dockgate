// Spawns the isolated service-ctl worker for a one-shot op and resolves its JSON. Mirrors
// host-stats.collectHostStats — the worker runs ssh2 in its own process so it never contends with the
// main-process EventMonitor connections. cfg: { host,port,username,keyPath?,password?,passphrase? }.
const { execFile } = require('child_process');
const path = require('path');

function runWorker(cfg, op, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      host: cfg.host, port: cfg.port, username: cfg.username,
      keyPath: cfg.keyPath || null, password: cfg.password || null, passphrase: cfg.passphrase || null,
      op, ...extra,
    });
    const child = execFile(process.execPath, [path.join(__dirname, 'service-ctl-worker.js'), payload], { maxBuffer: 4 * 1024 * 1024 });
    const to = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('service-ctl timed out')); }, 28000);
    let buf = '', err = '';
    child.stdout.on('data', d => { buf += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0) return reject(new Error(err.trim() || 'service-ctl failed'));
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad service-ctl output')); }
    });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

const collectServiceStatus = (cfg) => runWorker(cfg, 'status');
const readServiceConfig = (cfg, itemId, configPath) => runWorker(cfg, 'readconfig', { itemId, configPath });
const performServiceAction = (cfg, itemId, action) => runWorker(cfg, 'action', { itemId, action });
const writeServiceConfig = (cfg, itemId, configPath, contentB64) => runWorker(cfg, 'writeconfig', { itemId, configPath, contentB64 });

module.exports = { runWorker, collectServiceStatus, readServiceConfig, performServiceAction, writeServiceConfig };
