// Swarm → Nodes → a node: one page like a service's, with tabs.
//   Overview (role, state, address, OS, Docker, CPU/memory, labels, times), Tasks (every task Swarm placed
//   here, open its service), Resources (CPU, memory, disk, network of the node's DockGate server, live and
//   48 hours), Labels (edit; which services use them), Events (Docker node events), History (what DockGate
//   changed), Inspect. The buttons on top are the same actions as the ⋯ menu in Swarm → Nodes.
Router.register('swarm-node', async (content, params) => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const { id } = params;
  let currentTab = params.tab || 'overview';
  const pageNavId = Router._navId;
  let n = null, timer = null, stopRes = null;
  const TABS = [['overview', 'Overview'], ['tasks', 'Tasks'], ['resources', 'Resources'], ['labels', 'Labels'], ['events', 'Events'], ['history', 'History'], ['inspect', 'Inspect']];
  const AVAIL = { active: ['ok', 'active'], pause: ['warn', 'paused'], drain: ['warn', 'drained'] };
  const statePill = (st) => UI.pill(st === 'running' ? 'ok' : ['failed', 'rejected'].includes(st) ? 'bad' : ['shutdown', 'complete'].includes(st) ? 'off' : 'warn', esc(st));
  const kv = (rows) => `<div class="detail-grid">${rows.filter(Boolean).map(([k, v]) => `<div class="detail-item"><div class="detail-label">${esc(k)}</div><div class="detail-value" style="white-space:normal;overflow-wrap:anywhere">${v}</div></div>`).join('')}</div>`;
  const when = (iso) => iso ? `<span title="${esc(formatTime(iso))}">${esc(timeAgo(iso))}</span>` : '—';
  const serverOf = () => n.serverId || (n.self ? n.managerServer || 'local' : null); // the DockGate server behind the node
  const stop = () => { clearTimeout(timer); if (stopRes) { try { stopRes(); } catch (e) { /* gone */ } stopRes = null; } };
  // After an action: the node may be gone (removed) — then back to the list, else reload.
  const done = async () => {
    try { await API.get(`/swarm/nodes/${encodeURIComponent(id)}/detail`); render(); }
    catch (e) { Router.navigate('swarm', { tab: 'swarm-nodes' }, { replace: true }); }
  };

  async function render() {
    try { n = await API.get(`/swarm/nodes/${encodeURIComponent(id)}/detail`); }
    catch (e) {
      content.innerHTML = `<div class="empty-state"><h3>Node not found</h3><p>${esc(e.message)}</p><button class="btn btn-primary mt-2" id="nd-back">Back to Nodes</button></div>`;
      content.querySelector('#nd-back').onclick = () => Router.navigate('swarm', { tab: 'swarm-nodes' });
      return;
    }
    if (!Router.isActiveNav(pageNavId)) return;
    if (window.SwarmUI && SwarmUI.css) SwarmUI.css();
    document.getElementById('header-title').innerHTML = `<span class="crumb-parent">Swarm</span><span class="crumb-sep">/</span><span class="crumb-parent">Nodes</span><span class="crumb-sep">/</span><span class="crumb-page">${esc(n.hostname)}</span>`;
    const av = AVAIL[n.availability] || ['off', esc(n.availability)];
    const running = n.tasks.filter(t => t.state === 'running').length;
    const sid = serverOf();
    content.innerHTML = `
      <div id="nd-jobs"></div>
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-ghost" id="back-btn" style="transform:rotate(180deg)" title="Back">${Icons.chevronRight}</button>
          <div>
            <div class="page-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${esc(n.hostname)}
              ${UI.pill(n.state === 'ready' ? 'ok' : 'bad', esc(n.state))} ${UI.pill(av[0], av[1])} ${UI.chip(esc(n.role))} ${n.leader ? UI.pill('info', 'leader') : ''}</div>
            <div class="page-subtitle td-mono">${esc(n.id.slice(0, 12))} · ${esc(n.addr || '')} · Docker ${esc(n.engine || '?')} · ${esc(n.os || '')}/${esc(n.arch || '')}</div>
          </div>
        </div>
        <div class="page-actions">
          ${n.availability !== 'active' ? `<button class="btn btn-primary" data-act="activate">Activate</button>` : ''}
          ${n.availability !== 'pause' ? `<button class="btn btn-secondary" data-act="pause">Pause</button>` : ''}
          ${n.availability !== 'drain' ? `<button class="btn btn-secondary" data-act="drain">Drain…</button>` : ''}
          <button class="btn btn-secondary" data-act="${n.role === 'worker' ? 'promote' : 'demote'}">${n.role === 'worker' ? 'Promote to manager' : 'Demote to worker'}</button>
          ${sid && sid !== 'local' ? `<button class="btn btn-secondary" data-console>${Icons.terminal} Server console</button>` : ''}
          ${!n.serverId && !n.self ? `<button class="btn btn-secondary" data-act="adopt">Add to DockGate…</button>` : ''}
          <button class="btn btn-danger" data-act="remove">${Icons.trash} Remove…</button>
        </div>
      </div>
      ${n.state !== 'ready' ? `<div class="insight-card danger" style="margin-bottom:12px"><div><b>The node is ${esc(n.state)}.</b> ${esc(n.message || 'Swarm can not reach it: its tasks are started on other servers.')}</div></div>` : ''}
      ${n.role === 'manager' && n.reachability && n.reachability !== 'reachable' ? `<div class="insight-card danger" style="margin-bottom:12px"><div><b>Manager ${esc(n.reachability)}.</b> With too few reachable managers the cluster can not change.</div></div>` : ''}
      <div class="tabs" id="detail-tabs">${TABS.map(([k, l]) => `<button class="tab ${currentTab === k ? 'active' : ''}" data-tab="${k}">${l}${k === 'tasks' ? ` <span class="ui-sub">${running}</span>` : ''}</button>`).join('')}</div>
      <div id="tab-content"></div>`;
    content.querySelector('#back-btn').onclick = () => Router.back('swarm', { tab: 'swarm-nodes' });
    if (SwarmUI.jobBar) SwarmUI.jobBar(content.querySelector('#nd-jobs')); // drain, remove … run as Swarm jobs
    content.querySelector('[data-console]')?.addEventListener('click', () => Router.navigate('server-console', { id: sid }));
    const data = { nodes: { length: n.nodes }, managers: n.managers, labelUse: n.labelUse };
    content.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => SwarmUI.nodeAction(b.dataset.act, n, data, done)));
    content.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      currentTab = b.dataset.tab;
      Router.setTab(currentTab); // in the URL: Back / Forward and a refresh come back to this tab
      content.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === currentTab));
      renderTab();
    }));
    renderTab();
  }

  function renderTab() {
    stop();
    const el = content.querySelector('#tab-content');
    if (!el) return;
    const t = currentTab;
    if (t === 'overview') {
      const cap = `${n.cpus ? `${n.cpus} CPU` : '—'}${n.memBytes ? ` · ${formatBytes(n.memBytes)}` : ''}`;
      el.innerHTML = kv([
        ['Hostname', `<b>${esc(n.hostname)}</b>`],
        ['Role', `${esc(n.role)}${n.leader ? ' · leader' : ''}${n.role === 'manager' && n.reachability ? ` · ${esc(n.reachability)}` : ''}`],
        ['State', `${esc(n.state)}${n.message ? ` — ${esc(n.message)}` : ''}`],
        ['Availability', `${esc(n.availability)} <span class="ui-sub">${n.availability === 'active' ? 'gets new tasks' : n.availability === 'pause' ? 'keeps its tasks, gets no new ones' : 'its tasks run on other servers'}</span>`],
        ['Address', `<span class="td-mono">${esc(n.addr || '—')}</span>`],
        ['Running tasks', `${n.tasks.filter(x => x.state === 'running').length}`],
        ['Capacity', esc(cap)],
        ['OS / architecture', `${esc(n.os || '—')} / ${esc(n.arch || '—')}`],
        ['Docker', esc(n.engine || '—')],
        ['DockGate server', n.serverId ? esc(n.serverName) : n.self ? 'the server DockGate manages Swarm through' : '<span style="color:var(--warning,#d97706)">not in DockGate — add it to see CPU and memory and to open its console</span>'],
        ['Joined', when(n.createdAt)],
        ['Last change', when(n.updatedAt)],
        ['Node ID', `<span class="td-mono">${esc(n.id)}</span>`],
        ['Labels', Object.keys(n.labels).length ? Object.entries(n.labels).map(([k, v]) => UI.chip(`${esc(k)}=${esc(v)}`, { mono: true })).join(' ') : '<span class="ui-sub">none</span>'],
      ]) + (n.plugins.length ? `<div class="ui-sub" style="margin-top:12px">Plugins: ${n.plugins.map(esc).join(', ')}</div>` : '');
      return;
    }
    if (t === 'tasks') {
      const show = (all) => {
        const list = all ? n.tasks : n.tasks.filter(x => x.desired === 'running' || x.state === 'running');
        el.innerHTML = `<div class="ui-toolbar">${UI.chips([['now', 'Running now'], ['all', 'With history']], all ? 'all' : 'now', 'data-tf')}<span class="ui-spacer"></span><span class="ui-sub">Tasks Swarm placed on ${esc(n.hostname)}. Click a service to open it.</span></div>
          ${UI.table([{ label: 'Service' }, { label: 'Task' }, { label: 'State' }, { label: 'Image' }, { label: 'Container' }, { label: 'Since' }], list.map(x => ({ cells: [
            `<a href="#" data-svc="${esc(x.serviceId)}" class="td-name"><b>${esc(x.service)}</b></a>`,
            `<span class="td-mono text-sm">${x.slot ? `.${x.slot} ` : ''}${esc(x.id.slice(0, 12))}</span>`,
            `${statePill(x.state)}${x.desired !== x.state && x.desired !== 'running' ? ` <span class="ui-sub">→ ${esc(x.desired)}</span>` : ''}${x.error ? `<div class="ui-sub" style="color:var(--danger,#dc2626);white-space:normal;max-width:320px">${esc(x.error)}</div>` : ''}`,
            `<span class="td-mono text-sm">${esc(x.image)}</span>`,
            `<span class="td-mono text-sm">${esc(x.container || '—')}</span>`,
            when(x.at)] })), { minWidth: 820, empty: all ? 'No tasks on this node.' : 'Nothing runs on this node now.' })}`;
        el.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => show(b.dataset.tf === 'all'));
        el.querySelectorAll('[data-svc]').forEach(a => a.onclick = (e) => { e.preventDefault(); Router.navigate('swarm-service', { id: a.dataset.svc }); });
      };
      show(false);
      timer = setTimeout(async function again() { // keep the list fresh while it is open
        if (!Router.isActiveNav(pageNavId) || currentTab !== 'tasks' || !el.isConnected) return;
        try { n = await API.get(`/swarm/nodes/${encodeURIComponent(id)}/detail`); const all = el.querySelector('[data-tf][aria-pressed="true"]')?.dataset.tf === 'all'; show(all); } catch (e) { /* keep the last list */ }
        timer = setTimeout(again, 10000);
      }, 10000);
      return;
    }
    if (t === 'resources') {
      const sid = serverOf();
      if (!sid) { el.innerHTML = `<div class="insight-card info"><div>CPU, memory, disk and network come from the node's server in DockGate. <b>Add this server to DockGate</b> (Servers → Add server, address ${esc(n.addr || '')}) to see them here.</div></div>`; return; }
      if (typeof renderServerMonitoring !== 'function') { el.innerHTML = '<div class="ui-sub">Monitoring is not available.</div>'; return; }
      renderServerMonitoring(sid, el); // server-monitoring.js: Live and Last 48 hours, with the alert rules
      return;
    }
    if (t === 'labels') {
      const used = n.labelUse || {};
      const rows = Object.entries(n.labels).map(([k, v]) => ({ cells: [`<span class="td-mono">${esc(k)}</span>`, `<span class="td-mono">${esc(v)}</span>`, used[k] ? used[k].map(x => UI.chip(esc(x))).join(' ') : '<span class="ui-sub">no service uses it</span>'] }));
      el.innerHTML = `<div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Labels</div><div class="ui-ph-desc">Services choose servers with placement rules such as <span class="td-mono">node.labels.db==true</span>. A service whose rule matches no active server has nowhere to run.</div></div>${UI.btn('Edit labels…', 'data-edit-labels', 'btn-primary')}</div>
        ${UI.table([{ label: 'Key' }, { label: 'Value' }, { label: 'Used by' }], rows, { empty: 'No labels on this node.', minWidth: 0 })}`;
      el.querySelector('[data-edit-labels]').onclick = () => SwarmUI.nodeAction('labels', n, { nodes: { length: n.nodes }, managers: n.managers, labelUse: n.labelUse }, done);
      return;
    }
    if (t === 'events') {
      el.innerHTML = '<div class="text-sm text-muted">Reading the events of the last 24 hours…</div>';
      API.get(`/swarm/nodes/${encodeURIComponent(n.id)}/events`).then(({ events }) => {
        if (!el.isConnected) return;
        el.innerHTML = `<div class="ui-sub" style="margin-bottom:8px">Docker events about this node in the last 24 hours: joined, state, availability, role, labels.</div>
          ${UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Detail' }], events.map(e => ({ cells: [`<span class="ui-sub" title="${esc(formatTime(new Date(e.time * 1000).toISOString()))}">${esc(timeAgo(e.time))}</span>`, esc(e.action), `<span class="td-mono text-sm">${esc(e.detail || '—')}</span>`] })), { empty: 'No node events in the last 24 hours.', minWidth: 0 })}`;
      }).catch(e => { if (el.isConnected) el.innerHTML = UI.errorState(e, { compact: true }); });
      return;
    }
    if (t === 'history') {
      el.innerHTML = '<div class="text-sm text-muted">Loading…</div>';
      API.get(`/swarm/nodes/${encodeURIComponent(n.id)}/audit?name=${encodeURIComponent(n.hostname)}`).then(({ audit }) => {
        if (!el.isConnected) return;
        // details: { change: ['availability active → drain', 'labels', …], labels: { key: value } }
        const what = (a) => {
          const d = a.details || {};
          if (a.action === 'swarm_node_remove') return 'Removed from the swarm';
          if (a.action !== 'swarm_node_update') return esc(a.action);
          const parts = (Array.isArray(d.change) ? d.change : []).map(c => c === 'labels'
            ? `labels set to ${Object.keys(d.labels || {}).length ? Object.entries(d.labels).map(([k, v]) => `<span class="td-mono">${esc(k)}=${esc(v)}</span>`).join(', ') : 'none'}`
            : esc(c));
          return parts.join(' · ') || 'changed';
        };
        el.innerHTML = `<div class="ui-sub" style="margin-bottom:8px">What was changed on this node from DockGate (newest 50). Everything is also in Observe → Audit log.</div>
          ${UI.table([{ label: 'When' }, { label: 'Change' }], audit.map(a => ({ cells: [`<span class="ui-sub">${esc(timeAgo(new Date(String(a.at).replace(' ', 'T') + 'Z').toISOString()))}</span>`, what(a)] })), { empty: 'Nothing was changed on this node from DockGate yet.', minWidth: 0 })}`;
      }).catch(e => { if (el.isConnected) el.innerHTML = UI.errorState(e, { compact: true }); });
      return;
    }
    if (t === 'inspect') {
      el.innerHTML = '<div class="text-sm text-muted">Loading…</div>';
      API.get(`/swarm/inspect/node/${encodeURIComponent(n.id)}`).then(d => {
        if (el.isConnected) el.innerHTML = `<div class="json-viewer" style="max-height:65vh">${syntaxHighlightJSON(JSON.stringify(d, null, 2))}</div>`;
      }).catch(e => { if (el.isConnected) el.innerHTML = UI.errorState(e, { compact: true }); });
    }
  }

  await render();
  return stop;
});
