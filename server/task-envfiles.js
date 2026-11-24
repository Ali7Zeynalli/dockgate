// The env files of a project folder (Deploy > Tasks > Env & secrets, a project's page): .env and every file whose
// name starts with .env (.env.local, .env.production, .env-dev, .env_staging ...) or ends in .env (app.env), in the
// folder and its subfolders, read like dotenv reads them. Each file is shown
// on its own (path, keys, which look secret, used by Compose, tracked by Git); keys can be imported into the
// folder's Env & secrets, and chosen files can be loaded into every task / recipe run (DockGate's own values win).
const crypto = require('crypto');
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS task_env_files (server_id TEXT NOT NULL, dir TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (server_id, dir))`);
const q = {
  get: db.prepare('SELECT files FROM task_env_files WHERE server_id = ? AND dir = ?'),
  put: db.prepare('INSERT INTO task_env_files (server_id, dir, files) VALUES (?, ?, ?) ON CONFLICT(server_id, dir) DO UPDATE SET files = excluded.files'),
};

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const err = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });
const MAX_FILE = 256 * 1024;
const SKIP_DIRS = ['node_modules', '.git', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage', 'target'];
const SECRETISH = /(PASS|PWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|AUTH|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$|DSN|SALT|SIGNING|CERT|DATABASE_URL|REDIS_URL|MONGO(DB)?_URI|AMQP_URL|_URI$)/i;
const EXAMPLE = /\.(example|sample|template|dist|defaults?)$|\.example\.|\.sample\./i;
const REL_RE = /^(?!.*(^|\/)\.\.(\/|$))[\w.@+\-/ ]{1,300}$/;

/** dotenv-style parsing: comments, `export`, '...' (literal), "..." (escapes, may span lines), unquoted with ` #` comments. */
function parseDotenv(text) {
  const vars = []; let bad = 0;
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s?(.*)$/);
    if (!m) { bad++; continue; }
    const key = m[1]; let rest = m[2]; let value; const at = i + 1;
    const q1 = rest.trimStart();
    if (q1.startsWith('"')) {
      let body = q1.slice(1); let end = -1;
      for (;;) {
        for (let j = 0; j < body.length; j++) { if (body[j] === '\\') { j++; continue; } if (body[j] === '"') { end = j; break; } }
        if (end >= 0 || i + 1 >= lines.length) break;
        body += '\n' + lines[++i];
      }
      value = (end >= 0 ? body.slice(0, end) : body).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\(["\\$])/g, '$1');
    } else if (q1.startsWith("'")) {
      const end = q1.indexOf("'", 1); value = end >= 0 ? q1.slice(1, end) : q1.slice(1);
    } else if (q1.startsWith('`')) {
      const end = q1.indexOf('`', 1); value = end >= 0 ? q1.slice(1, end) : q1.slice(1);
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    vars.push({ key, value, line: at });
  }
  return { vars, bad };
}

const secretish = (key) => SECRETISH.test(key);
function preview(key, value) {
  if (!value) return '';
  if (secretish(key)) return '••••••';
  return value.length > 300 ? value.slice(0, 300) + '...' : value;
}

/** Find and read every env file of the folder (and its Compose and Git context). */
async function discover(TK, s, dir) {
  const tag = '@@DG' + crypto.randomBytes(4).toString('hex');
  const prune = SKIP_DIRS.map(d => `-name ${shq(d)}`).join(' -o ');
  const cmd = `cd ${shq(dir)} 2>/dev/null || { echo ${tag}NODIR; exit 0; }
find . -maxdepth 4 \\( ${prune} \\) -prune -o -type f \\( \\( -name '.env*' ! -name '.envrc' \\) -o -name '*.env' \\) -print 2>/dev/null | grep -v '/\\.dockgate-' | sort | head -100 | while IFS= read -r f; do
  s=$(wc -c < "$f" 2>/dev/null || echo 0); printf '${tag}F %s\\t%s\\n' "$s" "$f"
  if [ "$s" -le ${MAX_FILE} ]; then cat "$f" 2>/dev/null; fi; printf '\\n${tag}E\\n'
done
for c in docker-compose.yml docker-compose.yaml compose.yml compose.yaml docker-compose.*.yml docker-compose.*.yaml */docker-compose.yml */compose.yml; do [ -f "$c" ] && { printf '${tag}C %s\\n' "$c"; head -c 200000 "$c"; printf '\\n${tag}E\\n'; }; done
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf '${tag}G\\n'; git ls-files -- '*.env' '.env' '.env.*' '**/.env' '**/.env.*' '**/*.env' 2>/dev/null | head -200; printf '${tag}E\\n'; fi`;
  const r = await TK.exec(s, cmd);
  const out = String(r.stdout || '');
  if (out.includes(tag + 'NODIR')) throw err(`The folder ${dir} is not on the server`, 404);
  const files = []; const composes = []; let gitFiles = null;
  const re = new RegExp(`${tag}(F|C|G)([^\\n]*)\\n([\\s\\S]*?)\\n?${tag}E`, 'g');
  let m;
  while ((m = re.exec(out))) {
    const kind = m[1], head = m[2].trim(), body = m[3];
    if (kind === 'F') {
      const [size, rawPath] = head.split('\t'); const path = String(rawPath || '').replace(/^\.\//, '');
      if (!path) continue;
      const n = Number(size) || 0; const tooBig = n > MAX_FILE;
      const p = tooBig ? { vars: [], bad: 0 } : parseDotenv(body);
      const name = path.split('/').pop();
      files.push({ path, name, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', size: n, tooBig, example: EXAMPLE.test(name), bad: p.bad,
        vars: p.vars.map(v => ({ key: v.key, line: v.line, secret: secretish(v.key), empty: !v.value, preview: preview(v.key, v.value), length: v.value.length })) });
    } else if (kind === 'C') composes.push({ file: head, text: body });
    else if (kind === 'G') gitFiles = new Set(body.split('\n').map(x => x.trim()).filter(Boolean));
  }
  // Compose: files named under env_file:, and the root .env that Compose reads for ${VARIABLES}
  const envFileRefs = new Map();
  for (const c of composes) {
    const base = c.file.includes('/') ? c.file.slice(0, c.file.lastIndexOf('/') + 1) : '';
    const lines = c.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m1 = lines[i].match(/^\s*env_file\s*:\s*(.*)$/); if (!m1) continue;
      const vals = [];
      if (m1[1].trim()) vals.push(...m1[1].replace(/[[\]]/g, '').split(','));
      else for (let j = i + 1; j < lines.length; j++) { const li = lines[j].match(/^\s*-\s*(?:path\s*:\s*)?(.+)$/); if (!li) { if (/^\s*(required|format)\s*:/.test(lines[j])) continue; break; } vals.push(li[1]); }
      for (let v of vals) { v = v.trim().replace(/^["']|["']$/g, '').replace(/^\.\//, ''); if (v) envFileRefs.set((base + v).replace(/^\.\//, ''), c.file); }
    }
  }
  for (const f of files) {
    f.usedBy = [];
    if (envFileRefs.has(f.path)) f.usedBy.push(`env_file in ${envFileRefs.get(f.path)}`);
    if (f.name === '.env' && composes.some(c => (c.file.includes('/') ? c.file.slice(0, c.file.lastIndexOf('/')) : '') === f.folder)) f.usedBy.push('read by docker compose for ${VARIABLES}');
    f.inGit = gitFiles ? gitFiles.has(f.path) : null;
  }
  const missing = [...envFileRefs.keys()].filter(p => !files.some(f => f.path === p)).map(p => ({ path: p, compose: envFileRefs.get(p) }));
  return { files, missing, git: !!gitFiles };
}

function checkRel(p) { const s = String(p || '').trim().replace(/^\.\//, ''); if (!REL_RE.test(s) || s.startsWith('/')) throw err(`Not a file of this folder: ${p}`); return s; }

/** Full values of one env file (shown on request). */
async function values(TK, s, dir, file) {
  const rel = checkRel(file);
  const r = await TK.exec(s, `cd ${shq(dir)} 2>/dev/null && [ -f ${shq(rel)} ] && [ "$(wc -c < ${shq(rel)})" -le ${MAX_FILE} ] && cat ${shq(rel)}`);
  if (r.code !== 0) throw err(`${rel} could not be read`, 404);
  return { file: rel, vars: parseDotenv(r.stdout).vars.map(v => ({ key: v.key, value: v.value, secret: secretish(v.key), line: v.line })) };
}

function loaded(serverId, dir) { try { return JSON.parse((q.get.get(serverId, dir) || {}).files || '[]'); } catch (e) { return []; } }
function setLoaded(serverId, dir, files) {
  const list = [...new Set((Array.isArray(files) ? files : []).map(checkRel))].slice(0, 20);
  q.put.run(serverId, dir, JSON.stringify(list));
  return list;
}

/** The variables of the files chosen for this folder, in order (a later file wins), for a run on server s. */
async function varsForRun(TK, s, dir, configServerId = s.id) {
  const list = loaded(configServerId, dir);
  const out = new Map();
  for (const f of list) {
    try { for (const v of (await values(TK, s, dir, f)).vars) out.set(v.key, { key: v.key, value: v.value, secret: v.secret, from: f }); }
    catch (e) { /* a missing file: the run goes on without it (the log says so) */ out.set(`__missing__${f}`, { missing: f }); }
  }
  return [...out.values()];
}

module.exports = { parseDotenv, discover, values, loaded, setLoaded, varsForRun, secretish };
