const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR override allows tests (and custom deploys) to use an isolated data directory
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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

  CREATE TABLE IF NOT EXISTS registries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    server_address TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS provision_runs (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    preset TEXT NOT NULL,
    distro TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    item_total INTEGER DEFAULT 0,
    item_ok INTEGER DEFAULT 0,
    item_failed INTEGER DEFAULT 0,
    source_ip TEXT,
    log TEXT DEFAULT '',
    error TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS provision_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    seq INTEGER,
    label TEXT,
    state TEXT NOT NULL,
    detect_cmd TEXT,
    install_cmd TEXT,
    verify_cmd TEXT,
    log TEXT DEFAULT '',
    duration_ms INTEGER,
    error TEXT,
    reason TEXT,
    finished_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS host_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    cpu REAL, mem_pct REAL, disk_pct REAL, swap_pct REAL,
    load1 REAL, net_rx INTEGER, net_tx INTEGER, procs INTEGER
  );

  -- Per-server notification-channel overrides for the edge notifier agent. When a row exists
  -- the agent on that host uses these values instead of the global smtp_config. tg_token and
  -- smtp_pass are encrypted at rest (see the secret-encryption migration below).
  CREATE TABLE IF NOT EXISTS server_channels (
    server_id TEXT PRIMARY KEY,
    tg_token TEXT,
    tg_chat_id TEXT,
    smtp_host TEXT,
    smtp_port TEXT,
    smtp_user TEXT,
    smtp_pass TEXT,
    smtp_from TEXT,
    smtp_to TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Edge-notifier deploy jobs (install / update / remove / install-all). Persisted so the live
  -- log survives a closed modal / browser, mirroring provision_runs.
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    server_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    total INTEGER DEFAULT 1,
    ok INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    phase TEXT,
    servers TEXT DEFAULT '[]',
    log TEXT DEFAULT '',
    error TEXT,
    source_ip TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
  );
`);

// Idempotent additive migrations
// "duplicate column" is expected on repeat boots — silenced; other errors are logged
// so that genuine corruption / locked-DB problems aren't hidden silently.
function migrate(sql) {
  try { db.exec(sql); }
  catch (e) {
    if (!/duplicate column name|already exists/i.test(e.message)) {
      console.warn('[db migration]', e.message);
    }
  }
}

migrate('ALTER TABLE build_history ADD COLUMN context_url TEXT DEFAULT ""');
migrate('ALTER TABLE build_history ADD COLUMN build_args TEXT DEFAULT "{}"');
migrate('ALTER TABLE build_history ADD COLUMN nocache INTEGER DEFAULT 0');
migrate('ALTER TABLE build_history ADD COLUMN pull INTEGER DEFAULT 0');
migrate('ALTER TABLE notification_log ADD COLUMN channel TEXT DEFAULT "email"');
migrate('ALTER TABLE servers ADD COLUMN password TEXT');
migrate('ALTER TABLE servers ADD COLUMN passphrase TEXT'); // SSH key passphrase — support for encrypted private keys
migrate('ALTER TABLE activity ADD COLUMN server TEXT');     // audit: which host the action was performed on (multi-host context)
migrate('ALTER TABLE activity ADD COLUMN source_ip TEXT');  // audit: where from (the only "who" signal, since there's no auth)

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
migrate('CREATE INDEX IF NOT EXISTS idx_activity_resource ON activity (resource_id, resource_type)');
migrate('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity (created_at)');
migrate('CREATE INDEX IF NOT EXISTS idx_builds_started ON build_history (started_at)');
migrate('CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_log (created_at)');
migrate('CREATE INDEX IF NOT EXISTS idx_prov_runs_server ON provision_runs (server_id, started_at)');
migrate('CREATE INDEX IF NOT EXISTS idx_prov_items_run ON provision_items (run_id)');
migrate('CREATE INDEX IF NOT EXISTS idx_prov_items_server_item ON provision_items (server_id, item_id, id)');
migrate('CREATE INDEX IF NOT EXISTS idx_host_metrics_server ON host_metrics (server_id, id)');
// Retention — keep the last 200 provision runs; drop items whose run was trimmed
migrate('DELETE FROM provision_runs WHERE id NOT IN (SELECT id FROM provision_runs ORDER BY started_at DESC LIMIT 200)');
migrate('DELETE FROM provision_items WHERE run_id NOT IN (SELECT id FROM provision_runs)');

// Retention — keep only last 1000 activity records and 100 builds
// Saxlama — yalnız son 1000 fəaliyyət qeydi və 100 build saxla
migrate('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY created_at DESC LIMIT 1000)');
migrate('DELETE FROM build_history WHERE id NOT IN (SELECT id FROM build_history ORDER BY started_at DESC LIMIT 100)');

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
  timezone: 'auto', // display timezone — 'auto' = browser/host; otherwise an IANA zone (e.g. Asia/Baku)
  active_server: 'local',
  // App Templates catalog source. Empty = the default community catalog (500+ apps, auto-loaded by
  // the backend); a URL = custom catalog; the sentinel 'bundled' = the offline ~15 set only.
  template_url: '',
  // Auth: first-run setup writes auth_password_hash + auth_salt into settings; this flag gates the setup screen.
  admin_setup_done: 'false',
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
  // Audit — with server + source_ip (used by logAction() in server/audit.js)
  logActivityFull: db.prepare('INSERT INTO activity (resource_id, resource_type, resource_name, action, details, server, source_ip) VALUES (?, ?, ?, ?, ?, ?, ?)'),
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
  insertServer: db.prepare('INSERT INTO servers (id, type, host, port, username, key_path, password, passphrase, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateServer: db.prepare('UPDATE servers SET host = ?, port = ?, username = ?, key_path = ?, password = ?, passphrase = ?, description = ? WHERE id = ?'),
  deleteServer: db.prepare('DELETE FROM servers WHERE id = ?'),

  // Registries (private image registry credentials — used to authenticate pull/push)
  getRegistries: db.prepare('SELECT * FROM registries ORDER BY server_address'),
  getRegistry: db.prepare('SELECT * FROM registries WHERE id = ?'),
  getRegistryByHost: db.prepare('SELECT * FROM registries WHERE server_address = ?'),
  insertRegistry: db.prepare('INSERT INTO registries (name, server_address, username, password) VALUES (?, ?, ?, ?)'),
  updateRegistry: db.prepare('UPDATE registries SET name = ?, server_address = ?, username = ?, password = ? WHERE id = ?'),
  deleteRegistry: db.prepare('DELETE FROM registries WHERE id = ?'),

  // Provisioning runs + items (server-setup history)
  insertProvisionRun: db.prepare('INSERT INTO provision_runs (id, server_id, preset, distro, status, item_total, source_ip) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateProvisionRunStatus: db.prepare('UPDATE provision_runs SET status = ?, item_ok = ?, item_failed = ?, error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?'),
  appendProvisionRunLog: db.prepare('UPDATE provision_runs SET log = log || ? WHERE id = ?'),
  getProvisionRuns: db.prepare('SELECT id, server_id, preset, distro, status, item_total, item_ok, item_failed, started_at, finished_at FROM provision_runs WHERE server_id = ? ORDER BY started_at DESC LIMIT ?'),
  getProvisionRun: db.prepare('SELECT * FROM provision_runs WHERE id = ?'),
  insertProvisionItem: db.prepare('INSERT INTO provision_items (run_id, server_id, item_id, seq, label, state, detect_cmd, install_cmd, verify_cmd, log, duration_ms, error, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getProvisionItems: db.prepare('SELECT * FROM provision_items WHERE run_id = ? ORDER BY seq'),
  // Matrix — the latest recorded state of each item_id for a server (newest row per item).
  getLatestItemsPerServer: db.prepare('SELECT pi.* FROM provision_items pi WHERE pi.server_id = ? AND pi.id = (SELECT MAX(pi2.id) FROM provision_items pi2 WHERE pi2.server_id = pi.server_id AND pi2.item_id = pi.item_id)'),
  trimProvisionRuns: db.prepare('DELETE FROM provision_runs WHERE id NOT IN (SELECT id FROM provision_runs ORDER BY started_at DESC LIMIT 200)'),

  // Host metrics (time-series — opportunistic samples taken whenever /host/stats is fetched)
  insertHostMetric: db.prepare('INSERT INTO host_metrics (server_id, cpu, mem_pct, disk_pct, swap_pct, load1, net_rx, net_tx, procs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getHostMetrics: db.prepare('SELECT ts, cpu, mem_pct, disk_pct, swap_pct, load1, net_rx, net_tx, procs FROM host_metrics WHERE server_id = ? ORDER BY id DESC LIMIT ?'),
  trimHostMetrics: db.prepare('DELETE FROM host_metrics WHERE server_id = ? AND id NOT IN (SELECT id FROM host_metrics WHERE server_id = ? ORDER BY id DESC LIMIT ?)'),
  deleteHostMetrics: db.prepare('DELETE FROM host_metrics WHERE server_id = ?'),

  // Per-server notification-channel overrides (edge notifier agent). Secrets encrypted at rest.
  getServerChannel: db.prepare('SELECT * FROM server_channels WHERE server_id = ?'),
  upsertServerChannel: db.prepare(`INSERT INTO server_channels (server_id, tg_token, tg_chat_id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_to, updated_at)
    VALUES (@server_id, @tg_token, @tg_chat_id, @smtp_host, @smtp_port, @smtp_user, @smtp_pass, @smtp_from, @smtp_to, CURRENT_TIMESTAMP)
    ON CONFLICT(server_id) DO UPDATE SET tg_token=@tg_token, tg_chat_id=@tg_chat_id, smtp_host=@smtp_host, smtp_port=@smtp_port, smtp_user=@smtp_user, smtp_pass=@smtp_pass, smtp_from=@smtp_from, smtp_to=@smtp_to, updated_at=CURRENT_TIMESTAMP`),
  deleteServerChannel: db.prepare('DELETE FROM server_channels WHERE server_id = ?'),

  // Edge-notifier deploy jobs (install / update / remove / install-all) — re-openable progress.
  insertAgentJob: db.prepare('INSERT INTO agent_jobs (id, kind, server_id, status, total, source_ip) VALUES (?, ?, ?, ?, ?, ?)'),
  updateAgentJobProgress: db.prepare('UPDATE agent_jobs SET ok = ?, failed = ?, phase = ? WHERE id = ?'),
  finishAgentJob: db.prepare('UPDATE agent_jobs SET status = ?, ok = ?, failed = ?, error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?'),
  setAgentJobServers: db.prepare('UPDATE agent_jobs SET servers = ? WHERE id = ?'),
  appendAgentJobLog: db.prepare('UPDATE agent_jobs SET log = log || ? WHERE id = ?'),
  getAgentJob: db.prepare('SELECT * FROM agent_jobs WHERE id = ?'),
  getAgentJobs: db.prepare('SELECT id, kind, server_id, status, total, ok, failed, started_at, finished_at FROM agent_jobs ORDER BY started_at DESC LIMIT ?'),
  trimAgentJobs: db.prepare('DELETE FROM agent_jobs WHERE id NOT IN (SELECT id FROM agent_jobs ORDER BY started_at DESC LIMIT 200)'),
};

// One-time at-rest encryption of stored secrets (idempotent — already-encrypted rows are skipped, so
// this is safe to run on every boot). Late require to avoid load-order coupling.
try {
  const { encrypt, isEncrypted } = require('./auth/secrets');
  const updS = db.prepare('UPDATE servers SET password = ?, passphrase = ? WHERE id = ?');
  for (const s of db.prepare('SELECT id, password, passphrase FROM servers').all()) {
    if ((s.password && !isEncrypted(s.password)) || (s.passphrase && !isEncrypted(s.passphrase))) {
      updS.run(s.password ? encrypt(s.password) : s.password, s.passphrase ? encrypt(s.passphrase) : s.passphrase, s.id);
    }
  }
  const updR = db.prepare('UPDATE registries SET password = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, password FROM registries').all()) {
    if (r.password && !isEncrypted(r.password)) updR.run(encrypt(r.password), r.id);
  }
  // smtp_config: encrypt the two secret keys (Telegram bot token + SMTP password) at rest.
  const updCfg = db.prepare('UPDATE smtp_config SET value = ? WHERE key = ?');
  for (const row of db.prepare("SELECT key, value FROM smtp_config WHERE key IN ('tg_token','smtp_pass')").all()) {
    if (row.value && !isEncrypted(row.value)) updCfg.run(encrypt(row.value), row.key);
  }
  // server_channels: encrypt per-server secret overrides (token + smtp password).
  const updSc = db.prepare('UPDATE server_channels SET tg_token = ?, smtp_pass = ? WHERE server_id = ?');
  for (const sc of db.prepare('SELECT server_id, tg_token, smtp_pass FROM server_channels').all()) {
    if ((sc.tg_token && !isEncrypted(sc.tg_token)) || (sc.smtp_pass && !isEncrypted(sc.smtp_pass))) {
      updSc.run(sc.tg_token ? encrypt(sc.tg_token) : sc.tg_token, sc.smtp_pass ? encrypt(sc.smtp_pass) : sc.smtp_pass, sc.server_id);
    }
  }
} catch (e) { console.warn('[db] secret encryption migration failed:', e.message); }

module.exports = { db, stmts };
