// Provisioning panel + overview — render INTO a container (the per-server console's tabs), not a modal.
// On open they LIVE-SCAN the server (read-only detect) so you see what's installed before acting.
// Globals: renderProvisionPanel(serverId, container) · renderConsoleOverview(serverId, container, onSetup).
const PV_ICON = { verified: '✓', installed: '✓', present: '✓', failed: '✗', skipped: '⊘', unknown: '○' };
const PV_STATE = (scanItems) => {
  const present = {};
  for (const it of (scanItems || [])) present[it.id] = it;
  return (id) => { const s = present[id]; return s ? (s.na ? 'na' : (s.present ? 'present' : 'missing')) : 'unknown'; };
};

// ---------- Setup tab — components table (AWS Systems Manager / Azure Machine Configuration style) ----------
// Live scan = what is installed now; matrix = the last result DockGate recorded per component (errors);
// runs = history. "Run setup" shows the plan first; the run streams step by step (GitHub Actions style).
const PV_PRESETS = [
  ['just-docker', 'Just Docker', 'Docker Engine + Compose and log limits'],
  ['secure-baseline', 'Secure baseline', 'update · firewall · SSH hardening · fail2ban · Docker · deploy user'],
  ['full', 'Full', 'Everything in the list'],
  ['custom', 'Custom', 'Pick components'],
];
async function renderProvisionPanel(serverId, container, opts = {}) {
  container.innerHTML = `<div class="text-sm text-muted">Scanning <b>${escapeHtml(serverId)}</b> over SSH — checking what is installed…</div><div class="skeleton" style="height:16px;width:60%;margin-top:10px"></div>`;
  let catalog, scan, matrix = [], runs = [];
  try {
    [catalog, scan, matrix, runs] = await Promise.all([
      API.get('/servers/provision/catalog'), API.get(`/servers/${serverId}/provision/scan`),
      API.get(`/servers/${serverId}/provision/matrix`).then(r => r.matrix || []).catch(() => []),
      API.get(`/servers/${serverId}/provision/runs`).then(r => r.runs || []).catch(() => []),
    ]);
  } catch (e) {
    return secError(container, 'Scan failed — the server may be unreachable, or the login cannot be used for the scan', e, () => renderProvisionPanel(serverId, container));
  }
  renderProvisionForm(serverId, catalog, scan, container, { matrix, runs, preset: opts.preset });
}

function renderProvisionForm(serverId, catalog, scan, container, { matrix = [], runs = [], preset: startPreset } = {}) {
  const stateOf = PV_STATE(scan.items);
  const items = catalog.items || [];
  const last = Object.fromEntries(matrix.map(m => [m.id, m]));
  let preset = startPreset || 'secure-baseline';
  let custom = new Set(items.filter(it => stateOf(it.id) === 'missing' && !it.optional && !it.alwaysRun).map(it => it.id));
  const statusOf = (it) => {
    const st = stateOf(it.id);
    if (st === 'na') return ['off', 'Not available', 'na'];
    if (it.alwaysRun) return ['info', 'Runs every time', 'action'];
    if (st === 'present') return ['ok', 'Installed', 'present'];
    if (st === 'missing' && last[it.id] && last[it.id].state === 'failed') return ['bad', 'Failed', 'failed'];
    if (st === 'missing') return it.optional ? ['off', 'Optional', 'optional'] : ['warn', 'Missing', 'missing'];
    return ['off', 'Unknown', 'unknown'];
  };
  const selected = () => preset === 'custom' ? [...custom] : (preset === 'full' ? items.map(i => i.id) : (catalog.presets[preset] || []));
  const todoOf = (ids) => items.filter(it => ids.includes(it.id) && ['missing', 'failed', 'optional', 'action'].includes(statusOf(it)[2]));
  const groupLabel = (g) => ({ base: 'Base', security: 'Security', system: 'System' }[g] || (g ? g[0].toUpperCase() + g.slice(1) : 'Other'));
  const ord = ['base', 'security', 'system'];
  const sorted = items.slice().sort((a, b) => (ord.indexOf(a.group) - ord.indexOf(b.group)) || (a.seq - b.seq));
  const fmtWhen = (t) => (t ? String(t).replace('T', ' ').slice(0, 16) : '—');
  const dur = (a, b) => { if (!a || !b) return '—'; const s = Math.max(0, (new Date(b.replace(' ', 'T') + 'Z') - new Date(a.replace(' ', 'T') + 'Z')) / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`; };

  const draw = () => {
    const sel = selected(), todo = todoOf(sel);
    const counts = items.reduce((a, it) => { const k = statusOf(it)[2]; a[k] = (a[k] || 0) + 1; return a; }, {});
    container.innerHTML = `
      ${UI.statusLine([
        scan.distro ? `<b>OS</b> <span class="text-muted">${escapeHtml(scan.distro)}</span>` : '',
        UI.pill('ok', `${counts.present || 0} installed`),
        counts.missing ? UI.pill('warn', `${counts.missing} missing`) : '',
        counts.failed ? UI.pill('bad', `${counts.failed} failed`) : '',
        counts.na ? `<span class="text-muted">${counts.na} not available on this OS</span>` : '',
      ])}
      ${UI.header('Setup', 'What is installed on this server. Each component is checked before it is installed and verified after.', `${UI.btn('Scan again', 'data-rescan', 'btn-ghost')}<button type="button" class="btn btn-sm btn-primary" data-run ${todo.length ? '' : 'disabled'}>${todo.length ? `Run setup (${todo.length})…` : 'Nothing to install'}</button>`)}
      <div class="ui-field" style="margin-bottom:10px"><span class="ui-label">Preset</span>
        <div class="ui-seg">${PV_PRESETS.map(([v, l]) => `<button type="button" data-preset="${v}" aria-pressed="${preset === v}">${l}</button>`).join('')}</div>
        <span class="ui-help">${escapeHtml(PV_PRESETS.find(x => x[0] === preset)[2])} · ${sel.length} components, ${todo.length} to run${preset === 'custom' ? ' · tick the components below' : ''}</span></div>
      ${UI.table([{ label: '', width: '34px' }, { label: 'Component' }, { label: 'Group' }, { label: 'Status' }, { label: 'Details' }, { label: 'Last run' }, { label: '', align: 'right' }], sorted.map(it => {
        const [lv, txt, key] = statusOf(it), m = last[it.id];
        const on = sel.includes(it.id);
        const detail = key === 'failed' && m && (m.error || m.reason) ? `<span style="color:var(--danger)">${escapeHtml(String(m.error || m.reason).split('\n').slice(-1)[0].slice(0, 140))}</span>`
          : key === 'na' ? escapeHtml((scan.items.find(x => x.id === it.id) || {}).reason || 'not on this OS') : escapeHtml(it.description || '');
        return { cls: on ? 'ui-row-selected' : '', cells: [
          `<input type="checkbox" data-comp="${escapeHtml(it.id)}" aria-label="Include ${escapeHtml(it.label)}" ${on ? 'checked' : ''} ${preset === 'custom' && key !== 'na' ? '' : 'disabled'} style="accent-color:var(--accent)">`,
          `<b>${escapeHtml(it.label)}</b>${it.risk === 'high' ? '<div class="ui-sub" style="color:var(--warning)">risky · tested with a new SSH login</div>' : ''}`,
          `<span class="ui-sub">${groupLabel(it.group)}</span>`,
          UI.pill(lv, txt),
          `<span class="ui-sub" title="${escapeHtml(key === 'failed' && m ? (m.error || m.reason || '') : (it.description || ''))}">${detail}</span>`,
          `<span class="ui-sub">${fmtWhen(m && m.lastAt)}</span>`,
          ['missing', 'failed', 'optional'].includes(key) ? UI.btn(key === 'failed' ? 'Retry' : 'Install', `data-one="${escapeHtml(it.id)}"`) : '',
        ] };
      }), { minWidth: 820 })}
      ${UI.header('Run history', 'Every setup run with its full log.')}
      ${UI.table([{ label: 'Started' }, { label: 'Preset' }, { label: 'Result' }, { label: 'Duration' }, { label: '', align: 'right' }], runs.map(r => ({ cells: [
        `<span class="ui-sub">${fmtWhen(r.started_at)}</span>`,
        escapeHtml((PV_PRESETS.find(x => x[0] === r.preset) || [0, r.preset])[1]),
        `${UI.pill(...({ running: ['info', 'Running'], done: ['ok', 'Succeeded'], partial: ['bad', 'Failed'], error: ['bad', 'Error'], cancelled: ['warn', 'Cancelled'] }[r.status] || ['off', escapeHtml(r.status)]))} <span class="ui-sub">${r.item_ok || 0} ok · ${r.item_failed || 0} failed</span>`,
        `<span class="ui-sub">${dur(r.started_at, r.finished_at)}</span>`,
        UI.btn('View log', `data-log="${escapeHtml(r.id)}"`),
      ] })), { minWidth: 600, empty: 'No runs yet.' })}`;

    container.querySelector('[data-rescan]').onclick = () => renderProvisionPanel(serverId, container, { preset });
    container.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { preset = b.dataset.preset; draw(); });
    container.querySelectorAll('[data-comp]').forEach(cb => cb.onchange = () => { if (cb.checked) custom.add(cb.dataset.comp); else custom.delete(cb.dataset.comp); draw(); });
    container.querySelector('[data-run]').onclick = () => openRunSetup(todoOf(selected()), preset === 'custom' ? [...custom] : undefined, preset, selected());
    container.querySelectorAll('[data-one]').forEach(b => b.onclick = () => { const it = items.find(x => x.id === b.dataset.one); openRunSetup([it], [it.id], 'custom', [it.id]); });
    container.querySelectorAll('[data-log]').forEach(b => b.onclick = () => openRunLog(b.dataset.log));
  };

  function openRunSetup(todo, only, presetName, selIds) {
    // the server asks for confirmation when ANY selected component is high-risk (it re-checks installed ones)
    const risky = items.filter(it => selIds.includes(it.id) && it.risk === 'high' && statusOf(it)[2] !== 'na');
    const needsUser = todo.some(it => it.id === 'deploy-user');
    UI.dialog({
      title: 'Run setup', saveLabel: `Start (${todo.length})`, wide: true,
      body: `<div class="ui-sub">Only what is missing or failed runs; installed components are skipped. You can cancel between components.</div>
        <div class="card ui-steps" style="padding:0">${todo.map(it => `<div><span class="text-muted">○</span><span><b>${escapeHtml(it.label)}</b>${it.description ? `<div class="ui-sub">${escapeHtml(it.description)}</div>` : ''}</span><span class="ui-sub">${groupLabel(it.group)}</span></div>`).join('')}</div>
        ${needsUser ? `<div class="ui-field"><label for="pv-deploy-name">Deploy user name</label><input class="input" id="pv-deploy-name" value="deploy" spellcheck="false" style="width:200px;font-family:var(--font-mono)"><span class="ui-help">Created with sudo + Docker access and an SSH key DockGate generates; DockGate then connects as this user.</span></div>` : ''}
        ${risky.length ? `<label class="flex gap-2 text-sm" style="align-items:flex-start"><input type="checkbox" id="pv-confirm" style="margin-top:3px"><span><b style="color:var(--danger)">${risky.map(r => escapeHtml(r.label)).join(', ')}</b> can lock you out if misconfigured (installed ones are only re-checked). DockGate tests a new SSH login and rolls back on failure. I want to proceed.</span></label>` : ''}
        ${UI.explain('Packages are installed and config files written on the server.', 'Each component is detected first and verified after; firewall and SSH changes test a new login.')}`,
      onSave: async (ov) => {
        const confirm = !!ov.querySelector('#pv-confirm')?.checked;
        if (risky.length && !confirm) throw new Error('Tick the confirmation for the risky components first');
        const deployUser = (ov.querySelector('#pv-deploy-name')?.value || 'deploy').trim();
        const r = await API.post(`/servers/${serverId}/provision`, { preset: presetName, only, confirm, deployUser });
        setTimeout(() => streamProvisionJob(serverId, r.jobId, container), 0);
      },
    });
  }
  draw();
}

async function openRunLog(runId) {
  let d;
  try { d = await API.get(`/servers/provision/runs/${encodeURIComponent(runId)}`); }
  catch (e) { return showToast(e.message, 'error', 8000); }
  const ic = { verified: ['ok', 'Verified'], present: ['ok', 'Already there'], installed: ['ok', 'Installed'], failed: ['bad', 'Failed'], skipped: ['off', 'Skipped'] };
  const m = showModal(`Setup run · ${escapeHtml(String(d.run.started_at || '').slice(0, 16))}`, `
    ${UI.table([{ label: 'Component' }, { label: 'Result' }, { label: 'Time' }], (d.items || []).map(i => ({ cells: [
      `<b>${escapeHtml(i.label || i.item_id)}</b>${i.error ? `<div class="ui-sub" style="color:var(--danger)">${escapeHtml(String(i.error).slice(0, 200))}</div>` : ''}`,
      UI.pill(...(ic[i.state] || ['off', i.state])), `<span class="ui-sub">${i.duration_ms ? (i.duration_ms / 1000).toFixed(1) + ' s' : '—'}</span>`,
    ] })), { minWidth: 420, empty: 'No components recorded.' })}
    <details style="margin-top:10px"><summary class="text-sm" style="cursor:pointer;font-weight:600">Full log</summary><pre style="white-space:pre-wrap;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-secondary);padding:10px;border-radius:8px;max-height:45vh;overflow:auto;font-size:12px;margin-top:8px">${escapeHtml(d.run.log || '(empty)')}</pre></details>`, []);
  m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
  const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Close'; c.onclick = () => m.close();
  m.overlay.querySelector('.modal-footer').append(c);
}

// ---------- Overview tab — merged readiness + live host metrics (Dashboard-grade) ----------
// One scan feeds the readiness banner + component cards; renderHostMonitoring owns the live
// metrics subtree (its own self-terminating 5s poll). One scan + one host poll — no double work.
async function renderConsoleOverview(serverId, container, onSetup) {
  container.innerHTML = `
    <div class="text-sm text-muted">🔍 Scanning <b>${escapeHtml(serverId)}</b> over SSH…</div>
    <div class="skeleton" style="height:18px;width:55%;margin-top:10px"></div>
    <div class="skeleton" style="height:18px;width:40%;margin-top:6px"></div>`;
  let catalog, scan;
  try {
    [catalog, scan] = await Promise.all([API.get('/servers/provision/catalog'), API.get(`/servers/${serverId}/provision/scan`)]);
  } catch (e) {
    container.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div class="text-danger" style="font-weight:600">Scan failed</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><button class="btn btn-secondary btn-sm" id="ov-retry" style="margin-top:10px">Retry scan</button></div>`;
    container.querySelector('#ov-retry')?.addEventListener('click', () => renderConsoleOverview(serverId, container, onSetup));
    return;
  }

  const stateOf = PV_STATE(scan.items);
  const items = catalog.items || [];
  const installed = items.filter(it => stateOf(it.id) === 'present').length;
  const missingItems = items.filter(it => !it.alwaysRun && !it.optional && stateOf(it.id) === 'missing');
  const missing = missingItems.length;
  const missingNames = missingItems.map(it => it.label).join(' · '); // name them, not just count them
  const naCount = items.filter(it => stateOf(it.id) === 'na').length;
  const ready = stateOf('docker') === 'present';

  const meta = {
    present: { ic: '✓', col: 'var(--success)', txt: 'installed' },
    missing: { ic: '●', col: 'var(--warning, #f59e0b)', txt: 'missing' },
    action:  { ic: '↻', col: 'var(--info)', txt: 'runs every time' },
    optional:{ ic: '◦', col: 'var(--text-muted)', txt: 'optional · not installed' },
    na:      { ic: '⊘', col: 'var(--text-muted)', txt: 'n/a on this OS' },
    unknown: { ic: '?', col: 'var(--text-muted)', txt: 'unknown' },
  };
  // Compact component row (status icon + label + state) — no nested cards, so the Components zone stays tidy.
  const compRow = (it) => {
    const st = it.alwaysRun ? 'action' : (it.optional && stateOf(it.id) === 'missing' ? 'optional' : stateOf(it.id)), c = meta[st] || meta.unknown;
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;border-bottom:1px solid var(--border);opacity:${st === 'na' ? 0.55 : 1}">
      <span style="color:${c.col};width:14px;text-align:center">${c.ic}</span>
      <span style="flex:1;min-width:0">${escapeHtml(it.label)}${it.risk === 'high' ? ' <span class="text-xs" style="color:var(--danger)">⚠</span>' : ''}</span>
      <span class="text-xs text-muted">${c.txt}</span>
    </div>`;
  };
  const groups = [['base', 'Base'], ['security', 'Security'], ['system', 'System']];
  const componentsHtml = groups.map(([g, glabel]) => {
    const gItems = items.filter(it => it.group === g);
    if (!gItems.length) return '';
    return `<div style="margin-bottom:10px"><div class="text-xs text-muted" style="font-weight:700;letter-spacing:.4px;margin-bottom:2px">${glabel.toUpperCase()}</div>${gItems.map(compRow).join('')}</div>`;
  }).join('');

  // Zoned layout: readiness banner (top) · grid-2 [Docker | Components] · live host metrics (full width).
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card" style="border-left:4px solid ${ready ? 'var(--success)' : 'var(--warning, #f59e0b)'}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <div>
            <div style="font-size:17px;font-weight:700">${ready ? '✓ Ready' : '⚠ Needs setup'}</div>
            <div class="text-sm text-muted">${scan.distro ? 'OS: ' + escapeHtml(scan.distro) + ' · ' : ''}${installed} installed · ${missing} missing${naCount ? ` · ${naCount} n/a` : ''}</div>
            ${missing ? `<div class="text-sm" style="color:var(--warning,#f59e0b);font-weight:600;margin-top:3px">Missing: ${escapeHtml(missingNames)}</div>` : ''}
          </div>
          ${missing ? `<button class="btn btn-primary btn-sm" id="ov-setup">Set up ${missing} missing →</button>` : ''}
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:10px">Docker</div>
          <div id="ov-docker"><div class="text-xs text-muted">loading…</div></div>
        </div>
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:10px">Components</div>
          ${componentsHtml || '<div class="text-xs text-muted">No components</div>'}
          <div class="text-xs text-muted" style="margin-top:8px">Scanned over SSH · use <b>Setup</b> to install missing.</div>
        </div>
      </div>

      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">Live host metrics</div>
        <div id="ov-host"></div>
      </div>
    </div>`;
  container.querySelector('#ov-setup')?.addEventListener('click', () => { if (typeof onSetup === 'function') onSetup(); });

  // Docker counts — compact stat row, auto-refreshed every 30s (self-terminating; skipped while a modal
  // is open or the user is typing). The readiness scan is one-shot (slow + rarely changes); host metrics
  // refresh on their own 5s tick.
  const dockerStat = (d) => {
    const s = (v, l, col) => `<div style="text-align:center;min-width:60px"><div style="font-size:20px;font-weight:800;line-height:1.1;color:${col || 'var(--text-primary)'}">${v}</div><div class="text-xs text-muted">${l}</div></div>`;
    return `<div style="display:flex;gap:16px;flex-wrap:wrap">${s(d.containers, 'Containers')}${s(d.running, 'Running', 'var(--success)')}${s(d.images, 'Images')}${s(d.volumes, 'Volumes')}${s(d.networks, 'Networks')}</div>`;
  };
  let dt = null;
  async function refreshDocker() {
    const el = container.querySelector('#ov-docker');
    if (!el || !document.body.contains(el)) { if (dt) clearInterval(dt); return; } // view swapped out
    if (typeof shouldSkipAutoRefresh === 'function' && shouldSkipAutoRefresh()) return; // modal open / typing
    try { const d = await API.get(`/servers/${serverId}/docker/summary`); if (document.body.contains(el)) el.innerHTML = dockerStat(d); }
    catch (e) { if (document.body.contains(el)) el.innerHTML = '<div class="text-xs text-muted">Docker not reachable on this host</div>'; }
  }
  refreshDocker();
  dt = setInterval(refreshDocker, 30000);

  // Embed the live host-metrics dashboard; it self-terminates its 5s poll when this view is swapped out.
  const hostEl = container.querySelector('#ov-host');
  if (hostEl && typeof renderHostMonitoring === 'function') renderHostMonitoring(serverId, hostEl);
}

// ---------- Run progress — steps like a CI job, log underneath ----------
function streamProvisionJob(serverId, jobId, container) {
  container.innerHTML = `
    ${UI.header(`<span id="pv-title">Setting up ${escapeHtml(serverId)}…</span>`, 'Runs on the server even if you leave this page.', `<button class="btn btn-sm btn-secondary" id="pv-cancel">Cancel after this step</button><button class="btn btn-sm btn-primary" id="pv-rescan" style="display:none">Back to components</button>`)}
    <div class="card ui-steps" style="padding:0" id="pv-steps"></div>
    <details class="card" style="margin-top:12px"><summary class="text-sm" style="cursor:pointer;font-weight:600">Full log</summary>
      <pre id="pv-log" style="white-space:pre-wrap;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-secondary);padding:10px;border-radius:8px;max-height:38vh;overflow:auto;font-size:12px;margin-top:8px"></pre>
    </details>`;
  const logEl = container.querySelector('#pv-log');
  const stepsEl = container.querySelector('#pv-steps');
  const titleEl = container.querySelector('#pv-title');
  const rescan = container.querySelector('#pv-rescan');
  rescan.addEventListener('click', () => renderProvisionPanel(serverId, container));
  const cancelBtn = container.querySelector('#pv-cancel');
  cancelBtn.addEventListener('click', () => showConfirm('Cancel setup', 'The component that is installing now finishes first (stopping a package manager halfway can break it); nothing after it runs.', async () => {
    try { await API.post(`/servers/provision/job/${jobId}/cancel`); cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…'; }
    catch (e) { showToast(e.message, 'error', 6000); }
  }, true));
  const sm = {
    verified: ['✓', 'var(--success)', 'verified'], present: ['✓', 'var(--success)', 'already there'], installed: ['✓', 'var(--success)', 'installed'],
    failed: ['✕', 'var(--danger)', 'failed'], skipped: ['⊘', 'var(--text-muted)', 'skipped'],
  };
  const step = (label, state, running) => {
    const [ic, c, txt] = sm[state] || [running ? '●' : '○', running ? 'var(--accent)' : 'var(--text-muted)', running ? 'running…' : (state || '')];
    return `<div><span style="color:${c};text-align:center">${ic}</span><span>${escapeHtml(label)}</span><span class="ui-sub">${txt}</span></div>`;
  };
  let timer = null;
  const poll = async () => {
    if (!document.body.contains(stepsEl)) { clearInterval(timer); return; }
    let job;
    try { job = await API.get(`/servers/provision/job/${jobId}`); }
    catch (e) { clearInterval(timer); if (document.body.contains(stepsEl)) { titleEl.textContent = 'Run finished — see Run history'; rescan.style.display = ''; cancelBtn.style.display = 'none'; } return; }
    logEl.textContent = job.log || '';
    logEl.scrollTop = logEl.scrollHeight;
    const rows = (job.items || []).map(i => step(i.label || i.id, i.state, false));
    if (job.status === 'running' && job.phase && !(job.items || []).some(i => i.id === job.phase)) rows.push(step(job.phase, null, true));
    stepsEl.innerHTML = rows.join('') || '<div><span></span><span class="ui-sub">Starting…</span><span></span></div>';
    if (job.status && job.status !== 'running') {
      clearInterval(timer);
      rescan.style.display = '';
      cancelBtn.style.display = 'none';
      if (job.rebootRequired && !container.querySelector('#pv-reboot')) {
        const rb = document.createElement('div');
        rb.id = 'pv-reboot'; rb.className = 'insight-card warning'; rb.style.cssText = 'justify-content:space-between;margin-bottom:12px';
        rb.innerHTML = '<span>Updates need a reboot to take effect.</span><button class="btn btn-sm btn-secondary">Reboot server…</button>';
        rb.querySelector('button').addEventListener('click', () => showConfirm('Reboot server', 'The server restarts now and is unreachable for a minute or two.', async () => {
          try { await API.post(`/servers/${serverId}/reboot`, { confirm: true }); showToast('Reboot started', 'info', 6000); } catch (e) { showToast(e.message, 'error', 8000); }
        }, true));
        stepsEl.parentNode.insertBefore(rb, stepsEl);
      }
      const ok = (job.items || []).filter(i => ['verified', 'present', 'installed'].includes(i.state)).length;
      const failed = (job.items || []).filter(i => i.state === 'failed').length;
      titleEl.textContent = `Setup ${job.status} — ${ok} ok, ${failed} failed`;
      showToast(`Setup ${job.status}: ${ok} ok, ${failed} failed`, failed ? 'warning' : 'success', 8000);
    } else {
      titleEl.textContent = `Setting up ${serverId}… (${(job.items || []).length} done)`;
    }
  };
  poll();
  timer = setInterval(poll, 1500);
}
