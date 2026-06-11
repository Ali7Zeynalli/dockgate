// Global Terminal Page — two tabs:
//   🐳 Container — interactive shell (exec) into a running container (works local + remote daemon)
//   💻 System    — a shell on the SERVER itself (the active one from the header): real SSH shell for a
//                  remote host, or the DockGate container shell for Local. See server/host-terminal.js.
Router.register('terminal', async (content, params) => {
  let activeTab = 'container';
  let selectedContainerId = params?.id || '';
  let containers = [];
  let activeServer = { id: 'local', label: 'Local', isLocal: true };
  let term = null;
  let fitAddon = null;
  let channel = null; // which event set the current xterm is bound to ('container' | 'system')

  const pageNavId = Router._navId;

  // ---- shared xterm helpers ----
  function disposeTerm() {
    if (term) { try { term.dispose(); } catch (e) {} term = null; }
    window.removeEventListener('resize', handleResize);
    unbindSocket();
  }
  function handleResize() {
    if (fitAddon) { try { fitAddon.fit(); } catch (e) {} }
    if (term && channel) socket.emit(channel === 'system' ? 'hostterm:resize' : 'terminal:resize', { cols: term.cols, rows: term.rows });
  }
  function makeTerm(area) {
    term = new Terminal({ cursorBlink: true, theme: { background: '#000000', foreground: '#e8ecf4' }, fontFamily: 'var(--font-mono), monospace', fontSize: 14, scrollback: 5000 });
    try { fitAddon = new window.FitAddon.FitAddon(); term.loadAddon(fitAddon); } catch (e) {}
    term.open(area);
    if (fitAddon) { setTimeout(handleResize, 50); window.addEventListener('resize', handleResize); }
  }

  // ---- socket binding (per channel) ----
  const onData = ({ data }) => { if (term) term.write(data); };
  const onEnd = () => { if (term) term.write('\r\n\x1b[33m— session ended (press Reconnect) —\x1b[0m\r\n'); };
  const onErr = ({ error }) => { if (term) term.write(`\r\n\x1b[31m— terminal error: ${error || 'unknown'} —\x1b[0m\r\n`); };
  function unbindSocket() {
    socket.off('terminal:data', onData).off('terminal:end', onEnd).off('terminal:error', onErr).off('terminal:ready', onContainerReady);
    socket.off('hostterm:data', onData).off('hostterm:end', onEnd).off('hostterm:error', onErr).off('hostterm:ready', onSystemReady);
    window._activeResub = null;
  }
  const onContainerReady = () => { if (term) term.write(`\x1b[32mConnected\x1b[0m\r\n`); };
  const onSystemReady = ({ host }) => { if (term) term.write(`\x1b[32mConnected to ${host || 'host'}\x1b[0m\r\n`); };

  // ---- Container terminal session ----
  function startContainerSession() {
    if (!selectedContainerId || !term) return;
    const shell = document.getElementById('terminal-shell')?.value || '/bin/sh';
    term.reset();
    term.write(`\x1b[36mConnecting to ${shell}…\x1b[0m\r\n`);
    socket.emit('terminal:stop');
    socket.emit('terminal:start', { containerId: selectedContainerId, shell });
    setTimeout(handleResize, 100);
    window._activeResub = () => startContainerSession();
  }
  function connectContainer() {
    channel = 'container';
    const area = document.getElementById('terminal-area');
    if (!area) return;
    disposeTerm();
    makeTerm(area);
    socket.on('terminal:ready', onContainerReady).on('terminal:data', onData).on('terminal:end', onEnd).on('terminal:error', onErr);
    term.onData(d => socket.emit('terminal:input', d));
    socket.emit('terminal:stop');
    setTimeout(startContainerSession, 50);
  }

  // ---- System (host) terminal session ----
  function startSystemSession() {
    if (!term) return;
    term.reset();
    term.write(`\x1b[36mConnecting to ${activeServer.label}…\x1b[0m\r\n`);
    socket.emit('hostterm:stop');
    socket.emit('hostterm:start', { cols: term.cols, rows: term.rows });
    setTimeout(handleResize, 100);
    window._activeResub = () => startSystemSession();
  }
  function connectSystem() {
    channel = 'system';
    const area = document.getElementById('terminal-area');
    if (!area) return;
    disposeTerm();
    makeTerm(area);
    socket.on('hostterm:ready', onSystemReady).on('hostterm:data', onData).on('hostterm:end', onEnd).on('hostterm:error', onErr);
    term.onData(d => socket.emit('hostterm:input', d));
    socket.emit('hostterm:stop');
    setTimeout(startSystemSession, 50);
  }

  async function fetchContainers() {
    const list = await API.get('/containers');
    containers = list.filter(c => c.state === 'running');
  }
  async function fetchActiveServer() {
    try {
      const servers = await API.get('/servers');
      const a = (servers || []).find(s => s.isActive) || { id: 'local', type: 'local' };
      activeServer = { id: a.id, isLocal: a.id === 'local', label: a.id === 'local' ? 'Local (DockGate container)' : `${a.id}${a.host ? ' (' + a.host + ')' : ''}` };
    } catch (e) { activeServer = { id: 'local', isLocal: true, label: 'Local (DockGate container)' }; }
  }

  function tabBar() {
    const t = (id, icon, label) => `<button class="btn ${activeTab === id ? 'btn-primary' : 'btn-secondary'}" data-tab="${id}">${icon} ${label}</button>`;
    return `<div style="display:flex;gap:8px;margin-bottom:14px">${t('container', '🐳', 'Container')}${t('system', '💻', 'System')}</div>`;
  }

  function renderContainerTab() {
    return `
      <div class="card mb-3" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 18px">
        <label class="text-sm font-bold">Container:</label>
        <select class="select" id="terminal-container">
          <option value="" disabled ${!selectedContainerId ? 'selected' : ''}>-- Choose Container --</option>
          ${containers.map(c => `<option value="${c.id}" ${selectedContainerId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${c.shortId})</option>`).join('')}
        </select>
        <div style="flex:1"></div>
        <label class="text-sm font-bold">Shell:</label>
        <select class="select" id="terminal-shell" style="width:120px">
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/zsh">/bin/zsh</option>
        </select>
        <button class="btn btn-primary" id="term-connect" ${!selectedContainerId ? 'disabled' : ''}>Connect</button>
        <button class="btn btn-secondary" id="term-reconnect" style="display:none">${Icons.refresh} Reconnect</button>
      </div>`;
  }
  function renderSystemTab() {
    return `
      <div class="card mb-3" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 18px">
        <label class="text-sm font-bold">Server:</label>
        <span class="badge ${activeServer.isLocal ? 'badge-created' : 'badge-running'}">${escapeHtml(activeServer.label)}</span>
        <span class="text-xs text-muted">${activeServer.isLocal ? 'Shell inside the DockGate container (has the docker CLI). Switch to a remote server in the header for its SSH shell.' : 'Real SSH shell on this host — manage it directly (apt, systemctl, docker…).'}</span>
        <div style="flex:1"></div>
        <button class="btn btn-primary" id="sys-connect">Connect</button>
        <button class="btn btn-secondary" id="sys-reconnect" style="display:none">${Icons.refresh} Reconnect</button>
      </div>`;
  }

  async function render() {
    try {
      if (containers.length === 0) await fetchContainers();
      await fetchActiveServer();
      if (!Router.isActiveNav(pageNavId)) return;

      const subtitle = activeTab === 'container'
        ? 'Interactive shell into a running container'
        : 'A shell on the server itself (the active one from the header)';

      content.innerHTML = `
        <div class="page-header mb-3"><div><div class="page-title">Terminal</div><div class="page-subtitle">${subtitle}</div></div></div>
        ${tabBar()}
        ${activeTab === 'container' ? renderContainerTab() : renderSystemTab()}
        <div class="card" style="padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#000;flex:1;display:flex;flex-direction:column;min-height:500px;max-height:calc(100vh - 220px)">
          <div id="terminal-area" style="flex:1;padding:12px;overflow:hidden"></div>
        </div>`;

      // tab switching
      content.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.tab === activeTab) return;
        disposeTerm(); socket.emit('terminal:stop'); socket.emit('hostterm:stop');
        activeTab = b.dataset.tab; channel = null;
        render();
      }));

      if (activeTab === 'container') {
        const sel = document.getElementById('terminal-container');
        const cBtn = document.getElementById('term-connect');
        const rBtn = document.getElementById('term-reconnect');
        const doConnect = () => {
          if (!sel.value) return;
          selectedContainerId = sel.value;
          if (cBtn) cBtn.style.display = 'none';
          if (rBtn) rBtn.style.display = 'inline-flex';
          connectContainer();
        };
        sel?.addEventListener('change', () => { if (cBtn) cBtn.disabled = !sel.value; if (sel.value) doConnect(); });
        document.getElementById('terminal-shell')?.addEventListener('change', () => { if (sel.value) doConnect(); });
        cBtn?.addEventListener('click', doConnect);
        rBtn?.addEventListener('click', doConnect);
        if (selectedContainerId) doConnect();
      } else {
        const cBtn = document.getElementById('sys-connect');
        const rBtn = document.getElementById('sys-reconnect');
        const doConnect = () => { if (cBtn) cBtn.style.display = 'none'; if (rBtn) rBtn.style.display = 'inline-flex'; connectSystem(); };
        cBtn?.addEventListener('click', doConnect);
        rBtn?.addEventListener('click', doConnect);
      }
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function destroy() {
    disposeTerm();
    socket.emit('terminal:stop');
    socket.emit('hostterm:stop');
  }

  await render();
  return destroy;
});
