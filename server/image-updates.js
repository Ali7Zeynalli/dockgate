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
// Versions read from the image config (local image and the registry's newer one) so the UI can say "15.8 → 15.19".
for (const col of ['local_version TEXT', 'remote_version TEXT', 'remote_created TEXT', 'local_created TEXT']) {
  try { db.exec(`ALTER TABLE image_updates ADD COLUMN ${col}`); } catch (e) { /* already there */ }
}
const upsert = db.prepare(`INSERT INTO image_updates (server_id, image, status, local_digest, remote_digest, error, checked_at, local_version, remote_version, remote_created, local_created)
  VALUES (@server_id, @image, @status, @local_digest, @remote_digest, @error, @checked_at, @local_version, @remote_version, @remote_created, @local_created)
  ON CONFLICT(server_id, image) DO UPDATE SET status = excluded.status, local_digest = excluded.local_digest,
  remote_digest = excluded.remote_digest, error = excluded.error, checked_at = excluded.checked_at,
  local_version = excluded.local_version, remote_version = excluded.remote_version,
  remote_created = excluded.remote_created, local_created = excluded.local_created`);
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

// Env names that carry a helper tool's version, not the image's own (gosu, pip, yarn …).
const HELPER_ENV = /^(GOSU|PYTHON_PIP|PYTHON_SETUPTOOLS|PYTHON_GET_PIP|PIP|SETUPTOOLS|WHEEL|YARN|JSYAML|GPG|DOCKERIZE|TINI|SU_EXEC|NJS|PKG_RELEASE|DYNPKG_RELEASE|ACME|LUA)_VERSION$/;
// Official images whose version variable is not named after the repo.
const ENV_ALIAS = { postgres: 'PG', postgis: 'POSTGIS', mongo: 'MONGO', httpd: 'HTTPD', golang: 'GOLANG', rabbitmq: 'RABBITMQ', 'eclipse-temurin': 'JAVA', openjdk: 'JAVA', elasticsearch: 'ELASTIC', mariadb: 'MARIADB' };

/**
 * The version an image says it is, read from its config: the OCI version label, a <NAME>_VERSION env var
 * named after the repo, or the first other *_VERSION var. null when the image does not say.
 * config: the image's Config ({ Env, Labels }); repo: "postgres", "bitnami/redis", "ghcr.io/x/api".
 */
function versionOf(config, repo) {
  const c = config || {};
  const labels = c.Labels || {};
  const env = {};
  for (const e of c.Env || []) { const i = e.indexOf('='); if (i > 0) env[e.slice(0, i)] = e.slice(i + 1); }
  const base = String(repo || '').split('/').pop().toLowerCase();
  const stem = (ENV_ALIAS[base] || base).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (env[`${stem}_VERSION`]) return env[`${stem}_VERSION`];
  const label = labels['org.opencontainers.image.version'] || labels['org.label-schema.version'] || labels.version;
  if (label && !/^(latest|stable)$/i.test(label)) return String(label).slice(0, 60);
  const other = Object.keys(env).find(k => /_VERSION$/.test(k) && !HELPER_ENV.test(k));
  return other ? String(env[other]).slice(0, 60) : null;
}

/** The daemon's platform, for picking the matching image from a multi-arch tag. */
async function platformOf(docker) {
  try {
    const v = await docker.version();
    const arch = { x86_64: 'amd64', aarch64: 'arm64' }[v.Arch] || v.Arch || 'amd64';
    return { os: v.Os || 'linux', arch };
  } catch (e) { return { os: 'linux', arch: 'amd64' }; }
}

function tagMap(images) {
  const m = new Map();
  for (const i of images) for (const t of i.RepoTags || []) if (t && t !== '<none>:<none>') m.set(t, i);
  return m;
}
/** The local image a reference points at ("nginx" means "nginx:latest"; Hub names may carry docker.io/). */
function tagged(byTag, ref) {
  const r = String(ref || '');
  const lastSeg = r.split('/').pop();
  const withTag = lastSeg.includes(':') ? r : `${r}:latest`;
  return byTag.get(r) || byTag.get(withTag) || byTag.get(withTag.replace(/^docker\.io\/(library\/)?/, '')) || null;
}

/**
 * Containers that run an older image than their tag points at on this server — another container with the
 * same tag was updated, or the image was pulled by hand. Map container ID → { imageId, version, created }.
 */
async function staleContainers(docker) {
  const [containers, images] = await Promise.all([docker.listContainers({ all: true }), docker.listImages({ all: false })]);
  const byTag = tagMap(images);
  const out = new Map();
  const facts = new Map();
  for (const c of containers) {
    // Docker lists the image ID instead of the tag once the tag points at another image — read the tag
    // the container was created with from its config.
    let image = c.Image;
    if (!parseRef(image) && /^(sha256:)?[0-9a-f]{12,64}$/.test(String(image))) {
      try { image = (await docker.getContainer(c.Id).inspect()).Config.Image; } catch (e) { continue; }
    }
    const ref = parseRef(image);
    if (!ref || ref.pinned) continue;
    const t = tagged(byTag, image);
    if (!t || t.Id === c.ImageID) continue;
    if (!facts.has(t.Id)) {
      let f = { imageId: t.Id, version: null, created: null };
      try { const full = await docker.getImage(t.Id).inspect(); f = { imageId: t.Id, version: versionOf(full.Config, ref.repo), created: full.Created ? String(full.Created).slice(0, 19) : null }; } catch (e) { /* keep ids */ }
      facts.set(t.Id, f);
    }
    out.set(c.Id, { ...facts.get(t.Id), image });
  }
  return out;
}

/**
 * Check one server. docker: a dockerode client for it. Returns the rows stored for that server.
 * fetchDigest is injectable for tests.
 */
async function checkServer(serverId, docker, { fetchDigest = registry.getRemoteDigest, fetchConfig = registry.getRemoteConfig } = {}) {
  const [containers, images] = await Promise.all([docker.listContainers({ all: true }), docker.listImages({ all: false })]);
  const byId = new Map(images.map(i => [i.Id, i]));
  const byTag = tagMap(images);
  const refs = new Map(); // image ref → the image its tag points at here (falls back to the container's image)
  for (const c of containers) if (c.Image && !refs.has(c.Image)) refs.set(c.Image, tagged(byTag, c.Image) || byId.get(c.ImageID) || null);
  const now = Date.now();
  const cache = new Map(); // host/repo:tag → digest | Error (same image on many containers)
  const cfgCache = new Map(); // host/repo:tag → remote config | null
  let platform = null;
  for (const [image, img] of refs) {
    const ref = parseRef(image);
    let row = { server_id: serverId, image, status: 'skip', local_digest: null, remote_digest: null, error: null, checked_at: now, local_version: null, remote_version: null, remote_created: null, local_created: null };
    if (img && ref && !ref.pinned) {
      try {
        const full = await docker.getImage(img.Id).inspect();
        row.local_version = versionOf(full.Config, ref.repo);
        row.local_created = full.Created ? String(full.Created).slice(0, 19) : null;
      } catch (e) { /* version stays unknown */ }
    }
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
        else {
          row = { ...row, status: local.includes(remote) ? 'current' : 'update', local_digest: local[0], remote_digest: remote };
          if (row.status === 'update') {
            if (!cfgCache.has(key)) {
              if (!platform) platform = await platformOf(docker);
              try { cfgCache.set(key, await fetchConfig(registryFor(ref.host), ref.repo, ref.tag, platform)); }
              catch (e) { cfgCache.set(key, null); }
            }
            const rc = cfgCache.get(key);
            if (rc) { row.remote_version = versionOf(rc.config, ref.repo); row.remote_created = rc.created ? String(rc.created).slice(0, 19) : null; }
          }
        }
      }
    }
    upsert.run(row);
  }
  dropOthers(serverId, new Set(refs.keys()));
  return listFor.all(serverId);
}

function resultsFor(serverId) { return listFor.all(serverId); }
function resultFor(serverId, image) { return db.prepare('SELECT * FROM image_updates WHERE server_id = ? AND image = ?').get(serverId, image) || null; }

/**
 * After an update or a roll back the local image changed: set the stored row from what is local now,
 * against the registry digest of the last check (no registry call).
 */
function refreshLocal(serverId, image, { digests = [], version = null, created = null } = {}) {
  const r = resultFor(serverId, image);
  if (!r || !r.remote_digest) return;
  const status = digests.includes(r.remote_digest) ? 'current' : 'update';
  db.prepare('UPDATE image_updates SET status = ?, local_digest = ?, local_version = ?, local_created = ? WHERE server_id = ? AND image = ?')
    .run(status, digests[0] || r.local_digest, version, created, serverId, image);
}

/** Updates not announced yet (a new remote digest since the last alert). */
function unannounced(serverId) {
  return listFor.all(serverId).filter(r => r.status === 'update' && r.notified_digest !== r.remote_digest);
}
function announce(serverId, rows) { for (const r of rows) markNotified.run(r.remote_digest, serverId, r.image); }

module.exports = { staleContainers, parseRef, registryFor, localDigests, versionOf, platformOf, checkServer, resultsFor, resultFor, refreshLocal, unannounced, announce };
