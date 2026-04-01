// Global Terminal Page
Router.register('terminal', async (content, params) => {
  let selectedContainerId = params?.id || '';
  let containers = [];
  let term = null;
  let fitAddon = null;

  async function fetchContainers() {
    const list = await API.get('/containers');
    containers = list.filter(c => c.state === 'running');
  }

  async function render() {
    try {
      if (containers.length === 0) await fetchContainers();

      content.innerHTML = `
        <div class="page-header mb-3">
          <div>
            <div class="page-title">Terminal</div>
            <div class="page-subtitle">Interactive shell sessions for running containers</div>
          </div>
        </div>

        <div class="card mb-3" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 18px">
          <label class="text-sm font-bold">Select Container:</label>
          <select class="select" id="terminal-container">
            <option value="" disabled ${!selectedContainerId ? 'selected' : ''}>-- Choose Container --</option>
            ${containers.map(c => `
              <option value="${c.id}" ${selectedContainerId === c.id ? 'selected' : ''}>
                ${escapeHtml(c.name)} (${c.shortId})
              </option>
            `).join('')}
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
        </div>

        <div class="card" id="terminal-container-wrapper" style="padding:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:#000; flex:1; display:flex; flex-direction:column; min-height: 500px; max-height: calc(100vh - 180px)">
          ${!selectedContainerId || containers.length === 0 
            ? `<div class="empty-state" style="margin:auto">
                 <span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">${Icons.terminal}</span>
                 <h3>Terminal Disconnected</h3>
                 <p>${containers.length === 0 ? 'No running containers available.' : 'Select a container and click Connect to start session.'}</p>
               </div>` 
            : `<div id="terminal-area" style="flex:1; padding:12px; overflow:hidden"></div>`
          }
        </div>
      `;

      if (containers.length > 0 && selectedContainerId) {
        initTerminal();
      }

      // Bind events
      const targetSelect = document.getElementById('terminal-container');
      const connectBtn = document.getElementById('term-connect');
      const reconnectBtn = document.getElementById('term-reconnect');
      const shellSelect = document.getElementById('terminal-shell');

      function connect() {
        if (!targetSelect.value) return;
        selectedContainerId = targetSelect.value;
        const wrapper = document.getElementById('terminal-container-wrapper');
        const area = document.getElementById('terminal-area');
        if (!area) {
          wrapper.innerHTML = `<div id="terminal-area" style="flex:1; padding:12px; overflow:hidden"></div>`;
        }
        if(connectBtn) connectBtn.style.display = 'none';
        if(reconnectBtn) reconnectBtn.style.display = 'inline-flex';
        initTerminal();
      }

      targetSelect?.addEventListener('change', () => {
        if(connectBtn) connectBtn.disabled = !targetSelect.value;
        if(targetSelect.value) connect();
      });
      
      shellSelect?.addEventListener('change', () => {
        if(targetSelect.value) connect();
      });

      connectBtn?.addEventListener('click', connect);
      reconnectBtn?.addEventListener('click', connect);

    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function initTerminal() {
    if (term) term.dispose();
    
    const area = document.getElementById('terminal-area');
    if (!area) return;

    term = new Terminal({
      cursorBlink: true,
      theme: { background: '#000000', foreground: '#e8ecf4' },
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 14,
      scrollback: 5000
    });
    
    try {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    } catch (e) {
      console.warn('FitAddon missing on global terminal');
    }

    term.open(area);
    
    if (fitAddon) {
      setTimeout(() => fitAddon.fit(), 50);
      window.addEventListener('resize', handleResize);
    }

    socket.off('terminal:ready').on('terminal:ready', () => {
      let opt = document.getElementById('terminal-container').selectedOptions[0];
      term.write(`\x1b[32mConnected to ${opt ? opt.text.trim() : 'container'}\x1b[0m\r\n`);
    });

    socket.off('terminal:data').on('terminal:data', ({ data }) => {
      if (term) term.write(data);
    });

    term.onData(data => {
      socket.emit('terminal:input', data);
    });

    socket.emit('terminal:stop');
    setTimeout(startSession, 50);
  }

  function handleResize() {
    if (fitAddon) fitAddon.fit();
  }

  function startSession() {
    if (!selectedContainerId || !term) return;
    const shell = document.getElementById('terminal-shell')?.value || '/bin/sh';
    
    term.reset();
    term.write(`\x1b[36mConnecting to ${shell}...\x1b[0m\r\n`);
    
    socket.emit('terminal:stop');
    socket.emit('terminal:start', { containerId: selectedContainerId, shell });
  }

  function destroy() {
    window.removeEventListener('resize', handleResize);
    socket.off('terminal:ready');
    socket.off('terminal:data');
    socket.emit('terminal:stop');
    if (term) term.dispose();
  }

  // Initial boot
  await render();
  
  // Return cleanup func for SPA Router
  return destroy;
});
