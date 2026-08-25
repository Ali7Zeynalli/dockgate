// State-of-the-Art 4-in-1 Unified Log Explorer & Diagnostic Center
// Real-time WebSocket streaming, Linux host logs, Log Doctor & cross-container search.
// Ultra-lightweight DOM virtualization with strict element capping to prevent browser freezing.

Router.register('logs', async (content, params = {}) => {
  const cleanupFns = [];
  const pageNavId = Router._navId;

  const activeServer = Store.get('activeServer') || { id: 'local', name: 'Local Daemon' };
  const serverId = activeServer.id || 'local';

  let currentMode = params.mode || (params.tab === 'host' ? 'host' : (params.tab === 'doctor' ? 'doctor' : 'stream'));
  const preselectContainer = params.container || '';

  // Render outer shell with 4-in-1 segmented navigation
  content.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;max-width:1400px;margin:0 auto;">
      
      <!-- Top Header & Mode Switcher -->
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 18px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
        <div>
          <div style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:8px;">
            <span>📜</span>
            <span>Logs &amp; Diagnostic Explorer</span>
            <span class="badge" style="font-size:10px;padding:1px 6px;background:var(--accent-dim);color:var(--accent);">${escapeHtml(activeServer.name || serverId)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Real-time container streaming, Linux host logs &amp; autonomous Log Doctor</div>
        </div>

        <!-- Mode Switcher Tabs -->
        <div class="segmented-control" id="logs-mode-nav" style="display:flex;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px;gap:2px;">
          <button type="button" class="btn btn-sm ${currentMode === 'stream' ? 'btn-primary' : 'btn-ghost'}" data-mode="stream" style="padding:4px 10px;font-size:12px;">🐳 Container Stream</button>
          <button type="button" class="btn btn-sm ${currentMode === 'host' ? 'btn-primary' : 'btn-ghost'}" data-mode="host" style="padding:4px 10px;font-size:12px;">🐧 Linux Host Logs</button>
          <button type="button" class="btn btn-sm ${currentMode === 'doctor' ? 'btn-primary' : 'btn-ghost'}" data-mode="doctor" style="padding:4px 10px;font-size:12px;">🩺 Log Doctor</button>
          <button type="button" class="btn btn-sm ${currentMode === 'search' ? 'btn-primary' : 'btn-ghost'}" data-mode="search" style="padding:4px 10px;font-size:12px;">🌐 All Containers</button>
        </div>
      </div>

      <!-- Mode View Container -->
      <div id="logs-view-root"></div>
    </div>
  `;

  const viewRoot = content.querySelector('#logs-view-root');
  const modeNav = content.querySelector('#logs-mode-nav');

  // Switch between the 4 modes
  async function switchMode(mode) {
    if (!Router.isActiveNav(pageNavId)) return;
    currentMode = mode;

    modeNav.querySelectorAll('button').forEach(btn => {
      btn.className = `btn btn-sm ${btn.dataset.mode === mode ? 'btn-primary' : 'btn-ghost'}`;
    });

    if (mode === 'stream') await renderContainerStreamView();
    else if (mode === 'host') await renderHostLogsView();
    else if (mode === 'doctor') await renderLogDoctorView();
    else if (mode === 'search') await renderCrossContainerSearchView();
  }

  modeNav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) switchMode(btn.dataset.mode);
  });

  // =========================================================================
  // 1. 🐳 REAL-TIME CONTAINER WEBSOCKET STREAMING (Zero browser freezing)
  // =========================================================================
  async function renderContainerStreamView() {
    // Teardown any previous stream
    if (window._activeLogStreamTeardown) {
      window._activeLogStreamTeardown();
      window._activeLogStreamTeardown = null;
    }

    const containers = await API.get('/containers').catch(() => []);
    if (!Router.isActiveNav(pageNavId) || currentMode !== 'stream') return;

    const running = containers.filter(c => c.state === 'running');

    viewRoot.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        
        <!-- Controls Toolbar -->
        <div class="card" style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px;background:var(--bg-secondary);">
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:700;color:var(--text-muted);">CONTAINER:</label>
            <select class="select" id="stream-target" style="min-width:180px;font-size:12px;">
              <option value="">-- Select Container --</option>
              ${running.map(c => `<option value="${c.id}" ${preselectContainer === c.name || preselectContainer === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>

          <button class="btn btn-primary btn-sm" id="stream-connect-btn" style="padding:4px 12px;font-weight:600;">Connect</button>
          <button class="btn btn-secondary btn-sm" id="stream-pause-btn" disabled style="padding:4px 10px;">${Icons.pause} Pause</button>
          <button class="btn btn-secondary btn-sm" id="stream-clear-btn" style="padding:4px 10px;">Clear</button>
          <button class="btn btn-secondary btn-sm" id="stream-download-btn" disabled style="padding:4px 10px;" title="Download raw logs">💾 Export</button>

          <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
            <!-- Lines selector -->
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:11px;color:var(--text-muted);">Tail:</span>
              <select class="select" id="stream-tail" style="padding:2px 6px;font-size:11px;">
                <option value="100">100</option>
                <option value="200" selected>200</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
                <option value="2000">2000</option>
              </select>
            </div>

            <!-- Timestamps toggle -->
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--text-muted);">
              <input type="checkbox" id="stream-timestamps"> Timestamps
            </label>

            <!-- Auto scroll toggle -->
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--text-muted);">
              <input type="checkbox" id="stream-autoscroll" checked> Auto-scroll
            </label>

            <!-- Search box -->
            <div class="search-input" style="width:180px;">
              <span class="nav-item-icon">${Icons.search}</span>
              <input type="text" placeholder="Filter..." id="stream-search" style="padding:4px 8px 4px 28px;font-size:12px;">
            </div>
          </div>
        </div>

        <!-- Terminal Log Viewer -->
        <div class="log-viewer" id="stream-content" style="height:62vh;font-family:var(--font-mono, monospace);background:#080c14;border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px;overflow-y:auto;line-height:1.45;font-size:12px;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;">
          <div style="color:var(--text-muted);text-align:center;padding:40px;">Select a running container and click <b>Connect</b> to start real-time log streaming.</div>
        </div>

        <!-- Status footer -->
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);padding:0 4px;">
          <span id="stream-status">Idle</span>
          <span id="stream-line-count">0 lines (buffer cap: 1000)</span>
        </div>
      </div>
    `;

    const targetSelect = viewRoot.querySelector('#stream-target');
    const connectBtn = viewRoot.querySelector('#stream-connect-btn');
    const pauseBtn = viewRoot.querySelector('#stream-pause-btn');
    const clearBtn = viewRoot.querySelector('#stream-clear-btn');
    const downloadBtn = viewRoot.querySelector('#stream-download-btn');
    const tailSelect = viewRoot.querySelector('#stream-tail');
    const tsCheckbox = viewRoot.querySelector('#stream-timestamps');
    const autoScrollCb = viewRoot.querySelector('#stream-autoscroll');
    const searchInput = viewRoot.querySelector('#stream-search');
    const logContent = viewRoot.querySelector('#stream-content');
    const statusEl = viewRoot.querySelector('#stream-status');
    const lineCountEl = viewRoot.querySelector('#stream-line-count');

    let activeCid = null;
    let isPaused = false;
    let totalLinesCount = 0;
    const MAX_DOM_LINES = 1000;
    const rawLogLines = [];

    // Micro-batch buffer for high throughput
    let lineQueue = [];
    let rafTimer = null;

    function flushQueue() {
      if (!lineQueue.length || !document.body.contains(logContent)) {
        lineQueue = [];
        rafTimer = null;
        return;
      }

      const fragment = document.createDocumentFragment();
      const searchTerm = searchInput.value.trim().toLowerCase();

      for (const text of lineQueue) {
        rawLogLines.push(text);
        if (rawLogLines.length > 5000) rawLogLines.shift();

        const lineEl = document.createElement('div');
        lineEl.className = 'log-line';

        const isErr = /error|fatal|fail|panic|exception/i.test(text);
        const isWrn = /warn/i.test(text);
        if (isErr) lineEl.style.color = '#f87171';
        else if (isWrn) lineEl.style.color = '#fbbf24';

        lineEl.textContent = text;
        if (searchTerm && !text.toLowerCase().includes(searchTerm)) {
          lineEl.style.display = 'none';
        }
        fragment.appendChild(lineEl);
        totalLinesCount++;
      }

      lineQueue = [];
      logContent.appendChild(fragment);

      // Fast circular DOM ring buffer trimming
      while (logContent.childElementCount > MAX_DOM_LINES) {
        logContent.removeChild(logContent.firstChild);
      }

      if (autoScrollCb.checked) {
        logContent.scrollTop = logContent.scrollHeight;
      }

      lineCountEl.textContent = `${logContent.childElementCount} rendered lines (buffer cap: ${MAX_DOM_LINES})`;
      rafTimer = null;
    }

    function appendStreamLine(text) {
      if (isPaused) return;
      lineQueue.push(text);
      if (!rafTimer) {
        rafTimer = requestAnimationFrame(flushQueue);
      }
    }

    function appendNotice(text, color = 'var(--text-muted)') {
      const el = document.createElement('div');
      el.style.color = color;
      el.style.fontStyle = 'italic';
      el.style.padding = '2px 0';
      el.textContent = text;
      logContent.appendChild(el);
      if (autoScrollCb.checked) logContent.scrollTop = logContent.scrollHeight;
    }

    function disconnect() {
      if (activeCid) {
        socket.emit('logs:unsubscribe');
        activeCid = null;
        connectBtn.textContent = 'Connect';
        connectBtn.className = 'btn btn-primary btn-sm';
        pauseBtn.disabled = true;
        downloadBtn.disabled = rawLogLines.length === 0;
        statusEl.textContent = 'Disconnected';
      }
    }

    function subscribe() {
      if (!activeCid) return;
      const tail = parseInt(tailSelect.value, 10) || 200;
      const timestamps = tsCheckbox.checked;
      socket.emit('logs:subscribe', { containerId: activeCid, tail, timestamps });
      statusEl.textContent = `Streaming from ${activeCid.substring(0, 12)}…`;
      connectBtn.textContent = 'Disconnect';
      connectBtn.className = 'btn btn-danger btn-sm';
      pauseBtn.disabled = false;
      downloadBtn.disabled = false;
    }
    window._activeResub = subscribe;

    connectBtn.addEventListener('click', () => {
      const cid = targetSelect.value;
      if (!cid) return;

      if (activeCid === cid) {
        disconnect();
        return;
      }

      disconnect();
      activeCid = cid;
      logContent.innerHTML = '';
      totalLinesCount = 0;
      rawLogLines.length = 0;
      appendNotice(`— Connecting to ${targetSelect.options[targetSelect.selectedIndex].text}… —`, 'var(--accent)');
      subscribe();
    });

    const onLogData = ({ containerId, data }) => {
      if (!activeCid || (containerId && !activeCid.startsWith(containerId) && !containerId.startsWith(activeCid))) return;
      if (typeof data === 'string') {
        const lines = data.split('\n');
        for (const l of lines) {
          if (l.trim()) appendStreamLine(l);
        }
      }
    };

    const onLogEnd = () => { if (activeCid) appendNotice('— container stream ended —', '#f59e0b'); };
    const onLogError = ({ error }) => { if (activeCid) appendNotice(`— error: ${error} —`, '#ef4444'); };

    socket.on('logs:data', onLogData);
    socket.on('logs:end', onLogEnd);
    socket.on('logs:error', onLogError);

    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.innerHTML = isPaused ? `${Icons.play} Resume` : `${Icons.pause} Pause`;
      pauseBtn.className = isPaused ? 'btn btn-warning btn-sm' : 'btn btn-secondary btn-sm';
    });

    clearBtn.addEventListener('click', () => {
      logContent.innerHTML = '';
      totalLinesCount = 0;
      lineCountEl.textContent = '0 lines';
    });

    downloadBtn.addEventListener('click', () => {
      if (!rawLogLines.length) return;
      const cName = targetSelect.options[targetSelect.selectedIndex]?.text || 'container';
      const blob = new Blob([rawLogLines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cName}_logs_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      logContent.querySelectorAll('.log-line').forEach(line => {
        line.style.display = !q || line.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Auto-connect if preselected
    if (preselectContainer && targetSelect.value) {
      connectBtn.click();
    }

    const teardown = () => {
      disconnect();
      socket.off('logs:data', onLogData);
      socket.off('logs:end', onLogEnd);
      socket.off('logs:error', onLogError);
      window._activeResub = null;
      if (rafTimer) cancelAnimationFrame(rafTimer);
    };

    window._activeLogStreamTeardown = teardown;
    cleanupFns.push(teardown);
  }

  // =========================================================================
  // 2. 🐧 LINUX HOST & SYSTEM LOGS EXPLORER (Local & Remote SSH)
  // =========================================================================
  async function renderHostLogsView() {
    if (window._activeLogStreamTeardown) {
      window._activeLogStreamTeardown();
      window._activeLogStreamTeardown = null;
    }

    viewRoot.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        
        <!-- Controls Toolbar -->
        <div class="card" style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px;background:var(--bg-secondary);">
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:700;color:var(--text-muted);">SOURCE:</label>
            <select class="select" id="hl-source" style="min-width:240px;max-width:360px;font-size:12px;">
              <optgroup label="System Curated">
                <option value="source:journald" selected>journald (All Services)</option>
                <option value="source:kernel">kernel (dmesg)</option>
                <option value="source:auth">auth.log (Security &amp; SSH)</option>
                <option value="source:syslog">syslog (System Events)</option>
                <option value="source:boot">this boot log</option>
              </optgroup>
            </select>
          </div>

          <div style="display:flex;align-items:center;gap:4px;">
            <span style="font-size:11px;color:var(--text-muted);">Lines:</span>
            <select class="select" id="hl-lines" style="padding:2px 6px;font-size:11px;">
              <option value="200" selected>200</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
              <option value="2000">2000</option>
            </select>
          </div>

          <button class="btn btn-secondary btn-sm" id="hl-refresh" style="padding:4px 10px;">${Icons.refresh} Refresh</button>
          
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--text-muted);">
            <input type="checkbox" id="hl-auto"> Auto-refresh 5s
          </label>

          <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
            <div class="search-input" style="width:200px;">
              <span class="nav-item-icon">${Icons.search}</span>
              <input type="text" placeholder="Search system log..." id="hl-search" style="padding:4px 8px 4px 28px;font-size:12px;">
            </div>
          </div>
        </div>

        <!-- Terminal Log Viewer -->
        <div class="log-viewer" id="hl-body" style="height:62vh;font-family:var(--font-mono, monospace);background:#080c14;border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px;overflow-y:auto;line-height:1.45;font-size:12px;color:#cbd5e1;white-space:pre-wrap;word-break:break-all;">
          Loading system logs…
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);padding:0 4px;">
          <span id="hl-status">Ready</span>
          <span id="hl-info">—</span>
        </div>
      </div>
    `;

    const sourceSel = viewRoot.querySelector('#hl-source');
    const linesSel = viewRoot.querySelector('#hl-lines');
    const refreshBtn = viewRoot.querySelector('#hl-refresh');
    const autoCb = viewRoot.querySelector('#hl-auto');
    const searchInput = viewRoot.querySelector('#hl-search');
    const bodyEl = viewRoot.querySelector('#hl-body');
    const statusEl = viewRoot.querySelector('#hl-status');
    const infoEl = viewRoot.querySelector('#hl-info');

    let timer = null;

    // Discover systemd service units + /var/log files on this host
    (async () => {
      try {
        const d = await API.get(`/servers/${serverId}/host/log-sources`);
        if (!document.body.contains(sourceSel)) return;

        const optgrp = (label, opts) => {
          if (!opts.length) return;
          const g = document.createElement('optgroup');
          g.label = label;
          for (const [val, text] of opts) {
            const o = document.createElement('option');
            o.value = val;
            o.textContent = text;
            g.appendChild(o);
          }
          sourceSel.appendChild(g);
        };

        optgrp(`System Services (${(d.units || []).length})`, (d.units || []).map(u => [`unit:${u}`, u.replace(/\.service$/, '')]));
        optgrp(`Log Files (${(d.files || []).length})`, (d.files || []).map(f => [`file:${f}`, f.replace('/var/log/', '')]));
      } catch (e) {}
    })();

    function queryFor(value) {
      const i = value.indexOf(':');
      const kind = value.slice(0, i);
      const val = value.slice(i + 1);
      return `${kind}=${encodeURIComponent(val)}`;
    }

    async function loadLogs() {
      if (!document.body.contains(bodyEl)) {
        if (timer) clearInterval(timer);
        return;
      }
      statusEl.textContent = 'Fetching host logs…';

      try {
        const lines = linesSel.value;
        const r = await API.get(`/servers/${serverId}/host/logs?${queryFor(sourceSel.value)}&lines=${encodeURIComponent(lines)}`);
        if (!document.body.contains(bodyEl)) return;

        const rawText = r.text || '(empty log stream)';
        const searchTerm = searchInput.value.trim().toLowerCase();

        if (searchTerm) {
          const filtered = rawText.split('\n').filter(l => l.toLowerCase().includes(searchTerm)).join('\n');
          bodyEl.textContent = filtered || '(no matches found)';
        } else {
          bodyEl.textContent = rawText;
        }

        bodyEl.scrollTop = bodyEl.scrollHeight;
        statusEl.textContent = `Active · ${r.label || ''} · ${new Date().toLocaleTimeString()}`;
        infoEl.textContent = `${r.lines || lines} lines requested`;
      } catch (err) {
        if (!document.body.contains(bodyEl)) return;
        bodyEl.textContent = `Could not read host logs: ${err.message}\n\nHint: Host logs require passwordless sudo or read access to /var/log.`;
        statusEl.textContent = 'Error';
      }
    }

    refreshBtn.addEventListener('click', loadLogs);
    sourceSel.addEventListener('change', loadLogs);
    linesSel.addEventListener('change', loadLogs);
    searchInput.addEventListener('input', () => {
      clearTimeout(searchInput._t);
      searchInput._t = setTimeout(loadLogs, 250);
    });

    autoCb.addEventListener('change', (e) => {
      if (timer) { clearInterval(timer); timer = null; }
      if (e.target.checked) timer = setInterval(loadLogs, 5000);
    });

    loadLogs();

    cleanupFns.push(() => {
      if (timer) clearInterval(timer);
    });
  }

  // =========================================================================
  // 3. 🩺 LOG DOCTOR & AUTONOMOUS DIAGNOSTICS
  // =========================================================================
  async function renderLogDoctorView() {
    if (window._activeLogStreamTeardown) {
      window._activeLogStreamTeardown();
      window._activeLogStreamTeardown = null;
    }

    viewRoot.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;">
        
        <!-- Health Score Hero Card -->
        <div class="card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:20px 24px;background:linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.95));border:1px solid rgba(0, 212, 170, 0.3);border-radius:var(--radius-lg);">
          <div style="display:flex;align-items:center;gap:14px;">
            <div style="font-size:36px;">🩺</div>
            <div>
              <div style="font-size:18px;font-weight:800;color:var(--text-primary);">Log Doctor Diagnostic Engine</div>
              <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">Scans recent logs for Kernel OOM Kills, Proxy 502/504s, Port Collisions, and Security Anomalies.</div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:14px;">
            <div style="text-align:right;">
              <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;">SERVER HEALTH SCORE</div>
              <div id="doctor-score-val" style="font-size:28px;font-weight:800;color:#10b981;">—/100</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="doctor-rescan-btn" style="padding:6px 14px;">🔄 Re-Scan</button>
          </div>
        </div>

        <!-- Issue Cards Container -->
        <div id="doctor-issues-list" style="display:flex;flex-direction:column;gap:12px;">
          <div class="card" style="padding:32px;text-align:center;color:var(--text-muted);">
            Scanning log buffers for anomalies…
          </div>
        </div>
      </div>
    `;

    const scoreVal = viewRoot.querySelector('#doctor-score-val');
    const rescanBtn = viewRoot.querySelector('#doctor-rescan-btn');
    const issuesList = viewRoot.querySelector('#doctor-issues-list');

    async function runScan() {
      scoreVal.textContent = '…';
      try {
        const doc = await API.get(`/monitoring/${serverId}/doctor`);
        if (!document.body.contains(scoreVal)) return;

        const score = doc.healthScore ?? 100;
        let scoreColor = '#10b981';
        if (score < 70) scoreColor = '#ef4444';
        else if (score < 90) scoreColor = '#f59e0b';

        scoreVal.textContent = `${score}/100`;
        scoreVal.style.color = scoreColor;

        const issues = doc.issues || [];
        if (issues.length === 0) {
          issuesList.innerHTML = `
            <div class="card" style="padding:24px;background:rgba(16, 185, 129, 0.08);border:1px solid rgba(16, 185, 129, 0.25);border-radius:var(--radius-lg);text-align:center;">
              <div style="font-size:24px;margin-bottom:6px;">✨</div>
              <div style="font-size:15px;font-weight:700;color:#10b981;margin-bottom:4px;">All Systems Nominal</div>
              <div style="font-size:12px;color:var(--text-muted);max-width:500px;margin:0 auto;">No memory terminations (OOM), 502/504 Bad Gateways, port collisions, or authentication brute-force attacks detected in recent logs.</div>
            </div>
          `;
        } else {
          issuesList.innerHTML = issues.map(iss => {
            let sevColor = '#ef4444';
            let sevBadge = 'CRITICAL';
            if (iss.severity === 'warning') { sevColor = '#f59e0b'; sevBadge = 'WARNING'; }
            else if (iss.severity === 'security') { sevColor = '#ec4899'; sevBadge = 'SECURITY'; }

            return `
              <div class="card" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;padding:16px 20px;border-left:5px solid ${sevColor};background:var(--bg-secondary);">
                <div style="flex:1;min-width:300px;">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span class="badge" style="background:${sevColor}22;color:${sevColor};font-size:10px;font-weight:800;padding:2px 6px;">${sevBadge}</span>
                    <span style="font-weight:800;font-size:14px;color:var(--text-primary);">${escapeHtml(iss.title)}</span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;line-height:1.4;">${escapeHtml(iss.description)}</div>
                  ${iss.evidence ? `<div style="font-family:var(--font-mono);font-size:11px;color:#94a3b8;background:rgba(0,0,0,0.3);padding:6px 10px;border-radius:4px;word-break:break-all;border:1px solid var(--border);">💡 Evidence: ${escapeHtml(iss.evidence)}</div>` : ''}
                </div>
                ${iss.action ? `
                  <button class="btn btn-primary btn-sm" onclick="Router.navigate('${iss.action.page}', { tab: '${iss.action.tab || ''}' })" style="align-self:center;white-space:nowrap;font-size:12px;padding:6px 14px;">
                    ${escapeHtml(iss.action.label)} →
                  </button>
                ` : ''}
              </div>
            `;
          }).join('');
        }
      } catch (err) {
        if (!document.body.contains(scoreVal)) return;
        scoreVal.textContent = 'Err';
        issuesList.innerHTML = `<div class="card text-danger" style="padding:16px;">Failed to run diagnostic scan: ${escapeHtml(err.message)}</div>`;
      }
    }

    rescanBtn.addEventListener('click', runScan);
    runScan();
  }

  // =========================================================================
  // 4. 🌐 CROSS-CONTAINER SEARCH & AGGREGATOR
  // =========================================================================
  async function renderCrossContainerSearchView() {
    if (window._activeLogStreamTeardown) {
      window._activeLogStreamTeardown();
      window._activeLogStreamTeardown = null;
    }

    viewRoot.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        
        <!-- Filter Toolbar -->
        <div class="card" style="display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 16px;background:var(--bg-secondary);">
          <div style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:700;color:var(--text-muted);">LEVEL:</label>
            <div class="segmented-control" id="agg-lvl-nav" style="display:flex;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px;">
              <button type="button" class="btn btn-sm btn-primary" data-lvl="" style="padding:2px 8px;font-size:11px;">All</button>
              <button type="button" class="btn btn-sm btn-ghost" data-lvl="error" style="padding:2px 8px;font-size:11px;color:#ef4444;">🔴 Errors</button>
              <button type="button" class="btn btn-sm btn-ghost" data-lvl="warn" style="padding:2px 8px;font-size:11px;color:#f59e0b;">🟡 Warnings</button>
              <button type="button" class="btn btn-sm btn-ghost" data-lvl="info" style="padding:2px 8px;font-size:11px;color:#10b981;">🟢 Info</button>
            </div>
          </div>

          <div style="flex:1;min-width:240px;">
            <div class="search-input" style="width:100%;">
              <span class="nav-item-icon">${Icons.search}</span>
              <input type="text" placeholder="Search across all containers (e.g. timeout, 500, db connection)..." id="agg-search" style="width:100%;font-size:12px;padding:4px 8px 4px 28px;">
            </div>
          </div>

          <button class="btn btn-secondary btn-sm" id="agg-refresh-btn" style="padding:4px 10px;">🔄 Refresh</button>
        </div>

        <!-- Log List -->
        <div class="log-viewer" id="agg-content" style="height:62vh;font-family:var(--font-mono, monospace);background:#080c14;border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px;overflow-y:auto;line-height:1.5;font-size:12px;">
          <div style="color:var(--text-muted);text-align:center;padding:32px;">Loading cross-container logs…</div>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);padding:0 4px;">
          <span id="agg-status">Ready</span>
          <span id="agg-count">0 matching logs</span>
        </div>
      </div>
    `;

    const lvlNav = viewRoot.querySelector('#agg-lvl-nav');
    const searchInput = viewRoot.querySelector('#agg-search');
    const refreshBtn = viewRoot.querySelector('#agg-refresh-btn');
    const aggContent = viewRoot.querySelector('#agg-content');
    const statusEl = viewRoot.querySelector('#agg-status');
    const countEl = viewRoot.querySelector('#agg-count');

    let currentLvl = '';

    lvlNav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lvl]');
      if (!btn) return;
      lvlNav.querySelectorAll('button').forEach(b => { b.className = 'btn btn-sm btn-ghost'; });
      btn.className = 'btn btn-sm btn-primary';
      currentLvl = btn.dataset.lvl;
      fetchAggLogs();
    });

    async function fetchAggLogs() {
      statusEl.textContent = 'Searching…';
      try {
        const search = searchInput.value.trim();
        const qs = `?level=${encodeURIComponent(currentLvl)}&search=${encodeURIComponent(search)}&limit=300`;
        const res = await API.get(`/monitoring/${serverId}/logs${qs}`);
        if (!document.body.contains(aggContent)) return;

        const logs = res.logs || [];
        countEl.textContent = `${logs.length} matching logs`;

        if (logs.length === 0) {
          aggContent.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:32px;">No matching log entries found.</div>`;
          statusEl.textContent = 'Empty';
          return;
        }

        // Fast document fragment rendering
        aggContent.innerHTML = '';
        const fragment = document.createDocumentFragment();

        for (const l of logs) {
          const lineEl = document.createElement('div');
          lineEl.style.padding = '2px 0';
          lineEl.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
          lineEl.style.display = 'flex';
          lineEl.style.gap = '8px';
          lineEl.style.alignItems = 'baseline';

          const timeStr = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          let lvlColor = '#94a3b8';
          if (l.level === 'error') lvlColor = '#ef4444';
          else if (l.level === 'warn') lvlColor = '#f59e0b';
          else if (l.level === 'info') lvlColor = '#10b981';

          lineEl.innerHTML = `
            <span style="color:#64748b;font-size:10px;white-space:nowrap;">${timeStr}</span>
            <span class="badge" style="font-size:9px;padding:0 5px;background:rgba(255,255,255,0.07);color:#38bdf8;white-space:nowrap;">${escapeHtml(l.containerName || 'sys')}</span>
            <span style="font-weight:700;font-size:10px;color:${lvlColor};white-space:nowrap;width:38px;">${(l.level || 'INFO').toUpperCase()}</span>
            <span style="flex:1;color:${l.level === 'error' ? '#fca5a5' : '#cbd5e1'};word-break:break-all;">${escapeHtml(l.message)}</span>
          `;
          fragment.appendChild(lineEl);
        }

        aggContent.appendChild(fragment);
        aggContent.scrollTop = aggContent.scrollHeight;
        statusEl.textContent = 'Updated';
      } catch (err) {
        if (!document.body.contains(aggContent)) return;
        aggContent.innerHTML = `<div class="text-danger" style="padding:16px;">Failed to fetch logs: ${escapeHtml(err.message)}</div>`;
        statusEl.textContent = 'Error';
      }
    }

    refreshBtn.addEventListener('click', fetchAggLogs);
    searchInput.addEventListener('input', () => {
      clearTimeout(searchInput._t);
      searchInput._t = setTimeout(fetchAggLogs, 300);
    });

    fetchAggLogs();
  }

  // Initial load
  await switchMode(currentMode);

  return () => {
    cleanupFns.forEach(fn => { try { fn(); } catch(e){} });
  };
});
