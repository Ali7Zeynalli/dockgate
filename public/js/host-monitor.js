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
    <div class="card" id="hm-trend-card" style="margin-bottom:16px;display:none">
      <div style="font-size:15px;font-weight:700;margin-bottom:12px">Trend — CPU / Memory / Disk (%)</div>
      <div style="height:180px"><canvas id="hm-trend-canvas"></canvas></div>
    </div>
    <div id="hm-body">
      <div class="summary-grid">${Array(6).fill('<div class="summary-card"><div class="skeleton" style="width:100%;height:42px"></div></div>').join('')}</div>
    </div>`;
  const statusEl = container.querySelector('#hm-status');
  const body = container.querySelector('#hm-body');
  let timer = null, first = true, built = false;

  // ---- Trend chart (chart.js) — seeded from stored /host/metrics, then appended live each poll.
  let chart = null, seeded = false;
  const buf = []; // [{cpu,mem,disk}], capped at 120 points
  const C = { cpu: '#00d4aa', mem: '#3b82f6', disk: '#8b5cf6' };
  function ensureChart() {
    if (chart || typeof Chart === 'undefined') return;
    const cv = container.querySelector('#hm-trend-canvas');
    if (!cv) return;
    container.querySelector('#hm-trend-card').style.display = '';
    const ds = (label, color) => ({ label, data: [], borderColor: color, backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 2 });
    chart = new Chart(cv, {
      type: 'line',
      data: { labels: [], datasets: [ds('CPU', C.cpu), ds('Memory', C.mem), ds('Disk', C.disk)] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: { y: { min: 0, max: 100, ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } }, x: { display: false } },
        plugins: { legend: { position: 'top', labels: { color: '#9ca3af', font: { size: 11 }, usePointStyle: true, pointStyleWidth: 8, boxHeight: 6 } } },
      },
    });
  }
  function applyBuf() {
    if (!chart) return;
    chart.data.labels = buf.map(() => '');
    chart.data.datasets[0].data = buf.map(p => p.cpu);
    chart.data.datasets[1].data = buf.map(p => p.mem);
    chart.data.datasets[2].data = buf.map(p => p.disk);
    chart.update('none');
  }
  async function seedTrend() {
    if (seeded) return; seeded = true;
    try {
      const r = await API.get(`/servers/${serverId}/host/metrics?limit=120`);
      for (const m of (r.metrics || [])) buf.push({ cpu: m.cpu || 0, mem: m.mem_pct || 0, disk: m.disk_pct || 0 });
      if (buf.length > 120) buf.splice(0, buf.length - 120);
    } catch (e) { /* no history yet — chart fills from live samples */ }
  }
  function pushSample(s) {
    const memPct = s.mem && s.mem.total ? Math.round(s.mem.used / s.mem.total * 100) : 0;
    const rootDisk = (s.disks || []).find(d => d.mount === '/') || (s.disks || [])[0] || { usePct: 0 };
    buf.push({ cpu: s.cpu || 0, mem: memPct, disk: rootDisk.usePct || 0 });
    if (buf.length > 120) buf.shift();
    ensureChart(); applyBuf();
  }

  // Colour helpers — shared 70 / 90 thresholds, mapped onto the design-system colour classes.
  const barClass = (p) => p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green';
  const iconClass = (p) => p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green';
  const clamp = (p) => Math.min(100, Math.max(0, p || 0));

  // Usage bar — same pattern as the Dashboard's "Disk Usage" card (used for the per-mount Disks list).
  const bar = (label, pct, sub, cls) => `
    <div style="margin-bottom:12px">
      <div class="flex justify-between items-center text-sm mb-1"><span>${label}</span><span class="text-muted">${sub}</span></div>
      <div class="disk-bar"><div class="disk-bar-fill ${cls || barClass(pct)}" style="width:${clamp(pct)}%"></div></div>
    </div>`;

  // Build the structure ONCE; later polls only UPDATE values in place (no full innerHTML rebuild → no
  // flicker, scroll/selection preserved). Stable metrics carry ids; the variable lists (ports/disks/
  // procs) each have their own container that re-renders in isolation.
  const $ = (sel) => body.querySelector(sel);
  function buildBody() {
    const kpiTile = (id, icon, label) => `
      <div class="summary-card">
        <div class="summary-card-icon teal" id="hm-ic-${id}"><span class="nav-item-icon">${icon}</span></div>
        <div class="summary-card-content"><div class="summary-card-value" id="hm-v-${id}">—</div><div class="summary-card-label">${label}</div></div>
      </div>`;
    const barRow = (id, label) => `
      <div style="margin-bottom:12px">
        <div class="flex justify-between items-center text-sm mb-1"><span>${label}</span><span class="text-muted" id="hm-bs-${id}">—</span></div>
        <div class="disk-bar"><div class="disk-bar-fill green" id="hm-bf-${id}" style="width:0%"></div></div>
      </div>`;
    body.innerHTML = `
      <div id="hm-insights" class="mb-2"></div>
      <div class="summary-grid">
        ${kpiTile('cpu', Icons.system, 'CPU')}
        ${kpiTile('mem', Icons.layers, 'Memory')}
        ${kpiTile('disk', Icons.volume, 'Disk /')}
        ${kpiTile('swap', Icons.refresh, 'Swap')}
        ${kpiTile('up', Icons.events, 'Uptime')}
        ${kpiTile('load', Icons.dashboard, 'Load 1m')}
      </div>
      <div class="grid-2 mb-3">
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:16px">Resource Usage</div>
          ${barRow('cpu', 'CPU')}${barRow('mem', 'Memory')}${barRow('disk', 'Disk (/)')}${barRow('swap', 'Swap')}
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <div class="text-xs text-muted" style="margin-bottom:8px;font-weight:600">NETWORK I/O</div>
            <div class="flex gap-2 text-sm">
              <span><span style="color:var(--success)">↓</span> <span id="hm-net-rx">—</span>/s</span>
              <span><span style="color:var(--accent)">↑</span> <span id="hm-net-tx">—</span>/s</span>
            </div>
          </div>
        </div>
        <div class="card">
          <div style="font-size:15px;font-weight:700;margin-bottom:12px">System</div>
          <div class="detail-grid" style="grid-template-columns:1fr 1fr">
            <div class="detail-item"><div class="detail-label">Load avg (1·5·15)</div><div class="detail-value" id="hm-d-load">—</div></div>
            <div class="detail-item"><div class="detail-label">Processes</div><div class="detail-value" id="hm-d-procs">—</div></div>
            <div class="detail-item"><div class="detail-label">Network ↓</div><div class="detail-value" id="hm-d-rx">—</div></div>
            <div class="detail-item"><div class="detail-label">Network ↑</div><div class="detail-value" id="hm-d-tx">—</div></div>
            <div class="detail-item"><div class="detail-label">Uptime</div><div class="detail-value" id="hm-d-up">—</div></div>
            <div class="detail-item"><div class="detail-label">Open ports</div><div class="detail-value" id="hm-d-ports">—</div></div>
          </div>
        </div>
      </div>
      <div class="grid-2 mb-3">
        <div class="card"><div style="font-size:15px;font-weight:700;margin-bottom:12px">Open Ports</div><div id="hm-ports"></div></div>
        <div class="card"><div style="font-size:15px;font-weight:700;margin-bottom:12px">Disks</div><div id="hm-disks"></div></div>
      </div>
      <div class="card"><div style="font-size:15px;font-weight:700;margin-bottom:12px">Top Processes</div><div id="hm-procs"></div></div>`;
    built = true;
  }

  const setT = (sel, v) => { const e = $(sel); if (e) e.textContent = v; };
  const setIcon = (id, color) => { const e = $('#hm-ic-' + id); if (e) e.className = 'summary-card-icon ' + color; };
  const setBar = (id, pct, sub, cls) => { const f = $('#hm-bf-' + id); if (f) { f.style.width = clamp(pct) + '%'; f.className = 'disk-bar-fill ' + (cls || barClass(pct)); } setT('#hm-bs-' + id, sub); };

  function updateBody(s) {
    const hasSwap = !!(s.mem && s.mem.swapTotal);
    const memPct = s.mem && s.mem.total ? Math.round(s.mem.used / s.mem.total * 100) : 0;
    const swapPct = hasSwap ? Math.round(s.mem.swapUsed / s.mem.swapTotal * 100) : 0;
    const rootDisk = (s.disks || []).find(d => d.mount === '/') || (s.disks || [])[0] || { usePct: 0, used: 0, size: 0 };
    const upD = Math.floor((s.uptime || 0) / 86400), upH = Math.floor(((s.uptime || 0) % 86400) / 3600);
    const upStr = upD > 0 ? `${upD}d ${upH}h` : `${upH}h`;
    const net = s.net || { rxBytesSec: 0, txBytesSec: 0 };
    const load = s.load || { load1: 0, load5: 0, load15: 0, procsRunning: 0, procsTotal: 0 };
    const cpu = s.cpu != null ? s.cpu : 0;

    // KPI tiles (value + threshold colour)
    setT('#hm-v-cpu', `${s.cpu != null ? s.cpu : '—'}%`); setIcon('cpu', iconClass(cpu));
    setT('#hm-v-mem', `${memPct}%`); setIcon('mem', memPct >= 70 ? iconClass(memPct) : 'blue');
    setT('#hm-v-disk', `${rootDisk.usePct}%`); setIcon('disk', iconClass(rootDisk.usePct));
    setT('#hm-v-swap', hasSwap ? `${swapPct}%` : '—'); setIcon('swap', hasSwap ? iconClass(swapPct) : 'teal');
    setT('#hm-v-up', upStr); setT('#hm-v-load', `${load.load1}`);

    // Resource bars
    setBar('cpu', cpu, `${s.cpu != null ? s.cpu : '—'}%`);
    setBar('mem', memPct, `${formatBytes(s.mem.used)} / ${formatBytes(s.mem.total)}`, memPct >= 90 ? 'red' : memPct >= 70 ? 'yellow' : 'blue');
    setBar('disk', rootDisk.usePct, `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.size)}`);
    if (hasSwap) setBar('swap', swapPct, `${formatBytes(s.mem.swapUsed)} / ${formatBytes(s.mem.swapTotal)}`);
    else setBar('swap', 0, 'no swap', 'green');

    // Network footer + System grid
    setT('#hm-net-rx', formatBytes(net.rxBytesSec)); setT('#hm-net-tx', formatBytes(net.txBytesSec));
    setT('#hm-d-load', `${load.load1} · ${load.load5} · ${load.load15}`);
    setT('#hm-d-procs', `${load.procsRunning} running / ${load.procsTotal} total`);
    setT('#hm-d-rx', `${formatBytes(net.rxBytesSec)}/s`); setT('#hm-d-tx', `${formatBytes(net.txBytesSec)}/s`);
    setT('#hm-d-up', upStr); setT('#hm-d-ports', `${(s.ports || []).length}`);

    // Insight bridges (scoped re-render — they appear/disappear)
    const sid = String(serverId).replace(/'/g, '');
    const ins = [];
    if (rootDisk.usePct >= 85) ins.push(`<div class="insight-card warning" onclick="Router.navigate('infra',{tab:'cleanup'})" style="cursor:pointer" title="Open Docker Cleanup"><span class="nav-item-icon">${Icons.alert}</span><span>Disk ${rootDisk.usePct}% full on / — free space with Docker Cleanup →</span></div>`);
    if (memPct >= 90 && !hasSwap) ins.push(`<div class="insight-card warning" onclick="Router.navigate('server-console',{id:'${sid}',tab:'setup'})" style="cursor:pointer" title="Open Setup"><span class="nav-item-icon">${Icons.alert}</span><span>Memory ${memPct}% and no swap — add a swap file in Setup →</span></div>`);
    if (s.cpu != null && s.cpu >= 90) ins.push(`<div class="insight-card warning"><span class="nav-item-icon">${Icons.alert}</span><span>CPU ${s.cpu}% — see Top Processes below</span></div>`);
    const insEl = $('#hm-insights'); if (insEl) insEl.innerHTML = ins.join('');

    // Variable lists — re-render only their own container (isolated, no page-wide flicker)
    const portsEl = $('#hm-ports');
    if (portsEl) portsEl.innerHTML = (s.ports || []).length
      ? `<div class="flex" style="flex-wrap:wrap;gap:6px">${s.ports.map(p => `<span class="badge" style="background:var(--accent-dim);color:var(--accent)">${escapeHtml(String(p))}</span>`).join('')}</div>`
      : '<div class="text-muted text-sm">No listening ports detected</div>';
    const disksEl = $('#hm-disks');
    if (disksEl) disksEl.innerHTML = (s.disks || []).length
      ? s.disks.map(d => bar(d.mount, d.usePct, `${formatBytes(d.used)} / ${formatBytes(d.size)} · ${d.usePct}%`)).join('')
      : '<div class="text-muted text-sm">No mounts reported</div>';
    const procsEl = $('#hm-procs');
    if (procsEl) procsEl.innerHTML = (s.procs || []).length ? `
      <div style="max-height:260px;overflow-y:auto">
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:5px 6px;color:var(--text-muted);font-weight:600">PID</th>
            <th style="text-align:left;padding:5px 6px;color:var(--text-muted);font-weight:600">Command</th>
            <th style="text-align:right;padding:5px 6px;color:var(--text-muted);font-weight:600">CPU%</th>
            <th style="text-align:right;padding:5px 6px;color:var(--text-muted);font-weight:600">MEM%</th>
            <th style="text-align:right;padding:5px 6px;color:var(--text-muted);font-weight:600">RSS</th>
          </tr></thead>
          <tbody>${s.procs.map(p => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:5px 6px;font-family:var(--font-mono)">${p.pid}</td>
              <td style="padding:5px 6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.comm)}">${escapeHtml(p.comm)}</td>
              <td style="padding:5px 6px;text-align:right;font-weight:600;color:${p.cpu > 80 ? 'var(--danger)' : p.cpu > 50 ? 'var(--warning)' : 'var(--text-secondary)'}">${p.cpu}</td>
              <td style="padding:5px 6px;text-align:right">${p.mem}</td>
              <td style="padding:5px 6px;text-align:right" class="text-muted">${formatBytes(p.rss)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : '<div class="text-muted text-sm">No process data</div>';
  }

  const poll = async () => {
    if (!document.body.contains(body)) { clearInterval(timer); if (chart) { chart.destroy(); chart = null; } return; } // tab/page changed → stop
    try {
      if (first) await seedTrend(); // pull stored history before the first live sample
      const s = await API.get(`/servers/${serverId}/host/stats`);
      if (!document.body.contains(body)) return;
      if (!built) buildBody();
      updateBody(s);
      pushSample(s);
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
