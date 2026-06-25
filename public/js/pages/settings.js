// Settings Page — tabbed layout
Router.register('settings', async (content, params) => {
  // Servers moved to the Infrastructure section — redirect old #/settings?tab=servers deep-links.
  if (params && params.tab === 'servers') { Router.navigate('infra', { tab: 'servers' }, { replace: true }); return; }
  const pageNavId = Router._navId;

  async function render() {
    try {
      // Store's initial value is an empty object ({}) — since that is truthy, a hard
      // refresh used to SKIP the server fetch, so all General settings showed defaults.
      // Use the cache only when Store actually holds settings, otherwise fetch from the server.
      const cachedSettings = Store.get('settings');
      const haveCached = cachedSettings && Object.keys(cachedSettings).length > 0;
      const [settings, autostartRes] = await Promise.all([
        haveCached ? Promise.resolve(cachedSettings) : API.get('/meta/settings'),
        API.get('/meta/autostart').catch(() => ({ enabled: true }))
      ]);

      if (!Router.isActiveNav(pageNavId)) return;
      Store.set('settings', settings);
      let isAutoStart = autostartRes.enabled;

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Settings</div><div class="page-subtitle">Configure DockGate Control</div></div>
          <div class="page-actions"><button class="btn btn-primary" id="save-settings">Save Settings</button></div>
        </div>

        <div class="tab-bar" id="settings-tabs">
          <button class="tab-btn active" data-tab="general">General</button>
          <button class="tab-btn" data-tab="notifications">Notifications</button>
          <button class="tab-btn" data-tab="log">Notification Log</button>
          <button class="tab-btn" data-tab="update">Software Update</button>
          <button class="tab-btn" data-tab="system">System</button>
          <button class="tab-btn" data-tab="security">Security</button>
        </div>

        <div id="settings-tab-content" style="padding-top:20px;">
          <!-- Tab content rendered here -->
        </div>
      `;

      const tabContent = document.getElementById('settings-tab-content');
      // Restore the active tab from the URL params (deep-link / refresh / Back), default General.
      const validTabs = ['general', 'notifications', 'log', 'update', 'system', 'security'];
      let activeTab = (params && validTabs.includes(params.tab)) ? params.tab : 'general';

      // Reflect the restored tab in the tab-bar highlight (default markup highlights General).
      document.querySelectorAll('#settings-tabs .tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === activeTab);
      });

      // Tab switching
      document.getElementById('settings-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        document.querySelectorAll('#settings-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        renderTab(activeTab);
        // Sync the tab into the URL hash so Back/Forward + refresh land on this tab.
        Router.updateParams({ tab: activeTab });
      });

      function renderTab(tab) {
        if (tab === 'general') renderGeneral();
        else if (tab === 'notifications') renderNotifications();
        else if (tab === 'log') renderLog();
        else if (tab === 'update') renderUpdate();
        else if (tab === 'system') renderSystemInfo(tabContent); // System info now lives here (global from system.js)
        else if (tab === 'security') renderSecurity();
      }

      // ==================== SECURITY TAB ====================
      function renderSecurity() {
        tabContent.innerHTML = `
          <div class="settings-section" style="max-width:520px;">
            <div class="settings-section-title">Change Password</div>
            <div class="settings-row-desc" style="margin-bottom:14px;">Update the admin password used to sign in to DockGate. You stay logged in on this device after changing it.</div>
            <form id="sec-form" autocomplete="on">
              <input type="text" id="sec-user" name="username" autocomplete="username" value="admin" readonly aria-hidden="true" tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">
              <div style="display:flex;flex-direction:column;gap:10px;">
                <input class="input" id="sec-cur" type="password" placeholder="Current password" autocomplete="current-password">
                <input class="input" id="sec-new" type="password" placeholder="New password (min 8 characters)" autocomplete="new-password">
                <input class="input" id="sec-new2" type="password" placeholder="Confirm new password" autocomplete="new-password">
              </div>
              <div style="margin-top:14px;">
                <button class="btn btn-primary btn-sm" id="sec-save" type="submit">Change Password</button>
              </div>
            </form>
          </div>
        `;
        // Password fields wrapped in a <form> (+ a hidden username field) so the browser/password-manager
        // is happy ("password field not in a form" gone); submit is handled in JS, never reloads the page.
        document.getElementById('sec-form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const cur = document.getElementById('sec-cur').value;
          const nw = document.getElementById('sec-new').value;
          const nw2 = document.getElementById('sec-new2').value;
          if (!cur || !nw) { showToast('Fill in all fields', 'warning'); return; }
          if (nw !== nw2) { showToast('New passwords do not match', 'warning'); return; }
          if (nw.length < 8) { showToast('New password must be at least 8 characters', 'warning'); return; }
          try {
            await API.post('/auth/change-password', { currentPassword: cur, newPassword: nw });
            showToast('Password changed');
            ['sec-cur', 'sec-new', 'sec-new2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
          } catch (e) { showToast(e.message, 'error'); }
        });
      }

      // ==================== GENERAL TAB ====================
      function renderGeneral() {
        // Full IANA zone list (modern engines) + "Auto" fallback
        const zones = (typeof Intl.supportedValuesOf === 'function') ? Intl.supportedValuesOf('timeZone') : [];
        const curTz = settings.timezone || 'auto';
        const tzOptions = [`<option value="auto"${curTz === 'auto' ? ' selected' : ''}>Auto (browser)</option>`]
          .concat(zones.map(z => `<option value="${z}"${z === curTz ? ' selected' : ''}>${z}</option>`))
          .join('');
        tabContent.innerHTML = `
          <div class="grid-2">
            <div class="settings-section">
              <div class="settings-section-title">Appearance</div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">Theme</div>
                  <div class="settings-row-desc">Application visual style</div>
                </div>
                <select class="select" id="set-theme">
                  <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
                  <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option>
                </select>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">Default View</div>
                  <div class="settings-row-desc">Container list default layout</div>
                </div>
                <select class="select" id="set-view">
                  <option value="table" ${settings.defaultView === 'table' ? 'selected' : ''}>Table</option>
                  <option value="card" ${settings.defaultView === 'card' ? 'selected' : ''}>Card</option>
                </select>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">Timezone</div>
                  <div class="settings-row-desc">Timezone for displayed dates &amp; notifications</div>
                </div>
                <select class="select" id="set-timezone">${tzOptions}</select>
              </div>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">Terminal & Logs</div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">Default Shell</div>
                  <div class="settings-row-desc">Shell to use when opening terminal</div>
                </div>
                <select class="select" id="set-shell">
                  <option value="/bin/sh" ${settings.terminalShell === '/bin/sh' ? 'selected' : ''}>/bin/sh</option>
                  <option value="/bin/bash" ${settings.terminalShell === '/bin/bash' ? 'selected' : ''}>/bin/bash</option>
                  <option value="/bin/zsh" ${settings.terminalShell === '/bin/zsh' ? 'selected' : ''}>/bin/zsh</option>
                </select>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">Log Timestamps</div>
                  <div class="settings-row-desc">Show timestamp for each log line</div>
                </div>
                <div class="toggle ${settings.logTimestamps === 'true' ? 'active' : ''}" id="set-logtimes"></div>
              </div>
            </div>
          </div>

          <div class="settings-section" style="margin-top:20px;">
            <div class="settings-section-title">System</div>
            <div class="settings-row">
              <div>
                <div class="settings-row-label">Auto-Start Service</div>
                <div class="settings-row-desc">Automatically run panel when Docker daemon boots</div>
              </div>
              <div class="toggle ${isAutoStart ? 'active' : ''}" id="set-autostart"></div>
            </div>
          </div>
        `;

        document.getElementById('set-logtimes')?.addEventListener('click', function() { this.classList.toggle('active'); });
        document.getElementById('set-autostart')?.addEventListener('click', function() { this.classList.toggle('active'); });
      }

      // ==================== SERVERS TAB — MOVED to Infrastructure (pages/infrastructure.js) ====================
      // DEAD CODE: no tab button / validTab / renderTab branch references these anymore. Kept temporarily
      // to avoid an untested 340-line cut; delete this whole block (down to NOTIFICATIONS) once the
      // Infrastructure refactor is verified in a browser. (P1.11 — deferred.)
      // eslint-disable-next-line no-unused-vars
      async function renderServers() {
        // Yükleme — DOM API
        const loading = document.createElement('div');
        loading.className = 'text-muted text-sm';
        loading.textContent = 'Loading servers...';
        tabContent.replaceChildren(loading);
        try {
          const data = await API.get('/servers');
          renderServersList(data);
        } catch (e) {
          const err = document.createElement('div');
          err.className = 'text-xs text-danger';
          err.textContent = e.message;
          tabContent.replaceChildren(err);
        }
      }

      function renderServersList(data) {
        const rowsHtml = data.servers.map(s => {
          const isLocal = s.id === 'local';
          const activeBadge = s.isActive ? '<span class="badge badge-running">active</span>' : '';
          const hostStr = s.host ? `${escapeHtml(s.username || '')}@${escapeHtml(s.host)}:${s.port || 22}` : '—';
          let authBadge = '';
          if (s.hasKey) authBadge = '<span class="text-xs text-muted">🔑 key</span>';
          else if (s.hasPassword) authBadge = '<span class="text-xs text-muted">🔒 password</span>';
          else if (!isLocal) authBadge = '<span class="text-xs text-muted">📡 agent</span>';
          return `<tr>
              <td class="td-mono">${isLocal ? '🖥' : '🔐'} ${escapeHtml(s.id)}</td>
              <td class="text-xs">${escapeHtml(s.type)}</td>
              <td class="td-mono text-xs">${hostStr}</td>
              <td>${authBadge}</td>
              <td>${activeBadge}</td>
              <td>
                ${!s.isActive ? `<button class="btn btn-xs btn-secondary" data-action="activate" data-id="${escapeHtml(s.id)}">Use</button>` : ''}
                <button class="btn btn-xs btn-secondary" data-action="test" data-id="${escapeHtml(s.id)}">Test</button>
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
              <thead><tr><th>ID</th><th>Type</th><th>Host</th><th>Auth</th><th>Status</th><th>Actions</th></tr></thead>
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
              <label class="text-xs text-muted">SSH user şifrəsi (DB-də plain-text saxlanılır — yalnız trust edilən şəbəkədə):</label>
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
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:4px 0 8px;cursor:pointer;color:var(--text-secondary)">
              <input type="checkbox" id="srv-grant-docker"> Grant Docker access after adding (runs <code style="margin:0 3px">sudo usermod -aG docker</code> — needs passwordless sudo)
            </label>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-secondary btn-sm" id="srv-test-new">Test Connection</button>
              <button class="btn btn-primary btn-sm" id="srv-add">Add Server</button>
              <div id="srv-test-result" style="align-self:center;"></div>
            </div>
          </div>
        `;
        // setHTML helper — escapeHtml() artıq tətbiq olunub yuxarıda
        Object.assign(tabContent, { innerHTML: html });

        attachServerHandlers(data.servers);
      }

      // Stage-1 SSH auth failures get a actionable hint (usermod fixes stage 2, not this).
      function sshErrorHint(msg) {
        return /authentication methods failed/i.test(String(msg))
          ? `${msg} → SSH login itself failed: check the user (Coolify → usually root), that the public key is in that user's authorized_keys, and the key passphrase. ("usermod -aG docker" does NOT fix this — it's for the docker-permission stage after login.)`
          : msg;
      }

      function attachServerHandlers(servers = []) {
        // Auth tabs (key / password / agent)
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
              } else if (action === 'edit') {
                const s = servers.find(x => x.id === id);
                if (s) openServerEditModal(s);
              } else if (action === 'delete') {
                showDeleteConfirm('Delete Server', { message: `Server "${id}" silinsin? SSH key faylı da silinir.`, phrase: id, onConfirm: async () => {
                  await API.del(`/servers/${id}`);
                  showToast('Silindi');
                  if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
                  renderServers();
                } });
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
          // 'agent' — heç biri əlavə edilmir, server-side agent fallback işləyir
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
            // Opt-in: grant docker access right after adding
            if (document.getElementById('srv-grant-docker')?.checked) {
              try {
                const g = await API.post(`/servers/${id}/grant-docker`, {});
                showToast(g.message || 'Docker access granted', 'success', 7000);
              } catch (ge) { showToast('Added, but granting Docker access failed: ' + sshErrorHint(ge.message), 'warning', 10000); }
            }
            if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
            renderServers();
          } catch (e) { showToast(e.message, 'error'); }
        });
      }

      // Edit an existing SSH server in a modal. ID is immutable (it's the PK / URL param).
      // Key and password are never returned by the API, so leaving them blank keeps the current secret;
      // entering a new one replaces it (PUT /servers/:id only updates the fields that are sent).
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

        // Build the PUT body — only include a secret if a new one was actually entered.
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
            // No new secret entered → test the saved server by id (uses stored credentials)
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

      // ==================== NOTIFICATIONS TAB ====================
      async function renderNotifications() {
        tabContent.innerHTML = '<div class="text-muted text-sm">Loading notification settings...</div>';

        try {
          const [smtpConfig, tgConfig, rules] = await Promise.all([
            API.get('/meta/smtp'),
            API.get('/meta/telegram'),
            API.get('/meta/notifications/rules'),
          ]);

          const ruleLabels = {
            container_die: 'Container Stopped/Died',
            container_restart: 'Container Restarted',
            container_oom: 'Container OOM Kill',
            container_unhealthy: 'Container Unhealthy',
            disk_threshold: 'Disk Usage Threshold',
            build_failed: 'Build Failed',
            container_start: 'Container Started',
            container_pause: 'Container Paused',
            container_unpause: 'Container Resumed',
          };

          const emailConfigured = !!(smtpConfig.smtp_host);
          const tgConfigured = !!(tgConfig.tg_chat_id);

          tabContent.innerHTML = `
            <!-- Channels -->
            <div class="settings-section">
              <div class="settings-section-title">Channels</div>

              <!-- Email -->
              <div class="settings-row" style="cursor:pointer;" id="email-channel-header">
                <div style="display:flex;align-items:center;gap:10px;">
                  <div class="toggle ${emailConfigured ? 'active' : ''}" id="email-channel-toggle"></div>
                  <div>
                    <div class="settings-row-label" style="margin:0;">Email (SMTP)</div>
                    <div class="settings-row-desc">${emailConfigured ? escapeHtml(smtpConfig.smtp_to || '') : 'Not configured'}</div>
                  </div>
                </div>
                <span class="text-xs text-muted" id="email-chevron">${emailConfigured ? '▼' : '▶'}</span>
              </div>
              <div id="email-channel-body" style="display:${emailConfigured ? 'block' : 'none'};padding:4px 0 16px 0;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
                  <input class="input" id="smtp-host" placeholder="SMTP Host" value="${escapeHtml(smtpConfig.smtp_host || '')}" />
                  <input class="input" id="smtp-port" placeholder="Port (587)" value="${escapeHtml(smtpConfig.smtp_port || '')}" type="number" />
                  <input class="input" id="smtp-user" placeholder="Username" value="${escapeHtml(smtpConfig.smtp_user || '')}" />
                  <input class="input" id="smtp-pass" placeholder="Password" value="${escapeHtml(smtpConfig.smtp_pass || '')}" type="password" />
                  <input class="input" id="smtp-from" placeholder="From Email" value="${escapeHtml(smtpConfig.smtp_from || '')}" />
                  <input class="input" id="smtp-to" placeholder="To Email" value="${escapeHtml(smtpConfig.smtp_to || '')}" />
                </div>
                <div style="display:flex;gap:8px;">
                  <button class="btn btn-primary btn-sm" id="save-smtp">Save</button>
                  <button class="btn btn-secondary btn-sm" id="test-smtp">Test Email</button>
                  <button class="btn btn-ghost btn-sm" id="clear-smtp" style="margin-left:auto;">Clear</button>
                </div>
              </div>

              <div style="border-top:1px solid var(--border);"></div>

              <!-- Telegram -->
              <div class="settings-row" style="cursor:pointer;" id="tg-channel-header">
                <div style="display:flex;align-items:center;gap:10px;">
                  <div class="toggle ${tgConfigured ? 'active' : ''}" id="tg-channel-toggle"></div>
                  <div>
                    <div class="settings-row-label" style="margin:0;">Telegram Bot</div>
                    <div class="settings-row-desc">${tgConfigured ? 'Chat ID: ' + escapeHtml(tgConfig.tg_chat_id) : 'Not configured'}</div>
                  </div>
                </div>
                <span class="text-xs text-muted" id="tg-chevron">${tgConfigured ? '▼' : '▶'}</span>
              </div>
              <div id="tg-channel-body" style="display:${tgConfigured ? 'block' : 'none'};padding:4px 0 16px 0;">
                ${!tgConfigured ? `
                <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px 16px;margin-bottom:14px;font-size:12px;line-height:1.7;">
                  <div style="font-size:13px;font-weight:600;margin-bottom:8px;">How to set up Telegram Bot</div>
                  <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;">
                    <span style="background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">1</span>
                    <span>Open Telegram, search for <strong>@BotFather</strong> and send <code>/newbot</code></span>
                  </div>
                  <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;">
                    <span style="background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">2</span>
                    <span>Follow the prompts to name your bot. You will receive a <strong>Bot Token</strong> — paste it below</span>
                  </div>
                  <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;">
                    <span style="background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">3</span>
                    <span>Open your new bot in Telegram and send <code>/start</code></span>
                  </div>
                  <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;">
                    <span style="background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">4</span>
                    <span>Open this URL in browser to find your <strong>Chat ID</strong>:<br>
                      <code style="font-size:11px;word-break:break-all;">https://api.telegram.org/bot&lt;YOUR_TOKEN&gt;/getUpdates</code><br>
                      Look for <code>"chat":{"id": <strong>123456789</strong>}</code> — that number is your Chat ID
                    </span>
                  </div>
                  <div style="display:flex;gap:8px;align-items:flex-start;">
                    <span style="background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">5</span>
                    <span>Paste both values below, click <strong>Save</strong>, then <strong>Test Message</strong></span>
                  </div>
                </div>
                ` : ''}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                  <input class="input" id="tg-token" placeholder="Bot Token" value="${escapeHtml(tgConfig.tg_token || '')}" type="password" />
                  <input class="input" id="tg-chat-id" placeholder="Chat ID" value="${escapeHtml(tgConfig.tg_chat_id || '')}" />
                </div>
                <div style="display:flex;gap:8px;">
                  <button class="btn btn-primary btn-sm" id="save-telegram">Save</button>
                  <button class="btn btn-secondary btn-sm" id="test-telegram">Test Message</button>
                  <button class="btn btn-ghost btn-sm" id="clear-telegram" style="margin-left:auto;">Clear</button>
                </div>
              </div>
            </div>

            <!-- Rules -->
            <div class="settings-section" style="margin-top:20px;">
              <div class="settings-section-title">Alert Rules</div>
              ${rules.map(r => `
                <div class="settings-row" style="padding:8px 0;">
                  <div>
                    <div class="settings-row-label">${ruleLabels[r.event_type] || r.event_type}</div>
                    <div class="settings-row-desc">${escapeHtml(r.description || '')}</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:12px;">
                    <span class="text-xs text-muted">Cooldown:</span>
                    <input class="input" style="width:60px;padding:4px 6px;font-size:12px;" type="number" min="0" max="1440" value="${r.cooldown_minutes}" data-rule="${r.event_type}" data-field="cooldown" title="0 = send every occurrence (no throttle)" />
                    <span class="text-xs text-muted">min · 0 = every</span>
                    <div class="toggle ${r.enabled ? 'active' : ''}" data-rule="${r.event_type}" data-field="enabled"></div>
                  </div>
                </div>
              `).join('')}
              <button class="btn btn-primary btn-sm" id="save-rules" style="margin-top:8px;">Save Rules</button>
            </div>

            ${typeof edgeNotifierSectionHtml === 'function' ? edgeNotifierSectionHtml(emailConfigured || tgConfigured) : ''}
          `;

          // Accordion
          function setupAccordion(headerId, bodyId, chevronId) {
            document.getElementById(headerId)?.addEventListener('click', (e) => {
              if (e.target.closest('.toggle')) return;
              const body = document.getElementById(bodyId);
              const chevron = document.getElementById(chevronId);
              if (!body) return;
              const open = body.style.display !== 'none';
              body.style.display = open ? 'none' : 'block';
              if (chevron) chevron.textContent = open ? '▶' : '▼';
            });
          }
          setupAccordion('email-channel-header', 'email-channel-body', 'email-chevron');
          setupAccordion('tg-channel-header', 'tg-channel-body', 'tg-chevron');

          // Toggle opens panel
          document.getElementById('email-channel-toggle')?.addEventListener('click', () => {
            const b = document.getElementById('email-channel-body'), c = document.getElementById('email-chevron');
            if (b && b.style.display === 'none') { b.style.display = 'block'; if (c) c.textContent = '▼'; }
          });
          document.getElementById('tg-channel-toggle')?.addEventListener('click', () => {
            const b = document.getElementById('tg-channel-body'), c = document.getElementById('tg-chevron');
            if (b && b.style.display === 'none') { b.style.display = 'block'; if (c) c.textContent = '▼'; }
          });

          // Rule toggles
          tabContent.querySelectorAll('.toggle[data-rule]').forEach(toggle => {
            toggle.addEventListener('click', function() { this.classList.toggle('active'); });
          });

          // Save SMTP
          document.getElementById('save-smtp')?.addEventListener('click', async () => {
            try {
              await API.post('/meta/smtp', {
                smtp_host: document.getElementById('smtp-host').value,
                smtp_port: document.getElementById('smtp-port').value,
                smtp_user: document.getElementById('smtp-user').value,
                smtp_pass: document.getElementById('smtp-pass').value,
                smtp_from: document.getElementById('smtp-from').value,
                smtp_to: document.getElementById('smtp-to').value,
              });
              showToast('SMTP settings saved');
              if (typeof edgeNotifierSync === 'function') edgeNotifierSync(true); // push new channel to installed agents
              renderNotifications(); // refresh so masked values / configured-state show immediately
            } catch(e) { showToast(e.message, 'error'); }
          });

          document.getElementById('test-smtp')?.addEventListener('click', async () => {
            try { showToast('Sending test email...', 'info'); await API.post('/meta/smtp/test'); showToast('Test email sent!'); }
            catch(e) { showToast('Test failed: ' + e.message, 'error'); }
          });

          document.getElementById('clear-smtp')?.addEventListener('click', () => {
            showDeleteConfirm('Clear SMTP', { message: 'Delete the saved SMTP settings? Host, user and password will have to be re-entered.', phrase: 'delete', confirmLabel: 'Clear', onConfirm: async () => {
              try { await API.delete('/meta/smtp'); showToast('SMTP cleared'); renderNotifications(); }
              catch(e) { showToast(e.message, 'error'); }
            }});
          });

          // Save Telegram
          document.getElementById('save-telegram')?.addEventListener('click', async () => {
            try {
              await API.post('/meta/telegram', {
                tg_token: document.getElementById('tg-token').value,
                tg_chat_id: document.getElementById('tg-chat-id').value,
              });
              showToast('Telegram settings saved');
              if (typeof edgeNotifierSync === 'function') edgeNotifierSync(true); // push new channel to installed agents
              renderNotifications(); // refresh so masked token / configured-state show immediately
            } catch(e) { showToast(e.message, 'error'); }
          });

          document.getElementById('test-telegram')?.addEventListener('click', async () => {
            try { showToast('Sending test message...', 'info'); await API.post('/meta/telegram/test'); showToast('Telegram test sent!'); }
            catch(e) { showToast('Test failed: ' + e.message, 'error'); }
          });

          document.getElementById('clear-telegram')?.addEventListener('click', () => {
            showDeleteConfirm('Clear Telegram', { message: 'Delete the saved Telegram settings? The bot token and chat ID will have to be re-entered.', phrase: 'delete', confirmLabel: 'Clear', onConfirm: async () => {
              try { await API.delete('/meta/telegram'); showToast('Telegram cleared'); renderNotifications(); }
              catch(e) { showToast(e.message, 'error'); }
            }});
          });

          // Save Rules
          document.getElementById('save-rules')?.addEventListener('click', async () => {
            try {
              const updates = [];
              tabContent.querySelectorAll('.toggle[data-rule]').forEach(toggle => {
                updates.push(API.put(`/meta/notifications/rules/${toggle.dataset.rule}`, { enabled: toggle.classList.contains('active') }));
              });
              tabContent.querySelectorAll('input[data-rule][data-field="cooldown"]').forEach(input => {
                const cd = parseInt(input.value, 10);
                updates.push(API.put(`/meta/notifications/rules/${input.dataset.rule}`, { cooldown_minutes: Number.isFinite(cd) && cd >= 0 ? cd : 5 }));
              });
              await Promise.all(updates);
              showToast('Notification rules saved');
              if (typeof edgeNotifierSync === 'function') edgeNotifierSync(true); // push new rules to installed agents
            } catch(e) { showToast(e.message, 'error'); }
          });

          // Edge Notifier (per-server agent) — renders only when a channel is configured.
          if (typeof attachEdgeNotifierHandlers === 'function') attachEdgeNotifierHandlers(tabContent, emailConfigured || tgConfigured);

        } catch(e) {
          tabContent.innerHTML = '<div class="text-xs text-muted">Could not load notification settings.</div>';
        }
      }

      // ==================== NOTIFICATION LOG TAB ====================
      async function renderLog() {
        tabContent.innerHTML = '<div class="text-muted text-sm">Loading notification log...</div>';

        try {
          const notifLogs = await API.get('/meta/notifications/log?limit=50');

          if (notifLogs.length === 0) {
            tabContent.innerHTML = `
              <div class="settings-section">
                <div class="empty-state" style="padding:40px 0;">
                  <div class="text-muted">No notifications sent yet</div>
                </div>
              </div>
            `;
            return;
          }

          tabContent.innerHTML = `
            <div class="settings-section">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                <div class="settings-section-title" style="margin:0;">Notification Log</div>
                <button class="btn btn-ghost btn-sm" id="clear-notif-log">Clear Log</button>
              </div>
              <div class="table-wrapper" style="max-height:400px;overflow-y:auto;">
                <table>
                  <thead><tr><th>Time</th><th>Channel</th><th>Type</th><th>Subject</th><th>Status</th></tr></thead>
                  <tbody>
                    ${notifLogs.map(l => `
                      <tr>
                        <td class="text-xs text-muted" style="white-space:nowrap;">${formatTime(l.created_at)}</td>
                        <td class="td-mono text-xs" style="text-align:center;">${l.channel === 'telegram' ? '📱 TG' : '📧 Email'}</td>
                        <td class="td-mono text-xs">${escapeHtml(l.event_type)}</td>
                        <td class="text-sm">${escapeHtml(l.subject)}</td>
                        <td><span class="badge ${l.status === 'sent' ? 'badge-running' : 'badge-stopped'}">${l.status}</span></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;

          document.getElementById('clear-notif-log')?.addEventListener('click', () => {
            showDeleteConfirm('Clear notification log', { message: 'Permanently clear the entire notification history log?', phrase: 'delete', confirmLabel: 'Clear', onConfirm: async () => {
              try { await API.delete('/meta/notifications/log'); showToast('Log cleared'); renderLog(); }
              catch(e) { showToast(e.message, 'error'); }
            }});
          });
        } catch(e) {
          tabContent.innerHTML = '<div class="text-xs text-muted">Could not load notification log.</div>';
        }
      }

      // ==================== UPDATE TAB ====================
      async function renderUpdate() {
        tabContent.innerHTML = '<div class="text-muted text-sm">Checking for updates...</div>';

        try {
          const updateInfo = await API.get('/meta/update/check');

          if (updateInfo.updateAvailable) {
            tabContent.innerHTML = `
              <div class="settings-section">
                <div class="insight-card info" style="margin-bottom:12px;">
                  <span>${Icons.info}</span>
                  <span>A new version is available: v${escapeHtml(updateInfo.remoteVersion)}</span>
                </div>
                <div style="margin-bottom:12px;">
                  <div class="text-sm text-muted">Current: v${updateInfo.currentVersion} &rarr; Latest: v${updateInfo.remoteVersion}</div>
                </div>
                ${updateInfo.changes && updateInfo.changes.length > 0 ? `
                <div style="margin-bottom:12px;">
                  <div class="text-xs text-muted" style="margin-bottom:6px;">What's new:</div>
                  <div style="max-height:150px;overflow-y:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 12px;font-size:12px;">
                    ${updateInfo.changes.map(c => `<div style="padding:2px 0;">&bull; ${escapeHtml(c)}</div>`).join('')}
                  </div>
                </div>` : ''}
                <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:12px;font-family:var(--font-mono);font-size:12px;line-height:1.8;">
                  <div class="text-xs text-muted" style="margin-bottom:6px;font-family:var(--font-sans);">To update manually:</div>
                  <div>docker compose pull</div>
                  <div>docker compose up -d</div>
                </div>
                <div style="display:flex;gap:8px;">
                  <button class="btn btn-primary btn-sm" id="auto-update-btn">${Icons.download} Update Now</button>
                  <button class="btn btn-secondary btn-sm" id="copy-update-cmd">${Icons.copy} Copy Commands</button>
                  <a href="${updateInfo.repoUrl}" target="_blank" class="btn btn-secondary btn-sm">${Icons.externalLink} GitHub</a>
                </div>
              </div>
            `;

            document.getElementById('auto-update-btn')?.addEventListener('click', () => {
              showConfirm('Update DockGate', 'This will pull the latest Docker image and restart the container. Your data will be preserved.', async () => {
                try {
                  showToast('Updating... Panel will restart in a moment.', 'info', 15000);
                  await API.post('/meta/update/apply');
                  localStorage.setItem('dcc_update_available', 'false');
                  const badge = document.getElementById('badge-settings');
                  if (badge) badge.style.display = 'none';
                } catch(e) { showToast('Update started, panel will restart...', 'info', 10000); }
              });
            });

            document.getElementById('copy-update-cmd')?.addEventListener('click', () => {
              navigator.clipboard.writeText('docker compose pull && docker compose up -d').then(() => showToast('Commands copied'));
            });
          } else if (updateInfo.error) {
            // The check itself failed server-side (e.g. no network / wget). Don't pretend "up to date".
            tabContent.innerHTML = `
              <div class="settings-section">
                <div style="display:flex;align-items:center;gap:12px;">
                  <span class="text-muted">&#9888;</span>
                  <div>
                    <div class="text-sm">Could not check for updates</div>
                    <div class="text-xs text-muted">${escapeHtml(updateInfo.error)} (current v${updateInfo.currentVersion})</div>
                  </div>
                  <button class="btn btn-xs btn-secondary" id="check-update-btn">${Icons.refresh} Retry</button>
                  <a href="${updateInfo.repoUrl || 'https://github.com/Ali7Zeynalli/dockgate'}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub</a>
                </div>
              </div>
            `;
            document.getElementById('check-update-btn')?.addEventListener('click', () => renderUpdate());
          } else {
            tabContent.innerHTML = `
              <div class="settings-section">
                <div style="display:flex;align-items:center;gap:12px;">
                  <span style="color:var(--success);font-size:18px;">&#10003;</span>
                  <div>
                    <div class="text-sm">DockGate is up to date</div>
                    <div class="text-xs text-muted">v${updateInfo.currentVersion}</div>
                  </div>
                  <button class="btn btn-xs btn-secondary" id="check-update-btn">${Icons.refresh} Check</button>
                  <a href="${updateInfo.repoUrl || 'https://github.com/Ali7Zeynalli/dockgate'}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub</a>
                </div>
              </div>
            `;
            document.getElementById('check-update-btn')?.addEventListener('click', () => renderUpdate());
          }
        } catch(e) {
          tabContent.innerHTML = `
            <div class="settings-section">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="text-muted">&#9888;</span>
                <div>
                  <div class="text-sm">Could not check for updates</div>
                  <div class="text-xs text-muted">Check your internet connection</div>
                </div>
                <button class="btn btn-xs btn-secondary" id="retry-update-btn">${Icons.refresh} Retry</button>
                <a href="https://github.com/Ali7Zeynalli/dockgate" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub</a>
              </div>
            </div>
          `;
          document.getElementById('retry-update-btn')?.addEventListener('click', () => renderUpdate());
        }
      }

      // ==================== SAVE SETTINGS ====================
      document.getElementById('save-settings')?.addEventListener('click', async () => {
        // If not on General tab, switch to it first so fields exist
        if (activeTab !== 'general') {
          document.querySelector('#settings-tabs .tab-btn[data-tab="general"]')?.click();
          await new Promise(r => setTimeout(r, 50));
        }

        const newSettings = {
          theme: document.getElementById('set-theme')?.value || settings.theme,
          defaultView: document.getElementById('set-view')?.value || settings.defaultView,
          terminalShell: document.getElementById('set-shell')?.value || settings.terminalShell,
          timezone: document.getElementById('set-timezone')?.value || settings.timezone || 'auto',
          logTimestamps: document.getElementById('set-logtimes')?.classList.contains('active') ? 'true' : 'false',
        };

        const newAutoStart = document.getElementById('set-autostart')?.classList.contains('active') ?? isAutoStart;

        try {
          await API.post('/meta/settings', newSettings);

          if (newAutoStart !== isAutoStart) {
            const asRes = await API.post('/meta/autostart', { enabled: newAutoStart });
            isAutoStart = asRes.policy !== 'no';
          }

          Store.set('settings', { ...settings, ...newSettings });
          applyTheme(newSettings.theme);
          localStorage.setItem('dcc_theme', newSettings.theme);
          localStorage.setItem('dcc_timezone', newSettings.timezone);
          showToast('Settings saved successfully');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      // Initial tab render — honour the restored activeTab (not always General)
      renderTab(activeTab);

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  await render();
});
