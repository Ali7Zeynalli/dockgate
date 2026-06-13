// Provisioning panel — renders INTO a container (the per-server console's Setup tab), not a modal.
// On open it LIVE-SCANS the server (read-only detect of every catalog item) so you see what's already
// installed before choosing what to run. Global: renderProvisionPanel(serverId, container).
const PV_ICON = { verified: '✓', installed: '✓', present: '✓', failed: '✗', skipped: '⏭', unknown: '○' };

async function renderProvisionPanel(serverId, container) {
  container.innerHTML = `
    <div class="text-sm text-muted">🔍 Scanning <b>${escapeHtml(serverId)}</b> over SSH — checking what's already installed…</div>
    <div class="skeleton" style="height:16px;width:60%;margin-top:10px"></div>
    <div class="skeleton" style="height:16px;width:45%;margin-top:6px"></div>`;
  let catalog, scan;
  try {
    [catalog, scan] = await Promise.all([
      API.get('/servers/provision/catalog'),
      API.get(`/servers/${serverId}/provision/scan`),
    ]);
  } catch (e) {
    container.innerHTML =
      `<div class="text-danger text-sm">Scan failed: ${escapeHtml(e.message)}</div>
       <div class="text-xs text-muted" style="margin-top:6px">The server may be unreachable, or it uses password auth the scan couldn't use. Fix the connection (Test) then retry.</div>
       <button class="btn btn-secondary btn-sm" id="pv-retry" style="margin-top:10px">Retry scan</button>`;
    container.querySelector('#pv-retry')?.addEventListener('click', () => renderProvisionPanel(serverId, container));
    return;
  }
  renderProvisionForm(serverId, catalog, scan, container);
}

function renderProvisionForm(serverId, catalog, scan, container) {
  const present = {};
  for (const it of (scan.items || [])) present[it.id] = it;
  const stateOf = (id) => { const s = present[id]; return s ? (s.na ? 'na' : (s.present ? 'present' : 'missing')) : 'unknown'; };
  const icon = (st) => ({ present: '✓', missing: '○', na: '⊘', unknown: '○' }[st] || '○');
  const missingCount = (catalog.items || []).filter(it => stateOf(it.id) === 'missing').length;

  const presets = [
    ['just-docker', 'Just Docker', 'Docker Engine + compose plugin only'],
    ['secure-baseline', 'Secure baseline', 'update + firewall + SSH hardening + fail2ban + Docker'],
    ['full', 'Full', 'Everything (also swap, time sync, auto-updates)'],
    ['custom', 'Custom', 'Pick individual items below'],
  ];
  const presetHtml = presets.map(([v, label, desc], i) => `
    <label style="display:flex;gap:8px;align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:8px;cursor:pointer">
      <input type="radio" name="pv-preset" value="${v}"${i === 1 ? ' checked' : ''} style="margin-top:3px">
      <div><div style="font-weight:600">${escapeHtml(label)}</div><div class="text-xs text-muted">${escapeHtml(desc)}</div></div>
    </label>`).join('');

  const itemHtml = (catalog.items || []).map(it => {
    const st = stateOf(it.id);
    const risk = it.risk === 'high' ? ' <span class="text-xs" style="color:var(--danger)">⚠ risky</span>' : '';
    const dis = st === 'na' ? ' disabled' : '';
    return `<label style="display:flex;gap:8px;align-items:center;padding:3px 0;${st === 'na' ? 'opacity:.5' : ''}">
      <input type="checkbox" class="pv-item" value="${escapeHtml(it.id)}" data-risk="${escapeHtml(it.risk)}"${dis}>
      <span>${icon(st)} ${escapeHtml(it.label)}${risk} <span class="text-xs text-muted">${st === 'present' ? 'installed' : st === 'na' ? 'n/a on this OS' : st === 'missing' ? 'missing' : ''}</span></span>
    </label>`;
  }).join('');

  const explainer = (catalog.items || []).map(it => `
    <details style="margin-bottom:6px"><summary>${escapeHtml(it.label)} <span class="text-xs text-muted">[${escapeHtml(it.group)}${it.risk === 'high' ? ' · risky' : ''}]</span></summary>
      <div class="text-xs text-muted" style="padding:6px 0 0 12px">${escapeHtml(it.description)}</div>
      ${it.commands ? `<pre style="white-space:pre-wrap;padding:6px 12px;background:var(--bg-primary);border-radius:6px;margin-top:4px;font-size:11px">detect:  ${escapeHtml(it.commands.detect)}\ninstall: ${escapeHtml(it.commands.install)}\nverify:  ${escapeHtml(it.commands.verify)}</pre>` : ''}
    </details>`).join('');

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;max-width:760px">
      <div class="text-sm">Scanned <b>${escapeHtml(serverId)}</b>${scan.distro ? ` · OS <b>${escapeHtml(scan.distro)}</b>` : ''} — <b>${missingCount}</b> item(s) missing. detect → install → verify runs over SSH; already-present items are skipped.</div>
      <div class="settings-section">
        <div class="settings-section-title">Preset</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">${presetHtml}</div>
        <div id="pv-custom" style="display:none;margin-top:10px"><div style="font-weight:600;margin-bottom:4px">Items <span class="text-xs text-muted">(✓ installed · ○ missing · ⊘ n/a)</span></div>${itemHtml}</div>
        <label id="pv-confirm-wrap" style="display:none;gap:8px;align-items:center;color:var(--danger);margin-top:10px">
          <input type="checkbox" id="pv-confirm"> I understand the risky steps (firewall / SSH hardening) and want to proceed
        </label>
        <div style="margin-top:14px"><button class="btn btn-primary" id="pv-run">Run provisioning</button></div>
      </div>
      <details class="settings-section"><summary style="font-weight:600;cursor:pointer">Server status (live)</summary>
        <div style="padding-top:8px">${(catalog.items || []).map(it => { const st = stateOf(it.id); return `<div class="text-sm">${icon(st)} ${escapeHtml(it.label)} <span class="text-xs text-muted">${st}</span></div>`; }).join('')}</div>
      </details>
      <details class="settings-section"><summary style="font-weight:600;cursor:pointer">How it works</summary><div style="padding-top:8px">${explainer}</div></details>
    </div>`;

  function update() {
    const preset = container.querySelector('input[name="pv-preset"]:checked')?.value;
    container.querySelector('#pv-custom').style.display = preset === 'custom' ? 'block' : 'none';
    let risky;
    if (preset === 'custom') risky = [...container.querySelectorAll('.pv-item:checked')].some(c => c.dataset.risk === 'high');
    else risky = (preset === 'secure-baseline' || preset === 'full');
    container.querySelector('#pv-confirm-wrap').style.display = risky ? 'flex' : 'none';
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
      runBtn.disabled = false; runBtn.textContent = 'Run provisioning';
      if (/confirm/i.test(e.message || '')) { container.querySelector('#pv-confirm-wrap').style.display = 'flex'; showToast('Tick the risky-steps confirmation first', 'warning', 6000); }
      else showToast(e.message, 'error', 8000);
    }
  });
}

// Overview — a card-based "where does this server stand" dashboard built from the live scan.
// Shows, per item, what's installed / missing / n-a, grouped, so you can see the state at a glance.
// onSetup() is called by the "Set up missing" button (the console switches to the Setup tab).
async function renderProvisionOverview(serverId, container, onSetup) {
  container.innerHTML = `
    <div class="text-sm text-muted">🔍 Scanning <b>${escapeHtml(serverId)}</b> over SSH…</div>
    <div class="skeleton" style="height:18px;width:55%;margin-top:10px"></div>
    <div class="skeleton" style="height:18px;width:40%;margin-top:6px"></div>`;
  let catalog, scan;
  try {
    [catalog, scan] = await Promise.all([
      API.get('/servers/provision/catalog'),
      API.get(`/servers/${serverId}/provision/scan`),
    ]);
  } catch (e) {
    container.innerHTML = `<div class="text-danger text-sm">Scan failed: ${escapeHtml(e.message)}</div>
      <button class="btn btn-secondary btn-sm" id="ov-retry" style="margin-top:10px">Retry scan</button>`;
    container.querySelector('#ov-retry')?.addEventListener('click', () => renderProvisionOverview(serverId, container, onSetup));
    return;
  }

  const present = {};
  for (const it of (scan.items || [])) present[it.id] = it;
  const stateOf = (id) => { const s = present[id]; return s ? (s.na ? 'na' : (s.present ? 'present' : 'missing')) : 'unknown'; };
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

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;max-width:900px">
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

// Live log + per-item status; polls the job (keeps running server-side if you navigate away).
function streamProvisionJob(serverId, jobId, container) {
  container.innerHTML = `
    <div style="max-width:760px">
      <div class="text-sm">Provisioning <b>${escapeHtml(serverId)}</b>… (keeps running on the server even if you leave this page)</div>
      <div id="pv-steps" style="margin:8px 0;line-height:1.9"></div>
      <pre id="pv-log" style="white-space:pre-wrap;background:#0d1117;color:#c9d1d9;padding:10px;border-radius:8px;max-height:45vh;overflow:auto;font-size:12px"></pre>
      <button class="btn btn-secondary btn-sm" id="pv-rescan" style="margin-top:10px;display:none">↻ Re-scan</button>
    </div>`;
  const logEl = container.querySelector('#pv-log');
  const stepsEl = container.querySelector('#pv-steps');
  const rescan = container.querySelector('#pv-rescan');
  rescan.addEventListener('click', () => renderProvisionPanel(serverId, container));
  let timer = null;
  const poll = async () => {
    if (!document.body.contains(logEl)) { clearInterval(timer); return; }
    let job;
    try { job = await API.get(`/servers/provision/job/${jobId}`); }
    catch (e) { clearInterval(timer); if (document.body.contains(logEl)) { logEl.textContent += '\n(job finished — see Run history)'; rescan.style.display = ''; } return; }
    logEl.textContent = job.log || '';
    logEl.scrollTop = logEl.scrollHeight;
    stepsEl.innerHTML = (job.items || []).map(i => {
      const col = i.state === 'failed' ? 'var(--danger)' : (['verified', 'present'].includes(i.state) ? 'var(--success)' : 'var(--text-muted)');
      return `<span style="color:${col};margin-right:12px;white-space:nowrap">${PV_ICON[i.state] || '•'} ${escapeHtml(i.label || i.id)}</span>`;
    }).join('');
    if (job.status && job.status !== 'running') {
      clearInterval(timer);
      rescan.style.display = '';
      const ok = (job.items || []).filter(i => ['verified', 'present'].includes(i.state)).length;
      const failed = (job.items || []).filter(i => i.state === 'failed').length;
      showToast(`Provisioning ${job.status}: ${ok} ok, ${failed} failed`, failed ? 'warning' : 'success', 8000);
    }
  };
  poll();
  timer = setInterval(poll, 1500);
}
