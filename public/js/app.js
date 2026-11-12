// Navigation setup
// One list drives the sidebar, the section pages (tabbed-section.js) and the top-bar breadcrumb. A section's
// pages are reached from the sidebar only; old links (#/activity?tab=…, #/infra?tab=registries) are sent to
// the new place by Router.resolve.
const navItems = {
  dashboard: { label: 'Dashboard', icon: Icons.dashboard },
  monitoring: { label: 'Monitoring', icon: Icons.chart },
  resources: { label: 'Resources', icon: Icons.layers, tabs: [['containers', 'Containers'], ['images', 'Images'], ['volumes', 'Volumes'], ['networks', 'Networks'], ['builds', 'Builds'], ['prune', 'Prune']], default: 'containers' },
  deploy: { label: 'Deploy', icon: Icons.compose, tabs: [['compose', 'Compose stacks'], ['templates', 'App templates'], ['registries', 'Registries']], default: 'compose' },
  observe: { label: 'Observe', icon: Icons.events, tabs: [['logs', 'Logs'], ['events', 'Events'], ['audit', 'Audit log'], ['notification-log', 'Notifications sent']], default: 'logs' },
  swarm: { label: 'Swarm', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/></svg>', tabs: [['swarm-overview', 'Overview'], ['swarm-nodes', 'Nodes'], ['swarm-services', 'Services'], ['swarm-scaling', 'Auto Scaling'], ['swarm-stacks', 'Stacks'], ['swarm-migrate', 'Migrate'], ['swarm-secrets', 'Secrets & configs'], ['swarm-networks', 'Networks'], ['swarm-settings', 'Cluster settings']], default: 'swarm-overview' },
  tools: { label: 'Tools', icon: Icons.terminal, tabs: [['terminal', 'Terminal'], ['files', 'Files'], ['schedules', 'Schedules']], default: 'terminal' },
  infra: { label: 'Servers', icon: Icons.system, tabs: [['servers', 'Servers'], ['sshkeys', 'SSH keys'], ['agent', 'Edge agent']], default: 'servers' },
  'server-console': { label: 'Server Console', icon: Icons.terminal, tabs: [['overview', 'Overview'], ['monitoring', 'Monitoring'], ['setup', 'Setup'], ['access', 'Access & SSH'], ['users', 'Users & keys'], ['firewall', 'Firewall'], ['fail2ban', 'Fail2ban'], ['manage', 'Services'], ['logs', 'Logs'], ['settings', 'Settings']], default: 'overview' },
  settings: { label: 'Settings', icon: Icons.settings, tabs: [['general', 'General'], ['notifications', 'Notifications'], ['update', 'Software update'], ['system', 'System'], ['security', 'Security']], default: 'general' }
};

// DOCKER (what runs) · SERVER (the hosts) · SYSTEM (DockGate itself).
const navGroups = [
  { label: 'Overview', items: ['dashboard', 'monitoring'] },
  { label: 'Docker', items: ['resources', 'deploy', 'swarm', 'observe', 'tools'] },
  { label: 'Server', items: ['infra', 'server-console'] },
  { label: 'System', items: ['settings'] }
];

function initMacSidebar() {
  const sidebarNav = document.getElementById('sidebar-nav');
  if (!sidebarNav) return;

  let html = '';

  navGroups.forEach((group) => {
    let itemsHtml = '';

    group.items.forEach(key => {
      const item = navItems[key];
      if (!item) return;
      if (item.tabs) {
        // A section with sub-tabs → a collapsible parent + its tabs as sidebar sub-items (auto-expands
        // when active, so the sidebar stays compact). The in-page tab bar still works too.
        itemsHtml += `
          <a class="nav-item nav-parent" data-page="${key}" data-default="${item.default}">
            <span class="nav-item-icon">${item.icon}</span>
            <span style="flex:1">${item.label}</span>
            <span class="nav-badge" id="badge-${key}" style="display:none;margin-right:6px;"></span>
            <span class="nav-caret">▸</span>
          </a>
          <div class="nav-subitems" id="nav-sub-${key}">
            ${item.tabs.map(([tab, label]) => `
              <a class="nav-subitem" data-page="${key}" data-tab="${tab}" style="display:flex;align-items:center;justify-content:space-between;">
                <span>${label}</span>
                <span class="nav-badge" id="badge-${key}-${tab}" style="display:none"></span>
              </a>
            `).join('')}
          </div>
        `;
        return;
      }
      const active = (key === 'dashboard') ? 'active' : '';
      itemsHtml += `
        <a class="nav-item ${active}" data-page="${key}">
          <span class="nav-item-icon">${item.icon}</span>
          <span style="flex:1">${item.label}</span>
          <span class="nav-badge" id="badge-${key}" style="display:none"></span>
        </a>
      `;
    });

    html += `
      <div class="nav-group">
        <div class="nav-group-header">${group.label}</div>
        <div class="nav-group-items">${itemsHtml}</div>
      </div>
    `;
  });

  sidebarNav.innerHTML = html;

  // "Server Console" is always shown as a standard nav item. Clicking it opens the active remote
  // server's console; with none active it sends the user to Servers to add/pick one (handler below).

  // Open the active remote server's console at `tab` (Server Console's tabs need a server id, so its
  // sidebar items inject the active server here). With no remote server yet, hint + go pick one.
  const goConsole = (tab) => {
    const active = Store.get('activeServer');
    if (active && active.id !== 'local' && active.type !== 'local') Router.navigate('server-console', { id: active.id, tab });
    else {
      if (typeof showToast === 'function') showToast('Add a remote server first — a console needs one', 'info', 5000);
      Router.navigate('infra', { tab: 'servers' });
    }
  };

  // Phones / narrow windows: the sidebar is a drawer (☰). It closes after a navigation, on Esc and when
  // the dimmed page behind it is tapped.
  const app = document.getElementById('app'), toggle = document.getElementById('nav-toggle'), backdrop = document.getElementById('nav-backdrop');
  const setNav = (open) => {
    app.classList.toggle('nav-open', open);
    if (backdrop) backdrop.hidden = !open;
    if (toggle) { toggle.setAttribute('aria-expanded', open); toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); }
  };
  toggle?.addEventListener('click', () => setNav(!app.classList.contains('nav-open')));
  backdrop?.addEventListener('click', () => setNav(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.classList.contains('nav-open')) setNav(false); });
  sidebarNav.addEventListener('click', (e) => { if (e.target.closest('.nav-item, .nav-subitem')) setTimeout(() => setNav(false), 0); });

  sidebarNav.addEventListener('click', (e) => {
    // A sidebar sub-item (a section's tab) → navigate straight to that tab.
    const subitem = e.target.closest('.nav-subitem');
    if (subitem) {
      if (subitem.dataset.page === 'server-console') { goConsole(subitem.dataset.tab); return; }
      Router.navigate(subitem.dataset.page, { tab: subitem.dataset.tab });
      return;
    }
    const item = e.target.closest('.nav-item');
    if (!item) return;
    const page = item.dataset.page;
    // Server Console header → its default tab on the active server (id injected by goConsole).
    if (page === 'server-console') { goConsole(item.dataset.default || 'overview'); return; }
    // A section header → open its default tab (syncSidebarTabs then expands it).
    if (item.classList.contains('nav-parent')) { Router.navigate(page, { tab: item.dataset.default }); return; }
    if (page) Router.navigate(page);
  });

  // Keep the sidebar in sync with the route: expand the active section, highlight its active sub-item,
  // collapse the rest. Fires when Router toggles a section's .active class, and on Back/Forward.
  sidebarNav.querySelectorAll('.nav-parent').forEach(p => new MutationObserver(syncSidebarTabs).observe(p, { attributes: true, attributeFilter: ['class'] }));
  window.addEventListener('hashchange', syncSidebarTabs);
  syncSidebarTabs();
}

// Mirror the active in-page tab into the sidebar: expand the active section, highlight its active
// sub-item, collapse the others. (Router already toggles the parent's .active class on navigation.)
function syncSidebarTabs() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  // The entry for the page shown: a detail page (a container, a Swarm service or node) lights up its list.
  const target = (typeof Router !== 'undefined' && Router.currentPage) ? Router.navTarget() : null;
  const tab = target ? (target.tab || '') : (new URLSearchParams((location.hash.split('?')[1] || '')).get('tab') || '');
  if (target) nav.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === target.page));
  nav.querySelectorAll('.nav-parent').forEach(parent => {
    const on = parent.classList.contains('active');
    const sub = document.getElementById('nav-sub-' + parent.dataset.page);
    if (sub) sub.classList.toggle('open', on);
    const caret = parent.querySelector('.nav-caret');
    if (caret) caret.style.transform = on ? 'rotate(90deg)' : '';
  });
  nav.querySelectorAll('.nav-subitem').forEach(s => {
    const parent = nav.querySelector(`.nav-parent[data-page="${s.dataset.page}"]`);
    const parentOn = parent?.classList.contains('active');
    // On a bare section URL (no ?tab), the page shows the default tab — highlight it to match.
    const effTab = tab || parent?.dataset.default;
    s.classList.toggle('active', !!parentOn && s.dataset.tab === effTab);
  });
}

// Global search lives in command-palette.js (⌘K / Ctrl+K and the header search box).
function initGlobalSearch() {}

// DockGate settings for pages that need them before Settings was opened (default shell, container list
// layout, log timestamps). Kept in the Store and in localStorage so a hard refresh has them at once.
function rememberSettings(s) {
  Store.set('settings', { ...(Store.get('settings') || {}), ...s });
  try { localStorage.setItem('dcc_settings', JSON.stringify(Store.get('settings'))); } catch (e) { /* private mode */ }
}
function appSetting(key, fallback) {
  let s = Store.get('settings');
  if (!s || !Object.keys(s).length) { try { s = JSON.parse(localStorage.getItem('dcc_settings') || '{}'); } catch (e) { s = {}; } }
  return s && s[key] != null && s[key] !== '' ? s[key] : fallback;
}
window.rememberSettings = rememberSettings;
window.appSetting = appSetting;

// Apply theme to document / Temanı sənədə tətbiq et
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'dark');
}

// ============ AUTH GATE ============
// Show the setup/login screen before the app boots. Returns true if already signed in.
async function ensureAuthenticated() {
  let status;
  try { status = await API.get('/auth/status'); }
  catch (e) { status = { authenticated: false, setupDone: true }; }
  if (status.authenticated) return true;
  renderAuthScreen(status.setupDone ? 'login' : 'setup', { tokenRequired: !!status.setupTokenRequired });
  return false;
}

function renderAuthScreen(mode, { tokenRequired = false } = {}) {
  const root = document.getElementById('auth-root');
  if (!root) return;
  const isSetup = mode === 'setup';
  const appEl = document.getElementById('app');
  if (appEl) appEl.style.display = 'none';
  const title = isSetup ? 'Welcome to DockGate' : 'DockGate';
  const sub = isSetup ? 'Set an admin password to secure the panel' : 'Sign in to continue';
  const btnLabel = isSetup ? 'Create & sign in' : 'Log in';
  root.innerHTML = `
    <div style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#0d1117);">
      <form id="auth-form" style="width:340px;max-width:90vw;background:var(--bg-secondary,#161b22);border:1px solid var(--border,#30363d);border-radius:12px;padding:28px 24px;box-shadow:0 8px 40px rgba(0,0,0,.45);text-align:center;">
        <div style="font-size:40px;margin-bottom:8px;">🐳</div>
        <div style="font-size:18px;font-weight:600;">${title}</div>
        <div style="color:var(--text-muted,#8b949e);font-size:13px;margin:4px 0 18px;">${sub}</div>
        <input class="input" id="auth-pw" type="password" placeholder="Password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" style="width:100%;">
        ${isSetup ? '<input class="input" id="auth-pw2" type="password" placeholder="Confirm password" autocomplete="new-password" style="width:100%;margin-top:8px;">' : ''}
        ${isSetup && tokenRequired ? '<input class="input" id="auth-token" type="text" placeholder="Setup token" autocomplete="off" spellcheck="false" style="width:100%;margin-top:8px;font-family:var(--font-mono,monospace);"><div style="color:var(--text-muted,#8b949e);font-size:11px;margin-top:6px;text-align:left;">You are connecting from outside the local network. The setup token is printed in DockGate\'s log: <code>docker logs dockgate-control-panel</code></div>' : ''}
        <button class="btn btn-primary" type="submit" style="width:100%;margin-top:14px;">${btnLabel}</button>
        <div id="auth-error" style="color:var(--danger,#f85149);font-size:12px;margin-top:10px;min-height:14px;"></div>
        ${isSetup ? '<div style="color:var(--text-muted,#8b949e);font-size:11px;margin-top:6px;">Minimum 8 characters · stored as a scrypt hash.</div>' : ''}
      </form>
    </div>`;
  const err = root.querySelector('#auth-error');
  root.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const pw = root.querySelector('#auth-pw').value;
    try {
      if (isSetup) {
        const pw2 = root.querySelector('#auth-pw2').value;
        if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }
        if (pw !== pw2) { err.textContent = 'Passwords do not match'; return; }
        const tokEl = root.querySelector('#auth-token');
        await API.post('/auth/setup', { password: pw, ...(tokEl ? { setupToken: tokEl.value.trim() } : {}) });
      } else {
        if (!pw) { err.textContent = 'Enter your password'; return; }
        await API.post('/auth/login', { password: pw });
      }
      location.reload();
    } catch (ex) { err.textContent = ex.message || 'Failed'; }
  });
  setTimeout(() => { const i = root.querySelector('#auth-pw'); if (i) i.focus(); }, 50);
}

// Sidebar logout button (global — called from index.html).
async function logout() {
  try { await API.post('/auth/logout'); } catch (e) {}
  location.reload();
}

// A 401 on any data call (expired session) bounces back to the login screen.
window.__authExpired = () => { try { location.reload(); } catch (e) {} };

// Boot application
async function boot() {
  try {
    // Apply saved theme immediately / Saxlanmış temanı dərhal tətbiq et
    const savedTheme = localStorage.getItem('dcc_theme') || 'dark';
    applyTheme(savedTheme);

    // Auth gate — show setup/login first; stop boot here if not signed in.
    if (!(await ensureAuthenticated())) return;

    initMacSidebar();
    initGlobalSearch();
    if (window.QuickTerminal) QuickTerminal.init();

    // Enable browser Back/Forward navigation + hash deep-links
    Router.init();
    if (window.edgeAgentUpdateCheck) edgeAgentUpdateCheck(); // tells you when servers run an older Edge agent

    // Restore the page+params: prefer the URL hash (shareable, survives refresh),
    // then fall back to localStorage (legacy hard-refresh persistence), then default.
    const fromHash = Router._parseHash();
    let startPage, startParams = {};
    if (fromHash && Router.routes[fromHash.path]) {
      startPage = fromHash.path;
      startParams = fromHash.params;
    } else {
      startPage = localStorage.getItem('dcc_last_page') || 'dashboard';
      try { startParams = JSON.parse(localStorage.getItem('dcc_last_params')) || {}; } catch(e){ startParams = {}; }
    }
    // Remap a legacy/bookmarked sub-route (e.g. #/containers) onto its consolidated section tab.
    // Moved pages (#/containers, #/activity?tab=…) are rewritten inside Router.navigate (Router.resolve).
    // replace:true → set the initial hash without adding a spurious history entry
    // Settings first (one small request), so the first page already uses them (container layout, shell…).
    try { rememberSettings(await API.get('/meta/settings')); } catch (e) { /* pages fall back to defaults */ }
    await Router.navigate(startPage, startParams, { replace: true });

    // Load theme + display timezone from server settings / Server settings-dən tema və timezone yüklə
    API.get('/meta/settings').then(s => {
      if (s) rememberSettings(s);
      if (s && s.theme) {
        applyTheme(s.theme);
        localStorage.setItem('dcc_theme', s.theme);
      }
      // Cache timezone so formatTime() works immediately on hard refresh, before Store fills
      if (s && s.timezone) localStorage.setItem('dcc_timezone', s.timezone);
    }).catch(() => {});

    // Show version from package.json in sidebar and detect post-update / Sidebar-da versiyanı göstər və update-i aşkar et
    API.get('/meta/version').then(v => {
      const el = document.getElementById('app-version');
      if (el && v.version) el.textContent = 'v' + v.version;
      
      const lastVersion = localStorage.getItem('dcc_app_version');
      if (lastVersion && lastVersion !== v.version) {
        if (typeof showToast === 'function') {
          showToast(`🎉 DockGate updated to v${v.version}!`, 'success', 8000);
        }
        localStorage.setItem('dcc_update_available', 'false');
      }
      if (v.version) localStorage.setItem('dcc_app_version', v.version);
    }).catch(() => {});

    // Auto update check — on boot and every 5m / Avtomatik update yoxlama — başlanğıcda və hər 5 dəqiqədə bir
    checkForUpdates();
    setInterval(() => checkForUpdates(), 5 * 60 * 1000);

    // Global "deploy running" indicator on the Deploy nav item — so a running deploy is visible from any page.
    checkRunningDeploys();
    setInterval(checkRunningDeploys, 4000);

    // Server switcher (Local + SSH)
    initServerSwitcher();

  } catch (err) {
    document.getElementById('content').innerHTML = `
      <div class="empty-state text-danger">
        <h3>Initialization Failed</h3>
        <p>${err.message}</p>
      </div>
    `;
  }
}

// Check for updates and show badge in sidebar / Update yoxla və sidebar-da badge göstər
async function checkForUpdates(force = false) {
  try {
    const lastCheck = localStorage.getItem('dcc_update_last_check');
    const now = Date.now();

    if (!force && lastCheck && (now - parseInt(lastCheck)) < 5 * 60 * 1000) {
      const cached = localStorage.getItem('dcc_update_available');
      const cachedVer = localStorage.getItem('dcc_update_remote_version') || '';
      if (cached === 'true') showUpdateBadge(cachedVer);
      return;
    }

    const info = await API.get('/meta/update/check');
    localStorage.setItem('dcc_update_last_check', String(now));
    localStorage.setItem('dcc_update_available', String(info.updateAvailable));
    if (info.remoteVersion) localStorage.setItem('dcc_update_remote_version', info.remoteVersion);

    if (info.updateAvailable) {
      showUpdateBadge(info.remoteVersion);
    } else {
      hideUpdateBadge();
    }
  } catch(e) {
    console.log('Update check failed:', e.message);
  }
}

function showUpdateBadge(remoteVer = '') {
  const badgeParent = document.getElementById('badge-settings');
  if (badgeParent) {
    badgeParent.textContent = remoteVer ? `v${remoteVer}` : 'UPDATE';
    badgeParent.style.display = 'inline-flex';
    badgeParent.style.background = '#f59e0b';
    badgeParent.style.color = '#000';
    badgeParent.style.fontWeight = '700';
    badgeParent.style.padding = '1px 6px';
    badgeParent.style.fontSize = '9px';
  }
  const badgeSub = document.getElementById('badge-settings-update');
  if (badgeSub) {
    badgeSub.textContent = '● NEW';
    badgeSub.style.display = 'inline-flex';
    badgeSub.style.background = '#38bdf8';
    badgeSub.style.color = '#000';
    badgeSub.style.fontWeight = '700';
    badgeSub.style.padding = '1px 5px';
    badgeSub.style.fontSize = '8px';
  }
}

function hideUpdateBadge() {
  const badgeParent = document.getElementById('badge-settings');
  if (badgeParent) badgeParent.style.display = 'none';
  const badgeSub = document.getElementById('badge-settings-update');
  if (badgeSub) badgeSub.style.display = 'none';
  localStorage.setItem('dcc_update_available', 'false');
}

// Show a "▶ N" badge on the Deploy nav item while any compose deploy job is running, so it's visible
// from any page. Clicking the Deploy nav (existing handler) lands on Compose, where the live banner shows.
async function checkRunningDeploys() {
  const badge = document.getElementById('badge-deploy');
  if (!badge) return;
  try {
    const jobs = await API.get('/compose/deploy-jobs');
    const running = (jobs || []).filter(j => j.status === 'running').length;
    if (running) { badge.textContent = '▶ ' + running; badge.style.display = 'inline-flex'; }
    else badge.style.display = 'none';
  } catch (e) { /* not logged in / no access — leave the badge hidden */ }
  // Swarm jobs (move to Swarm, redeploy, add servers …): every Swarm page shows the bar to reopen them.
  try {
    const n = (((await API.get('/swarm/jobs')) || {}).jobs || []).filter(j => j.status === 'running').length;
    const b = document.getElementById('badge-swarm');
    if (b) { if (n) { b.textContent = '▶ ' + n; b.style.display = 'inline-flex'; } else b.style.display = 'none'; }
  } catch (e) { /* no access — leave it hidden */ }
  // The same for Edge agent jobs (install / update …) on Servers → Edge agent, where the job reopens.
  try {
    const n = ((await API.get('/agent/jobs')) || []).filter(j => j.status === 'running').length;
    for (const id of ['badge-infra', 'badge-infra-agent']) {
      const b = document.getElementById(id); if (!b) continue;
      if (n) { b.textContent = '▶ ' + n; b.style.display = 'inline-flex'; } else b.style.display = 'none';
    }
  } catch (e) { /* no access — leave it hidden */ }
}

// ============ SERVER SWITCHER (Local + SSH) ============

// Per-server access gate: a protected server can't be switched to without its access password (a 2nd
// factor on top of the DockGate login). Prompt for it, then resolve to the entered string — or null if
// the user dismisses (X / backdrop / Cancel) so callers can abort cleanly.
function promptAccessPassword(label) {
  return new Promise((resolve) => {
    const body = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="text-xs text-muted">🔒 <b>${escapeHtml(label || 'This server')}</b> is protected. Enter its access password to switch to it.</div>
        <input class="input" id="gate-pw" type="password" placeholder="Access password" autocomplete="off" style="width:100%" />
      </div>`;
    const m = showModal('🔒 Access password required', body, [{ label: 'Cancel' }]);
    const root = document.getElementById('modal-root');
    const input = root.querySelector('#gate-pw');
    const footer = root.querySelector('#modal-footer');
    let done = false;
    const finish = (val) => { if (done) return; done = true; obs.disconnect(); m.close(); resolve(val); };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary';
    okBtn.textContent = 'Unlock';
    okBtn.onclick = () => finish(input.value);
    footer.insertBefore(okBtn, footer.firstChild);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
    // X / backdrop / Cancel all just remove the overlay — observe that to resolve as a cancel.
    const obs = new MutationObserver(() => { if (!root.contains(m.overlay)) finish(null); });
    obs.observe(root, { childList: true });
    setTimeout(() => input.focus(), 50);
  });
}

// Switch the active server, transparently handling the access-password gate (403 + needsAccessPassword).
// Returns true on success, false if the user cancelled or the password was wrong; rethrows other errors.
async function activateServer(id, label) {
  try {
    await API.post('/servers/active', { id });
    return true;
  } catch (err) {
    if (/access password/i.test(err.message || '')) {
      const pw = await promptAccessPassword(label);
      if (pw == null) return false; // cancelled
      try { await API.post('/servers/active', { id, accessPassword: pw }); return true; }
      catch (e2) { showToast(e2.message || 'Access password incorrect', 'error', 7000); return false; }
    }
    throw err;
  }
}
window.promptAccessPassword = promptAccessPassword;
window.activateServer = activateServer;

// Make a server the one DockGate works on (the header picker shows it): access-password gate, then the
// Store, the remembered host and the header picker are updated. Returns true when the server is now active.
async function useServer(id) {
  const cur = Store.get('activeServer');
  if (cur && cur.id === id) return true;
  const data = await API.get('/servers');
  const srv = (data.servers || []).find(s => s.id === id);
  if (!srv) throw new Error(`Server "${id}" not found`);
  const ok = srv.isActive || await activateServer(id, srv.name || srv.id); // already active (Store not filled yet on boot)
  if (!ok) return false;
  Store.set('activeServer', { ...srv, isActive: true });
  localStorage.setItem('dcc_active_type', srv.type || 'local');
  localStorage.setItem('dcc_active_host', srv.host || '');
  await initServerSwitcher();
  return true;
}
window.useServer = useServer;

async function initServerSwitcher() {
  try {
    const data = await API.get('/servers');
    const select = document.getElementById('server-select');
    if (!select) return;

    // Persist the active server in Store + localStorage so port links are host-aware (dockerHostUrl)
    const activeServer = data.servers.find(s => s.isActive) || data.servers.find(s => s.id === 'local');
    if (activeServer) {
      Store.set('activeServer', activeServer);
      localStorage.setItem('dcc_active_type', activeServer.type || 'local');
      localStorage.setItem('dcc_active_host', activeServer.host || '');
    }

    // "Server Console" is always visible now (a standard nav item); no longer hidden until a
    // remote SSH server exists. The header server switcher below still tracks the active server.

    // DOM API ilə qur — XSS qoruması (host/id user input-dur)
    select.replaceChildren();
    for (const s of data.servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const label = s.id === 'local'
        ? '🖥 Local'
        : `🔐 ${s.name || s.id}${s.host ? ' (' + s.host + ')' : ''}${s.hasAccessPassword ? ' 🔒' : ''}`;
      opt.textContent = label;
      if (s.isActive) opt.selected = true;
      select.appendChild(opt);
    }

    // Header count badge — total registered servers (with a remote breakdown in the tooltip).
    const countEl = document.getElementById('server-count');
    if (countEl) {
      const remotes = data.servers.filter(s => s.id !== 'local' && s.type !== 'local').length;
      countEl.textContent = String(data.servers.length);
      countEl.title = `${data.servers.length} server(s) · ${remotes} remote`;
    }

    select.addEventListener('change', async (e) => {
      const id = e.target.value;
      const sel = data.servers.find(s => s.id === id);
      const revert = () => { const active = data.servers.find(s => s.isActive); if (active) select.value = active.id; };
      try {
        showToast(`Switching to ${id}...`, 'info');
        const ok = await activateServer(id, sel ? (sel.name || sel.id) : id);
        if (!ok) { revert(); return; } // cancelled or wrong access password
        showToast(`Connected to ${id}`, 'success');
        // Update the active server so port links point to the new host
        if (sel) {
          Store.set('activeServer', sel);
          localStorage.setItem('dcc_active_type', sel.type || 'local');
          localStorage.setItem('dcc_active_host', sel.host || '');
        }
        const currentPage = Store.get('currentPage') || 'dashboard';
        const currentParams = Store.get('currentParams') || {};
        // On a server console the page follows the picker: the new server's console (same tab), or the
        // Servers list when switching to the local machine (it has no console).
        if (currentPage === 'server-console') {
          const remote = sel && sel.id !== 'local' && sel.type !== 'local';
          setTimeout(() => remote ? Router.navigate('server-console', { id, tab: currentParams.tab }) : Router.navigate('infra', { tab: 'servers' }), 300);
        } else setTimeout(() => Router.navigate(currentPage, currentParams), 300);
      } catch (err) {
        showToast(`Switch failed: ${err.message}`, 'error', 8000);
        revert();
      }
    });
  } catch (e) {
    console.warn('Server switcher init failed:', e.message);
  }
}

// Servers dəyişəndə switcher-i yenidən yüklə (Settings tab-dan add/delete sonra)
window.refreshServerSwitcher = initServerSwitcher;

// Start
document.addEventListener('DOMContentLoaded', boot);
