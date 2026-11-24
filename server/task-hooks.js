// Deploy recipes started from outside: a push webhook of GitHub, GitLab, Bitbucket Cloud or Bitbucket Server /
// Data Center (Gitea and Forgejo send GitHub's signature too), or a CI job calling with a token. Each recipe has
// its own hook id and secret. The request is verified, the branch filtered, then the recipe runs; with a token of
// the provider, DockGate reports the deploy back on the commit (pending -> success / failure).
//   verify(headers, rawBody, secret)  -> { ok, provider, event }   (timing-safe; no secret = refused)
//   parse(provider, event, body)      -> { push, branch, sha, message, author, repo, api } | { ping } | { ignored }
//   statusPoster(provider, git, token, targetUrl) -> (state, description) => Promise
const crypto = require('crypto');

const eq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = (secret, raw) => crypto.createHmac('sha256', String(secret)).update(raw || Buffer.alloc(0)).digest('hex');
const h = (headers, name) => headers[name.toLowerCase()];

function provider(headers) {
  if (h(headers, 'x-gitlab-event') || h(headers, 'x-gitlab-token')) return 'gitlab';
  if (h(headers, 'x-github-event')) return 'github';
  const ek = h(headers, 'x-event-key');
  if (ek) return /^repo:refs_changed|^pr:/.test(ek) || h(headers, 'x-request-id') && !h(headers, 'x-hook-uuid') ? 'bitbucket-server' : 'bitbucket';
  if (h(headers, 'x-gitea-event')) return 'gitea';
  if (h(headers, 'authorization') || h(headers, 'x-dockgate-token')) return 'ci';
  return 'unknown';
}

function verify(headers, raw, secret) {
  if (!secret) return { ok: false, why: 'no secret' };
  const p = provider(headers);
  const sig256 = h(headers, 'x-hub-signature-256');
  const sig = h(headers, 'x-hub-signature');
  const bearer = String(h(headers, 'authorization') || '').replace(/^Bearer\s+/i, '') || h(headers, 'x-dockgate-token');
  let ok = false;
  if (p === 'gitlab') ok = eq(h(headers, 'x-gitlab-token'), secret);
  else if (sig256) ok = eq(sig256, 'sha256=' + hmac(secret, raw));                 // GitHub, Gitea, Forgejo
  else if (sig && /^sha256=/.test(sig)) ok = eq(sig, 'sha256=' + hmac(secret, raw)); // Bitbucket Cloud & Server
  else if (h(headers, 'x-gitea-signature')) ok = eq(h(headers, 'x-gitea-signature'), hmac(secret, raw));
  else if (bearer) ok = eq(bearer, secret);                                          // CI / anything with the token
  const event = h(headers, 'x-github-event') || h(headers, 'x-gitlab-event') || h(headers, 'x-event-key') || h(headers, 'x-gitea-event') || (p === 'ci' ? 'run' : null);
  return { ok, provider: p, event };
}

const branchOf = (ref) => String(ref || '').replace(/^refs\/heads\//, '');
function parse(p, event, b) {
  b = b || {};
  if (/ping|diagnostics:ping/i.test(String(event)) || b.zen) return { ping: true };
  if (p === 'github' || p === 'gitea') {
    if (event && event !== 'push') return { ignored: `event ${event}` };
    if (!/^refs\/heads\//.test(b.ref || '')) return { ignored: 'not a branch (a tag?)' };
    if (b.deleted || /^0+$/.test(b.after || '')) return { ignored: 'branch deleted' };
    const repo = b.repository || {};
    const api = p === 'github' ? (repo.url && /api\./.test(repo.url) ? repo.url.replace(/\/repos\/.*$/, '') : 'https://api.github.com') : (repo.html_url ? new URL(repo.html_url).origin + '/api/v1' : null);
    return { push: true, branch: branchOf(b.ref), sha: b.after, message: (b.head_commit || {}).message || '', author: (b.pusher || {}).name || (b.sender || {}).login || '', repo: repo.full_name, api };
  }
  if (p === 'gitlab') {
    if (event && !/^Push Hook$/i.test(event)) return { ignored: `event ${event}` };
    if (!/^refs\/heads\//.test(b.ref || '')) return { ignored: 'not a branch (a tag?)' };
    if (/^0+$/.test(b.after || '')) return { ignored: 'branch deleted' };
    const last = (b.commits || []).find(c => c.id === (b.checkout_sha || b.after)) || (b.commits || []).slice(-1)[0] || {};
    const web = (b.project || {}).web_url || (b.repository || {}).homepage || '';
    return { push: true, branch: branchOf(b.ref), sha: b.checkout_sha || b.after, message: last.message || '', author: b.user_name || b.user_username || '', repo: (b.project || {}).path_with_namespace, projectId: b.project_id || (b.project || {}).id, api: web ? new URL(web).origin + '/api/v4' : 'https://gitlab.com/api/v4' };
  }
  if (p === 'bitbucket') {
    if (event && event !== 'repo:push') return { ignored: `event ${event}` };
    const ch = ((b.push || {}).changes || []).find(c => c.new && c.new.type === 'branch');
    if (!ch) return { ignored: 'no branch in the push (a tag or a deleted branch?)' };
    return { push: true, branch: ch.new.name, sha: (ch.new.target || {}).hash, message: (ch.new.target || {}).message || '', author: (b.actor || {}).display_name || '', repo: (b.repository || {}).full_name, api: 'https://api.bitbucket.org/2.0' };
  }
  if (p === 'bitbucket-server') {
    if (event && event !== 'repo:refs_changed') return { ignored: `event ${event}` };
    const ch = (b.changes || []).find(c => c.ref && c.ref.type === 'BRANCH' && c.type !== 'DELETE');
    if (!ch) return { ignored: 'no branch updated' };
    const repo = b.repository || {}; const self = (((repo.links || {}).self || [])[0] || {}).href || '';
    return { push: true, branch: ch.ref.displayId, sha: ch.toHash, message: '', author: (b.actor || {}).displayName || (b.actor || {}).name || '', repo: repo.project ? `${repo.project.key}/${repo.slug}` : repo.slug, api: self ? new URL(self).origin : null };
  }
  if (p === 'ci') return { push: true, branch: b.branch || null, sha: b.commit || b.sha || null, message: b.message || '', author: b.author || 'CI', repo: b.repo || null, ci: true };
  return { ignored: 'unknown sender' };
}

/** Does the branch match the recipe's filter? "" / null / "*" = any; "release/*" = a prefix. */
function branchMatch(filter, branch) {
  const f = String(filter || '').trim();
  if (!f || f === '*') return true;
  if (!branch) return false;
  return f.split(',').map(x => x.trim()).filter(Boolean).some(x => (x.endsWith('*') ? branch.startsWith(x.slice(0, -1)) : branch === x));
}

/** Report on the commit. token: GitHub / Gitea token, GitLab token (api), Bitbucket "user:app-password" or an access token. */
function statusPoster(p, git, token, targetUrl, name = 'DockGate deploy') {
  if (!token || !git || !git.sha || !git.repo && !git.projectId) return null;
  const url = targetUrl && /^https?:\/\//.test(targetUrl) ? targetUrl : undefined;
  return async (state, description) => {
    let endpoint, headers = { 'Content-Type': 'application/json', 'User-Agent': 'DockGate' }, body;
    const desc = String(description || '').slice(0, 140);
    if (p === 'github' || p === 'gitea') {
      endpoint = `${git.api || 'https://api.github.com'}/repos/${git.repo}/statuses/${git.sha}`;
      headers.Authorization = `Bearer ${token}`; if (p === 'github') headers.Accept = 'application/vnd.github+json';
      body = { state: state === 'skipped' ? 'error' : state, context: name, description: desc, ...(url ? { target_url: url } : {}) };
    } else if (p === 'gitlab') {
      const st = { pending: 'running', success: 'success', failure: 'failed', skipped: 'canceled' }[state];
      endpoint = `${git.api}/projects/${encodeURIComponent(git.projectId || git.repo)}/statuses/${git.sha}`;
      headers['PRIVATE-TOKEN'] = token;
      body = { state: st, name, description: desc, ...(url ? { target_url: url } : {}) };
    } else if (p === 'bitbucket' || p === 'bitbucket-server') {
      const st = { pending: 'INPROGRESS', success: 'SUCCESSFUL', failure: 'FAILED', skipped: 'STOPPED' }[state];
      endpoint = p === 'bitbucket' ? `${git.api}/repositories/${git.repo}/commit/${git.sha}/statuses/build` : `${git.api}/rest/build-status/1.0/commits/${git.sha}`;
      headers.Authorization = token.includes(':') ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`;
      body = { key: 'DOCKGATE-DEPLOY', state: st, name, description: desc, url: url || 'https://github.com/Ali7Zeynalli/dockgate' };
    } else return;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error(`${p} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } finally { clearTimeout(t); }
  };
}

/** The id the sender gives each delivery (a redelivery of the same event keeps it): GitHub, GitLab, Bitbucket, CI. */
function deliveryId(headers) {
  const v = h(headers, 'x-github-delivery') || h(headers, 'x-gitea-delivery') || h(headers, 'x-gitlab-event-uuid') || h(headers, 'idempotency-key')
    || h(headers, 'x-request-uuid') || h(headers, 'x-request-id');
  return v ? String(v).slice(0, 120) : null;
}

module.exports = { provider, verify, parse, branchMatch, statusPoster, hmac, deliveryId };
