// Container Detail Page (10 tabs)
Router.register('container-detail', async (content, params) => {
  const { id, tab: initialTab = 'overview' } = params;
  let currentTab = initialTab;
  let cleanup = [];

  async function render() {
    try {
      const info = await API.get(`/containers/${id}`);
      const name = info.Name?.replace(/^\//, '') || id.substring(0, 12);
      const state = info.State?.Status || 'unknown';

      document.getElementById('header-title').textContent = name;

      content.innerHTML = `
        <div class="page-header">
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-ghost" id="back-btn">${Icons.chevronRight} Back</button>
            <div>
              <div class="page-title" style="display:flex;align-items:center;gap:10px">
                ${escapeHtml(name)}
                <span class="badge badge-${state}"><span class="badge-dot"></span> ${state}</span>
              </div>
              <div class="page-subtitle td-mono">${info.Id?.substring(0, 12) || ''} · ${escapeHtml(info.Config?.Image || '')}</div>
            </div>
          </div>
          <div class="page-actions">
            ${state === 'running' ? `
              <button class="btn btn-secondary" data-action="stop">${Icons.stop} Stop</button>
              <button class="btn btn-secondary" data-action="restart">${Icons.restart} Restart</button>
              <button class="btn btn-secondary" data-action="pause">${Icons.pause} Pause</button>
            ` : state === 'paused' ? `
              <button class="btn btn-primary" data-action="unpause">${Icons.play} Unpause</button>
            ` : `
              <button class="btn btn-primary" data-action="start">${Icons.play} Start</button>
            `}
            <button class="btn btn-danger" data-action="remove">${Icons.trash} Remove</button>
          </div>
        </div>

        <div class="tabs" id="detail-tabs">
          ${['overview','logs','terminal','stats','environment','ports','volumes','network','inspect','history'].map(t =>
            `<button class="tab ${currentTab === t ? 'active' : ''}" data-tab="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`
          ).join('')}
        </div>

        <div id="tab-content"></div>
      `;

      // Back button
      document.getElementById('back-btn').style.transform = 'rotate(180deg)';
      document.getElementById('back-btn').addEventListener('click', () => Router.navigate('containers'));

      // Tab switching
      content.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => { 
          currentTab = btn.dataset.tab; 
          content.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
          renderTab(info); 
        });
      });

      // Actions
      content.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          if (action === 'remove') {
            showConfirm('Remove Container', `Remove <strong>${escapeHtml(name)}</strong>?`, async () => {
              try { await API.post(`/containers/${id}/remove`, { force: true }); showToast(`Removed ${name}`); Router.navigate('containers'); }
              catch (err) { showToast(err.message, 'error'); }
            }, true);
            return;
          }
          try { await API.post(`/containers/${id}/${action}`); showToast(`${action} → ${name}`); render(); }
          catch (err) { showToast(err.message, 'error'); }
        });
      });

      renderTab(info);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Container not found</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary mt-2" onclick="Router.navigate('containers')">Back</button></div>`;
    }
  }

  function renderTab(info) {
    const tabContent = document.getElementById('tab-content');
    if (!tabContent) return;

    // Cleanup previous streams
    cleanup.forEach(fn => { try { fn(); } catch(e){} });
    cleanup = [];

    switch(currentTab) {
      case 'overview': renderOverview(tabContent, info); break;
      case 'logs': renderLogs(tabContent, info); break;
      case 'terminal': renderTerminal(tabContent, info); break;
      case 'stats': renderStats(tabContent, info); break;
      case 'environment': renderEnvironment(tabContent, info); break;
      case 'ports': renderPorts(tabContent, info); break;
      case 'volumes': renderVolumes(tabContent, info); break;
      case 'network': renderNetwork(tabContent, info); break;
      case 'inspect': renderInspect(tabContent, info); break;
      case 'history': renderHistory(tabContent, info); break;
    }
  }

  function renderOverview(el, info) {
    const cfg = info.Config || {};
    const state = info.State || {};
    const hc = info.HostConfig || {};
    el.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-label">Container ID</div><div class="detail-value mono">${info.Id?.substring(0, 24) || 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Image</div><div class="detail-value mono">${escapeHtml(cfg.Image || '')}</div></div>
        <div class="detail-item"><div class="detail-label">Command</div><div class="detail-value mono">${escapeHtml((cfg.Cmd || []).join(' '))}</div></div>
        <div class="detail-item"><div class="detail-label">Entrypoint</div><div class="detail-value mono">${escapeHtml((cfg.Entrypoint || []).join(' ') || 'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value">${state.Status || 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Health</div><div class="detail-value">${state.Health?.Status || 'No healthcheck'}</div></div>
        <div class="detail-item"><div class="detail-label">Restart Count</div><div class="detail-value">${info.RestartCount || 0}</div></div>
        <div class="detail-item"><div class="detail-label">Exit Code</div><div class="detail-value">${state.ExitCode ?? 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Created</div><div class="detail-value">${info.Created ? new Date(info.Created).toLocaleString() : 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Started</div><div class="detail-value">${state.StartedAt ? new Date(state.StartedAt).toLocaleString() : 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Finished</div><div class="detail-value">${state.FinishedAt && state.FinishedAt !== '0001-01-01T00:00:00Z' ? new Date(state.FinishedAt).toLocaleString() : 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Restart Policy</div><div class="detail-value">${hc.RestartPolicy?.Name || 'N/A'} (max: ${hc.RestartPolicy?.MaximumRetryCount || 0})</div></div>
        <div class="detail-item"><div class="detail-label">Working Dir</div><div class="detail-value mono">${cfg.WorkingDir || '/'}</div></div>
        <div class="detail-item"><div class="detail-label">User</div><div class="detail-value">${cfg.User || 'root'}</div></div>
      </div>
      ${Object.keys(cfg.Labels || {}).length > 0 ? `
        <div class="mt-3">
          <div class="detail-label mb-1">Labels</div>
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Key</th><th>Value</th></tr></thead>
              <tbody>${Object.entries(cfg.Labels).map(([k,v]) => `<tr><td class="td-mono">${escapeHtml(k)}</td><td class="text-sm">${escapeHtml(v)}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>` : ''}
    `;
  }

  function renderLogs(el, info) {
    let isPaused = false;
    let autoScroll = true;
    el.innerHTML = `
      <div class="log-toolbar">
        <button class="btn btn-sm btn-secondary" id="log-pause">${Icons.pause} Pause</button>
        <button class="btn btn-sm btn-secondary" id="log-clear">Clear</button>
        <button class="btn btn-sm btn-secondary" id="log-download">${Icons.download} Download</button>
        <button class="btn btn-sm btn-secondary" id="log-copy">${Icons.copy} Copy</button>
        <div style="flex:1"></div>
        <div class="search-input" style="max-width:200px">
          <span class="nav-item-icon">${Icons.search}</span>
          <input type="text" placeholder="Search logs..." id="log-search">
        </div>
      </div>
      <div class="log-viewer" id="log-content">Connecting to log stream...</div>
    `;

    const logEl = document.getElementById('log-content');

    // Subscribe to log stream
    socket.emit('logs:subscribe', { containerId: id, tail: 200 });
    logEl.textContent = '';

    const onLogData = ({ data }) => {
      if (isPaused) return;
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = data;
      logEl.appendChild(line);
      if (logEl.children.length > 5000) logEl.removeChild(logEl.firstChild);
      if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
    };
    socket.on('logs:data', onLogData);
    cleanup.push(() => { socket.off('logs:data', onLogData); socket.emit('logs:unsubscribe'); });

    document.getElementById('log-pause')?.addEventListener('click', function() {
      isPaused = !isPaused;
      this.innerHTML = isPaused ? `${Icons.play} Resume` : `${Icons.pause} Pause`;
    });

    document.getElementById('log-clear')?.addEventListener('click', () => { logEl.innerHTML = ''; });

    document.getElementById('log-download')?.addEventListener('click', () => {
      const blob = new Blob([logEl.textContent], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${info.Name?.replace(/^\//, '') || 'container'}-logs.txt`;
      a.click();
    });

    document.getElementById('log-copy')?.addEventListener('click', () => {
      navigator.clipboard.writeText(logEl.textContent);
      showToast('Logs copied to clipboard');
    });

    document.getElementById('log-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      logEl.querySelectorAll('.log-line').forEach(line => {
        line.style.display = !q || line.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  function renderTerminal(el, info) {
    if (info.State?.Status !== 'running') {
      el.innerHTML = '<div class="empty-state"><h3>Container is not running</h3><p>Start the container to use terminal</p></div>';
      return;
    }

    el.innerHTML = `
      <div class="terminal-toolbar">
        <div class="flex items-center gap-1">
          <span class="badge badge-running"><span class="badge-dot"></span> Terminal</span>
          <span class="text-muted text-sm" id="term-shell">/bin/sh</span>
        </div>
        <div class="flex gap-1">
          <select class="select btn-sm" id="shell-select">
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/zsh">/bin/zsh</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="term-reconnect">${Icons.refresh} Reconnect</button>
        </div>
      </div>
      <div id="terminal-area" style="height:420px;background:#000;padding:8px;overflow:hidden"></div>
    `;

    const area = document.getElementById('terminal-area');
    const term = new Terminal({
      cursorBlink: true,
      theme: { background: '#000000', foreground: '#e8ecf4' },
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 13
    });
    
    let fitAddon = null;
    try {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    } catch (e) { console.warn('FitAddon not available'); }

    term.open(area);
    
    if (fitAddon) {
      setTimeout(() => fitAddon.fit(), 50);
      window.addEventListener('resize', () => fitAddon.fit());
    }

    function connectTerminal(shell = '/bin/sh') {
      term.reset();
      term.write(`\x1b[36mConnecting to ${shell}...\x1b[0m\r\n`);
      socket.emit('terminal:start', { containerId: id, shell });
    }

    socket.on('terminal:ready', () => {
      term.write(`\x1b[32mConnected!\x1b[0m\r\n`);
    });

    const onTermData = ({ data }) => {
      term.write(data);
    };
    
    socket.on('terminal:data', onTermData);

    term.onData(data => {
      socket.emit('terminal:input', data);
    });

    connectTerminal();

    document.getElementById('term-reconnect')?.addEventListener('click', () => {
      socket.emit('terminal:stop');
      const shell = document.getElementById('shell-select')?.value || '/bin/sh';
      connectTerminal(shell);
    });

    document.getElementById('shell-select')?.addEventListener('change', (e) => {
      socket.emit('terminal:stop');
      connectTerminal(e.target.value);
    });

    cleanup.push(() => { 
      socket.off('terminal:data', onTermData); 
      socket.off('terminal:ready');
      socket.emit('terminal:stop'); 
      if (term) term.dispose(); 
    });
  }

  function renderStats(el, info) {
    if (info.State?.Status !== 'running') {
      el.innerHTML = '<div class="empty-state"><h3>Container is not running</h3><p>Start the container to view stats</p></div>';
      return;
    }

    el.innerHTML = `
      <div class="summary-grid" style="margin-bottom:20px">
        <div class="summary-card"><div class="summary-card-icon green"><span class="nav-item-icon">${Icons.restart}</span></div><div class="summary-card-content"><div class="summary-card-value" id="stat-cpu">0%</div><div class="summary-card-label">CPU Usage</div></div></div>
        <div class="summary-card"><div class="summary-card-icon blue"><span class="nav-item-icon">${Icons.layers}</span></div><div class="summary-card-content"><div class="summary-card-value" id="stat-mem">0 B</div><div class="summary-card-label">Memory Usage</div></div></div>
        <div class="summary-card"><div class="summary-card-icon purple"><span class="nav-item-icon">${Icons.network}</span></div><div class="summary-card-content"><div class="summary-card-value" id="stat-net">↓ 0 B / ↑ 0 B</div><div class="summary-card-label">Network I/O</div></div></div>
        <div class="summary-card"><div class="summary-card-icon yellow"><span class="nav-item-icon">${Icons.volume}</span></div><div class="summary-card-content"><div class="summary-card-value" id="stat-block">R: 0 B / W: 0 B</div><div class="summary-card-label">Block I/O</div></div></div>
      </div>
      <div class="grid-2">
        <div class="card"><div style="font-weight:600;margin-bottom:8px">CPU %</div><div class="chart-container"><canvas id="cpu-chart"></canvas></div></div>
        <div class="card"><div style="font-weight:600;margin-bottom:8px">Memory</div><div class="chart-container"><canvas id="mem-chart"></canvas></div></div>
      </div>
    `;

    const cpuData = [];
    const memData = [];
    const labels = [];
    const maxPoints = 60;

    const chartOpts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: {
        x: { display: false },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5a6478', font: { size: 10 } } }
      },
      plugins: { legend: { display: false } },
      elements: { point: { radius: 0 }, line: { tension: 0.3, borderWidth: 2 } }
    };

    const cpuChart = new Chart(document.getElementById('cpu-chart'), {
      type: 'line',
      data: { labels, datasets: [{ data: cpuData, borderColor: '#00d68f', backgroundColor: 'rgba(0,214,143,0.1)', fill: true }] },
      options: { ...chartOpts, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, max: 100, ticks: { ...chartOpts.scales.y.ticks, callback: v => v + '%' } } } }
    });

    const memChart = new Chart(document.getElementById('mem-chart'), {
      type: 'line',
      data: { labels, datasets: [{ data: memData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true }] },
      options: chartOpts
    });

    socket.emit('stats:subscribe', { containerId: id });

    const onStatsData = (data) => {
      document.getElementById('stat-cpu').textContent = data.cpuPercent + '%';
      document.getElementById('stat-mem').textContent = formatBytes(data.memoryUsage) + ' / ' + formatBytes(data.memoryLimit);
      document.getElementById('stat-net').textContent = '↓ ' + formatBytes(data.networkRx) + ' / ↑ ' + formatBytes(data.networkTx);
      document.getElementById('stat-block').textContent = 'R: ' + formatBytes(data.blockRead) + ' / W: ' + formatBytes(data.blockWrite);

      const now = new Date().toLocaleTimeString();
      labels.push(now);
      cpuData.push(data.cpuPercent);
      memData.push(data.memoryUsage);

      if (labels.length > maxPoints) { labels.shift(); cpuData.shift(); memData.shift(); }
      cpuChart.update();
      memChart.update();
    };
    socket.on('stats:data', onStatsData);

    cleanup.push(() => { socket.off('stats:data', onStatsData); socket.emit('stats:unsubscribe'); cpuChart.destroy(); memChart.destroy(); });
  }

  function renderEnvironment(el, info) {
    const env = info.Config?.Env || [];
    el.innerHTML = `
      <div class="search-input mb-2" style="max-width:300px">
        <span class="nav-item-icon">${Icons.search}</span>
        <input type="text" placeholder="Search environment..." id="env-search">
      </div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Key</th><th>Value</th><th style="width:40px"></th></tr></thead>
          <tbody id="env-tbody">
            ${env.map(e => {
              const [key, ...rest] = e.split('=');
              const value = rest.join('=');
              const isSecret = /password|secret|key|token|api/i.test(key);
              return `<tr data-env><td class="td-mono">${escapeHtml(key)}</td><td class="text-sm ${isSecret ? 'text-muted' : ''}">${isSecret ? '••••••••' : escapeHtml(value)}</td><td><button class="btn-icon" onclick="navigator.clipboard.writeText('${escapeHtml(value).replace(/'/g, "\\'")}');showToast('Copied!')" title="Copy">${Icons.copy}</button></td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('env-search')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('[data-env]').forEach(row => {
        row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  function renderPorts(el, info) {
    const ports = info.NetworkSettings?.Ports || {};
    const portList = Object.entries(ports);
    if (portList.length === 0) { el.innerHTML = '<div class="empty-state"><h3>No ports exposed</h3></div>'; return; }

    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Container Port</th><th>Protocol</th><th>Host Binding</th><th></th></tr></thead>
          <tbody>
            ${portList.map(([port, bindings]) => {
              const [containerPort, protocol] = port.split('/');
              return (bindings || [{ HostIp: '', HostPort: '' }]).map(b => `
                <tr>
                  <td class="td-mono">${containerPort}</td>
                  <td><span class="badge badge-created">${protocol}</span></td>
                  <td class="td-mono">${b.HostIp || '0.0.0.0'}:${b.HostPort || '—'}</td>
                  <td>${b.HostPort ? `<a href="http://localhost:${b.HostPort}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} Open</a>` : ''}</td>
                </tr>
              `).join('');
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderVolumes(el, info) {
    const mounts = info.Mounts || [];
    if (mounts.length === 0) { el.innerHTML = '<div class="empty-state"><h3>No volumes mounted</h3></div>'; return; }

    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Type</th><th>Source</th><th>Destination</th><th>Mode</th></tr></thead>
          <tbody>
            ${mounts.map(m => `
              <tr>
                <td><span class="badge badge-${m.Type === 'volume' ? 'running' : 'paused'}">${m.Type}</span></td>
                <td class="td-mono">${escapeHtml(m.Source || m.Name || '')}</td>
                <td class="td-mono">${escapeHtml(m.Destination || '')}</td>
                <td><span class="badge ${m.RW ? 'badge-running' : 'badge-stopped'}">${m.RW ? 'rw' : 'ro'}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderNetwork(el, info) {
    const networks = info.NetworkSettings?.Networks || {};
    const netList = Object.entries(networks);

    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Network</th><th>IP Address</th><th>Gateway</th><th>MAC Address</th></tr></thead>
          <tbody>
            ${netList.map(([name, n]) => `
              <tr>
                <td class="td-name">${escapeHtml(name)}</td>
                <td class="td-mono">${n.IPAddress || '—'}</td>
                <td class="td-mono">${n.Gateway || '—'}</td>
                <td class="td-mono">${n.MacAddress || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderInspect(el, info) {
    const json = JSON.stringify(info, null, 2);
    el.innerHTML = `
      <div class="flex gap-1 mb-2">
        <button class="btn btn-sm btn-secondary" id="inspect-copy">${Icons.copy} Copy JSON</button>
        <div class="search-input" style="max-width:250px">
          <span class="nav-item-icon">${Icons.search}</span>
          <input type="text" placeholder="Search JSON..." id="inspect-search">
        </div>
      </div>
      <div class="json-viewer" id="json-view">${syntaxHighlightJSON(json)}</div>
    `;
    document.getElementById('inspect-copy')?.addEventListener('click', () => {
      navigator.clipboard.writeText(json);
      showToast('JSON copied to clipboard');
    });
  }

  function renderHistory(el) {
    API.get(`/meta/activity?limit=50`).then(activity => {
      const filtered = activity.filter(a => a.resource_id === id || a.resource_id === id.substring(0, 12));
      if (filtered.length === 0) { el.innerHTML = '<div class="empty-state"><h3>No activity recorded</h3><p>Actions performed on this container will appear here</p></div>'; return; }
      el.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Action</th><th>Details</th><th>Time</th></tr></thead>
            <tbody>
              ${filtered.map(a => `
                <tr>
                  <td><span class="badge badge-${a.action === 'start' ? 'running' : a.action === 'stop' ? 'stopped' : 'created'}">${a.action}</span></td>
                  <td class="text-sm text-muted">${escapeHtml(a.details || '')}</td>
                  <td class="text-sm text-muted">${timeAgo(a.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    });
  }

  await render();
  return () => { cleanup.forEach(fn => { try { fn(); } catch(e){} }); };
});
