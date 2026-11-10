// Servers section (route key 'infra'): Servers · SSH keys · Edge agent, chosen in the sidebar.
// Registries moved to Deploy and Cleanup to Resources → Prune; their old links are redirected by Router.resolve.
Router.register('infra', async (content, params) => {
  const pageNavId = Router._navId;

  // The sidebar lists Servers · SSH keys · Edge agent, so the page has no tab bar of its own.
  content.innerHTML = `<div id="infra-tab-content"></div>`;
  const tabContent = document.getElementById('infra-tab-content');
  const validTabs = ['servers', 'sshkeys', 'agent'];
  const activeTab = (params && validTabs.includes(params.tab)) ? params.tab : 'servers';

  function renderTab(tab) {
    if (tab === 'servers') renderServers();
    else if (tab === 'sshkeys') renderSshKeysInto(tabContent, { embedded: true });   // moved here from Settings
    else if (tab === 'agent') renderEdgeAgentInto(tabContent);                        // moved here from Settings → Notifications
  }

  // ==================== SERVERS SUB-TAB — list like DigitalOcean Droplets / Hetzner Servers ====================
  // One table; the name opens the Server Console (where Settings holds edit / remove / Docker access).
  // "Add server" is a 4-step wizard: connection → login → verify (host key shown) → details.
  async function renderServers() {
    tabContent.innerHTML = '<div class="skeleton" style="height:120px;width:100%"></div>';
    try {
      const [data, ov] = await Promise.all([API.get('/servers'), API.get('/servers/overview').catch(() => ({ servers: {} }))]);
      renderServersList(data, ov.servers || {});
    } catch (e) { tabContent.innerHTML = UI.errorState(e); }
  }

  function renderServersList(data, overview = {}) {
    const bar = (label, pct) => pct == null ? '' : `<div style="display:grid;grid-template-columns:30px 1fr 32px;align-items:center;gap:5px;font-size:10.5px;line-height:1.5"><span class="text-muted">${label}</span><div class="disk-bar" style="height:5px;margin:0"><div class="disk-bar-fill ${pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'}" style="width:${Math.min(100, pct)}%"></div></div><span style="text-align:right">${Math.round(pct)}%</span></div>`;
    const rows = data.servers.map(s => {
      const isLocal = s.id === 'local';
      const ov = overview[s.id] || {}, rd = ov.readiness || {}, ls = ov.lastStat;
      const login = isLocal ? '<span class="ui-sub">Docker socket</span>'
        : `${escapeHtml(s.username || '')} · ${s.authMode === 'key' ? 'SSH key' : s.authMode === 'password' ? 'password' : 'agent'}${s.username === 'root' ? ' ' + UI.pill('warn', 'root') : ''}${s.authMode === 'password' ? ' ' + UI.pill('warn', 'password') : ''}`;
      const setup = isLocal ? '<span class="ui-sub">—</span>' : !rd.scanned ? '<span class="ui-sub">not scanned</span>' : rd.dockerReady ? UI.pill('ok', 'Ready') : UI.pill('warn', 'Needs setup');
      const flags = [s.hasAccessPassword ? '<span title="An access password is needed to switch to this server">🔒</span>' : '', !isLocal && s.notifications_enabled === 0 ? UI.pill('off', 'alerts muted') : ''].filter(Boolean).join(' ');
      return { cells: [
        isLocal ? `<b>Local Docker</b><div class="ui-sub">this machine</div>`
          : `<a href="#" data-open="${escapeHtml(s.id)}" style="color:inherit;text-decoration:none"><b>${escapeHtml(s.name || s.id)}</b></a> ${flags}<div class="ui-sub td-mono">${escapeHtml(s.id)}</div>`,
        s.isActive ? UI.pill('info', 'In use') : '<span class="ui-sub">—</span>',
        isLocal ? '<span class="ui-sub">—</span>' : `<span class="td-mono text-xs">${escapeHtml(s.host)}:${s.port || 22}</span>`,
        login, setup,
        (isLocal || !ls) ? '<span class="ui-sub">—</span>' : `<div style="min-width:140px">${bar('CPU', ls.cpu)}${bar('RAM', ls.mem)}${bar('Disk', ls.disk)}</div>`,
        `${isLocal ? '' : UI.btn('Open', `data-open="${escapeHtml(s.id)}"`, 'btn-primary')}${s.isActive ? '' : UI.btn('Use', `data-use="${escapeHtml(s.id)}"`)}${UI.btn('Test', `data-test="${escapeHtml(s.id)}"`)}`,
      ] };
    });
    tabContent.innerHTML = `<div class="ui-page">${UI.header('', 'Every server DockGate manages. The one marked "In use" is the one the Docker pages show — switch it here or with the server picker in the header.', UI.primary('Add server', 'data-add'))}
      ${UI.table([{ label: 'Name' }, { label: 'Status' }, { label: 'Address' }, { label: 'Login' }, { label: 'Setup' }, { label: 'CPU · RAM · Disk' }, { label: '', align: 'right' }], rows, { minWidth: 860 })}
      <div class="ui-sub" style="margin-top:8px">Edit, remove and Docker access for a server are in its console → Settings.</div></div>`;
    tabContent.querySelector('[data-add]').onclick = () => openAddServerWizard();
    // Swarm → Nodes → Add to DockGate… opens the wizard with the node's address filled in.
    if (params && params.addHost && !renderServers.prefilled) { renderServers.prefilled = true; openAddServerWizard({ host: String(params.addHost) }); }
    tabContent.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('server-console', { id: b.dataset.open }); }));
    tabContent.querySelectorAll('[data-use]').forEach(b => b.onclick = async () => {
      const srv = data.servers.find(x => x.id === b.dataset.use);
      try {
        const ok = await useServer(srv.id);
        if (!ok) return;
        showToast(`Now using ${srv.name || srv.id}`);
        renderServers();
      } catch (e) { showToast(e.message, 'error'); }
    });
    tabContent.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Testing…';
      try { showServerTestResult(await API.post('/servers/test', { id: b.dataset.test, type: b.dataset.test === 'local' ? 'local' : 'ssh' })); }
      catch (e) { showToast(`✗ ${sshErrorHint(e.message)}`, 'error', 12000); }
      finally { b.disabled = false; b.textContent = 'Test'; }
    });
  }

  function openAddServerWizard(prefill = {}) {
    const st = { step: 0, name: '', id: '', idTouched: false, host: prefill.host || '', port: 22, username: 'root', auth: 'key', privateKey: '', passphrase: '', password: '', test: null, description: '', accessPassword: '', notifs: true };
    const STEPS = ['Connection', 'Login', 'Verify', 'Details'];
    const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const authBody = () => ({ type: 'ssh', host: st.host.trim(), port: Number(st.port) || 22, username: st.username.trim(), ...(st.auth === 'key' ? { privateKey: st.privateKey || undefined, passphrase: st.passphrase || undefined } : { password: st.password || undefined }) });
    const d = UI.dialog({ title: 'Add server', saveLabel: 'Next', wide: true, context: false, body: '<div data-wiz></div>', onSave: () => next() });
    const box = d.overlay.querySelector('[data-wiz]');
    const read = () => box.querySelectorAll('[data-k]').forEach(el => { st[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    function draw() {
      const steps = `<div class="flex gap-1" style="flex-wrap:wrap;margin-bottom:4px">${STEPS.map((l, i) => `<span class="ui-pill ${i === st.step ? 'ui-pill-info' : i < st.step ? 'ui-pill-ok' : 'ui-pill-off'}">${i < st.step ? '✓ ' : ''}${i + 1}. ${l}</span>`).join('')}</div>`;
      const views = [
        `<div class="ui-field"><label for="aw-name">Name</label><input class="input" id="aw-name" data-k="name" value="${escapeHtml(st.name)}" placeholder="Production web"></div>
         <div class="ui-field"><label for="aw-id">ID <span class="ui-sub" style="font-weight:400">· permanent, used in links</span></label><input class="input td-mono" id="aw-id" data-k="id" value="${escapeHtml(st.id)}" placeholder="prod-web"></div>
         <div class="ui-row"><div class="ui-field" style="flex:1;min-width:200px"><label for="aw-host">Host or IP</label><input class="input" id="aw-host" data-k="host" value="${escapeHtml(st.host)}" placeholder="203.0.113.10 or server.example.com"></div>
           <div class="ui-field"><label for="aw-port">Port</label><input class="input" id="aw-port" data-k="port" type="number" value="${escapeHtml(st.port)}" style="width:90px"></div>
           <div class="ui-field"><label for="aw-user">User</label><input class="input" id="aw-user" data-k="username" value="${escapeHtml(st.username)}" style="width:130px"></div></div>`,
        `<div class="ui-field"><span class="ui-label">How DockGate logs in</span><div class="ui-seg">${[['key', 'SSH key'], ['password', 'Password'], ['agent', 'SSH agent']].map(([v, l]) => `<button type="button" data-auth="${v}" aria-pressed="${st.auth === v}" ${v === 'agent' ? 'disabled title="Coming soon"' : ''}>${l}</button>`).join('')}</div></div>
         ${st.auth === 'key' ? `<div class="ui-field"><label for="aw-key">Private key</label><textarea class="input" id="aw-key" data-k="privateKey" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="font-family:var(--font-mono);font-size:11px;width:100%">${escapeHtml(st.privateKey)}</textarea></div>
           <div class="ui-field"><label for="aw-pp">Passphrase <span class="ui-sub" style="font-weight:400">· only if the key is encrypted</span></label><input class="input" id="aw-pp" data-k="passphrase" type="password" autocomplete="new-password" value="${escapeHtml(st.passphrase)}"></div>`
          : `<div class="ui-field"><label for="aw-pw">Password</label><input class="input" id="aw-pw" data-k="password" type="password" autocomplete="new-password" value="${escapeHtml(st.password)}"><span class="ui-help">Stored encrypted. A key is safer — after adding, DockGate can create a deploy user with a key and switch to it.</span></div>`}`,
        st.test ? (st.test.success ? `<div class="insight-card ${st.test.docker ? 'success' : 'warning'}"><div><b>SSH works.</b> ${st.test.docker ? `Docker ${escapeHtml(st.test.version)} · ${st.test.containers} containers.` : 'Docker is not installed yet — Setup installs it after adding.'}</div></div>
            ${st.test.hostKey ? `<div class="ui-field"><span class="ui-label">Server identity (host key)</span><div class="td-mono" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px">${escapeHtml(st.test.hostKey.type)} · ${escapeHtml(st.test.hostKey.fingerprint)}</div><span class="ui-help">Compare it with your provider's console (or <span class="td-mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</span> on the server). DockGate pins it, so a different key later is refused.</span></div>` : ''}`
          : `<div class="insight-card danger"><div><b>Could not connect.</b> ${escapeHtml(sshErrorHint(st.test.error || ''))}</div></div>${st.test.hostKey ? `<div class="ui-sub">The server presented ${escapeHtml(st.test.hostKey.type)} · <span class="td-mono">${escapeHtml(st.test.hostKey.fingerprint)}</span></div>` : ''}`)
          : '<div class="ui-sub">Connecting…</div>',
        `<div class="ui-field"><label for="aw-desc">Description</label><input class="input" id="aw-desc" data-k="description" value="${escapeHtml(st.description)}" placeholder="optional"></div>
         <div class="ui-field"><label for="aw-ap">Access password <span class="ui-sub" style="font-weight:400">· optional second password to switch to this server</span></label><input class="input" id="aw-ap" data-k="accessPassword" type="password" autocomplete="new-password" value="${escapeHtml(st.accessPassword)}"></div>
         <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-k="notifs" ${st.notifs ? 'checked' : ''}> Send alert notifications for this server</label>
         ${st.username === 'root' || st.auth === 'password' ? '<div class="insight-card warning"><div>DockGate will log in as <b>' + escapeHtml(st.username) + '</b>' + (st.auth === 'password' ? ' with a password' : '') + '. After adding it offers to create a deploy user (non-root, SSH key).</div></div>' : ''}`,
      ];
      box.innerHTML = `<div style="display:grid;gap:12px">${steps}${views[st.step]}</div>`;
      d.save.textContent = ['Next', 'Connect & check', st.test && st.test.success ? 'Trust and continue' : 'Try again', 'Add server'][st.step];
      d.save.disabled = st.step === 2 && !st.test;
      box.querySelector('#aw-name')?.addEventListener('input', (e) => { if (!st.idTouched) { const idEl = box.querySelector('#aw-id'); idEl.value = slug(e.target.value); } });
      box.querySelector('#aw-id')?.addEventListener('input', () => { st.idTouched = true; });
      box.querySelectorAll('[data-auth]').forEach(b => b.onclick = () => { read(); st.auth = b.dataset.auth; draw(); });
      const foot = d.overlay.querySelector('.modal-footer');
      let back = foot.querySelector('[data-back]');
      if (!back) { back = document.createElement('button'); back.className = 'btn btn-secondary'; back.dataset.back = '1'; back.textContent = 'Back'; back.onclick = () => { read(); st.step = Math.max(0, st.step - 1); if (st.step < 2) st.test = null; draw(); }; foot.insertBefore(back, d.save); }
      back.style.display = st.step ? '' : 'none';
    }
    async function runTest() {
      st.test = null; draw();
      try { st.test = await API.post('/servers/test', authBody()); }
      catch (e) { st.test = { success: false, error: e.message }; }
      draw();
    }
    async function next() {
      read();
      if (st.step === 0) {
        if (!st.host.trim() || !st.username.trim()) throw new Error('Host and user are required');
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(st.id || slug(st.name))) throw new Error('ID: letters, numbers, - and _ (it is used in links and cannot change later)');
        if (!st.id) st.id = slug(st.name);
        st.step = 1; draw(); return false;
      }
      if (st.step === 1) {
        if (st.auth === 'key' && !st.privateKey.trim()) throw new Error('Paste the private key');
        if (st.auth === 'password' && !st.password) throw new Error('Enter the password');
        st.step = 2; runTest(); return false;
      }
      if (st.step === 2) { if (!st.test || !st.test.success) { runTest(); return false; } st.step = 3; draw(); return false; }
      const body = { id: st.id, name: st.name.trim(), ...authBody(), description: st.description.trim(), accessPassword: st.accessPassword, notifications_enabled: st.notifs ? 1 : 0, hostKeyBlob: st.test && st.test.hostKey ? st.test.hostKey.blob : undefined };
      const added = await API.post('/servers', body);
      showToast(`Server "${st.name || st.id}" added`);
      if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
      renderServers();
      if (st.username === 'root' || added.authMode !== 'key') {
        setTimeout(() => showModal('Create a deploy user?', `<p class="text-sm" style="color:var(--text-secondary)">DockGate connects to <b>${escapeHtml(st.id)}</b> as <b>${escapeHtml(st.username)}</b>${added.authMode === 'key' ? ' with a key' : ' with a password'}. A deploy user is a non-root account with sudo and Docker access that DockGate logs in to with an SSH key it generates — the first step before turning off root and password login.</p><p class="text-xs text-muted" style="margin-top:8px">Nothing is locked down by this step. You can also do it later from the server's Overview.</p>`, [
          { label: 'Later', className: 'btn btn-secondary' },
          { label: 'Create deploy user', className: 'btn btn-primary', onClick: () => Router.navigate('server-console', { id: st.id, tab: 'overview', wizard: '1' }) },
        ]), 0);
      }
    }
    draw();
  }

  renderTab(activeTab);
});

// Pages hosted by the Deploy and Resources sections (tabbed-section.js invokes these handlers).
Router.register('registries', async (content) => renderRegistriesInto(content, { embedded: true }));
Router.register('prune', async (content) => renderCleanupInto(content, { embedded: true }));
Router.register('cleanup', async (content) => renderCleanupInto(content, { embedded: true }));

// Edge agent: installed per server, so it lives with the servers. Notifications links here.
async function renderEdgeAgentInto(el) {
  let configured = true;
  try {
    const [smtp, tg] = await Promise.all([API.get('/meta/smtp'), API.get('/meta/telegram')]);
    configured = !!(smtp.smtp_host || tg.tg_chat_id);
  } catch (e) { /* the agent table still loads; only the channel warning depends on this */ }
  el.innerHTML = edgeAgentSectionHtml(configured);
  attachEdgeAgentHandlers(el, true);
}

// Stage-1 SSH auth failures get an actionable hint ("usermod -aG docker" fixes the Docker stage, not this).
function sshErrorHint(msg) {
  return /authentication methods failed/i.test(String(msg))
    ? `${msg} → SSH login itself failed: check the user, that the public key is in that user's authorized_keys, and the key passphrase. ("usermod -aG docker" does NOT fix this — it is for the Docker-permission stage after login.)`
    : msg;
}
function showServerTestResult(r) {
  if (r.success && r.docker === false) showToast(`⚠ ${r.message || 'SSH OK — Docker not detected'}`, 'warning', 10000);
  else if (r.success) showToast(`✓ SSH OK · Docker ${r.version} (${r.containers} containers, ${r.images} images)`, 'success', 6000);
  else showToast(`✗ ${sshErrorHint(r.error)}`, 'error', 12000);
}
