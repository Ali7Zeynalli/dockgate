'use strict';
// Deploy → Tasks. task-parse.js is pure; tasks.js runs against "a server" that is this machine (bash).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const P = require('../../server/task-parse');

test('Makefile: targets with ## or # descriptions, variables, no special or pattern targets', () => {
  const m = P.makefile('ENV ?= staging\nIMAGE := app\n.PHONY: build deploy\n# Show help\nhelp:\n\t@x\nbuild: ## Build the image\n\tdocker build .\ndeploy: build test ## Deploy it\n\t./d\napp.o: app.c\n%.o: %.c\n\tcc\ndefine X\nfoo: bar\nendef\n');
  assert.deepEqual(m.targets.map(t => [t.name, t.desc, t.deps.join()]), [['help', 'Show help', ''], ['build', 'Build the image', ''], ['deploy', 'Deploy it', 'build,test']]);
  assert.deepEqual(m.vars.map(v => `${v.name}${v.op}${v.value}`), ['ENV?=staging', 'IMAGE:=app']);
});

test('justfile, Taskfile, package.json, shell descriptions', () => {
  const j = P.justfile("# Build it\nbuild:\n  x\n[private]\nhidden:\n_also:\ndeploy env='staging' tag:\n  y\n[doc('Run tests')]\ntest *args:\n");
  assert.deepEqual(j.recipes.map(r => [r.name, r.desc, r.params.map(p => `${p.name}=${p.value}`).join()]), [['build', 'Build it', ''], ['deploy', '', 'env=staging,tag=null'], ['test', 'Run tests', 'args=null']]);
  const t = P.taskfile("version: '3'\ntasks:\n  build:\n    desc: Build\n  deploy:prod:\n    summary: Ship it\n  inner:\n    internal: true\nvars:\n  x: 1\n");
  assert.deepEqual(t.tasks, [{ name: 'build', desc: 'Build' }, { name: 'deploy:prod', desc: 'Ship it' }]);
  assert.deepEqual(P.packageJson('{"scripts":{"build":"vite build"}}').scripts, [{ name: 'build', cmd: 'vite build' }]);
  assert.equal(P.shellDesc('#!/bin/bash\n# Deploy the app\n# to production\nset -e\n'), 'Deploy the app to production');
});

test('command lines are quoted, dry runs, and risky names', () => {
  assert.equal(P.command({ source: 'make', name: 'deploy' }, { vars: { ENV: "prod's" } }), "make 'deploy' 'ENV=prod'\\''s'");
  assert.equal(P.command({ source: 'make', name: 'deploy' }, { dry: true }), "make -n 'deploy'");
  assert.equal(P.command({ source: 'npm', name: 'build', pm: 'pnpm' }, { args: '--prod x' }), "pnpm run 'build' -- '--prod' 'x'");
  assert.equal(P.command({ source: 'just', name: 'deploy', params: [{ name: 'env' }, { name: 'tag' }] }, { vars: { env: 'prod', tag: 'v1' } }), "just 'deploy' 'prod' 'v1'");
  assert.equal(P.command({ source: 'ansible', name: 'site.yml', inventory: 'hosts' }, { dry: true }), "ansible-playbook 'site.yml' -i 'hosts' --check --diff");
  assert.throws(() => P.command({ source: 'sh', name: '../../etc/x.sh' }), /safely/);
  assert.throws(() => P.command({ source: 'make', name: 'a;rm' }), /safely/);
  assert.throws(() => P.command({ source: 'make', name: 'x' }, { vars: { 'A B': 1 } }), /variable/);
  assert.equal(P.RISKY.test('deploy'), true); assert.equal(P.RISKY.test('db:migrate'), true); assert.equal(P.RISKY.test('build'), false); assert.equal(P.RISKY.test('downloads'), false);
});

// ---------- running against "a server" (this machine) ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tasks-'));
const HOME = path.join(ROOT, 'home'), PROJ = path.join(ROOT, 'proj');
fs.mkdirSync(HOME); fs.mkdirSync(path.join(PROJ, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'Makefile'), 'ENV ?= staging\nhello: ## Say hello\n\t@echo "hello $(ENV) $$API_TOKEN"\nslow: ## Sleep\n\t@sleep 30\nfail:\n\t@echo boom; exit 3\n');
fs.writeFileSync(path.join(PROJ, 'package.json'), '{"scripts":{"build":"echo built"}}');
fs.writeFileSync(path.join(PROJ, 'pnpm-lock.yaml'), '');
fs.writeFileSync(path.join(PROJ, 'scripts', 'deploy.sh'), '#!/bin/bash\n# Ship it\necho shipped "$@"\n');
const env = { ...process.env, HOME };
const runLocal = (cmd, onData) => new Promise((res) => {
  const p = require('child_process').spawn('bash', ['-c', cmd], { env });
  let out = '', er = '';
  p.stdout.on('data', d => { out += d; if (onData) onData(d.toString()); }); p.stderr.on('data', d => { er += d; if (onData) onData(d.toString()); });
  p.on('close', (code) => res({ code: code || 0, stdout: out, stderr: er }));
});
const rcPath = require.resolve('../../server/remote-compose');
const realRc = require(rcPath);
require.cache[rcPath].exports = { ...realRc, execRemote: async (_s, cmd, onData) => runLocal(cmd, onData) };
const poolPath = require.resolve('../../server/ssh-pool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { withSftp: async (_s, fn) => fn({ writeFile: (p, d, o, cb) => { fs.writeFileSync(p, d, { mode: 0o600 }); cb(); } }) } };
const { stmts, db } = require('../../server/db');
db.prepare("INSERT OR REPLACE INTO servers (id, type, host, port, username) VALUES ('srv-t', 'ssh', '127.0.0.1', 22, 'deploy')").run();
const TK = require('../../server/tasks');
const wait = async (id, ms = 15000) => { const t0 = Date.now(); for (;;) { const r = TK.runLog(id); if (r.status !== 'running') return r; if (Date.now() - t0 > ms) throw new Error('still running'); await new Promise(res => setTimeout(res, 100)); } };

test('Tasks: find them, run with variables and env (secrets masked), dry run, lock, cancel, history', async () => {
  assert.equal(TK.server('local').local, true); // the local server runs tasks too (here, as DockGate's user)
  const d = await TK.discover('srv-t', PROJ);
  assert.equal(d.pm, 'pnpm');
  assert.deepEqual(d.tasks.map(t => `${t.source}:${t.name}`).sort(), ['make:fail', 'make:hello', 'make:slow', 'npm:build', 'sh:scripts/deploy.sh']);
  assert.equal(d.tasks.find(t => t.name === 'scripts/deploy.sh').desc, 'Ship it');
  assert.deepEqual(d.tasks.find(t => t.name === 'hello').vars, [{ name: 'ENV', value: 'staging' }]);
  await assert.rejects(TK.discover('srv-t', PROJ + '/nope'), /not on the server/);
  TK.envSet('srv-t', PROJ, [{ key: 'API_TOKEN', value: 'tok-12345', secret: true }]);
  assert.equal(TK.envList('srv-t', PROJ)[0].value, null, 'secret values never come back');
  let r = await wait((await TK.start('srv-t', PROJ, { source: 'make', name: 'hello', vars: { ENV: 'prod' } })).id);
  assert.equal(r.status, 'ok'); assert.match(r.text, /hello prod ••••/); assert.doesNotMatch(r.text, /tok-12345/);
  assert.deepEqual(fs.readdirSync(path.join(HOME, '.dockgate', 'run')), [], 'the env and pid files are gone');
  r = await wait((await TK.start('srv-t', PROJ, { source: 'make', name: 'hello', dry: true })).id);
  assert.match(r.text, /echo "hello staging/); assert.doesNotMatch(r.text, /^hello staging/m);
  r = await wait((await TK.start('srv-t', PROJ, { source: 'make', name: 'fail' })).id);
  assert.equal(r.status, 'failed'); assert.equal(r.code, 2);
  r = await wait((await TK.start('srv-t', PROJ, { source: 'npm', name: 'build', pm: 'pnpm' })).id).catch(e => e);
  r = await wait((await TK.start('srv-t', PROJ, { source: 'sh', name: 'scripts/deploy.sh', args: 'now' })).id);
  assert.match(r.text, /shipped now/);
  // one run per folder; cancel stops the process group
  const slow = await TK.start('srv-t', PROJ, { source: 'make', name: 'slow' });
  await assert.rejects(TK.start('srv-t', PROJ, { source: 'make', name: 'hello' }), (e) => e.code === 'BUSY');
  await new Promise(res => setTimeout(res, 600));
  assert.equal((await TK.cancel(slow.id)).cancelled, true);
  r = await wait(slow.id, 20000); assert.equal(r.status, 'cancelled');
  const h = TK.runs('srv-t', PROJ);
  assert.ok(h.length >= 5); assert.equal(h[0].status, 'cancelled');
  assert.equal(TK.runLog(h[h.length - 1].id).status, 'ok', 'finished runs keep their log');
  // templates: written once, not over an existing file
  await TK.addTemplate('srv-t', PROJ, 'deploy.sh');
  assert.ok(fs.existsSync(path.join(PROJ, 'deploy.sh')));
  await assert.rejects(TK.addTemplate('srv-t', PROJ, 'Makefile'), (e) => e.code === 'EXISTS');
});

test('Recipes: git pull, a check that fails, recovery back to the commit before; then a deploy that passes; schedule', async () => {
  const R = require('../../server/task-recipes');
  // a "remote" repo and the project as its clone
  const ORIGIN = path.join(ROOT, 'origin.git'), APP = path.join(ROOT, 'app');
  const sh = (c, cwd) => require('child_process').execSync(c, { cwd, env: { ...process.env, HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  sh(`git init -q --bare ${ORIGIN} && git clone -q ${ORIGIN} ${APP}`);
  fs.writeFileSync(path.join(APP, 'Makefile'), 'up: ## Start\n\t@echo "up v$$(cat VERSION)"\nrollback:\n\t@echo rolled-back\n'); fs.writeFileSync(path.join(APP, 'VERSION'), '1');
  sh('git add -A && git commit -qm v1 && git push -q origin HEAD', APP);
  const v1 = sh('git rev-parse HEAD', APP);
  // a new commit lands upstream
  const UP = path.join(ROOT, 'up'); sh(`git clone -q ${ORIGIN} ${UP}`); fs.writeFileSync(path.join(UP, 'VERSION'), '2'); sh('git commit -qam v2 && git push -q origin HEAD', UP);
  assert.throws(() => R.save('srv-t', APP, { name: 'x', steps: [{ type: 'git_back' }] }), /recovery step/);
  const bad = R.save('srv-t', APP, { name: 'Deploy', steps: [{ type: 'git_pull' }, { type: 'task', source: 'make', name: 'up' }, { type: 'check_url', url: 'http://127.0.0.1:9/health', tries: 2, every: 1 }],
    onFail: [{ type: 'git_back' }, { type: 'task', source: 'make', name: 'rollback' }], settings: { notify: { fail: false } } });
  const wait = async (id) => { for (let i = 0; i < 300; i++) { const r = TK.runLog(id); if (r.status !== 'running') return r; await new Promise(res => setTimeout(res, 100)); } throw new Error('still running'); };
  let r = await wait((await R.run(bad.id)).id);
  assert.equal(r.status, 'failed');
  assert.match(r.text, /now at \w+ v2/); assert.match(r.text, /up v2/); assert.match(r.text, /no good answer/); assert.match(r.text, /Recovering/); assert.match(r.text, /rolled-back/);
  assert.equal(sh('git rev-parse HEAD', APP), v1, 'back at the commit before the pull');
  // passing deploy (no check) + a task step with variables + docker-free compose check skipped
  const good = R.save('srv-t', APP, { name: 'Deploy ok', steps: [{ type: 'git_pull' }, { type: 'task', source: 'make', name: 'up' }, { type: 'wait', seconds: 1 }], settings: { notify: { fail: false } } });
  r = await wait((await R.run(good.id, { trigger: 'webhook:github', git: { sha: 'abc123', branch: 'main', message: 'v2', author: 'ann' } })).id);
  assert.equal(r.status, 'ok'); assert.match(r.text, /Triggered by webhook:github — ann: main abc123/); assert.match(r.text, /✓ Deployed/);
  // schedule: due → runs once
  R.save('srv-t', APP, { name: 'Deploy ok', steps: good.steps, schedule: '* * * * *', settings: { notify: { fail: false } } }, good.id);
  require('../../server/db').db.prepare('UPDATE task_recipes SET last_sched = ? WHERE id = ?').run(Date.now() - 120000, good.id);
  R.tick();
  await new Promise(res => setTimeout(res, 300));
  const last = TK.runs('srv-t', APP)[0];
  assert.equal(last.trigger, 'schedule'); await wait(last.id);
});

test('Webhooks: GitHub, GitLab, Bitbucket Cloud / Server, CI — signatures, payloads, branches, commit status', async () => {
  const H = require('../../server/task-hooks');
  const secret = 's3cr3t', raw = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
  const sig = 'sha256=' + require('crypto').createHmac('sha256', secret).update(raw).digest('hex');
  assert.deepEqual(H.verify({ 'x-github-event': 'push', 'x-hub-signature-256': sig }, raw, secret), { ok: true, provider: 'github', event: 'push' });
  assert.equal(H.verify({ 'x-github-event': 'push', 'x-hub-signature-256': sig.replace(/.$/, '0') }, raw, secret).ok, false);
  assert.equal(H.verify({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret }, raw, secret).ok, true);
  assert.equal(H.verify({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'nope' }, raw, secret).ok, false);
  assert.deepEqual(H.verify({ 'x-event-key': 'repo:push', 'x-hook-uuid': 'u', 'x-hub-signature': sig }, raw, secret), { ok: true, provider: 'bitbucket', event: 'repo:push' });
  assert.equal(H.verify({ 'x-event-key': 'repo:refs_changed', 'x-request-id': 'r', 'x-hub-signature': sig }, raw, secret).provider, 'bitbucket-server');
  assert.deepEqual(H.verify({ authorization: `Bearer ${secret}` }, raw, secret), { ok: true, provider: 'ci', event: 'run' });
  assert.equal(H.verify({ authorization: 'Bearer x' }, raw, '').ok, false);
  const gh = H.parse('github', 'push', { ref: 'refs/heads/main', after: 'a1', head_commit: { message: 'Fix' }, pusher: { name: 'ann' }, repository: { full_name: 'o/r' } });
  assert.deepEqual([gh.branch, gh.sha, gh.author, gh.repo, gh.api], ['main', 'a1', 'ann', 'o/r', 'https://api.github.com']);
  assert.ok(H.parse('github', 'push', { ref: 'refs/tags/v1' }).ignored); assert.ok(H.parse('github', 'ping', { zen: 'x' }).ping);
  const gl = H.parse('gitlab', 'Push Hook', { ref: 'refs/heads/dev', checkout_sha: 'b2', after: 'b2', user_name: 'bob', project_id: 7, project: { path_with_namespace: 'g/p', web_url: 'https://git.example.com/g/p' }, commits: [{ id: 'b2', message: 'Add' }] });
  assert.deepEqual([gl.branch, gl.sha, gl.message, gl.api, gl.projectId], ['dev', 'b2', 'Add', 'https://git.example.com/api/v4', 7]);
  const bb = H.parse('bitbucket', 'repo:push', { actor: { display_name: 'Cem' }, repository: { full_name: 'w/r' }, push: { changes: [{ new: { type: 'branch', name: 'main', target: { hash: 'c3', message: 'Go' } } }] } });
  assert.deepEqual([bb.branch, bb.sha, bb.author, bb.repo], ['main', 'c3', 'Cem', 'w/r']);
  const bs = H.parse('bitbucket-server', 'repo:refs_changed', { actor: { displayName: 'Dan' }, repository: { slug: 'r', project: { key: 'P' }, links: { self: [{ href: 'https://bb.example.com/projects/P/repos/r/browse' }] } }, changes: [{ ref: { displayId: 'main', type: 'BRANCH' }, toHash: 'd4', type: 'UPDATE' }] });
  assert.deepEqual([bs.branch, bs.sha, bs.repo, bs.api], ['main', 'd4', 'P/r', 'https://bb.example.com']);
  assert.equal(H.branchMatch('', 'x'), true); assert.equal(H.branchMatch('main', 'dev'), false); assert.equal(H.branchMatch('main, release/*', 'release/1.2'), true);
  // commit status: the right endpoint and body per provider (fetch stubbed)
  const calls = []; const realFetch = global.fetch;
  global.fetch = async (u, o) => { calls.push({ u, o }); return { ok: true, text: async () => '' }; };
  try {
    await H.statusPoster('github', gh, 'ghp_x', 'https://dg.example.com/')('pending', 'running');
    await H.statusPoster('gitlab', gl, 'glpat', null)('failure', 'failed');
    await H.statusPoster('bitbucket', bb, 'user:app-pass', null)('success', 'ok');
  } finally { global.fetch = realFetch; }
  assert.equal(calls[0].u, 'https://api.github.com/repos/o/r/statuses/a1'); assert.equal(JSON.parse(calls[0].o.body).state, 'pending'); assert.equal(calls[0].o.headers.Authorization, 'Bearer ghp_x');
  assert.equal(calls[1].u, 'https://git.example.com/api/v4/projects/7/statuses/b2'); assert.equal(JSON.parse(calls[1].o.body).state, 'failed'); assert.equal(calls[1].o.headers['PRIVATE-TOKEN'], 'glpat');
  assert.equal(calls[2].u, 'https://api.bitbucket.org/2.0/repositories/w/r/commit/c3/statuses/build'); assert.equal(JSON.parse(calls[2].o.body).state, 'SUCCESSFUL'); assert.match(calls[2].o.headers.Authorization, /^Basic /);
});

test('Webhook route: a signed GitHub push runs the recipe; a wrong signature, another branch and a ping do not', async () => {
  const R = require('../../server/task-recipes');
  const express = require('express');
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/hooks', require('../../server/routes/hooks'));
  const srv = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/hooks/deploy`;
  try {
    const rec = R.save('srv-t', PROJ, { name: 'Hooked', steps: [{ type: 'task', source: 'make', name: 'hello' }], hookBranch: 'main', settings: { notify: { fail: false } } });
    const { hookId, secret } = R.enableHook(rec.id);
    const post = (body, headers) => fetch(`${base}/${hookId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const push = (branch) => JSON.stringify({ ref: `refs/heads/${branch}`, after: 'f'.repeat(40), head_commit: { message: 'm' }, pusher: { name: 'ann' }, repository: { full_name: 'o/r' } });
    const sign = (b) => 'sha256=' + require('crypto').createHmac('sha256', secret).update(b).digest('hex');
    let b = push('main');
    assert.equal((await post(b, { 'x-github-event': 'push', 'x-hub-signature-256': sign(b) + 'x' })).status, 401);
    assert.equal((await fetch(`${base}/${'0'.repeat(24)}`, { method: 'POST' })).status, 404);
    const ping = JSON.stringify({ zen: 'hi' });
    assert.deepEqual(await (await post(ping, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(ping) })).json(), { ok: true, pong: true, recipe: 'Hooked' });
    b = push('dev'); let r = await post(b, { 'x-github-event': 'push', 'x-hub-signature-256': sign(b) });
    assert.equal(r.status, 202); assert.match((await r.json()).ignored, /branch dev/);
    b = push('main'); r = await post(b, { 'x-github-event': 'push', 'x-hub-signature-256': sign(b) });
    assert.equal(r.status, 202); const { run } = await r.json(); assert.ok(run);
    for (let i = 0; i < 100 && TK.runLog(run).status === 'running'; i++) await new Promise(res => setTimeout(res, 100));
    const log = TK.runLog(run); assert.equal(log.status, 'ok'); assert.match(log.text, /webhook:github — ann: main ffffffffff/);
    // CI with the token
    r = await post(JSON.stringify({ branch: 'main', commit: 'ci1' }), { authorization: `Bearer ${secret}` });
    assert.equal(r.status, 202);
    for (let i = 0; i < 100 && TK.runs('srv-t', PROJ)[0].status === 'running'; i++) await new Promise(res => setTimeout(res, 100));
    assert.equal(TK.runs('srv-t', PROJ)[0].trigger, 'ci');
  } finally { srv.close(); }
});

test('Queue: a push during a deploy waits (the newest wins, the older is marked skipped) and starts after; manual: 409, queue, replace', async () => {
  const R = require('../../server/task-recipes');
  const rec = R.save('srv-t', PROJ, { name: 'Slow', steps: [{ type: 'command', cmd: 'echo "deploying $(date +%s%N)"; sleep 2' }], settings: { notify: { fail: false } } });
  const waitDone = async (id) => { for (let i = 0; i < 200; i++) { const r = TK.runLog(id); if (r.status !== 'running') return r; await new Promise(res => setTimeout(res, 100)); } throw new Error('still running'); };
  const statuses = [];
  const st = (sha) => async (state, d) => { statuses.push(`${sha}:${state}`); };
  const first = await R.run(rec.id, { trigger: 'manual' });
  await assert.rejects(R.run(rec.id, { trigger: 'manual' }), (e) => e.code === 'BUSY' && e.run === first.id);
  const q1 = await R.run(rec.id, { trigger: 'webhook:github', git: { sha: 'aaa111', branch: 'main', author: 'ann' }, status: st('aaa111') });
  assert.deepEqual([q1.queued, q1.id, q1.replaced], [true, first.id, false]);
  const q2 = await R.run(rec.id, { trigger: 'webhook:github', git: { sha: 'bbb222', branch: 'main', author: 'bob' }, status: st('bbb222') });
  assert.equal(q2.replaced, true);
  assert.equal(R.list('srv-t', PROJ).find(x => x.id === rec.id).waiting.what, 'main bbb222 (bob)');
  const r1 = await waitDone(first.id);
  assert.equal(r1.status, 'ok'); assert.match(r1.text, /⏳ Queued — webhook:github: main aaa111/); assert.match(r1.text, /⏳ Queued \(replaces the one that waited\)/);
  await new Promise(res => setTimeout(res, 300));
  const next = TK.runs('srv-t', PROJ)[0];
  assert.notEqual(next.id, first.id); assert.equal(next.trigger, 'webhook:github');
  assert.deepEqual(statuses.slice(0, 3), ['aaa111:pending', 'aaa111:skipped', 'bbb222:pending']);
  const r2 = await waitDone(next.id);
  assert.match(r2.text, /bob\): main bbb222|— bob: main bbb222/); assert.ok(statuses.includes('bbb222:success'));
  assert.equal(R.sameCommitRecently(rec.id, 'bbb222'), true); assert.equal(R.sameCommitRecently(rec.id, 'zzz'), false);
  // manual "replace": the running one is cancelled, then the new one runs
  const a = await R.run(rec.id, { trigger: 'manual' });
  await new Promise(res => setTimeout(res, 300));
  const rep = await R.run(rec.id, { trigger: 'manual', mode: 'replace' });
  assert.equal(rep.queued, true);
  assert.match((await waitDone(a.id)).status, /cancelled/);
  await new Promise(res => setTimeout(res, 300));
  const b = TK.runs('srv-t', PROJ)[0]; assert.notEqual(b.id, a.id);
  assert.equal((await waitDone(b.id)).status, 'ok');
  R.remove(rec.id);
});

test('Webhook guards: delivery seen before, same commit, CI force, rate limit, wrong signatures block, body size', async () => {
  const R = require('../../server/task-recipes');
  const express = require('express');
  const hooks = require('../../server/routes/hooks');
  const app = express();
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/hooks', hooks);
  const srv = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/hooks/deploy`;
  try {
    hooks._reset();
    const rec = R.save('srv-t', PROJ, { name: 'Guarded', steps: [{ type: 'task', source: 'make', name: 'hello' }], settings: { notify: { fail: false } } });
    const { hookId, secret } = R.enableHook(rec.id);
    const sign = (b) => 'sha256=' + require('crypto').createHmac('sha256', secret).update(b).digest('hex');
    const push = (sha) => JSON.stringify({ ref: 'refs/heads/main', after: sha, head_commit: { message: 'm' }, pusher: { name: 'ann' }, repository: { full_name: 'o/r' } });
    const gh = (b, delivery) => fetch(`${base}/${hookId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sign(b), 'x-github-delivery': delivery }, body: b });
    const settle = async () => { for (let i = 0; i < 100 && TK.runs('srv-t', PROJ)[0].status === 'running'; i++) await new Promise(res => setTimeout(res, 100)); };
    let r = await gh(push('c'.repeat(40)), 'd-1'); assert.equal(r.status, 202); assert.ok((await r.json()).run); await settle();
    r = await gh(push('c'.repeat(40)), 'd-1'); assert.deepEqual(await r.json(), { ok: true, duplicate: true, ignored: 'this delivery was taken already' });
    r = await gh(push('c'.repeat(40)), 'd-2'); assert.match((await r.json()).ignored, /deployed less than 2 minutes ago/);
    const ci = (body) => fetch(`${base}/${hookId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    r = await ci({ branch: 'main', commit: 'c'.repeat(40) }); assert.match((await r.json()).ignored, /force/);
    r = await ci({ branch: 'main', commit: 'c'.repeat(40), force: true }); assert.equal(r.status, 202); assert.ok((await r.json()).run); await settle();
    // body over 1 MB
    const big = JSON.stringify({ ref: 'refs/heads/main', pad: 'x'.repeat(1100000) });
    assert.equal((await gh(big, 'd-big')).status, 413);
    // wrong signatures: 20 → the address is blocked, even with a good one
    hooks._reset();
    for (let i = 0; i < 20; i++) { const x = await fetch(`${base}/${hookId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }, body: '{}' }); assert.equal(x.status, 401); }
    r = await gh(push('d'.repeat(40)), 'd-3'); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 800);
    const refused = require('../../server/db').db.prepare("SELECT count(*) n FROM activity WHERE action = 'hook_refused'").get();
    assert.ok(refused.n <= 3, `one audit line per window, not per request (got ${refused.n})`);
    // 30 a minute
    hooks._reset();
    let last;
    for (let i = 0; i < 31; i++) last = await fetch(`${base}/${hookId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sign('{"zen":"z"}') }, body: '{"zen":"z"}' });
    assert.equal(last.status, 429);
    hooks._reset(); R.remove(rec.id);
  } finally { srv.close(); }
});

test('Kamal: rollback needs a version; the versions are read from kamal app containers', async () => {
  assert.throws(() => P.command({ source: 'kamal', name: 'rollback' }), /needs the version/);
  assert.equal(P.command({ source: 'kamal', name: 'rollback' }, { args: 'abc1234' }), "kamal rollback 'abc1234'");
  const bin = path.join(HOME, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'kamal'), '#!/bin/bash\necho "App Host: 10.0.0.5"\necho "CONTAINER ID   IMAGE   NAMES"\necho "1a2b   reg/app:9f8e7d6c5b4a   app-web-9f8e7d6c5b4a"\necho "3c4d   reg/app:1234567abcde   app-web-1234567abcde"\necho "5e6f   reg/app:9f8e7d6c5b4a   app-workers-9f8e7d6c5b4a"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  const r = await TK.kamalVersions('srv-t', PROJ);
  assert.equal(r.ok, true); assert.deepEqual(r.versions, ['9f8e7d6c5b4a', '1234567abcde']); assert.match(r.output, /App Host/);
  fs.unlinkSync(path.join(HOME, '.bash_profile'));
});

test('Several servers: the folder env of the recipe server reaches every server; a server value wins', async () => {
  const R = require('../../server/task-recipes');
  db.prepare("INSERT OR REPLACE INTO servers (id, type, host, port, username) VALUES ('srv-t2', 'ssh', '127.0.0.2', 22, 'deploy')").run();
  TK.envSet('srv-t', PROJ, [{ key: 'STAGE', value: 'prod' }, { key: 'REGION', value: 'eu' }]);
  TK.envSet('srv-t2', PROJ, [{ key: 'REGION', value: 'us' }]);
  const rec = R.save('srv-t', PROJ, { name: 'Two', steps: [{ type: 'command', cmd: 'echo "stage=$STAGE region=$REGION"' }], settings: { servers: ['srv-t', 'srv-t2'], notify: { fail: false } } });
  const { id } = await R.run(rec.id);
  let r; for (let i = 0; i < 100; i++) { r = TK.runLog(id); if (r.status !== 'running') break; await new Promise(res => setTimeout(res, 100)); }
  assert.equal(r.status, 'ok');
  assert.match(r.text, /127\.0\.0\.1[\s\S]*stage=prod region=eu[\s\S]*127\.0\.0\.2[\s\S]*stage=prod region=us/);
  R.remove(rec.id);
});

test('Local server: a task and a recipe run where DockGate runs, with the folder env', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-local-task-'));
  fs.writeFileSync(path.join(d, 'Makefile'), 'hello: ## say hello\n\t@echo hello $$WHO\n');
  TK.envSet('local', d, [{ key: 'WHO', value: 'local-world', secret: false }]);
  const info = await TK.discover('local', d);
  assert.ok(info.tasks.some(t => t.source === 'make' && t.name === 'hello'));
  const { id } = await TK.start('local', d, { source: 'custom', cmd: 'echo "hi $WHO from $(pwd)"' });
  const r = await wait(id);
  assert.equal(r.status, 'ok'); assert.match(r.text, new RegExp(`hi local-world from ${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const R = require('../../server/task-recipes');
  const rc = R.save('local', d, { name: 'Local deploy', steps: [{ type: 'command', cmd: 'echo step-one' }, { type: 'command', cmd: 'test -f Makefile' }] });
  const run = await R.run(rc.id, { trigger: 'manual' });
  const rr = await wait(run.id);
  assert.equal(rr.status, 'ok'); assert.match(rr.text, /step-one/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('One way to deploy: the stack webhook runs the folder recipe, and the recipe lands in the stack deploy history', async () => {
  const R = require('../../server/task-recipes');
  const { COMPOSE_DIR } = require('../../server/routes/compose-shared');
  const express = require('express');
  const project = 'rcdemo-' + Date.now().toString(36);
  const dir = path.join(COMPOSE_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, '.dockgate-git.json'), JSON.stringify({ repoUrl: 'https://example.invalid/r.git', branch: 'main', secret: 'k3y', serverId: 'local', deployMode: 'local' }));
  fs.writeFileSync(path.join(dir, '.dockgate-deploy.json'), JSON.stringify({ mode: 'local', serverId: 'local', workingDir: dir, composeFile: 'docker-compose.yml', source: 'git' }));
  // compose_up only in the recovery steps: the run does not need Docker, but it counts as a compose deploy
  const rec = R.save('local', dir, { name: 'Stack recipe', steps: [{ type: 'command', cmd: 'echo deployed-by-recipe' }], onFail: [{ type: 'compose_up', build: false }], settings: { notify: { fail: false } } });
  const app = express(); app.use(express.json()); app.use('/api/compose', require('../../server/routes/compose'));
  const srv = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}/api/compose/webhook/${project}`;
    assert.equal((await fetch(`${base}?key=wrong`, { method: 'POST' })).status, 403);
    const r = await (await fetch(`${base}?key=k3y`, { method: 'POST' })).json();
    assert.equal(r.recipe, 'Stack recipe'); assert.ok(r.run);
    const done = await wait(r.run);
    assert.equal(done.status, 'ok'); assert.match(done.text, /deployed-by-recipe/);
    let row = null;
    for (let i = 0; i < 50 && !row; i++) { row = db.prepare("SELECT * FROM compose_deploys WHERE project = ? AND kind = 'recipe'").get(project); if (!row) await new Promise(x => setTimeout(x, 100)); }
    assert.ok(row, 'the recipe run is in the stack deploy history');
    assert.equal(row.status, 'done'); assert.equal(row.server_id, 'local');
    assert.equal(JSON.parse(row.details).recipe, 'Stack recipe');
    R.remove(rec.id);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('One way to deploy: a Git sync schedule runs the folder recipe when the branch moved, then not again', async () => {
  const R = require('../../server/task-recipes');
  const { COMPOSE_DIR } = require('../../server/routes/compose-shared');
  const compose = require('../../server/routes/compose');
  const sh = (cwd, cmd) => require('child_process').execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sync-')) + '/r.git';
  sh(os.tmpdir(), `git init -q --bare ${bare}`);
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sync-src-'));
  sh(src, 'git init -q && echo a > a && git add a && git -c user.name=t -c user.email=t@t commit -qm one && git branch -M main');
  sh(src, `git push -q ${bare} main`);
  const head = sh(src, 'git rev-parse HEAD');
  const project = 'rcsync-' + Date.now().toString(36);
  const dir = path.join(COMPOSE_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.dockgate-git.json'), JSON.stringify({ repoUrl: 'file://' + bare, branch: 'main', serverId: 'local', deployMode: 'local', deployedCommit: '' }));
  fs.writeFileSync(path.join(dir, '.dockgate-deploy.json'), JSON.stringify({ mode: 'local', serverId: 'local', workingDir: dir, composeFile: 'docker-compose.yml', source: 'git' }));
  const rec = R.save('local', dir, { name: 'Sync recipe', steps: [{ type: 'command', cmd: 'echo synced' }], settings: { notify: { fail: false } } });
  try {
    const out = await compose.scheduledGitSync('local', [project]);
    assert.equal(out.length, 1); assert.equal(out[0].status, 'deployed'); assert.match(out[0].message, /recipe Sync recipe/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.dockgate-git.json'), 'utf8')).deployedCommit, head, 'the deployed commit moves on');
    const again = await compose.scheduledGitSync('local', [project]);
    assert.equal(again[0].status, 'unchanged');
  } finally { R.remove(rec.id); fs.rmSync(dir, { recursive: true, force: true }); }
});
