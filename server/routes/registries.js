const express = require('express');
const router = express.Router();
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');

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
  };
}

// GET / — list all stored registry credentials (passwords masked)
router.get('/', (req, res) => {
  try {
    res.json(stmts.getRegistries.all().map(maskRegistry));
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
    const info = stmts.insertRegistry.run(name || serverAddress, serverAddress, username, String(password));
    logAction({ req, resourceType: 'registry', resourceName: serverAddress, action: 'add', details: { username } });
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

    stmts.updateRegistry.run(newName, newAddr, newUser, newPass, existing.id);
    logAction({ req, resourceType: 'registry', resourceName: newAddr, action: 'edit', details: { username: newUser } });
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
    stmts.deleteRegistry.run(req.params.id);
    logAction({ req, resourceType: 'registry', resourceName: existing.server_address, action: 'remove' });
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
      password = reg.password;
    }
    if (!serverAddress || !username || !password) {
      return res.status(400).json({ error: 'serverAddress, username and password are required' });
    }
    const data = await dockerService.checkRegistryAuth({ serveraddress: serverAddress, username, password });
    res.json({ success: true, status: data.Status || 'Login Succeeded' });
  } catch (err) {
    // The Docker daemon wraps a registry 401 as its own HTTP 500 whose message still mentions the
    // underlying status. Detect an auth failure from either the code or the message and surface 401,
    // so the UI can tell "wrong credentials" apart from "registry unreachable" (genuine 500).
    const m = (err.message || '').toLowerCase();
    const isAuthFail = err.statusCode === 401
      || /\b401\b|unauthorized|incorrect username or password|authentication required/.test(m);
    res.status(isAuthFail ? 401 : 500).json({ error: err.message });
  }
});

module.exports = router;
