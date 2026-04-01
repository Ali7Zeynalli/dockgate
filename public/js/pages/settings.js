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
      `;

      // Toggle interactions
      document.getElementById('set-logtimes')?.addEventListener('click', function() {
        this.classList.toggle('active');
      });
      
      document.getElementById('set-autostart')?.addEventListener('click', function() {
        this.classList.toggle('active');
      });

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
