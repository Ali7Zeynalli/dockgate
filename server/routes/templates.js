const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { stmts } = require('../db');

// App templates (Portainer "App Templates" v2 format).
// Source: the `template_url` setting if set (cached), otherwise the bundled catalog shipped with DockGate.
// The bundled set works fully offline; pointing template_url at an aggregated list (e.g. a community
// catalog) yields 100+ apps when online.
const BUNDLED = path.join(__dirname, '..', 'templates.json');
// When `template_url` is unset/empty we default to this community catalog (500+ apps) so the page
// auto-loads a big list out of the box. The user can set a custom URL, or the sentinel 'bundled'
// to force the offline set only.
const DEFAULT_CATALOG = 'https://raw.githubusercontent.com/Lissy93/portainer-templates/main/templates.json';
const TTL_MS = 10 * 60 * 1000; // cache remote catalogs for 10 minutes
let cache = { at: 0, url: null, data: null };

function loadBundled() {
  try { return JSON.parse(fs.readFileSync(BUNDLED, 'utf8')); }
  catch (e) { return { version: '2', templates: [] }; }
}

// GET /api/templates — return the catalog ({ version, templates[], source }).
router.get('/', async (req, res) => {
  try {
    const setting = (stmts.getSetting.get('template_url')?.value || '').trim();
    if (setting === 'bundled') return res.json({ ...loadBundled(), source: 'bundled' });
    // Empty/unset → the default community catalog (auto-load); any other value is a custom URL.
    const url = setting || DEFAULT_CATALOG;

    if (cache.data && cache.url === url && (Date.now() - cache.at) < TTL_MS) {
      return res.json({ ...cache.data, source: 'remote', url });
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      cache = { at: Date.now(), url, data };
      return res.json({ ...data, source: 'remote', url });
    } catch (e) {
      // Remote unreachable / invalid → fall back to the bundled set and report why
      return res.json({ ...loadBundled(), source: 'bundled-fallback', error: e.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/templates/stackfile?url=... — fetch a compose stackfile referenced by a stack template.
// Proxied server-side to avoid browser CORS. http(s) only, SSRF-guarded (no internal/metadata hosts;
// redirects rejected — a public host could otherwise bounce into the private network). isBlockedLogoHost
// is hoisted (function declaration below).
router.get('/stackfile', async (req, res) => {
  try {
    const raw = String(req.query.url || '');
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ error: 'bad url' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).json({ error: 'Only http(s) URLs are allowed' });
    if (isBlockedLogoHost(u.hostname)) return res.status(400).json({ error: 'blocked host' });
    const r = await fetch(raw, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    if (!r.ok) return res.status(502).json({ error: r.type === 'opaqueredirect' ? 'redirects are not allowed' : `Upstream HTTP ${r.status}` });
    const yaml = await r.text();
    res.json({ yaml });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/templates/hubstats?image=<image> — Docker Hub popularity (pull/star count) for a template's
// image. Proxied server-side (CORS) and cached. Non-Docker-Hub registries (ghcr.io, quay.io…) → unavailable.
const hubCache = new Map(); // repo → { at, data }
const HUB_TTL_MS = 60 * 60 * 1000; // 1 hour

// Resolve a docker image reference to a Docker Hub repo path ('library/<name>' for official), or null.
function hubRepoOf(image) {
  let ref = String(image || '').trim().split('@')[0]; // drop digest
  if (!ref) return null;
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) ref = ref.slice(0, lastColon); // drop :tag (but keep registry:port before a /)
  const firstSeg = ref.split('/')[0];
  if (firstSeg.includes('.') || firstSeg.includes(':')) return null; // a registry host → not Docker Hub
  return ref.includes('/') ? ref : 'library/' + ref; // official images live under library/
}

router.get('/hubstats', async (req, res) => {
  try {
    const repo = hubRepoOf(req.query.image);
    if (!repo) return res.json({ available: false, reason: 'not on Docker Hub' });
    const cached = hubCache.get(repo);
    if (cached && Date.now() - cached.at < HUB_TTL_MS) return res.json(cached.data);
    let data;
    try {
      const r = await fetch(`https://hub.docker.com/v2/repositories/${repo}/`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) data = { available: false };
      else {
        const j = await r.json();
        const isOfficial = repo.startsWith('library/');
        data = {
          available: true,
          repo,
          pulls: j.pull_count || 0,
          stars: j.star_count || 0,
          description: j.description || '',
          url: isOfficial ? `https://hub.docker.com/_/${repo.slice('library/'.length)}` : `https://hub.docker.com/r/${repo}`,
        };
      }
    } catch (e) { data = { available: false }; }
    hubCache.set(repo, { at: Date.now(), data });
    res.json(data);
  } catch (err) { res.json({ available: false, error: err.message }); }
});

// GET /api/templates/logo?url=<external image URL> — same-origin proxy for template logos.
// Template logos live on assorted external hosts; some respond with
// `Cross-Origin-Resource-Policy: same-origin`, so the browser BLOCKS the <img> and logs a CORP
// warning. Re-serving the bytes from our own origin removes the warning AND makes those blocked
// logos render. The response is browser-cacheable (Cache-Control), so each logo hits the upstream
// at most once per cache window.
const LOGO_TTL_S = 24 * 60 * 60;          // browser cache lifetime (1 day)
const LOGO_MAX_BYTES = 2 * 1024 * 1024;   // logos are tiny — reject anything over 2MB

// Basic SSRF guard for a self-hosted panel: reject obvious internal / non-public targets.
// Note: only the literal hostname is checked — a public host that redirects/resolves to an
// internal IP is not caught (acceptable for an operator-only self-hosted tool).
function isBlockedLogoHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 loopback/ULA/link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;          // loopback / private / "this host"
    if (a === 169 && b === 254) return true;                    // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
  }
  return false;
}

router.get('/logo', async (req, res) => {
  try {
    const raw = String(req.query.url || '');
    let u;
    try { u = new URL(raw); } catch { return res.status(400).send('bad url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).send('only http(s)');
    if (isBlockedLogoHost(u.hostname)) return res.status(400).send('blocked host');

    const r = await fetch(raw, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { Accept: 'image/*' } });
    if (!r.ok) return res.status(502).send('upstream ' + r.status);

    const ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (!ct.startsWith('image/') && ct !== 'application/octet-stream') return res.status(415).send('not an image');

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > LOGO_MAX_BYTES) return res.status(413).send('too large');

    res.setHeader('Content-Type', ct.startsWith('image/') ? ct : 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', `public, max-age=${LOGO_TTL_S}`);
    return res.send(buf);
  } catch (err) {
    // Network/timeout/abort → 502; the <img> onerror handler then hides the broken logo cleanly.
    return res.status(502).send('logo proxy error');
  }
});

module.exports = router;
