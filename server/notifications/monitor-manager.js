// Multi-host EventMonitor manager.
// Owns one EventMonitor per registered server (local + every SSH host)
// so notifications fire regardless of which server is currently active in the UI.

const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const EventMonitor = require('./event-monitor');
const { stmts } = require('../db');

const SSH_KEYS_DIR = path.join(__dirname, '..', '..', 'data', 'ssh-keys');

const monitors = new Map(); // serverId → EventMonitor

function buildClient(server) {
  if (!server || server.id === 'local' || server.type === 'local') {
    return new Docker({ socketPath: '/var/run/docker.sock' });
  }
  const opts = {
    protocol: 'ssh',
    host: server.host,
    port: server.port || 22,
    username: server.username,
  };
  if (server.key_path) {
    const keyPath = path.isAbsolute(server.key_path)
      ? server.key_path
      : path.join(SSH_KEYS_DIR, server.key_path);
    if (fs.existsSync(keyPath)) {
      opts.privateKey = fs.readFileSync(keyPath);
    }
  } else if (server.password) {
    opts.password = server.password;
  }
  return new Docker(opts);
}

function startMonitor(serverIdOrConfig) {
  let id, config;
  if (typeof serverIdOrConfig === 'string') {
    id = serverIdOrConfig;
    if (id === 'local') {
      config = { id: 'local', type: 'local' };
    } else {
      config = stmts.getServer.get(id);
      if (!config) {
        console.warn(`[monitor-manager] Server "${id}" not found in DB`);
        return null;
      }
    }
  } else {
    id = serverIdOrConfig.id;
    config = serverIdOrConfig;
  }

  // Stop existing monitor for this id (config may have changed)
  stopMonitor(id);

  try {
    const docker = buildClient(config);
    const m = new EventMonitor(id, docker);
    m.start();
    monitors.set(id, m);
    return m;
  } catch (err) {
    console.error(`[monitor-manager] Could not start monitor for "${id}":`, err.message);
    return null;
  }
}

function stopMonitor(serverId) {
  const m = monitors.get(serverId);
  if (m) {
    m.stop();
    monitors.delete(serverId);
  }
}

function startAll() {
  // Local first
  startMonitor('local');
  // Every registered SSH server
  const servers = stmts.getServers.all();
  for (const s of servers) {
    startMonitor(s);
  }
  console.log(`[monitor-manager] Started ${monitors.size} monitor(s)`);
}

function stopAll() {
  for (const id of [...monitors.keys()]) stopMonitor(id);
}

// Returns the local-server monitor — used by the build-failed trigger
// (builds run against the host Docker only).
function getLocal() {
  return monitors.get('local');
}

function listMonitors() {
  return [...monitors.entries()].map(([id, m]) => ({
    serverId: id,
    running: !m.stopped,
    hasStream: !!m.stream,
  }));
}

module.exports = {
  startMonitor, stopMonitor, startAll, stopAll, getLocal, listMonitors,
};
