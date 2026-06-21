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

  async navigate(path, params = {}, opts = {}) {
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
      resources: 'Resources',
      deploy: 'Deploy',
      activity: 'Activity',
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
      audit: 'Audit Log',
      infra: 'Servers',
      'server-console': 'Server Console',
      settings: 'Settings',
    };

    document.getElementById('header-title').textContent = titles[path] || path;
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
        content.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg><h3>Error loading page</h3><p>${escapeHtml(err.message)}</p></div>`;
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
        this.navigate(parsed.path, parsed.params, { fromHash: true });
      }
    });
  }
};
