// Services tab (Server Console) — one page per system service, as sub-tabs: Docker · Time sync · Auto updates.
// Security services live in their own tabs (SSH → Access & SSH, UFW → Firewall, fail2ban → Fail2ban).
// Every page has the same shape: header (state + actions) → settings form → live details → raw config
// (advanced, collapsed) → recent log. Also exports the shared pieces those other tabs reuse:
//   renderServiceBar(serverId, itemId, el, opts)   — state badge + start/stop/restart/enable/disable
//   renderRawConfig(serverId, itemId, path, el, opts) — guarded raw editor (backup → validate → auto-restore)
// Globals only (no build step), same as the rest of public/js.

function svcPre(text, empty) {
  return `<pre style="white-space:pre-wrap;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:11.5px;line-height:1.5;max-height:260px;overflow:auto;margin:0">${escapeHtml(text || empty || '(nothing)')}</pre>`;
}

// ---------- service state bar (shared) ----------
async function renderServiceBar(serverId, itemId, el, { label, note, onChange } = {}) {
  el.innerHTML = '<div class="skeleton" style="height:38px;width:100%"></div>';
  let s;
  try {
    const data = await API.get(`/servers/${serverId}/services/status`);
    s = (data.services || []).find(x => x.itemId === itemId);
  } catch (e) { el.innerHTML = `<div class="text-xs" style="color:var(--danger)">Service state unavailable: ${escapeHtml(e.message)}</div>`; return; }
  if (!s || s.na) { el.innerHTML = `<div class="text-xs text-muted">${escapeHtml((s && s.reason) || 'Not available on this server')}</div>`; return null; }
  const btn = (act, txt, cls) => `<button class="btn btn-xs ${cls}" data-act="${act}">${txt}</button>`;
  // active/enabled are null when the server has no systemd and the state cannot be probed
  const acts = s.active === null
    ? [btn('start', 'Start', 'btn-primary'), btn('restart', s.reload ? 'Reload' : 'Restart', 'btn-secondary'), btn('stop', 'Stop', 'btn-danger')]
    : (s.active ? [btn('restart', s.reload ? 'Reload' : 'Restart', 'btn-secondary'), btn('stop', 'Stop', 'btn-danger')] : [btn('start', 'Start', 'btn-primary')]);
  if (s.enabled !== null) acts.push(s.enabled ? btn('disable', 'Disable at boot', 'btn-secondary') : btn('enable', 'Enable at boot', 'btn-secondary'));
  el.innerHTML = `
    <div class="flex items-center justify-between" style="gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card)">
      <div class="flex items-center gap-2" style="flex-wrap:wrap">
        <span style="font-weight:600">${escapeHtml(label || s.label)}</span>
        ${s.active === null ? '<span class="badge" title="No systemd on this server and no way to check this service">state unknown</span>' : (s.active ? '<span class="badge badge-running"><span class="badge-dot"></span> active</span>' : '<span class="badge badge-stopped">inactive</span>')}
        ${s.enabled === null ? '<span class="text-xs text-muted" title="Starting at boot is managed by systemd, which this server does not run">no systemd · boot start not managed</span>' : `<span class="text-xs ${s.enabled ? '' : 'text-muted'}" style="${s.enabled ? 'color:var(--success)' : ''}">${s.enabled ? '● starts at boot' : '○ not started at boot'}</span>`}
        <span class="text-xs text-muted td-mono">${escapeHtml(s.unit || '')}${s.timer ? ' (timer)' : ''}</span>
      </div>
      <div class="flex gap-1" style="flex-wrap:wrap">${acts.join('')}</div>
    </div>
    ${note ? `<div class="text-xs text-muted" style="margin-top:6px">${note}</div>` : ''}`;
  el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const action = b.dataset.act;
    const send = (confirm) => API.post(`/servers/${serverId}/services/${itemId}/action`, { action, confirm });
    const done = () => { showToast(`${s.label}: ${b.textContent.toLowerCase()} ✓`); setTimeout(() => { renderServiceBar(serverId, itemId, el, { label, note, onChange }); onChange && onChange(); }, 700); };
    send(false).then(done).catch((e) => {
      if (/confirm/i.test(e.message || '')) secConfirm({
        title: `${escapeHtml(b.textContent)} — ${escapeHtml(s.label)}`, danger: true, confirmLabel: b.textContent,
        change: `${escapeHtml(s.label)} (${escapeHtml(s.unit || '')}) will ${escapeHtml(b.textContent.toLowerCase())}.`,
        protects: s.risk === 'high' ? 'This service guards access (SSH / firewall): stopping it over a password login is refused, and open SSH sessions survive a reload.' : 'Only this service is affected.',
        undo: action === 'stop' || action === 'disable' ? 'Start / enable it again from this bar.' : 'Nothing to undo.',
        onConfirm: () => send(true).then(done).catch(e2 => showToast(e2.message, 'error', 8000)),
      });
      else showToast(e.message, 'error', 8000);
    });
  }));
  return s; // callers use s.configPaths (distro-specific) for the raw editor
}

// ---------- raw config editor (shared, advanced) ----------
function renderRawConfig(serverId, itemId, path, el, { label, high, hint } = {}) {
  el.innerHTML = `
    <details class="card" style="padding:12px 14px">
      <summary class="text-sm" style="cursor:pointer;font-weight:600">Advanced: edit ${escapeHtml(path)} directly</summary>
      <div style="margin-top:10px">
        ${high ? '<div class="insight-card warning" style="display:block;margin-bottom:8px"><b>Lockout risk.</b> A wrong value here can cut SSH access. The file is backed up, validated and restored if the service fails to restart — but prefer the form above, which also tests a new login.</div>' : ''}
        ${hint ? `<div class="text-xs text-muted" style="margin-bottom:6px">${hint}</div>` : ''}
        <textarea class="input" data-ta spellcheck="false" style="width:100%;min-height:200px;font-family:var(--font-mono);font-size:12px;line-height:1.5" placeholder="loading…"></textarea>
        <div class="flex gap-1 items-center" style="margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-save>Validate &amp; save</button>
          <span class="text-xs text-muted">backup → validate → restore automatically on failure</span>
        </div>
      </div>
    </details>`;
  const d = el.querySelector('details'), ta = el.querySelector('[data-ta]');
  let loaded = false;
  d.addEventListener('toggle', async () => {
    if (!d.open || loaded) return;
    loaded = true; ta.disabled = true;
    try {
      const r = await API.get(`/servers/${serverId}/services/${itemId}/config?path=${encodeURIComponent(path)}`);
      ta.value = r.content || ''; ta.placeholder = r.exists ? '' : '(file does not exist yet — saving creates it)';
    } catch (e) { ta.placeholder = 'could not read: ' + e.message; loaded = false; }
    ta.disabled = false;
  });
  el.querySelector('[data-save]').addEventListener('click', () => secConfirm({
    title: `Save ${escapeHtml(label || path)}`, danger: !!high, confirmLabel: 'Validate & save',
    change: `${escapeHtml(path)} is replaced with the text above and the service applies it.`,
    protects: high
      ? 'The file is backed up and validated, and restored if the service fails to restart. This editor does NOT test a new login — a wrong value can still lock you out; prefer the form above.'
      : 'The file is backed up and validated, and restored if the service fails to restart.',
    undo: 'The previous version is kept as a backup next to the file.',
    onConfirm: async () => {
      try {
        const r = await API.post(`/servers/${serverId}/services/${itemId}/config`, { path, content: ta.value, confirm: true });
        showToast(`Saved${r.validated ? ' & validated' : ''}${r.backup ? ' · backup kept' : ''}`, 'success', 6000);
      } catch (e) { showToast('Save failed: ' + e.message, 'error', 10000); }
    },
  }));
}

function renderServiceLogs(text, el) {
  el.innerHTML = `<details class="card" style="padding:12px 14px"><summary class="text-sm" style="cursor:pointer;font-weight:600">Recent log</summary><div style="margin-top:10px">${svcPre(text, '(no journal entries)')}</div></details>`;
}

// ---------- Services tab ----------
function renderServicesPanel(serverId, container, sub) {
  const pages = [['docker', 'Docker'], ['timesync', 'Time sync'], ['unattended-upgrades', 'Auto updates']];
  let active = pages.some(p => p[0] === sub) ? sub : 'docker';
  container.innerHTML = `
    <div class="tab-bar" id="svc-tabs" style="margin-bottom:14px">${pages.map(([v, l]) => `<button class="tab-btn ${v === active ? 'active' : ''}" data-svc="${v}">${l}</button>`).join('')}</div>
    <div class="text-xs text-muted" style="margin:-6px 0 14px">SSH is managed in <b>Access &amp; SSH</b>, the firewall in <b>Firewall</b>, fail2ban in <b>Fail2ban</b>.</div>
    <div id="svc-page"></div>`;
  const page = container.querySelector('#svc-page');
  const show = (v) => {
    active = v;
    container.querySelectorAll('#svc-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.svc === v));
    renderServicePage(serverId, v, page);
  };
  container.querySelector('#svc-tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (b) show(b.dataset.svc); });
  show(active);
}

async function renderServicePage(serverId, item, el) {
  el.innerHTML = `
    <div data-bar style="margin-bottom:16px"></div>
    <div data-body><div class="card"><div class="skeleton" style="width:100%;height:120px"></div></div></div>
    <div data-raw style="margin-top:16px"></div>
    <div data-logs style="margin-top:12px"></div>`;
  const reload = () => renderServicePage(serverId, item, el);
  renderServiceBar(serverId, item, el.querySelector('[data-bar]'), { onChange: reload }).then((svc) => {
    const p = svc && svc.configPaths && svc.configPaths[0];
    if (p && document.body.contains(el)) renderRawConfig(serverId, item, p, el.querySelector('[data-raw]'), { label: p });
  });
  const body = el.querySelector('[data-body]');
  let info;
  try { info = await API.get(`/servers/${serverId}/services/${item}/info`); }
  catch (e) { body.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div style="font-weight:600;color:var(--danger)">Couldn't read service details</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div></div>`; return; }
  if (!document.body.contains(body)) return;
  if (item === 'docker') renderDockerPage(serverId, info, body, reload);
  else if (item === 'timesync') renderTimesyncPage(serverId, info, body, reload);
  else renderAutoUpdatesPage(serverId, info, body, reload);
  renderServiceLogs(info.logs, el.querySelector('[data-logs]'));
}

const svcKv = (pairs) => `<div class="detail-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">${pairs.map(([k, v]) => `<div class="detail-item"><div class="detail-label">${k}</div><div class="detail-value" style="word-break:normal">${v}</div></div>`).join('')}</div>`;

function renderDockerPage(serverId, info, body, reload) {
  const s = info.summary, st = info.settings || {};
  body.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px">Container logs &amp; restarts</div>
        <div class="text-sm text-muted" style="margin-bottom:10px">Without a size limit, container logs grow until the disk is full. Applies to containers created after saving.</div>
        <form data-form style="display:grid;gap:4px">
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Log size per file</div><div class="settings-row-desc">e.g. 10m, 50m, 1g</div></div><input class="input" id="dk-size" value="${escapeHtml(st.maxSize || '10m')}" style="width:90px"></div>
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Log files kept</div><div class="settings-row-desc">Oldest file is deleted when a new one starts</div></div><input class="input" id="dk-files" type="number" min="1" max="50" value="${st.maxFile || 3}" style="width:90px"></div>
          <div class="settings-row" style="padding:8px 0;border-bottom:0"><div><div class="settings-row-label">Live restore</div><div class="settings-row-desc">Containers keep running while Docker itself restarts${s && s.swarm === 'active' ? ' · not available in swarm mode' : ''}</div></div><div class="toggle ${st.liveRestore ? 'active' : ''}" id="dk-lr" role="switch" tabindex="0"></div></div>
          ${info.daemonJsonValid === false ? '<div class="insight-card danger">/etc/docker/daemon.json is not valid JSON — fix it under Advanced first.</div>' : ''}
          <button class="btn btn-sm btn-primary" type="submit" style="justify-self:start;margin-top:6px">Save</button>
        </form>
      </div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:10px">Engine</div>
        ${s ? svcKv([['Version', escapeHtml(s.version || '—')], ['Containers', `${s.running} running / ${s.containers}`], ['Images', String(s.images)], ['Storage', escapeHtml(s.storageDriver || '—')], ['Logging', escapeHtml(s.loggingDriver || '—')], ['Live restore', s.liveRestore ? 'on' : 'off'], ['Cgroup', escapeHtml(s.cgroupDriver || '—')], ['Swarm', escapeHtml(s.swarm || '—')]]) : '<div class="text-sm text-muted">Docker is not reachable on this server.</div>'}
        ${info.df ? `<div style="margin-top:12px">${svcPre(info.df)}</div>` : ''}
      </div>
    </div>`;
  const lr = body.querySelector('#dk-lr');
  lr.addEventListener('click', () => lr.classList.toggle('active'));
  lr.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); lr.classList.toggle('active'); } });
  body.querySelector('[data-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = { maxSize: body.querySelector('#dk-size').value.trim(), maxFile: Number(body.querySelector('#dk-files').value), liveRestore: lr.classList.contains('active') };
    secConfirm({
      title: 'Save Docker settings', confirmLabel: 'Save',
      change: '/etc/docker/daemon.json gets the new log limits and live-restore setting. New containers use them; existing ones keep theirs until recreated.',
      protects: 'The file is backed up and validated. With running containers Docker only reloads, so nothing is stopped; with none it restarts. A failure restores the previous file.',
      undo: 'Save the old values again, or restore the file under Advanced.',
      onConfirm: async () => {
        try {
          const { jobId } = await API.post(`/servers/${serverId}/services/docker/settings`, { ...v, confirm: true });
          const ok = await runLifelineJob(serverId, jobId, 'Docker settings');
          if (ok) reload();
        } catch (er) { showToast(er.message, 'error', 8000); }
      },
    });
  });
}

function renderTimesyncPage(serverId, info, body, reload) {
  const list = (info.servers || []).map(x => ({ ...x }));
  body.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:4px"><div style="font-weight:700;font-size:15px">NTP sources</div>${info.managed ? '<span class="badge" style="background:var(--accent-dim);color:var(--accent)">set by DockGate</span>' : '<span class="badge" style="opacity:.7">distro defaults</span>'}</div>
        <div class="text-sm text-muted" style="margin-bottom:10px">Where this server gets its time. A <b>pool</b> name resolves to several servers; a <b>server</b> is one host. DockGate keeps the distro's own lines (commented) and can switch back to them.</div>
        ${info.installed === false ? '<div class="insight-card warning">chrony is not installed — install it in Setup → Time sync.</div>' : `
        <div data-list style="display:grid;gap:6px;margin-bottom:10px"></div>
        <form data-add class="flex gap-1 items-center" style="flex-wrap:wrap">
          <select class="select" id="ntp-type"><option value="pool">pool</option><option value="server">server</option></select>
          <input class="input" id="ntp-host" placeholder="e.g. pool.ntp.org, time.cloudflare.com" style="width:240px">
          <button class="btn btn-sm btn-secondary" type="submit">Add</button>
        </form>
        <div class="flex gap-1" style="margin-top:14px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-save>Save &amp; restart chrony</button>
          ${info.managed ? '<button class="btn btn-sm btn-secondary" data-defaults>Use distro defaults</button>' : ''}
        </div>
        <div data-err style="margin-top:8px"></div>`}
      </div>
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:10px"><div style="font-weight:700;font-size:15px">Clock</div>${info.synced ? '<span class="badge badge-running">synchronised</span>' : '<span class="badge badge-stopped">not synchronised</span>'}</div>
        ${info.offset ? `<div class="text-sm" style="margin-bottom:8px">Offset from NTP: <span class="td-mono">${escapeHtml(info.offset)}</span></div>` : ''}
        ${svcPre(info.sources, 'chrony is not installed or not running')}
        <details style="margin-top:8px"><summary class="text-xs text-muted" style="cursor:pointer">timedatectl / tracking</summary><div style="margin-top:6px">${svcPre([info.timedatectl, info.tracking].filter(Boolean).join('\n\n'))}</div></details>
      </div>
    </div>`;
  if (info.installed === false) return;
  const listEl = body.querySelector('[data-list]');
  const draw = () => {
    listEl.innerHTML = list.length ? list.map((x, i) => `<div class="flex items-center justify-between" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px"><span><span class="text-xs text-muted" style="display:inline-block;width:52px">${escapeHtml(x.type)}</span><span class="td-mono">${escapeHtml(x.host)}</span></span><button class="btn btn-xs btn-secondary" data-rm="${i}">Remove</button></div>`).join('')
      : '<div class="text-sm text-muted">No sources — add at least one, or use the distro defaults.</div>';
    listEl.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { list.splice(Number(b.dataset.rm), 1); draw(); }));
  };
  draw();
  body.querySelector('[data-add]').addEventListener('submit', (e) => {
    e.preventDefault();
    const host = body.querySelector('#ntp-host').value.trim();
    if (!host) return;
    if (!list.some(x => x.host === host)) list.push({ type: body.querySelector('#ntp-type').value, host });
    body.querySelector('#ntp-host').value = '';
    draw();
  });
  const save = async (servers) => {
    try {
      const { jobId } = await API.post(`/servers/${serverId}/services/timesync/settings`, { servers });
      const ok = await runLifelineJob(serverId, jobId, 'Time sync sources');
      if (ok) reload();
    } catch (e) { body.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
  body.querySelector('[data-save]').addEventListener('click', () => {
    if (!list.length) { body.querySelector('[data-err]').innerHTML = '<div class="insight-card warning">Add at least one source, or use the distro defaults.</div>'; return; }
    save(list);
  });
  body.querySelector('[data-defaults]')?.addEventListener('click', () => secConfirm({
    title: 'Use distro defaults', confirmLabel: 'Use defaults',
    change: "DockGate's NTP sources are removed and the distro's own pool/server lines come back. chrony restarts.",
    protects: 'The configuration is validated (chronyd -p) and restored if chrony fails to start.',
    undo: 'Add your sources again and save.',
    onConfirm: () => save([]),
  }));
}

function renderAutoUpdatesPage(serverId, info, body, reload) {
  const st = info.settings || {};
  const debian = info.family !== 'rhel';
  body.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px">Automatic security updates</div>
        ${debian ? `
        <form data-form style="display:grid;gap:4px">
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Install updates automatically</div><div class="settings-row-desc">Daily, via unattended-upgrades</div></div><div class="toggle ${st.enabled ? 'active' : ''}" id="au-en" role="switch" tabindex="0"></div></div>
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Reboot automatically when needed</div><div class="settings-row-desc">Only when an update requires it (kernel, libc)</div></div><div class="toggle ${st.autoReboot ? 'active' : ''}" id="au-rb" role="switch" tabindex="0"></div></div>
          <div class="settings-row" style="padding:8px 0;border-bottom:0"><div><div class="settings-row-label">Reboot time</div><div class="settings-row-desc">Server local time, 24-hour</div></div><input class="input" id="au-time" value="${escapeHtml(st.rebootTime || '04:00')}" style="width:90px"></div>
          <button class="btn btn-sm btn-primary" type="submit" style="justify-self:start;margin-top:6px">Save</button>
        </form>` : `<div class="text-sm text-muted" style="margin:6px 0 10px">dnf-automatic settings:</div>${svcPre(info.rhel, 'dnf-automatic is not configured')}`}
      </div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:10px">Status</div>
        ${svcKv([['Pending updates', String(info.pending)], ['Reboot required', info.rebootRequired ? '<span style="color:var(--warning)">yes</span>' : 'no']])}
        <div class="text-xs text-muted" style="margin:12px 0 4px">Next / last run</div>${svcPre(info.timer, 'timer not found')}
        ${info.last ? `<details style="margin-top:8px"><summary class="text-xs text-muted" style="cursor:pointer">Last unattended-upgrades log</summary><div style="margin-top:6px">${svcPre(info.last)}</div></details>` : ''}
      </div>
    </div>`;
  if (!debian) return;
  body.querySelectorAll('.toggle').forEach(t => { const f = () => t.classList.toggle('active'); t.addEventListener('click', f); t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); f(); } }); });
  body.querySelector('[data-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = { enabled: body.querySelector('#au-en').classList.contains('active'), autoReboot: body.querySelector('#au-rb').classList.contains('active'), rebootTime: body.querySelector('#au-time').value.trim() };
    try { await API.post(`/servers/${serverId}/services/unattended-upgrades/settings`, v); showToast('Auto update settings saved'); reload(); }
    catch (er) { showToast(er.message, 'error', 8000); }
  });
}
