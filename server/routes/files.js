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
// ?sudo=1 reads a file the SSH user may not (root-owned configs), with passwordless sudo.
router.get('/read', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await a.fm.readFileText(a.s, req.query.path || '', { sudo: req.query.sudo === '1' })); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message, code: err.code }); }
});

// Save edited text back to a file (create/overwrite).
// Save: the content the file had is kept as an earlier version (DockGate's database), then the file is written
// atomically. body: { path, content, sudo, baseMtime (when it was opened), force (save although it changed) }
router.post('/write', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, content, sudo, baseMtime, force } = req.body || {};
    if (!p) return res.status(400).json({ error: 'path is required' });
    const text = content == null ? '' : String(content);
    const before = await a.fm.readFileText(a.s, p, { sudo: !!sudo }).catch(() => null);
    const r = await a.fm.writeFileText(a.s, p, text, { sudo: !!sudo, baseMtime, force: !!force });
    let kept = false;
    if (before && !before.isBinary && typeof before.content === 'string' && before.content !== text) kept = require('../file-versions').save(a.id, a.fm.normRemote(p), before.content);
    const after = await a.fm.readFileText(a.s, p, { sudo: !!sudo }).catch(() => null);
    logAction({ req, server: a.id, resourceType: 'file', resourceName: p, action: sudo ? 'edit_sudo' : 'edit', details: { atomic: r && r.atomic, versionKept: kept } });
    res.json({ success: true, atomic: !!(r && r.atomic), versionKept: kept, mtime: after ? after.mtime : null });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message, code: err.code }); }
});

// Earlier versions of a file (kept on each save from the editor) and one of them.
router.get('/versions', (req, res) => {
  const a = activeRemote(res); if (!a) return;
  res.json(require('../file-versions').list(a.id, a.fm.normRemote(String(req.query.path || ''))));
});
router.get('/version', (req, res) => {
  const a = activeRemote(res); if (!a) return;
  const v = require('../file-versions').get(a.id, req.query.id);
  if (!v) return res.status(404).json({ error: 'That version is gone' });
  res.json(v);
});

// Places (Home, common folders that exist, Compose project folders), log tail, checks before / after a save.
const fx = require('../file-extras');
router.get('/places', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await fx.places(a)); } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});
router.get('/tail', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try { res.json(await fx.tail(a, String(req.query.path || ''), req.query.lines, { sudo: req.query.sudo === '1' })); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message, code: err.code }); }
});
// body { path, content, kind: 'compose' | 'nginx' } → { ok: true | false | null (tool missing), tool, output }
router.post('/check', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, content, kind } = req.body || {};
    if (kind === 'compose') return res.json(await fx.checkCompose(a, String(p || ''), content == null ? '' : String(content)));
    if (kind === 'nginx') return res.json(await fx.checkNginx(a));
    res.status(400).json({ error: 'kind: compose or nginx' });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// Permissions: chmod (mode, recursive, sudo) and chown (owner, group, recursive — with sudo on a remote server).
router.post('/chmod', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, mode, recursive, sudo } = req.body || {};
    const r = await a.fm.chmod(a.s, p, String(mode || ''), { recursive: !!recursive, sudo: !!sudo });
    logAction({ req, server: a.id, resourceType: 'file', resourceName: p, action: 'chmod', details: { mode, recursive: !!recursive, sudo: !!sudo } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message, code: err.code }); }
});
router.post('/chown', async (req, res) => {
  const a = activeRemote(res); if (!a) return;
  try {
    const { path: p, owner, group, recursive } = req.body || {};
    const r = await a.fm.chown(a.s, p, String(owner || '').trim(), group ? String(group).trim() : '', { recursive: !!recursive });
    logAction({ req, server: a.id, resourceType: 'file', resourceName: p, action: 'chown', details: { owner, group, recursive: !!recursive } });
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message, code: err.code }); }
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
