// Container Detail Page (10 tabs)
Router.register('container-detail', async (content, params) => {
  const { id, tab: initialTab = 'overview' } = params;
  let currentTab = initialTab;
  let cleanup = [];

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      const info = await API.get(`/containers/${id}`);

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

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
            <button class="btn btn-secondary" id="update-btn" title="Edit CPU / memory / restart">${Icons.settings} Resources</button>
            <button class="btn btn-secondary" id="recreate-btn" title="Recreate with a new image">${Icons.restart} Recreate</button>
            <button class="btn btn-secondary" id="commit-btn" title="Commit to an image">${Icons.layers} Commit</button>
            <button class="btn btn-secondary" id="export-btn" title="Export filesystem as tar">${Icons.download} Export</button>
            <button class="btn btn-danger" data-action="remove">${Icons.trash} Remove</button>
          </div>
        </div>

        <div class="tabs" id="detail-tabs">
          ${['overview','logs','terminal','stats','processes','environment','ports','volumes','files','network','inspect','history'].map(t =>
            `<button class="tab ${currentTab === t ? 'active' : ''}" data-tab="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`
          ).join('')}
        </div>

        <div id="tab-content"></div>
      `;

      // Back button
      document.getElementById('back-btn').style.transform = 'rotate(180deg)';
      document.getElementById('back-btn').addEventListener('click', () => Router.navigate('resources',{tab:'containers'}));

      // Export filesystem → tar download (C5)
      document.getElementById('export-btn')?.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = `/api/containers/${id}/export`;
        a.download = `${name}.tar`;
        document.body.appendChild(a); a.click(); a.remove();
        showToast('Export started…', 'info');
      });

      // Edit resources (C1) — live CPU / memory / restart-policy update
      document.getElementById('update-btn')?.addEventListener('click', () => {
        const hc = info.HostConfig || {};
        const curCpus = hc.NanoCpus ? (hc.NanoCpus / 1e9) : '';
        const curMem = hc.Memory ? Math.round(hc.Memory / 1024 / 1024) + 'm' : '';
        const curRestart = hc.RestartPolicy?.Name || 'no';
        const body = `<div style="display:flex;flex-direction:column;gap:10px">
          <div class="input-group"><label>CPUs</label><input class="input" id="upd-cpus" placeholder="e.g. 0.5" value="${curCpus}"></div>
          <div class="input-group"><label>Memory</label><input class="input" id="upd-mem" placeholder="e.g. 512m" value="${curMem}"></div>
          <div class="input-group"><label>Restart policy</label><select class="select" id="upd-restart">${['no', 'unless-stopped', 'always', 'on-failure'].map(r => `<option value="${r}" ${r === curRestart ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        </div>`;
        showModal('Edit Resources', body, [
          { label: 'Cancel', className: 'btn btn-secondary' },
          { label: 'Apply', className: 'btn btn-primary', onClick: async () => {
            try {
              await API.post(`/containers/${id}/update`, { cpus: document.getElementById('upd-cpus').value.trim(), memory: document.getElementById('upd-mem').value.trim(), restart: document.getElementById('upd-restart').value });
              showToast('Resources updated'); render();
            } catch (e) { showToast(e.message, 'error', 8000); }
          } },
        ]);
      });

      // Recreate with a new image (C2) — preserves config, removes the old container
      document.getElementById('recreate-btn')?.addEventListener('click', () => {
        const curImg = info.Config?.Image || '';
        const body = `<div style="display:flex;flex-direction:column;gap:8px">
          <div class="text-sm text-muted">Recreates this container with the same config (env, ports, volumes, networks). Volume data is preserved; the old container is removed.</div>
          <div class="input-group"><label>Image</label><input class="input" id="recr-img" value="${escapeHtml(curImg)}"></div>
        </div>`;
        const m = showModal('Recreate Container', body, []);
        const root = m.overlay;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary'; btn.textContent = 'Recreate';
        root.querySelector('#modal-footer').appendChild(btn);
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = 'Recreating…';
          try {
            const r = await API.post(`/containers/${id}/recreate`, { image: root.querySelector('#recr-img').value.trim() });
            showToast('Container recreated'); m.close();
            Router.navigate('container-detail', { id: r.id }); // old id is gone → open the new one
          } catch (e) { showToast(e.message, 'error', 9000); btn.disabled = false; btn.textContent = 'Recreate'; }
        });
      });

      // Commit to an image (C4)
      document.getElementById('commit-btn')?.addEventListener('click', () => {
        const body = `<div style="display:flex;flex-direction:column;gap:8px">
          <div class="input-group"><label>Repository *</label><input class="input" id="commit-repo" placeholder="myrepo/app"></div>
          <div class="input-group"><label>Tag</label><input class="input" id="commit-tag" placeholder="latest" value="latest"></div>
        </div>`;
        showModal('Commit to Image', body, [
          { label: 'Cancel', className: 'btn btn-secondary' },
          { label: 'Commit', className: 'btn btn-primary', onClick: async () => {
            const repo = document.getElementById('commit-repo').value.trim();
            if (!repo) { showToast('Repository required', 'warning'); return; }
            try { await API.post(`/containers/${id}/commit`, { repo, tag: document.getElementById('commit-tag').value.trim() || 'latest' }); showToast('Image committed'); }
            catch (e) { showToast(e.message, 'error', 8000); }
          } },
        ]);
      });

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
              try { await API.post(`/containers/${id}/remove`, { force: true }); showToast(`Removed ${name}`); Router.navigate('resources',{tab:'containers'}); }
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
      content.innerHTML = `<div class="empty-state"><h3>Container not found</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary mt-2" onclick="Router.navigate('resources',{tab:'containers'})">Back</button></div>`;
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
      case 'processes': renderProcesses(tabContent, info); break;
      case 'environment': renderEnvironment(tabContent, info); break;
      case 'ports': renderPorts(tabContent, info); break;
      case 'volumes': renderVolumes(tabContent, info); break;
      case 'files': renderFiles(tabContent, info); break;
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
        <div class="detail-item"><div class="detail-label">Created</div><div class="detail-value">${info.Created ? formatTime(info.Created) : 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Started</div><div class="detail-value">${state.StartedAt ? formatTime(state.StartedAt) : 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Finished</div><div class="detail-value">${state.FinishedAt && state.FinishedAt !== '0001-01-01T00:00:00Z' ? formatTime(state.FinishedAt) : 'N/A'}</div></div>
        <div class="detail-item"><div class="detail-label">Restart Policy</div><div class="detail-value">${hc.RestartPolicy?.Name || 'N/A'} (max: ${hc.RestartPolicy?.MaximumRetryCount || 0})</div></div>
        <div class="detail-item"><div class="detail-label">Working Dir</div><div class="detail-value mono">${cfg.WorkingDir || '/'}</div></div>
        <div class="detail-item"><div class="detail-label">User</div><div class="detail-value">${cfg.User || 'root'}</div></div>
      </div>
      ${state.Health ? `
        <div class="mt-3">
          <div class="detail-label mb-1">Healthcheck — <span class="badge badge-${state.Health.Status === 'healthy' ? 'running' : 'created'}">${escapeHtml(state.Health.Status || '')}</span> · failing streak: ${state.Health.FailingStreak || 0}</div>
          <div class="table-wrapper"><table><thead><tr><th>Time</th><th>Exit</th><th>Output</th></tr></thead>
            <tbody>${(state.Health.Log || []).slice(-5).reverse().map(l => `<tr><td class="text-xs text-muted" style="white-space:nowrap">${l.Start ? formatTime(l.Start) : ''}</td><td>${l.ExitCode}</td><td class="td-mono text-xs" style="white-space:pre-wrap;word-break:break-all;max-width:420px">${escapeHtml((l.Output || '').trim().slice(0, 300))}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted text-sm">No checks yet.</td></tr>'}</tbody>
          </table></div>
        </div>` : ''}
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

  // Processes (top) + one-off exec (C6 + C8)
  function renderProcesses(el, info) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div class="detail-label">Running processes</div><button class="btn btn-xs btn-secondary" id="proc-refresh">${Icons.refresh}</button></div>
          <div class="table-wrapper" id="proc-table"><div class="text-muted text-sm" style="padding:12px">Loading…</div></div>
        </div>
        <div>
          <div class="detail-label mb-1">Run a one-off command</div>
          <div style="display:flex;gap:6px"><input class="input" id="exec-cmd" placeholder="e.g. ls -la /" style="flex:1"><button class="btn btn-sm btn-primary" id="exec-run">Run</button></div>
          <pre id="exec-out" class="log-viewer" style="margin-top:6px;max-height:240px;display:none;white-space:pre-wrap"></pre>
        </div>
      </div>`;
    async function loadTop() {
      const t = document.getElementById('proc-table');
      if (!t) return;
      if (info.State?.Status !== 'running') { t.innerHTML = '<div class="text-muted text-sm" style="padding:12px">Container is not running.</div>'; return; }
      try {
        const data = await API.get(`/containers/${id}/top`);
        const titles = data.Titles || [], procs = data.Processes || [];
        t.innerHTML = `<table><thead><tr>${titles.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${procs.map(rw => `<tr>${rw.map(c => `<td class="text-xs td-mono">${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      } catch (e) { t.innerHTML = `<div class="text-danger text-sm" style="padding:12px">${escapeHtml(e.message)}</div>`; }
    }
    document.getElementById('proc-refresh')?.addEventListener('click', loadTop);
    const runExec = async () => {
      const cmd = document.getElementById('exec-cmd').value.trim();
      if (!cmd) return;
      const out = document.getElementById('exec-out');
      out.style.display = 'block'; out.textContent = 'Running…';
      try { const r = await API.post(`/containers/${id}/exec`, { cmd }); out.textContent = (r.output || '(no output)') + `\n[exit ${r.exitCode}]`; }
      catch (e) { out.textContent = 'Error: ' + e.message; }
    };
    document.getElementById('exec-run')?.addEventListener('click', runExec);
    document.getElementById('exec-cmd')?.addEventListener('keydown', e => { if (e.key === 'Enter') runExec(); });
    loadTop();
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

    // Subscribe to log stream (and re-subscribe on socket reconnect so it doesn't freeze)
    const subscribeLogs = () => {
      const logSettings = Store.get('settings') || {};
      socket.emit('logs:subscribe', { containerId: id, tail: 200, timestamps: logSettings.logTimestamps === 'true' });
    };
    subscribeLogs();
    window._activeResub = subscribeLogs;
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
    const onLogNotice = (txt, color) => {
      const line = document.createElement('div');
      line.className = 'log-line'; line.style.color = color; line.textContent = txt;
      logEl.appendChild(line); if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
    };
    const onLogEnd = () => onLogNotice('— stream ended —', 'var(--warning)');
    const onLogError = ({ error }) => onLogNotice(`— log error: ${error} —`, 'var(--danger)');
    socket.on('logs:data', onLogData);
    socket.on('logs:end', onLogEnd);
    socket.on('logs:error', onLogError);
    cleanup.push(() => {
      socket.off('logs:data', onLogData);
      socket.off('logs:end', onLogEnd);
      socket.off('logs:error', onLogError);
      window._activeResub = null;
      socket.emit('logs:unsubscribe');
    });

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
    
    const syncSize = () => {
      if (fitAddon) { try { fitAddon.fit(); } catch (e) {} }
      socket.emit('terminal:resize', { cols: term.cols, rows: term.rows });
    };
    if (fitAddon) {
      setTimeout(syncSize, 50);
      window.addEventListener('resize', syncSize);
      cleanup.push(() => window.removeEventListener('resize', syncSize));
    }

    function connectTerminal(shell = '/bin/sh') {
      term.reset();
      term.write(`\x1b[36mConnecting to ${shell}...\x1b[0m\r\n`);
      socket.emit('terminal:start', { containerId: id, shell });
      setTimeout(syncSize, 100);
      window._activeResub = () => connectTerminal(shell); // resume on reconnect
    }

    const onTermReady = () => {
      term.write(`\x1b[32mConnected!\x1b[0m\r\n`);
    };

    socket.on('terminal:ready', onTermReady);

    const onTermData = ({ data }) => {
      term.write(data);
    };
    
    socket.on('terminal:data', onTermData);
    const onTermEnd = () => term.write('\r\n\x1b[33m— session ended (Reconnect) —\x1b[0m\r\n');
    const onTermError = ({ error }) => term.write(`\r\n\x1b[31m— terminal error: ${error || 'unknown'} —\x1b[0m\r\n`);
    socket.on('terminal:end', onTermEnd);
    socket.on('terminal:error', onTermError);

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
      socket.off('terminal:ready', onTermReady);
      socket.off('terminal:end', onTermEnd);
      socket.off('terminal:error', onTermError);
      window._activeResub = null;
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
      <div class="summary-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
        <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
          <div class="summary-card-icon green"><span class="nav-item-icon">${Icons.restart}</span></div>
          <div><div style="font-size:20px;font-weight:800;letter-spacing:-0.5px" id="stat-cpu">0%</div><div class="text-xs text-muted" style="margin-top:2px">CPU</div></div>
        </div>
        <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
          <div class="summary-card-icon blue"><span class="nav-item-icon">${Icons.layers}</span></div>
          <div><div style="font-size:20px;font-weight:800;letter-spacing:-0.5px" id="stat-mem">0 B</div><div class="text-xs text-muted" style="margin-top:2px">Memory</div></div>
        </div>
        <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
          <div class="summary-card-icon purple"><span class="nav-item-icon">${Icons.network}</span></div>
          <div>
            <div style="font-size:13px;font-weight:700" id="stat-net-rx">↓ 0 B</div>
            <div style="font-size:13px;font-weight:700;margin-top:2px" id="stat-net-tx">↑ 0 B</div>
            <div class="text-xs text-muted" style="margin-top:2px">Network I/O</div>
          </div>
        </div>
        <div class="card" style="padding:16px;display:flex;align-items:center;gap:12px">
          <div class="summary-card-icon yellow"><span class="nav-item-icon">${Icons.volume}</span></div>
          <div>
            <div style="font-size:13px;font-weight:700" id="stat-block-r">R: 0 B</div>
            <div style="font-size:13px;font-weight:700;margin-top:2px" id="stat-block-w">W: 0 B</div>
            <div class="text-xs text-muted" style="margin-top:2px">Block I/O</div>
          </div>
        </div>
      </div>
      <div class="grid-2" style="margin-bottom:16px">
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <span style="font-weight:600;font-size:13px">CPU Usage</span>
            <span class="text-xs text-muted" id="cpu-chart-label">0%</span>
          </div>
          <div style="position:relative;height:220px"><canvas id="cpu-chart"></canvas></div>
        </div>
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <span style="font-weight:600;font-size:13px">Memory Usage</span>
            <span class="text-xs text-muted" id="mem-chart-label">0 B</span>
          </div>
          <div style="position:relative;height:220px"><canvas id="mem-chart"></canvas></div>
        </div>
      </div>
    `;

    const cpuData = [];
    const memData = [];
    const labels = [];
    const maxPoints = 60;

    // Chart.js doesn't support CSS variables — read computed value
    // Chart.js CSS dəyişənlərini dəstəkləmir — hesablanmış dəyəri oxu
    const cs = getComputedStyle(document.documentElement);
    const gridColor = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.04)';
    const tickColor = cs.getPropertyValue('--text-muted').trim() || '#5a6478';

    const chartOpts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: {
        x: { display: false },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 10 } } }
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
      options: { ...chartOpts, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, ticks: { ...chartOpts.scales.y.ticks, callback: v => formatBytes(v) } } } }
    });

    const subscribeStats = () => socket.emit('stats:subscribe', { containerId: id });
    subscribeStats();
    window._activeResub = subscribeStats; // resume the live chart after a socket reconnect

    const onStatsData = (data) => {
      document.getElementById('stat-cpu').textContent = data.cpuPercent + '%';
      document.getElementById('stat-mem').textContent = formatBytes(data.memoryUsage) + ' / ' + formatBytes(data.memoryLimit);
      document.getElementById('stat-net-rx').textContent = '↓ ' + formatBytes(data.networkRx);
      document.getElementById('stat-net-tx').textContent = '↑ ' + formatBytes(data.networkTx);
      document.getElementById('stat-block-r').textContent = 'R: ' + formatBytes(data.blockRead);
      document.getElementById('stat-block-w').textContent = 'W: ' + formatBytes(data.blockWrite);

      // Update chart header labels
      document.getElementById('cpu-chart-label').textContent = data.cpuPercent + '%';
      document.getElementById('mem-chart-label').textContent = formatBytes(data.memoryUsage) + ' / ' + formatBytes(data.memoryLimit);

      const now = new Date().toLocaleTimeString();
      labels.push(now);
      cpuData.push(data.cpuPercent);
      memData.push(data.memoryUsage);

      if (labels.length > maxPoints) { labels.shift(); cpuData.shift(); memData.shift(); }
      cpuChart.update();
      memChart.update();
    };
    socket.on('stats:data', onStatsData);

    cleanup.push(() => { socket.off('stats:data', onStatsData); window._activeResub = null; socket.emit('stats:unsubscribe'); cpuChart.destroy(); memChart.destroy(); });
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
              const safeValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
              return `<tr data-env><td class="td-mono">${escapeHtml(key)}</td><td class="text-sm ${isSecret ? 'text-muted' : ''}">${isSecret ? '••••••••' : escapeHtml(value)}</td><td><button class="btn-icon" onclick="navigator.clipboard.writeText('${safeValue}');showToast('Copied!')" title="Copy">${Icons.copy}</button></td></tr>`;
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
              // Show only one binding per HostPort (IPv4/IPv6 deduplicate) / Eyni HostPort üçün yalnız bir binding göstər
              const seen = new Set();
              const uniqueBindings = (bindings || [{ HostIp: '', HostPort: '' }]).filter(b => {
                const key = b.HostPort || '';
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              return uniqueBindings.map(b => `
                <tr>
                  <td class="td-mono">${containerPort}</td>
                  <td><span class="badge badge-created">${protocol}</span></td>
                  <td class="td-mono">${b.HostIp === '::' ? '0.0.0.0' : (b.HostIp || '0.0.0.0')}:${b.HostPort || '—'}</td>
                  <td>${b.HostPort ? `<a href="${dockerHostUrl(b.HostPort)}" target="_blank" class="btn btn-xs btn-secondary">${Icons.externalLink} Open</a>` : ''}</td>
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

  // File browser (C3) — navigate the container fs, download files, upload a tar to extract
  function renderFiles(el, info) {
    if (info.State?.Status !== 'running') {
      el.innerHTML = '<div class="empty-state" style="padding:30px"><p class="text-muted">The file browser needs a running container (it uses exec).</p></div>';
      return;
    }
    let curPath = '/';
    async function load(path) {
      let data;
      try { data = await API.get(`/containers/${id}/files?path=${encodeURIComponent(path)}`); }
      catch (e) { el.innerHTML = `<div class="text-danger" style="padding:20px">${escapeHtml(e.message)}</div>`; return; }
      curPath = data.path || '/';
      const parts = curPath.split('/').filter(Boolean);
      const crumb = [`<a href="#" data-nav="/">/</a>`]
        .concat(parts.map((p, i) => `<a href="#" data-nav="/${parts.slice(0, i + 1).join('/')}">${escapeHtml(p)}</a>`))
        .join(' <span class="text-muted">/</span> ');
      const join = (n) => (curPath === '/' ? '' : curPath) + '/' + n;
      const rows = (data.entries || []).map(e => e.type === 'dir'
        ? `<tr><td><a href="#" class="td-name" data-dir="${escapeHtml(join(e.name))}">📁 ${escapeHtml(e.name)}</a></td><td></td><td></td></tr>`
        : `<tr><td class="td-name">📄 ${escapeHtml(e.name)}</td><td class="text-xs text-muted" style="white-space:nowrap">${formatBytes(e.size)}</td><td style="text-align:right"><button class="btn btn-xs btn-secondary" data-dl="${escapeHtml(join(e.name))}">${Icons.download}</button></td></tr>`
      ).join('');
      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="text-sm" style="word-break:break-all">${crumb}</div>
          <button class="btn btn-xs btn-secondary" id="cp-up" title="Upload a .tar — extracted into the current folder">${Icons.arrowUp} Upload .tar here</button>
        </div>
        <div class="table-wrapper" style="max-height:55vh;overflow:auto"><table><tbody>${rows || '<tr><td class="text-muted text-sm" style="padding:10px">Empty</td></tr>'}</tbody></table></div>
      </div>`;
      el.querySelectorAll('[data-dir]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); load(a.dataset.dir); }));
      el.querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); load(a.dataset.nav); }));
      el.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => {
        const a = document.createElement('a'); a.href = `/api/containers/${id}/file?path=${encodeURIComponent(b.dataset.dl)}`;
        document.body.appendChild(a); a.click(); a.remove();
      }));
      el.querySelector('#cp-up')?.addEventListener('click', () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.tar';
        inp.onchange = async () => {
          const f = inp.files && inp.files[0]; if (!f) return;
          showToast(`Uploading ${f.name} → ${curPath}…`, 'info');
          try {
            const r = await fetch(`/api/containers/${id}/upload?path=${encodeURIComponent(curPath)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-tar' }, body: f });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || 'Upload failed');
            showToast('Extracted into container'); load(curPath);
          } catch (e) { showToast(e.message, 'error', 8000); }
        };
        inp.click();
      });
    }
    load('/');
  }

  async function renderNetwork(el, info) {
    const networks = info.NetworkSettings?.Networks || {};
    const netList = Object.entries(networks);
    const connectedNames = new Set(netList.map(([n]) => n));
    let allNets = [];
    try { allNets = await API.get('/networks').catch(() => []); } catch (e) {}
    const candidates = (allNets || []).filter(n => !connectedNames.has(n.name) && !['host', 'none'].includes(n.name)).map(n => n.name);

    el.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Network</th><th>IP Address</th><th>Gateway</th><th>MAC Address</th><th></th></tr></thead>
          <tbody>
            ${netList.map(([name, n]) => `
              <tr>
                <td class="td-name">${escapeHtml(name)}</td>
                <td class="td-mono">${n.IPAddress || '—'}</td>
                <td class="td-mono">${n.Gateway || '—'}</td>
                <td class="td-mono">${n.MacAddress || '—'}</td>
                <td style="text-align:right"><button class="btn btn-xs btn-secondary" data-netdisc="${escapeHtml(name)}">Disconnect</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="mt-2" style="display:flex;gap:6px;align-items:center">
        <select class="select" id="net-attach-sel" style="flex:1"><option value="">Connect to a network…</option>${candidates.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
        <button class="btn btn-sm btn-primary" id="net-attach-btn">Connect</button>
      </div>
    `;
    el.querySelector('#net-attach-btn')?.addEventListener('click', async () => {
      const net = el.querySelector('#net-attach-sel').value;
      if (!net) { showToast('Pick a network', 'warning'); return; }
      try { await API.post(`/networks/${net}/connect`, { container: id }); showToast(`Connected to ${net}`); render(); }
      catch (e) { showToast(e.message, 'error'); }
    });
    el.querySelectorAll('[data-netdisc]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post(`/networks/${b.dataset.netdisc}/disconnect`, { container: id, force: true }); showToast(`Disconnected from ${b.dataset.netdisc}`); render(); }
      catch (e) { showToast(e.message, 'error'); }
    }));
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
      navigator.clipboard?.writeText(json)
        .then(() => showToast('JSON copied to clipboard'))
        .catch(() => showToast('Copy failed (clipboard needs HTTPS or localhost)', 'warning'));
    });
    // Wire the search box (it was previously dead — no listener) to filter the JSON by line
    const searchInput = document.getElementById('inspect-search');
    const jsonView = document.getElementById('json-view');
    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) { jsonView.innerHTML = syntaxHighlightJSON(json); return; }
      const matched = json.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n');
      jsonView.innerHTML = matched ? syntaxHighlightJSON(matched) : '<span class="text-muted">No matches</span>';
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
    }).catch(err => {
      el.innerHTML = `<div class="empty-state"><h3>Failed to load history</h3><p>${escapeHtml(err.message)}</p></div>`;
    });
  }

  await render();
  return () => { cleanup.forEach(fn => { try { fn(); } catch(e){} }); };
});
