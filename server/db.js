const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'docker-panel.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'container',
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'container',
    note TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, type)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'container',
    tag TEXT NOT NULL,
    color TEXT DEFAULT '#00d4aa',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, type, tag)
  );

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL,
    resource_type TEXT NOT NULL DEFAULT 'container',
    resource_name TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS build_history (
    id TEXT PRIMARY KEY,
    image_tag TEXT,
    dockerfile TEXT DEFAULT 'Dockerfile',
    context_url TEXT DEFAULT '',
    build_args TEXT DEFAULT '{}',
    nocache INTEGER DEFAULT 0,
    pull INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'building',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    duration_ms INTEGER,
    image_id TEXT,
    error TEXT,
    log TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS hidden_docker_builds (
    image_id TEXT PRIMARY KEY,
    hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration — mövcud build_history cədvəlinə yeni sütunlar əlavə et
try { db.exec('ALTER TABLE build_history ADD COLUMN context_url TEXT DEFAULT ""'); } catch(e) {}
try { db.exec('ALTER TABLE build_history ADD COLUMN build_args TEXT DEFAULT "{}"'); } catch(e) {}
try { db.exec('ALTER TABLE build_history ADD COLUMN nocache INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE build_history ADD COLUMN pull INTEGER DEFAULT 0'); } catch(e) {}

// Default settings
const defaultSettings = {
  theme: 'dark',
  refreshInterval: '5000',
  defaultView: 'table',
  sidebarCollapsed: 'false',
  logTailLines: '200',
  logTimestamps: 'false',
  logAutoScroll: 'true',
  logWrapLines: 'true',
  terminalShell: '/bin/sh',
  terminalFontSize: '14',
  dateFormat: 'relative',
  confirmDestructive: 'true',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
Object.entries(defaultSettings).forEach(([k, v]) => insertSetting.run(k, v));

// Prepared statements
const stmts = {
  // Favorites
  getFavorites: db.prepare('SELECT * FROM favorites ORDER BY created_at DESC'),
  getFavoritesByType: db.prepare('SELECT * FROM favorites WHERE type = ? ORDER BY created_at DESC'),
  isFavorite: db.prepare('SELECT 1 FROM favorites WHERE id = ? AND type = ?'),
  addFavorite: db.prepare('INSERT OR IGNORE INTO favorites (id, type, name) VALUES (?, ?, ?)'),
  removeFavorite: db.prepare('DELETE FROM favorites WHERE id = ? AND type = ?'),

  // Notes
  getNotes: db.prepare('SELECT * FROM notes ORDER BY updated_at DESC'),
  getNote: db.prepare('SELECT * FROM notes WHERE id = ? AND type = ?'),
  setNote: db.prepare(`INSERT INTO notes (id, type, note, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id, type) DO UPDATE SET note = excluded.note, updated_at = CURRENT_TIMESTAMP`),
  deleteNote: db.prepare('DELETE FROM notes WHERE id = ? AND type = ?'),

  // Tags
  getTags: db.prepare('SELECT * FROM tags ORDER BY created_at DESC'),
  getTagsForResource: db.prepare('SELECT * FROM tags WHERE id = ? AND type = ?'),
  addTag: db.prepare('INSERT OR IGNORE INTO tags (id, type, tag, color) VALUES (?, ?, ?, ?)'),
  removeTag: db.prepare('DELETE FROM tags WHERE id = ? AND type = ? AND tag = ?'),

  // Activity
  getActivity: db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?'),
  logActivity: db.prepare('INSERT INTO activity (resource_id, resource_type, resource_name, action, details) VALUES (?, ?, ?, ?, ?)'),
  clearActivity: db.prepare('DELETE FROM activity'),

  // Settings
  getSettings: db.prepare('SELECT * FROM settings'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

  // Build History — build tarixçəsini saxlamaq üçün
  getBuilds: db.prepare('SELECT * FROM build_history ORDER BY started_at DESC LIMIT ?'),
  getBuild: db.prepare('SELECT * FROM build_history WHERE id = ?'),
  insertBuild: db.prepare('INSERT INTO build_history (id, image_tag, dockerfile, context_url, build_args, nocache, pull, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updateBuildStatus: db.prepare('UPDATE build_history SET status = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ?, image_id = ?, error = ? WHERE id = ?'),
  appendBuildLog: db.prepare('UPDATE build_history SET log = log || ? WHERE id = ?'),
  deleteBuild: db.prepare('DELETE FROM build_history WHERE id = ?'),
  clearBuilds: db.prepare('DELETE FROM build_history'),

  // Hidden Docker Builds — build history-dən gizlədilmiş image-lər
  getHiddenBuilds: db.prepare('SELECT image_id FROM hidden_docker_builds'),
  hideBuild: db.prepare('INSERT OR IGNORE INTO hidden_docker_builds (image_id) VALUES (?)'),
  unhideBuild: db.prepare('DELETE FROM hidden_docker_builds WHERE image_id = ?'),
  clearHiddenBuilds: db.prepare('DELETE FROM hidden_docker_builds'),
};

module.exports = { db, stmts };
