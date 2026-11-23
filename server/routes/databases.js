// Tools → Databases API (server/pg-studio.js) — PostgreSQL in containers of the active server. Mounted at /api/databases.
const express = require('express');
const router = express.Router();
const { logAction } = require('../audit');
const S = require('../pg-studio');
const A = require('../pg-admin');
const BK = require('../pg-backup');

const send = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(e.statusCode || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.danger ? { danger: e.danger } : {}), ...(e.names ? { names: e.names } : {}), ...(e.at != null ? { at: e.at } : {}) }); }
};
const audit = (req, action, details) => logAction({ req, resourceType: 'database', resourceName: `${req.params.c}${req.params.db ? '/' + req.params.db : ''}`, action, details });

router.get('/', send(async () => ({ containers: await S.targets() })));
router.get('/:c/info', send(async (req) => S.info(req.params.c)));
// body { user?, dbname?, password?, allowWrite?, production? }
router.put('/:c/settings', send(async (req) => {
  const b = req.body || {};
  const r = S.saveSettings(req.params.c, b);
  audit(req, 'db_settings', { user: b.user, dbname: b.dbname, password: b.password !== undefined ? (b.password ? 'set' : 'cleared') : undefined, allowWrite: b.allowWrite, production: b.production });
  return r;
}));
router.get('/:c/db/:db/objects', send(async (req) => S.objects(req.params.c, req.params.db)));
router.get('/:c/db/:db/structure', send(async (req) => S.structure(req.params.c, req.params.db, req.query.schema, req.query.table)));
// body { schema, table, limit, offset, sort: [{ col, dir }], filters: [{ col, op, value }], where }
router.post('/:c/db/:db/rows', send(async (req) => S.rows(req.params.c, req.params.db, req.body || {})));
// Export / import / test data for whole databases or ticked tables — pg-io.js
const IO = require('../pg-io');
const fileName = (req, ext) => `${req.params.db}${req.query.tables && String(req.query.tables).split(',').length === 1 ? '.' + String(req.query.tables).split('.').pop() : ''}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.${ext}`.replace(/[^\w.-]+/g, '_');
router.get('/:c/db/:db/dump', async (req, res) => {
  const gz = req.query.gz === '1'; let started = false; let out = res;
  try {
    await IO.dump(req.params.c, req.params.db, { tables: req.query.tables, what: req.query.what, rows: req.query.rows, clean: req.query.clean === '1' }, (chunk) => {
      if (!started) { started = true; res.setHeader('Content-Type', gz ? 'application/gzip' : 'application/sql; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, gz ? 'sql.gz' : 'sql')}"`); if (gz) { out = require('zlib').createGzip(); out.pipe(res); } }
      out.write(chunk);
    });
    audit(req, 'db_export', { format: 'sql', what: req.query.what || 'both', tables: req.query.tables ? String(req.query.tables).slice(0, 500) : 'all' });
    if (!started) { res.setHeader('Content-Type', 'application/sql; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, 'sql')}"`); }
    out.end();
  } catch (e) { if (!started) res.status(e.statusCode || 500).json({ error: e.message }); else { try { out.write(`\n-- DockGate: the export stopped: ${e.message}\n`); } catch (x) {} out.end(); } }
});
router.get('/:c/db/:db/export-zip', async (req, res) => {
  try {
    const fmt = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const buf = await IO.zipTables(req.params.c, req.params.db, { tables: req.query.tables, format: fmt });
    audit(req, 'db_export', { format: fmt, tables: String(req.query.tables || '').slice(0, 500) });
    res.setHeader('Content-Type', fmt === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, fmt === 'xlsx' ? 'xlsx' : 'csv.zip')}"`);
    res.end(buf);
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});
// the body is the file itself (application/octet-stream), gunzipped here when ?gz=1
router.post('/:c/db/:db/import-sql', send(async (req) => {
  let src = req; if (req.query.gz === '1') { src = req.pipe(require('zlib').createGunzip()); }
  const r = await IO.importSql(req.params.c, req.params.db, src, { single: req.query.single === '1' });
  audit(req, 'db_import_sql', { file: String(req.query.name || '').slice(0, 120), single: req.query.single === '1', tags: r.tags });
  return r;
}));
router.post('/:c/db/:db/mock', send(async (req) => {
  const b = req.body || {};
  const r = await IO.mock(req.params.c, req.params.db, b);
  if (!r.test) audit(req, 'db_mock_rows', { table: `${b.schema}.${b.table}`, rows: r.rows });
  return r;
}));
// Design: structure changes as operations → SQL (preview), run in one transaction (test: rolled back) — pg-ddl.js
const D = require('../pg-ddl');
router.post('/:c/db/:db/ddl/preview', send(async (req) => D.preview(req.params.c, req.params.db, req.body || {})));
router.post('/:c/db/:db/ddl/apply', send(async (req) => {
  const b = req.body || {};
  const r = await D.apply(req.params.c, req.params.db, b);
  if (!r.test) audit(req, 'db_ddl', { table: b.table ? `${b.schema}.${b.table}` : ((b.ops || [])[0] || {}).name, statements: r.statements.map(x => x.sql).join(';\n').slice(0, 3000) });
  return r;
}));
router.post('/:c/db/:db/count', send(async (req) => S.count(req.params.c, req.params.db, req.body || {})));
// body { sql, confirm }
router.post('/:c/db/:db/sql', send(async (req) => {
  const b = req.body || {};
  const r = await S.runSql(req.params.c, req.params.db, b.sql, { confirm: !!b.confirm });
  if (r.writes) audit(req, 'db_sql', { sql: String(b.sql).slice(0, 1000), error: r.error ? r.error.message.slice(0, 300) : undefined });
  return r;
}));
router.post('/:c/db/:db/row/update', send(async (req) => { const r = await S.updateRow(req.params.c, req.params.db, req.body || {}); audit(req, 'db_row_update', { table: `${req.body.schema}.${req.body.table}`, key: req.body.pk, columns: Object.keys(req.body.set || {}) }); return r; }));
router.post('/:c/db/:db/row/insert', send(async (req) => { const r = await S.insertRow(req.params.c, req.params.db, req.body || {}); audit(req, 'db_row_insert', { table: `${req.body.schema}.${req.body.table}`, key: r.key }); return r; }));
router.post('/:c/db/:db/row/delete', send(async (req) => { const r = await S.deleteRows(req.params.c, req.params.db, req.body || {}); audit(req, 'db_row_delete', { table: `${req.body.schema}.${req.body.table}`, rows: r.deleted }); return r; }));
// body { schema, table, changes: [...], test } — many edits in one transaction (see pg-studio.applyChanges)
router.post('/:c/db/:db/changes', send(async (req) => {
  const b = req.body || {};
  const r = await S.applyChanges(req.params.c, req.params.db, b);
  if (!r.test) audit(req, 'db_changes', { table: `${b.schema}.${b.table}`, update: r.update, insert: r.insert, delete: r.delete, changes: (b.changes || []).slice(0, 50).map(c => ({ op: c.op, key: c.pk, columns: Object.keys(c.set || c.values || {}) })) });
  return r;
}));
router.get('/:c/db/:db/fk-lookup', send(async (req) => S.fkLookup(req.params.c, req.params.db, { schema: req.query.schema, table: req.query.table, column: req.query.column, q: req.query.q || '', key: req.query.key })));
router.post('/:c/db/:db/referencing', send(async (req) => S.referencing(req.params.c, req.params.db, req.body || {})));
// ---------- who wrote it: row info, change tracking (pg-history.js) ----------
const H = require('../pg-history');
router.get('/:c/db/:db/history/status', send(async (req) => H.status(req.params.c, req.params.db, req.query.schema, req.query.table)));
router.post('/:c/db/:db/history/enable', send(async (req) => { const b = req.body || {}; const r = await H.enable(req.params.c, req.params.db, b.schema, b.table, b); audit(req, 'db_tracking_on', { table: `${b.schema}.${b.table}`, keepDays: r.keepDays }); return r; }));
router.post('/:c/db/:db/history/disable', send(async (req) => { const b = req.body || {}; const r = await H.disable(req.params.c, req.params.db, b.schema, b.table, b); audit(req, 'db_tracking_off', { table: `${b.schema}.${b.table}`, dropLog: !!b.dropLog }); return r; }));
router.post('/:c/db/:db/history/row', send(async (req) => { const b = req.body || {}; return H.rowInfo(req.params.c, req.params.db, b.schema, b.table, b.pk, req.params.c); }));
router.post('/:c/db/:db/history/log', send(async (req) => { const b = req.body || {}; return H.tableLog(req.params.c, req.params.db, b.schema, b.table, b); }));
router.post('/:c/db/:db/history/restore', send(async (req) => { const b = req.body || {}; const r = await H.restore(req.params.c, req.params.db, b.schema, b.table, b.id); audit(req, 'db_restore_row', { table: `${b.schema}.${b.table}`, key: r.key, change: b.id }); return r; }));
// ---------- many rows at once (pg-bulk.js) ----------
const BU = require('../pg-bulk');
// body { schema, table, columns, rows, mode: insert | upsert | skip, emptyNull, test } (up to 100 MB — see index.js)
router.post('/:c/db/:db/import', send(async (req) => { const b = req.body || {}; const r = await BU.importRows(req.params.c, req.params.db, b); if (!r.test) audit(req, 'db_import', { table: `${b.schema}.${b.table}`, rows: r.rows, written: r.written, mode: r.mode }); return r; }));
// body { schema, table, filters, where, set, op: update | delete, test, all }
router.post('/:c/db/:db/bulk', send(async (req) => { const b = req.body || {}; const r = await BU.bulkUpdate(req.params.c, req.params.db, b); if (!r.test) audit(req, 'db_bulk_' + r.op, { table: `${b.schema}.${b.table}`, rows: r.rows, set: b.op === 'delete' ? undefined : Object.keys(b.set || {}), filters: b.filters, where: b.where || undefined }); return r; }));
// body { schema, table, column, find, replace, matchCase, wholeValue, filters, where, preview, test }
router.post('/:c/db/:db/replace', send(async (req) => { const b = req.body || {}; const r = await BU.findReplace(req.params.c, req.params.db, b); if (!r.test && !r.preview) audit(req, 'db_replace', { table: `${b.schema}.${b.table}`, column: b.column, find: String(b.find).slice(0, 100), replace: String(b.replace || '').slice(0, 100), rows: r.rows }); return r; }));
// ?schema&table&format=csv|json — streamed download
router.get('/:c/db/:db/export', async (req, res) => {
  const fmt = req.query.format === 'json' ? 'json' : 'csv';
  const fname = `${req.query.schema}.${req.query.table}`.replace(/[^\w.-]+/g, '_');
  let started = false;
  try {
    await S.exportTable(req.params.c, req.params.db, req.query.schema, req.query.table, fmt, (chunk) => {
      if (!started) { started = true; res.setHeader('Content-Type', fmt === 'json' ? 'application/x-ndjson' : 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${fname}.${fmt === 'json' ? 'jsonl' : 'csv'}"`); }
      res.write(chunk);
    });
    if (!started) { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${fname}.${fmt === 'json' ? 'jsonl' : 'csv'}"`); }
    res.end();
  } catch (e) { if (started) res.end(); else res.status(e.statusCode || 500).json({ error: e.message }); }
});

// ---------- SQL Workbench ----------
const WS = require('../pg-session');
const WB = require('../pg-workbench');
const sessKey = (req) => {
  const id = String(req.params.sid || '');
  if (!WB.ID_RE.test(id)) throw Object.assign(new Error('Bad session id'), { statusCode: 400 });
  return `${require('../docker').getActiveServerId()}|${req.params.c}|${id}`;
};
// All tables with their columns (for completion in the editor).
router.get('/:c/db/:db/schema-index', send(async (req) => S.schemaIndex(req.params.c, req.params.db)));
// body { sql, mode: run | test, confirm, timeoutMs } — runs in the tab's own session
router.post('/:c/db/:db/session/:sid/run', send(async (req) => {
  const b = req.body || {};
  const t = await S.resolve(req.params.c);
  const ms = Math.max(5000, Math.min(600000, parseInt(b.timeoutMs, 10) || 30000));
  let r;
  try { r = await WS.run(sessKey(req), t, req.params.db, { sql: b.sql, mode: b.mode === 'test' ? 'test' : 'run', confirm: !!b.confirm, timeoutMs: ms, params: b.params && typeof b.params === 'object' ? b.params : null }); }
  catch (e) { if (!['NEEDS_CONFIRM', 'READ_ONLY', 'BUSY', 'NEEDS_PARAMS'].includes(e.code)) WB.addHistory(req.params.c, { dbname: req.params.db, sql: b.sql, mode: b.mode, ok: false, ms: 0 }); throw e; }
  WB.addHistory(req.params.c, { dbname: req.params.db, sql: b.sql, mode: r.mode, ok: !r.error, ms: r.ms, rows: r.results.reduce((a, x) => a + (x.total || 0), 0) });
  if (r.writes && r.mode === 'run') audit(req, 'db_sql', { sql: String(b.sql).slice(0, 1000), error: r.error ? r.error.message.slice(0, 300) : undefined, tx: r.tx });
  return r;
}));
router.post('/:c/session/:sid/commit', send(async (req) => { const r = await WS.tx(sessKey(req), 'commit'); audit(req, 'db_commit', { ok: r.ok }); return r; }));
router.post('/:c/session/:sid/rollback', send(async (req) => WS.tx(sessKey(req), 'rollback')));
router.post('/:c/session/:sid/cancel', send(async (req) => WS.cancel(sessKey(req))));
router.get('/:c/session/:sid', send(async (req) => WS.state(sessKey(req))));
router.get('/:c/session/:sid/more', send(async (req) => WS.more(sessKey(req), req.query.result, req.query.offset, req.query.limit)));
router.delete('/:c/session/:sid', send(async (req) => WS.close(sessKey(req))));
router.get('/:c/tabs', send(async (req) => ({ tabs: WB.tabs(req.params.c) })));
router.put('/:c/tabs/:sid', send(async (req) => WB.putTab(req.params.c, req.params.sid, req.body || {})));
router.delete('/:c/tabs/:sid', send(async (req) => { try { WS.close(sessKey(req)); } catch (e) {} return WB.delTab(req.params.c, req.params.sid); }));
router.get('/:c/history', send(async (req) => ({ history: WB.history(req.params.c, req.query.q) })));
router.get('/:c/saved', send(async (req) => ({ saved: WB.saved(req.params.c) })));
router.post('/:c/saved', send(async (req) => WB.saveQuery(req.params.c, req.body || {})));
router.delete('/:c/saved/:id', send(async (req) => WB.delSaved(req.params.c, req.params.id)));

// ---------- Admin ----------
router.get('/:c/db/:db/admin', send(async (req) => A.overview(req.params.c, req.params.db)));
// body { pid, action: cancel | terminate }
router.post('/:c/session', send(async (req) => { const r = await A.session(req.params.c, req.body.pid, req.body.action); audit(req, 'db_session_' + (req.body.action === 'terminate' ? 'terminate' : 'cancel'), { pid: req.body.pid }); return r; }));
router.post('/:c/roles', send(async (req) => { const b = req.body || {}; const r = await A.createRole(req.params.c, b); audit(req, 'db_role_create', { role: r.role, createdb: !!b.createdb, superuser: !!b.superuser, database: b.database || undefined, access: b.database ? b.access : undefined }); return r; }));
router.post('/:c/roles/password', send(async (req) => { const r = await A.setPassword(req.params.c, req.body || {}); audit(req, 'db_role_password', { role: req.body.role }); return r; }));
router.post('/:c/roles/drop', send(async (req) => { const r = await A.dropRole(req.params.c, req.body || {}); audit(req, 'db_role_drop', { role: req.body.role }); return r; }));
router.post('/:c/roles/grant', send(async (req) => { const r = await A.grant(req.params.c, req.body || {}); audit(req, 'db_role_grant', { role: req.body.role, database: req.body.database, access: req.body.access }); return r; }));
router.post('/:c/databases', send(async (req) => { const r = await A.createDatabase(req.params.c, req.body || {}); audit(req, 'db_create', { database: r.database, owner: req.body.owner }); return r; }));
router.post('/:c/databases/drop', send(async (req) => { const r = await A.dropDatabase(req.params.c, req.body || {}); audit(req, 'db_drop', { database: req.body.database }); return r; }));
// body { action: vacuum | vacuum_full | analyze | reindex, schema?, table? }
router.post('/:c/db/:db/maintain', send(async (req) => { const r = await A.maintain(req.params.c, req.params.db, req.body || {}); audit(req, 'db_maintain', { sql: r.sql }); return r; }));

// ---------- Backups ----------
router.get('/:c/backups', send(async (req) => BK.list(req.params.c)));
// body { database, kind: custom | sql | all }
router.post('/:c/backups', send(async (req) => { const r = await BK.create(req.params.c, req.body || {}); audit(req, 'db_backup', { file: r.file, size: r.size }); return r; }));
router.delete('/:c/backups/:file', send(async (req) => { const r = await BK.remove(req.params.c, req.params.file); audit(req, 'db_backup_delete', { file: req.params.file }); return r; }));
router.get('/:c/backups/:file/download', async (req, res) => {
  try { await BK.download(req.params.c, req.params.file, res); }
  catch (e) { if (!res.headersSent) res.status(e.statusCode || (e.code === 'ENOENT' || e.code === 2 ? 404 : 500)).json({ error: e.message }); else res.end(); }
});
// body { file, target, keepOwners }
router.post('/:c/backups/restore', send(async (req) => { const r = await BK.restore(req.params.c, req.body || {}); audit(req, 'db_restore', { file: req.body.file, database: r.database }); return r; }));
// body { restored, into }
router.post('/:c/backups/swap', send(async (req) => { const r = await BK.swap(req.params.c, req.body || {}); audit(req, 'db_swap', { database: r.database, kept: r.kept }); return r; }));
// body { database, keepDays, schedule } — a Scripts entry + a Cron job (SSH servers)
router.post('/:c/backups/schedule', send(async (req) => {
  const dockerSvc = require('../docker');
  const id = dockerSvc.getActiveServerId();
  if (id === 'local') throw Object.assign(new Error('On this machine a scheduled backup is a task in Tools → Schedules: Add schedule → "Back up a database".'), { statusCode: 400 });
  const server = require('../db').stmts.getServer.get(id);
  const t = await S.resolve(req.params.c);
  const b = req.body || {};
  const spec = BK.scheduleSpec(t.name, { database: b.database, keepDays: b.keepDays, user: t.user });
  const scripts = require('../scripts');
  const existing = scripts.list(server.id).find(s => s.name === spec.name);
  const saved = await scripts.save(server, spec, existing ? existing.id : null, { force: true });
  await scripts.schedule(server, saved.id, { schedule: String(b.schedule || '15 3 * * *'), notify: ['fail', 'missed'], log: true });
  audit(req, 'db_backup_schedule', { script: saved.name, schedule: b.schedule });
  return { script: saved.name, path: saved.path };
}));

module.exports = router;
