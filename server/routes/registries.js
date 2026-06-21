const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const { encrypt, decrypt } = require('../auth/secrets');
const registryBrowse = require('../registry-browse');

/**
 * Shape a registry row for the API — the stored password is NEVER returned, only whether one exists.
 * @param {object} r registries table row
 */
function maskRegistry(r) {
  return {
    id: r.id,
    name: r.name,
    server_address: r.server_address,
    username: r.username,
    hasPassword: !!r.password,
    created_at: r.created_at,
    last_test_status: r.last_test_status || null, // 'ok' | 'fail' | null — for the status pill
    last_test_at: r.last_test_at || null,
  };
}

// GET / — list all stored registry credentials (passwords masked) + per-registry tracked-repo counts
router.get('/', (req, res) => {
  try {
    const counts = {};
    for (const c of stmts.countTrackedByRegistry.all()) counts[c.registry_id] = c.n;
    res.json(stmts.getRegistries.all().map(r => ({ ...maskRegistry(r), trackedRepos: counts[r.id] || 0 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — add a registry credential
// body: { name?, serverAddress, username, password }
router.post('/', (req, res) => {
  try {
    const { name, serverAddress, username, password } = req.body || {};
    if (!serverAddress) return res.status(400).json({ error: 'serverAddress is required' });
    if (!username) return res.status(400).json({ error: 'username is required' });
    if (!password) return res.status(400).json({ error: 'password is required' });
    if (stmts.getRegistryByHost.get(serverAddress)) {
      return res.status(409).json({ error: `A credential for "${serverAddress}" already exists` });
    }
    const info = stmts.insertRegistry.run(name || serverAddress, serverAddress, username, encrypt(String(password)));
    logAction({ req, server: 'local', resourceType: 'registry', resourceName: serverAddress, action: 'add', details: { username } });
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id — edit an existing credential. An omitted/empty password keeps the current one.
// body: { name?, serverAddress?, username?, password? }
router.put('/:id', (req, res) => {
  try {
    const existing = stmts.getRegistry.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Registry not found' });

    const { name, serverAddress, username, password } = req.body || {};
    const newAddr = serverAddress !== undefined ? serverAddress : existing.server_address;

    // server_address is UNIQUE — block colliding with a different row
    const clash = stmts.getRegistryByHost.get(newAddr);
    if (clash && String(clash.id) !== String(existing.id)) {
      return res.status(409).json({ error: `A credential for "${newAddr}" already exists` });
    }

    const newName = name !== undefined ? name : existing.name;
    const newUser = username !== undefined ? username : existing.username;
    // undefined or empty string = keep existing password; non-empty = update
    const newPass = (password !== undefined && password !== '') ? String(password) : existing.password;

    stmts.updateRegistry.run(newName, newAddr, newUser, encrypt(newPass), existing.id);
    logAction({ req, server: 'local', resourceType: 'registry', resourceName: newAddr, action: 'edit', details: { username: newUser } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  try {
    const existing = stmts.getRegistry.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Registry not found' });
    stmts.deleteTrackedReposByRegistry.run(req.params.id); // cascade: drop this registry's tracked repos
    stmts.deleteRegistry.run(req.params.id);
    logAction({ req, server: 'local', resourceType: 'registry', resourceName: existing.server_address, action: 'remove' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /test — verify credentials against the registry without persisting.
// body: { serverAddress, username, password }  OR  { id } to test a stored credential
router.post('/test', async (req, res) => {
  try {
    let { serverAddress, username, password, id } = req.body || {};
    if (id) {
      const reg = stmts.getRegistry.get(id);
      if (!reg) return res.status(404).json({ error: 'Registry not found' });
      serverAddress = reg.server_address;
      username = reg.username;
      password = decrypt(reg.password);
    }
    if (!serverAddress || !username || !password) {
      return res.status(400).json({ error: 'serverAddress, username and password are required' });
    }
    const data = await dockerService.checkRegistryAuth({ serveraddress: serverAddress, username, password });
    if (id) try { stmts.updateRegistryTest.run('ok', id); } catch (e) {} // cache the result for the status pill
    logAction({ req, server: 'local', resourceType: 'registry', resourceName: serverAddress, action: 'test', details: { username, result: 'success' } });
    res.json({ success: true, status: data.Status || 'Login Succeeded' });
  } catch (err) {
    // The Docker daemon wraps a registry 401 as its own HTTP 500 whose message still mentions the
    // underlying status. Detect an auth failure from either the code or the message and surface 401,
    // so the UI can tell "wrong credentials" apart from "registry unreachable" (genuine 500).
    const m = (err.message || '').toLowerCase();
    const isAuthFail = err.statusCode === 401
      || /\b401\b|unauthorized|incorrect username or password|authentication required/.test(m);
    if ((req.body || {}).id) try { stmts.updateRegistryTest.run('fail', (req.body).id); } catch (e) {}
    logAction({ req, server: 'local', resourceType: 'registry', resourceName: (req.body || {}).serverAddress || '', action: 'test', details: { result: isAuthFail ? 'auth-failed' : 'error' } });
    res.status(isAuthFail ? 401 : 500).json({ error: err.message });
  }
});

// ── Browse / Inventory ─────────────────────────────────────────────────────────────────────────────
// Tracked repositories per registry. These are populated automatically when an image is pushed
// (see the image:push handler) and manually pinned here. Repo names only — no secrets stored.

// GET /:id/repos — the repos tracked under this registry (with last-pushed time).
router.get('/:id/repos', (req, res) => {
  try {
    if (!stmts.getRegistry.get(req.params.id)) return res.status(404).json({ error: 'Registry not found' });
    res.json(stmts.getTrackedRepos.all(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/repos { repo } — pin a repository to track (e.g. "owner/app").
router.post('/:id/repos', (req, res) => {
  try {
    if (!stmts.getRegistry.get(req.params.id)) return res.status(404).json({ error: 'Registry not found' });
    const repo = String((req.body || {}).repo || '').trim().replace(/^\/+|\/+$/g, '');
    if (!repo) return res.status(400).json({ error: 'repo is required' });
    stmts.insertTrackedRepo.run(req.params.id, repo, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id/repos?repo=owner/app — untrack a repository (repo in the query, since DELETE has no body).
router.delete('/:id/repos', (req, res) => {
  try {
    const repo = String(req.query.repo || (req.body || {}).repo || '').trim();
    if (!repo) return res.status(400).json({ error: 'repo is required' });
    stmts.deleteTrackedRepo.run(req.params.id, repo);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/tags?repo=owner/app — list a repo's tags via the registry v2 API (token-dance auth).
router.get('/:id/tags', async (req, res) => {
  try {
    const reg = stmts.getRegistry.get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registry not found' });
    const repo = String(req.query.repo || '').trim().replace(/^\/+|\/+$/g, '');
    if (!repo) return res.status(400).json({ error: 'repo query param is required' });
    const tags = await registryBrowse.listTags(reg, repo);
    res.json({ repo, tags });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /:id/manifest?repo=owner/app&ref=tag — digest + size for one tag (lazy, on expand).
router.get('/:id/manifest', async (req, res) => {
  try {
    const reg = stmts.getRegistry.get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registry not found' });
    const repo = String(req.query.repo || '').trim().replace(/^\/+|\/+$/g, '');
    const ref = String(req.query.ref || '').trim();
    if (!repo || !ref) return res.status(400).json({ error: 'repo and ref are required' });
    const info = await registryBrowse.getManifestInfo(reg, repo, ref);
    res.json(info);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
