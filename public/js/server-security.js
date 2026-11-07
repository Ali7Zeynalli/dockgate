// Server security pages — Overview security status · Access & SSH · Users · Firewall · Deploy-user wizard.
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
  container.innerHTML = `
    ${data.rebootRequired ? `
    <div class="card" style="border-left:3px solid var(--warning);margin-bottom:16px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div style="min-width:0;flex:1"><div style="font-weight:700;font-size:15px">Reboot required</div><div class="text-sm text-muted" style="margin-top:4px">Installed updates (kernel or core libraries) take effect after a reboot. Running containers with a restart policy come back by themselves.</div></div>
      <button class="btn btn-secondary" data-reboot>${Icons.restart || ''} Reboot server</button>
    </div>` : ''}
    ${dep && dep.level !== 'ok' ? `
    <div class="card" style="border-left:3px solid var(--accent);margin-bottom:16px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:15px">DockGate connects to this server as ${escapeHtml(dep.value.replace(/^DockGate connects as /, ''))}</div>
        <div class="text-sm text-muted" style="margin-top:4px;max-width:70ch">Create a deploy user: a non-root account with passwordless sudo and Docker access, logged in with an SSH key that DockGate generates. Password login stays on until you turn it off yourself.</div>
      </div>
      <button class="btn btn-primary" data-wizard>${Icons.key || ''} Create deploy user</button>
    </div>` : ''}
    <div class="card" style="margin-bottom:16px">
      <div class="flex justify-between items-center" style="margin-bottom:10px">
        <div style="font-size:15px;font-weight:700">Security status</div>${secPill(worst)}
      </div>
      <div class="grid-3" style="gap:10px">
        ${data.checks.map(c => `
          <div style="border:1px solid var(--border);border-left:3px solid ${SEC_LEVEL[c.level].color};border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;min-width:0">
            <div class="flex justify-between items-center" style="gap:6px"><span class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em;font-weight:600">${escapeHtml(c.label)}</span><span style="width:8px;height:8px;border-radius:50%;background:${SEC_LEVEL[c.level].color};flex:none"></span></div>
            <div class="text-sm" style="font-weight:500">${escapeHtml(c.value)}</div>
            ${c.action ? `<button class="btn btn-xs btn-ghost" data-go="${c.action}" style="align-self:flex-start;padding-left:0;color:var(--accent)">${go[c.action]} →</button>` : ''}
          </div>`).join('')}
      </div>
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
  const lockNote = locked ? `<div class="text-xs" style="color:var(--warning);margin-top:8px">Needs a deploy user with a verified SSH key first. <a href="#" data-wizard style="color:var(--accent)">Create deploy user</a></div>` : '';
  const rootOpts = [['yes', 'Allowed'], ['prohibit-password', 'Key only'], ['no', 'Blocked']];

  container.innerHTML = `
    <div data-sshbar style="margin-bottom:16px"></div>
    ${a.legacyFile ? '<div class="insight-card info" style="margin-bottom:16px">Settings from the old /etc/ssh/sshd_config.d/99-dockgate.conf are shown below and move into DockGate\'s single file (10-dockgate-access.conf) on the next save.</div>' : ''}
    ${a.includesDropins === false ? `<div class="insight-card warning" style="margin-bottom:16px">/etc/ssh/sshd_config does not include sshd_config.d/*.conf, so DockGate cannot change SSH settings. Add "Include /etc/ssh/sshd_config.d/*.conf" at the top of that file first.</div>` : ''}
    <div class="card" style="margin-bottom:16px">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:12px">
        <div style="min-width:0">
          <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em;font-weight:600">DockGate's connection</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${secMono(a.connection.user + '@' + a.connection.host + ':' + (a.connection.port || a.sshPort))}</div>
          <div class="text-sm text-muted" style="margin-top:2px">${a.connection.auth === 'key' ? 'SSH key · verified' : 'Password'}</div>
        </div>
        <div style="min-width:0">
          <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em;font-weight:600">Host key</div>
          ${hk.pinned ? `<div style="margin-top:2px">${secMono(hk.type + ' ' + hk.fingerprint)}</div>
          <div class="text-xs" style="color:var(--success);margin-top:2px">● Pinned ${escapeHtml(hk.pinnedAt || '')} — DockGate refuses to connect if it changes <a href="#" data-retrust style="color:var(--accent);margin-left:6px">Re-trust…</a></div>` : '<div class="text-sm text-muted" style="margin-top:2px">Not pinned yet — pinned on the next connection</div>'}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card" style="border-left:3px solid ${a.rootLogin === 'yes' ? 'var(--danger)' : a.rootLogin === 'no' ? 'var(--success)' : 'var(--warning)'}">
        <div class="flex justify-between items-center"><div style="font-weight:700;font-size:15px">Root SSH login</div>${secMono('PermitRootLogin ' + a.rootLogin)}</div>
        <div class="text-sm text-muted" style="margin-top:4px">Who can log in as root over SSH. Blocking it does not remove root — sudo still works.</div>
        <div class="tab-bar" data-root style="margin-top:12px">${rootOpts.map(([v, l]) => `<button class="tab-btn ${a.rootLogin === v ? 'active' : ''}" type="button" data-v="${v}" ${locked && v !== 'yes' ? 'disabled style="opacity:.45;cursor:not-allowed"' : ''}>${l}</button>`).join('')}</div>
        ${lockNote}
      </div>

      <div class="card" style="border-left:3px solid ${a.passwordAuth ? 'var(--warning)' : 'var(--success)'}">
        <div class="flex justify-between items-center"><div style="font-weight:700;font-size:15px">Password login</div>${secMono('PasswordAuthentication ' + (a.passwordAuth ? 'yes' : 'no'))}</div>
        <div class="text-sm text-muted" style="margin-top:4px">${a.passwordAuth ? 'Anyone can try passwords against this server. With keys only, guessing is useless.' : 'Only SSH keys can log in.'}</div>
        <div class="flex items-center gap-2" style="margin-top:12px;flex-wrap:wrap">
          ${a.passwordAuth
            ? `<button class="btn btn-sm btn-danger" data-pw="off" ${locked ? 'disabled' : ''}>Disable password login</button>`
            : `<button class="btn btn-sm btn-secondary" data-pw="on">Re-enable password login</button>`}
          <span class="text-xs text-muted">Users with keys: ${a.keyHolders.length ? a.keyHolders.map(escapeHtml).join(', ') : 'none'}</span>
        </div>
        ${a.passwordAuth ? lockNote : ''}
      </div>

      <div class="card">
        <div class="flex justify-between items-center"><div style="font-weight:700;font-size:15px">SSH port</div>${secMono('Port ' + a.sshPort)}</div>
        <div class="text-sm text-muted" style="margin-top:4px">The new port is opened in the firewall first. The old one closes only after DockGate has logged in on the new port.</div>
        <form data-port class="flex items-center gap-1" style="margin-top:12px">
          <input class="input" id="acc-port" type="number" min="1" max="65535" value="${a.sshPort}" style="width:120px">
          <button class="btn btn-sm btn-primary" type="submit">Change port</button>
        </form>
      </div>

      <div class="card">
        <div style="font-weight:700;font-size:15px">Hardening</div>
        <div class="text-sm text-muted" style="margin-top:4px">Written to <span class="td-mono">/etc/ssh/sshd_config.d/10-dockgate-access.conf</span>. The main sshd_config is never edited.</div>
        <form data-hard style="margin-top:8px">
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Max auth tries</div><div class="settings-row-desc">Attempts per connection before it is dropped</div></div><input class="input" id="acc-tries" type="number" min="1" max="10" value="${a.maxAuthTries}" style="width:80px"></div>
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Login grace time (seconds)</div><div class="settings-row-desc">Time allowed to finish logging in</div></div><input class="input" id="acc-grace" type="number" min="10" max="600" value="${a.loginGraceTime}" style="width:80px"></div>
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Dead connection timeout (minutes)</div><div class="settings-row-desc">Drops a connection whose client stopped answering (network gone, laptop asleep). It does NOT log out an idle but open terminal. 0 = off</div></div><input class="input" id="acc-dead" type="number" min="0" max="240" value="${a.deadTimeoutMin}" style="width:80px"></div>
          <div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">Idle session timeout (minutes)</div><div class="settings-row-desc">${a.supportsIdleTimeout ? 'Closes a session with no input or output for this long (ChannelTimeout). 0 = off' : `Needs OpenSSH 9.2+ — this server runs ${escapeHtml(a.sshVersion || 'an older version')}`}</div></div><input class="input" id="acc-idle" type="number" min="0" max="1440" value="${a.idleTimeoutMin || 0}" style="width:80px" ${a.supportsIdleTimeout ? '' : 'disabled'}></div>
          <div class="settings-row" style="padding:8px 0;border-bottom:0"><div><div class="settings-row-label">X11 forwarding</div><div class="settings-row-desc">Not needed on servers</div></div><div class="toggle ${a.x11 ? 'active' : ''}" id="acc-x11" role="switch" tabindex="0" aria-checked="${a.x11}"></div></div>
          <button class="btn btn-sm btn-primary" type="submit" style="margin-top:8px">Save hardening</button>
        </form>
      </div>
    </div>`;

  renderServiceBar(serverId, 'ssh-hardening', container.querySelector('[data-sshbar]'), { label: 'SSH server (sshd)', note: 'Reload applies config changes without closing open sessions.' });
  const rawEl = document.createElement('div'); rawEl.style.marginTop = '16px'; container.appendChild(rawEl);
  renderRawConfig(serverId, 'ssh-hardening', '/etc/ssh/sshd_config.d/10-dockgate-access.conf', rawEl, { label: 'DockGate sshd drop-in', high: true });
  container.querySelector('[data-retrust]')?.addEventListener('click', (e) => { e.preventDefault(); confirmRetrust(serverId, reload); });
  container.querySelectorAll('[data-wizard]').forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); openDeployUserWizard(serverId, () => Router.navigate('server-console', { id: serverId, tab: 'access' })); }));

  const apply = async (setting, value, title, successText) => {
    try {
      const { jobId } = await API.post(`/servers/${serverId}/access`, { setting, value, confirm: true });
      const ok = await runLifelineJob(serverId, jobId, title, { successText });
      if (ok) showToast(`${title}: saved`);
      reload();
    } catch (e) { showToast(e.message, 'error', 7000); }
  };

  container.querySelector('[data-root]').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn'); if (!b || b.disabled || b.classList.contains('active')) return;
    const v = b.dataset.v;
    const txt = { yes: 'root can log in with a password or a key', 'prohibit-password': 'root can log in with an SSH key only', no: 'nobody can log in as root over SSH' };
    secConfirm({
      title: v === 'yes' ? 'Allow root SSH login' : 'Restrict root SSH login',
      change: `<span class="td-mono">PermitRootLogin ${v}</span> — ${txt[v]}.`,
      protects: `DockGate keeps its own connection as <b>${escapeHtml(a.connection.user)}</b> and tests a fresh login before saving. If that fails, the server restores the old setting after 120 s.`,
      undo: 'Pick another option here at any time.',
      danger: v !== 'yes', confirmLabel: v === 'yes' ? 'Allow' : 'Apply',
      onConfirm: () => apply('rootLogin', v, 'Root SSH login', `Root SSH login is now "${b.textContent}".`),
    });
  });

  container.querySelector('[data-pw]')?.addEventListener('click', (e) => {
    const off = e.currentTarget.dataset.pw === 'off';
    secConfirm({
      title: off ? 'Disable password login' : 'Re-enable password login',
      change: off ? '<span class="td-mono">PasswordAuthentication no</span> and <span class="td-mono">KbdInteractiveAuthentication no</span>. Only SSH keys will work.' : '<span class="td-mono">PasswordAuthentication yes</span>. Passwords will work again.',
      protects: off ? `These users can still log in with a key: <b>${a.keyHolders.map(escapeHtml).join(', ')}</b>. DockGate tests a new key login before saving; if it fails, the server rolls back after 120 s.` : 'No lockout risk.',
      undo: off ? 'Re-enable it here. If you lose every key, use your provider\'s web console.' : 'Disable it here again.',
      danger: off, confirmLabel: off ? 'Disable password login' : 'Re-enable',
      onConfirm: () => apply('passwordAuth', !off, 'Password login', off ? 'Password login is off. Only SSH keys can log in now.' : 'Password login is on again.'),
    });
  });

  container.querySelector('[data-port]').addEventListener('submit', (e) => {
    e.preventDefault();
    const port = Number(container.querySelector('#acc-port').value);
    if (port === a.sshPort) return;
    secConfirm({
      title: `Move SSH to port ${port}`,
      change: `sshd listens on <b>${port}</b> instead of <b>${a.sshPort}</b>.`,
      protects: `Port ${port} is opened in the firewall first. Port ${a.sshPort} closes only after DockGate logs in on ${port}. Rollback after 120 s if anything fails.`,
      undo: `Change it back here. Update your own ssh config / client to use port ${port}.`,
      onConfirm: () => apply('sshPort', port, 'SSH port', `SSH now listens on ${port}.`),
    });
  });

  const x11 = container.querySelector('#acc-x11');
  const flip = () => { x11.classList.toggle('active'); x11.setAttribute('aria-checked', x11.classList.contains('active')); };
  x11.addEventListener('click', flip);
  x11.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  container.querySelector('[data-hard]').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = { maxAuthTries: Number(container.querySelector('#acc-tries').value), loginGraceTime: Number(container.querySelector('#acc-grace').value), deadTimeoutMin: Number(container.querySelector('#acc-dead').value), idleTimeoutMin: Number(container.querySelector('#acc-idle').value) || 0, x11: x11.classList.contains('active') };
    apply('hardening', value, 'SSH hardening', 'Hardening saved.');
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
  const yes = (on) => on ? '<span style="color:var(--success)">● yes</span>' : '<span class="text-muted">○ no</span>';

  container.innerHTML = `
    <div class="flex justify-between items-center mb-2" style="flex-wrap:wrap;gap:8px">
      <div><div style="font-size:15px;font-weight:700">Users</div><div class="text-xs text-muted">Human accounts (UID ≥ 1000) and root. DockGate connects as <b>${escapeHtml(d.connectionUser)}</b>.</div></div>
      <button class="btn btn-sm btn-primary" data-add>+ Add user</button>
    </div>
    <div class="table-wrapper"><table>
      <thead><tr><th>User</th><th>Sudo</th><th>Docker</th><th>SSH keys</th><th>Password login</th><th>Last login</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${d.users.map(u => `
        <tr style="${u.locked ? 'opacity:.55' : ''}">
          <td class="td-name"><div style="font-weight:600">${escapeHtml(u.name)} ${u.isConnection ? '<span class="badge" style="background:var(--accent-dim);color:var(--accent);margin-left:4px">DockGate</span>' : ''}${u.locked ? ' <span class="badge badge-stopped" style="margin-left:4px">locked</span>' : ''}</div><div class="text-xs text-muted td-mono">uid ${u.uid} · ${escapeHtml(u.home)}</div></td>
          <td>${yes(u.sudo)}</td><td>${yes(u.docker)}</td>
          <td>${u.keys.length ? `<span>${u.keys.length} key${u.keys.length > 1 ? 's' : ''}</span>` : '<span style="color:var(--warning)">none</span>'}</td>
          <td>${u.uid === 0 ? '<span class="text-xs text-muted">see Access &amp; SSH</span>' : (d.passwordAuth && u.passwordLogin ? '<span style="color:var(--warning)">allowed</span>' : '<span class="text-muted">off</span>')}</td>
          <td class="text-xs text-muted">${escapeHtml(u.lastLogin || '—')}</td>
          <td style="text-align:right"><div style="display:inline-flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end">
            <button class="btn btn-xs btn-secondary" data-keys="${escapeHtml(u.name)}">${Icons.key || ''} Keys</button>
            ${u.uid === 0 ? '' : `<button class="btn btn-xs btn-secondary" data-edit="${escapeHtml(u.name)}">Permissions</button>
            <button class="btn btn-xs btn-secondary" data-lock="${escapeHtml(u.name)}" ${u.isConnection ? 'disabled title="DockGate connects as this user"' : ''}>${u.locked ? 'Unlock' : 'Lock'}</button>
            <button class="btn btn-xs btn-danger" data-del="${escapeHtml(u.name)}" ${u.isConnection ? 'disabled title="DockGate connects as this user"' : ''}>${Icons.trash || 'Delete'}</button>`}
          </div></td>
        </tr>`).join('')}</tbody>
    </table></div>
    <div class="text-xs text-muted" style="margin-top:8px">Protected: the user DockGate connects as cannot be locked or deleted, the last sudo user keeps sudo, and the last key cannot be removed while password login is off.</div>`;

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

// ============================================================
// Firewall tab
// ============================================================
async function renderFirewallPanel(serverId, container) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let f;
  try { f = await API.get(`/servers/${serverId}/firewall`); }
  catch (e) { return secError(container, "Couldn't read the firewall", e, () => renderFirewallPanel(serverId, container)); }
  const reload = () => renderFirewallPanel(serverId, container);
  const bypass = f.ports.filter(p => p.exposure === 'bypass');
  const EXPO = {
    public:     ['var(--warning)', 'Public'],
    restricted: ['var(--accent)', 'Restricted'],
    internal:   ['var(--success)', 'Internal only'],
    local:      ['var(--text-muted)', 'This server only'],
    bypass:     ['var(--danger)', 'Public · bypasses UFW'],
  };
  const statCard = (label, value, sub) => `<div class="card"><div class="text-xs text-muted" style="text-transform:uppercase;font-weight:600;letter-spacing:.04em">${label}</div><div style="font-weight:700;margin-top:4px">${value}</div><div class="text-xs text-muted">${sub}</div></div>`;
  const sshRule = (r) => { const m = /^(\d+)(\/tcp)?$/.exec(r.to); return m && Number(m[1]) === f.sshPort && r.dir === 'IN' && r.action !== 'DENY' && !r.v6; };

  let banner = '';
  if (!f.active) {
    banner = `<div class="card" style="border-left:3px solid var(--danger);margin-bottom:16px"><div class="flex justify-between items-center" style="gap:12px;flex-wrap:wrap"><div style="min-width:0;flex:1"><div style="font-weight:700;font-size:15px;color:var(--danger)">The firewall is off — every listening port is reachable from the internet</div><div class="text-sm text-muted" style="margin-top:4px">Turning it on blocks all incoming traffic except SSH (${f.sshPort}/tcp) and, if you keep them, 80 and 443. DockGate tests a new SSH login and switches it off again by itself if that fails.</div></div><button class="btn btn-danger" data-ufwon>Turn the firewall on</button></div></div>`;
  } else if (!f.ufwActive) {
    banner = `<div class="insight-card info" style="margin-bottom:16px">This server uses firewalld. Port rules and Docker port isolation here work with UFW; manage firewalld ports in Services → Firewall.</div>`;
  } else if (!f.dockerIsolation && bypass.length) {
    banner = `
    <div class="card" style="border-left:3px solid var(--danger);margin-bottom:16px">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:12px">
        <div style="min-width:0;flex:1">
          <div style="font-weight:700;font-size:15px;color:var(--danger)">${bypass.length} container port${bypass.length === 1 ? ' is' : 's are'} open to the internet despite UFW</div>
          <div class="text-sm text-muted" style="margin-top:4px;max-width:72ch">Docker writes its own iptables rules, so ports published with <span class="td-mono">-p</span> skip UFW entirely. Turn on Docker port isolation: containers keep talking to each other and to this server, but only the ports you choose are reachable from outside.</div>
        </div>
        <button class="btn btn-danger" data-iso>Turn on Docker port isolation</button>
      </div>
    </div>`;
  }

  container.innerHTML = `
    <div class="flex gap-1 items-start" style="margin-bottom:12px;flex-wrap:wrap"><div data-ufwbar style="flex:1;min-width:280px"></div>${f.ufwActive ? '<button class="btn btn-sm btn-secondary" data-ufwreload style="margin-top:6px">Reload rules</button>' : ''}</div>
    ${banner}
    <div class="grid-4" style="margin-bottom:16px">
      ${statCard('Firewall', f.active ? '<span style="color:var(--success)">● Active</span>' : '<span style="color:var(--danger)">○ Inactive</span>', escapeHtml(f.backend === 'none' ? 'not installed' : f.backend.toUpperCase()) + (f.ufwActive ? ' · <a href="#" data-ufwoff style="color:var(--danger)">turn off</a>' : ''))}
      ${statCard('Incoming', f.active ? 'Deny by default' : 'Allow all', 'Outgoing: allow')}
      ${statCard('Docker ports', f.dockerIsolation ? '<span style="color:var(--success)">● Isolated</span>' : (f.ufwActive ? '<span style="color:var(--danger)">● Bypass UFW</span>' : '—'), f.dockerIsolation ? `DOCKER-USER chain · <a href="#" data-iso-off style="color:var(--accent)">turn off</a>` : 'DOCKER-USER chain')}
      ${statCard('SSH', `${f.sshPort}/tcp`, 'Always kept open')}
    </div>

    <div class="flex justify-between items-center mb-2"><div style="font-size:15px;font-weight:700">Listening ports</div><span class="text-xs text-muted">What is reachable from where (IPv4)</span></div>
    <div class="table-wrapper" style="margin-bottom:20px"><table>
      <thead><tr><th>Port</th><th>Used by</th><th>Listens on</th><th>Reachable from</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${f.ports.length ? f.ports.map(p => {
        const [col, lbl] = EXPO[p.exposure] || ['var(--text-muted)', p.exposure];
        const key = p.port + '/' + p.proto;
        let act = '';
        if (p.exposure === 'local') act = '<span class="text-xs text-muted">bound to localhost</span>';
        else if (p.isSsh) act = '<span class="text-xs text-muted">managed in Access &amp; SSH</span>';
        else if (!f.ufwActive) act = '<span class="text-xs text-muted">needs UFW</span>';
        else if (p.exposure === 'bypass') act = '<span class="text-xs text-muted">turn on isolation first</span>';
        else if (p.exposure === 'internal') act = `<button class="btn btn-xs btn-primary" data-open="${key}">Open to internet</button> <button class="btn btn-xs btn-secondary" data-restrict="${key}">Allow one IP…</button>`;
        else act = `<button class="btn btn-xs btn-secondary" data-close="${key}">Close</button>`;
        return `<tr>
          <td class="td-mono" style="font-weight:600">${key}</td>
          <td><div>${escapeHtml(p.usedBy)}</div><div class="text-xs text-muted">${p.kind === 'container' ? 'container · ' + escapeHtml(p.container) + (p.containerPort && p.containerPort !== p.port ? ' · inside :' + p.containerPort : '') : 'host process'}</div></td>
          <td class="td-mono text-xs">${escapeHtml(p.bind)}</td>
          <td><span style="color:${col};font-weight:600;font-size:13px">● ${lbl}</span>${p.restrictedTo ? `<div class="text-xs text-muted td-mono">${escapeHtml(p.restrictedTo)}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">${act}</td>
        </tr>`; }).join('') : '<tr><td colspan="5" class="text-sm text-muted">No listening ports found (ss / netstat unavailable?)</td></tr>'}</tbody>
    </table></div>

    ${f.ufwActive ? `
    <div class="grid-2">
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">UFW rules</div>
        <div class="table-wrapper"><table>
          <thead><tr><th>#</th><th>To</th><th>Action</th><th>From</th><th></th></tr></thead>
          <tbody>${f.rules.length ? f.rules.map(r => `<tr>
            <td class="text-muted">${r.n}</td><td class="td-mono">${escapeHtml(r.to)}${r.v6 ? ' <span class="text-xs text-muted">v6</span>' : ''}</td>
            <td><span style="color:${r.action === 'ALLOW' || r.action === 'LIMIT' ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:12px">${escapeHtml(r.action + ' ' + r.dir)}</span></td>
            <td class="text-sm">${escapeHtml(r.from)}${r.note ? ` <span class="text-xs text-muted">· ${escapeHtml(r.note)}</span>` : ''}</td>
            <td style="text-align:right">${sshRule(r) ? '<span class="text-xs text-muted" title="Keeps SSH reachable">locked</span>' : (r.v6 ? '' : `<button class="btn btn-xs btn-danger" data-delrule="${r.n}">Delete</button>`)}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="text-sm text-muted">No rules</td></tr>'}</tbody>
        </table></div>
        <div class="text-xs text-muted" style="margin-top:6px">Deleting a rule also deletes its IPv6 twin.</div>
      </div>
      <div class="card" style="align-self:start">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">Add rule</div>
        <form data-rule style="display:grid;gap:10px">
          <div class="flex gap-1"><input class="input" id="fw-port" type="number" min="1" max="65535" placeholder="Port, e.g. 8443" style="flex:1"><select class="select" id="fw-proto" style="width:90px"><option>tcp</option><option>udp</option></select></div>
          <input class="input" id="fw-from" placeholder="From: any, or 198.51.100.24 / 10.0.0.0/24" value="any">
          <div class="tab-bar" id="fw-act"><button class="tab-btn active" type="button" data-a="allow">Allow</button><button class="tab-btn" type="button" data-a="deny">Deny</button></div>
          <button class="btn btn-sm btn-primary" type="submit">Add rule</button>
          <div data-err></div>
        </form>
      </div>
    </div>` : ''}`;

  renderServiceBar(serverId, 'firewall', container.querySelector('[data-ufwbar]'), { label: 'Firewall service', onChange: reload });
  if (f.backend === 'ufw') { const rawEl = document.createElement('div'); rawEl.style.marginTop = '16px'; container.appendChild(rawEl); renderRawConfig(serverId, 'firewall', '/etc/default/ufw', rawEl, { label: '/etc/default/ufw', high: true }); }
  // Warnings when a firewall change touched something it should not have (fail2ban bans, containers).
  const warnToast = (r) => (r && r.warnings || []).forEach(w => showToast(w, 'warning', 12000));
  container.querySelector('[data-ufwreload]')?.addEventListener('click', () => secConfirm({
    title: 'Reload firewall rules', confirmLabel: 'Reload',
    change: 'UFW re-reads its saved rules (including the Docker isolation rules).',
    protects: 'Open connections, including SSH, stay up. Afterwards DockGate checks that fail2ban still holds its bans and that no container stopped.',
    undo: 'Nothing to undo — the saved rules are applied as they are.',
    onConfirm: async () => {
      try { const r = await API.post(`/servers/${serverId}/firewall/reload`, { confirm: true }); showToast('Firewall reloaded'); warnToast(r); reload(); } catch (e) { showToast(e.message, 'error', 8000); }
    },
  }));
  container.querySelector('[data-ufwon]')?.addEventListener('click', () => {
    const m = showModal('Turn the firewall on', `
      ${serverContextBanner()}
      <div class="detail-grid" style="grid-template-columns:1fr;gap:10px">
        <div class="detail-item"><div class="detail-label">What changes</div><div class="detail-value" style="white-space:normal;word-break:normal">UFW is switched on: incoming connections are blocked unless a rule allows them. Outgoing traffic is not affected.</div></div>
        <div class="detail-item"><div class="detail-label">What protects you</div><div class="detail-value" style="white-space:normal;word-break:normal">SSH (${f.sshPort}/tcp) is allowed before switching on. DockGate then opens a new SSH login; if it fails, the firewall is switched off again (and on the server itself after 120 s if DockGate loses contact).</div></div>
        <div class="detail-item"><div class="detail-label">How to undo</div><div class="detail-value" style="white-space:normal;word-break:normal">"turn off" next to the firewall state on this page.</div></div>
      </div>
      <label class="flex items-center gap-2" style="margin-top:12px"><input type="checkbox" id="ufw-web" checked> Keep web traffic open (80/tcp, 443/tcp)</label>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-danger'; ok.textContent = 'Turn on';
    footer.append(c, ok);
    ok.onclick = async () => {
      const allowWeb = m.overlay.querySelector('#ufw-web').checked;
      m.close();
      try {
        const { jobId } = await API.post(`/servers/${serverId}/firewall/ufw`, { enable: true, allowWeb, confirm: true });
        if (jobId) { const okk = await runLifelineJob(serverId, jobId, 'Switch the firewall on'); if (okk) showToast('Firewall on'); }
        reload();
      } catch (e) { showToast(e.message, 'error', 8000); }
    };
  });
  container.querySelector('[data-ufwoff]')?.addEventListener('click', (e) => {
    e.preventDefault();
    secConfirm({
      title: 'Turn the firewall off', danger: true, confirmLabel: 'Turn off',
      change: 'UFW is switched off. Every listening port becomes reachable from the internet; Docker port isolation stops working.',
      protects: 'Nothing is locked out by this — SSH stays reachable. fail2ban bans and running containers are checked afterwards.',
      undo: 'Turn the firewall on again here; your rules are kept.',
      onConfirm: async () => {
        try { const r = await API.post(`/servers/${serverId}/firewall/ufw`, { enable: false, confirm: true }); showToast('Firewall off', 'warning'); warnToast(r); reload(); }
        catch (er) { showToast(er.message, 'error', 8000); }
      },
    });
  });
  const runIsolation = async (enable, keepPublic) => {
    try {
      const { jobId } = await API.post(`/servers/${serverId}/firewall/docker-isolation`, { enable, keepPublic, confirm: true });
      const okk = await runLifelineJob(serverId, jobId, enable ? 'Docker port isolation' : 'Turn off Docker port isolation');
      if (okk) showToast(enable ? 'Docker port isolation on' : 'Docker port isolation off');
      reload();
    } catch (e) { showToast(e.message, 'error', 8000); }
  };
  // Isolation: list current bypassing ports and ask which stay public (default closed; web ports pre-ticked).
  container.querySelector('[data-iso]')?.addEventListener('click', () => {
    const m = showModal('Turn on Docker port isolation', `
      ${serverContextBanner()}
      <p class="text-sm" style="color:var(--text-secondary);margin-bottom:10px">After this, container ports are closed to the internet unless you open them. Inside the server nothing changes. Choose which of these currently public ports should <b>stay</b> public:</p>
      <div style="display:grid;gap:6px;margin-bottom:12px">${bypass.map(p => `<label class="flex items-center gap-2" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer"><input type="checkbox" value="${p.port}/${p.proto}" ${[80, 443].includes(p.port) ? 'checked' : ''}><span class="td-mono" style="font-weight:600;min-width:72px">${p.port}/${p.proto}</span><span class="text-sm">${escapeHtml(p.usedBy)}</span>${p.containerPort !== p.port ? `<span class="text-xs text-muted">→ :${p.containerPort}</span>` : ''}</label>`).join('')}</div>
      <div class="text-xs text-muted">Web traffic (80/443) is ticked by default. Databases and dashboards should usually stay closed. IPv6 is not covered by these rules.</div>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-danger'; ok.textContent = 'Turn on isolation';
    footer.append(c, ok);
    ok.onclick = () => { const keep = [...m.overlay.querySelectorAll('input[type=checkbox]:checked')].map(x => x.value); m.close(); runIsolation(true, keep); };
  });
  container.querySelector('[data-iso-off]')?.addEventListener('click', (e) => {
    e.preventDefault();
    secConfirm({ title: 'Turn off Docker port isolation', change: 'The DOCKER-USER rules are removed. Every published container port becomes reachable from the internet again.', protects: 'SSH is tested with a new connection; on failure the previous rules come back.', undo: 'Turn isolation on again here.', danger: true, confirmLabel: 'Turn off', onConfirm: () => runIsolation(false, []) });
  });

  const expose = async (key, open, scope, ip) => {
    const [port, proto] = key.split('/');
    const r = await API.post(`/servers/${serverId}/firewall/expose`, { port: Number(port), proto, open, scope, ip });
    showToast(open ? `${key} opened${scope === 'ip' ? ' for ' + ip : ''}` : `${key} closed`);
    warnToast(r);
    reload();
  };
  const tryExpose = (...a) => expose(...a).catch(e => showToast(e.message, 'error', 8000));
  container.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Open ${b.dataset.open} to the internet`, confirmLabel: 'Open',
    change: 'A firewall rule lets anyone on the internet reach this port.',
    protects: 'Only this port is opened. fail2ban bans and running containers are checked afterwards.',
    undo: '"Close" on the same row.',
    onConfirm: () => tryExpose(b.dataset.open, true, 'any'),
  })));
  container.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Close ${b.dataset.close}`, danger: true, confirmLabel: 'Close',
    change: 'The rule that opens this port is removed. It stays reachable inside the server, but not from outside.',
    protects: 'The SSH port cannot be closed here. fail2ban bans and running containers are checked afterwards.',
    undo: '"Open to internet" on the same row.',
    onConfirm: () => tryExpose(b.dataset.close, false),
  })));
  container.querySelectorAll('[data-restrict]').forEach(b => b.addEventListener('click', () => {
    const m = showModal(`Allow one IP · ${b.dataset.restrict}`, `<label class="text-sm" for="fw-ip" style="font-weight:600;display:block;margin-bottom:4px">IP address or range</label><input class="input" id="fw-ip" placeholder="198.51.100.24 or 10.0.0.0/24" style="font-family:var(--font-mono);width:100%"><div data-err style="margin-top:8px"></div>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Allow';
    footer.append(c, ok);
    ok.onclick = async () => {
      const ip = m.overlay.querySelector('#fw-ip').value.trim();
      try { await expose(b.dataset.restrict, true, 'ip', ip); m.close(); }
      catch (e) { m.overlay.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
    };
  }));
  container.querySelectorAll('[data-delrule]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Delete rule #${b.dataset.delrule}`, danger: true, confirmLabel: 'Delete rule',
    change: 'The rule (and its IPv6 twin) is removed from UFW immediately.',
    protects: 'The rule that keeps SSH reachable cannot be deleted. fail2ban bans and running containers are checked afterwards.',
    undo: 'Add the same rule again with "Add rule".',
    onConfirm: async () => {
      try { const r = await API.del(`/servers/${serverId}/firewall/rules/${b.dataset.delrule}`); showToast('Rule deleted'); warnToast(r); reload(); } catch (e) { showToast(e.message, 'error', 8000); }
    },
  })));
  let action = 'allow';
  container.querySelector('#fw-act')?.addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (!b) return; action = b.dataset.a; container.querySelectorAll('#fw-act .tab-btn').forEach(x => x.classList.toggle('active', x === b)); });
  container.querySelector('[data-rule]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { port: Number(container.querySelector('#fw-port').value), proto: container.querySelector('#fw-proto').value, from: container.querySelector('#fw-from').value.trim() || 'any', action };
    try { const r = await API.post(`/servers/${serverId}/firewall/rules`, body); showToast('Rule added'); warnToast(r); reload(); }
    catch (er) { container.querySelector('[data-rule] [data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(er.message)}</div>`; }
  });
}
