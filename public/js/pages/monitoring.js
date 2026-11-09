// Unified Observability & Monitoring Dashboard (Grafana-like Native Charts & Metrics)
// Zero external libraries — pure HTML5 Canvas & SVG with smooth bezier curves and tooltips.

const MonitoringPage = {
  currentRange: 'live', // 'live' (rolling 15 minutes) or '48h' (DockGate's store)
  refreshInterval: 10000,
  refreshTimer: null,
  activeContainer: '',
  cachedData: null,

  async render(container, params = {}) {
    const activeServer = Store.get('activeServer') || { id: 'local', name: 'Local Daemon' };
    const serverId = activeServer.id || 'local';

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;max-width:1400px;margin:0 auto;">
        
        ${UI.header('Monitoring', 'Every server at a glance, then live host and container metrics for the server picked in the header. Open a server for its full graphs and alert policies.',
          `${UI.seg([['live', 'Live'], ['48h', 'Last 48 hours']], this.currentRange, 'data-range')}
           <select id="mon-refresh-sel" class="select" aria-label="Auto refresh" style="padding:4px 8px;font-size:12px;">
             <option value="5000">Refresh: 5s</option>
             <option value="10000" selected>Refresh: 10s</option>
             <option value="30000">Refresh: 30s</option>
             <option value="0">Refresh: off</option>
           </select>
           <button id="mon-refresh-btn" class="btn btn-secondary btn-sm" title="Refresh now">${Icons.refresh}</button>`)}

        <div id="mon-fleet"></div>
        <div class="ui-sub" id="mon-range-note" style="margin:-6px 0 -8px"></div>

        <div class="ui-ph" style="margin:6px 0 -6px"><div class="ui-ph-text"><div class="ui-ph-title">${escapeHtml(activeServer.name || activeServer.label || serverId)} <span id="mon-agent-badge" class="ui-pill ui-pill-off" style="margin-left:6px">connecting…</span></div><div class="ui-ph-desc">Metrics of the server picked in the header — live, or the last 48 hours, as chosen above.</div></div></div>

        <!-- Metric Stat Cards -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:14px;">
          <!-- CPU Card -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);position:relative;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px;font-weight:600;">
              <span>HOST CPU</span>
              <span id="mon-stat-cpu-sub">—</span>
            </div>
            <div id="mon-stat-cpu" style="font-size:26px;font-weight:800;margin:6px 0 2px;color:var(--text-primary);">0.0%</div>
            <div class="progress-bar" style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
              <div id="mon-stat-cpu-bar" style="width:0%;height:100%;background:#00d4aa;transition:width 0.3s;"></div>
            </div>
          </div>

          <!-- Memory Card -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);position:relative;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px;font-weight:600;">
              <span>HOST MEMORY</span>
              <span id="mon-stat-mem-sub">—</span>
            </div>
            <div id="mon-stat-mem" style="font-size:26px;font-weight:800;margin:6px 0 2px;color:var(--text-primary);">0.0%</div>
            <div class="progress-bar" style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
              <div id="mon-stat-mem-bar" style="width:0%;height:100%;background:#38bdf8;transition:width 0.3s;"></div>
            </div>
          </div>

          <!-- Disk Card -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);position:relative;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px;font-weight:600;">
              <span>DISK USAGE ( / )</span>
              <span id="mon-stat-disk-sub">—</span>
            </div>
            <div id="mon-stat-disk" style="font-size:26px;font-weight:800;margin:6px 0 2px;color:var(--text-primary);">0.0%</div>
            <div class="progress-bar" style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
              <div id="mon-stat-disk-bar" style="width:0%;height:100%;background:#f59e0b;transition:width 0.3s;"></div>
            </div>
          </div>

          <!-- Network Card -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);position:relative;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px;font-weight:600;">
              <span>NETWORK I/O</span>
              <span id="mon-stat-net-sub">RX / TX</span>
            </div>
            <div id="mon-stat-net" style="font-size:20px;font-weight:800;margin:8px 0 2px;color:var(--text-primary);">0 KB/s · 0 KB/s</div>
            <div style="font-size:11px;color:var(--text-muted);">Real-time bandwidth</div>
          </div>
        </div>

        <!-- Time Series Charts Grid -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(540px, 1fr));gap:16px;">
          
          <!-- Chart 1: CPU Utilization -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="font-weight:700;font-size:14px;">CPU (%)</div>
              <span class="text-xs text-muted" id="chart-cpu-legend">Host CPU</span>
            </div>
            <div style="height:220px;position:relative;">
              <canvas id="chart-cpu" style="width:100%;height:100%;"></canvas>
            </div>
          </div>

          <!-- Chart 2: Memory & Swap Usage -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="font-weight:700;font-size:14px;">Memory (%)</div>
              <span class="text-xs text-muted">RAM Utilization</span>
            </div>
            <div style="height:220px;position:relative;">
              <canvas id="chart-mem" style="width:100%;height:100%;"></canvas>
            </div>
          </div>

          <!-- Chart 3: Network Bandwidth -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="font-weight:700;font-size:14px;">Network (KB/s)</div>
              <span class="text-xs text-muted">Download (RX) vs Upload (TX)</span>
            </div>
            <div style="height:220px;position:relative;">
              <canvas id="chart-net" style="width:100%;height:100%;"></canvas>
            </div>
          </div>

          <!-- Chart 4: Per-Container CPU Breakdown -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="font-weight:700;font-size:14px;">🐳 Container CPU Distribution</div>
              <span class="text-xs text-muted">Top Active Containers</span>
            </div>
            <div style="height:220px;position:relative;">
              <canvas id="chart-containers" style="width:100%;height:100%;"></canvas>
            </div>
          </div>

        </div>

        <!-- Container Breakdown Table -->
        <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
            <div>
              <div style="font-weight:700;font-size:15px;">Containers</div>
              <div class="text-xs text-muted">Real-time resource breakdown per container</div>
            </div>
          </div>

          <div class="table-wrapper" style="overflow-x:auto;">
            <table class="table" style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="border-bottom:1px solid var(--border);text-align:left;color:var(--text-muted);font-size:12px;">
                  <th style="padding:8px 12px;">CONTAINER</th>
                  <th style="padding:8px 12px;">CPU %</th>
                  <th style="padding:8px 12px;">MEMORY USAGE</th>
                  <th style="padding:8px 12px;">MEM %</th>
                  <th style="padding:8px 12px;">ACTIONS</th>
                </tr>
              </thead>
              <tbody id="mon-containers-tbody">
                <tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted);">Loading containers…</td></tr>
              </tbody>
            </table>
          </div>
        </div>

      </div>
    `;

    // Event Listeners
    container.querySelectorAll('[data-range]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        container.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        this.currentRange = btn.dataset.range;
        this._clientHistory = null; // a new window starts empty
        this.fetchData(serverId);
      });
    });

    const refreshSel = container.querySelector('#mon-refresh-sel');
    refreshSel.addEventListener('change', () => {
      this.refreshInterval = parseInt(refreshSel.value, 10);
      this.resetTimer(serverId);
    });

    container.querySelector('#mon-refresh-btn').addEventListener('click', () => {
      this.fetchFleet();
      this.fetchData(serverId);
    });

    // Initial Fetch & Timer
    this.fetchFleet();
    this.fetchData(serverId);
    this.resetTimer(serverId);

    return () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    };
  },

  // All servers in one table: state, CPU / memory sparklines, disk bar. Data: /servers + /servers/overview.
  async fetchFleet() {
    const el = document.getElementById('mon-fleet');
    if (!el) return;
    try {
      const [list, ov] = await Promise.all([API.get('/servers'), API.get('/servers/overview?history=40')]);
      if (!document.getElementById('mon-fleet')) return;
      const servers = list.servers || [];
      const spark = (vals, color) => {
        const v = vals.filter(x => x != null);
        if (v.length < 2) return '<span class="text-muted text-xs">not enough data yet</span>';
        const w = 120, h = 28, step = w / (v.length - 1);
        const pts = v.map((x, i) => `${(i * step).toFixed(1)},${(h - 2 - Math.min(100, Math.max(0, x)) / 100 * (h - 4)).toFixed(1)}`);
        const lastY = pts[pts.length - 1].split(',')[1];
        return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="display:block"><polyline points="0,${h} ${pts.join(' ')} ${w},${h}" fill="${color}" fill-opacity=".14" stroke="none"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/><circle cx="${w}" cy="${lastY}" r="2.4" fill="${color}"/></svg>`;
      };
      const pct = (x) => x == null ? '—' : `${Math.round(x)}%`;
      const rows = servers.map(s => {
        const o = (ov.servers || {})[s.id] || {}, last = o.lastStat, series = o.series || [];
        const ageMin = last && last.ts ? (Date.now() - new Date(String(last.ts).replace(' ', 'T') + (String(last.ts).includes('Z') ? '' : 'Z')).getTime()) / 60000 : null;
        if (!last) return { cells: [
          `<b>${escapeHtml(s.name || s.id)}</b><div class="ui-sub">${s.id === 'local' ? 'this machine' : escapeHtml(s.host || '')}</div>`,
          s.id === 'local' ? UI.pill('info', 'live below') : UI.pill('off', 'no data yet'),
          `<span class="text-muted text-xs" style="grid-column:span 3">${s.id === 'local' ? 'DockGate shows this machine live below; it keeps no history for it.' : 'No metrics recorded yet. They appear after DockGate or the edge agent has polled this server.'}</span>`, '', '',
          s.id === 'local' ? '' : UI.btn('Open', `data-mon-open="${escapeHtml(s.id)}"`),
        ] };
        const state = !last ? UI.pill('off', 'no data yet') : ageMin != null && ageMin > 10 ? UI.pill('warn', `last seen ${Math.round(ageMin)} min ago`) : UI.pill('ok', 'reporting');
        const diskCls = last && last.disk >= 90 ? 'red' : last && last.disk >= 80 ? 'yellow' : 'green';
        const name = escapeHtml(s.name || s.id);
        return { cells: [
          `<b>${name}</b><div class="ui-sub">${s.id === 'local' ? 'this machine' : escapeHtml(s.host || '')}</div>`,
          state,
          `${spark(series.map(x => x.cpu), '#3b82f6')}<span class="ui-sub">${pct(last && last.cpu)}</span>`,
          `${spark(series.map(x => x.mem), '#a78bfa')}<span class="ui-sub">${pct(last && last.mem)}</span>`,
          last && last.disk != null ? `<div class="disk-bar" style="height:6px;margin:0;width:120px"><div class="disk-bar-fill ${diskCls}" style="width:${Math.min(100, last.disk)}%"></div></div><span class="ui-sub">${pct(last.disk)}</span>` : '<span class="text-muted">—</span>',
          s.id === 'local' ? '' : UI.btn('Open', `data-mon-open="${escapeHtml(s.id)}"`),
        ] };
      });
      el.innerHTML = UI.table([{ label: 'Server' }, { label: 'State' }, { label: 'CPU · last 40 min' }, { label: 'Memory · last 40 min' }, { label: 'Disk' }, { label: '', align: 'right' }], rows, { empty: 'No servers yet.', minWidth: 760 });
      el.querySelectorAll('[data-mon-open]').forEach(b => b.addEventListener('click', () => Router.navigate('server-console', { id: b.dataset.monOpen, tab: 'monitoring' })));
    } catch (e) {
      el.innerHTML = UI.errorState(e, { compact: true, title: 'The server list could not be loaded' });
    }
  },

  resetTimer(serverId) {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.refreshInterval > 0) {
      this.refreshTimer = setInterval(() => { this.fetchData(serverId); this.fetchFleet(); }, this.refreshInterval);
    }
  },

  async fetchData(serverId) {
    try {
      const [metrics, summary] = await Promise.all([
        API.get(`/monitoring/${serverId}/metrics?range=${this.currentRange}${this.activeContainer ? `&container=${encodeURIComponent(this.activeContainer)}` : ''}`),
        API.get(`/monitoring/${serverId}/summary`).catch(() => null)
      ]);

      // Live without the agent: one sample per refresh → keep a rolling 15-minute window here (host + containers).
      if (this.currentRange === 'live' && metrics.count === 1 && metrics.timestamps && metrics.timestamps.length === 1 && metrics.host && metrics.host.cpu) {
        if (!this._clientHistory) this._clientHistory = { timestamps: [], cpu: [], mem: [], netRx: [], netTx: [], containers: {} };
        const h = this._clientHistory;
        h.timestamps.push(metrics.timestamps[0]);
        h.cpu.push(metrics.host.cpu[0]);
        h.mem.push(metrics.host.memPercent[0]);
        h.netRx.push(metrics.host.netRxBytesSec[0]);
        h.netTx.push(metrics.host.netTxBytesSec[0]);
        for (const [name, c] of Object.entries(metrics.latestContainers || {})) (h.containers[name] = h.containers[name] || []).push({ t: metrics.timestamps[0], cpuPercent: c.cpuPercent || 0 });
        const cutoff = Date.now() - 15 * 60 * 1000;
        while (h.timestamps.length && h.timestamps[0] < cutoff) { h.timestamps.shift(); h.cpu.shift(); h.mem.shift(); h.netRx.shift(); h.netTx.shift(); }
        for (const name of Object.keys(h.containers)) { h.containers[name] = h.containers[name].filter(p => p.t >= cutoff); if (!h.containers[name].length) delete h.containers[name]; }
        metrics.timestamps = [...h.timestamps];
        metrics.host.cpu = [...h.cpu];
        metrics.host.memPercent = [...h.mem];
        metrics.host.netRxBytesSec = [...h.netRx];
        metrics.host.netTxBytesSec = [...h.netTx];
        metrics.containers = Object.fromEntries(Object.entries(h.containers).map(([k, v]) => [k, v.map(p => ({ cpuPercent: p.cpuPercent }))]));
      }

      if (summary && summary.breakdown) {
        metrics.breakdown = summary.breakdown;
      }

      this.cachedData = metrics;
      this.updateUI(metrics);
    } catch (err) {
      console.warn('[monitoring] fetch error:', err.message);
    }
  },

  updateUI(data) {
    const note = document.getElementById('mon-range-note');
    if (note) {
      if (data.range === '48h') {
        const hrs = data.storedSince ? (Date.now() - data.storedSince) / 3600000 : 0;
        note.textContent = data.storedSince ? `Last 48 hours from DockGate's own store: 5-minute averages of one sample a minute${hrs < 47 ? ` · stored since ${new Date(data.storedSince).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} (${hrs < 1 ? Math.max(1, Math.round(hrs * 60)) + ' min' : Math.round(hrs) + ' h'})` : ''}. Kept across reboots.` : 'No stored samples yet — DockGate stores one a minute and keeps 48 hours.';
      } else note.textContent = `Live · the last 15 minutes${data.source === 'agent' ? ' from the edge agent' : ', read by DockGate on each refresh'}.`;
    }
    const badge = document.getElementById('mon-agent-badge');
    if (badge) {
      const agent = data.source === 'agent';
      badge.className = `ui-pill ui-pill-${agent ? 'ok' : 'info'}`;
      badge.textContent = agent ? 'edge agent · live' : 'polled by DockGate';
      badge.title = agent ? 'Metrics come from the edge agent on the server.' : 'DockGate reads these metrics over SSH (or the local socket) every few seconds.';
    }

    const host = data.host || {};
    const latest = host.latest || {};

    // 1. Update Cards
    const cpuVal = latest.cpu ?? (host.cpu && host.cpu.length ? host.cpu[host.cpu.length - 1] : 0);
    const memVal = latest.memPercent ?? (host.memPercent && host.memPercent.length ? host.memPercent[host.memPercent.length - 1] : 0);
    const diskVal = latest.diskPercent ?? (host.diskPercent && host.diskPercent.length ? host.diskPercent[host.diskPercent.length - 1] : 0);
    const netRx = latest.netRxBytesSec ?? (host.netRxBytesSec && host.netRxBytesSec.length ? host.netRxBytesSec[host.netRxBytesSec.length - 1] : 0);
    const netTx = latest.netTxBytesSec ?? (host.netTxBytesSec && host.netTxBytesSec.length ? host.netTxBytesSec[host.netTxBytesSec.length - 1] : 0);

    const elCpu = document.getElementById('mon-stat-cpu');
    const elCpuBar = document.getElementById('mon-stat-cpu-bar');
    if (elCpu) elCpu.textContent = `${cpuVal.toFixed(1)}%`;
    if (elCpuBar) elCpuBar.style.width = `${Math.min(100, cpuVal)}%`;

    const elMem = document.getElementById('mon-stat-mem');
    const elMemBar = document.getElementById('mon-stat-mem-bar');
    if (elMem) elMem.textContent = `${memVal.toFixed(1)}%`;
    if (elMemBar) elMemBar.style.width = `${Math.min(100, memVal)}%`;

    const elDisk = document.getElementById('mon-stat-disk');
    const elDiskBar = document.getElementById('mon-stat-disk-bar');
    if (elDisk) elDisk.textContent = `${diskVal.toFixed(1)}%`;
    if (elDiskBar) elDiskBar.style.width = `${Math.min(100, diskVal)}%`;

    const elNet = document.getElementById('mon-stat-net');
    if (elNet) elNet.textContent = `↓ ${(netRx / 1024).toFixed(1)} KB/s · ↑ ${(netTx / 1024).toFixed(1)} KB/s`;

    // 2. Render Canvas Charts
    const timestamps = data.timestamps || [];
    this.drawChart('chart-cpu', timestamps, [{ label: 'CPU %', data: host.cpu || [], color: '#00d4aa' }], '%');
    this.drawChart('chart-mem', timestamps, [{ label: 'Memory %', data: host.memPercent || [], color: '#38bdf8' }], '%');
    this.drawChart('chart-net', timestamps, [
      { label: 'RX KB/s', data: (host.netRxBytesSec || []).map(v => (v / 1024)), color: '#10b981' },
      { label: 'TX KB/s', data: (host.netTxBytesSec || []).map(v => (v / 1024)), color: '#f43f5e' },
    ], ' KB/s');

    // Container multi-line chart
    const containerLines = [];
    const colors = ['#a855f7', '#ec4899', '#3b82f6', '#14b8a6', '#f59e0b', '#84cc16'];
    let cIndex = 0;
    for (const [cName, cPoints] of Object.entries(data.containers || {})) {
      containerLines.push({
        label: cName,
        // points [{cpuPercent}] (DockGate) or { cpu: [...] } (Edge agent)
        data: Array.isArray(cPoints) ? cPoints.map(p => p.cpuPercent || 0) : ((cPoints && cPoints.cpu) || []),
        color: colors[cIndex % colors.length],
      });
      cIndex++;
    }
    this.drawChart('chart-containers', timestamps, containerLines, '%', data.range === '48h' ? 'Container graphs are live only — switch to Live.' : null);

    // 3. Render Containers Table
    const tbody = document.getElementById('mon-containers-tbody');
    if (tbody) {
      const items = data.breakdown || (data.latestContainers ? Object.entries(data.latestContainers).map(([name, s]) => ({ name, ...s })) : []);

      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted);">No running containers detected</td></tr>`;
      } else {
        tbody.innerHTML = items.map((c) => {
          const name = c.name || c.id || 'container';
          const cpuP = c.cpuPercent ?? 0;
          const memMb = c.memUsageBytes ? (c.memUsageBytes / (1024 * 1024)).toFixed(1) : (c.memMb ? c.memMb : '—');
          const memP = c.memPercent ?? 0;

          return `
            <tr style="border-bottom:1px solid var(--border);font-size:13px;">
              <td style="padding:10px 12px;font-weight:600;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;margin-right:6px;"></span>
                ${escapeHtml(name)}
              </td>
              <td style="padding:10px 12px;font-family:var(--font-mono);font-weight:600;color:${cpuP > 50 ? '#ef4444' : '#00d4aa'};">
                ${typeof cpuP === 'number' ? cpuP.toFixed(1) + '%' : cpuP}
              </td>
              <td style="padding:10px 12px;font-family:var(--font-mono);">${memMb} MB</td>
              <td style="padding:10px 12px;font-family:var(--font-mono);">${typeof memP === 'number' ? memP.toFixed(1) + '%' : memP}</td>
              <td style="padding:10px 12px;">
                <button class="btn btn-secondary btn-sm" onclick="Router.navigate('observe', { tab: 'logs', container: '${escapeHtml(name)}' })" style="padding:2px 8px;font-size:11px;">
                  📜 Logs
                </button>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  },

  // High-performance smooth Canvas Chart Renderer
  drawChart(canvasId, timestamps, seriesList, unit = '', emptyText = null) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padX = 40;
    const padY = 25;

    ctx.clearRect(0, 0, w, h);

    if (!seriesList || seriesList.length === 0 || timestamps.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(emptyText || (this.currentRange === '48h' ? 'No stored samples yet — DockGate stores one a minute.' : 'Collecting live samples…'), w / 2, h / 2);
      return;
    }

    // Determine max Y
    let maxY = 10;
    seriesList.forEach(s => {
      s.data.forEach(val => { if (val > maxY) maxY = val; });
    });
    maxY = Math.ceil(maxY * 1.15); // Add headroom

    // Draw Grid Lines & Y Axis
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yVal = (maxY / ySteps) * i;
      const yPos = h - padY - ((yVal / maxY) * (h - padY * 2));
      ctx.beginPath();
      ctx.moveTo(padX, yPos);
      ctx.lineTo(w - 10, yPos);
      ctx.stroke();
      ctx.fillText(`${Math.round(yVal)}${unit}`, padX - 6, yPos + 3);
    }

    // Draw Lines for each series
    const plotW = w - padX - 10;
    const plotH = h - padY * 2;
    const numPoints = timestamps.length;

    seriesList.forEach(s => {
      if (!s.data || s.data.length === 0) return;

      ctx.strokeStyle = s.color || '#00d4aa';
      ctx.lineWidth = 2;
      ctx.beginPath();

      s.data.forEach((val, idx) => {
        const x = padX + (idx / (numPoints - 1)) * plotW;
        const y = h - padY - (Math.min(val, maxY) / maxY) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Area gradient
      ctx.lineTo(padX + plotW, h - padY);
      ctx.lineTo(padX, h - padY);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padY, 0, h - padY);
      grad.addColorStop(0, `${s.color}22`);
      grad.addColorStop(1, `${s.color}00`);
      ctx.fillStyle = grad;
      ctx.fill();
    });

    // Draw X Time Labels (first and last)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    const longSpan = timestamps[timestamps.length - 1] - timestamps[0] > 20 * 3600000;
    const fmtT = (t) => new Date(t).toLocaleString([], { hour: '2-digit', minute: '2-digit', ...(longSpan ? { day: '2-digit', month: 'short' } : {}) });
    const firstTime = fmtT(timestamps[0]);
    const lastTime = fmtT(timestamps[timestamps.length - 1]);
    ctx.fillText(firstTime, padX, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(lastTime, w - 10, h - 6);
  }
};

window.MonitoringPage = MonitoringPage;
Router.register('monitoring', (content, params) => MonitoringPage.render(content, params));
