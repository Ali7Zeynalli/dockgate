// Edge Notifier (agent) — Settings ▸ Notifications panel. Plain-script globals (loaded before settings.js).
// Renders a per-server table with Install / Start-Stop / Update / Channel / Remove, an "Install on all"
// fan-out, and a re-openable deploy-log modal. All actions hit /api/agent/* (DockGate-initiated outbound).
(function () {
  function pill(st) {
    const map = {
      running:     ['Running', 'badge-running'],
      stopped:     ['Stopped', 'badge-created'],
      absent:      ['Not installed', 'badge-dead'],
      unreachable: ['Unreachable', 'badge-dead'],
    };
    const [label, cls] = map[st.state] || map.absent;
    const ver = st.version ? ` <span class="text-xs text-muted">v${escapeHtml(st.version)}</span>` : '';
    return `<span class="badge ${cls}">${label}</span>${ver}`;
  }

  function rowHtml(s, st) {
    const sid = escapeHtml(s.id);
    const host = escapeHtml(s.host || '');
    const state = st.state || 'absent';
    const installed = state === 'running' || state === 'stopped';
    let actions;
    if (!installed) {
      actions = `<button class="btn btn-primary btn-sm" data-act="install" data-sid="${sid}">Install</button>
        <button class="btn btn-secondary btn-sm" data-act="channel" data-sid="${sid}" data-installed="0">Channel</button>`;
    } else {
      const power = state === 'running'
        ? `<button class="btn btn-ghost btn-sm" data-act="stop" data-sid="${sid}">Stop</button>`
        : `<button class="btn btn-ghost btn-sm" data-act="start" data-sid="${sid}">Start</button>`;
      actions = `${power}
        <button class="btn btn-secondary btn-sm" data-act="channel" data-sid="${sid}" data-installed="1">Channel</button>
        <button class="btn btn-secondary btn-sm" data-act="update" data-sid="${sid}">Update</button>
        <button class="btn btn-ghost btn-sm" data-act="remove" data-sid="${sid}">Remove</button>`;
    }
    return `<div class="settings-row" style="padding:8px 0;">
      <div>
        <div class="settings-row-label" style="margin:0;">${sid}</div>
        <div class="settings-row-desc">${host} · ${pill(st)}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${actions}</div>
    </div>`;
  }

  // Live deploy-log modal. Polls the job; stops cleanly when the job ends or the modal is closed.
  // Always shows a Close button, and a prominent status that turns green/red when the job finishes.
  function openJobModal(jobId, onDone) {
    const body = `<pre id="edge-job-log" style="max-height:340px;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0;">Starting…</pre>
      <div id="edge-job-status" style="margin-top:10px;font-size:13px;font-weight:600;color:var(--text-muted);">⏳ Working…</div>`;
    const m = showModal('Notifier agent — deploy', body, []);
    const footer = m.overlay.querySelector('#modal-footer');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => m.close();
    if (footer) footer.appendChild(closeBtn);

    let timer = null, finished = false;
    async function poll() {
      if (!m.overlay || !m.overlay.isConnected) { if (timer) clearTimeout(timer); return; }
      try {
        const j = await API.get('/agent/job/' + jobId);
        const le = m.overlay.querySelector('#edge-job-log');
        if (le) { le.textContent = j.log || '(no output yet)'; le.scrollTop = le.scrollHeight; }
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
          showToast(okAll ? 'Deploy finished' : (j.status === 'failed' ? 'Deploy failed' : 'Deploy finished with errors'), okAll ? 'success' : 'error');
          if (typeof onDone === 'function') onDone();
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
      <div class="text-xs text-muted" style="margin-bottom:10px;">Pick the servers to install the notifier agent on. Already-installed servers start unchecked — re-checking one reinstalls (recreates) it.</div>
      <label style="display:flex;align-items:center;gap:10px;padding:4px 0 10px;font-weight:600;cursor:pointer;border-bottom:1px solid var(--border);">
        <input type="checkbox" id="edge-pick-all"> <span>Select all</span>
      </label>
      <div style="max-height:320px;overflow:auto;">${rows}</div>`;
    const m = showModal('Install notifier agent — choose servers', body, []);
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

  // ---- public entry points used by settings.js renderNotifications ----

  window.edgeNotifierSectionHtml = function (channelConfigured) {
    if (!channelConfigured) {
      return `<div class="settings-section" style="margin-top:20px;">
        <div class="settings-section-title">Edge Notifier (agent)</div>
        <div class="text-xs text-muted">Configure a Telegram or SMTP channel above first — the agent reuses it to send alerts directly from each server (no inbound access needed).</div>
      </div>`;
    }
    return `<div class="settings-section" style="margin-top:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px;flex-wrap:wrap;">
        <div class="settings-section-title" style="margin:0;">Edge Notifier (agent)</div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" id="edge-refresh">↻ Refresh</button>
          <button class="btn btn-primary btn-sm" id="edge-install-all">Install on servers…</button>
        </div>
      </div>
      <div class="settings-row-desc" style="margin-bottom:10px;">A tiny <strong>outbound-only</strong> container on each server watches its Docker events and sends alerts through the channel above — no inbound ports, works behind NAT, keeps alerting if DockGate is offline. Installing it stops DockGate's central monitor for that host (no duplicate alerts); removing it resumes the monitor.</div>
      <div id="edge-agent-table"><div class="text-xs text-muted">Loading servers…</div></div>
    </div>`;
  };

  window.attachEdgeNotifierHandlers = function (root, channelConfigured) {
    if (!channelConfigured) return;

    async function load() {
      const el = document.getElementById('edge-agent-table');
      if (!el) return;
      try {
        const [serversResp, status] = await Promise.all([API.get('/servers'), API.get('/agent/status')]);
        const servers = (serversResp.servers || serversResp || []).filter(s => s.id !== 'local' && s.type !== 'local');
        if (!servers.length) {
          el.innerHTML = `<div class="text-xs text-muted">No remote servers yet. Add one under Infrastructure to deploy the agent.</div>`;
          return;
        }
        el.innerHTML = servers.map(s => rowHtml(s, status[s.id] || {})).join('');
        el.querySelectorAll('[data-act]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const sid = btn.dataset.sid, act = btn.dataset.act;
            try {
              if (act === 'install' || act === 'update') {
                const { jobId } = await API.post('/agent/' + act, { serverId: sid });
                openJobModal(jobId, load);
              } else if (act === 'remove') {
                if (!confirm(`Remove the notifier agent from ${sid}? DockGate's central monitor will resume watching it.`)) return;
                await API.post('/agent/remove', { serverId: sid });
                showToast('Agent removed'); load();
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

    document.getElementById('edge-refresh')?.addEventListener('click', load);
    document.getElementById('edge-install-all')?.addEventListener('click', () => openInstallPicker(load));

    load();
  };
})();
