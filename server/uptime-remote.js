// Uptime from other servers: the same check run on a server DockGate manages, over its SSH login, with the
// tools a server has (curl, nc / bash, openssl, getent). With several places a check is down only when every
// place fails, so one place with a network problem does not raise an alert.
//   probeOn(server, check)  → { ok, ms, status?, error? }
//   merge(results)          one result from several places: { ok, ms, status, error, cert, places }
const remoteExec = require('./remote-compose');
const { statusMatcher, parseHostPort } = require('./uptime-probe');
const shq = remoteExec.shq;
const MARK = '__DG_UPTIME__';

function script(check) {
  const c = check.config || {};
  const t = Math.max(1, Math.min(60, Number(c.timeout) || 10));
  if (check.type === 'http') {
    const h = Object.entries(c.headers || {}).map(([k, v]) => `-H ${shq(`${k}: ${v}`)}`).join(' ');
    const body = c.contains || c.notContains ? '' : '-o /dev/null';
    return `command -v curl >/dev/null 2>&1 || { echo "${MARK}nocurl"; exit 0; }; `
      + `curl -sS ${body} ${c.follow === false ? '' : '-L --max-redirs 5'} ${c.ignoreTls ? '-k' : ''} -X ${['GET', 'HEAD', 'POST'].includes(c.method) ? c.method : 'GET'} ${c.method === 'HEAD' ? '-I' : ''} `
      + `--max-time ${t} -A DockGate-Uptime/1.0 ${h} -w '\\n${MARK}%{http_code} %{time_total}' ${shq(check.target)} 2>&1 | tail -c 1100000`;
  }
  if (check.type === 'tcp') {
    const { host, port } = parseHostPort(check.target, 0);
    return `s=$(date +%s%N); if command -v nc >/dev/null 2>&1; then nc -z -w ${t} ${shq(host)} ${port} 2>&1; else timeout ${t} bash -c ${shq(`</dev/tcp/${host}/${port}`)} 2>&1; fi; rc=$?; e=$(date +%s%N); echo "${MARK}$rc $(( (e - s) / 1000000 ))"`;
  }
  if (check.type === 'ssl') {
    const { host, port } = parseHostPort(check.target, 443);
    return `command -v openssl >/dev/null 2>&1 || { echo "${MARK}noopenssl"; exit 0; }; s=$(date +%s%N); out=$(echo | timeout ${t} openssl s_client -servername ${shq(host)} -connect ${shq(`${host}:${port}`)} 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null); e=$(date +%s%N); echo "$out"; echo "${MARK}$( [ -n "$out" ] && echo 0 || echo 1 ) $(( (e - s) / 1000000 ))"`;
  }
  if (check.type === 'dns') return `s=$(date +%s%N); out=$(timeout ${t} getent ahosts ${shq(check.target)} | awk '{print $1}' | sort -u | head -8 | tr '\\n' ' '); e=$(date +%s%N); echo "$out"; echo "${MARK}$( [ -n "$out" ] && echo 0 || echo 1 ) $(( (e - s) / 1000000 ))"`;
  throw new Error('Unknown check type');
}

/** Parse what the script printed (exported for tests). */
function parse(check, out) {
  const text = String(out || '');
  const i = text.lastIndexOf(MARK);
  if (i < 0) return { ok: false, ms: 0, error: (text.trim().split('\n').pop() || 'no answer').slice(0, 200) };
  const tail = text.slice(i + MARK.length).trim(), before = text.slice(0, i).replace(/\n$/, '');
  if (tail === 'nocurl') return { ok: false, ms: 0, error: 'curl is not installed on this server' };
  if (tail === 'noopenssl') return { ok: false, ms: 0, error: 'openssl is not installed on this server' };
  const c = check.config || {};
  if (check.type === 'http') {
    const [code, secs] = tail.split(/\s+/); const status = Number(code), ms = Math.round(Number(secs) * 1000) || 0;
    if (!status) { const err = before.split('\n').filter(l => /^curl: \(\d+\)/.test(l)).pop() || 'no answer'; return { ok: false, ms, error: /timed out/i.test(err) ? `Timeout after ${c.timeout || 10} s` : err.replace(/^curl: \(\d+\)\s*/, '') }; }
    let ok; try { ok = statusMatcher(c.expect)(status); } catch (e) { ok = false; }
    if (!ok) return { ok: false, ms, status, error: `HTTP ${status} (expected ${c.expect || '200-399'})` };
    if (c.contains && !before.includes(c.contains)) return { ok: false, ms, status, error: `The page does not contain "${c.contains}"` };
    if (c.notContains && before.includes(c.notContains)) return { ok: false, ms, status, error: `The page contains "${c.notContains}"` };
    return { ok: true, ms, status };
  }
  const [rc, ms] = tail.split(/\s+/).map(Number);
  if (rc === 0) return { ok: true, ms: ms || 0, ...(check.type === 'dns' ? { detail: before.trim() } : {}) };
  const msg = check.type === 'tcp' ? (rc === 124 ? `Timeout after ${c.timeout || 10} s` : /refused/i.test(before) ? 'Connection refused' : 'Connection failed')
    : check.type === 'ssl' ? 'No certificate (TLS connection failed)' : `${check.target} does not resolve`;
  return { ok: false, ms: ms || 0, error: msg };
}

async function probeOn(server, check) {
  try {
    let timer;
    const r = await Promise.race([
      remoteExec.execRemote(server, script(check)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SSH: no answer in time')), ((check.config && check.config.timeout) || 10) * 1000 + 15000); }),
    ]).finally(() => clearTimeout(timer));
    return parse(check, String(r.stdout || '') + String(r.stderr || ''));
  } catch (e) { return { ok: false, ms: 0, error: `SSH: ${e.message}`, ssh: true }; }
}

/** Several places → one result: ok when any place is ok; the error names each place. */
function merge(results) {
  const places = {};
  for (const [id, label, r] of results) places[id] = { label, ok: !!r.ok, ms: r.ms || 0, status: r.status || null, error: r.ok ? null : r.error || 'failed' };
  const okOnes = results.filter(([, , r]) => r.ok);
  const first = okOnes[0] ? okOnes[0][2] : results[0][2];
  const cert = (results.find(([id, , r]) => id === 'dockgate' && r.cert) || [])[2];
  return {
    ok: okOnes.length > 0, ms: first.ms || 0, status: first.status || null, detail: first.detail,
    error: okOnes.length ? null : results.map(([, label, r]) => `${label}: ${r.error || 'failed'}`).join(' · '),
    cert: cert ? cert.cert : undefined, places,
    partial: okOnes.length > 0 && okOnes.length < results.length,
  };
}

module.exports = { script, parse, probeOn, merge, MARK };
