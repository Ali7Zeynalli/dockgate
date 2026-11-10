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

      // The sidebar lists the Settings pages, so there is no tab bar here. Changes save as you make them.
      content.innerHTML = `<div id="settings-tab-content"></div>`;

      const tabContent = document.getElementById('settings-tab-content');
      const validTabs = ['general', 'notifications', 'update', 'system', 'security'];
      let activeTab = (params && validTabs.includes(params.tab)) ? params.tab : 'general';

      function renderTab(tab) {
        if (tab === 'general') renderGeneral();
        else if (tab === 'notifications') renderNotifications();
        else if (tab === 'update') renderUpdate();
        else if (tab === 'system') renderSystemInfo(tabContent); // Docker / OS info (system.js)
        else if (tab === 'security') renderSecurity();
      }

      // ==================== SECURITY TAB ====================
      function renderSecurity() {
        tabContent.innerHTML = `
          ${UI.header('Security', 'Who can open DockGate.')}
          ${UI.settings([
            { label: 'Admin password', desc: 'Needed to sign in to DockGate. Changing it keeps you signed in here and signs out every other browser and device.', value: '<span class="text-muted">••••••••</span>', action: UI.btn('Change…', 'id="sec-change"') },
          ])}
          <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title" style="color:var(--danger)">Danger zone</div></div></div>
          <div style="border:1px solid var(--danger);border-radius:var(--radius-lg);overflow:hidden">
            ${UI.settings([{ label: 'Sign out everywhere', desc: 'Ends every DockGate session, this one too. Use it if you signed in on a machine you do not trust or think a session was copied.', action: `<button class="btn btn-xs btn-secondary" id="sec-logout-all" style="color:var(--danger)">Sign out everywhere…</button>` }])}
          </div>
        `;
        document.getElementById('sec-logout-all')?.addEventListener('click', () => showConfirm('Sign out everywhere', 'Every DockGate session ends now, including this one. You will need the admin password to log in again.', async () => {
          try { await API.post('/auth/logout-all'); location.reload(); } catch (e) { showToast(e.message, 'error'); }
        }, true));
        // Password fields sit in a <form> with a hidden username so password managers recognise them.
        document.getElementById('sec-change')?.addEventListener('click', () => UI.dialog({
          title: 'Change admin password', saveLabel: 'Change password', context: false,
          body: `<form id="sec-form" autocomplete="on" onsubmit="return false">
              <input type="text" name="username" autocomplete="username" value="admin" readonly aria-hidden="true" tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">
              <div style="display:flex;flex-direction:column;gap:10px;">
                <input class="input" id="sec-cur" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password">
                <input class="input" id="sec-new" type="password" placeholder="New password (at least 8 characters)" autocomplete="new-password" aria-label="New password">
                <input class="input" id="sec-new2" type="password" placeholder="New password again" autocomplete="new-password" aria-label="Confirm new password">
              </div>
            </form>`,
          onSave: async (ov) => {
            const cur = ov.querySelector('#sec-cur').value, nw = ov.querySelector('#sec-new').value, nw2 = ov.querySelector('#sec-new2').value;
            if (!cur || !nw) throw new Error('Fill in all three fields.');
            if (nw !== nw2) throw new Error('The two new passwords are different.');
            if (nw.length < 8) throw new Error('The new password needs at least 8 characters.');
            await API.post('/auth/change-password', { currentPassword: cur, newPassword: nw });
            showToast('Password changed');
          },
        }));
      }

      // ==================== GENERAL TAB ====================
      function renderGeneral() {
        // Full IANA zone list (modern engines) + "Auto" fallback
        const zones = (typeof Intl.supportedValuesOf === 'function') ? Intl.supportedValuesOf('timeZone') : [];
        const curTz = settings.timezone || 'auto';
        const tzOptions = [`<option value="auto"${curTz === 'auto' ? ' selected' : ''}>Auto (browser)</option>`]
          .concat(zones.map(z => `<option value="${z}"${z === curTz ? ' selected' : ''}>${z}</option>`))
          .join('');
        const sel = (id, opts, cur) => `<select class="select" id="${id}" aria-label="${id}">${opts.map(([v, l]) => `<option value="${v}"${String(cur) === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
        tabContent.innerHTML = `
          ${UI.header('General', 'How DockGate looks and behaves. Changes are saved as soon as you make them.')}
          <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Appearance</div></div></div>
          ${UI.settings([
            { label: 'Theme', desc: 'Light or dark.', value: sel('set-theme', [['dark', 'Dark'], ['light', 'Light']], settings.theme || 'dark') },
            { label: 'Container list', desc: 'How Resources → Containers opens: table or cards.', value: sel('set-view', [['table', 'Table'], ['card', 'Cards']], settings.defaultView || 'table') },
            { label: 'Timezone', desc: 'Used for dates on every page and in notifications.', value: `<select class="select" id="set-timezone" aria-label="Timezone">${tzOptions}</select>` },
          ])}
          <div class="ui-ph"><div class="ui-ph-title">Terminal and logs</div></div>
          ${UI.settings([
            { label: 'Default shell', desc: 'Shell picked first in Tools → Terminal and the quick terminal. You can still change it there.', value: sel('set-shell', [['/bin/sh', '/bin/sh'], ['/bin/bash', '/bin/bash'], ['/bin/zsh', '/bin/zsh']], settings.terminalShell || '/bin/sh') },
            { label: 'Log timestamps', desc: 'Show the time column in container logs (Observe → Logs and the container page). Time filters work either way.', action: `<div class="toggle ${settings.logTimestamps === 'true' ? 'active' : ''}" id="set-logtimes" role="switch" tabindex="0" aria-checked="${settings.logTimestamps === 'true'}" aria-label="Log timestamps"></div>` },
          ])}
          <div class="ui-ph"><div class="ui-ph-title">DockGate service</div></div>
          ${UI.settings([
            { label: 'Start with Docker', desc: 'Start the DockGate container whenever Docker starts on this machine (restart policy “unless-stopped”). Off means you start it by hand after a reboot.', action: `<div class="toggle ${isAutoStart ? 'active' : ''}" id="set-autostart" role="switch" tabindex="0" aria-checked="${!!isAutoStart}" aria-label="Start with Docker"></div>` },
          ])}
        `;

        // Each control saves on its own (no page-wide Save button), then confirms with a toast.
        const save = async (patch, label) => {
          try {
            await API.post('/meta/settings', patch);
            Object.assign(settings, patch);
            rememberSettings(settings);
            if (patch.theme) { applyTheme(patch.theme); localStorage.setItem('dcc_theme', patch.theme); }
            if (patch.timezone) localStorage.setItem('dcc_timezone', patch.timezone);
            showToast(`Saved · ${label}`);
          } catch (e) { showToast(e.message, 'error'); }
        };
        document.getElementById('set-theme')?.addEventListener('change', (e) => save({ theme: e.target.value }, 'theme'));
        document.getElementById('set-view')?.addEventListener('change', (e) => save({ defaultView: e.target.value }, 'container list'));
        document.getElementById('set-timezone')?.addEventListener('change', (e) => save({ timezone: e.target.value }, 'timezone'));
        document.getElementById('set-shell')?.addEventListener('change', (e) => save({ terminalShell: e.target.value }, 'default shell'));
        const toggle = (el, fn) => {
          if (!el) return;
          const flip = () => { const on = !el.classList.contains('active'); el.classList.toggle('active', on); el.setAttribute('aria-checked', on); fn(on, el); };
          el.addEventListener('click', flip);
          el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
        };
        toggle(document.getElementById('set-logtimes'), (on) => save({ logTimestamps: on ? 'true' : 'false' }, `log timestamps ${on ? 'on' : 'off'}`));
        toggle(document.getElementById('set-autostart'), async (on, el) => {
          try {
            const r = await API.post('/meta/autostart', { enabled: on });
            isAutoStart = r.policy !== 'no';
            showToast(`Saved · start with Docker ${isAutoStart ? 'on' : 'off'}`);
          } catch (e) { el.classList.toggle('active', !on); el.setAttribute('aria-checked', !on); showToast(e.message, 'error'); }
        });
      }

      // ==================== NOTIFICATIONS TAB ====================
      async function renderNotifications() {
        tabContent.innerHTML = '<div class="text-muted text-sm">Loading notification settings...</div>';

        try {
          const [smtpConfig, tgConfig, rules, hostNotifs, whConfig] = await Promise.all([
            API.get('/meta/smtp'),
            API.get('/meta/telegram'),
            API.get('/meta/notifications/rules'),
            API.get('/meta/notifications/hosts').catch(() => ({ local: { enabled: true }, servers: [] })),
            API.get('/meta/webhook').catch(() => ({ configured: false, format: 'json' })),
          ]);
          const WH_FORMATS = [['slack', 'Slack'], ['discord', 'Discord'], ['teams', 'Microsoft Teams'], ['ntfy', 'ntfy'], ['json', 'JSON (your own system)']];
          const whLabel = (WH_FORMATS.find(f => f[0] === whConfig.format) || [, 'JSON'])[1];


          const emailConfigured = !!(smtpConfig.smtp_host);
          const tgConfigured = !!(tgConfig.tg_chat_id);

          tabContent.innerHTML = `
            ${UI.header('Notifications', 'Where alerts go (channels), which servers send them, and which events trigger them (rules).', `<button class="btn btn-secondary btn-sm" onclick="Router.navigate('observe',{tab:'notification-log'})">See what was sent</button>`)}
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

              <!-- Webhook: Slack, Discord, Teams, ntfy or JSON -->
              ${UI.settings([{ label: 'Webhook', desc: 'Sends every alert to one URL: Slack, Discord, Microsoft Teams, ntfy, or JSON for your own system.',
                value: whConfig.configured ? `${UI.pill('ok', 'on')} <span class="ui-sub">${escapeHtml(whLabel)} · <span class="td-mono">${escapeHtml(whConfig.url)}</span></span>` : UI.pill('off', 'not set up'),
                action: `${whConfig.configured ? UI.btn('Send test', 'id="test-webhook"') + ' ' : ''}${UI.btn(whConfig.configured ? 'Edit' : 'Set up…', 'id="edit-webhook"')}${whConfig.configured ? ' ' + UI.btn('Remove…', 'id="clear-webhook"') : ''}` }])}
            </div>

            <!-- Monitored Hosts / Server Muting -->
            <div class="settings-section" style="margin-top:20px;">
              <div class="settings-section-title">Muted servers</div>
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

            <!-- Rules: shared alert rules (alert-rules-panel.js) -->
            <div id="alert-rules-box" style="margin-top:20px"></div>

            <div class="settings-section" style="margin-top:20px;">
              ${UI.settings([{ label: 'Edge agent', desc: 'Keeps watching a server and sends these alerts when DockGate cannot reach it. Installed per server, so it now lives under Servers.', action: UI.btn('Open Edge agent', 'id="open-edge-agent"') }])}
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
          renderAlertRules(document.getElementById('alert-rules-box'));

          document.getElementById('edit-webhook')?.addEventListener('click', () => UI.dialog({
            title: 'Webhook channel', context: false,
            body: `<div class="ui-field"><label for="wh-format">Format</label><select class="select" id="wh-format">${WH_FORMATS.map(([v, l]) => `<option value="${v}" ${v === whConfig.format ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
              <div class="ui-field"><label for="wh-url">URL</label><input class="input" id="wh-url" placeholder="${whConfig.configured ? 'Leave empty to keep the current URL' : 'https://hooks.slack.com/services/…'}" autocomplete="off"><span class="ui-help">The URL is stored encrypted. For ntfy use the topic URL, e.g. https://ntfy.sh/my-dockgate.</span></div>
              ${UI.explain('Every alert of every enabled rule is also sent here.', 'JSON format sends <span class="td-mono">{ event, server, title, text, time }</span>.')}`,
            onSave: async (ov) => {
              const url = ov.querySelector('#wh-url').value.trim();
              if (!url && !whConfig.configured) throw new Error('Enter the webhook URL');
              await API.post('/meta/webhook', { format: ov.querySelector('#wh-format').value, ...(url ? { url } : {}) });
              showToast('Webhook saved');
              renderNotifications();
            },
          }));
          document.getElementById('test-webhook')?.addEventListener('click', async (e) => {
            e.target.disabled = true;
            try { await API.post('/meta/webhook/test'); showToast('Test message sent to the webhook'); }
            catch (er) { showToast(`Webhook failed: ${er.message}`, 'error', 9000); }
            finally { e.target.disabled = false; }
          });
          document.getElementById('clear-webhook')?.addEventListener('click', () => showConfirm('Remove webhook', 'Alerts stop going to this webhook. Email and Telegram are not affected.', async () => {
            try { await API.del('/meta/webhook'); showToast('Webhook removed'); renderNotifications(); } catch (er) { showToast(er.message, 'error'); }
          }, true));

          // Edge Agent (per-server observability) — always render; agent can install in metrics-only mode.
          document.getElementById('open-edge-agent')?.addEventListener('click', () => Router.navigate('infra', { tab: 'agent' }));

        } catch(e) {
          tabContent.innerHTML = '<div class="text-xs text-muted">Could not load notification settings.</div>';
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
            ${UI.header('Software update', 'Your DockGate version and what changed in newer ones.')}
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

      // Initial tab render — honour the restored activeTab (not always General)
      renderTab(activeTab);

    } catch (err) { content.innerHTML = `${UI.errorState(err)}`; }
  }

  await render();
});
