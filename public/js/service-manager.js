// Manage tab — per-service control panel for one remote server. Lists the manageable services
// (GET /services/status) as design-system cards and exposes start / stop / restart / enable / disable.
// Destructive actions on a high-risk service (firewall/ssh) or on Docker are gated by the backend (409
// → confirm dialog → resend with confirm:true; no mutation happens on the 409). Status is re-fetched on
// open and after each action — no polling, so nothing to tear down. Global: renderServiceManager(id, con).
function renderServiceManager(serverId, container) {
  container.innerHTML = `
    <div class="flex justify-between items-center mb-2">
      <div style="font-size:15px;font-weight:700">Services</div>
      <span class="badge badge-restarting" id="sm-status"><span class="badge-dot"></span> loading…</span>
    </div>
    <div id="sm-body"><div class="grid-2">${Array(4).fill('<div class="card"><div class="skeleton" style="width:100%;height:64px"></div></div>').join('')}</div></div>`;
  const statusEl = container.querySelector('#sm-status');
  const body = container.querySelector('#sm-body');

  const btn = (item, label, act, txt, cls, icon) =>
    `<button class="btn btn-sm ${cls}" data-item="${item}" data-act="${act}" data-label="${label}">${icon || ''}${txt}</button>`;

  function card(s) {
    const lbl = escapeHtml(s.label || s.itemId), il = escapeHtml(s.itemId);
    if (s.na) {
      return `<div class="card" style="opacity:.6">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-weight:700;font-size:15px">${lbl}</div><span class="badge" style="opacity:.6">n/a</span></div>
        <div class="text-xs text-muted" style="margin-top:4px">${escapeHtml(s.reason || 'not manageable on this OS')}</div></div>`;
    }
    const statusBadge = s.active
      ? '<span class="badge badge-running"><span class="badge-dot"></span> active</span>'
      : '<span class="badge badge-stopped">inactive</span>';
    const enabled = s.enabled
      ? '<span class="text-xs" style="color:var(--success)">● enabled at boot</span>'
      : '<span class="text-xs text-muted">○ not enabled at boot</span>';
    const riskTag = s.risk === 'high' ? ' <span class="text-xs" style="color:var(--danger)">⚠ lockout-class</span>' : '';
    const actions = [];
    if (s.active) {
      actions.push(btn(il, lbl, 'restart', 'Restart', 'btn-secondary', Icons.restart));
      actions.push(btn(il, lbl, 'stop', 'Stop', 'btn-danger', Icons.stop));
    } else {
      actions.push(btn(il, lbl, 'start', 'Start', 'btn-primary', Icons.play));
    }
    actions.push(s.enabled ? btn(il, lbl, 'disable', 'Disable', 'btn-secondary') : btn(il, lbl, 'enable', 'Enable', 'btn-secondary'));
    const cfgList = (s.configPaths || []).map(p => escapeHtml(p)).join('<br>') || '—';
    const cfgPath = (s.configPaths || [])[0];
    const high = s.risk === 'high';
    const editor = cfgPath ? `
      <details data-cfg data-item="${il}" data-path="${escapeHtml(cfgPath)}" data-label="${lbl}" data-high="${high ? '1' : '0'}" style="margin-top:8px">
        <summary class="text-xs" style="cursor:pointer;color:var(--accent)">Edit config (${escapeHtml(cfgPath)})</summary>
        <div style="margin-top:8px">
          ${high ? '<div style="border-left:3px solid var(--danger);background:rgba(248,81,73,.06);padding:8px 10px;border-radius:6px;margin-bottom:8px"><div class="text-xs" style="color:var(--danger);font-weight:600">⚠ Lockout risk</div><div class="text-xs text-muted">A wrong firewall / SSH change over this connection can lock you out. The file is backed up, validated, and auto-restored if the service fails to restart.</div></div>' : ''}
          <textarea class="input" data-cfgta spellcheck="false" style="width:100%;min-height:160px;font-family:var(--font-mono);font-size:12px;line-height:1.5" placeholder="open to load…"></textarea>
          <div class="flex gap-1 items-center" style="margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" data-cfgsave>Validate &amp; save</button>
            <span class="text-xs text-muted">backup → validate → auto-restore on failure</span>
          </div>
        </div>
      </details>` : '';
    return `<div class="card" style="border-left:3px solid ${s.active ? 'var(--success)' : 'var(--text-muted)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div><div style="font-weight:700;font-size:15px">${lbl}${riskTag}</div><div style="margin-top:4px">${enabled}</div></div>
        ${statusBadge}
      </div>
      <div class="flex gap-1" style="margin-top:12px;flex-wrap:wrap">${actions.join('')}</div>
      <details style="margin-top:10px"><summary class="text-xs text-muted" style="cursor:pointer">How it works</summary>
        <div class="detail-grid" style="grid-template-columns:1fr;gap:6px;margin-top:8px">
          <div class="detail-item"><div class="detail-label">Unit</div><div class="detail-value mono">${escapeHtml(s.unit || '—')}${s.timer ? ' (timer)' : ''}</div></div>
          <div class="detail-item"><div class="detail-label">Config</div><div class="detail-value mono">${cfgList}</div></div>
        </div>
      </details>
      ${editor}
    </div>`;
  }

  function render(data) {
    const svcs = data.services || [];
    if (!svcs.length) { body.innerHTML = '<div class="empty-state"><p>No manageable services detected on this host.</p></div>'; return; }
    body.innerHTML = `<div class="grid-2">${svcs.map(card).join('')}</div>`;
    body.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.item, b.dataset.act, b.dataset.label)));
    // Config editors: lazy-load the file on first expand; Save → confirm → guarded write.
    body.querySelectorAll('details[data-cfg]').forEach(d => {
      const itemId = d.dataset.item, p = d.dataset.path, ta = d.querySelector('textarea[data-cfgta]');
      let loaded = false;
      d.addEventListener('toggle', async () => {
        if (!d.open || loaded) return;
        loaded = true; ta.value = ''; ta.disabled = true; ta.placeholder = 'loading…';
        try {
          const r = await API.get(`/servers/${serverId}/services/${itemId}/config?path=${encodeURIComponent(p)}`);
          ta.value = r.content || ''; ta.disabled = false;
          ta.placeholder = r.exists ? '' : '(file does not exist yet — saving will create it)';
        } catch (e) { ta.disabled = false; ta.placeholder = 'could not read: ' + e.message; loaded = false; }
      });
      d.querySelector('button[data-cfgsave]')?.addEventListener('click', () => saveConfig(itemId, p, ta.value, d.dataset.label, d.dataset.high === '1'));
    });
  }

  function saveConfig(itemId, path, content, label, high) {
    const doSave = async () => {
      try {
        const r = await API.post(`/servers/${serverId}/services/${itemId}/config`, { path, content, confirm: true });
        showToast(`${label}: config saved${r.validated ? ' & validated' : ''}${r.backup ? ' · backup made' : ''}`, 'success', 7000);
        setTimeout(refresh, 800);
      } catch (e) { showToast('Save failed: ' + e.message, 'error', 10000); }
    };
    const warn = high
      ? `Editing ${label} config over SSH can LOCK YOU OUT if wrong. It is backed up, validated, and auto-restored if the service fails to restart — but a firewall/SSH change that blocks this session may still cut you off. Continue?`
      : `Save ${label} config? It is backed up and validated, and auto-restored if the service fails to restart.`;
    showConfirm(`Save ${label} config`, warn, doSave, true);
  }

  async function refresh() {
    try {
      const data = await API.get(`/servers/${serverId}/services/status`);
      if (!document.body.contains(body)) return; // tab/page changed
      statusEl.className = 'badge badge-running';
      statusEl.innerHTML = `<span class="badge-dot"></span> ${escapeHtml(data.distro || 'live')}`;
      render(data);
    } catch (e) {
      if (!document.body.contains(body)) return;
      statusEl.className = 'badge badge-stopped';
      statusEl.textContent = 'unavailable';
      body.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div style="font-weight:600;color:var(--danger)">Couldn't read services</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><div class="text-xs text-muted" style="margin-top:6px">Needs SSH access + passwordless sudo on a Linux host.</div><button class="btn btn-secondary btn-sm" id="sm-retry" style="margin-top:10px">Retry</button></div>`;
      body.querySelector('#sm-retry')?.addEventListener('click', refresh);
    }
  }

  async function act(itemId, action, label) {
    const send = (confirm) => API.post(`/servers/${serverId}/services/${itemId}/action`, { action, confirm });
    try {
      await send(false);
      showToast(`${label}: ${action} ✓`, 'success');
      setTimeout(refresh, 700);
    } catch (e) {
      if (/confirm/i.test(e.message || '')) {
        // Backend asked for confirmation (high-risk / docker / destructive). No mutation happened yet.
        showConfirm(`${action} — ${label}?`, `${e.message}. Continue?`, async () => {
          try { await send(true); showToast(`${label}: ${action} ✓`, 'success'); setTimeout(refresh, 700); }
          catch (e2) { showToast(e2.message, 'error', 8000); }
        }, true);
      } else {
        showToast(e.message, 'error', 8000);
      }
    }
  }

  refresh();
}
