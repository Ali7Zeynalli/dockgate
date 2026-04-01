// Client-side SPA Router
const Router = {
  routes: {},
  currentPage: null,
  currentCleanup: null,

  register(path, handler) {
    this.routes[path] = handler;
  },

  async navigate(path, params = {}) {
    // Cleanup previous page
    if (this.currentCleanup) {
      try { this.currentCleanup(); } catch(e) {}
      this.currentCleanup = null;
    }

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
      settings: 'Settings',
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
      if (typeof cleanup === 'function') {
        this.currentCleanup = cleanup;
      }
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg><h3>Error loading page</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }
};
