// Script Builder: a script is a list of steps chosen from blocks; DockGate writes the shell script from them.
// No step carries raw shell except "Custom command" - every value goes through shq() or a strict pattern, so
// a name or path can not break out of its place. Pure (unit tested); server/scripts.js stores and runs them.
//   BLOCKS            the blocks the page offers, with their fields
//   build(spec)       { name, steps:[{ type, ...fields, onFail }] } -> the .sh text
//   TEMPLATES         ready-made scripts (daily DB backup, weekly Docker cleanup, restart when a site is down ...)
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,40}$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PATH_RE = /^\/[\w./@:+-]*$/;
const DEST_RE = /^([\w.-]+@)?[\w.-]+:[\w./~@+-]*$|^\/[\w./@:+-]*$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,254}$/i;

const need = (v, re, label) => { const s = String(v == null ? '' : v).trim(); if (!re.test(s)) throw bad(`${label}`); return s; };
const num = (v, lo, hi, label) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${label}: ${lo}-${hi}`); return n; };

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
  notify: { label: 'Send a message', group: 'Notify', desc: 'POST to a webhook (Slack, Discord, ntfy, Teams...)', fields: [['url', 'Webhook URL', 'text', 'https://ntfy.sh/my-topic', true], ['text', 'Message', 'text', 'Backup of $(hostname) done', true]] },
  os_update: { label: 'Update the system', group: 'System', root: true, desc: 'apt / dnf: security updates only, or everything. Services > Auto updates already does daily security updates - this adds a full update on your schedule',
    fields: [['mode', 'Which updates', 'select', ['security', 'all'], true], ['autoremove', 'Remove unused packages', 'select', ['yes', 'no'], false]] },
  reboot_if_needed: { label: 'Reboot if an update needs it', group: 'System', root: true, desc: 'Only when the system asks for it (/var/run/reboot-required or needs-restarting), optionally only in a time window',
    fields: [['window', 'Only between (server time)', 'text', '03:00-05:00 (empty = any time)', false], ['delay', 'In (minutes)', 'number', '1', false]] },
  service: { label: 'System service: restart / reload / check', group: 'System', root: true, desc: 'systemctl; "check" fails when the service is not running', fields: [['name', 'Service', 'text', 'nginx', true], ['action', 'Action', 'select', ['check', 'restart', 'reload', 'start'], true]] },
  journal_vacuum: { label: 'Shrink the system journal', group: 'System', root: true, desc: 'journalctl --vacuum-size, and old rotated logs in /var/log', fields: [['size', 'Keep at most', 'text', '500M', true], ['days', 'Delete rotated logs older than (days)', 'number', '30 (empty = keep)', false]] },
  wait_healthy: { label: 'Wait until a container is healthy', group: 'Docker', desc: 'Until its health check says healthy (or it runs, without a health check)', fields: [['container', 'Container', 'text', 'web', true], ['timeout', 'At most (seconds)', 'number', '120', false]] },
  git_pull: { label: 'Git pull', group: 'Docker', desc: 'Fast-forward a checkout (fails on local changes)', fields: [['dir', 'Folder', 'text', '/srv/app', true], ['branch', 'Branch', 'text', 'main (empty = current)', false]] },
  db_maintenance: { label: 'Database maintenance', group: 'Backup', desc: 'Postgres VACUUM ANALYZE (vacuumdb), MySQL / MariaDB OPTIMIZE (mysqlcheck) in its container',
    fields: [['container', 'Container', 'text', 'postgres', true], ['engine', 'Database', 'select', ['postgres', 'mysql', 'mariadb'], true], ['database', 'Database name', 'text', 'app (empty = all)', false], ['user', 'User', 'text', 'postgres / root', false]] },
  port_check: { label: 'Check a port', group: 'Checks', desc: 'Fails when host:port does not accept a connection', fields: [['host', 'Host', 'text', '127.0.0.1', true], ['port', 'Port', 'number', '5432', true]] },
  mem_check: { label: 'Check memory', group: 'Checks', desc: 'Fails when more memory is used than the limit', fields: [['max', 'At most (%)', 'number', '90', true]] },
  load_check: { label: 'Check CPU load', group: 'Checks', desc: 'Fails when the 5-minute load per CPU is above the limit', fields: [['max', 'At most (load per CPU)', 'text', '1.5', true]] },
  ssl_check: { label: 'Check an SSL certificate', group: 'Checks', desc: 'Fails when it expires in fewer days than the limit', fields: [['domain', 'Domain', 'text', 'example.com', true], ['days', 'At least (days left)', 'number', '14', true]] },
  top_containers: { label: 'Report the busiest containers', group: 'Checks', desc: 'Prints the containers using the most memory / CPU (docker stats)', fields: [['count', 'How many', 'number', '5', false]] },
  telegram: { label: 'Telegram message', group: 'Notify', desc: 'With a bot token and chat ID (kept in the script file on the server)', fields: [['token', 'Bot token', 'text', '123456:ABC...', true], ['chat', 'Chat ID', 'text', '-1001234567890 or @channel', true], ['text', 'Message', 'text', '$(hostname): $SCRIPT_STATUS', true]] },
  sleep: { label: 'Wait', group: 'Flow', desc: '', fields: [['seconds', 'Seconds', 'number', '30', true]] },
  custom: { label: 'Custom command', group: 'Flow', desc: 'Any shell - runs as written', fields: [['command', 'Command', 'textarea', 'systemctl reload nginx', true]] },
};

function stepShell(s) {
  switch (s.type) {
    case 'db_backup': {
      const c = need(s.container, CONTAINER_RE, 'Container name'), dir = need(s.dir, PATH_RE, 'Folder: an absolute path');
      const db = String(s.database || '').trim(); if (db && !/^[\w.-]{1,64}$/.test(db)) throw bad('Database name');
      const user = String(s.user || '').trim(); if (user && !/^[\w.-]{1,64}$/.test(user)) throw bad('User');
      const file = `f=${shq(`${dir}/${c}-${db || 'all'}-`)}"$(date +%F-%H%M).sql.gz"`;
      if (s.engine === 'postgres') return `mkdir -p ${shq(dir)}\n${file}\ndocker exec ${shq(c)} ${db ? 'pg_dump' : 'pg_dumpall'} -U ${shq(user || 'postgres')}${db ? ` ${shq(db)}` : ''} | gzip > "$f"\ntest -s "$f"\necho " -> $f"`;
      if (s.engine === 'mysql' || s.engine === 'mariadb') {
        const tool = s.engine === 'mariadb' ? 'mariadb-dump' : 'mysqldump';
        return `mkdir -p ${shq(dir)}\n${file}\ndocker exec ${shq(c)} sh -c ${shq(`exec ${tool} -u${user || 'root'} -p"$MYSQL_ROOT_PASSWORD$MARIADB_ROOT_PASSWORD" --single-transaction ${db ? db : '--all-databases'}`)} | gzip > "$f"\ntest -s "$f"\necho " -> $f"`;
      }
      throw bad('Database: postgres, mysql or mariadb');
    }
    case 'volume_backup': {
      const v = need(s.volume, CONTAINER_RE, 'Volume name'), dir = need(s.dir, PATH_RE, 'Folder: an absolute path');
      return `mkdir -p ${shq(dir)}\nf=${shq(v + '-')}"$(date +%F-%H%M).tar.gz"\ndocker run --rm -v ${shq(v + ':/v:ro')} -v ${shq(dir + ':/b')} alpine tar czf "/b/$f" -C /v .\necho " -> ${dir}/$f"`;
    }
    case 'folder_backup': {
      const src = need(s.src, PATH_RE, 'Folder: an absolute path'), dir = need(s.dir, PATH_RE, 'Into folder: an absolute path');
      const base = src.replace(/\/+$/, '').split('/').pop() || 'root';
      return `mkdir -p ${shq(dir)}\nf=${shq(`${dir}/${base}-`)}"$(date +%F-%H%M).tar.gz"\ntar czf "$f" -C ${shq(src)} .\necho " -> $f"`;
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
    case 'os_update': {
      const all = s.mode === 'all', rm = s.autoremove !== 'no';
      return [
        'if command -v apt-get >/dev/null 2>&1; then',
        '  export DEBIAN_FRONTEND=noninteractive',
        '  apt-get update -q',
        all ? '  apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade'
          : '  if command -v unattended-upgrade >/dev/null 2>&1; then unattended-upgrade -v; else apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade; fi',
        rm ? '  apt-get -y -q autoremove' : '',
        'elif command -v dnf >/dev/null 2>&1; then',
        `  dnf -y -q upgrade${all ? '' : ' --security'}`,
        rm ? '  dnf -y -q autoremove' : '',
        'elif command -v yum >/dev/null 2>&1; then',
        `  yum -y -q update${all ? '' : ' --security'}`,
        'else echo "No apt, dnf or yum on this server"; false; fi',
      ].filter(Boolean).join('\n');
    }
    case 'reboot_if_needed': {
      const delay = s.delay === '' || s.delay == null ? 1 : num(s.delay, 1, 240, 'In (minutes)');
      const w = String(s.window || '').trim();
      let win = '';
      if (w) {
        const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(w);
        if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) throw bad('Only between: e.g. 03:00-05:00');
        const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
        win = `now=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))\nif ${a <= b ? `[ $now -lt ${a} ] || [ $now -ge ${b} ]` : `[ $now -lt ${a} ] && [ $now -ge ${b} ]`}; then echo "A reboot is needed, but it is outside ${w} - next time"; exit 0; fi\n`;
      }
      return `need=0\n[ -f /var/run/reboot-required ] && need=1\nif command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; then need=1; fi\nif [ $need = 0 ]; then echo "No reboot needed"; exit 0; fi\n${win}echo "Rebooting in ${delay} min"\nshutdown -r +${delay} 'DockGate script: reboot after updates'`;
    }
    case 'service': {
      const n = need(s.name, /^[a-zA-Z0-9@._-]{1,80}$/, 'Service name, e.g. nginx');
      if (!['check', 'restart', 'reload', 'start'].includes(s.action)) throw bad('Action');
      if (s.action === 'check') return `systemctl is-active --quiet ${shq(n)} && echo "${n} is running" || { echo "${n} is not running ($(systemctl is-active ${shq(n)} 2>/dev/null))"; false; }`;
      return `systemctl ${s.action} ${shq(n)}\nsystemctl is-active --quiet ${shq(n)} && echo "${n} is running"`;
    }
    case 'journal_vacuum': {
      const size = need(s.size, /^\d{1,5}[KMG]$/i, 'Keep at most: e.g. 500M or 1G');
      const days = s.days === '' || s.days == null ? 0 : num(s.days, 1, 3650, 'Delete rotated logs older than (days)');
      return `journalctl --vacuum-size=${size.toUpperCase()}${days ? `\nfind /var/log -type f \\( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \\) -mtime +${days} -print -delete` : ''}`;
    }
    case 'wait_healthy': {
      const c = need(s.container, CONTAINER_RE, 'Container name');
      const t = s.timeout === '' || s.timeout == null ? 120 : num(s.timeout, 5, 3600, 'At most (seconds)');
      return `end=$(( $(date +%s) + ${t} ))\nwhile :; do\n  st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${shq(c)} 2>/dev/null || echo missing)\n  case "$st" in healthy|running) echo "${c}: $st"; break;; esac\n  [ $(date +%s) -ge $end ] && { echo "${c}: still $st after ${t} s"; false; }\n  sleep 3\ndone`;
    }
    case 'git_pull': {
      const dir = need(s.dir, PATH_RE, 'Folder: an absolute path');
      const br = String(s.branch || '').trim(); if (br && !/^[\w./-]{1,100}$/.test(br)) throw bad('Branch');
      return `cd ${shq(dir)}\ngit pull --ff-only${br ? ` origin ${shq(br)}` : ''}\ngit log -1 --format='now at %h %s'`;
    }
    case 'db_maintenance': {
      const c = need(s.container, CONTAINER_RE, 'Container name');
      const db = String(s.database || '').trim(); if (db && !/^[\w.-]{1,64}$/.test(db)) throw bad('Database name');
      const user = String(s.user || '').trim(); if (user && !/^[\w.-]{1,64}$/.test(user)) throw bad('User');
      if (s.engine === 'postgres') return `docker exec ${shq(c)} vacuumdb -U ${shq(user || 'postgres')} --analyze ${db ? `-d ${shq(db)}` : '--all'}`;
      if (s.engine === 'mysql' || s.engine === 'mariadb') return `docker exec ${shq(c)} sh -c ${shq(`exec ${s.engine === 'mariadb' ? 'mariadb-check' : 'mysqlcheck'} -u${user || 'root'} -p"$MYSQL_ROOT_PASSWORD$MARIADB_ROOT_PASSWORD" --optimize ${db ? db : '--all-databases'}`)}`;
      throw bad('Database: postgres, mysql or mariadb');
    }
    case 'port_check': {
      const h = need(s.host, /^[\w.-]{1,253}$|^[0-9a-fA-F:]+$/, 'Host'), p = num(s.port, 1, 65535, 'Port');
      return `timeout 5 bash -c ${shq(`</dev/tcp/${h}/${p}`)} && echo "${h}:${p} answers" || { echo "${h}:${p} does not answer"; false; }`;
    }
    case 'mem_check': {
      const max = num(s.max, 1, 99, 'At most (%)');
      return `use=$(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "%d", (t-a)*100/t}' /proc/meminfo)\necho "memory: $use% used"\n[ "$use" -le ${max} ] || { echo "above ${max}%"; false; }`;
    }
    case 'load_check': {
      const max = String(s.max || '').trim(); if (!/^\d{1,2}(\.\d{1,2})?$/.test(max)) throw bad('At most: e.g. 1.5');
      return `cpus=$(nproc)\nload=$(cut -d' ' -f2 /proc/loadavg)\necho "load (5 min): $load on $cpus CPUs"\nawk -v l="$load" -v c="$cpus" -v m=${max} 'BEGIN { exit !(l / c <= m) }' || { echo "above ${max} per CPU"; false; }`;
    }
    case 'ssl_check': {
      const d = need(s.domain, /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/, 'Domain, e.g. example.com');
      const days = num(s.days, 1, 365, 'At least (days left)');
      return `end=$(echo | timeout 15 openssl s_client -servername ${shq(d)} -connect ${shq(d + ':443')} 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2)\n[ -n "$end" ] || { echo "${d}: no certificate"; false; }\nleft=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))\necho "${d}: $left days left"\n[ "$left" -ge ${days} ] || { echo "fewer than ${days} days"; false; }`;
    }
    case 'top_containers': {
      const n = s.count === '' || s.count == null ? 5 : num(s.count, 1, 50, 'How many');
      return `docker stats --no-stream --format '{{.MemPerc}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.Name}}' | sort -rn | head -${n} | awk -F'\t' 'BEGIN { print "MEM%\tCPU%\tUSAGE\tNAME" } { print }'`;
    }
    case 'telegram': {
      const tok = need(s.token, /^\d{5,12}:[\w-]{30,60}$/, 'Bot token: like 123456:ABC... (from @BotFather)');
      const chat = need(s.chat, /^-?\d{3,20}$|^@[\w]{4,64}$/, 'Chat ID: a number or @channel');
      const text = String(s.text || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
      if (!text) throw bad('Message is required');
      const safe = text.replace(/[\\"`]/g, '').replace(/\$(?!\(hostname\)|SCRIPT_STATUS\b|SCRIPT_NAME\b)/g, '\\$');
      return `msg="${safe}"\ncurl -fsS --max-time 15 ${shq(`https://api.telegram.org/bot${tok}/sendMessage`)} --data-urlencode ${shq(`chat_id=${chat}`)} --data-urlencode "text=$msg" >/dev/null`;
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
    `# ${name} - made with DockGate Script Builder (Server Console > Scripts). Edit it there: changes made here are replaced.`,
    'set -uo pipefail',
    `SCRIPT_NAME=${shq(name)}`,
    'SCRIPT_STATUS=ok',
    'failed=0',
    'anyfail=0   # an earlier step failed in this run (steps "only if an earlier step failed" run then)',
    'step() { printf "\\n[%s] ▶ %s\\n" "$(date "+%F %T")" "$1"; }',
    '',
  ];
  steps.forEach((s, i) => {
    const label = (BLOCKS[s.type] ? (s.title || BLOCKS[s.type].label) : s.type).replace(/[\r\n"`$\\]/g, ' ');
    const onlyIfFailed = s.when === 'if_failed';
    const ind = onlyIfFailed ? '  ' : '';
    const body = stepShell(s).split('\n').map(l => ind + '  ' + l).join('\n');
    const onFail = s.onFail === 'continue' ? 'continue' : 'stop';
    out.push(`# ${i + 1}. ${label}${onlyIfFailed ? ' (only if an earlier step failed)' : ''}`);
    if (onlyIfFailed) out.push(`if [ "$anyfail" != 1 ]; then echo; echo "- ${i + 1}. ${label}: skipped (nothing failed)"; else`);
    // A standalone subshell: set -e works there (inside an "if" condition bash would ignore it).
    out.push(`${ind}step "${i + 1}. ${label}"`, `${ind}(`, `${ind}  set -e`, body, `${ind})`, `${ind}if [ $? -ne 0 ]; then`);
    out.push(onFail === 'stop' ? `${ind}  echo "✗ step ${i + 1} failed - stopping"; SCRIPT_STATUS=failed; exit 1` : `${ind}  echo "✗ step ${i + 1} failed - going on"; failed=$((failed+1)); anyfail=1; SCRIPT_STATUS=failed`);
    // a fix that worked: the earlier failure is handled
    if (onlyIfFailed) out.push(`${ind}else`, `${ind}  echo "✓ fixed"; failed=0; SCRIPT_STATUS=fixed`);
    out.push(`${ind}fi`);
    if (onlyIfFailed) out.push('fi');
    out.push('');
  });
  out.push('if [ "$failed" -gt 0 ]; then echo; echo "Done with $failed failed step(s)"; exit 1; fi', 'echo; echo "✓ Done"', '');
  return out.join('\n');
}

// Ready-made scripts. params: what the page asks first ([key, label, kind, default, [[step, field], ...]]);
// kind 'container' / 'volume' / 'compose' offer the server's own names. The steps can be changed afterwards.
const P = (key, label, kind, def, targets) => ({ key, label, kind, def, targets });
const TEMPLATES = [
  // ---- updates and upkeep
  { id: 'security-updates', category: 'Updates and upkeep', name: 'security-updates', title: 'Daily security updates, reboot at night when needed', schedule: '0 3 * * *',
    params: [P('window', 'Reboot only between', 'text', '04:00-05:00', [[1, 'window']])],
    steps: [{ type: 'os_update', mode: 'security', autoremove: 'yes' }, { type: 'reboot_if_needed', window: '04:00-05:00', delay: 1 }] },
  { id: 'full-update', category: 'Updates and upkeep', name: 'full-update', title: 'Weekly full update: system, Docker images, reboot when needed', schedule: '30 3 * * 0',
    params: [P('dir', 'Compose project folder', 'compose', '/srv/app', [[1, 'dir']]), P('container', 'Container to wait for', 'container', 'web', [[2, 'container']])],
    steps: [{ type: 'os_update', mode: 'all', autoremove: 'yes' }, { type: 'compose_redeploy', dir: '/srv/app', onFail: 'continue' }, { type: 'wait_healthy', container: 'web', timeout: 180, onFail: 'continue' }, { type: 'docker_prune', until: 168, onFail: 'continue' }, { type: 'reboot_if_needed', window: '', delay: 2 }] },
  { id: 'images-update', category: 'Updates and upkeep', name: 'images-update', title: 'Update a Compose project\'s images and check the site', schedule: '0 5 * * 1',
    params: [P('dir', 'Compose project folder', 'compose', '/srv/app', [[0, 'dir']]), P('container', 'Container to wait for', 'container', 'web', [[1, 'container']]), P('url', 'Site to check', 'text', 'https://example.com/health', [[2, 'url']])],
    steps: [{ type: 'compose_redeploy', dir: '/srv/app' }, { type: 'wait_healthy', container: 'web', timeout: 180 }, { type: 'http_check', url: 'https://example.com/health', expect: '200' }] },
  { id: 'monthly-cleanup', category: 'Updates and upkeep', name: 'monthly-cleanup', title: 'Monthly cleanup: Docker, journal, old logs, then check the disk', schedule: '0 4 1 * *',
    steps: [{ type: 'docker_prune', until: 720, onFail: 'continue' }, { type: 'journal_vacuum', size: '500M', days: 30, onFail: 'continue' }, { type: 'disk_check', path: '/', max: 85 }] },
  { id: 'docker-cleanup', category: 'Updates and upkeep', name: 'docker-cleanup', title: 'Weekly Docker cleanup (older than 7 days)', schedule: '0 4 * * 0',
    steps: [{ type: 'docker_prune', until: 168 }, { type: 'disk_check', path: '/', max: 90, onFail: 'continue' }] },
  // ---- backups
  { id: 'db-backup', category: 'Backups', name: 'db-backup', title: 'Daily PostgreSQL backup, keep 7 days, copy off the server', schedule: '30 3 * * *',
    params: [P('container', 'PostgreSQL container', 'container', 'postgres', [[0, 'container']]), P('database', 'Database', 'text', 'app', [[0, 'database']]), P('dest', 'Copy to (user@host:/path)', 'text', 'backup@10.0.0.9:/backups/web-1/db/', [[2, 'dest']])],
    steps: [{ type: 'db_backup', container: 'postgres', engine: 'postgres', database: 'app', user: 'postgres', dir: '/var/backups/db' }, { type: 'cleanup_old', dir: '/var/backups/db', pattern: '*.sql.gz', days: 7 }, { type: 'copy_remote', src: '/var/backups/db/', dest: 'backup@10.0.0.9:/backups/web-1/db/', onFail: 'continue' }, { type: 'disk_check', path: '/var/backups', max: 85, onFail: 'continue' }] },
  { id: 'mysql-backup', category: 'Backups', name: 'mysql-backup', title: 'Daily MySQL / MariaDB backup, keep 7 days', schedule: '45 3 * * *',
    params: [P('container', 'MySQL / MariaDB container', 'container', 'mysql', [[0, 'container']]), P('database', 'Database (empty = all)', 'text', '', [[0, 'database']])],
    steps: [{ type: 'db_backup', container: 'mysql', engine: 'mysql', database: '', user: 'root', dir: '/var/backups/db' }, { type: 'cleanup_old', dir: '/var/backups/db', pattern: '*.sql.gz', days: 7 }, { type: 'disk_check', path: '/var/backups', max: 85, onFail: 'continue' }] },
  { id: 'volume-backup', category: 'Backups', name: 'volume-backup', title: 'Volume backup, keep 14 days', schedule: '0 2 * * *',
    params: [P('volume', 'Volume', 'volume', 'app_data', [[0, 'volume']])],
    steps: [{ type: 'volume_backup', volume: 'app_data', dir: '/var/backups/volumes' }, { type: 'cleanup_old', dir: '/var/backups/volumes', pattern: '*.tar.gz', days: 14 }] },
  { id: 'config-backup', category: 'Backups', name: 'config-backup', title: 'Weekly backup of /etc and the projects folder, copied off the server', schedule: '15 2 * * 0',
    params: [P('src', 'Projects folder', 'text', '/srv', [[1, 'src']]), P('dest', 'Copy to (user@host:/path)', 'text', 'backup@10.0.0.9:/backups/web-1/config/', [[2, 'dest']])],
    steps: [{ type: 'folder_backup', src: '/etc', dir: '/var/backups/config' }, { type: 'folder_backup', src: '/srv', dir: '/var/backups/config' }, { type: 'copy_remote', src: '/var/backups/config/', dest: 'backup@10.0.0.9:/backups/web-1/config/', onFail: 'continue' }, { type: 'cleanup_old', dir: '/var/backups/config', pattern: '*.tar.gz', days: 28 }] },
  { id: 'db-maintenance', category: 'Backups', name: 'db-maintenance', title: 'Weekly database maintenance (VACUUM ANALYZE / OPTIMIZE)', schedule: '0 5 * * 0',
    params: [P('container', 'Database container', 'container', 'postgres', [[0, 'container']])],
    steps: [{ type: 'db_maintenance', container: 'postgres', engine: 'postgres', database: '', user: 'postgres' }] },
  // ---- health and self-repair
  { id: 'restart-if-down', category: 'Health and self-repair', name: 'restart-if-down', title: 'Restart a container when its site does not answer', schedule: '*/5 * * * *',
    params: [P('url', 'Site to check', 'text', 'https://example.com/health', [[0, 'url'], [3, 'url']]), P('container', 'Container to restart', 'container', 'web', [[1, 'container'], [2, 'container']])],
    steps: [{ type: 'http_check', url: 'https://example.com/health', expect: '200', onFail: 'continue' }, { type: 'container_action', container: 'web', action: 'restart', when: 'if_failed' }, { type: 'wait_healthy', container: 'web', timeout: 120, when: 'if_failed' }, { type: 'http_check', url: 'https://example.com/health', expect: '200' }] },
  { id: 'service-watchdog', category: 'Health and self-repair', name: 'service-watchdog', title: 'Start a system service again when it stopped', schedule: '*/5 * * * *',
    params: [P('name', 'Service', 'text', 'nginx', [[0, 'name'], [1, 'name']])],
    steps: [{ type: 'service', name: 'nginx', action: 'check', onFail: 'continue' }, { type: 'service', name: 'nginx', action: 'restart', when: 'if_failed' }] },
  { id: 'disk-full', category: 'Health and self-repair', name: 'disk-full', title: 'Free disk space when the disk gets full', schedule: '*/30 * * * *',
    steps: [{ type: 'disk_check', path: '/', max: 85, onFail: 'continue' }, { type: 'docker_prune', until: 72, when: 'if_failed' }, { type: 'journal_vacuum', size: '300M', days: 14, onFail: 'continue' }, { type: 'disk_check', path: '/', max: 92 }] },
  { id: 'memory-report', category: 'Health and self-repair', name: 'memory-report', title: 'Show the busiest containers when memory runs low', schedule: '*/15 * * * *',
    steps: [{ type: 'mem_check', max: 90, onFail: 'continue' }, { type: 'top_containers', count: 5, when: 'if_failed' }, { type: 'mem_check', max: 90 }] },
  { id: 'ssl-renew', category: 'Health and self-repair', name: 'ssl-renew', title: 'Renew a certificate that expires soon (certbot) and reload nginx', schedule: '30 6 * * *',
    params: [P('domain', 'Domain', 'text', 'example.com', [[0, 'domain']])],
    steps: [{ type: 'ssl_check', domain: 'example.com', days: 14, onFail: 'continue' }, { type: 'custom', command: 'certbot renew --quiet', when: 'if_failed' }, { type: 'service', name: 'nginx', action: 'reload', when: 'if_failed' }] },
  // ---- deploy
  { id: 'git-deploy', category: 'Deploy', name: 'git-deploy', title: 'Deploy from Git: pull, build, start, check', schedule: '*/10 * * * *',
    params: [P('dir', 'Project folder (a Git checkout)', 'compose', '/srv/app', [[0, 'dir'], [1, 'dir']]), P('container', 'Container to wait for', 'container', 'web', [[2, 'container']]), P('url', 'Site to check', 'text', 'https://example.com/health', [[3, 'url']])],
    steps: [{ type: 'git_pull', dir: '/srv/app', branch: '' }, { type: 'compose_redeploy', dir: '/srv/app' }, { type: 'wait_healthy', container: 'web', timeout: 180 }, { type: 'http_check', url: 'https://example.com/health', expect: '200' }] },
  { id: 'compose-update', category: 'Deploy', name: 'compose-update', title: 'Pull and redeploy a Compose project, then check it', schedule: '0 5 * * 1',
    params: [P('dir', 'Compose project folder', 'compose', '/srv/app', [[0, 'dir']]), P('url', 'Site to check', 'text', 'https://example.com/health', [[2, 'url']])],
    steps: [{ type: 'compose_redeploy', dir: '/srv/app' }, { type: 'sleep', seconds: 20 }, { type: 'http_check', url: 'https://example.com/health', expect: '200' }] },
  { id: 'nightly-restart', category: 'Deploy', name: 'nightly-restart', title: 'Restart a container every night (apps that leak memory)', schedule: '15 4 * * *',
    params: [P('container', 'Container', 'container', 'web', [[0, 'container'], [1, 'container']])],
    steps: [{ type: 'container_action', container: 'web', action: 'restart' }, { type: 'wait_healthy', container: 'web', timeout: 120 }] },
];

/** A template with the page's answers put into its steps. */
function fromTemplate(id, answers = {}) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) throw bad('Unknown template');
  const steps = JSON.parse(JSON.stringify(t.steps));
  for (const p of t.params || []) {
    const v = answers[p.key] != null ? answers[p.key] : p.def;
    for (const [i, f] of p.targets) if (steps[i]) steps[i][f] = v;
  }
  return { name: t.name, title: t.title, steps, schedule: t.schedule };
}

/** One block as shell to paste into your own script (Insert block in the code editor). */
function snippet(step) {
  const b = BLOCKS[step && step.type]; if (!b) throw bad(`Unknown block: ${step && step.type}`);
  const body = stepShell(step);
  const label = (step.title || b.label).replace(/[\r\n]/g, ' ');
  const pre = /SCRIPT_NAME|SCRIPT_STATUS/.test(body) ? ': "${SCRIPT_NAME:=$(basename "$0" .sh)}"; : "${SCRIPT_STATUS:=ok}"\n' : '';
  return `# --- ${label} (DockGate block) ---\n${pre}(\n  set -e\n${body.split('\n').map(l => '  ' + l).join('\n')}\n) || { echo "✗ ${label.replace(/["`$\\]/g, '')} failed"; exit 1; }\n`;
}

module.exports = { BLOCKS, TEMPLATES, build, stepShell, snippet, fromTemplate, NAME_RE };
