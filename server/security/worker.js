// Isolated security worker — forked child process (same pattern as provision-worker / service-ctl-worker)
// so its ssh2 connection never contends with the main-process connections to the same host.
//
// It executes ONLY what the parent built in server/security/plans.js — it has no command logic of its
// own beyond the root/sudo prefix and the "test a NEW login" step.
//
// Input (argv[2], JSON): { host, port, username, keyPath?, password?, passphrase?, hostKey?, mode, script?, plan? }
//   mode 'read' → runs `script`, prints {"out": "...", "code": n} to stdout
//   mode 'plan' → runs plan.steps in order, streaming NDJSON:
//       {type:'step', i, state:'running'|'done'|'failed', out?}  {type:'rolledback'}  {type:'done'}  {type:'fatal', error}
//     A step is { label, cmd } or { label, test: { port?, username, keyPath?, password?, cmd? } }.
//     When a step marked rollbackOnFail fails, plan.rollback runs immediately on the (still open) original
//     connection; if that connection is gone, the server-side timer armed earlier restores the config.
delete process.env.SSH_AUTH_SOCK;
const { Client } = require('ssh2');
const { workerConnectOpts } = require('../ssh-connect');

const cfg = JSON.parse(process.argv[2] || '{}');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prefix = 'sudo -n ';
const sub = (cmd) => String(cmd).split('{{S}}').join(prefix);

function run(conn, cmd, timeoutMs = 600000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ code: 124, out: 'timed out' }); } }, timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); done = true; return resolve({ code: 1, out: String(err.message || err) }); }
      let out = '';
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { out += d.toString(); });
      stream.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code: code == null ? 1 : code, out }); });
    });
  });
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    try { c.connect(opts); } catch (e) { reject(e); }
  });
}

// A brand-new connection with the credentials the change must keep working (e.g. the deploy user's new
// key, or the new SSH port). Proves the server still accepts logins before the change is kept.
async function testLogin(t) {
  const opts = workerConnectOpts({
    host: cfg.host, port: t.port || cfg.port, username: t.username || cfg.username,
    keyPath: t.keyPath || (t.password ? null : cfg.keyPath), password: t.password || (t.keyPath ? null : cfg.password),
    passphrase: t.keyPath ? null : cfg.passphrase, hostKey: cfg.hostKey,
  }, { readyTimeout: 15000 });
  // sshd closes its listening socket for a moment while it re-executes on reload (SIGHUP), so a refused
  // or reset connection is retried for ~15 s. An authentication failure is final — that is the answer.
  let c, lastErr;
  for (let attempt = 0; attempt < 8 && !c; attempt++) {
    try { c = await connect(opts); }
    catch (e) {
      lastErr = e;
      if (!/ECONNREFUSED|ECONNRESET|Timed out|timeout|ETIMEDOUT/i.test(e.message || '')) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!c) return { code: 255, out: 'New SSH login failed: ' + ((lastErr && lastErr.message) || lastErr) };
  const cmd = t.cmd || (opts.username === 'root' ? 'true' : 'sudo -n true');
  const r = await run(c, cmd, 30000);
  try { c.end(); } catch (e) {}
  if (r.code !== 0) r.out = `Logged in, but "${cmd}" failed: ${r.out}`;
  return r;
}

(async () => {
  const wd = setTimeout(() => { emit({ type: 'fatal', error: 'security worker timed out' }); process.exit(1); }, 20 * 60 * 1000);
  let conn;
  try { conn = await connect(workerConnectOpts(cfg)); }
  catch (e) {
    const msg = /host denied/i.test(e.message || '') ? require('../ssh-hostkey').MISMATCH_MESSAGE : (e.message || String(e));
    if (cfg.mode === 'read') { process.stderr.write(msg + '\n'); process.exit(1); }
    emit({ type: 'fatal', error: msg }); process.exit(1);
  }
  const who = await run(conn, 'id -u', 15000);
  prefix = String(who.out).trim().split('\n').pop().trim() === '0' ? '' : 'sudo -n ';

  if (cfg.mode === 'read') {
    const r = await run(conn, sub(cfg.script), 60000);
    clearTimeout(wd); try { conn.end(); } catch (e) {}
    process.stdout.write(JSON.stringify({ code: r.code, out: r.out }));
    return process.exit(0);
  }

  const steps = (cfg.plan && cfg.plan.steps) || [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    emit({ type: 'step', i, state: 'running' });
    const r = s.test ? await testLogin(s.test) : await run(conn, sub(s.cmd));
    if (r.code === 0) { emit({ type: 'step', i, state: 'done', out: String(r.out).slice(-2000) }); continue; }
    emit({ type: 'step', i, state: 'failed', out: String(r.out).trim().slice(-2000) || `exit code ${r.code}` });
    if (s.rollbackOnFail && cfg.plan.rollback) {
      const rb = await run(conn, sub(cfg.plan.rollback), 60000);
      emit({ type: 'rolledback', ok: rb.code === 0, out: String(rb.out).slice(-1000) });
    }
    clearTimeout(wd); try { conn.end(); } catch (e) {}
    emit({ type: 'end', ok: false });
    return process.exit(0);
  }
  clearTimeout(wd); try { conn.end(); } catch (e) {}
  emit({ type: 'end', ok: true });
  process.exit(0);
})().catch((e) => { emit({ type: 'fatal', error: e.message || String(e) }); process.exit(1); });
