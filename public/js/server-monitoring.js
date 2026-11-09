// Server Console → Monitoring: two views.
//  Live (default)   — refreshes every few seconds: resource use, a rolling 15-minute trend, disks, processes,
//                     open ports (host-monitor.js). Nothing of it is stored.
//  Last 48 hours    — DockGate's own store: one sample a minute per server, shown as 5-minute averages with
//                     the peak of each bucket. The same with or without the Edge agent, kept across reboots.
// The alerts that apply to this server follow either view.

async function renderServerMonitoring(serverId, container, range = 'live') {
  container.innerHTML = `<div class="ui-page">
    ${UI.header('Monitoring', range === '48h' ? 'The last 48 hours, from what DockGate stored once a minute.' : 'Live resource use of this server, refreshed every few seconds.',
      `<div class="ui-seg" data-range>${[['live', 'Live'], ['48h', 'Last 48 hours']].map(([r, l]) => `<button type="button" data-r="${r}" aria-pressed="${r === range}">${l}</button>`).join('')}</div>`)}
    <div data-view></div>
    <div data-alerts></div>
  </div>`;
  container.querySelectorAll('[data-r]').forEach(b => b.onclick = () => renderServerMonitoring(serverId, container, b.dataset.r));
  renderServerAlerts(serverId, container.querySelector('[data-alerts]')); // alert-rules-panel.js
  const view = container.querySelector('[data-view]');
  if (range !== '48h') { if (typeof renderHostMonitoring === 'function') renderHostMonitoring(serverId, view, { live: true }); return; }

  view.innerHTML = '<div class="skeleton" style="height:150px;width:100%"></div>';
  let d;
  try { d = await API.get(`/monitoring/${encodeURIComponent(serverId)}/metrics?range=48h`); }
  catch (e) { view.innerHTML = `<div class="insight-card warning"><div>History is not available: ${escapeHtml(e.message)}</div></div>`; return; }
  const h = d.host || {}, mx = h.max || {}, ts = d.timestamps || [];
  if (ts.length < 2) { view.innerHTML = '<div class="insight-card info"><div>No history yet. DockGate stores one sample a minute and keeps 48 hours — come back in a few minutes, or use Live.</div></div>'; return; }
  const mbit = (arr) => (arr || []).map(v => (Number(v) || 0) * 8 / 1e6);
  const sum = (a, b) => a.map((v, i) => v + (b[i] || 0));
  const hrs = d.storedSince ? (Date.now() - d.storedSince) / 3600000 : 48;
  view.innerHTML = `
    <div class="ui-sub" style="margin-bottom:8px">5-minute averages; the thin line is the peak inside each 5 minutes.${hrs < 47 ? ` Stored since ${escapeHtml(new Date(d.storedSince).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))} (${hrs < 1 ? Math.max(1, Math.round(hrs * 60)) + ' min' : Math.round(hrs) + ' h'}) — the graphs fill up to 48 hours.` : ''}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px">
      ${monChart('CPU', '%', h.cpu, 100, 'var(--accent)', ts, mx.cpu)}
      ${monChart('Memory', '%', h.memPercent, 100, '#a78bfa', ts, mx.memPercent)}
      ${monChart('Disk /', '% used', h.diskPercent, 100, 'var(--warning)', ts, mx.diskPercent)}
      ${monChart('Network', 'Mbit/s', sum(mbit(h.netRxBytesSec), mbit(h.netTxBytesSec)), null, '#38bdf8', ts, sum(mbit(mx.netRxBytesSec), mbit(mx.netTxBytesSec)))}
    </div>`;
}

function monFmtSpan(ts) {
  const ms = ts[ts.length - 1] - ts[0];
  const hrs = ms / 3600000;
  return hrs >= 48 ? `${Math.round(hrs / 24)} days` : hrs >= 1 ? `${hrs.toFixed(hrs < 10 ? 1 : 0)} hours` : `${Math.round(ms / 60000)} minutes`;
}

/** Area chart: one scale for the line, the fill, the grid and the labels. */
function monChart(title, unit, values, fixedMax, color, ts, peaks) {
  const v = (values || []).map(x => Number(x) || 0);
  const pk = peaks ? peaks.map(x => Number(x) || 0) : null;
  const w = 300, h = 96, padT = 6, padB = 6;
  const max = fixedMax || Math.max(1, ...v, ...(pk || [])) * 1.15;
  const x = (i) => (i * w) / Math.max(1, v.length - 1);
  const y = (val) => h - padB - (val / max) * (h - padT - padB);
  const line = v.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join(' ');
  const now = v.length ? v[v.length - 1] : 0;
  const peak = (pk || v).length ? Math.max(...(pk || v)) : 0;
  const pline = pk ? pk.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join(' ') : '';
  const fmt = (n) => (n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(0) : n.toFixed(1));
  const fmtT = (t) => new Date(t).toLocaleString([], { hour: '2-digit', minute: '2-digit', ...(ts[ts.length - 1] - ts[0] > 86400000 ? { day: '2-digit', month: 'short' } : {}) });
  return `<div class="card" style="padding:14px 16px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:600">${title}</span><span style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">${fmt(now)}<span class="text-xs text-muted"> ${unit}</span></span></div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:96px;display:block;margin-top:6px" role="img" aria-label="${title}: now ${fmt(now)} ${unit}, peak ${fmt(peak)} ${unit}">
      <path d="M0 ${h - padB} H${w}" stroke="var(--border)" fill="none"/>
      <path d="M0 ${y(max / 2).toFixed(1)} H${w}" stroke="var(--border)" stroke-dasharray="3 4" fill="none"/>
      <path d="${line} L${w} ${h - padB} L0 ${h - padB} Z" fill="${color}" fill-opacity=".14"/>
      ${pline ? `<path d="${pline}" fill="none" stroke="${color}" stroke-width="1" stroke-opacity=".45" vector-effect="non-scaling-stroke"/>` : ''}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="ui-sub" style="display:flex;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums"><span>${fmtT(ts[0])}</span><span>peak ${fmt(peak)} ${unit}</span><span>${fmtT(ts[ts.length - 1])}</span></div>
  </div>`;
}

