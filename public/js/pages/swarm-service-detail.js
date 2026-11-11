// Swarm → Services → a service: one page like a container's, with tabs.
//   Overview, Tasks, Logs (all tasks, or one), Terminal (a task on any node), Files (a task's container on any
//   node: browse, edit, upload, download), Stats (now and the last hours), Environment, Ports, Volumes,
//   Networks, Secrets & configs, Placement, Updates (newer image, update, roll back, what DockGate changed),
//   Events, Inspect. The buttons on top are the same as in the Services list.
Router.register('swarm-service', async (content, params) => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const { id } = params;
  let currentTab = params.tab || 'overview';
  const pageNavId = Router._navId;
  let cleanup = [];
  let s = null, form = null, tasks = [];
  const TABS = [['overview', 'Overview'], ['tasks', 'Tasks'], ['logs', 'Logs'], ['terminal', 'Terminal'], ['files', 'Files'], ['stats', 'Stats'], ['environment', 'Environment'], ['ports', 'Ports'], ['volumes', 'Volumes'], ['networks', 'Networks'], ['secrets', 'Secrets & configs'], ['placement', 'Placement'], ['updates', 'Updates'], ['events', 'Events'], ['inspect', 'Inspect']];
  const UPD = { updating: ['warn', 'updating'], completed: ['ok', 'updated'], paused: ['bad', 'update paused'], rollback_started: ['warn', 'rolling back'], rollback_paused: ['bad', 'roll back paused'], rollback_completed: ['warn', 'rolled back'] };
  const statePill = (st) => UI.pill(st === 'running' ? 'ok' : ['failed', 'rejected'].includes(st) ? 'bad' : ['shutdown', 'complete'].includes(st) ? 'off' : 'warn', esc(st));
  const runCleanup = () => { for (const f of cleanup) { try { f(); } catch (e) { /* gone */ } } cleanup = []; };
  const editBtn = (label = 'Edit…') => `<div style="margin-top:12px">${UI.btn(label, 'data-edit-svc')}</div>`;
  const kv = (rows) => `<div class="detail-grid">${rows.filter(Boolean).map(([k, v]) => `<div class="detail-item"><div class="detail-label">${esc(k)}</div><div class="detail-value" style="white-space:normal;overflow-wrap:anywhere">${v}</div></div>`).join('')}</div>`;
  const done = (kind) => { if (kind === 'removed') Router.navigate('swarm', { tab: 'swarm-services' }, { replace: true }); else render(); };

  async function load() {
    const [sum, f, t] = await Promise.all([API.get(`/swarm/services/${encodeURIComponent(id)}/summary`), API.get(`/swarm/services/${encodeURIComponent(id)}`), API.get(`/swarm/services/${encodeURIComponent(id)}/tasks`)]);
    s = sum; form = f; tasks = t.tasks;
  }

  async function render() {
    try { await load(); }
    catch (e) {
      content.innerHTML = `<div class="empty-state"><h3>Service not found</h3><p>${esc(e.message)}</p><button class="btn btn-primary mt-2" id="svc-back">Back to Services</button></div>`;
      content.querySelector('#svc-back').onclick = () => Router.navigate('swarm', { tab: 'swarm-services' });
      return;
    }
    if (!Router.isActiveNav(pageNavId)) return;
    if (window.SwarmUI && SwarmUI.svcCss) SwarmUI.svcCss();
    document.getElementById('header-title').innerHTML = `<span class="crumb-parent">Swarm</span><span class="crumb-sep">/</span><span class="crumb-parent">Services</span><span class="crumb-sep">/</span><span class="crumb-page">${esc(s.name)}</span>`;
    const ok = s.running >= s.desired;
    const upd = s.update && UPD[s.update.state];
    content.innerHTML = `
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-ghost" id="back-btn" style="transform:rotate(180deg)">${Icons.chevronRight}</button>
          <div>
            <div class="page-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${esc(s.name)}
              ${UI.pill(ok ? 'ok' : 'warn', `${s.running}/${s.desired} running`)} ${upd ? UI.pill(upd[0], upd[1]) : ''} ${s.newer && s.newer.status === 'update' ? UI.pill('info', 'newer image') : ''}
              ${s.stack ? UI.chip(`stack ${esc(s.stack)}`) : ''}</div>
            <div class="page-subtitle td-mono">${esc(s.id.slice(0, 12))} · ${esc(s.image)} · ${esc(s.mode)}</div>
          </div>
        </div>
        <div class="page-actions">
          ${s.mode === 'replicated' ? `<button class="btn btn-secondary" data-act="scale">Scale…</button>` : ''}
          ${s.newer && s.newer.status === 'update' ? `<button class="btn btn-primary" data-act="newest">${Icons.download} Update to newest…</button>` : ''}
          <button class="btn btn-secondary" data-act="image">Update image…</button>
          ${s.hasPrevious ? `<button class="btn btn-secondary" data-act="rollback">Roll back</button>` : ''}
          <button class="btn btn-secondary" data-act="restart">${Icons.restart} Restart</button>
          <button class="btn btn-secondary" data-act="settings">${Icons.settings} Settings</button>
          <button class="btn btn-danger" data-act="remove">${Icons.trash} Remove</button>
        </div>
      </div>
      ${s.problem ? `<div class="insight-card danger" style="margin-bottom:12px"><div><b>Why it is not running:</b> ${esc(s.problem)}</div></div>` : ''}
      <div class="tabs" id="detail-tabs">${TABS.map(([k, l]) => `<button class="tab ${currentTab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div id="tab-content"></div>`;
    content.querySelector('#back-btn').onclick = () => Router.back('swarm', { tab: 'swarm-services' }); // where you came from
    content.querySelector('#tab-content').addEventListener('click', (e) => { if (e.target.closest('[data-edit-svc]')) SwarmUI.openServiceForm({ id: s.id, onDone: render }); });
    content.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => SwarmUI.serviceAction(b.dataset.act, s, done)));
    content.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      currentTab = b.dataset.tab;
      Router.setTab(currentTab); // in the URL: Back / Forward and a refresh come back to this tab
      content.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === currentTab));
      renderTab();
    }));
    renderTab();
  }

  function renderTab() {
    runCleanup();
    const el = content.querySelector('#tab-content');
    if (!el) return;
    el.innerHTML = '<div class="text-sm text-muted" style="padding:12px 0">Loading…</div>';
    const fn = { overview, tasks: tasksTab, logs, terminal, files, stats, environment, ports, volumes, networks, secrets, placement, updates, events, inspect }[currentTab];
    Promise.resolve(fn(el)).catch(e => { el.innerHTML = UI.errorState(e, { compact: true }); });
  }

  const running = () => tasks.filter(t => t.state === 'running' && t.containerId);
  const taskLabel = (t) => `${s.name}${t.slot ? '.' + t.slot : ''} @ ${t.node}`;

  // ---- tabs ----
  function overview(el) {
    const g = form.form.general, r = form.form.resources, u = form.form.update;
    const byNode = {};
    for (const t of tasks.filter(x => x.desired === 'running' || x.desired === 'ready')) (byNode[t.node] = byNode[t.node] || []).push(t);
    el.innerHTML = kv([
      ['Image', `<span class="td-mono">${esc(s.image)}</span>${s.newer ? (s.newer.status === 'update' ? ` ${UI.pill('info', 'newer image')}${s.newer.version ? ` <span class="ui-sub">${esc(s.newer.version)}</span>` : ''}` : s.newer.status === 'current' ? ` ${UI.pill('ok', 'newest')}` : '') : ''}`],
      ['Mode', `${esc(s.mode)}${s.mode === 'replicated' ? ` · ${s.desired} replica${s.desired === 1 ? '' : 's'}` : ''}`],
      ['Tasks', `<b>${s.running}/${s.desired}</b> running`],
      ['Where', Object.keys(byNode).length ? Object.entries(byNode).map(([n, l]) => `${esc(n)}: ${l.map(t => statePill(t.state)).join(' ')}`).join('<br>') : '<span class="ui-sub">no tasks</span>'],
      ['Ports', s.ports.length ? s.ports.map(p => `<span class="td-mono">${p.published || ''}${p.published ? '→' : ''}${p.target}/${p.protocol}</span> <span class="ui-sub">${p.mode}</span>`).join('<br>') : '<span class="ui-sub">none</span>'],
      ['Reached inside the cluster as', `<span class="td-mono">${esc(s.name)}</span> — ${s.endpointMode === 'vip' ? `virtual IP ${esc((s.vips || []).join(', ') || '—')}` : 'DNS round robin'}`],
      ['Command', esc([g.entrypoint, g.command].filter(Boolean).join(' ') || "the image's")],
      ['Resources', esc([r.cpus ? `${r.cpus} CPU` : '', r.memory ? `${r.memory} memory` : ''].filter(Boolean).join(' · ') || 'no limits')],
      ['Updates', esc(`${u.order}, ${u.parallelism || 'all'} at a time, on failure: ${u.failureAction}`)],
      ['Last update', s.update ? `${UI.pill(...(UPD[s.update.state] || ['off', esc(s.update.state)]))} ${s.update.message ? `<span class="ui-sub">${esc(s.update.message)}</span>` : ''}` : '<span class="ui-sub">—</span>'],
      ['Created', esc(formatTime(s.createdAt))], ['Changed', esc(formatTime(s.updatedAt))],
      s.stack ? ['Stack', `${esc(s.stack)} · <a href="#" data-go-stacks>Swarm → Stacks</a>`] : null,
    ]);
    el.querySelector('[data-go-stacks]')?.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('swarm', { tab: 'swarm-stacks' }); });
  }

  async function tasksTab(el) {
    const draw = async () => {
      try { tasks = (await API.get(`/swarm/services/${s.id}/tasks`)).tasks; } catch (e) { /* keep */ }
      if (!el.isConnected) return;
      el.innerHTML = `<div class="ui-sub" style="margin-bottom:8px">Where each task runs and why one stopped. Swarm keeps a few stopped tasks per slot (Cluster settings → Task history).</div>` + UI.table([{ label: 'Task' }, { label: 'Server' }, { label: 'State' }, { label: 'Why' }, { label: 'Image' }, { label: 'When' }, { label: '', align: 'right' }],
        tasks.map(t => ({ cells: [`${esc(s.name)}${t.slot ? '.' + t.slot : ''}<div class="ui-sub td-mono">${esc(t.id.slice(0, 12))}</div>`, esc(t.node), `${statePill(t.state)}<div class="ui-sub">wanted: ${esc(t.desired)}</div>`,
          `<span class="text-sm">${esc(t.error || t.message)}${t.exitCode ? ` · exit code ${t.exitCode}${t.exitCode === 137 ? ' (killed: memory limit or stop timeout)' : ''}` : ''}</span>`, `<span class="td-mono text-sm">${esc(t.image)}</span>`, `<span class="ui-sub" title="${esc(formatTime(t.updatedAt))}">${esc(timeAgo(t.updatedAt))}</span>`,
          `<span style="white-space:nowrap">${t.state === 'running' && t.containerId ? `${UI.btn('Logs', `data-t-logs="${esc(t.id)}"`)} ${UI.btn('Terminal', `data-t-term="${esc(t.id)}"`)} ${UI.btn('Files', `data-t-files="${esc(t.id)}"`)} ` : ''}${UI.btn('Inspect', `data-t-insp="${esc(t.id)}"`)}</span>`] })), { minWidth: 980 });
      el.querySelectorAll('[data-t-logs]').forEach(b => b.onclick = () => { pick.task = b.dataset.tLogs; switchTo('logs'); });
      el.querySelectorAll('[data-t-term]').forEach(b => b.onclick = () => { pick.task = b.dataset.tTerm; switchTo('terminal'); });
      el.querySelectorAll('[data-t-files]').forEach(b => b.onclick = () => { pick.task = b.dataset.tFiles; switchTo('files'); });
      el.querySelectorAll('[data-t-insp]').forEach(b => b.onclick = () => SwarmUI.inspect('task', b.dataset.tInsp, `task ${b.dataset.tInsp.slice(0, 12)}`));
    };
    await draw();
    const timer = setInterval(() => { if (el.isConnected && currentTab === 'tasks') draw(); }, 6000);
    cleanup.push(() => clearInterval(timer));
  }
  const pick = { task: null };
  const switchTo = (tab) => { currentTab = tab; content.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab)); renderTab(); };
  // A select of the running tasks; calls onPick(task) now and on change.
  function taskSelect(el, onPick, { all = false } = {}) {
    const list = running();
    if (!list.length && !all) { el.innerHTML = '<div class="empty-state" style="padding:30px"><p class="text-muted">No running task.</p></div>'; return null; }
    const cur = list.find(t => t.id === pick.task) || (all ? null : list[0]);
    el.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap"><span class="ui-label" style="margin:0">Task</span><select class="select" data-task style="width:auto">${all ? '<option value="">All tasks</option>' : ''}${list.map(t => `<option value="${esc(t.id)}" ${cur && cur.id === t.id ? 'selected' : ''}>${esc(taskLabel(t))}</option>`).join('')}</select><span class="ui-sub" data-where></span></div><div data-body></div>`;
    const sel = el.querySelector('[data-task]');
    const go = () => { pick.task = sel.value || null; onPick(list.find(t => t.id === sel.value) || null, el.querySelector('[data-body]'), el.querySelector('[data-where]')); };
    sel.onchange = go; go();
    return sel;
  }

  function logs(el) {
    taskSelect(el, (t, body) => {
      const want = t ? `${s.name}${t.slot ? '.' + t.slot : ''} @ ${t.node}` : null;
      LogViewer.mount(body, { key: 'swarm-service', fileName: `${s.name}${t ? '-' + (t.slot || t.id.slice(0, 8)) : ''}-logs`, height: '62vh', live: true, poll: 5000, liveDefault: true,
        desc: t ? `Only ${want}.` : 'docker service logs — every task in one place; the source is task @ server.', empty: 'No log lines yet.',
        load: async (limit) => { const r = await API.get(`/swarm/services/${s.id}/logs?tail=${limit}`); return { rows: want ? r.rows.filter(x => x.src === want) : r.rows }; } });
    }, { all: true });
  }

  function terminal(el) {
    taskSelect(el, (t, body, where) => {
      runCleanup();
      if (!t) return;
      if (!t.serverId) { body.innerHTML = `<div class="insight-card warning"><div>${esc(t.node)} is not in DockGate. Add it (Swarm → Nodes → ⋯ → Add to DockGate…) to open a terminal there.</div></div>`; return; }
      where.textContent = `on ${t.node}`;
      cleanup.push(SwarmUI.mountTerminal(body, { containerId: t.containerId, serverId: t.serverId, node: t.node }));
    });
  }

  function files(el) {
    taskSelect(el, (t, body, where) => {
      if (!t) return;
      where.textContent = `container of ${taskLabel(t)}`;
      const base = `/swarm/tasks/${encodeURIComponent(t.id)}`;
      let cur = '/';
      const browse = async (path) => {
        let d;
        try { d = await API.get(`${base}/files?path=${encodeURIComponent(path)}`); } catch (e) { body.innerHTML = UI.errorState(e, { compact: true }); return; }
        cur = d.path || '/';
        const parts = cur.split('/').filter(Boolean);
        const crumb = ['<a href="#" data-nav="/">/</a>'].concat(parts.map((p, i) => `<a href="#" data-nav="/${parts.slice(0, i + 1).join('/')}">${esc(p)}</a>`)).join(' <span class="text-muted">/</span> ');
        const join = (n) => (cur === '/' ? '' : cur) + '/' + n;
        const rows = d.entries.map(e => e.type === 'dir'
          ? `<tr><td><a href="#" class="td-name" data-dir="${esc(join(e.name))}">📁 ${esc(e.name)}</a></td><td></td><td style="text-align:right">${FileEditUI.rowActions(join(e.name), true)}</td></tr>`
          : `<tr><td class="td-name">📄 ${esc(e.name)}</td><td class="text-xs text-muted" style="white-space:nowrap">${formatBytes(e.size)}</td><td style="text-align:right;white-space:nowrap"><button class="btn btn-xs btn-secondary" data-dl="${esc(join(e.name))}" title="Download">${Icons.download}</button> ${FileEditUI.rowActions(join(e.name), false)}</td></tr>`).join('');
        body.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px"><div class="text-sm" style="word-break:break-all">${crumb}</div><span>${FileEditUI.folderActions()} <button class="btn btn-xs btn-secondary" data-up title="Upload a .tar — extracted into this folder">${Icons.arrowUp} Upload .tar here</button></span></div>
          <div class="table-wrapper" style="max-height:58vh;overflow:auto"><table><tbody>${rows || '<tr><td class="text-muted text-sm" style="padding:10px">Empty</td></tr>'}</tbody></table></div>
          <div class="ui-sub" style="margin-top:6px">Changes here are in this task's container only: a new task (update, restart, another node) starts from the image again. Keep data in a volume.</div>`;
        body.querySelectorAll('[data-dir]').forEach(a => a.onclick = (e) => { e.preventDefault(); browse(a.dataset.dir); });
        body.querySelectorAll('[data-nav]').forEach(a => a.onclick = (e) => { e.preventDefault(); browse(a.dataset.nav); });
        body.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => { const a = document.createElement('a'); a.href = `/api${base}/file?path=${encodeURIComponent(b.dataset.dl)}`; document.body.appendChild(a); a.click(); a.remove(); });
        body.querySelector('[data-up]').onclick = () => {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.tar';
          inp.onchange = async () => {
            const f = inp.files && inp.files[0]; if (!f) return;
            try { const r = await fetch(`/api${base}/upload?path=${encodeURIComponent(cur)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-tar' }, body: f }); const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error(x.error || 'Upload failed'); showToast('Extracted into the container'); browse(cur); }
            catch (e) { showToast(e.message, 'error', 8000); }
          };
          inp.click();
        };
        FileEditUI.bind(body, base, cur, () => browse(cur));
      };
      browse('/');
    });
  }

  async function stats(el) {
    el.innerHTML = `<div class="sw-cards" data-now style="margin-bottom:14px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><select class="select" data-h style="width:auto"><option value="1">Last hour</option><option value="6" selected>Last 6 hours</option><option value="24">Last 24 hours</option><option value="48">Last 48 hours</option></select><span class="ui-sub">All running tasks summed, every 2 minutes.</span></div>
      <div class="ui-label">CPU</div><div style="height:200px"><canvas data-cpu></canvas></div>
      <div class="ui-label" style="margin-top:12px">Memory</div><div style="height:200px"><canvas data-mem></canvas></div><div data-empty class="ui-sub" style="margin-top:8px"></div>`;
    const now = async () => {
      try {
        const st = await API.get('/swarm/services/stats');
        const x = st.services[s.id];
        const box = el.querySelector('[data-now]'); if (!box) return;
        const card = (k, v) => `<div class="sw-card"><div class="k">${k}</div><div class="v">${v}</div></div>`;
        box.innerHTML = x ? card('CPU now', `${x.cpu}%`) + card('Memory now', formatBytes(x.memBytes)) + card('Tasks measured', `${x.tasks}`) + card('On', esc(x.nodes.join(', '))) : card('Now', '<span class="ui-sub" style="font-size:13px">no numbers (no running task on a server in DockGate)</span>');
      } catch (e) { /* keep */ }
    };
    now();
    const t = setInterval(() => { if (el.isConnected && currentTab === 'stats') now(); }, 10000);
    cleanup.push(() => clearInterval(t));
    const cs = getComputedStyle(document.documentElement);
    const grid = cs.getPropertyValue('--border').trim() || 'rgba(128,128,128,.2)', tick = cs.getPropertyValue('--text-muted').trim() || '#888';
    let charts = [];
    cleanup.push(() => charts.forEach(c => c.destroy()));
    const draw = async () => {
      const r = await API.get(`/swarm/services/${s.id}/history?hours=${el.querySelector('[data-h]').value}`);
      charts.forEach(c => c.destroy()); charts = [];
      const labels = r.samples.map(x => new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      el.querySelector('[data-empty]').textContent = r.samples.length ? `${r.samples.length} samples` : 'No samples yet — DockGate records every 2 minutes while the server in use is a manager.';
      const opts = (fmt) => ({ responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) } } },
        scales: { x: { ticks: { color: tick, maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, font: { size: 10 }, callback: fmt } } }, elements: { point: { radius: 0 }, line: { tension: 0.25, borderWidth: 2 } } });
      charts.push(new Chart(el.querySelector('[data-cpu]'), { type: 'line', data: { labels, datasets: [{ data: r.samples.map(x => x.cpu), borderColor: '#00b37e', backgroundColor: 'rgba(0,179,126,0.12)', fill: true }] }, options: opts(v => `${Math.round(v * 10) / 10}%`) }));
      charts.push(new Chart(el.querySelector('[data-mem]'), { type: 'line', data: { labels, datasets: [{ data: r.samples.map(x => x.mem), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', fill: true }] }, options: opts(v => formatBytes(v)) }));
    };
    el.querySelector('[data-h]').onchange = draw;
    await draw();
  }

  function environment(el) {
    const env = form.form.env.env || [];
    el.innerHTML = UI.table([{ label: 'Name' }, { label: 'Value' }], env.map(line => { const i = line.indexOf('='); const k = i < 0 ? line : line.slice(0, i); const v = i < 0 ? '' : line.slice(i + 1); const secret = /(PASS|SECRET|TOKEN|KEY)/i.test(k); return { cells: [`<span class="td-mono">${esc(k)}</span>`, secret ? `<span class="td-mono" data-secret="${esc(v)}">••••••</span> <a href="#" data-show>show</a>` : `<span class="td-mono" style="overflow-wrap:anywhere">${esc(v)}</span>`] }; }), { minWidth: 0, empty: 'No environment variables set on the service (the image may set its own).' })
      + `${form.form.env.labels ? `<div class="ui-label" style="margin-top:12px">Service labels</div><pre class="td-mono text-sm">${esc(form.form.env.labels)}</pre>` : ''}${editBtn('Edit environment…')}`;
    el.querySelectorAll('[data-show]').forEach(a => a.onclick = (e) => { e.preventDefault(); const sp = a.previousElementSibling; sp.textContent = sp.dataset.secret; a.remove(); });
  }
  function ports(el) {
    const p = form.form.network.ports || [];
    el.innerHTML = UI.table([{ label: 'Published (server)' }, { label: 'Container' }, { label: 'Protocol' }, { label: 'Mode' }], p.map(x => ({ cells: [x.published ? `<b>${esc(x.published)}</b>` : '<span class="ui-sub">random</span>', esc(x.target), esc(x.protocol), x.mode === 'host' ? 'host — only servers with a task, real client IP' : 'ingress — every server answers'] })), { minWidth: 0, empty: 'No published ports: only services on the same overlay network reach it (by its name).' }) + editBtn('Edit ports…');
  }
  function volumes(el) {
    const m = form.form.mounts || [];
    el.innerHTML = UI.table([{ label: 'Type' }, { label: 'Source' }, { label: 'Path in the task' }, { label: '' }], m.map(x => ({ cells: [esc(x.type), `<span class="td-mono">${esc(x.source || '—')}</span>`, `<span class="td-mono">${esc(x.target)}</span>`, x.readonly ? UI.chip('read-only') : ''] })), { minWidth: 0, empty: 'No volumes or bind mounts.' })
      + `<div class="ui-sub" style="margin-top:8px">A volume lives on the server where the task runs. A service with data is usually kept on one server (Placement).</div>${editBtn('Edit mounts…')}`;
  }
  function networks(el) {
    const n = form.form.network.networks || [];
    el.innerHTML = UI.table([{ label: 'Network' }, { label: 'Aliases' }], n.map(x => ({ cells: [`<b>${esc(x.name)}</b>`, esc(x.aliases || '—')] })), { minWidth: 0, empty: 'Only on the ingress network (published ports).' })
      + `<div class="ui-sub" style="margin-top:8px">Other services on the same network reach it as <span class="td-mono">${esc(s.name)}</span>${s.vips && s.vips.length ? ` (virtual IP ${esc(s.vips.join(', '))})` : ''}.</div>${editBtn('Edit networks…')}`;
  }
  function secrets(el) {
    const e = form.form.env;
    const row = (x, dir) => ({ cells: [`<b>${esc(x.name)}</b>`, `<span class="td-mono">${esc(x.target ? (x.target.startsWith('/') ? x.target : `${dir}/${x.target}`) : `${dir}/${x.name}`)}</span>`] });
    el.innerHTML = `<div class="ui-label">Secrets</div>${UI.table([{ label: 'Secret' }, { label: 'File in the task' }], (e.secrets || []).map(x => row(x, '/run/secrets')), { minWidth: 0, empty: 'No secrets.' })}
      <div class="ui-label" style="margin-top:12px">Configs</div>${UI.table([{ label: 'Config' }, { label: 'File in the task' }], (e.configs || []).map(x => row(x, '')), { minWidth: 0, empty: 'No configs.' })}
      <div class="ui-sub" style="margin-top:8px">Change their values in Swarm → Secrets & configs (Rotate).</div>${editBtn('Edit…')}`;
  }
  function placement(el) {
    const pl = form.form.placement, r = form.form.resources, rs = form.form.restart;
    el.innerHTML = kv([
      ['Constraints', pl.constraints.length ? pl.constraints.map(c => `<span class="td-mono">${esc(c)}</span>`).join('<br>') : '<span class="ui-sub">any server</span>'],
      ['Spread over', pl.spread.length ? esc(pl.spread.join(', ')) : '<span class="ui-sub">—</span>'],
      ['At most per server', esc(pl.maxPerNode || 'no limit')],
      ['CPU limit / reservation', esc(`${r.cpus || '—'} / ${r.cpusReserve || '—'}`)],
      ['Memory limit / reservation', esc(`${r.memory || '—'} / ${r.memoryReserve || '—'}`)],
      ['Restart', esc(`${rs.condition}${rs.delay ? `, after ${rs.delay}` : ''}${rs.maxAttempts ? `, at most ${rs.maxAttempts} times` : ''}`)],
    ]) + editBtn('Edit placement and resources…');
  }
  async function updates(el) {
    const [ins, au] = await Promise.all([API.get(`/swarm/inspect/service/${s.id}`), API.get(`/swarm/services/${s.id}/audit`).catch(() => ({ audit: [] }))]);
    const curImg = String(ins.Spec.TaskTemplate.ContainerSpec.Image || '');
    const prevImg = ins.PreviousSpec ? String(ins.PreviousSpec.TaskTemplate.ContainerSpec.Image || '') : null;
    const n = s.newer;
    el.innerHTML = kv([
      ['Image now', `<span class="td-mono" style="overflow-wrap:anywhere">${esc(curImg)}</span>`],
      ['Registry', n ? (n.status === 'update' ? `${UI.pill('info', 'newer image')}${n.version ? ` ${esc(n.version)}` : ''}${n.created ? ` <span class="ui-sub">built ${esc(n.created)}</span>` : ''}` : n.status === 'current' ? UI.pill('ok', 'this is the newest build') : n.status === 'error' ? `<span class="ui-sub">${esc(n.error)}</span>` : `<span class="ui-sub">${esc(n.error || 'not checked')}</span>`) + ` <span class="ui-sub">checked ${esc(timeAgo(Math.floor(n.checkedAt / 1000)))}</span>` : '<span class="ui-sub">not checked yet</span>'],
      ['Previous version', prevImg ? `<span class="td-mono" style="overflow-wrap:anywhere">${esc(prevImg)}</span>` : '<span class="ui-sub">none</span>'],
      ['Last update', s.update ? `${UI.pill(...(UPD[s.update.state] || ['off', esc(s.update.state)]))} ${esc(s.update.message || '')}` : '<span class="ui-sub">—</span>'],
    ]) + `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${UI.btn('Check for updates', 'data-u-check')} ${n && n.status === 'update' ? UI.primary('Update to newest…', 'data-u-newest') : ''} ${UI.btn('Update image…', 'data-u-image')} ${prevImg ? UI.btn('Roll back', 'data-u-rollback') : ''}</div>
      <div class="ui-ph-title" style="margin:18px 0 6px">Changed from DockGate</div>
      ${UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Details' }], au.audit.map(a => ({ cells: [`<span class="ui-sub">${esc(formatTime(a.at))}</span>`, esc(String(a.action).replace(/^swarm_service_/, '').replace(/_/g, ' ')), `<span class="td-mono text-sm">${esc(Object.entries(a.details || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</span>`] })), { minWidth: 0, empty: 'Nothing recorded yet.' })}`;
    el.querySelector('[data-u-check]').onclick = async (e) => { e.currentTarget.disabled = true; try { await API.post('/swarm/services/check-images', {}); render(); } catch (er) { showToast(er.message, 'error', 8000); e.currentTarget.disabled = false; } };
    el.querySelector('[data-u-newest]')?.addEventListener('click', () => SwarmUI.serviceAction('newest', s, done));
    el.querySelector('[data-u-image]').onclick = () => SwarmUI.serviceAction('image', s, done);
    el.querySelector('[data-u-rollback]')?.addEventListener('click', () => SwarmUI.serviceAction('rollback', s, done));
  }
  async function events(el) {
    const r = await API.get(`/swarm/services/${s.id}/events?hours=24`);
    el.innerHTML = `<div class="ui-sub" style="margin-bottom:8px">Docker events of this service, last 24 hours.</div>` + UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Detail' }], r.events.map(e => ({ cells: [`<span class="ui-sub" title="${esc(formatTime(new Date(e.time * 1000).toISOString()))}">${esc(timeAgo(e.time))}</span>`, esc(e.action), `<span class="td-mono text-sm" style="overflow-wrap:anywhere">${esc(e.detail)}</span>`] })), { minWidth: 0, empty: 'No events in the last 24 hours.' });
  }
  async function inspect(el) {
    const d = await API.get(`/swarm/inspect/service/${s.id}`);
    const text = JSON.stringify(d, null, 2);
    el.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:6px">${UI.btn('Copy', 'data-copy')}</div><pre class="td-mono" style="max-height:65vh;overflow:auto;font-size:12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:10px;white-space:pre">${esc(text)}</pre>`;
    el.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(text).then(() => showToast('Copied'), () => showToast('Copy failed', 'error'));
  }

  await render();
  return () => runCleanup();
});
