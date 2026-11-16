// Earlier versions of files saved from the Files editor. Kept in DockGate's database (encrypted — config files hold
// secrets), not next to the file: a copy like default.conf.bak inside nginx's sites-enabled/ would be loaded too.
// The last 5 per file, up to 512 KB each.
const { db } = require('./db');
const secrets = require('./auth/secrets');

db.exec(`CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, path TEXT NOT NULL, t INTEGER NOT NULL, size INTEGER, content TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS file_versions_p ON file_versions (server_id, path, t)');
const KEEP = 5, MAX = 512 * 1024;

/** Keep the content a file had before a save. */
function save(serverId, path, content) {
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > MAX) return false;
  db.prepare('INSERT INTO file_versions (server_id, path, t, size, content) VALUES (?, ?, ?, ?, ?)').run(serverId, path, Date.now(), Buffer.byteLength(text), secrets.encrypt(text));
  db.prepare(`DELETE FROM file_versions WHERE server_id = ? AND path = ? AND id NOT IN
    (SELECT id FROM file_versions WHERE server_id = ? AND path = ? ORDER BY t DESC, id DESC LIMIT ${KEEP})`).run(serverId, path, serverId, path);
  return true;
}
function list(serverId, path) { return db.prepare('SELECT id, t, size FROM file_versions WHERE server_id = ? AND path = ? ORDER BY t DESC, id DESC').all(serverId, path); }
function get(serverId, id) {
  const r = db.prepare('SELECT id, path, t, size, content FROM file_versions WHERE server_id = ? AND id = ?').get(serverId, Number(id));
  return r ? { id: r.id, path: r.path, t: r.t, size: r.size, content: secrets.decryptStrict(r.content) } : null;
}
module.exports = { save, list, get, KEEP, MAX };
