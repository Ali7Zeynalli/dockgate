// File manager API (Phase 2) — operates on the ACTIVE server (from the header). Remote SSH host → SFTP.
// Local: only the folders shared with DockGate under FILES_ROOT (/host), see file-manager-local.js.
const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const fm = require('../file-manager');

const fmLocal = require('../file-manager-local');

// The active server's file manager: SFTP for a remote server; for the local machine only the folders shared
// with DockGate under FILES_ROOT (/host) — see file-manager-local.js. Writes 400/404 and returns null otherwise.
function activeRemote(res) {
  const id = dockerService.getActiveServerId();
  if (id === 'local') {
    if (!fmLocal.available()) { res.status(400).json({ error: `No folder of this machine is shared with DockGate yet. Add one under the DockGate service's volumes (for example - /srv:${fmLocal.ROOT}/srv) and restart DockGate, or switch to a remote server.` }); return null; }
    return { id, s: { id: 'local' }, fm: fmLocal };
  }
  const s = stmts.getServer.get(id);
  if (!s) { res.status(404).json({ error: 'Active server not found' }); return null; }
  return { id, s, fm };
}

// What the Files page can show: remote (SFTP) or local (shared folders, or how to share one).
router.get('/context', async (req, res) => {
  const id = dockerService.getActiveServerId();
  if (id === 'local') return res.json({ remote: false, local: true, available: fmLocal.available(), root: fmLocal.ROOT, roots: fmLocal.roots(), home: fmLocal.ROOT });
  const s = stmts.getServer.get(id);
  if (!s) return res.json({ remote: false });
  let home = '/';
  try { home = await fm.homeDir(s); } catch (e) {}
  res.json({ remote: true, serverId: id, host: s.host, home });
});

router.get('/', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await a.fm.listDir(a.s, req.query.path || '/')); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.get('/download', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    logAction({ req, server: a.id, resourceType: 'file', resourceName: req.query.path || '', action: 'download' });
    await a.fm.downloadTo(a.s, req.query.path || '', res);
  } catch (err) { if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message }); else res.end(); }
});

// Raw-body upload (Content-Type: application/octet-stream) → not JSON-parsed by express.json.
router.post('/upload', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: dir, name } = req.query;
    if (!dir || !name) return res.status(400).json({ error: 'path (dir) and name are required' });
    const r = await a.fm.uploadFrom(a.s, dir, name, req);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'upload' });
    res.json({ success: true, path: r.path });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/mkdir', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: dir, name, ensure } = req.body || {};
    const r = await a.fm.mkdir(a.s, dir, name, { ensure: !!ensure });
    if (!r.existed) logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'mkdir' });
    res.json({ success: true, path: r.path, existed: !!r.existed });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/rename', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });
    const r = await a.fm.rename(a.s, oldPath, newPath);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.to, action: 'rename', details: { from: r.from } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.delete('/', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const isDir = req.query.isDir === '1' || req.query.isDir === 'true';
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const r = (isDir && recursive) ? await a.fm.removeRecursive(a.s, req.query.path || '') : await a.fm.remove(a.s, req.query.path || '', isDir);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'delete', details: { isDir, recursive } });
    res.json({ success: true, path: r.path });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Read a file as text for the in-browser editor (binary/oversized → metadata only).
router.get('/read', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await a.fm.readFileText(a.s, req.query.path || '')); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Save edited text back to a file (create/overwrite).
router.post('/write', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, content } = req.body || {};
    if (!p) return res.status(400).json({ error: 'path is required' });
    await a.fm.writeFileText(a.s, p, content == null ? '' : content);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: p, action: 'edit' });
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Copy a file/folder into destDir (auto-suffixes "-copy" when pasted into its own directory).
router.post('/copy', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return res.status(400).json({ error: 'src and destDir are required' });
    const base = String(src).split('/').filter(Boolean).pop();
    let dest = a.fm.joinRemote(destDir, base);
    if (dest === a.fm.normRemote(src)) { const m = base.match(/^(.*?)(\.[^.]+)?$/); dest = a.fm.joinRemote(destDir, (m[1] || base) + '-copy' + (m[2] || '')); }
    const r = await a.fm.copy(a.s, src, dest);
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
    const dest = a.fm.joinRemote(destDir, base);
    const r = await a.fm.move(a.s, src, dest);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.to, action: 'move', details: { from: r.from } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Download a whole folder as a streamed .tar.gz.
router.get('/download-folder', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    logAction({ req, server: a.id, resourceType: 'file', resourceName: req.query.path || '', action: 'download' });
    await a.fm.archiveDirTo(a.s, req.query.path || '', res);
  } catch (err) { if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message }); else res.end(); }
});

// Extract an archive (.zip/.tar/.tar.gz/.tar.bz2/.tar.xz/.gz) on the remote host.
// body: { path, here?, overwrite?, deleteAfter? }  (default: into a new subfolder named after the archive)
router.post('/extract', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, here, overwrite, deleteAfter } = req.body || {};
    if (!p) return res.status(400).json({ error: 'path is required' });
    const r = await a.fm.extract(a.s, p, { here: !!here, overwrite: !!overwrite, deleteAfter: !!deleteAfter });
    logAction({ req, server: a.id, resourceType: 'file', resourceName: r.path, action: 'extract', details: { archive: p } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

module.exports = router;
