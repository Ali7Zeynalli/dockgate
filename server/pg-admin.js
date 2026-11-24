// Tools > Databases > Admin: who is connected, roles, databases, table health (dead rows, vacuum), slow queries.
// Everything that changes something needs "Allow changes" on the connection (pg-studio settings).
const S = require('./pg-studio');
const P = require('./pg-sql');

const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const NAME_RE = /^[A-Za-z_][\w$-]{0,62}$/;
const okName = (n, what) => { const s = String(n || '').trim(); if (!NAME_RE.test(s)) throw err(`${what}: letters, digits, _ $ - (start with a letter)`); return s; };

async function changer(name) {
  const t = await S.resolve(name);
  if (!t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first.', 403, { code: 'READ_ONLY' });
  return t;
}
async function exec(t, dbname, sql) {
  const r = await S.psql(t, ['-At', '-c', sql], { db: dbname || t.dbname, readOnly: false, timeoutMs: 600000 });
  if (r.code !== 0) throw err(String(r.stderr || 'failed').replace(/^psql:(\s*error:)?\s*/gm, '').trim(), 400);
  return String(r.stdout || '').trim();
}

/** Overview: connections (used / max), sessions, roles, databases, key settings, table health, slow queries. */
async function overview(name, dbname) {
  const t = await S.resolve(name);
  const db = dbname || t.dbname;
  const d = await S.json(t, db, `select json_build_object(
    'maxConnections', current_setting('max_connections')::int,
    'connections', (select count(*) from pg_stat_activity where backend_type = 'client backend'),
    'settings', (select json_object_agg(name, setting || coalesce(unit, '')) from pg_settings where name in ('shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'max_wal_size', 'wal_level', 'autovacuum', 'timezone', 'listen_addresses', 'ssl', 'password_encryption')),
    'uptime', extract(epoch from now() - pg_postmaster_start_time())::bigint,
    'sessions', (select coalesce(json_agg(json_build_object('pid', pid, 'user', usename, 'db', datname, 'app', application_name, 'client', client_addr::text,
        'state', state, 'since', extract(epoch from now() - coalesce(query_start, backend_start))::bigint, 'wait', wait_event_type || coalesce(':' || wait_event, ''),
        'query', left(query, 500), 'me', pid = pg_backend_pid()) order by query_start nulls last), '[]')
      from pg_stat_activity where backend_type = 'client backend'),
    'roles', (select coalesce(json_agg(json_build_object('name', r.rolname, 'super', r.rolsuper, 'login', r.rolcanlogin, 'createdb', r.rolcreatedb, 'createrole', r.rolcreaterole,
        'replication', r.rolreplication, 'connLimit', r.rolconnlimit, 'validUntil', r.rolvaliduntil,
        'memberOf', (select coalesce(json_agg(g.rolname), '[]') from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid)) order by r.rolname), '[]')
      from pg_roles r where r.rolname !~ '^pg_'),
    'tables', (select coalesce(json_agg(x order by x.size desc), '[]') from (select schemaname as schema, relname as name, n_live_tup as live, n_dead_tup as dead,
        pg_total_relation_size(relid) as size, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, seq_scan, idx_scan
      from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 50) x),
    'statements', (select exists (select 1 from pg_extension where extname = 'pg_stat_statements'))
  )`);
  if (d.statements) {
    try {
      d.slow = await S.json(t, db, `select coalesce(json_agg(x), '[]') from (select left(query, 400) as query, calls, round(total_exec_time::numeric, 1) as total_ms,
        round(mean_exec_time::numeric, 2) as mean_ms, rows from pg_stat_statements order by total_exec_time desc limit 20) x`);
    } catch (e) { d.slow = null; d.slowError = e.message; }
  }
  return d;
}

/** Stop a query (cancel) or close the session (terminate). */
async function session(name, pid, action) {
  const t = await changer(name);
  const p = parseInt(pid, 10); if (!(p > 0)) throw err('Which session?');
  const fn = action === 'terminate' ? 'pg_terminate_backend' : 'pg_cancel_backend';
  const out = await exec(t, t.dbname, `select ${fn}(${p})`);
  return { ok: out === 't' };
}

/** Create a login role, optionally owning / granted a database. */
async function createRole(name, { role, password, createdb = false, superuser = false, database = null, access = 'all' }) {
  const t = await changer(name);
  const r = okName(role, 'Role');
  if (password != null && String(password).length > 0 && String(password).length < 8) throw err('Password: at least 8 characters');
  const opts = ['LOGIN', createdb ? 'CREATEDB' : 'NOCREATEDB', superuser ? 'SUPERUSER' : 'NOSUPERUSER'];
  if (password) opts.push(`PASSWORD ${P.lit(password)}`);
  await exec(t, t.dbname, `CREATE ROLE ${P.ident(r)} WITH ${opts.join(' ')}`);
  if (database) await grant(name, { role: r, database, access });
  return { role: r };
}
async function setPassword(name, { role, password }) {
  const t = await changer(name);
  if (!password || String(password).length < 8) throw err('Password: at least 8 characters');
  await exec(t, t.dbname, `ALTER ROLE ${P.ident(okName(role, 'Role'))} WITH PASSWORD ${P.lit(password)}`);
  return { ok: true };
}
async function dropRole(name, { role }) {
  const t = await changer(name);
  const r = okName(role, 'Role');
  if (r === t.user) throw err('This is the user DockGate logs in with');
  await exec(t, t.dbname, `DROP ROLE ${P.ident(r)}`);
  return { ok: true };
}
/** access: 'read' (connect + usage + select on all tables, now and later) or 'all' (all privileges). */
async function grant(name, { role, database, access = 'all' }) {
  const t = await changer(name);
  const r = P.ident(okName(role, 'Role'));
  const dbn = String(database || '').trim(); if (!dbn) throw err('Which database?');
  const schemas = (await exec(t, dbn, `select string_agg(quote_ident(nspname), ',') from pg_namespace where nspname not in ('pg_catalog','information_schema') and nspname not like 'pg\\_%'`)).split(',').filter(Boolean);
  const stmts = [`GRANT CONNECT${access === 'all' ? ', CREATE, TEMPORARY' : ''} ON DATABASE ${P.ident(dbn)} TO ${r}`];
  for (const s of schemas) {
    if (access === 'all') stmts.push(`GRANT ALL ON SCHEMA ${s} TO ${r}`, `GRANT ALL ON ALL TABLES IN SCHEMA ${s} TO ${r}`, `GRANT ALL ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`, `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ALL ON TABLES TO ${r}`, `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ALL ON SEQUENCES TO ${r}`);
    else stmts.push(`GRANT USAGE ON SCHEMA ${s} TO ${r}`, `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`, `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${r}`);
  }
  const args = []; stmts.forEach(s => args.push('-c', s));
  const res = await S.psql(t, args, { db: dbn, readOnly: false });
  if (res.code !== 0) throw err(String(res.stderr).replace(/^psql:(\s*error:)?\s*/gm, '').trim());
  return { ok: true, statements: stmts.length };
}

async function createDatabase(name, { database, owner }) {
  const t = await changer(name);
  const d = okName(database, 'Database');
  await exec(t, t.dbname, `CREATE DATABASE ${P.ident(d)}${owner ? ` OWNER ${P.ident(okName(owner, 'Owner'))}` : ''}`);
  return { database: d };
}
async function dropDatabase(name, { database, confirm }) {
  const t = await changer(name);
  const d = String(database || '');
  if (!d || confirm !== d) throw err('Type the database name to confirm', 400, { code: 'CONFIRM' });
  const maint = await S.maintenanceDb(t, [d]);
  await exec(t, maint, `select pg_terminate_backend(pid) from pg_stat_activity where datname = ${P.lit(d)} and pid <> pg_backend_pid()`);
  await exec(t, maint, `DROP DATABASE ${P.ident(d)}`);
  return { ok: true };
}

/** VACUUM (ANALYZE) / ANALYZE / REINDEX for a table, or the whole database when no table is given. */
async function maintain(name, dbname, { action, schema, table }) {
  const t = await changer(name);
  const target = table ? ` ${P.qname(schema || 'public', table)}` : '';
  const sql = action === 'analyze' ? `ANALYZE${target}` : action === 'reindex' ? (table ? `REINDEX TABLE${target}` : `REINDEX DATABASE ${P.ident(dbname || t.dbname)}`) : action === 'vacuum_full' ? `VACUUM (FULL, ANALYZE)${target}` : `VACUUM (ANALYZE)${target}`;
  const t0 = Date.now();
  await exec(t, dbname, sql);
  return { ok: true, sql, ms: Date.now() - t0 };
}

module.exports = { overview, session, createRole, setPassword, dropRole, grant, createDatabase, dropDatabase, maintain };
