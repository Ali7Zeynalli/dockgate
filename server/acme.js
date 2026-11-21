// A small ACME client (RFC 8555) for Let's Encrypt and other ACME CAs, with Node's crypto only:
// ES256 account key, http-01 challenges, an EC P-256 certificate key and a CSR built here (DER).
//   issue({ directory, email, accountKeyPem, domains, setChallenge(token, keyAuth), clearChallenge(token), log })
//     → { certPem, keyPem, accountKeyPem, notAfter }
const crypto = require('crypto');

const DIRECTORIES = {
  letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory',
  'letsencrypt-staging': 'https://acme-staging-v02.api.letsencrypt.org/directory',
};
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- DER ----------
function len(n) { if (n < 0x80) return Buffer.from([n]); const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); }
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
function oid(s) {
  const n = s.split('.').map(Number); const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) { const b = [v & 0x7f]; let x = v >> 7; while (x) { b.unshift(0x80 | (x & 0x7f)); x >>= 7; } out.push(...b); }
  return tlv(0x06, Buffer.from(out));
}
/** A PKCS#10 CSR (DER) for `domains` (the first is the CN; all in subjectAltName), signed with an EC key. */
function csr(domains, keyObject) {
  const spki = keyObject.type === 'private' ? crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'der' }) : keyObject.export({ type: 'spki', format: 'der' });
  const subject = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(domains[0], 'utf8')))));
  const san = seq(...domains.map(d => tlv(0x82, Buffer.from(d, 'ascii'))));
  const ext = seq(seq(oid('2.5.29.17'), tlv(0x04, san)));
  const attrs = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(ext)));
  const info = seq(tlv(0x02, Buffer.from([0])), subject, spki, attrs);
  const sig = crypto.sign('sha256', info, keyObject);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

// ---------- the client ----------
function jwkOf(key) { const j = crypto.createPublicKey(key).export({ format: 'jwk' }); return { crv: j.crv, kty: j.kty, x: j.x, y: j.y }; }
const thumbprint = (jwk) => b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());

class Acme {
  constructor(directoryUrl, accountKeyPem, { log = () => {}, fetchImpl = fetch } = {}) {
    this.url = DIRECTORIES[directoryUrl] || directoryUrl;
    this.key = accountKeyPem ? crypto.createPrivateKey(accountKeyPem) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    this.jwk = jwkOf(this.key); this.kid = null; this.nonce = null; this.log = log; this.fetch = fetchImpl;
  }
  accountKeyPem() { return this.key.export({ type: 'pkcs8', format: 'pem' }); }
  async dir() {
    if (this.d) return this.d;
    const r = await this.fetch(this.url); if (!r.ok) throw new Error(`ACME directory ${this.url}: HTTP ${r.status}`);
    this.d = await r.json(); return this.d;
  }
  async newNonce() { const r = await this.fetch((await this.dir()).newNonce, { method: 'HEAD' }); return r.headers.get('replay-nonce'); }
  async post(url, payload, { useJwk = false, tries = 3 } = {}) {
    for (let t = 0; t < tries; t++) {
      const nonce = this.nonce || await this.newNonce(); this.nonce = null;
      const protectedH = { alg: 'ES256', nonce, url, ...(useJwk || !this.kid ? { jwk: this.jwk } : { kid: this.kid }) };
      const p64 = b64u(JSON.stringify(protectedH)); const pl64 = payload === null ? '' : b64u(JSON.stringify(payload));
      const signature = b64u(crypto.sign('sha256', Buffer.from(`${p64}.${pl64}`), { key: this.key, dsaEncoding: 'ieee-p1363' }));
      const r = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/jose+json' }, body: JSON.stringify({ protected: p64, payload: pl64, signature }) });
      this.nonce = r.headers.get('replay-nonce') || null;
      const type = r.headers.get('content-type') || '';
      const body = type.includes('json') ? await r.json() : await r.text();
      if (r.status === 400 && body && body.type === 'urn:ietf:params:acme:error:badNonce' && t + 1 < tries) continue;
      if (r.status >= 400) { const e = new Error(`ACME: ${(body && (body.detail || body.type)) || r.status}`); e.acme = body; e.statusCode = 502; throw e; }
      return { status: r.status, headers: r.headers, body };
    }
    throw new Error('ACME: no fresh nonce');
  }
  async account(email) {
    const d = await this.dir();
    const r = await this.post(d.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) }, { useJwk: true });
    this.kid = r.headers.get('location'); return r.body;
  }
  async poll(url, done, { every = 2000, max = 90000 } = {}) {
    const end = Date.now() + max;
    for (;;) {
      const r = await this.post(url, null); const b = r.body;
      if (done(b)) return b;
      if (b.status === 'invalid') { const why = (b.error && b.error.detail) || ((b.challenges || []).find(c => c.error) || {}).error; throw Object.assign(new Error(`ACME: ${typeof why === 'string' ? why : (why && why.detail) || 'the check failed'}`), { statusCode: 502, acme: b }); }
      if (Date.now() > end) throw Object.assign(new Error('ACME: timed out waiting for the CA'), { statusCode: 504 });
      await sleep(Number(r.headers.get('retry-after')) * 1000 || every);
    }
  }
}

async function issue({ directory, email, accountKeyPem, domains, setChallenge, clearChallenge = async () => {}, log = () => {}, fetchImpl }) {
  const names = [...new Set(domains.map(d => String(d).toLowerCase()))];
  if (!names.length) throw new Error('No domain');
  if (names.some(n => n.startsWith('*.'))) throw Object.assign(new Error('A wildcard certificate needs a DNS check; DockGate checks over HTTP — list the names instead'), { statusCode: 400 });
  const a = new Acme(directory, accountKeyPem, { log, fetchImpl });
  log(`Account at ${a.url}`); await a.account(email);
  const d = await a.dir();
  const order = await a.post(d.newOrder, { identifiers: names.map(value => ({ type: 'dns', value })) });
  const orderUrl = order.headers.get('location'); let o = order.body;
  const tokens = [];
  try {
    for (const authUrl of o.authorizations) {
      const az = (await a.post(authUrl, null)).body;
      if (az.status === 'valid') { log(`${az.identifier.value}: already checked`); continue; }
      const ch = (az.challenges || []).find(c => c.type === 'http-01');
      if (!ch) throw Object.assign(new Error(`${az.identifier.value}: the CA offers no HTTP check`), { statusCode: 502 });
      const keyAuth = `${ch.token}.${thumbprint(a.jwk)}`;
      await setChallenge(ch.token, keyAuth, az.identifier.value); tokens.push(ch.token);
      log(`${az.identifier.value}: answering http://${az.identifier.value}/.well-known/acme-challenge/${ch.token.slice(0, 8)}…`);
      await a.post(ch.url, {});
      await a.poll(authUrl, b => b.status === 'valid');
      log(`${az.identifier.value}: checked`);
    }
    const certKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    o = (await a.post(o.finalize, { csr: b64u(csr(names, certKey)) })).body;
    o = await a.poll(orderUrl, b => b.status === 'valid' && b.certificate, { every: 1500 });
    const certPem = String((await a.post(o.certificate, null)).body);
    if (!/BEGIN CERTIFICATE/.test(certPem)) throw new Error('ACME: no certificate in the answer');
    const first = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0];
    const notAfter = new Date(new crypto.X509Certificate(first).validTo).toISOString();
    log(`Issued for ${names.join(', ')}, valid until ${notAfter.slice(0, 10)}`);
    return { certPem, keyPem: certKey.export({ type: 'pkcs8', format: 'pem' }), accountKeyPem: a.accountKeyPem(), notAfter };
  } finally { for (const t of tokens) await clearChallenge(t).catch(() => {}); }
}

module.exports = { issue, csr, thumbprint, jwkOf, DIRECTORIES, Acme, _der: { tlv, seq, set, oid } };
