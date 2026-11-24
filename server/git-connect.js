// Connect to Git: turn a folder that was uploaded (no .git) into a checkout of a Git repository, in place.
// The folder, the Compose project name and the volumes stay as they are; only the files the repository
// has are written. Steps: check (access, branches), compare (a throw-away git dir reads the repository
// against the folder - nothing in the folder changes), connect (backup of every file that will be
// replaced, then git init + fetch + checkout), undo (from that backup). When the repository is empty,
// "first push" makes the first commit from the folder (with a .gitignore) and pushes it.
// Works on the local DockGate host and on SSH servers (same shell commands, run over SSH).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./paths');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const err = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });
const REG = () => path.join(DATA_DIR, 'git-connect.json');
const LOCAL_BACKUPS = () => path.join(DATA_DIR, 'git-connect-backups');
const REMOTE_BACKUPS = '$HOME/.dockgate/git-connect-backups';
const DG_EXCLUDE = ['.dockgate-*', '.dockgate-*/'];
const SENSITIVE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials\.json|secrets?\.(json|ya?ml))$/i;
const SAFE_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist)$/i;
const DENY_DIRS = new Set(['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var', '/opt', '/srv', '/home', '/root', '/boot', '/proc', '/sys', '/dev', '/tmp', '/run', '/mnt', '/media']);

// ---------- where it runs ----------
function safeDir(d) {
  const s = String(d || '').trim().replace(/\/+$/, '');
  if (!s.startsWith('/') && !s.startsWith('~/')) throw err('The folder must be an absolute path');
  if (s.includes('..') || /[\n\r\0'"`$\\]/.test(s) || !/^[~\w./@+ :=,-]+$/.test(s)) throw err('The folder path has characters DockGate does not accept');
  if (DENY_DIRS.has(s) || s === '~') throw err(`DockGate will not turn ${s} into a Git checkout - pick the project's own folder`);
  return s;
}

/** The place commands run: { serverId, remote, server, dir, sh(cmd, opts) }. */
async function target(serverId, dir) {
  const d = safeDir(dir);
  const sid = serverId || 'local';
  if (sid === 'local') {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw err(`The folder ${d} does not exist here`, 404);
    const sh = (cmd, { cwd = d, timeout = 180000 } = {}) => new Promise((resolve) => {
      execFile('sh', ['-c', cmd], { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
        (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(stdout || ''), err: String(stderr || (e && !stdout ? e.message : '') || '') }));
    });
    return { serverId: 'local', remote: false, server: null, dir: d, sh };
  }
  const { stmts } = require('./db');
  const server = stmts.getServer.get(sid);
  if (!server) throw err('Server not found', 404);
  const RC = require('./remote-compose');
  let rd = d;
  if (d.startsWith('~')) rd = await RC.resolveRemotePath(server, d);
  const sh = async (cmd, { cwd = rd } = {}) => {
    const r = await RC.execRemote(server, `cd ${shq(cwd)} && LC_ALL=C GIT_TERMINAL_PROMPT=0 sh -c ${shq(cmd)}`);
    return { code: r.code, out: String(r.stdout || ''), err: String(r.stderr || '') };
  };
  const probe = await sh('pwd');
  if (probe.code !== 0) throw err(`The folder ${rd} does not exist on ${server.name || server.host}`, 404);
  return { serverId: sid, remote: true, server, dir: rd, sh };
}

// ---------- repository access ----------
function checkUrl(u) {
  const s = String(u || '').trim();
  if (process.env.DG_GITCONNECT_ALLOW_FILE === '1' && /^file:\/\/\/[\w./-]+$/.test(s)) return s; // tests
  if (!/^(https:\/\/[\w.-]+(:\d+)?\/[\w./~%+-]+|ssh:\/\/[\w.@-]+(:\d+)?\/[\w./~%+-]+|[\w.-]+@[\w.-]+:[\w./~%+-]+)$/.test(s)) throw err('Use the repository\'s HTTPS URL (https://github.com/owner/repo) or SSH URL (git@github.com:owner/repo.git)');
  return s;
}
function checkBranch(b) {
  const s = String(b || '').trim();
  if (!s || s.length > 100 || s.startsWith('-') || s.includes('..') || !/^[\w./-]+$/.test(s) || /\/$|\.lock$/.test(s)) throw err('Branch name is not valid');
  return s;
}
const isSshUrl = (u) => /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(u);
const urlWithToken = (url, token) => (token && /^https:\/\//i.test(url) ? url.replace(/^https:\/\//i, `https://${encodeURIComponent(token)}@`) : url);
/** Hide tokens in anything shown back. */
function redact(s, auth) {
  let t = String(s || '').replace(/\/\/[^@/\s]+@/g, '//***@');
  if (auth && auth.token) t = t.split(auth.token).join('***').split(encodeURIComponent(auth.token)).join('***');
  return t;
}
function normAuth(a = {}) {
  const repoUrl = checkUrl(a.repoUrl);
  const keyId = a.keyId ? String(a.keyId) : '';
  if (keyId && !isSshUrl(repoUrl)) throw err('With an SSH key, use the SSH URL (git@github.com:owner/repo.git)');
  return { repoUrl, token: keyId ? '' : String(a.token || '').trim(), keyId };
}
async function sshCmd(t, auth) {
  let key = '';
  if (auth.keyId) key = t.remote ? await require('./remote-compose').ensureRemoteKey(t.server, auth.keyId) : require('./ssh-keys').persistDeployKey(auth.keyId);
  return key ? `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new` : 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
}
async function gitEnv(t, auth) { return `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${shq(await sshCmd(t, auth))}`; }
function fail(r, what, auth) {
  const msg = redact((r.err || r.out || '').trim().split('\n').filter(Boolean).slice(-4).join(', '), auth);
  let hint = '';
  if (/Authentication failed|could not read Username|403|Permission denied \(publickey\)|Repository not found|not found/i.test(msg)) hint = ' - check the URL and that the token / deploy key can read this repository';
  if (/remote rejected|protected branch|Permission to .* denied|403/i.test(msg) && /push/i.test(what)) hint = ' - the token / key needs write access to push';
  return err(`${what} failed: ${msg || 'exit ' + r.code}${hint}`);
}

async function gitInstalled(t) { return (await t.sh('command -v git')).code === 0; }
async function gitRoot(t) { const r = await t.sh('git rev-parse --show-toplevel 2>/dev/null'); return r.code === 0 ? r.out.trim() : ''; }

/** Access check: the repository's branches, its default branch, empty or not; and the folder's state. */
async function check(t, a) {
  const auth = normAuth(a);
  if (!(await gitInstalled(t))) throw err(t.remote ? 'git is not installed on this server - install it (apt-get install -y git / dnf install -y git), then try again' : 'git is not installed here');
  const root = await gitRoot(t);
  const env = await gitEnv(t, auth);
  const r = await t.sh(`${env} git ls-remote --symref ${shq(urlWithToken(auth.repoUrl, auth.token))}`);
  if (r.code !== 0) throw fail(r, 'Reading the repository', auth);
  const branches = []; let defaultBranch = '';
  for (const line of r.out.split('\n')) {
    const m = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/); if (m) { defaultBranch = m[1]; continue; }
    const b = line.match(/^[0-9a-f]{40}\s+refs\/heads\/(\S+)$/); if (b) branches.push(b[1]);
  }
  const files = parseInt((await t.sh("find . -path ./.git -prune -o -path ./node_modules -prune -o -type f -print 2>/dev/null | grep -v '/\\.dockgate-' | head -100001 | wc -l")).out.trim(), 10) || 0;
  return { dir: t.dir, server: t.serverId, isGit: !!root, gitRoot: root, branches, defaultBranch: defaultBranch || branches[0] || '', empty: branches.length === 0, files };
}

// ---------- compare (a throw-away git dir; the folder is not touched) ----------
const sessions = new Map(); // id -> { t, auth, branch, gdir, lists, at }
const TTL = 30 * 60 * 1000;
async function sweep() {
  for (const [id, s] of sessions) if (Date.now() - s.at > TTL) { sessions.delete(id); await s.t.sh(`rm -rf ${shq(s.gdir)}`).catch(() => {}); }
}
function splitZ(out) { return out.split('\0').filter(Boolean); }

async function compare(t, a, branchIn, { composeRel = '' } = {}) {
  await sweep();
  const auth = normAuth(a); const branch = checkBranch(branchIn);
  if (await gitRoot(t)) throw err('This folder is a Git checkout already - use Pull / Sync on it');
  if (!(await gitInstalled(t))) throw err('git is not installed on this server');
  const mk = await t.sh('mktemp -d /tmp/dg-gitconnect-XXXXXX');
  if (mk.code !== 0) throw fail(mk, 'Making a temporary folder');
  const gdir = mk.out.trim(); const G = `git --git-dir=${shq(gdir)}`; const W = `${G} --work-tree=. -c core.fileMode=false -c core.quotePath=false`;
  const env = await gitEnv(t, auth);
  const ref = `refs/remotes/origin/${branch}`;
  const steps = [
    `${G} init -q`,
    `${env} ${G} fetch -q --depth 1 ${shq(urlWithToken(auth.repoUrl, auth.token))} ${shq(`+refs/heads/${branch}:${ref}`)}`,
    `{ ${G} show ${shq(ref + ':.gitignore')} 2>/dev/null; printf '\\n${DG_EXCLUDE.join('\\n')}\\n'; } > ${shq(gdir + '/info/exclude')}`,
    `${W} read-tree ${shq(ref)}`,
  ];
  for (const s of steps) {
    const r = await t.sh(s);
    if (r.code !== 0) { await t.sh(`rm -rf ${shq(gdir)}`); throw fail(r, /fetch/.test(s) ? `Fetching branch ${branch}` : 'Reading the repository', auth); }
  }
  const st = await t.sh(`${W} status --porcelain=v1 -z --untracked-files=normal --ignored=traditional`);
  if (st.code !== 0) { await t.sh(`rm -rf ${shq(gdir)}`); throw fail(st, 'Comparing'); }
  const repoFiles = splitZ((await t.sh(`${G} ls-tree -r -z --name-only ${shq(ref)}`)).out);
  const head = (await t.sh(`${G} log -1 --format=%h%x09%s ${shq(ref)}`)).out.trim().split('\t');
  const lists = { differs: [], onlyRepo: [], onlyServer: [], ignored: [] };
  for (const e of splitZ(st.out)) {
    const x = e.slice(0, 2), p = e.slice(3);
    if (/(^|\/)\.dockgate-/.test(p)) continue; // DockGate's own records stay out of the lists
    if (x === '??') lists.onlyServer.push(p);
    else if (x === '!!') lists.ignored.push(p);
    else if (x[1] === 'M' || x[1] === 'T') lists.differs.push(p);
    else if (x[1] === 'D') lists.onlyRepo.push(p);
  }
  const same = repoFiles.length - lists.differs.length - lists.onlyRepo.length;
  const sensitive = lists.onlyServer.filter(p => SENSITIVE.test(p.replace(/\/$/, '')) && !SAFE_EXAMPLE.test(p));
  const repoHasGitignore = repoFiles.includes('.gitignore');
  const composeInRepo = composeRel ? repoFiles.includes(composeRel) : null;
  const id = crypto.randomBytes(8).toString('hex');
  sessions.set(id, { t, auth, branch, gdir, lists, at: Date.now() });
  const cap = (l) => l.slice(0, 1000);
  return {
    session: id, branch, commit: { hash: head[0] || '', subject: head[1] || '' }, repoFiles: repoFiles.length, same,
    differs: cap(lists.differs), onlyRepo: cap(lists.onlyRepo), onlyServer: cap(lists.onlyServer), ignored: cap(lists.ignored),
    counts: { differs: lists.differs.length, onlyRepo: lists.onlyRepo.length, onlyServer: lists.onlyServer.length, ignored: lists.ignored.length },
    sensitive, repoHasGitignore, composeRel, composeInRepo,
  };
}

function session(id) {
  const s = sessions.get(String(id || ''));
  if (!s || Date.now() - s.at > TTL) throw err('The comparison is too old - compare again', 410);
  s.at = Date.now();
  return s;
}

/** The change one file gets: − what the server has now, + what it has after connecting. */
async function diff(id, file) {
  const s = session(id);
  if (!s.lists.differs.includes(file)) throw err('That file is not in the list of changed files');
  const W = `git --git-dir=${shq(s.gdir)} --work-tree=. -c core.fileMode=false`;
  const r = await s.t.sh(`${W} diff --no-color -R ${shq('refs/remotes/origin/' + s.branch)} -- ${shq(file)} | head -c 300000`);
  return { file, diff: r.out };
}

// ---------- backups registry ----------
function readReg() { try { return JSON.parse(fs.readFileSync(REG(), 'utf8')); } catch (e) { return { backups: [] }; } }
function writeReg(r) { fs.mkdirSync(path.dirname(REG()), { recursive: true }); fs.writeFileSync(REG(), JSON.stringify(r, null, 2), { mode: 0o600 }); }
function listBackups(serverId, dir) {
  return readReg().backups.filter(b => (!serverId || b.serverId === serverId) && (!dir || b.dir === dir)).sort((a, b) => b.at - a.at);
}
async function backupDir(t) {
  if (!t.remote) { fs.mkdirSync(LOCAL_BACKUPS(), { recursive: true }); return LOCAL_BACKUPS(); }
  const r = await t.sh(`mkdir -p ${REMOTE_BACKUPS} && chmod 700 ${REMOTE_BACKUPS} && cd ${REMOTE_BACKUPS} && pwd`);
  if (r.code !== 0) throw fail(r, 'Making the backup folder');
  return r.out.trim();
}
async function writeList(t, file, items) { // NUL-separated list of paths for tar -T --null
  const b64 = Buffer.from(items.join('\0') + (items.length ? '\0' : ''), 'utf8').toString('base64');
  const r = await t.sh(`printf %s ${shq(b64)} | base64 -d > ${shq(file)}`);
  if (r.code !== 0) throw fail(r, 'Writing the backup list');
}
/** Pack the files that will be replaced; record what is added. Returns the registry entry. */
async function makeBackup(t, kind, { overwritten = [], added = [], repoUrl = '', branch = '', createdGitignore = false, project = '' }) {
  const bdir = await backupDir(t);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const tar = `${bdir}/${id}.tar.gz`;
  if (overwritten.length) {
    const list = `${bdir}/${id}.list`;
    await writeList(t, list, overwritten);
    const r = await t.sh(`tar czf ${shq(tar)} --null -T ${shq(list)} && rm -f ${shq(list)}`);
    if (r.code !== 0) throw fail(r, 'The backup');
  }
  const entry = { id, kind, serverId: t.serverId, dir: t.dir, project, repoUrl: redact(repoUrl), branch, at: Date.now(), tar: overwritten.length ? tar : '', overwritten: overwritten.slice(0, 5000), added: added.slice(0, 20000), createdGitignore, undone: false };
  const reg = readReg(); reg.backups.push(entry); reg.backups = reg.backups.slice(-200); writeReg(reg);
  return entry;
}

// ---------- connect ----------
const locks = new Set();
async function withLock(t, fn) {
  const k = `${t.serverId}:${t.dir}`;
  if (locks.has(k)) throw err('Something is already being done in this folder', 409);
  locks.add(k);
  try { return await fn(); } finally { locks.delete(k); }
}

async function rollbackConnect(t, entry) {
  await t.sh('rm -rf .git');
  if (entry.tar) await t.sh(`tar xzf ${shq(entry.tar)}`);
  if (entry.added.length) {
    const list = `${await backupDir(t)}/${entry.id}.added`;
    await writeList(t, list, entry.added);
    await t.sh(`tr '\\0' '\\n' < ${shq(list)} | while IFS= read -r f; do [ -f "$f" ] && rm -f -- "$f"; d=$(dirname -- "$f"); [ "$d" != . ] && rmdir -p -- "$d" 2>/dev/null; done; rm -f ${shq(list)}`);
  }
}

/** Connect the folder: backup -> git init -> fetch -> checkout (files of the repository win, others stay). */
async function connect(id, { keep = [], project = '' } = {}) {
  const s = session(id); const t = s.t; const auth = s.auth; const branch = s.branch;
  return withLock(t, async () => {
    if (await gitRoot(t)) throw err('This folder became a Git checkout meanwhile - nothing was changed');
    const keepSet = new Set((Array.isArray(keep) ? keep : []).filter(f => s.lists.differs.includes(f)));
    const entry = await makeBackup(t, 'connect', { overwritten: s.lists.differs, added: s.lists.onlyRepo, repoUrl: auth.repoUrl, branch, project });
    const env = await gitEnv(t, auth);
    const ref = `refs/remotes/origin/${branch}`;
    const steps = [
      ['Setting up Git', `git init -q && printf '${DG_EXCLUDE.join('\\n')}\\n' >> .git/info/exclude`],
      ['Adding the remote', `git remote add origin ${shq(urlWithToken(auth.repoUrl, auth.token))}`],
      ...(auth.keyId ? [['Saving the deploy key', `git config core.sshCommand ${shq(await sshCmd(t, auth))}`]] : []),
      [`Fetching ${branch}`, `${env} git fetch -q --depth 1 origin ${shq(`+refs/heads/${branch}:${ref}`)}`],
      ['Checking out the files', `git checkout -q -f -B ${shq(branch)} ${shq(ref)} && git branch -q --set-upstream-to=${shq('origin/' + branch)} ${shq(branch)}`],
    ];
    for (const [what, cmd] of steps) {
      const r = await t.sh(cmd);
      if (r.code !== 0) { await rollbackConnect(t, entry); markUndone(entry.id); throw fail(r, what, auth); }
    }
    if (keepSet.size && entry.tar) {
      const list = `${await backupDir(t)}/${entry.id}.keep`;
      await writeList(t, list, [...keepSet]);
      await t.sh(`tar xzf ${shq(entry.tar)} --null -T ${shq(list)}; rm -f ${shq(list)}`);
    }
    const head = (await t.sh('git log -1 --format=%h%x09%s')).out.trim().split('\t');
    const dirty = (await t.sh('git status --porcelain --untracked-files=no')).out.trim().split('\n').filter(Boolean);
    sessions.delete(id); await t.sh(`rm -rf ${shq(s.gdir)}`);
    return { connected: true, dir: t.dir, server: t.serverId, branch, repoUrl: redact(auth.repoUrl), commit: { hash: head[0], subject: head[1] || '' }, backup: entry.id, replaced: s.lists.differs.length - keepSet.size, kept: [...keepSet], added: s.lists.onlyRepo.length, localChanges: dirty.length };
  });
}

function markUndone(id) { const reg = readReg(); const b = reg.backups.find(x => x.id === id); if (b) { b.undone = true; writeReg(reg); } }

/** Undo a connect / first push from its backup: .git goes, replaced files come back, added files go. */
async function undo(backupId) {
  const entry = readReg().backups.find(b => b.id === backupId);
  if (!entry) throw err('Backup not found', 404);
  if (entry.undone) throw err('This one was undone already');
  const t = await target(entry.serverId, entry.dir);
  return withLock(t, async () => {
    if ((await t.sh('test -d .git')).code !== 0) throw err('This folder has no .git - nothing to undo');
    if (entry.kind === 'connect') await rollbackConnect(t, entry);
    else { await t.sh('rm -rf .git'); if (entry.createdGitignore) await t.sh('rm -f .gitignore'); }
    markUndone(entry.id);
    return { undone: true, dir: t.dir, server: t.serverId, restored: entry.overwritten.length, removed: entry.added.length };
  });
}

// ---------- first push (the repository is empty) ----------
const SUGGEST_DIRS = ['data', 'uploads', 'storage', 'logs', 'backups', 'tmp', '.venv', 'venv', '__pycache__', 'vendor', 'dist', 'build', '.next', 'coverage'];
async function suggestGitignore(t) {
  const has = await t.sh('cat .gitignore 2>/dev/null');
  if (has.code === 0 && has.out.trim()) return { exists: true, text: has.out };
  const dirs = (await t.sh(`for d in ${SUGGEST_DIRS.map(shq).join(' ')}; do [ -d "$d" ] && echo "$d"; done`)).out.split('\n').filter(Boolean);
  const lines = ['# secrets - keep them on the server only', '.env', '.env.*', '!.env.example', '*.pem', '*.key', '', '# dependencies and generated files', 'node_modules/', '*.log'];
  if (dirs.length) lines.push('', '# data folders of the running app', ...dirs.map(d => d + '/'));
  return { exists: false, text: lines.join('\n') + '\n' };
}

async function initPreview(t, gitignoreText) {
  if (await gitRoot(t)) throw err('This folder is a Git checkout already');
  const mk = await t.sh('mktemp -d /tmp/dg-gitinit-XXXXXX'); if (mk.code !== 0) throw fail(mk, 'Making a temporary folder');
  const gdir = mk.out.trim(); const G = `git --git-dir=${shq(gdir)} --work-tree=. -c core.quotePath=false`;
  try {
    const gi = String(gitignoreText || '');
    const b64 = Buffer.from(gi + '\n' + DG_EXCLUDE.join('\n') + '\n').toString('base64');
    let r = await t.sh(`git --git-dir=${shq(gdir)} init -q && printf %s ${shq(b64)} | base64 -d > ${shq(gdir + '/info/exclude')}`);
    if (r.code !== 0) throw fail(r, 'Preparing');
    r = await t.sh(`${G} add -A --dry-run`);
    if (r.code !== 0) throw fail(r, 'Listing the files');
    const files = r.out.split('\n').map(l => (l.match(/^add '(.*)'$/) || [])[1]).filter(Boolean);
    const big = (await t.sh("find . -path ./.git -prune -o -type f -size +50M -print 2>/dev/null | sed 's#^\\./##' | head -50")).out.split('\n').filter(Boolean).filter(f => files.includes(f));
    const sensitive = files.filter(f => SENSITIVE.test(f) && !SAFE_EXAMPLE.test(f));
    return { files: files.slice(0, 3000), count: files.length, sensitive, big };
  } finally { await t.sh(`rm -rf ${shq(gdir)}`); }
}

function checkIdentity(name, email) {
  const n = String(name || '').trim(), e = String(email || '').trim();
  if (!n || n.length > 100 || /[\n\r<>]/.test(n)) throw err('Give the name for the first commit');
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(e) || e.length > 200) throw err('Give an e-mail for the first commit');
  return { n, e };
}

async function initPush(t, a, { branch: b, gitignore, name, email, message, allowSensitive = false, project = '' } = {}) {
  const auth = normAuth(a); const branch = checkBranch(b || 'main');
  const { n, e } = checkIdentity(name, email);
  const msg = String(message || 'First commit from the server').slice(0, 500).replace(/\r/g, '');
  return withLock(t, async () => {
    const c = await check(t, auth);
    if (c.isGit) throw err('This folder is a Git checkout already');
    if (c.branches.includes(branch)) throw err(`The repository has a ${branch} branch already - use Connect to Git instead`);
    const gi = await suggestGitignore(t);
    const text = gi.exists ? gi.text : String(gitignore || gi.text);
    const pv = await initPreview(t, text);
    if (!pv.count) throw err('There is nothing to commit - every file is ignored');
    if (pv.sensitive.length && !allowSensitive) throw Object.assign(err(`These look like secrets and would be pushed: ${pv.sensitive.slice(0, 5).join(', ')} - add them to .gitignore`), { sensitive: pv.sensitive });
    if (pv.big.length) throw err(`Files over 50 MB would be pushed (GitHub refuses over 100 MB): ${pv.big.slice(0, 5).join(', ')} - add them to .gitignore`);
    const entry = await makeBackup(t, 'init', { repoUrl: auth.repoUrl, branch, createdGitignore: !gi.exists, project });
    const env = await gitEnv(t, auth);
    const steps = [
      ...(gi.exists ? [] : [['Writing .gitignore', `printf %s ${shq(Buffer.from(text).toString('base64'))} | base64 -d > .gitignore`]]),
      ['Setting up Git', `git init -q && printf '${DG_EXCLUDE.join('\\n')}\\n' >> .git/info/exclude && git checkout -q -b ${shq(branch)}`],
      ['Making the first commit', `git add -A && git -c user.name=${shq(n)} -c user.email=${shq(e)} commit -q -m ${shq(msg)}`],
      ['Adding the remote', `git remote add origin ${shq(urlWithToken(auth.repoUrl, auth.token))}`],
      ...(auth.keyId ? [['Saving the deploy key', `git config core.sshCommand ${shq(await sshCmd(t, auth))}`]] : []),
      ['The push', `${env} git push -q -u origin ${shq(branch)}`],
    ];
    for (const [what, cmd] of steps) {
      const r = await t.sh(cmd);
      if (r.code !== 0) { await t.sh('rm -rf .git'); if (!gi.exists) await t.sh('rm -f .gitignore'); markUndone(entry.id); throw fail(r, what, auth); }
    }
    const head = (await t.sh('git log -1 --format=%h')).out.trim();
    return { pushed: true, dir: t.dir, server: t.serverId, branch, repoUrl: redact(auth.repoUrl), commit: head, files: pv.count + (gi.exists ? 0 : 1), backup: entry.id, wroteGitignore: !gi.exists };
  });
}

module.exports = { target, check, compare, diff, connect, undo, listBackups, suggestGitignore, initPreview, initPush, redact, _sessions: sessions, _safeDir: safeDir };
