// Newer-image check: for every image a container uses, ask its registry for the digest of the same tag and
// compare it with the digests `docker pull` recorded locally (RepoDigests). Nothing is pulled or changed —
// the result only says "newer image", "up to date" or why it could not be checked. Runs once a day for
// every server and on demand ("Check for updates") for the server in use.
const { stmts, db } = require('./db');
const registry = require('./registry-browse');

db.exec(`CREATE TABLE IF NOT EXISTS image_updates (
  server_id TEXT NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL,          -- update | current | error | skip
  local_digest TEXT,
  remote_digest TEXT,
  error TEXT,
  checked_at INTEGER,
  notified_digest TEXT,
  PRIMARY KEY (server_id, image)
)`);
const upsert = db.prepare(`INSERT INTO image_updates (server_id, image, status, local_digest, remote_digest, error, checked_at)
  VALUES (@server_id, @image, @status, @local_digest, @remote_digest, @error, @checked_at)
  ON CONFLICT(server_id, image) DO UPDATE SET status = excluded.status, local_digest = excluded.local_digest,
  remote_digest = excluded.remote_digest, error = excluded.error, checked_at = excluded.checked_at`);
const listFor = db.prepare('SELECT * FROM image_updates WHERE server_id = ?');
const markNotified = db.prepare('UPDATE image_updates SET notified_digest = ? WHERE server_id = ? AND image = ?');
const dropOthers = (serverId, keep) => {
  const rows = listFor.all(serverId);
  for (const r of rows) if (!keep.has(r.image)) db.prepare('DELETE FROM image_updates WHERE server_id = ? AND image = ?').run(serverId, r.image);
};

/** "nginx:1.27" → { host: 'docker.io', repo: 'nginx', tag: '1.27' }. null for image IDs; pinned for @sha256 refs. */
function parseRef(ref) {
  const s = String(ref || '').trim();
  if (!s || /^sha256:/.test(s) || /^[0-9a-f]{12,64}$/.test(s)) return null;
  if (s.includes('@')) return { pinned: true };
  const parts = s.split('/');
  let host = 'docker.io';
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) host = parts.shift();
  let rest = parts.join('/');
  let tag = 'latest';
  const i = rest.lastIndexOf(':');
  if (i > 0) { tag = rest.slice(i + 1); rest = rest.slice(0, i); }
  return { host, repo: rest, tag };
}

/** Stored login for a registry host, or an anonymous one. */
function registryFor(host) {
  const norm = (a) => String(a || '').replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const hub = registry.HUB_ALIASES.map(norm);
  const want = hub.includes(host) ? hub : [host];
  const row = stmts.getRegistries.all().find(r => want.includes(norm(r.server_address)));
  return row || { server_address: host };
}

/** The digests of `repo` this image was pulled with (RepoDigests "repo@sha256:…"). */
function localDigests(image, ref) {
  const want = new Set([ref.repo, `${ref.host}/${ref.repo}`, ref.host === 'docker.io' && !ref.repo.includes('/') ? `library/${ref.repo}` : null].filter(Boolean));
  return (image.RepoDigests || []).map(d => d.split('@')).filter(([r]) => want.has(r) || want.has(r.replace(/^docker\.io\//, ''))).map(([, d]) => d);
}

/**
 * Check one server. docker: a dockerode client for it. Returns the rows stored for that server.
 * fetchDigest is injectable for tests.
 */
async function checkServer(serverId, docker, { fetchDigest = registry.getRemoteDigest } = {}) {
  const [containers, images] = await Promise.all([docker.listContainers({ all: true }), docker.listImages({ all: false })]);
  const byId = new Map(images.map(i => [i.Id, i]));
  const refs = new Map(); // image ref → image
  for (const c of containers) if (c.Image && !refs.has(c.Image)) refs.set(c.Image, byId.get(c.ImageID) || null);
  const now = Date.now();
  const cache = new Map(); // host/repo:tag → digest | Error (same image on many containers)
  for (const [image, img] of refs) {
    const ref = parseRef(image);
    let row = { server_id: serverId, image, status: 'skip', local_digest: null, remote_digest: null, error: null, checked_at: now };
    if (!ref) row.error = 'started from an image ID';
    else if (ref.pinned) row.error = 'pinned to a digest';
    else if (!img) row.error = 'image not found locally';
    else {
      const local = localDigests(img, ref);
      if (!local.length) row.error = 'built here or loaded from a file (no registry digest)';
      else {
        const key = `${ref.host}/${ref.repo}:${ref.tag}`;
        if (!cache.has(key)) {
          try { cache.set(key, await fetchDigest(registryFor(ref.host), ref.repo, ref.tag)); }
          catch (e) { cache.set(key, e instanceof Error ? e : new Error(String(e))); }
        }
        const remote = cache.get(key);
        if (remote instanceof Error) row = { ...row, status: 'error', local_digest: local[0], error: remote.message.slice(0, 200) };
        else row = { ...row, status: local.includes(remote) ? 'current' : 'update', local_digest: local[0], remote_digest: remote };
      }
    }
    upsert.run(row);
  }
  dropOthers(serverId, new Set(refs.keys()));
  return listFor.all(serverId);
}

function resultsFor(serverId) { return listFor.all(serverId); }

/** Updates not announced yet (a new remote digest since the last alert). */
function unannounced(serverId) {
  return listFor.all(serverId).filter(r => r.status === 'update' && r.notified_digest !== r.remote_digest);
}
function announce(serverId, rows) { for (const r of rows) markNotified.run(r.remote_digest, serverId, r.image); }

module.exports = { parseRef, registryFor, localDigests, checkServer, resultsFor, unannounced, announce };
