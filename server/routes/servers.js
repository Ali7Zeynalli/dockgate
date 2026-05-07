/**
 * Servers route — SSH multi-host idarəetmə
 * Local + uzaq SSH server-lər arasında Docker daemon-larını idarə edir
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const dockerService = require('../docker');
const monitorManager = require('../notifications/monitor-manager');
const { stmts } = require('../db');

const SSH_KEYS_DIR = path.join(__dirname, '..', '..', 'data', 'ssh-keys');
if (!fs.existsSync(SSH_KEYS_DIR)) {
  fs.mkdirSync(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
}

// ID validate — yalnız təhlükəsiz simvollar
function validateId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// GET /api/servers — bütün server-lər (local + ssh)
router.get('/', (req, res) => {
  try {
    const sshServers = stmts.getServers.all();
    const activeId = stmts.getSetting.get('active_server')?.value || 'local';

    // Local həmişə vardır
    const list = [
      { id: 'local', type: 'local', description: 'Local Docker socket', isActive: activeId === 'local' },
      ...sshServers.map(s => ({
        id: s.id,
        type: s.type,
        host: s.host,
        port: s.port,
        username: s.username,
        description: s.description,
        hasKey: !!s.key_path,
        hasPassword: !!s.password,
        authMode: s.key_path ? 'key' : (s.password ? 'password' : 'agent'),
        created: s.created_at,
        isActive: activeId === s.id,
      })),
    ];

    res.json({ servers: list, activeId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers — yeni SSH server əlavə et
// body: { id, host, port, username, privateKey?, password?, description? }
// Auth iyerarxiyası: privateKey > password > SSH agent
router.post('/', (req, res) => {
  try {
    const { id, host, port = 22, username, privateKey, password, description = '' } = req.body || {};

    if (!validateId(id)) return res.status(400).json({ error: 'id: yalnız hərf, rəqəm, _, - (max 64)' });
    if (id === 'local') return res.status(400).json({ error: '"local" rezerv edilmiş id-dir' });
    if (!host) return res.status(400).json({ error: 'host tələb olunur' });
    if (!username) return res.status(400).json({ error: 'username tələb olunur' });

    if (stmts.getServer.get(id)) {
      return res.status(409).json({ error: `Server "${id}" artıq mövcuddur` });
    }

    let keyPath = null;
    if (privateKey) {
      const keyFile = `${id}.pem`;
      const fullPath = path.join(SSH_KEYS_DIR, keyFile);
      fs.writeFileSync(fullPath, privateKey, { mode: 0o600 });
      keyPath = keyFile;
    }

    // password — DB-də plain text saxlanılır (data/ volume host filesystem qoruması ilə)
    // DockGate self-hosted istifadə üçündür — auth UI tərəfində yox
    const pwdToStore = password ? String(password) : null;

    stmts.insertServer.run(id, 'ssh', host, parseInt(port) || 22, username, keyPath, pwdToStore, description);
    stmts.logActivity.run(id, 'server', id, 'add', JSON.stringify({ host, username, auth: keyPath ? 'key' : (pwdToStore ? 'password' : 'agent') }));

    // Start dedicated monitor so notifications from this host start flowing immediately
    monitorManager.startMonitor(id);

    res.json({
      success: true, id, host, port, username,
      hasKey: !!keyPath,
      hasPassword: !!pwdToStore,
      authMode: keyPath ? 'key' : (pwdToStore ? 'password' : 'agent'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/test — server-ə qoşulmanı yoxla (qeydiyyatdan əvvəl)
// body: { id?, type?, host?, port?, username?, privateKey?, password?, passphrase? }
router.post('/test', async (req, res) => {
  try {
    const { type = 'ssh', host, port = 22, username, privateKey, password, passphrase, id } = req.body || {};

    let serverConfig;
    if (type === 'local') {
      serverConfig = { type: 'local' };
    } else if (id && !privateKey && !password) {
      const existing = stmts.getServer.get(id);
      if (!existing) return res.status(404).json({ error: 'Server tapılmadı' });
      serverConfig = existing;
    } else {
      if (!host || !username) return res.status(400).json({ error: 'host və username tələb olunur' });

      let tempKeyPath = null;
      if (privateKey) {
        tempKeyPath = path.join(SSH_KEYS_DIR, `_test_${Date.now()}.pem`);
        fs.writeFileSync(tempKeyPath, privateKey, { mode: 0o600 });
      }

      try {
        serverConfig = {
          type: 'ssh', host, port: parseInt(port) || 22, username,
          key_path: tempKeyPath, passphrase,
          password: !privateKey && password ? password : undefined,
        };
        const result = await dockerService.testServerConnection(serverConfig);
        return res.json(result);
      } finally {
        if (tempKeyPath && fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
      }
    }

    const result = await dockerService.testServerConnection(serverConfig);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/servers/active — aktiv server dəyiş
// body: { id }
router.post('/active', async (req, res) => {
  try {
    const { id = 'local' } = req.body || {};
    const newId = dockerService.setActiveServer(id);
    stmts.logActivity.run('', 'server', id, 'switch', '');
    res.json({ success: true, activeId: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/servers/:id
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'local') return res.status(400).json({ error: 'local server silinə bilməz' });

    const server = stmts.getServer.get(id);
    if (!server) return res.status(404).json({ error: 'Server tapılmadı' });

    // Aktiv olan silinirsə — local-a keç
    const activeId = stmts.getSetting.get('active_server')?.value;
    if (activeId === id) {
      dockerService.setActiveServer('local');
    }

    // Key faylını sil
    if (server.key_path) {
      const keyFile = path.isAbsolute(server.key_path)
        ? server.key_path
        : path.join(SSH_KEYS_DIR, server.key_path);
      if (fs.existsSync(keyFile)) {
        try { fs.unlinkSync(keyFile); } catch(e) {}
      }
    }

    stmts.deleteServer.run(id);
    stmts.logActivity.run(id, 'server', id, 'delete', '');

    // Stop the dedicated monitor for this server
    monitorManager.stopMonitor(id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
