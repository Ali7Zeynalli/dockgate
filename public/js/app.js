// Navigation setup
const navItems = {
  dashboard: { label: 'Dashboard', icon: Icons.dashboard },
  containers: { label: 'Containers', icon: Icons.container },
  images: { label: 'Images', icon: Icons.image },
  builds: { label: 'Builds', icon: Icons.layers },
  volumes: { label: 'Volumes', icon: Icons.volume },
  networks: { label: 'Networks', icon: Icons.network },
  compose: { label: 'Compose', icon: Icons.compose },
  logs: { label: 'Logs', icon: Icons.logs },
  terminal: { label: 'Terminal', icon: Icons.terminal },
  events: { label: 'Events', icon: Icons.events },
  system: { label: 'System', icon: Icons.system },
  cleanup: { label: 'Cleanup', icon: Icons.cleanup },
  settings: { label: 'Settings', icon: Icons.settings }
};

const navGroups = [
  { label: 'Core', items: ['dashboard', 'containers', 'images', 'volumes', 'networks'] },
  { label: 'Build', items: ['builds', 'compose'] },
  { label: 'Monitor', items: ['logs', 'terminal', 'events', 'system'] },
  { label: 'Manage', items: ['cleanup', 'settings'] }
];

function initMacSidebar() {
  const sidebarNav = document.getElementById('sidebar-nav');
  if (!sidebarNav) return;
  
  let html = '';
  
  navGroups.forEach((group, index) => {
    let itemsHtml = '';
    
    group.items.forEach(key => {
      const item = navItems[key];
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
        <div class="nav-group-header">
          ${group.label}
        </div>
        <div class="nav-group-items">
          ${itemsHtml}
        </div>
      </div>
    `;
  });
  
  sidebarNav.innerHTML = html;

  sidebarNav.addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    
    const page = item.dataset.page;
    if (page) Router.navigate(page);
  });
}

// Global Search
function initGlobalSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim() !== '') {
      Router.navigate('containers');
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

// Boot application
async function boot() {
  try {
    // Apply saved theme immediately / Saxlanmış temanı dərhal tətbiq et
    const savedTheme = localStorage.getItem('dcc_theme') || 'dark';
    applyTheme(savedTheme);

    initMacSidebar();
    initGlobalSearch();

    // Navigate to default or last visited page (using localStorage for hard refresh)
    const lastPage = localStorage.getItem('dcc_last_page') || 'dashboard';
    let lastParams = {};
    try { lastParams = JSON.parse(localStorage.getItem('dcc_last_params')) || {}; } catch(e){}
    await Router.navigate(lastPage, lastParams);

    // Load theme from server settings / Server settings-dən temanı yüklə
    API.get('/meta/settings').then(s => {
      if (s && s.theme) {
        applyTheme(s.theme);
        localStorage.setItem('dcc_theme', s.theme);
      }
    }).catch(() => {});

    // Show version from package.json in sidebar / Sidebar-da versiyanı package.json-dan göstər
    API.get('/meta/version').then(v => {
      const el = document.getElementById('app-version');
      if (el && v.version) el.textContent = 'v' + v.version;
    }).catch(() => {});

    // Auto update check — on boot and every 24h / Avtomatik update yoxlama — başlanğıcda və hər 24 saatda bir
    checkForUpdates();
    setInterval(checkForUpdates, 24 * 60 * 60 * 1000);

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
    // Has 24h passed since last check? / Son yoxlamadan 24 saat keçibmi?
    const lastCheck = localStorage.getItem('dcc_update_last_check');
    const now = Date.now();
    if (lastCheck && (now - parseInt(lastCheck)) < 24 * 60 * 60 * 1000) {
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

// ============ SERVER SWITCHER (Local + SSH) ============
async function initServerSwitcher() {
  try {
    const data = await API.get('/servers');
    const select = document.getElementById('server-select');
    if (!select) return;

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

    select.addEventListener('change', async (e) => {
      const id = e.target.value;
      try {
        showToast(`Switching to ${id}...`, 'info');
        await API.post('/servers/active', { id });
        showToast(`Connected to ${id}`, 'success');
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
