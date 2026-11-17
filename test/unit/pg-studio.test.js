'use strict';
// Tools → Databases. pg-sql.js is pure (runs everywhere). pg-studio.js runs against a real PostgreSQL when one
// is reachable (DG_TEST_PG=socketdir:port, default /var/tmp/dgpg:55432) — "docker exec" becomes a local psql.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const P = require('../../server/pg-sql');

test('split: top-level ; only — strings, $$ bodies, comments and quoted names kept whole', () => {
  const sql = `select 'a;b', "x;y" from t; -- c;d
  create function f() returns int as $body$ begin return 1; end; $body$ language plpgsql;
  /* a /* nested ; */ ; */ select E'it\\'s;' ; select $$;$$;  ;  -- only a comment`;
  const st = P.split(sql).map(s => s.sql);
  assert.equal(st.length, 4);
  assert.match(st[0], /^select 'a;b', "x;y" from t$/);
  assert.match(st[1], /\$body\$ language plpgsql$/);
  assert.match(st[2], /select E'it\\'s;'$/);
  assert.equal(st[3], 'select $$;$$');
});

test('kind: reads vs writes, rows, and what needs a confirm', () => {
  assert.deepEqual(P.kind('SELECT 1'), { first: 'SELECT', rows: true, write: false, danger: null });
  assert.equal(P.kind("select 'drop table x'").write, false, 'words in strings do not count');
  assert.equal(P.kind('with x as (delete from t returning *) select * from x').write, true);
  assert.equal(P.kind('insert into t values (1) returning id').rows, true);
  assert.equal(P.kind('update t set a = 1').danger, 'UPDATE without WHERE changes every row');
  assert.equal(P.kind('update t set a = 1 where id = 2').danger, null);
  assert.match(P.kind('DROP TABLE t').danger, /DROP/);
  assert.match(P.kind('truncate t').danger, /TRUNCATE/);
  assert.match(P.kind('alter table t drop column a').danger, /ALTER/);
  assert.equal(P.kind('explain select 1').write, false);
  assert.equal(P.kind('vacuum').write, true);
});

test('quoting and CSV reading (NULL vs empty string, quotes, new lines)', () => {
  assert.equal(P.ident('we"ird'), '"we""ird"');
  assert.equal(P.lit("it's"), "'it''s'"); assert.equal(P.lit(null), 'NULL');
  assert.throws(() => P.lit('a\0b'));
  assert.deepEqual(P.parseCsv(`a,b,c\n1,${P.NULL_MARK},""\n"x,y","l1\nl2","q""q"\n`), [['a', 'b', 'c'], ['1', null, ''], ['x,y', 'l1\nl2', 'q"q']]);
  assert.deepEqual(P.readResult('UPDATE 3', 'update t set a=1'), { kind: 'tag', tag: 'UPDATE 3' });
  assert.deepEqual(P.readResult('id\n9\nINSERT 0 1', 'insert into t values (9) returning id'), { kind: 'rows', columns: ['id'], rows: [['9']], tag: 'INSERT 0 1' });
  assert.deepEqual(P.readResult('n\n', 'select 1 as n where false'), { kind: 'rows', columns: ['n'], rows: [] });
});

// ---------- against a real PostgreSQL ----------
const [PGHOST, PGPORT] = (process.env.DG_TEST_PG || '/var/tmp/dgpg:55432').split(':');
let pgUp = false;
try { execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-At', '-c', 'select 1'], { stdio: 'pipe', timeout: 5000 }); pgUp = true; } catch (e) { /* not here */ }
const skip = pgUp ? false : 'no PostgreSQL here (set DG_TEST_PG)';

function setup() {
  const dockerPath = require.resolve('../../server/docker');
  const fake = {
    getActiveServerId: () => 'local',
    docker: {
      listContainers: async () => [{ Id: 'c1', Names: ['/shop-db-1'], Image: 'postgres:16-alpine', State: 'running', Status: 'Up', Labels: { 'com.docker.compose.project': 'shop' } }, { Id: 'c2', Names: ['/redis'], Image: 'redis:7', State: 'running', Labels: {} }],
      getContainer: (n) => ({ inspect: async () => { if (n !== 'shop-db-1') throw new Error('no'); return { Id: 'c1', State: { Running: true }, Config: { Image: 'postgres:16-alpine', Env: ['POSTGRES_USER=postgres', 'POSTGRES_DB=dgtest'] } }; } }),
    },
  };
  require.cache[dockerPath] = { id: dockerPath, filename: dockerPath, loaded: true, exports: fake };
  const S = require('../../server/pg-studio');
  S._setExec((id, cmd, env, { onStdout, timeoutMs, stdin } = {}) => new Promise((res) => {
    const args = cmd.slice(1); args.splice(0, 0, '-h', PGHOST, '-p', PGPORT);
    const e = { ...process.env }; for (const kv of env) { const i = kv.indexOf('='); e[kv.slice(0, i)] = kv.slice(i + 1); }
    const p = spawn(cmd[0], args, { env: e });
    let out = '', er = '';
    p.stdout.on('data', d => { if (onStdout) onStdout(d); else out += d; }); p.stderr.on('data', d => { er += d; });
    if (stdin) stdin.pipe(p.stdin); else p.stdin.end();
    const timer = setTimeout(() => p.kill(), timeoutMs || 60000);
    p.on('close', (code) => { clearTimeout(timer); res({ code: code || 0, stdout: out, stderr: er, truncated: false, timedOut: false }); });
  }));
  return S;
}

test('Databases against PostgreSQL: find, browse, edit by key, SQL with confirms, read-only', { skip }, async () => {
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-c', 'drop database if exists dgtest', '-c', 'create database dgtest'], { stdio: 'pipe' });
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest', '-c', `create schema shop;
    create table shop.items (id bigserial primary key, name text not null, price numeric(20,2), note text, made timestamptz default now());
    insert into shop.items (name, price, note) values ('Apple', 1.5, null), ('Pear', 2, ''), ('Big', 9007199254740993, 'it''s');
    create table shop.log (msg text); insert into shop.log values ('x');
    create view shop.cheap as select * from shop.items where price < 2;`], { stdio: 'pipe' });
  const S = setup();
  const t = await S.targets();
  assert.equal(t.length, 1); assert.equal(t[0].name, 'shop-db-1'); assert.equal(t[0].settings.allowWrite, false);
  const info = await S.info('shop-db-1');
  assert.equal(info.user, 'postgres'); assert.ok(info.databases.some(d => d.name === 'dgtest'));
  const o = await S.objects('shop-db-1', 'dgtest');
  assert.ok(o.schemas.includes('shop'));
  assert.deepEqual(o.relations.filter(r => r.schema === 'shop').map(r => `${r.name}:${r.kind}`).sort(), ['cheap:v', 'items:r', 'items_id_seq:S', 'log:r']);
  const st = await S.structure('shop-db-1', 'dgtest', 'shop', 'items');
  assert.deepEqual(st.pk, ['id']); assert.equal(st.columns.find(c => c.name === 'price').type, 'numeric(20,2)');
  // rows: text values, NULL vs '', big numbers exact, sort + filter
  let r = await S.rows('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', sort: [{ col: 'id', dir: 'asc' }] });
  assert.equal(r.editable, true);
  const idx = (n) => r.columns.findIndex(c => c.name === n);
  assert.equal(r.rows[0][idx('note')], null); assert.equal(r.rows[1][idx('note')], '');
  assert.equal(r.rows[2][idx('price')], '9007199254740993.00');
  r = await S.rows('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', filters: [{ col: 'name', op: 'contains', value: 'p' }] });
  assert.deepEqual(r.rows.map(x => x[idx('name')]).sort(), ['Apple', 'Pear']);
  assert.equal((await S.count('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', filters: [{ col: 'note', op: 'null' }] })).count, 1);
  await assert.rejects(S.rows('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', where: '1=1; drop table shop.log' }), /one condition/);
  // read-only by default
  await assert.rejects(S.updateRow('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', pk: { id: '1' }, set: { name: 'x' } }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(S.runSql('shop-db-1', 'dgtest', 'delete from shop.log where true'), (e) => e.code === 'READ_ONLY');
  // a write hidden in a function call is still stopped by the read-only session
  const ro = await S.runSql('shop-db-1', 'dgtest', "select 1 as a; select set_config('x.y', '1', false)");
  assert.equal(ro.error, null); assert.equal(ro.results.length, 2);
  // SQL: several results, NULL, an error names its statement and stops there
  let q = await S.runSql('shop-db-1', 'dgtest', "select id, note from shop.items order by id; select count(*) as n from shop.log; select * from nope; select 2");
  assert.equal(q.results[0].kind, 'rows'); assert.deepEqual(q.results[0].columns, ['id', 'note']); assert.equal(q.results[0].rows[0][1], null);
  assert.deepEqual(q.results[1].rows, [['1']]);
  assert.equal(q.error.statement, 3); assert.match(q.error.message, /nope/); assert.equal(q.results.length, 2);
  await assert.rejects(S.runSql('shop-db-1', 'dgtest', '\\! id'), /psql commands/);
  // allow changes: edits by key, dangerous statements ask first
  S.saveSettings('shop-db-1', { allowWrite: true });
  assert.deepEqual(await S.updateRow('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', pk: { id: '2' }, set: { note: null, name: "O'Neil" } }).then(x => x.updated), 1);
  await assert.rejects(S.updateRow('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', pk: { id: '99' }, set: { name: 'x' } }), (e) => e.code === 'GONE');
  await assert.rejects(S.updateRow('shop-db-1', 'dgtest', { schema: 'shop', table: 'log', pk: { msg: 'x' }, set: { msg: 'y' } }), (e) => e.code === 'NO_PK');
  const ins = await S.insertRow('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', values: { name: 'New', price: '3.25' } });
  assert.equal(ins.inserted, 1); assert.ok(ins.key.id);
  assert.equal((await S.deleteRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'items', pks: [{ id: ins.key.id }, { id: '1' }] })).deleted, 2);
  await assert.rejects(S.runSql('shop-db-1', 'dgtest', 'delete from shop.log'), (e) => e.code === 'NEEDS_CONFIRM' && e.danger[0].why.includes('WHERE'));
  q = await S.runSql('shop-db-1', 'dgtest', "insert into shop.log values ('a'), ('b') returning msg; delete from shop.log", { confirm: true });
  assert.equal(q.error, null); assert.deepEqual(q.results[0].rows, [['a'], ['b']]); assert.equal(q.results[0].tag, 'INSERT 0 2'); assert.equal(q.results[1].tag, 'DELETE 3');
  // a transaction across statements; an error rolls the open one back
  q = await S.runSql('shop-db-1', 'dgtest', "begin; insert into shop.log values ('t'); select 1/0; commit");
  assert.equal(q.error.statement, 3);
  assert.equal((await S.count('shop-db-1', 'dgtest', { schema: 'shop', table: 'log' })).count, 0);
  // export
  let csv = ''; await S.exportTable('shop-db-1', 'dgtest', 'shop', 'items', 'csv', (c) => { csv += c; });
  assert.match(csv, /^id,name,price,note,made\n/); assert.match(csv, /O'Neil/);
  let jl = ''; await S.exportTable('shop-db-1', 'dgtest', 'shop', 'items', 'json', (c) => { jl += c; });
  assert.ok(jl.trim().split('\n').map(l => JSON.parse(l)).some(x => x.name === "O'Neil" && x.note === null));
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('Admin and backups against PostgreSQL: roles, sessions, vacuum, backup → restore to a new database → swap', { skip }, async () => {
  const S = setup();
  const A = require('../../server/pg-admin');
  const BK = require('../../server/pg-backup');
  for (const d of ['dgtest_copy', 'dgtest_sql']) execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-c', `drop database if exists ${d}`], { stdio: 'pipe' });
  const pq = (...a) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-At', ...a], { stdio: 'pipe' }).toString();
  pq('-c', "select pg_terminate_backend(pid) from pg_stat_activity where datname like 'dgtest%' and pid <> pg_backend_pid()");
  for (const d of pq('-c', "select datname from pg_database where datname like 'dgtest\\_%'").split('\n').filter(Boolean)) pq('-c', `drop database "${d}"`);
  pq('-c', 'drop role if exists dg_app');
  const o = await A.overview('shop-db-1', 'dgtest');
  assert.ok(o.maxConnections > 0); assert.ok(o.roles.some(r => r.name === 'postgres' && r.super));
  assert.ok(o.tables.some(t => t.name === 'items')); assert.ok(o.sessions.some(x => x.me));
  await assert.rejects(A.createRole('shop-db-1', { role: 'dg_app', password: 'longpassword1' }), (e) => e.code === 'READ_ONLY');
  S.saveSettings('shop-db-1', { allowWrite: true });
  await A.createRole('shop-db-1', { role: 'dg_app', password: 'longpassword1', database: 'dgtest', access: 'read' });
  await assert.rejects(A.createRole('shop-db-1', { role: 'bad name' }), /letters/);
  await A.setPassword('shop-db-1', { role: 'dg_app', password: 'another-pass-2' });
  assert.equal(execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest', '-At', '-c', "select has_table_privilege('dg_app', 'shop.items', 'SELECT')::text || has_table_privilege('dg_app', 'shop.items', 'DELETE')::text"]).toString().trim(), 'truefalse');
  const m = await A.maintain('shop-db-1', 'dgtest', { action: 'vacuum', schema: 'shop', table: 'items' });
  assert.match(m.sql, /^VACUUM \(ANALYZE\) "shop"\."items"$/);
  await assert.rejects(A.dropDatabase('shop-db-1', { database: 'dgtest', confirm: 'nope' }), (e) => e.code === 'CONFIRM');
  // the login database itself can be swapped / dropped: DockGate stands in another database meanwhile
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-c', 'drop database if exists dgtest_tmp', '-c', 'create database dgtest_tmp'], { stdio: 'pipe' });
  await A.dropDatabase('shop-db-1', { database: 'dgtest_tmp', confirm: 'dgtest_tmp' });
  // backups (this machine → DockGate's data folder)
  const b1 = await BK.create('shop-db-1', { database: 'dgtest', kind: 'custom' });
  assert.match(b1.file, /^shop-db-1-dgtest-\d{4}-\d\d-\d\d-\d{6}\.dump$/); assert.ok(b1.size > 100);
  const b2 = await BK.create('shop-db-1', { database: 'dgtest', kind: 'sql' });
  const b3 = await BK.create('shop-db-1', { kind: 'all' });
  assert.match(b3.file, /-all-.*\.sql\.gz$/);
  const l = await BK.list('shop-db-1');
  assert.deepEqual(l.files.map(f => f.name).sort(), [b1.file, b2.file, b3.file].sort());
  assert.equal(l.files.find(f => f.name === b3.file).restorable, false);
  await assert.rejects(BK.restore('shop-db-1', { file: b3.file, target: 'x' }), (e) => e.code === 'WHOLE');
  await assert.rejects(BK.restore('shop-db-1', { file: b1.file, target: 'dgtest' }), /exists/);
  const r1 = await BK.restore('shop-db-1', { file: b1.file, target: 'dgtest_copy' });
  assert.equal(r1.database, 'dgtest_copy');
  await BK.restore('shop-db-1', { file: b2.file, target: 'dgtest_sql' });
  const n = (db) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', db, '-At', '-c', 'select count(*) from shop.items']).toString().trim();
  assert.equal(n('dgtest_copy'), n('dgtest')); assert.equal(n('dgtest_sql'), n('dgtest'));
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest_copy', '-c', "insert into shop.items (name) values ('only-in-copy')"], { stdio: 'pipe' });
  const sw = await BK.swap('shop-db-1', { restored: 'dgtest_copy', into: 'dgtest_sql' });
  assert.match(sw.kept, /^dgtest_sql_before_\d+$/);
  assert.equal(execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest_sql', '-At', '-c', "select count(*) from shop.items where name = 'only-in-copy'"]).toString().trim(), '1');
  for (const f of [b1.file, b2.file, b3.file]) await BK.remove('shop-db-1', f);
  assert.equal((await BK.list('shop-db-1')).files.length, 0);
  await assert.rejects(BK.remove('shop-db-1', '../etc.dump'), /Unknown backup|Not a backup/);
  // the scheduled backup is a Scripts entry that writes where the list looks
  const spec = BK.scheduleSpec('shop-db-1', { database: 'dgtest', keepDays: 14 });
  const text = require('../../server/script-builder').build(spec);
  assert.match(text, /\/var\/backups\/dockgate\/postgres\/shop-db-1-dgtest-/); assert.match(text, /-mtime \+14/);
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('pg-sql: psql commands, unfinished text, error position', () => {
  assert.equal(P.hasMeta('select 1 \\! id'), true);
  assert.equal(P.hasMeta("select E'a\\nb', '\\x', $$ \\q $$ -- \\! c"), false);
  assert.equal(P.incomplete("select 'a"), "a ' string is not closed");
  assert.equal(P.incomplete('select (1'), 'a ( is not closed');
  assert.equal(P.incomplete("select '(' , $x$ ( $x$"), null);
  assert.deepEqual(P.errorAt('ERROR:  column "x" does not exist\nLINE 2: where x = 1\n              ^', 'select *\nwhere x = 1'), { line: 2, col: 6, offset: 15 });
  assert.deepEqual(P.split('  select 1;\n\n  select 2 ;').map(s => [s.start, s.end]), [[2, 10], [15, 24]]);
  const ph = P.params("select :a, ':b', x::int, arr[1:2], $$ :c $$ -- :d\n, :a", { a: "x'y" });
  assert.deepEqual(ph.names, ['a']); assert.equal(ph.sql, "select 'x''y', ':b', x::int, arr[1:2], $$ :c $$ -- :d\n, 'x''y'");
});

const t0Cleanup = [];
test.after(() => t0Cleanup.forEach(f => f()));
test('Workbench sessions against PostgreSQL: a transaction lives across runs, test runs roll back, cancel, errors point at the text', { skip }, async () => {
  const S = setup();
  const WS = require('../../server/pg-session');
  S._setOpen(async (id, cmd, env) => {
    const args = cmd.slice(1); args.splice(0, 0, '-h', PGHOST, '-p', PGPORT);
    const e = { ...process.env }; for (const kv of env) { const i = kv.indexOf('='); e[kv.slice(0, i)] = kv.slice(i + 1); }
    const p = spawn(cmd[0], args, { env: e });
    const outs = [], errs = [], exits = [];
    p.stdout.on('data', d => outs.forEach(f => f(d))); p.stderr.on('data', d => errs.forEach(f => f(d))); p.on('close', () => exits.forEach(f => f()));
    return { write: (s) => p.stdin.write(s), close: () => { try { p.stdin.end(); } catch (er) {} setTimeout(() => p.kill(), 500); }, onOut: f => outs.push(f), onErr: f => errs.push(f), onExit: f => exits.push(f) };
  });
  const pq = (...a) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest', '-At', ...a]).toString().trim();
  pq('-c', 'drop table if exists shop.wb', '-c', 'create table shop.wb (id int primary key, v text)', '-c', "insert into shop.wb values (1, 'a'), (2, 'b')");
  S.saveSettings('shop-db-1', { allowWrite: false });
  const t = await S.resolve('shop-db-1');
  const K = 'local|shop-db-1|tab1test';
  t0Cleanup.push(() => WS._closeAll());
  // read-only: a write is refused, but a test run may try it and nothing stays
  await assert.rejects(WS.run(K, t, 'dgtest', { sql: "update shop.wb set v = 'x'" }), (e) => e.code === 'READ_ONLY');
  let r = await WS.run(K, t, 'dgtest', { sql: "update shop.wb set v = 'x' where id = 1 returning id, v; select count(*) from shop.wb where v = 'x'", mode: 'test' });
  assert.equal(r.error, null); assert.equal(r.rolledBack, true); assert.equal(r.tx, 'idle');
  assert.deepEqual(r.results[0].rows, [['1', 'x']]); assert.equal(r.results[0].tag, 'UPDATE 1'); assert.deepEqual(r.results[1].rows, [['1']]);
  assert.equal(pq('-c', 'select v from shop.wb where id = 1'), 'a', 'rolled back');
  await assert.rejects(WS.run(K, t, 'dgtest', { sql: 'commit', mode: 'test' }), (e) => e.code === 'NO_TEST');
  // session state lives on: SET in one run is there in the next (and a temp table once changes are allowed)
  r = await WS.run(K, t, 'dgtest', { sql: "set application_name = 'mine'" });
  assert.equal(r.error, null, JSON.stringify(r.error));
  S.saveSettings('shop-db-1', { allowWrite: true });
  const t2 = await S.resolve('shop-db-1');
  r = await WS.run(K, t2, 'dgtest', { sql: 'create temp table tt (x int); insert into tt values (7)' });
  assert.equal(r.error, null, JSON.stringify(r.error)); assert.equal(r.results[1].tag, 'INSERT 0 1');
  r = await WS.run(K, t2, 'dgtest', { sql: "select x, current_setting('application_name') from tt" });
  assert.deepEqual(r.results[0].rows, [['7', 'mine']]);
  // a transaction across runs, then commit / roll back
  r = await WS.run(K, t2, 'dgtest', { sql: "begin; update shop.wb set v = 'tx' where id = 2" });
  assert.equal(r.tx, 'open');
  assert.equal(pq('-c', 'select v from shop.wb where id = 2'), 'b', 'not visible outside before commit');
  r = await WS.run(K, t2, 'dgtest', { sql: "select v from shop.wb where id = 2" });
  assert.deepEqual(r.results[0].rows, [['tx']]); assert.equal(r.tx, 'open');
  assert.equal((await WS.tx(K, 'commit')).tx, 'idle');
  assert.equal(pq('-c', 'select v from shop.wb where id = 2'), 'tx');
  await WS.run(K, t2, 'dgtest', { sql: "begin; delete from shop.wb where id = 1" });
  assert.equal((await WS.tx(K, 'rollback')).tx, 'idle');
  assert.equal(pq('-c', 'select count(*) from shop.wb'), '2');
  // an error points at the text and leaves a failed transaction to roll back
  const text = "begin;\nselect 1;\nselect *\nfrom shop.wb\nwhere nope = 1;\nselect 2";
  r = await WS.run(K, t2, 'dgtest', { sql: text });
  assert.equal(r.error.statement, 3); assert.match(r.error.message, /nope/); assert.equal(text.slice(r.error.offset, r.error.offset + 4), 'nope');
  assert.equal(r.tx, 'aborted'); assert.equal(r.results.length, 2);
  await WS.tx(K, 'rollback');
  // unfinished text and psql commands never reach psql
  await assert.rejects(WS.run(K, t2, 'dgtest', { sql: "select 'oops" }), (e) => e.code === 'INCOMPLETE');
  await assert.rejects(WS.run(K, t2, 'dgtest', { sql: 'select 1 \\! id' }), /psql commands/);
  // many rows: the first 1000 come back, the rest with more()
  r = await WS.run(K, t2, 'dgtest', { sql: 'select g from generate_series(1, 2500) g' });
  assert.equal(r.results[0].rows.length, 1000); assert.equal(r.results[0].total, 2500); assert.equal(r.results[0].more, true);
  const m = WS.more(K, 0, 2000, 1000); assert.equal(m.rows.length, 500); assert.equal(m.rows[0][0], '2001'); assert.equal(m.more, false);
  // cancel a long query
  const long = WS.run(K, t2, 'dgtest', { sql: 'select pg_sleep(20)' });
  await new Promise(res => setTimeout(res, 700));
  assert.equal((await WS.cancel(K)).cancelled, true);
  r = await long; assert.match(r.error.message, /cancel/i);
  // dangerous statements still ask first in Run (not in Test run)
  await assert.rejects(WS.run(K, t2, 'dgtest', { sql: 'delete from shop.wb' }), (e) => e.code === 'NEEDS_CONFIRM');
  r = await WS.run(K, t2, 'dgtest', { sql: 'delete from shop.wb', mode: 'test' });
  assert.equal(r.results[0].tag, 'DELETE 2'); assert.equal(pq('-c', 'select count(*) from shop.wb'), '2');
  // :name parameters are asked for, then filled in as quoted values
  await assert.rejects(WS.run(K, t2, 'dgtest', { sql: 'select v from shop.wb where id = :id and v <> :skip' }), (e) => e.code === 'NEEDS_PARAMS' && e.names.join() === 'id,skip');
  r = await WS.run(K, t2, 'dgtest', { sql: 'select v, :label as l from shop.wb where id = :id', params: { id: 2, label: "it's" } });
  assert.deepEqual(r.results[0].rows, [['tx', "it's"]]);
  // EXPLAIN ANALYZE of a write inside a test run: real timings, nothing stays
  r = await WS.run(K, t2, 'dgtest', { sql: "EXPLAIN (ANALYZE, FORMAT JSON) update shop.wb set v = 'zz'", mode: 'test' });
  const plan = JSON.parse(r.results[0].rows[0][0]);
  assert.equal(plan[0].Plan['Node Type'], 'ModifyTable'); assert.ok(plan[0]['Execution Time'] >= 0);
  assert.equal(pq('-c', "select count(*) from shop.wb where v = 'zz'"), '0');
  WS.close(K); assert.equal(WS.state(K).none, true);
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('Data editor against PostgreSQL: many edits in one transaction, conflicts, test, foreign keys', { skip }, async () => {
  const S = setup();
  const pq = (...a) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest', '-At', ...a]).toString().trim();
  pq('-c', 'drop table if exists shop.ord, shop.cust', '-c', 'drop type if exists shop.st', '-c', "create type shop.st as enum ('new','paid')");
  pq('-c', "create table shop.cust (id int primary key, name text not null, vip boolean default false)", '-c', "create table shop.ord (id serial primary key, cust_id int references shop.cust(id), total numeric(10,2), status shop.st default 'new', meta jsonb)");
  pq('-c', "insert into shop.cust values (1, 'Ann', false), (2, 'Bob', true)", '-c', "insert into shop.ord (cust_id, total) values (1, 10), (1, 20), (2, 5)");
  const st = await S.structure('shop-db-1', 'dgtest', 'shop', 'ord');
  const col = (n) => st.columns.find(c => c.name === n);
  assert.deepEqual(col('status').enum, ['new', 'paid']); assert.equal(col('cust_id').fk.table, 'cust'); assert.equal(col('meta').base, 'jsonb'); assert.equal(col('total').category, 'N');
  S.saveSettings('shop-db-1', { allowWrite: false });
  const changes = [{ op: 'update', pk: { id: '1' }, set: { name: 'Anna' }, orig: { name: 'Ann' } }, { op: 'insert', values: { id: '3', name: 'Cem' } }, { op: 'delete', pk: { id: '2' } }];
  await assert.rejects(S.applyChanges('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', changes }), (e) => e.code === 'READ_ONLY');
  // test: works read-only, nothing stays
  const tr = await S.applyChanges('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', changes: [changes[0], changes[1]], test: true });
  assert.equal(tr.test, true); assert.equal(pq('-c', 'select string_agg(name, \',\' order by id) from shop.cust'), 'Ann,Bob');
  S.saveSettings('shop-db-1', { allowWrite: true });
  // a failing change (Bob has orders) rolls back all of them
  await assert.rejects(S.applyChanges('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', changes }), (e) => e.code === 'FAILED' && e.at === 2 && /foreign key/.test(e.message));
  assert.equal(pq('-c', 'select string_agg(name, \',\' order by id) from shop.cust'), 'Ann,Bob', 'nothing saved');
  // someone else changed the row since it was loaded → conflict, nothing saved
  pq('-c', "update shop.cust set name = 'Ann B' where id = 1");
  await assert.rejects(S.applyChanges('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', changes: [changes[0], changes[1]] }), (e) => e.code === 'CONFLICT' && /id=1/.test(e.message));
  assert.equal(pq('-c', 'select count(*) from shop.cust'), '2');
  const ok = await S.applyChanges('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', changes: [{ op: 'update', pk: { id: '1' }, set: { name: "O'Hara", vip: 'true' }, orig: { name: 'Ann B', vip: 'false' } }, changes[1]] });
  assert.deepEqual([ok.update, ok.insert], [1, 1]);
  assert.equal(pq('-c', "select name || '/' || vip from shop.cust where id = 1"), "O'Hara/true");
  // foreign keys: picker options and rows pointing here
  const fk = await S.fkLookup('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', column: 'id', q: 'ha' });
  assert.equal(fk.label, 'name'); assert.deepEqual(fk.options, [{ key: '1', label: "O'Hara" }]);
  assert.equal((await S.fkLookup('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', column: 'id', key: '2' })).options[0].label, 'Bob');
  const refs = await S.referencing('shop-db-1', 'dgtest', { schema: 'shop', table: 'cust', pk: { id: '1' } });
  assert.deepEqual(refs.refs.map(r => [r.table, r.column, r.count]), [['ord', 'cust_id', 2]]);
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('Who wrote it, against PostgreSQL: tracking records the changes of the app itself, row history, restore', { skip }, async () => {
  const S = setup();
  const H = require('../../server/pg-history');
  const pq = (...a) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest', '-At', ...a]).toString().trim();
  pq('-c', 'drop schema if exists dockgate_audit cascade', '-c', 'drop table if exists shop.acct', '-c', "create table shop.acct (id int primary key, owner text, balance int)", '-c', "insert into shop.acct values (1, 'ann', 100), (2, 'bob', 50)");
  pq('-c', "drop role if exists app_user", '-c', "create role app_user login", '-c', 'grant usage on schema shop to app_user', '-c', 'grant select, insert, update, delete on shop.acct to app_user');
  S.saveSettings('shop-db-1', { allowWrite: false });
  assert.equal((await H.status('shop-db-1', 'dgtest', 'shop', 'acct')).tracked, false);
  await assert.rejects(H.enable('shop-db-1', 'dgtest', 'shop', 'acct'), (e) => e.code === 'READ_ONLY');
  S.saveSettings('shop-db-1', { allowWrite: true });
  const st = await H.enable('shop-db-1', 'dgtest', 'shop', 'acct', { keepDays: 30 });
  assert.equal(st.tracked, true); assert.equal(st.keepDays, 30);
  // the app (another role, its own application_name) changes rows — no rights on dockgate_audit needed
  const asApp = (sql) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'app_user', '-d', 'dgtest', '-At', '-c', sql], { env: { ...process.env, PGAPPNAME: 'billing-api' } }).toString();
  asApp("update shop.acct set balance = 80 where id = 1");
  asApp("update shop.acct set balance = 80 where id = 1"); // nothing changed → not logged
  asApp("insert into shop.acct values (3, 'cem', 10)");
  asApp('delete from shop.acct where id = 2');
  const info = await S.applyChanges('shop-db-1', 'dgtest', { schema: 'shop', table: 'acct', changes: [{ op: 'update', pk: { id: '1' }, set: { owner: 'Ann' }, orig: { owner: 'ann' } }] });
  assert.equal(info.update, 1);
  const row = await H.rowInfo('shop-db-1', 'dgtest', 'shop', 'acct', { id: '1' }, 'shop-db-1');
  assert.ok(row.xmin); assert.equal(row.tracked, true);
  assert.deepEqual(row.history.map(h => [h.op, h.user, h.app, h.changed.join()]), [['U', 'postgres', 'DockGate', 'owner'], ['U', 'app_user', 'billing-api', 'balance']]);
  assert.equal(row.history[1].old.balance, 100); assert.equal(row.history[1].new.balance, 80);
  const log = await H.tableLog('shop-db-1', 'dgtest', 'shop', 'acct', { op: 'D' });
  assert.equal(log.changes.length, 1); assert.equal(log.changes[0].old.owner, 'bob'); assert.ok(log.users.includes('app_user'));
  // bring the deleted row back, and put row 1 back as before the app's change
  await H.restore('shop-db-1', 'dgtest', 'shop', 'acct', log.changes[0].id);
  assert.equal(pq('-c', 'select owner || balance from shop.acct where id = 2'), 'bob50');
  await H.restore('shop-db-1', 'dgtest', 'shop', 'acct', row.history[1].id);
  assert.equal(pq('-c', 'select owner || balance from shop.acct where id = 1'), 'ann100', 'the whole row as it was before that change');
  assert.equal((await H.tableLog('shop-db-1', 'dgtest', 'shop', 'acct', {})).changes[0].op, 'U', 'the restore is logged too');
  // turning it off keeps the log unless asked
  assert.equal((await H.disable('shop-db-1', 'dgtest', 'shop', 'acct')).tracked, false);
  asApp("update shop.acct set balance = 1 where id = 3");
  assert.equal((await H.tableLog('shop-db-1', 'dgtest', 'shop', 'acct', {})).changes.some(c => c.key.id === '3' && c.op === 'U'), false);
  assert.equal((await H.disable('shop-db-1', 'dgtest', 'shop', 'acct', { dropLog: true })).count, 0);
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('Many rows at once against PostgreSQL: import (insert / upsert / skip), bulk update by filter, find and replace', { skip }, async () => {
  const S = setup();
  const BU = require('../../server/pg-bulk');
  const pq = (...a) => execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgtest', '-At', ...a]).toString().trim();
  pq('-c', 'drop table if exists shop.prod', '-c', 'create table shop.prod (sku text primary key, name text not null, price numeric(10,2), note text)');
  S.saveSettings('shop-db-1', { allowWrite: false });
  const rows = Array.from({ length: 1200 }, (_, i) => [`S${i}`, `Item ${i}`, String(i % 50), i % 3 ? '' : "it's"]);
  const t1 = await BU.importRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', columns: ['sku', 'name', 'price', 'note'], rows, test: true });
  assert.deepEqual([t1.written, t1.test], [1200, true]); assert.equal(pq('-c', 'select count(*) from shop.prod'), '0');
  await assert.rejects(BU.importRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', columns: ['sku', 'name'], rows: [['a', 'b']] }), (e) => e.code === 'READ_ONLY');
  S.saveSettings('shop-db-1', { allowWrite: true });
  const r1 = await BU.importRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', columns: ['sku', 'name', 'price', 'note'], rows });
  assert.equal(r1.written, 1200); assert.equal(pq('-c', "select count(*) || '/' || count(note) from shop.prod"), '1200/400', 'empty cells are NULL');
  // a bad row (NOT NULL) in the middle: nothing is imported
  await assert.rejects(BU.importRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', columns: ['sku', 'name'], rows: [['X1', 'ok'], ['X2', '']] }), (e) => e.code === 'FAILED' && /null/i.test(e.message));
  assert.equal(pq('-c', "select count(*) from shop.prod where sku like 'X%'"), '0');
  // skip existing / update existing by key
  const r2 = await BU.importRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', columns: ['sku', 'name'], rows: [['S1', 'changed'], ['NEW1', 'new']], mode: 'skip' });
  assert.deepEqual([r2.written, r2.skipped], [1, 1]); assert.equal(pq('-c', "select name from shop.prod where sku = 'S1'"), 'Item 1');
  await BU.importRows('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', columns: ['sku', 'name'], rows: [['S1', 'changed']], mode: 'upsert' });
  assert.equal(pq('-c', "select name || '/' || price from shop.prod where sku = 'S1'"), 'changed/1.00', 'only mapped columns change');
  // bulk update by the Data filter
  await assert.rejects(BU.bulkUpdate('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', set: { note: 'x' } }), (e) => e.code === 'ALL_ROWS');
  const b1 = await BU.bulkUpdate('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', filters: [{ col: 'price', op: '=', value: '0' }], set: { note: 'free' }, test: true });
  assert.equal(b1.rows, 24); assert.equal(pq('-c', "select count(*) from shop.prod where note = 'free'"), '0');
  await BU.bulkUpdate('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', filters: [{ col: 'price', op: '=', value: '0' }], set: { note: 'free' } });
  assert.equal(pq('-c', "select count(*) from shop.prod where note = 'free'"), '24');
  assert.equal((await BU.bulkUpdate('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', where: "sku like 'NEW%'", op: 'delete' })).rows, 1);
  // find and replace: preview, part of the value (case-insensitive), whole value
  const pv = await BU.findReplace('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', column: 'name', find: 'ITEM 1', replace: 'Thing-1', preview: true });
  assert.equal(pv.rows, 310, 'Item 1, 10–19, 100–199, 1000–1199 (S1 was renamed)'); assert.equal(pv.samples[0].after.startsWith('Thing-1'), true);
  assert.equal((await BU.findReplace('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', column: 'name', find: 'item 1', replace: 'Thing-1' })).rows, 310);
  assert.equal(pq('-c', "select name from shop.prod where sku = 'S15'"), 'Thing-15');
  assert.equal((await BU.findReplace('shop-db-1', 'dgtest', { schema: 'shop', table: 'prod', column: 'note', find: "it's", replace: 'its', wholeValue: true, matchCase: true })).rows, 392, '400 minus the 8 set to free above');
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('Design (pg-ddl): operations → quoted SQL; types and expressions checked', () => {
  const D = require('../../server/pg-ddl');
  const structure = { columns: [{ name: 'id' }, { name: 'Name' }, { name: 'price' }] };
  const b = (ops) => D.build(ops, { schema: 'shop', table: 'items', structure }).map(s => s.sql);
  assert.deepEqual(b([{ op: 'addColumn', name: 'sku', type: 'varchar(40)', notnull: true, default: "'x'", unique: true, comment: "it's" }]), [
    `ALTER TABLE "shop"."items" ADD COLUMN "sku" varchar(40) NOT NULL DEFAULT 'x'`, 'ALTER TABLE "shop"."items" ADD UNIQUE ("sku")', `COMMENT ON COLUMN "shop"."items"."sku" IS 'it''s'`]);
  assert.deepEqual(b([{ op: 'alterColumn', name: 'Name', type: 'text', notnull: false, default: null, rename: 'title' }]), [
    'ALTER TABLE "shop"."items" ALTER COLUMN "Name" TYPE text', 'ALTER TABLE "shop"."items" ALTER COLUMN "Name" DROP DEFAULT', 'ALTER TABLE "shop"."items" ALTER COLUMN "Name" DROP NOT NULL', 'ALTER TABLE "shop"."items" RENAME COLUMN "Name" TO "title"']);
  assert.deepEqual(b([{ op: 'alterColumn', name: 'price', type: 'numeric(12,2)', using: 'price::numeric(12,2)' }]), ['ALTER TABLE "shop"."items" ALTER COLUMN "price" TYPE numeric(12,2) USING price::numeric(12,2)']);
  assert.equal(b([{ op: 'addIndex', columns: ['Name', 'price'], unique: true }])[0], 'CREATE UNIQUE INDEX "items_Name_price_key" ON "shop"."items" ("Name", "price")');
  assert.equal(b([{ op: 'addForeignKey', columns: ['id'], refTable: 'owners', refColumns: ['id'], onDelete: 'cascade' }])[0], 'ALTER TABLE "shop"."items" ADD FOREIGN KEY ("id") REFERENCES "shop"."owners" ("id") ON DELETE CASCADE');
  assert.equal(D.build([{ op: 'createTable', schema: 'public', name: 'notes', columns: [{ name: 'id', type: 'bigint', identity: true, pk: true }, { name: 'body', type: 'text', notnull: true }, { name: 'at', type: 'timestamp with time zone', default: 'now()' }] }])[0].sql,
    'CREATE TABLE "public"."notes" (\n  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  "body" text NOT NULL,\n  "at" timestamp with time zone DEFAULT now(),\n  PRIMARY KEY ("id")\n)');
  assert.throws(() => b([{ op: 'addColumn', name: 'x', type: 'int; drop table t' }]), /not a type/);
  assert.throws(() => b([{ op: 'addColumn', name: 'x', type: 'int', default: '1; drop table t' }]), /one expression/);
  assert.equal(b([{ op: 'addCheck', expr: "price > 0 or note = 'a;b'" }])[0], "ALTER TABLE \"shop\".\"items\" ADD CHECK (price > 0 or note = 'a;b')");
  assert.throws(() => b([{ op: 'dropColumn', name: 'nope' }]), /no column nope/);
  assert.throws(() => b([{ op: 'addForeignKey', columns: ['id', 'price'], refTable: 'o', refColumns: ['id'] }]), /as many/);
  assert.equal(D.build([{ op: 'addIndex', columns: ['a'], concurrently: true }], { schema: 's', table: 't' })[0].concurrent, true);
});

test('Design against PostgreSQL: test rolls back, a failing change stops all, apply, create, duplicate, read-only', { skip }, async () => {
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-c', 'drop database if exists dgddl', '-c', 'create database dgddl'], { stdio: 'pipe' });
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgddl', '-c', `create table public.items (id bigserial primary key, name text, price text);
    insert into items (name, price) values ('a', '1.5'), ('a', 'cheap');`], { stdio: 'pipe' });
  const S = setup(); const D = require('../../server/pg-ddl');
  const cols = async () => (await S.structure('shop-db-1', 'dgddl', 'public', 'items')).columns.map(c => `${c.name}:${c.type}`);
  const before = await cols();
  // read-only: apply refused, test allowed
  S.saveSettings('shop-db-1', { allowWrite: false });
  await assert.rejects(D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'items', ops: [{ op: 'addColumn', name: 'sku', type: 'text' }] }), /read-only/);
  let r = await D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'items', test: true, ops: [{ op: 'addColumn', name: 'sku', type: 'text' }, { op: 'alterColumn', name: 'name', rename: 'title' }] });
  assert.equal(r.test, true); assert.deepEqual(await cols(), before, 'the test left nothing');
  // a change that does not fit the data: the message says which one, nothing kept
  await assert.rejects(D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'items', test: true, ops: [{ op: 'addColumn', name: 'sku', type: 'text' }, { op: 'alterColumn', name: 'price', type: 'numeric(10,2)', using: 'price::numeric' }] }),
    (e) => /Change 2 \(price: type numeric\(10,2\)\)/.test(e.message) && /invalid input syntax/.test(e.message) && e.at === 1);
  await assert.rejects(D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'items', test: true, ops: [{ op: 'addIndex', columns: ['name'], unique: true }] }), /could not create unique index|duplicate/i);
  // apply for real (concurrent index outside the transaction)
  S.saveSettings('shop-db-1', { allowWrite: true });
  r = await D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'items', ops: [{ op: 'addColumn', name: 'sku', type: 'varchar(20)', default: "'n/a'" }, { op: 'alterColumn', name: 'name', rename: 'title', notnull: true }, { op: 'addIndex', columns: ['sku'], concurrently: true }] });
  assert.equal(r.ok, true);
  assert.deepEqual(await cols(), ['id:bigint', 'title:text', 'price:text', 'sku:character varying(20)']);
  const st = await S.structure('shop-db-1', 'dgddl', 'public', 'items');
  assert.ok(st.indexes.some(i => i.name === 'items_sku_idx')); assert.equal(st.columns.find(c => c.name === 'title').notnull, true);
  // create and duplicate
  await D.apply('shop-db-1', 'dgddl', { schema: 'public', ops: [{ op: 'createTable', schema: 'public', name: 'notes', columns: [{ name: 'id', type: 'bigint', identity: true, pk: true }, { name: 'item_id', type: 'bigint' }, { name: 'body', type: 'text', notnull: true }] }] });
  await D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'notes', ops: [{ op: 'addForeignKey', columns: ['item_id'], refTable: 'items', refColumns: ['id'], onDelete: 'CASCADE' }] });
  await D.apply('shop-db-1', 'dgddl', { schema: 'public', table: 'items', ops: [{ op: 'duplicate', name: 'items_copy', withData: true }] });
  const o = await S.objects('shop-db-1', 'dgddl');
  assert.ok(o.relations.some(x => x.name === 'notes') && o.relations.some(x => x.name === 'items_copy'));
  assert.equal(execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgddl', '-At', '-c', 'select count(*) from items_copy']).toString().trim(), '2');
  const notes = await S.structure('shop-db-1', 'dgddl', 'public', 'notes');
  assert.ok(notes.constraints.some(c => c.type === 'f' && /ON DELETE CASCADE/.test(c.def)));
  S.saveSettings('shop-db-1', { allowWrite: false });
});

test('Export / import / test data against PostgreSQL: pg_dump of ticked tables, CSV zip, xlsx, .sql import, made-up rows', { skip }, async () => {
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-c', 'drop database if exists dgio', '-c', 'create database dgio'], { stdio: 'pipe' });
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgio', '-c', `create type mood as enum ('ok', 'sad');
    create table customers (id bigint generated by default as identity primary key, name text not null, email varchar(60) not null unique, born date, vip boolean not null, feel mood not null);
    create table orders (id bigserial primary key, customer_id bigint not null references customers(id), total numeric(8,2) not null, note text, made timestamptz not null default now(), tags text[]);
    create table other (x int); insert into customers (name, email, vip, feel) values ('A', 'a@x', true, 'ok'), ('B "q"', 'b@x', false, 'sad');`], { stdio: 'pipe' });
  const S = setup(); const IO = require('../../server/pg-io');
  // dump: only the ticked tables, INSERT rows
  let sql = ''; await IO.dump('shop-db-1', 'dgio', { tables: 'public.customers', what: 'both', rows: 'insert', clean: true }, (c) => { sql += c; });
  assert.match(sql, /CREATE TABLE public\.customers/); assert.match(sql, /DROP TABLE IF EXISTS public\.customers/); assert.match(sql, /INSERT INTO public\.customers \(id, name, email, born, vip, feel\) VALUES/);
  assert.doesNotMatch(sql, /CREATE TABLE public\.other/);
  // zip of CSV and an xlsx — read back with Python's zipfile
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgio-'));
  fs.writeFileSync(path.join(dir, 'a.zip'), await IO.zipTables('shop-db-1', 'dgio', { tables: ['public.customers', 'public.other'], format: 'csv' }));
  fs.writeFileSync(path.join(dir, 'a.xlsx'), await IO.zipTables('shop-db-1', 'dgio', { tables: ['public.customers'], format: 'xlsx' }));
  const py = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1]);print(sorted(z.namelist()));print(z.read('customers.csv').decode())\nx=zipfile.ZipFile(sys.argv[2]);assert x.testzip() is None;s=x.read('xl/worksheets/sheet1.xml').decode();print('B "q"' in s.replace('&quot;','"'), '<v>1</v>' in s, 'customers' in x.read('xl/workbook.xml').decode())`;
  const out = execFileSync('python3', ['-c', py, path.join(dir, 'a.zip'), path.join(dir, 'a.xlsx')]).toString();
  assert.match(out, /\['customers\.csv', 'other\.csv'\]/); assert.match(out, /id,name,email,born,vip,feel/); assert.match(out, /"B ""q"""/); assert.match(out, /True True True/);
  // .sql import: read-only refused; then a file with an error in the middle, in one transaction → nothing stays
  const { Readable } = require('stream');
  S.saveSettings('shop-db-1', { allowWrite: false });
  await assert.rejects(IO.importSql('shop-db-1', 'dgio', Readable.from(['select 1;']), {}), /read-only/);
  S.saveSettings('shop-db-1', { allowWrite: true });
  await assert.rejects(IO.importSql('shop-db-1', 'dgio', Readable.from(['create table imp1 (a int);\n', 'insert into imp1 values (1);\n', 'insert into nope values (2);\n']), { single: true }), /Line 3: .*nope.*nothing was imported/s);
  assert.equal(execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgio', '-At', '-c', "select count(*) from pg_tables where tablename = 'imp1'"]).toString().trim(), '0');
  const ok = await IO.importSql('shop-db-1', 'dgio', Readable.from([sql.replace(/public\.customers/g, 'public.customers2').replace(/customers_pkey|customers_email_key|customers_id_seq/g, (m) => m.replace('customers', 'customers2'))]), { single: true });
  assert.equal(ok.ok, true); assert.ok(ok.tags.INSERT >= 1);
  assert.equal(execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgio', '-At', '-c', 'select count(*) from customers2']).toString().trim(), '2');
  // test data: types, names, enum, unique email, the foreign key from existing rows; test rolls back
  let m = await IO.mock('shop-db-1', 'dgio', { schema: 'public', table: 'customers', rows: 50, test: true });
  assert.equal(m.rows, 50); assert.equal(m.sample.length, 5); assert.ok(m.skipped.includes('id'));
  assert.match(m.sample[0].email, /@example\.com$/); assert.ok(['ok', 'sad'].includes(m.sample[0].feel)); assert.equal(typeof m.sample[0].vip, 'boolean');
  assert.equal(execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgio', '-At', '-c', 'select count(*) from customers']).toString().trim(), '2', 'the test left nothing');
  m = await IO.mock('shop-db-1', 'dgio', { schema: 'public', table: 'customers', rows: 200 });
  assert.equal(m.rows, 200);
  m = await IO.mock('shop-db-1', 'dgio', { schema: 'public', table: 'orders', rows: 300 });
  assert.equal(m.rows, 300);
  const chk = execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgio', '-At', '-c', "select count(*) filter (where c.id is null), count(distinct o.customer_id) > 50, max(o.total) <= 999999.99, count(*) filter (where o.tags is null) from orders o left join customers c on c.id = o.customer_id"]).toString().trim();
  assert.equal(chk, '0|t|t|0');
  execFileSync('psql', ['-X', '-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', 'dgio', '-c', 'create table empty_ref (id int primary key); create table needs (id int, r int not null references empty_ref(id))']);
  await assert.rejects(IO.mock('shop-db-1', 'dgio', { schema: 'public', table: 'needs', rows: 5 }), /empty_ref has no rows yet/);
  S.saveSettings('shop-db-1', { allowWrite: false });
});
