// Client-side SPA Router
// Navigation race condition protection via navId
// Naviqasiya race condition qoruması navId vasitəsilə
const Router = {
  routes: {},
  currentPage: null,
  currentCleanup: null,
  _navId: 0, // Unique navigation counter to prevent stale renders / Köhnə renderlərin qarşısını almaq üçün unikal naviqasiya sayğacı

  register(path, handler) {
    this.routes[path] = handler;
  },

  // Check if a navigation is still the active one / Naviqasiyanın hələ aktiv olub-olmadığını yoxla
  isActiveNav(navId) {
    return this._navId === navId;
  },

  async navigate(path, params = {}) {
    // Increment navigation ID — invalidates any in-flight async from previous page
    // Naviqasiya ID-ni artır — əvvəlki səhifənin davam edən async əməliyyatlarını ləğv edir
    const navId = ++this._navId;

    // Cleanup previous page / Əvvəlki səhifəni təmizlə
    if (this.currentCleanup) {
      try { this.currentCleanup(); } catch(e) {}
      this.currentCleanup = null;
    }

    // Close any open modals on navigation / Naviqasiya zamanı açıq modalları bağla
    const modalRoot = document.getElementById('modal-root');
    if (modalRoot) modalRoot.innerHTML = '';

    const content = document.getElementById('content');
    const handler = this.routes[path];

    if (!handler) {
      content.innerHTML = '<div class="empty-state"><p>Page not found</p></div>';
      return;
    }

    // Update header title
    const titles = {
      dashboard: 'Dashboard',
      containers: 'Containers',
      'container-detail': 'Container Details',
      images: 'Images',
      volumes: 'Volumes',
      networks: 'Networks',
      compose: 'Compose Projects',
      logs: 'Logs',
      events: 'Events',
      system: 'System',
      cleanup: 'Cleanup',
      builds: 'Builds',
      settings: 'Settings',
      'k8s-dashboard': 'Kubernetes Overview',
      'k8s-pods': 'Pods',
      'k8s-deployments': 'Deployments',
      'k8s-services': 'Services',
      'k8s-configmaps': 'ConfigMaps',
      'k8s-secrets': 'Secrets',
      'k8s-nodes': 'Nodes',
      'k8s-pod-logs': 'Pod Logs',
      'k8s-pod-terminal': 'Pod Terminal',
    };

    document.getElementById('header-title').textContent = titles[path] || path;
    this.currentPage = path;
    Store.set('currentPage', path);
    Store.set('currentParams', params);
    
    // Save to localStorage for hard-refresh persistence
    localStorage.setItem('dcc_last_page', path);
    localStorage.setItem('dcc_last_params', JSON.stringify(params));

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
      const isActive = item.dataset.page === path;
      item.classList.toggle('active', isActive);
    });

    // Show loading
    content.innerHTML = '<div class="empty-state"><div class="skeleton" style="width:200px;height:24px;margin-bottom:16px"></div><div class="skeleton" style="width:300px;height:16px"></div></div>';

    try {
      const cleanup = await handler(content, params);

      // If another navigation happened while handler was running, discard this result
      // Handler işləyərkən başqa naviqasiya baş verdisə, bu nəticəni at
      if (!this.isActiveNav(navId)) {
        if (typeof cleanup === 'function') {
          try { cleanup(); } catch(e) {}
        }
        return;
      }

      if (typeof cleanup === 'function') {
        this.currentCleanup = cleanup;
      }
    } catch (err) {
      // Only show error if this navigation is still active / Yalnız bu naviqasiya hələ aktivdirsə xətanı göstər
      if (this.isActiveNav(navId)) {
        content.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg><h3>Error loading page</h3><p>${escapeHtml(err.message)}</p></div>`;
      }
    }
  }
};
