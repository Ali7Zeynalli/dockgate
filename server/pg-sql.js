// PostgreSQL helpers for Tools → Databases (pure, unit tested): split a SQL text into statements, tell what a
// statement does, quote identifiers and literals, and read psql's CSV output.
//   split(text)            [{ sql, start }] — top-level ";" only (quotes, $tag$ bodies and comments respected)
//   kind(sql)              { first, rows, write, danger } — first keyword, returns rows?, changes data?, needs a confirm?
//   ident(name)            "name" — always quoted ("" doubled)
//   lit(value)             'value' or NULL — standard_conforming_strings is forced on for every session
//   parseCsv(text)         [[field…]…] with null for the NULL marker
//   readResult(out, sql)   { kind: 'rows', columns, rows } | { kind: 'tag', tag } (+ tag after RETURNING rows)

const NULL_MARK = '␀'; // "␀": psql prints NULL as this (-P null=␀); an empty string stays ""

function split(text) {
  const s = String(text || '');
  const out = [];
  let i = 0, start = 0;
  const n = s.length;
  const push = (end) => { const sql = s.slice(start, end); if (meaningful(sql)) out.push({ sql: sql.trim(), start }); };
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '-' && d === '-') { const e = s.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && d === '*') { // nested block comments
      let depth = 1; i += 2;
      while (i < n && depth) { if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; } else i++; }
      continue;
    }
    if (c === "'") { // '…' with '' — E'…' also takes \'
      const esc = i > 0 && /[eE]/.test(s[i - 1]) && !/[\w$]/.test(s[i - 2] || '');
      i++;
      while (i < n) { if (esc && s[i] === '\\') { i += 2; continue; } if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '"') { i++; while (i < n) { if (s[i] === '"') { if (s[i + 1] === '"') { i += 2; continue; } i++; break; } i++; } continue; }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(s.slice(i));
      if (m && !/[\w]/.test(s[i - 1] || '')) { const tag = m[0]; const e = s.indexOf(tag, i + tag.length); i = e < 0 ? n : e + tag.length; continue; }
    }
    if (c === ';') { push(i); start = i + 1; }
    i++;
  }
  push(n);
  return out;
}

// Anything but blanks and comments?
function meaningful(sql) { return strip(sql).trim().length > 0; }
function strip(sql) { return String(sql).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' '); }

const ROW_FIRST = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FETCH']);
const READ_FIRST = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FETCH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'RESET', 'DECLARE', 'CLOSE', 'MOVE', 'LISTEN', 'UNLISTEN', 'PREPARE', 'DEALLOCATE', 'DISCARD']);

/** What a statement does. The text with its quoted parts blanked, so a word inside a string does not count. */
function kind(sql) {
  const bare = blank(strip(sql));
  const words = bare.replace(/^[\s(]+/, '').split(/[^A-Za-z_]+/).filter(Boolean).map(w => w.toUpperCase());
  const first = words[0] || '';
  const has = (re) => re.test(bare);
  const rows = ROW_FIRST.has(first) || has(/\bRETURNING\b/i);
  const modifying = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|COMMENT|SECURITY|REFRESH|CALL|DO|IMPORT|LOCK)\b/i;
  const write = !READ_FIRST.has(first) || (first === 'WITH' && modifying.test(bare)) || (first === 'EXPLAIN' && /\bANALYZE\b/i.test(bare) && modifying.test(bare));
  let danger = null;
  if (first === 'DROP') danger = 'DROP removes it for good';
  else if (first === 'TRUNCATE') danger = 'TRUNCATE empties the table';
  else if ((first === 'DELETE' || first === 'UPDATE') && !has(/\bWHERE\b/i)) danger = `${first} without WHERE changes every row`;
  else if (first === 'ALTER' && has(/\bDROP\b/i)) danger = 'ALTER … DROP removes a part of it';
  return { first, rows, write, danger };
}

// Quoted strings, identifiers and $…$ bodies replaced by blanks (for keyword checks only).
function blank(sql) {
  return String(sql)
    .replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

function ident(name) {
  const s = String(name == null ? '' : name);
  if (!s || s.includes('\0')) throw Object.assign(new Error('A name is needed'), { statusCode: 400 });
  return '"' + s.replace(/"/g, '""') + '"';
}
const qname = (schema, name) => `${ident(schema)}.${ident(name)}`;
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  if (s.includes('\0')) throw Object.assign(new Error('A value can not contain a NUL character'), { statusCode: 400 });
  return "'" + s.replace(/'/g, "''") + "'";
}

/** RFC 4180 CSV as psql writes it; the NULL marker (unquoted) becomes null. */
function parseCsv(text) {
  const s = String(text || '');
  const rows = [];
  let row = [], f = '', i = 0, quoted = false, wasQuoted = false;
  const endField = () => { row.push(!wasQuoted && f === NULL_MARK ? null : f); f = ''; wasQuoted = false; };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i += 2; continue; } quoted = false; i++; continue; }
      f += c; i++; continue;
    }
    if (c === '"') { quoted = true; wasQuoted = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\n' || c === '\r') { endField(); rows.push(row); row = []; if (c === '\r' && s[i + 1] === '\n') i++; i++; continue; }
    f += c; i++;
  }
  if (f !== '' || wasQuoted || row.length) { endField(); rows.push(row); }
  return rows;
}

const TAG_RE = /^(INSERT \d+ \d+|UPDATE \d+|DELETE \d+|MERGE \d+|COPY \d+|SELECT \d+|MOVE \d+|FETCH \d+)$/;
const ANY_TAG_RE = /^[A-Z][A-Z ]*[A-Z]( \d+){0,2}$/;

/** One statement's output → rows (with the command tag that follows RETURNING rows) or a command tag. */
function readResult(out, sql) {
  const k = kind(sql);
  const text = String(out || '').replace(/\n$/, '');
  if (!text) return k.rows ? { kind: 'rows', columns: [], rows: [] } : { kind: 'tag', tag: 'OK' };
  if (!k.rows) return { kind: 'tag', tag: text.split('\n').filter(Boolean).pop() };
  const recs = parseCsv(text);
  let tag = null;
  if (k.first !== 'SELECT' && k.first !== 'VALUES' && k.first !== 'TABLE' && k.first !== 'SHOW') {
    const last = recs[recs.length - 1];
    if (last && last.length === 1 && typeof last[0] === 'string' && (TAG_RE.test(last[0]) || (recs.length === 1 && ANY_TAG_RE.test(last[0])))) { recs.pop(); tag = last[0]; }
  }
  if (!recs.length) return { kind: 'tag', tag: tag || 'OK' };
  const [columns, ...rows] = recs;
  return { kind: 'rows', columns, rows, ...(tag ? { tag } : {}) };
}

module.exports = { split, kind, ident, qname, lit, parseCsv, readResult, NULL_MARK };
