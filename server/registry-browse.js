// Read-only browse of a private Docker registry via the Registry HTTP API v2 (the "token-dance" auth).
// Used by the Registries "Browse" view to list a KNOWN repo's tags and per-tag digest/size. Works on any
// spec-compliant registry — ghcr.io, registry.gitlab.com, quay.io, self-hosted registry:2 — and Docker
// Hub (registry-1.docker.io). Full /v2/_catalog enumeration is intentionally NOT done here (Docker Hub
// and GHCR don't support it); the caller passes a known repo (auto-tracked on push, or user-pinned).
// Stored passwords/PATs are decrypted per call and used only as the Basic credential to fetch a bearer
// token — never logged.

const { decrypt } = require('./auth/secrets');

const HUB_ALIASES = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'https://index.docker.io/v1/'];
const TIMEOUT_MS = 12000;

// Map a stored server_address to the registry's v2 API base URL.
function apiBase(serverAddress) {
  if (HUB_ALIASES.includes(serverAddress)) return 'https://registry-1.docker.io';
  const host = String(serverAddress).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return 'https://' + host;
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// Registrable-ish domain (last two labels). Used to confirm a token realm belongs to the same provider
// as the configured registry before sending it the credential — auth.docker.io ⟷ registry-1.docker.io,
// gitlab.com ⟷ registry.gitlab.com, ghcr.io, quay.io all share their last two labels.
function baseDomain(host) {
  return String(host || '').toLowerCase().split('.').slice(-2).join('.');
}

// Docker Hub's v2 API needs official single-name images under the "library/" namespace (nginx → library/nginx).
function normRepo(serverAddress, repo) {
  return (HUB_ALIASES.includes(serverAddress) && !repo.includes('/')) ? 'library/' + repo : repo;
}

// Parse  WWW-Authenticate: Bearer realm="…",service="…",scope="…"
function parseBearer(header) {
  if (!header || !/^Bearer/i.test(header)) return null;
  const out = {};
  for (const m of header.replace(/^Bearer\s*/i, '').matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function fetchT(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// A v2 GET with the token dance: try unauthenticated; on 401 read WWW-Authenticate, exchange the stored
// Basic credential for a bearer token at the realm, then retry. `scope` overrides the default pull scope.
async function v2Get(registry, path, { scope, accept } = {}) {
  const url = apiBase(registry.server_address) + path;
  const headers = {};
  if (accept) headers.Accept = accept;
  let res = await fetchT(url, { headers });
  if (res.status === 401) {
    const wa = parseBearer(res.headers.get('www-authenticate'));
    if (wa && wa.realm) {
      const tokenUrl = new URL(wa.realm);
      if (wa.service) tokenUrl.searchParams.set('service', wa.service);
      const useScope = scope || wa.scope;
      if (useScope) tokenUrl.searchParams.set('scope', useScope);
      const tHeaders = {};
      if (registry.username) {
        // Only hand the stored credential to a realm that is HTTPS and on the SAME domain as the
        // configured registry — a malicious/compromised registry (or a MITM on the unauthenticated
        // /v2/ probe) must not redirect the admin's PAT to another host, least of all over cleartext.
        const expectedHost = new URL(apiBase(registry.server_address)).host;
        if (tokenUrl.protocol !== 'https:') throw new Error('Registry auth realm is not HTTPS — refusing to send the credential');
        if (baseDomain(tokenUrl.hostname) !== baseDomain(expectedHost)) {
          throw new Error(`Registry auth realm host "${tokenUrl.hostname}" doesn't match the registry — refusing to send the credential`);
        }
        const pw = registry.password ? decrypt(registry.password) : '';
        tHeaders.Authorization = basicAuth(registry.username, pw);
      }
      const tRes = await fetchT(tokenUrl.toString(), { headers: tHeaders });
      if (!tRes.ok) throw new Error(`Registry auth failed (${tRes.status})`);
      const tJson = await tRes.json().catch(() => ({}));
      const token = tJson.token || tJson.access_token;
      if (!token) throw new Error('No token returned by registry auth');
      res = await fetchT(url, { headers: { ...headers, Authorization: 'Bearer ' + token } });
    }
  }
  return res;
}

// List all tags for a known repo (follows Link pagination, capped to keep it bounded).
async function listTags(registry, repoIn) {
  const repo = normRepo(registry.server_address, repoIn);
  const scope = `repository:${repo}:pull`;
  let path = `/v2/${repo}/tags/list?n=100`;
  const tags = [];
  for (let i = 0; i < 10 && path; i++) {            // cap ~1000 tags
    const res = await v2Get(registry, path, { scope });
    if (res.status === 404) throw new Error('Repository not found (or no access for this credential)');
    if (res.status === 401 || res.status === 403) throw new Error('Not authorized for this repository');
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    const json = await res.json().catch(() => ({}));
    if (Array.isArray(json.tags)) tags.push(...json.tags);
    const link = res.headers.get('link');
    const m = link && link.match(/<([^>]+)>\s*;\s*rel="next"/i);
    path = m ? m[1].replace(/^https?:\/\/[^/]+/, '') : null;  // path-only (same host)
  }
  return tags;
}

// Digest + total (config + layers) size for repo:ref, read from the manifest. Returns 0 size for a
// multi-arch manifest list (no per-layer sizes at that level) — acceptable for an at-a-glance view.
async function getManifestInfo(registry, repoIn, ref) {
  const repo = normRepo(registry.server_address, repoIn);
  const scope = `repository:${repo}:pull`;
  const accept = [
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.index.v1+json',
  ].join(', ');
  const res = await v2Get(registry, `/v2/${repo}/manifests/${encodeURIComponent(ref)}`, { scope, accept });
  if (!res.ok) throw new Error(`Manifest ${res.status}`);
  const digest = res.headers.get('docker-content-digest') || null;
  const json = await res.json().catch(() => ({}));
  let size = 0;
  if (json.config && typeof json.config.size === 'number') size += json.config.size;
  if (Array.isArray(json.layers)) for (const l of json.layers) size += (l.size || 0);
  return { digest, size };
}

module.exports = { listTags, getManifestInfo, apiBase };
