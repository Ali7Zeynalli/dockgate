// Quick Terminal — Global floating & minimizable terminal overlay with Split-Screen (Dual Terminal) support
// Accessible from any page via the header shortcut or Ctrl+` (or Alt+T).
// Supports side-by-side Container Exec & Host SSH terminal sessions concurrently.
const QuickTerminal = (function() {
  let state = 'closed'; // 'closed' | 'open' | 'minimized' | 'maximized'
  let isSplit = false; // Single (false) or Dual Side-by-Side (true)
  let containers = [];
  let activeServer = { id: 'local', label: 'Local', isLocal: true };
  let rootEl = null;

  // Panel state models: panel[0] = Left/Primary, panel[1] = Right/Secondary
  const panels = [
    { slot: 0, activeTab: 'container', selectedContainerId: '', term: null, fitAddon: null, channel: null, isConnected: false },
    { slot: 1, activeTab: 'system', selectedContainerId: '', term: null, fitAddon: null, channel: null, isConnected: false }
  ];

  function disposePanelTerm(slot) {
    const p = panels[slot];
    if (p.term) {
      try { p.term.dispose(); } catch (e) {}
      p.term = null;
      p.fitAddon = null;
    }
    p.isConnected = false;
    p.channel = null;
    updateStatusBadge();
  }

  function handleResize() {
    if (state === 'closed' || state === 'minimized') return;
    [0, 1].forEach(slot => {
      if (slot === 1 && !isSplit) return;
      const p = panels[slot];
      if (p.term && p.fitAddon) {
        try {
          p.fitAddon.fit();
          if (p.channel && p.term.cols && p.term.rows) {
            socket.emit(p.channel === 'system' ? 'hostterm:resize' : 'terminal:resize', {
              cols: p.term.cols,
              rows: p.term.rows,
              slot
            });
          }
        } catch (e) {}
      }
    });
  }

  function makeTerm(slot, areaEl) {
    if (!areaEl) return;
    const p = panels[slot];
    p.term = new Terminal({
      cursorBlink: true,
      theme: { background: '#000000', foreground: '#e8ecf4' },
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 13,
      scrollback: 5000
    });
    try {
      p.fitAddon = new window.FitAddon.FitAddon();
      p.term.loadAddon(p.fitAddon);
    } catch (e) {}
    p.term.open(areaEl);
    p.term.onData(d => {
      if (p.channel === 'system') {
        socket.emit('hostterm:input', { data: d, slot });
      } else if (p.channel === 'container') {
        socket.emit('terminal:input', { data: d, slot });
      }
    });
    setTimeout(handleResize, 60);
  }

  // Socket event binding
  function bindGlobalSocketEvents() {
    socket.off('terminal:data', onContainerData)
          .off('terminal:end', onContainerEnd)
          .off('terminal:error', onContainerError)
          .off('terminal:ready', onContainerReady);
    socket.off('hostterm:data', onHostData)
          .off('hostterm:end', onHostEnd)
          .off('hostterm:error', onHostError)
          .off('hostterm:ready', onHostReady);

    socket.on('terminal:data', onContainerData)
          .on('terminal:end', onContainerEnd)
          .on('terminal:error', onContainerError)
          .on('terminal:ready', onContainerReady);
    socket.on('hostterm:data', onHostData)
          .on('hostterm:end', onHostEnd)
          .on('hostterm:error', onHostError)
          .on('hostterm:ready', onHostReady);
  }

  function getSlot(payload) {
    return (payload && payload.slot !== undefined) ? payload.slot : 0;
  }

  const onContainerData = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p && p.term && payload.data) p.term.write(payload.data);
  };
  const onContainerEnd = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p) {
      p.isConnected = false;
      updateStatusBadge();
      if (p.term) p.term.write('\r\n\x1b[33m— container session ended (press Reconnect) —\x1b[0m\r\n');
    }
  };
  const onContainerError = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p) {
      p.isConnected = false;
      updateStatusBadge();
      if (p.term) p.term.write(`\r\n\x1b[31m— container error: ${payload.error || 'unknown'} —\x1b[0m\r\n`);
    }
  };
  const onContainerReady = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p) {
      p.isConnected = true;
      updateStatusBadge();
      if (p.term) p.term.write('\x1b[32m● Connected to container\x1b[0m\r\n');
    }
  };

  const onHostData = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p && p.term && payload.data) p.term.write(payload.data);
  };
  const onHostEnd = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p) {
      p.isConnected = false;
      updateStatusBadge();
      if (p.term) p.term.write('\r\n\x1b[33m— host session ended (press Reconnect) —\x1b[0m\r\n');
    }
  };
  const onHostError = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p) {
      p.isConnected = false;
      updateStatusBadge();
      if (p.term) p.term.write(`\r\n\x1b[31m— host error: ${payload.error || 'unknown'} —\x1b[0m\r\n`);
    }
  };
  const onHostReady = (payload) => {
    const slot = getSlot(payload);
    const p = panels[slot];
    if (p) {
      p.isConnected = true;
      updateStatusBadge();
      if (p.term) p.term.write(`\x1b[32m● Connected to ${payload.host || 'host'}\x1b[0m\r\n`);
    }
  };

  // Session starters
  function startContainerSession(slot) {
    const p = panels[slot];
    if (!p.selectedContainerId || !p.term) return;
    const shell = document.getElementById(`qt-shell-${slot}`)?.value || '/bin/sh';
    p.term.reset();
    p.term.write(`\x1b[36mConnecting to ${shell}…\x1b[0m\r\n`);
    socket.emit('terminal:stop', { slot });
    socket.emit('terminal:start', { containerId: p.selectedContainerId, shell, slot });
    setTimeout(handleResize, 100);
  }

  function connectContainer(slot) {
    const p = panels[slot];
    p.channel = 'container';
    const area = document.getElementById(`qt-terminal-area-${slot}`);
    if (!area) return;
    disposePanelTerm(slot);
    p.channel = 'container';
    makeTerm(slot, area);
    socket.emit('terminal:stop', { slot });
    setTimeout(() => startContainerSession(slot), 50);
    updateToolbarState(slot);
  }

  function startSystemSession(slot) {
    const p = panels[slot];
    if (!p.term) return;
    p.term.reset();
    p.term.write(`\x1b[36mConnecting to ${activeServer.label}…\x1b[0m\r\n`);
    socket.emit('hostterm:stop', { slot });
    socket.emit('hostterm:start', { cols: p.term.cols || 80, rows: p.term.rows || 24, slot });
    setTimeout(handleResize, 100);
  }

  function connectSystem(slot) {
    const p = panels[slot];
    p.channel = 'system';
    const area = document.getElementById(`qt-terminal-area-${slot}`);
    if (!area) return;
    disposePanelTerm(slot);
    p.channel = 'system';
    makeTerm(slot, area);
    socket.emit('hostterm:stop', { slot });
    setTimeout(() => startSystemSession(slot), 50);
    updateToolbarState(slot);
  }

  async function fetchContainers() {
    try {
      const list = await API.get('/containers');
      containers = (list || []).filter(c => c.state === 'running');
      [0, 1].forEach(slot => {
        const sel = document.getElementById(`qt-container-${slot}`);
        if (sel) {
          const cur = panels[slot].selectedContainerId;
          sel.innerHTML = `
            <option value="" disabled ${!cur ? 'selected' : ''}>-- Choose Container --</option>
            ${containers.map(c => `<option value="${c.id}" ${cur === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${c.shortId})</option>`).join('')}
          `;
          if (cur && !containers.some(c => c.id === cur)) {
            panels[slot].selectedContainerId = '';
          }
        }
      });
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
      [0, 1].forEach(slot => {
        const lbl = document.getElementById(`qt-server-label-${slot}`);
        if (lbl) lbl.textContent = activeServer.label;
      });
    } catch (e) {
      activeServer = { id: 'local', isLocal: true, label: 'Local Docker' };
    }
  }

  function updateStatusBadge() {
    const badge = document.getElementById('qt-status-badge');
    const miniBadge = document.getElementById('qt-mini-status');
    const miniText = document.getElementById('qt-mini-title');

    const connectedCount = panels.filter((p, i) => (i === 0 || isSplit) && p.isConnected).length;
    let label = 'Disconnected';
    let dotClass = 'qt-dot-disconnected';

    if (connectedCount > 1) {
      label = `Dual Session (${connectedCount} Active)`;
      dotClass = 'qt-dot-connected';
    } else if (connectedCount === 1) {
      const activeP = panels.find((p, i) => (i === 0 || isSplit) && p.isConnected);
      label = activeP.channel === 'system' ? `Host (${activeServer.id})` : 'Container';
      dotClass = 'qt-dot-connected';
    } else if (panels.some((p, i) => (i === 0 || isSplit) && p.channel)) {
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
      if (isSplit && connectedCount > 1) {
        miniText.textContent = `Terminal: Split (2 Active)`;
      } else {
        const p0 = panels[0];
        const target = p0.channel === 'system' ? activeServer.label : (containers.find(c => c.id === p0.selectedContainerId)?.name || 'Terminal');
        miniText.textContent = `Terminal: ${target}`;
      }
    }
  }

  function updateToolbarState(slot) {
    const p = panels[slot];
    const cBtn = document.getElementById(`qt-btn-connect-${slot}`);
    const rBtn = document.getElementById(`qt-btn-reconnect-${slot}`);
    const hasTarget = p.activeTab === 'system' || !!p.selectedContainerId;

    if (cBtn && rBtn) {
      if (p.channel) {
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

  function renderPaneHtml(slot) {
    const p = panels[slot];
    return `
      <div class="quick-term-pane" id="qt-pane-${slot}">
        <!-- Pane Controls Bar -->
        <div class="quick-term-controls">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div class="quick-term-tab-group">
              <button class="quick-term-tab-btn ${p.activeTab === 'container' ? 'active' : ''}" data-slot="${slot}" data-tab="container">
                🐳 Container
              </button>
              <button class="quick-term-tab-btn ${p.activeTab === 'system' ? 'active' : ''}" data-slot="${slot}" data-tab="system">
                💻 System
              </button>
            </div>
            ${isSplit ? `<span class="badge badge-created" style="font-size:10px;padding:2px 7px;">${slot === 0 ? 'Panel 1 (Left)' : 'Panel 2 (Right)'}</span>` : ''}
          </div>
          <div class="quick-term-target-bar" id="qt-target-bar-${slot}">
            ${renderTargetControls(slot)}
          </div>
        </div>

        <!-- Terminal Viewport -->
        <div class="quick-term-viewport">
          <div id="qt-terminal-area-${slot}"></div>
        </div>
      </div>
    `;
  }

  function renderTargetControls(slot) {
    const p = panels[slot];
    if (p.activeTab === 'container') {
      return `
        <div style="display:flex;align-items:center;gap:6px;flex:1;flex-wrap:wrap;">
          <select class="select qt-select" id="qt-container-${slot}">
            <option value="" disabled ${!p.selectedContainerId ? 'selected' : ''}>-- Choose Container --</option>
            ${containers.map(c => `<option value="${c.id}" ${p.selectedContainerId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${c.shortId})</option>`).join('')}
          </select>
          <select class="select qt-select" id="qt-shell-${slot}" style="width:95px;">
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/zsh">/bin/zsh</option>
          </select>
          <button class="btn btn-primary btn-sm" id="qt-btn-connect-${slot}" ${!p.selectedContainerId ? 'disabled' : ''}>Connect</button>
          <button class="btn btn-secondary btn-sm" id="qt-btn-reconnect-${slot}" style="display:none;">${Icons.refresh} Reconnect</button>
          <button class="btn btn-ghost btn-sm" id="qt-btn-clear-${slot}" title="Clear buffer">Clear</button>
        </div>
      `;
    } else {
      return `
        <div style="display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;">
          <span class="badge ${activeServer.isLocal ? 'badge-created' : 'badge-running'}" id="qt-server-label-${slot}">
            ${escapeHtml(activeServer.label)}
          </span>
          <div style="flex:1"></div>
          <button class="btn btn-primary btn-sm" id="qt-btn-connect-${slot}">Connect</button>
          <button class="btn btn-secondary btn-sm" id="qt-btn-reconnect-${slot}" style="display:none;">${Icons.refresh} Reconnect</button>
          <button class="btn btn-ghost btn-sm" id="qt-btn-clear-${slot}" title="Clear buffer">Clear</button>
        </div>
      `;
    }
  }

  function renderModalHtml() {
    return `
      <div class="quick-term-backdrop" id="qt-backdrop"></div>
      <div class="quick-term-window ${isSplit ? 'qt-split-mode' : ''}" id="qt-window">
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
            <button class="qt-btn-ctrl ${isSplit ? 'active' : ''}" id="qt-btn-split" title="${isSplit ? 'Close Split (Single Terminal)' : 'Split Side-by-Side (Dual Terminals)'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
            </button>
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

        <!-- Body: 1 Pane or 2 Split Panes -->
        <div class="quick-term-panes-wrapper">
          ${renderPaneHtml(0)}
          ${isSplit ? renderPaneHtml(1) : ''}
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

  function bindDomEvents() {
    const root = rootEl;
    if (!root) return;

    // Tabs for both panels
    root.querySelectorAll('.quick-term-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const slot = parseInt(btn.dataset.slot, 10);
        const tab = btn.dataset.tab;
        const p = panels[slot];
        if (tab === p.activeTab) return;
        p.activeTab = tab;
        socket.emit('terminal:stop', { slot });
        socket.emit('hostterm:stop', { slot });
        disposePanelTerm(slot);

        // Update tab buttons for this slot
        root.querySelectorAll(`.quick-term-tab-btn[data-slot="${slot}"]`).forEach(b => b.classList.toggle('active', b.dataset.tab === p.activeTab));
        const targetBar = document.getElementById(`qt-target-bar-${slot}`);
        if (targetBar) {
          targetBar.innerHTML = renderTargetControls(slot);
          bindTargetEvents(slot);
        }
      });
    });

    // Split Toggle
    document.getElementById('qt-btn-split')?.addEventListener('click', toggleSplit);

    // Titlebar actions
    document.getElementById('qt-btn-minimize')?.addEventListener('click', minimize);
    document.getElementById('qt-btn-maximize')?.addEventListener('click', toggleMaximize);
    document.getElementById('qt-btn-close')?.addEventListener('click', close);
    document.getElementById('qt-backdrop')?.addEventListener('click', minimize);
    document.getElementById('qt-btn-fullscreen-page')?.addEventListener('click', () => {
      minimize();
      if (typeof Router !== 'undefined') {
        Router.navigate('activity', { tab: 'terminal', id: panels[0].selectedContainerId });
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

    bindTargetEvents(0);
    if (isSplit) bindTargetEvents(1);
  }

  function bindTargetEvents(slot) {
    const p = panels[slot];
    const cBtn = document.getElementById(`qt-btn-connect-${slot}`);
    const rBtn = document.getElementById(`qt-btn-reconnect-${slot}`);
    const clearBtn = document.getElementById(`qt-btn-clear-${slot}`);
    const sel = document.getElementById(`qt-container-${slot}`);
    const shellSel = document.getElementById(`qt-shell-${slot}`);

    clearBtn?.addEventListener('click', () => {
      if (p.term) p.term.clear();
    });

    if (p.activeTab === 'container') {
      const doConnect = () => {
        if (!sel?.value) return;
        p.selectedContainerId = sel.value;
        connectContainer(slot);
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
        connectSystem(slot);
      };
      cBtn?.addEventListener('click', doConnect);
      rBtn?.addEventListener('click', doConnect);
    }
  }

  function toggleSplit() {
    isSplit = !isSplit;
    const curP0Container = panels[0].selectedContainerId;
    const curP0Tab = panels[0].activeTab;
    const curP0Channel = panels[0].channel;

    const curP1Container = panels[1].selectedContainerId;
    const curP1Tab = panels[1].activeTab;
    const curP1Channel = panels[1].channel;

    // Re-render modal structure with new split state
    rootEl.innerHTML = renderModalHtml();
    bindDomEvents();

    // Reconnect Panel 0
    if (curP0Channel === 'container' && curP0Container) {
      connectContainer(0);
    } else if (curP0Channel === 'system') {
      connectSystem(0);
    } else {
      const a0 = document.getElementById('qt-terminal-area-0');
      if (a0) makeTerm(0, a0);
    }

    // Connect/Initialize Panel 1 if split
    if (isSplit) {
      if (curP1Channel === 'container' && curP1Container) {
        connectContainer(1);
      } else if (curP1Channel === 'system' || curP1Tab === 'system') {
        connectSystem(1);
      } else {
        const a1 = document.getElementById('qt-terminal-area-1');
        if (a1) makeTerm(1, a1);
      }
    } else {
      socket.emit('terminal:stop', { slot: 1 });
      socket.emit('hostterm:stop', { slot: 1 });
      disposePanelTerm(1);
    }

    setTimeout(handleResize, 120);
  }

  async function open(defaultContainerId = '') {
    if (defaultContainerId) panels[0].selectedContainerId = defaultContainerId;
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

    bindGlobalSocketEvents();
    await Promise.all([fetchContainers(), fetchActiveServer()]);
    rootEl.innerHTML = renderModalHtml();
    bindDomEvents();

    state = 'open';
    rootEl.classList.remove('qt-minimized-mode');
    rootEl.classList.add('qt-open');

    // Auto connect panel 0
    if (panels[0].activeTab === 'container' && panels[0].selectedContainerId) {
      connectContainer(0);
    } else if (panels[0].activeTab === 'system') {
      connectSystem(0);
    } else {
      const area = document.getElementById('qt-terminal-area-0');
      if (area && !panels[0].term) {
        makeTerm(0, area);
        panels[0].term.write('\x1b[36m— Select a container or switch to System shell to start —\x1b[0m\r\n');
      }
    }

    if (isSplit) {
      if (panels[1].activeTab === 'system') connectSystem(1);
      else if (panels[1].selectedContainerId) connectContainer(1);
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
      if (panels[0].term) panels[0].term.focus();
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
    if (panels[0].term) panels[0].term.focus();
  }

  function close() {
    state = 'closed';
    isSplit = false;
    [0, 1].forEach(slot => {
      disposePanelTerm(slot);
      socket.emit('terminal:stop', { slot });
      socket.emit('hostterm:stop', { slot });
    });
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
    bindGlobalSocketEvents();
    window.addEventListener('resize', handleResize);

    const btn = document.getElementById('btn-quick-terminal');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggle();
      });
    }

    window.addEventListener('keydown', (e) => {
      const isBacktick = e.key === '`' || e.code === 'Backquote';
      const isCtrlBacktick = (e.ctrlKey || e.metaKey) && isBacktick;
      const isAltT = e.altKey && (e.key === 't' || e.key === 'T');

      if (isCtrlBacktick || isAltT) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && (state === 'open' || state === 'maximized')) {
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
    toggleSplit,
    getState: () => state,
    isSplit: () => isSplit
  };
})();

window.QuickTerminal = QuickTerminal;
