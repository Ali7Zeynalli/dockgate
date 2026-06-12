// File manager API (Phase 2) — operates on the ACTIVE server (from the header). Remote SSH host → SFTP.
// Local is not handled here (Phase 3, deferred); it returns a clear "switch to a remote server" message.
const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const fm = require('../file-manager');

// Resolve the active REMOTE server, or write the appropriate 400/404 and return null.
function activeRemote(res) {
  const id = dockerService.getActiveServerId();
  if (id === 'local') { res.status(400).json({ error: 'The file manager works on a remote SSH server. Switch to one in the header (Local host browsing is not enabled).' }); return null; }
  const s = stmts.getServer.get(id);
  if (!s) { res.status(404).json({ error: 'Active server not found' }); return null; }
  return { id, s };
}

// Whether the active server is a remote SSH host (used by the UI to show/hide the manager).
router.get('/context', (req, res) => {
  const id = dockerService.getActiveServerId();
  if (id === 'local') return res.json({ remote: false });
  const s = stmts.getServer.get(id);
  res.json({ remote: !!s, serverId: id, host: s ? s.host : null });
});

router.get('/', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await fm.listDir(a.s, req.query.path || '/')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/download', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    logAction({ req, server: a.id, resourceType: 'file', resourceName: req.query.path || '', action: 'download' });
    await fm.downloadTo(a.s, req.query.path || '', res);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end(); }
});

// Raw-body upload (Content-Type: application/octet-stream) → not JSON-parsed by express.json.
router.post('/upload', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: dir, name } = req.query;
    if (!dir || !name) return res.status(400).json({ error: 'path (dir) and name are required' });
    const r = await fm.uploadFrom(a.s, dir, name, req);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'upload' });
    res.json({ success: true, path: r.path });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/mkdir', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: dir, name } = req.body || {};
    const r = await fm.mkdir(a.s, dir, name);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'mkdir' });
    res.json({ success: true, path: r.path });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/rename', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });
    const r = await fm.rename(a.s, oldPath, newPath);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.to, action: 'rename', details: { from: r.from } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const isDir = req.query.isDir === '1' || req.query.isDir === 'true';
    const r = await fm.remove(a.s, req.query.path || '', isDir);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'delete', details: { isDir } });
    res.json({ success: true, path: r.path });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
