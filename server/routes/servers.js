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
const { logAction, ipFromReq } = require('../audit');
const { encrypt, decrypt } = require('../auth/secrets');
const catalog = require('../provision/catalog');
const provisionRunner = require('../provision/provision-runner');

const SSH_KEYS_DIR = path.join(__dirname, '..', '..', 'data', 'ssh-keys');
if (!fs.existsSync(SSH_KEYS_DIR)) {
  fs.mkdirSync(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
}

// ID validate — yalnız təhlükəsiz simvollar
function validateId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Stage-2 köməkçisi: serverə SSH ilə girib `sudo -n usermod -aG docker <user>` işlədir —
 * beləcə DockGate user-i docker socket-ə çata bilir. Passwordless sudo tələb olunur.
 * İZOLƏ child-process-də işləyir (grant-docker-worker.js): əsas serverdə eyni host-a açıq olan
 * EventMonitor ssh2 bağlantıları ilə konkurensiyada auth ilişirdi — ayrı proses bunu həll edir.
 * @param {object} server DB-dəki server sətri (host/port/username/key_path/password/passphrase)
 */
function grantDockerAccess(server) {
  const { execFile } = require('child_process');
  const keyPath = server.key_path
    ? (path.isAbsolute(server.key_path) ? server.key_path : path.join(SSH_KEYS_DIR, server.key_path))
    : null;
  const cfg = { host: server.host, port: server.port, username: server.username, keyPath, password: decrypt(server.password), passphrase: decrypt(server.passphrase) };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'grant-docker-worker.js'), JSON.stringify(cfg)], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'grant failed').toString().trim()));
      resolve({ success: true, already: /DG_ALREADY/.test(stdout || '') });
    });
  });
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
        hasPassphrase: !!s.passphrase,
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
// body: { id, host, port, username, privateKey?, passphrase?, password?, description? }
// Auth iyerarxiyası: privateKey > password > SSH agent
router.post('/', (req, res) => {
  try {
    const { id, host, port = 22, username, privateKey, passphrase, password, description = '' } = req.body || {};

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

    // password / passphrase — stored as plain text in the DB (protected by the data/ volume host filesystem)
    // DockGate self-hosted istifadə üçündür — auth UI tərəfində yox
    const pwdToStore = password ? String(password) : null;
    // passphrase only makes sense with key auth (to unlock an encrypted private key)
    const passphraseToStore = (privateKey && passphrase) ? String(passphrase) : null;

    stmts.insertServer.run(id, 'ssh', host, parseInt(port) || 22, username, keyPath, encrypt(pwdToStore), encrypt(passphraseToStore), description);
    logAction({ req, server: 'local', resourceId: id, resourceType: 'server', resourceName: id, action: 'add', details: { host, username, auth: keyPath ? 'key' : (pwdToStore ? 'password' : 'agent') } });

    // Start dedicated monitor so notifications from this host start flowing immediately
    monitorManager.startMonitor(id);

    res.json({
      success: true, id, host, port, username,
      hasKey: !!keyPath,
      hasPassword: !!pwdToStore,
      hasPassphrase: !!passphraseToStore,
      authMode: keyPath ? 'key' : (pwdToStore ? 'password' : 'agent'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/grant-docker — user-i remote-da docker qrupuna əlavə et (sudo usermod).
// Opt-in əməliyyat: SSH login işləməlidir, user-in passwordless sudo-su olmalıdır.
router.post('/:id/grant-docker', async (req, res) => {
  try {
    const server = stmts.getServer.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server tapılmadı' });
    const r = await grantDockerAccess(server);
    logAction({ req, server: 'local', resourceId: req.params.id, resourceType: 'server', resourceName: req.params.id, action: 'grant-docker', details: { user: server.username, already: !!r.already } });
    res.json({ success: true, already: !!r.already, message: r.already
      ? `"${server.username}" is already in the docker group — nothing to do.`
      : `"${server.username}" added to the docker group — re-test the connection.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/servers/:id — edit an existing SSH server
// body: { host?, port?, username?, privateKey?, passphrase?, password?, description? }
// Only the fields sent are changed (undefined = keep). An empty string for password/passphrase clears it.
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'local') return res.status(400).json({ error: 'the local server cannot be edited' });

    const existing = stmts.getServer.get(id);
    if (!existing) return res.status(404).json({ error: 'Server not found' });

    const { host, port, username, privateKey, passphrase, password, description } = req.body || {};

    const newHost = host !== undefined ? host : existing.host;
    const newPort = port !== undefined ? (parseInt(port) || 22) : existing.port;
    const newUsername = username !== undefined ? username : existing.username;
    const newDescription = description !== undefined ? description : existing.description;

    // Key — if a new privateKey is provided, write it to file; otherwise keep the existing one
    let keyPath = existing.key_path;
    if (privateKey) {
      const keyFile = `${id}.pem`;
      fs.writeFileSync(path.join(SSH_KEYS_DIR, keyFile), privateKey, { mode: 0o600 });
      keyPath = keyFile;
    }

    // undefined = leave unchanged, empty string = clear, non-empty = update
    const newPassword = password !== undefined ? (password ? String(password) : null) : existing.password;
    const newPassphrase = passphrase !== undefined ? (passphrase ? String(passphrase) : null) : existing.passphrase;

    stmts.updateServer.run(newHost, newPort, newUsername, keyPath, encrypt(newPassword), encrypt(newPassphrase), newDescription, id);
    logAction({ req, server: 'local', resourceId: id, resourceType: 'server', resourceName: id, action: 'edit', details: { host: newHost, username: newUsername } });

    // If this is the active server, rebuild the client (config changed)
    const activeId = stmts.getSetting.get('active_server')?.value;
    if (activeId === id) {
      try { dockerService.setActiveServer(id); } catch(e) { /* connection will be verified later */ }
    }

    // Restart the monitor with the new config (startMonitor calls stopMonitor internally)
    monitorManager.startMonitor(id);

    res.json({
      success: true, id,
      hasKey: !!keyPath,
      hasPassword: !!newPassword,
      hasPassphrase: !!newPassphrase,
      authMode: keyPath ? 'key' : (newPassword ? 'password' : 'agent'),
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
    logAction({ req, server: 'local', resourceId: id, resourceType: 'server', resourceName: id, action: 'switch' });
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
    logAction({ req, server: 'local', resourceId: id, resourceType: 'server', resourceName: id, action: 'delete' });

    // Stop the dedicated monitor for this server
    monitorManager.stopMonitor(id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PROVISIONING ============
function resolveKeyPath(server) {
  if (!server.key_path) return null;
  return path.isAbsolute(server.key_path) ? server.key_path : path.join(SSH_KEYS_DIR, server.key_path);
}

// GET /api/servers/provision/catalog — read-only reference (explainer + custom checklist).
router.get('/provision/catalog', (req, res) => {
  res.json({
    presets: catalog.PRESETS,
    items: catalog.ITEMS.map(i => ({
      id: i.id, seq: i.seq, label: i.label, description: i.description, group: i.group,
      risk: i.risk, requiresKey: !!i.requiresKey, dependsOn: i.dependsOn || [],
      distros: Object.keys(i.distro), commands: i.distro.debian || null,
    })),
  });
});

// GET /api/servers/provision/job/:id — live job poll (in-memory; finished jobs fall out after TTL).
router.get('/provision/job/:id', (req, res) => {
  const job = provisionRunner.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have finished — see run history)' });
  res.json({ id: job.id, serverId: job.serverId, status: job.status, phase: job.phase, distro: job.distro, log: job.log, items: job.items, error: job.error });
});

// GET /api/servers/provision/runs/:runId — one run + its items (re-openable after the job is gone).
router.get('/provision/runs/:runId', (req, res) => {
  try {
    const run = stmts.getProvisionRun.get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ run, items: stmts.getProvisionItems.all(req.params.runId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/servers/:id/provision/scan — LIVE read-only probe: run each item's detect over SSH and
// report what's already installed (vs the matrix, which is DB history). Used when the Setup UI opens.
router.get('/:id/provision/scan', async (req, res) => {
  try {
    const server = stmts.getServer.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.id === 'local' || server.type === 'local') return res.status(400).json({ error: 'Provisioning targets a remote SSH server' });
    const cfg = { ...server, keyPath: resolveKeyPath(server), password: decrypt(server.password), passphrase: decrypt(server.passphrase) };
    res.json(await provisionRunner.scanServer(cfg));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/servers/:id/provision/matrix — every catalog item → its latest recorded state for this server.
router.get('/:id/provision/matrix', (req, res) => {
  try {
    const server = stmts.getServer.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const latest = {};
    for (const row of stmts.getLatestItemsPerServer.all(req.params.id)) latest[row.item_id] = row;
    const matrix = catalog.ITEMS.map(i => {
      const r = latest[i.id];
      return {
        id: i.id, label: i.label, seq: i.seq, group: i.group, risk: i.risk,
        state: r ? r.state : 'unknown', lastRunId: r ? r.run_id : null,
        lastAt: r ? r.finished_at : null, error: r ? r.error : null, reason: r ? r.reason : null,
      };
    });
    res.json({ serverId: req.params.id, matrix });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/servers/:id/provision/runs — run history for a server.
router.get('/:id/provision/runs', (req, res) => {
  try {
    if (!stmts.getServer.get(req.params.id)) return res.status(404).json({ error: 'Server not found' });
    res.json({ runs: stmts.getProvisionRuns.all(req.params.id, 50) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/servers/:id/provision — start a run. body: { preset, only?, confirm? }
router.post('/:id/provision', (req, res) => {
  try {
    const server = stmts.getServer.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.id === 'local' || server.type === 'local') return res.status(400).json({ error: 'Provisioning targets a remote SSH server' });
    const { preset = 'secure-baseline', only, confirm } = req.body || {};
    const cfg = { ...server, keyPath: resolveKeyPath(server), password: decrypt(server.password), passphrase: decrypt(server.passphrase) };
    const { jobId, runId } = provisionRunner.startProvision(cfg, { preset, only, confirm, sourceIp: ipFromReq(req) });
    res.json({ jobId, runId });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message, risks: err.risks || [] });
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
