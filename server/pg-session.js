// SQL Workbench sessions: one psql per editor tab that stays open (docker exec -i … psql), so a transaction,
// SET, temp tables and cursors live from one Run to the next.
//   run(key, t, db, { sql, mode })   mode 'run' | 'test' (inside a transaction that is always rolled back)
//   tx(key, 'commit' | 'rollback')   end the open transaction
//   cancel(key)                      stop the running query (pg_cancel_backend from another connection)
//   more(key, result, offset)        further rows of a result kept in memory (up to MAX_KEEP rows)
//   close(key)                       end the session; idle ones end after IDLE_MS (an open transaction rolls back)
// Each statement is sent with markers around it (\echo); psql's own :ERROR and :ROW_COUNT say how it ended.
// Statements are checked first: no psql commands (\…), nothing left open (a quote, $…$ body, parenthesis).
const crypto = require('crypto');
const S = require('./pg-studio');
const P = require('./pg-sql');

const IDLE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 30;
const SHOW_ROWS = 1000;       // rows sent with a result; the rest come with more()
const MAX_KEEP = 50000;       // rows kept per result
const MAX_BYTES = 40 * 1024 * 1024;
const err = (msg, statusCode = 400, extra) => Object.assign(new Error(msg), { statusCode }, extra || {});
const sessions = new Map();

// Statements a test run can not hold: they end the transaction, or can not run inside one.
const NO_TEST = /^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED|VACUUM|CHECKPOINT|ALTER\s+SYSTEM|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+DATABASE|CREATE\s+TABLESPACE|DROP\s+TABLESPACE|REINDEX\s+(DATABASE|SYSTEM))\b|\bCONCURRENTLY\b/i;

class Session {
  constructor(key, t, db, proc, readOnly, timeoutMs) {
    Object.assign(this, { key, t, db, proc, readOnly, timeoutMs, mark: `\u241E${crypto.randomBytes(5).toString('hex')}:`, buf: '', lines: [], waiters: [], errBuf: '', pid: null,
      busy: false, dead: false, txState: 'idle', lastUsed: Date.now(), results: [] });
    proc.onOut((c) => this._out(c));
    proc.onErr((c) => { this.errBuf += c.toString('utf8'); if (this.errBuf.length > 200000) this.errBuf = this.errBuf.slice(-100000); });
    proc.onExit(() => { this.dead = true; this.waiters.splice(0).forEach(w => w.reject(err(this.errBuf.replace(/^psql:(\s*error:)?\s*/gm, '').trim() || 'The session ended', 410, { code: 'SESSION_ENDED' }))); sessions.delete(this.key); });
  }
  _out(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (line.startsWith(this.mark)) { const w = this.waiters[0]; if (w) w.onMark(line.slice(this.mark.length)); }
      else { const w = this.waiters[0]; if (w) w.onLine(line); }
    }
  }
  /** Send one statement; resolve { lines, error, rowCount, stderr, truncated } when its end marker comes. */
  exec1(sql, { keep = true, tags = false } = {}) {
    if (this.dead) return Promise.reject(err('The session ended', 410, { code: 'SESSION_ENDED' }));
    const n = crypto.randomBytes(3).toString('hex');
    return new Promise((resolve, reject) => {
      const lines = []; let bytes = 0, truncated = false, started = false;
      const errStart = this.errBuf.length;
      const timer = setTimeout(() => { reject(err('No answer from psql — the session was closed', 504, { code: 'TIMEOUT' })); this.close(); }, this.timeoutMs + 30000);
      const w = {
        reject: (e) => { clearTimeout(timer); reject(e); },
        onLine: (l) => { if (!started || !keep) return; if (truncated) return; bytes += l.length + 1; if (bytes > MAX_BYTES) { truncated = true; return; } lines.push(l); },
        onMark: (m) => {
          if (m === `S ${n}`) { started = true; return; }
          const x = new RegExp(`^E ${n} (\\S+) (\\S*)$`).exec(m);
          if (!x) return;
          clearTimeout(timer);
          this.waiters.shift();
          setTimeout(() => resolve({ lines, error: x[1] === 'true', rowCount: Number(x[2]) || 0, stderr: this.errBuf.slice(errStart), truncated }), 15);
        },
      };
      this.waiters.push(w);
      // QUIET off only around a statement of the user: psql then prints its command tag (UPDATE 3)
      this.proc.write(`\\echo ${this.mark}S ${n}\n${tags ? '\\set QUIET off\n' : ''}${sql}\n;\n${tags ? '\\set QUIET on\n' : ''}\\echo ${this.mark}E ${n} :ERROR :ROW_COUNT\n`);
    });
  }
  async probeTx() {
    // without FETCH_COUNT: psql would wrap the SELECT in its own transaction (a cursor) and now() would differ
    const r = await this.exec1("\\unset FETCH_COUNT\n\\pset format unaligned\n\\pset tuples_only on\nselect (now() <> statement_timestamp())::text", { keep: true }).catch(() => null);
    await this.exec1('\\pset tuples_only off\n\\pset format csv\n\\set FETCH_COUNT 1000\nselect 1 where false', { keep: false }).catch(() => null);
    this.txState = !r ? this.txState : r.error ? 'aborted' : (r.lines.join('').trim() === 'true' ? 'open' : 'idle');
    return this.txState;
  }
  close() {
    if (this.dead) return; this.dead = true; sessions.delete(this.key);
    try { this.proc.write('\\q\n'); } catch (e) {}
    this.proc.close();
  }
}

const cleanMsg = (s) => String(s || '').split('\n').map(l => l.replace(/^psql:[^:]*:\d+:\s*/, '')).join('\n').trim();
const ERROR_LINE = /^(psql:[^:]*:\d+:\s*)?(ERROR|FATAL|PANIC):/m;

async function open(key, t, db, { timeoutMs = 30000 } = {}) {
  if (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.values()].filter(s => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0]; if (oldest) oldest.close(); }
  const proc = await S.openPsql(t, db, { readOnly: !t.allowWrite, timeoutMs });
  const s = new Session(key, t, db, proc, !t.allowWrite, timeoutMs);
  sessions.set(key, s);
  const r = await s.exec1('\\pset format unaligned\n\\pset tuples_only on\nselect pg_backend_pid()');
  await s.exec1('\\pset tuples_only off\n\\pset format csv\nselect 1 where false', { keep: false });
  if (r.error || !r.lines.length) { s.close(); throw err(cleanMsg(r.stderr) || 'Could not start a session', 400); }
  s.pid = Number(r.lines.join('').trim());
  return s;
}

async function get(key, t, db, opts) {
  let s = sessions.get(key);
  if (s && (s.dead || s.t.id !== t.id || s.db !== db || s.timeoutMs !== (opts.timeoutMs || 30000))) {
    if (s.txState !== 'idle' && !s.dead && s.t.id === t.id && s.db === db) throw err('A transaction is open in this tab — Commit or Roll back before changing the database or the time limit', 409, { code: 'TX_OPEN' });
    s.close(); s = null;
  }
  return s || open(key, t, db, opts);
}

/** Run statements in the tab's session. mode 'test': inside BEGIN … ROLLBACK (or a savepoint in an open transaction). */
async function run(key, t, db, { sql, mode = 'run', confirm = false, timeoutMs = 30000 }) {
  const stmts = P.split(sql);
  if (!stmts.length) throw err('Nothing to run');
  if (stmts.length > 200) throw err('At most 200 statements at once');
  const open1 = P.incomplete(sql); if (open1) throw err(`The text is not complete: ${open1}`, 400, { code: 'INCOMPLETE' });
  for (const st of stmts) if (P.hasMeta(st.sql)) throw err('psql commands (a backslash outside quotes) are not run here — write SQL', 400);
  const kinds = stmts.map(st => P.kind(st.sql));
  const test = mode === 'test';
  if (test) { const bad = stmts.find(st => NO_TEST.test(P.kind(st.sql).first + ' ' + st.sql.replace(/^[\s(]+/, '').slice(0, 60))); if (bad) throw err(`A test run can not hold "${bad.sql.slice(0, 60)}" — it ends the transaction or can not run in one. Use Run.`, 400, { code: 'NO_TEST' }); }
  const writes = kinds.some(k => k.write && !['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE'].includes(k.first));
  if (!test && writes && !t.allowWrite) throw err('This connection is read-only. Turn on "Allow changes", or use Test run (it rolls back).', 403, { code: 'READ_ONLY' });
  if (!test) {
    const danger = kinds.map((k, i) => k.danger ? { statement: i + 1, sql: stmts[i].sql.slice(0, 200), why: k.danger } : null).filter(Boolean);
    if (danger.length && !confirm) throw err('Some statements need a confirm', 409, { code: 'NEEDS_CONFIRM', danger });
    if (writes && t.production && !confirm) throw err('This is marked as production — confirm to run statements that change data', 409, { code: 'NEEDS_CONFIRM', danger: [{ statement: 0, why: 'production database' }] });
  }
  const s = await get(key, t, db, { timeoutMs });
  if (s.busy) throw err('This tab is still running a query — Cancel it first', 409, { code: 'BUSY' });
  if (test && s.txState === 'aborted') throw err('The open transaction failed — Roll back first', 409, { code: 'TX_ABORTED' });
  s.busy = true; s.lastUsed = Date.now();
  const t0 = Date.now();
  const results = []; let error = null; const notices = [];
  try {
    if (s.txState === 'idle' && s.readOnly !== !t.allowWrite) { await s.exec1(`SET default_transaction_read_only = ${t.allowWrite ? 'off' : 'on'}`, { keep: false }); s.readOnly = !t.allowWrite; }
    const wasTx = s.txState !== 'idle';
    if (test) await s.exec1(wasTx ? 'SAVEPOINT dg_test' : 'BEGIN TRANSACTION READ WRITE', { keep: false });
    for (let i = 0; i < stmts.length; i++) {
      const st = stmts[i];
      const r = await s.exec1(st.sql, { tags: true });
      const msgs = cleanMsg(r.stderr.replace(/^(psql:[^:]*:\d+:\s*)?(ERROR|FATAL)[\s\S]*$/m, ''));
      if (msgs) notices.push({ statement: i + 1, text: msgs });
      if (r.error || ERROR_LINE.test(r.stderr)) {
        const at = P.errorAt(r.stderr, st.sql);
        error = { statement: i + 1, message: cleanMsg((r.stderr.match(/(^|\n)(psql:[^:]*:\d+:\s*)?(ERROR|FATAL)[\s\S]*$/) || [r.stderr])[0]), ...(at ? { offset: st.start + at.offset, line: at.line, col: at.col } : { offset: st.start }) };
        break;
      }
      const res = P.readResult(r.lines.join('\n'), st.sql);
      const rec = { statement: i + 1, start: st.start, end: st.end, sql: st.sql.slice(0, 300), ms: null, ...res };
      if (res.kind === 'rows') {
        rec.total = res.rows.length;
        if (rec.total > MAX_KEEP) { res.rows = res.rows.slice(0, MAX_KEEP); rec.kept = MAX_KEEP; }
        rec.truncated = r.truncated;
      }
      results.push(rec);
    }
    if (test) {
      const end = await s.exec1(wasTx ? 'ROLLBACK TO SAVEPOINT dg_test' : 'ROLLBACK', { keep: false });
      if (wasTx && !end.error) await s.exec1('RELEASE SAVEPOINT dg_test', { keep: false });
    }
    await s.probeTx();
  } finally { s.busy = false; s.lastUsed = Date.now(); }
  s.results = results; // kept for more()
  return {
    results: results.map((r, i) => r.kind === 'rows' ? { ...r, index: i, rows: r.rows.slice(0, SHOW_ROWS), more: r.rows.length > SHOW_ROWS } : { ...r, index: i }),
    error, notices, ms: Date.now() - t0, mode, tx: s.txState, pid: s.pid, writes, rolledBack: test,
  };
}

async function tx(key, action) {
  const s = sessions.get(key);
  if (!s || s.dead) return { tx: 'idle', ended: true };
  if (s.busy) throw err('A query is running — Cancel it first', 409, { code: 'BUSY' });
  s.busy = true;
  try { const r = await s.exec1(action === 'commit' ? 'COMMIT' : 'ROLLBACK', { keep: false }); await s.probeTx(); return { tx: s.txState, ok: !r.error, message: r.error ? cleanMsg(r.stderr) : null }; }
  finally { s.busy = false; s.lastUsed = Date.now(); }
}

async function cancel(key) {
  const s = sessions.get(key);
  if (!s || !s.pid || !s.busy) return { cancelled: false };
  const r = await S.psql(s.t, ['-At', '-c', `select pg_cancel_backend(${Number(s.pid)})`], { db: s.db });
  return { cancelled: String(r.stdout).trim() === 't' };
}

function more(key, index, offset = SHOW_ROWS, limit = SHOW_ROWS) {
  const s = sessions.get(key);
  const r = s && s.results[Number(index)];
  if (!r || r.kind !== 'rows') throw err('That result is gone — run the query again', 410, { code: 'GONE' });
  const o = Math.max(0, parseInt(offset, 10) || 0), l = Math.max(1, Math.min(5000, parseInt(limit, 10) || SHOW_ROWS));
  return { rows: r.rows.slice(o, o + l), offset: o, more: r.rows.length > o + l, total: r.total };
}

function close(key) { const s = sessions.get(key); if (s) s.close(); return { ok: true }; }
function state(key) { const s = sessions.get(key); return s && !s.dead ? { tx: s.txState, busy: s.busy, pid: s.pid, db: s.db } : { tx: 'idle', none: true }; }

// Idle sessions end (closing the connection rolls an open transaction back).
const sweeper = setInterval(() => { const now = Date.now(); for (const s of sessions.values()) if (!s.busy && now - s.lastUsed > IDLE_MS) s.close(); }, 60000);
if (sweeper.unref) sweeper.unref();

module.exports = { run, tx, cancel, more, close, state, sessions, IDLE_MS, SHOW_ROWS, _closeAll() { for (const s of [...sessions.values()]) s.close(); } };
