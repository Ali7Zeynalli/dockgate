// Host monitoring dashboard — live CPU / RAM / disk / swap / load / network / uptime / open ports / top
// processes for a remote server. Built with the same design-system primitives as the main Dashboard
// (summary-grid · summary-card · card · grid-2 · disk-bar · detail-grid) so the console matches the app.
// Polls GET /api/servers/:id/host/stats every 5s; stops when the container leaves the DOM (tab/navigation).
// Global: renderHostMonitoring(serverId, container).
function renderHostMonitoring(serverId, container) {
  container.innerHTML = `
    <div class="flex justify-between items-center mb-2">
      <div style="font-size:15px;font-weight:700">Host Metrics</div>
      <span class="badge badge-restarting" id="hm-status"><span class="badge-dot"></span> connecting…</span>
    </div>
    <div id="hm-body">
      <div class="summary-grid">${Array(6).fill('<div class="summary-card"><div class="skeleton" style="width:100%;height:42px"></div></div>').join('')}</div>
    </div>`;
  const statusEl = container.querySelector('#hm-status');
  const body = container.querySelector('#hm-body');
  let timer = null, first = true;

  // Colour helpers — shared 70 / 90 thresholds, mapped onto the design-system colour classes.
  const barClass = (p) => p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green';
  const iconClass = (p) => p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green';
  const clamp = (p) => Math.min(100, Math.max(0, p || 0));

  // KPI tile — identical markup to the Dashboard's summary-card.
  const kpi = (icon, color, value, label) => `
    <div class="summary-card">
      <div class="summary-card-icon ${color}"><span class="nav-item-icon">${icon}</span></div>
      <div class="summary-card-content">
        <div class="summary-card-value">${value}</div>
        <div class="summary-card-label">${label}</div>
      </div>
    </div>`;

  // Usage bar — same pattern as the Dashboard's "Disk Usage" card.
  const bar = (label, pct, sub, cls) => `
    <div style="margin-bottom:12px">
      <div class="flex justify-between items-center text-sm mb-1"><span>${label}</span><span class="text-muted">${sub}</span></div>
      <div class="disk-bar"><div class="disk-bar-fill ${cls || barClass(pct)}" style="width:${clamp(pct)}%"></div></div>
    </div>`;

  const render = (s) => {
    const memPct = s.mem.total ? Math.round(s.mem.used / s.mem.total * 100) : 0;
    const swapPct = s.mem.swapTotal ? Math.round(s.mem.swapUsed / s.mem.swapTotal * 100) : 0;
    const rootDisk = (s.disks || []).find(d => d.mount === '/') || (s.disks || [])[0] || { usePct: 0, used: 0, size: 0, mount: '/' };
    const upD = Math.floor((s.uptime || 0) / 86400), upH = Math.floor(((s.uptime || 0) % 86400) / 3600);
    const upStr = upD > 0 ? `${upD}d ${upH}h` : `${upH}h`;
    const net = s.net || { rxBytesSec: 0, txBytesSec: 0 };
    const load = s.load || { load1: 0, load5: 0, load15: 0, procsRunning: 0, procsTotal: 0 };
    const memCls = memPct >= 90 ? 'red' : memPct >= 70 ? 'yellow' : 'blue';

    body.innerHTML = `
      <!-- KPI tiles -->
      <div class="summary-grid">
        ${kpi(Icons.system, iconClass(s.cpu), `${s.cpu != null ? s.cpu : '—'}%`, 'CPU')}
        ${kpi(Icons.layers, memPct >= 70 ? iconClass(memPct) : 'blue', `${memPct}%`, 'Memory')}
        ${kpi(Icons.volume, iconClass(rootDisk.usePct), `${rootDisk.usePct}%`, 'Disk /')}
        ${s.mem.swapTotal
          ? kpi(Icons.refresh, iconClass(swapPct), `${swapPct}%`, 'Swap')
          : kpi(Icons.container, 'purple', `${load.procsRunning}`, 'Running')}
        ${kpi(Icons.events, 'teal', upStr, 'Uptime')}
        ${kpi(Icons.dashboard, 'blue', `${load.load1}`, 'Load 1m')}
      </div>

      <!-- Resource usage bars + system detail -->
      <div class="grid-2 mb-3">
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:16px">Resource Usage</div>
          ${bar('CPU', s.cpu, `${s.cpu != null ? s.cpu : '—'}%`)}
          ${bar('Memory', memPct, `${formatBytes(s.mem.used)} / ${formatBytes(s.mem.total)}`, memCls)}
          ${bar('Disk (/)', rootDisk.usePct, `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.size)}`)}
          ${s.mem.swapTotal ? bar('Swap', swapPct, `${formatBytes(s.mem.swapUsed)} / ${formatBytes(s.mem.swapTotal)}`) : ''}
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <div class="text-xs text-muted" style="margin-bottom:8px;font-weight:600">NETWORK I/O</div>
            <div class="flex gap-2 text-sm">
              <span><span style="color:var(--success)">↓</span> ${formatBytes(net.rxBytesSec)}/s</span>
              <span><span style="color:var(--accent)">↑</span> ${formatBytes(net.txBytesSec)}/s</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:12px">System</div>
          <div class="detail-grid" style="grid-template-columns:1fr 1fr">
            <div class="detail-item"><div class="detail-label">Load avg (1·5·15)</div><div class="detail-value">${load.load1} · ${load.load5} · ${load.load15}</div></div>
            <div class="detail-item"><div class="detail-label">Processes</div><div class="detail-value">${load.procsRunning} running / ${load.procsTotal} total</div></div>
            <div class="detail-item"><div class="detail-label">Network ↓</div><div class="detail-value">${formatBytes(net.rxBytesSec)}/s</div></div>
            <div class="detail-item"><div class="detail-label">Network ↑</div><div class="detail-value">${formatBytes(net.txBytesSec)}/s</div></div>
            <div class="detail-item"><div class="detail-label">Uptime</div><div class="detail-value">${upStr}</div></div>
            <div class="detail-item"><div class="detail-label">Open ports</div><div class="detail-value">${(s.ports || []).length}</div></div>
          </div>
        </div>
      </div>

      <!-- Ports + disks -->
      <div class="grid-2 mb-3">
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:12px">Open Ports</div>
          ${(s.ports || []).length
            ? `<div class="flex" style="flex-wrap:wrap;gap:6px">${s.ports.map(p => `<span class="badge" style="background:var(--accent-dim);color:var(--accent)">${escapeHtml(String(p))}</span>`).join('')}</div>`
            : '<div class="text-muted text-sm">No listening ports detected</div>'}
        </div>
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:12px">Disks</div>
          ${(s.disks || []).length
            ? s.disks.map(d => bar(d.mount, d.usePct, `${formatBytes(d.used)} / ${formatBytes(d.size)} · ${d.usePct}%`)).join('')
            : '<div class="text-muted text-sm">No mounts reported</div>'}
        </div>
      </div>

      <!-- Top processes -->
      <div class="card">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px">Top Processes</div>
        ${(s.procs || []).length ? `
        <div style="max-height:260px;overflow-y:auto">
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--border)">
                <th style="text-align:left;padding:5px 6px;color:var(--text-muted);font-weight:600">PID</th>
                <th style="text-align:left;padding:5px 6px;color:var(--text-muted);font-weight:600">Command</th>
                <th style="text-align:right;padding:5px 6px;color:var(--text-muted);font-weight:600">CPU%</th>
                <th style="text-align:right;padding:5px 6px;color:var(--text-muted);font-weight:600">MEM%</th>
                <th style="text-align:right;padding:5px 6px;color:var(--text-muted);font-weight:600">RSS</th>
              </tr>
            </thead>
            <tbody>
              ${s.procs.map(p => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:5px 6px;font-family:var(--font-mono)">${p.pid}</td>
                  <td style="padding:5px 6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.comm)}">${escapeHtml(p.comm)}</td>
                  <td style="padding:5px 6px;text-align:right;font-weight:600;color:${p.cpu > 80 ? 'var(--danger)' : p.cpu > 50 ? 'var(--warning)' : 'var(--text-secondary)'}">${p.cpu}</td>
                  <td style="padding:5px 6px;text-align:right">${p.mem}</td>
                  <td style="padding:5px 6px;text-align:right" class="text-muted">${formatBytes(p.rss)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<div class="text-muted text-sm">No process data</div>'}
      </div>`;
  };

  const poll = async () => {
    if (!document.body.contains(body)) { clearInterval(timer); return; } // tab/page changed → stop
    try {
      const s = await API.get(`/servers/${serverId}/host/stats`);
      render(s);
      statusEl.className = 'badge badge-running';
      statusEl.innerHTML = '<span class="badge-dot"></span> live · 5s';
      first = false;
    } catch (e) {
      statusEl.className = 'badge badge-stopped';
      statusEl.innerHTML = 'unavailable';
      if (first) body.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div style="font-weight:600;color:var(--danger)">Couldn't read host metrics</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><div class="text-xs text-muted" style="margin-top:6px">Needs SSH access to a Linux host with /proc (read-only).</div></div>`;
    }
  };
  poll();
  timer = setInterval(poll, 5000);
}
