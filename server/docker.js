const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

// ============ DYNAMIC DOCKER CLIENT ============
// Active Docker client — local socket default, SSH əlaqələrə switch oluna bilər
// _docker dəyişəni runtime-da setActiveServer() ilə dəyişir
let _docker = new Docker({ socketPath: '/var/run/docker.sock' });
let _activeServerId = 'local';

function createLocalClient() {
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

function createSshClient(server) {
  const opts = {
    protocol: 'ssh',
    host: server.host,
    port: server.port || 22,
    username: server.username,
  };
  // Auth precedence: key > password > SSH agent.
  // IMPORTANT: docker-modem forwards only host/port/username/password to ssh2 at the top level.
  // privateKey/passphrase MUST live inside sshOptions or they are silently dropped, which makes
  // ssh2 fall back to the (absent) agent → "All configured authentication methods failed".
  if (server.key_path) {
    const keyPath = path.isAbsolute(server.key_path)
      ? server.key_path
      : path.join(__dirname, '..', 'data', 'ssh-keys', server.key_path);
    if (!fs.existsSync(keyPath)) throw new Error(`SSH key not found: ${keyPath}`);
    opts.sshOptions = {
      privateKey: fs.readFileSync(keyPath),
      ...(server.passphrase ? { passphrase: server.passphrase } : {}),
    };
  } else if (server.password) {
    opts.password = server.password; // docker-modem forwards top-level password to ssh2
  }
  // If neither is set, ssh2 falls back to the SSH agent.
  return new Docker(opts);
}

/**
 * Aktiv Docker client-i dəyiş.
 * @param {string} serverId — 'local' və ya servers cədvəlindəki id
 */
function setActiveServer(serverId) {
  // Stmts-i late require et — circular dependency-dən qorunmaq üçün
  const { stmts } = require('./db');
  if (!serverId || serverId === 'local') {
    _docker = createLocalClient();
    _activeServerId = 'local';
  } else {
    const server = stmts.getServer.get(serverId);
    if (!server) throw new Error(`Server tapılmadı: ${serverId}`);
    _docker = createSshClient(server);
    _activeServerId = serverId;
  }
  // Cache-i təmizlə — yeni server-in datasını gətirməliyik
  cache.clear();
  // DB-də saxla
  stmts.setSetting.run('active_server', _activeServerId);
  return _activeServerId;
}

function getActiveServerId() { return _activeServerId; }

function isLocalActive() { return _activeServerId === 'local'; }

/**
 * Operations requiring the host CLI (compose, buildx, build-cache prune, self-update,
 * autostart) can only run against the local daemon — a remote SSH host has no access
 * to the panel's own container or host filesystem. If the active server isn't local,
 * throw a clear error instead of silently acting on the wrong host.
 */
function assertLocalActive(operation) {
  if (_activeServerId !== 'local') {
    const err = new Error(`"${operation}" is only supported on the local host (active server: ${_activeServerId}). This operation requires the host CLI / host filesystem and does not apply to a remote SSH host. Switch to Local first.`);
    err.statusCode = 400;
    throw err;
  }
}

// docker dəyişəninə hər müraciətdə getter işləyir — dinamik client dönür
const docker = new Proxy({}, {
  get(_, prop) { return _docker[prop]; },
});

// ============ CACHE LAYER ============
// Ağır Docker API çağırışlarını müvəqqəti saxlayır / Caches expensive Docker API calls
const cache = new Map();

/**
 * Cache-dən oxuyur və ya funksiyanı icra edib nəticəni saxlayır
 * Reads from cache or executes function and stores result
 */
async function cached(key, fn, ttlMs = 10000) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return entry.data;
  const data = await fn();
  cache.set(key, { data, time: Date.now() });
  return data;
}

/** Cache-i təmizləyir / Invalidates cache entries matching prefix */
function invalidateCache(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ============ CONTAINERS ============
async function listContainers(all = true, { size = false } = {}) {
  const containers = await docker.listContainers({ all, size });
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

/** Running processes inside a container (docker top). */
async function containerTop(id) {
  return await docker.getContainer(id).top();
}

/**
 * Run a one-off command in a container and return its combined output + exit code.
 * @param {string} id
 * @param {string[]} cmd argv array (e.g. ["ls", "-la", "/"])
 */
async function containerExecOnce(id, cmd) {
  const exec = await docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = { write: (d) => chunks.push(d) };
    docker.modem.demuxStream(stream, sink, sink); // de-multiplex stdout/stderr into one buffer
    stream.on('end', async () => {
      let exitCode = null;
      try { exitCode = (await exec.inspect()).ExitCode; } catch (e) { /* best-effort */ }
      resolve({ output: Buffer.concat(chunks).toString('utf8'), exitCode });
    });
    stream.on('error', reject);
  });
}

/** Export a container's filesystem as a tar stream (the route pipes it to the client). */
function containerExportStream(id) {
  return docker.getContainer(id).export();
}

// Confine a browse path: ensure it's absolute and strip any "../".
function safeFsPath(p) {
  return ('/' + String(p || '')).replace(/\/+/g, '/').replace(/\.\.(\/|$)/g, '').replace(/\/$/, '') || '/';
}

/** C3 — list a directory inside a (running) container via exec. Returns { path, entries[] }. */
async function containerListFiles(id, path) {
  const safe = safeFsPath(path);
  const script = `cd "${safe}" 2>/dev/null && for f in * .*; do [ "$f" = "." ] || [ "$f" = ".." ] || { [ -e "$f" ] && printf '%s\\t%s\\t%s\\n' "$([ -d "$f" ] && echo d || echo f)" "$(stat -c %s "$f" 2>/dev/null || echo 0)" "$f"; }; done`;
  const { output } = await containerExecOnce(id, ['sh', '-c', script]);
  const entries = String(output || '').split('\n').filter(Boolean).map(line => {
    const i1 = line.indexOf('\t'), i2 = line.indexOf('\t', i1 + 1);
    if (i1 < 0 || i2 < 0) return null;
    return { type: line.slice(0, i1) === 'd' ? 'dir' : 'file', size: parseInt(line.slice(i1 + 1, i2)) || 0, name: line.slice(i2 + 1).replace(/\r$/, '') };
  }).filter(Boolean).sort((a, b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));
  return { path: safe, entries };
}

/** C3 — stream a single file from a container as a download (binary-safe, via exec cat). */
async function containerDownloadFile(id, path, res) {
  const safe = safeFsPath(path);
  const exec = await docker.getContainer(id).exec({ Cmd: ['cat', safe], AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(safe.split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  const { Writable } = require('stream');
  const devnull = new Writable({ write(c, e, cb) { cb(); } });
  docker.modem.demuxStream(stream, res, devnull);
  stream.on('end', () => { try { res.end(); } catch (e) {} });
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
}

/** C3 — extract an uploaded tar into the container at `path` (docker cp in / putArchive). */
async function containerUpload(id, path, req) {
  await docker.getContainer(id).putArchive(req, { path: safeFsPath(path) });
  return { success: true };
}

/** Update a running container's resource limits / restart policy live (docker update). */
async function updateContainer(id, updateConfig) {
  await docker.getContainer(id).update(updateConfig);
  invalidateCache('');
  return { success: true };
}

/** Commit a container's current state into a new image (docker commit). */
async function commitContainer(id, { repo, tag, comment, author } = {}) {
  const r = await docker.getContainer(id).commit({ repo, tag, comment, author });
  invalidateCache('');
  return { id: r.Id || r.id };
}

/**
 * Recreate a container with (optionally) a new image, preserving its config — the "update" flow.
 * Pulls/verifies the image FIRST so the old container is only removed once the new one can be built;
 * reconnects any secondary networks afterwards. Volume data persists (volumes are untouched).
 * @param {string} id
 * @param {string} [newImage] image to switch to (defaults to the current image, e.g. to pull :latest)
 */
async function recreateContainer(id, newImage) {
  const info = await docker.getContainer(id).inspect();
  const image = newImage || info.Config.Image;
  try { await pullImage(image); } catch (e) { /* may already be local */ }
  try { await docker.getImage(image).inspect(); }
  catch (e) { throw new Error(`Image not available: ${image}`); } // abort before touching the old container

  const name = (info.Name || '').replace(/^\//, '');
  const config = {
    name,
    Image: image,
    Hostname: info.Config.Hostname,
    Env: info.Config.Env,
    Cmd: info.Config.Cmd,
    Entrypoint: info.Config.Entrypoint,
    Labels: info.Config.Labels,
    WorkingDir: info.Config.WorkingDir,
    User: info.Config.User,
    ExposedPorts: info.Config.ExposedPorts,
    HostConfig: info.HostConfig,
  };

  await docker.getContainer(id).remove({ force: true });
  const created = await docker.createContainer(config);
  await created.start();

  // Re-attach any networks beyond the primary one (NetworkMode is handled by HostConfig).
  const nets = info.NetworkSettings?.Networks || {};
  const primary = info.HostConfig?.NetworkMode;
  for (const netName of Object.keys(nets)) {
    if (netName === primary || ['default', 'bridge', 'host', 'none'].includes(netName)) continue;
    try { await docker.getNetwork(netName).connect({ Container: created.id }); } catch (e) { /* best-effort */ }
  }
  invalidateCache('');
  return { id: created.id };
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
  invalidateCache(''); // Əməliyyatdan sonra bütün cache-i təmizlə / Clear all cache after action
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
  invalidateCache('');
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

/** Layer history of an image (each layer's CreatedBy command + size). */
async function imageHistory(id) {
  return await docker.getImage(id).history();
}

/** I2 — save an image as a tar stream (docker save). The route pipes it to the client. */
async function imageSaveStream(id) {
  return await docker.getImage(id).get();
}

/** I2 — load images from a tar stream (docker load). Resolves with the load progress output. */
async function loadImage(stream) {
  return new Promise((resolve, reject) => {
    docker.loadImage(stream, (err, out) => {
      if (err) return reject(err);
      let output = '';
      out.on('data', d => { output += d.toString(); });
      out.on('end', () => { invalidateCache(''); resolve({ output }); });
      out.on('error', reject);
    });
  });
}

/**
 * Extract the registry host from an image reference.
 * Docker rule: the first slash-segment is a registry only if it contains '.' or ':' or is 'localhost';
 * otherwise the reference targets Docker Hub.
 * e.g. "ghcr.io/owner/app:1.0" → "ghcr.io"; "localhost:5000/app" → "localhost:5000"; "nginx:latest" → "docker.io".
 * @param {string} repoTag
 * @returns {string} registry host
 */
function registryHostOf(repoTag) {
  const firstSlash = repoTag.indexOf('/');
  if (firstSlash === -1) return 'docker.io';
  const maybeHost = repoTag.slice(0, firstSlash);
  if (maybeHost === 'localhost' || maybeHost.includes('.') || maybeHost.includes(':')) {
    return maybeHost;
  }
  return 'docker.io';
}

/**
 * Look up stored credentials for the registry that hosts `repoTag`.
 * Returns a dockerode authconfig ({ username, password, serveraddress }) or undefined if none stored.
 * Docker Hub is matched under any of its canonical addresses so the user can save it however they like.
 * @param {string} repoTag
 * @returns {{username:string,password:string,serveraddress:string}|undefined}
 */
function lookupAuthConfig(repoTag) {
  const { stmts } = require('./db'); // late require — avoid circular dependency
  const host = registryHostOf(repoTag);
  const candidates = host === 'docker.io'
    ? ['docker.io', 'index.docker.io', 'https://index.docker.io/v1/', 'registry-1.docker.io']
    : [host];
  for (const addr of candidates) {
    const reg = stmts.getRegistryByHost.get(addr);
    if (reg) return { username: reg.username, password: reg.password, serveraddress: addr };
  }
  return undefined;
}

/**
 * Pull an image. If `auth` is omitted, a stored private-registry credential matching the
 * image's registry host is used automatically; public images still pull with no auth.
 * @param {string} repoTag
 * @param {object} [auth] explicit dockerode authconfig (overrides auto-lookup)
 */
async function pullImage(repoTag, auth) {
  const authconfig = auth || lookupAuthConfig(repoTag);
  return new Promise((resolve, reject) => {
    const opts = authconfig ? { authconfig } : {};
    docker.pull(repoTag, opts, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        resolve(output);
      });
    });
  });
}

/**
 * Push a local image (repoTag must include the target repository) to its registry.
 * Auto-matches a stored credential by registry host unless `auth` is provided.
 * The push stream reports auth/denied failures as in-band JSON, so the output is scanned for errors.
 * @param {string} repoTag
 * @param {object} [auth] explicit dockerode authconfig
 */
async function pushImage(repoTag, auth) {
  const authconfig = auth || lookupAuthConfig(repoTag);
  const image = docker.getImage(repoTag);
  return new Promise((resolve, reject) => {
    image.push({ authconfig }, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        const failed = (output || []).find(o => o && o.error);
        if (failed) return reject(new Error(failed.error));
        resolve(output);
      });
    });
  });
}

/**
 * Verify registry credentials against the registry (Docker Engine POST /auth). Does not persist.
 * @param {{serveraddress:string, username:string, password:string}} creds
 * @returns {Promise<object>} the registry response (e.g. { Status: 'Login Succeeded' })
 */
async function checkRegistryAuth({ serveraddress, username, password }) {
  return new Promise((resolve, reject) => {
    docker.checkAuth({ username, password, serveraddress }, (err, data) => {
      if (err) return reject(err);
      resolve(data || { Status: 'Login Succeeded' });
    });
  });
}

async function removeImage(id, force = false) {
  const image = docker.getImage(id);
  await image.remove({ force });
  invalidateCache(''); // keep disk usage / counters from going stale
  return { success: true };
}

/**
 * Docker image build edir və stream qaytarır
 * Niyə: Real-time build loqlarını WebSocket vasitəsilə göndərmək üçün
 * Modul: Docker service
 * İstifadə: routes/builds.js, server/index.js (WebSocket)
 */
/**
 * Build a minimal single-file tar (USTAR) containing just a Dockerfile — the build context for
 * an inline "build from this image" build (no Git/URL context needed). Avoids a tar dependency.
 */
function makeDockerfileTar(content) {
  const data = Buffer.from(String(content || ''), 'utf8');
  const h = Buffer.alloc(512);
  h.write('Dockerfile', 0);                                                   // name
  h.write('0000644\0', 100);                                                  // mode
  h.write('0000000\0', 108);                                                  // uid
  h.write('0000000\0', 116);                                                  // gid
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);             // size (octal)
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136); // mtime
  h.write('        ', 148);                                                    // checksum placeholder (8 spaces)
  h.write('0', 156);                                                          // typeflag = regular file
  h.write('ustar\x0000', 257);                                               // magic "ustar\0" + version "00"
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);                      // real checksum
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad), Buffer.alloc(1024)]);      // + two zero end-blocks
}

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
  invalidateCache('');
  return { success: true };
}

async function createVolume(config) {
  const r = await docker.createVolume(config);
  invalidateCache('');
  return r;
}

// Volume backup / clone use a throwaway helper container (busybox/alpine) that mounts the volume.
const VOL_HELPER_IMAGE = 'alpine';
async function ensureHelperImage() {
  try { await docker.getImage(VOL_HELPER_IMAGE).inspect(); }
  catch (e) { await pullImage(VOL_HELPER_IMAGE); }
}

/**
 * V1 — stream a gzipped tar of a volume's contents to an HTTP response.
 * A helper container mounts the volume read-only and runs `tar`; its stdout (the tar) is
 * de-multiplexed straight to the response, then the helper is removed.
 */
async function backupVolumeToResponse(volName, res) {
  await ensureHelperImage();
  const helper = await docker.createContainer({
    Image: VOL_HELPER_IMAGE,
    Cmd: ['sh', '-c', 'tar czf - -C /volume . 2>/dev/null'],
    HostConfig: { Binds: [`${volName}:/volume:ro`], AutoRemove: false },
    AttachStdout: true, AttachStderr: true, Tty: false,
  });
  const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${volName}.tar.gz"`);
  const { Writable } = require('stream');
  const devnull = new Writable({ write(c, e, cb) { cb(); } });
  docker.modem.demuxStream(stream, res, devnull); // stdout (tar) → res, stderr → discard
  let removed = false;
  const cleanup = async () => { if (removed) return; removed = true; try { await helper.remove({ force: true }); } catch (e) {} };
  await helper.start();
  stream.on('end', () => { res.end(); cleanup(); });
  stream.on('error', () => { try { res.destroy(); } catch (e) {} cleanup(); });
  res.on('close', cleanup);
}

/**
 * V2 — restore a volume from an uploaded gzipped tar (the inverse of backup).
 * A helper container extracts the upload (piped into its stdin) into the volume.
 * @param {string} volName
 * @param {import('stream').Readable} req the request body stream (the .tar.gz upload)
 */
async function restoreVolumeFromRequest(volName, req) {
  await ensureHelperImage();
  const helper = await docker.createContainer({
    Image: VOL_HELPER_IMAGE,
    Cmd: ['sh', '-c', 'tar xzf - -C /volume'],
    HostConfig: { Binds: [`${volName}:/volume`], AutoRemove: false },
    AttachStdin: true, OpenStdin: true, StdinOnce: true,
    AttachStdout: true, AttachStderr: true, Tty: false,
  });
  const stream = await helper.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  await helper.start();
  req.pipe(stream); // upload → container stdin; StdinOnce closes stdin when the upload ends
  const result = await helper.wait();
  try { await helper.remove({ force: true }); } catch (e) {}
  invalidateCache('');
  if (result.StatusCode !== 0) throw new Error(`Restore failed (tar exited ${result.StatusCode})`);
  return { success: true };
}

// Confine a browse path to the volume mount — strip any "../" so it can't escape /volume.
function safeVolPath(p) {
  return ('/' + String(p || '')).replace(/\/+/g, '/').replace(/\.\.(\/|$)/g, '').replace(/\/$/, '') || '';
}

/**
 * V3 — list a directory inside a volume (one helper container per request, read-only mount).
 * Returns { path, entries:[{ type:'dir'|'file', size, name }] }.
 */
async function listVolumeFiles(volName, path) {
  await ensureHelperImage();
  const safe = safeVolPath(path);
  const script = `cd "/volume${safe}" 2>/dev/null && for f in * .*; do [ "$f" = "." ] || [ "$f" = ".." ] || { [ -e "$f" ] && printf '%s\\t%s\\t%s\\n' "$([ -d "$f" ] && echo d || echo f)" "$(stat -c %s "$f" 2>/dev/null || echo 0)" "$f"; }; done`;
  const helper = await docker.createContainer({
    Image: VOL_HELPER_IMAGE,
    Cmd: ['sh', '-c', script],
    HostConfig: { Binds: [`${volName}:/volume:ro`], AutoRemove: false },
    Tty: true, // raw (un-framed) text output
  });
  await helper.start();
  await helper.wait();
  const buf = await helper.logs({ stdout: true, stderr: false });
  try { await helper.remove({ force: true }); } catch (e) {}
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const entries = text.split('\n').filter(Boolean).map(line => {
    const i1 = line.indexOf('\t'), i2 = line.indexOf('\t', i1 + 1);
    if (i1 < 0 || i2 < 0) return null;
    return { type: line.slice(0, i1) === 'd' ? 'dir' : 'file', size: parseInt(line.slice(i1 + 1, i2)) || 0, name: line.slice(i2 + 1).replace(/\r$/, '') };
  }).filter(Boolean).sort((a, b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));
  return { path: safe, entries };
}

/** V3 — stream a single file from a volume as a download (binary-safe). */
async function downloadVolumeFile(volName, path, res) {
  await ensureHelperImage();
  const safe = safeVolPath(path);
  const helper = await docker.createContainer({
    Image: VOL_HELPER_IMAGE,
    Cmd: ['cat', `/volume${safe}`],
    HostConfig: { Binds: [`${volName}:/volume:ro`], AutoRemove: false },
    AttachStdout: true, AttachStderr: true, Tty: false,
  });
  const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(safe.split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  const { Writable } = require('stream');
  const devnull = new Writable({ write(c, e, cb) { cb(); } });
  docker.modem.demuxStream(stream, res, devnull);
  let removed = false;
  const cleanup = async () => { if (removed) return; removed = true; try { await helper.remove({ force: true }); } catch (e) {} };
  await helper.start();
  stream.on('end', () => { res.end(); cleanup(); });
  stream.on('error', () => { try { res.destroy(); } catch (e) {} cleanup(); });
  res.on('close', cleanup);
}

/**
 * V4 — clone a volume's contents into a new volume (a helper container `cp -a`s the data).
 */
async function cloneVolume(srcName, destName) {
  await ensureHelperImage();
  await docker.createVolume({ Name: destName });
  const helper = await docker.createContainer({
    Image: VOL_HELPER_IMAGE,
    Cmd: ['sh', '-c', 'cp -a /from/. /to/ 2>/dev/null || true'],
    HostConfig: { Binds: [`${srcName}:/from:ro`, `${destName}:/to`], AutoRemove: false },
  });
  await helper.start();
  await helper.wait();
  try { await helper.remove({ force: true }); } catch (e) {}
  invalidateCache('');
  return { success: true, name: destName };
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
  invalidateCache('');
  return { success: true };
}

async function createNetwork(config) {
  const r = await docker.createNetwork(config);
  invalidateCache('');
  return r;
}

/** Attach a container to a network (networks are immutable, but membership is live). */
async function connectNetwork(id, container, opts = {}) {
  await docker.getNetwork(id).connect({ Container: container, ...opts });
  invalidateCache('');
  return { success: true };
}

/** Detach a container from a network. */
async function disconnectNetwork(id, container, force = false) {
  await docker.getNetwork(id).disconnect({ Container: container, Force: !!force });
  invalidateCache('');
  return { success: true };
}

// ============ SYSTEM ============
async function getSystemInfo() {
  return cached('systemInfo', () => docker.info(), 60000); // 60s cache
}

async function getDockerVersion() {
  return await docker.version();
}

async function getDiskUsage() {
  return cached('diskUsage', () => docker.df(), 30000); // 30s cache
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
  const r = await docker.pruneContainers();
  invalidateCache('');
  return r;
}

async function pruneImages(dangling = false) {
  // dangling=false → bütün unused image-lər (tagged + dangling) silinir
  // dangling=true  → yalnız dangling (untagged <none>) silinir
  const r = await docker.pruneImages({ filters: { dangling: [String(dangling)] } });
  invalidateCache('');
  return r;
}

async function pruneVolumes() {
  // Docker 23+ default yalnız anonim volume-ları silir; all=true → named unused də silinir
  const r = await docker.pruneVolumes({ filters: { all: ['true'] } });
  invalidateCache('');
  return r;
}

async function pruneNetworks() {
  const r = await docker.pruneNetworks();
  invalidateCache('');
  return r;
}

async function pruneBuildCache() {
  // Use the Docker Engine API (POST /build/prune) via dockerode instead of the host
  // `docker builder prune` CLI. The API tunnels over SSH, so this now works on remote
  // hosts too (the CLI version only worked on the local daemon).
  const r = await docker.pruneBuilder({ all: true });
  invalidateCache('');
  const reclaimed = r.SpaceReclaimed || 0;
  return {
    Message: 'Build cache pruned',
    SpaceReclaimed: reclaimed,                 // bytes — read by cleanup page
    SpaceReclaimedStr: formatBytes(reclaimed), // human string — read by builds page
    CachesDeleted: r.CachesDeleted || [],
  };
}

// Minimal byte formatter (kept local to docker.js — used by pruneBuildCache result)
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function systemPrune(volumes = false) {
  const results = {};
  results.containers = await docker.pruneContainers();
  // Bütün unused image-ləri sil (tagged + dangling) — UI preview ilə uyğun
  results.images = await docker.pruneImages({ filters: { dangling: ['false'] } });
  results.networks = await docker.pruneNetworks();
  if (volumes) {
    // Named + anonim unused volume-ları sil
    results.volumes = await docker.pruneVolumes({ filters: { all: ['true'] } });
  }
  invalidateCache('');
  return results;
}

// NOTE: Real-time streams (events/stats/logs) and container exec are wired up
// directly via dockerode in the socket handlers in server/index.js.
// The previous streamEvents/streamContainerStats/streamContainerLogs/execInContainer
// wrappers weren't used by any caller (divergence risk) — removed.

// ============ SETTINGS / SYSTEM ============
// DockGate manages its own container (autostart, self-update) — this is ALWAYS on the
// local daemon, so use a fresh local client rather than the active (possibly remote) client.
async function getAppContainer() {
  const os = require('os');
  const hostname = os.hostname();
  return createLocalClient().getContainer(hostname);
}

async function getAutoStartStatus() {
  try {
    const c = await getAppContainer();
    const info = await c.inspect();
    return info.HostConfig.RestartPolicy.Name !== 'no';
  } catch(err) {
    return false; // Container tapılmırsa auto-start aktiv deyil
  }
}

async function setAutoStart(enabled) {
  const c = await getAppContainer();
  const policyName = enabled ? 'always' : 'no';
  await c.update({ RestartPolicy: { Name: policyName, MaximumRetryCount: 0 } });
  return policyName;
}

// Test connection — server config qəbul edir, dockerode ilə ping et
async function testServerConnection(serverConfig) {
  let client;
  try {
    if (!serverConfig || serverConfig.type === 'local') {
      client = createLocalClient();
    } else {
      client = createSshClient(serverConfig);
    }
    const version = await client.version();
    const info = await client.info();
    return {
      success: true,
      version: version.Version,
      apiVersion: version.ApiVersion,
      os: info.OperatingSystem,
      containers: info.Containers,
      images: info.Images,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  docker, invalidateCache, createLocalClient,
  setActiveServer, getActiveServerId, isLocalActive, assertLocalActive, testServerConnection,
  listContainers, inspectContainer, getContainerStats, containerAction,
  containerTop, containerExecOnce, containerExportStream, updateContainer, commitContainer, recreateContainer,
  containerListFiles, containerDownloadFile, containerUpload,
  getContainerLogs, createContainer, parseStats, demuxLogs,
  listImages, inspectImage, imageHistory, imageSaveStream, loadImage, pullImage, pushImage, removeImage, tagImage, buildImage, makeDockerfileTar,
  registryHostOf, checkRegistryAuth,
  listVolumes, inspectVolume, removeVolume, createVolume, backupVolumeToResponse, restoreVolumeFromRequest, cloneVolume,
  listVolumeFiles, downloadVolumeFile,
  listNetworks, inspectNetwork, removeNetwork, createNetwork, connectNetwork, disconnectNetwork,
  getSystemInfo, getDockerVersion, getDiskUsage,
  listComposeProjects, getComposeProject,
  getCleanupPreview, pruneContainers, pruneImages, pruneVolumes, pruneNetworks, pruneBuildCache, systemPrune,
  getAutoStartStatus, setAutoStart,
};
