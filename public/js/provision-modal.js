// Provisioning modal — set up a remote server (Docker, firewall, fail2ban, ...) over SSH.
// On open it LIVE-SCANS the server (read-only detect of every catalog item) so you see what's already
// installed before choosing what to run. Opened from the Setup button on a server row. Global: openProvisionModal(id).
const PV_ICON = { verified: '✓', installed: '✓', present: '✓', failed: '✗', skipped: '⏭', unknown: '○' };

async function openProvisionModal(serverId) {
  const m = showModal(`Provision: ${escapeHtml(serverId)}`,
    `<div id="pv-body" style="display:flex;flex-direction:column;gap:10px;max-height:65vh;overflow:auto">
       <div class="text-sm text-muted">🔍 Scanning <b>${escapeHtml(serverId)}</b> over SSH — checking what's already installed…</div>
       <div class="skeleton" style="height:16px;width:60%"></div>
       <div class="skeleton" style="height:16px;width:45%"></div>
     </div>`, []);
  const root = m.overlay;

  let catalog, scan;
  try {
    [catalog, scan] = await Promise.all([
      API.get('/servers/provision/catalog'),
      API.get(`/servers/${serverId}/provision/scan`),
    ]);
  } catch (e) {
    root.querySelector('#pv-body').innerHTML =
      `<div class="text-danger text-sm">Scan failed: ${escapeHtml(e.message)}</div>
       <div class="text-xs text-muted" style="margin-top:6px">The server may be unreachable, or it's using password auth that the scan couldn't use. Fix the connection (Test) and reopen Setup.</div>`;
    return;
  }
  renderProvisionForm(serverId, catalog, scan, root, m);
}

function renderProvisionForm(serverId, catalog, scan, root, modal) {
  const present = {}; // id -> {present, na}
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
    <label style="display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--border);border-radius:8px;cursor:pointer;margin-bottom:6px">
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

  root.querySelector('#pv-body').innerHTML = `
    <div class="text-sm">Scanned <b>${escapeHtml(serverId)}</b>${scan.distro ? ` · OS: <b>${escapeHtml(scan.distro)}</b>` : ''} — <b>${missingCount}</b> item(s) missing. detect → install → verify runs over SSH; already-present items are skipped.</div>
    <div><div style="font-weight:600;margin-bottom:6px">Preset</div>${presetHtml}</div>
    <div id="pv-custom" style="display:none"><div style="font-weight:600;margin-bottom:4px">Items <span class="text-xs text-muted">(✓ installed · ○ missing · ⊘ n/a)</span></div>${itemHtml}</div>
    <label id="pv-confirm-wrap" style="display:none;gap:8px;align-items:center;color:var(--danger)">
      <input type="checkbox" id="pv-confirm"> I understand the risky steps (firewall / SSH hardening) and want to proceed
    </label>
    <details><summary style="font-weight:600">Server status (live)</summary>
      <div style="padding-top:6px">${(catalog.items || []).map(it => { const st = stateOf(it.id); return `<div class="text-sm">${icon(st)} ${escapeHtml(it.label)} <span class="text-xs text-muted">${st}</span></div>`; }).join('')}</div>
    </details>
    <details><summary style="font-weight:600">How it works</summary><div style="padding-top:6px">${explainer}</div></details>`;

  function update() {
    const preset = root.querySelector('input[name="pv-preset"]:checked')?.value;
    root.querySelector('#pv-custom').style.display = preset === 'custom' ? 'block' : 'none';
    let risky;
    if (preset === 'custom') risky = [...root.querySelectorAll('.pv-item:checked')].some(c => c.dataset.risk === 'high');
    else risky = (preset === 'secure-baseline' || preset === 'full');
    root.querySelector('#pv-confirm-wrap').style.display = risky ? 'flex' : 'none';
  }
  root.querySelectorAll('input[name="pv-preset"]').forEach(r => r.addEventListener('change', update));
  root.querySelector('#pv-custom').addEventListener('change', update);
  update();

  const footer = root.querySelector('#modal-footer');
  footer.innerHTML = '';
  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-primary';
  runBtn.textContent = 'Run provisioning';
  footer.appendChild(runBtn);

  runBtn.addEventListener('click', async () => {
    const preset = root.querySelector('input[name="pv-preset"]:checked')?.value || 'secure-baseline';
    const only = preset === 'custom' ? [...root.querySelectorAll('.pv-item:checked')].map(c => c.value) : undefined;
    const confirm = !!root.querySelector('#pv-confirm')?.checked;
    if (preset === 'custom' && (!only || !only.length)) { showToast('Pick at least one item', 'warning'); return; }
    runBtn.disabled = true; runBtn.textContent = 'Starting…';
    try {
      const r = await API.post(`/servers/${serverId}/provision`, { preset, only, confirm });
      streamProvisionJob(serverId, r.jobId, root);
    } catch (e) {
      runBtn.disabled = false; runBtn.textContent = 'Run provisioning';
      if (/confirm/i.test(e.message || '')) { root.querySelector('#pv-confirm-wrap').style.display = 'flex'; showToast('Tick the risky-steps confirmation first', 'warning', 6000); }
      else showToast(e.message, 'error', 8000);
    }
  });
}

// Switch the modal body to a live log + per-item status; poll the job (keeps running if the modal closes).
function streamProvisionJob(serverId, jobId, root) {
  const bodyEl = root.querySelector('#pv-body');
  bodyEl.innerHTML = `
    <div class="text-sm">Provisioning <b>${escapeHtml(serverId)}</b>… (keeps running on the server even if you close this)</div>
    <div id="pv-steps" style="margin:8px 0;line-height:1.9"></div>
    <pre id="pv-log" style="white-space:pre-wrap;background:#0d1117;color:#c9d1d9;padding:10px;border-radius:8px;max-height:40vh;overflow:auto;font-size:12px"></pre>`;
  const logEl = root.querySelector('#pv-log');
  const stepsEl = root.querySelector('#pv-steps');
  let timer = null;
  const poll = async () => {
    if (!document.body.contains(logEl)) { clearInterval(timer); return; } // modal closed → stop (job continues)
    let job;
    try { job = await API.get(`/servers/provision/job/${jobId}`); }
    catch (e) { clearInterval(timer); if (document.body.contains(logEl)) logEl.textContent += '\n(job finished — see Run history)'; return; }
    logEl.textContent = job.log || '';
    logEl.scrollTop = logEl.scrollHeight;
    stepsEl.innerHTML = (job.items || []).map(i => {
      const col = i.state === 'failed' ? 'var(--danger)' : (['verified', 'present'].includes(i.state) ? 'var(--success)' : 'var(--text-muted)');
      return `<span style="color:${col};margin-right:12px;white-space:nowrap">${PV_ICON[i.state] || '•'} ${escapeHtml(i.label || i.id)}</span>`;
    }).join('');
    if (job.status && job.status !== 'running') {
      clearInterval(timer);
      const ok = (job.items || []).filter(i => ['verified', 'present'].includes(i.state)).length;
      const failed = (job.items || []).filter(i => i.state === 'failed').length;
      showToast(`Provisioning ${job.status}: ${ok} ok, ${failed} failed`, failed ? 'warning' : 'success', 8000);
    }
  };
  poll();
  timer = setInterval(poll, 1500);
}
