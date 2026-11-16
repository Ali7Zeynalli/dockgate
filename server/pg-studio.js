// Tools → Databases: PostgreSQL in containers of the active server, reached with `docker exec … psql` inside the
// container — no published port, no tunnel, the same way on the local machine and on SSH servers.
//   targets()                       the Postgres containers here, with their saved settings
//   info(name)                      version, user, databases
//   objects(name, db)               schemas, tables / views / sequences, functions
//   structure(name, db, s, t)       columns, primary key, indexes, constraints, triggers, view definition
//   rows(name, db, q)               a page of a table (all values as text, NULL as null), sorted / filtered
//   count(name, db, q)              exact row count for the same filter
//   runSql(name, db, sql, opts)     statements one by one in one session; rows / command tags per statement
//   updateRow / insertRow / deleteRows   by primary key only, each checked to touch exactly the rows meant
//   exportTable(name, db, s, t, fmt, write)   CSV (COPY) or JSON lines, streamed
// Safety: a connection is read-only until "Allow changes" (default_transaction_read_only=on for every session);
// DROP, TRUNCATE, ALTER … DROP and DELETE / UPDATE without WHERE ask first; psql meta commands (\…) are refused;
// every session has a statement timeout. Settings per server + container: pg_connections (password encrypted).
const crypto = require('crypto');
const { Writable } = require('stream');
const { db } = require('./db');
const P = require('./pg-sql');
const secrets = require('./auth/secrets');

const IMAGE_RE = /(^|\/)(postgres|postgresql|postgis|timescaledb(-ha|-postgis)?|pgvector|supabase\/postgres|bitnami\/postgresql(-repmgr)?|cloudnative-pg\/postgresql|crunchydata\/crunchy-postgres|ankane\/pgvector|paradedb)(:|@|$)/i;
const MAX_ROWS = 1000;           // rows kept per statement in the SQL editor
const PAGE_MAX = 500;            // rows per page in the table view
const TIMEOUT_MS = 30000;        // statement_timeout for the editor and the table view

db.exec(`CREATE TABLE IF NOT EXISTS pg_connections (
  server_id TEXT NOT NULL, container TEXT NOT NULL, user TEXT, dbname TEXT, password TEXT,
  allow_write INTEGER NOT NULL DEFAULT 0, production INTEGER NOT NULL DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY (server_id, container)
)`);
const q = {
  get: db.prepare('SELECT * FROM pg_connections WHERE server_id = ? AND container = ?'),
  all: db.prepare('SELECT * FROM pg_connections WHERE server_id = ?'),
  put: db.prepare(`INSERT INTO pg_connections (server_id, container, user, dbname, password, allow_write, production, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, container) DO UPDATE SET user = excluded.user, dbname = excluded.dbname, password = excluded.password, allow_write = excluded.allow_write, production = excluded.production, updated_at = excluded.updated_at`),
};
const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const dockerSvc = () => require('./docker');
const serverId = () => dockerSvc().getActiveServerId();

// ---------- containers ----------
const envOf = (inspect) => Object.fromEntries(((inspect.Config && inspect.Config.Env) || []).map(e => { const i = e.indexOf('='); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; }));
function defaultsFrom(env) {
  const user = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || env.PGUSER || 'postgres';
  const password = env.POSTGRES_PASSWORD || env.POSTGRESQL_PASSWORD || (user === 'postgres' ? env.POSTGRESQL_POSTGRES_PASSWORD : '') || env.PGPASSWORD || '';
  const dbname = env.POSTGRES_DB || env.POSTGRESQL_DATABASE || env.PGDATABASE || user;
  return { user, password, dbname };
}
const isPg = (c) => IMAGE_RE.test(String(c.Image || c.image || '')) || /postgres/i.test(String((c.Labels || c.labels || {})['org.opencontainers.image.title'] || ''));
const nameOf = (c) => String((c.Names && c.Names[0]) || c.name || '').replace(/^\//, '');
const settingsRow = (r) => r ? { user: r.user || null, dbname: r.dbname || null, hasPassword: !!r.password, allowWrite: !!r.allow_write, production: !!r.production } : { user: null, dbname: null, hasPassword: false, allowWrite: false, production: false };

async function targets() {
  const list = await dockerSvc().docker.listContainers({ all: true });
  const saved = Object.fromEntries(q.all.all(serverId()).map(r => [r.container, r]));
  return list.filter(isPg).map(c => {
    const name = nameOf(c);
    return { id: c.Id, name, image: c.Image, state: c.State, status: c.Status, project: (c.Labels || {})['com.docker.compose.project'] || null, settings: settingsRow(saved[name]) };
  }).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
}

/** The container (running) and how to log in: saved settings over what the container's environment says. */
async function resolve(name) {
  const n = String(name || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n)) throw err('Unknown container', 404);
  let ins;
  try { ins = await dockerSvc().docker.getContainer(n).inspect(); } catch (e) { throw err(`Container ${n} not found on this server`, 404); }
  if (!ins.State || !ins.State.Running) throw err(`${n} is not running — start it first`, 409, { code: 'NOT_RUNNING' });
  const d = defaultsFrom(envOf(ins));
  const s = q.get.get(serverId(), n);
  let password = d.password;
  if (s && s.password) { try { password = secrets.decrypt(s.password); } catch (e) { /* keep the container's */ } }
  return { id: ins.Id, name: n, image: (ins.Config && ins.Config.Image) || '', user: (s && s.user) || d.user, dbname: (s && s.dbname) || d.dbname, password, allowWrite: !!(s && s.allow_write), production: !!(s && s.production), fromEnv: d };
}

function saveSettings(name, body) {
  const cur = q.get.get(serverId(), name);
  const b = body || {};
  const user = b.user === undefined ? (cur && cur.user) : (String(b.user || '').trim() || null);
  const dbname = b.dbname === undefined ? (cur && cur.dbname) : (String(b.dbname || '').trim() || null);
  if (user && !/^[\w.$-]{1,63}$/.test(user)) throw err('User: letters, digits, _ . $ -');
  if (dbname && !/^[^\0'"\\]{1,63}$/.test(dbname)) throw err('Database: up to 63 characters');
  let password = cur ? cur.password : null;
  if (b.password !== undefined) password = b.password ? secrets.encrypt(String(b.password)) : null;
  const allow = b.allowWrite === undefined ? (cur ? cur.allow_write : 0) : (b.allowWrite ? 1 : 0);
  const prod = b.production === undefined ? (cur ? cur.production : 0) : (b.production ? 1 : 0);
  q.put.run(serverId(), name, user, dbname, password, allow, prod, Date.now());
  return settingsRow(q.get.get(serverId(), name));
}

// ---------- exec ----------
async function dockerExec(id, cmd, env, { maxBytes = 8 * 1024 * 1024, timeoutMs = 60000, user, onStdout, stdin } = {}) {
  const dk = dockerSvc().docker;
  const ex = await dk.getContainer(id).exec({ Cmd: cmd, Env: env, AttachStdout: true, AttachStderr: true, AttachStdin: !!stdin, Tty: false, ...(user ? { User: user } : {}) });
  const stream = await ex.start({ hijack: true, stdin: !!stdin });
  if (stdin) { stdin.on('data', (c) => { if (!stream.write(c)) { stdin.pause(); stream.once('drain', () => stdin.resume()); } }); stdin.on('end', () => { try { stream.end(); } catch (e) {} }); stdin.on('error', () => { try { stream.destroy(); } catch (e) {} }); }
  return new Promise((resolveP, reject) => {
    const out = []; const errs = []; let size = 0, esize = 0, truncated = false, done = false, timedOut = false;
    const so = new Writable({ write(chunk, enc, cb) {
      if (onStdout) { onStdout(chunk); return cb(); }
      if (truncated) return cb();
      size += chunk.length;
      if (size > maxBytes) { truncated = true; out.push(chunk.slice(0, chunk.length - (size - maxBytes))); setImmediate(() => { try { stream.destroy(); } catch (e) {} }); } else out.push(chunk);
      cb();
    } });
    const se = new Writable({ write(chunk, enc, cb) { if (esize < 65536) { errs.push(chunk); esize += chunk.length; } cb(); } });
    dk.modem.demuxStream(stream, so, se);
    const finish = async () => {
      if (done) return; done = true; clearTimeout(timer);
      let code = null; if (!truncated && !timedOut) { try { code = (await ex.inspect()).ExitCode; } catch (e) {} }
      resolveP({ code: timedOut ? 124 : (code == null ? 0 : code), stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8'), truncated, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; try { stream.destroy(); } catch (e) {} finish(); }, timeoutMs);
    stream.on('end', finish); stream.on('close', finish);
    stream.on('error', (e) => { if (truncated || timedOut) finish(); else { clearTimeout(timer); done = true; reject(e); } });
  });
}
let execImpl = dockerExec;
const how = new Map(); // container id → { host: true } / { osUser: 'postgres' } once the socket / peer login failed

/** Another client tool (pg_dump, pg_dumpall, pg_restore, psql for a restore) with the same login as psql. */
const toolArgs = (t, argv) => { const m = how.get(t.id) || {}; return m.host ? [argv[0], '-h', '127.0.0.1', ...argv.slice(1)] : argv; };
async function psqlTool(t, argv, { onStdout, stdin, timeoutMs = 3600000 } = {}) {
  const env = ['PGAPPNAME=DockGate', 'PGCONNECT_TIMEOUT=8', 'PSQLRC=/dev/null'];
  if (t.password) env.push(`PGPASSWORD=${t.password}`);
  const m = how.get(t.id) || {};
  return execImpl(t.id, argv, env, { onStdout, stdin, timeoutMs, user: m.osUser, maxBytes: 1024 * 1024 });
}
/** "docker exec …" for a shell on the SSH server (PGPASSWORD comes from that shell's environment, not argv). */
function dockerExecLine(t, { stdin = false } = {}) {
  const m = how.get(t.id) || {};
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return `docker exec${stdin ? ' -i' : ''}${m.osUser ? ' -u ' + sq(m.osUser) : ''}${t.password ? ' -e PGPASSWORD' : ''} -e PGAPPNAME=DockGate ${sq(t.id)}`;
}

/** psql in the container. opts: { db, readOnly, timeoutMs, args (output format), maxBytes, onStdout } */
async function psql(t, extra, opts = {}) {
  const ms = Math.max(1000, Math.min(600000, opts.timeoutMs || TIMEOUT_MS));
  const env = [
    `PGOPTIONS=-c statement_timeout=${ms} -c lock_timeout=10000 -c idle_in_transaction_session_timeout=120000 -c standard_conforming_strings=on -c default_transaction_read_only=${opts.readOnly === false ? 'off' : 'on'}`,
    'PGAPPNAME=DockGate', 'PGCONNECT_TIMEOUT=8', 'PSQLRC=/dev/null',
  ];
  if (t.password) env.push(`PGPASSWORD=${t.password}`);
  const run = async (mode) => {
    const cmd = ['psql', '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', '-U', t.user, '-d', opts.db || t.dbname, ...(mode.host ? ['-h', '127.0.0.1'] : []), ...extra];
    return execImpl(t.id, cmd, env, { maxBytes: opts.maxBytes, timeoutMs: ms + 15000, user: mode.osUser, onStdout: opts.onStdout });
  };
  let mode = how.get(t.id) || {};
  let r = await run(mode);
  const e1 = String(r.stderr || '');
  if (r.code !== 0 && !mode.host && /socket .*(No such file|failed)|could not connect to server: No such file/i.test(e1)) { mode = { ...mode, host: true }; r = await run(mode); if (r.code === 0) how.set(t.id, mode); }
  else if (r.code !== 0 && !mode.osUser && /Peer authentication failed/i.test(e1)) { mode = { ...mode, osUser: 'postgres' }; r = await run(mode); if (r.code === 0) how.set(t.id, mode); }
  if (r.code === 127 || /executable file not found|psql: (command )?not found/i.test(String(r.stderr) + String(r.stdout))) throw err('psql is not in this container — it does not look like a PostgreSQL server image', 400, { code: 'NO_PSQL' });
  return r;
}
const cleanErr = (s) => String(s || '').replace(/^psql:(\s*error:)?\s*/gm, '').replace(/^(\/dev\/stdin|<stdin>):\d+:\s*/gm, '').trim();
function failIfBad(r) {
  if (r.timedOut) throw err('The query took too long and was stopped', 504, { code: 'TIMEOUT' });
  if (r.code !== 0) {
    const m = cleanErr(r.stderr) || 'psql failed';
    const auth = /password authentication failed|no password supplied|role .* does not exist/i.test(m);
    throw err(auth ? `${m} — set the user / password under Connection` : m, auth ? 401 : 400, auth ? { code: 'AUTH' } : undefined);
  }
}
/** One query that returns one JSON value (catalog reads). */
async function json(t, dbname, sql) {
  const r = await psql(t, ['-At', '-c', sql], { db: dbname });
  failIfBad(r);
  const s = String(r.stdout || '').trim();
  return s ? JSON.parse(s) : null;
}
const dbOf = (t, dbname) => { const d = String(dbname || t.dbname); if (!d || d.includes('\0')) throw err('Database?'); return d; };

/** A database to stand in while another is renamed or dropped: postgres, template1, or the login one when it is not involved. */
async function maintenanceDb(t, avoid) {
  const list = await json(t, t.dbname, `select coalesce(json_agg(datname), '[]') from pg_database where datallowconn and has_database_privilege(datname, 'CONNECT')`);
  const pick = ['postgres', 'template1', t.dbname, ...list].find(d => list.includes(d) && !avoid.includes(d));
  if (!pick) throw err('No other database to connect to while this one changes');
  return pick;
}

// ---------- catalog ----------
async function info(name) {
  const t = await resolve(name);
  const d = await json(t, t.dbname, `select json_build_object('version', version(), 'serverVersion', current_setting('server_version'), 'user', current_user,
    'superuser', (select rolsuper from pg_roles where rolname = current_user), 'database', current_database(),
    'databases', (select coalesce(json_agg(json_build_object('name', datname, 'owner', pg_get_userbyid(datdba), 'encoding', pg_encoding_to_char(encoding),
      'size', case when has_database_privilege(datname, 'CONNECT') then pg_database_size(datname) end, 'connect', has_database_privilege(datname, 'CONNECT')) order by datname), '[]')
      from pg_database where not datistemplate))`);
  return { ...d, container: t.name, image: t.image, login: { user: t.user, dbname: t.dbname }, allowWrite: t.allowWrite, production: t.production };
}

const USER_NS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'`;
async function objects(name, dbname) {
  const t = await resolve(name);
  return json(t, dbOf(t, dbname), `select json_build_object(
    'schemas', (select coalesce(json_agg(n.nspname order by n.nspname), '[]') from pg_namespace n where ${USER_NS}),
    'relations', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'rows', greatest(c.reltuples, -1)::bigint,
        'size', pg_total_relation_size(c.oid)) order by n.nspname, c.relname), '[]')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and ${USER_NS} and not coalesce((row_to_json(c)->>'relispartition')::boolean, false)),
    'functions', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
        'result', pg_get_function_result(p.oid), 'kind', coalesce(row_to_json(p)->>'prokind', 'f')) order by n.nspname, p.proname), '[]')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${USER_NS}
        and not exists (select 1 from pg_depend dp where dp.objid = p.oid and dp.deptype = 'e'))
  )`);
}

async function structureOf(t, dbname, schema, table) {
  const d = await json(t, dbname, `select json_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'rows', greatest(c.reltuples, -1)::bigint,
    'size', pg_total_relation_size(c.oid), 'comment', obj_description(c.oid, 'pg_class'),
    'columns', (select coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull,
        'default', pg_get_expr(ad.adbin, ad.adrelid), 'identity', nullif(row_to_json(a)->>'attidentity', ''), 'generated', nullif(row_to_json(a)->>'attgenerated', ''),
        'comment', col_description(c.oid, a.attnum)) order by a.attnum), '[]')
      from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
    'pk', (select coalesce(json_agg(a.attname order by array_position(i.indkey::int2[], a.attnum)), '[]')
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = c.oid and i.indisprimary),
    'indexes', (select coalesce(json_agg(json_build_object('name', ic.relname, 'def', pg_get_indexdef(i.indexrelid), 'primary', i.indisprimary,
        'unique', i.indisunique, 'size', pg_relation_size(i.indexrelid)) order by ic.relname), '[]')
      from pg_index i join pg_class ic on ic.oid = i.indexrelid where i.indrelid = c.oid),
    'constraints', (select coalesce(json_agg(json_build_object('name', co.conname, 'type', co.contype, 'def', pg_get_constraintdef(co.oid)) order by co.conname), '[]')
      from pg_constraint co where co.conrelid = c.oid),
    'referencedBy', (select coalesce(json_agg(json_build_object('name', co.conname, 'table', co.conrelid::regclass::text, 'def', pg_get_constraintdef(co.oid)) order by co.conname), '[]')
      from pg_constraint co where co.confrelid = c.oid and co.contype = 'f'),
    'triggers', (select coalesce(json_agg(json_build_object('name', tg.tgname, 'def', pg_get_triggerdef(tg.oid), 'enabled', tg.tgenabled <> 'D') order by tg.tgname), '[]')
      from pg_trigger tg where tg.tgrelid = c.oid and not tg.tgisinternal),
    'viewdef', case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end,
    'sequence', case when c.relkind = 'S' then (select row_to_json(s) from pg_sequences s where s.schemaname = n.nspname and s.sequencename = c.relname) end
  ) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${P.lit(schema)} and c.relname = ${P.lit(table)}`);
  if (!d) throw err(`${schema}.${table} not found`, 404);
  return d;
}
async function structure(name, dbname, schema, table) { const t = await resolve(name); return structureOf(t, dbOf(t, dbname), schema, table); }

// ---------- rows ----------
const OPS = { '=': '=', '!=': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);
function whereOf(cols, { filters = [], where = '' } = {}) {
  const names = new Set(cols.map(c => c.name));
  const parts = [];
  for (const f of filters || []) {
    if (!f || !names.has(f.col)) throw err(`Unknown column in a filter: ${f && f.col}`);
    const c = P.ident(f.col);
    const v = f.value == null ? '' : String(f.value);
    if (OPS[f.op]) parts.push(`${c} ${OPS[f.op]} ${P.lit(v)}`);
    else if (f.op === 'contains') parts.push(`${c}::text ILIKE ${P.lit('%' + likeEsc(v) + '%')}`);
    else if (f.op === 'starts') parts.push(`${c}::text ILIKE ${P.lit(likeEsc(v) + '%')}`);
    else if (f.op === 'null') parts.push(`${c} IS NULL`);
    else if (f.op === 'notnull') parts.push(`${c} IS NOT NULL`);
    else if (f.op === 'in') { const vs = v.split(',').map(x => x.trim()).filter(Boolean); if (vs.length) parts.push(`${c} IN (${vs.map(P.lit).join(', ')})`); }
    else throw err(`Unknown filter: ${f.op}`);
  }
  const w = String(where || '').trim();
  if (w) { if (P.split(w).length > 1) throw err('WHERE: one condition, no ";"'); parts.push(`(${w})`); }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

async function rows(name, dbname, body = {}) {
  const t = await resolve(name); const dbn = dbOf(t, dbname);
  const st = await structureOf(t, dbn, body.schema, body.table);
  if (st.kind === 'S') throw err('A sequence has no rows to show — see Structure');
  const cols = st.columns;
  const limit = Math.max(1, Math.min(PAGE_MAX, parseInt(body.limit, 10) || 100));
  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const names = new Set(cols.map(c => c.name));
  const sort = (body.sort || []).filter(s => s && names.has(s.col));
  const order = sort.length ? sort.map(s => `${P.ident(s.col)} ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`) : st.pk.map(c => P.ident(c));
  const sel = cols.length ? cols.map(c => `x.${P.ident(c.name)}::text`).join(', ') : '';
  const sql = `select json_build_object('rows', coalesce(json_agg(array[${sel}]::text[]), '[]')) from (select * from ${P.qname(st.schema, st.name)}${whereOf(cols, body)}${order.length ? ' ORDER BY ' + order.join(', ') : ''} LIMIT ${limit} OFFSET ${offset}) x`;
  const d = cols.length ? await json(t, dbn, sql) : { rows: [] };
  return { columns: cols, pk: st.pk, kind: st.kind, estimate: st.rows, rows: d.rows, limit, offset, editable: st.pk.length > 0 && (st.kind === 'r' || st.kind === 'p') };
}

async function count(name, dbname, body = {}) {
  const t = await resolve(name); const dbn = dbOf(t, dbname);
  const st = await structureOf(t, dbn, body.schema, body.table);
  const d = await json(t, dbn, `select json_build_object('n', count(*)) from ${P.qname(st.schema, st.name)}${whereOf(st.columns, body)}`);
  return { count: Number(d.n) };
}

// ---------- SQL editor ----------
async function runSql(name, dbname, sql, { confirm = false } = {}) {
  const t = await resolve(name); const dbn = dbOf(t, dbname);
  const stmts = P.split(sql);
  if (!stmts.length) throw err('Nothing to run');
  if (stmts.length > 100) throw err('At most 100 statements at once');
  const kinds = stmts.map(s => P.kind(s.sql));
  stmts.forEach((s) => { if (s.sql.startsWith('\\')) throw err('psql commands (\\…) are not run here — write SQL'); });
  const writes = kinds.some(k => k.write);
  if (writes && !t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" to run statements that change data.', 403, { code: 'READ_ONLY' });
  const danger = kinds.map((k, i) => k.danger ? { statement: i + 1, sql: stmts[i].sql.slice(0, 200), why: k.danger } : null).filter(Boolean);
  if (danger.length && !confirm) throw err('Some statements need a confirm', 409, { code: 'NEEDS_CONFIRM', danger });
  if (writes && t.production && !confirm) throw err('This is marked as production — confirm to run statements that change data', 409, { code: 'NEEDS_CONFIRM', danger: [{ statement: 0, why: 'production database' }] });
  const mark = `\u241E${crypto.randomBytes(4).toString('hex')}:`;
  const args = ['--csv', '-P', `null=${P.NULL_MARK}`, '-v', 'FETCH_COUNT=500'];
  stmts.forEach((s, i) => { args.push('-c', `\\echo ${mark}${i}`, '-c', s.sql); });
  args.push('-c', `\\echo ${mark}end`);
  const t0 = Date.now();
  const r = await psql(t, args, { db: dbn, readOnly: !t.allowWrite });
  const ms = Date.now() - t0;
  // split the output at the markers
  const chunks = {}; let cur = null; let ended = false;
  for (const line of String(r.stdout || '').split('\n')) {
    if (line.startsWith(mark)) { const k = line.slice(mark.length); if (k === 'end') { ended = true; cur = null; } else { cur = Number(k); chunks[cur] = []; } continue; }
    if (cur != null) chunks[cur].push(line);
  }
  const results = [];
  for (let i = 0; i < stmts.length; i++) {
    if (!(i in chunks)) break;
    const res = P.readResult(chunks[i].join('\n'), stmts[i].sql);
    if (res.kind === 'rows' && res.rows.length > MAX_ROWS) { res.total = res.rows.length; res.rows = res.rows.slice(0, MAX_ROWS); res.truncated = true; }
    results.push({ statement: i + 1, sql: stmts[i].sql.slice(0, 300), ...res });
  }
  if (r.truncated && results.length) { const last = results[results.length - 1]; last.truncated = true; }
  let error = null;
  if (r.timedOut) error = { message: 'The query took too long and was stopped', statement: results.length || 1 };
  else if (r.code !== 0 || (!ended && !r.truncated)) {
    const failed = Math.max(0, Object.keys(chunks).length - 1);
    if (results[failed]) results.splice(failed); // the failed statement printed nothing useful
    error = { message: cleanErr(r.stderr) || 'Failed', statement: failed + 1 };
  }
  const notices = r.code === 0 ? cleanErr(r.stderr) : '';
  return { results, error, notices: notices || null, ms, writes, truncated: !!r.truncated };
}

// ---------- edits (primary key only) ----------
async function editable(t, dbn, schema, table) {
  if (!t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first.', 403, { code: 'READ_ONLY' });
  const st = await structureOf(t, dbn, schema, table);
  if (!(st.kind === 'r' || st.kind === 'p')) throw err('Only tables can be changed here');
  if (!st.pk.length) throw err('This table has no primary key — change it with SQL', 400, { code: 'NO_PK' });
  return st;
}
const keyWhere = (st, pk) => {
  if (!pk || typeof pk !== 'object') throw err('Which row?');
  return st.pk.map(c => { if (!(c in pk) || pk[c] === null) throw err(`The key ${c} is missing`); return `${P.ident(c)} = ${P.lit(pk[c])}`; }).join(' AND ');
};
const colSet = (st, obj) => { const names = new Set(st.columns.map(c => c.name)); return Object.keys(obj || {}).map(k => { if (!names.has(k)) throw err(`Unknown column: ${k}`); return k; }); };
async function write(t, dbn, sql) {
  const r = await psql(t, ['-At', '-c', sql], { db: dbn, readOnly: false });
  failIfBad(r);
  return JSON.parse(String(r.stdout || '').trim() || 'null');
}

async function updateRow(name, dbname, { schema, table, pk, set }) {
  const t = await resolve(name); const dbn = dbOf(t, dbname); const st = await editable(t, dbn, schema, table);
  const cols = colSet(st, set); if (!cols.length) throw err('Nothing to change');
  const d = await write(t, dbn, `with u as (update ${P.qname(st.schema, st.name)} set ${cols.map(c => `${P.ident(c)} = ${P.lit(set[c])}`).join(', ')} where ${keyWhere(st, pk)} returning 1) select json_build_object('n', count(*)) from u`);
  if (Number(d.n) !== 1) throw err('The row is not there any more — reload the table', 409, { code: 'GONE' });
  return { updated: 1, sql: `UPDATE ${st.schema}.${st.name} SET ${cols.join(', ')} WHERE ${st.pk.join(', ')}` };
}
async function insertRow(name, dbname, { schema, table, values }) {
  const t = await resolve(name); const dbn = dbOf(t, dbname); const st = await editable(t, dbn, schema, table);
  const cols = colSet(st, values);
  const body = cols.length ? `(${cols.map(P.ident).join(', ')}) values (${cols.map(c => P.lit(values[c])).join(', ')})` : 'default values';
  const d = await write(t, dbn, `with i as (insert into ${P.qname(st.schema, st.name)} ${body} returning ${st.pk.map(c => `${P.ident(c)}::text`).join(', ')}) select coalesce(json_agg(row_to_json(i)), '[]') from i`);
  return { inserted: d.length, key: d[0] || null };
}
async function deleteRows(name, dbname, { schema, table, pks }) {
  const t = await resolve(name); const dbn = dbOf(t, dbname); const st = await editable(t, dbn, schema, table);
  if (!Array.isArray(pks) || !pks.length) throw err('Which rows?');
  if (pks.length > 1000) throw err('At most 1000 rows at once');
  const where = pks.map(pk => `(${keyWhere(st, pk)})`).join(' OR ');
  const d = await write(t, dbn, `with d as (delete from ${P.qname(st.schema, st.name)} where ${where} returning 1) select json_build_object('n', count(*)) from d`);
  return { deleted: Number(d.n), asked: pks.length };
}

// ---------- export ----------
async function exportTable(name, dbname, schema, table, format, onChunk) {
  const t = await resolve(name); const dbn = dbOf(t, dbname);
  const st = await structureOf(t, dbn, schema, table);
  const src = P.qname(st.schema, st.name);
  const args = format === 'json'
    ? ['-At', '-v', 'FETCH_COUNT=1000', '-c', `select row_to_json(t)::text from ${src} t`]
    : ['-c', `COPY (select * from ${src}) TO STDOUT WITH (FORMAT csv, HEADER)`];
  const r = await psql(t, args, { db: dbn, timeoutMs: 600000, onStdout: onChunk });
  failIfBad(r);
  return { name: `${st.schema}.${st.name}` };
}

module.exports = {
  targets, resolve, saveSettings, info, objects, structure, rows, count, runSql, updateRow, insertRow, deleteRows, exportTable, psql, json, psqlTool, toolArgs, dockerExecLine, maintenanceDb,
  IMAGE_RE, isPg, defaultsFrom, whereOf,
  _setExec(fn) { execImpl = fn || dockerExec; how.clear(); },
};
