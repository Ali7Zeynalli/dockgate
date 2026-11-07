// Compose project Files API — browse/edit ALL files of a managed project, not just the compose YAML
// (Dockerfile, .dockerignore, .env, configs…). Local projects live in COMPOSE_DIR/<project>/ on DockGate;
// a project deployed to a remote folder is browsed over SFTP. Mounted inside the compose router.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const dockerService = require('../docker');
const { logAction } = require('../audit');
const fileManager = require('../file-manager');
const {
  COMPOSE_FILENAMES, validateProjectName, managedDir, safeRelPath, findComposeFile,
  remoteProjectCtx, safeRemoteProjectPath, isProtectedProjectFile, safeProjectFile, isBinaryFile,
} = require('./compose-shared');

// GET file tree (flat, sorted). Remote folder-deployed project → browse the REMOTE folder over SFTP;
// otherwise the local managed dir. Skips .git internals + the git-secret file.
router.get('/:project/tree', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const files = (await fileManager.listTree(rc.server, rc.remotePath)).filter(f => !isProtectedProjectFile(f.path));
      return res.json({ project: req.params.project, files, composeFile: rc.composeFile, remote: true, remotePath: rc.remotePath });
    }
    const dir = managedDir(req.params.project);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No DockGate-managed files for this project' });
    const out = [];
    const walk = (cur, rel) => {
      for (const name of fs.readdirSync(cur).sort()) {
        const r = rel ? rel + '/' + name : name;
        if (isProtectedProjectFile(r)) continue;
        let st; try { st = fs.statSync(path.join(cur, name)); } catch (e) { continue; }
        if (st.isDirectory()) { out.push({ path: r, type: 'dir', size: 0 }); walk(path.join(cur, name), r); }
        else out.push({ path: r, type: 'file', size: st.size });
      }
    };
    walk(dir, '');
    res.json({ project: req.params.project, files: out, composeFile: findComposeFile(dir) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lazy, ONE-folder listing for the project Files browser (fast: a single readdir, no recursive walk).
// `sub` is a project-relative folder path (jailed). Mirrors the standalone File Manager's listDir speed.
router.get('/:project/dir', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const sub = (req.query.sub || '').toString();
    const relSub = sub ? safeRelPath(sub) : '';
    if (sub && !relSub) return res.status(400).json({ error: 'Invalid path' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = rc.remotePath.replace(/\/+$/, '') + (relSub ? '/' + relSub : '');
      const { entries } = await fileManager.listDir(rc.server, abs);
      const out = entries.filter(e => !isProtectedProjectFile(relSub ? relSub + '/' + e.name : e.name))
        .map(e => ({ name: e.name, type: e.type, size: e.size }));
      return res.json({ project: req.params.project, sub: relSub, entries: out, composeFile: rc.composeFile, remote: true });
    }
    const base = managedDir(req.params.project);
    if (!fs.existsSync(base)) return res.status(404).json({ error: 'No DockGate-managed files for this project' });
    const dir = relSub ? path.join(base, relSub) : base;
    if (dir !== base && !dir.startsWith(base + path.sep)) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(404).json({ error: 'Not a folder' });
    const out = fs.readdirSync(dir).map(name => {
      const rel = relSub ? relSub + '/' + name : name;
      if (isProtectedProjectFile(rel)) return null;
      let st; try { st = fs.statSync(path.join(dir, name)); } catch (e) { return null; }
      return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size };
    }).filter(Boolean).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));
    res.json({ project: req.params.project, sub: relSub, entries: out, composeFile: findComposeFile(base) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET a single file's content (text). Binary/oversized → metadata only. Remote project → SFTP read.
router.get('/:project/filecontent', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = safeRemoteProjectPath(rc.remotePath, req.query.path);
      if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
      const r = await fileManager.readFileText(rc.server, abs);
      return res.json({ path: req.query.path, ...r });
    }
    const abs = safeProjectFile(req.params.project, req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'File not found' });
    const size = fs.statSync(abs).size;
    if (isBinaryFile(abs, size)) return res.json({ path: req.query.path, isBinary: true, size });
    res.json({ path: req.query.path, isBinary: false, size, content: fs.readFileSync(abs, 'utf8') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT a single file's content (create or overwrite). Remote project → SFTP write.
router.put('/:project/filecontent', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const { path: rel, content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = safeRemoteProjectPath(rc.remotePath, rel);
      if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
      await fileManager.writeFileText(rc.server, abs, content);
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-edit', details: { file: safeRelPath(rel), remote: true } });
      return res.json({ success: true });
    }
    const abs = safeProjectFile(req.params.project, rel);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-edit', details: { file: safeRelPath(rel) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE a single project file (not the compose file, not protected). Remote project → SFTP unlink.
router.delete('/:project/filecontent', async (req, res) => {
  try {
    if (!validateProjectName(req.params.project)) return res.status(400).json({ error: 'Invalid project name' });
    const rel = safeRelPath(req.query.path);
    if (COMPOSE_FILENAMES.includes(rel)) return res.status(400).json({ error: 'Cannot delete the compose file itself' });
    const rc = remoteProjectCtx(req.params.project);
    if (rc) {
      const abs = safeRemoteProjectPath(rc.remotePath, req.query.path);
      if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
      await fileManager.remove(rc.server, abs, false);
      logAction({ req, server: dockerService.getActiveServerId(), resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-delete', details: { file: rel, remote: true } });
      return res.json({ success: true });
    }
    const abs = safeProjectFile(req.params.project, req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid or protected path' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not found' });
    fs.rmSync(abs, { recursive: true, force: true });
    logAction({ req, resourceId: req.params.project, resourceType: 'compose', resourceName: req.params.project, action: 'file-delete', details: { file: rel } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
