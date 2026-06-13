// Isolated service-control worker — forked child process (same pattern as host-stats-worker.js /
// grant-docker-worker.js) so its ssh2 connection never contends with the main-process EventMonitor
// connections to the same host. One-shot: performs ONE op, writes ONE JSON object to stdout, exits 0
// (or writes the error to stderr and exits 1).
//
// SECURITY: this worker NEVER receives or runs free shell. Every command is resolved from the catalog
// (catalog.serviceFor / serviceAction / isConfigPathAllowed) keyed by an item id + action — and a config
// path is re-checked against the catalog allowlist HERE too (defence in depth against a route bypass).
//
// Input (argv[2], JSON): { host, port, username, keyPath?, password?, passphrase?, op, itemId?, configPath? }
//   op='status'     → { distro, services:[{itemId,label,unit,timer,risk,managed,active,enabled,configPaths,na,reason}] }
//   op='readconfig' → { path, exists, content }
delete process.env.SSH_AUTH_SOCK; // auth strictly via the provided key/password — no agent fallback
const { Client } = require('ssh2');
const fs = require('fs');
const catalog = require('./provision/catalog');

const cfg = JSON.parse(process.argv[2] || '{}');
const conn = new Client();
const opts = { host: cfg.host, port: cfg.port || 22, username: cfg.username, readyTimeout: 20000, agent: false, tryKeyboard: false };
if (cfg.keyPath) { opts.privateKey = fs.readFileSync(cfg.keyPath); if (cfg.passphrase) opts.passphrase = cfg.passphrase; }
else if (cfg.password) opts.password = cfg.password;

let done = false;
const fail = (m) => { if (done) return; done = true; process.stderr.write(String(m) + '\n'); try { conn.end(); } catch (e) {} process.exit(1); };
const ok = (obj) => { if (done) return; done = true; try { conn.end(); } catch (e) {} process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const wd = setTimeout(() => fail('service-ctl timed out'), 25000);

// Run one command; resolve { code, out } (stdout+stderr merged). Never rejects.
function run(cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve({ code: 1, out: String(err.message || err) });
      let out = '';
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { out += d.toString(); });
      stream.on('close', (code) => resolve({ code: code || 0, out }));
    });
  });
}

const lastLine = (s) => (String(s || '').trim().split('\n').filter(Boolean).pop() || '').trim();

async function detectDistro() {
  const d = await run('. /etc/os-release 2>/dev/null; echo "${ID:-unknown}"');
  return lastLine(d.out) || 'unknown';
}

async function doStatus() {
  const distro = await detectDistro();
  const services = [];
  for (const itemId of catalog.manageableItems()) {
    let svc;
    try { svc = catalog.serviceFor(itemId, distro); }
    catch (e) { services.push({ itemId, na: true, reason: 'unsupported distro' }); continue; }
    if (!svc) continue;
    if (svc.na) { services.push({ itemId, label: svc.label, na: true, reason: svc.reason, risk: svc.risk }); continue; }
    const a = await run(svc.verbs.status);
    const en = await run(svc.verbs.enabled);
    services.push({
      itemId, label: svc.label, unit: svc.unit, timer: svc.timer, risk: svc.risk,
      requiresKeyForConfig: svc.requiresKeyForConfig, configPaths: svc.configPaths,
      managed: true,
      active: lastLine(a.out) === 'active',
      enabled: ['enabled', 'static', 'enabled-runtime'].includes(lastLine(en.out)),
    });
  }
  ok({ distro, services });
}

async function doReadConfig() {
  const distro = await detectDistro();
  const p = cfg.configPath;
  // Defence in depth — the path must be an exact catalog allowlist entry for this item+distro.
  if (!catalog.isConfigPathAllowed(cfg.itemId, distro, p)) return fail('config path not allowed');
  const ex = await run(`test -f '${p}' && echo DG_YES || echo DG_NO`);
  if (!/DG_YES/.test(ex.out)) return ok({ path: p, exists: false, content: '' });
  const c = await run(`sudo -n cat -- '${p}'`);
  if (c.code !== 0) return fail(c.out.trim() || 'read failed (passwordless sudo required)');
  ok({ path: p, exists: true, content: c.out });
}

conn.on('ready', async () => {
  try {
    if (cfg.op === 'status') return await doStatus();
    if (cfg.op === 'readconfig') return await doReadConfig();
    fail('unknown op: ' + cfg.op);
  } catch (e) { fail(e && e.message ? e.message : String(e)); }
}).on('error', e => fail(e.message)).connect(opts);
