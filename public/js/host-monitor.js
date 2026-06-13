// Host monitoring dashboard — live CPU / RAM / disk / swap / load / network / uptime / open ports / top
// processes for a remote server. Polls GET /api/servers/:id/host/stats every 5s; stops when the
// container leaves the DOM (tab change / navigation). Global: renderHostMonitoring(serverId, container).
function renderHostMonitoring(serverId, container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;max-width:980px">
      <div class="text-sm text-muted" id="hm-status">🔍 Reading host metrics for <b>${escapeHtml(serverId)}</b> over SSH…</div>
      <div id="hm-body"><div class="skeleton" style="height:90px"></div></div>
    </div>`;
  const statusEl = container.querySelector('#hm-status');
  const body = container.querySelector('#hm-body');
  let timer = null, first = true;

  const gauge = (label, pct, sub) => {
    const col = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning, #f59e0b)' : 'var(--success)';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><div style="font-weight:600">${label}</div><div style="font-weight:700;color:${col}">${pct != null ? pct + '%' : '—'}</div></div>
      <div style="height:8px;background:var(--bg-primary);border-radius:5px;margin-top:8px;overflow:hidden"><div style="height:100%;width:${Math.min(100, Math.max(0, pct || 0))}%;background:${col};transition:width .4s"></div></div>
      <div class="text-xs text-muted" style="margin-top:6px">${sub || ''}</div>
    </div>`;
  };
  const infoCard = (title, inner) => `<div class="card"><div style="font-weight:600;margin-bottom:8px">${title}</div>${inner}</div>`;

  const render = (s) => {
    const memPct = s.mem.total ? Math.round(s.mem.used / s.mem.total * 100) : 0;
    const swapPct = s.mem.swapTotal ? Math.round(s.mem.swapUsed / s.mem.swapTotal * 100) : 0;
    const rootDisk = (s.disks || []).find(d => d.mount === '/') || (s.disks || [])[0] || { usePct: 0, used: 0, size: 0, mount: '/' };
    const upD = Math.floor((s.uptime || 0) / 86400), upH = Math.floor(((s.uptime || 0) % 86400) / 3600);
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
        ${gauge('CPU', s.cpu, `${s.load.procsRunning}/${s.load.procsTotal} running`)}
        ${gauge('Memory', memPct, `${formatBytes(s.mem.used)} / ${formatBytes(s.mem.total)}`)}
        ${gauge('Disk (/)', rootDisk.usePct, `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.size)}`)}
        ${s.mem.swapTotal ? gauge('Swap', swapPct, `${formatBytes(s.mem.swapUsed)} / ${formatBytes(s.mem.swapTotal)}`) : infoCard('Network', `<div class="text-sm">↓ ${formatBytes(s.net.rxBytesSec)}/s<br>↑ ${formatBytes(s.net.txBytesSec)}/s</div>`)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:12px">
        ${infoCard('Load average', `<div class="text-sm">${s.load.load1} · ${s.load.load5} · ${s.load.load15} <span class="text-xs text-muted">(1·5·15 min)</span></div>`)}
        ${s.mem.swapTotal ? infoCard('Network', `<div class="text-sm">↓ ${formatBytes(s.net.rxBytesSec)}/s &nbsp; ↑ ${formatBytes(s.net.txBytesSec)}/s</div>`) : ''}
        ${infoCard('Uptime', `<div class="text-sm">${upD}d ${upH}h</div>`)}
        ${infoCard('Open ports', `<div>${(s.ports || []).length ? s.ports.map(p => `<span class="badge" style="margin:2px">${p}</span>`).join('') : '<span class="text-muted text-sm">none detected</span>'}</div>`)}
      </div>
      ${(s.disks || []).length > 1 ? `<div class="card" style="margin-top:12px"><div style="font-weight:600;margin-bottom:8px">Disks</div>${s.disks.map(d => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span class="td-mono">${escapeHtml(d.mount)}</span><span class="text-muted">${formatBytes(d.used)} / ${formatBytes(d.size)} · ${d.usePct}%</span></div>`).join('')}</div>` : ''}
      <div class="card" style="margin-top:12px"><div style="font-weight:600;margin-bottom:8px">Top processes</div>
        <div class="table-wrapper"><table style="width:100%">
          <thead><tr><th style="text-align:left">PID</th><th style="text-align:left">Command</th><th style="text-align:right">CPU%</th><th style="text-align:right">MEM%</th><th style="text-align:right">RSS</th></tr></thead>
          <tbody>${(s.procs || []).map(p => `<tr><td class="td-mono">${p.pid}</td><td>${escapeHtml(p.comm)}</td><td style="text-align:right">${p.cpu}</td><td style="text-align:right">${p.mem}</td><td style="text-align:right">${formatBytes(p.rss)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  };

  const poll = async () => {
    if (!document.body.contains(body)) { clearInterval(timer); return; } // tab/page changed → stop
    try {
      const s = await API.get(`/servers/${serverId}/host/stats`);
      render(s);
      statusEl.textContent = 'Live · auto-refresh 5s';
      first = false;
    } catch (e) {
      statusEl.textContent = '⚠ Host metrics unavailable — ' + (e.message || 'server unreachable');
      if (first) body.innerHTML = `<div class="card" style="border-left:3px solid var(--danger)"><div class="text-danger" style="font-weight:600">Couldn't read host metrics</div><div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(e.message)}</div><div class="text-xs text-muted" style="margin-top:6px">Needs SSH access + a Linux host with /proc (read-only).</div></div>`;
    }
  };
  poll();
  timer = setInterval(poll, 5000);
}
