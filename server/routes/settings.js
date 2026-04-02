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
  const { execSync } = require('child_process');
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${filePath}`;
  return execSync(`wget -qO- --timeout=5 "${url}"`, { timeout: 8000, encoding: 'utf8' });
}

// Fetch recent changes from CHANGELOG.md / CHANGELOG.md-dən son dəyişiklikləri al
function fetchRecentChanges() {
  try {
    const content = githubRawFetch('CHANGELOG.md');
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

// Check for updates — version comparison (raw.githubusercontent, no rate limits) / Yenilik yoxla
router.get('/update/check', async (req, res) => {
  try {
    const pkgPath = require('path').join(__dirname, '..', '..', 'package.json');
    delete require.cache[require.resolve(pkgPath)];
    const currentVersion = require(pkgPath).version;

    const remoteContent = githubRawFetch('package.json');
    const remoteVersion = JSON.parse(remoteContent).version;
    console.log(`[Update] ${currentVersion} → ${remoteVersion} (update: ${remoteVersion !== currentVersion})`);

    const changes = fetchRecentChanges();

    res.json({
      updateAvailable: remoteVersion !== currentVersion,
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

    // Step 3: Build docker run command from container config / docker run əmrini konfiqurasiyadan yarat
    let runCmd = `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null; docker run -d --name ${containerName}`;

    // Restart policy
    runCmd += ` --restart ${restartPolicy.Name || 'always'}`;

    // Port bindings
    for (const [containerPort, hostPorts] of Object.entries(portBindings)) {
      for (const hp of (hostPorts || [])) {
        const port = containerPort.split('/')[0];
        runCmd += hp.HostIp ? ` -p ${hp.HostIp}:${hp.HostPort}:${port}` : ` -p ${hp.HostPort}:${port}`;
      }
    }

    // Volume binds
    for (const bind of binds) {
      runCmd += ` -v '${bind}'`;
    }

    // Environment variables (only user-defined) / Yalnız istifadəçi tərəfindən təyin edilənlər
    const skipEnvPrefixes = ['PATH=', 'NODE_VERSION=', 'YARN_VERSION=', 'HOSTNAME='];
    for (const e of env) {
      if (!skipEnvPrefixes.some(prefix => e.startsWith(prefix))) {
        runCmd += ` -e '${e}'`;
      }
    }

    // Resource limits
    if (nanoCpus > 0) runCmd += ` --cpus ${nanoCpus / 1e9}`;
    if (memory > 0) runCmd += ` --memory ${memory}`;

    runCmd += ` ${DOCKER_IMAGE}:latest`;

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
