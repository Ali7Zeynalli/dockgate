// Tools > Databases > Backups: pg_dump / pg_dumpall of a Postgres container, kept next to it.
//   SSH server  -> files on that server in /var/backups/dockgate/postgres (sudo makes it once; else ~/dockgate-backups/postgres);
//                 the dump runs there (docker exec ... > file), nothing passes through DockGate.
//   this machine -> files in DockGate's data folder (data/backups/postgres), streamed from the container.
// File names: <container>-<database|all>-<YYYY-MM-DD-HHMMSS>.dump (custom format, one database)
//             <container>-<database|all>-<...>.sql.gz (plain SQL; also what Scripts' "Database backup" block writes).
// Restore goes into a NEW database first (a .dump or a one-database .sql.gz); "swap" then puts it in place of
// the old one, which is kept renamed. A whole-server backup (...-all-....sql.gz) is restored by hand (shown how).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const S = require('./pg-studio');
const P = require('./pg-sql');
const remoteExec = require('./remote-compose');
const shq = remoteExec.shq;

const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const REMOTE_DIR = '/var/backups/dockgate/postgres';
const LOCAL_DIR = () => path.join(require('./paths').DATA_DIR, 'backups', 'postgres');
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(dump|sql\.gz)$/;
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*$/, '').replace(/-(\d\d)-(\d\d)$/, '$1$2');

function where() {
  const id = require('./docker').getActiveServerId();
  if (id === 'local') return { local: true };
  const s = require('./db').stmts.getServer.get(id);
  if (!s) throw err('Active server not found', 404);
  return { local: false, server: s };
}
// The folder on the SSH server: made (with sudo once) and owned by the SSH user; ~/dockgate-backups/postgres without sudo.
const remoteDirScript = `d=${shq(REMOTE_DIR)}; if ! { mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; }; then if sudo -n true 2>/dev/null; then sudo -n mkdir -p "$d" && sudo -n chown "$(id -u):$(id -g)" "$d"; else d="$HOME/dockgate-backups/postgres"; mkdir -p "$d"; fi; fi`;

async function dir() {
  const w = where();
  if (w.local) { fs.mkdirSync(LOCAL_DIR(), { recursive: true }); return { ...w, dir: LOCAL_DIR() }; }
  const r = await remoteExec.execRemote(w.server, `${remoteDirScript}; printf '%s' "$d"`);
  if (r.code !== 0) throw err(`Could not make the backup folder: ${String(r.stderr || '').trim().slice(0, 200)}`, 500);
  return { ...w, dir: String(r.stdout).trim() };
}

/** Backups of this container (and any .dump / .sql.gz in the folder named after it). */
async function list(name) {
  const d = await dir();
  const pre = `${name}-`;
  let files = [];
  if (d.local) {
    files = fs.readdirSync(d.dir).filter(f => f.startsWith(pre) && FILE_RE.test(f)).map(f => { const st = fs.statSync(path.join(d.dir, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; });
  } else {
    const r = await remoteExec.execRemote(d.server, `cd ${shq(d.dir)} 2>/dev/null && for f in ${shq(pre)}*.dump ${shq(pre)}*.sql.gz; do [ -f "$f" ] && printf '%s\\t%s\\t%s\\n' "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$f"; done; true`);
    files = String(r.stdout || '').split('\n').filter(Boolean).map(l => { const [size, mt, f] = l.split('\t'); return { name: f, size: Number(size), mtime: Number(mt) * 1000 }; }).filter(f => FILE_RE.test(f.name));
  }
  return { dir: d.dir, local: d.local, files: files.map(f => ({ ...f, ...describe(name, f.name) })).sort((a, b) => b.mtime - a.mtime) };
}
function describe(container, file) {
  const rest = file.slice(container.length + 1).replace(/\.(dump|sql\.gz)$/, '');
  const m = /^(.*)-(\d{4}-\d\d-\d\d-\d{4,6})$/.exec(rest);
  const database = m ? m[1] : rest;
  const format = file.endsWith('.dump') ? 'custom' : 'sql';
  return { database, format, whole: database === 'all', restorable: database !== 'all' };
}
const fileIn = (d, file) => { if (!FILE_RE.test(String(file || ''))) throw err('Unknown backup file'); return d.local ? path.join(d.dir, file) : `${d.dir}/${file}`; };

/** Make a backup now. kind: 'custom' (pg_dump -Fc of one database) | 'sql' (pg_dump | gzip) | 'all' (pg_dumpall | gzip). */
async function create(name, { database, kind = 'custom' }) {
  const t = await S.resolve(name);
  const d = await dir();
  const whole = kind === 'all';
  const db = whole ? 'all' : String(database || t.dbname);
  if (!whole && !/^[^\0/]{1,63}$/.test(db)) throw err('Database?');
  const ext = kind === 'custom' ? 'dump' : 'sql.gz';
  const file = `${t.name}-${db.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${stamp()}.${ext}`;
  const tool = S.toolArgs(t, whole ? ['pg_dumpall', '-U', t.user, '-l', t.dbname] : ['pg_dump', '-U', t.user, '-d', db, ...(kind === 'custom' ? ['-Fc'] : [])]);
  const t0 = Date.now();
  if (d.local) {
    const dest = path.join(d.dir, file), part = dest + '.part';
    const out = fs.createWriteStream(part, { mode: 0o600 });
    const gz = kind === 'custom' ? null : zlib.createGzip();
    if (gz) gz.pipe(out);
    const sink = gz || out;
    let r;
    try {
      r = await S.psqlTool(t, tool, { onStdout: (c) => sink.write(c), timeoutMs: 6 * 3600 * 1000 });
    } finally { await new Promise((res) => { out.on('close', res); sink.end(); }); }
    if (r.code !== 0) { try { fs.unlinkSync(part); } catch (e) {} throw err(`${tool[0]} failed: ${String(r.stderr || '').trim().slice(0, 400)}`, 500); }
    fs.renameSync(part, dest);
    return { file, size: fs.statSync(dest).size, ms: Date.now() - t0, dir: d.dir };
  }
  const execPrefix = S.dockerExecLine(t);
  const f = `${d.dir}/${file}`;
  const pipe = kind === 'custom' ? '' : ' | gzip';
  const r = await remoteExec.execRemote(d.server, `set -o pipefail; ${t.password ? `export PGPASSWORD=${shq(t.password)}; ` : ''}${execPrefix} ${tool.map(shq).join(' ')}${pipe} > ${shq(f + '.part')} && mv ${shq(f + '.part')} ${shq(f)} && stat -c %s ${shq(f)}; rc=$?; [ $rc -ne 0 ] && rm -f ${shq(f + '.part')}; exit $rc`);
  if (r.code !== 0) throw err(`${tool[0]} failed: ${String(r.stderr || r.stdout || '').trim().slice(0, 400)}`, 500);
  return { file, size: Number(String(r.stdout).trim().split('\n').pop()) || 0, ms: Date.now() - t0, dir: d.dir };
}

async function remove(name, file) {
  const d = await dir();
  if (!String(file).startsWith(name + '-')) throw err('Not a backup of this container');
  const f = fileIn(d, file);
  if (d.local) fs.unlinkSync(f);
  else { const r = await remoteExec.execRemote(d.server, `rm -f -- ${shq(f)}`); if (r.code !== 0) throw err(String(r.stderr).trim() || 'Could not delete', 500); }
  return { ok: true };
}

async function download(name, file, res) {
  const d = await dir();
  if (!String(file).startsWith(name + '-')) throw err('Not a backup of this container');
  const f = fileIn(d, file);
  if (d.local) {
    const st = fs.statSync(f);
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`); res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', st.size);
    await new Promise((resolve, reject) => pipeline(fs.createReadStream(f), res, (e) => e ? reject(e) : resolve()));
    return;
  }
  await require('./file-manager').downloadTo(d.server, f, res);
}

/** Restore into a new database (made here). keepOwners: keep owners and grants from the backup. */
async function restore(name, { file, target, keepOwners = true }) {
  const t = await S.resolve(name);
  if (!t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first.', 403, { code: 'READ_ONLY' });
  const d = await dir();
  if (!String(file).startsWith(name + '-')) throw err('Not a backup of this container');
  const info = describe(name, file);
  if (!info.restorable) throw err('A whole-server backup (pg_dumpall) is restored by hand - see the guide', 400, { code: 'WHOLE' });
  const db = String(target || '').trim();
  if (!/^[A-Za-z_][\w$-]{0,62}$/.test(db)) throw err('New database name: letters, digits, _ $ -');
  const f = fileIn(d, file);
  const exists = await S.json(t, t.dbname, `select json_build_object('n', count(*)) from pg_database where datname = ${P.lit(db)}`);
  if (Number(exists.n)) throw err(`A database named ${db} exists - pick a new name`, 409);
  const mk = await S.psql(t, ['-c', `CREATE DATABASE ${P.ident(db)}`], { readOnly: false });
  if (mk.code !== 0) throw err(String(mk.stderr).replace(/^psql:(\s*error:)?\s*/gm, '').trim(), 400);
  const tool = S.toolArgs(t, info.format === 'custom'
    ? ['pg_restore', '-U', t.user, '-d', db, '--exit-on-error', ...(keepOwners ? [] : ['--no-owner', '--no-privileges'])]
    : ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', t.user, '-d', db]);
  const t0 = Date.now();
  let r;
  if (d.local) {
    const src = fs.createReadStream(f);
    r = await S.psqlTool(t, tool, { stdin: info.format === 'custom' ? src : src.pipe(zlib.createGunzip()), timeoutMs: 6 * 3600 * 1000 });
  } else {
    const feed = info.format === 'custom' ? `cat ${shq(f)}` : `gunzip -c ${shq(f)}`;
    r = await remoteExec.execRemote(d.server, `set -o pipefail; ${t.password ? `export PGPASSWORD=${shq(t.password)}; ` : ''}${feed} | ${S.dockerExecLine(t, { stdin: true })} ${tool.map(shq).join(' ')}`);
  }
  if (r.code !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim().slice(-600);
    await S.psql(t, ['-c', `DROP DATABASE IF EXISTS ${P.ident(db)}`], { readOnly: false }).catch(() => {});
    throw err(`Restore failed (the new database was removed): ${msg}`, 500);
  }
  return { database: db, ms: Date.now() - t0 };
}

/** Put a restored database in place of another: the old one stays, renamed <name>_before_<stamp>. */
async function swap(name, { restored, into }) {
  const t = await S.resolve(name);
  if (!t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first.', 403, { code: 'READ_ONLY' });
  const a = String(restored || ''), b = String(into || '');
  if (!a || !b || a === b) throw err('Which databases?');
  const maint = await S.maintenanceDb(t, [a, b]);
  const old = `${b}_before_${stamp().replace(/-/g, '')}`.slice(0, 63);
  const args = [];
  for (const sql of [
    `select pg_terminate_backend(pid) from pg_stat_activity where datname in (${P.lit(a)}, ${P.lit(b)}) and pid <> pg_backend_pid()`,
    `ALTER DATABASE ${P.ident(b)} RENAME TO ${P.ident(old)}`,
    `ALTER DATABASE ${P.ident(a)} RENAME TO ${P.ident(b)}`,
  ]) args.push('-c', sql);
  const r = await S.psql(t, ['-q', ...args], { readOnly: false, db: maint });
  if (r.code !== 0) throw err(String(r.stderr).replace(/^psql:(\s*error:)?\s*/gm, '').trim(), 400);
  return { database: b, kept: old };
}

/** A Scripts entry that backs this database up on a schedule (SSH servers): dump -> delete old -> disk check. */
function scheduleSpec(name, { database, keepDays = 7, user }) {
  const db = String(database || '').trim();
  return {
    name: `pg-backup-${name}${db ? '-' + db : ''}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 41),
    title: `PostgreSQL backup of ${name}${db ? ' / ' + db : ' (all databases)'}`,
    steps: [
      { type: 'db_backup', container: name, engine: 'postgres', database: db, user: user || 'postgres', dir: REMOTE_DIR },
      { type: 'cleanup_old', dir: REMOTE_DIR, pattern: `${name}-*.sql.gz`, days: Math.max(1, Math.min(365, parseInt(keepDays, 10) || 7)) },
      { type: 'disk_check', path: '/var/backups', max: 90, onFail: 'continue' },
    ],
  };
}

module.exports = { list, create, remove, download, restore, swap, scheduleSpec, describe, REMOTE_DIR, LOCAL_DIR };
