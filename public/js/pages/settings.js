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
            <div class="settings-row-desc" style="margin-bottom:14px;">Update the admin password used to sign in to DockGate. You stay logged in on this device; every other browser or device is signed out.</div>
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
          <div class="settings-section" style="max-width:520px;">
            <div class="settings-section-title">Sessions</div>
            <div class="settings-row-desc" style="margin-bottom:14px;">Signs out every browser and device that is logged in to DockGate — this one too. Use it if you logged in on a machine you do not trust or think your session was copied.</div>
            <button class="btn btn-danger btn-sm" id="sec-logout-all" type="button">Sign out everywhere</button>
          </div>
        `;
        document.getElementById('sec-logout-all')?.addEventListener('click', () => showConfirm('Sign out everywhere', 'Every DockGate session ends now, including this one. You will need the admin password to log in again.', async () => {
          try { await API.post('/auth/logout-all'); location.reload(); } catch (e) { showToast(e.message, 'error'); }
        }, true));
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
      // ==================== NOTIFICATIONS TAB ====================
      async function renderNotifications() {
        tabContent.innerHTML = '<div class="text-muted text-sm">Loading notification settings...</div>';

        try {
          const [smtpConfig, tgConfig, rules, hostNotifs] = await Promise.all([
            API.get('/meta/smtp'),
            API.get('/meta/telegram'),
            API.get('/meta/notifications/rules'),
            API.get('/meta/notifications/hosts').catch(() => ({ local: { enabled: true }, servers: [] })),
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

            <!-- Monitored Hosts / Server Muting -->
            <div class="settings-section" style="margin-top:20px;">
              <div class="settings-section-title">Monitored Hosts &amp; Server Muting</div>
              <div class="text-xs text-muted" style="margin-bottom:12px;">Enable or mute alerts per server. Muting a host suppresses its emails and Telegram alerts while all containers, deployments, and metrics continue running normally.</div>
              
              <!-- Local Daemon -->
              <div class="settings-row" style="padding:8px 0;">
                <div>
                  <div class="settings-row-label" style="display:flex;align-items:center;gap:6px;">🖥️ Local Daemon <span class="badge" style="font-size:10px;background:var(--bg-tertiary);">local host</span></div>
                  <div class="settings-row-desc">Docker daemon running on the Dockgate master machine</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span class="text-xs text-muted">${hostNotifs.local?.enabled ? 'Active' : 'Muted'}</span>
                  <div class="toggle host-notif-toggle ${hostNotifs.local?.enabled ? 'active' : ''}" data-host-id="local"></div>
                </div>
              </div>

              <!-- Remote SSH Servers -->
              ${(hostNotifs.servers || []).map(s => `
                <div class="settings-row" style="padding:8px 0;border-top:1px solid var(--border);">
                  <div>
                    <div class="settings-row-label" style="display:flex;align-items:center;gap:6px;">🌐 ${escapeHtml(s.name || s.id)} <span class="text-xs text-muted font-mono">(${escapeHtml(s.host || '')})</span></div>
                    <div class="settings-row-desc">Remote SSH Docker server</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span class="text-xs text-muted">${s.notifications_enabled ? 'Active' : 'Muted'}</span>
                    <div class="toggle host-notif-toggle ${s.notifications_enabled ? 'active' : ''}" data-host-id="${escapeHtml(s.id)}"></div>
                  </div>
                </div>
              `).join('')}
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

            ${typeof edgeAgentSectionHtml === 'function' ? edgeAgentSectionHtml(emailConfigured || tgConfigured) : ''}
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

          // Host notification toggles
          tabContent.querySelectorAll('.host-notif-toggle').forEach(toggle => {
            toggle.addEventListener('click', async function() {
              const hostId = this.dataset.hostId;
              const willEnable = !this.classList.contains('active');
              this.classList.toggle('active');
              try {
                await API.put(`/meta/notifications/hosts/${hostId}`, { enabled: willEnable });
                showToast(willEnable
                  ? `✓ Alerts enabled for ${hostId === 'local' ? 'Local Daemon' : hostId}`
                  : `🔕 Alerts muted for ${hostId === 'local' ? 'Local Daemon' : hostId}`, 'info');
                renderNotifications();
              } catch(err) {
                this.classList.toggle('active'); // rollback
                showToast(err.message, 'error');
              }
            });
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
              if (typeof edgeAgentSync === 'function') edgeAgentSync(true); // push new channel to installed agents
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
              if (typeof edgeAgentSync === 'function') edgeAgentSync(true); // push new channel to installed agents
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
              if (typeof edgeAgentSync === 'function') edgeAgentSync(true); // push new rules to installed agents
            } catch(e) { showToast(e.message, 'error'); }
          });

          // Edge Agent (per-server observability) — always render; agent can install in metrics-only mode.
          if (typeof attachEdgeAgentHandlers === 'function') attachEdgeAgentHandlers(tabContent, true);

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
        tabContent.innerHTML = '<div class="text-muted text-sm" style="padding:20px 0;"><span style="display:inline-block;animation:spin 1s linear infinite;">⏳</span> Checking GitHub for updates…</div>';

        try {
          const updateInfo = await API.get('/meta/update/check');
          const isUpdate = !!updateInfo.updateAvailable;
          const currentVer = updateInfo.currentVersion || '2.2.0';
          const remoteVer = updateInfo.remoteVersion || currentVer;
          const changes = updateInfo.changes || [];
          const repoUrl = updateInfo.repoUrl || 'https://github.com/Ali7Zeynalli/dockgate';
          const checkedTime = updateInfo.checkedAt ? new Date(updateInfo.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Just now';

          tabContent.innerHTML = `
            <div class="settings-section" style="display:flex;flex-direction:column;gap:16px;">
              
              <!-- Status Hero Card -->
              <div class="card" style="padding:18px 20px;background:linear-gradient(135deg, rgba(15, 23, 42, 0.8), rgba(30, 41, 59, 0.8));border:1px solid ${isUpdate ? 'rgba(56, 189, 248, 0.4)' : 'rgba(16, 185, 129, 0.3)'};border-radius:var(--radius-lg);box-shadow:0 4px 20px rgba(0,0,0,0.15);">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
                  <div style="display:flex;align-items:center;gap:14px;">
                    <div style="width:44px;height:44px;border-radius:10px;background:${isUpdate ? 'rgba(56, 189, 248, 0.15)' : 'rgba(16, 185, 129, 0.15)'};display:flex;align-items:center;justify-content:center;font-size:22px;">
                      ${isUpdate ? '🚀' : '✓'}
                    </div>
                    <div>
                      <div style="font-weight:700;font-size:16px;color:var(--text-primary);display:flex;align-items:center;gap:8px;">
                        ${isUpdate ? `New Version Available: v${escapeHtml(remoteVer)}` : 'DockGate is Up to Date'}
                        <span class="badge" style="background:${isUpdate ? '#38bdf822' : '#10b98122'};color:${isUpdate ? '#38bdf8' : '#10b981'};font-size:11px;font-weight:700;padding:2px 8px;">
                          ${isUpdate ? 'UPDATE READY' : 'LATEST'}
                        </span>
                      </div>
                      <div class="text-sm text-muted" style="margin-top:2px;">
                        Installed: <b>v${escapeHtml(currentVer)}</b> &bull; Remote: <b>v${escapeHtml(remoteVer)}</b> &bull; Channel: <b>Stable (main)</b>
                      </div>
                      <div class="text-xs text-muted" style="margin-top:4px;">
                        Last checked: ${checkedTime}
                      </div>
                    </div>
                  </div>

                  <!-- Actions -->
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button class="btn btn-sm btn-secondary" id="check-update-btn" title="Force fresh update check from GitHub">
                      ${Icons.refresh} Check for Updates
                    </button>
                    ${isUpdate ? `
                      <button class="btn btn-sm btn-primary" id="auto-update-btn" style="background:var(--accent);color:#000;font-weight:700;">
                        ${Icons.download} Update to v${escapeHtml(remoteVer)} Now
                      </button>
                    ` : `
                      <button class="btn btn-sm btn-secondary" id="force-reinstall-btn" title="Re-pull latest image & restart">
                        ⚡ Re-pull Latest Image
                      </button>
                    `}
                  </div>
                </div>
              </div>

              <!-- What's New / Release Notes -->
              ${changes.length > 0 ? `
                <div class="card" style="padding:16px 20px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
                  <div style="font-weight:700;font-size:14px;color:var(--text-primary);margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                    What's new in DockGate
                  </div>
                  <div style="max-height:220px;overflow-y:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 16px;font-size:12px;line-height:1.7;">
                    ${changes.map(c => {
                      const isHeader = c.startsWith('📌');
                      return isHeader
                        ? `<div style="font-weight:700;color:var(--text-primary);margin-top:8px;margin-bottom:4px;">${mdInline(c.replace(/^📌\s*/, ''))}</div>`
                        : `<div style="color:var(--text-secondary);padding-left:8px;">&bull; ${mdInline(c)}</div>`;
                    }).join('')}
                  </div>
                </div>
              ` : ''}

              <!-- Manual Update Instructions Card -->
              <div class="card" style="padding:16px 20px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <div style="font-weight:600;font-size:13px;color:var(--text-primary);">Manual Terminal Update</div>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-xs btn-secondary" id="copy-update-cmd">${Icons.copy} Copy Commands</button>
                    <a href="${repoUrl}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub Repository</a>
                  </div>
                </div>
                <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;font-family:var(--font-mono);font-size:12px;line-height:1.6;color:#38bdf8;">
                  docker compose pull && docker compose up -d
                </div>
              </div>

            </div>
          `;

          // Handler for Update / Re-pull action
          const handleApplyUpdate = (targetVer) => {
            showConfirm('Update DockGate', `This will pull the latest Docker image (v${escapeHtml(targetVer)}) and recreate the container. Your databases and configs will be preserved.`, async () => {
              showModal('Updating DockGate', `
                <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px 12px;text-align:center;">
                  <div style="width:42px;height:42px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;"></div>
                  <div>
                    <div style="font-weight:700;font-size:15px;margin-bottom:6px;">Pulling Image &amp; Recreating Container…</div>
                    <div class="text-sm text-muted">Updating from v${escapeHtml(currentVer)} to v${escapeHtml(targetVer)}.</div>
                    <div class="text-xs text-muted" style="margin-top:6px;">DockGate is pulling <code>ghcr.io/ali7zeynalli/dockgate:latest</code>. The panel will auto-reload as soon as the new container starts.</div>
                  </div>
                </div>
                <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
              `, []);

              try {
                await API.post('/meta/update/apply');
                if (typeof hideUpdateBadge === 'function') hideUpdateBadge();
              } catch(e) {
                // Expected HTTP drop during restart
              }

              // Heartbeat Auto-Reconnect Polling
              let attempts = 0;
              const pollTimer = setInterval(async () => {
                attempts++;
                try {
                  const res = await fetch('/api/auth/status', { cache: 'no-store' });
                  if (res.ok) {
                    clearInterval(pollTimer);
                    window.location.reload();
                  }
                } catch (err) {}
                if (attempts > 90) {
                  clearInterval(pollTimer);
                  window.location.reload();
                }
              }, 2000);
            });
          };

          document.getElementById('auto-update-btn')?.addEventListener('click', () => handleApplyUpdate(remoteVer));
          document.getElementById('force-reinstall-btn')?.addEventListener('click', () => handleApplyUpdate(currentVer));

          document.getElementById('check-update-btn')?.addEventListener('click', () => {
            if (typeof checkForUpdates === 'function') checkForUpdates(true);
            renderUpdate();
          });

          document.getElementById('copy-update-cmd')?.addEventListener('click', () => {
            navigator.clipboard.writeText('docker compose pull && docker compose up -d').then(() => showToast('Commands copied to clipboard'));
          });

        } catch(e) {
          tabContent.innerHTML = `
            <div class="settings-section">
              <div class="card" style="padding:18px 20px;border-left:4px solid #ef4444;background:var(--bg-secondary);">
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
                  <div>
                    <div style="font-weight:700;font-size:14px;color:#ef4444;margin-bottom:4px;">Could not check for updates</div>
                    <div class="text-xs text-muted">${escapeHtml(e.message || 'Network error')}</div>
                  </div>
                  <div style="display:flex;gap:8px;">
                    <button class="btn btn-sm btn-secondary" id="retry-update-btn">${Icons.refresh} Retry</button>
                    <a href="https://github.com/Ali7Zeynalli/dockgate" target="_blank" class="btn btn-sm btn-secondary">${Icons.externalLink} GitHub</a>
                  </div>
                </div>
              </div>
            </div>
          `;
          document.getElementById('retry-update-btn')?.addEventListener('click', () => {
            if (typeof checkForUpdates === 'function') checkForUpdates(true);
            renderUpdate();
          });
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

    } catch (err) { content.innerHTML = `${UI.errorState(err)}`; }
  }

  await render();
});
