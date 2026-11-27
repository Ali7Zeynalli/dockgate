// Uptime probes and rules (Observe > Uptime). No database here, so it can be unit tested.
//   probe(check)               one check: { ok, ms, status?, error?, cert? }
//   evaluate(state, r, check, now)   the next state and the alerts that are due (down / up / slow / certificate)
// Check types:
//   http   GET/HEAD/POST a URL: expected status (200, 200-399, 301), optional text the page must (not) contain,
//          the TLS certificate of an https URL
//   ssl    only the certificate of host[:port] (days left, valid for the name, issuer)
//   tcp    host:port accepts a connection
//   dns    a name resolves (optionally to an expected address)
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');

const TYPES = ['http', 'ssl', 'tcp', 'dns'];
const CERT_DAYS = [30, 14, 7, 1];
const MAX_BODY = 1024 * 1024;
const DAY = 86400000;

// Cloud metadata addresses are never checked: a check must not become a way to read the server's credentials.
function blockedAddress(ip) {
  return /^169\.254\./.test(ip) || /^fd00:ec2::254$/i.test(ip) || /^::ffff:169\.254\./i.test(ip);
}
function safeLookup(host, opts, cb) {
  dns.lookup(host, opts, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some(a => blockedAddress(a.address))) return cb(Object.assign(new Error(`${host} points to a cloud metadata address - not checked`), { code: 'EBLOCKED' }));
    cb(null, address, family);
  });
}

/** "200", "200-399", "200,301" -> (code) => bool. */
function statusMatcher(spec) {
  const parts = String(spec || '200-399').split(',').map(s => s.trim()).filter(Boolean);
  const tests = parts.map(p => {
    const m = /^(\d{3})\s*-\s*(\d{3})$/.exec(p);
    if (m) return (c) => c >= Number(m[1]) && c <= Number(m[2]);
    if (/^\d{3}$/.test(p)) return (c) => c === Number(p);
    if (/^\dxx$/i.test(p)) return (c) => Math.floor(c / 100) === Number(p[0]);
    throw new Error(`Expected status: "${p}" - use 200, 200-399, 2xx or a list like 200,301`);
  });
  return (c) => tests.some(t => t(c));
}

function certInfo(c, host, authorized, authError) {
  if (!c || !c.valid_to) return null;
  const validTo = Date.parse(c.valid_to);
  const names = String(c.subjectaltname || '').split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(Boolean);
  let nameOk = true;
  try { nameOk = !tls.checkServerIdentity(host, c); } catch (e) { nameOk = false; }
  const issuer = c.issuer ? (c.issuer.O ? `${c.issuer.O}${c.issuer.CN ? ' ' + c.issuer.CN : ''}` : c.issuer.CN || '') : '';
  return { validTo, daysLeft: Math.floor((validTo - Date.now()) / DAY), issuer, names: names.slice(0, 20), nameOk, authorized: !!authorized, error: authorized ? null : (authError ? String(authError.message || authError) : null) };
}

function parseHostPort(target, defPort) {
  const s = String(target || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m || !m[1]) throw new Error('Host: example.com or example.com:443');
  const port = m[2] ? Number(m[2]) : defPort;
  if (!port || port < 1 || port > 65535) throw new Error('Port: 1-65535');
  return { host: m[1], port };
}

/** Clean and check a check's settings (what the form sends). Throws with a readable message. */
function normalize(input) {
  const type = TYPES.includes(input.type) ? input.type : 'http';
  const name = String(input.name || '').trim().slice(0, 80);
  let target = String(input.target || '').trim();
  const c = input.config || {};
  const config = {};
  if (type === 'http') {
    let u; try { u = new URL(target); } catch (e) { throw new Error('URL: https://example.com/health'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('URL must start with http:// or https://');
    target = u.toString();
    config.method = ['GET', 'HEAD', 'POST'].includes(c.method) ? c.method : 'GET';
    config.expect = String(c.expect || '200-399').trim();
    statusMatcher(config.expect);
    config.contains = String(c.contains || '').slice(0, 200);
    config.notContains = String(c.notContains || '').slice(0, 200);
    config.follow = c.follow !== false;
    config.ignoreTls = !!c.ignoreTls;
    config.headers = {};
    for (const [k, v] of Object.entries(c.headers || {})) if (/^[A-Za-z0-9-]{1,64}$/.test(k)) config.headers[k] = String(v).slice(0, 1000);
  } else if (type === 'ssl') {
    target = (() => { const hp = parseHostPort(target, 443); return hp.port === 443 ? hp.host : `${hp.host}:${hp.port}`; })();
  } else if (type === 'tcp') {
    const hp = parseHostPort(target, 0); target = `${hp.host}:${hp.port}`;
  } else if (type === 'dns') {
    target = parseHostPort(target, 53).host;
    config.expectIp = String(c.expectIp || '').trim();
    if (config.expectIp && !net.isIP(config.expectIp)) throw new Error('Expected address: an IP like 203.0.113.10');
  }
  const timeout = Math.round(Number(c.timeout) || 10);
  if (timeout < 1 || timeout > 60) throw new Error('Timeout: 1-60 seconds');
  config.timeout = timeout;
  const slowMs = c.slowMs === '' || c.slowMs == null ? 0 : Math.round(Number(c.slowMs));
  if (!Number.isFinite(slowMs) || slowMs < 0 || slowMs > 120000) throw new Error('Slow above: 0-120000 ms (0 = off)');
  config.slowMs = slowMs;
  config.slowCount = Math.min(10, Math.max(1, Math.round(Number(c.slowCount) || 3)));
  config.certAlerts = (type === 'http' && /^https:/i.test(target)) || type === 'ssl' ? c.certAlerts !== false : false;
  const interval = Math.round(Number(input.interval) || 60);
  if (interval < 30 || interval > 3600) throw new Error('Every: 30 seconds to 1 hour');
  const fails = Math.round(Number(input.fails) || 2);
  if (fails < 1 || fails > 10) throw new Error('Down after: 1-10 failures in a row');
  return { name: name || target, type, target, config, interval, fails };
}

const timeoutErr = (s) => Object.assign(new Error(`Timeout after ${s} s`), { code: 'ETIMEDOUT' });

function probeHttp(check, depth = 0) {
  const cfg = check.config || {};
  const u = new URL(check.target);
  const lib = u.protocol === 'https:' ? https : http;
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false, cert = null;
    const finish = (r) => { if (!done) { done = true; resolve({ ms: Date.now() - t0, ...r, cert: r.cert || cert }); } };
    const req = lib.request(u, {
      method: cfg.method || 'GET', lookup: safeLookup, timeout: (cfg.timeout || 10) * 1000,
      rejectUnauthorized: !cfg.ignoreTls, agent: false,
      headers: { 'User-Agent': 'DockGate-Uptime/1.0', Accept: '*/*', ...(cfg.headers || {}) },
    }, (res) => {
      if (u.protocol === 'https:') { try { const s = res.socket; cert = certInfo(s.getPeerCertificate(), u.hostname, s.authorized, s.authorizationError); } catch (e) { /* no cert */ } }
      const code = res.statusCode;
      if (cfg.follow !== false && code >= 300 && code < 400 && res.headers.location && depth < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return probeHttp({ ...check, target: next }, depth + 1).then(r => finish({ ...r, ms: Date.now() - t0, cert: cert || r.cert }));
      }
      let ok;
      try { ok = statusMatcher(cfg.expect)(code); } catch (e) { ok = false; }
      if (!ok) { res.resume(); return finish({ ok: false, status: code, error: `HTTP ${code}${res.statusMessage ? ' ' + res.statusMessage : ''} (expected ${cfg.expect || '200-399'})` }); }
      if (!cfg.contains && !cfg.notContains) { res.resume(); res.on('end', () => finish({ ok: true, status: code })); res.on('error', () => finish({ ok: true, status: code })); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < MAX_BODY) body += d; });
      res.on('end', () => {
        if (cfg.contains && !body.includes(cfg.contains)) return finish({ ok: false, status: code, error: `The page does not contain "${cfg.contains}"` });
        if (cfg.notContains && body.includes(cfg.notContains)) return finish({ ok: false, status: code, error: `The page contains "${cfg.notContains}"` });
        finish({ ok: true, status: code });
      });
      res.on('error', (e) => finish({ ok: false, status: code, error: e.message }));
    });
    req.on('timeout', () => { req.destroy(timeoutErr(cfg.timeout || 10)); });
    req.on('error', (e) => finish({ ok: false, error: friendly(e, cfg.timeout) }));
    req.end();
  });
}

function probeSsl(check) {
  const cfg = check.config || {};
  const { host, port } = parseHostPort(check.target, 443);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve({ ms: Date.now() - t0, ...r }); } };
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, lookup: safeLookup, timeout: (cfg.timeout || 10) * 1000 }, () => {
      const cert = certInfo(sock.getPeerCertificate(), host, sock.authorized, sock.authorizationError);
      if (!cert) return finish({ ok: false, error: 'No certificate' });
      finish({ ok: true, cert });
    });
    sock.on('timeout', () => finish({ ok: false, error: timeoutErr(cfg.timeout || 10).message }));
    sock.on('error', (e) => finish({ ok: false, error: friendly(e, cfg.timeout) }));
  });
}

function probeTcp(check) {
  const cfg = check.config || {};
  const { host, port } = parseHostPort(check.target, 0);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve({ ms: Date.now() - t0, ...r }); } };
    const sock = net.connect({ host, port, lookup: safeLookup, timeout: (cfg.timeout || 10) * 1000 }, () => finish({ ok: true }));
    sock.on('timeout', () => finish({ ok: false, error: timeoutErr(cfg.timeout || 10).message }));
    sock.on('error', (e) => finish({ ok: false, error: friendly(e, cfg.timeout) }));
  });
}

async function probeDns(check) {
  const cfg = check.config || {};
  const t0 = Date.now();
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(timeoutErr(cfg.timeout || 10)), (cfg.timeout || 10) * 1000))]);
  try {
    const a4 = await withTimeout(dns.promises.resolve4(check.target).catch(() => []));
    const a6 = await withTimeout(dns.promises.resolve6(check.target).catch(() => []));
    const all = [...a4, ...a6];
    if (!all.length) return { ok: false, ms: Date.now() - t0, error: `${check.target} does not resolve` };
    if (cfg.expectIp && !all.includes(cfg.expectIp)) return { ok: false, ms: Date.now() - t0, error: `Resolves to ${all.slice(0, 4).join(', ')}, not ${cfg.expectIp}` };
    return { ok: true, ms: Date.now() - t0, detail: all.slice(0, 4).join(', ') };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: friendly(e, cfg.timeout) }; }
}

function friendly(e, timeout) {
  const c = e && e.code;
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET' && /timeout/i.test(e.message)) return `Timeout after ${timeout || 10} s`;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return `DNS: the name does not resolve (${c})`;
  if (c === 'ECONNREFUSED') return 'Connection refused';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'Host not reachable';
  if (c === 'CERT_HAS_EXPIRED') return 'TLS: the certificate has expired';
  if (c === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'TLS: the certificate is not for this name';
  if (c === 'DEPTH_ZERO_SELF_SIGNED_CERT' || c === 'SELF_SIGNED_CERT_IN_CHAIN') return 'TLS: self-signed certificate (tick "Ignore certificate errors" to check it anyway)';
  if (c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'TLS: the certificate chain is incomplete';
  return (e && e.message) || String(e);
}

async function probe(check) {
  try {
    if (check.type === 'ssl') return await probeSsl(check);
    if (check.type === 'tcp') return await probeTcp(check);
    if (check.type === 'dns') return await probeDns(check);
    return await probeHttp(check);
  } catch (e) { return { ok: false, ms: 0, error: friendly(e) }; }
}

/**
 * One result -> the next state and the alerts due. state: { status: 'up'|'down'|'pending', fails, since,
 * slowStreak, slow, certSent: [days...], certBad }. Alerts: [{ type, data }].
 */
function evaluate(state, r, check, now) {
  const st = { status: 'pending', fails: 0, since: now, slowStreak: 0, slow: false, certSent: [], certBad: false, ...(state || {}) };
  const alerts = [];
  const cfg = check.config || {};
  st.lastAt = now; st.lastMs = r.ms; st.lastError = r.ok ? null : (r.error || 'failed'); st.lastStatus = r.status || null;
  if (r.cert) st.cert = r.cert;

  if (r.ok) {
    if (st.status === 'down') alerts.push({ type: 'site_up', data: { since: st.since, until: now, ms: r.ms, status: r.status } });
    if (st.status !== 'up') { st.status = 'up'; st.since = now; }
    st.fails = 0;
    // Slow: above the limit on N checks in a row; once, until it is fast again.
    if (cfg.slowMs > 0 && r.ms > cfg.slowMs) {
      st.slowStreak = (st.slowStreak || 0) + 1;
      if (!st.slow && st.slowStreak >= (cfg.slowCount || 3)) { st.slow = true; alerts.push({ type: 'site_slow', data: { ms: r.ms, limit: cfg.slowMs, count: st.slowStreak } }); }
    } else { st.slowStreak = 0; st.slow = false; }
  } else {
    st.fails = (st.fails || 0) + 1;
    st.slowStreak = 0;
    if (st.status !== 'down' && st.fails >= (check.fails || 2)) {
      st.status = 'down'; st.since = now - Math.max(0, (st.fails - 1)) * (check.interval || 60) * 1000;
      alerts.push({ type: 'site_down', data: { error: st.lastError, status: r.status, fails: st.fails } });
    }
  }

  // Certificate: 30 / 14 / 7 / 1 days, once each; invalid once until it is valid again. A renewed certificate starts over.
  if (cfg.certAlerts && r.cert) {
    const c = r.cert;
    const bad = c.daysLeft < 0 || !c.nameOk || (!c.authorized && c.error && !/self.signed/i.test(c.error));
    if (bad && !st.certBad) { st.certBad = true; alerts.push({ type: 'cert_invalid', data: { cert: c } }); }
    if (!bad) st.certBad = false;
    if (c.daysLeft > CERT_DAYS[0]) st.certSent = [];
    else if (c.daysLeft >= 0) {
      const due = CERT_DAYS.filter(d => c.daysLeft <= d && !st.certSent.includes(d));
      if (due.length) { st.certSent = [...new Set([...st.certSent, ...due])]; alerts.push({ type: 'cert_expiring', data: { cert: c, days: Math.min(...due) } }); }
    }
  }
  return { state: st, alerts };
}

module.exports = { TYPES, CERT_DAYS, probe, evaluate, normalize, statusMatcher, parseHostPort, blockedAddress, certInfo };
