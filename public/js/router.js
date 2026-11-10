// Client-side SPA Router
// Navigation race condition protection via navId
// Naviqasiya race condition qoruması navId vasitəsilə
const Router = {
  routes: {},
  currentPage: null,
  currentCleanup: null,
  _navId: 0, // Unique navigation counter to prevent stale renders / Köhnə renderlərin qarşısını almaq üçün unikal naviqasiya sayğacı
  _suppressHash: false, // Skip the hashchange handler for writes we trigger ourselves / Öz yazdığımız hashchange-i atla

  register(path, handler) {
    this.routes[path] = handler;
  },

  // Check if a navigation is still the active one / Naviqasiyanın hələ aktiv olub-olmadığını yoxla
  isActiveNav(navId) {
    return this._navId === navId;
  },

  // Pages that moved keep their old links working: #/activity?tab=logs, #/infra?tab=registries, a bare
  // #/containers, #/cleanup … are rewritten to the section that now holds them.
  resolve(path, params = {}) {
    const p = { ...(params || {}) };
    const SECTION_OF = {
      containers: 'resources', images: 'resources', volumes: 'resources', networks: 'resources', builds: 'resources', prune: 'resources', cleanup: 'resources',
      compose: 'deploy', templates: 'deploy', registries: 'deploy',
      logs: 'observe', events: 'observe', audit: 'observe', 'notification-log': 'observe',
      terminal: 'tools', files: 'tools', schedules: 'tools',
    };
    const TAB = { cleanup: 'prune' };
    if (path === 'activity') { const t = p.tab || 'logs'; return { path: SECTION_OF[t] || 'observe', params: { ...p, tab: TAB[t] || t } }; }
    if (path === 'infra' && p.tab === 'registries') return { path: 'deploy', params: p };
    if ((path === 'resources' || path === 'deploy') && TAB[p.tab]) return { path, params: { ...p, tab: TAB[p.tab] } };
    if (SECTION_OF[path]) { delete p.tab; return { path: SECTION_OF[path], params: { ...p, tab: TAB[path] || path } }; }
    if (path === 'settings' && p.tab === 'agent') return { path: 'infra', params: { tab: 'agent' } };
    if (path === 'settings' && p.tab === 'log') return { path: 'observe', params: { tab: 'notification-log' } }; // the log moved to Observe
    return { path, params: p };
  },

  // Top bar: "Section / Page" for pages inside a section, else the page name.
  setTitle(path, params = {}) {
    const el = document.getElementById('header-title');
    if (!el) return;
    const item = typeof navItems !== 'undefined' ? navItems[path] : null;
    const extra = { 'container-detail': ['Resources', 'Container'], 'server-console': null };
    const crumb = (parent, page) => `<span class="crumb-parent">${escapeHtml(parent)}</span><span class="crumb-sep">/</span><span class="crumb-page">${escapeHtml(page)}</span>`;
    if (item && item.tabs) {
      const t = item.tabs.find(([k]) => k === (params.tab || item.default));
      el.innerHTML = t ? crumb(item.label, t[1]) : escapeHtml(item.label);
    } else if (extra[path]) el.innerHTML = crumb(...extra[path]);
    else el.textContent = (item && item.label) || this.titles[path] || path;
    if (typeof syncSidebarTabs === 'function') setTimeout(syncSidebarTabs, 0); // redirects use replaceState (no hashchange)
    document.title = `${el.textContent.replace(/\s*\/\s*/g, ' / ')} · DockGate`;
  },
  titles: { 'container-detail': 'Container', system: 'System' },

  async navigate(path, params = {}, opts = {}) {
    ({ path, params } = this.resolve(path, params));
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

    this.setTitle(path, params);
    this.currentPage = path;
    Store.set('currentPage', path);
    Store.set('currentParams', params);
    
    // Save to localStorage for hard-refresh persistence
    localStorage.setItem('dcc_last_page', path);
    localStorage.setItem('dcc_last_params', JSON.stringify(params));

    // Reflect the navigation in the URL hash so the browser Back/Forward buttons
    // work and a hard-refresh restores the exact page+params. Skip when THIS
    // navigation was itself triggered by a hash change (Back/Forward), to avoid a
    // write→event loop. / Naviqasiyanı URL hash-də əks etdir ki, brauzerin Geri/İrəli
    // düymələri işləsin və refresh eyni səhifə+params bərpa etsin.
    if (!opts.fromHash) this._writeHash(path, params, opts.replace);

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
        content.innerHTML = UI.errorState(err);
      }
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // URL hash sync — browser history integration (Back/Forward + deep-link refresh)
  // Format: #/<path>?<querystring>  (params are flat string key/values)
  // ──────────────────────────────────────────────────────────────────────────

  // Parse the current location hash into { path, params }, or null when empty.
  _parseHash() {
    const raw = (window.location.hash || '').replace(/^#\/?/, '');
    if (!raw) return null;
    const qIdx = raw.indexOf('?');
    const path = decodeURIComponent(qIdx >= 0 ? raw.slice(0, qIdx) : raw);
    const params = {};
    if (qIdx >= 0) {
      new URLSearchParams(raw.slice(qIdx + 1)).forEach((v, k) => { params[k] = v; });
    }
    return path ? { path, params } : null;
  },

  // Build a hash string from a path + flat params object (empty values omitted).
  _buildHash(path, params = {}) {
    const base = '#/' + encodeURIComponent(path);
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v != null && v !== '') usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `${base}?${qs}` : base;
  },

  // Write the hash. `replace` → history.replaceState (no new entry, used on boot);
  // otherwise an assignment pushes a new history entry so Back works.
  _writeHash(path, params, replace) {
    const target = this._buildHash(path, params);
    if ((window.location.hash || '') === target) return; // unchanged → no event
    if (replace && window.history.replaceState) {
      window.history.replaceState(null, '', target); // does NOT fire hashchange
    } else {
      this._suppressHash = true; // swallow the hashchange our own write triggers
      window.location.hash = target;
    }
  },

  // Update the params of the CURRENT page (e.g. a sub-tab) WITHOUT re-rendering:
  // syncs Store/localStorage and pushes a history entry so Back returns to the
  // previous sub-state and a refresh restores it.
  updateParams(params = {}) {
    Store.set('currentParams', params);
    this.setTitle(this.currentPage, params);
    localStorage.setItem('dcc_last_params', JSON.stringify(params));
    this._writeHash(this.currentPage, params, false);
  },

  // Attach the hashchange listener (Back/Forward navigation). Call once on boot.
  init() {
    window.addEventListener('hashchange', () => {
      // Ignore the event caused by our own _writeHash() assignment.
      if (this._suppressHash) { this._suppressHash = false; return; }
      const parsed = this._parseHash();
      if (parsed && this.routes[parsed.path]) {
        const r = this.resolve(parsed.path, parsed.params);
        const moved = r.path !== parsed.path || r.params.tab !== parsed.params.tab;
        this.navigate(r.path, r.params, { fromHash: !moved, replace: moved });
      }
    });
  }
};
