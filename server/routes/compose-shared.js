// Shared helpers for the compose routes (compose.js, compose-files.js): where DockGate keeps managed
// projects, safe path handling, and the pointer file of a project deployed to a remote server.
const fs = require('fs');
const path = require('path');
const dockerService = require('../docker');
const remoteCompose = require('../remote-compose');

// Respects DATA_DIR (same as db.js) so tests/custom deploys use an isolated location.
const COMPOSE_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'compose');

// Validate compose project name — only safe characters (also prevents path traversal in COMPOSE_DIR)
function validateProjectName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

// Absolute path to a managed project's directory (project name already validated by caller)
function managedDir(project) {
  return path.join(COMPOSE_DIR, project);
}

// Sanitize an uploaded relative file path: drop leading slashes and any "../" so it can't escape the dir.
function safeRelPath(p) {
  const norm = path.normalize(String(p || '')).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
  if (norm === '.' || norm.includes('..')) return '';
  return norm;
}

// Standard compose filenames docker compose auto-detects.
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// The managed project's compose file — ANY of the standard names (.yml AND .yaml). A folder/git deploy
// may bring docker-compose.yaml, so nothing may hardcode docker-compose.yml.
function findComposeFile(dir) {
  return COMPOSE_FILENAMES.find(n => fs.existsSync(path.join(dir, n))) || null;
}

// Find ALL compose files in a staged tree (recursive, NAME-AGNOSTIC): any *.yml/*.yaml whose top level
// declares `services:`. Catches docker-compose.app.yml, stack.yml, infra/*.yml, etc. — not just the 4
// standard names. Returns POSIX-relative paths, shallowest first. Skips obvious junk dirs.
function findComposeFiles(dir) {
  const out = [];
  const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.dockgate']);
  const walk = (cur, rel) => {
    let entries; try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(cur, e.name), r); continue; }
      if (!/\.ya?ml$/i.test(e.name)) continue;
      try { if (/^services:/m.test(fs.readFileSync(path.join(cur, e.name), 'utf8').slice(0, 65536))) out.push(r); } catch (e2) { }
      if (out.length >= 50) return; // sanity cap
    }
  };
  walk(dir, '');
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return out;
}

// Local pointer for a REMOTE-deployed project: the files live on the remote, but DockGate remembers
// which server + folder so it can drive up/down/rebuild even when the project is fully down (no labels).
function deployMetaPath(project) { return path.join(managedDir(project), '.dockgate-deploy.json'); }
function readDeployMeta(project) { try { return JSON.parse(fs.readFileSync(deployMetaPath(project), 'utf8')); } catch (e) { return null; } }

// If the project lives on the active remote host (folder-deployed), return its SFTP context; else null.
// Used to make the Files browser read/write the REMOTE folder instead of DockGate's local pointer dir.
function remoteProjectCtx(project) {
  const meta = readDeployMeta(project);
  if (!meta || meta.mode !== 'remote' || meta.serverId !== dockerService.getActiveServerId()) return null;
  const server = remoteCompose.getActiveRemoteServer();
  if (!server) return null;
  return { server, remotePath: meta.remotePath, composeFile: meta.composeFile };
}
// Build a safe absolute remote path under the project's remote folder (traversal guard).
function safeRemoteProjectPath(remotePath, relPath) {
  const rel = safeRelPath(relPath);
  if (!rel || isProtectedProjectFile(rel)) return null;
  return remotePath.replace(/\/$/, '') + '/' + rel;
}
function writeDeployMeta(project, meta) {
  const d = managedDir(project);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(deployMetaPath(project), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

// Files that must never be read/written/deleted via the file API (token leak / git internals).
function isProtectedProjectFile(rel) {
  return rel === '.dockgate-git.json' || rel === '.dockgate-deploy.json' || rel === '.git' || rel.startsWith('.git/');
}

// Resolve a project-relative path to an absolute path INSIDE the managed dir, or null if it escapes
// (traversal or symlink). Used for read/write/delete of individual project files.
function safeProjectFile(project, relPath) {
  const dir = managedDir(project);
  const rel = safeRelPath(relPath);
  if (!rel || isProtectedProjectFile(rel)) return null;
  const abs = path.join(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  try { // symlink-escape guard (only meaningful for existing paths)
    const realDir = fs.realpathSync(dir);
    const real = fs.realpathSync(abs);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) return null;
  } catch (e) { /* path may not exist yet (new file) — prefix check above already guards */ }
  return abs;
}

// Treat a file as binary (non-editable) if it's large or contains a NUL byte in its head.
function isBinaryFile(abs, size) {
  if (size > 2 * 1024 * 1024) return true;
  try {
    const fd = fs.openSync(abs, 'r');
    const n = Math.min(size, 8000);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.includes(0);
  } catch (e) { return false; }
}


module.exports = {
  COMPOSE_DIR, COMPOSE_FILENAMES, validateProjectName, managedDir, safeRelPath, findComposeFile, findComposeFiles,
  deployMetaPath, readDeployMeta, writeDeployMeta, remoteProjectCtx, safeRemoteProjectPath,
  isProtectedProjectFile, safeProjectFile, isBinaryFile,
};
