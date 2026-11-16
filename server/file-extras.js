// Tools → Files extras: Places (where to jump), log tail, and checks of a file before / after it is saved.
//   places(a)               { home, common: [dir], projects: [{ name, dir }] } — only folders that exist
//   tail(a, path, lines)    the last lines of a (log) file; sudo for root-owned logs on a remote server
//   checkCompose(a, path, content)   docker compose config -q on the unsaved content (project folder = the file's)
//   checkNginx(a)           nginx -t on the server (after a save under /etc/nginx)
// a = { id, s, fm } from routes/files.js (s: the server row, or { id: 'local' }).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const remoteExec = require('./remote-compose');
const fmLocal = require('./file-manager-local');

const COMMON = ['/srv', '/opt', '/etc', '/etc/nginx', '/etc/caddy', '/var/log', '/var/www', '/home', '/root', '/var/lib/docker/volumes'];
const MAX_LINES = 10000;
const rand = () => crypto.randomBytes(5).toString('hex');
const isLocal = (a) => a.id === 'local';
const shq = remoteExec.shq;

async function composeProjects() {
  try {
    const docker = require('./docker');
    const list = await docker.listComposeProjects();
    return (list || []).filter(p => p.workingDir).map(p => ({ name: p.name, dir: p.workingDir }));
  } catch (e) { return []; }
}

async function places(a) {
  const projects = await composeProjects();
  if (isLocal(a)) {
    const ROOT = fmLocal.ROOT;
    // A project folder of this machine shows when it is shared with DockGate (under FILES_ROOT).
    const mapped = projects.map(p => ({ ...p, dir: p.dir.startsWith(ROOT + '/') ? p.dir : path.join(ROOT, p.dir) }))
      .filter(p => { try { return fs.statSync(fmLocal.safe(p.dir)).isDirectory(); } catch (e) { return false; } });
    return { home: ROOT, common: fmLocal.roots(), projects: mapped };
  }
  const script = `printf '%s\\n' "$HOME"; for d in ${COMMON.map(shq).join(' ')}; do [ -d "$d" ] && printf '%s\\n' "$d"; done; true`;
  const r = await remoteExec.execRemote(a.s, script);
  const lines = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const home = lines.shift() || '/';
  return { home, common: lines, projects };
}

/** Last `lines` lines of a file. A remote file the SSH user may not read → 403 EACCES (the UI then offers sudo). */
async function tail(a, p, lines, { sudo = false } = {}) {
  const n = Math.max(1, Math.min(MAX_LINES, parseInt(lines, 10) || 1000));
  if (isLocal(a)) {
    const abs = fmLocal.safe(p);
    if (!fs.statSync(abs).isFile()) throw Object.assign(new Error('Not a file'), { statusCode: 400 });
    const fd = fs.openSync(abs, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len);
      const all = buf.toString('utf8').split('\n'); if (all[all.length - 1] === '') all.pop();
      return { text: all.slice(-n).join('\n'), size };
    } finally { fs.closeSync(fd); }
  }
  const file = remoteExec.shq(require('./file-manager').normRemote(p));
  const r = await remoteExec.execRemote(a.s, `${sudo ? 'sudo -n ' : ''}tail -n ${n} -- ${file}`);
  if (r.code !== 0) {
    const out = String(r.stderr || r.stdout || '');
    if (!sudo && /permission denied/i.test(out)) throw Object.assign(new Error(`Permission denied: ${p} — read it with sudo`), { statusCode: 403, code: 'EACCES' });
    if (/password is required|a terminal is required/i.test(out)) throw Object.assign(new Error('sudo asks this user for a password — DockGate needs passwordless sudo'), { statusCode: 403, code: 'SUDO' });
    throw Object.assign(new Error(out.trim().slice(0, 300) || 'tail failed'), { statusCode: /No such file/i.test(out) ? 404 : 500 });
  }
  return { text: String(r.stdout || '').replace(/\n$/, '') };
}

const runLocal = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (e, so, se) =>
  resolve({ code: e ? (typeof e.code === 'number' ? e.code : 127) : 0, missing: !!e && e.code === 'ENOENT', out: String(se || '') + String(so || '') })));

/** docker compose config -q on the content in the editor (not yet saved), with the file's folder as the project folder. */
async function checkCompose(a, p, content) {
  const file = require('./file-manager').normRemote(p);
  const dir = path.posix.dirname(file);
  if (isLocal(a)) {
    const tmp = path.join(require('os').tmpdir(), `.dg-check-${rand()}.yml`);
    fs.writeFileSync(tmp, String(content), { mode: 0o600 });
    try {
      const r = await runLocal('docker', ['compose', '--project-directory', dir, '-f', tmp, 'config', '-q']);
      if (r.missing) return { ok: null, tool: 'docker compose config', output: 'docker compose is not available here' };
      return { ok: r.code === 0, tool: 'docker compose config', output: r.out.split(tmp).join(path.basename(file)).trim() };
    } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  }
  const tmp = `/tmp/.dg-check-${rand()}.yml`;
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const r = await remoteExec.execRemote(a.s, `umask 077; printf %s ${shq(b64)} | base64 -d > ${tmp} && docker compose --project-directory ${shq(dir)} -f ${tmp} config -q 2>&1; rc=$?; rm -f ${tmp}; exit $rc`);
  const out = String(r.stdout || r.stderr || '').split(tmp).join(path.posix.basename(file)).trim();
  if (r.code === 127 || /docker: ('compose' is not a docker command|command not found)|unknown command "compose"/i.test(out)) return { ok: null, tool: 'docker compose config', output: 'docker compose is not installed on this server' };
  return { ok: r.code === 0, tool: 'docker compose config', output: out };
}

/** nginx -t on the server (the whole configuration as saved). null when nginx is not installed there. */
async function checkNginx(a) {
  if (isLocal(a)) return { ok: null, tool: 'nginx -t', output: 'nginx -t runs on remote servers only' };
  const r = await remoteExec.execRemote(a.s, 'command -v nginx >/dev/null 2>&1 || exit 127; sudo -n nginx -t 2>&1 || nginx -t 2>&1');
  const out = String(r.stdout || r.stderr || '').trim();
  if (r.code === 127) return { ok: null, tool: 'nginx -t', output: 'nginx is not installed on this server (it may run in a container)' };
  return { ok: r.code === 0, tool: 'nginx -t', output: out };
}

// Check the unsaved content of a system file with the tool that owns it, on the server:
//   sshd → sshd -t -f   · sudoers → visudo -cf   · fstab → findmnt --verify --tab-file
const TOOLS = {
  sshd: { tool: 'sshd -t', cmd: (t) => `sudo -n sshd -t -f ${t} 2>&1 || sshd -t -f ${t} 2>&1`, missing: /sshd: (command )?not found/ },
  sudoers: { tool: 'visudo -c', cmd: (t) => `sudo -n visudo -cf ${t} 2>&1 || visudo -cf ${t} 2>&1`, missing: /visudo: (command )?not found/ },
  fstab: { tool: 'findmnt --verify', cmd: (t) => `out=$(findmnt --verify --tab-file ${t} 2>&1); echo "$out"; echo "$out" | grep -qE '^\\s*\\[E\\]' && exit 1; exit 0`, missing: /findmnt: (command )?not found/ },
};
async function checkFile(a, kind, content) {
  const T = TOOLS[kind]; if (!T) throw Object.assign(new Error('Unknown check'), { statusCode: 400 });
  if (isLocal(a)) return { ok: null, tool: T.tool, output: `${T.tool} runs on remote servers only` };
  const tmp = `/tmp/.dg-check-${rand()}`;
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const r = await remoteExec.execRemote(a.s, `umask 077; printf %s ${shq(b64)} | base64 -d > ${tmp}; ( ${T.cmd(tmp)} ); rc=$?; rm -f ${tmp}; exit $rc`);
  const out = String(r.stdout || r.stderr || '').split(tmp).join('(this file)').trim();
  if (T.missing.test(out)) return { ok: null, tool: T.tool, output: `${T.tool.split(' ')[0]} is not available on this server` };
  return { ok: r.code === 0, tool: T.tool, output: out || (r.code === 0 ? 'OK' : 'failed') };
}

module.exports = { places, tail, checkCompose, checkNginx, checkFile, COMMON, MAX_LINES };
