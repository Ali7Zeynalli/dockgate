'use strict';
// The ACME client (server/acme.js) against a small ACME server in this test that checks what Let's Encrypt
// checks: every request is a JWS signed with the account key (jwk for new accounts, kid after), nonces are
// fresh, the http-01 key authorization is token.thumbprint, and the CSR names the domains (openssl signs it).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const A = require('../../server/acme');

const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let haveOpenssl = true; try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { haveOpenssl = false; }

function fakeCa({ failChallenge = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-acme-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=Test CA', '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.pem')], { stdio: 'ignore' });
  const nonces = new Set(); const accounts = new Map(); const orders = new Map(); const seen = { badNonce: 0, posts: 0 };
  let base; const challenges = new Map(); // token → { authz, expect, domain }
  let answers = null; // filled by the test's setChallenge
  const dnsRecords = new Map(); // fqdn → [TXT values], filled by the test's dns.set
  const nonce = () => { const n = b64u(crypto.randomBytes(12)); nonces.add(n); return n; };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Replay-Nonce': nonce(), 'Content-Type': typeof obj === 'string' ? 'application/pem-certificate-chain' : 'application/json', ...headers }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (req.url === '/dir') return send(200, { newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` });
      if (req.url === '/nonce') { res.writeHead(200, { 'Replay-Nonce': nonce() }); return res.end(); }
      // every other request: a verified JWS
      const jws = JSON.parse(body); const prot = JSON.parse(b64d(jws.protected).toString());
      seen.posts++;
      if (!nonces.delete(prot.nonce)) { seen.badNonce++; return send(400, { type: 'urn:ietf:params:acme:error:badNonce', detail: 'stale nonce' }); }
      assert.equal(prot.url, base + req.url); assert.equal(prot.alg, 'ES256');
      const jwk = prot.jwk || accounts.get(prot.kid); assert.ok(jwk, 'unknown account');
      if (req.url !== '/acct') assert.ok(prot.kid && !prot.jwk, 'after the account, requests use kid');
      const ok = crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64d(jws.signature));
      if (!ok) return send(403, { type: 'urn:ietf:params:acme:error:unauthorized', detail: 'bad signature' });
      const payload = jws.payload ? JSON.parse(b64d(jws.payload).toString()) : null;
      if (req.url === '/acct') { assert.equal(payload.termsOfServiceAgreed, true); const kid = `${base}/acct/1`; accounts.set(kid, jwk); return send(201, { status: 'valid' }, { Location: kid }); }
      if (req.url === '/order') {
        const id = String(orders.size + 1); const o = { status: 'pending', identifiers: payload.identifiers, authorizations: [], finalize: `${base}/fin/${id}`, jwk };
        for (const idf of payload.identifiers) { const tok = b64u(crypto.randomBytes(16)); const az = `${base}/authz/${tok}`; o.authorizations.push(az); const wild = idf.value.startsWith('*.'); challenges.set(tok, { status: 'pending', domain: wild ? idf.value.slice(2) : idf.value, wildcard: wild, expect: `${tok}.${A.thumbprint(jwk)}` }); }
        orders.set(id, o); return send(201, o, { Location: `${base}/o/${id}` });
      }
      let m;
      if ((m = req.url.match(/^\/dnschall\/(.+)$/))) {
        const c = challenges.get(m[1]); // what the CA would read from DNS: TXT _acme-challenge.<domain>
        const txt = (dnsRecords.get(`_acme-challenge.${c.domain}`) || []);
        if (!txt.includes(A.dnsValue(c.expect))) { c.status = 'invalid'; c.error = { detail: `No TXT record found at _acme-challenge.${c.domain}` }; } else c.status = 'valid';
        return send(200, { status: 'processing' });
      }
      if ((m = req.url.match(/^\/authz\/(.+)$/))) { const c = challenges.get(m[1]); return send(200, { status: c.status, identifier: { type: 'dns', value: c.domain }, ...(c.wildcard ? { wildcard: true } : {}), challenges: [{ type: 'dns-01', url: `${base}/dnschall/${m[1]}`, token: m[1] }, { type: 'http-01', url: `${base}/chall/${m[1]}`, token: m[1], ...(c.error ? { error: c.error } : {}) }] }); }
      if ((m = req.url.match(/^\/chall\/(.+)$/))) {
        const c = challenges.get(m[1]);
        // what the CA would fetch from http://domain/.well-known/acme-challenge/<token>
        const got = answers.get(m[1]);
        if (failChallenge || got !== c.expect) { c.status = 'invalid'; c.error = { detail: `Invalid response from http://${c.domain}/.well-known/acme-challenge/${m[1]}: 404` }; } else c.status = 'valid';
        return send(200, { status: 'processing' });
      }
      if ((m = req.url.match(/^\/fin\/(\d+)$/))) {
        const o = orders.get(m[1]);
        const csrPath = path.join(dir, `r${m[1]}.csr`), crt = path.join(dir, `c${m[1]}.pem`), ext = path.join(dir, `e${m[1]}.cnf`);
        fs.writeFileSync(csrPath, `-----BEGIN CERTIFICATE REQUEST-----\n${b64d(payload.csr).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`);
        const text = execFileSync('openssl', ['req', '-in', csrPath, '-noout', '-text', '-verify'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        for (const idf of o.identifiers) assert.ok(text.includes(`DNS:${idf.value}`), `CSR names ${idf.value}`);
        fs.writeFileSync(ext, `subjectAltName=${o.identifiers.map(i => `DNS:${i.value}`).join(',')}\n`);
        execFileSync('openssl', ['x509', '-req', '-in', csrPath, '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial', '-days', '90', '-extfile', ext, '-out', crt], { stdio: 'ignore' });
        o.status = 'valid'; o.certificate = `${base}/cert/${m[1]}`; return send(200, { status: 'processing' });
      }
      if ((m = req.url.match(/^\/o\/(\d+)$/))) { const o = orders.get(m[1]); return send(200, { status: o.status, certificate: o.certificate }); }
      if ((m = req.url.match(/^\/cert\/(\d+)$/))) return send(200, fs.readFileSync(path.join(dir, `c${m[1]}.pem`), 'utf8') + fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'));
      return send(404, { detail: 'no route' });
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${srv.address().port}`; res({ url: `${base}/dir`, seen, dnsRecords, setAnswers: (m2) => { answers = m2; }, close: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }, nonces }); }));
}

test('issue: account, http-01 answered, CSR, certificate chain and key that match', { skip: !haveOpenssl && 'openssl not available' }, async () => {
  const ca = await fakeCa(); const answers = new Map(); ca.setAnswers(answers); const cleared = [];
  try {
    const r = await A.issue({ directory: ca.url, email: 'ops@example.test', domains: ['shop.example.test', 'www.shop.example.test'],
      setChallenge: async (token, keyAuth, domain) => { assert.ok(['shop.example.test', 'www.shop.example.test'].includes(domain)); answers.set(token, keyAuth); },
      clearChallenge: async (token) => { cleared.push(token); } });
    const leaf = new crypto.X509Certificate(r.certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
    assert.match(leaf.subjectAltName, /DNS:shop\.example\.test/); assert.match(leaf.subjectAltName, /DNS:www\.shop\.example\.test/);
    assert.ok(leaf.checkPrivateKey(crypto.createPrivateKey(r.keyPem)), 'the key belongs to the certificate');
    assert.ok(new Date(r.notAfter) > new Date(Date.now() + 80 * 86400000));
    assert.equal(cleared.length, 2, 'challenge files removed');
    // the same account is used again with its key
    const again = await A.issue({ directory: ca.url, accountKeyPem: r.accountKeyPem, domains: ['shop.example.test'], setChallenge: async (t, k) => answers.set(t, k) });
    assert.equal(again.accountKeyPem.trim(), r.accountKeyPem.trim());
  } finally { ca.close(); }
});

test('a failed check says why and still removes the challenge files', { skip: !haveOpenssl && 'openssl not available' }, async () => {
  const ca = await fakeCa({ failChallenge: true }); const answers = new Map(); ca.setAnswers(answers); const cleared = [];
  try {
    await assert.rejects(A.issue({ directory: ca.url, domains: ['bad.example.test'], setChallenge: async (t, k) => answers.set(t, k), clearChallenge: async (t) => cleared.push(t) }), /Invalid response from http:\/\/bad\.example\.test/);
    assert.equal(cleared.length, 1);
  } finally { ca.close(); }
});

test('a stale nonce is retried with the fresh one', { skip: !haveOpenssl && 'openssl not available' }, async () => {
  const ca = await fakeCa(); const answers = new Map(); ca.setAnswers(answers);
  try {
    const a = new A.Acme(ca.url, null);
    a.nonce = 'stale-nonce';
    await a.account();
    assert.equal(ca.seen.badNonce, 1); assert.ok(a.kid);
  } finally { ca.close(); }
});

test('wildcards are refused (they need a DNS check)', async () => {
  await assert.rejects(A.issue({ directory: 'http://127.0.0.1:9/dir', domains: ['*.example.test'], setChallenge: async () => {} }), /wildcard/);
});

test('issue with the DNS check: a wildcard and its base name, TXT records added, waited for and removed', { skip: !haveOpenssl && 'openssl not available' }, async () => {
  const ca = await fakeCa(); ca.setAnswers(new Map()); const log = []; const waited = []; let n = 0;
  const dns = {
    set: async (fqdn, value) => { const l = ca.dnsRecords.get(fqdn) || []; l.push(value); ca.dnsRecords.set(fqdn, l); return { fqdn, value, id: ++n }; },
    clear: async (h) => { ca.dnsRecords.set(h.fqdn, (ca.dnsRecords.get(h.fqdn) || []).filter(v => v !== h.value)); },
    wait: async (fqdn, value) => { waited.push(fqdn); assert.ok((ca.dnsRecords.get(fqdn) || []).includes(value)); },
  };
  try {
    const r = await A.issue({ directory: ca.url, domains: ['*.example.test', 'example.test'], dns, log: (m) => log.push(m), setChallenge: async () => { throw new Error('no HTTP check with dns'); } });
    const leaf = new crypto.X509Certificate(r.certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
    assert.match(leaf.subjectAltName, /DNS:\*\.example\.test/); assert.match(leaf.subjectAltName, /DNS:example\.test/);
    assert.deepEqual(waited, ['_acme-challenge.example.test', '_acme-challenge.example.test']);
    assert.deepEqual(ca.dnsRecords.get('_acme-challenge.example.test'), [], 'records removed after the check');
    assert.ok(log.some(l => /\*\.example\.test: checked/.test(l)));
  } finally { ca.close(); }
});

test('a wildcard without the DNS check is refused before anything is asked', async () => {
  await assert.rejects(() => A.issue({ directory: 'http://127.0.0.1:1/dir', domains: ['*.example.test'], setChallenge: async () => {} }), /needs the DNS check/);
});
