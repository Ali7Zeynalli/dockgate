// Deploy → Tasks: the Makefile targets, just recipes, Taskfile tasks, package.json scripts, *.sh, Ansible
// playbooks and Kamal of a folder on the SSH server picked in the top bar (server/tasks.js) — run them with a live
// log; deploy recipes of steps with checks and recovery, run by hand, on a schedule, by a GitHub / GitLab /
// Bitbucket push or from CI (server/task-recipes.js, task-hooks.js); the folder's env and secrets.
Router.register('tasks', async (content, params = {}) => {
  const navId = Router._navId;
  const alive = () => Router.isActiveNav(navId);
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const st = { dir: params.dir || null, view: params.view || 'tasks', projects: [], info: null, kinds: null, recipes: null, servers: [] };
  const save = () => Router.updateParams({ tab: 'tasks', ...(st.dir ? { dir: st.dir, view: st.view } : {}) });
  const SRC = { make: 'Makefile', just: 'justfile', task: 'Taskfile', npm: 'package.json', sh: 'Shell scripts', ansible: 'Ansible', kamal: 'Kamal' };
  const TOOL = { make: 'make', just: 'just', task: 'task', ansible: 'ansible-playbook', kamal: 'kamal' };
  const STATUS = { ok: ['ok', '✓ ok'], failed: ['bad', '✗ failed'], running: ['info', '▶ running'], cancelled: ['warn', '■ cancelled'], timeout: ['warn', '⏱ time limit'], interrupted: ['warn', 'interrupted'] };
  const pill = (s) => { const [l, t] = STATUS[s] || ['', s]; return UI.pill(l, t); };
  const ago = (t) => (t ? (typeof timeAgo === 'function' ? timeAgo(t) : new Date(t).toLocaleString()) : '—');
  const srv = Store.get('activeServer') || {};

  content.innerHTML = `<style>
    .tk-wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:14px;align-items:start}
    @media (max-width:900px){.tk-wrap{grid-template-columns:1fr}}
    .tk-proj{display:block;width:100%;text-align:left;background:none;border:0;color:var(--text-primary);padding:7px 8px;border-radius:8px;cursor:pointer;font:inherit}
    .tk-proj:hover{background:var(--bg-hover,rgba(255,255,255,.05))} .tk-proj[aria-current=true]{background:var(--accent-soft,rgba(59,130,246,.15))}
    .tk-proj small{display:block;color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tk-log{white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.45;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:60vh;overflow:auto;margin:0}
    .tk-step{border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px;display:grid;gap:6px}
    .tk-step .tk-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center} .tk-step .tk-row > *{flex:1;min-width:120px}
    .tk-code{white-space:pre-wrap;word-break:break-all;font-family:var(--font-mono,monospace);font-size:11.5px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:4px 0 8px}
  </style><div data-root><div class="card"><div class="skeleton" style="height:200px"></div></div></div>`;
  const root = content.querySelector('[data-root]');

  if (srv.type !== 'ssh') {
    root.innerHTML = `${UI.header('Tasks', 'Run the Makefile, just, Taskfile, npm scripts and shell scripts of your projects, and deploy them with recipes.')}
      <div class="card" style="padding:24px"><b>Tasks run on SSH servers.</b><div class="ui-sub" style="margin-top:6px">Pick a server reached over SSH in the top bar (Servers → Add server). The tasks run there, in the project folder, as the SSH user (or root with sudo).</div></div>`;
    return;
  }

  async function loadProjects() {
    try { const r = await API.get('/tasks/projects'); st.projects = r.projects; } catch (e) { if (alive()) root.innerHTML = UI.errorState(e, { title: 'Tasks could not be loaded' }); return; }
    if (!alive()) return;
    if (st.dir && !st.projects.some(p => p.dir === st.dir)) st.projects.unshift({ dir: st.dir, name: st.dir.split('/').pop(), notAdded: true });
    if (!st.dir && st.projects.length) st.dir = st.projects[0].dir;
    drawShell();
    if (st.dir) openProject();
  }

  function drawShell() {
    root.innerHTML = `${UI.header('Tasks', `Tasks and deploy recipes of project folders on <b>${esc(srv.name || srv.host)}</b> — found in the Makefile, justfile, Taskfile, package.json, *.sh, Ansible and Kamal files. Nothing runs until you press Run.`, UI.primary('+ Add folder', 'data-add'))}
      <div class="tk-wrap">
        <div class="card" style="padding:8px">
          ${st.projects.length ? st.projects.map(p => `<button type="button" class="tk-proj" data-proj="${esc(p.dir)}" aria-current="${p.dir === st.dir}"><b>${esc(p.name)}</b> ${p.compose ? UI.chip('compose') : ''} ${p.last ? pill(p.last.status) : ''}<small class="td-mono">${esc(p.dir)}</small></button>`).join('')
            : '<div class="ui-sub" style="padding:8px">No folders yet. Compose projects of this server show here by themselves; add any other folder with <b>+ Add folder</b>.</div>'}
        </div>
        <div style="min-width:0" data-main>${st.dir ? '<div class="card"><div class="skeleton" style="height:200px"></div></div>' : '<div class="card" style="padding:24px"><b>Add the folder of a project</b><div class="ui-sub" style="margin-top:6px">The folder with its Makefile, deploy.sh, justfile or package.json — for example <span class="td-mono">/srv/myapp</span>.</div></div>'}</div>
      </div>`;
    root.querySelector('[data-add]').onclick = addFolder;
    root.querySelectorAll('[data-proj]').forEach(b => b.onclick = () => { st.dir = b.dataset.proj; st.view = 'tasks'; st.info = null; st.recipes = null; save(); drawShell(); openProject(); });
  }
  const main = () => root.querySelector('[data-main]');

  function addFolder() {
    UI.dialog({ title: 'Add a project folder', saveLabel: 'Add',
      body: `<label class="ui-field"><span class="ui-label">Folder on ${esc(srv.name || srv.host)}</span><input class="input td-mono" id="af-d" placeholder="/srv/myapp"></label>
        <label class="ui-field"><span class="ui-label">Name (optional)</span><input class="input" id="af-n"></label>`,
      onSave: async (ov) => { const r = await API.post('/tasks/projects', { dir: ov.querySelector('#af-d').value, name: ov.querySelector('#af-n').value }); st.dir = r.dir; st.view = 'tasks'; save(); await loadProjects(); } });
  }

  async function openProject() {
    st.info = null;
    try { st.info = await API.get(`/tasks/discover?dir=${encodeURIComponent(st.dir)}`); }
    catch (e) {
      if (!alive()) return;
      main().innerHTML = `<div class="card" style="padding:20px"><b style="color:var(--danger)">${esc(e.message)}</b><div style="margin-top:10px">${UI.btn('Try again', 'data-retry')} ${UI.btn('Remove from the list', 'data-rm')}</div></div>`;
      main().querySelector('[data-retry]').onclick = openProject; main().querySelector('[data-rm]').onclick = removeFolder;
      return;
    }
    if (!alive()) return;
    drawProject();
  }
  function removeFolder() {
    showConfirm('Remove folder', `Remove <span class="td-mono">${esc(st.dir)}</span> from Tasks? The folder and its files stay on the server.`, async () => { await API.del(`/tasks/projects?dir=${encodeURIComponent(st.dir)}`); st.dir = null; save(); loadProjects(); });
  }

  function drawProject() {
    const i = st.info, p = st.projects.find(x => x.dir === st.dir) || {};
    const g = i.git;
    main().innerHTML = `<div class="card" style="padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">${esc(p.name || st.dir)}</b><span class="td-mono ui-sub">${esc(st.dir)}</span>
          ${g ? UI.chip(`git · ${esc(g.branch || 'detached')}${g.changed ? ` · ${g.changed} changed` : ''}`, { title: `${g.last || ''}\n${g.remote || ''}` }) : UI.chip('not a Git folder')}
          ${i.compose.length ? UI.chip(`compose: ${esc(i.compose.join(', '))}`) : ''}
          <span style="flex:1"></span>${p.notAdded ? UI.btn('Add to the list', 'data-keep') : ''} ${UI.menu([{ label: 'Refresh', attrs: 'data-refresh' }, { label: 'Run a command…', attrs: 'data-custom' }, ...(p.added ? [{ label: 'Remove from the list…', attrs: 'data-rm', danger: true }] : [])])}</div>
        ${g && g.last ? `<div class="ui-sub" style="margin-top:4px">Last commit: ${esc(g.last)}</div>` : ''}
        ${i.running.length ? `<div style="margin-top:6px">${i.running.map(r => `${UI.pill('info', '▶ running')} ${esc(r.name)} ${UI.btn('Open log', `data-log="${r.id}"`)}`).join(' ')}</div>` : ''}
      </div>
      <div class="tab-bar" style="margin-bottom:12px">${[['tasks', `Tasks (${i.tasks.length})`], ['recipes', 'Deploy recipes'], ['runs', 'Runs'], ['env', 'Env & secrets'], ['templates', 'Templates']].map(([v, l]) => `<button class="tab-btn ${st.view === v ? 'active' : ''}" data-view="${v}">${l}</button>`).join('')}</div>
      <div data-body></div>`;
    const m = main();
    m.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { st.view = b.dataset.view; save(); drawProject(); });
    m.querySelector('[data-refresh]').onclick = openProject;
    m.querySelector('[data-custom]').onclick = customCommand;
    const rm = m.querySelector('[data-rm]'); if (rm) rm.onclick = removeFolder;
    const keep = m.querySelector('[data-keep]'); if (keep) keep.onclick = async () => { await API.post('/tasks/projects', { dir: st.dir }); showToast('Added'); loadProjects(); };
    m.querySelectorAll('[data-log]').forEach(b => b.onclick = () => openLog(Number(b.dataset.log)));
    ({ tasks: drawTasks, recipes: drawRecipes, runs: drawRuns, env: drawEnv, templates: drawTemplates }[st.view] || drawTasks)();
  }
  const body = () => main().querySelector('[data-body]');

  // ---------- tasks ----------
  function drawTasks() {
    const i = st.info;
    if (!i.tasks.length) {
      body().innerHTML = `<div class="card" style="padding:20px"><b>No tasks found in this folder.</b><div class="ui-sub" style="margin-top:6px">DockGate reads <span class="td-mono">Makefile</span>, <span class="td-mono">justfile</span>, <span class="td-mono">Taskfile.yml</span>, <span class="td-mono">package.json</span> scripts, <span class="td-mono">*.sh</span> (also in scripts/, bin/, deploy/), Ansible playbooks and Kamal's <span class="td-mono">config/deploy.yml</span>. Start with one from <b>Templates</b>.</div></div>`;
      return;
    }
    const groups = [...new Set(i.tasks.map(t => t.source))];
    body().innerHTML = groups.map(src => {
      const missing = TOOL[src] && !i.tools.includes(TOOL[src]) || src === 'npm' && !i.tools.includes(i.pm || 'npm');
      const list = i.tasks.filter(t => t.source === src);
      return `<div class="card" style="padding:0;margin-bottom:12px"><div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center"><b>${SRC[src]}</b>${src === 'npm' ? UI.chip(esc(i.pm || 'npm')) : ''}<span class="ui-sub">${list.length}</span>
          ${missing ? `<span class="ui-sub" style="color:var(--warning)">⚠ ${esc(src === 'npm' ? i.pm || 'npm' : TOOL[src])} is not installed on the server (for the SSH user)</span>` : ''}</div>
        ${UI.table([{ label: 'Task' }, { label: 'What it does' }, { label: '', align: 'right' }], list.map(t => ({ cells: [
          `<span class="td-mono"><b>${esc(t.name)}</b></span>${t.risky ? ' ' + UI.pill('warn', 'asks first') : ''}`,
          `<span class="text-sm">${esc(t.desc || '')}</span>${t.params && t.params.length ? `<div class="ui-sub">parameters: ${t.params.map(p => esc(p.name + (p.def != null ? '=' + p.def : ''))).join(', ')}</div>` : ''}${t.deps && t.deps.length ? `<div class="ui-sub">runs first: ${esc(t.deps.join(', '))}</div>` : ''}`,
          `<div class="td-actions" style="justify-content:flex-end">${UI.btn('▶ Run', `data-run="${i.tasks.indexOf(t)}"`, 'btn-primary')} ${src === 'kamal' ? '' : UI.btn('Dry run', `data-dry="${i.tasks.indexOf(t)}"`, 'btn-secondary')} ${UI.btn('Options…', `data-opt="${i.tasks.indexOf(t)}"`)}</div>`] })), { minWidth: 560 })}</div>`;
    }).join('');
    body().querySelectorAll('[data-run]').forEach(b => b.onclick = () => { const t = i.tasks[b.dataset.run]; (t.params && t.params.some(p => p.def == null)) ? runOptions(t) : runTask(t, {}); });
    body().querySelectorAll('[data-dry]').forEach(b => b.onclick = () => runTask(i.tasks[b.dataset.dry], { dry: true }));
    body().querySelectorAll('[data-opt]').forEach(b => b.onclick = () => runOptions(i.tasks[b.dataset.opt]));
  }
  function runOptions(t) {
    const vars = t.source === 'just' ? (t.params || []).map(p => ({ name: p.name, value: p.def || '', param: true })) : t.source === 'make' || t.source === 'task' ? (t.vars || []) : [];
    UI.dialog({ title: `Run ${esc(t.source)} ${esc(t.name)}`, saveLabel: '▶ Run',
      body: `${vars.length ? `<div class="ui-label" style="margin-bottom:4px">${t.source === 'just' ? 'Parameters' : 'Variables'} <span class="ui-sub">— empty = the file's own value</span></div>${vars.map(v => `<label class="ui-field" style="margin-bottom:6px"><span class="ui-label td-mono">${esc(v.name)}</span><input class="input td-mono" data-var="${esc(v.name)}" placeholder="${esc(v.value || '')}"></label>`).join('')}` : ''}
        ${t.source === 'make' || t.source === 'task' ? '<label class="ui-field"><span class="ui-label">Other variables</span><input class="input td-mono" id="ro-x" placeholder="TAG=v1.2 ENV=staging"></label>' : ''}
        ${t.source !== 'kamal' || true ? '<label class="ui-field"><span class="ui-label">Extra arguments</span><input class="input td-mono" id="ro-a" placeholder="(optional)"></label>' : ''}
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="ro-r"> Run as root (sudo -n — the SSH user needs sudo without a password)</label>
        <label class="ui-field" style="margin-top:8px"><span class="ui-label">Time limit (minutes)</span><input class="input" id="ro-t" type="number" value="60" min="1" max="720"></label>
        ${t.source !== 'kamal' ? '<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="ro-d"> Dry run — show what it would do</label>' : ''}`,
      onSave: async (ov) => {
        const v = {}; ov.querySelectorAll('[data-var]').forEach(x => { if (x.value !== '') v[x.dataset.var] = x.value; });
        const x = ov.querySelector('#ro-x'); if (x && x.value.trim()) for (const w of x.value.trim().split(/\s+/)) { const k = w.indexOf('='); if (k < 1) throw new Error(`"${w}" is not NAME=value`); v[w.slice(0, k)] = w.slice(k + 1); }
        const d = ov.querySelector('#ro-d');
        await runTask(t, { vars: v, args: ov.querySelector('#ro-a').value, runAs: ov.querySelector('#ro-r').checked ? 'root' : 'user', timeoutMin: Number(ov.querySelector('#ro-t').value), dry: !!(d && d.checked) });
      } });
  }
  function kamalRollback(t) {
    UI.dialog({ title: 'Kamal rollback', saveLabel: 'Roll back', danger: true,
      body: `<div class="text-sm" style="margin-bottom:8px">Kamal goes back to a version that is still on the servers. DockGate asks Kamal for them (<span class="td-mono">kamal app containers</span>)…</div>
        <div data-kv><div class="skeleton" style="height:40px"></div></div>
        <label class="ui-field" style="margin-top:8px"><span class="ui-label">Version</span><input class="input td-mono" id="kr-v" placeholder="the version (a git commit)"></label>`,
      onOpen: async (ov) => {
        const box = ov.querySelector('[data-kv]');
        let r; try { r = await API.get(`/tasks/kamal-versions?dir=${encodeURIComponent(st.dir)}`); } catch (e) { box.innerHTML = `<div class="text-danger text-sm">${esc(e.message)}</div>`; return; }
        box.innerHTML = `${r.versions.length ? `<label class="ui-field" style="margin:0"><span class="ui-label">Versions found</span><select class="input td-mono" id="kr-s">${r.versions.map(v => `<option>${esc(v)}</option>`).join('')}</select></label>` : `<div class="ui-sub">${r.ok ? 'No versions found in the output — type one below.' : 'Kamal did not answer — type the version below.'}</div>`}
          <details style="margin-top:6px"><summary class="ui-sub" style="cursor:pointer">What Kamal said</summary><pre class="tk-code" style="max-height:200px;overflow:auto">${esc(r.output || '(nothing)')}</pre></details>`;
        const sel = ov.querySelector('#kr-s'), inp = ov.querySelector('#kr-v');
        if (sel) { inp.value = sel.value; sel.onchange = () => { inp.value = sel.value; }; }
      },
      onSave: async (ov) => {
        const v = ov.querySelector('#kr-v').value.trim();
        if (!/^[\w.-]{1,100}$/.test(v)) throw new Error('Pick or type a version (letters, digits, . _ -)');
        const r = await API.post('/tasks/run', { dir: st.dir, source: 'kamal', name: 'rollback', args: v }); openLog(r.id);
      } });
  }
  function runTask(t, opt) {
    if (t.source === 'kamal' && t.name === 'rollback' && !(opt.args || '').trim()) return kamalRollback(t);
    const go = async () => {
      try { const r = await API.post('/tasks/run', { dir: st.dir, source: t.source, name: t.name, params: t.params, pm: t.pm, inventory: t.inventory, ...opt }); openLog(r.id); }
      catch (e) { if (e.data && e.data.run) { showToast(e.message, 'warning'); openLog(e.data.run); } else showToast(e.message, 'error', 8000); }
    };
    if (t.risky && !opt.dry) return showConfirm(`Run ${t.name}?`, `<span class="td-mono">${esc(t.source)} ${esc(t.name)}</span> in <span class="td-mono">${esc(st.dir)}</span> on <b>${esc(srv.name || srv.host)}</b> — its name says it changes things (deploy, migrate, delete…). A dry run first shows what it would do.`, go, true);
    return go();
  }
  function customCommand() {
    UI.dialog({ title: 'Run a command in this folder', saveLabel: '▶ Run',
      body: `<label class="ui-field"><span class="ui-label">Command (bash, in ${esc(st.dir)})</span><textarea class="input td-mono" id="cc-c" rows="4" placeholder="git log --oneline -5"></textarea></label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cc-r"> Run as root (sudo -n)</label>`,
      onSave: async (ov) => { const r = await API.post('/tasks/run', { dir: st.dir, source: 'custom', cmd: ov.querySelector('#cc-c').value, runAs: ov.querySelector('#cc-r').checked ? 'root' : 'user' }); openLog(r.id); } });
  }

  // ---------- live log ----------
  function openLog(id) {
    const m = showModal(`Run #${id}`, `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap" data-head><span class="skeleton" style="width:200px;height:18px"></span></div><pre class="tk-log" data-log></pre>`, []);
    const md = m.overlay.querySelector('.modal'); if (md) md.classList.add('ui-modal-wide');
    const footer = m.overlay.querySelector('.modal-footer');
    const cancel = document.createElement('button'); cancel.className = 'btn btn-danger'; cancel.textContent = '■ Cancel run'; cancel.style.display = 'none';
    const close = document.createElement('button'); close.className = 'btn btn-secondary'; close.textContent = 'Close';
    footer.append(cancel, close); close.onclick = () => m.close();
    cancel.onclick = async () => { cancel.disabled = true; try { await API.post(`/tasks/runs/${id}/cancel`, {}); } catch (e) { showToast(e.message, 'error'); } };
    const pre = m.overlay.querySelector('[data-log]'), head = m.overlay.querySelector('[data-head]');
    let from = 0, stop = false;
    const done = () => !document.body.contains(m.overlay);
    (async function poll() {
      while (!stop && !done()) {
        let r; try { r = await API.get(`/tasks/runs/${id}?from=${from}`); } catch (e) { pre.textContent += `\n${e.message}\n`; break; }
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        if (r.text) { pre.textContent += r.text; from = r.size; if (atEnd) pre.scrollTop = pre.scrollHeight; }
        head.innerHTML = `${pill(r.status)} <b>${esc(r.name)}</b> <span class="ui-sub">${r.trigger ? esc(r.trigger) + ' · ' : ''}${r.finished ? ((r.finished - r.started) / 1000).toFixed(1) + ' s' : 'started ' + ago(r.started)}</span>`;
        cancel.style.display = r.status === 'running' ? '' : 'none';
        if (r.status !== 'running') { stop = true; if (alive() && st.info) { if (st.view === 'runs') drawRuns(); } break; }
        await new Promise(res => setTimeout(res, 1000));
      }
    })();
  }

  // ---------- runs ----------
  async function drawRuns() {
    body().innerHTML = '<div class="card"><div class="skeleton" style="height:120px"></div></div>';
    let r; try { r = await API.get(`/tasks/runs?dir=${encodeURIComponent(st.dir)}&limit=100`); } catch (e) { body().innerHTML = UI.errorState(e, { compact: true }); return; }
    if (!alive() || st.view !== 'runs') return;
    body().innerHTML = `<div class="card" style="padding:0">${UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Started by' }, { label: 'Result' }, { label: '', align: 'right' }], r.runs.map(x => ({ cells: [
      `<span title="${esc(new Date(x.started_at).toLocaleString())}">${ago(x.started_at)}</span>`,
      `<b>${esc(x.name)}</b>${x.kind === 'recipe' ? ' ' + UI.chip('recipe') : ''}`,
      `<span class="ui-sub">${esc(x.trigger || 'manual')}</span>`,
      `${pill(x.status)} ${x.finished_at ? `<span class="ui-sub">${((x.finished_at - x.started_at) / 1000).toFixed(1)} s</span>` : ''}`,
      UI.btn('Log', `data-log="${x.id}"`)] })), { empty: 'Nothing has run in this folder yet.', minWidth: 560 })}</div>`;
    body().querySelectorAll('[data-log]').forEach(b => b.onclick = () => openLog(Number(b.dataset.log)));
  }

  // ---------- env ----------
  async function drawEnv() {
    let r; try { r = await API.get(`/tasks/env?dir=${encodeURIComponent(st.dir)}`); } catch (e) { body().innerHTML = UI.errorState(e, { compact: true }); return; }
    if (!alive() || st.view !== 'env') return;
    const row = (e = {}) => `<div class="tk-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center" data-env><input class="input td-mono" data-k value="${esc(e.key || '')}" placeholder="NAME" style="max-width:220px" ${e.key ? 'readonly' : ''}>
      <input class="input td-mono" data-v type="${e.secret ? 'password' : 'text'}" value="${esc(e.value || '')}" placeholder="${e.secret ? '•••• (saved — type to change)' : 'value'}" autocomplete="new-password">
      <label style="display:flex;gap:4px;align-items:center;font-weight:400;white-space:nowrap"><input type="checkbox" data-s ${e.secret ? 'checked' : ''}> secret</label>${UI.btn('✕', 'data-del title="Remove"')}</div>`;
    body().innerHTML = `<div class="card" style="padding:14px"><div class="ui-sub" style="margin-bottom:10px">Given to every task and recipe of this folder as environment variables (stored encrypted in DockGate, written to a file only the SSH user can read for the run, then deleted). <b>Secret</b> values are never shown again and are hidden as •••• in the logs.</div>
      <div data-list>${r.env.map(row).join('')}</div>${UI.btn('+ Add', 'data-add')} <span style="float:right">${UI.primary('Save', 'data-save')}</span></div>`;
    const list = body().querySelector('[data-list]');
    const bindDel = () => list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const e = b.closest('[data-env]'); if (e.querySelector('[data-k]').readOnly) { e.dataset.removed = '1'; e.style.display = 'none'; } else e.remove(); });
    bindDel();
    body().querySelector('[data-add]').onclick = () => { list.insertAdjacentHTML('beforeend', row()); bindDel(); };
    body().querySelector('[data-save]').onclick = async () => {
      const items = [];
      list.querySelectorAll('[data-env]').forEach(e => {
        const key = e.querySelector('[data-k]').value.trim(); if (!key) return;
        const old = r.env.find(x => x.key === key); const v = e.querySelector('[data-v]').value, secret = e.querySelector('[data-s]').checked;
        if (e.dataset.removed) return items.push({ key, remove: true });
        if (old && old.secret && v === '' && secret) return; // keep the saved secret
        items.push({ key, value: v, secret });
      });
      try { await API.put('/tasks/env', { dir: st.dir, items }); showToast('Saved'); drawEnv(); } catch (e) { showToast(e.message, 'error'); }
    };
  }

  // ---------- templates ----------
  async function drawTemplates() {
    let r; try { r = await API.get('/tasks/templates'); } catch (e) { body().innerHTML = UI.errorState(e, { compact: true }); return; }
    if (!alive() || st.view !== 'templates') return;
    body().innerHTML = r.templates.map(t => `<div class="card" style="padding:12px 14px;margin-bottom:12px"><div style="display:flex;gap:8px;align-items:center"><b class="td-mono">${esc(t.file)}</b><span style="flex:1"></span>${UI.btn(`Add ${esc(t.file)} to the folder`, `data-tpl="${esc(t.name)}"`, 'btn-primary')}</div><pre class="tk-code" style="max-height:260px;overflow:auto">${esc(t.text)}</pre></div>`).join('')
      + '<div class="ui-sub">A file that is already in the folder is not overwritten unless you say so. Edit it afterwards in Files.</div>';
    body().querySelectorAll('[data-tpl]').forEach(b => b.onclick = async () => {
      const add = async (overwrite) => { const x = await API.post('/tasks/templates', { dir: st.dir, name: b.dataset.tpl, overwrite }); showToast(`Added ${x.path}`); openProject(); };
      try { await add(false); } catch (e) { if (/exists/i.test(e.message)) showConfirm('Overwrite?', `${esc(e.message)} — overwrite it?`, () => add(true).catch(x => showToast(x.message, 'error')), true); else showToast(e.message, 'error'); }
    });
  }

  // ---------- recipes ----------
  async function drawRecipes() {
    let r; try { r = await API.get(`/tasks/recipes?dir=${encodeURIComponent(st.dir)}`); } catch (e) { body().innerHTML = UI.errorState(e, { compact: true }); return; }
    if (!alive() || st.view !== 'recipes') return;
    st.recipes = r.recipes; st.kinds = r.kinds;
    const stepTxt = (s) => ({ git_pull: `git pull${s.branch ? ' ' + s.branch : ''}`, task: `${s.source} ${s.name}`, command: String(s.cmd || '').split('\n')[0].slice(0, 60), compose_up: 'compose up', check_url: `check ${s.url}`, container_healthy: `${s.container} healthy`, wait: `wait ${s.seconds || 10}s`, git_back: 'back to commit before' }[s.type] || s.type);
    body().innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><div class="ui-sub" style="flex:1">A recipe is the steps of a deploy: pull the code, run your tasks, start the containers, check that the app answers. When a step fails the <b>recovery</b> steps run (go back to the commit before, your rollback task). Run it by hand, on a schedule, on a Git push or from CI.</div>${UI.primary('+ New recipe', 'data-new')}</div>
      ${r.recipes.length ? r.recipes.map(x => `<div class="card" style="padding:12px 14px;margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(x.name)}</b>
          ${x.schedule ? UI.chip(`🕑 ${esc(SchedulePicker.describe(x.schedule))}`) : ''}${x.running ? ' ' + UI.pill('info', '▶ running') + ' ' + UI.btn('Log', `data-log="${x.running}"`) : ''}${x.waiting ? ' ' + UI.chip(`⏳ waiting: ${esc(x.waiting.what)}`, { title: `${x.waiting.trigger} — starts when the running deploy ends` }) : ''}${x.hook ? UI.chip(`⚡ webhook${x.hookBranch ? ' · ' + esc(x.hookBranch) : ''}`) : ''}${x.settings.servers && x.settings.servers.length > 1 ? UI.chip(`${x.settings.servers.length} servers`) : ''}
          <span style="flex:1"></span>${UI.btn('▶ Deploy', `data-rrun="${x.id}"`, 'btn-primary')} ${UI.btn('Edit', `data-redit="${x.id}"`)} ${UI.btn('Webhook / CI…', `data-rhook="${x.id}"`)} ${UI.menu([{ label: 'Delete…', attrs: `data-rdel="${x.id}"`, danger: true }])}</div>
        <div class="ui-sub" style="margin-top:6px">${x.steps.map((s, k) => `${k + 1}. ${esc(stepTxt(s))}`).join(' → ')}${x.onFail.length ? ` <span style="color:var(--warning)">· if it fails: ${x.onFail.map(s => esc(stepTxt(s))).join(' → ')}</span>` : ''}</div></div>`).join('')
        : `<div class="card" style="padding:20px"><b>No recipes yet.</b><div class="ui-sub" style="margin-top:6px">${st.info.git ? 'A typical one: Git pull → your <span class="td-mono">make deploy</span> (or docker compose up) → check the URL → if it fails, back to the commit before.' : 'This folder is not a Git clone: use tasks, docker compose up and checks.'}</div><div style="margin-top:10px">${UI.btn('Start from the usual recipe', 'data-quick', 'btn-primary')}</div></div>`}`;
    const b = body();
    b.querySelector('[data-new]').onclick = () => editRecipe(null);
    const qk = b.querySelector('[data-quick]'); if (qk) qk.onclick = () => editRecipe(null, quickRecipe());
    b.querySelectorAll('[data-redit]').forEach(x => x.onclick = () => editRecipe(st.recipes.find(y => y.id === Number(x.dataset.redit))));
    b.querySelectorAll('[data-rhook]').forEach(x => x.onclick = () => hookDialog(st.recipes.find(y => y.id === Number(x.dataset.rhook))));
    const deploy = async (rc, mode) => {
      try {
        const r2 = await API.post(`/tasks/recipes/${rc.id}/run`, mode ? { mode } : {});
        if (r2.queued) showToast(mode === 'replace' ? 'The running deploy is being stopped — yours starts right after' : 'Queued — it starts when the running deploy ends', 'info', 7000);
        openLog(r2.id); drawRecipes();
      } catch (e) {
        if (e.code !== 'BUSY') return showToast(e.message, 'error', 8000);
        const m = showModal('A deploy is running', `<p class="text-sm">${esc(rc.name)} is running now (run #${e.data.run}). What should happen with yours?</p>`, []);
        const ft = m.overlay.querySelector('.modal-footer'); ft.style.flexWrap = 'wrap'; ft.style.gap = '8px';
        const add = (label, cls, fn) => { const bt = document.createElement('button'); bt.className = `btn ${cls}`; bt.textContent = label; bt.onclick = () => { m.close(); fn(); }; ft.append(bt); };
        add('Open its log', 'btn-secondary', () => openLog(e.data.run));
        add('Deploy after it', 'btn-primary', () => deploy(rc, 'queue'));
        add('Stop it and deploy now', 'btn-danger', () => deploy(rc, 'replace'));
      }
    };
    b.querySelectorAll('[data-log]').forEach(x => x.onclick = () => openLog(Number(x.dataset.log)));
    b.querySelectorAll('[data-rrun]').forEach(x => x.onclick = () => { const rc = st.recipes.find(y => y.id === Number(x.dataset.rrun)); showConfirm(`Deploy — ${esc(rc.name)}`, `Run the recipe in <span class="td-mono">${esc(st.dir)}</span> on ${rc.settings.servers.length > 1 ? `<b>${rc.settings.servers.length} servers</b>, one after another` : `<b>${esc(srv.name || srv.host)}</b>`}?`, () => deploy(rc)); });
    b.querySelectorAll('[data-rdel]').forEach(x => x.onclick = () => { const rc = st.recipes.find(y => y.id === Number(x.dataset.rdel)); showDeleteConfirm('Delete recipe', { message: `Delete the recipe <b>${esc(rc.name)}</b>? Its webhook stops working. Past runs stay in Runs.`, phrase: rc.name, onConfirm: async () => { await API.del(`/tasks/recipes/${rc.id}`); showToast('Deleted'); drawRecipes(); } }); });
  }
  function quickRecipe() {
    const i = st.info; const steps = [];
    if (i.git && i.git.remote) steps.push({ type: 'git_pull' });
    const dep = i.tasks.find(t => t.source === 'make' && /^deploy$/.test(t.name)) || i.tasks.find(t => t.source === 'just' && t.name === 'deploy') || i.tasks.find(t => t.source === 'sh' && /deploy\.sh$/.test(t.name));
    if (dep) steps.push({ type: 'task', source: dep.source, name: dep.name }); else if (i.compose.length) steps.push({ type: 'compose_up', build: true });
    steps.push({ type: 'check_url', url: 'http://127.0.0.1:8080/', tries: 10, every: 3 });
    return { name: 'Deploy', steps, onFail: i.git && i.git.remote ? [{ type: 'git_back' }, ...(i.compose.length && !dep ? [{ type: 'compose_up', build: true }] : [])] : [], settings: { notify: { fail: true } } };
  }

  async function editRecipe(rec, preset) {
    if (!st.servers.length) { try { st.servers = (await API.get('/servers')).servers.filter(s => s.type === 'ssh'); } catch (e) { st.servers = []; } }
    const r = rec || preset || { name: 'Deploy', steps: [], onFail: [], settings: { notify: { fail: true } } };
    const set = r.settings || {};
    const servers = set.servers && set.servers.length ? set.servers : [srv.id];
    const tasks = st.info.tasks.filter(t => t.source !== 'kamal' || true);
    const kindOpts = (where, cur) => Object.entries(st.kinds).filter(([k]) => where === 'fail' || k !== 'git_back').map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    const field = (s, name, label, ph = '', type = 'text') => `<label class="ui-field" style="margin:0${name === 'url' ? ';flex-basis:100%' : ''}"><span class="ui-label">${label}</span><input class="input td-mono" data-f="${name}" type="${type}" value="${esc(s[name] ?? '')}" placeholder="${esc(ph)}"></label>`;
    const fieldsOf = (s) => {
      switch (s.type) {
        case 'git_pull': return field(s, 'branch', 'Branch', 'empty = the current one');
        case 'task': return `<label class="ui-field" style="margin:0"><span class="ui-label">Task</span><select class="input" data-f="task">${tasks.map(t => `<option value="${esc(t.source + '\u0001' + t.name)}" ${t.source === s.source && t.name === s.name ? 'selected' : ''}>${esc(t.source)} ${esc(t.name)}</option>`).join('')}${s.name && !tasks.some(t => t.source === s.source && t.name === s.name) ? `<option value="${esc(s.source + '\u0001' + s.name)}" selected>${esc(s.source)} ${esc(s.name)} (not found now)</option>` : ''}</select></label>
          <label class="ui-field" style="margin:0"><span class="ui-label">Variables</span><input class="input td-mono" data-f="vars" value="${esc(Object.entries(s.vars || {}).map(([k, v]) => `${k}=${v}`).join(' '))}" placeholder="TAG=latest"></label>${field(s, 'args', 'Arguments')}`;
        case 'command': return `<label class="ui-field" style="margin:0;flex-basis:100%"><span class="ui-label">Command (bash)</span><textarea class="input td-mono" data-f="cmd" rows="2">${esc(s.cmd || '')}</textarea></label>`;
        case 'compose_up': return `<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" data-f="build" ${s.build !== false ? 'checked' : ''}> --build</label><label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" data-f="pull" ${s.pull ? 'checked' : ''}> pull images first</label>`;
        case 'check_url': return `${field(s, 'url', 'URL (from the server)', 'http://127.0.0.1:8080/health')}${field(s, 'status', 'Good answer', '200-399')}${field(s, 'contains', 'Body contains', '(optional)')}${field(s, 'tries', 'Tries', '10', 'number')}${field(s, 'every', 'Every (s)', '3', 'number')}`;
        case 'container_healthy': return `${field(s, 'container', 'Container', 'myapp-web-1')}${field(s, 'timeout', 'Wait up to (s)', '120', 'number')}`;
        case 'wait': return field(s, 'seconds', 'Seconds', '10', 'number');
        case 'git_back': return '<div class="ui-sub">git reset --hard to the commit before this run\'s Git pull.</div>';
        default: return '';
      }
    };
    const stepHtml = (s, where) => `<div class="tk-step" data-step data-where="${where}"><div class="tk-row"><select class="input" data-kind style="max-width:280px">${kindOpts(where, s.type)}</select>
        <label style="display:flex;gap:4px;align-items:center;font-weight:400;flex:0 0 auto;min-width:0"><input type="checkbox" data-f="runAs" ${s.runAs === 'root' ? 'checked' : ''}> root</label>
        <span style="flex:0 0 auto;min-width:0">${UI.btn('↑', 'data-up title="Up"')} ${UI.btn('↓', 'data-down title="Down"')} ${UI.btn('✕', 'data-x title="Remove"')}</span></div>
      <div class="tk-row" data-fields>${fieldsOf(s)}</div></div>`;
    const readStep = (el) => {
      const s = { type: el.querySelector('[data-kind]').value };
      el.querySelectorAll('[data-f]').forEach(f => {
        const k = f.dataset.f;
        if (f.type === 'checkbox') { if (k === 'runAs') { if (f.checked) s.runAs = 'root'; } else s[k] = f.checked; }
        else if (k === 'task') { const [src, name] = f.value.split('\u0001'); const t = tasks.find(x => x.source === src && x.name === name) || {}; Object.assign(s, { source: src, name, params: t.params, pm: t.pm, inventory: t.inventory }); }
        else if (k === 'vars') { const v = {}; for (const w of f.value.trim().split(/\s+/).filter(Boolean)) { const i = w.indexOf('='); if (i < 1) throw new Error(`"${w}" is not NAME=value`); v[w.slice(0, i)] = w.slice(i + 1); } s.vars = v; }
        else if (f.value !== '') s[k] = f.type === 'number' ? Number(f.value) : f.value;
      });
      return s;
    };
    UI.dialog({ title: rec ? `Edit recipe — ${esc(rec.name)}` : 'New deploy recipe', saveLabel: 'Save', wide: true,
      body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input" id="rc-n" value="${esc(r.name)}"></label>
        <div class="ui-label" style="margin:8px 0 4px">Steps <span class="ui-sub">— in ${esc(st.dir)}, one after another; the first that fails stops the deploy</span></div>
        <div data-steps="ok">${r.steps.map(s => stepHtml(s, 'ok')).join('')}</div><div>${UI.btn('+ Add step', 'data-add="ok"')}</div>
        <div class="ui-label" style="margin:14px 0 4px">If it fails — recovery steps <span class="ui-sub">(optional; e.g. back to the commit before, then compose up or your rollback task)</span></div>
        <div data-steps="fail">${r.onFail.map(s => stepHtml(s, 'fail')).join('')}</div><div>${UI.btn('+ Add recovery step', 'data-add="fail"')}</div>
        <details style="margin-top:14px" ${servers.length > 1 || r.schedule ? 'open' : ''}><summary style="cursor:pointer;font-weight:600">Servers, schedule, alerts</summary>
          <div class="ui-field" style="margin-top:8px"><span class="ui-label">Servers <span class="ui-sub">— the same folder on each, one after another</span></span>${st.servers.map(s => `<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" data-srv="${esc(s.id)}" ${servers.includes(s.id) ? 'checked' : ''}> ${esc(s.name || s.host)} <span class="ui-sub">${esc(s.host || '')}</span></label>`).join('')}
            <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin-top:4px"><input type="checkbox" id="rc-cs" ${set.continueServers ? 'checked' : ''}> Go on with the next server when one fails (otherwise stop)</label></div>
          <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="rc-sch" ${r.schedule ? 'checked' : ''}> Run on a schedule</label>
          <div data-sp style="${r.schedule ? '' : 'display:none'}">${SchedulePicker.html(r.schedule || '30 3 * * *')}</div>
          <div class="ui-field" style="margin-top:8px"><span class="ui-label">Alerts (Settings → Notifications channels)</span>
            <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="rc-nf" ${set.notify && set.notify.fail === false ? '' : 'checked'}> When a deploy fails</label>
            <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="rc-no" ${set.notify && set.notify.ok ? 'checked' : ''}> When a deploy works</label></div>
          <label class="ui-field"><span class="ui-label">Time limit for each step (minutes)</span><input class="input" id="rc-t" type="number" min="1" max="720" value="${esc(set.timeoutMin || 60)}"></label>
        </details>
        <div class="ui-sub" style="margin-top:10px">While a recipe runs, Uptime alerts of this server stay quiet (as for Compose deploys). Env & secrets of the folder are given to every step.</div>`,
      onOpen: (ov) => {
        const sp = SchedulePicker.bind(ov.querySelector('[data-sp]'));
        ov._sp = sp;
        ov.querySelector('#rc-sch').onchange = (e) => { ov.querySelector('[data-sp]').style.display = e.target.checked ? '' : 'none'; };
        const bindStep = (el) => {
          el.querySelector('[data-kind]').onchange = () => { el.querySelector('[data-fields]').innerHTML = fieldsOf({ type: el.querySelector('[data-kind]').value }); };
          el.querySelector('[data-x]').onclick = () => el.remove();
          el.querySelector('[data-up]').onclick = () => { if (el.previousElementSibling) el.parentNode.insertBefore(el, el.previousElementSibling); };
          el.querySelector('[data-down]').onclick = () => { if (el.nextElementSibling) el.parentNode.insertBefore(el.nextElementSibling, el); };
        };
        ov.querySelectorAll('[data-step]').forEach(bindStep);
        ov.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
          const where = b.dataset.add; const box = ov.querySelector(`[data-steps="${where}"]`);
          box.insertAdjacentHTML('beforeend', stepHtml({ type: where === 'fail' ? (st.info.git ? 'git_back' : 'command') : (tasks.length ? 'task' : 'command') }, where));
          bindStep(box.lastElementChild);
        });
      },
      onSave: async (ov) => {
        const data = {
          dir: st.dir, name: ov.querySelector('#rc-n').value,
          steps: [...ov.querySelectorAll('[data-steps="ok"] [data-step]')].map(readStep),
          onFail: [...ov.querySelectorAll('[data-steps="fail"] [data-step]')].map(readStep),
          schedule: ov.querySelector('#rc-sch').checked ? ov._sp.value() : null,
          hookBranch: rec ? rec.hookBranch : null,
          settings: { servers: [...ov.querySelectorAll('[data-srv]:checked')].map(x => x.dataset.srv), continueServers: ov.querySelector('#rc-cs').checked, notify: { fail: ov.querySelector('#rc-nf').checked, ok: ov.querySelector('#rc-no').checked }, timeoutMin: Number(ov.querySelector('#rc-t').value) },
        };
        if (!data.settings.servers.length) data.settings.servers = [srv.id];
        if (rec) await API.put(`/tasks/recipes/${rec.id}`, data); else await API.post('/tasks/recipes', data);
        showToast('Saved'); drawRecipes();
      } });
  }

  // ---------- webhook / CI ----------
  async function hookDialog(rec) {
    let h = null;
    if (rec.hook) { try { h = await API.get(`/tasks/recipes/${rec.id}/hook`); } catch (e) { h = null; } }
    const url = h ? `${location.origin}/api/hooks/deploy/${h.hookId}` : '';
    const localUrl = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(location.hostname);
    const code = (t) => `<pre class="tk-code">${esc(t)}</pre>`;
    const tabs = h ? {
      GitHub: `<ol class="text-sm" style="padding-left:18px;margin:6px 0"><li>Repository → <b>Settings → Webhooks → Add webhook</b></li><li>Payload URL: the URL above · Content type: <b>application/json</b></li><li>Secret: the secret above · SSL verification on</li><li>Which events: <b>Just the push event</b> → Add webhook. GitHub sends a ping; it shows a green tick when DockGate answered.</li></ol>`,
      GitLab: `<ol class="text-sm" style="padding-left:18px;margin:6px 0"><li>Project → <b>Settings → Webhooks → Add new webhook</b></li><li>URL: the URL above</li><li>Secret token: the secret above</li><li>Trigger: <b>Push events</b> (a branch filter there is fine too) → Add webhook → Test → Push events</li></ol><div class="ui-sub">Self-hosted GitLab: allow requests to your DockGate address (Admin → Settings → Network → Outbound requests) if it is on a local network.</div>`,
      'Bitbucket Cloud': `<ol class="text-sm" style="padding-left:18px;margin:6px 0"><li>Repository → <b>Repository settings → Webhooks → Add webhook</b></li><li>Title: DockGate · URL: the URL above</li><li>Secret: the secret above (Bitbucket signs each request with it)</li><li>Triggers: <b>Repository push</b> → Save</li></ol>`,
      'Bitbucket Server / DC': `<ol class="text-sm" style="padding-left:18px;margin:6px 0"><li>Repository → <b>Repository settings → Webhooks → Create webhook</b></li><li>URL: the URL above · Secret: the secret above</li><li>Events: <b>Repository → Push</b> → Test connection → Create</li></ol>`,
      'GitHub Actions': code(`# .github/workflows/deploy.yml — after your tests; secret DOCKGATE_TOKEN = the secret above
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST "${url}" \\
            -H "Authorization: Bearer \${{ secrets.DOCKGATE_TOKEN }}" -H "Content-Type: application/json" \\
            -d '{"branch":"\${{ github.ref_name }}","commit":"\${{ github.sha }}","author":"\${{ github.actor }}"}'`),
      'GitLab CI': code(`# .gitlab-ci.yml — CI/CD variable DOCKGATE_TOKEN (masked) = the secret above
deploy:
  stage: deploy
  image: curlimages/curl
  rules: [{ if: '$CI_COMMIT_BRANCH == "main"' }]
  script:
    - 'curl -fsS -X POST "${url}" -H "Authorization: Bearer $DOCKGATE_TOKEN" -H "Content-Type: application/json" -d "{\\"branch\\":\\"$CI_COMMIT_BRANCH\\",\\"commit\\":\\"$CI_COMMIT_SHA\\"}"'`),
      'Bitbucket Pipelines': code(`# bitbucket-pipelines.yml — repository variable DOCKGATE_TOKEN (secured) = the secret above
pipelines:
  branches:
    main:
      - step:
          name: Deploy
          script:
            - 'curl -fsS -X POST "${url}" -H "Authorization: Bearer $DOCKGATE_TOKEN" -H "Content-Type: application/json" -d "{\\"branch\\":\\"$BITBUCKET_BRANCH\\",\\"commit\\":\\"$BITBUCKET_COMMIT\\"}"'`),
    } : {};
    const m = UI.dialog({ title: `Webhook / CI — ${esc(rec.name)}`, saveLabel: 'Save', wide: true,
      body: h ? `${localUrl ? `<div class="insight-card warning" style="margin-bottom:10px"><div>This address (<span class="td-mono">${esc(location.host)}</span>) is not reachable from the internet, so <b>GitHub, GitLab.com and Bitbucket Cloud can not call it</b>. Open DockGate at its public HTTPS address (a domain, or a tunnel) and copy the URL from there. A CI runner or a Git server on the same network can use it.</div></div>` : ''}
          <label class="ui-field"><span class="ui-label">URL</span><div style="display:flex;gap:6px"><input class="input td-mono" readonly value="${esc(url)}">${UI.btn('Copy', 'data-copy="url"')}</div></label>
          <label class="ui-field"><span class="ui-label">Secret <span class="ui-sub">— for the webhook's secret, or as <span class="td-mono">Authorization: Bearer …</span> from CI</span></span><div style="display:flex;gap:6px"><input class="input td-mono" type="password" readonly value="${esc(h.secret)}" data-secret>${UI.btn('Show', 'data-show')} ${UI.btn('Copy', 'data-copy="secret"')}</div></label>
          <label class="ui-field"><span class="ui-label">Only these branches <span class="ui-sub">— e.g. <span class="td-mono">main</span> or <span class="td-mono">main, release/*</span>; empty = any branch</span></span><input class="input td-mono" id="hk-b" value="${esc(rec.hookBranch || '')}"></label>
          <div class="tab-bar" style="margin:10px 0 6px;flex-wrap:wrap">${Object.keys(tabs).map((k, n) => `<button class="tab-btn ${n ? '' : 'active'}" data-ht="${esc(k)}">${esc(k)}</button>`).join('')}</div>
          <div data-hbody>${tabs.GitHub}</div>
          <details style="margin-top:10px"><summary style="cursor:pointer;font-weight:600">Show the result on the commit ${rec.hasStatusToken ? UI.pill('ok', 'token saved') : ''}</summary>
            <div class="ui-sub" style="margin:6px 0">With a token DockGate marks the pushed commit <b>pending → success / failed</b> (as "DockGate deploy"). GitHub: a fine-grained token with <b>Commit statuses: Read and write</b> on the repository. GitLab: a project access token with the <b>api</b> scope (Developer). Bitbucket Cloud: <span class="td-mono">username:app-password</span> with <b>Repositories: Read</b> (or a repository access token with <b>Repositories: Write</b>). Bitbucket Server / DC: an HTTP access token with repository read.</div>
            <div style="display:flex;gap:6px"><input class="input td-mono" id="hk-t" type="password" autocomplete="new-password" placeholder="${rec.hasStatusToken ? '(saved — type to change)' : 'token'}">${rec.hasStatusToken ? UI.btn('Forget', 'data-forget') : ''}</div></details>
          <div style="margin-top:12px;display:flex;gap:8px">${UI.btn('New secret', 'data-rotate')} ${UI.btn('Turn the webhook off', 'data-off', 'btn-danger')}</div>`
        : `<div class="text-sm">A URL and a secret for this recipe: give them to <b>GitHub, GitLab or Bitbucket</b> as a push webhook, or call the URL from your <b>CI</b> after the tests pass. Each request is checked (signature or token), the branch filtered, then the recipe runs.</div>
          <div class="ui-sub" style="margin-top:8px">DockGate must be reachable from the sender — for GitHub.com, GitLab.com and Bitbucket Cloud that means a public HTTPS address.</div>`,
      onOpen: (ov, { save }) => {
        if (!h) { save.textContent = 'Turn the webhook on'; return; }
        ov.querySelectorAll('[data-ht]').forEach(b => b.onclick = () => { ov.querySelectorAll('[data-ht]').forEach(x => x.classList.toggle('active', x === b)); ov.querySelector('[data-hbody]').innerHTML = tabs[b.dataset.ht]; });
        ov.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy === 'url' ? url : h.secret).then(() => showToast('Copied', 'success', 2000)));
        ov.querySelector('[data-show]').onclick = () => { const i = ov.querySelector('[data-secret]'); i.type = i.type === 'password' ? 'text' : 'password'; };
        ov.querySelector('[data-rotate]').onclick = () => showConfirm('New secret', 'Make a new URL and secret? The old ones stop working at once — update GitHub / GitLab / Bitbucket / CI.', async () => { await API.post(`/tasks/recipes/${rec.id}/hook`, {}); m.close(); await drawRecipes(); hookDialog(st.recipes.find(x => x.id === rec.id)); });
        ov.querySelector('[data-off]').onclick = () => showConfirm('Turn the webhook off', 'The URL stops working. You can turn it on again (with a new URL).', async () => { await API.del(`/tasks/recipes/${rec.id}/hook`); m.close(); drawRecipes(); }, true);
        const fg = ov.querySelector('[data-forget]'); if (fg) fg.onclick = async () => { await API.put(`/tasks/recipes/${rec.id}/status-token`, { token: '' }); showToast('Token forgotten'); m.close(); drawRecipes(); };
      },
      onSave: async (ov) => {
        if (!h) { await API.post(`/tasks/recipes/${rec.id}/hook`, {}); await drawRecipes(); hookDialog(st.recipes.find(x => x.id === rec.id)); return; }
        const branch = ov.querySelector('#hk-b').value.trim();
        if (branch !== (rec.hookBranch || '')) await API.put(`/tasks/recipes/${rec.id}`, { dir: rec.dir, name: rec.name, steps: rec.steps, onFail: rec.onFail, settings: rec.settings, schedule: rec.schedule, hookBranch: branch || null });
        const t = ov.querySelector('#hk-t').value.trim(); if (t) await API.put(`/tasks/recipes/${rec.id}/status-token`, { token: t });
        showToast('Saved'); drawRecipes();
      } });
  }

  await loadProjects();
});
