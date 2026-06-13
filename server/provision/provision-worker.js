// Isolated provisioning worker (forked child process — same pattern as grant-docker-worker.js, so the
// long-lived ssh2 connection doesn't contend with the main process's EventMonitor connections to the
// same host). Detects the distro, builds the concrete plan from the catalog, then runs each item's
// detect → install → verify over ONE SSH connection, streaming progress to stdout as NDJSON.
//
// Input  (argv[2], JSON): { host, port, username, keyPath?, password?, passphrase?, itemIds:[...] }
// Output (stdout, NDJSON): {type:'meta',distro,total} · {type:'log',line} · {type:'item',...} · {type:'done',ok,failed} · {type:'fatal',error}
const { Client } = require('ssh2');
const fs = require('fs');
const catalog = require('./catalog');

delete process.env.SSH_AUTH_SOCK; // auth strictly via the provided key/password — no agent fallback

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const cfg = JSON.parse(process.argv[2] || '{}');

function authOpts(c) {
  const opts = { host: c.host, port: c.port || 22, username: c.username, readyTimeout: 20000, tryKeyboard: false };
  if (c.keyPath) { opts.privateKey = fs.readFileSync(c.keyPath); if (c.passphrase) opts.passphrase = c.passphrase; }
  else if (c.password) opts.password = c.password;
  return opts;
}

// Run one command; resolve { code, out } (stdout+stderr merged). Never rejects.
function run(conn, cmd) {
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

(async () => {
  const conn = new Client();
  const watchdog = setTimeout(() => { emit({ type: 'fatal', error: 'provisioning timed out (30 min)' }); try { conn.end(); } catch (e) {} process.exit(1); }, 30 * 60 * 1000);

  conn.on('ready', async () => {
    try {
      const d = await run(conn, '. /etc/os-release 2>/dev/null; echo "${ID:-unknown}"');
      const distro = String(d.out || '').trim().split('\n').pop().trim() || 'unknown';

      let plan;
      try { plan = catalog.buildPlanForDistro(cfg.itemIds || [], distro); }
      catch (e) { emit({ type: 'meta', distro, total: 0 }); emit({ type: 'fatal', error: e.message }); clearTimeout(watchdog); conn.end(); return process.exit(0); }

      emit({ type: 'meta', distro, total: plan.length });

      // Scan mode — read-only: run each item's detect command only (no install/verify), report present/missing.
      if (cfg.mode === 'scan') {
        for (const step of plan) {
          if (step.na) { emit({ type: 'scan-item', id: step.id, label: step.label, present: false, na: true, reason: step.reason }); continue; }
          const det = await run(conn, step.detect);
          emit({ type: 'scan-item', id: step.id, label: step.label, present: det.code === 0, na: false });
        }
        emit({ type: 'scan-done', distro });
        clearTimeout(watchdog); conn.end(); return process.exit(0);
      }

      let ok = 0, failed = 0;
      for (const step of plan) {
        const t0 = Date.now();
        if (step.na) { emit({ type: 'item', id: step.id, label: step.label, state: 'skipped', reason: step.reason, durationMs: 0 }); continue; }

        emit({ type: 'log', line: `▶ ${step.label}` });
        const det = await run(conn, step.detect);
        if (det.code === 0) {
          emit({ type: 'item', id: step.id, label: step.label, state: 'present', detect: step.detect, log: '✓ already present', durationMs: Date.now() - t0 });
          emit({ type: 'log', line: `  ✓ already present — skipped` });
          ok++; continue;
        }

        emit({ type: 'log', line: `  installing…` });
        const ins = await run(conn, step.install + ' 2>&1');
        let state, error;
        if (ins.code !== 0) { state = 'failed'; error = String(ins.out || '').slice(-2000).trim(); failed++; }
        else {
          const ver = await run(conn, step.verify);
          if (ver.code === 0) { state = 'verified'; ok++; }
          else { state = 'failed'; error = 'verify failed: ' + String(ver.out || '').slice(-500).trim(); failed++; }
        }
        emit({ type: 'item', id: step.id, label: step.label, state, detect: step.detect, install: step.install, verify: step.verify, log: String(ins.out || '').slice(-4000), error, durationMs: Date.now() - t0 });
        emit({ type: 'log', line: state === 'verified' ? `  ✓ ${step.label}` : `  ✗ ${step.label}${error ? ' — ' + String(error).split('\n')[0] : ''}` });
      }

      emit({ type: 'done', ok, failed });
      clearTimeout(watchdog); conn.end(); process.exit(0);
    } catch (e) {
      emit({ type: 'fatal', error: String(e.message || e) });
      clearTimeout(watchdog); try { conn.end(); } catch (_) {} process.exit(1);
    }
  });

  conn.on('error', (err) => { emit({ type: 'fatal', error: String(err.message || err) }); clearTimeout(watchdog); process.exit(1); });

  try { conn.connect(authOpts(cfg)); }
  catch (e) { emit({ type: 'fatal', error: String(e.message || e) }); clearTimeout(watchdog); process.exit(1); }
})();
