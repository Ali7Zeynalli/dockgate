// Infrastructure Page — top-level section hosting Servers + Registries + Cleanup as sub-tabs.
// The Servers block was moved here from settings.js (Settings stays for app config only).
Router.register('infra', async (content, params) => {
  const pageNavId = Router._navId;

  content.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Infrastructure</div><div class="page-subtitle">Servers, registries & cleanup</div></div>
    </div>
    <div class="tab-bar" id="infra-tabs">
      <button class="tab-btn active" data-tab="servers">Servers</button>
      <button class="tab-btn" data-tab="registries">Registries</button>
      <button class="tab-btn" data-tab="cleanup">Cleanup</button>
    </div>
    <div id="infra-tab-content" style="padding-top:20px;"></div>
  `;

  const tabContent = document.getElementById('infra-tab-content');
  // Restore the active sub-tab from the URL params (deep-link / refresh / Back), default Servers.
  const validTabs = ['servers', 'registries', 'cleanup'];
  let activeTab = (params && validTabs.includes(params.tab)) ? params.tab : 'servers';
  document.querySelectorAll('#infra-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));

  document.getElementById('infra-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('#infra-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    renderTab(activeTab);
    // Sync the sub-tab into the URL hash so Back/Forward + refresh land on it.
    Router.updateParams({ tab: activeTab });
  });

  function renderTab(tab) {
    if (tab === 'servers') renderServers();
    else if (tab === 'registries') renderRegistriesInto(tabContent, { embedded: true });
    else if (tab === 'cleanup') renderCleanupInto(tabContent, { embedded: true });
  }

  // ==================== SERVERS SUB-TAB (SSH multi-host) ====================
  // Moved verbatim from settings.js; writes into tabContent (#infra-tab-content). User input is
  // escapeHtml()-sanitized. The 4 refreshServerSwitcher() calls are preserved (header SRV dropdown).
  async function renderServers() {
    const loading = document.createElement('div');
    loading.className = 'text-muted text-sm';
    loading.textContent = 'Loading servers...';
    tabContent.replaceChildren(loading);
    try {
      // Batched: the servers list + a DB-only overview (readiness + last metric) for per-row enrichment.
      const [data, ov] = await Promise.all([
        API.get('/servers'),
        API.get('/servers/overview').catch(() => ({ servers: {} })),
      ]);
      renderServersList(data, ov.servers || {});
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'text-xs text-danger';
      err.textContent = e.message;
      tabContent.replaceChildren(err);
    }
  }

  function renderServersList(data, overview = {}) {
    // Per-server readiness badge + mini health bars from the batched /overview (DB-only).
    const miniBar = (label, pct) => pct == null ? '' :
      `<div style="display:flex;align-items:center;gap:4px;font-size:10px;line-height:1.4"><span class="text-muted" style="width:26px">${label}</span><div class="disk-bar" style="flex:1;height:5px;margin:0"><div class="disk-bar-fill ${pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'}" style="width:${Math.min(100, pct)}%"></div></div><span style="width:30px;text-align:right">${Math.round(pct)}%</span></div>`;
    const rowsHtml = data.servers.map(s => {
      const isLocal = s.id === 'local';
      const activeBadge = s.isActive ? '<span class="badge badge-running">active</span>' : '';
      const hostStr = s.host ? `${escapeHtml(s.username || '')}@${escapeHtml(s.host)}:${s.port || 22}` : '—';
      let authBadge = '';
      if (s.hasKey) authBadge = '<span class="text-xs text-muted">🔑 key</span>';
      else if (s.hasPassword) authBadge = '<span class="text-xs text-muted">🔒 password</span>';
      else if (!isLocal) authBadge = '<span class="text-xs text-muted">📡 agent</span>';
      const ov = overview[s.id] || {}, rd = ov.readiness || {}, ls = ov.lastStat;
      let readyBadge = '<span class="text-xs text-muted">—</span>';
      if (!isLocal) readyBadge = !rd.scanned ? '<span class="text-xs text-muted">not scanned</span>'
        : rd.dockerReady ? '<span class="badge badge-running">ready</span>'
        : '<span class="badge badge-restarting">needs setup</span>';
      const health = (isLocal || !ls) ? '<span class="text-xs text-muted">—</span>'
        : `<div style="min-width:130px">${miniBar('CPU', ls.cpu)}${miniBar('MEM', ls.mem)}${miniBar('DSK', ls.disk)}</div>`;
      return `<tr>
          <td class="td-mono">${isLocal ? '🖥' : '🔐'} ${escapeHtml(s.id)}</td>
          <td class="text-xs">${escapeHtml(s.type)}</td>
          <td class="td-mono text-xs">${hostStr}</td>
          <td>${authBadge}</td>
          <td>${activeBadge}</td>
          <td>${readyBadge}</td>
          <td>${health}</td>
          <td>
            ${!s.isActive ? `<button class="btn btn-xs btn-secondary" data-action="activate" data-id="${escapeHtml(s.id)}">Use</button>` : ''}
            <button class="btn btn-xs btn-secondary" data-action="test" data-id="${escapeHtml(s.id)}">Test</button>
            ${!isLocal ? `<button class="btn btn-xs btn-primary" data-action="console" data-id="${escapeHtml(s.id)}" title="Open server console — Setup, Monitoring, Logs">Manage</button>` : ''}
            ${!isLocal ? `<button class="btn btn-xs btn-secondary" data-action="grant" data-id="${escapeHtml(s.id)}" title="Run sudo usermod -aG docker on the server (needs passwordless sudo)">Grant Docker</button>` : ''}
            ${!isLocal ? `<button class="btn btn-xs btn-secondary" data-action="edit" data-id="${escapeHtml(s.id)}">Edit</button>` : ''}
            ${!isLocal ? `<button class="btn btn-xs btn-ghost text-danger" data-action="delete" data-id="${escapeHtml(s.id)}">${Icons.trash}</button>` : ''}
          </td>
        </tr>`;
    }).join('');

    const html = `
      <div class="settings-section">
        <div class="settings-section-title">Docker Servers</div>
        <div class="text-muted text-sm" style="margin-bottom:12px;">
          Local Docker socket + uzaq SSH server-lər. Header-dəki SRV dropdown ilə dəyişir.
        </div>
        <div class="table-wrapper"><table>
          <thead><tr><th>ID</th><th>Type</th><th>Host</th><th>Auth</th><th>Status</th><th>Readiness</th><th>Health</th><th>Actions</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
      </div>
      <div class="settings-section" style="margin-top:20px;">
        <div class="settings-section-title">Add SSH Server</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <input class="input" id="srv-id" placeholder="ID (e.g. prod-1)" />
          <input class="input" id="srv-host" placeholder="Host (e.g. 1.2.3.4 or server.example.com)" />
          <input class="input" id="srv-user" placeholder="SSH user" value="root" />
          <input class="input" id="srv-port" type="number" placeholder="Port" value="22" />
        </div>

        <div class="tab-bar" id="auth-tabs" style="margin-bottom:8px;">
          <button class="tab-btn active" data-auth="key" type="button">🔑 Private Key</button>
          <button class="tab-btn" data-auth="password" type="button">🔒 Password</button>
          <button class="tab-btn" data-auth="agent" type="button">📡 SSH Agent <span style="font-size:10px;opacity:0.7;">· Coming Soon</span></button>
        </div>

        <div id="auth-key" class="auth-pane">
          <label class="text-xs text-muted" for="srv-key">Private key (paste OpenSSH format):</label>
          <textarea class="input" id="srv-key" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="font-family:var(--font-mono);font-size:11px;width:100%;margin-top:4px;"></textarea>
          <label class="text-xs text-muted" style="display:block;margin-top:8px;" for="srv-passphrase">Key passphrase (only if the key is encrypted — leave blank otherwise):</label>
          <input class="input" id="srv-passphrase" type="password" placeholder="passphrase (optional)" autocomplete="new-password" style="margin-top:4px;width:100%;" />
        </div>

        <div id="auth-password" class="auth-pane" style="display:none;">
          <label class="text-xs text-muted">SSH user şifrəsi (DB-də şifrli saxlanılır — yalnız trust edilən şəbəkədə):</label>
          <input class="input" id="srv-password" type="password" placeholder="••••••••" style="margin-top:4px;width:100%;" />
          <div class="text-xs text-muted" style="margin-top:6px;">⚠ Daha təhlükəsiz: Private Key istifadə edin</div>
        </div>

        <div id="auth-agent" class="auth-pane" style="display:none;">
          <div style="padding:12px 16px;background:var(--bg-primary);border:1px dashed var(--border);border-radius:var(--radius-md);">
            <div style="font-weight:600;margin-bottom:6px;">⏳ Coming Soon</div>
            <div class="text-xs text-muted" style="line-height:1.6;">
              SSH agent forwarding requires mounting <code>SSH_AUTH_SOCK</code> from the host into the DockGate container.
              Out-of-the-box this is not wired up yet — for now use <strong>Private Key</strong> or <strong>Password</strong>.
            </div>
          </div>
        </div>

        <input class="input" id="srv-desc" placeholder="Description (optional)" style="margin:8px 0;width:100%;" />
        <div class="text-xs text-muted" style="margin:0 0 8px">Docker access (usermod -aG docker) is handled by <b>Manage → Setup</b> per server (idempotent).</div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" id="srv-test-new">Test Connection</button>
          <button class="btn btn-primary btn-sm" id="srv-add">Add Server</button>
          <div id="srv-test-result" style="align-self:center;"></div>
        </div>
      </div>
    `;
    Object.assign(tabContent, { innerHTML: html });
    attachServerHandlers(data.servers);
  }

  // Stage-1 SSH auth failures get an actionable hint (usermod fixes stage 2, not this).
  function sshErrorHint(msg) {
    return /authentication methods failed/i.test(String(msg))
      ? `${msg} → SSH login itself failed: check the user (Coolify → usually root), that the public key is in that user's authorized_keys, and the key passphrase. ("usermod -aG docker" does NOT fix this — it's for the docker-permission stage after login.)`
      : msg;
  }

  function attachServerHandlers(servers = []) {
    let authMode = 'key';
    tabContent.querySelectorAll('#auth-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        authMode = btn.dataset.auth;
        tabContent.querySelectorAll('#auth-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tabContent.querySelectorAll('.auth-pane').forEach(p => p.style.display = 'none');
        const pane = document.getElementById(`auth-${authMode}`);
        if (pane) pane.style.display = '';
      });
    });

    tabContent.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { action, id } = btn.dataset;
        try {
          if (action === 'activate') {
            await API.post('/servers/active', { id });
            showToast(`Activated: ${id}`);
            if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
            renderServers();
          } else if (action === 'test') {
            const r = await API.post('/servers/test', { id });
            if (r.success) {
              showToast(`✓ ${r.version} (${r.containers} containers, ${r.images} images)`, 'success', 6000);
            } else {
              showToast(`✗ ${sshErrorHint(r.error)}`, 'error', 12000);
            }
          } else if (action === 'grant') {
            showConfirm('Grant Docker access', `Run <code>sudo usermod -aG docker</code> on <strong>${escapeHtml(id)}</strong>? Requires that the SSH user has passwordless sudo. Takes effect on the next connection.`, async () => {
              try {
                const r = await API.post(`/servers/${id}/grant-docker`, {});
                showToast(r.message || 'Docker access granted', 'success', 7000);
              } catch (e) { showToast(sshErrorHint(e.message), 'error', 10000); }
            });
          } else if (action === 'console') {
            Router.navigate('server-console', { id });
          } else if (action === 'edit') {
            const s = servers.find(x => x.id === id);
            if (s) openServerEditModal(s);
          } else if (action === 'delete') {
            showConfirm('Delete Server', `Server "${id}" silinsin? SSH key faylı da silinir.`, async () => {
              await API.del(`/servers/${id}`);
              showToast('Silindi');
              if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
              renderServers();
            }, true);
          }
        } catch (e) { showToast(e.message, 'error'); }
      });
    });

    function buildAuthBody() {
      const base = {
        host: document.getElementById('srv-host').value.trim(),
        port: parseInt(document.getElementById('srv-port').value) || 22,
        username: document.getElementById('srv-user').value.trim(),
      };
      if (authMode === 'key') {
        const k = document.getElementById('srv-key').value;
        if (k && k.trim()) base.privateKey = k;
        const ph = document.getElementById('srv-passphrase')?.value;
        if (ph) base.passphrase = ph;
      } else if (authMode === 'password') {
        const p = document.getElementById('srv-password').value;
        if (p) base.password = p;
      }
      return base;
    }

    document.getElementById('srv-test-new')?.addEventListener('click', async () => {
      const result = document.getElementById('srv-test-result');
      result.replaceChildren();
      const status = document.createElement('span');
      status.className = 'text-xs text-muted';
      status.textContent = 'Testing...';
      result.appendChild(status);
      try {
        const body = buildAuthBody();
        const r = await API.post('/servers/test', body);
        result.replaceChildren();
        const out = document.createElement('span');
        out.className = 'text-xs';
        if (r.success) {
          out.style.color = 'var(--success)';
          out.textContent = `✓ ${r.version} — ${r.containers} containers`;
        } else {
          out.style.color = 'var(--danger)';
          out.textContent = `✗ ${sshErrorHint(r.error)}`;
        }
        result.appendChild(out);
      } catch (e) {
        result.replaceChildren();
        const out = document.createElement('span');
        out.className = 'text-xs';
        out.style.color = 'var(--danger)';
        out.textContent = `✗ ${sshErrorHint(e.message)}`;
        result.appendChild(out);
      }
    });

    document.getElementById('srv-add')?.addEventListener('click', async () => {
      const id = document.getElementById('srv-id').value.trim();
      const description = document.getElementById('srv-desc').value.trim();
      const auth = buildAuthBody();
      if (!id || !auth.host || !auth.username) {
        showToast('ID, host və username tələb olunur', 'warning');
        return;
      }
      try {
        await API.post('/servers', { id, ...auth, description });
        showToast(`Server "${id}" (${authMode}) əlavə olundu`);
        if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
        renderServers();
      } catch (e) { showToast(e.message, 'error'); }
    });
  }

  // Edit an existing SSH server in a modal. ID is immutable (PK / URL param). Blank key/password keeps current.
  function openServerEditModal(s) {
    const body = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="text-xs text-muted">Editing <b>${escapeHtml(s.id)}</b> — the ID cannot be changed.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input class="input" id="esrv-host" placeholder="Host" value="${escapeHtml(s.host || '')}" />
          <input class="input" id="esrv-port" type="number" placeholder="Port" value="${s.port || 22}" />
          <input class="input" id="esrv-user" placeholder="SSH user" value="${escapeHtml(s.username || '')}" />
          <input class="input" id="esrv-desc" placeholder="Description" value="${escapeHtml(s.description || '')}" />
        </div>
        <div class="tab-bar" id="esrv-auth-tabs">
          <button class="tab-btn ${s.authMode !== 'password' ? 'active' : ''}" data-auth="key" type="button">🔑 Private Key</button>
          <button class="tab-btn ${s.authMode === 'password' ? 'active' : ''}" data-auth="password" type="button">🔒 Password</button>
        </div>
        <div id="esrv-pane-key" class="esrv-pane" style="display:${s.authMode !== 'password' ? 'block' : 'none'}">
          <label class="text-xs text-muted">New private key — leave blank to keep the current ${s.hasKey ? 'key' : 'auth'}:</label>
          <textarea class="input" id="esrv-key" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="font-family:var(--font-mono);font-size:11px;width:100%;margin-top:4px;"></textarea>
        </div>
        <div id="esrv-pane-password" class="esrv-pane" style="display:${s.authMode === 'password' ? 'block' : 'none'}">
          <label class="text-xs text-muted">New password — leave blank to keep the current one:</label>
          <input class="input" id="esrv-pass" type="password" placeholder="••••••••" style="width:100%;margin-top:4px;" />
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" id="esrv-test" type="button">Test Connection</button>
          <span id="esrv-test-result" class="text-xs"></span>
        </div>
        <div class="text-xs text-muted">Test verifies the saved server unless you enter a new key/password above.</div>
      </div>`;

    const m = showModal(`Edit server: ${escapeHtml(s.id)}`, body, []);
    const root = document.getElementById('modal-root');
    let authMode = s.authMode === 'password' ? 'password' : 'key';

    root.querySelectorAll('#esrv-auth-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        authMode = btn.dataset.auth;
        root.querySelectorAll('#esrv-auth-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        root.querySelector('#esrv-pane-key').style.display = authMode === 'key' ? 'block' : 'none';
        root.querySelector('#esrv-pane-password').style.display = authMode === 'password' ? 'block' : 'none';
      });
    });

    function buildEditBody() {
      const b = {
        host: root.querySelector('#esrv-host').value.trim(),
        port: parseInt(root.querySelector('#esrv-port').value) || 22,
        username: root.querySelector('#esrv-user').value.trim(),
        description: root.querySelector('#esrv-desc').value.trim(),
      };
      if (authMode === 'key') {
        const k = root.querySelector('#esrv-key').value;
        if (k && k.trim()) b.privateKey = k;
      } else {
        const p = root.querySelector('#esrv-pass').value;
        if (p) b.password = p;
      }
      return b;
    }

    root.querySelector('#esrv-test').addEventListener('click', async () => {
      const r = root.querySelector('#esrv-test-result');
      r.textContent = 'Testing…'; r.style.color = 'var(--text-secondary)';
      try {
        const b = buildEditBody();
        const payload = (b.privateKey || b.password) ? b : { id: s.id };
        const res = await API.post('/servers/test', payload);
        if (res.success) { r.textContent = `✓ ${res.version} — ${res.containers} containers`; r.style.color = 'var(--success)'; }
        else { r.textContent = `✗ ${res.error}`; r.style.color = 'var(--danger)'; }
      } catch (e) { r.textContent = '✗ ' + e.message; r.style.color = 'var(--danger)'; }
    });

    const footer = root.querySelector('#modal-footer');
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save Changes';
    footer.appendChild(saveBtn);
    saveBtn.addEventListener('click', async () => {
      const b = buildEditBody();
      if (!b.host || !b.username) { showToast('Host and username are required', 'warning'); return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await API.put('/servers/' + s.id, b);
        showToast(`Server "${s.id}" updated`);
        m.close();
        if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
        renderServers();
      } catch (e) {
        showToast(e.message, 'error', 8000);
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
      }
    });
  }

  renderTab(activeTab);
});

// Backward-compat: old top-level #/registries and #/cleanup links now redirect into Infrastructure.
Router.register('registries', async (content, params) => Router.navigate('infra', { tab: 'registries' }, { replace: true }));
Router.register('cleanup', async (content, params) => Router.navigate('infra', { tab: 'cleanup' }, { replace: true }));
