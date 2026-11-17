// Deploy → Tasks: read the task files of a project (pure, unit tested). Nothing here runs a tool: the files are
// parsed as text, because listing targets with the tool itself can run code (make evaluates $(shell …)).
//   makefile(text)    { targets: [{ name, desc, deps }], vars: [{ name, value, op }] }  — "## text" or "# text" above = description
//   justfile(text)    { recipes: [{ name, desc, params: [{ name, value }] }] }          — "_name" and [private] are hidden
//   taskfile(text)    { tasks: [{ name, desc }] }                                       — Taskfile.yml (go-task)
//   packageJson(text) { scripts: [{ name, cmd }] }
//   shellDesc(head)   the first comment lines after the shebang
//   discover(out)     the sections printed by DISCOVER_SH → { files, tasks: [...], git, tools }
//   command(task, { vars, args, dry, pm })   the shell line that runs (or dry-runs) a task

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

const SPECIAL = /^\.(PHONY|SUFFIXES|DEFAULT|PRECIOUS|INTERMEDIATE|SECONDARY|SECONDEXPANSION|DELETE_ON_ERROR|IGNORE|LOW_RESOLUTION_TIME|SILENT|EXPORT_ALL_VARIABLES|NOTPARALLEL|ONESHELL|POSIX|DEFAULT_GOAL)$/;
function makefile(text) {
  const lines = String(text || '').replace(/\\\n/g, ' ').split('\n');
  const targets = new Map(); const vars = []; let comment = []; let inDefine = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^define\b/.test(line)) { inDefine = true; continue; }
    if (inDefine) { if (/^endef\b/.test(line)) inDefine = false; continue; }
    if (/^\t/.test(line)) continue; // a recipe line
    const c = /^#+\s?(.*)$/.exec(line);
    if (c) { comment.push(c[1].trim()); continue; }
    const v = /^(?:export\s+|override\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\?=|:=|::=|\+=|=|!=)\s*(.*)$/.exec(line);
    if (v) {
      if (!vars.some(x => x.name === v[1])) vars.push({ name: v[1], op: v[2], value: v[3].replace(/\s+#.*$/, '').trim() });
      comment = []; continue;
    }
    const t = /^([^\s:=#%][^:=#]*?)\s*::?(?![=])\s*([^#;]*?)\s*(?:;[^#]*)?(?:##\s*(.*))?$/.exec(line);
    if (t) {
      const desc = (t[3] || '').trim() || (comment.length ? comment[comment.length - 1] : '');
      for (const name of t[1].trim().split(/\s+/)) {
        if (!name || SPECIAL.test(name) || name.includes('%') || name.includes('$')) continue;
        const prev = targets.get(name);
        targets.set(name, { name, desc: (prev && prev.desc) || desc, deps: t[2] ? t[2].split(/\s+/).filter(Boolean) : [] });
      }
      comment = []; continue;
    }
    if (!line.trim()) comment = [];
  }
  // targets that are only files (foo.o) are hardly tasks: keep names without a dot, or with a description
  const list = [...targets.values()].filter(x => !/\.[a-z0-9]{1,4}$/i.test(x.name) || x.desc);
  return { targets: list, vars };
}

function justfile(text) {
  const lines = String(text || '').split('\n');
  const recipes = []; let comment = []; let attrs = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^\s+\S/.test(line)) continue; // a recipe body line
    const c = /^#\s?(.*)$/.exec(line); if (c) { comment.push(c[1].trim()); continue; }
    const a = /^\[([^\]]+)\]\s*$/.exec(line); if (a) { attrs.push(a[1]); continue; }
    if (/^(set|alias|export|import|mod)\b/.test(line) || /^[A-Za-z_][\w-]*\s*:=/.test(line)) { comment = []; attrs = []; continue; }
    const r = /^@?([A-Za-z_][\w-]*)((?:\s+[+*$]?[A-Za-z_][\w-]*(?:=(?:'[^']*'|"[^"]*"|\S+))?)*)\s*:(?!=)/.exec(line);
    if (r) {
      const hidden = r[1].startsWith('_') || attrs.some(x => /\bprivate\b/.test(x));
      const params = (r[2].trim() ? r[2].trim().match(/[+*$]?[A-Za-z_][\w-]*(?:=(?:'[^']*'|"[^"]*"|\S+))?/g) : []).map(p => { const [n, ...rest] = p.replace(/^[+*$]/, '').split('='); return { name: n, value: rest.length ? rest.join('=').replace(/^['"]|['"]$/g, '') : null }; });
      const doc = attrs.map(x => /^doc\((['"])(.*)\1\)$/.exec(x)).find(Boolean);
      if (!hidden) recipes.push({ name: r[1], desc: doc ? doc[2] : (comment[comment.length - 1] || ''), params });
    }
    comment = []; attrs = [];
  }
  return { recipes };
}

// Taskfile.yml: the keys under "tasks:" and their desc / summary. A small line reader, enough for Taskfiles.
function taskfile(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\r$/, ''));
  const tasks = []; let inTasks = false; let level = null; let cur = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const ind = line.match(/^ */)[0].length;
    if (/^tasks\s*:\s*$/.test(line)) { inTasks = true; level = null; continue; }
    if (!inTasks) continue;
    if (ind === 0) { inTasks = false; continue; }
    const k = /^(\s*)(["']?)([\w:.-]+)\2\s*:\s*(.*)$/.exec(line);
    if (!k) continue;
    if (level === null) level = ind;
    if (ind === level) { cur = { name: k[3], desc: '', internal: false }; tasks.push(cur); if (k[4] && !k[4].startsWith('#') && !/^[|>]/.test(k[4])) cur.desc = ''; continue; }
    if (cur && ind > level) {
      if ((k[3] === 'desc' || (k[3] === 'summary' && !cur.desc)) && k[4] && !/^[|>]/.test(k[4])) cur.desc = k[4].replace(/^["']|["']$/g, '');
      if (k[3] === 'internal' && /true/.test(k[4])) cur.internal = true;
    }
  }
  return { tasks: tasks.filter(t => !t.internal).map(({ name, desc }) => ({ name, desc })) };
}

function packageJson(text) {
  try { const j = JSON.parse(text); return { scripts: Object.entries(j.scripts || {}).map(([name, cmd]) => ({ name, cmd: String(cmd) })) }; }
  catch (e) { return { scripts: [], error: 'package.json is not valid JSON' }; }
}

function shellDesc(head) {
  const out = [];
  for (const l of String(head || '').split('\n').slice(0, 15)) {
    if (/^#!/.test(l)) continue;
    const m = /^#\s?(.*)$/.exec(l);
    if (!m) break;
    if (/^-+$|^=+$|shellcheck|set -[eu]/i.test(m[1])) continue;
    if (m[1].trim()) out.push(m[1].trim());
    if (out.length >= 2) break;
  }
  return out.join(' ');
}

// What DISCOVER_SH prints, section by section.
const FILES = ['Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'package.json', 'config/deploy.yml', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json'];
const DISCOVER_SH = (dir) => `cd ${shq(dir)} 2>/dev/null || { echo '@@NODIR'; exit 0; }
echo '@@LS'; ls -1A 2>/dev/null | head -300
for f in ${FILES.filter(f => !/lock|bun/.test(f)).map(shq).join(' ')}; do [ -f "$f" ] && { echo "@@FILE $f"; head -c 300000 "$f"; echo; }; done
for f in pnpm-lock.yaml yarn.lock bun.lockb package-lock.json; do [ -f "$f" ] && echo "@@LOCK $f"; done
find . -maxdepth 3 \\( -name node_modules -o -name .git -o -name vendor -o -name .venv \\) -prune -o -type f -name '*.sh' -print 2>/dev/null | sed 's|^\\./||' | head -80 | while IFS= read -r s; do echo "@@SH $s"; head -n 15 "$s" 2>/dev/null; done
for f in *.yml *.yaml playbooks/*.yml playbooks/*.yaml ansible/*.yml; do [ -f "$f" ] && grep -qE '^\\s*-\\s*(hosts|import_playbook):' "$f" 2>/dev/null && echo "@@PLAYBOOK $f"; done
for f in inventory inventory.ini hosts hosts.ini ansible/inventory inventory/hosts; do [ -e "$f" ] && { echo "@@INVENTORY $f"; break; }; done
for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -f "$f" ] && echo "@@COMPOSE $f"; done
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo '@@GIT'; git rev-parse --abbrev-ref HEAD 2>/dev/null; git log -1 --format='%h %ci %s' 2>/dev/null; git remote get-url origin 2>/dev/null | sed -E 's#//[^/@]+@#//***@#'; git status --porcelain 2>/dev/null | head -c 2000 | wc -l; fi
echo '@@TOOLS'; for t in make just task npm pnpm yarn bun node kamal ansible-playbook docker git; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; true`;

function discover(out) {
  const res = { files: [], tasks: [], git: null, tools: [], compose: [], missing: false };
  const parts = String(out || '').split(/^@@/m);
  const files = {}; let lock = null; const sh = []; const playbooks = []; let inventory = null;
  for (const p of parts) {
    const nl = p.indexOf('\n'); const head = nl < 0 ? p : p.slice(0, nl); const body = nl < 0 ? '' : p.slice(nl + 1);
    if (head === 'NODIR') res.missing = true;
    else if (head === 'LS') res.files = body.split('\n').filter(Boolean);
    else if (head.startsWith('FILE ')) files[head.slice(5)] = body;
    else if (head.startsWith('LOCK ')) lock = lock || head.slice(5);
    else if (head.startsWith('SH ')) sh.push({ path: head.slice(3), desc: shellDesc(body) });
    else if (head.startsWith('PLAYBOOK ')) playbooks.push(head.slice(9));
    else if (head.startsWith('INVENTORY ')) inventory = head.slice(10);
    else if (head.startsWith('COMPOSE ')) res.compose.push(head.slice(8));
    else if (head === 'GIT') { const [branch, last, remote, dirty] = body.split('\n'); res.git = { branch: branch || null, last: last || null, remote: remote || null, changed: Number(dirty) || 0 }; }
    else if (head === 'TOOLS') res.tools = body.split('\n').filter(Boolean);
  }
  const mk = files.Makefile || files.makefile || files.GNUmakefile;
  if (mk != null) { const m = makefile(mk); res.makeVars = m.vars; m.targets.forEach(t => res.tasks.push({ source: 'make', name: t.name, desc: t.desc, deps: t.deps, vars: m.vars.filter(v => v.op === '?=' || v.op === '=' || v.op === ':=').map(v => ({ name: v.name, value: v.value })) })); }
  const jf = files.justfile || files.Justfile || files['.justfile'];
  if (jf != null) justfile(jf).recipes.forEach(r => res.tasks.push({ source: 'just', name: r.name, desc: r.desc, params: r.params }));
  const tf = files['Taskfile.yml'] || files['Taskfile.yaml'] || files['taskfile.yml'];
  if (tf != null) taskfile(tf).tasks.forEach(t => res.tasks.push({ source: 'task', name: t.name, desc: t.desc }));
  if (files['package.json'] != null) {
    const pm = lock === 'pnpm-lock.yaml' ? 'pnpm' : lock === 'yarn.lock' ? 'yarn' : lock === 'bun.lockb' ? 'bun' : 'npm';
    res.pm = pm;
    packageJson(files['package.json']).scripts.forEach(s => res.tasks.push({ source: 'npm', name: s.name, desc: s.cmd, pm }));
  }
  sh.forEach(s => res.tasks.push({ source: 'sh', name: s.path, desc: s.desc }));
  playbooks.forEach(pb => res.tasks.push({ source: 'ansible', name: pb, desc: `ansible-playbook ${pb}${inventory ? ` -i ${inventory}` : ''}`, inventory }));
  if (files['config/deploy.yml'] != null) {
    [['deploy', 'Build, push and roll out the app'], ['redeploy', 'Deploy again without setting up'], ['rollback', 'Go back to a version (asks for it)'], ['app details', 'Show the running containers'], ['app logs', 'Recent logs of the app']].forEach(([n, d]) => res.tasks.push({ source: 'kamal', name: n, desc: d }));
  }
  return res;
}

const NAME_RE = { make: /^[^\s'"`$;&|<>]+$/, just: /^[A-Za-z_][\w-]*$/, task: /^[\w:.-]+$/, npm: /^[^\s'"`;&|<>]+$/, sh: /^(?!\/)(?!.*\.\.)[\w./ -]+\.sh$/, ansible: /^(?!\/)(?!.*\.\.)[\w./-]+\.ya?ml$/, kamal: /^(deploy|redeploy|rollback|app details|app logs)$/ };
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The shell line for a task. vars: { NAME: value } (make / task variables, just params), args: extra words. */
function command(t, { vars = {}, args = '', dry = false, pm, inventory } = {}) {
  const re = NAME_RE[t.source]; if (!re) throw new Error(`Unknown kind of task: ${t.source}`);
  if (!re.test(t.name)) throw new Error('That task name can not be run safely');
  const kv = Object.entries(vars || {}).filter(([k, v]) => { if (!VAR_RE.test(k)) throw new Error(`Bad variable name: ${k}`); return v !== undefined && v !== null && v !== ''; });
  const extra = String(args || '').trim() ? String(args).trim().split(/\s+/).map(shq).join(' ') : '';
  switch (t.source) {
    case 'make': return `make ${dry ? '-n ' : ''}${shq(t.name)}${kv.map(([k, v]) => ` ${shq(`${k}=${v}`)}`).join('')}${extra ? ' ' + extra : ''}`;
    case 'just': return `just ${dry ? '--dry-run ' : ''}${shq(t.name)}${(t.params || []).map(p => (vars[p.name] !== undefined && vars[p.name] !== '' ? ' ' + shq(vars[p.name]) : '')).join('')}${extra ? ' ' + extra : ''}`;
    case 'task': return `task ${dry ? '--dry ' : ''}${shq(t.name)}${kv.map(([k, v]) => ` ${shq(`${k}=${v}`)}`).join('')}${extra ? ' -- ' + extra : ''}`;
    case 'npm': { const m = pm || t.pm || 'npm'; if (dry) return `node -e ${shq(`const s=require('./package.json').scripts||{};console.log(s[${JSON.stringify(t.name)}]||'')`)}`; return `${m} run ${shq(t.name)}${extra ? ' -- ' + extra : ''}`; }
    case 'sh': return dry ? `bash -n ${shq(t.name)} && echo "✓ bash -n: no syntax errors" && echo && head -n 200 ${shq(t.name)}` : `bash ${shq(t.name)}${extra ? ' ' + extra : ''}`;
    case 'ansible': return `ansible-playbook ${shq(t.name)}${(inventory || t.inventory) ? ` -i ${shq(inventory || t.inventory)}` : ''}${dry ? ' --check --diff' : ''}${extra ? ' ' + extra : ''}`;
    case 'kamal': if (dry) throw new Error('Kamal has no dry run'); return `kamal ${t.name}${extra ? ' ' + extra : ''}`;
    default: throw new Error('Unknown task');
  }
}

// Names that change things where it hurts: asked before they run.
const RISKY = /(^|[-_:./])(deploy|prod|production|release|publish|migrate|rollback|destroy|drop|clean|purge|reset|delete|remove|down|teardown|restore)($|[-_:./])/i;

module.exports = { makefile, justfile, taskfile, packageJson, shellDesc, discover, command, DISCOVER_SH, RISKY, shq };
