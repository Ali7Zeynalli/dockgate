// Global & Centralized Log Explorer with Intelligent Log Doctor Diagnostics
Router.register('logs', async (content, params = {}) => {
  let cleanupFns = [];
  const pageNavId = Router._navId;

  async function render() {
    try {
      const activeServer = Store.get('activeServer') || { id: 'local' };
      const serverId = activeServer.id || 'local';

      const containers = await API.get('/containers').catch(() => []);
      if (!Router.isActiveNav(pageNavId)) return;

      const running = containers.filter(c => c.state === 'running');
      const preselectContainer = params.container || '';

      content.innerHTML = `
        <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div class="page-title">📜 Centralized Log Explorer &amp; Log Doctor</div>
            <div class="page-subtitle">Full-stack multi-layer log harvester &amp; autonomous diagnostic engine</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="logs-agent-badge" class="badge" style="background:var(--accent-dim);color:var(--accent);font-size:11px;padding:2px 8px;">Unified Harvester Active</span>
          </div>
        </div>

        <!-- 🩺 Log Doctor Diagnostic Banner -->
        <div id="log-doctor-banner" class="card mb-3" style="padding:14px 18px;background:linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.95));border:1px solid rgba(0, 212, 170, 0.3);border-radius:var(--radius-lg);box-shadow:0 4px 16px rgba(0,0,0,0.2);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:18px;">🩺</span>
              <span style="font-weight:700;font-size:14px;color:var(--text-primary);">Log Doctor &amp; Server Health Insights</span>
              <span id="doctor-score-badge" class="badge" style="background:#10b98122;color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;">Analyzing…</span>
            </div>
            <button id="doctor-toggle-btn" class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px;">Hide Issues ▲</button>
          </div>

          <div id="doctor-issues-container" style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">
            <div style="color:var(--text-muted);font-size:12px;">Scanning recent logs for anomalies, OOM kills, proxy 502s, and port collisions…</div>
          </div>
        </div>

        <!-- Controls Toolbar -->
        <div class="card mb-3" style="display:flex;flex-direction:column;gap:12px;padding:14px 18px;background:var(--bg-secondary);">
          
          <!-- Row 1: Source & Container Selectors -->
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <!-- Source Selector Chips -->
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="text-xs text-muted" style="font-weight:600;">SOURCE:</span>
              <div class="segmented-control" style="display:flex;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px;">
                <button type="button" class="btn btn-sm btn-primary" data-src="" style="padding:3px 8px;font-size:11px;">🌐 All</button>
                <button type="button" class="btn btn-sm btn-ghost" data-src="container" style="padding:3px 8px;font-size:11px;">🐳 Containers</button>
                <button type="button" class="btn btn-sm btn-ghost" data-src="nginx" style="padding:3px 8px;font-size:11px;">🌐 Nginx/Web</button>
                <button type="button" class="btn btn-sm btn-ghost" data-src="system" style="padding:3px 8px;font-size:11px;">🐧 Linux OS</button>
                <button type="button" class="btn btn-sm btn-ghost" data-src="auth" style="padding:3px 8px;font-size:11px;">🛡️ Security/Auth</button>
                <button type="button" class="btn btn-sm btn-ghost" data-src="kernel" style="padding:3px 8px;font-size:11px;">⚠️ Kernel</button>
              </div>
            </div>

            <!-- Specific Container Dropdown -->
            <div style="display:flex;align-items:center;gap:6px;">
              <select class="select" id="log-target" style="min-width:160px;font-size:12px;">
                <option value="">All Containers</option>
                ${running.map(c => `<option value="${escapeHtml(c.name)}" ${preselectContainer === c.name || preselectContainer === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>

            <!-- Log Level Chips -->
            <div class="segmented-control" style="display:flex;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px;">
              <button type="button" class="btn btn-sm btn-primary" data-lvl="" style="padding:3px 8px;font-size:11px;">All Levels</button>
              <button type="button" class="btn btn-sm btn-ghost" data-lvl="error" style="padding:3px 8px;font-size:11px;color:#ef4444;">🔴 Error</button>
              <button type="button" class="btn btn-sm btn-ghost" data-lvl="warn" style="padding:3px 8px;font-size:11px;color:#f59e0b;">🟡 Warn</button>
              <button type="button" class="btn btn-sm btn-ghost" data-lvl="info" style="padding:3px 8px;font-size:11px;color:#10b981;">🟢 Info</button>
            </div>
          </div>

          <!-- Row 2: Search Input & Actions -->
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <div style="flex:1;min-width:200px;">
              <div class="search-input" style="width:100%;">
                <span class="nav-item-icon">${Icons.search}</span>
                <input type="text" placeholder="Filter message (e.g. 500, OOM, timeout, connection refused)..." id="log-search" style="width:100%;">
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:var(--text-muted);">
                <input type="checkbox" id="log-autoscroll" checked> Auto-scroll
              </label>
              <button class="btn btn-sm btn-secondary" id="log-refresh" title="Refresh logs">🔄 Refresh</button>
              <button class="btn btn-sm btn-secondary" id="log-clear" title="Clear view">Clear</button>
            </div>
          </div>

        </div>

        <!-- Log Content Console -->
        <div class="log-viewer" id="log-content" style="height: 60vh; font-family: var(--font-mono, monospace); background: #0b0f19; border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 12px; overflow-y: auto; line-height: 1.5; font-size: 12px;">
          <div style="color:var(--text-muted);text-align:center;padding:24px;">Loading unified log stream…</div>
        </div>
      `;

      const targetSelect = document.getElementById('log-target');
      const searchInput = document.getElementById('log-search');
      const logContent = document.getElementById('log-content');
      const refreshBtn = document.getElementById('log-refresh');
      const clearBtn = document.getElementById('log-clear');
      const autoScrollCb = document.getElementById('log-autoscroll');
      const doctorContainer = document.getElementById('doctor-issues-container');
      const doctorScoreBadge = document.getElementById('doctor-score-badge');
      const doctorToggleBtn = document.getElementById('doctor-toggle-btn');

      let currentSource = '';
      let currentLevel = '';
      let pollTimer = null;
      let doctorExpanded = true;

      doctorToggleBtn.addEventListener('click', () => {
        doctorExpanded = !doctorExpanded;
        doctorContainer.style.display = doctorExpanded ? 'flex' : 'none';
        doctorToggleBtn.textContent = doctorExpanded ? 'Hide Issues ▲' : 'Show Issues ▼';
      });

      async function fetchDoctor() {
        if (!Router.isActiveNav(pageNavId)) return;
        try {
          const doc = await API.get(`/monitoring/${serverId}/doctor`);
          if (!Router.isActiveNav(pageNavId)) return;

          const score = doc.healthScore ?? 100;
          let scoreColor = '#10b981';
          if (score < 70) scoreColor = '#ef4444';
          else if (score < 90) scoreColor = '#f59e0b';

          doctorScoreBadge.innerHTML = `Health Score: ${score}/100`;
          doctorScoreBadge.style.color = scoreColor;
          doctorScoreBadge.style.background = `${scoreColor}22`;

          const issues = doc.issues || [];
          if (issues.length === 0) {
            doctorContainer.innerHTML = `
              <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(16, 185, 129, 0.08);border:1px solid rgba(16, 185, 129, 0.2);border-radius:6px;color:#10b981;font-size:12px;">
                <span>✓</span>
                <span><b>All Systems Nominal:</b> No critical crashes, OOM terminations, proxy 502s, or port collisions detected in recent logs.</span>
              </div>
            `;
          } else {
            doctorContainer.innerHTML = issues.map(iss => {
              let sevColor = '#ef4444';
              let sevBadge = 'CRITICAL';
              if (iss.severity === 'warning') { sevColor = '#f59e0b'; sevBadge = 'WARNING'; }
              else if (iss.severity === 'security') { sevColor = '#ec4899'; sevBadge = 'SECURITY'; }

              return `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;padding:10px 14px;background:rgba(0,0,0,0.3);border-left:4px solid ${sevColor};border-radius:6px;">
                  <div style="flex:1;min-width:280px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                      <span class="badge" style="background:${sevColor}22;color:${sevColor};font-size:10px;font-weight:700;padding:1px 6px;">${sevBadge}</span>
                      <span style="font-weight:700;font-size:13px;color:var(--text-primary);">${escapeHtml(iss.title)}</span>
                    </div>
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${escapeHtml(iss.description)}</div>
                    ${iss.evidence ? `<div style="font-family:var(--font-mono);font-size:11px;color:#94a3b8;background:rgba(255,255,255,0.04);padding:4px 8px;border-radius:4px;word-break:break-all;">💡 Evidence: ${escapeHtml(iss.evidence)}</div>` : ''}
                  </div>
                  ${iss.action ? `
                    <button class="btn btn-sm btn-primary" onclick="Router.navigate('${iss.action.page}', { tab: '${iss.action.tab || ''}' })" style="white-space:nowrap;align-self:center;font-size:11px;padding:4px 10px;">
                      ${escapeHtml(iss.action.label)} →
                    </button>
                  ` : ''}
                </div>
              `;
            }).join('');
          }
        } catch (e) {
          // Doctor fetch error
        }
      }

      async function fetchLogs() {
        if (!Router.isActiveNav(pageNavId)) return;
        const container = targetSelect.value;
        const search = searchInput.value.trim();

        try {
          const qs = `?container=${encodeURIComponent(container)}&source=${encodeURIComponent(currentSource)}&level=${encodeURIComponent(currentLevel)}&search=${encodeURIComponent(search)}&limit=300`;
          const res = await API.get(`/monitoring/${serverId}/logs${qs}`);

          if (!Router.isActiveNav(pageNavId)) return;

          const logs = res.logs || [];
          if (logs.length === 0) {
            logContent.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:24px;">No log entries matching the selected criteria.</div>`;
            return;
          }

          logContent.innerHTML = logs.map(l => {
            const timeStr = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            let levelColor = '#94a3b8';
            let bgStyle = '';
            if (l.level === 'error') {
              levelColor = '#ef4444';
              bgStyle = 'background:rgba(239, 68, 68, 0.08);';
            } else if (l.level === 'warn') {
              levelColor = '#f59e0b';
            } else if (l.level === 'info') {
              levelColor = '#10b981';
            }

            const srcTag = l.source || (l.containerName || 'app');

            return `
              <div class="log-row" style="display:flex;gap:10px;padding:2px 6px;border-radius:3px;${bgStyle}">
                <span style="color:#64748b;flex-shrink:0;user-select:none;">${timeStr}</span>
                <span style="color:#38bdf8;font-weight:600;flex-shrink:0;">[${escapeHtml(srcTag)}]</span>
                <span style="color:${levelColor};font-weight:700;flex-shrink:0;width:45px;text-align:center;text-transform:uppercase;font-size:10px;padding:1px 3px;border-radius:2px;background:rgba(255,255,255,0.05);">${l.level}</span>
                <span style="color:#e2e8f0;word-break:break-all;white-space:pre-wrap;flex:1;">${escapeHtml(l.message)}</span>
              </div>
            `;
          }).join('');

          if (autoScrollCb.checked) {
            logContent.scrollTop = logContent.scrollHeight;
          }
        } catch (e) {
          // Log query error
        }
      }

      // Event handlers for source chips
      content.querySelectorAll('[data-src]').forEach(btn => {
        btn.addEventListener('click', () => {
          content.querySelectorAll('[data-src]').forEach(b => { b.className = 'btn btn-sm btn-ghost'; });
          btn.className = 'btn btn-sm btn-primary';
          currentSource = btn.dataset.src;
          fetchLogs();
        });
      });

      // Event handlers for level chips
      content.querySelectorAll('[data-lvl]').forEach(btn => {
        btn.addEventListener('click', () => {
          content.querySelectorAll('[data-lvl]').forEach(b => { b.className = 'btn btn-sm btn-ghost'; });
          btn.className = 'btn btn-sm btn-primary';
          currentLevel = btn.dataset.lvl;
          fetchLogs();
        });
      });

      targetSelect.addEventListener('change', fetchLogs);
      searchInput.addEventListener('input', () => {
        clearTimeout(searchInput._t);
        searchInput._t = setTimeout(fetchLogs, 300);
      });
      refreshBtn.addEventListener('click', () => { fetchLogs(); fetchDoctor(); });
      clearBtn.addEventListener('click', () => { logContent.innerHTML = ''; });

      // Initial Fetch & Live auto-refresh every 5s
      fetchLogs();
      fetchDoctor();
      pollTimer = setInterval(() => { fetchLogs(); fetchDoctor(); }, 5000);

      cleanupFns.push(() => {
        if (pollTimer) clearInterval(pollTimer);
      });

    } catch (err) {
      content.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();

  return () => {
    cleanupFns.forEach(fn => fn());
  };
});
