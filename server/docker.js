const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ============ CONTAINERS ============
async function listContainers(all = true) {
  const containers = await docker.listContainers({ all, size: true });
  return containers.map(c => ({
    id: c.Id,
    shortId: c.Id.substring(0, 12),
    names: c.Names.map(n => n.replace(/^\//, '')),
    name: (c.Names[0] || '').replace(/^\//, ''),
    image: c.Image,
    imageId: c.ImageID,
    command: c.Command,
    created: c.Created,
    state: c.State,
    status: c.Status,
    ports: c.Ports || [],
    labels: c.Labels || {},
    networkMode: c.HostConfig?.NetworkMode || '',
    mounts: c.Mounts || [],
    sizeRw: c.SizeRw || 0,
    sizeRootFs: c.SizeRootFs || 0,
    networks: Object.keys(c.NetworkSettings?.Networks || {}),
    composeProject: c.Labels?.['com.docker.compose.project'] || null,
    composeService: c.Labels?.['com.docker.compose.service'] || null,
  }));
}

async function inspectContainer(id) {
  const container = docker.getContainer(id);
  return await container.inspect();
}

async function getContainerStats(id) {
  const container = docker.getContainer(id);
  const stats = await container.stats({ stream: false });
  return parseStats(stats);
}

function parseStats(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
  const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

  const memUsage = stats.memory_stats?.usage || 0;
  const memLimit = stats.memory_stats?.limit || 1;
  const memPercent = (memUsage / memLimit) * 100;

  const netRx = Object.values(stats.networks || {}).reduce((a, n) => a + (n.rx_bytes || 0), 0);
  const netTx = Object.values(stats.networks || {}).reduce((a, n) => a + (n.tx_bytes || 0), 0);

  const blockRead = (stats.blkio_stats?.io_service_bytes_recursive || [])
    .filter(s => s.op === 'read' || s.op === 'Read')
    .reduce((a, s) => a + s.value, 0);
  const blockWrite = (stats.blkio_stats?.io_service_bytes_recursive || [])
    .filter(s => s.op === 'write' || s.op === 'Write')
    .reduce((a, s) => a + s.value, 0);

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsage: memUsage,
    memoryLimit: memLimit,
    memoryPercent: Math.round(memPercent * 100) / 100,
    networkRx: netRx,
    networkTx: netTx,
    blockRead,
    blockWrite,
    pids: stats.pids_stats?.current || 0,
  };
}

async function containerAction(id, action, options = {}) {
  const container = docker.getContainer(id);
  switch (action) {
    case 'start': await container.start(); break;
    case 'stop': await container.stop({ t: options.timeout || 10 }); break;
    case 'restart': await container.restart({ t: options.timeout || 10 }); break;
    case 'kill': await container.kill({ signal: options.signal || 'SIGKILL' }); break;
    case 'pause': await container.pause(); break;
    case 'unpause': await container.unpause(); break;
    case 'remove': await container.remove({ force: options.force || false, v: options.removeVolumes || false }); break;
    case 'rename': await container.rename({ name: options.name }); break;
    default: throw new Error(`Unknown action: ${action}`);
  }
  return { success: true, action, id };
}

async function getContainerLogs(id, options = {}) {
  const container = docker.getContainer(id);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail: options.tail || 200,
    timestamps: options.timestamps || false,
    follow: false,
  });
  return demuxLogs(logs);
}

function demuxLogs(buffer) {
  if (typeof buffer === 'string') return buffer;
  const lines = [];
  let offset = 0;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  while (offset < buf.length) {
    if (offset + 8 > buf.length) {
      lines.push(buf.slice(offset).toString('utf8'));
      break;
    }
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) {
      lines.push(buf.slice(offset + 8).toString('utf8'));
      break;
    }
    lines.push(buf.slice(offset + 8, offset + 8 + size).toString('utf8'));
    offset += 8 + size;
  }
  return lines.join('');
}

async function createContainer(config) {
  const container = await docker.createContainer(config);
  return { id: container.id };
}

// ============ IMAGES ============
async function listImages() {
  const images = await docker.listImages({ all: false });
  const containers = await docker.listContainers({ all: true });
  const usedImages = new Set(containers.map(c => c.ImageID));

  return images.map(img => ({
    id: img.Id,
    shortId: img.Id.replace('sha256:', '').substring(0, 12),
    repoTags: img.RepoTags || ['<none>:<none>'],
    repoDigests: img.RepoDigests || [],
    size: img.Size,
    virtualSize: img.VirtualSize || img.Size,
    created: img.Created,
    labels: img.Labels || {},
    containers: containers.filter(c => c.ImageID === img.Id).length,
    inUse: usedImages.has(img.Id),
    isDangling: (!img.RepoTags || img.RepoTags[0] === '<none>:<none>'),
  }));
}

async function inspectImage(id) {
  const image = docker.getImage(id);
  return await image.inspect();
}

async function pullImage(repoTag) {
  return new Promise((resolve, reject) => {
    docker.pull(repoTag, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        resolve(output);
      });
    });
  });
}

async function removeImage(id, force = false) {
  const image = docker.getImage(id);
  await image.remove({ force });
  return { success: true };
}

/**
 * Docker image build edir və stream qaytarır
 * Niyə: Real-time build loqlarını WebSocket vasitəsilə göndərmək üçün
 * Modul: Docker service
 * İstifadə: routes/builds.js, server/index.js (WebSocket)
 */
async function buildImage(context, options = {}) {
  const buildOpts = {
    t: options.tag || undefined,
    dockerfile: options.dockerfile || 'Dockerfile',
    nocache: options.nocache || false,
    pull: options.pull || false,
    buildargs: options.buildargs || {},
    rm: true,
  };

  return new Promise((resolve, reject) => {
    docker.buildImage(context, buildOpts, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

async function tagImage(id, repo, tag) {
  const image = docker.getImage(id);
  await image.tag({ repo, tag });
  return { success: true };
}

// ============ VOLUMES ============
async function listVolumes() {
  const result = await docker.listVolumes();
  const containers = await docker.listContainers({ all: true });
  const volumes = result.Volumes || [];

  return volumes.map(v => {
    const attachedContainers = containers.filter(c =>
      (c.Mounts || []).some(m => m.Name === v.Name)
    );
    return {
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      createdAt: v.CreatedAt,
      labels: v.Labels || {},
      scope: v.Scope,
      options: v.Options || {},
      attachedContainers: attachedContainers.length,
      inUse: attachedContainers.length > 0,
      containerNames: attachedContainers.map(c => (c.Names[0] || '').replace(/^\//, '')),
    };
  });
}

async function inspectVolume(name) {
  const volume = docker.getVolume(name);
  return await volume.inspect();
}

async function removeVolume(name) {
  const volume = docker.getVolume(name);
  await volume.remove();
  return { success: true };
}

async function createVolume(config) {
  return await docker.createVolume(config);
}

// ============ NETWORKS ============
async function listNetworks() {
  const networks = await docker.listNetworks();
  return networks.map(n => ({
    id: n.Id,
    shortId: n.Id.substring(0, 12),
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope,
    internal: n.Internal,
    ipam: n.IPAM,
    containers: Object.keys(n.Containers || {}).length,
    labels: n.Labels || {},
    created: n.Created,
    subnet: n.IPAM?.Config?.[0]?.Subnet || '',
    gateway: n.IPAM?.Config?.[0]?.Gateway || '',
  }));
}

async function inspectNetwork(id) {
  const network = docker.getNetwork(id);
  return await network.inspect();
}

async function removeNetwork(id) {
  const network = docker.getNetwork(id);
  await network.remove();
  return { success: true };
}

async function createNetwork(config) {
  return await docker.createNetwork(config);
}

// ============ SYSTEM ============
async function getSystemInfo() {
  return await docker.info();
}

async function getDockerVersion() {
  return await docker.version();
}

async function getDiskUsage() {
  return await docker.df();
}

// ============ COMPOSE ============
async function listComposeProjects() {
  const containers = await docker.listContainers({ all: true });
  const projects = {};

  containers.forEach(c => {
    const project = c.Labels?.['com.docker.compose.project'];
    if (!project) return;
    if (!projects[project]) {
      projects[project] = {
        name: project,
        workingDir: c.Labels?.['com.docker.compose.project.working_dir'] || '',
        configFiles: c.Labels?.['com.docker.compose.project.config_files'] || '',
        services: [],
        running: 0,
        stopped: 0,
        total: 0,
      };
    }
    const service = c.Labels?.['com.docker.compose.service'];
    if (service && !projects[project].services.includes(service)) {
      projects[project].services.push(service);
    }
    projects[project].total++;
    if (c.State === 'running') projects[project].running++;
    else projects[project].stopped++;
  });

  return Object.values(projects);
}

async function getComposeProject(projectName) {
  const containers = await docker.listContainers({ all: true });
  const projectContainers = containers.filter(
    c => c.Labels?.['com.docker.compose.project'] === projectName
  );

  const services = {};
  projectContainers.forEach(c => {
    const service = c.Labels?.['com.docker.compose.service'] || 'unknown';
    services[service] = {
      name: service,
      containerId: c.Id,
      containerName: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
    };
  });

  return {
    name: projectName,
    workingDir: projectContainers[0]?.Labels?.['com.docker.compose.project.working_dir'] || '',
    configFiles: projectContainers[0]?.Labels?.['com.docker.compose.project.config_files'] || '',
    services: Object.values(services),
    running: projectContainers.filter(c => c.State === 'running').length,
    total: projectContainers.length,
  };
}

const { exec } = require('child_process');

// ============ CLEANUP ============
async function getCleanupPreview() {
  const [containers, images, volumes, networks, dfData] = await Promise.all([
    docker.listContainers({ all: true, filters: { status: ['exited', 'dead', 'created'] } }),
    listImages(),
    listVolumes(),
    listNetworks(),
    getDiskUsage()
  ]);

  const stoppedContainers = containers.map(c => ({
    id: c.Id.substring(0, 12),
    name: (c.Names[0] || '').replace(/^\//, ''),
    image: c.Image,
    status: c.Status,
    created: c.Created,
  }));

  const unusedImages = images.filter(i => !i.inUse);
  const danglingImages = images.filter(i => i.isDangling);
  const unusedVolumes = volumes.filter(v => !v.inUse);
  const unusedNetworks = networks.filter(n =>
    !['bridge', 'host', 'none'].includes(n.name) && n.containers === 0
  );

  const buildCacheSize = dfData.BuildCache?.reduce((a, b) => a + (b.Size || 0), 0) || 0;

  return {
    stoppedContainers,
    unusedImages,
    danglingImages,
    unusedVolumes,
    unusedNetworks,
    estimatedSpace: {
      images: unusedImages.reduce((a, i) => a + i.size, 0),
      containers: stoppedContainers.length,
      buildCache: buildCacheSize
    }
  };
}

async function pruneContainers() {
  return await docker.pruneContainers();
}

async function pruneImages(dangling = true) {
  return await docker.pruneImages({ filters: { dangling: [String(dangling)] } });
}

async function pruneVolumes() {
  return await docker.pruneVolumes();
}

async function pruneNetworks() {
  return await docker.pruneNetworks();
}

async function pruneBuildCache() {
  return new Promise((resolve, reject) => {
    exec('docker builder prune -a -f', (err, stdout) => {
      if (err) return reject(err);
      
      let spaceStr = '';
      const match = stdout.match(/Total reclaimed space: (.+)/);
      if (match) spaceStr = match[1];
      
      resolve({
        Message: "Build cache pruned",
        SpaceReclaimedStr: spaceStr,
        Output: stdout
      });
    });
  });
}

async function systemPrune(volumes = false) {
  const results = {};
  results.containers = await docker.pruneContainers();
  results.images = await docker.pruneImages();
  results.networks = await docker.pruneNetworks();
  if (volumes) {
    results.volumes = await docker.pruneVolumes();
  }
  return results;
}

// ============ EVENTS ============
function streamEvents(callback, filters = {}) {
  docker.getEvents({ filters }, (err, stream) => {
    if (err) { callback(err); return; }
    stream.on('data', (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        callback(null, event);
      } catch (e) { /* ignore parse errors */ }
    });
    stream.on('error', (err) => callback(err));
  });
}

// ============ STATS STREAM ============
function streamContainerStats(id, callback) {
  const container = docker.getContainer(id);
  container.stats({ stream: true }, (err, stream) => {
    if (err) { callback(err); return null; }
    stream.on('data', (chunk) => {
      try {
        const stats = JSON.parse(chunk.toString());
        callback(null, parseStats(stats));
      } catch (e) { /* ignore */ }
    });
    stream.on('error', (err) => callback(err));
    stream.on('end', () => callback(null, null));
    return stream;
  });
  return { destroy: () => { /* will be handled by caller */ } };
}

// ============ LOG STREAM ============
function streamContainerLogs(id, callback, options = {}) {
  const container = docker.getContainer(id);
  container.logs({
    stdout: true,
    stderr: true,
    tail: options.tail || 100,
    follow: true,
    timestamps: options.timestamps || false,
  }, (err, stream) => {
    if (err) { callback(err); return; }
    stream.on('data', (chunk) => {
      const text = demuxLogs(chunk);
      callback(null, text);
    });
    stream.on('error', (err) => callback(err));
    stream.on('end', () => callback(null, null));
  });
}

// ============ EXEC ============
async function execInContainer(id, cmd = ['/bin/sh'], options = {}) {
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    ...options,
  });
  return exec;
}

// ============ SETTINGS / SYSTEM ============
async function getAppContainer() {
  const os = require('os');
  const hostname = os.hostname();
  return docker.getContainer(hostname);
}

async function getAutoStartStatus() {
  try {
    const c = await getAppContainer();
    const info = await c.inspect();
    return info.HostConfig.RestartPolicy.Name !== 'no';
  } catch(err) {
    return true; // Assume true if we fail to read
  }
}

async function setAutoStart(enabled) {
  const c = await getAppContainer();
  const policyName = enabled ? 'always' : 'no';
  await c.update({ RestartPolicy: { Name: policyName, MaximumRetryCount: 0 } });
  return policyName;
}

module.exports = {
  docker,
  listContainers, inspectContainer, getContainerStats, containerAction,
  getContainerLogs, createContainer, parseStats, demuxLogs,
  listImages, inspectImage, pullImage, removeImage, tagImage, buildImage,
  listVolumes, inspectVolume, removeVolume, createVolume,
  listNetworks, inspectNetwork, removeNetwork, createNetwork,
  getSystemInfo, getDockerVersion, getDiskUsage,
  listComposeProjects, getComposeProject,
  getCleanupPreview, pruneContainers, pruneImages, pruneVolumes, pruneNetworks, pruneBuildCache, systemPrune,
  streamEvents, streamContainerStats, streamContainerLogs, execInContainer,
  getAutoStartStatus, setAutoStart,
};
