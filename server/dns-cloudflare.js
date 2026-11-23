// The DNS check (ACME dns-01) through Cloudflare's API: DockGate adds the TXT record _acme-challenge.<name>,
// waits until public DNS answers it, Let's Encrypt checks it, and DockGate removes it. This is what makes
// wildcard certificates (*.example.com) possible, and works when port 80 is closed or the site is behind
// Cloudflare's proxy. The API token needs Zone → DNS → Edit for the zones it is used for (and Zone → Read).
const dns = require('dns');

const API = 'https://api.cloudflare.com/client/v4';
const err = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });

async function call(token, method, path, body, fetchImpl = fetch) {
  let r;
  try {
    r = await fetchImpl(API + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw err(`Cloudflare could not be reached: ${e.message}`, 502); }
  let j = {}; try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || j.success === false) {
    const m = (j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
    throw err(r.status === 401 || r.status === 403 ? `Cloudflare refused the token: ${m}` : `Cloudflare: ${m}`, r.status === 401 || r.status === 403 ? 403 : 502);
  }
  return j.result;
}

/** Is the token valid (and active)? */
async function verify(token, { fetchImpl } = {}) {
  if (!token) throw err('No Cloudflare API token');
  const r = await call(token, 'GET', '/user/tokens/verify', null, fetchImpl);
  if (!r || r.status !== 'active') throw err(`The token is ${r ? r.status : 'unknown'}`);
  return { ok: true, status: r.status };
}

/** The Cloudflare zone a name belongs to: the longest of its parent names that is a zone of this account. */
async function zoneFor(token, fqdn, { fetchImpl } = {}) {
  const labels = String(fqdn).replace(/\.$/, '').replace(/^_acme-challenge\./, '').replace(/^\*\./, '').split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const r = await call(token, 'GET', `/zones?name=${encodeURIComponent(name)}&status=active`, null, fetchImpl);
    if (Array.isArray(r) && r[0]) return { id: r[0].id, name: r[0].name };
  }
  throw err(`No Cloudflare zone of this token holds ${fqdn} — add the domain to Cloudflare, or give the token access to its zone`);
}

/** Add the TXT record; returns what clearTxt needs. */
async function setTxt(token, fqdn, value, { fetchImpl } = {}) {
  const z = await zoneFor(token, fqdn, { fetchImpl });
  const rec = await call(token, 'POST', `/zones/${z.id}/dns_records`, { type: 'TXT', name: fqdn, content: value, ttl: 60, comment: 'DockGate: ACME check, removed after it' }, fetchImpl);
  return { zoneId: z.id, id: rec.id, fqdn };
}
async function clearTxt(token, h, { fetchImpl } = {}) {
  if (h && h.zoneId && h.id) await call(token, 'DELETE', `/zones/${h.zoneId}/dns_records/${h.id}`, null, fetchImpl);
}

/** Wait until public resolvers answer the TXT value (Let's Encrypt asks from several places). */
async function waitTxt(fqdn, value, { timeoutMs = 180000, every = 5000, servers = ['1.1.1.1', '8.8.8.8'], log = () => {}, resolve } = {}) {
  const resolvers = servers.map(s => { const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 }); r.setServers([s]); return r; });
  const ask = resolve || (async (name) => { const out = []; for (const r of resolvers) { try { out.push((await r.resolveTxt(name)).map(x => x.join(''))); } catch (e) { out.push([]); } } return out; });
  const end = Date.now() + timeoutMs;
  for (let n = 0; ; n++) {
    const answers = await ask(fqdn);
    if (answers.length && answers.every(list => list.includes(value))) { log(`${fqdn}: the TXT record is visible in public DNS`); return true; }
    if (Date.now() > end) throw err(`${fqdn}: the TXT record did not show in public DNS within ${Math.round(timeoutMs / 1000)} s`, 504);
    if (n === 0) log(`${fqdn}: waiting for public DNS…`);
    await new Promise(r => setTimeout(r, every));
  }
}

module.exports = { verify, zoneFor, setTxt, clearTxt, waitTxt, API };
