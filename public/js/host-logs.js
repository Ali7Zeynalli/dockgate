// Host logs tab — last N lines of any log on the host over SSH. The dropdown is populated by DISCOVERY
// (GET /host/log-sources): curated quick-picks + every systemd service unit + every file under /var/log.
// One-shot fetch + manual/auto refresh (no live socket). Global: renderHostLogs(id, container).
function renderHostLogs(serverId, container) {
  container.innerHTML = `
    ${UI.header('Logs', 'System journal and log files of this server (Cockpit "Logs" style). Most sources need passwordless sudo.')}
    <div class="flex gap-1 items-center mb-2" style="flex-wrap:wrap">
      <select class="select" id="hl-source" style="min-width:220px;max-width:340px">
        <optgroup label="System"><option value="source:journald">journald (all)</option><option value="source:kernel">kernel (dmesg)</option><option value="source:auth">auth</option><option value="source:syslog">syslog</option><option value="source:boot">this boot</option></optgroup>
      </select>
      <select class="select" id="hl-lines"><option>200</option><option>500</option><option>1000</option></select>
      <button class="btn btn-sm btn-secondary" id="hl-refresh">${Icons.refresh} Refresh</button>
      <select class="select" id="hl-level" aria-label="Level"><option value="">All lines</option><option value="warn">Warnings and errors</option><option value="err">Errors only</option></select>
      <input class="input" id="hl-q" placeholder="Search" style="width:180px">
      <label class="text-xs text-muted flex items-center gap-1" style="cursor:pointer"><input type="checkbox" id="hl-auto"> Follow (5 s)</label>
      <span class="text-xs text-muted" id="hl-status" style="margin-left:auto"></span>
    </div>
    <div class="log-viewer" id="hl-body" style="height:60vh">Loading…</div>`;
  const body = container.querySelector('#hl-body');
  const statusEl = container.querySelector('#hl-status');
  const sourceSel = container.querySelector('#hl-source');
  const linesSel = container.querySelector('#hl-lines');
  let timer = null;

  // Populate the dropdown with discovered units + /var/log files (in addition to the System quick-picks).
  (async () => {
    try {
      const d = await API.get(`/servers/${serverId}/host/log-sources`);
      if (!document.body.contains(sourceSel)) return;
      const optgrp = (label, opts) => {
        if (!opts.length) return;
        const g = document.createElement('optgroup'); g.label = label;
        for (const [val, text] of opts) { const o = document.createElement('option'); o.value = val; o.textContent = text; g.appendChild(o); }
        sourceSel.appendChild(g);
      };
      optgrp(`Services (${(d.units || []).length})`, (d.units || []).map(u => [`unit:${u}`, u.replace(/\.service$/, '')]));
      optgrp(`Files (${(d.files || []).length})`, (d.files || []).map(f => [`file:${f}`, f.replace('/var/log/', '')]));
    } catch (e) { /* discovery failed — the System quick-picks still work */ }
  })();

  function queryFor(value) {
    const i = value.indexOf(':'); const kind = value.slice(0, i), val = value.slice(i + 1);
    return `${kind}=${encodeURIComponent(val)}`;
  }

  async function load() {
    if (!document.body.contains(body)) { if (timer) clearInterval(timer); return; } // tab/page changed
    statusEl.textContent = 'loading…';
    try {
      const r = await API.get(`/servers/${serverId}/host/logs?${queryFor(sourceSel.value)}&lines=${encodeURIComponent(linesSel.value)}`);
      if (!document.body.contains(body)) return;
      raw = r.text || '';
      applyFilter();
      statusEl.textContent = `${r.label || ''} · ${r.lines} lines · ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (!document.body.contains(body)) return;
      body.textContent = 'Could not read logs: ' + e.message + '\n\nNeeds SSH access (+ passwordless sudo for most logs).';
      statusEl.textContent = 'error';
    }
  }
  // client-side filters: level (by keywords in the line) and free-text search
  let raw = '';
  const ERR = /\b(err(or)?|fail(ed|ure)?|fatal|crit(ical)?|panic|denied|refused)\b/i, WARN = /\b(warn(ing)?|ban|invalid|timeout|deprecated)\b/i;
  function applyFilter() {
    const lvl = container.querySelector('#hl-level').value, q = container.querySelector('#hl-q').value.trim().toLowerCase();
    const lines = raw.split('\n').filter(l => (!lvl || (lvl === 'err' ? ERR.test(l) : (ERR.test(l) || WARN.test(l)))) && (!q || l.toLowerCase().includes(q)));
    body.textContent = lines.join('\n') || (raw ? '(no lines match the filter)' : '(empty)');
    body.scrollTop = body.scrollHeight;
  }
  container.querySelector('#hl-level').addEventListener('change', applyFilter);
  container.querySelector('#hl-q').addEventListener('input', applyFilter);
  container.querySelector('#hl-refresh').addEventListener('click', load);
  sourceSel.addEventListener('change', load);
  linesSel.addEventListener('change', load);
  container.querySelector('#hl-auto').addEventListener('change', (e) => {
    if (timer) { clearInterval(timer); timer = null; }
    if (e.target.checked) timer = setInterval(load, 5000);
  });
  load();
}
