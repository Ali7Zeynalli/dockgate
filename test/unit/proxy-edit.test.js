'use strict';
// Proxies & SSL — the safe change path (server/proxy-edit.js) run for real in a shell: a stand-in `nginx` (its check
// fails on a line "BROKEN", its reload is logged) and a stand-in `curl` (answers from a status file per scheme) on
// PATH, a host proxy whose files are in a temp folder. Covers: a good change, a failed check, a site that stops
// answering, asking each site only the way it is served, a file that can not be put back, renewal that is only
// recorded once the proxy took it, and certificate alerts sent once per threshold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PX = require('../../server/proxies');
const PE = require('../../server/proxy-edit');
const ACME = require('../../server/acme');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-px-'));
const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
const conf = path.join(dir, 'site.conf');
const status = path.join(dir, 'status'); // lines "https:<code>" / "http:<code>"
const log = path.join(dir, 'calls.log');
fs.writeFileSync(path.join(bin, 'nginx'), `#!/bin/sh
echo "nginx $*" >> ${log}
if [ "$1" = "-t" ]; then if grep -q BROKEN ${dir}/*.conf ${dir}/*.pem 2>/dev/null; then echo "nginx: [emerg] unknown directive BROKEN" >&2; exit 1; fi; echo "nginx: test is successful"; exit 0; fi
exit 0
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
url=""; for a in "$@"; do case "$a" in http*://*) url="$a";; esac; done
scheme=\${url%%://*}
echo "curl $scheme $url" >> ${log}
code=$(grep "^$scheme:" ${status} | head -1 | cut -d: -f2)
printf %s "\${code:-000}"
`, { mode: 0o755 });
// base64 that fails while ${dir}/fail-base64 exists (a write that breaks half way)
const realB64 = require('node:child_process').execFileSync('sh', ['-c', 'command -v base64']).toString().trim();
fs.writeFileSync(path.join(bin, 'base64'), `#!/bin/sh\nif [ -f ${dir}/fail-base64 ]; then echo "base64: write error" >&2; exit 1; fi\nexec ${realB64} "$@"\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

// a host proxy whose commands run in a local shell
let failWrites = false;
PX.hostExec = (server, cmd) => new Promise((resolve) => {
  if (failWrites && /base64 -d/.test(cmd)) return resolve({ code: 1, out: '', err: 'No space left on device' });
  execFile('sh', ['-c', cmd], { env: process.env }, (e, out, er) => resolve({ code: e ? (e.code || 1) : 0, out: String(out), err: String(er) }));
});
const ctx = { serverId: 'test-srv', c: null, server: { id: 'test-srv' } };
const p = { id: 'h:nginx', name: 'nginx', kind: 'nginx', where: 'host', unit: 'nginx' };
const setStatus = (https, http) => fs.writeFileSync(status, `https:${https}\nhttp:${http}\n`);
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
const reset = () => fs.writeFileSync(log, '');
const versions = () => PE._q.vers.all('test-srv', 'nginx', conf, conf);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a good change: written, checked, reloaded, sites asked, earlier version kept', async () => {
  fs.writeFileSync(conf, 'server { listen 80; server_name a.example.test; }\n'); setStatus(200, 200); reset();
  const r = await PE.apply(ctx, p, [{ path: conf, text: 'server { listen 80; server_name a.example.test; # v2\n}\n' }], { domains: [{ domain: 'a.example.test', https: false }], note: 'v2' });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.match(fs.readFileSync(conf, 'utf8'), /# v2/);
  assert.match(calls(), /nginx -t/); assert.match(calls(), /nginx -s reload/);
  assert.equal(versions().length, 1); assert.equal(versions()[0].note, 'v2');
});

test('a failed check: nothing reloaded, the earlier file back, no version kept', async () => {
  const before = fs.readFileSync(conf, 'utf8'); reset(); const n = versions().length;
  const r = await PE.apply(ctx, p, [{ path: conf, text: 'BROKEN\n' }], { domains: [{ domain: 'a.example.test', https: false }] });
  assert.equal(r.ok, false); assert.equal(r.stage, 'test');
  assert.match(r.output, /unknown directive BROKEN/);
  assert.equal(fs.readFileSync(conf, 'utf8'), before);
  assert.doesNotMatch(calls(), /-s reload/);
  assert.equal(versions().length, n, 'a change that did not go through leaves no version');
  assert.ok(r.steps.some(s => s.t === 'Put the earlier files back'));
});

test('a site that stops answering: the earlier file back and reloaded', async () => {
  const before = fs.readFileSync(conf, 'utf8');
  setStatus(200, 200);
  // the stand-in curl answers 502 once the new file is in place
  const orig = PX.hostExec;
  PX.hostExec = async (server, cmd) => { const r = await orig(server, cmd); if (/nginx -s reload/.test(cmd) && /BADPORT/.test(fs.readFileSync(conf, 'utf8'))) setStatus(200, 502); else if (/nginx -s reload/.test(cmd)) setStatus(200, 200); return r; };
  try {
    const r = await PE.apply(ctx, p, [{ path: conf, text: 'server { BADPORT }\n' }], { domains: [{ domain: 'a.example.test', https: false }] });
    assert.equal(r.ok, false); assert.equal(r.stage, 'check');
    assert.deepEqual(r.probe, { before: { 'a.example.test': 200 }, after: { 'a.example.test': 502 } });
    assert.equal(fs.readFileSync(conf, 'utf8'), before);
  } finally { PX.hostExec = orig; }
});

test('each site is asked only the way it is served (no other site\'s HTTPS answer)', async () => {
  setStatus(200, 502); reset();
  const r = await PE.probe(ctx, p, [{ domain: 'http-only.example.test', https: false }, { domain: 'tls.example.test', https: true }, 'either.example.test']);
  assert.deepEqual(r, { 'http-only.example.test': 502, 'tls.example.test': 200, 'either.example.test': 200 });
  assert.match(calls(), /curl http http:\/\/http-only/); assert.doesNotMatch(calls(), /curl https https:\/\/http-only/);
  assert.doesNotMatch(calls(), /curl http http:\/\/tls/);
});

test('a file that can not be put back is said plainly — never "put back"', async () => {
  fs.writeFileSync(conf, 'server { listen 80; server_name a.example.test; }\n'); setStatus(200, 200);
  const orig = PX.hostExec;
  let wrote = 0;
  PX.hostExec = async (server, cmd) => { if (/base64 -d/.test(cmd) && ++wrote > 1) return { code: 1, out: '', err: 'No space left on device' }; return orig(server, cmd); };
  try {
    const r = await PE.apply(ctx, p, [{ path: conf, text: 'BROKEN\n' }], { domains: [] });
    assert.equal(r.ok, false); assert.equal(r.stage, 'test');
    assert.ok(r.steps.some(s => !s.ok && /COULD NOT put back/.test(s.t)), JSON.stringify(r.steps));
    assert.ok(!r.steps.some(s => s.t === 'Put the earlier files back'));
  } finally { PX.hostExec = orig; fs.writeFileSync(conf, 'server { listen 80; server_name a.example.test; }\n'); }
});

test('renewal: recorded only when the proxy took the new certificate; a failed check keeps the old files and date', async () => {
  PE.setAcmeSettings({ tos: true });
  const certPath = path.join(dir, 'fullchain.pem'), keyPath = path.join(dir, 'privkey.pem');
  fs.writeFileSync(certPath, 'OLD CERT\n'); fs.writeFileSync(keyPath, 'OLD KEY\n');
  PE._q.upCert.run({ server_id: 'test-srv', proxy: 'nginx', proxy_kind: 'nginx', proxy_where: 'host', names: JSON.stringify(['a.example.test']), cert_path: certPath, key_path: keyPath, cert_pem: 'OLD CERT', key_enc: 'x', not_after: '2026-12-01T00:00:00.000Z', issued_at: 1, last_try: 1, directory: 'test' });
  const row = PE._q.certs.all('test-srv').find(x => x.cert_path === certPath);
  const origIssue = ACME.issue;
  try {
    ACME.issue = async () => ({ certPem: 'NEW CERT BROKEN\n', keyPem: 'NEW KEY\n', accountKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', notAfter: '2027-03-01T00:00:00.000Z' });
    await assert.rejects(PE.renew(row.id, { ctx }), /nginx -t/);
    assert.equal(fs.readFileSync(certPath, 'utf8'), 'OLD CERT\n'); assert.equal(fs.readFileSync(keyPath, 'utf8'), 'OLD KEY\n');
    let after = PE._q.cert.get(row.id);
    assert.equal(after.not_after, '2026-12-01T00:00:00.000Z', 'the date stays: DockGate tries again'); assert.match(after.last_error, /nginx -t/);
    ACME.issue = async () => ({ certPem: 'NEW CERT\n', keyPem: 'NEW KEY\n', accountKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', notAfter: '2027-03-01T00:00:00.000Z' });
    reset();
    const ok = await PE.renew(row.id, { ctx });
    assert.equal(ok.ok, true);
    assert.equal(fs.readFileSync(certPath, 'utf8'), 'NEW CERT\n');
    after = PE._q.cert.get(row.id);
    assert.equal(after.not_after, '2027-03-01T00:00:00.000Z'); assert.equal(after.last_error, null);
    assert.match(calls(), /nginx -s reload/);
  } finally { ACME.issue = origIssue; }
});

test('certificate alerts: once per threshold, internal and test certificates skipped, renewed-but-not-loaded told', async () => {
  const HM = require('../../server/notifications/health-monitor');
  const sent = []; const orig = HM.deliver;
  HM.deliver = async (type, s, subject) => { sent.push({ type, subject }); return true; };
  try {
    const cert = (o) => ({ names: ['shop.example.test'], issuer: "Let's Encrypt R11", validTo: '2026-12-01T00:00:00Z', daysLeft: 10, renewal: 'certbot timer — on', renewer: 'certbot', auto: true, internal: false, staging: false, proxies: ['nginx'], served: null, fingerprint: 'AA', ...o });
    const snap = { certs: [cert({}), cert({ fingerprint: 'BB', internal: true, daysLeft: 0 }), cert({ fingerprint: 'CC', staging: true, daysLeft: 2 }), cert({ fingerprint: 'DD', daysLeft: 50, served: { stale: true, proxy: 'nginx', notAfter: '2026-11-25T00:00:00Z' } })], errors: [{ proxy: 'caddy', lines: ['{"level":"error","msg":"could not get certificate"}'] }] };
    await PE.certAlerts({ id: 'test-srv', name: 'Test' }, snap);
    assert.deepEqual(sent.map(x => x.type).sort(), ['cert_acme_error', 'cert_expiring', 'cert_not_loaded']);
    assert.match(sent.find(x => x.type === 'cert_expiring').subject, /expires in 10 days — shop\.example\.test on Test/);
    sent.length = 0;
    await PE.certAlerts({ id: 'test-srv', name: 'Test' }, snap); // same day, same thresholds: nothing again
    assert.equal(sent.length, 0);
    await PE.certAlerts({ id: 'test-srv', name: 'Test' }, { certs: [cert({ daysLeft: 6 })], errors: [] }); // crossed 7
    assert.equal(sent.length, 1); assert.match(sent[0].subject, /expires in 6 days/);
  } finally { HM.deliver = orig; }
});

test('a write that breaks half way never empties the file (the cause of a lost Caddyfile in an early build)', async () => {
  fs.writeFileSync(conf, 'server { listen 80; server_name keep.example.test; }\n'); setStatus(200, 200);
  fs.writeFileSync(path.join(dir, 'fail-base64'), '1');
  try {
    const r = await PE.apply(ctx, p, [{ path: conf, text: 'server { listen 80; server_name new.example.test; }\n' }], { domains: [] });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(conf, 'utf8'), 'server { listen 80; server_name keep.example.test; }\n');
  } finally { fs.rmSync(path.join(dir, 'fail-base64'), { force: true }); }
});
