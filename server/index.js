const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dockerService = require('./docker');
const { stmts } = require('./db');
const { logAction } = require('./audit');

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize: 10MB so large streamed messages (build logs, exec output) don't trip the 1MB default.
// Same-origin only by default; set ALLOWED_ORIGIN to permit a specific cross-origin panel (cookie auth needs credentials).
const io = new Server(server, {
  cors: process.env.ALLOWED_ORIGIN ? { origin: process.env.ALLOWED_ORIGIN, credentials: true } : { origin: false },
  maxHttpBufferSize: 10 * 1024 * 1024, // large streamed messages (build logs, exec output)
});

const monitorManager = require('./notifications/monitor-manager');
const { attachHostTerminal } = require('./host-terminal');

const PORT = process.env.PORT || 7077;

// For the correct source IP behind a reverse proxy (nginx, etc.) — audit source_ip is derived from this
app.set('trust proxy', true);

// Middleware
// Body parsing: 5MB protects every endpoint (SSH key uploads, normal API payloads). The folder-deploy
// upload sends a whole project as base64 JSON (≈50MB of files → ≈67MB base64), so THAT one route gets
// 100MB. A single global 5MB parser would otherwise reject it first ("Payload Too Large").
const jsonSmall = express.json({ limit: '5mb' });
const jsonLarge = express.json({ limit: '100mb' });
// covers /deploy-folder (single-shot) and /deploy-folder-file (per-file upload — one big binary file can still be ~67MB as base64)
app.use((req, res, next) => (req.path.startsWith('/api/compose/deploy-folder') ? jsonLarge : jsonSmall)(req, res, next));

// Cache-busting: index.html-dəki hər asset URL-i ?v=<versiya> ilə möhürlənir (__V__ placeholder),
// beləcə hər relizdən sonra brauzer köhnə JS/CSS-i yox, təzəsini çəkir (hard refresh lazım olmur).
const APP_VERSION = require('../package.json').version;
const INDEX_HTML = require('fs')
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/__V__/g, APP_VERSION);
app.get(['/', '/index.html'], (req, res) => res.type('html').send(INDEX_HTML));

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Authentication gate ----
// /api/auth/* (login/logout/status/setup) is open; EVERY other /api route + the dashboard require a
// valid session cookie. Static SPA assets stay public (they're the app shell, no data); the client
// renders the login/setup screen when /api/auth/status reports unauthenticated. Registered BEFORE the
// business routes so requireAuth runs first for them.
const { requireAuth, checkOrigin } = require('./auth/middleware');
app.use('/api', checkOrigin);                    // CSRF defense-in-depth: cross-origin state change → 403
app.use('/api/auth', require('./routes/auth'));  // open: login / logout / status / setup
app.use('/api', requireAuth);                    // everything else needs a session

// REST Routes
app.use('/api/containers', require('./routes/containers'));
app.use('/api/images', require('./routes/images'));
app.use('/api/builds', require('./routes/builds'));
app.use('/api/volumes', require('./routes/volumes'));
app.use('/api/networks', require('./routes/networks'));
app.use('/api/compose', require('./routes/compose'));
app.use('/api/files', require('./routes/files'));
app.use('/api/system', require('./routes/system'));
app.use('/api/cleanup', require('./routes/cleanup'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/registries', require('./routes/registries'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/meta', require('./routes/settings'));

// Startup-da saxlanmış aktiv server-i bərpa et (yalnız "local" olmadıqda)
try {
  const savedServerId = stmts.getSetting.get('active_server')?.value;
  if (savedServerId && savedServerId !== 'local') {
    dockerService.setActiveServer(savedServerId);
    console.log(`[startup] Active server restored: ${savedServerId}`);
  }
} catch (err) {
  console.error('[startup] Could not restore active server:', err.message);
  console.error('[startup] Falling back to local Docker socket');
}

// Dashboard summary endpoint / Dashboard məlumat endpoint-i
app.get('/api/dashboard', async (req, res) => {
  try {
    // Faza 1: Əsas məlumatlar paralel (size:false — sürətli) / Phase 1: Core data in parallel (no size — fast)
    const [containers, images, volumes, networks, systemInfo, diskUsage, composeProjects] = await Promise.all([
      dockerService.listContainers(true),
      dockerService.listImages(),
      dockerService.listVolumes(),
      dockerService.listNetworks(),
      dockerService.getSystemInfo(),
      dockerService.getDiskUsage(),
      dockerService.listComposeProjects(),
    ]);

    const running = containers.filter(c => c.state === 'running');
    const stopped = containers.filter(c => c.state === 'exited');
    const restarting = containers.filter(c => c.state === 'restarting');
    const paused = containers.filter(c => c.state === 'paused');

    // Get favorites / Favoritləri al
    const favorites = stmts.getFavorites.all();
    const recentActivity = stmts.getActivity.all(10);

    // Smart insights / Ağıllı təhlillər
    const insights = [];
    const oldStopped = stopped.filter(c => {
      const created = new Date(c.created * 1000);
      const daysOld = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
      return daysOld > 7;
    });
    if (oldStopped.length > 0) {
      insights.push({ type: 'warning', message: `${oldStopped.length} stopped container(s) have been inactive for 7+ days`, action: 'cleanup' });
    }

    const unusedImages = images.filter(i => !i.inUse);
    if (unusedImages.length > 0) {
      const size = unusedImages.reduce((a, i) => a + i.size, 0);
      insights.push({ type: 'info', message: `${unusedImages.length} unused image(s) taking ${formatBytes(size)}`, action: 'cleanup' });
    }

    const danglingImages = images.filter(i => i.isDangling);
    if (danglingImages.length > 0) {
      insights.push({ type: 'warning', message: `${danglingImages.length} dangling image(s) found`, action: 'cleanup' });
    }

    const unusedVolumes = volumes.filter(v => !v.inUse);
    if (unusedVolumes.length > 0) {
      insights.push({ type: 'info', message: `${unusedVolumes.length} volume(s) not attached to any container`, action: 'cleanup' });
    }

    // Faza 2: Stats + health paralel (yalnız running üçün) / Phase 2: Stats + health in parallel (running only)
    let containerStats = [];
    let healthStats = { healthy: 0, unhealthy: 0, noHealthcheck: 0, starting: 0 };
    let containerDetails = [];

    if (running.length > 0) {
      const [statsResults, inspectResults] = await Promise.all([
        // CPU/RAM stats — top 10 / CPU/RAM statistikası — ilk 10
        Promise.all(running.slice(0, 10).map(async (c) => {
          try {
            const stats = await dockerService.getContainerStats(c.id);
            return { name: c.name, id: c.shortId, ...stats };
          } catch(e) { return null; }
        })),
        // Health inspect — top 20 / Sağlamlıq yoxlaması — ilk 20
        Promise.all(running.slice(0, 20).map(async (c) => {
          try {
            const info = await dockerService.inspectContainer(c.id);
            const health = info.State?.Health?.Status;
            return {
              name: c.name,
              id: c.shortId,
              health: health || 'none',
              startedAt: info.State?.StartedAt,
              restartCount: info.RestartCount || 0,
              status: c.status,
            };
          } catch(e) { return null; }
        })),
      ]);

      containerStats = statsResults.filter(Boolean).sort((a, b) => b.cpuPercent - a.cpuPercent);
      containerDetails = inspectResults.filter(Boolean);
      for (const cd of containerDetails) {
        if (cd.health === 'healthy') healthStats.healthy++;
        else if (cd.health === 'unhealthy') healthStats.unhealthy++;
        else if (cd.health === 'starting') healthStats.starting++;
        else healthStats.noHealthcheck++;
      }
    }

    // Port map — all exposed ports / Port xəritəsi — bütün açıq portlar
    const portMap = [];
    for (const c of containers) {
      for (const p of (c.ports || [])) {
        if (p.PublicPort) {
          portMap.push({
            container: c.name,
            containerId: c.shortId,
            state: c.state,
            hostPort: p.PublicPort,
            containerPort: p.PrivatePort,
            protocol: p.Type || 'tcp',
            hostIp: p.IP || '0.0.0.0',
          });
        }
      }
    }
    portMap.sort((a, b) => a.hostPort - b.hostPort);

    // Top images by size / Ən böyük image-lər
    const topImages = [...images]
      .sort((a, b) => b.size - a.size)
      .slice(0, 8)
      .map(i => ({
        id: i.shortId,
        tag: (i.repoTags && i.repoTags[0] !== '<none>:<none>') ? i.repoTags[0] : i.shortId,
        size: i.size,
        inUse: i.inUse,
        created: i.created,
      }));

    res.json({
      summary: {
        totalContainers: containers.length,
        running: running.length,
        stopped: stopped.length,
        restarting: restarting.length,
        paused: paused.length,
        totalImages: images.length,
        totalVolumes: volumes.length,
        totalNetworks: networks.length,
        composeProjects: composeProjects.length,
      },
      system: {
        dockerVersion: systemInfo.ServerVersion,
        os: `${systemInfo.OperatingSystem}`,
        kernel: systemInfo.KernelVersion,
        architecture: systemInfo.Architecture,
        cpus: systemInfo.NCPU,
        memory: systemInfo.MemTotal,
        storageDriver: systemInfo.Driver,
      },
      diskUsage: {
        images: diskUsage.Images?.reduce((a, i) => a + (i.Size || 0), 0) || 0,
        containers: diskUsage.Containers?.reduce((a, c) => a + (c.SizeRw || 0), 0) || 0,
        volumes: diskUsage.Volumes?.reduce((a, v) => a + (v.UsageData?.Size || 0), 0) || 0,
        buildCache: diskUsage.BuildCache?.reduce((a, b) => a + (b.Size || 0), 0) || 0,
      },
      containerStats,
      healthStats,
      containerDetails,
      portMap,
      topImages,
      insights,
      favorites,
      recentActivity,
      composeProjects,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// Error handler — turn an oversized body (and other thrown errors) into a clean JSON response
// instead of Express's default HTML stack. Must come after the routes.
app.use((err, req, res, next) => {
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'Request body too large. Folder deploy accepts up to ~50MB of files; other endpoints up to 5MB. For bigger projects use pre-built images or Deploy from Git.' });
  }
  if (err) return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  next();
});

// ============ WEBSOCKET ============
// Handshake auth — same session cookie as the REST gate. An unauthenticated client cannot open ANY
// live stream (build / logs / stats / events / terminal / host shell).
io.use((socket, next) => {
  const { verifyToken, readSessionToken } = require('./auth/session');
  const token = readSessionToken({ headers: socket.handshake.headers });
  if (verifyToken(token)) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // System (host) terminal — shell on the active server (remote SSH host or local container). See host-terminal.js.
  attachHostTerminal(socket, { dockerService, stmts, logAction });

  // ---- Docker Image Build streaming ----
  let buildStream = null;
  let activeBuildInfo = null; // {id, tag, server} — so build:cancel can write a meaningful audit entry
  socket.on('build:start', async ({ buildId, contextType, contextValue, gitToken, tag, dockerfile, nocache, pull, buildargs }) => {
    try {
      const crypto = require('crypto');
      const id = buildId || crypto.randomUUID();
      const startTime = Date.now();
      // The build runs on the ACTIVE daemon (local or the selected remote SSH host) via the
      // docker Proxy. Capture it so the audit entry and failure alert name the correct host
      // instead of hardcoding 'local'.
      const buildServer = dockerService.getActiveServerId();

      // Insert build record into DB / DB-yə build qeydini əlavə et
      stmts.insertBuild.run(id, tag || 'untagged', dockerfile || 'Dockerfile', contextValue || '', JSON.stringify(buildargs || {}), nocache ? 1 : 0, pull ? 1 : 0, 'building');
      socket.emit('build:started', { buildId: id });
      // Audit the INITIATION too (not just the outcome) — a cancelled/never-finishing build must leave a trace
      logAction({ socket, server: buildServer, resourceType: 'build', resourceName: tag || 'untagged', action: 'build_start', details: { buildId: id, contextType: contextType || 'url' } });
      activeBuildInfo = { id, tag: tag || 'untagged', server: buildServer };

      // 'inline' → build from a Dockerfile typed in the UI (a generated single-file tar context);
      // 'url' (default) → a Git repo / remote tarball that dockerode fetches.
      // gitToken (private repo): URL-in userinfo hissəsinə daxil edilir — daemon git clone-u
      // onunla edir. DB-yə YALNIZ təmiz URL yazılır (yuxarıda), token heç yerdə saxlanmır/loglanmır.
      let context;
      if (contextType === 'inline') {
        context = dockerService.makeDockerfileTar(contextValue);
      } else if (gitToken && /^https:\/\//i.test(contextValue || '')) {
        context = contextValue.replace(/^https:\/\//i, `https://${encodeURIComponent(gitToken)}@`);
      } else {
        context = contextValue;
      }

      const stream = await dockerService.buildImage(context, {
        tag, dockerfile, nocache, pull, buildargs
      });
      buildStream = stream;

      let fullLog = '';
      let imageId = null;
      let buildError = null; // structured error — scanning the log text for 'ERROR:' was fragile

      stream.on('data', (chunk) => {
        try {
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            const json = JSON.parse(line);
            let logLine = '';

            if (json.stream) {
              logLine = json.stream;
            } else if (json.status) {
              logLine = json.status + (json.progress ? ' ' + json.progress : '') + '\n';
            } else if (json.error || json.errorDetail) {
              // Docker build error field — we determine the status from this (not from the log text)
              buildError = json.error || json.errorDetail?.message || 'Build failed';
              logLine = 'ERROR: ' + buildError + '\n';
            } else if (json.aux && json.aux.ID) {
              imageId = json.aux.ID;
              logLine = 'Built image: ' + json.aux.ID + '\n';
            }

            if (logLine) {
              fullLog += logLine;
              socket.emit('build:log', { buildId: id, data: logLine, json });
            }
          }
        } catch (e) {
          const text = chunk.toString();
          fullLog += text;
          socket.emit('build:log', { buildId: id, data: text });
        }
      });

      stream.on('end', () => {
        const duration = Date.now() - startTime;
        const status = buildError ? 'failed' : 'success';

        stmts.updateBuildStatus.run(status, duration, imageId, buildError, id);
        stmts.appendBuildLog.run(fullLog, id);

        socket.emit('build:complete', { buildId: id, status, duration, imageId });
        // Audit on the actual build host (active server)
        logAction({ socket, server: buildServer, resourceType: 'build', resourceName: tag || 'untagged', action: status === 'failed' ? 'build_failed' : 'build_success', details: { buildId: id, duration } });
        if (status === 'failed') {
          // Route the failure through the monitor of the host the build ran on
          const mon = monitorManager.get(buildServer) || monitorManager.getLocal();
          if (mon) mon.triggerBuildFailed({ imageTag: tag, buildId: id, error: buildError, duration });
        }
        buildStream = null;
        activeBuildInfo = null;
      });

      stream.on('error', (err) => {
        const duration = Date.now() - startTime;
        stmts.updateBuildStatus.run('failed', duration, null, err.message, id);
        stmts.appendBuildLog.run(fullLog + '\nERROR: ' + err.message, id);

        socket.emit('build:error', { buildId: id, error: err.message });
        buildStream = null;
        activeBuildInfo = null;
      });

    } catch (err) {
      socket.emit('build:error', { buildId: buildId || 'unknown', error: err.message });
    }
  });

  socket.on('build:cancel', () => {
    if (buildStream) {
      try { buildStream.destroy(); } catch(e) {}
      buildStream = null;
      socket.emit('build:cancelled');
      // Audit the cancellation — destroying an active build is a state-changing operation
      if (activeBuildInfo) {
        logAction({ socket, server: activeBuildInfo.server, resourceType: 'build', resourceName: activeBuildInfo.tag, action: 'build_cancel', details: { buildId: activeBuildInfo.id } });
        activeBuildInfo = null;
      }
    }
  });

  // Container log streaming
  let logStream = null;
  socket.on('logs:subscribe', async ({ containerId, tail = 100, timestamps = false }) => {
    if (logStream) { try { logStream.destroy(); } catch(e){} logStream = null; }
    try {
      const container = dockerService.docker.getContainer(containerId);
      logStream = await container.logs({
        stdout: true, stderr: true, tail, follow: true, timestamps
      });
      logStream.on('data', (chunk) => {
        const text = dockerService.demuxLogs(chunk);
        socket.emit('logs:data', { containerId, data: text });
      });
      logStream.on('end', () => socket.emit('logs:end', { containerId }));
      logStream.on('error', (err) => socket.emit('logs:error', { containerId, error: err.message }));
    } catch (err) {
      socket.emit('logs:error', { containerId, error: err.message });
    }
  });

  socket.on('logs:unsubscribe', () => {
    if (logStream) { try { logStream.destroy(); } catch(e){} logStream = null; }
  });

  // Container stats streaming
  let statsStream = null;
  socket.on('stats:subscribe', async ({ containerId }) => {
    if (statsStream) { try { statsStream.destroy(); } catch(e){} statsStream = null; }
    try {
      const container = dockerService.docker.getContainer(containerId);
      statsStream = await container.stats({ stream: true });
      statsStream.on('data', (chunk) => {
        try {
          const raw = JSON.parse(chunk.toString());
          const parsed = dockerService.parseStats(raw);
          socket.emit('stats:data', { containerId, ...parsed });
        } catch (e) { /* ignore */ }
      });
      statsStream.on('end', () => socket.emit('stats:end', { containerId }));
    } catch (err) {
      socket.emit('stats:error', { containerId, error: err.message });
    }
  });

  socket.on('stats:unsubscribe', () => {
    if (statsStream) { try { statsStream.destroy(); } catch(e){} statsStream = null; }
  });

  // Docker events streaming
  let eventStream = null;
  socket.on('events:subscribe', async (payload) => {
    try {
      // Destroy previous stream if exists / Əvvəlki stream varsa sil
      if (eventStream) { try { eventStream.destroy(); } catch(e){} eventStream = null; }

      // payload: { filters?, since? } — since (unix saniyə) Docker-a keçmiş hadisələri replay etdirir,
      // sonra axın canlı davam edir. since yoxdursa yalnız yeni hadisələr gəlir (köhnə davranış).
      const { filters, since } = payload || {};
      const opts = (filters && Object.keys(filters).length > 0) ? { filters } : {};
      if (Number.isFinite(since) && since > 0) opts.since = Math.floor(since);
      eventStream = await new Promise((resolve, reject) => {
        dockerService.docker.getEvents(opts, (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        });
      });
      eventStream.on('data', (chunk) => {
        try {
          const event = JSON.parse(chunk.toString());
          socket.emit('events:data', event);
        } catch (e) { /* ignore parse errors */ }
      });
      eventStream.on('error', (err) => {
        socket.emit('events:error', { error: err.message });
      });
    } catch (err) {
      socket.emit('events:error', { error: err.message });
    }
  });

  socket.on('events:unsubscribe', () => {
    if (eventStream) { try { eventStream.destroy(); } catch(e){} eventStream = null; }
  });

  // Container terminal (exec)
  socket.on('terminal:start', async ({ containerId, shell = '/bin/sh' }) => {
    try {
      // Clean up previous terminal listeners to prevent leaks
      // Əvvəlki terminal listener-lərini təmizlə ki, leak olmasın
      socket.removeAllListeners('terminal:input');
      socket.removeAllListeners('terminal:resize');

      const container = dockerService.docker.getContainer(containerId);
      const exec = await container.exec({
        Cmd: [shell],
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      });
      const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

      stream.on('data', (chunk) => {
        socket.emit('terminal:data', { containerId, data: chunk.toString('utf8') });
      });
      stream.on('end', () => socket.emit('terminal:end', { containerId }));

      socket.on('terminal:input', (data) => {
        try { stream.write(data); } catch(e) {}
      });

      socket.on('terminal:resize', ({ cols, rows }) => {
        try { exec.resize({ h: rows, w: cols }); } catch(e) {}
      });

      socket._termStream = stream;
      // Audit — interactive shell access into the container (session level; keystrokes are not logged)
      logAction({ socket, resourceId: containerId, resourceType: 'container', resourceName: containerId.substring(0, 12), action: 'terminal_open', details: { shell } });
      socket.emit('terminal:ready', { containerId });
    } catch (err) {
      socket.emit('terminal:error', { containerId, error: err.message });
    }
  });

  socket.on('terminal:stop', () => {
    if (socket._termStream) { try { socket._termStream.end(); } catch(e){} socket._termStream = null; }
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    if (buildStream) try { buildStream.destroy(); } catch(e){}
    if (logStream) try { logStream.destroy(); } catch(e){}
    if (statsStream) try { statsStream.destroy(); } catch(e){}
    if (eventStream) try { eventStream.destroy(); } catch(e){}
    if (socket._termStream) try { socket._termStream.end(); } catch(e){}
    console.log('Client disconnected:', socket.id);
  });
});

// Utils
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

// Start server
server.listen(PORT, process.env.BIND_HOST || '0.0.0.0', () => {
  console.log(`\n  🐳 DockGate Control Panel`);
  console.log(`  ────────────────────────`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Listening on port ${PORT}\n`);

  // Start one event monitor per registered server (local + every SSH host).
  // Notifications fire from any server regardless of which one is active in the UI.
  monitorManager.startAll();
});

// Periodic DB retention — trim old records every 6 hours
// Dövri DB saxlama — hər 6 saatda köhnə qeydləri sil
setInterval(() => {
  try { stmts.trimActivity.run(); } catch(e) {}
  try { stmts.trimBuilds.run(); } catch(e) {}
  try { stmts.trimNotificationLogs.run(); } catch(e) {}
}, 6 * 60 * 60 * 1000);
