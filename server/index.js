const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dockerService = require('./docker');
const { stmts } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 7077;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// REST Routes
app.use('/api/containers', require('./routes/containers'));
app.use('/api/images', require('./routes/images'));
app.use('/api/builds', require('./routes/builds'));
app.use('/api/volumes', require('./routes/volumes'));
app.use('/api/networks', require('./routes/networks'));
app.use('/api/compose', require('./routes/compose'));
app.use('/api/system', require('./routes/system'));
app.use('/api/cleanup', require('./routes/cleanup'));
app.use('/api/meta', require('./routes/settings'));

// Dashboard summary endpoint
app.get('/api/dashboard', async (req, res) => {
  try {
    const [containers, images, volumes, networks, systemInfo, diskUsage] = await Promise.all([
      dockerService.listContainers(true),
      dockerService.listImages(),
      dockerService.listVolumes(),
      dockerService.listNetworks(),
      dockerService.getSystemInfo(),
      dockerService.getDiskUsage(),
    ]);

    const running = containers.filter(c => c.state === 'running');
    const stopped = containers.filter(c => c.state === 'exited');
    const restarting = containers.filter(c => c.state === 'restarting');
    const paused = containers.filter(c => c.state === 'paused');

    // Get favorites
    const favorites = stmts.getFavorites.all();
    const recentActivity = stmts.getActivity.all(10);

    // Smart insights
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

    const composeProjects = await dockerService.listComposeProjects();

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

// ============ WEBSOCKET ============
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Container log streaming
  let logStream = null;
  socket.on('logs:subscribe', async ({ containerId, tail = 100, timestamps = false }) => {
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
  socket.on('events:subscribe', async (filters = {}) => {
    try {
      eventStream = await new Promise((resolve, reject) => {
        dockerService.docker.getEvents({ filters }, (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        });
      });
      eventStream.on('data', (chunk) => {
        try {
          const event = JSON.parse(chunk.toString());
          socket.emit('events:data', event);
        } catch (e) { /* ignore */ }
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
server.listen(PORT, () => {
  console.log(`\n  🐳 DockGate Control Panel`);
  console.log(`  ────────────────────────`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Listening on port ${PORT}\n`);
});
