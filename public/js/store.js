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
