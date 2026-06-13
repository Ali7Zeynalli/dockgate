// Host logs tab — last N lines of an allowlisted host log source (journald / auth / syslog / dmesg)
// over SSH. One-shot fetch + manual/auto refresh (no live socket). Global: renderHostLogs(id, container).
function renderHostLogs(serverId, container) {
  const SOURCES = ['journald', 'auth', 'syslog', 'dmesg'];
  container.innerHTML = `
    <div class="flex gap-1 items-center mb-2" style="flex-wrap:wrap">
      <select class="select" id="hl-source">${SOURCES.map(s => `<option value="${s}">${s}</option>`).join('')}</select>
      <select class="select" id="hl-lines"><option>200</option><option>500</option><option>1000</option></select>
      <button class="btn btn-sm btn-secondary" id="hl-refresh">${Icons.refresh} Refresh</button>
      <label class="text-xs text-muted flex items-center gap-1" style="cursor:pointer"><input type="checkbox" id="hl-auto"> auto 5s</label>
      <span class="text-xs text-muted" id="hl-status" style="margin-left:auto"></span>
    </div>
    <div class="log-viewer" id="hl-body" style="height:60vh">Loading…</div>`;
  const body = container.querySelector('#hl-body');
  const statusEl = container.querySelector('#hl-status');
  const sourceSel = container.querySelector('#hl-source');
  const linesSel = container.querySelector('#hl-lines');
  let timer = null;

  async function load() {
    if (!document.body.contains(body)) { if (timer) clearInterval(timer); return; } // tab/page changed
    statusEl.textContent = 'loading…';
    try {
      const r = await API.get(`/servers/${serverId}/host/logs?source=${encodeURIComponent(sourceSel.value)}&lines=${encodeURIComponent(linesSel.value)}`);
      if (!document.body.contains(body)) return;
      body.textContent = r.text || '(empty)';
      body.scrollTop = body.scrollHeight;
      statusEl.textContent = `${r.lines} lines · ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      if (!document.body.contains(body)) return;
      body.textContent = 'Could not read logs: ' + e.message + '\n\nNeeds SSH access (+ passwordless sudo for auth / syslog / dmesg).';
      statusEl.textContent = 'error';
    }
  }
  container.querySelector('#hl-refresh').addEventListener('click', load);
  sourceSel.addEventListener('change', load);
  linesSel.addEventListener('change', load);
  container.querySelector('#hl-auto').addEventListener('change', (e) => {
    if (timer) { clearInterval(timer); timer = null; }
    if (e.target.checked) timer = setInterval(load, 5000);
  });
  load();
}
