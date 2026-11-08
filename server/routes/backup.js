// /api/backup — DockGate's own backup (server/backup.js): download an encrypted file, list the nightly
// copies, and restore from a file or a copy. Restoring stages the backup and restarts DockGate when Docker
// restarts it by itself; otherwise the user restarts the container to finish.
const express = require('express');
const router = express.Router();
const B = require('../backup');
const { logAction } = require('../audit');

const raw = express.raw({ type: 'application/octet-stream', limit: '600mb' });
const fail = (res, e) => res.status(e.statusCode || 500).json({ error: e.message });

async function willRestartItself() {
  try { return !!(await require('../docker').getAutoStartStatus()); } catch (e) { return false; }
}

router.get('/', async (req, res) => {
  try { res.json({ auto: B.listAuto(), keep: B.KEEP_AUTO, restartsItself: await willRestartItself(), envMasterKey: !!process.env.DG_MASTER_KEY }); }
  catch (e) { fail(res, e); }
});

// POST /api/backup/download { password, includeCompose } → the encrypted .dgbackup file.
router.post('/download', async (req, res) => {
  try {
    const { password, includeCompose = true } = req.body || {};
    if (!password || String(password).length < 12) return res.status(400).json({ error: 'The password needs at least 12 characters' });
    const file = B.seal(await B.createBundle({ includeCompose: !!includeCompose }), password);
    logAction({ req, server: 'local', resourceType: 'system', resourceName: 'backup', action: 'backup_download', details: { bytes: file.length, includeCompose: !!includeCompose } });
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="dockgate-${new Date().toISOString().slice(0, 10)}.dgbackup"` });
    res.send(file);
  } catch (e) { fail(res, e); }
});

// POST /api/backup/auto/:name/download { password } → that nightly copy, encrypted with the password.
router.post('/auto/:name/download', (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 12) return res.status(400).json({ error: 'The password needs at least 12 characters' });
    const buf = B.readAuto(req.params.name);
    const file = B.seal(buf.subarray(B.MAGIC_PLAIN.length), password);
    logAction({ req, server: 'local', resourceType: 'system', resourceName: 'backup', action: 'backup_download', details: { copy: req.params.name } });
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="dockgate-${req.params.name.replace(/^auto-|\.dgbak$/g, '')}.dgbackup"` });
    res.send(file);
  } catch (e) { fail(res, e); }
});

// POST /api/backup/inspect (file body, X-Backup-Password) → what the file holds; nothing changes.
router.post('/inspect', raw, (req, res) => {
  try { res.json(B.summary(B.open(req.body, req.get('x-backup-password')))); }
  catch (e) { fail(res, e); }
});

async function finishRestore(req, res, bundle, from) {
  B.stage(bundle);
  logAction({ req, server: 'local', resourceType: 'system', resourceName: 'backup', action: 'backup_restore', details: { from, created: bundle.created } });
  const restarts = await willRestartItself();
  res.json({ staged: true, restarting: restarts, summary: B.summary(bundle) });
  // Docker brings DockGate back with the restored data (applied before the database opens).
  if (restarts && process.env.NODE_ENV !== 'test') setTimeout(() => process.exit(0), 800);
}

// POST /api/backup/restore?confirm=restore (file body, X-Backup-Password)
router.post('/restore', raw, async (req, res) => {
  try {
    if (req.query.confirm !== 'restore') return res.status(400).json({ error: 'Type restore to confirm' });
    await finishRestore(req, res, B.open(req.body, req.get('x-backup-password')), 'file');
  } catch (e) { fail(res, e); }
});

// POST /api/backup/auto/:name/restore { confirm: 'restore' }
router.post('/auto/:name/restore', async (req, res) => {
  try {
    if ((req.body || {}).confirm !== 'restore') return res.status(400).json({ error: 'Type restore to confirm' });
    await finishRestore(req, res, B.open(B.readAuto(req.params.name)), req.params.name);
  } catch (e) { fail(res, e); }
});

module.exports = router;
