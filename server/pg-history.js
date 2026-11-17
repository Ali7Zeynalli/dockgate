// Databases → who wrote a row, when, and how.
//   rowInfo(name, db, s, t, pk)       without any setup: the row's last transaction (xmin) and its commit time
//                                     (when track_commit_timestamp is on), plus the edits made from DockGate
//   status / enable / disable          change tracking for a table (opt-in): a trigger writes every INSERT, UPDATE and
//                                     DELETE — the database user, the application_name, the client address, the time,
//                                     the old and new values — into dockgate_audit.changes (kept N days, default 90)
//   rowHistory(…, pk)                  the tracked changes of one row; tableLog(…) of the table (filter by kind / user)
//   restore(…, changeId)               put a row back as it was before an UPDATE, or bring back a deleted row
// The trigger function is SECURITY DEFINER, so the app's users need no rights on dockgate_audit.
const S = require('./pg-studio');
const P = require('./pg-sql');
const { db: localDb } = require('./db');

const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const TRG = 'dockgate_audit_trg';

const SETUP = `
CREATE SCHEMA IF NOT EXISTS dockgate_audit;
CREATE TABLE IF NOT EXISTS dockgate_audit.changes (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  table_name text NOT NULL,
  op text NOT NULL,
  row_key jsonb,
  old_row jsonb,
  new_row jsonb,
  changed text[],
  db_user text NOT NULL DEFAULT current_user,
  app text DEFAULT current_setting('application_name', true),
  client inet DEFAULT inet_client_addr(),
  txid bigint DEFAULT txid_current()
);
CREATE INDEX IF NOT EXISTS changes_row_idx ON dockgate_audit.changes (table_name, row_key);
CREATE INDEX IF NOT EXISTS changes_at_idx ON dockgate_audit.changes (table_name, at);
CREATE TABLE IF NOT EXISTS dockgate_audit.tables (table_name text PRIMARY KEY, keep_days int NOT NULL DEFAULT 90, since timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION dockgate_audit.log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $dgfn$
DECLARE o jsonb; n jsonb; k jsonb := '{}'::jsonb; c text[]; col text; who text;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  FOREACH col IN ARRAY TG_ARGV LOOP k := k || jsonb_build_object(col, coalesce(n, o) ->> col); END LOOP;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO c FROM jsonb_each(n) WHERE n -> key IS DISTINCT FROM o -> key;
    IF c IS NULL THEN RETURN NULL; END IF;
  END IF;
  who := session_user;
  INSERT INTO dockgate_audit.changes (table_name, op, row_key, old_row, new_row, changed, db_user)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, left(TG_OP, 1), k, o, n, c, who);
  RETURN NULL;
END $dgfn$;`;

async function changer(name) {
  const t = await S.resolve(name);
  if (!t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first.', 403, { code: 'READ_ONLY' });
  return t;
}
async function run(t, dbname, sqlList, { readOnly = false } = {}) {
  const args = ['-q']; sqlList.forEach(x => args.push('-c', x));
  const r = await S.psql(t, args, { db: dbname, readOnly, timeoutMs: 120000 });
  if (r.code !== 0) throw err(String(r.stderr || 'failed').replace(/^psql:(\s*error:)?\s*/gm, '').trim(), 400);
  return r;
}
const tableName = (st) => `${st.schema}.${st.name}`;

/** Is the table tracked, how long kept, how many changes kept; and whether commit times are recorded. */
async function status(name, dbname, schema, table) {
  const t = await S.resolve(name);
  const st = await S.structure(name, dbname, schema, table);
  const d = await S.json(t, dbname, `select json_build_object(
    'tracked', exists (select 1 from pg_trigger where tgname = ${P.lit(TRG)} and tgrelid = ${P.lit(P.qname(st.schema, st.name))}::regclass),
    'commitTimes', current_setting('track_commit_timestamp') = 'on',
    'schema', exists (select 1 from pg_namespace where nspname = 'dockgate_audit'),
    'keepDays', (select keep_days from dockgate_audit.tables where table_name = ${P.lit(tableName(st))}),
    'since', (select since from dockgate_audit.tables where table_name = ${P.lit(tableName(st))}),
    'count', (select count(*) from dockgate_audit.changes where table_name = ${P.lit(tableName(st))})
  )`).catch(async () => S.json(t, dbname, `select json_build_object('tracked', false, 'commitTimes', current_setting('track_commit_timestamp') = 'on', 'schema', false, 'count', 0)`));
  return { ...d, pk: st.pk, table: tableName(st) };
}

async function enable(name, dbname, schema, table, { keepDays = 90 } = {}) {
  const t = await changer(name);
  const st = await S.structure(name, dbname, schema, table);
  if (!(st.kind === 'r' || st.kind === 'p')) throw err('Only tables can be tracked');
  if (!st.pk.length) throw err('Tracking needs a primary key to tell the rows apart', 400, { code: 'NO_PK' });
  const days = Math.max(1, Math.min(3650, parseInt(keepDays, 10) || 90));
  const q = P.qname(st.schema, st.name);
  await run(t, dbname, [SETUP,
    `INSERT INTO dockgate_audit.tables (table_name, keep_days) VALUES (${P.lit(tableName(st))}, ${days}) ON CONFLICT (table_name) DO UPDATE SET keep_days = excluded.keep_days`,
    `DROP TRIGGER IF EXISTS ${TRG} ON ${q}`,
    `CREATE TRIGGER ${TRG} AFTER INSERT OR UPDATE OR DELETE ON ${q} FOR EACH ROW EXECUTE PROCEDURE dockgate_audit.log(${st.pk.map(P.lit).join(', ')})`]);
  return status(name, dbname, schema, table);
}

async function disable(name, dbname, schema, table, { dropLog = false } = {}) {
  const t = await changer(name);
  const st = await S.structure(name, dbname, schema, table);
  const list = [`DROP TRIGGER IF EXISTS ${TRG} ON ${P.qname(st.schema, st.name)}`];
  if (dropLog) list.push(`DELETE FROM dockgate_audit.changes WHERE table_name = ${P.lit(tableName(st))}`, `DELETE FROM dockgate_audit.tables WHERE table_name = ${P.lit(tableName(st))}`);
  await run(t, dbname, list).catch((e) => { if (!/dockgate_audit/.test(e.message)) throw e; });
  return status(name, dbname, schema, table);
}

// Changes older than the table's keep_days go (done when the history is read, and when tracking is turned on).
async function prune(t, dbname, tn) {
  await S.psql(t, ['-q', '-c', `DELETE FROM dockgate_audit.changes c USING dockgate_audit.tables x WHERE x.table_name = ${P.lit(tn)} AND c.table_name = x.table_name AND c.at < now() - make_interval(days => x.keep_days)`], { db: dbname, readOnly: false }).catch(() => {});
}

const keyJson = (st, pk) => {
  if (!pk || typeof pk !== 'object') throw err('Which row?');
  return JSON.stringify(Object.fromEntries(st.pk.map(k => { if (!(k in pk)) throw err(`The key ${k} is missing`); return [k, pk[k] == null ? null : String(pk[k])]; })));
};
const changeCols = `id, at, op, row_key as "key", old_row as "old", new_row as "new", changed, db_user as "user", app, host(client) as client, txid`;

/** One row: its last transaction and commit time, edits made from DockGate, and its tracked changes. */
async function rowInfo(name, dbname, schema, table, pk, container) {
  const t = await S.resolve(name);
  const st = await S.structure(name, dbname, schema, table);
  const where = st.pk.map(k => `${P.ident(k)}::text = ${P.lit(pk[k])}`).join(' AND ');
  const tn = tableName(st);
  const info = await S.json(t, dbname, `select json_build_object('xmin', (select xmin::text from ${P.qname(st.schema, st.name)} where ${where}),
    'committed', case when current_setting('track_commit_timestamp') = 'on' then (select pg_xact_commit_timestamp(xmin) from ${P.qname(st.schema, st.name)} where ${where}) end,
    'commitTimes', current_setting('track_commit_timestamp') = 'on')`);
  // edits from DockGate (its own audit log): who in DockGate is "the admin" — so the time, the address and what changed
  const key = JSON.stringify(Object.fromEntries(st.pk.map(k => [k, String(pk[k])])));
  const mine = localDb.prepare(`SELECT action, details, created_at, source_ip FROM activity WHERE resource_type = 'database' AND resource_name = ? AND action IN ('db_changes', 'db_row_update', 'db_row_insert', 'db_row_delete', 'db_restore_row') ORDER BY id DESC LIMIT 500`).all(`${container}/${dbname}`)
    .map(r => ({ ...r, d: (() => { try { return JSON.parse(r.details || '{}'); } catch (e) { return {}; } })() }))
    .filter(r => r.d.table === tn && (
      (r.d.key && JSON.stringify(Object.fromEntries(Object.entries(r.d.key).map(([k, v]) => [k, String(v)]))) === key) ||
      (Array.isArray(r.d.changes) && r.d.changes.some(c => c.key && JSON.stringify(Object.fromEntries(Object.entries(c.key).map(([k, v]) => [k, String(v)]))) === key))))
    .slice(0, 50)
    .map(r => ({ at: r.created_at, action: r.action, from: r.source_ip, columns: r.d.columns || ((r.d.changes || []).find(c => c.key && String(Object.values(c.key)[0]) === String(Object.values(pk)[0])) || {}).columns || null }));
  const s = await status(name, dbname, schema, table);
  let history = [];
  if (s.schema) {
    await prune(t, dbname, tn);
    history = await S.json(t, dbname, `select coalesce(json_agg(x order by x.id desc), '[]') from (select ${changeCols} from dockgate_audit.changes where table_name = ${P.lit(tn)} and row_key = ${P.lit(keyJson(st, pk))}::jsonb order by id desc limit 200) x`).catch(() => []);
  }
  return { ...info, tracked: s.tracked, keepDays: s.keepDays, since: s.since, dockgate: mine, history };
}

/** The table's tracked changes, newest first. filter: { op: I|U|D, user, q (any text in the values), before (id) } */
async function tableLog(name, dbname, schema, table, { op, user, q, before, limit = 100 } = {}) {
  const t = await S.resolve(name);
  const st = await S.structure(name, dbname, schema, table);
  const tn = tableName(st);
  const s = await status(name, dbname, schema, table);
  if (!s.schema) return { status: s, changes: [] };
  await prune(t, dbname, tn);
  const conds = [`table_name = ${P.lit(tn)}`];
  if (['I', 'U', 'D'].includes(op)) conds.push(`op = ${P.lit(op)}`);
  if (user) conds.push(`db_user = ${P.lit(user)}`);
  if (q) conds.push(`(coalesce(old_row::text, '') || coalesce(new_row::text, '')) ILIKE ${P.lit('%' + String(q).replace(/[\\%_]/g, (m) => '\\' + m) + '%')}`);
  if (before) conds.push(`id < ${Number(before) || 0}`);
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  const changes = await S.json(t, dbname, `select coalesce(json_agg(x order by x.id desc), '[]') from (select ${changeCols} from dockgate_audit.changes where ${conds.join(' and ')} order by id desc limit ${n}) x`);
  const users = await S.json(t, dbname, `select coalesce(json_agg(distinct db_user), '[]') from dockgate_audit.changes where table_name = ${P.lit(tn)}`);
  return { status: s, changes, users };
}

/** Put the row back as it was before a tracked UPDATE, or bring back a deleted row (or undo an insert). */
async function restore(name, dbname, schema, table, changeId) {
  const t = await changer(name);
  const st = await S.structure(name, dbname, schema, table);
  const tn = tableName(st);
  const ch = (await S.json(t, dbname, `select coalesce(json_agg(x), '[]') from (select ${changeCols} from dockgate_audit.changes where id = ${Number(changeId) || 0} and table_name = ${P.lit(tn)}) x`))[0];
  if (!ch) throw err('That change is not in the log any more', 404);
  const q = P.qname(st.schema, st.name);
  const cols = st.columns.filter(c => !c.generated && !(c.identity === 'a')).map(c => c.name);
  const rec = (j) => `jsonb_populate_record(null::${q}, ${P.lit(JSON.stringify(j))}::jsonb)`;
  const where = st.pk.map(k => `${P.ident(k)}::text = ${P.lit(ch.key[k])}`).join(' AND ');
  let sql;
  if (ch.op === 'D') sql = `INSERT INTO ${q} (${cols.map(P.ident).join(', ')}) SELECT ${cols.map(c => 'r.' + P.ident(c)).join(', ')} FROM ${rec(ch.old)} r`;
  else if (ch.op === 'U') sql = `UPDATE ${q} SET (${cols.map(P.ident).join(', ')}) = (SELECT ${cols.map(c => 'r.' + P.ident(c)).join(', ')} FROM ${rec(ch.old)} r) WHERE ${where}`;
  else sql = `DELETE FROM ${q} WHERE ${where}`;
  if (cols.length === 1 && ch.op === 'U') sql = `UPDATE ${q} SET ${P.ident(cols[0])} = (SELECT r.${P.ident(cols[0])} FROM ${rec(ch.old)} r) WHERE ${where}`;
  await run(t, dbname, [sql]);
  return { restored: ch.op === 'D' ? 'deleted row brought back' : ch.op === 'U' ? 'row put back as before the change' : 'inserted row removed', key: ch.key, op: ch.op };
}

module.exports = { status, enable, disable, rowInfo, tableLog, restore, SETUP, TRG };
