// Provisioning panel + overview — render INTO a container (the per-server console's tabs), not a modal.
// On open they LIVE-SCAN the server (read-only detect) so you see what's installed before acting.
// Globals: renderProvisionPanel(serverId, container) · renderConsoleOverview(serverId, container, onSetup).
const PV_ICON = { verified: '✓', installed: '✓', present: '✓', failed: '✗', skipped: '⊘', unknown: '○' };
const PV_STATE = (scanItems) => {
  const present = {};
  for (const it of (scanItems || [])) present[it.id] = it;
  return (id) => { const s = present[id]; return s ? (s.na ? 'na' : (s.present ? 'present' : 'missing')) : 'unknown'; };
};

// ---------- Setup tab ----------
async function renderProvisionPanel(serverId, container) {
  container.innerHTML = `
    <div class="text-sm text-muted">🔍 Scanning <b>${escapeHtml(serverId)}</b> over SSH — checking what's already installed…</div>
    <div class="skeleton" style="height:16px;width:60%;margin-top:10px"></div>
    <div class="skeleton" style="height:16px;width:45%;margin-top:6px"></div>`;
  let catalog, scan;
  try {
    [catalog, scan] = await Promise.all([API.get('/servers/provision/catalog'), API.get(`/servers/${serverId}/provision/scan`)]);
  } catch (e) {
    container.innerHTML =
      `<div class="card" style="border-left:3px solid var(--danger)"><div class="text-danger" style="font-weight:600">Scan failed</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><div class="text-xs text-muted" style="margin-top:6px">The server may be unreachable, or it uses password auth the scan couldn't use. Fix the connection (Test) then retry.</div><button class="btn btn-secondary btn-sm" id="pv-retry" style="margin-top:10px">Retry scan</button></div>`;
    container.querySelector('#pv-retry')?.addEventListener('click', () => renderProvisionPanel(serverId, container));
    return;
  }
  renderProvisionForm(serverId, catalog, scan, container);
}

function renderProvisionForm(serverId, catalog, scan, container) {
  const stateOf = PV_STATE(scan.items);
  const items = catalog.items || [];
  const missingCount = items.filter(it => !it.alwaysRun && !it.optional && stateOf(it.id) === 'missing').length;

  const presets = [
    ['just-docker', 'Just Docker', '🐳', 'Docker Engine + compose plugin'],
    ['secure-baseline', 'Secure baseline', '🛡', 'update · firewall · SSH hardening · fail2ban · Docker'],
    ['full', 'Full', '🏭', 'Everything — also swap, time sync, auto-updates'],
    ['custom', 'Custom', '⚙️', 'Pick individual items'],
  ];
  const presetCards = presets.map(([v, label, emoji, desc], i) => `
    <label class="pv-preset-card" data-preset="${v}" style="display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;cursor:pointer;transition:border-color .15s,background .15s">
      <input type="radio" name="pv-preset" value="${v}"${i === 1 ? ' checked' : ''} style="display:none">
      <div style="font-size:22px;line-height:1">${emoji}</div>
      <div><div style="font-weight:600">${escapeHtml(label)}</div><div class="text-xs text-muted" style="margin-top:2px">${escapeHtml(desc)}</div></div>
    </label>`).join('');

  // On-card status: border colour + a pill, matching the Overview component cards.
  const pvState = {
    present: { col: 'var(--success)', pill: '<span class="badge badge-healthy">installed</span>' },
    missing: { col: 'var(--warning, #f59e0b)', pill: '<span class="badge" style="background:var(--bg-primary);color:var(--text-muted)">missing</span>' },
    action:  { col: 'var(--info)', pill: '<span class="badge" style="background:var(--info-bg);color:var(--info)">runs every time</span>' },
    optional:{ col: 'var(--text-muted)', pill: '<span class="badge" style="opacity:.6">optional</span>' },
    na:      { col: 'var(--text-muted)', pill: '<span class="badge" style="opacity:.55">n/a</span>' },
    unknown: { col: 'var(--text-muted)', pill: '<span class="badge" style="opacity:.55">unknown</span>' },
  };
  const itemCard = (it) => {
    const st = it.alwaysRun ? 'action' : (it.optional && stateOf(it.id) === 'missing' ? 'optional' : stateOf(it.id)), m = pvState[st] || pvState.unknown;
    return `<label class="card pv-item-card" style="display:flex;gap:10px;align-items:flex-start;border-left:3px solid ${m.col};padding:12px 14px;opacity:${st === 'na' ? 0.55 : 1};transition:background .12s,box-shadow .12s">
      <input type="checkbox" class="pv-item" value="${escapeHtml(it.id)}" data-risk="${escapeHtml(it.risk)}"${st === 'na' ? ' data-na="1"' : ''} style="margin-top:3px;accent-color:var(--accent);width:16px;height:16px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span style="font-weight:600">${escapeHtml(it.label)}</span>
          <span style="display:flex;align-items:center;gap:6px">
            <span class="pv-sel-badge badge" style="display:none;background:var(--accent);color:var(--text-inverse)">✓ selected</span>
            ${m.pill}
          </span>
        </div>
        ${it.description ? `<div class="text-xs text-muted" style="margin-top:3px">${escapeHtml(it.description)}</div>` : ''}
        ${it.risk === 'high' ? '<div class="text-xs" style="color:var(--danger);margin-top:3px">⚠ risky — can lock you out if misconfigured</div>' : ''}
      </div>
    </label>`;
  };
  const groupLabel = (g) => ({ base: 'Base', security: 'Security', system: 'System' }[g] || (g ? g[0].toUpperCase() + g.slice(1) : 'Other'));
  const ord = ['base', 'security', 'system'];
  const groupKeys = [...new Set(items.map(it => it.group))].sort((a, b) => (ord.indexOf(a) < 0 ? 99 : ord.indexOf(a)) - (ord.indexOf(b) < 0 ? 99 : ord.indexOf(b)));
  const itemCardsGrouped = groupKeys.map(g => {
    const gItems = items.filter(it => it.group === g);
    if (!gItems.length) return '';
    return `<div style="margin-bottom:14px"><div style="font-weight:600;margin-bottom:8px">${groupLabel(g)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">${gItems.map(itemCard).join('')}</div></div>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card">
        <div style="font-weight:700;font-size:15px">Set up ${escapeHtml(serverId)}</div>
        <div class="text-xs text-muted" style="margin-top:2px">${scan.distro ? 'OS ' + escapeHtml(scan.distro) + ' · ' : ''}${missingCount} missing · detect → install → verify over SSH (present items are skipped)</div>
      </div>

      <div>
        <div style="font-weight:600;margin-bottom:8px">1 · Choose a preset</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">${presetCards}</div>
      </div>

      <div id="pv-items">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
          <div style="font-weight:600">2 · Components on this server</div>
          <div class="text-xs text-muted" id="pv-custom-hint">Switch to <b>Custom</b> to tick individual items</div>
        </div>
        ${itemCardsGrouped}
      </div>

      <div id="pv-confirm-wrap" class="card" style="display:none;border-color:var(--danger);background:rgba(248,81,73,.06)">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="pv-confirm" style="margin-top:3px">
          <div><div style="font-weight:600;color:var(--danger)">⚠ Risky steps selected</div><div class="text-xs text-muted">Firewall / SSH hardening can lock you out if misconfigured. I understand and want to proceed.</div></div>
        </label>
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary" id="pv-run">▶ Run provisioning</button>
        <span class="text-xs text-muted">Runs in the background — safe to navigate away. Each item is detected first and skipped if already present.</span>
      </div>
    </div>`;

  function update() {
    const preset = container.querySelector('input[name="pv-preset"]:checked')?.value;
    container.querySelectorAll('.pv-preset-card').forEach(card => {
      const on = card.dataset.preset === preset;
      card.style.borderColor = on ? 'var(--accent, #00d4aa)' : 'var(--border)';
      card.style.background = on ? 'rgba(0,212,170,.07)' : 'transparent';
    });
    const custom = preset === 'custom';
    const presetIds = custom ? null : (catalog.presets[preset] || []);
    // Non-custom: TICK exactly the items this preset installs (read-only) so you SEE the selection.
    // Custom: checkboxes are editable; keep whatever is ticked (a sensible start when switching presets).
    container.querySelectorAll('.pv-item').forEach(cb => {
      const na = cb.dataset.na === '1';
      if (custom) { cb.disabled = na; }
      else { cb.checked = !na && presetIds.includes(cb.value); cb.disabled = true; }
      const sel = cb.checked;
      const card = cb.closest('.pv-item-card');
      const badge = card && card.querySelector('.pv-sel-badge');
      // Native checkbox is the control in Custom; under a preset it's read-only → hide it and make the
      // selection unmistakable with an accent ring + tint + a "✓ selected" badge.
      cb.style.display = custom ? '' : 'none';
      if (badge) badge.style.display = (!custom && sel) ? '' : 'none';
      if (card) {
        card.style.boxShadow = sel ? 'inset 0 0 0 1.5px var(--accent)' : 'none';
        card.style.background = sel ? 'var(--accent-dim)' : '';
      }
    });
    const hint = container.querySelector('#pv-custom-hint');
    if (hint) hint.textContent = custom
      ? 'Tick the items you want to install'
      : 'These items will be installed by this preset — switch to Custom to change';
    // Risky = any TICKED high-risk item (works for both modes, since the preset's items are ticked above).
    const risky = [...container.querySelectorAll('.pv-item:checked')].some(c => c.dataset.risk === 'high');
    container.querySelector('#pv-confirm-wrap').style.display = risky ? 'block' : 'none';
  }
  container.querySelectorAll('input[name="pv-preset"]').forEach(r => r.addEventListener('change', update));
  container.querySelector('#pv-items').addEventListener('change', update);
  update();

  container.querySelector('#pv-run').addEventListener('click', async () => {
    const runBtn = container.querySelector('#pv-run');
    const preset = container.querySelector('input[name="pv-preset"]:checked')?.value || 'secure-baseline';
    const only = preset === 'custom' ? [...container.querySelectorAll('.pv-item:checked')].map(c => c.value) : undefined;
    const confirm = !!container.querySelector('#pv-confirm')?.checked;
    if (preset === 'custom' && (!only || !only.length)) { showToast('Pick at least one item', 'warning'); return; }
    runBtn.disabled = true; runBtn.textContent = 'Starting…';
    try {
      const r = await API.post(`/servers/${serverId}/provision`, { preset, only, confirm });
      streamProvisionJob(serverId, r.jobId, container);
    } catch (e) {
      runBtn.disabled = false; runBtn.textContent = '▶ Run provisioning';
      if (/confirm/i.test(e.message || '')) { container.querySelector('#pv-confirm-wrap').style.display = 'block'; showToast('Tick the risky-steps confirmation first', 'warning', 6000); }
      else showToast(e.message, 'error', 8000);
    }
  });
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
  const missing = items.filter(it => !it.alwaysRun && !it.optional && stateOf(it.id) === 'missing').length;
  const naCount = items.filter(it => stateOf(it.id) === 'na').length;
  const ready = stateOf('docker') === 'present';

  const meta = {
    present: { ic: '✓', col: 'var(--success)', txt: 'installed' },
    missing: { ic: '○', col: 'var(--text-muted)', txt: 'missing' },
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

// ---------- Run progress — step cards (primary) + collapsible log (secondary, not a raw terminal) ----------
function streamProvisionJob(serverId, jobId, container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div><div style="font-weight:700" id="pv-title">Provisioning ${escapeHtml(serverId)}…</div>
          <div class="text-xs text-muted">Runs on the server even if you leave this page.</div></div>
        <button class="btn btn-secondary btn-sm" id="pv-rescan" style="display:none">↻ Re-scan</button>
      </div>
      <div id="pv-steps" style="display:flex;flex-direction:column;gap:8px"></div>
      <details class="card"><summary class="text-sm" style="cursor:pointer;font-weight:600">Show full log</summary>
        <pre id="pv-log" style="white-space:pre-wrap;background:var(--bg-primary);border:1px solid var(--border);color:var(--text-secondary);padding:10px;border-radius:8px;max-height:38vh;overflow:auto;font-size:12px;margin-top:8px"></pre>
      </details>
    </div>`;
  const logEl = container.querySelector('#pv-log');
  const stepsEl = container.querySelector('#pv-steps');
  const titleEl = container.querySelector('#pv-title');
  const rescan = container.querySelector('#pv-rescan');
  rescan.addEventListener('click', () => renderProvisionPanel(serverId, container));

  const sm = {
    verified: { ic: '✓', c: 'var(--success)' }, present: { ic: '✓', c: 'var(--success)' }, installed: { ic: '✓', c: 'var(--success)' },
    failed: { ic: '✗', c: 'var(--danger)' }, skipped: { ic: '⊘', c: 'var(--text-muted)' },
  };
  const stepCard = (label, state, running) => {
    const m = sm[state] || { ic: running ? '⟳' : '○', c: 'var(--text-muted)' };
    return `<div class="card" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-left:3px solid ${m.c}">
      <div style="color:${m.c};font-size:16px;width:18px;text-align:center">${m.ic}</div>
      <div style="flex:1;font-weight:500">${escapeHtml(label)}</div>
      <div class="text-xs text-muted">${running ? 'running…' : (state || '')}</div></div>`;
  };

  let timer = null;
  const poll = async () => {
    if (!document.body.contains(stepsEl)) { clearInterval(timer); return; }
    let job;
    try { job = await API.get(`/servers/provision/job/${jobId}`); }
    catch (e) { clearInterval(timer); if (document.body.contains(stepsEl)) { titleEl.textContent = 'Job finished — see Run history'; rescan.style.display = ''; } return; }
    logEl.textContent = job.log || '';
    logEl.scrollTop = logEl.scrollHeight;
    const done = (job.items || []).filter(i => ['verified', 'present', 'failed', 'skipped'].includes(i.state)).length;
    const rows = (job.items || []).map(i => stepCard(i.label || i.id, i.state, false));
    // a "running" row for the item currently in progress (job.phase) if it isn't a completed item yet
    if (job.status === 'running' && job.phase && !(job.items || []).some(i => i.id === job.phase)) {
      rows.push(stepCard(job.phase, null, true));
    }
    stepsEl.innerHTML = rows.join('');
    if (job.status && job.status !== 'running') {
      clearInterval(timer);
      rescan.style.display = '';
      const ok = (job.items || []).filter(i => ['verified', 'present'].includes(i.state)).length;
      const failed = (job.items || []).filter(i => i.state === 'failed').length;
      titleEl.textContent = `${failed ? '⚠' : '✓'} Provisioning ${job.status} — ${ok} ok, ${failed} failed`;
      showToast(`Provisioning ${job.status}: ${ok} ok, ${failed} failed`, failed ? 'warning' : 'success', 8000);
    } else {
      titleEl.textContent = `Provisioning ${escapeHtml(serverId)}… (${done} done)`;
    }
  };
  poll();
  timer = setInterval(poll, 1500);
}
