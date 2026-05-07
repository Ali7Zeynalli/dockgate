// Settings Page — tabbed layout
Router.register('settings', async (content) => {
  const pageNavId = Router._navId;

  async function render() {
    try {
      const [settings, autostartRes] = await Promise.all([
        Store.get('settings') ? Promise.resolve(Store.get('settings')) : API.get('/meta/settings'),
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
          <button class="tab-btn" data-tab="servers">Servers</button>
          <button class="tab-btn" data-tab="notifications">Notifications</button>
          <button class="tab-btn" data-tab="log">Notification Log</button>
          <button class="tab-btn" data-tab="update">Software Update</button>
        </div>

        <div id="settings-tab-content" style="padding-top:20px;">
          <!-- Tab content rendered here -->
        </div>
      `;

      const tabContent = document.getElementById('settings-tab-content');
      let activeTab = 'general';

      // Tab switching
      document.getElementById('settings-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        document.querySelectorAll('#settings-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        renderTab(activeTab);
      });

      function renderTab(tab) {
        if (tab === 'general') renderGeneral();
        else if (tab === 'servers') renderServers();
        else if (tab === 'notifications') renderNotifications();
        else if (tab === 'log') renderLog();
        else if (tab === 'update') renderUpdate();
      }

      // ==================== GENERAL TAB ====================
      function renderGeneral() {
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

      // ==================== SERVERS TAB (SSH multi-host) ====================
      // Bütün user input-lar escapeHtml() ilə sanitize olunur — XSS-ə qarşı
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
              <label class="text-xs text-muted">Private key (paste OpenSSH format):</label>
              <textarea class="input" id="srv-key" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="font-family:var(--font-mono);font-size:11px;width:100%;margin-top:4px;"></textarea>
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
            <div style="display:flex;gap:8px;">
              <button class="btn btn-secondary btn-sm" id="srv-test-new">Test Connection</button>
              <button class="btn btn-primary btn-sm" id="srv-add">Add Server</button>
              <div id="srv-test-result" style="align-self:center;"></div>
            </div>
          </div>
          <div class="settings-section" style="margin-top:20px;">
            <div class="settings-section-title">Required on remote server</div>
            <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 16px;font-family:var(--font-mono);font-size:12px;line-height:1.7;">
              <div class="text-xs text-muted" style="margin-bottom:6px;font-family:var(--font-sans);">User-in Docker socket-ə çıxışı olmalıdır:</div>
              <div># Server-də:</div>
              <div>sudo usermod -aG docker $USER</div>
              <div># SSH ilə test:</div>
              <div>ssh user@host docker ps</div>
            </div>
          </div>
        `;
        // setHTML helper — escapeHtml() artıq tətbiq olunub yuxarıda
        Object.assign(tabContent, { innerHTML: html });

        attachServerHandlers();
      }

      function attachServerHandlers() {
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
                  showToast(`✗ ${r.error}`, 'error', 8000);
                }
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
              out.textContent = `✗ ${r.error}`;
            }
            result.appendChild(out);
          } catch (e) {
            result.replaceChildren();
            const out = document.createElement('span');
            out.className = 'text-xs';
            out.style.color = 'var(--danger)';
            out.textContent = `✗ ${e.message}`;
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
                    <input class="input" style="width:60px;padding:4px 6px;font-size:12px;" type="number" min="1" max="1440" value="${r.cooldown_minutes}" data-rule="${r.event_type}" data-field="cooldown" />
                    <span class="text-xs text-muted">min</span>
                    <div class="toggle ${r.enabled ? 'active' : ''}" data-rule="${r.event_type}" data-field="enabled"></div>
                  </div>
                </div>
              `).join('')}
              <button class="btn btn-primary btn-sm" id="save-rules" style="margin-top:8px;">Save Rules</button>
            </div>
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
            } catch(e) { showToast(e.message, 'error'); }
          });

          document.getElementById('test-smtp')?.addEventListener('click', async () => {
            try { showToast('Sending test email...', 'info'); await API.post('/meta/smtp/test'); showToast('Test email sent!'); }
            catch(e) { showToast('Test failed: ' + e.message, 'error'); }
          });

          document.getElementById('clear-smtp')?.addEventListener('click', async () => {
            try { await API.delete('/meta/smtp'); showToast('SMTP cleared'); renderNotifications(); }
            catch(e) { showToast(e.message, 'error'); }
          });

          // Save Telegram
          document.getElementById('save-telegram')?.addEventListener('click', async () => {
            try {
              await API.post('/meta/telegram', {
                tg_token: document.getElementById('tg-token').value,
                tg_chat_id: document.getElementById('tg-chat-id').value,
              });
              showToast('Telegram settings saved');
            } catch(e) { showToast(e.message, 'error'); }
          });

          document.getElementById('test-telegram')?.addEventListener('click', async () => {
            try { showToast('Sending test message...', 'info'); await API.post('/meta/telegram/test'); showToast('Telegram test sent!'); }
            catch(e) { showToast('Test failed: ' + e.message, 'error'); }
          });

          document.getElementById('clear-telegram')?.addEventListener('click', async () => {
            try { await API.delete('/meta/telegram'); showToast('Telegram cleared'); renderNotifications(); }
            catch(e) { showToast(e.message, 'error'); }
          });

          // Save Rules
          document.getElementById('save-rules')?.addEventListener('click', async () => {
            try {
              const updates = [];
              tabContent.querySelectorAll('.toggle[data-rule]').forEach(toggle => {
                updates.push(API.put(`/meta/notifications/rules/${toggle.dataset.rule}`, { enabled: toggle.classList.contains('active') }));
              });
              tabContent.querySelectorAll('input[data-rule][data-field="cooldown"]').forEach(input => {
                updates.push(API.put(`/meta/notifications/rules/${input.dataset.rule}`, { cooldown_minutes: parseInt(input.value) || 5 }));
              });
              await Promise.all(updates);
              showToast('Notification rules saved');
            } catch(e) { showToast(e.message, 'error'); }
          });

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
                        <td class="text-xs text-muted" style="white-space:nowrap;">${new Date(l.created_at).toLocaleString()}</td>
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

          document.getElementById('clear-notif-log')?.addEventListener('click', async () => {
            try { await API.delete('/meta/notifications/log'); showToast('Log cleared'); renderLog(); }
            catch(e) { showToast(e.message, 'error'); }
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
          showToast('Settings saved successfully');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      // Initial tab render
      renderGeneral();

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  await render();
});
