// Newer images for Swarm services. A service's image is pinned to a digest when it is created or updated
// (nginx:1.27@sha256:…), so every node runs the same build. Here that digest is compared with the digest the
// registry gives for the same tag now. Nothing is pulled or changed. "Update to newest" writes tag@newDigest,
// so all nodes get exactly that build. Checked once a day with the container check, and on demand.
const { db } = require('./db');
const IU = require('./image-updates');
const registry = require('./registry-browse');

db.exec(`CREATE TABLE IF NOT EXISTS swarm_image_updates (
  cluster_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_name TEXT,
  image TEXT,                    -- repo:tag (no digest)
  status TEXT NOT NULL,          -- update | current | error | skip
  current_digest TEXT,
  remote_digest TEXT,
  remote_version TEXT,
  remote_created TEXT,
  error TEXT,
  checked_at INTEGER,
  notified_digest TEXT,
  PRIMARY KEY (cluster_id, service_id)
)`);
const upsert = db.prepare(`INSERT INTO swarm_image_updates (cluster_id, service_id, service_name, image, status, current_digest, remote_digest, remote_version, remote_created, error, checked_at)
  VALUES (@cluster_id, @service_id, @service_name, @image, @status, @current_digest, @remote_digest, @remote_version, @remote_created, @error, @checked_at)
  ON CONFLICT(cluster_id, service_id) DO UPDATE SET service_name = excluded.service_name, image = excluded.image, status = excluded.status,
  current_digest = excluded.current_digest, remote_digest = excluded.remote_digest, remote_version = excluded.remote_version,
  remote_created = excluded.remote_created, error = excluded.error, checked_at = excluded.checked_at`);
const listFor = db.prepare('SELECT * FROM swarm_image_updates WHERE cluster_id = ?');

/** "nginx:1.27@sha256:abc" → { tagRef: 'nginx:1.27', digest: 'sha256:abc' } */
function splitImage(image) {
  const s = String(image || '');
  const i = s.indexOf('@');
  return i < 0 ? { tagRef: s, digest: null } : { tagRef: s.slice(0, i), digest: s.slice(i + 1) };
}

/**
 * Check every service of the cluster c manages. Returns the stored rows. fetchDigest/fetchConfig are
 * injectable for tests.
 */
async function check(c, clusterId, { fetchDigest = registry.getRemoteDigest, fetchConfig = registry.getRemoteConfig } = {}) {
  const services = await c.listServices();
  const now = Date.now();
  const cache = new Map();
  const keep = new Set();
  let platform = null;
  for (const s of services) {
    keep.add(s.ID);
    const { tagRef, digest } = splitImage(s.Spec.TaskTemplate.ContainerSpec.Image);
    const ref = IU.parseRef(tagRef);
    const row = { cluster_id: clusterId, service_id: s.ID, service_name: s.Spec.Name, image: tagRef, status: 'skip', current_digest: digest, remote_digest: null, remote_version: null, remote_created: null, error: null, checked_at: now };
    if (!ref || ref.pinned) row.error = 'not a tag';
    else if (!digest) row.error = 'no digest recorded (created with --no-resolve-image or a local image)';
    else {
      const key = `${ref.host}/${ref.repo}:${ref.tag}`;
      if (!cache.has(key)) {
        try { cache.set(key, await fetchDigest(IU.registryFor(ref.host), ref.repo, ref.tag)); }
        catch (e) { cache.set(key, e instanceof Error ? e : new Error(String(e))); }
      }
      const remote = cache.get(key);
      if (remote instanceof Error) { row.status = 'error'; row.error = remote.message.slice(0, 200); }
      else {
        row.remote_digest = remote;
        row.status = remote === digest ? 'current' : 'update';
        if (row.status === 'update') {
          try {
            if (!platform) platform = await IU.platformOf(c);
            const rc = await fetchConfig(IU.registryFor(ref.host), ref.repo, ref.tag, platform);
            if (rc) { row.remote_version = IU.versionOf(rc.config, ref.repo); row.remote_created = rc.created ? String(rc.created).slice(0, 19) : null; }
          } catch (e) { /* version unknown */ }
        }
      }
    }
    upsert.run(row);
  }
  for (const r of listFor.all(clusterId)) if (!keep.has(r.service_id)) db.prepare('DELETE FROM swarm_image_updates WHERE cluster_id = ? AND service_id = ?').run(clusterId, r.service_id);
  return listFor.all(clusterId);
}

function results(clusterId) {
  const out = {};
  for (const r of listFor.all(clusterId)) out[r.service_id] = r;
  return out;
}
/** Rows with a newer image not announced yet (one notice per new digest). */
function unannounced(clusterId) { return listFor.all(clusterId).filter(r => r.status === 'update' && r.notified_digest !== r.remote_digest); }
function announce(clusterId, rows) { for (const r of rows) db.prepare('UPDATE swarm_image_updates SET notified_digest = ? WHERE cluster_id = ? AND service_id = ?').run(r.remote_digest, clusterId, r.service_id); }

/** Daily check for every cluster a known server manages; announces new updates once. */
async function checkAll() {
  const { stmts } = require('./db');
  const dockerService = require('./docker');
  const HM = require('./notifications/health-monitor');
  const servers = [{ id: 'local', type: 'local', name: 'Local' }, ...stmts.getServers.all().filter(x => x.id !== 'local' && x.type !== 'local')];
  const done = new Set();
  for (const srv of servers) {
    try {
      const c = srv.id === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(srv);
      const info = await c.info();
      const sw = info.Swarm || {};
      if (sw.LocalNodeState !== 'active' || !sw.ControlAvailable || !sw.Cluster || done.has(sw.Cluster.ID)) continue;
      done.add(sw.Cluster.ID);
      await check(c, sw.Cluster.ID);
      const fresh = unannounced(sw.Cluster.ID);
      if (!fresh.length) continue;
      const name = HM.serverLabel(srv);
      const list = fresh.map(r => `${r.service_name} (${r.image})`).join(', ');
      const sent = await HM.deliver('image_update', srv, `${name}: newer image${fresh.length > 1 ? 's' : ''} for Swarm services`,
        `🔵 Swarm on ${name}: newer image${fresh.length > 1 ? 's' : ''} available\n${list}\nUpdate them from Swarm → Services.`,
        `<p>Swarm on ${name.replace(/</g, '&lt;')}: a newer version of the same tag is in the registry for <b>${list.replace(/</g, '&lt;')}</b>.</p><p>Update them from DockGate → Swarm → Services.</p>`);
      if (sent || !(stmts.getRule.get('image_update') || {}).enabled) announce(sw.Cluster.ID, fresh);
    } catch (e) { console.warn(`[swarm-images] ${srv.id}:`, e.message); }
  }
}

module.exports = { splitImage, check, results, unannounced, announce, checkAll };
