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

// Whether the active server is a remote SSH host (used by the UI to show/hide the manager + folder picker).
router.get('/context', async (req, res) => {
  const id = dockerService.getActiveServerId();
  if (id === 'local') return res.json({ remote: false });
  const s = stmts.getServer.get(id);
  if (!s) return res.json({ remote: false });
  let home = '/';
  try { home = await fm.homeDir(s); } catch (e) {}
  res.json({ remote: true, serverId: id, host: s.host, home });
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
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const r = (isDir && recursive) ? await fm.removeRecursive(a.s, req.query.path || '') : await fm.remove(a.s, req.query.path || '', isDir);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'delete', details: { isDir, recursive } });
    res.json({ success: true, path: r.path });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Read a file as text for the in-browser editor (binary/oversized → metadata only).
router.get('/read', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await fm.readFileText(a.s, req.query.path || '')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Save edited text back to a file (create/overwrite).
router.post('/write', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, content } = req.body || {};
    if (!p) return res.status(400).json({ error: 'path is required' });
    await fm.writeFileText(a.s, p, content == null ? '' : content);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: p, action: 'edit' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Copy a file/folder into destDir (auto-suffixes "-copy" when pasted into its own directory).
router.post('/copy', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return res.status(400).json({ error: 'src and destDir are required' });
    const base = String(src).split('/').filter(Boolean).pop();
    let dest = fm.joinRemote(destDir, base);
    if (dest === fm.normRemote(src)) { const m = base.match(/^(.*?)(\.[^.]+)?$/); dest = fm.joinRemote(destDir, (m[1] || base) + '-copy' + (m[2] || '')); }
    const r = await fm.copy(a.s, src, dest);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.to, action: 'copy', details: { from: r.from } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Move a file/folder into destDir.
router.post('/move', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return res.status(400).json({ error: 'src and destDir are required' });
    const base = String(src).split('/').filter(Boolean).pop();
    const dest = fm.joinRemote(destDir, base);
    const r = await fm.move(a.s, src, dest);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.to, action: 'move', details: { from: r.from } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Download a whole folder as a streamed .tar.gz.
router.get('/download-folder', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    logAction({ req, server: a.id, resourceType: 'file', resourceName: req.query.path || '', action: 'download' });
    await fm.archiveDirTo(a.s, req.query.path || '', res);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end(); }
});

module.exports = router;
