// Server Console → Monitoring (DigitalOcean / Hetzner "Graphs" style): a time range, CPU · memory · disk ·
// network graphs, then the live view (resource use, disks, processes, open ports — host-monitor.js) and the
// alerts that apply to this server. History comes from the Edge agent when installed, otherwise from the
// samples DockGate stores itself.

async function renderServerMonitoring(serverId, container, range = '1h') {
  container.innerHTML = `<div class="ui-page">
    ${UI.header('Monitoring', 'Resource use of this server.', `<div class="ui-seg" data-range>${['1h', '6h', '24h', '7d'].map(r => `<button type="button" data-r="${r}" aria-pressed="${r === range}">${r}</button>`).join('')}</div>`)}
    <div data-charts><div class="skeleton" style="height:150px;width:100%"></div></div>
    ${UI.header('Live', 'Refreshes every few seconds while this tab is open.')}
    <div data-live></div>
    <div data-alerts></div>
  </div>`;
  container.querySelectorAll('[data-r]').forEach(b => b.onclick = () => renderServerMonitoring(serverId, container, b.dataset.r));
  if (typeof renderHostMonitoring === 'function') renderHostMonitoring(serverId, container.querySelector('[data-live]'));
  renderServerAlerts(serverId, container.querySelector('[data-alerts]')); // alert-rules-panel.js

  const chartsEl = container.querySelector('[data-charts]');
  let d;
  try { d = await API.get(`/monitoring/${encodeURIComponent(serverId)}/metrics?range=${encodeURIComponent(range)}`); }
  catch (e) { chartsEl.innerHTML = `<div class="insight-card warning"><div>Graphs are not available: ${escapeHtml(e.message)}</div></div>`; return; }
  const h = d.host || {};
  const ts = d.timestamps || [];
  if (ts.length < 2) { chartsEl.innerHTML = '<div class="insight-card info"><div>Not enough history yet — DockGate stores a sample every few minutes. The live view below is current.</div></div>'; return; }
  const mbit = (arr) => (arr || []).map(v => (Number(v) || 0) * 8 / 1e6);
  const net = mbit(h.netRxBytesSec).map((v, i) => v + (mbit(h.netTxBytesSec)[i] || 0));
  chartsEl.innerHTML = `
    ${d.source !== 'agent' ? `<div class="ui-sub" style="margin-bottom:8px">Showing the last ${ts.length} samples DockGate stored (${monFmtSpan(ts)}). Install the Edge agent for the full ${escapeHtml(range)} history.</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px">
      ${monChart('CPU', '%', h.cpu, 100, 'var(--accent)', ts)}
      ${monChart('Memory', '%', h.memPercent, 100, '#a78bfa', ts)}
      ${monChart('Disk /', '% used', h.diskPercent, 100, 'var(--warning)', ts)}
      ${monChart('Network', 'Mbit/s', net, null, '#38bdf8', ts)}
    </div>`;
}

function monFmtSpan(ts) {
  const ms = ts[ts.length - 1] - ts[0];
  const hrs = ms / 3600000;
  return hrs >= 48 ? `${Math.round(hrs / 24)} days` : hrs >= 1 ? `${hrs.toFixed(hrs < 10 ? 1 : 0)} hours` : `${Math.round(ms / 60000)} minutes`;
}

/** Area chart: one scale for the line, the fill, the grid and the labels. */
function monChart(title, unit, values, fixedMax, color, ts) {
  const v = (values || []).map(x => Number(x) || 0);
  const w = 300, h = 96, padT = 6, padB = 6;
  const max = fixedMax || Math.max(1, ...v) * 1.15;
  const x = (i) => (i * w) / Math.max(1, v.length - 1);
  const y = (val) => h - padB - (val / max) * (h - padT - padB);
  const line = v.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join(' ');
  const now = v.length ? v[v.length - 1] : 0;
  const peak = v.length ? Math.max(...v) : 0;
  const fmt = (n) => (n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(0) : n.toFixed(1));
  const fmtT = (t) => new Date(t).toLocaleString([], { hour: '2-digit', minute: '2-digit', ...(ts[ts.length - 1] - ts[0] > 86400000 ? { day: '2-digit', month: 'short' } : {}) });
  return `<div class="card" style="padding:14px 16px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:600">${title}</span><span style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">${fmt(now)}<span class="text-xs text-muted"> ${unit}</span></span></div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:96px;display:block;margin-top:6px" role="img" aria-label="${title}: now ${fmt(now)} ${unit}, peak ${fmt(peak)} ${unit}">
      <path d="M0 ${h - padB} H${w}" stroke="var(--border)" fill="none"/>
      <path d="M0 ${y(max / 2).toFixed(1)} H${w}" stroke="var(--border)" stroke-dasharray="3 4" fill="none"/>
      <path d="${line} L${w} ${h - padB} L0 ${h - padB} Z" fill="${color}" fill-opacity=".14"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="ui-sub" style="display:flex;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums"><span>${fmtT(ts[0])}</span><span>peak ${fmt(peak)} ${unit}</span><span>${fmtT(ts[ts.length - 1])}</span></div>
  </div>`;
}

