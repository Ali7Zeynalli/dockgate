// Quick Terminal — Global floating & minimizable terminal overlay
// Accessible from any page via the header shortcut or Ctrl+` (or Alt+T).
// Allows executing container shells and host SSH terminal without leaving the current view.
const QuickTerminal = (function() {
  let state = 'closed'; // 'closed' | 'open' | 'minimized' | 'maximized'
  let activeTab = 'container'; // 'container' | 'system'
  let selectedContainerId = '';
  let containers = [];
  let activeServer = { id: 'local', label: 'Local', isLocal: true };
  let term = null;
  let fitAddon = null;
  let channel = null; // 'container' | 'system' | null
  let isConnected = false;
  let rootEl = null;

  // xterm disposal and resizing helpers
  function disposeTerm() {
    if (term) {
      try { term.dispose(); } catch (e) {}
      term = null;
    }
    window.removeEventListener('resize', handleResize);
    unbindSocket();
    isConnected = false;
    updateStatusBadge();
  }

  function handleResize() {
    if (!term || !fitAddon || state === 'closed' || state === 'minimized') return;
    try {
      fitAddon.fit();
      if (channel && term.cols && term.rows) {
        socket.emit(channel === 'system' ? 'hostterm:resize' : 'terminal:resize', {
          cols: term.cols,
          rows: term.rows
        });
      }
    } catch (e) {}
  }

  function makeTerm(areaEl) {
    if (!areaEl) return;
    term = new Terminal({
      cursorBlink: true,
      theme: { background: '#000000', foreground: '#e8ecf4' },
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 13,
      scrollback: 5000
    });
    try {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    } catch (e) {}
    term.open(areaEl);
    window.addEventListener('resize', handleResize);
    setTimeout(handleResize, 60);
  }

  // Socket handlers
  const onData = ({ data }) => { if (term) term.write(data); };
  const onEnd = () => {
    isConnected = false;
    updateStatusBadge();
    if (term) term.write('\r\n\x1b[33m— session ended (press Reconnect) —\x1b[0m\r\n');
  };
  const onErr = ({ error }) => {
    isConnected = false;
    updateStatusBadge();
    if (term) term.write(`\r\n\x1b[31m— terminal error: ${error || 'unknown'} —\x1b[0m\r\n`);
  };
  const onContainerReady = () => {
    isConnected = true;
    updateStatusBadge();
    if (term) term.write('\x1b[32m● Connected to container\x1b[0m\r\n');
  };
  const onSystemReady = ({ host }) => {
    isConnected = true;
    updateStatusBadge();
    if (term) term.write(`\x1b[32m● Connected to ${host || 'host'}\x1b[0m\r\n`);
  };

  function unbindSocket() {
    socket.off('terminal:data', onData).off('terminal:end', onEnd).off('terminal:error', onErr).off('terminal:ready', onContainerReady);
    socket.off('hostterm:data', onData).off('hostterm:end', onEnd).off('hostterm:error', onErr).off('hostterm:ready', onSystemReady);
  }

  // Connect to Container Exec
  function startContainerSession() {
    if (!selectedContainerId || !term) return;
    const shell = document.getElementById('qt-shell')?.value || '/bin/sh';
    term.reset();
    term.write(`\x1b[36mConnecting to ${shell}…\x1b[0m\r\n`);
    socket.emit('terminal:stop');
    socket.emit('terminal:start', { containerId: selectedContainerId, shell });
    setTimeout(handleResize, 100);
  }

  function connectContainer() {
    channel = 'container';
    const area = document.getElementById('qt-terminal-area');
    if (!area) return;
    disposeTerm();
    makeTerm(area);
    socket.on('terminal:ready', onContainerReady).on('terminal:data', onData).on('terminal:end', onEnd).on('terminal:error', onErr);
    term.onData(d => socket.emit('terminal:input', d));
    socket.emit('terminal:stop');
    setTimeout(startContainerSession, 50);
    updateToolbarState();
  }

  // Connect to System Shell
  function startSystemSession() {
    if (!term) return;
    term.reset();
    term.write(`\x1b[36mConnecting to ${activeServer.label}…\x1b[0m\r\n`);
    socket.emit('hostterm:stop');
    socket.emit('hostterm:start', { cols: term.cols || 80, rows: term.rows || 24 });
    setTimeout(handleResize, 100);
  }

  function connectSystem() {
    channel = 'system';
    const area = document.getElementById('qt-terminal-area');
    if (!area) return;
    disposeTerm();
    makeTerm(area);
    socket.on('hostterm:ready', onSystemReady).on('hostterm:data', onData).on('hostterm:end', onEnd).on('hostterm:error', onErr);
    term.onData(d => socket.emit('hostterm:input', d));
    socket.emit('hostterm:stop');
    setTimeout(startSystemSession, 50);
    updateToolbarState();
  }

  async function fetchContainers() {
    try {
      const list = await API.get('/containers');
      containers = (list || []).filter(c => c.state === 'running');
      const sel = document.getElementById('qt-container');
      if (sel) {
        sel.innerHTML = `
          <option value="" disabled ${!selectedContainerId ? 'selected' : ''}>-- Choose Container --</option>
          ${containers.map(c => `<option value="${c.id}" ${selectedContainerId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${c.shortId})</option>`).join('')}
        `;
        if (selectedContainerId && !containers.some(c => c.id === selectedContainerId)) {
          selectedContainerId = '';
        }
      }
    } catch (e) {}
  }

  async function fetchActiveServer() {
    try {
      const servers = await API.get('/servers');
      const a = (servers || []).find(s => s.isActive) || { id: 'local', type: 'local' };
      activeServer = {
        id: a.id,
        isLocal: a.id === 'local',
        label: a.id === 'local' ? 'Local Docker' : `${a.name || a.id}${a.host ? ' (' + a.host + ')' : ''}`
      };
      const lbl = document.getElementById('qt-server-label');
      if (lbl) lbl.textContent = activeServer.label;
    } catch (e) {
      activeServer = { id: 'local', isLocal: true, label: 'Local Docker' };
    }
  }

  function updateStatusBadge() {
    const badge = document.getElementById('qt-status-badge');
    const miniBadge = document.getElementById('qt-mini-status');
    const miniText = document.getElementById('qt-mini-title');
    
    let label = 'Disconnected';
    let dotClass = 'qt-dot-disconnected';
    if (isConnected) {
      label = channel === 'system' ? `Host (${activeServer.id})` : 'Container';
      dotClass = 'qt-dot-connected';
    } else if (channel) {
      label = 'Connecting…';
      dotClass = 'qt-dot-connecting';
    }

    if (badge) {
      badge.innerHTML = `<span class="qt-dot ${dotClass}"></span> <span>${label}</span>`;
    }
    if (miniBadge) {
      miniBadge.className = `qt-dot ${dotClass}`;
    }
    if (miniText) {
      const target = channel === 'system' ? activeServer.label : (containers.find(c => c.id === selectedContainerId)?.name || 'Terminal');
      miniText.textContent = `Terminal: ${target}`;
    }
  }

  function updateToolbarState() {
    const cBtn = document.getElementById('qt-btn-connect');
    const rBtn = document.getElementById('qt-btn-reconnect');
    const hasTarget = activeTab === 'system' || !!selectedContainerId;

    if (cBtn && rBtn) {
      if (channel) {
        cBtn.style.display = 'none';
        rBtn.style.display = 'inline-flex';
      } else {
        cBtn.style.display = 'inline-flex';
        cBtn.disabled = !hasTarget;
        rBtn.style.display = 'none';
      }
    }
    updateStatusBadge();
  }

  function renderModalHtml() {
    return `
      <div class="quick-term-backdrop" id="qt-backdrop"></div>
      <div class="quick-term-window" id="qt-window">
        <!-- Titlebar -->
        <div class="quick-term-titlebar" id="qt-titlebar">
          <div class="quick-term-title-left">
            <span class="quick-term-logo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            </span>
            <span class="quick-term-title-text">Quick Terminal</span>
            <div id="qt-status-badge" class="quick-term-status-badge">
              <span class="qt-dot qt-dot-disconnected"></span> <span>Disconnected</span>
            </div>
          </div>
          <div class="quick-term-title-actions">
            <button class="qt-btn-ctrl" id="qt-btn-fullscreen-page" title="Open full Terminal page">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
            <button class="qt-btn-ctrl" id="qt-btn-minimize" title="Minimize (hide to bottom dock)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="qt-btn-ctrl" id="qt-btn-maximize" title="Toggle Maximize">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="qt-btn-ctrl qt-btn-close" id="qt-btn-close" title="Close Terminal">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <!-- Controls Toolbar -->
        <div class="quick-term-controls">
          <!-- Tab toggles -->
          <div class="quick-term-tab-group">
            <button class="quick-term-tab-btn ${activeTab === 'container' ? 'active' : ''}" data-tab="container">
              🐳 Container Exec
            </button>
            <button class="quick-term-tab-btn ${activeTab === 'system' ? 'active' : ''}" data-tab="system">
              💻 System (Host)
            </button>
          </div>

          <!-- Dynamic settings depending on active tab -->
          <div class="quick-term-target-bar" id="qt-target-bar">
            ${renderTargetControls()}
          </div>
        </div>

        <!-- Terminal Output Viewport -->
        <div class="quick-term-viewport">
          <div id="qt-terminal-area"></div>
        </div>
      </div>

      <!-- Minimized Floating Pill -->
      <div class="quick-term-minimized" id="qt-minimized" style="display:none;">
        <span class="qt-dot qt-dot-disconnected" id="qt-mini-status"></span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span class="qt-mini-title" id="qt-mini-title">Terminal</span>
        <button class="qt-mini-action" id="qt-mini-restore" title="Restore Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
        <button class="qt-mini-action qt-mini-close" id="qt-mini-close" title="Close Session">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
  }

  function renderTargetControls() {
    if (activeTab === 'container') {
      return `
        <div style="display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;">
          <select class="select qt-select" id="qt-container">
            <option value="" disabled ${!selectedContainerId ? 'selected' : ''}>-- Choose Container --</option>
            ${containers.map(c => `<option value="${c.id}" ${selectedContainerId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${c.shortId})</option>`).join('')}
          </select>
          <select class="select qt-select" id="qt-shell" style="width:110px;">
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/zsh">/bin/zsh</option>
          </select>
          <button class="btn btn-primary btn-sm" id="qt-btn-connect" ${!selectedContainerId ? 'disabled' : ''}>Connect</button>
          <button class="btn btn-secondary btn-sm" id="qt-btn-reconnect" style="display:none;">${Icons.refresh} Reconnect</button>
          <button class="btn btn-ghost btn-sm" id="qt-btn-clear" title="Clear buffer">Clear</button>
        </div>
      `;
    } else {
      return `
        <div style="display:flex;align-items:center;gap:10px;flex:1;flex-wrap:wrap;">
          <span class="badge ${activeServer.isLocal ? 'badge-created' : 'badge-running'}" id="qt-server-label">
            ${escapeHtml(activeServer.label)}
          </span>
          <span class="text-xs text-muted" style="flex:1;">
            ${activeServer.isLocal ? 'DockGate container shell (docker CLI ready)' : 'Real SSH shell on remote host'}
          </span>
          <button class="btn btn-primary btn-sm" id="qt-btn-connect">Connect</button>
          <button class="btn btn-secondary btn-sm" id="qt-btn-reconnect" style="display:none;">${Icons.refresh} Reconnect</button>
          <button class="btn btn-ghost btn-sm" id="qt-btn-clear" title="Clear buffer">Clear</button>
        </div>
      `;
    }
  }

  function bindDomEvents() {
    const root = rootEl;
    if (!root) return;

    // Tabs
    root.querySelectorAll('.quick-term-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === activeTab) return;
        activeTab = tab;
        socket.emit('terminal:stop');
        socket.emit('hostterm:stop');
        disposeTerm();
        channel = null;
        
        // Update tabs UI
        root.querySelectorAll('.quick-term-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
        const targetBar = document.getElementById('qt-target-bar');
        if (targetBar) {
          targetBar.innerHTML = renderTargetControls();
          bindTargetEvents();
        }
      });
    });

    // Titlebar actions
    document.getElementById('qt-btn-minimize')?.addEventListener('click', minimize);
    document.getElementById('qt-btn-maximize')?.addEventListener('click', toggleMaximize);
    document.getElementById('qt-btn-close')?.addEventListener('click', close);
    document.getElementById('qt-backdrop')?.addEventListener('click', minimize); // clicking backdrop minimizes gracefully
    document.getElementById('qt-btn-fullscreen-page')?.addEventListener('click', () => {
      minimize();
      if (typeof Router !== 'undefined') {
        Router.navigate('activity', { tab: 'terminal', id: selectedContainerId });
      }
    });

    // Minimized widget actions
    document.getElementById('qt-minimized')?.addEventListener('click', (e) => {
      if (e.target.closest('#qt-mini-close')) {
        e.stopPropagation();
        close();
      } else {
        restore();
      }
    });

    bindTargetEvents();
  }

  function bindTargetEvents() {
    const cBtn = document.getElementById('qt-btn-connect');
    const rBtn = document.getElementById('qt-btn-reconnect');
    const clearBtn = document.getElementById('qt-btn-clear');
    const sel = document.getElementById('qt-container');
    const shellSel = document.getElementById('qt-shell');

    clearBtn?.addEventListener('click', () => {
      if (term) term.clear();
    });

    if (activeTab === 'container') {
      const doConnect = () => {
        if (!sel?.value) return;
        selectedContainerId = sel.value;
        connectContainer();
      };

      sel?.addEventListener('change', () => {
        if (cBtn) cBtn.disabled = !sel.value;
        if (sel.value) doConnect();
      });
      shellSel?.addEventListener('change', () => {
        if (sel?.value) doConnect();
      });
      cBtn?.addEventListener('click', doConnect);
      rBtn?.addEventListener('click', doConnect);
    } else {
      const doConnect = () => {
        connectSystem();
      };
      cBtn?.addEventListener('click', doConnect);
      rBtn?.addEventListener('click', doConnect);
    }
  }

  async function open(defaultContainerId = '') {
    if (defaultContainerId) selectedContainerId = defaultContainerId;
    if (state === 'open' || state === 'maximized') return;

    if (!rootEl) {
      rootEl = document.getElementById('quick-terminal-root');
      if (!rootEl) {
        rootEl = document.createElement('div');
        rootEl.id = 'quick-terminal-root';
        document.body.appendChild(rootEl);
      }
    }

    if (state === 'minimized') {
      restore();
      return;
    }

    await Promise.all([fetchContainers(), fetchActiveServer()]);
    rootEl.innerHTML = renderModalHtml();
    bindDomEvents();

    state = 'open';
    rootEl.classList.remove('qt-minimized-mode');
    rootEl.classList.add('qt-open');

    // Auto connect if container selected or if system tab
    if (activeTab === 'container' && selectedContainerId) {
      connectContainer();
    } else if (activeTab === 'system') {
      connectSystem();
    } else {
      // Initialize blank terminal preview
      const area = document.getElementById('qt-terminal-area');
      if (area && !term) {
        makeTerm(area);
        term.write('\x1b[36m— Select a container or switch to System shell to start —\x1b[0m\r\n');
      }
    }
  }

  function minimize() {
    if (state === 'closed') return;
    state = 'minimized';
    if (rootEl) {
      rootEl.classList.remove('qt-open', 'qt-maximized');
      rootEl.classList.add('qt-minimized-mode');
      const minEl = document.getElementById('qt-minimized');
      if (minEl) minEl.style.display = 'inline-flex';
      updateStatusBadge();
    }
  }

  function restore() {
    if (state === 'closed') {
      open();
      return;
    }
    state = 'open';
    if (rootEl) {
      rootEl.classList.remove('qt-minimized-mode');
      rootEl.classList.add('qt-open');
      const minEl = document.getElementById('qt-minimized');
      if (minEl) minEl.style.display = 'none';
      setTimeout(handleResize, 100);
      if (term) term.focus();
    }
  }

  function toggleMaximize() {
    if (state === 'maximized') {
      state = 'open';
      rootEl?.classList.remove('qt-maximized');
    } else {
      state = 'maximized';
      rootEl?.classList.add('qt-maximized');
    }
    setTimeout(handleResize, 100);
    if (term) term.focus();
  }

  function close() {
    state = 'closed';
    disposeTerm();
    socket.emit('terminal:stop');
    socket.emit('hostterm:stop');
    channel = null;
    if (rootEl) {
      rootEl.className = '';
      rootEl.innerHTML = '';
    }
  }

  function toggle() {
    if (state === 'closed') {
      open();
    } else if (state === 'minimized') {
      restore();
    } else {
      minimize();
    }
  }

  function init() {
    // Setup shortcut button in header
    const btn = document.getElementById('btn-quick-terminal');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggle();
      });
    }

    // Global keyboard shortcut: Ctrl+` or Alt+T
    window.addEventListener('keydown', (e) => {
      const isBacktick = e.key === '`' || e.code === 'Backquote';
      const isCtrlBacktick = (e.ctrlKey || e.metaKey) && isBacktick;
      const isAltT = e.altKey && (e.key === 't' || e.key === 'T');

      if (isCtrlBacktick || isAltT) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && (state === 'open' || state === 'maximized')) {
        // Only minimize on Escape if not actively in middle of terminal command typing
        minimize();
      }
    });
  }

  return {
    init,
    open,
    minimize,
    restore,
    close,
    toggle,
    getState: () => state
  };
})();

window.QuickTerminal = QuickTerminal;
