// Observe → Logs: one container live, all containers at once, the server's own logs, Log Doctor.
// The first three use the shared LogViewer (public/js/log-viewer.js): search, levels, histogram, up to 10,000 lines.

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
      
      ${UI.header('Logs', 'Follow one container live, search every container at once, read the server\'s own logs, or let Log Doctor point out errors.',
        `<span class="ui-seg" id="logs-mode-nav">${[['stream', 'Container'], ['search', 'All containers'], ['swarm', 'Swarm service'], ['host', 'Host logs'], ['doctor', 'Log Doctor']].map(([m, l]) => `<button type="button" data-mode="${m}" aria-pressed="${currentMode === m}">${l}</button>`).join('')}</span>`)}

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

    modeNav.querySelectorAll('button').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode)));

    if (mode === 'stream') await renderContainerStreamView();
    else if (mode === 'host') await renderHostLogsView();
    else if (mode === 'doctor') await renderLogDoctorView();
    else if (mode === 'search') await renderCrossContainerSearchView();
    else if (mode === 'swarm') await renderSwarmServiceView();
  }

  // Swarm service: docker service logs of every task of one service (all servers), source = task @ server.
  // The button is shown only while Swarm is active on the server in use.
  API.get('/swarm/status').then(st => { if (!(st && st.state === 'active' && st.manager)) modeNav.querySelector('[data-mode="swarm"]')?.remove(); }).catch(() => modeNav.querySelector('[data-mode="swarm"]')?.remove());
  async function renderSwarmServiceView() {
    if (window._activeLogStreamTeardown) { window._activeLogStreamTeardown(); window._activeLogStreamTeardown = null; }
    let services = [];
    try { services = (await API.get('/swarm/services')).services; } catch (e) { viewRoot.innerHTML = UI.errorState(e, { compact: true }); return; }
    if (!Router.isActiveNav(pageNavId) || currentMode !== 'swarm') return;
    const pre = services.find(x => x.name === params.service || x.id === params.service);
    const tools = `<select class="select" data-svc aria-label="Service" style="max-width:260px"><option value="">Choose a service…</option>${services.map(x => `<option value="${escapeHtml(x.id)}" ${pre && pre.id === x.id ? 'selected' : ''}>${escapeHtml(x.name)} (${x.running}/${x.desired})</option>`).join('')}</select>`;
    viewRoot.innerHTML = '<div data-lvroot></div>';
    let sel;
    LogViewer.mount(viewRoot.querySelector('[data-lvroot]'), {
      key: 'swarm-service', fileName: 'swarm-service', tools, live: true, poll: 5000, liveDefault: false,
      retention: 'Docker keeps these logs on each server (the service\'s log driver limits)', empty: 'Choose a service to read the logs of all its tasks.',
      onTools(el, v) { sel = el.querySelector('[data-svc]'); sel.addEventListener('change', () => v.reload()); },
      load: async (limit) => { if (!sel || !sel.value) return { rows: [] }; const r = await API.get(`/swarm/services/${sel.value}/logs?tail=${limit}`); return { rows: r.rows }; },
    });
  }

  modeNav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) switchMode(btn.dataset.mode);
  });

  // =========================================================================
  // 1. One container, live (socket), in the shared LogViewer
  // =========================================================================
  async function renderContainerStreamView() {
    if (window._activeLogStreamTeardown) { window._activeLogStreamTeardown(); window._activeLogStreamTeardown = null; }
    const containers = await API.get('/containers').catch(() => []);
    if (!Router.isActiveNav(pageNavId) || currentMode !== 'stream') return;
    const sorted = [...containers].sort((a, b) => (b.state === 'running') - (a.state === 'running') || String(a.name).localeCompare(String(b.name)));
    const pre = sorted.find(c => preselectContainer && (c.name === preselectContainer || c.id === preselectContainer || c.id.startsWith(preselectContainer)));
    const tools = `<select class="select" data-cid aria-label="Container" style="max-width:240px">
        <option value="">Choose a container…</option>
        ${sorted.map(c => `<option value="${escapeHtml(c.id)}" ${pre && pre.id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}${c.state === 'running' ? '' : ` (${escapeHtml(c.state)})`}</option>`).join('')}
      </select>
      <select class="select" data-period aria-label="Read from Docker" title="Which part of the container's log to read from Docker">
        <option value="">Newest lines</option><option value="900">Last 15 min</option><option value="3600">Last hour</option><option value="86400">Last 24 h</option><option value="604800">Last 7 days</option>
      </select>`;
    viewRoot.innerHTML = '<div data-lvroot></div>';
    let cid = '', partial = '', cidSel, periodSel;
    const viewer = LogViewer.mount(viewRoot.querySelector('[data-lvroot]'), {
      key: 'container-stream', fileName: 'container', tools, live: true, format: 'docker', showTime: appSetting('logTimestamps', 'false') === 'true',
      retention: 'Docker keeps this log (its log driver limits)',
      empty: 'Choose a container to follow its log.',
      onTools(el) {
        cidSel = el.querySelector('[data-cid]'); periodSel = el.querySelector('[data-period]');
        cidSel.addEventListener('change', () => subscribe());
        periodSel.addEventListener('change', () => subscribe());
      },
      onLimit: () => subscribe(),
    });
    function subscribe() {
      cid = cidSel.value; partial = '';
      viewer.clear();
      if (!cid) { socket.emit('logs:unsubscribe'); return; }
      const p = Number(periodSel.value) || 0;
      socket.emit('logs:subscribe', { containerId: cid, tail: viewer.limit, timestamps: true, since: p ? Math.floor(Date.now() / 1000) - p : undefined });
    }
    window._activeResub = () => { if (cid) subscribe(); };
    const mine = (id) => cid && (!id || cid.startsWith(id) || id.startsWith(cid));
    const onLogData = ({ containerId, data }) => {
      if (!mine(containerId) || typeof data !== 'string') return;
      const text = partial + data; const cut = text.lastIndexOf('\n'); // keep a half-received line for the next chunk
      if (cut < 0) { partial = text; return; }
      partial = text.slice(cut + 1);
      viewer.push(text.slice(0, cut));
    };
    const onLogEnd = ({ containerId }) => { if (mine(containerId)) { if (partial) { viewer.push(partial); partial = ''; } viewer.notice('The container stopped writing (stream ended).', 'W'); } };
    const onLogError = ({ containerId, error }) => { if (mine(containerId)) viewer.notice(`Error: ${error}`, 'E'); };
    socket.on('logs:data', onLogData); socket.on('logs:end', onLogEnd); socket.on('logs:error', onLogError);
    if (cidSel.value) subscribe();
    const teardown = () => {
      if (cid) socket.emit('logs:unsubscribe');
      cid = '';
      socket.off('logs:data', onLogData); socket.off('logs:end', onLogEnd); socket.off('logs:error', onLogError);
      window._activeResub = null; viewer.destroy();
    };
    window._activeLogStreamTeardown = teardown;
    cleanupFns.push(teardown);
  }

  // =========================================================================
  // 2. Host logs: the same view as Server Console → Logs (one implementation)
  // =========================================================================
  async function renderHostLogsView() {
    if (window._activeLogStreamTeardown) { window._activeLogStreamTeardown(); window._activeLogStreamTeardown = null; }
    const link = serverId !== 'local' ? ` · the same view as <a href="#" data-console>Server Console → Logs</a>` : '';
    viewRoot.innerHTML = `<p class="ui-sub" style="margin:0 0 8px">${escapeHtml(activeServer.name || serverId)}${link}</p><div data-hlroot></div>`;
    viewRoot.querySelector('[data-console]')?.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('server-console', { id: serverId, tab: 'logs' }); });
    renderHostLogs(serverId, viewRoot.querySelector('[data-hlroot]'), { header: false });
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
  // 4. All containers at once (Edge agent store, else Docker), in the shared LogViewer
  // =========================================================================
  async function renderCrossContainerSearchView() {
    if (window._activeLogStreamTeardown) { window._activeLogStreamTeardown(); window._activeLogStreamTeardown = null; }
    viewRoot.innerHTML = '<div data-lvroot></div>';
    const levelOf = { error: 'E', warn: 'W', info: 'I', debug: 'D' };
    let from = '';
    const viewer = LogViewer.mount(viewRoot.querySelector('[data-lvroot]'), {
      key: 'all-containers', fileName: 'all-containers', poll: 10000, liveDefault: false,
      retention: 'Edge agent keeps the newest 10,000 lines; without it, read from Docker',
      empty: 'No container log lines.',
      async load(limit) {
        const res = await API.get(`/monitoring/${serverId}/logs?limit=${limit}`);
        from = res.source === 'agent' ? 'Edge agent' : 'Docker';
        return { rows: (res.logs || []).map(l => ({ t: l.timestamp ? new Date(l.timestamp).getTime() : null, l: levelOf[l.level] || undefined, src: l.containerName || l.source || '', msg: l.message || '', meta: { From: from, Stream: l.stream } })) };
      },
    });
    cleanupFns.push(() => viewer.destroy());
  }

  // Initial load
  await switchMode(currentMode);

  return () => {
    cleanupFns.forEach(fn => { try { fn(); } catch(e){} });
  };
});
