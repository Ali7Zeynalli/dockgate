// Global Logs Page
Router.register('logs', async (content) => {
  let cleanupFns = [];
  
  async function render() {
    try {
      const containers = await API.get('/containers');
      const running = containers.filter(c => c.state === 'running');
      
      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Global Logs</div><div class="page-subtitle">Stream logs from any running container</div></div>
        </div>
        
        <div class="card mb-3" style="display:flex;gap:12px;align-items:center;padding:12px 18px">
          <label class="text-sm font-bold">Select Container:</label>
          <select class="select" id="log-target">
            <option value="">-- Choose Container --</option>
            ${running.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <div style="flex:1"></div>
          <button class="btn btn-primary" id="log-connect" disabled>Connect</button>
        </div>

        <div class="log-toolbar">
          <button class="btn btn-sm btn-secondary" id="log-pause" disabled>${Icons.pause} Pause</button>
          <button class="btn btn-sm btn-secondary" id="log-clear">Clear</button>
          <div style="flex:1"></div>
          <div class="search-input" style="max-width:250px">
            <span class="nav-item-icon">${Icons.search}</span>
            <input type="text" placeholder="Search logs..." id="log-search">
          </div>
        </div>
        <div class="log-viewer" id="log-content" style="height: 60vh">Select a container and connect to view logs.</div>
      `;

      const targetSelect = document.getElementById('log-target');
      const connectBtn = document.getElementById('log-connect');
      const logContent = document.getElementById('log-content');
      const pauseBtn = document.getElementById('log-pause');
      
      let isPaused = false;
      let activeContainer = null;

      targetSelect.addEventListener('change', () => {
        connectBtn.disabled = !targetSelect.value;
      });

      function disconnect() {
        if (activeContainer) {
          socket.emit('logs:unsubscribe');
          activeContainer = null;
        }
      }

      connectBtn.addEventListener('click', () => {
        const id = targetSelect.value;
        const name = targetSelect.options[targetSelect.selectedIndex].text;
        
        if (activeContainer === id) return;
        
        disconnect();
        activeContainer = id;
        logContent.innerHTML = `<span style="color:var(--accent)">Connecting to ${name}...</span>\n`;
        pauseBtn.disabled = false;
        
        socket.emit('logs:subscribe', { containerId: id, tail: 200 });
      });

      const onLogData = ({ data }) => {
        if (isPaused) return;
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = data;
        logContent.appendChild(line);
        if (logContent.children.length > 3000) logContent.removeChild(logContent.firstChild);
        logContent.scrollTop = logContent.scrollHeight;
      };

      socket.on('logs:data', onLogData);
      cleanupFns.push(() => {
        socket.off('logs:data', onLogData);
        disconnect();
      });

      pauseBtn.addEventListener('click', () => {
        isPaused = !isPaused;
        pauseBtn.innerHTML = isPaused ? `${Icons.play} Resume` : `${Icons.pause} Pause`;
      });
      
      document.getElementById('log-clear').addEventListener('click', () => {
        logContent.innerHTML = '';
      });

      document.getElementById('log-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        logContent.querySelectorAll('.log-line').forEach(line => {
          line.style.display = !q || line.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  
  await render();
  return () => { cleanupFns.forEach(fn => { try { fn(); } catch(e){} }); };
});
