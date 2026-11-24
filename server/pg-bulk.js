// Databases -> many rows at once, each in ONE transaction (or a Test that rolls back):
//   importRows(...)    CSV rows into a table: insert, insert-or-update by primary key, or skip rows whose key exists
//   bulkUpdate(...)    set columns (or delete) on every row matching the Data tab's filter
//   findReplace(...)   replace a text in one column (part of the value or the whole value), with a preview
const S = require('./pg-studio');
const P = require('./pg-sql');

const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const BATCH = 500;

async function prepare(name, dbname, schema, table, test) {
  const t = await S.resolve(name);
  if (!test && !t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first, or use Test (it rolls back).', 403, { code: 'READ_ONLY' });
  const st = await S.structure(name, dbname, schema, table);
  if (!(st.kind === 'r' || st.kind === 'p')) throw err('Only tables can be changed here');
  return { t, st, q: P.qname(st.schema, st.name) };
}
const cleanErr = (s) => String(s || '').split('\n').map(l => l.replace(/^psql:[^:]*:\d+:\s*/, '')).filter(l => l && !/^(CONTEXT|LINE \d+|\s+\^)/.test(l)).join('\n').trim();

/** rows: [[...]] in the order of columns; mode: insert | upsert | skip; emptyNull: an empty cell is NULL. */
async function importRows(name, dbname, { schema, table, columns, rows, mode = 'insert', emptyNull = true, test = false }) {
  const { t, st, q } = await prepare(name, dbname, schema, table, test);
  const known = new Map(st.columns.map(c => [c.name, c]));
  if (!Array.isArray(columns) || !columns.length) throw err('Map at least one column');
  columns.forEach(c => { if (!known.has(c)) throw err(`Unknown column: ${c}`); if (known.get(c).generated) throw err(`${c} is generated - it can not be imported`); });
  if (new Set(columns).size !== columns.length) throw err('A column is mapped twice');
  if (!Array.isArray(rows) || !rows.length) throw err('No rows to import');
  if (rows.length > 500000) throw err('At most 500 000 rows at once');
  if ((mode === 'upsert' || mode === 'skip') && !st.pk.length) throw err('Update / skip by key needs a primary key');
  if (mode === 'upsert' && !st.pk.every(k => columns.includes(k))) throw err(`Map the primary key (${st.pk.join(', ')}) to update rows by it`);
  const lit = (v) => (v === null || v === undefined || (emptyNull && v === '') ? 'NULL' : P.lit(v));
  const head = `INSERT INTO ${q} (${columns.map(P.ident).join(', ')}) VALUES `;
  const others = columns.filter(c => !st.pk.includes(c));
  const tail = mode === 'skip' ? ` ON CONFLICT (${st.pk.map(P.ident).join(', ')}) DO NOTHING`
    : mode === 'upsert' ? (others.length ? ` ON CONFLICT (${st.pk.map(P.ident).join(', ')}) DO UPDATE SET ${others.map(c => `${P.ident(c)} = excluded.${P.ident(c)}`).join(', ')}` : ` ON CONFLICT (${st.pk.map(P.ident).join(', ')}) DO NOTHING`) : '';
  const out = ['BEGIN;'];
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    out.push(head + part.map((r, j) => { if (!Array.isArray(r) || r.length !== columns.length) throw err(`Row ${i + j + 1} has ${Array.isArray(r) ? r.length : 0} cells, ${columns.length} expected`); return `(${r.map(lit).join(', ')})`; }).join(',\n') + tail + ';');
  }
  out.push(test ? 'ROLLBACK;' : 'COMMIT;');
  const sqlText = out.join('\n') + '\n';
  const { Readable } = require('stream');
  const argv = S.toolArgs(t, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', t.user, '-d', dbname || t.dbname, '-f', '-']);
  let stdout = '';
  const r = await S.psqlTool(t, argv, { stdin: Readable.from([sqlText]), onStdout: (c) => { stdout += c.toString(); }, timeoutMs: 30 * 60000 });
  if (r.code !== 0) {
    const e = String(r.stderr || '');
    const m = /psql:[^:]*:(\d+):/.exec(e);
    let row = null;
    if (m) { const line = Number(m[1]); const lines = sqlText.split('\n'); let stmt = -1; for (let k = 0; k < line && k < lines.length; k++) if (lines[k].startsWith('INSERT INTO')) stmt++; if (stmt >= 0) row = stmt * BATCH + 1; }
    throw err(`${cleanErr(e) || 'The import failed'}${row ? ` (in rows ${row}–${row + BATCH - 1})` : ''} - nothing was imported.`, 400, { code: 'FAILED' });
  }
  const done = [...stdout.matchAll(/^INSERT 0 (\d+)$/gm)].reduce((a, x) => a + Number(x[1]), 0);
  return { rows: rows.length, written: done, skipped: rows.length - done, test: !!test, mode };
}

/** set: { column: value | null } on every row matching filters / where; or op 'delete'. all: allow no filter. */
async function bulkUpdate(name, dbname, { schema, table, filters = [], where = '', set, op = 'update', test = false, all = false }) {
  const { t, st, q } = await prepare(name, dbname, schema, table, test);
  const w = S.whereOf(st.columns, { filters, where });
  if (!w && !all) throw err('No filter: this would change every row. Filter the rows first, or confirm every row.', 409, { code: 'ALL_ROWS' });
  let stmt;
  if (op === 'delete') stmt = `DELETE FROM ${q}${w}`;
  else {
    const cols = Object.keys(set || {}); if (!cols.length) throw err('Nothing to set');
    const known = new Set(st.columns.filter(c => !c.generated).map(c => c.name));
    cols.forEach(c => { if (!known.has(c)) throw err(`Unknown column: ${c}`); });
    stmt = `UPDATE ${q} SET ${cols.map(c => `${P.ident(c)} = ${set[c] === null ? 'NULL' : P.lit(set[c])}`).join(', ')}${w}`;
  }
  const sql = `with x as (${stmt} returning 1) select json_build_object('n', count(*)) from x`;
  const args = test ? ['-At', '-c', 'BEGIN', '-c', sql, '-c', 'ROLLBACK'] : ['-At', '-c', sql];
  const r = await S.psql(t, args, { db: dbname, readOnly: false, timeoutMs: 600000 });
  if (r.code !== 0) throw err(`${cleanErr(r.stderr)} - nothing was changed.`, 400, { code: 'FAILED' });
  const line = String(r.stdout).split('\n').find(l => l.startsWith('{'));
  return { rows: line ? Number(JSON.parse(line).n) : 0, test: !!test, op };
}

/** Replace text in one column. wholeValue: only cells equal to `find`; matchCase: case-sensitive. preview: count + samples. */
async function findReplace(name, dbname, { schema, table, column, find, replace = '', matchCase = false, wholeValue = false, filters = [], where = '', preview = false, test = false }) {
  const { t, st, q } = await prepare(name, dbname, schema, table, test || preview);
  const c = st.columns.find(x => x.name === column);
  if (!c) throw err(`Unknown column: ${column}`);
  if (c.generated) throw err(`${column} is generated`);
  if (find == null || String(find) === '') throw err('What to find?');
  const col = P.ident(column), f = String(find), rp = String(replace == null ? '' : replace);
  const reEsc = (x) => x.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const likeEsc = (x) => x.replace(/[\\%_]/g, (m) => '\\' + m);
  const match = wholeValue ? (matchCase ? `${col}::text = ${P.lit(f)}` : `lower(${col}::text) = lower(${P.lit(f)})`) : `${col}::text ${matchCase ? 'LIKE' : 'ILIKE'} ${P.lit('%' + likeEsc(f) + '%')}`;
  const newVal = wholeValue ? P.lit(rp) : matchCase ? `replace(${col}::text, ${P.lit(f)}, ${P.lit(rp)})` : `regexp_replace(${col}::text, ${P.lit(reEsc(f))}, ${P.lit(rp.replace(/\\/g, '\\\\'))}, 'gi')`;
  const base = S.whereOf(st.columns, { filters, where });
  const cond = base ? `${base} AND ${match}` : ` WHERE ${match}`;
  if (preview) {
    const d = await S.json(t, dbname, `select json_build_object('rows', (select count(*) from ${q}${cond}), 'samples', (select coalesce(json_agg(x), '[]') from (select ${col}::text as before, ${newVal} as after from ${q}${cond} limit 10) x))`);
    return { preview: true, ...d };
  }
  const sql = `with x as (update ${q} set ${col} = ${newVal}${cond} returning 1) select json_build_object('n', count(*)) from x`;
  const args = test ? ['-At', '-c', 'BEGIN', '-c', sql, '-c', 'ROLLBACK'] : ['-At', '-c', sql];
  const r = await S.psql(t, args, { db: dbname, readOnly: false, timeoutMs: 600000 });
  if (r.code !== 0) throw err(`${cleanErr(r.stderr)} - nothing was changed.`, 400, { code: 'FAILED' });
  const line = String(r.stdout).split('\n').find(l => l.startsWith('{'));
  return { rows: line ? Number(JSON.parse(line).n) : 0, test: !!test };
}

module.exports = { importRows, bulkUpdate, findReplace };
