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
const TTL_MS = 10 * 60 * 1000; // cache remote catalogs for 10 minutes
let cache = { at: 0, url: null, data: null };

function loadBundled() {
  try { return JSON.parse(fs.readFileSync(BUNDLED, 'utf8')); }
  catch (e) { return { version: '2', templates: [] }; }
}

// GET /api/templates — return the catalog ({ version, templates[], source }).
router.get('/', async (req, res) => {
  try {
    const url = (stmts.getSetting.get('template_url')?.value || '').trim();
    if (!url) return res.json({ ...loadBundled(), source: 'bundled' });

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
// Proxied server-side to avoid browser CORS. Only http(s) URLs are accepted.
router.get('/stackfile', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http(s) URLs are allowed' });
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).json({ error: `Upstream HTTP ${r.status}` });
    const yaml = await r.text();
    res.json({ yaml });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
