// Server security pages — Overview security status · Access & SSH · Users · Deploy-user wizard (Firewall: firewall-panel.js).
// Same style as service-manager.js / provision-modal.js (globals, API.*, design-system classes).
// Every risky change goes through a confirm dialog and then a server-side "lifeline" job (validate →
// arm rollback → apply → test a NEW SSH connection → commit), whose steps runLifelineJob() shows live.
// The safety rules (DockGate keeps its own user/key, last sudo user, SSH port) are enforced by the
// backend (server/routes/security.js); the UI only explains them.

// ---------- shared helpers ----------
const SEC_LEVEL = {
  ok:   { color: 'var(--success)', bg: 'var(--success-bg)', label: 'OK' },
  warn: { color: 'var(--warning)', bg: 'var(--warning-bg)', label: 'Review' },
  crit: { color: 'var(--danger)',  bg: 'var(--danger-bg)',  label: 'Action needed' },
};
const secPill = (level, text) => `<span class="badge" style="background:${SEC_LEVEL[level].bg};color:${SEC_LEVEL[level].color}">${escapeHtml(text || SEC_LEVEL[level].label)}</span>`;
const secMono = (s) => `<span class="td-mono" style="font-size:12px">${escapeHtml(s)}</span>`;

function secError(container, title, e, retry) {
  container.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div style="font-weight:600;color:var(--danger)">${escapeHtml(title)}</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><button class="btn btn-secondary btn-sm" data-retry style="margin-top:10px">Retry</button></div>`;
  container.querySelector('[data-retry]').addEventListener('click', retry);
}

// Live progress for a guarded server-side job. Resolves true when it finishes, false on failure.
function runLifelineJob(serverId, jobId, title, { successText } = {}) {
  return new Promise((resolve) => {
    const m = showModal(escapeHtml(title), `
      <div class="text-sm text-muted" style="margin-bottom:12px">If the server stops answering at any point, it restores the previous configuration by itself after 120 seconds.</div>
      <div data-steps style="display:grid;gap:8px"></div>
      <div data-result style="margin-top:14px"></div>`, []);
    const stepsEl = m.overlay.querySelector('[data-steps]');
    const resEl = m.overlay.querySelector('[data-result]');
    const footer = m.overlay.querySelector('.modal-footer');
    footer.innerHTML = '<span class="text-xs text-muted">Working… keep this window open or close it — the job keeps running.</span>';
    const icon = (st) => st === 'done' ? '<span style="color:var(--success);font-weight:700">✓</span>'
      : st === 'running' ? '<span class="badge-dot" style="background:var(--accent);display:inline-block;width:8px;height:8px;border-radius:50%;animation:pulse 1.2s infinite"></span>'
      : st === 'failed' ? '<span style="color:var(--danger);font-weight:700">✗</span>' : '<span class="text-muted">○</span>';
    const tick = async () => {
      if (!document.body.contains(m.overlay)) return resolve(null);
      let job;
      try { job = await API.get(`/servers/${serverId}/jobs/${jobId}`); } catch (e) { resEl.innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; return resolve(false); }
      stepsEl.innerHTML = job.steps.map(s => `<div class="flex items-center gap-2" style="font-size:13px;${s.state === 'pending' ? 'color:var(--text-muted)' : ''}"><span style="width:16px;text-align:center">${icon(s.state)}</span><span>${escapeHtml(s.label)}</span></div>`).join('');
      if (job.status === 'running') return setTimeout(tick, 400);
      const ok = job.status === 'done';
      const warns = (job.result && job.result.warnings) || [];
      const failedStep = job.steps.find(s => s.state === 'failed');
      const rb = job.rolledBack === true ? ' The previous configuration was restored.' : (job.rolledBack === false ? ' Automatic restore did not confirm — the server restores it by itself within 120 s.' : '');
      resEl.innerHTML = ok
        ? `<div class="insight-card info" style="background:var(--success-bg);color:var(--success);border-left-color:var(--success)">${escapeHtml(job.successText || successText || 'Applied and verified with a new SSH connection.')}</div>${warns.map(w => `<div class="insight-card warning" style="margin-top:8px">${escapeHtml(w)}</div>`).join('')}`
        : `<div class="insight-card danger" style="display:block"><div style="font-weight:600">${escapeHtml(failedStep ? failedStep.label + ' failed.' : 'Failed.')}${escapeHtml(rb)}</div><pre style="white-space:pre-wrap;margin-top:6px;font-size:11px;max-height:160px;overflow:auto">${escapeHtml(String(job.error || '').slice(-1500))}</pre></div>`;
      footer.innerHTML = '';
      const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = 'Done'; b.onclick = () => m.close(); footer.appendChild(b);
      // Resolve once the user dismisses the result (Done, ✕ or backdrop), so callers can re-render safely.
      const waitClose = () => document.body.contains(m.overlay) ? setTimeout(waitClose, 250) : resolve(ok ? job : false);
      waitClose();
    };
    tick();
  });
}

// Confirm dialog with a "what changes / what protects you / how to undo" layout (risky ops only).
function secConfirm({ title, change, protects, undo, confirmLabel = 'Apply', danger = false, onConfirm }) {
  showModal(escapeHtml(title), `
    ${serverContextBanner()}
    <div class="detail-grid" style="grid-template-columns:1fr;gap:10px">
      <div class="detail-item"><div class="detail-label">What changes</div><div class="detail-value" style="white-space:normal;word-break:normal;overflow-wrap:anywhere">${change}</div></div>
      <div class="detail-item"><div class="detail-label">What protects you</div><div class="detail-value" style="white-space:normal;word-break:normal;overflow-wrap:anywhere">${protects}</div></div>
      <div class="detail-item"><div class="detail-label">How to undo</div><div class="detail-value" style="white-space:normal;word-break:normal;overflow-wrap:anywhere">${undo}</div></div>
    </div>`, [
    { label: 'Cancel', className: 'btn btn-secondary' },
    { label: confirmLabel, className: danger ? 'btn btn-danger' : 'btn btn-primary', onClick: onConfirm },
  ]);
}

// Re-trust the server's SSH host key (after a rebuild/reinstall the key legitimately changes).
function confirmRetrust(serverId, onDone) {
  secConfirm({
    title: 'Re-trust host key',
    change: 'DockGate forgets the pinned host key and pins the key the server presents on the next connection.',
    protects: 'Only do this if you rebuilt or reinstalled the server, or rotated its host keys yourself. An unexpected change can mean someone is intercepting the connection.',
    undo: 'Not needed — the new key is pinned automatically.',
    danger: true, confirmLabel: 'Re-trust',
    onConfirm: async () => {
      try { await API.post(`/servers/${serverId}/access/retrust-host-key`, { confirm: true }); showToast('Host key will be re-pinned on the next connection'); onDone && onDone(); }
      catch (e) { showToast(e.message, 'error', 8000); }
    },
  });
}
function addRetrustButton(serverId, card, onDone) {
  if (!card) return;
  const b = document.createElement('button');
  b.className = 'btn btn-danger btn-sm'; b.style.marginTop = '10px'; b.style.marginLeft = '8px'; b.textContent = 'Re-trust host key…';
  b.addEventListener('click', () => confirmRetrust(serverId, onDone));
  card.appendChild(b);
}

// ============================================================
// Overview → Security posture card (rendered above the existing overview)
// ============================================================
async function renderSecurityPosture(serverId, container, goTab) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:120px"></div></div>`;
  let data;
  try { data = await API.get(`/servers/${serverId}/security/posture`); }
  catch (e) { container.innerHTML = ''; return; }
  const worst = data.checks.some(c => c.level === 'crit') ? 'crit' : data.checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  const dep = data.checks.find(c => c.id === 'deploy-user');
  const go = { 'deploy-wizard': 'Set up', access: 'Open Access & SSH', firewall: 'Open Firewall', fail2ban: 'Open Fail2ban', setup: 'Open Setup' };
  // Azure Defender / DO Insights style: a list of recommendations, most important first, each with a
  // link to the place that fixes it.
  const order = { crit: 0, warn: 1, ok: 2 };
  const checks = data.checks.slice().sort((a, b) => order[a.level] - order[b.level]);
  const pillOf = { crit: ['bad', 'High'], warn: ['warn', 'Medium'], ok: ['ok', 'OK'] };
  const open = checks.filter(c => c.level !== 'ok').length;
  container.innerHTML = `
    ${data.rebootRequired ? `
    <div class="card" style="border-left:3px solid var(--warning);margin-bottom:14px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div style="min-width:0;flex:1"><div style="font-weight:700;font-size:15px">Reboot required</div><div class="text-sm text-muted" style="margin-top:4px">Installed updates (kernel or core libraries) take effect after a reboot. Running containers with a restart policy come back by themselves.</div></div>
      <button class="btn btn-secondary" data-reboot>${Icons.restart || ''} Reboot server…</button>
    </div>` : ''}
    ${dep && dep.level !== 'ok' ? `
    <div class="card" style="border-left:3px solid var(--accent);margin-bottom:14px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:15px">DockGate connects to this server as ${escapeHtml(dep.value.replace(/^DockGate connects as /, ''))}</div>
        <div class="text-sm text-muted" style="margin-top:4px;max-width:70ch">Create a deploy user: a non-root account with passwordless sudo and Docker access, logged in with an SSH key that DockGate generates. Password login stays on until you turn it off yourself.</div>
      </div>
      <button class="btn btn-primary" data-wizard>${Icons.key || ''} Create deploy user</button>
    </div>` : ''}
    ${UI.header('Security recommendations', open ? `${open} to look at — most important first.` : 'Nothing to fix right now.', secPill(worst))}
    <div class="ui-settings">${checks.map(c => `
      <div class="ui-set" style="grid-template-columns:auto minmax(0,1fr) auto">
        ${UI.pill(...pillOf[c.level])}
        <div class="ui-set-l"><b>${escapeHtml(c.label)}</b><span>${escapeHtml(c.value)}</span></div>
        <div class="ui-set-a">${c.action ? UI.btn(go[c.action] || 'Open', `data-go="${c.action}"`) : ''}</div>
      </div>`).join('')}
    </div>`;
  const refreshConsole = () => Router.navigate('server-console', { id: serverId, tab: 'overview' });
  container.querySelector('[data-wizard]')?.addEventListener('click', () => openDeployUserWizard(serverId, refreshConsole));
  container.querySelector('[data-reboot]')?.addEventListener('click', () => secConfirm({
    title: 'Reboot server', danger: true, confirmLabel: 'Reboot',
    change: 'The server restarts now and is unreachable for a minute or two.',
    protects: 'Containers with a restart policy and enabled services start again by themselves. SSH and firewall settings are on disk and survive the reboot.',
    undo: 'Not applicable — wait for the server to come back; DockGate reconnects automatically.',
    onConfirm: async () => {
      try { await API.post(`/servers/${serverId}/reboot`, { confirm: true }); showToast('Reboot started — the server is back in a minute or two', 'info', 8000); }
      catch (e) { showToast(e.message, 'error', 8000); }
    },
  }));
  container.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.go === 'deploy-wizard') openDeployUserWizard(serverId, refreshConsole);
    else goTab(b.dataset.go);
  }));
}

// ============================================================
// Deploy-user wizard
// ============================================================
function openDeployUserWizard(serverId, onDone) {
  const m = showModal('Create deploy user', `
    <div class="text-sm text-muted" style="margin-bottom:14px">DockGate will create the user, give it the permissions below, install an SSH key and log in with it to prove it works. Only then does DockGate switch its own connection to this user. Nothing is locked down in this step.</div>
    <div class="input-group" style="margin-bottom:12px">
      <label class="text-sm" for="dw-name" style="font-weight:600;display:block;margin-bottom:4px">Username</label>
      <input class="input" id="dw-name" value="deploy" spellcheck="false" style="font-family:var(--font-mono)">
      <div class="text-xs text-muted" style="margin-top:4px">Lowercase letters, digits, _ and -. Starts with a letter or _.</div>
    </div>
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">Permissions</div>
    <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Passwordless sudo</div><div class="settings-row-desc">Needed so DockGate can manage packages, SSH, users and the firewall. Equivalent to root.</div></div><span class="badge badge-running">on</span></div>
    <div class="settings-row" style="padding:8px 0;margin-bottom:12px"><div><div class="settings-row-label">Docker group</div><div class="settings-row-desc">Run docker without sudo.</div></div><span class="badge badge-running">on</span></div>
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">SSH key</div>
    <div class="tab-bar" id="dw-keymode" style="margin-bottom:8px">
      <button class="tab-btn active" type="button" data-km="generate">Generate for me (ed25519)</button>
      <button class="tab-btn" type="button" data-km="paste">Use my public key</button>
    </div>
    <div class="text-xs text-muted" data-kmhelp>DockGate generates the key pair and keeps the private key encrypted. You can download it later from Users → Keys.</div>
    <textarea class="input" id="dw-pub" hidden spellcheck="false" placeholder="ssh-ed25519 AAAAC3Nz… you@laptop" style="width:100%;min-height:72px;margin-top:8px;font-family:var(--font-mono);font-size:12px"></textarea>
    <div data-err style="margin-top:10px"></div>`, []);
  const ov = m.overlay;
  let keyMode = 'generate';
  ov.querySelector('#dw-keymode').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn'); if (!b) return;
    keyMode = b.dataset.km;
    ov.querySelectorAll('#dw-keymode .tab-btn').forEach(x => x.classList.toggle('active', x === b));
    ov.querySelector('#dw-pub').hidden = keyMode !== 'paste';
    ov.querySelector('[data-kmhelp]').textContent = keyMode === 'paste'
      ? 'Paste the public key from your own machine (~/.ssh/id_ed25519.pub). DockGate also adds its own key so it can keep managing the server.'
      : 'DockGate generates the key pair and keeps the private key encrypted. You can download it later from Users → Keys.';
  });
  const footer = ov.querySelector('.modal-footer');
  const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
  const go = document.createElement('button'); go.className = 'btn btn-primary'; go.textContent = 'Create and verify';
  footer.append(cancel, go);
  go.onclick = async () => {
    const username = ov.querySelector('#dw-name').value.trim();
    const publicKey = ov.querySelector('#dw-pub').value.trim();
    go.disabled = true;
    try {
      const { jobId } = await API.post(`/servers/${serverId}/deploy-user`, { username, keyMode, publicKey });
      m.close();
      const job = await runLifelineJob(serverId, jobId, `Creating deploy user "${username}"`, { successText: `DockGate now connects as ${username} with an SSH key. Password login is still on — turn it off in Access & SSH when you are ready.` });
      if (job) { showToast(`Deploy user "${username}" ready`); onDone && onDone(); }
    } catch (e) {
      go.disabled = false;
      ov.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`;
    }
  };
}

// ============================================================
// Access & SSH tab
// ============================================================
async function renderAccessPanel(serverId, container) {
  container.innerHTML = `<div class="grid-2">${Array(4).fill('<div class="card"><div class="skeleton" style="width:100%;height:90px"></div></div>').join('')}</div>`;
  let a;
  try { a = await API.get(`/servers/${serverId}/access`); }
  catch (e) {
    secError(container, "Couldn't read SSH settings", e, () => renderAccessPanel(serverId, container));
    if (/host key mismatch/i.test(e.message || '')) addRetrustButton(serverId, container.querySelector('.card'), () => renderAccessPanel(serverId, container));
    return;
  }
  const reload = () => renderAccessPanel(serverId, container);
  const locked = !a.safeForLockdown;
  const hk = a.hostKey || {};
  const rootTxt = { yes: 'Allowed', 'prohibit-password': 'Key only', no: 'Blocked' };
  const mins = (v) => (v ? `${v} min` : 'Off');
  const lockHint = locked ? `<div class="ui-sub" style="color:var(--warning)">Needs a deploy user with a verified SSH key first — <a href="#" data-wizard>create one</a></div>` : '';

  container.innerHTML = `
    <div data-sshbar style="margin-bottom:12px"></div>
    ${a.legacyFile ? '<div class="insight-card info" style="margin-bottom:12px"><div>Settings from the old /etc/ssh/sshd_config.d/99-dockgate.conf are shown below and move into DockGate\'s single file (10-dockgate-access.conf) on the next save.</div></div>' : ''}
    ${a.includesDropins === false ? '<div class="insight-card warning" style="margin-bottom:12px"><div>/etc/ssh/sshd_config does not include sshd_config.d/*.conf, so DockGate cannot change SSH settings. Add "Include /etc/ssh/sshd_config.d/*.conf" at the top of that file first.</div></div>' : ''}
    ${UI.header('Access & SSH', 'How people log in to this server. Every change tests a new SSH login and rolls back by itself if it fails.')}
    ${UI.settings([
      { label: "DockGate's connection", desc: 'The user and login DockGate uses. Change it in Settings.', value: `${secMono(a.connection.user + '@' + a.connection.host + ':' + (a.connection.port || a.sshPort))}<div class="ui-sub">${a.connection.auth === 'key' ? 'SSH key · verified' : 'password'}</div>` },
      { label: 'Root login', desc: 'Who can log in as root over SSH. Blocking it does not remove root — sudo still works.' + lockHint, value: `${UI.pill(a.rootLogin === 'yes' ? 'bad' : a.rootLogin === 'no' ? 'ok' : 'warn', rootTxt[a.rootLogin] || a.rootLogin)} <span class="ui-sub td-mono">PermitRootLogin ${escapeHtml(a.rootLogin)}</span>`, action: UI.btn('Edit', 'data-edit="root"') },
      { label: 'Password login', desc: (a.passwordAuth ? 'Anyone can try passwords against this server.' : 'Only SSH keys can log in.') + ` Users with keys: ${a.keyHolders.length ? a.keyHolders.map(escapeHtml).join(', ') : 'none'}.` + (a.passwordAuth ? lockHint : ''), value: a.passwordAuth ? UI.pill('warn', 'Allowed') : UI.pill('ok', 'Disabled · keys only'), action: a.passwordAuth ? UI.btn('Disable…', `data-pw="off" ${locked ? 'disabled' : ''}`, 'btn-danger') : UI.btn('Re-enable…', 'data-pw="on"') },
      { label: 'SSH port', desc: 'The new port is opened in the firewall first; the old one closes after DockGate logs in on the new one.', value: `<span class="td-mono">${a.sshPort}</span>`, action: UI.btn('Edit', 'data-edit="port"') },
      { label: 'Login attempts per connection', desc: 'Wrong passwords or keys before the connection is dropped.', value: `${a.maxAuthTries}`, action: UI.btn('Edit', 'data-edit="maxAuthTries"') },
      { label: 'Time to log in', desc: 'Seconds a client gets to finish logging in.', value: `${a.loginGraceTime} s`, action: UI.btn('Edit', 'data-edit="loginGraceTime"') },
      { label: 'Dead connection timeout', desc: 'Drops a connection whose client stopped answering (network gone, laptop asleep). Does not log out an idle open terminal.', value: mins(a.deadTimeoutMin), action: UI.btn('Edit', 'data-edit="deadTimeoutMin"') },
      { label: 'Idle session timeout', desc: a.supportsIdleTimeout ? 'Closes a session with no input or output for this long.' : `Needs OpenSSH 9.2+ — this server runs ${escapeHtml(a.sshVersion || 'an older version')}.`, value: mins(a.idleTimeoutMin), action: a.supportsIdleTimeout ? UI.btn('Edit', 'data-edit="idleTimeoutMin"') : '' },
      { label: 'X11 forwarding', desc: 'Not needed on servers.', value: a.x11 ? UI.pill('warn', 'On') : UI.pill('ok', 'Off'), action: UI.btn(a.x11 ? 'Turn off' : 'Turn on', 'data-x11') },
      { label: 'Host key', desc: 'The server identity. DockGate refuses to connect if it changes.', value: hk.pinned ? `${secMono(hk.type + ' ' + hk.fingerprint)}<div class="ui-sub">pinned ${escapeHtml(hk.pinnedAt || '')}</div>` : '<span class="ui-sub">not pinned yet — pinned on the next connection</span>', action: hk.pinned ? UI.btn('Re-trust…', 'data-retrust', 'btn-danger') : '' },
    ])}
    <div class="ui-sub" style="margin-top:8px">Written to <span class="td-mono">/etc/ssh/sshd_config.d/10-dockgate-access.conf</span>. The main sshd_config is never edited.</div>`;

  renderServiceBar(serverId, 'ssh-hardening', container.querySelector('[data-sshbar]'), { label: 'SSH server (sshd)', note: 'Reload applies config changes without closing open sessions.' });
  const rawEl = document.createElement('div'); rawEl.style.marginTop = '16px'; container.appendChild(rawEl);
  renderRawConfig(serverId, 'ssh-hardening', '/etc/ssh/sshd_config.d/10-dockgate-access.conf', rawEl, { label: 'DockGate sshd drop-in', high: true });
  container.querySelector('[data-retrust]')?.addEventListener('click', () => confirmRetrust(serverId, reload));
  container.querySelectorAll('[data-wizard]').forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); openDeployUserWizard(serverId, () => Router.navigate('server-console', { id: serverId, tab: 'access' })); }));

  const apply = async (setting, value, title, successText) => {
    const { jobId } = await API.post(`/servers/${serverId}/access`, { setting, value, confirm: true });
    setTimeout(async () => { if (await runLifelineJob(serverId, jobId, title, { successText })) showToast(`${title}: saved`); reload(); }, 0);
  };
  const hardening = (patch) => ({ maxAuthTries: a.maxAuthTries, loginGraceTime: a.loginGraceTime, deadTimeoutMin: a.deadTimeoutMin, idleTimeoutMin: a.idleTimeoutMin || 0, x11: !!a.x11, ...patch });
  const protect = `DockGate keeps its own connection as <b>${escapeHtml(a.connection.user)}</b> and tests a fresh login before saving. If that fails, the server restores the old setting after 120 s.`;
  const numberEdit = (key, label, unit, min, max, help) => UI.dialog({
    title: label, body: `<div class="ui-field"><label for="ax">${label}${unit ? ` (${unit})` : ''}</label><input class="input" id="ax" type="number" min="${min}" max="${max}" value="${a[key] || 0}" style="width:120px"><span class="ui-help">${help}</span></div>${UI.explain('sshd is reloaded with the new value. Open sessions stay.', protect)}`,
    onSave: (ov) => { const v = Number(ov.querySelector('#ax').value); if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Enter a number from ${min} to ${max}`); return apply('hardening', hardening({ [key]: v }), label, `${label} saved.`); },
  });
  const EDITS = {
    root: () => {
      let v = a.rootLogin;
      UI.dialog({
        title: 'Root SSH login', danger: true,
        body: `<div class="ui-field"><span class="ui-label">Root can log in</span><div class="ui-seg">${Object.entries(rootTxt).map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${v === k}" ${locked && k !== 'yes' ? 'disabled title="Create a deploy user first"' : ''}>${l}</button>`).join('')}</div><span class="ui-help">Key only = root keeps working with an SSH key, never with a password.</span></div>${lockHint}${UI.explain('<span class="td-mono">PermitRootLogin</span> changes and sshd is reloaded.', protect)}`,
        onOpen: (ov) => ov.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { v = b.dataset.v; ov.querySelectorAll('[data-v]').forEach(x => x.setAttribute('aria-pressed', x === b)); }),
        onSave: () => (v === a.rootLogin ? undefined : apply('rootLogin', v, 'Root SSH login', `Root SSH login is now "${rootTxt[v]}".`)),
      });
    },
    port: () => UI.dialog({
      title: 'SSH port',
      body: `<div class="ui-field"><label for="ax">Port</label><input class="input" id="ax" type="number" min="1" max="65535" value="${a.sshPort}" style="width:120px"><span class="ui-help">Update your own ssh client afterwards.</span></div>${UI.explain('sshd listens on the new port instead of the current one.', 'The new port is opened in the firewall first; the old one closes only after DockGate logs in on the new one. Rollback after 120 s if anything fails.')}`,
      onSave: (ov) => { const port = Number(ov.querySelector('#ax').value); if (port === a.sshPort) return; return apply('sshPort', port, 'SSH port', `SSH now listens on ${port}.`); },
    }),
    maxAuthTries: () => numberEdit('maxAuthTries', 'Login attempts per connection', '', 1, 10, 'Lower values slow down guessing; 3 is a common choice.'),
    loginGraceTime: () => numberEdit('loginGraceTime', 'Time to log in', 'seconds', 10, 600, 'Unauthenticated connections are dropped after this.'),
    deadTimeoutMin: () => numberEdit('deadTimeoutMin', 'Dead connection timeout', 'minutes', 0, 240, '0 = off.'),
    idleTimeoutMin: () => numberEdit('idleTimeoutMin', 'Idle session timeout', 'minutes', 0, 1440, '0 = off. Closes terminals nobody uses.'),
  };
  container.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => EDITS[b.dataset.edit]());
  container.querySelector('[data-x11]').onclick = () => apply('hardening', hardening({ x11: !a.x11 }), 'X11 forwarding', `X11 forwarding ${a.x11 ? 'off' : 'on'}.`).catch(e => showToast(e.message, 'error', 7000));
  container.querySelector('[data-pw]')?.addEventListener('click', (e) => {
    const off = e.currentTarget.dataset.pw === 'off';
    secConfirm({
      title: off ? 'Disable password login' : 'Re-enable password login',
      change: off ? '<span class="td-mono">PasswordAuthentication no</span> and <span class="td-mono">KbdInteractiveAuthentication no</span>. Only SSH keys will work.' : '<span class="td-mono">PasswordAuthentication yes</span>. Passwords will work again.',
      protects: off ? `These users can still log in with a key: <b>${a.keyHolders.map(escapeHtml).join(', ')}</b>. DockGate tests a new key login before saving; if it fails, the server rolls back after 120 s.` : 'No lockout risk.',
      undo: off ? 'Re-enable it here. If you lose every key, use your provider\'s web console.' : 'Disable it here again.',
      danger: off, confirmLabel: off ? 'Disable password login' : 'Re-enable',
      onConfirm: () => apply('passwordAuth', !off, 'Password login', off ? 'Password login is off. Only SSH keys can log in now.' : 'Password login is on again.').catch(er => showToast(er.message, 'error', 7000)),
    });
  });
}

// ============================================================
// Users tab
// ============================================================
async function renderUsersPanel(serverId, container) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let d;
  try { d = await API.get(`/servers/${serverId}/users`); }
  catch (e) { return secError(container, "Couldn't read users", e, () => renderUsersPanel(serverId, container)); }
  const reload = () => renderUsersPanel(serverId, container);
  const keyRows = d.users.flatMap(u => u.keys.map((k, i) => ({ u, k, i })));
  container.innerHTML = `
    ${UI.header('Users', `Who can log in to this server: human accounts (UID ≥ 1000) and root. DockGate connects as <b>${escapeHtml(d.connectionUser)}</b>.`, UI.primary('Add user', 'data-add'))}
    ${UI.table([{ label: 'User' }, { label: 'Role' }, { label: 'Docker' }, { label: 'SSH keys' }, { label: 'Password login' }, { label: 'Last login' }, { label: '', align: 'right' }], d.users.map(u => ({ cls: u.locked ? 'ui-row-muted' : '', cells: [
      `<b>${escapeHtml(u.name)}</b>${u.isConnection ? ' ' + UI.pill('info', 'DockGate') : ''}${u.locked ? ' ' + UI.pill('bad', 'locked') : ''}<div class="ui-sub td-mono">uid ${u.uid} · ${escapeHtml(u.home)}</div>`,
      u.uid === 0 ? 'root' : (u.sudo ? 'Admin (sudo)' : 'Standard'),
      u.docker ? 'Yes' : '<span class="ui-sub">No</span>',
      u.keys.length ? `${u.keys.length}` : UI.pill('warn', 'none'),
      u.uid === 0 ? '<span class="ui-sub">see Access &amp; SSH</span>' : (d.passwordAuth && u.passwordLogin ? UI.pill('warn', 'allowed') : '<span class="ui-sub">off</span>'),
      `<span class="ui-sub">${escapeHtml(u.lastLogin || '—')}</span>`,
      `${UI.btn('Keys', `data-keys="${escapeHtml(u.name)}"`)}${u.uid === 0 ? '' : `${UI.btn('Edit', `data-edit="${escapeHtml(u.name)}"`)}${UI.btn(u.locked ? 'Unlock' : 'Lock', `data-lock="${escapeHtml(u.name)}" ${u.isConnection ? 'disabled title="DockGate connects as this user"' : ''}`)}${UI.btn('Delete', `data-del="${escapeHtml(u.name)}" ${u.isConnection ? 'disabled title="DockGate connects as this user"' : ''}`, 'btn-danger')}`}`,
    ] })), { minWidth: 820 })}
    ${UI.header('SSH keys', 'Public keys in each user\'s authorized_keys. Keys DockGate generated can be downloaded.', UI.primary('Add SSH key', 'data-addkey'))}
    ${UI.table([{ label: 'Name' }, { label: 'User' }, { label: 'Type' }, { label: 'Fingerprint' }, { label: '', align: 'right' }], keyRows.map(({ u, k, i }) => ({ cells: [
      `<b>${escapeHtml(k.comment || '(no comment)')}</b>${k.dockgate ? ' ' + UI.pill('info', 'made by DockGate') : ''}${k.connectionKey ? ' ' + UI.pill('ok', 'DockGate logs in with it') : ''}`,
      escapeHtml(u.name), `<span class="ui-sub">${escapeHtml(k.type)}</span>`, `<span class="td-mono text-xs">${escapeHtml(k.fingerprint)}</span>`,
      `${k.dockgate ? UI.btn('Download', `data-dlkey="${escapeHtml(u.name)}:${i}"`) : ''}${UI.btn('Remove', `data-rmkey="${escapeHtml(u.name)}:${i}" ${k.connectionKey ? 'disabled title="DockGate connects with this key"' : ''}`, 'btn-danger')}`,
    ] })), { minWidth: 720, empty: 'No SSH keys — nobody can log in with a key.' })}
    <div class="ui-sub" style="margin-top:8px">Protected: the user DockGate connects as cannot be locked or deleted, the last sudo user keeps sudo, and the last key cannot be removed while password login is off.</div>`;

  const keyOf = (v) => { const [n, i] = v.split(':'); const u = d.users.find(x => x.name === n); return { u, k: u.keys[Number(i)] }; };
  container.querySelectorAll('[data-dlkey]').forEach(b => b.addEventListener('click', () => { const { u, k } = keyOf(b.dataset.dlkey); downloadPrivateKey(serverId, u.name, k); }));
  container.querySelectorAll('[data-rmkey]').forEach(b => b.addEventListener('click', () => {
    const { u, k } = keyOf(b.dataset.rmkey);
    secConfirm({
      title: `Remove key from ${escapeHtml(u.name)}`, danger: true, confirmLabel: 'Remove key',
      change: `<b>${escapeHtml(k.comment || k.type)}</b> (<span class="td-mono">${escapeHtml(k.fingerprint)}</span>) is removed from ${escapeHtml(u.home)}/.ssh/authorized_keys.`,
      protects: 'DockGate refuses to remove the key it logs in with, and the last key while password login is off.',
      undo: 'Add the public key again.',
      onConfirm: async () => { try { await API.del(`/servers/${serverId}/users/${encodeURIComponent(u.name)}/keys?fingerprint=${encodeURIComponent(k.fingerprint)}`); showToast('Key removed'); reload(); } catch (e) { showToast(e.message, 'error', 7000); } },
    });
  }));
  container.querySelector('[data-addkey]').addEventListener('click', () => {
    let mode = 'paste';
    UI.dialog({
      title: 'Add SSH key', saveLabel: 'Add key',
      body: `<div class="ui-field"><label for="ak-user">User</label><select class="select" id="ak-user">${d.users.filter(u => !u.locked).map(u => `<option ${u.isConnection ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}</select></div>
        <div class="ui-field"><span class="ui-label">Key</span><div class="ui-seg"><button type="button" data-km="paste" aria-pressed="true">Paste a public key</button><button type="button" data-km="generate" aria-pressed="false">Generate a new key (ed25519)</button></div>
        <textarea class="input" data-pub spellcheck="false" placeholder="ssh-ed25519 AAAAC3Nz… you@laptop" style="width:100%;min-height:72px;font-family:var(--font-mono);font-size:12px"></textarea>
        <span class="ui-help" data-kmhelp>From ~/.ssh/id_ed25519.pub on your own machine.</span></div>`,
      onOpen: (ov) => ov.querySelectorAll('[data-km]').forEach(b => b.onclick = () => { mode = b.dataset.km; ov.querySelectorAll('[data-km]').forEach(x => x.setAttribute('aria-pressed', x === b)); ov.querySelector('[data-pub]').hidden = mode !== 'paste'; ov.querySelector('[data-kmhelp]').textContent = mode === 'paste' ? 'From ~/.ssh/id_ed25519.pub on your own machine.' : 'DockGate generates the pair and keeps the private key encrypted — download it from this table.'; }),
      onSave: async (ov) => { await API.post(`/servers/${serverId}/users/${encodeURIComponent(ov.querySelector('#ak-user').value)}/keys`, { mode, publicKey: ov.querySelector('[data-pub]').value.trim() }); showToast('Key added'); reload(); },
    });
  });
  const byName = (n) => d.users.find(u => u.name === n);
  container.querySelector('[data-add]').addEventListener('click', () => openAddUser(serverId, reload));
  container.querySelectorAll('[data-keys]').forEach(b => b.addEventListener('click', () => openUserKeys(serverId, byName(b.dataset.keys), d, reload)));
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openUserPerms(serverId, byName(b.dataset.edit), reload)));
  container.querySelectorAll('[data-lock]').forEach(b => b.addEventListener('click', () => {
    const u = byName(b.dataset.lock);
    secConfirm({
      title: u.locked ? `Unlock ${escapeHtml(u.name)}` : `Lock ${escapeHtml(u.name)}`, danger: !u.locked, confirmLabel: u.locked ? 'Unlock' : 'Lock',
      change: u.locked ? 'The account expiry is removed; the user can log in again with their keys or password.' : 'The account is expired and its password locked: no password or key login. Files, processes and keys are kept.',
      protects: 'DockGate never locks the user it connects as, nor the last user with sudo.',
      undo: u.locked ? 'Lock it again here.' : 'Unlock it here at any time.',
      onConfirm: async () => {
        try { await API.put(`/servers/${serverId}/users/${encodeURIComponent(u.name)}`, { locked: !u.locked }); showToast(u.locked ? 'User unlocked' : 'User locked'); reload(); } catch (e) { showToast(e.message, 'error', 7000); }
      },
    });
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const u = byName(b.dataset.del);
    let removeHome = false; // read on change — the dialog is closed before onConfirm runs
    const m = showDeleteConfirm(`Delete user ${escapeHtml(u.name)}`, {
      message: `<p class="text-sm" style="color:var(--text-secondary)">Removes the account, its SSH keys and sudo rights.</p><label class="flex items-center gap-1 text-sm" style="margin-top:8px"><input type="checkbox" id="del-home"> Also delete <span class="td-mono">${escapeHtml(u.home)}</span></label>`,
      phrase: u.name, confirmLabel: 'Delete user',
      onConfirm: async () => { try { await API.del(`/servers/${serverId}/users/${encodeURIComponent(u.name)}${removeHome ? '?removeHome=1' : ''}`); showToast(`User ${u.name} deleted`); reload(); } catch (e) { showToast(e.message, 'error', 7000); } },
    });
    m.overlay.querySelector('#del-home')?.addEventListener('change', (ev) => { removeHome = ev.target.checked; });
  }));
}

function userKeyModeHtml(id) {
  return `<div class="tab-bar" id="${id}" style="margin-bottom:8px">
      <button class="tab-btn active" type="button" data-km="generate">Generate (ed25519)</button>
      <button class="tab-btn" type="button" data-km="paste">Paste public key</button>
      <button class="tab-btn" type="button" data-km="none">No key</button>
    </div>
    <textarea class="input" data-pub hidden spellcheck="false" placeholder="ssh-ed25519 AAAAC3Nz… you@laptop" style="width:100%;min-height:72px;font-family:var(--font-mono);font-size:12px"></textarea>`;
}
function wireKeyMode(ov, id) {
  let mode = 'generate';
  ov.querySelector('#' + id).addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn'); if (!b) return;
    mode = b.dataset.km;
    ov.querySelectorAll(`#${id} .tab-btn`).forEach(x => x.classList.toggle('active', x === b));
    ov.querySelector('[data-pub]').hidden = mode !== 'paste';
  });
  return () => mode;
}

// Download a private key DockGate generated. The admin password is asked again: the file grants SSH access.
function downloadPrivateKey(serverId, username, key) {
  const m = showModal('Download private key', `
    <div class="text-sm text-muted" style="margin-bottom:10px">This file lets anyone who has it log in as <b>${escapeHtml(username)}</b>. Enter the DockGate admin password to continue.</div>
    <input class="input" id="pk-pw" type="password" autocomplete="current-password" placeholder="Admin password" style="width:100%">
    <div data-err style="margin-top:8px"></div>`, []);
  const footer = m.overlay.querySelector('.modal-footer');
  const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
  const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Download';
  footer.append(c, ok);
  const go = async () => {
    try {
      const r = await API.post(`/servers/${serverId}/users/${encodeURIComponent(username)}/keys/private`, { fingerprint: key.fingerprint, adminPassword: m.overlay.querySelector('#pk-pw').value });
      const url = URL.createObjectURL(new Blob([r.privateKey], { type: 'application/x-pem-file' }));
      const a = document.createElement('a'); a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      m.close(); showToast(`Saved ${r.filename} — keep it private (chmod 600)`);
    } catch (e) { m.overlay.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
  ok.onclick = go;
  m.overlay.querySelector('#pk-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  setTimeout(() => m.overlay.querySelector('#pk-pw').focus(), 50);
}

function openAddUser(serverId, reload) {
  const m = showModal('Add user', `
    <div class="input-group" style="margin-bottom:12px">
      <label class="text-sm" for="au-name" style="font-weight:600;display:block;margin-bottom:4px">Username</label>
      <input class="input" id="au-name" placeholder="alice" spellcheck="false" style="font-family:var(--font-mono)">
    </div>
    <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Sudo</div><div class="settings-row-desc">Full admin rights without a password</div></div><div class="toggle" id="au-sudo" role="switch" tabindex="0"></div></div>
    <div class="settings-row" style="padding:8px 0;margin-bottom:12px"><div><div class="settings-row-label">Docker</div><div class="settings-row-desc">Member of the docker group (root-equivalent)</div></div><div class="toggle active" id="au-docker" role="switch" tabindex="0"></div></div>
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">SSH key</div>
    ${userKeyModeHtml('au-km')}
    <div data-err style="margin-top:10px"></div>`, []);
  const ov = m.overlay;
  ov.querySelectorAll('.toggle').forEach(t => { const f = () => t.classList.toggle('active'); t.addEventListener('click', f); t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); f(); } }); });
  const mode = wireKeyMode(ov, 'au-km');
  const footer = ov.querySelector('.modal-footer');
  const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
  const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Create user';
  footer.append(c, ok);
  ok.onclick = async () => {
    ok.disabled = true;
    const body = { name: ov.querySelector('#au-name').value.trim(), sudo: ov.querySelector('#au-sudo').classList.contains('active'), docker: ov.querySelector('#au-docker').classList.contains('active'), keyMode: mode(), publicKey: ov.querySelector('[data-pub]').value.trim() };
    try { await API.post(`/servers/${serverId}/users`, body); m.close(); showToast(`User ${body.name} created`); reload(); }
    catch (e) { ok.disabled = false; ov.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
}

function openUserPerms(serverId, u, reload) {
  const m = showModal(`Permissions · ${escapeHtml(u.name)}`, `
    <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Sudo</div><div class="settings-row-desc">Passwordless, via /etc/sudoers.d/90-dockgate-${escapeHtml(u.name)}</div></div><div class="toggle ${u.sudo ? 'active' : ''}" id="up-sudo" role="switch" tabindex="0"></div></div>
    <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Docker</div><div class="settings-row-desc">docker group membership</div></div><div class="toggle ${u.docker ? 'active' : ''}" id="up-docker" role="switch" tabindex="0"></div></div>
    <div data-err style="margin-top:10px"></div>`, []);
  const ov = m.overlay;
  ov.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', () => t.classList.toggle('active')));
  const footer = ov.querySelector('.modal-footer');
  const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
  const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Save';
  footer.append(c, ok);
  ok.onclick = async () => {
    try { await API.put(`/servers/${serverId}/users/${encodeURIComponent(u.name)}`, { sudo: ov.querySelector('#up-sudo').classList.contains('active'), docker: ov.querySelector('#up-docker').classList.contains('active') }); m.close(); showToast('Permissions saved'); reload(); }
    catch (e) { ov.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
}

function openUserKeys(serverId, u, d, reload) {
  const m = showModal(`SSH keys · ${escapeHtml(u.name)}`, `
    <div class="text-xs text-muted" style="margin-bottom:8px">From <span class="td-mono">${escapeHtml(u.home)}/.ssh/authorized_keys</span></div>
    <div style="display:grid;gap:8px;margin-bottom:14px">${u.keys.length ? u.keys.map((k, i) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <div class="text-sm" style="font-weight:600">${escapeHtml(k.comment || k.type)}${k.dockgate ? ' <span class="badge" style="background:var(--accent-dim);color:var(--accent)">DockGate</span>' : ''}${k.connectionKey ? ' <span class="badge badge-running">in use</span>' : ''}</div>
          <div class="text-xs text-muted td-mono" style="overflow-wrap:anywhere;margin-top:2px">${escapeHtml(k.type)} · ${escapeHtml(k.fingerprint)}</div>
        </div>
        <div class="flex gap-1" style="flex:none">${k.dockgate ? `<button class="btn btn-xs btn-secondary" data-dl="${i}">${Icons.download || ''} Private key</button>` : ''}<button class="btn btn-xs btn-danger" data-rm="${i}" ${k.connectionKey ? 'disabled title="DockGate connects with this key"' : ''}>Remove</button></div>
      </div>`).join('') : '<div class="text-sm text-muted">No keys — this user cannot log in over SSH.</div>'}</div>
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">Add a key</div>
    <div class="tab-bar" id="uk-km" style="margin-bottom:8px">
      <button class="tab-btn active" type="button" data-km="paste">Paste public key</button>
      <button class="tab-btn" type="button" data-km="generate">Generate (ed25519)</button>
    </div>
    <textarea class="input" data-pub spellcheck="false" placeholder="ssh-ed25519 AAAAC3Nz… you@laptop" style="width:100%;min-height:64px;font-family:var(--font-mono);font-size:12px"></textarea>
    <div data-err style="margin-top:10px"></div>`, []);
  const ov = m.overlay;
  let mode = 'paste';
  ov.querySelector('#uk-km').addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (!b) return; mode = b.dataset.km; ov.querySelectorAll('#uk-km .tab-btn').forEach(x => x.classList.toggle('active', x === b)); ov.querySelector('[data-pub]').hidden = mode !== 'paste'; });
  const refresh = async () => { m.close(); reload(); const nd = await API.get(`/servers/${serverId}/users`); const nu = nd.users.find(x => x.name === u.name); if (nu) openUserKeys(serverId, nu, nd, reload); };
  ov.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
    try { await API.del(`/servers/${serverId}/users/${encodeURIComponent(u.name)}/keys?fingerprint=${encodeURIComponent(u.keys[Number(b.dataset.rm)].fingerprint)}`); showToast('Key removed'); refresh(); }
    catch (e) { ov.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  }));
  ov.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => downloadPrivateKey(serverId, u.name, u.keys[Number(b.dataset.dl)])));
  const footer = ov.querySelector('.modal-footer');
  const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Close'; c.onclick = () => m.close();
  const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Add key';
  footer.append(c, ok);
  ok.onclick = async () => {
    try { await API.post(`/servers/${serverId}/users/${encodeURIComponent(u.name)}/keys`, { mode, publicKey: ov.querySelector('[data-pub]').value.trim() }); showToast('Key added'); refresh(); }
    catch (e) { ov.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
}
