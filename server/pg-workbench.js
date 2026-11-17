// SQL Workbench storage (DockGate's database): editor tabs, query history, saved queries — per server + container.
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS pg_wb_tabs (
  id TEXT NOT NULL, server_id TEXT NOT NULL, container TEXT NOT NULL, name TEXT, dbname TEXT, sql TEXT, position INTEGER, updated_at INTEGER,
  PRIMARY KEY (server_id, container, id))`);
db.exec(`CREATE TABLE IF NOT EXISTS pg_wb_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, container TEXT NOT NULL, dbname TEXT, sql TEXT, mode TEXT, ok INTEGER, ms INTEGER, rows INTEGER, at INTEGER)`);
db.exec('CREATE INDEX IF NOT EXISTS pg_wb_history_k ON pg_wb_history (server_id, container, at)');
db.exec(`CREATE TABLE IF NOT EXISTS pg_wb_saved (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, container TEXT NOT NULL, folder TEXT, name TEXT NOT NULL, description TEXT, sql TEXT, dbname TEXT, updated_at INTEGER)`);

const err = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const sid = () => require('./docker').getActiveServerId();
const ID_RE = /^[a-z0-9]{6,40}$/;
const KEEP_HISTORY = 500;

const q = {
  tabs: db.prepare('SELECT id, name, dbname, sql, position, updated_at FROM pg_wb_tabs WHERE server_id = ? AND container = ? ORDER BY position, updated_at'),
  putTab: db.prepare(`INSERT INTO pg_wb_tabs (id, server_id, container, name, dbname, sql, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, container, id) DO UPDATE SET name = excluded.name, dbname = excluded.dbname, sql = excluded.sql, position = excluded.position, updated_at = excluded.updated_at`),
  delTab: db.prepare('DELETE FROM pg_wb_tabs WHERE server_id = ? AND container = ? AND id = ?'),
  addHist: db.prepare('INSERT INTO pg_wb_history (server_id, container, dbname, sql, mode, ok, ms, rows, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  trimHist: db.prepare('DELETE FROM pg_wb_history WHERE server_id = ? AND container = ? AND id NOT IN (SELECT id FROM pg_wb_history WHERE server_id = ? AND container = ? ORDER BY at DESC LIMIT ?)'),
  hist: db.prepare("SELECT id, dbname, sql, mode, ok, ms, rows, at FROM pg_wb_history WHERE server_id = ? AND container = ? AND (? = '' OR sql LIKE ?) ORDER BY at DESC LIMIT 200"),
  saved: db.prepare('SELECT id, folder, name, description, sql, dbname, updated_at FROM pg_wb_saved WHERE server_id = ? AND container = ? ORDER BY folder, name'),
  addSaved: db.prepare('INSERT INTO pg_wb_saved (server_id, container, folder, name, description, sql, dbname, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updSaved: db.prepare('UPDATE pg_wb_saved SET folder = ?, name = ?, description = ?, sql = ?, dbname = ?, updated_at = ? WHERE id = ? AND server_id = ? AND container = ?'),
  delSaved: db.prepare('DELETE FROM pg_wb_saved WHERE id = ? AND server_id = ? AND container = ?'),
};

function tabs(c) { return q.tabs.all(sid(), c); }
function putTab(c, id, { name, dbname, sql, position }) {
  if (!ID_RE.test(String(id))) throw err('Bad tab id');
  const s = String(sql == null ? '' : sql); if (s.length > 1024 * 1024) throw err('A tab holds up to 1 MB');
  q.putTab.run(id, sid(), c, String(name || 'Query').slice(0, 60), dbname ? String(dbname).slice(0, 63) : null, s, Number(position) || 0, Date.now());
  return { ok: true };
}
function delTab(c, id) { q.delTab.run(sid(), c, String(id)); return { ok: true }; }
function addHistory(c, { dbname, sql, mode, ok, ms, rows }) {
  q.addHist.run(sid(), c, dbname || null, String(sql).slice(0, 20000), mode || 'run', ok ? 1 : 0, ms || 0, rows || 0, Date.now());
  q.trimHist.run(sid(), c, sid(), c, KEEP_HISTORY);
}
function history(c, search = '') { const s = String(search || '').trim(); return q.hist.all(sid(), c, s, `%${s}%`); }
function saved(c) { return q.saved.all(sid(), c); }
function saveQuery(c, { id, folder, name, description, sql, dbname }) {
  const n = String(name || '').trim(); if (!n) throw err('A name is needed');
  const args = [String(folder || '').trim().slice(0, 60) || null, n.slice(0, 120), String(description || '').slice(0, 500), String(sql || '').slice(0, 200000), dbname || null, Date.now()];
  if (id) { q.updSaved.run(...args, Number(id), sid(), c); return { id: Number(id) }; }
  return { id: q.addSaved.run(sid(), c, ...args).lastInsertRowid };
}
function delSaved(c, id) { q.delSaved.run(Number(id), sid(), c); return { ok: true }; }

module.exports = { tabs, putTab, delTab, addHistory, history, saved, saveQuery, delSaved, ID_RE };
