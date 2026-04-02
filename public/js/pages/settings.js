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

      // Auto-update yoxla
      try {
        const updateInfo = await API.get('/meta/update/check');
        const updateEl = document.getElementById('update-section');
        if (updateInfo.updateAvailable) {
          updateEl.innerHTML = `
            <div class="insight-card info" style="margin-bottom:12px;">
              <span>${Icons.info}</span>
              <span>A new version is available. ${updateInfo.pendingCommits} new commit(s) found. Update is optional.</span>
            </div>
            <div style="margin-bottom:12px;">
              <div class="text-sm text-muted" style="margin-bottom:8px;">Current version: v${updateInfo.currentVersion}</div>
              <div style="max-height:150px;overflow-y:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 12px;font-family:var(--font-mono);font-size:11px;">
                ${updateInfo.commits.map(c => `<div style="padding:2px 0;">${escapeHtml(c)}</div>`).join('')}
              </div>
            </div>
            <button class="btn btn-primary" id="apply-update">${Icons.download} Update Now</button>
            <button class="btn btn-secondary" id="skip-update" style="margin-left:8px;">Skip</button>
            <a href="${updateInfo.repoUrl}" target="_blank" class="btn btn-secondary" style="margin-left:8px;">${Icons.externalLink} GitHub</a>
          `;
          document.getElementById('apply-update')?.addEventListener('click', async () => {
            showConfirm('Update DockGate', 'This will pull latest changes from GitHub and restart the server. Your data will not be affected. Continue?', async () => {
              try {
                showToast('Updating... Server will restart shortly.', 'info', 10000);
                await API.post('/meta/update/apply');
              } catch(e) { /* server restarting */ }
            });
          });
          document.getElementById('skip-update')?.addEventListener('click', () => {
            updateEl.innerHTML = `<div class="text-sm text-muted">Update skipped. You can check again anytime.</div>`;
          });
        } else {
          updateEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="color:var(--success);">✓</span>
              <div>
                <div class="text-sm">DockGate is up to date</div>
                <div class="text-xs text-muted">v${updateInfo.currentVersion}</div>
              </div>
              <button class="btn btn-xs btn-secondary" id="check-update-btn">${Icons.refresh} Check</button>
              <a href="${updateInfo.repoUrl || 'https://github.com/Ali7Zeynalli/dockgate'}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} GitHub</a>
            </div>
          `;
          document.getElementById('check-update-btn')?.addEventListener('click', () => render());
        }
      } catch(e) {
        document.getElementById('update-section').innerHTML = `<div class="text-sm text-muted">Could not check for updates</div>`;
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
