// Tools → Databases → Export / Import / test data, for whole databases or ticked tables:
//   dump(name, db, { tables, what, rows, clean }, onChunk)   pg_dump in the container, plain SQL (streamed)
//   zipTables(name, db, { tables, format })                  .zip of CSV files, or one .xlsx with a sheet per table
//   importSql(name, db, readable, { single })                 a .sql file fed to psql (stops at the first error)
//   mock(name, db, { schema, table, rows, test })             rows of made-up values that fit the columns
//                                                             (types, names like email / phone, foreign keys)
const P = require('./pg-sql');
const Z = require('./zip-write');

const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const S = () => require('./pg-studio');
const pgPattern = (s, t) => `"${String(s).replace(/"/g, '""')}"."${String(t).replace(/"/g, '""')}"`;
function tablesOf(list) {
  const out = (Array.isArray(list) ? list : String(list || '').split(',')).map(x => String(x).trim()).filter(Boolean).map(x => { const i = x.indexOf('.'); if (i < 1) throw err(`Not schema.table: ${x}`); return { schema: x.slice(0, i), table: x.slice(i + 1) }; });
  if (out.length > 500) throw err('At most 500 tables at once');
  return out;
}

async function dump(name, dbname, { tables, what = 'both', rows = 'insert', clean = false } = {}, onChunk) {
  const t = await S().resolve(name); const db = dbname || t.dbname;
  const argv = ['pg_dump', '-U', t.user, '-d', db, '--no-owner', '--no-privileges'];
  if (what === 'schema') argv.push('--schema-only'); else if (what === 'data') argv.push('--data-only');
  if (what !== 'schema' && rows === 'insert') argv.push('--column-inserts', '--rows-per-insert=100');
  if (clean && what !== 'data') argv.push('--clean', '--if-exists');
  for (const x of tablesOf(tables)) argv.push('-t', pgPattern(x.schema, x.table));
  const r = await S().psqlTool(t, S().toolArgs(t, argv), { onStdout: onChunk, timeoutMs: 3600000 });
  if (r.code !== 0) throw err(String(r.stderr || 'pg_dump failed').replace(/^pg_dump:\s*/gm, '').trim().slice(0, 600));
}

const MAX_ZIP = 300 * 1024 * 1024;
async function zipTables(name, dbname, { tables, format = 'csv' } = {}) {
  const list = tablesOf(tables); if (!list.length) throw err('Pick at least one table');
  const files = []; let total = 0;
  for (const x of list) {
    const parts = [];
    await S().exportTable(name, dbname, x.schema, x.table, 'csv', (c) => { total += c.length; if (total > MAX_ZIP) throw err('More than 300 MB — export fewer tables, or use SQL (pg_dump), which streams'); parts.push(Buffer.from(c)); });
    files.push({ ...x, csv: Buffer.concat(parts) });
  }
  if (format === 'xlsx') {
    const sheets = files.map(f => {
      const rows = P.parseCsv(f.csv.toString('utf8')).filter(r => !(r.length === 1 && r[0] === ''));
      if (rows.length > 1048576) throw err(`${f.table} has more rows than a sheet can hold (1 048 576) — export it as CSV`);
      return { name: f.schema === 'public' ? f.table : `${f.schema}.${f.table}`, rows };
    });
    return Z.xlsx(sheets);
  }
  return Z.zip(files.map(f => ({ name: `${f.schema === 'public' ? '' : f.schema + '.'}${f.table}.csv`, data: f.csv })));
}

async function importSql(name, dbname, readable, { single = false } = {}) {
  const t = await S().resolve(name);
  if (!t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first.', 403, { code: 'READ_ONLY' });
  const argv = S().toolArgs(t, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', ...(single ? ['-1'] : []), '-U', t.user, '-d', dbname || t.dbname, '-f', '-']);
  let out = ''; const t0 = Date.now();
  const r = await S().psqlTool(t, argv, { stdin: readable, onStdout: (c) => { out = (out + c.toString()).slice(-20000); }, timeoutMs: 3600000 });
  const tags = {}; out.split('\n').forEach(l => { const m = /^(CREATE|ALTER|INSERT|COPY|DROP|SET|COMMENT|GRANT|SELECT|UPDATE|DELETE)\b/.exec(l.trim()); if (m) tags[m[1]] = (tags[m[1]] || 0) + 1; });
  if (r.code !== 0) {
    const e = String(r.stderr || '');
    const line = (/psql:[^:]*:(\d+):/.exec(e) || [])[1];
    throw err(`${line ? `Line ${line}: ` : ''}${e.replace(/^psql:[^:]*:\d+:\s*/gm, '').replace(/^psql:\s*/gm, '').trim().slice(0, 800)}${single ? ' — nothing was imported (one transaction).' : ' — the statements before it stay done.'}`, 400, { code: 'FAILED', line: line ? Number(line) : null });
  }
  return { ok: true, ms: Date.now() - t0, tags, tail: out.split('\n').slice(-12).join('\n') };
}

// ---------- test data ----------
const FIRST = ['Anna', 'Ben', 'Chloe', 'Daniel', 'Elif', 'Farid', 'Gul', 'Hasan', 'Ivy', 'Jamal', 'Kenan', 'Leyla', 'Mia', 'Nihad', 'Omar', 'Petra', 'Rashad', 'Sara', 'Tural', 'Zara'];
const LAST = ['Aliyev', 'Brown', 'Chen', 'Demir', 'Evans', 'Garcia', 'Huseynov', 'Ivanova', 'Kim', 'Lopez', 'Mammadov', 'Novak', 'Smith', 'Yilmaz'];
const CITY = ['Baku', 'Berlin', 'Istanbul', 'London', 'Madrid', 'Paris', 'Tbilisi', 'Tokyo', 'Toronto', 'Vienna'];
const WORDS = ['alpha', 'blue', 'cloud', 'delta', 'echo', 'forest', 'green', 'harbor', 'island', 'jade', 'kite', 'lemon', 'moon', 'north', 'ocean', 'pine', 'quartz', 'river', 'stone', 'tiger'];
const pick = (arr) => `(ARRAY[${arr.map(x => P.lit(x)).join(',')}])[1 + floor(random() * ${arr.length})::int]`;
function valueFor(c, { unique, enumType }) {
  const n = c.name.toLowerCase(); const ty = String(c.type).toLowerCase();
  const len = Number((/(?:character varying|varchar|character|char)\((\d+)\)/.exec(ty) || [])[1]) || null;
  const cut = (e) => (len ? `left(${e}, ${len})` : e);
  const u = unique ? ` || '-' || g || '-' || substr(md5(random()::text), 1, 4)` : '';
  if (enumType) return `(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = ${P.lit(c.type)}::regtype AND g >= 0 ORDER BY random() LIMIT 1)::${c.type}`;
  if (/\[\]$/.test(ty)) return /int|numeric|real|double/.test(ty) ? `ARRAY[g, (random() * 100)::int]::${c.type}` : `ARRAY[${pick(WORDS)}, ${pick(WORDS)}]::${c.type}`;
  if (/^(smallint|integer|bigint|int2|int4|int8)/.test(ty)) return unique ? `(SELECT coalesce(max(${P.ident(c.name)}), 0) FROM __T__) + g` : /age/.test(n) ? '18 + (random() * 60)::int' : /qty|quantity|count|stock/.test(n) ? '(random() * 50)::int' : ty.startsWith('smallint') ? '(random() * 100)::int' : '(random() * 10000)::int';
  if (/^numeric|^decimal/.test(ty)) { const m = /\((\d+)(?:,\s*(\d+))?\)/.exec(ty); const p = m ? Number(m[1]) : 12, s = m && m[2] ? Number(m[2]) : 2; const max = Math.min(10000, Math.pow(10, Math.max(1, p - s)) - 1); return `round((random() * ${max})::numeric, ${s})`; }
  if (/^(real|double precision|float)/.test(ty)) return 'random() * 1000';
  if (ty === 'boolean') return 'random() < 0.5';
  if (ty === 'date') return /birth/.test(n) ? `current_date - (6570 + random() * 18000)::int` : 'current_date - (random() * 365)::int';
  if (/^timestamp/.test(ty)) return `now() - random() * interval '365 days'`;
  if (/^time/.test(ty)) return `time '00:00' + random() * interval '24 hours'`;
  if (ty === 'interval') return `random() * interval '30 days'`;
  if (ty === 'uuid') return 'md5(random()::text || g)::uuid';
  if (ty === 'json' || ty === 'jsonb') return `jsonb_build_object('n', g, 'tag', ${pick(WORDS)}, 'ok', random() < 0.5)::${ty}`;
  if (ty === 'bytea') return `decode(md5(random()::text), 'hex')`;
  if (ty === 'inet' || ty === 'cidr') return `('10.' || (g % 250) || '.' || (random() * 250)::int || '.' || (1 + random() * 250)::int)::${ty}`;
  if (/char|text|citext/.test(ty)) {
    if (/e-?mail/.test(n)) return cut(`lower(${pick(FIRST)}) || '.' || g || '@example.com'`);
    if (/phone|tel|mobile/.test(n)) return cut(`'+1 555 ' || lpad((random() * 9999999)::int::text, 7, '0')`);
    if (/first.?name/.test(n)) return cut(pick(FIRST) + u);
    if (/last.?name|surname/.test(n)) return cut(pick(LAST) + u);
    if (/name|author|customer|user/.test(n)) return cut(`${pick(FIRST)} || ' ' || ${pick(LAST)}${u}`);
    if (/city/.test(n)) return cut(pick(CITY) + u);
    if (/country/.test(n)) return cut(`${pick(['AZ', 'DE', 'TR', 'GB', 'ES', 'FR', 'GE', 'JP', 'CA', 'AT'])}${u}`);
    if (/url|link|website/.test(n)) return cut(`'https://example.com/' || ${pick(WORDS)} || '/' || g`);
    if (/status|state/.test(n)) return cut(`${pick(['new', 'active', 'pending', 'done', 'cancelled'])}${u}`);
    if (/color|colour/.test(n)) return cut(pick(['red', 'green', 'blue', 'black', 'white']) + u);
    if (/sku|code|ref/.test(n)) return cut(`upper(substr(md5(random()::text || g), 1, 8))${u}`);
    if (/desc|note|comment|body|text|bio|message|content/.test(n)) return cut(`initcap(${pick(WORDS)}) || ' ' || ${pick(WORDS)} || ' ' || ${pick(WORDS)} || ' ' || ${pick(WORDS)} || '.'`);
    if (/title|subject|label/.test(n)) return cut(`initcap(${pick(WORDS)} || ' ' || ${pick(WORDS)})${u}`);
    return cut(`${pick(WORDS)} || '-' || g${u ? " || '-' || substr(md5(random()::text), 1, 4)" : ''}`);
  }
  return null;
}
const MAX_MOCK = 100000;
async function mock(name, dbname, { schema, table, rows = 100, test = false } = {}) {
  const st0 = S(); const t = await st0.resolve(name); const db = dbname || t.dbname;
  if (!test && !t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes" first, or Test (rolled back).', 403, { code: 'READ_ONLY' });
  const n = Math.max(1, Math.min(MAX_MOCK, Math.floor(Number(rows) || 0)));
  const st = await st0.structure(name, db, schema, table);
  if (st.kind !== 'r' && st.kind !== 'p') throw err('Test data goes into tables only');
  const q = P.qname(st.schema, st.name);
  const fks = new Map(); // column → { ref, col }
  (st.constraints || []).filter(c => c.type === 'f').forEach(c => { const m = /FOREIGN KEY \(([^,)]+)\) REFERENCES ([^\s(]+)\(([^,)]+)\)/.exec(c.def || ''); if (m) fks.set(m[1].trim().replace(/^"|"$/g, ''), { ref: m[2], col: m[3].trim() }); });
  const uniq = new Set(st.pk || []);
  (st.indexes || []).filter(i => i.unique).forEach(i => { const m = /\(([^,()]+)\)\s*$/.exec(i.def || ''); if (m) uniq.add(m[1].trim().replace(/^"|"$/g, '')); });
  const enumTypes = new Set();
  const userTypes = st.columns.filter(c => !/^(smallint|integer|bigint|numeric|real|double|boolean|date|time|interval|uuid|jsonb?|bytea|inet|cidr|text|character|varchar|citext)/.test(String(c.type).toLowerCase()) && !/\[\]$/.test(c.type)).map(c => c.type);
  if (userTypes.length) {
    const rowsE = await st0.json(t, db, `select coalesce(json_agg(distinct format_type(e.enumtypid, null)), '[]') as v from pg_enum e where format_type(e.enumtypid, null) = any(array[${userTypes.map(x => P.lit(x)).join(',')}])`);
    (rowsE.v || rowsE || []).forEach(x => enumTypes.add(x));
  }
  const cols = []; const exprs = []; const skipped = []; const missing = [];
  for (const c of st.columns) {
    if (c.generated || c.identity) { skipped.push(c.name); continue; }
    if (c.default && !uniq.has(c.name)) { skipped.push(c.name); continue; }
    let e;
    const fk = fks.get(c.name);
    if (fk) e = `(SELECT r.${P.ident(fk.col.replace(/^"|"$/g, ''))} FROM ${fk.ref} r WHERE g >= 0 ORDER BY random() LIMIT 1)`;
    else e = valueFor(c, { unique: uniq.has(c.name), enumType: enumTypes.has(c.type) });
    if (e == null) { if (c.notnull) missing.push(`${c.name} (${c.type})`); else skipped.push(c.name); continue; }
    cols.push(P.ident(c.name)); exprs.push(e.replace(/__T__/g, q));
  }
  if (missing.length) throw err(`DockGate can not make up values for ${missing.join(', ')} — give them a default, or fill the table with SQL`);
  if (!cols.length) throw err('Every column has a default or is generated — nothing to fill');
  const sql = `WITH ins AS (INSERT INTO ${q} (${cols.join(', ')}) SELECT ${exprs.join(', ')} FROM generate_series(1, ${n}) AS g RETURNING *) SELECT json_build_object('n', (SELECT count(*) FROM ins), 'sample', (SELECT coalesce(json_agg(x), '[]') FROM (SELECT * FROM ins LIMIT 5) x))`;
  const r = await st0.psql(t, ['-q', '-At', '-c', 'BEGIN', '-c', sql, '-c', test ? 'ROLLBACK' : 'COMMIT'], { db, readOnly: false, timeoutMs: 600000 });
  if (r.code !== 0) {
    const e = String(r.stderr || '').replace(/^psql:(\s*error:)?\s*/gm, '').trim();
    const fkEmpty = [...fks.entries()].find(([c]) => new RegExp(`"${c}".*null value|null value in column "${c}"`).test(e));
    throw err(`${fkEmpty ? `${fkEmpty[1].ref} has no rows yet — fill it first. ` : ''}${e.slice(0, 600)} — nothing was added.`);
  }
  const outText = String(r.stdout || ''); const at = outText.indexOf('{"n"');
  const res = JSON.parse(at >= 0 ? outText.slice(at).trim() : '{"n":0,"sample":[]}');
  return { ok: true, test, rows: Number(res.n), sample: res.sample, columns: cols.map(c => c.replace(/^"|"$/g, '')), skipped, sql };
}

module.exports = { dump, zipTables, importSql, mock, tablesOf, valueFor };
