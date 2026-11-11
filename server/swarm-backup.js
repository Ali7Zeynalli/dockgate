// Swarm backup and recovery — phase 7.
//
// Backup (Cluster settings → Back up now, and once a night): one .tar file in data/swarm-backups/ with
//   cluster.json        what the cluster is: spec (no join tokens), nodes and their labels, services, overlay
//                       networks, configs (with content), secrets (names only — Swarm never returns values),
//                       DockGate's stacks
//   swarm-dir.tar.gz    the manager's /var/lib/docker/swarm (Raft state), read through a helper container that is
//                       never started — taken while Docker runs (Docker recommends stopping it for a perfectly
//                       consistent copy)
//   unlock-key.enc      the autolock key, encrypted with this DockGate's key (only when autolock is on)
//   RESTORE.txt         the steps to bring the cluster back on a new server
// The last 7 per cluster are kept.
//
// Recover cluster: when most managers are lost the services keep running but nothing can be changed. With the
// server name typed in, DockGate takes a backup, runs `docker swarm init --force-new-cluster` on the manager in
// use (a one-manager cluster with every service) and removes the managers that are gone.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const tarStream = require('tar-stream');
const { stmts, db } = require('./db');
const dockerService = require('./docker');
const swarm = require('./swarm');
const { logAction } = require('./audit');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'swarm-backups');
const KEEP = 7;
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });
const FILE_RE = /^swarm-[a-z0-9]{1,25}-\d{8}-\d{6}\.tar$/;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const RESTORE_TXT = (info) => `DockGate Swarm backup — ${new Date().toISOString()}
Cluster ${info.clusterId} · taken on ${info.server} (${info.nodeAddr})

Only needed when EVERY manager is lost. If one manager is still running, use DockGate → Swarm → Overview →
Recover cluster instead.

Bring the cluster back on a new server (the same Docker version is best):
  1. sudo systemctl stop docker
  2. sudo rm -rf /var/lib/docker/swarm
  3. sudo mkdir -p /var/lib/docker && sudo tar -xzf swarm-dir.tar.gz -C /var/lib/docker
     (the archive holds the folder "swarm")
  4. sudo systemctl start docker
  5. docker swarm init --force-new-cluster --advertise-addr <this server's address>
  6. If autolock was on: docker swarm unlock (the key is in unlock-key.enc — DockGate shows it in
     Cluster settings → Show unlock key on the DockGate that made this backup)
  7. Join the other servers again (Swarm → Add servers…); remove the old nodes in Swarm → Nodes.

cluster.json describes services, networks, configs and nodes in plain JSON (secrets by name only).
`;

async function manager() {
  const st = await swarm.status();
  if (st.state !== 'active' || !st.manager) throw bad(409, 'Swarm must be active and the server in use a manager');
  return { c: dockerService.docker, st };
}

/** The logical description; parts that need a leader are left out (with the reason) when there is none. */
async function describe(c, sid) {
  const out = { version: 1, takenAt: new Date().toISOString(), errors: [] };
  let noLeader = false;
  const tryPart = async (k, fn) => {
    if (noLeader) return;
    try { out[k] = await fn(); }
    catch (e) {
      const m = swarm.dockerMsg(e) || e.message;
      if (/does not have a leader|deadline exceeded/i.test(m)) { noLeader = true; out.errors.push('cluster description left out: the swarm has no leader (the swarm state below is complete)'); }
      else out.errors.push(`${k}: ${m}`);
    }
  };
  await tryPart('swarm', async () => { const s = await c.swarmInspect(); delete s.JoinTokens; return s; });
  await tryPart('nodes', async () => (await c.listNodes()).map(n => ({ id: n.ID, hostname: n.Description.Hostname, role: n.Spec.Role, availability: n.Spec.Availability, labels: n.Spec.Labels || {}, addr: n.Status.Addr, engine: n.Description.Engine && n.Description.Engine.EngineVersion })));
  await tryPart('services', async () => (await c.listServices()).map(s => ({ id: s.ID, spec: s.Spec })));
  await tryPart('networks', async () => (await c.listNetworks({ filters: JSON.stringify({ scope: ['swarm'] }) })).filter(n => !n.Ingress).map(n => ({ name: n.Name, driver: n.Driver, attachable: n.Attachable, internal: n.Internal, options: n.Options, labels: n.Labels, subnets: ((n.IPAM && n.IPAM.Config) || []).map(x => x.Subnet) })));
  await tryPart('configs', async () => (await c.listConfigs()).map(x => ({ name: x.Spec.Name, labels: x.Spec.Labels || {}, data: x.Spec.Data })));
  await tryPart('secrets', async () => (await c.listSecrets()).map(x => ({ name: x.Spec.Name, labels: x.Spec.Labels || {} })));
  try { out.stacks = db.prepare('SELECT name, origin, location, settings FROM swarm_stacks WHERE server_id = ?').all(sid); } catch (e) { out.stacks = []; }
  return out;
}

/** The manager's swarm folder as a gzipped tar, written to `dest`. */
async function rawCopy(c, dest) {
  const info = await c.info();
  const root = info.DockerRootDir || '/var/lib/docker';
  let image = 'alpine:3.20';
  try { await c.getImage(image).inspect(); }
  catch (e) { const any = (await c.listImages())[0]; if (!any) throw new Error('No image on the server to make the helper container from'); image = any.Id; }
  const helper = await c.createContainer({ Image: image, Cmd: ['true'], Labels: { 'dockgate.role': 'swarm-backup-helper' }, HostConfig: { Binds: [`${root}/swarm:/swarm:ro`], NetworkMode: 'none' } });
  try {
    const stream = await helper.getArchive({ path: '/swarm' });
    await pipeline(stream, zlib.createGzip({ level: 6 }), fs.createWriteStream(dest));
  } finally { await helper.remove({ force: true }).catch(() => {}); }
}

/** Take a backup of the cluster managed through the server in use. */
async function backupNow({ reason = 'manual', sourceIp } = {}) {
  const { c, st } = await manager();
  return backupWith(c, st.serverId, { reason, sourceIp });
}
async function backupWith(c, sid, { reason, sourceIp } = {}) {
  const info = await c.info();
  const sw = info.Swarm || {};
  // Without a leader `docker info` has no cluster ID: take it from DockGate's own record of this node.
  let clusterId = (sw.Cluster && sw.Cluster.ID) || null;
  if (!clusterId) { try { const r = db.prepare('SELECT cluster_id FROM swarm_node_servers WHERE node_id = ?').get(sw.NodeID); clusterId = r && r.cluster_id; } catch (e) { /* none */ } }
  clusterId = clusterId || 'unknown';
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const name = `swarm-${clusterId.slice(0, 12).toLowerCase()}-${stamp()}.tar`;
  const tmpGz = path.join(DIR, `.${name}.raw.gz`);
  const desc = await describe(c, sid);
  let rawError = null;
  try { await rawCopy(c, tmpGz); } catch (e) { rawError = e.message; desc.errors.push(`swarm folder: ${e.message}`); }
  const key = stmts.getSetting.get(`swarm_unlock_key:${sid}`);
  const meta = { file: name, clusterId, server: sid, serverName: info.Name, nodeAddr: sw.NodeAddr, reason, takenAt: desc.takenAt, autolock: !!(desc.swarm && desc.swarm.Spec && desc.swarm.Spec.EncryptionConfig && desc.swarm.Spec.EncryptionConfig.AutoLockManagers), unlockKey: !!(key && key.value), raw: !rawError, services: (desc.services || []).length, nodes: (desc.nodes || []).length, errors: desc.errors };
  const pack = tarStream.pack();
  const out = fs.createWriteStream(path.join(DIR, name), { mode: 0o600 });
  const done = pipeline(pack, out);
  const add = (n, buf) => new Promise((res, rej) => pack.entry({ name: n, size: buf.length, mode: 0o600 }, buf, (e) => (e ? rej(e) : res())));
  await add('RESTORE.txt', Buffer.from(RESTORE_TXT({ clusterId, server: info.Name, nodeAddr: sw.NodeAddr })));
  await add('cluster.json', Buffer.from(JSON.stringify(desc, null, 1)));
  if (key && key.value) await add('unlock-key.enc', Buffer.from(key.value));
  if (!rawError) {
    const size = fs.statSync(tmpGz).size;
    await new Promise((res, rej) => { const e = pack.entry({ name: 'swarm-dir.tar.gz', size, mode: 0o600 }, (err) => (err ? rej(err) : res())); fs.createReadStream(tmpGz).pipe(e); });
  }
  pack.finalize();
  await done;
  fs.rmSync(tmpGz, { force: true });
  meta.size = fs.statSync(path.join(DIR, name)).size;
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(meta), { mode: 0o600 });
  // keep the newest KEEP per cluster
  const mine = list().filter(b => b.clusterId === clusterId);
  for (const b of mine.slice(KEEP)) { fs.rmSync(path.join(DIR, b.file), { force: true }); fs.rmSync(path.join(DIR, `${b.file}.json`), { force: true }); }
  logAction({ sourceIp, server: sid, resourceType: 'swarm', resourceName: 'backup', action: 'swarm_backup', details: { file: name, size: meta.size, reason, errors: desc.errors } });
  return meta;
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => FILE_RE.test(f) && fs.existsSync(path.join(DIR, `${f}.json`)))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, `${f}.json`), 'utf8')); } catch (e) { return null; } })
    .filter(Boolean).sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
}
function filePath(name) {
  if (!FILE_RE.test(String(name || ''))) throw bad(400, 'Invalid backup name');
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) throw bad(404, 'Backup not found');
  return p;
}
function nightlyOn() { const r = stmts.getSetting.get('swarm_backup_nightly'); return !r || r.value !== '0'; }
function setNightly(on) { stmts.setSetting.run('swarm_backup_nightly', on ? '1' : '0'); }

// ---- nightly ----
let timer = null;
async function nightlyTick() {
  if (!nightlyOn()) return;
  const seen = new Set();
  const ids = new Set(['local', dockerService.getActiveServerId() || 'local']);
  try { for (const r of db.prepare('SELECT DISTINCT server_id FROM swarm_node_servers').all()) ids.add(r.server_id); } catch (e) { /* none */ }
  for (const id of ids) {
    try {
      const row = id === 'local' ? null : stmts.getServer.get(id);
      if (id !== 'local' && !row) continue;
      const c = id === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(row);
      const info = await c.info();
      const sw = info.Swarm || {};
      if (sw.LocalNodeState !== 'active' || !sw.ControlAvailable || !sw.Cluster || seen.has(sw.Cluster.ID)) continue;
      seen.add(sw.Cluster.ID);
      const last = list().find(b => b.clusterId === sw.Cluster.ID);
      if (last && Date.now() - Date.parse(last.takenAt) < 23 * 3600000) continue;
      await backupWith(c, id, { reason: 'nightly' });
    } catch (e) { console.warn(`[swarm-backup] ${id}:`, e.message); }
  }
}
function start() { if (!timer) { timer = setInterval(() => nightlyTick().catch(() => {}), 3600000); if (timer.unref) timer.unref(); setTimeout(() => nightlyTick().catch(() => {}), 120000).unref?.(); } }

// ---- recovery ----

/** Is the cluster without a leader, as seen from the manager in use? */
async function recoveryInfo() {
  const c = dockerService.docker;
  const info = await c.info();
  const sw = info.Swarm || {};
  const out = { serverName: info.Name, nodeAddr: sw.NodeAddr, manager: !!sw.ControlAvailable, managers: sw.Managers || 0, nodes: sw.Nodes || 0, remoteManagers: (sw.RemoteManagers || []).map(m => m.Addr), lost: false, error: sw.Error || null };
  if (sw.LocalNodeState !== 'active' || !sw.ControlAvailable) return out;
  try { await c.listNodes(); } catch (e) { out.lost = true; out.error = swarm.dockerMsg(e) || e.message; }
  return out;
}

async function startRecover({ confirm, sourceIp } = {}) {
  const c = dockerService.docker;
  const info = await c.info();
  const sw = info.Swarm || {};
  if (sw.LocalNodeState !== 'active' || !sw.ControlAvailable) throw bad(409, 'The server in use is not a manager of a swarm');
  if (String(confirm || '') !== info.Name) throw bad(400, `Type the server name (${info.Name}) to confirm`);
  // Only when the cluster really has no leader: on a healthy cluster --force-new-cluster would throw managers out.
  const ri = await recoveryInfo();
  if (!ri.lost) throw bad(409, 'The cluster has a leader — nothing to recover. Recover cluster is only for when most managers are lost.');
  if (swarm._jobs.busy()) throw bad(409, 'A Swarm job is already running');
  const sid = dockerService.getActiveServerId() || 'local';
  const job = swarm._jobs.newJob('recover'); swarm._jobs.setCurrent(job);
  const log = swarm._jobs.logTo(job), step = swarm._jobs.step;
  (async () => {
    try {
      step(job, 'backup', 'running', 'Back up the swarm state first');
      const b = await backupWith(c, sid, { reason: 'before recover', sourceIp });
      log(`Backup ${b.file} (${Math.round(b.size / 1024)} KB)${b.errors.length ? ` — without: ${b.errors.join('; ')}` : ''}`);
      step(job, 'backup', 'done');
      step(job, 'init', 'running', 'docker swarm init --force-new-cluster');
      const addr = sw.NodeAddr;
      const own = (await swarm.addressCandidates(sid).catch(() => [])).some(a => a.ip === addr);
      log(`$ docker swarm init --force-new-cluster --advertise-addr ${addr}`);
      await c.swarmInit({ ForceNewCluster: true, ListenAddr: `${own ? addr : '0.0.0.0'}:2377`, AdvertiseAddr: addr });
      let nodes = null;
      for (let i = 0; i < 30 && !nodes; i++) { nodes = await c.listNodes().catch(() => null); if (!nodes) await new Promise(r => setTimeout(r, 1000)); }
      if (!nodes) throw new Error('The cluster did not answer after --force-new-cluster');
      log(`✓ ${info.Name} is the only manager now; ${nodes.length} node(s) in the list`);
      step(job, 'init', 'done');
      step(job, 'clean', 'running', 'Remove the managers that are gone');
      const self = (await c.info()).Swarm.NodeID;
      for (const n of nodes.filter(x => x.ID !== self && x.Spec.Role === 'manager' && x.Status.State !== 'ready')) {
        // After --force-new-cluster the old managers are no longer Raft members, so demoting them fails
        // ("can't find manager in raft memberlist") — remove them anyway.
        try { const x = await c.getNode(n.ID).inspect(); await c.getNode(n.ID).update({ version: x.Version.Index, ...x.Spec, Role: 'worker' }); } catch (e) { /* see above */ }
        try {
          await c.getNode(n.ID).remove({ force: true });
          log(`  removed ${n.Description.Hostname} (${n.Status.Addr})`);
        } catch (e) { log(`  could not remove ${n.Description.Hostname}: ${swarm.dockerMsg(e)}`); }
      }
      step(job, 'clean', 'done');
      const workers = (await c.listNodes()).filter(n => n.Spec.Role === 'worker' && n.Status.State === 'ready');
      log(workers.length >= 2 ? `Next: promote two workers (Swarm → Nodes) to have 3 managers again — ${workers.slice(0, 2).map(w => w.Description.Hostname).join(', ')}.` : 'Next: add servers as managers (Swarm → Add servers…) to have 3 managers again.');
      log('A lost manager that comes back must leave its old swarm (docker swarm leave --force) and join again.');
      job.status = 'done';
      logAction({ sourceIp, server: sid, resourceType: 'swarm', resourceName: info.Name, action: 'swarm_force_new_cluster', details: { backup: b.file } });
    } catch (e) {
      job.steps.forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      job.status = 'error'; job.error = swarm.dockerMsg(e) || e.message; log('✗ ' + job.error);
    } finally { job.finishedAt = Date.now(); }
  })();
  return job;
}

module.exports = { backupNow, list, filePath, nightlyOn, setNightly, start, recoveryInfo, startRecover, describe, _dir: DIR };
