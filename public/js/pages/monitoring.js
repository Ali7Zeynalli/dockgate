// Unified Observability & Monitoring Dashboard (Grafana-like Native Charts & Metrics)
// Zero external libraries — pure HTML5 Canvas & SVG with smooth bezier curves and tooltips.

const MonitoringPage = {
  currentRange: '1h',
  refreshInterval: 10000,
  refreshTimer: null,
  activeContainer: '',
  cachedData: null,

  async render(container, params = {}) {
    const activeServer = Store.get('activeServer') || { id: 'local', name: 'Local Daemon' };
    const serverId = activeServer.id || 'local';

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;max-width:1400px;margin:0 auto;">
        
        <!-- Header Toolbar -->
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:12px 16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:18px;">📊</span>
              <span style="font-weight:700;font-size:15px;">Monitoring &amp; Observability</span>
            </div>
            <span id="mon-agent-badge" class="badge" style="background:var(--accent-dim);color:var(--accent);font-size:11px;padding:2px 8px;">Connecting…</span>
          </div>

          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <!-- Range Selector -->
            <div class="segmented-control" style="display:flex;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px;">
              <button type="button" class="btn btn-sm ${this.currentRange === '1h' ? 'btn-primary' : 'btn-ghost'}" data-range="1h" style="padding:3px 10px;font-size:12px;">1h</button>
              <button type="button" class="btn btn-sm ${this.currentRange === '6h' ? 'btn-primary' : 'btn-ghost'}" data-range="6h" style="padding:3px 10px;font-size:12px;">6h</button>
              <button type="button" class="btn btn-sm ${this.currentRange === '24h' ? 'btn-primary' : 'btn-ghost'}" data-range="24h" style="padding:3px 10px;font-size:12px;">24h</button>
              <button type="button" class="btn btn-sm ${this.currentRange === '7d' ? 'btn-primary' : 'btn-ghost'}" data-range="7d" style="padding:3px 10px;font-size:12px;">7d</button>
            </div>

            <!-- Auto-Refresh Selector -->
            <select id="mon-refresh-sel" class="select" style="padding:4px 8px;font-size:12px;background:var(--bg-primary);">
              <option value="5000">Auto: 5s</option>
              <option value="10000" selected>Auto: 10s</option>
              <option value="30000">Auto: 30s</option>
              <option value="0">Off</option>
            </select>

            <button id="mon-refresh-btn" class="btn btn-secondary btn-sm" title="Refresh now" style="padding:4px 10px;">🔄</button>
          </div>
        </div>

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
              <div style="font-weight:700;font-size:14px;">📈 CPU Utilization History (%)</div>
              <span class="text-xs text-muted" id="chart-cpu-legend">Host CPU</span>
            </div>
            <div style="height:220px;position:relative;">
              <canvas id="chart-cpu" style="width:100%;height:100%;"></canvas>
            </div>
          </div>

          <!-- Chart 2: Memory & Swap Usage -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="font-weight:700;font-size:14px;">🧠 Memory Allocation History (%)</div>
              <span class="text-xs text-muted">RAM Utilization</span>
            </div>
            <div style="height:220px;position:relative;">
              <canvas id="chart-mem" style="width:100%;height:100%;"></canvas>
            </div>
          </div>

          <!-- Chart 3: Network Bandwidth -->
          <div class="card" style="padding:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div style="font-weight:700;font-size:14px;">🌐 Network Throughput (KB/s)</div>
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
              <div style="font-weight:700;font-size:15px;">📦 Container Resource Matrix</div>
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
        container.querySelectorAll('[data-range]').forEach(b => { b.className = 'btn btn-sm btn-ghost'; });
        btn.className = 'btn btn-sm btn-primary';
        this.currentRange = btn.dataset.range;
        this.fetchData(serverId);
      });
    });

    const refreshSel = container.querySelector('#mon-refresh-sel');
    refreshSel.addEventListener('change', () => {
      this.refreshInterval = parseInt(refreshSel.value, 10);
      this.resetTimer(serverId);
    });

    container.querySelector('#mon-refresh-btn').addEventListener('click', () => {
      this.fetchData(serverId);
    });

    // Initial Fetch & Timer
    this.fetchData(serverId);
    this.resetTimer(serverId);

    return () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    };
  },

  resetTimer(serverId) {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.refreshInterval > 0) {
      this.refreshTimer = setInterval(() => this.fetchData(serverId), this.refreshInterval);
    }
  },

  async fetchData(serverId) {
    try {
      const [metrics, summary] = await Promise.all([
        API.get(`/monitoring/${serverId}/metrics?range=${this.currentRange}${this.activeContainer ? `&container=${encodeURIComponent(this.activeContainer)}` : ''}`),
        API.get(`/monitoring/${serverId}/summary`).catch(() => null)
      ]);

      // If polling mode with 1 sample, accumulate client-side history so chart draws live graphs!
      if (metrics.count === 1 && metrics.timestamps && metrics.timestamps.length === 1 && metrics.host && metrics.host.cpu) {
        if (!this._clientHistory) this._clientHistory = { timestamps: [], cpu: [], mem: [], netRx: [], netTx: [] };
        const h = this._clientHistory;
        h.timestamps.push(metrics.timestamps[0]);
        h.cpu.push(metrics.host.cpu[0]);
        h.mem.push(metrics.host.memPercent[0]);
        h.netRx.push(metrics.host.netRxBytesSec[0]);
        h.netTx.push(metrics.host.netTxBytesSec[0]);
        if (h.timestamps.length > 60) {
          h.timestamps.shift();
          h.cpu.shift();
          h.mem.shift();
          h.netRx.shift();
          h.netTx.shift();
        }
        metrics.timestamps = [...h.timestamps];
        metrics.host.cpu = [...h.cpu];
        metrics.host.memPercent = [...h.mem];
        metrics.host.netRxBytesSec = [...h.netRx];
        metrics.host.netTxBytesSec = [...h.netTx];
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
    const badge = document.getElementById('mon-agent-badge');
    if (badge) {
      if (data.source === 'agent') {
        badge.innerHTML = '🟢 Agent Live (All-in-One)';
        badge.style.background = 'var(--accent-dim)';
        badge.style.color = 'var(--accent)';
      } else {
        badge.innerHTML = '🟡 Host Live (Polling)';
        badge.style.background = 'rgba(245, 158, 11, 0.15)';
        badge.style.color = '#f59e0b';
      }
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
        data: (cPoints || []).map(p => p.cpuPercent || 0),
        color: colors[cIndex % colors.length],
      });
      cIndex++;
    }
    this.drawChart('chart-containers', timestamps, containerLines, '%');

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
                <button class="btn btn-secondary btn-sm" onclick="Router.navigate('activity', { tab: 'logs', container: '${escapeHtml(name)}' })" style="padding:2px 8px;font-size:11px;">
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
  drawChart(canvasId, timestamps, seriesList, unit = '') {
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
      ctx.fillText('Collecting time-series data points…', w / 2, h / 2);
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
    const firstTime = new Date(timestamps[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const lastTime = new Date(timestamps[timestamps.length - 1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(firstTime, padX, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(lastTime, w - 10, h - 6);
  }
};

window.MonitoringPage = MonitoringPage;
Router.register('monitoring', (content, params) => MonitoringPage.render(content, params));
