// Navigation setup
const navItems = {
  // Docker
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
  settings: { label: 'Settings', icon: Icons.settings },
  // Kubernetes
  'k8s-dashboard': { label: 'Overview', icon: Icons.dashboard },
  'k8s-pods': { label: 'Pods', icon: Icons.container },
  'k8s-deployments': { label: 'Deployments', icon: Icons.layers },
  'k8s-services': { label: 'Services', icon: Icons.network },
  'k8s-configmaps': { label: 'ConfigMaps', icon: Icons.logs },
  'k8s-secrets': { label: 'Secrets', icon: Icons.tag },
  'k8s-nodes': { label: 'Nodes', icon: Icons.system },
  'k8s-pod-logs': { label: 'Pod Logs', icon: Icons.logs },
  'k8s-pod-terminal': { label: 'Pod Terminal', icon: Icons.terminal },
};

const dockerNavGroups = [
  { label: 'Docker — Core', items: ['dashboard', 'containers', 'images', 'volumes', 'networks'] },
  { label: 'Docker — Build', items: ['builds', 'compose'] },
  { label: 'Docker — Monitor', items: ['logs', 'terminal', 'events', 'system'] },
  { label: 'Manage', items: ['cleanup', 'settings'] },
];

const k8sNavGroups = [
  { label: 'Kubernetes — Workloads', items: ['k8s-dashboard', 'k8s-pods', 'k8s-deployments'] },
  { label: 'Kubernetes — Network & Config', items: ['k8s-services', 'k8s-configmaps', 'k8s-secrets'] },
  { label: 'Kubernetes — Cluster', items: ['k8s-nodes', 'k8s-pod-logs', 'k8s-pod-terminal'] },
];

// Mode seçilməsi — Docker only, K8s only, və ya hər ikisi
function getNavGroups(k8sEnabled) {
  if (!k8sEnabled) return dockerNavGroups;
  // K8s aktivdirsə hər iki qrupu göstər, amma Settings ən sona
  const docker = dockerNavGroups.slice(0, -1); // cleanup/settings-siz
  const manage = dockerNavGroups[dockerNavGroups.length - 1];
  return [...docker, ...k8sNavGroups, manage];
}

function initMacSidebar(k8sEnabled = false) {
  const sidebarNav = document.getElementById('sidebar-nav');
  if (!sidebarNav) return;

  const groups = getNavGroups(k8sEnabled);
  let html = '';

  groups.forEach((group) => {
    let itemsHtml = '';

    group.items.forEach(key => {
      const item = navItems[key];
      if (!item) return;
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

// Re-render sidebar (mode dəyişəndə çağırılır)
function refreshSidebar() {
  API.get('/k8s-setup/status').then(s => {
    initMacSidebar(!!s.enabled);
  }).catch(() => initMacSidebar(false));
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

    // K8s mode yoxla və sidebar-a görə quraşdır
    let k8sEnabled = false;
    try {
      const status = await API.get('/k8s-setup/status');
      k8sEnabled = !!status.enabled;
    } catch (e) { /* K8s endpoint yoxdursa, keç */ }

    initMacSidebar(k8sEnabled);
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

// Start
document.addEventListener('DOMContentLoaded', boot);
