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

  CREATE TABLE IF NOT EXISTS smtp_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    description TEXT,
    cooldown_minutes INTEGER DEFAULT 5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'ssh',
    host TEXT,
    port INTEGER DEFAULT 22,
    username TEXT,
    key_path TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration — add new columns to existing build_history table / Mövcud build_history cədvəlinə yeni sütunlar əlavə et
try { db.exec('ALTER TABLE build_history ADD COLUMN context_url TEXT DEFAULT ""'); } catch(e) {}
try { db.exec('ALTER TABLE build_history ADD COLUMN build_args TEXT DEFAULT "{}"'); } catch(e) {}
try { db.exec('ALTER TABLE build_history ADD COLUMN nocache INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE build_history ADD COLUMN pull INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE notification_log ADD COLUMN channel TEXT DEFAULT "email"'); } catch(e) {}
try { db.exec('ALTER TABLE servers ADD COLUMN password TEXT'); } catch(e) {}

// Default notification rules / Defolt bildiriş qaydaları
const defaultRules = [
  ['container_die', 'Container stopped or died', 5],
  ['container_restart', 'Container restarted', 5],
  ['container_oom', 'Container killed by OOM (out of memory)', 5],
  ['container_unhealthy', 'Container health check failing', 10],
  ['disk_threshold', 'Disk usage exceeds threshold', 30],
  ['build_failed', 'Image build failed', 5],
];
const insertRule = db.prepare('INSERT OR IGNORE INTO notification_rules (event_type, description, cooldown_minutes) VALUES (?, ?, ?)');
defaultRules.forEach(([type, desc, cd]) => insertRule.run(type, desc, cd));

// Indexes for frequently queried columns / Tez-tez sorğulanan sütunlar üçün indekslər
try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_resource ON activity (resource_id, resource_type)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity (created_at)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_builds_started ON build_history (started_at)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_log (created_at)'); } catch(e) {}

// Retention — keep only last 1000 activity records and 100 builds
// Saxlama — yalnız son 1000 fəaliyyət qeydi və 100 build saxla
try { db.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY created_at DESC LIMIT 1000)'); } catch(e) {}
try { db.exec('DELETE FROM build_history WHERE id NOT IN (SELECT id FROM build_history ORDER BY started_at DESC LIMIT 100)'); } catch(e) {}

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
  active_server: 'local',
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
  // Retention — keep only last N records / Saxlama — yalnız son N qeydi saxla
  trimActivity: db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY created_at DESC LIMIT 1000)'),
  trimBuilds: db.prepare('DELETE FROM build_history WHERE id NOT IN (SELECT id FROM build_history ORDER BY started_at DESC LIMIT 100)'),

  // Settings
  getSettings: db.prepare('SELECT * FROM settings'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

  // Build History — store build records / Build tarixçəsini saxlamaq üçün
  getBuilds: db.prepare('SELECT * FROM build_history ORDER BY started_at DESC LIMIT ?'),
  getBuild: db.prepare('SELECT * FROM build_history WHERE id = ?'),
  insertBuild: db.prepare('INSERT INTO build_history (id, image_tag, dockerfile, context_url, build_args, nocache, pull, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updateBuildStatus: db.prepare('UPDATE build_history SET status = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ?, image_id = ?, error = ? WHERE id = ?'),
  appendBuildLog: db.prepare('UPDATE build_history SET log = log || ? WHERE id = ?'),
  deleteBuild: db.prepare('DELETE FROM build_history WHERE id = ?'),
  clearBuilds: db.prepare('DELETE FROM build_history'),

  // Hidden Docker Builds — images hidden from build history / Build history-dən gizlədilmiş image-lər
  getHiddenBuilds: db.prepare('SELECT image_id FROM hidden_docker_builds'),
  hideBuild: db.prepare('INSERT OR IGNORE INTO hidden_docker_builds (image_id) VALUES (?)'),
  unhideBuild: db.prepare('DELETE FROM hidden_docker_builds WHERE image_id = ?'),
  clearHiddenBuilds: db.prepare('DELETE FROM hidden_docker_builds'),

  // SMTP Config
  getSmtpConfig: db.prepare('SELECT * FROM smtp_config'),
  setSmtpConfig: db.prepare('INSERT OR REPLACE INTO smtp_config (key, value) VALUES (?, ?)'),
  deleteSmtpConfig: db.prepare('DELETE FROM smtp_config'),

  // Notification Rules
  getNotificationRules: db.prepare('SELECT * FROM notification_rules ORDER BY id'),
  getRule: db.prepare('SELECT * FROM notification_rules WHERE event_type = ?'),
  setRuleEnabled: db.prepare('UPDATE notification_rules SET enabled = ? WHERE event_type = ?'),
  setRuleCooldown: db.prepare('UPDATE notification_rules SET cooldown_minutes = ? WHERE event_type = ?'),

  // Notification Log
  insertNotificationLog: db.prepare('INSERT INTO notification_log (event_type, subject, recipient, status, error, channel) VALUES (?, ?, ?, ?, ?, ?)'),
  getNotificationLogs: db.prepare('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?'),
  getLastNotification: db.prepare('SELECT * FROM notification_log WHERE event_type = ? AND status = ? ORDER BY created_at DESC LIMIT 1'),
  clearNotificationLogs: db.prepare('DELETE FROM notification_log'),
  trimNotificationLogs: db.prepare('DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY created_at DESC LIMIT 500)'),

  // Servers (SSH multi-host)
  getServers: db.prepare('SELECT * FROM servers ORDER BY id'),
  getServer: db.prepare('SELECT * FROM servers WHERE id = ?'),
  insertServer: db.prepare('INSERT INTO servers (id, type, host, port, username, key_path, password, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updateServer: db.prepare('UPDATE servers SET host = ?, port = ?, username = ?, key_path = ?, password = ?, description = ? WHERE id = ?'),
  deleteServer: db.prepare('DELETE FROM servers WHERE id = ?'),
};

module.exports = { db, stmts };
