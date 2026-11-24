// How DockGate reaches the Git repository of a stack it did not clone itself (adopted from the server, or found by
// its containers): an access token (HTTPS) or an SSH key from Servers → SSH keys, per server and project. Without
// one, git uses whatever the server's own user has set up (its SSH key, a credential helper). Tokens are stored
// encrypted, never shown again, never written into the repository's .git/config.
const { db } = require('./db');
const { encrypt, decrypt } = require('./auth/secrets');

db.exec('CREATE TABLE IF NOT EXISTS git_access (server_id TEXT NOT NULL, project TEXT NOT NULL, key_id TEXT, token TEXT, updated_at INTEGER, PRIMARY KEY (server_id, project))');
const q = {
  get: db.prepare('SELECT * FROM git_access WHERE server_id = ? AND project = ?'),
  put: db.prepare('INSERT INTO git_access (server_id, project, key_id, token, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, project) DO UPDATE SET key_id = excluded.key_id, token = excluded.token, updated_at = excluded.updated_at'),
  del: db.prepare('DELETE FROM git_access WHERE server_id = ? AND project = ?'),
};

/** { keyId, token } stored for a project ('' when none). */
function get(serverId, project) {
  const r = q.get.get(serverId || 'local', project);
  if (!r) return { keyId: '', token: '' };
  let token = ''; try { token = r.token ? decrypt(r.token) : ''; } catch (e) { /* key changed: as if none */ }
  return { keyId: r.key_id || '', token };
}
/** What the page may know: the method, never the token. */
function describe(serverId, project) {
  const a = get(serverId, project);
  return { method: a.keyId ? 'key' : a.token ? 'token' : 'server', keyId: a.keyId || null, hasToken: !!a.token };
}
function set(serverId, project, { method, keyId, token }) {
  if (method === 'server') { q.del.run(serverId || 'local', project); return describe(serverId, project); }
  if (method === 'key') {
    if (!keyId || !/^[\w.-]{1,128}$/.test(String(keyId))) throw Object.assign(new Error('Choose an SSH key'), { statusCode: 400 });
    q.put.run(serverId || 'local', project, String(keyId), null, Date.now());
  } else if (method === 'token') {
    const cur = get(serverId, project);
    const t = token == null || token === '' ? cur.token : String(token).trim();
    if (!t) throw Object.assign(new Error('Paste the access token'), { statusCode: 400 });
    if (/\s/.test(t) || t.length > 500) throw Object.assign(new Error('That does not look like an access token'), { statusCode: 400 });
    q.put.run(serverId || 'local', project, null, encrypt(t), Date.now());
  } else throw Object.assign(new Error('Choose how DockGate reaches the repository'), { statusCode: 400 });
  return describe(serverId, project);
}
function remove(serverId, project) { q.del.run(serverId || 'local', project); }

// git@host:owner/repo(.git) ⇄ https://host/owner/repo(.git) — a token needs HTTPS, a key needs SSH
function toHttps(url) {
  const s = String(url || '').trim();
  let m = s.match(/^git@([^:]+):(.+)$/); if (m) return `https://${m[1]}/${m[2]}`;
  m = s.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+)$/); if (m) return `https://${m[1]}/${m[2]}`;
  return s.replace(/^(https:\/\/)[^@/]+@/i, '$1'); // no user / token of its own
}
function toSsh(url) {
  const s = String(url || '').trim();
  const m = s.replace(/^(https:\/\/)[^@/]+@/i, '$1').match(/^https:\/\/([^/]+)\/(.+)$/i);
  return m ? `git@${m[1]}:${m[2]}` : s;
}

/** https://host/… with the token as git expects it there (a user name and the token as its password). */
function withToken(url, token) {
  const u = toHttps(url); if (!token || !/^https:\/\//i.test(u)) return u;
  const host = (u.match(/^https:\/\/([^/]+)/i) || [])[1] || '';
  const user = token.includes(':') ? '' : /github/i.test(host) ? 'x-access-token:' : /bitbucket/i.test(host) ? 'x-token-auth:' : 'oauth2:';
  const cred = token.includes(':') ? token.split(':').map(encodeURIComponent).join(':') : user + encodeURIComponent(token);
  return u.replace(/^https:\/\//i, `https://${cred}@`);
}

/** Turns git's own auth failures into what to do. */
function explain(msg) {
  const s = String(msg || '');
  if (/Invalid username or token|could not read Password|HTTP Basic: Access denied|Invalid credentials/i.test(s) || (/Authentication failed for/i.test(s) && /\*\*\*|x-access-token|oauth2|x-token-auth/.test(s))) {
    return `${s.trim()}\n→ The repository refused the access token: it is wrong, expired, or has no read access to this repository. Paste a new one: the stack's page → Git → Access…`;
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled|Invalid username or password|403/i.test(s)) {
    return `${s.trim()}\n→ The repository is private and git has no access to it. Give DockGate an access token or an SSH key: the stack's page → Git → Access…`;
  }
  if (/Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/i.test(s)) {
    return `${s.trim()}\n→ The server's SSH key is not accepted for this repository. Choose an SSH key for it (the stack's page → Git → Access…) and add its public key to the repository's Deploy keys — or use an access token.`;
  }
  return s;
}

module.exports = { get, set, describe, remove, toHttps, toSsh, withToken, explain };
