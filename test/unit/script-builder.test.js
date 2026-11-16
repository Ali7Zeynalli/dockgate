'use strict';
// Script Builder: the scripts DockGate writes from blocks, run with bash (docker / rsync / curl replaced by shims that
// log their arguments): steps in order, stop vs go on, values never break out of their place, templates are valid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const B = require('../../server/script-builder');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sb-'));
const BIN = path.join(BASE, 'bin'); fs.mkdirSync(BIN);
const LOG = path.join(BASE, 'calls.log');
for (const tool of ['docker', 'rsync', 'apt-get', 'unattended-upgrade', 'shutdown']) fs.writeFileSync(path.join(BIN, tool), `#!/bin/bash\nprintf '%s' "${tool}" >> ${LOG}; for a in "$@"; do printf ' [%s]' "$a" >> ${LOG}; done; echo >> ${LOG}\n[ "$1" = exec ] && echo "-- dump --"\n[ "$1" = inspect ] && { echo "\${HEALTH:-healthy}"; exit 0; }\n[ "$FAIL_${tool.toUpperCase().replace(/-/g, '_')}" = 1 ] && exit 3\nexit 0\n`, { mode: 0o755 });
// systemctl: is-active answers from SVC_STATE (default active); other calls are logged
fs.writeFileSync(path.join(BIN, 'systemctl'), `#!/bin/bash\nprintf 'systemctl' >> ${LOG}; for a in "$@"; do printf ' [%s]' "$a" >> ${LOG}; done; echo >> ${LOG}\nif [ "$1" = is-active ]; then st=\${SVC_STATE:-active}; [ "$2" = --quiet ] || echo "$st"; [ "$st" = active ]; exit; fi\n[ "$1" = restart ] && echo restarted > ${BASE}/svc-restarted\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'curl'), `#!/bin/bash\nprintf 'curl' >> ${LOG}; for a in "$@"; do printf ' [%s]' "$a" >> ${LOG}; done; echo >> ${LOG}\nfor a in "$@"; do [ "$a" = "%{http_code}" ] && { printf '%s' "\${HTTP_CODE:-200}"; exit 0; }; done; exit 0\n`, { mode: 0o755 });
const run = (spec, env = {}) => new Promise((res) => {
  fs.writeFileSync(LOG, '');
  const f = path.join(BASE, 'script.sh'); fs.writeFileSync(f, B.build(spec), { mode: 0o755 });
  execFile('bash', [f], { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...env }, timeout: 20000 }, (e, so, se) => res({ code: e ? e.code : 0, out: String(so) + String(se), calls: fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) }));
});

test('templates build; names, paths and values are checked', () => {
  for (const t of B.TEMPLATES) assert.match(B.build(t), /^#!\/usr\/bin\/env bash/);
  assert.throws(() => B.build({ name: 'Bad Name', steps: [{ type: 'sleep', seconds: 1 }] }), /Name/);
  assert.throws(() => B.build({ name: 'x', steps: [] }), /at least one/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'container_action', container: 'web; rm -rf /', action: 'restart' }] }), /Container/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'cleanup_old', dir: '/etc', days: 1 }] }), /not in \/etc/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'cleanup_old', dir: '/var/backups', pattern: '$(id)', days: 1 }] }), /Names/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'copy_remote', src: 'relative', dest: '/x' }] }), /absolute/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'nope' }] }), /Unknown block/);
});

test('a backup script runs its steps in order with the right arguments', async () => {
  const dir = path.join(BASE, 'backups');
  const r = await run({ name: 'db-backup', steps: [
    { type: 'db_backup', container: 'pg', engine: 'postgres', database: 'app', user: 'postgres', dir },
    { type: 'volume_backup', volume: 'app_data', dir },
    { type: 'copy_remote', src: dir + '/', dest: 'backup@10.0.0.9:/b/' },
    { type: 'container_action', container: 'web', action: 'restart' },
  ] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ Done/);
  assert.equal(r.calls[0], 'docker [exec] [pg] [pg_dump] [-U] [postgres] [app]');
  assert.match(r.calls[1], /^docker \[run\] \[--rm\] \[-v\] \[app_data:\/v:ro\] \[-v\] \[.*backups:\/b\] \[alpine\] \[tar\] \[czf\] \[\/b\/app_data-\d{4}-\d\d-\d\d-\d{4}\.tar\.gz\]/);
  assert.equal(r.calls[2], `rsync [-az] [--partial] [${dir}/] [backup@10.0.0.9:/b/]`);
  assert.equal(r.calls[3], 'docker [restart] [web]');
  assert.ok(fs.readdirSync(dir).some(n => /^pg-app-.*\.sql\.gz$/.test(n)), 'dump file written');
});

test('a failing step stops the script; "go on" continues and the script still reports the failure', async () => {
  let r = await run({ name: 'x', steps: [{ type: 'copy_remote', src: '/tmp/', dest: '/tmp/x/' }, { type: 'container_action', container: 'web', action: 'restart' }] }, { FAIL_RSYNC: '1' });
  assert.equal(r.code, 1); assert.match(r.out, /step 1 failed — stopping/); assert.equal(r.calls.length, 1, 'step 2 did not run');
  r = await run({ name: 'x', steps: [{ type: 'copy_remote', src: '/tmp/', dest: '/tmp/x/', onFail: 'continue' }, { type: 'container_action', container: 'web', action: 'restart' }] }, { FAIL_RSYNC: '1' });
  assert.equal(r.code, 1); assert.match(r.out, /going on/); assert.equal(r.calls[1], 'docker [restart] [web]'); assert.match(r.out, /Done with 1 failed step/);
  // a failure in the middle of a step stops that step (set -e in a standalone subshell)
  r = await run({ name: 'x', steps: [{ type: 'custom', command: 'false\necho SHOULD-NOT-PRINT' }] });
  assert.equal(r.code, 1); assert.ok(!/SHOULD-NOT-PRINT/.test(r.out));
});

test('checks: URL status, disk use; the site-down template restarts only when the site fails', async () => {
  let r = await run({ name: 'x', steps: [{ type: 'http_check', url: 'https://example.com/health', expect: '200' }] }, { HTTP_CODE: '503' });
  assert.equal(r.code, 1); assert.match(r.out, /HTTP 503 \(expected 200\)/);
  r = await run({ name: 'x', steps: [{ type: 'disk_check', path: '/', max: 99 }] });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /\/: \d+% used/);
  const t = B.TEMPLATES.find(x => x.id === 'restart-if-down');
  r = await run(t, { HTTP_CODE: '502' }); assert.ok(r.calls.includes('docker [restart] [web]'), r.calls.join('\n'));
  r = await run(t, { HTTP_CODE: '200' }); assert.ok(!r.calls.some(c => c.startsWith('docker')), 'no restart while the site answers');
});

test('values can not run commands: names, paths, URLs and messages stay literal', async () => {
  const mark = path.join(BASE, 'pwned');
  const r = await run({ name: 'x', steps: [
    { type: 'notify', url: 'https://ntfy.sh/topic', text: `done $(touch ${mark}) \`touch ${mark}\` on $(hostname) "q"` },
    { type: 'http_check', url: `https://example.com/a'b?x=$(touch ${mark})`, expect: '200' },
  ] });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(mark), false);
  assert.match(r.calls[0], new RegExp(`\\[done \\$\\(touch ${mark.replace(/[/.]/g, '\\$&')}\\) touch .* on ${os.hostname()} q\\]`), 'only $(hostname) expands');
});


test('templates: every one builds, with the answers put into its steps', () => {
  assert.ok(B.TEMPLATES.length >= 18);
  for (const t of B.TEMPLATES) { assert.ok(t.category, t.id); B.build(B.fromTemplate(t.id)); }
  const t = B.fromTemplate('db-backup', { container: 'myapp-db-1', database: 'shop', dest: 'u@h:/b/' });
  assert.equal(t.steps[0].container, 'myapp-db-1'); assert.equal(t.steps[0].database, 'shop'); assert.equal(t.steps[2].dest, 'u@h:/b/');
  assert.equal(B.fromTemplate('restart-if-down', { container: 'shop-web-1' }).steps[1].container, 'shop-web-1');
  assert.throws(() => B.fromTemplate('nope'), /Unknown template/);
});

test('system update: apt with security updates, then a reboot only when the system asks for it', async () => {
  const r = await run(B.fromTemplate('security-updates', { window: '' }));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls[0], 'apt-get [update] [-q]');
  assert.equal(r.calls[1], 'unattended-upgrade [-v]', 'security only: unattended-upgrade');
  assert.ok(r.calls.includes('apt-get [-y] [-q] [autoremove]'));
  if (!fs.existsSync('/var/run/reboot-required')) { assert.match(r.out, /No reboot needed/); assert.ok(!r.calls.some(c => c.startsWith('shutdown'))); }
  const full = B.build({ name: 'x', steps: [{ type: 'os_update', mode: 'all', autoremove: 'no' }] });
  assert.match(full, /dist-upgrade/); assert.ok(!/autoremove/.test(full));
  assert.match(B.build({ name: 'x', steps: [{ type: 'os_update', mode: 'security' }] }), /dnf -y -q upgrade --security/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'reboot_if_needed', window: '25:00-26:00' }] }), /Only between/);
});

test('self-repair: a fix runs only when a check failed; a working fix counts as fixed, a failing one is reported', async () => {
  // service watchdog: running → nothing; stopped → restarted
  let r = await run(B.fromTemplate('service-watchdog', { name: 'nginx' }));
  assert.equal(r.code, 0, r.out); assert.match(r.out, /skipped \(nothing failed\)/); assert.ok(!r.calls.some(c => /\[restart\]/.test(c)));
  r = await run(B.fromTemplate('service-watchdog', { name: 'nginx' }), { SVC_STATE: 'failed' });
  assert.ok(r.calls.includes('systemctl [restart] [nginx]'), r.calls.join('\n'));
  // restart-if-down: site down → restart + wait healthy; the last check still fails → the run fails (reported)
  r = await run(B.fromTemplate('restart-if-down', { container: 'web', url: 'https://example.com/health' }), { HTTP_CODE: '502' });
  assert.ok(r.calls.includes('docker [restart] [web]')); assert.match(r.out, /web: healthy/); assert.match(r.out, /✓ fixed/);
  assert.equal(r.code, 1, 'the site still does not answer after the restart');
  r = await run(B.fromTemplate('restart-if-down', { container: 'web', url: 'https://example.com/health' }), { HTTP_CODE: '200' });
  assert.equal(r.code, 0); assert.ok(!r.calls.some(c => c.startsWith('docker')));
  // a fix that works → the run ends OK
  r = await run({ name: 'x', steps: [{ type: 'http_check', url: 'https://e.example/', onFail: 'continue' }, { type: 'container_action', container: 'web', action: 'restart', when: 'if_failed' }] }, { HTTP_CODE: '500' });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /✓ fixed/); assert.match(r.out, /✓ Done/);
  // wait_healthy gives up after its timeout
  r = await run({ name: 'x', steps: [{ type: 'wait_healthy', container: 'web', timeout: 5 }] }, { HEALTH: 'starting' });
  assert.equal(r.code, 1); assert.match(r.out, /still starting after 5 s/);
});

test('checks: memory, CPU load and a port; Telegram message keeps text literal', async () => {
  let r = await run({ name: 'x', steps: [{ type: 'mem_check', max: 99 }, { type: 'load_check', max: '50' }] });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /memory: \d+% used/); assert.match(r.out, /load \(5 min\): [\d.]+ on \d+ CPUs/);
  r = await run({ name: 'x', steps: [{ type: 'mem_check', max: 1 }] }); assert.equal(r.code, 1);
  r = await run({ name: 'x', steps: [{ type: 'port_check', host: '127.0.0.1', port: 1 }] }); assert.equal(r.code, 1); assert.match(r.out, /does not answer/);
  r = await run({ name: 'x', steps: [{ type: 'telegram', token: '123456789:AAEhBP0av28aaaaaaaaaaaaaaaaaaaaaaaaa', chat: '-100123', text: 'done on $(hostname) $(id)' }] });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls[0].includes('[https://api.telegram.org/bot123456789:AAEhBP0av28aaaaaaaaaaaaaaaaaaaaaaaaa/sendMessage]'));
  assert.ok(r.calls[0].includes(`[text=done on ${os.hostname()} $(id)]`), r.calls[0]);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'telegram', token: 'bad', chat: '1', text: 'x' }] }), /Bot token/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'service', name: 'nginx;reboot', action: 'restart' }] }), /Service name/);
  assert.throws(() => B.build({ name: 'x', steps: [{ type: 'ssl_check', domain: 'not a domain', days: 7 }] }), /Domain/);
});
