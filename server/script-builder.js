// Script Builder: a script is a list of steps chosen from blocks; DockGate writes the shell script from them.
// No step carries raw shell except "Custom command" — every value goes through shq() or a strict pattern, so
// a name or path can not break out of its place. Pure (unit tested); server/scripts.js stores and runs them.
//   BLOCKS            the blocks the page offers, with their fields
//   build(spec)       { name, steps:[{ type, ...fields, onFail }] } → the .sh text
//   TEMPLATES         ready-made scripts (daily DB backup, weekly Docker cleanup, restart when a site is down …)
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,40}$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PATH_RE = /^\/[\w./@:+-]*$/;
const DEST_RE = /^([\w.-]+@)?[\w.-]+:[\w./~@+-]*$|^\/[\w./@:+-]*$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,254}$/i;

const need = (v, re, label) => { const s = String(v == null ? '' : v).trim(); if (!re.test(s)) throw bad(`${label}`); return s; };
const num = (v, lo, hi, label) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${label}: ${lo}–${hi}`); return n; };

// fields: [key, label, kind ('text'|'number'|'select'|'textarea'), placeholder/options, required]
const BLOCKS = {
  db_backup: { label: 'Database backup', group: 'Backup', desc: 'pg_dump / mysqldump from a database container into a .sql.gz file',
    fields: [['container', 'Container', 'text', 'postgres', true], ['engine', 'Database', 'select', ['postgres', 'mysql', 'mariadb'], true], ['database', 'Database name', 'text', 'app (empty = all)', false], ['user', 'User', 'text', 'postgres / root', false], ['dir', 'Into folder', 'text', '/var/backups/db', true]] },
  volume_backup: { label: 'Volume backup', group: 'Backup', desc: 'A Docker volume into a .tar.gz file', fields: [['volume', 'Volume', 'text', 'app_data', true], ['dir', 'Into folder', 'text', '/var/backups/volumes', true]] },
  folder_backup: { label: 'Folder backup', group: 'Backup', desc: 'A folder into a .tar.gz file', fields: [['src', 'Folder', 'text', '/srv/app', true], ['dir', 'Into folder', 'text', '/var/backups/files', true]] },
  copy_remote: { label: 'Copy to another place', group: 'Backup', desc: 'rsync a folder or file to another server or folder', fields: [['src', 'From', 'text', '/var/backups/db/', true], ['dest', 'To', 'text', 'backup@10.0.0.9:/backups/web-1/', true]] },
  cleanup_old: { label: 'Delete old files', group: 'Backup', desc: 'Files older than N days in a folder', fields: [['dir', 'Folder', 'text', '/var/backups/db', true], ['pattern', 'Names', 'text', '*.sql.gz', false], ['days', 'Older than (days)', 'number', '7', true]] },
  container_action: { label: 'Container: restart / stop / start', group: 'Docker', desc: '', fields: [['container', 'Container', 'text', 'web', true], ['action', 'Action', 'select', ['restart', 'stop', 'start'], true]] },
  image_pull: { label: 'Pull an image', group: 'Docker', desc: '', fields: [['image', 'Image', 'text', 'nginx:1.27', true]] },
  docker_prune: { label: 'Docker cleanup', group: 'Docker', desc: 'Unused images, stopped containers, build cache (volumes are never removed)', fields: [['until', 'Older than (hours)', 'number', '168', false]] },
  compose_redeploy: { label: 'Compose: pull and redeploy', group: 'Docker', desc: 'docker compose pull && up -d in the project folder', fields: [['dir', 'Project folder', 'text', '/srv/app', true]] },
  http_check: { label: 'Check a URL', group: 'Checks', desc: 'Fails when the status is not the expected one', fields: [['url', 'URL', 'text', 'https://example.com/health', true], ['expect', 'Expected status', 'text', '200', false]] },
  disk_check: { label: 'Check disk space', group: 'Checks', desc: 'Fails when the disk is fuller than the limit', fields: [['path', 'Disk of', 'text', '/', true], ['max', 'At most (%)', 'number', '85', true]] },
  notify: { label: 'Send a message', group: 'Notify', desc: 'POST to a webhook (Slack, Discord, ntfy, Teams…)', fields: [['url', 'Webhook URL', 'text', 'https://ntfy.sh/my-topic', true], ['text', 'Message', 'text', 'Backup of $(hostname) done', true]] },
  sleep: { label: 'Wait', group: 'Flow', desc: '', fields: [['seconds', 'Seconds', 'number', '30', true]] },
  custom: { label: 'Custom command', group: 'Flow', desc: 'Any shell — runs as written', fields: [['command', 'Command', 'textarea', 'systemctl reload nginx', true]] },
};

function stepShell(s) {
  switch (s.type) {
    case 'db_backup': {
      const c = need(s.container, CONTAINER_RE, 'Container name'), dir = need(s.dir, PATH_RE, 'Folder: an absolute path');
      const db = String(s.database || '').trim(); if (db && !/^[\w.-]{1,64}$/.test(db)) throw bad('Database name');
      const user = String(s.user || '').trim(); if (user && !/^[\w.-]{1,64}$/.test(user)) throw bad('User');
      const file = `f=${shq(`${dir}/${c}-${db || 'all'}-`)}"$(date +%F-%H%M).sql.gz"`;
      if (s.engine === 'postgres') return `mkdir -p ${shq(dir)}\n${file}\ndocker exec ${shq(c)} ${db ? 'pg_dump' : 'pg_dumpall'} -U ${shq(user || 'postgres')}${db ? ` ${shq(db)}` : ''} | gzip > "$f"\ntest -s "$f"\necho "→ $f"`;
      if (s.engine === 'mysql' || s.engine === 'mariadb') {
        const tool = s.engine === 'mariadb' ? 'mariadb-dump' : 'mysqldump';
        return `mkdir -p ${shq(dir)}\n${file}\ndocker exec ${shq(c)} sh -c ${shq(`exec ${tool} -u${user || 'root'} -p"$MYSQL_ROOT_PASSWORD$MARIADB_ROOT_PASSWORD" --single-transaction ${db ? db : '--all-databases'}`)} | gzip > "$f"\ntest -s "$f"\necho "→ $f"`;
      }
      throw bad('Database: postgres, mysql or mariadb');
    }
    case 'volume_backup': {
      const v = need(s.volume, CONTAINER_RE, 'Volume name'), dir = need(s.dir, PATH_RE, 'Folder: an absolute path');
      return `mkdir -p ${shq(dir)}\nf=${shq(v + '-')}"$(date +%F-%H%M).tar.gz"\ndocker run --rm -v ${shq(v + ':/v:ro')} -v ${shq(dir + ':/b')} alpine tar czf "/b/$f" -C /v .\necho "→ ${dir}/$f"`;
    }
    case 'folder_backup': {
      const src = need(s.src, PATH_RE, 'Folder: an absolute path'), dir = need(s.dir, PATH_RE, 'Into folder: an absolute path');
      const base = src.replace(/\/+$/, '').split('/').pop() || 'root';
      return `mkdir -p ${shq(dir)}\nf=${shq(`${dir}/${base}-`)}"$(date +%F-%H%M).tar.gz"\ntar czf "$f" -C ${shq(src)} .\necho "→ $f"`;
    }
    case 'copy_remote': {
      const src = need(s.src, PATH_RE, 'From: an absolute path'), dest = need(s.dest, DEST_RE, 'To: user@host:/path or /path');
      return `rsync -az --partial ${shq(src)} ${shq(dest)}`;
    }
    case 'cleanup_old': {
      const dir = need(s.dir, PATH_RE, 'Folder: an absolute path');
      if (['/', '/etc', '/usr', '/var', '/home', '/root', '/boot', '/bin', '/lib'].includes(dir.replace(/\/+$/, '') || '/')) throw bad(`Delete old files: not in ${dir}`);
      const pat = String(s.pattern || '*').trim(); if (!/^[\w.*?\-[\]]{1,64}$/.test(pat)) throw bad('Names: e.g. *.sql.gz');
      const days = num(s.days, 1, 3650, 'Older than (days)');
      return `find ${shq(dir)} -maxdepth 1 -type f -name ${shq(pat)} -mtime +${days} -print -delete`;
    }
    case 'container_action': {
      const c = need(s.container, CONTAINER_RE, 'Container name');
      if (!['restart', 'stop', 'start'].includes(s.action)) throw bad('Action');
      return `docker ${s.action} ${shq(c)}`;
    }
    case 'image_pull': return `docker pull ${shq(need(s.image, IMAGE_RE, 'Image'))}`;
    case 'docker_prune': { const h = s.until === '' || s.until == null ? 0 : num(s.until, 1, 87600, 'Older than (hours)'); return `docker system prune -af${h ? ` --filter ${shq(`until=${h}h`)}` : ''}`; }
    case 'compose_redeploy': { const dir = need(s.dir, PATH_RE, 'Project folder: an absolute path'); return `cd ${shq(dir)}\ndocker compose pull\ndocker compose up -d --remove-orphans`; }
    case 'http_check': {
      const url = String(s.url || '').trim(); let u; try { u = new URL(url); } catch (e) { throw bad('URL'); } if (!/^https?:$/.test(u.protocol)) throw bad('URL: http(s)://');
      const ex = String(s.expect || '200').trim(); if (!/^\d{3}$/.test(ex)) throw bad('Expected status: e.g. 200');
      return `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 ${shq(u.toString())})\n[ "$code" = ${shq(ex)} ] || { echo "${u.host}: HTTP $code (expected ${ex})"; false; }`;
    }
    case 'disk_check': {
      const p = need(s.path, PATH_RE, 'Disk of: an absolute path'), max = num(s.max, 1, 99, 'At most (%)');
      return `use=$(df -P ${shq(p)} | awk 'NR==2 {gsub("%",""); print $5}')\necho "${p}: $use% used"\n[ "$use" -le ${max} ] || { echo "above ${max}%"; false; }`;
    }
    case 'notify': {
      let u; try { u = new URL(String(s.url || '')); } catch (e) { throw bad('Webhook URL'); } if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('Webhook URL: https://');
      const text = String(s.text || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
      if (!text) throw bad('Message is required');
      // $(hostname) and $SCRIPT_STATUS are the only expansions offered; everything else stays literal
      const safe = text.replace(/[\\"`]/g, '').replace(/\$(?!\(hostname\)|SCRIPT_STATUS\b|SCRIPT_NAME\b)/g, '\\$');
      return `msg="${safe}"\ncurl -fsS --max-time 15 -H 'Content-Type: text/plain' -d "$msg" ${shq(u.toString())} >/dev/null`;
    }
    case 'sleep': return `sleep ${num(s.seconds, 1, 3600, 'Seconds')}`;
    case 'custom': { const c = String(s.command || '').trim(); if (!c) throw bad('Command is required'); return c; }
    default: throw bad(`Unknown block: ${s.type}`);
  }
}

/** The whole script. Each step runs in its own subshell with set -e; "stop" (default) ends the script on failure. */
function build(spec) {
  const name = need(spec.name, NAME_RE, 'Name: lowercase letters, digits, . _ - (up to 41)');
  const steps = spec.steps || [];
  if (!steps.length) throw bad('Add at least one step');
  if (steps.length > 40) throw bad('At most 40 steps');
  const out = [
    '#!/usr/bin/env bash',
    `# ${name} — made with DockGate Script Builder (Server Console → Scripts). Edit it there: changes made here are replaced.`,
    'set -uo pipefail',
    `SCRIPT_NAME=${shq(name)}`,
    'SCRIPT_STATUS=ok',
    'failed=0',
    'step() { printf "\\n[%s] ▶ %s\\n" "$(date "+%F %T")" "$1"; }',
    '',
  ];
  steps.forEach((s, i) => {
    const label = (BLOCKS[s.type] ? (s.title || BLOCKS[s.type].label) : s.type).replace(/[\r\n"`$\\]/g, ' ');
    const body = stepShell(s).split('\n').map(l => '  ' + l).join('\n');
    const onFail = s.onFail === 'continue' ? 'continue' : 'stop';
    // A standalone subshell: set -e works there (inside an "if" condition bash would ignore it).
    out.push(`# ${i + 1}. ${label}`, `step "${i + 1}. ${label}"`, '(', '  set -e', body, ')', 'if [ $? -ne 0 ]; then');
    out.push(onFail === 'stop' ? `  echo "✗ step ${i + 1} failed — stopping"; SCRIPT_STATUS=failed; exit 1` : `  echo "✗ step ${i + 1} failed — going on"; failed=$((failed+1)); SCRIPT_STATUS=failed`);
    out.push('fi', '');
  });
  out.push('if [ "$failed" -gt 0 ]; then echo; echo "Done with $failed failed step(s)"; exit 1; fi', 'echo; echo "✓ Done"', '');
  return out.join('\n');
}

const TEMPLATES = [
  { id: 'db-backup', name: 'db-backup', title: 'Daily database backup, keep 7 days, copy off the server', schedule: '30 3 * * *',
    steps: [{ type: 'db_backup', container: 'postgres', engine: 'postgres', database: 'app', user: 'postgres', dir: '/var/backups/db' }, { type: 'cleanup_old', dir: '/var/backups/db', pattern: '*.sql.gz', days: 7 }, { type: 'copy_remote', src: '/var/backups/db/', dest: 'backup@10.0.0.9:/backups/web-1/db/', onFail: 'continue' }, { type: 'disk_check', path: '/var/backups', max: 85, onFail: 'continue' }] },
  { id: 'volume-backup', name: 'volume-backup', title: 'Volume backup, keep 14 days', schedule: '0 2 * * *',
    steps: [{ type: 'volume_backup', volume: 'app_data', dir: '/var/backups/volumes' }, { type: 'cleanup_old', dir: '/var/backups/volumes', pattern: '*.tar.gz', days: 14 }] },
  { id: 'docker-cleanup', name: 'docker-cleanup', title: 'Weekly Docker cleanup (older than 7 days)', schedule: '0 4 * * 0',
    steps: [{ type: 'docker_prune', until: 168 }, { type: 'disk_check', path: '/', max: 90, onFail: 'continue' }] },
  { id: 'restart-if-down', name: 'restart-if-down', title: 'Restart a container when its site does not answer', schedule: '*/5 * * * *',
    steps: [{ type: 'http_check', url: 'https://example.com/health', expect: '200', onFail: 'continue' }, { type: 'custom', command: '[ "$SCRIPT_STATUS" = failed ] && docker restart web || true' }] },
  { id: 'compose-update', name: 'compose-update', title: 'Pull and redeploy a Compose project, then check it', schedule: '0 5 * * 1',
    steps: [{ type: 'compose_redeploy', dir: '/srv/app' }, { type: 'sleep', seconds: 20 }, { type: 'http_check', url: 'https://example.com/health', expect: '200' }] },
];

module.exports = { BLOCKS, TEMPLATES, build, stepShell, NAME_RE };
