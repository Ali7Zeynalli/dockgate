// Server Console → Scripts: scripts made with the Script Builder (script-builder.js), kept in DockGate's database
// per server and written to the server as files. Root-owned under /opt/dockgate/scripts when the SSH user has
// passwordless sudo (so a root cron job never runs a file another user can change), else ~/.dockgate/scripts.
const { db } = require('./db');
const B = require('./script-builder');
const remoteExec = require('./remote-compose');
const shq = remoteExec.shq;

db.exec(`CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL,
  path TEXT, updated_at INTEGER, deployed_at INTEGER, last_run_at INTEGER, last_code INTEGER, UNIQUE(server_id, name)
)`);
const q = {
  list: db.prepare('SELECT * FROM scripts WHERE server_id = ? ORDER BY name'),
  get: db.prepare('SELECT * FROM scripts WHERE server_id = ? AND id = ?'),
  insert: db.prepare('INSERT INTO scripts (server_id, name, spec, updated_at) VALUES (?, ?, ?, ?)'),
  update: db.prepare('UPDATE scripts SET name = ?, spec = ?, updated_at = ? WHERE id = ?'),
  deployed: db.prepare('UPDATE scripts SET path = ?, deployed_at = ? WHERE id = ?'),
  ran: db.prepare('UPDATE scripts SET last_run_at = ?, last_code = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM scripts WHERE id = ?'),
};
const row = (r) => r && ({ id: r.id, name: r.name, spec: JSON.parse(r.spec), path: r.path, updatedAt: r.updated_at, deployedAt: r.deployed_at, lastRunAt: r.last_run_at, lastCode: r.last_code });

function list(serverId) { return q.list.all(serverId).map(row); }
function get(serverId, id) { return row(q.get.get(serverId, Number(id))); }

/** Save (create or update) and write the file to the server. Returns the saved script with its path. */
async function save(server, input, id = null) {
  const spec = { name: String(input.name || '').trim(), title: String(input.title || '').slice(0, 120), steps: input.steps || [] };
  const text = B.build(spec); // validates
  let sid = id ? Number(id) : null;
  const now = Date.now();
  try {
    if (sid) { if (!get(server.id, sid)) throw Object.assign(new Error('Script not found'), { statusCode: 404 }); q.update.run(spec.name, JSON.stringify(spec), now, sid); }
    else sid = q.insert.run(server.id, spec.name, JSON.stringify(spec), now).lastInsertRowid;
  } catch (e) { if (/UNIQUE/.test(e.message)) throw Object.assign(new Error(`A script named ${spec.name} exists on this server`), { statusCode: 400 }); throw e; }
  const path = await deploy(server, spec.name, text);
  q.deployed.run(path, Date.now(), sid);
  return get(server.id, sid);
}

async function deploy(server, name, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const r = await remoteExec.execRemote(server, `t=$(mktemp) && printf %s ${shq(b64)} | base64 -d > "$t" || exit 1
if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then S=; [ "$(id -u)" = 0 ] || S="sudo -n"; $S install -d -o root -g root -m 0755 /opt/dockgate/scripts && $S install -o root -g root -m 0750 "$t" /opt/dockgate/scripts/${name}.sh && echo "/opt/dockgate/scripts/${name}.sh"
else mkdir -p "$HOME/.dockgate/scripts" && install -m 0750 "$t" "$HOME/.dockgate/scripts/${name}.sh" && echo "$HOME/.dockgate/scripts/${name}.sh"; fi; rc=$?; rm -f "$t"; exit $rc`);
  const path = String(r.stdout || '').trim().split('\n').pop();
  if (r.code !== 0 || !path.startsWith('/')) throw Object.assign(new Error(`Could not write the script: ${String(r.stdout || r.stderr || '').trim().slice(0, 200)}`), { statusCode: 500 });
  return path;
}

async function remove(server, id) {
  const s = get(server.id, id); if (!s) throw Object.assign(new Error('Script not found'), { statusCode: 404 });
  if (s.path) await remoteExec.execRemote(server, `f=${shq(s.path)}; case "$f" in /opt/dockgate/scripts/*.sh) sudo -n rm -f "$f" 2>/dev/null || rm -f "$f";; */.dockgate/scripts/*.sh) rm -f "$f";; esac; true`);
  q.del.run(s.id);
  return s;
}

/** Run it once (as root when the file is root's), up to 5 minutes; output and exit code. */
async function run(server, id) {
  const s = get(server.id, id); if (!s || !s.path) throw Object.assign(new Error('Script not found — save it first'), { statusCode: 404 });
  const asRoot = s.path.startsWith('/opt/dockgate/');
  let timer;
  const r = await Promise.race([
    remoteExec.execRemote(server, `s=$(date +%s%N); ${asRoot ? '{ [ "$(id -u)" = 0 ] && bash ' + shq(s.path) + ' || sudo -n bash ' + shq(s.path) + '; }' : 'bash ' + shq(s.path)} > /tmp/.dg-run-$$ 2>&1; rc=$?; e=$(date +%s%N); tail -c 30000 /tmp/.dg-run-$$; rm -f /tmp/.dg-run-$$; echo "__DGRUN__$rc $(( (e - s) / 1000000 ))"`),
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
  const source = s.path.startsWith('/opt/dockgate/') ? (server.username === 'root' ? 'user' : 'root') : 'user';
  const cron = require('./cron');
  return cron.change(server, source, { action: 'add', entry: { schedule: sched, command: s.path, enabled: true, meta: { name: s.name, notify, log } } }, { serverId: server.id });
}

module.exports = { list, get, save, remove, run, schedule, deploy };
