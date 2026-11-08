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

// ---------- Services tab — Cockpit "Services" style: one table, select a row for its details ----------
const SVC_INFO = {
  docker: ['Container engine', null], timesync: ['Keeps the clock right (chrony)', null], 'unattended-upgrades': ['Installs security updates', null],
  'ssh-hardening': ['Remote login', 'access'], firewall: ['Blocks unwanted traffic', 'firewall'], fail2ban: ['Bans brute-force IPs', 'fail2ban'],
};
const SVC_NAME = { docker: 'Docker', timesync: 'Time sync', 'unattended-upgrades': 'Auto updates', 'ssh-hardening': 'SSH server', firewall: 'Firewall', fail2ban: 'Fail2ban' };
async function renderServicesPanel(serverId, container, sub) {
  container.innerHTML = '<div class="skeleton" style="height:160px;width:100%"></div>';
  let data;
  try { data = await API.get(`/servers/${serverId}/services/status`); }
  catch (e) { return secError(container, "Couldn't read services", e, () => renderServicesPanel(serverId, container, sub)); }
  const list = (data.services || []).filter(x => x.itemId).map(x => ({ ...x, label: SVC_NAME[x.itemId] || x.label }));
  const usable = list.filter(x => !x.na);
  let active = usable.some(x => x.itemId === sub) ? sub : (usable.find(x => x.itemId === 'docker') || usable[0] || {}).itemId;
  const reload = () => renderServicesPanel(serverId, container, active);
  const stateCell = (x) => x.na ? UI.pill('off', 'Not available') : x.active === null ? UI.pill('off', 'Unknown') : x.active ? UI.pill('ok', 'Running') : UI.pill('bad', 'Stopped');
  const bootCell = (x) => x.na || x.enabled === null ? '<span class="ui-sub">—</span>'
    : `<button type="button" class="toggle ${x.enabled ? 'active' : ''}" role="switch" aria-checked="${!!x.enabled}" aria-label="Start ${escapeHtml(x.label)} at boot" data-boot="${x.itemId}" style="border:0"></button>`;
  container.innerHTML = `
    ${UI.header('Services', 'System services DockGate manages on this server. Select one for its settings and log.')}
    ${UI.table([{ label: 'Service' }, { label: 'State' }, { label: 'Start at boot' }, { label: '', align: 'right' }], list.map(x => ({ cls: x.itemId === active ? 'ui-row-selected' : '', cells: [
      `<a href="#" data-sel="${x.itemId}" style="color:inherit;text-decoration:none;font-weight:600">${escapeHtml(x.label)}</a> <span class="ui-sub td-mono">${escapeHtml(x.unit || '')}${x.timer ? ' (timer)' : ''}</span><div class="ui-sub">${escapeHtml((SVC_INFO[x.itemId] || [x.reason || ''])[0])}</div>`,
      stateCell(x), bootCell(x),
      // state unknown (no systemd and nothing to probe): offer every action, as the old service bar did
      x.na ? '' : `${x.active !== true ? UI.btn('Start', `data-act="start" data-svc="${x.itemId}"`, 'btn-primary') : ''}${x.active !== false ? UI.btn(x.reload ? 'Reload' : 'Restart', `data-act="restart" data-svc="${x.itemId}"`) : ''}${x.active !== false ? UI.btn('Stop', `data-act="stop" data-svc="${x.itemId}"`, 'btn-danger') : ''}`,
    ] })), { minWidth: 640, empty: 'No manageable services on this server.' })}
    <div id="svc-page" style="margin-top:18px"></div>`;
  const page = container.querySelector('#svc-page');
  const show = (id) => {
    active = id;
    container.querySelectorAll('tr').forEach(tr => tr.classList.toggle('ui-row-selected', !!tr.querySelector(`[data-sel="${id}"]`)));
    const x = list.find(y => y.itemId === id);
    const tab = (SVC_INFO[id] || [])[1];
    if (!x) { page.innerHTML = ''; return; }
    if (tab) {
      page.innerHTML = `${UI.header(escapeHtml(x.label), `Settings for this service are on the <b>${escapeHtml({ access: 'Access & SSH', firewall: 'Firewall', fail2ban: 'Fail2ban' }[tab])}</b> tab.`, UI.btn('Open', 'data-goto', 'btn-primary'))}`;
      page.querySelector('[data-goto]').onclick = () => document.querySelector(`#con-tabs .tab-btn[data-ctab="${tab}"]`)?.click();
    } else {
      page.innerHTML = UI.header(escapeHtml(x.label), escapeHtml((SVC_INFO[id] || [''])[0])) + '<div data-detail></div>';
      renderServicePage(serverId, id, page.querySelector('[data-detail]'));
    }
  };
  container.querySelectorAll('[data-sel]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.sel); }));
  const run = (x, action, label) => svcRunAction(serverId, x, action, label, reload);
  container.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => run(list.find(y => y.itemId === b.dataset.svc), b.dataset.act, b.textContent)));
  container.querySelectorAll('[data-boot]').forEach(b => b.addEventListener('click', () => { const x = list.find(y => y.itemId === b.dataset.boot); run(x, x.enabled ? 'disable' : 'enable', x.enabled ? 'Disable at boot' : 'Enable at boot'); }));
  if (active) show(active);
}

/** One lifecycle action with the same confirm rules as the service bar (risky services ask first). */
function svcRunAction(serverId, s, action, label, done) {
  const send = (confirm) => API.post(`/servers/${serverId}/services/${s.itemId}/action`, { action, confirm });
  const ok = () => { showToast(`${s.label}: ${label.toLowerCase()} ✓`); setTimeout(done, 700); };
  send(false).then(ok).catch((e) => {
    if (/confirm/i.test(e.message || '')) secConfirm({
      title: `${escapeHtml(label)} — ${escapeHtml(s.label)}`, danger: true, confirmLabel: label,
      change: `${escapeHtml(s.label)} (${escapeHtml(s.unit || '')}) will ${escapeHtml(label.toLowerCase())}.`,
      protects: s.risk === 'high' ? 'This service guards access (SSH / firewall): stopping it over a password login is refused, and open SSH sessions survive a reload.' : 'Only this service is affected.',
      undo: action === 'stop' || action === 'disable' ? 'Start / enable it again here.' : 'Nothing to undo.',
      onConfirm: () => send(true).then(ok).catch(e2 => showToast(e2.message, 'error', 8000)),
    });
    else showToast(e.message, 'error', 8000);
  });
}

async function renderServicePage(serverId, item, el) {
  el.innerHTML = `
    <div data-body><div class="card"><div class="skeleton" style="width:100%;height:120px"></div></div></div>
    <div data-raw style="margin-top:16px"></div>
    <div data-logs style="margin-top:12px"></div>`;
  const reload = () => renderServicePage(serverId, item, el);
  // state + start/stop live in the Services table above; here: settings, the raw config file and the log
  API.get(`/servers/${serverId}/services/status`).then((d) => {
    const svc = (d.services || []).find(x => x.itemId === item);
    const p = svc && svc.configPaths && svc.configPaths[0];
    if (p && document.body.contains(el)) renderRawConfig(serverId, item, p, el.querySelector('[data-raw]'), { label: p });
  }).catch(() => {});
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
  const rs = info.rhelSettings || {};
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
        </form>` : (info.installed === false ? `<div class="text-sm text-muted" style="margin:6px 0 10px">dnf-automatic is not installed — install it in Setup → Auto updates.</div>` : `
        <form data-form style="display:grid;gap:4px">
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Install updates automatically</div><div class="settings-row-desc">Daily, via dnf-automatic.timer</div></div><div class="toggle ${rs.enabled ? 'active' : ''}" id="au-en" role="switch" tabindex="0"></div></div>
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Which updates</div><div class="settings-row-desc">Security only is the safer choice for servers</div></div><select class="select" id="au-type" style="width:150px"><option value="security" ${rs.upgradeType === 'security' ? 'selected' : ''}>Security only</option><option value="default" ${rs.upgradeType !== 'security' ? 'selected' : ''}>All updates</option></select></div>
          <div class="settings-row" style="padding:8px 0;border-bottom:0"><div><div class="settings-row-label">Reboot automatically when needed</div><div class="settings-row-desc">Right after an update that requires it (kernel, glibc). Needs dnf 4.15+ / dnf5 — older versions ignore it</div></div><div class="toggle ${rs.reboot === 'when-needed' ? 'active' : ''}" id="au-rb" role="switch" tabindex="0"></div></div>
          <button class="btn btn-sm btn-primary" type="submit" style="justify-self:start;margin-top:6px">Save</button>
        </form>`)}
      </div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:10px">Status</div>
        ${svcKv([['Pending updates', String(info.pending)], ['Reboot required', info.rebootRequired ? '<span style="color:var(--warning)">yes</span>' : 'no']])}
        <div class="text-xs text-muted" style="margin:12px 0 4px">Next / last run</div>${svcPre(info.timer, 'timer not found')}
        ${info.last ? `<details style="margin-top:8px"><summary class="text-xs text-muted" style="cursor:pointer">Last unattended-upgrades log</summary><div style="margin-top:6px">${svcPre(info.last)}</div></details>` : ''}
      </div>
    </div>`;
  if (!debian && !body.querySelector('[data-form]')) return;
  body.querySelectorAll('.toggle').forEach(t => { const f = () => t.classList.toggle('active'); t.addEventListener('click', f); t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); f(); } }); });
  body.querySelector('[data-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = debian
      ? { enabled: body.querySelector('#au-en').classList.contains('active'), autoReboot: body.querySelector('#au-rb').classList.contains('active'), rebootTime: body.querySelector('#au-time').value.trim() }
      : { family: 'rhel', enabled: body.querySelector('#au-en').classList.contains('active'), upgradeType: body.querySelector('#au-type').value, reboot: body.querySelector('#au-rb').classList.contains('active') ? 'when-needed' : 'never' };
    try { await API.post(`/servers/${serverId}/services/unattended-upgrades/settings`, v); showToast('Auto update settings saved'); reload(); }
    catch (er) { showToast(er.message, 'error', 8000); }
  });
}
