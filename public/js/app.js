// Navigation setup
// Related Docker pages are consolidated into tabbed sections (resources/deploy/activity — see
// tabbed-section.js); the individual pages stay registered as routes but are reached via those tabs.
const navItems = {
  dashboard: { label: 'Dashboard', icon: Icons.dashboard },
  resources: { label: 'Resources', icon: Icons.layers, tabs: [['containers', 'Containers'], ['images', 'Images'], ['builds', 'Builds'], ['volumes', 'Volumes'], ['networks', 'Networks']], default: 'containers' },
  deploy: { label: 'Deploy', icon: Icons.compose, tabs: [['compose', 'Compose'], ['templates', 'App Templates']], default: 'compose' },
  activity: { label: 'Activity', icon: Icons.events, tabs: [['logs', 'Logs'], ['terminal', 'Terminal'], ['events', 'Events'], ['files', 'Files'], ['audit', 'Audit Log']], default: 'logs' },
  infra: { label: 'Infrastructure', icon: Icons.system, tabs: [['servers', 'Servers'], ['registries', 'Registries'], ['cleanup', 'Cleanup']], default: 'servers' },
  'server-console': { label: 'Server Console', icon: Icons.terminal },
  settings: { label: 'Settings', icon: Icons.settings, tabs: [['general', 'General'], ['notifications', 'Notifications'], ['log', 'Notification Log'], ['update', 'Software Update'], ['system', 'System'], ['security', 'Security'], ['sshkeys', 'SSH Keys']], default: 'general' }
};

// Two clear domains: DOCKER management (Resources / Deploy / Activity — each a tabbed section) vs
// SERVER management (the host itself), then app System. 7 entries instead of 17.
const navGroups = [
  { label: 'Overview', items: ['dashboard'] },
  { label: 'Docker', items: ['resources', 'deploy', 'activity'] },
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
      if (item.tabs) {
        // A section with sub-tabs → a collapsible parent + its tabs as sidebar sub-items (auto-expands
        // when active, so the sidebar stays compact). The in-page tab bar still works too.
        itemsHtml += `
          <a class="nav-item nav-parent" data-page="${key}" data-default="${item.default}">
            <span class="nav-item-icon">${item.icon}</span>
            <span style="flex:1">${item.label}</span>
            <span class="nav-caret">▸</span>
          </a>
          <div class="nav-subitems" id="nav-sub-${key}">
            ${item.tabs.map(([tab, label]) => `<a class="nav-subitem" data-page="${key}" data-tab="${tab}">${label}</a>`).join('')}
          </div>
        `;
        return;
      }
      const active = (key === 'dashboard') ? 'active' : '';
      itemsHtml += `
        <a class="nav-item ${active}" data-page="${key}">
          <span class="nav-item-icon">${item.icon}</span>
          ${item.label}
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

  sidebarNav.addEventListener('click', (e) => {
    // A sidebar sub-item (a section's tab) → navigate straight to that tab.
    const subitem = e.target.closest('.nav-subitem');
    if (subitem) { Router.navigate(subitem.dataset.page, { tab: subitem.dataset.tab }); return; }
    const item = e.target.closest('.nav-item');
    if (!item) return;
    const page = item.dataset.page;
    // A section header → open its default tab (syncSidebarTabs then expands it).
    if (item.classList.contains('nav-parent')) { Router.navigate(page, { tab: item.dataset.default }); return; }
    if (page === 'server-console') {
      // Open the active remote server's console; with no remote server yet, send the user to Servers
      // to add one (a console needs a server) — with a hint so the redirect isn't surprising.
      const active = Store.get('activeServer');
      if (active && active.id !== 'local' && active.type !== 'local') Router.navigate('server-console', { id: active.id });
      else {
        if (typeof showToast === 'function') showToast('Add a remote server first — a console needs one', 'info', 5000);
        Router.navigate('infra', { tab: 'servers' });
      }
      return;
    }
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
  const tab = new URLSearchParams((location.hash.split('?')[1] || '')).get('tab') || '';
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

// Global Search
function initGlobalSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim() !== '') {
      Router.navigate('resources',{tab:'containers'});
      setTimeout(() => {
        const pageSearch = document.getElementById('container-search');
        if (pageSearch) {
          pageSearch.value = input.value;
          pageSearch.dispatchEvent(new Event('input'));
        }
        input.value = '';
        input.blur();
      }, 100);
    }
  });
}

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
  renderAuthScreen(status.setupDone ? 'login' : 'setup');
  return false;
}

function renderAuthScreen(mode) {
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
        await API.post('/auth/setup', { password: pw });
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

    // Enable browser Back/Forward navigation + hash deep-links
    Router.init();

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
    const SECTION_OF = { containers: 'resources', images: 'resources', builds: 'resources', volumes: 'resources', networks: 'resources', compose: 'deploy', templates: 'deploy', logs: 'activity', terminal: 'activity', events: 'activity', files: 'activity', audit: 'activity' };
    if (SECTION_OF[startPage]) { startParams = { tab: startPage }; startPage = SECTION_OF[startPage]; }
    // replace:true → set the initial hash without adding a spurious history entry
    await Router.navigate(startPage, startParams, { replace: true });

    // Load theme + display timezone from server settings / Server settings-dən tema və timezone yüklə
    API.get('/meta/settings').then(s => {
      if (s && s.theme) {
        applyTheme(s.theme);
        localStorage.setItem('dcc_theme', s.theme);
      }
      // Cache timezone so formatTime() works immediately on hard refresh, before Store fills
      if (s && s.timezone) localStorage.setItem('dcc_timezone', s.timezone);
    }).catch(() => {});

    // Show version from package.json in sidebar / Sidebar-da versiyanı package.json-dan göstər
    API.get('/meta/version').then(v => {
      const el = document.getElementById('app-version');
      if (el && v.version) el.textContent = 'v' + v.version;
    }).catch(() => {});

    // Auto update check — on boot and every 24h / Avtomatik update yoxlama — başlanğıcda və hər 24 saatda bir
    checkForUpdates();
    setInterval(checkForUpdates, 5 * 60 * 1000);

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
async function checkForUpdates() {
  try {
    // Has 5 min passed since last check? / Son yoxlamadan 5 dəqiqə keçibmi?
    const lastCheck = localStorage.getItem('dcc_update_last_check');
    const now = Date.now();
    if (lastCheck && (now - parseInt(lastCheck)) < 5 * 60 * 1000) {
      // Read from cache / Cache-dən oxu
      const cached = localStorage.getItem('dcc_update_available');
      if (cached === 'true') showUpdateBadge();
      return;
    }

    const info = await API.get('/meta/update/check');
    localStorage.setItem('dcc_update_last_check', String(now));
    localStorage.setItem('dcc_update_available', String(info.updateAvailable));

    if (info.updateAvailable) {
      showUpdateBadge();
    } else {
      hideUpdateBadge();
    }
  } catch(e) {
    // Network error — don't show badge, fail silently / Şəbəkə xətası — badge göstərmə, sessiz keç
    console.log('Update check failed:', e.message);
  }
}

function showUpdateBadge() {
  const badge = document.getElementById('badge-settings');
  if (badge) {
    badge.textContent = 'UPDATE';
    badge.style.display = 'inline-flex';
  }
}

function hideUpdateBadge() {
  const badge = document.getElementById('badge-settings');
  if (badge) badge.style.display = 'none';
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
}

// ============ SERVER SWITCHER (Local + SSH) ============
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
        : `🔐 ${s.id}${s.host ? ' (' + s.host + ')' : ''}`;
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
      try {
        showToast(`Switching to ${id}...`, 'info');
        await API.post('/servers/active', { id });
        showToast(`Connected to ${id}`, 'success');
        // Update the active server so port links point to the new host
        const sel = data.servers.find(s => s.id === id);
        if (sel) {
          Store.set('activeServer', sel);
          localStorage.setItem('dcc_active_type', sel.type || 'local');
          localStorage.setItem('dcc_active_host', sel.host || '');
        }
        const currentPage = Store.get('currentPage') || 'dashboard';
        const currentParams = Store.get('currentParams') || {};
        setTimeout(() => Router.navigate(currentPage, currentParams), 300);
      } catch (err) {
        showToast(`Switch failed: ${err.message}`, 'error', 8000);
        const active = data.servers.find(s => s.isActive);
        if (active) select.value = active.id;
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
