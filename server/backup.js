// DockGate's own backup: the database (servers, logins, keys' metadata, rules, audit…), the master key that
// decrypts the stored secrets, the SSH key files and — optionally — the compose folders DockGate manages.
//
// File format (.dgbackup): "DGBK1" | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(JSON bundle)), the key
// derived from the user's password with scrypt. Nightly copies kept inside the data folder use "DGBK0" +
// gzip without a password: they sit next to the data they copy, so a password would add nothing there.
//
// Restore never swaps files under a running database: the checked bundle is staged in restore-pending/ and
// applied by applyPending() when DockGate starts, before the database is opened. The current data is moved
// to backups/pre-restore-<time>/ first, so a restore can be undone by hand.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FORMAT = 'dockgate-backup';
const MAGIC_ENC = Buffer.from('DGBK1');
const MAGIC_PLAIN = Buffer.from('DGBK0');
const MAX_BYTES = 500 * 1024 * 1024;
const KEEP_AUTO = 7;

const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const backupsDir = () => path.join(dataDir(), 'backups');
const pendingDir = () => path.join(dataDir(), 'restore-pending');

function walk(root, rel = '', out = [], skip = () => false) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = path.posix.join(rel.split(path.sep).join('/'), e.name);
    if (skip(r, e)) continue;
    if (e.isDirectory()) walk(root, r, out, skip);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Build the bundle (a Buffer of gzipped JSON). */
async function createBundle({ includeCompose = true } = {}) {
  const { db } = require('./db');
  const dd = dataDir();
  const tmp = path.join(dd, `.backup-${process.pid}-${Date.now()}.db`);
  await db.backup(tmp); // consistent copy while DockGate keeps running
  const files = {};
  let total = 0;
  const add = (name, buf) => {
    total += buf.length;
    if (total > MAX_BYTES) throw Object.assign(new Error('The backup would be larger than 500 MB. Untick the compose files and try again.'), { statusCode: 413 });
    files[name] = buf.toString('base64');
  };
  try {
    add('docker-panel.db', fs.readFileSync(tmp));
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } }
  require('./auth/secrets').encrypt('init'); // makes sure the master key exists
  const keyFile = path.join(dd, '.master.key');
  if (fs.existsSync(keyFile)) add('.master.key', fs.readFileSync(keyFile));
  for (const f of walk(path.join(dd, 'ssh-keys'))) add('ssh-keys/' + f, fs.readFileSync(path.join(dd, 'ssh-keys', f)));
  if (includeCompose) {
    // .git folders are left out: a Git stack is cloned again on its next sync.
    for (const f of walk(path.join(dd, 'compose'), '', [], (r, e) => e.isDirectory() && (e.name === '.git' || e.name === 'node_modules'))) add('compose/' + f, fs.readFileSync(path.join(dd, 'compose', f)));
  }
  const version = require('../package.json').version;
  const json = JSON.stringify({ format: FORMAT, version, created: new Date().toISOString(), envMasterKey: !!process.env.DG_MASTER_KEY, includeCompose, files });
  return zlib.gzipSync(Buffer.from(json), { level: 6 });
}

function seal(gz, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC_ENC, salt, iv, c.getAuthTag(), ct]);
}

/** Read a .dgbackup (encrypted, needs the password) or a nightly copy (plain). Throws a readable error. */
function open(buf, password) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) throw Object.assign(new Error('This is not a DockGate backup file'), { statusCode: 400 });
  let gz;
  if (buf.subarray(0, 5).equals(MAGIC_PLAIN)) gz = buf.subarray(5);
  else if (buf.subarray(0, 5).equals(MAGIC_ENC)) {
    if (!password) throw Object.assign(new Error('Enter the password of the backup file'), { statusCode: 400 });
    const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49), ct = buf.subarray(49);
    const key = crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try { const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); gz = Buffer.concat([d.update(ct), d.final()]); }
    catch (e) { throw Object.assign(new Error('Wrong password, or the file is damaged'), { statusCode: 400 }); }
  } else throw Object.assign(new Error('This is not a DockGate backup file'), { statusCode: 400 });
  let b;
  try { b = JSON.parse(zlib.gunzipSync(gz).toString('utf8')); } catch (e) { throw Object.assign(new Error('The backup file is damaged'), { statusCode: 400 }); }
  if (!b || b.format !== FORMAT || !b.files || !b.files['docker-panel.db']) throw Object.assign(new Error('The backup file has no DockGate database in it'), { statusCode: 400 });
  for (const name of Object.keys(b.files)) {
    const n = path.posix.normalize(name);
    if (n !== name || n.startsWith('..') || path.posix.isAbsolute(n) || !/^(docker-panel\.db|\.master\.key|ssh-keys\/|compose\/)/.test(n)) throw Object.assign(new Error(`Unexpected file in the backup: ${name}`), { statusCode: 400 });
  }
  return b;
}

/** What a bundle holds, for the confirmation dialog. */
function summary(b) {
  const names = Object.keys(b.files);
  return { version: b.version, created: b.created, includeCompose: !!b.includeCompose, sshKeys: names.filter(n => n.startsWith('ssh-keys/')).length,
    composeFiles: names.filter(n => n.startsWith('compose/')).length, envMasterKey: !!b.envMasterKey };
}

/** Put a checked bundle in restore-pending/; applied on the next start. */
function stage(b) {
  const pd = pendingDir();
  fs.rmSync(pd, { recursive: true, force: true });
  fs.mkdirSync(pd, { recursive: true, mode: 0o700 });
  for (const [name, b64] of Object.entries(b.files)) {
    const fp = path.join(pd, ...name.split('/'));
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fp, Buffer.from(b64, 'base64'), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(pd, '.restore.json'), JSON.stringify({ created: b.created, version: b.version, includeCompose: !!b.includeCompose, stagedAt: new Date().toISOString() }));
}

/** Called before the database opens. Moves the current data aside and puts the staged backup in place. */
function applyPending(dir = dataDir()) {
  const pd = path.join(dir, 'restore-pending');
  const meta = path.join(pd, '.restore.json');
  if (!fs.existsSync(meta)) return null;
  const info = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const keep = path.join(dir, 'backups', `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
  const move = (name) => { const src = path.join(dir, name); if (fs.existsSync(src)) fs.renameSync(src, path.join(keep, name)); };
  ['docker-panel.db', 'docker-panel.db-wal', 'docker-panel.db-shm', '.master.key', 'ssh-keys'].forEach(move);
  if (info.includeCompose) move('compose');
  for (const name of fs.readdirSync(pd)) {
    if (name === '.restore.json') continue;
    fs.renameSync(path.join(pd, name), path.join(dir, name));
  }
  fs.rmSync(pd, { recursive: true, force: true });
  console.log(`[backup] restored the backup from ${info.created} (previous data kept in ${keep})`);
  return { ...info, keptIn: keep };
}

/** Nightly copy inside the data folder; the newest KEEP_AUTO are kept. */
async function autoBackup() {
  fs.mkdirSync(backupsDir(), { recursive: true, mode: 0o700 });
  const gz = await createBundle({ includeCompose: true }).catch(async (e) => (e.statusCode === 413 ? createBundle({ includeCompose: false }) : Promise.reject(e)));
  const name = `auto-${new Date().toISOString().slice(0, 10)}.dgbak`;
  fs.writeFileSync(path.join(backupsDir(), name), Buffer.concat([MAGIC_PLAIN, gz]), { mode: 0o600 });
  const autos = listAuto();
  for (const old of autos.slice(KEEP_AUTO)) fs.unlinkSync(path.join(backupsDir(), old.name));
  return name;
}
function listAuto() {
  if (!fs.existsSync(backupsDir())) return [];
  return fs.readdirSync(backupsDir()).filter(n => /^auto-\d{4}-\d{2}-\d{2}\.dgbak$/.test(n))
    .map(n => { const st = fs.statSync(path.join(backupsDir(), n)); return { name: n, size: st.size, at: st.mtimeMs }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}
function readAuto(name) {
  if (!/^auto-\d{4}-\d{2}-\d{2}\.dgbak$/.test(name)) throw Object.assign(new Error('No such copy'), { statusCode: 404 });
  const fp = path.join(backupsDir(), name);
  if (!fs.existsSync(fp)) throw Object.assign(new Error('No such copy'), { statusCode: 404 });
  return fs.readFileSync(fp);
}

module.exports = { createBundle, seal, open, summary, stage, applyPending, autoBackup, listAuto, readAuto, MAGIC_PLAIN, KEEP_AUTO };
