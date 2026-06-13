// Provisioning panel + overview — render INTO a container (the per-server console's tabs), not a modal.
// On open they LIVE-SCAN the server (read-only detect) so you see what's installed before acting.
// Globals: renderProvisionPanel(serverId, container) · renderProvisionOverview(serverId, container, onSetup).
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
  const missingCount = items.filter(it => stateOf(it.id) === 'missing').length;

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

  const itemRows = items.map(it => {
    const st = stateOf(it.id);
    const pill = st === 'present' ? '<span class="badge" style="background:rgba(34,197,94,.15);color:var(--success)">installed</span>'
      : st === 'na' ? '<span class="badge" style="opacity:.55">n/a</span>'
      : '<span class="badge" style="background:var(--bg-primary);color:var(--text-muted)">missing</span>';
    return `<label style="display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;${st === 'na' ? 'opacity:.5' : ''}">
      <input type="checkbox" class="pv-item" value="${escapeHtml(it.id)}" data-risk="${escapeHtml(it.risk)}"${st === 'na' ? ' disabled' : ''}>
      <div style="flex:1"><span style="font-weight:500">${escapeHtml(it.label)}</span>${it.risk === 'high' ? ' <span style="color:var(--danger);font-size:11px">⚠ risky</span>' : ''}</div>
      ${pill}
    </label>`;
  }).join('');

  const explainer = items.map(it => `
    <details style="margin-bottom:6px"><summary>${escapeHtml(it.label)} <span class="text-xs text-muted">[${escapeHtml(it.group)}${it.risk === 'high' ? ' · risky' : ''}]</span></summary>
      <div class="text-xs text-muted" style="padding:6px 0 0 12px">${escapeHtml(it.description)}</div>
      ${it.commands ? `<pre style="white-space:pre-wrap;padding:6px 12px;background:var(--bg-primary);border-radius:6px;margin-top:4px;font-size:11px">detect:  ${escapeHtml(it.commands.detect)}\ninstall: ${escapeHtml(it.commands.install)}\nverify:  ${escapeHtml(it.commands.verify)}</pre>` : ''}
    </details>`).join('');

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

      <div id="pv-custom" class="card" style="display:none">
        <div style="font-weight:600;margin-bottom:6px">Items <span class="text-xs text-muted">(✓ installed · ○ missing · ⊘ n/a)</span></div>
        ${itemRows}
      </div>

      <div id="pv-confirm-wrap" class="card" style="display:none;border-color:var(--danger);background:rgba(248,81,73,.06)">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="pv-confirm" style="margin-top:3px">
          <div><div style="font-weight:600;color:var(--danger)">⚠ Risky steps selected</div><div class="text-xs text-muted">Firewall / SSH hardening can lock you out if misconfigured. I understand and want to proceed.</div></div>
        </label>
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary" id="pv-run">▶ Run provisioning</button>
        <span class="text-xs text-muted">Runs in the background — safe to navigate away.</span>
      </div>

      <details class="card"><summary style="font-weight:600;cursor:pointer">How it works — detect / install / verify per item</summary><div style="padding-top:10px">${explainer}</div></details>
    </div>`;

  function update() {
    const preset = container.querySelector('input[name="pv-preset"]:checked')?.value;
    container.querySelectorAll('.pv-preset-card').forEach(card => {
      const on = card.dataset.preset === preset;
      card.style.borderColor = on ? 'var(--accent, #00d4aa)' : 'var(--border)';
      card.style.background = on ? 'rgba(0,212,170,.07)' : 'transparent';
    });
    container.querySelector('#pv-custom').style.display = preset === 'custom' ? 'block' : 'none';
    const risky = preset === 'custom'
      ? [...container.querySelectorAll('.pv-item:checked')].some(c => c.dataset.risk === 'high')
      : (preset === 'secure-baseline' || preset === 'full');
    container.querySelector('#pv-confirm-wrap').style.display = risky ? 'block' : 'none';
  }
  container.querySelectorAll('input[name="pv-preset"]').forEach(r => r.addEventListener('change', update));
  container.querySelector('#pv-custom').addEventListener('change', update);
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

// ---------- Overview tab — card-based "where does this server stand" ----------
async function renderProvisionOverview(serverId, container, onSetup) {
  container.innerHTML = `
    <div class="text-sm text-muted">🔍 Scanning <b>${escapeHtml(serverId)}</b> over SSH…</div>
    <div class="skeleton" style="height:18px;width:55%;margin-top:10px"></div>
    <div class="skeleton" style="height:18px;width:40%;margin-top:6px"></div>`;
  let catalog, scan;
  try {
    [catalog, scan] = await Promise.all([API.get('/servers/provision/catalog'), API.get(`/servers/${serverId}/provision/scan`)]);
  } catch (e) {
    container.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div class="text-danger" style="font-weight:600">Scan failed</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><button class="btn btn-secondary btn-sm" id="ov-retry" style="margin-top:10px">Retry scan</button></div>`;
    container.querySelector('#ov-retry')?.addEventListener('click', () => renderProvisionOverview(serverId, container, onSetup));
    return;
  }

  const stateOf = PV_STATE(scan.items);
  const items = catalog.items || [];
  const installed = items.filter(it => stateOf(it.id) === 'present').length;
  const missing = items.filter(it => stateOf(it.id) === 'missing').length;
  const naCount = items.filter(it => stateOf(it.id) === 'na').length;
  const ready = stateOf('docker') === 'present';

  const meta = {
    present: { ic: '✓', col: 'var(--success)', txt: 'installed' },
    missing: { ic: '○', col: 'var(--text-muted)', txt: 'missing' },
    na:      { ic: '⊘', col: 'var(--text-muted)', txt: 'n/a on this OS' },
    unknown: { ic: '?', col: 'var(--text-muted)', txt: 'unknown' },
  };
  const cardFor = (it) => {
    const st = stateOf(it.id), c = meta[st];
    return `<div class="card" style="border-left:3px solid ${c.col};opacity:${st === 'na' ? 0.55 : 1}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="font-weight:600">${escapeHtml(it.label)}</div>
        <div style="color:${c.col};font-size:18px;line-height:1">${c.ic}</div>
      </div>
      <div class="text-xs text-muted" style="margin-top:3px">${c.txt}${it.risk === 'high' ? ' · ⚠ risky' : ''}</div>
    </div>`;
  };
  const groups = [['base', 'Base'], ['security', 'Security'], ['system', 'System']];

  // KPI tiles — same summary-card markup as the main Dashboard.
  const ovKpi = (icon, color, value, label) => `
    <div class="summary-card"><div class="summary-card-icon ${color}"><span class="nav-item-icon">${icon}</span></div>
      <div class="summary-card-content"><div class="summary-card-value">${value}</div><div class="summary-card-label">${label}</div></div></div>`;

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="summary-grid" style="margin-bottom:0">
        ${ovKpi(Icons.success, 'green', installed, 'Installed')}
        ${ovKpi(Icons.warning, missing ? 'yellow' : 'green', missing, 'Missing')}
        ${naCount ? ovKpi(Icons.info, 'blue', naCount, 'N/A on this OS') : ''}
        ${ovKpi(Icons.container, ready ? 'green' : 'red', ready ? 'Ready' : 'No', 'Docker Engine')}
      </div>
      <div class="card" style="border-left:4px solid ${ready ? 'var(--success)' : 'var(--warning, #f59e0b)'}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <div>
            <div style="font-size:17px;font-weight:700">${ready ? '✓ Ready' : '⚠ Needs setup'}</div>
            <div class="text-sm text-muted">${scan.distro ? 'OS: ' + escapeHtml(scan.distro) + ' · ' : ''}${installed} installed · ${missing} missing${naCount ? ` · ${naCount} n/a` : ''}</div>
          </div>
          ${missing ? `<button class="btn btn-primary btn-sm" id="ov-setup">Set up ${missing} missing →</button>` : ''}
        </div>
      </div>
      ${groups.map(([g, glabel]) => {
        const gItems = items.filter(it => it.group === g);
        if (!gItems.length) return '';
        return `<div><div style="font-weight:600;margin-bottom:8px">${glabel}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px">${gItems.map(cardFor).join('')}</div></div>`;
      }).join('')}
      <div class="text-xs text-muted">Scanned live over SSH (read-only). Use the <b>Setup</b> tab to install the missing items.</div>
    </div>`;
  container.querySelector('#ov-setup')?.addEventListener('click', () => { if (typeof onSetup === 'function') onSetup(); });
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
