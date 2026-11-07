// IP lists for firewall port sources: official lists (Cloudflare, GitHub webhooks, UptimeRobot) that
// DockGate fetches only when asked, and the user's own named lists. A port's sources are stored on the
// server itself (one firewall rule per source); DockGate recognises a list on a port when every address
// of the list is there, and marks it "outdated" when the port still holds the list's previous version.
const https = require('https');
const ipaddr = require('ipaddr.js');
const { db } = require('../db');

db.exec(`CREATE TABLE IF NOT EXISTS ip_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- official | custom
  items TEXT NOT NULL DEFAULT '[]',
  prev_items TEXT,               -- the version before the last update (to find ports still on it)
  fetched_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ---------------------------------------------------------------- addresses
/** Canonical form of an IP or CIDR (network address, compact IPv6, /32 and /128 dropped) or null. */
function normalizeSource(s) {
  const v = String(s || '').trim();
  if (!v || v.length > 64) return null;
  try {
    if (v.includes('/')) {
      const [addr, len] = ipaddr.parseCIDR(v);
      const max = addr.kind() === 'ipv4' ? 32 : 128;
      if (len === max) return fmt(addr);
      // zero the host bits (ipaddr.js 1.x has no IPv6 networkAddressFromCIDR)
      const bytes = addr.toByteArray().map((b, i) => { const keep = Math.max(0, Math.min(8, len - i * 8)); return b & (0xff << (8 - keep)) & 0xff; });
      return `${fmt(ipaddr.fromByteArray(bytes))}/${len}`;
    }
    if (!ipaddr.isValid(v)) return null;
    return fmt(ipaddr.parse(v));
  } catch (e) { return null; }
}
const fmt = (a) => (a.kind() === 'ipv6' ? (a.isIPv4MappedAddress() ? a.toIPv4Address().toString() : a.toRFC5952String()) : a.toString());
const isV6 = (s) => String(s).includes(':');

/** Parse pasted text (lines, spaces, commas) → { valid: [...canonical], invalid: [...raw] } (deduplicated). */
function parseSourceText(text) {
  const valid = [], invalid = [];
  for (const raw of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const n = normalizeSource(raw);
    if (n) { if (!valid.includes(n)) valid.push(n); } else invalid.push(raw);
  }
  return { valid, invalid };
}

/** Is the address ip inside source (an IP or CIDR)? */
function sourceContains(source, ip) {
  try {
    const a = ipaddr.process(ip);
    if (source === 'any') return true;
    if (source.includes('/')) {
      const [net, len] = ipaddr.parseCIDR(source);
      return a.kind() === net.kind() && a.match(net, len);
    }
    const b = ipaddr.process(source);
    return a.kind() === b.kind() && a.toString() === b.toString();
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- official lists
// Defaults so the lists work before the first fetch (Cloudflare and GitHub publish these ranges).
const OFFICIAL = {
  cloudflare: {
    name: 'Cloudflare', source: 'cloudflare.com/ips-v4 · /ips-v6',
    urls: ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'],
    parse: (bodies) => bodies.join('\n'),
    defaults: ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'],
  },
  github: {
    name: 'GitHub webhooks', source: 'api.github.com/meta → hooks',
    urls: ['https://api.github.com/meta'],
    parse: (bodies) => (JSON.parse(bodies[0]).hooks || []).join('\n'),
    defaults: ['192.30.252.0/22', '185.199.108.0/22', '140.82.112.0/20', '143.55.64.0/20', '2a0a:a440::/29', '2606:50c0::/32'],
  },
  uptimerobot: {
    name: 'UptimeRobot', source: 'uptimerobot.com/inc/files/ips/IPv4andIPv6.txt',
    urls: ['https://uptimerobot.com/inc/files/ips/IPv4andIPv6.txt'],
    parse: (bodies) => bodies.join('\n'),
    defaults: [],
  },
};

const stmts = {
  all: db.prepare('SELECT * FROM ip_lists ORDER BY kind DESC, name'),
  get: db.prepare('SELECT * FROM ip_lists WHERE id = ?'),
  insert: db.prepare('INSERT OR IGNORE INTO ip_lists (id, name, kind, items) VALUES (?, ?, ?, ?)'),
  update: db.prepare("UPDATE ip_lists SET name = ?, items = ?, prev_items = ?, fetched_at = COALESCE(?, fetched_at), updated_at = datetime('now') WHERE id = ?"),
  del: db.prepare("DELETE FROM ip_lists WHERE id = ? AND kind = 'custom'"),
};
for (const [id, d] of Object.entries(OFFICIAL)) stmts.insert.run(id, d.name, 'official', JSON.stringify(d.defaults.map(normalizeSource)));

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
function rowOut(r) {
  if (!r) return null;
  const items = JSON.parse(r.items || '[]');
  return {
    id: r.id, name: r.name, kind: r.kind, items, prevItems: r.prev_items ? JSON.parse(r.prev_items) : null,
    source: r.kind === 'official' ? OFFICIAL[r.id].source : null, fetchedAt: r.fetched_at, updatedAt: r.updated_at,
    v4: items.filter(x => !isV6(x)).length, v6: items.filter(isV6).length,
  };
}
const all = () => stmts.all.all().map(rowOut);
const get = (id) => rowOut(stmts.get.get(String(id)));

function cleanItems(items) {
  const { valid, invalid } = parseSourceText(Array.isArray(items) ? items.join('\n') : items);
  if (invalid.length) throw httpError(400, `Not an IP address or range: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}`);
  if (valid.some(v => v === '0.0.0.0/0' || v === '::/0')) throw httpError(400, 'Use "Anyone" instead of 0.0.0.0/0 or ::/0');
  if (valid.length > 500) throw httpError(400, 'A list can hold at most 500 addresses');
  return valid;
}
const cleanName = (n) => { const s = String(n || '').trim(); if (!s || s.length > 40 || /[<>]/.test(s)) throw httpError(400, 'Give the list a name (up to 40 characters)'); return s; };

/** Create or edit one of the user's lists. */
function saveCustom(id, { name, items }) {
  const nm = cleanName(name), list = cleanItems(items);
  if (!list.length) throw httpError(400, 'Add at least one address');
  if (!id) {
    id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    stmts.insert.run(id, nm, 'custom', JSON.stringify(list));
    return get(id);
  }
  const cur = get(id);
  if (!cur) throw httpError(404, 'List not found');
  if (cur.kind !== 'custom') throw httpError(400, 'Official lists are updated from their source, not edited');
  const changed = JSON.stringify(cur.items) !== JSON.stringify(list);
  stmts.update.run(nm, JSON.stringify(list), changed ? JSON.stringify(cur.items) : (cur.prevItems ? JSON.stringify(cur.prevItems) : null), null, id);
  return get(id);
}
function removeCustom(id) {
  const cur = get(id);
  if (!cur) throw httpError(404, 'List not found');
  if (cur.kind !== 'custom') throw httpError(400, 'Official lists cannot be deleted');
  stmts.del.run(id);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DockGate', Accept: '*/*' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} answered ${res.statusCode}`)); }
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error(`${url} did not answer in 15 s`)));
    req.on('error', reject);
  });
}

/** Fetch an official list's current version → { current, upstream, add, remove } (nothing saved). */
async function checkOfficial(id, fetcher = fetchText) {
  const d = OFFICIAL[id];
  if (!d) throw httpError(400, 'Only official lists can be checked for updates');
  let bodies;
  try { bodies = await Promise.all(d.urls.map(u => fetcher(u))); }
  catch (e) { throw httpError(502, `Could not fetch the ${d.name} list: ${e.message}`); }
  const { valid } = parseSourceText(d.parse(bodies));
  if (!valid.length) throw httpError(502, `The ${d.name} list came back empty — nothing changed`);
  const cur = get(id).items;
  return { id, upstream: valid, add: valid.filter(x => !cur.includes(x)), remove: cur.filter(x => !valid.includes(x)) };
}
/** Save a fetched version (the old one is kept as prev_items so outdated ports can be found). */
function saveOfficial(id, items) {
  const cur = get(id);
  if (!cur || cur.kind !== 'official') throw httpError(400, 'Not an official list');
  const list = cleanItems(items);
  const changed = JSON.stringify(cur.items) !== JSON.stringify(list);
  stmts.update.run(cur.name, JSON.stringify(list), changed ? JSON.stringify(cur.items) : (cur.prevItems ? JSON.stringify(cur.prevItems) : null), new Date().toISOString().slice(0, 19).replace('T', ' '), id);
  return get(id);
}

// ---------------------------------------------------------------- port sources
/**
 * Raw sources on a port (['any'] or addresses) → display sources: '@<list>' where every address of a
 * list is present (largest list first), the rest as addresses. outdated: lists whose PREVIOUS version
 * is what the port holds. dockgateIp turns that one address into '@dockgate'.
 */
function inferSources(raw, lists, dockgateIp) {
  const rest = new Set(raw);
  const out = [], outdated = [];
  if (rest.has('any')) { rest.delete('any'); out.push('any'); }
  const sorted = [...lists].sort((a, b) => b.items.length - a.items.length);
  for (const l of sorted) {
    if (l.items.length && l.items.every(x => rest.has(x))) { l.items.forEach(x => rest.delete(x)); out.push('@' + l.id); continue; }
    if (l.prevItems && l.prevItems.length && l.prevItems.every(x => rest.has(x))) { l.prevItems.forEach(x => rest.delete(x)); out.push('@' + l.id); outdated.push(l.id); }
  }
  const ip = dockgateIp ? normalizeSource(dockgateIp) : null;
  if (ip && rest.has(ip)) { rest.delete(ip); out.push('@dockgate'); }
  return { sources: [...out, ...rest], outdated };
}

/** Display sources → addresses ([{ src, tag }]); tag names the list (UFW comment) or 'manual'. */
function expandSources(sources, lists, dockgateIp) {
  const byId = new Map(lists.map(l => [l.id, l]));
  const out = [], seen = new Set();
  const push = (src, tag) => { if (!seen.has(src)) { seen.add(src); out.push({ src, tag }); } };
  for (const s of sources) {
    if (s === 'any') push('any', 'any');
    else if (s === '@dockgate') { const ip = normalizeSource(dockgateIp); if (!ip) throw httpError(400, "DockGate's IP on this server is unknown"); push(ip, 'dockgate'); }
    else if (s[0] === '@') { const l = byId.get(s.slice(1)); if (!l) throw httpError(400, `Unknown list ${s.slice(1)}`); l.items.forEach(x => push(x, l.id)); }
    else { const n = normalizeSource(s); if (!n) throw httpError(400, `Not an IP address or range: ${s}`); push(n, 'manual'); }
  }
  if (seen.has('any') && out.length > 1) throw httpError(400, '"Anyone" already includes every address — remove the other sources');
  return out;
}

module.exports = {
  normalizeSource, parseSourceText, sourceContains, isV6,
  OFFICIAL, all, get, saveCustom, removeCustom, checkOfficial, saveOfficial,
  inferSources, expandSources,
};
