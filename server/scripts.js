// Server Console → Scripts: scripts kept in DockGate's database per server and written to the server as files.
// Two kinds (spec.kind):
//   blocks — made with the Script Builder (script-builder.js); DockGate writes the file from the steps.
//   code   — your own shell: the file on the server is the text (edited with the file editor, Versions kept there).
//            spec.external: a script that was already on the server, added where it is (never moved or deleted).
// Every write is checked with bash -n first. A blocks script whose file was changed by hand is not replaced
// without asking (409 CHANGED) — keep the server's version (it becomes a code script) or write the steps again. Root-owned under /opt/dockgate/scripts when the SSH user has
// passwordless sudo (so a root cron job never runs a file another user can change), else ~/.dockgate/scripts.
const { db } = require('./db');
const B = require('./script-builder');
const remoteExec = require('./remote-compose');
const shq = remoteExec.shq;
const crypto = require('crypto');
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const err = (msg, statusCode, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const MAX_CODE = 512 * 1024;

db.exec(`CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL,
  path TEXT, updated_at INTEGER, deployed_at INTEGER, last_run_at INTEGER, last_code INTEGER, UNIQUE(server_id, name)
)`);
try { db.exec('ALTER TABLE scripts ADD COLUMN hash TEXT'); } catch (e) { /* already there */ }
const q = {
  list: db.prepare('SELECT * FROM scripts WHERE server_id = ? ORDER BY name'),
  get: db.prepare('SELECT * FROM scripts WHERE server_id = ? AND id = ?'),
  insert: db.prepare('INSERT INTO scripts (server_id, name, spec, updated_at) VALUES (?, ?, ?, ?)'),
  update: db.prepare('UPDATE scripts SET name = ?, spec = ?, updated_at = ? WHERE id = ?'),
  deployed: db.prepare('UPDATE scripts SET path = ?, deployed_at = ?, hash = ? WHERE id = ?'),
  insertFull: db.prepare('INSERT INTO scripts (server_id, name, spec, updated_at, path, deployed_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setSpec: db.prepare('UPDATE scripts SET spec = ?, updated_at = ? WHERE id = ?'),
  ran: db.prepare('UPDATE scripts SET last_run_at = ?, last_code = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM scripts WHERE id = ?'),
};
const row = (r) => r && ({ id: r.id, name: r.name, spec: JSON.parse(r.spec), kind: JSON.parse(r.spec).kind === 'code' ? 'code' : 'blocks', hash: r.hash || null, path: r.path, updatedAt: r.updated_at, deployedAt: r.deployed_at, lastRunAt: r.last_run_at, lastCode: r.last_code });

function list(serverId) { return q.list.all(serverId).map(row); }
function get(serverId, id) { return row(q.get.get(serverId, Number(id))); }

const uniq = (fn, name) => { try { return fn(); } catch (e) { if (/UNIQUE/.test(e.message)) throw err(`A script named ${name} exists on this server`, 400); throw e; } };

/** Save a blocks script (create or update) and write the file. A file changed by hand since DockGate wrote it
 *  → 409 CHANGED with the server's text, unless force. */
async function save(server, input, id = null, { force = false } = {}) {
  const spec = { kind: 'blocks', name: String(input.name || '').trim(), title: String(input.title || '').slice(0, 120), steps: input.steps || [] };
  const text = B.build(spec); // validates
  let sid = id ? Number(id) : null;
  const old = sid ? get(server.id, sid) : null;
  if (sid && !old) throw err('Script not found', 404);
  if (old && old.kind === 'code') throw err('This script is your own code — edit its file', 400);
  if (old && old.path && old.hash && !force) {
    const cur = await readText(server, old.path).catch(() => null);
    if (cur != null && sha(cur) !== old.hash) throw err('The file was changed on the server after DockGate wrote it', 409, { code: 'CHANGED', current: cur });
  }
  const now = Date.now();
  if (sid) uniq(() => q.update.run(spec.name, JSON.stringify(spec), now, sid), spec.name);
  else sid = uniq(() => q.insert.run(server.id, spec.name, JSON.stringify(spec), now).lastInsertRowid, spec.name);
  try {
    const path = await deploy(server, spec.name, text);
    if (old && old.path && old.path !== path) await removeFile(server, old.path);
    q.deployed.run(path, Date.now(), sha(text), sid);
  } catch (e) { if (!old) q.del.run(sid); throw e; }
  return get(server.id, sid);
}

/** A new code script: your own shell, written like a blocks script (root-owned under /opt/dockgate/scripts with sudo). */
async function createCode(server, input) {
  const name = String(input.name || '').trim();
  if (!B.NAME_RE.test(name)) throw err('Name: lowercase letters, digits, . _ - (up to 41)', 400);
  const code = String(input.code == null ? '' : input.code);
  if (!code.trim()) throw err('The script is empty', 400);
  if (code.length > MAX_CODE) throw err('The script is larger than 512 KB', 400);
  const spec = { kind: 'code', name, title: String(input.title || '').slice(0, 120) };
  const sid = uniq(() => q.insert.run(server.id, name, JSON.stringify(spec), Date.now()).lastInsertRowid, name);
  try {
    const path = await deploy(server, name, code);
    spec.root = path.startsWith('/opt/dockgate/');
    q.setSpec.run(JSON.stringify(spec), Date.now(), sid);
    q.deployed.run(path, Date.now(), sha(code), sid);
  } catch (e) { q.del.run(sid); throw e; }
  return get(server.id, sid);
}

/** A blocks script becomes code (one way). keepServer: the file stays as it is on the server (hand changes kept). */
function toCode(server, id) {
  const s = get(server.id, id); if (!s) throw err('Script not found', 404);
  if (s.kind === 'code') return s;
  const spec = { kind: 'code', name: s.name, title: s.spec.title || '', root: !!(s.path && s.path.startsWith('/opt/dockgate/')) };
  q.setSpec.run(JSON.stringify(spec), Date.now(), s.id);
  return get(server.id, s.id);
}

/** Rename the title (code scripts: the file keeps its name and place). */
function setTitle(server, id, title) {
  const s = get(server.id, id); if (!s) throw err('Script not found', 404);
  q.setSpec.run(JSON.stringify({ ...s.spec, title: String(title || '').slice(0, 120) }), Date.now(), s.id);
  return get(server.id, s.id);
}

// The file's text (sudo when the SSH user may not read it).
async function readText(server, path) {
  const f = shq(path);
  const r = await remoteExec.execRemote(server, `[ -f ${f} ] || exit 44; if [ -r ${f} ]; then cat -- ${f}; else sudo -n cat -- ${f}; fi`);
  if (r.code === 44) throw err('The file is not on the server', 404);
  if (r.code !== 0) throw err(String(r.stderr || 'Could not read the file').trim().slice(0, 200), 500);
  return String(r.stdout || '');
}

// Where scripts usually live; crontab lines that run a .sh file are added too.
const FIND_DIRS = ['/opt', '/root', '/home', '/usr/local/bin', '/usr/local/sbin', '/srv', '/var/www', '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly'];
const discoverScript = () => `S=; [ "$(id -u)" = 0 ] || { sudo -n true 2>/dev/null && S="sudo -n"; }
{ $S find ${FIND_DIRS.join(' ')} -maxdepth 4 -type f \\( -name '*.sh' -o -name '*.bash' \\) -size -512k -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '/opt/dockgate/scripts/*' -not -path '*/.dockgate/scripts/*' -not -path '/var/lib/docker/*' 2>/dev/null | head -400
  { crontab -l 2>/dev/null; $S crontab -l 2>/dev/null; $S cat /etc/crontab /etc/cron.d/* 2>/dev/null; } | grep -v '^[[:space:]]*#' | grep -oE '/[A-Za-z0-9._/-]+\\.(sh|bash)' | sed 's/^/CRON /'
} | sort -u | while read -r a b; do
  if [ "$a" = CRON ]; then p=$b; c=1; else p=$a; c=0; fi
  $S test -f "$p" || continue
  printf '%s\\t%s\\t%s\\n' "$c" "$($S stat -c '%s %Y %U' "$p" 2>/dev/null)" "$p"
done`;

/** Shell scripts found on the server that are not in the list yet: { path, size, mtime, owner, inCron }. */
async function discover(server) {
  const r = await remoteExec.execRemote(server, discoverScript());
  const known = new Set(list(server.id).map(s => s.path));
  const by = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    const [c, st, p] = line.split('\t'); if (!p || !p.startsWith('/')) continue;
    const [size, mtime, owner] = String(st || '').split(' ');
    const prev = by.get(p);
    by.set(p, { path: p, size: Number(size) || 0, mtime: (Number(mtime) || 0) * 1000, owner: owner || '', inCron: c === '1' || !!(prev && prev.inCron) });
  }
  return [...by.values()].filter(x => !known.has(x.path)).sort((a, b) => (b.inCron - a.inCron) || a.path.localeCompare(b.path));
}

/** Add a script that is already on the server. The file stays where it is; DockGate never moves or deletes it. */
async function addExisting(server, { path, name, title }) {
  const p = String(path || '').trim();
  if (!/^\/[^\0\n]+$/.test(p) || p.split('/').includes('..')) throw err('A full path is needed', 400);
  const n = String(name || '').trim() || require('path').posix.basename(p).replace(/\.(sh|bash)$/, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 41);
  if (!B.NAME_RE.test(n)) throw err('Name: lowercase letters, digits, . _ - (up to 41)', 400);
  if (list(server.id).some(s => s.path === p)) throw err('This file is in the list already', 400);
  const f = shq(p);
  const r = await remoteExec.execRemote(server, `[ -f ${f} ] || exit 44; sz=$(stat -c %s ${f}); [ "$sz" -le ${MAX_CODE} ] || exit 45; stat -c '%u %U' ${f}`);
  if (r.code === 44) throw err('No such file on the server', 404);
  if (r.code === 45) throw err('The file is larger than 512 KB', 400);
  if (r.code !== 0) throw err(String(r.stderr || 'Could not read the file').trim().slice(0, 200), 500);
  const uid = String(r.stdout || '').trim().split(' ')[0];
  const text = await readText(server, p);
  if (text.includes('\0')) throw err('Not a text file', 400);
  const spec = { kind: 'code', name: n, title: String(title || '').slice(0, 120), external: true, root: uid === '0' };
  const now = Date.now();
  const sid = uniq(() => q.insertFull.run(server.id, n, JSON.stringify(spec), now, p, now, sha(text)).lastInsertRowid, n);
  return get(server.id, sid);
}

async function deploy(server, name, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const r = await remoteExec.execRemote(server, `t=$(mktemp) && printf %s ${shq(b64)} | base64 -d > "$t" || exit 1
if ! e=$(bash -n "$t" 2>&1); then echo "$e" | sed "s|$t|${name}.sh|g"; rm -f "$t"; exit 42; fi
if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then S=; [ "$(id -u)" = 0 ] || S="sudo -n"; $S install -d -o root -g root -m 0755 /opt/dockgate/scripts && $S install -o root -g root -m 0750 "$t" /opt/dockgate/scripts/${name}.sh && echo "/opt/dockgate/scripts/${name}.sh"
else mkdir -p "$HOME/.dockgate/scripts" && install -m 0750 "$t" "$HOME/.dockgate/scripts/${name}.sh" && echo "$HOME/.dockgate/scripts/${name}.sh"; fi; rc=$?; rm -f "$t"; exit $rc`);
  if (r.code === 42) throw err(`bash -n: the script has a syntax error — ${String(r.stdout || '').trim().slice(0, 400)}`, 400, { code: 'SYNTAX' });
  const path = String(r.stdout || '').trim().split('\n').pop();
  if (r.code !== 0 || !path.startsWith('/')) throw err(`Could not write the script: ${String(r.stdout || r.stderr || '').trim().slice(0, 200)}`, 500);
  return path;
}

// Only files DockGate wrote (its own script folders) are ever deleted.
const removeFile = (server, path) => remoteExec.execRemote(server, `f=${shq(path)}; case "$f" in /opt/dockgate/scripts/*.sh) sudo -n rm -f "$f" 2>/dev/null || rm -f "$f";; */.dockgate/scripts/*.sh) rm -f "$f";; esac; true`);

async function remove(server, id) {
  const s = get(server.id, id); if (!s) throw err('Script not found', 404);
  if (s.path && !s.spec.external) await removeFile(server, s.path);
  q.del.run(s.id);
  return s;
}

const asRoot = (s) => s.path.startsWith('/opt/dockgate/') || !!s.spec.root;

/** Run it once (as root when the file is root's), up to 5 minutes; output and exit code. */
async function run(server, id) {
  const s = get(server.id, id); if (!s || !s.path) throw Object.assign(new Error('Script not found — save it first'), { statusCode: 404 });
  const root = asRoot(s);
  let timer;
  const r = await Promise.race([
    remoteExec.execRemote(server, `s=$(date +%s%N); ${root ? '{ [ "$(id -u)" = 0 ] && bash ' + shq(s.path) + ' || sudo -n bash ' + shq(s.path) + '; }' : 'bash ' + shq(s.path)} > /tmp/.dg-run-$$ 2>&1; rc=$?; e=$(date +%s%N); tail -c 30000 /tmp/.dg-run-$$; rm -f /tmp/.dg-run-$$; echo "__DGRUN__$rc $(( (e - s) / 1000000 ))"`),
    new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Still running after 5 minutes — it goes on on the server'), { statusCode: 504 })), 300000); }),
  ]).finally(() => clearTimeout(timer));
  const out = String(r.stdout || '') + String(r.stderr || '');
  const m = /__DGRUN__(\d+) (\d+)\s*$/.exec(out);
  const code = m ? Number(m[1]) : r.code;
  q.ran.run(Date.now(), code, s.id);
  return { output: out.replace(/__DGRUN__\d+ \d+\s*$/, '').trimEnd(), code, ms: m ? Number(m[2]) : null };
}

/** Schedule it in cron (root's crontab for a root script, else the SSH user's), with log and alerts. */
async function schedule(server, id, { schedule: sched, notify = ['fail'], log = true }) {
  const s = get(server.id, id); if (!s || !s.path) throw Object.assign(new Error('Script not found — save it first'), { statusCode: 404 });
  const source = asRoot(s) ? (server.username === 'root' ? 'user' : 'root') : 'user';
  const cron = require('./cron');
  return cron.change(server, source, { action: 'add', entry: { schedule: sched, command: s.path, enabled: true, meta: { name: s.name, notify, log } } }, { serverId: server.id });
}

module.exports = { list, get, save, createCode, toCode, setTitle, addExisting, discover, readText, remove, run, schedule, deploy, sha };
