// Simple reactive store
const Store = {
  _state: {
    currentPage: 'dashboard',
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    settings: {},
    sidebarCollapsed: false,
  },
  _listeners: {},

  get(key) { return this._state[key]; },

  set(key, value) {
    this._state[key] = value;
    if (this._listeners[key]) {
      this._listeners[key].forEach(cb => cb(value));
    }
  },

  on(key, callback) {
    if (!this._listeners[key]) this._listeners[key] = [];
    this._listeners[key].push(callback);
    return () => {
      this._listeners[key] = this._listeners[key].filter(cb => cb !== callback);
    };
  },
};

// What a list page shows — filter, search, sort — kept for this browser tab, so going back to the page
// (Back, the sidebar, after opening an item) shows it as you left it. sessionStorage: cleared when the
// tab closes; a blocked storage just means the defaults.
Store.view = (page) => ({
  get(name, fallback) {
    try { const v = sessionStorage.getItem(`dg_view:${page}:${name}`); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(name, value) {
    try { sessionStorage.setItem(`dg_view:${page}:${name}`, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
  },
});
