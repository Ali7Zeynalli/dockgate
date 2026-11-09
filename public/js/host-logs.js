// Host logs: the newest N lines of any log on the host over SSH, shown in the shared LogViewer.
// The source picker is filled by discovery (GET /host/log-sources): System quick-picks, every systemd service unit,
// every file under /var/log. One implementation for Server Console → Logs and Observe → Logs → Host logs.
// Global: renderHostLogs(serverId, container, { header = true, source })
function renderHostLogs(serverId, container, opts = {}) {
  const head = opts.header === false ? '' : UI.header('Logs', 'System journal and log files of this server. Most sources need passwordless sudo.');
  container.innerHTML = `${head}<div data-hl></div>`;
  const srcPick = `<select class="select" data-hlsrc aria-label="Log source" style="max-width:260px">
      <optgroup label="System"><option value="source:journald">journald (all)</option><option value="source:kernel">kernel (dmesg)</option><option value="source:auth">auth</option><option value="source:syslog">syslog</option><option value="source:boot">this boot</option></optgroup>
    </select>`;
  let sourceSel = null;
  const queryFor = (value) => { const i = value.indexOf(':'); return `${value.slice(0, i)}=${encodeURIComponent(value.slice(i + 1))}`; };
  const viewer = LogViewer.mount(container.querySelector('[data-hl]'), {
    key: 'host-logs',
    fileName: `host-${serverId}`,
    retention: 'The server keeps these logs (journald / logrotate)',
    tools: srcPick,
    poll: 5000, liveDefault: false,
    empty: 'This log is empty.',
    onTools(el) {
      sourceSel = el.querySelector('[data-hlsrc]');
      if (opts.source) { const o = document.createElement('option'); o.value = opts.source; o.textContent = opts.source.replace(/^\w+:/, ''); sourceSel.prepend(o); sourceSel.value = opts.source; }
      sourceSel.addEventListener('change', () => viewer.reload());
      (async () => { // add discovered units + /var/log files to the System quick-picks
        try {
          const d = await API.get(`/servers/${serverId}/host/log-sources`);
          if (!document.body.contains(sourceSel)) return;
          const group = (label, list) => {
            if (!list.length) return;
            const g = document.createElement('optgroup'); g.label = label;
            for (const [val, text] of list) { const o = document.createElement('option'); o.value = val; o.textContent = text; g.appendChild(o); }
            sourceSel.appendChild(g);
          };
          group(`Services (${(d.units || []).length})`, (d.units || []).map(u => [`unit:${u}`, u.replace(/\.service$/, '')]));
          group(`Files (${(d.files || []).length})`, (d.files || []).map(f => [`file:${f}`, f.replace('/var/log/', '')]));
        } catch (e) { /* discovery failed: the System quick-picks still work */ }
      })();
    },
    async load(limit) {
      const value = sourceSel ? sourceSel.value : 'source:journald';
      try {
        const r = await API.get(`/servers/${serverId}/host/logs?${queryFor(value)}&lines=${limit}`);
        return { text: r.text || '' };
      } catch (e) {
        throw new Error(`${e.message}. Reading host logs needs SSH access, and passwordless sudo for most logs.`);
      }
    },
  });
  return viewer;
}
