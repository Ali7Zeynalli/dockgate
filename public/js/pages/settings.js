// Settings Page
Router.register('settings', async (content) => {
  async function render() {
    try {
      const [settings, autostartRes] = await Promise.all([
        Store.get('settings') ? Promise.resolve(Store.get('settings')) : API.get('/meta/settings'),
        API.get('/meta/autostart').catch(() => ({ enabled: true }))
      ]);
      
      Store.set('settings', settings);
      let isAutoStart = autostartRes.enabled;

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Settings</div><div class="page-subtitle">Configure DockGate Control</div></div>
          <div class="page-actions"><button class="btn btn-primary" id="save-settings">Save Settings</button></div>
        </div>

        <div class="grid-2">
          <div class="settings-section">
            <div class="settings-section-title">General</div>
            
            <div class="settings-row">
              <div>
                <div class="settings-row-label">Theme</div>
                <div class="settings-row-desc">Application visual style</div>
              </div>
              <select class="select" id="set-theme">
                <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
                <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light (Soon)</option>
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
                <div class="settings-row-label">Auto-Start Service</div>
                <div class="settings-row-desc">Automatically run panel when Docker daemon boots</div>
              </div>
              <div class="toggle ${isAutoStart ? 'active' : ''}" id="set-autostart"></div>
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
                <div class="settings-row-desc">Show time for each log entry</div>
              </div>
              <div class="toggle ${settings.logTimestamps === 'true' ? 'active' : ''}" id="set-logtimes"></div>
            </div>
          </div>
        </div>

        <div class="settings-section" style="margin-top:24px;">
          <div class="settings-section-title">Software Update</div>
          <div id="update-section" style="padding:4px 0;">
            <div class="text-muted text-sm">Checking for updates...</div>
          </div>
        </div>
      `;

      // Toggle interactions
      document.getElementById('set-logtimes')?.addEventListener('click', function() {
        this.classList.toggle('active');
      });
      
      document.getElementById('set-autostart')?.addEventListener('click', function() {
        this.classList.toggle('active');
      });

      // Check for auto-update / Auto-update yoxla
      try {
        const updateInfo = await API.get('/meta/update/check');
        const updateEl = document.getElementById('update-section');
        if (updateInfo.updateAvailable) {
          updateEl.innerHTML = `
            <div class="insight-card info" style="margin-bottom:12px;">
              <span>${Icons.info}</span>
              <span>A new version is available: v${escapeHtml(updateInfo.remoteVersion)}. Update is optional.</span>
            </div>
            <div style="margin-bottom:12px;">
              <div class="text-sm text-muted" style="margin-bottom:4px;">Current: v${updateInfo.currentVersion}${updateInfo.currentCommit && updateInfo.currentCommit !== 'unknown' ? ' (' + updateInfo.currentCommit + ')' : ''} → Latest: v${updateInfo.remoteVersion}${updateInfo.remoteCommit && updateInfo.remoteCommit !== 'unknown' ? ' (' + updateInfo.remoteCommit + ')' : ''}</div>
            </div>
            ${updateInfo.changes && updateInfo.changes.length > 0 ? `
            <div style="margin-bottom:12px;">
              <div class="text-xs text-muted" style="margin-bottom:6px;">What's new:</div>
              <div style="max-height:120px;overflow-y:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 12px;font-size:12px;">
                ${updateInfo.changes.map(c => `<div style="padding:2px 0;">• ${escapeHtml(c)}</div>`).join('')}
              </div>
            </div>` : ''}
            <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:12px;font-family:var(--font-mono);font-size:12px;line-height:1.8;">
              <div class="text-xs text-muted" style="margin-bottom:6px;font-family:var(--font-sans);">To update manually, run on your host:</div>
              <div>docker compose pull</div>
              <div>docker compose up -d</div>
            </div>
            <button class="btn btn-primary btn-sm" id="auto-update-btn">${Icons.download} Update Now</button>
            <button class="btn btn-secondary btn-sm" id="copy-update-cmd" style="margin-left:8px;">${Icons.copy} Copy Commands</button>
            <a href="${updateInfo.repoUrl}" target="_blank" class="btn btn-secondary btn-sm" style="margin-left:8px;">${Icons.externalLink} GitHub</a>
          `;
          document.getElementById('auto-update-btn')?.addEventListener('click', () => {
            showConfirm('Update DockGate', 'This will pull the latest Docker image and restart the container. Your data will be preserved. The panel will restart automatically.', async () => {
              try {
                showToast('Updating... Panel will restart in a moment.', 'info', 15000);
                await API.post('/meta/update/apply');
                // Hide badge / Badge-i gizlət
                localStorage.setItem('dcc_update_available', 'false');
                const badge = document.getElementById('badge-settings');
                if (badge) badge.style.display = 'none';
              } catch(e) { showToast('Update started, panel will restart...', 'info', 10000); }
            });
          });
          document.getElementById('copy-update-cmd')?.addEventListener('click', () => {
            navigator.clipboard.writeText('docker compose pull && docker compose up -d').then(() => showToast('Commands copied', 'success'));
          });
        } else {
          updateEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="color:var(--success);">✓</span>
              <div>
                <div class="text-sm">DockGate is up to date</div>
                <div class="text-xs text-muted">v${updateInfo.currentVersion}${updateInfo.currentCommit && updateInfo.currentCommit !== 'unknown' ? ' (' + updateInfo.currentCommit + ')' : ''}</div>
              </div>
              <button class="btn btn-xs btn-secondary" id="check-update-btn">${Icons.refresh} Check</button>
              <a href="${updateInfo.repoUrl || 'https://github.com/Ali7Zeynalli/dockgate'}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub</a>
            </div>
          `;
          document.getElementById('check-update-btn')?.addEventListener('click', () => render());
        }
      } catch(e) {
        document.getElementById('update-section').innerHTML = `
          <div style="display:flex;align-items:center;gap:12px;">
            <span class="text-muted">⚠</span>
            <div>
              <div class="text-sm">Could not check for updates</div>
              <div class="text-xs text-muted">Check your internet connection or try again later</div>
            </div>
            <button class="btn btn-xs btn-secondary" id="retry-update-btn">${Icons.refresh} Retry</button>
            <a href="https://github.com/Ali7Zeynalli/dockgate" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub</a>
          </div>
        `;
        document.getElementById('retry-update-btn')?.addEventListener('click', () => render());
      }

      // Save
      document.getElementById('save-settings')?.addEventListener('click', async () => {
        const newSettings = {
          theme: document.getElementById('set-theme').value,
          defaultView: document.getElementById('set-view').value,
          terminalShell: document.getElementById('set-shell').value,
          logTimestamps: document.getElementById('set-logtimes').classList.contains('active') ? 'true' : 'false'
        };

        const newAutoStart = document.getElementById('set-autostart').classList.contains('active');

        try {
          await API.post('/meta/settings', newSettings);
          
          if (newAutoStart !== isAutoStart) {
             const asRes = await API.post('/meta/autostart', { enabled: newAutoStart });
             isAutoStart = asRes.policy !== 'no';
          }
          
          Store.set('settings', { ...settings, ...newSettings });
          showToast('Settings saved successfully');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  
  await render();
});
