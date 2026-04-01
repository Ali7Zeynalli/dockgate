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

// Boot application
async function boot() {
  try {
    initMacSidebar();
    initGlobalSearch();
    
    // Navigate to default or last visited page (using localStorage for hard refresh)
    const lastPage = localStorage.getItem('dcc_last_page') || 'dashboard';
    let lastParams = {};
    try { lastParams = JSON.parse(localStorage.getItem('dcc_last_params')) || {}; } catch(e){}
    await Router.navigate(lastPage, lastParams);
    
  } catch (err) {
    document.getElementById('content').innerHTML = `
      <div class="empty-state text-danger">
        <h3>Initialization Failed</h3>
        <p>${err.message}</p>
      </div>
    `;
  }
}

// Start
document.addEventListener('DOMContentLoaded', boot);
