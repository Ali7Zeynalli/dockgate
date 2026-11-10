// Edge Agent (observability) — Settings ▸ Notifications panel. Plain-script globals (loaded before settings.js).
// Renders a per-server table with Install / Start-Stop / Update / Channel / Remove, an "Install on all"
// fan-out, and a re-openable deploy-log modal. All actions hit /api/agent/* (DockGate-initiated outbound).
(function () {
  // Status pill + version (used by the install picker and the fleet table).
  function pill(st) {
    const [lv, txt] = { running: ['ok', 'Running'], stopped: ['warn', 'Stopped'], absent: ['off', 'Not installed'], unreachable: ['bad', 'Unreachable'] }[st.state] || ['off', 'Not installed'];
    return UI.pill(lv, txt) + (st.version ? ` <span class="ui-sub">v${escapeHtml(st.version)}</span>` : '');
  }

  // Fleet table (DigitalOcean metrics agent / Datadog Fleet style): one row per server.
  function agentCells(s, st) {
    const sid = escapeHtml(s.id);
    const state = st.state || 'absent';
    const installed = state === 'running' || state === 'stopped';
    const pillOf = { running: ['ok', 'Running'], stopped: ['warn', 'Stopped'], absent: ['off', 'Not installed'], unreachable: ['bad', 'Unreachable'] }[state] || ['off', 'Not installed'];
    const actions = !installed
      ? `${UI.btn('Install', `data-act="install" data-sid="${sid}"`, 'btn-primary')}${UI.btn('Channel', `data-act="channel" data-sid="${sid}" data-installed="0"`)}`
      : `${UI.btn(state === 'running' ? 'Stop' : 'Start', `data-act="${state === 'running' ? 'stop' : 'start'}" data-sid="${sid}"`)}${UI.btn('Channel', `data-act="channel" data-sid="${sid}" data-installed="1"`)}${UI.btn('Update', `data-act="update" data-sid="${sid}"`, st.updateAvailable ? 'btn-primary' : '')}${UI.btn('Remove', `data-act="remove" data-sid="${sid}"`, 'btn-danger')}`;
    const ver = installed ? `<span class="ui-sub">v${escapeHtml(st.version || '?')}${st.build ? ` · <span class="td-mono">${escapeHtml(st.build.slice(0, 7))}</span>` : ''}</span>${st.updateAvailable ? ` ${UI.pill('warn', 'Update available')}` : ` ${UI.pill('ok', 'Up to date')}`}` : '<span class="ui-sub">—</span>';
    return [`<b>${escapeHtml(s.name || s.id)}</b>${s.name ? `<div class="ui-sub td-mono">${sid}</div>` : ''}`, `<span class="td-mono text-xs">${escapeHtml(s.host || '')}</span>`, UI.pill(...pillOf), ver, actions];
  }

  // Live deploy-log modal. Polls the job; stops cleanly when the job ends or the modal is closed.
  // Always shows a Close button, and a prominent status that turns green/red when the job finishes.
  // Closing it only closes the window: the job keeps running on DockGate, and Servers → Edge agent → Agent jobs
  // (or the banner there while it runs) opens it again, with the whole log so far.
  const KIND = { install: 'Install', 'install-all': 'Install', update: 'Update', reconfigure: 'Apply settings', remove: 'Remove' };
  function openJobModal(jobId, onDone) {
    const body = `<div id="edge-job-log"></div>
      <div id="edge-job-status" style="margin-top:10px;font-size:13px;font-weight:600;color:var(--text-muted);">⏳ Working…</div>
      <div class="ui-sub" style="margin-top:4px">Closing this window does not stop the job. Reopen it from Servers → Edge agent → Agent jobs.</div>`;
    const m = showModal('Edge agent job', body, []);
    if (typeof window._edgeAgentJobsRefresh === 'function' && document.getElementById('edge-agent-jobs')) setTimeout(window._edgeAgentJobsRefresh, 300);
    const footer = m.overlay.querySelector('#modal-footer');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => m.close();
    if (footer) footer.appendChild(closeBtn);

    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    // The job log in the shared LogViewer: new complete lines are appended as the job writes them.
    const viewer = LogViewer.mount(m.overlay.querySelector('#edge-job-log'), { key: 'agent-job', fileName: `agent-job-${jobId}`, live: true, limits: null, compact: true, height: '340px',
      retention: 'DockGate keeps the newest 200 agent jobs', empty: 'Starting…' });
    let sent = 0;
    const feed = (log, all) => { const lines = String(log || '').split('\n'); const upto = all ? lines.length : lines.length - 1; if (upto > sent) { viewer.push(lines.slice(sent, upto).join('\n')); sent = upto; } };
    let timer = null, finished = false, sawRunning = false, titled = false;
    async function poll() {
      if (!m.overlay || !m.overlay.isConnected) { if (timer) clearTimeout(timer); return; }
      try {
        const j = await API.get('/agent/job/' + jobId);
        if (!titled) { titled = true; const h = m.overlay.querySelector('.modal-title, .modal-header h3, .modal-header h2'); if (h) h.textContent = `Edge agent · ${KIND[j.kind] || j.kind}${(j.servers || []).length ? ' · ' + j.servers.map(x => x.id).join(', ') : ''}`; }
        if (j.status === 'running') sawRunning = true;
        feed(j.log, j.status !== 'running');
        const se = m.overlay.querySelector('#edge-job-status');
        const per = (j.servers || []).map(s => `${s.id}: ${s.state}${s.message ? ' — ' + s.message : ''}`).join('   ·   ');
        if (j.status === 'running') {
          if (se) { se.style.color = 'var(--text-muted)'; se.textContent = `⏳ Working…${j.total > 1 ? ` (${j.ok}/${j.total})` : ''}` + (per ? '   |   ' + per : ''); }
        } else if (!finished) {
          finished = true;
          const okAll = j.status === 'done' && (j.failed || 0) === 0;
          if (se) {
            se.style.color = okAll ? '#16a34a' : (j.status === 'failed' ? '#dc2626' : '#d97706');
            se.textContent = (okAll ? '✓ Completed' : (j.status === 'failed' ? '✗ Failed' : '⚠ Completed with errors'))
              + (j.total > 1 ? ` — ${j.ok}/${j.total} ok, ${j.failed} failed` : '')
              + (per ? '   |   ' + per : '');
          }
          closeBtn.className = 'btn btn-primary';   // highlight Close once it's done
          if (sawRunning) { // a job reopened after it ended shows its result without a toast
            showToast(okAll ? 'Agent job finished' : (j.status === 'failed' ? 'Agent job failed' : 'Agent job finished with errors'), okAll ? 'success' : 'error');
            if (typeof onDone === 'function') onDone();
          }
          if (timer) clearTimeout(timer);
          return;
        }
      } catch (e) { /* transient — keep polling */ }
      if (!finished) timer = setTimeout(poll, 1200);
    }
    poll();
  }

  // Per-server channel override editor. installed=true → recreate the agent after saving (push the change).
  async function channelModal(sid, onDone, installed) {
    let cur = {};
    try { cur = await API.get('/agent/channel/' + sid); } catch (e) {}
    const v = (k) => escapeHtml(cur[k] || '');
    const body = `
      <div class="text-xs text-muted" style="margin-bottom:10px;">Leave blank to use the global channel. Any field you fill here overrides it for <strong>${escapeHtml(sid)}</strong> only — e.g. a different Telegram bot/chat for this server.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <input class="input" id="ec-tg-token" placeholder="Telegram Bot Token" type="password" value="${v('tg_token')}">
        <input class="input" id="ec-tg-chat" placeholder="Telegram Chat ID" value="${v('tg_chat_id')}">
        <input class="input" id="ec-smtp-host" placeholder="SMTP Host" value="${v('smtp_host')}">
        <input class="input" id="ec-smtp-port" placeholder="SMTP Port" value="${v('smtp_port')}">
        <input class="input" id="ec-smtp-user" placeholder="SMTP User" value="${v('smtp_user')}">
        <input class="input" id="ec-smtp-pass" placeholder="SMTP Password" type="password" value="${v('smtp_pass')}">
        <input class="input" id="ec-smtp-from" placeholder="From Email" value="${v('smtp_from')}">
        <input class="input" id="ec-smtp-to" placeholder="To Email" value="${v('smtp_to')}">
      </div>`;
    const m = showModal('Channel override — ' + sid, body, []);
    const val = (id) => { const el = m.overlay.querySelector('#' + id); return el ? el.value : ''; };
    const footer = m.overlay.querySelector('#modal-footer');

    const apply = async (fn, okMsg) => {
      try {
        await fn();
        m.close();
        showToast(okMsg);
        if (installed) {
          try { const { jobId } = await API.post('/agent/reconfigure', { serverId: sid }); openJobModal(jobId, onDone); return; }
          catch (e) { /* fall through to reload */ }
        }
        if (typeof onDone === 'function') onDone();
      } catch (e) { showToast(e.message, 'error'); }
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = installed ? 'Save & apply' : 'Save';
    saveBtn.addEventListener('click', () => apply(() => API.post('/agent/channel/' + sid, {
      tg_token: val('ec-tg-token'), tg_chat_id: val('ec-tg-chat'),
      smtp_host: val('ec-smtp-host'), smtp_port: val('ec-smtp-port'),
      smtp_user: val('ec-smtp-user'), smtp_pass: val('ec-smtp-pass'),
      smtp_from: val('ec-smtp-from'), smtp_to: val('ec-smtp-to'),
    }), 'Channel override saved'));

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-ghost';
    clearBtn.textContent = 'Use global';
    clearBtn.addEventListener('click', () => apply(() => API.delete('/agent/channel/' + sid), 'Reverted to the global channel'));

    if (footer) { footer.appendChild(clearBtn); footer.appendChild(saveBtn); }
  }

  // Server picker — choose which servers to install the agent on (the "Install on servers…" button).
  async function openInstallPicker(onDone) {
    let servers = [], status = {};
    try {
      const [sr, st] = await Promise.all([API.get('/servers'), API.get('/agent/status')]);
      servers = (sr.servers || sr || []).filter(s => s.id !== 'local' && s.type !== 'local');
      status = st || {};
    } catch (e) { showToast(e.message, 'error'); return; }
    if (!servers.length) { showToast('No remote servers — add one under Infrastructure first', 'warning'); return; }

    const rows = servers.map(s => {
      const st = status[s.id] || {};
      const installed = st.state === 'running' || st.state === 'stopped';
      return `<label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">
        <input type="checkbox" class="edge-pick" value="${escapeHtml(s.id)}" ${installed ? '' : 'checked'}>
        <span style="flex:1;min-width:0;">
          <span class="settings-row-label" style="margin:0;">${escapeHtml(s.id)}</span>
          <span class="text-xs text-muted"> · ${escapeHtml(s.host || '')} · ${pill(st)}</span>
        </span>
      </label>`;
    }).join('');

    const body = `
      <div class="text-xs text-muted" style="margin-bottom:10px;">Pick the servers to install the DockGate agent on. Already-installed servers start unchecked — re-checking one reinstalls (recreates) it.</div>
      <label style="display:flex;align-items:center;gap:10px;padding:4px 0 10px;font-weight:600;cursor:pointer;border-bottom:1px solid var(--border);">
        <input type="checkbox" id="edge-pick-all"> <span>Select all</span>
      </label>
      <div style="max-height:320px;overflow:auto;">${rows}</div>`;
    const m = showModal('Install DockGate agent — choose servers', body, []);
    const allCb = m.overlay.querySelector('#edge-pick-all');
    allCb?.addEventListener('change', () => {
      m.overlay.querySelectorAll('.edge-pick').forEach(cb => { cb.checked = allCb.checked; });
    });
    const go = document.createElement('button');
    go.className = 'btn btn-primary';
    go.textContent = 'Install selected';
    go.addEventListener('click', async () => {
      const ids = [...m.overlay.querySelectorAll('.edge-pick:checked')].map(cb => cb.value);
      if (!ids.length) { showToast('Select at least one server', 'warning'); return; }
      try {
        const { jobId } = await API.post('/agent/install-all', { serverIds: ids });
        m.close();
        openJobModal(jobId, onDone);
      } catch (e) { showToast(e.message, 'error'); }
    });
    const footer = m.overlay.querySelector('#modal-footer');
    if (footer) footer.appendChild(go);
  }

  // ---- public entry points used by the Servers → Edge agent page ----

  window.edgeAgentSectionHtml = function (channelConfigured) {
    return `<div class="ui-page">
      ${UI.header('', 'A small outbound-only container on each server collects metrics and logs, watches Docker events and sends alerts through your notification channels. It needs no inbound port, works behind NAT and keeps watching when DockGate is offline. While it runs, DockGate\'s own monitor for that server pauses so you get no duplicate alerts.', `${UI.btn('Refresh', 'id="edge-refresh"')} ${UI.primary('Install on servers…', 'id="edge-install-all"')}`)}
      ${channelConfigured ? '' : `<div class="insight-card warning" style="margin-bottom:12px"><span>No notification channel is set up yet, so the agent installs in metrics-only mode. <a href="#/settings?tab=notifications">Set up a channel</a></span></div>`}
      <div id="edge-agent-update"></div>
      <div id="edge-agent-table"><div class="text-xs text-muted">Loading servers…</div></div>
      <h3 style="margin:22px 0 8px;font-size:15px">Agent jobs</h3>
      <div id="edge-agent-jobs"><div class="text-xs text-muted">Loading…</div></div>
    </div>`;
  };

  // Without a notification channel the agent still installs (metrics-only), so the table loads either way.
  // (It used to return here, leaving "Loading servers…" for good.)
  window.attachEdgeAgentHandlers = function (root, channelConfigured) {

    async function load() {
      const el = document.getElementById('edge-agent-table');
      if (!el) return;
      try {
        const [serversResp, status, cur] = await Promise.all([API.get('/servers'), API.get('/agent/status'), API.get('/agent/current').catch(() => null)]);
        const servers = (serversResp.servers || serversResp || []).filter(s => s.id !== 'local' && s.type !== 'local');
        // "Update all servers" banner: DockGate carries a newer agent build than some servers run.
        const behind = servers.filter(s => (status[s.id] || {}).updateAvailable);
        const ub = document.getElementById('edge-agent-update');
        if (ub) {
          ub.innerHTML = behind.length ? `<div class="insight-card warning" style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="flex:1;min-width:220px"><b>A newer agent is available${cur ? ` (v${escapeHtml(cur.version)}${cur.build ? ', build <span class="td-mono">' + escapeHtml(cur.build.slice(0, 7)) + '</span>' : ''})` : ''}.</b>
              ${behind.length === 1 ? '1 server runs' : behind.length + ' servers run'} an older one: ${behind.map(s => escapeHtml(s.name || s.id)).join(', ')}. Updating restarts the agent (a few seconds); containers are not touched.</span>
              ${UI.primary(`Update all servers (${behind.length})`, 'id="edge-update-all"')}</div>` : '';
          ub.querySelector('#edge-update-all')?.addEventListener('click', () => secConfirm({
            title: `Update the agent on ${behind.length} server${behind.length === 1 ? '' : 's'}`,
            change: `DockGate copies the new agent image to ${behind.map(s => '<b>' + escapeHtml(s.name || s.id) + '</b>').join(', ')} and recreates the agent there, one server after another.`,
            protects: 'The new image is on the server before the old agent stops. If the new agent does not start, the previous one is put back. Your containers keep running.',
            confirmLabel: 'Update all',
            onConfirm: async () => {
              try { const r = await API.post('/agent/update-all', {}); if (r.jobId) openJobModal(r.jobId, load); else { showToast('All agents are up to date'); load(); } }
              catch (e) { showToast(e.message, 'error'); }
            },
          }));
        }
        if (!servers.length) {
          el.innerHTML = `<div class="text-xs text-muted">No remote servers yet. Add one in Servers to install the agent on it.</div>`;
          return;
        }
        el.innerHTML = UI.table([{ label: 'Server' }, { label: 'Address' }, { label: 'Agent' }, { label: 'Version' }, { label: '', align: 'right' }], servers.map(s => ({ cells: agentCells(s, status[s.id] || {}) })), { minWidth: 640 });
        el.querySelectorAll('[data-act]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const sid = btn.dataset.sid, act = btn.dataset.act;
            try {
              if (act === 'install' || act === 'update') {
                const { jobId } = await API.post('/agent/' + act, { serverId: sid });
                openJobModal(jobId, load);
              } else if (act === 'remove') {
                showDeleteConfirm('Remove DockGate agent', {
                  message: `Remove the DockGate agent from <strong>${escapeHtml(sid)}</strong>? DockGate's central monitor will resume watching it.`,
                  phrase: sid, confirmLabel: 'Remove',
                  onConfirm: async () => {
                    try { await API.post('/agent/remove', { serverId: sid }); showToast('Agent removed'); load(); }
                    catch (e) { showToast(e.message, 'error'); }
                  },
                });
                return;
              } else if (act === 'start' || act === 'stop') {
                await API.post('/agent/power', { serverId: sid, action: act });
                showToast('Agent ' + (act === 'stop' ? 'stopped' : 'started')); load();
              } else if (act === 'channel') {
                channelModal(sid, load, btn.dataset.installed === '1');
              }
            } catch (e) { showToast(e.message, 'error'); }
          });
        });
      } catch (e) {
        el.innerHTML = `<div class="text-xs text-muted">Could not load agent status: ${escapeHtml(e.message)}</div>`;
      }
    }

    // Agent jobs: the running one on top (banner + Open log), then the recent ones. Any of them reopens its log.
    let jobsTimer = null, lastRunning = 0;
    async function loadJobs() {
      const el = document.getElementById('edge-agent-jobs');
      if (!el) { clearTimeout(jobsTimer); return; }
      let jobs = [];
      try { jobs = await API.get('/agent/jobs'); } catch (e) { el.innerHTML = `<div class="text-xs text-muted">Could not load agent jobs: ${escapeHtml(e.message)}</div>`; return; }
      const running = jobs.filter(j => j.status === 'running');
      const what = (j) => `${KIND[j.kind] || escapeHtml(j.kind)}${j.server_id ? ` · ${escapeHtml(j.server_id)}` : j.total > 1 ? ` · ${j.total} servers` : ''}`;
      const when = (t) => (t ? formatTime(String(t).replace(' ', 'T') + (/[zZ]$/.test(t) ? '' : 'Z')) : '—');
      const result = (j) => j.status === 'running' ? UI.pill('warn', `Running${j.total > 1 ? ` ${j.ok + j.failed}/${j.total}` : ''}`)
        : j.status === 'failed' ? UI.pill('bad', 'Failed') : (j.failed ? UI.pill('warn', `${j.failed} of ${j.total} failed`) : UI.pill('ok', 'Done'));
      el.innerHTML = (running.length ? running.map(j => `<div class="insight-card info" style="margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span style="flex:1;min-width:200px"><b>Running:</b> ${what(j)} · started ${escapeHtml(when(j.started_at))}</span>${UI.btn('Open log', `data-job="${escapeHtml(j.id)}"`, 'btn-primary')}</div>`).join('') : '')
        + (jobs.length ? UI.table([{ label: 'Started' }, { label: 'Job' }, { label: 'Result' }, { label: '', align: 'right' }],
            jobs.slice(0, 10).map(j => ({ cells: [`<span class="ui-sub">${escapeHtml(when(j.started_at))}</span>`, what(j), result(j), UI.btn('Open log', `data-job="${escapeHtml(j.id)}"`)] })), { minWidth: 480 })
          : '<div class="text-xs text-muted">No agent jobs yet.</div>');
      el.querySelectorAll('[data-job]').forEach(b => b.addEventListener('click', () => openJobModal(b.dataset.job, () => { load(); loadJobs(); })));
      if (lastRunning && !running.length) load(); // a job ended while the page was open: refresh versions
      lastRunning = running.length;
      clearTimeout(jobsTimer);
      if (running.length) jobsTimer = setTimeout(loadJobs, 3000);
    }
    const loadAll = () => { load(); loadJobs(); };
    window._edgeAgentJobsRefresh = loadJobs; // a job started anywhere on the page shows up here at once

    document.getElementById('edge-refresh')?.addEventListener('click', loadAll);
    document.getElementById('edge-install-all')?.addEventListener('click', () => openInstallPicker(load));

    loadAll();
  };

  // Once per browser session, shortly after sign-in: if some servers run an older agent build than DockGate carries,
  // say so in a notice that opens Servers → Edge agent (where "Update all servers" is). Nothing updates by itself.
  window.openAgentJob = openJobModal;

  window.edgeAgentUpdateCheck = function () {
    try { if (sessionStorage.getItem('dg_agent_update_checked')) return; sessionStorage.setItem('dg_agent_update_checked', '1'); } catch (e) { /* storage off: check anyway */ }
    setTimeout(async () => {
      let st;
      try { st = await API.get('/agent/status'); } catch (e) { return; }
      const behind = Object.keys(st || {}).filter(id => st[id] && st[id].installed && st[id].updateAvailable);
      if (!behind.length) return;
      const box = document.getElementById('toast-container'); if (!box) return;
      const t = document.createElement('div');
      t.className = 'toast toast-info'; t.style.cursor = 'pointer'; t.setAttribute('role', 'button'); t.tabIndex = 0;
      t.innerHTML = `<span><b>A newer Edge agent is available.</b> ${behind.length === 1 ? '1 server runs' : behind.length + ' servers run'} an older one. Open Edge agent to update all servers.</span>`;
      const go = () => { t.remove(); Router.navigate('infra', { tab: 'agent' }); };
      t.addEventListener('click', go); t.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      box.appendChild(t);
      setTimeout(() => t.remove(), 20000);
    }, 6000);
  };

  // Push the current rules + channel settings to every installed agent (called after the user
  // changes notification rules / channels, so central edits propagate without per-agent clicks).
  // silentIfNone: don't toast when there are no installed agents (used by the auto-hook).
  window.edgeAgentSync = async function (silentIfNone) {
    try {
      const r = await API.post('/agent/sync', {});
      if (r && r.jobId) { showToast(`Pushing settings to ${r.count} agent(s)…`, 'info'); openJobModal(r.jobId); }
      else if (!silentIfNone) showToast('No installed agents to update', 'info');
    } catch (e) { showToast('Agent sync failed: ' + e.message, 'error'); }
  };
})();
