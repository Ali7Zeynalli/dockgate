const express = require('express');
const router = express.Router();
const { stmts } = require('../db');

// ============ VERSION ============
const pkgVersion = require('../../package.json').version;
router.get('/version', (req, res) => { res.json({ version: pkgVersion }); });

// ============ FAVORITES ============
router.get('/favorites', (req, res) => {
  try {
    const type = req.query.type;
    const favs = type ? stmts.getFavoritesByType.all(type) : stmts.getFavorites.all();
    res.json(favs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/favorites', (req, res) => {
  try {
    const { id, type = 'container', name = '' } = req.body;
    stmts.addFavorite.run(id, type, name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/favorites/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    stmts.removeFavorite.run(req.params.id, type);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ NOTES ============
router.get('/notes', (req, res) => {
  try { res.json(stmts.getNotes.all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/notes/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    const note = stmts.getNote.get(req.params.id, type);
    res.json(note || { note: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notes', (req, res) => {
  try {
    const { id, type = 'container', note } = req.body;
    stmts.setNote.run(id, type, note);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/notes/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    stmts.deleteNote.run(req.params.id, type);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ TAGS ============
router.get('/tags', (req, res) => {
  try { res.json(stmts.getTags.all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tags/:id', (req, res) => {
  try {
    const type = req.query.type || 'container';
    res.json(stmts.getTagsForResource.all(req.params.id, type));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tags', (req, res) => {
  try {
    const { id, type = 'container', tag, color = '#00d4aa' } = req.body;
    stmts.addTag.run(id, type, tag, color);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tags/:id/:tag', (req, res) => {
  try {
    const type = req.query.type || 'container';
    stmts.removeTag.run(req.params.id, type, req.params.tag);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ ACTIVITY ============
router.get('/activity', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json(stmts.getActivity.all(limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/activity', (req, res) => {
  try { stmts.clearActivity.run(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SETTINGS ============
router.get('/settings', (req, res) => {
  try {
    const settings = {};
    stmts.getSettings.all().forEach(s => { settings[s.key] = s.value; });
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings', (req, res) => {
  try {
    Object.entries(req.body).forEach(([key, value]) => {
      stmts.setSetting.run(key, String(value));
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SMTP CONFIG ============
router.get('/smtp', (req, res) => {
  try {
    const rows = stmts.getSmtpConfig.all();
    const config = {};
    rows.forEach(r => {
      // Mask password
      config[r.key] = r.key === 'smtp_pass' ? '••••••••' : r.value;
    });
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/smtp', (req, res) => {
  try {
    const allowedKeys = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_to'];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowedKeys.includes(key) && value !== undefined) {
        // Don't overwrite password with mask
        if (key === 'smtp_pass' && value === '••••••••') continue;
        stmts.setSmtpConfig.run(key, String(value));
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/smtp', (req, res) => {
  try { stmts.deleteSmtpConfig.run(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/smtp/test', async (req, res) => {
  try {
    const mailer = require('../notifications/mailer');
    const result = await mailer.sendTestEmail();
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ TELEGRAM ============
router.get('/telegram', (req, res) => {
  try {
    const tg = require('../notifications/telegram');
    const settings = tg.getTelegramSettings();
    res.json({
      tg_token: settings.token ? '••••••••' + settings.token.slice(-4) : '',
      tg_chat_id: settings.chatId || '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/telegram', (req, res) => {
  try {
    const { tg_token, tg_chat_id } = req.body;
    if (tg_token && !tg_token.startsWith('••••')) {
      stmts.setSmtpConfig.run('tg_token', String(tg_token));
    }
    if (tg_chat_id !== undefined) {
      stmts.setSmtpConfig.run('tg_chat_id', String(tg_chat_id));
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/telegram', (req, res) => {
  try {
    const db = require('../db').db;
    db.prepare("DELETE FROM smtp_config WHERE key IN ('tg_token', 'tg_chat_id')").run();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/telegram/test', async (req, res) => {
  try {
    const tg = require('../notifications/telegram');
    const result = await tg.sendTestMessage();
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ NOTIFICATION RULES ============
router.get('/notifications/rules', (req, res) => {
  try { res.json(stmts.getNotificationRules.all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/notifications/rules/:type', (req, res) => {
  try {
    const { type } = req.params;
    const rule = stmts.getRule.get(type);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    if (req.body.enabled !== undefined) {
      stmts.setRuleEnabled.run(req.body.enabled ? 1 : 0, type);
    }
    if (req.body.cooldown_minutes !== undefined) {
      const cd = Math.max(1, Math.min(1440, parseInt(req.body.cooldown_minutes) || 5));
      stmts.setRuleCooldown.run(cd, type);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ NOTIFICATION LOG ============
router.get('/notifications/log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json(stmts.getNotificationLogs.all(limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/notifications/log', (req, res) => {
  try { stmts.clearNotificationLogs.run(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SYSTEM AUTO-START ============
router.get('/autostart', async (req, res) => {
  try {
    const dockerService = require('../docker');
    const status = await dockerService.getAutoStartStatus();
    res.json({ enabled: status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/autostart', async (req, res) => {
  try {
    const dockerService = require('../docker');
    const enabled = req.body.enabled === true;
    const policy = await dockerService.setAutoStart(enabled);
    stmts.logActivity.run('', 'system', 'settings', 'autostart_toggle', JSON.stringify({ policy }));
    res.json({ success: true, policy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ AUTO-UPDATE ============
const REPO_OWNER = 'Ali7Zeynalli';
const REPO_NAME = 'dockgate';
const DOCKER_IMAGE = `ghcr.io/${REPO_OWNER.toLowerCase()}/${REPO_NAME}`;
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

// Fetch file from GitHub (wget — Node.js https hangs on Alpine) / GitHub-dan fayl al (wget ilə)
function githubRawFetch(filePath) {
  const { execFile } = require('child_process');
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${filePath}`;
  return new Promise((resolve, reject) => {
    execFile('wget', ['-qO-', '--timeout=5', url], { timeout: 8000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// Fetch recent changes from CHANGELOG.md / CHANGELOG.md-dən son dəyişiklikləri al
async function fetchRecentChanges() {
  try {
    const content = await githubRawFetch('CHANGELOG.md');
    const lines = content.split('\n').slice(0, 30);
    const changes = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        changes.push(trimmed.substring(2));
      }
    }
    return changes.slice(0, 10);
  } catch(e) {
    return [];
  }
}

// Compare semver: returns true if remote > current / Semver müqayisə: remote > current olarsa true qaytarır
function isNewerVersion(current, remote) {
  const c = current.split('.').map(Number);
  const r = remote.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
    if ((r[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

// Check for updates — version comparison only / Yenilik yoxla — yalnız versiya müqayisəsi
router.get('/update/check', async (req, res) => {
  try {
    const pkgPath = require('path').join(__dirname, '..', '..', 'package.json');
    delete require.cache[require.resolve(pkgPath)];
    const currentVersion = require(pkgPath).version;

    const remoteContent = await githubRawFetch('package.json');
    const remoteVersion = JSON.parse(remoteContent).version;

    // Semver compare — update only if remote is newer / Yalnız remote daha yenidirsə update göstər
    const hasUpdate = isNewerVersion(currentVersion, remoteVersion);
    console.log(`[Update] v${currentVersion} → v${remoteVersion} (update: ${hasUpdate})`);

    const changes = hasUpdate ? await fetchRecentChanges() : [];

    res.json({
      updateAvailable: hasUpdate,
      currentVersion,
      remoteVersion,
      changes,
      repoUrl: REPO_URL,
    });
  } catch (err) {
    const pkgPath = require('path').join(__dirname, '..', '..', 'package.json');
    try { delete require.cache[require.resolve(pkgPath)]; } catch(e) {}
    let currentVersion = '0.0.0';
    try { currentVersion = require(pkgPath).version; } catch(e) {}
    res.json({ updateAvailable: false, currentVersion, error: err.message, repoUrl: REPO_URL });
  }
});

// Pull image via dockerode (Promise wrapper) / Dockerode ilə image pull et
function pullImage(docker, imageName) {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        resolve(output);
      });
    });
  });
}

// Inspect own container and get its config / Öz konteynerimizi inspect edib konfiqurasiyasını al
async function inspectSelf(docker) {
  const os = require('os');
  const hostname = os.hostname();
  const container = docker.getContainer(hostname);
  return await container.inspect();
}

// Apply update — pull pre-built image + restart via helper container / Yeniləmə tətbiq et
router.post('/update/apply', async (req, res) => {
  const dockerService = require('../docker');
  const docker = dockerService.docker;

  try {
    // Step 1: Get own container config / Öz konfiqurasiyamızı al
    const info = await inspectSelf(docker);
    const containerName = info.Name.replace(/^\//, '');
    const binds = info.HostConfig?.Binds || [];
    const portBindings = info.HostConfig?.PortBindings || {};
    const env = info.Config?.Env || [];
    const restartPolicy = info.HostConfig?.RestartPolicy || { Name: 'always' };
    const nanoCpus = info.HostConfig?.NanoCpus || 0;
    const memory = info.HostConfig?.Memory || 0;

    // Step 2: Pull new image / Yeni image-i çək
    console.log(`[Update] Pulling ${DOCKER_IMAGE}:latest ...`);
    await pullImage(docker, `${DOCKER_IMAGE}:latest`);
    console.log('[Update] Image pulled successfully');

    // Step 3: Build docker run args from container config / docker run arqumentlərini konfiqurasiyadan yarat
    const runArgs = ['stop', containerName];
    const rmArgs = ['rm', containerName];
    const startArgs = ['run', '-d', '--name', containerName];

    // Restart policy
    startArgs.push('--restart', restartPolicy.Name || 'always');

    // Port bindings
    for (const [containerPort, hostPorts] of Object.entries(portBindings)) {
      for (const hp of (hostPorts || [])) {
        const port = containerPort.split('/')[0];
        startArgs.push('-p', hp.HostIp ? `${hp.HostIp}:${hp.HostPort}:${port}` : `${hp.HostPort}:${port}`);
      }
    }

    // Volume binds
    for (const bind of binds) {
      startArgs.push('-v', bind);
    }

    // Environment variables (only user-defined) / Yalnız istifadəçi tərəfindən təyin edilənlər
    const skipEnvPrefixes = ['PATH=', 'NODE_VERSION=', 'YARN_VERSION=', 'HOSTNAME='];
    for (const e of env) {
      if (!skipEnvPrefixes.some(prefix => e.startsWith(prefix))) {
        startArgs.push('-e', e);
      }
    }

    // Resource limits
    if (nanoCpus > 0) startArgs.push('--cpus', String(nanoCpus / 1e9));
    if (memory > 0) startArgs.push('--memory', String(memory));

    startArgs.push(`${DOCKER_IMAGE}:latest`);

    // Shell-safe: hər arqumenti ayrıca quote et
    const shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    const runCmd = `docker ${runArgs.map(shellEscape).join(' ')} 2>/dev/null; docker ${rmArgs.map(shellEscape).join(' ')} 2>/dev/null; docker ${startArgs.map(shellEscape).join(' ')}`;

    console.log('[Update] Spawning helper container to restart...');

    // Step 4: Pull and run docker:cli helper container
    // Helper: wait 3s (for response to reach client), then stop old, start new
    try { await pullImage(docker, 'docker:cli'); } catch(e) { /* artıq mövcuddursa keç */ }

    const helper = await docker.createContainer({
      Image: 'docker:cli',
      Cmd: ['sh', '-c', `sleep 3 && ${runCmd}`],
      HostConfig: {
        AutoRemove: true,
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      },
    });
    await helper.start();
    console.log('[Update] Helper container started, restart in ~3 seconds');

    res.json({ success: true, message: 'Image updated. Restarting in a few seconds...' });

  } catch(err) {
    console.error('[Update] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual update instructions / Yeniləmə təlimatı
router.get('/update/instructions', (req, res) => {
  res.json({
    steps: [
      'docker compose pull',
      'docker compose up -d',
    ],
    note: 'Data is persisted in the ./data volume and will not be lost.',
  });
});

module.exports = router;
