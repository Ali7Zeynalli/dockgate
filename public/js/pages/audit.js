// Audit Log page: every operation done through DockGate, in the shared LogViewer
// (search, type = source, server, level, up to 10,000 entries) + CSV export + clearing.
// Since there is no auth, this is a "what was done + from where (IP)" audit, not "who did it".
Router.register('audit', async (content) => {
  let currentRows = [];

  function rowsToCsv(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['time', 'server', 'type', 'action', 'resource', 'source_ip', 'details'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        esc(r.created_at), esc(r.server || 'local'), esc(r.resource_type),
        esc(r.action), esc(r.resource_name || r.resource_id), esc(r.source_ip || ''), esc(r.details || ''),
      ].join(','));
    }
    return lines.join('\n');
  }

  // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
  const toMs = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z')); return Number.isFinite(t) ? t : null; };
  const levelOf = (action = '') => /(fail|error|denied|refused)/i.test(action) ? 'E' : /(remove|delete|destroy|prune|clear|kill|stop|revoke|ban)/i.test(action) ? 'W' : 'I';
  let viewer = null, serverSel = null;

  async function render() {
    let facets = { types: [], actions: [], servers: [] };
    try { facets = await API.get('/meta/activity/facets'); } catch (e) { /* filters stay empty */ }
    content.innerHTML = `
      ${UI.header('Audit log', 'Every change made through DockGate: what, on which server, and from which IP address. Click a line for its details.',
        `<button class="btn btn-secondary btn-sm" id="audit-export">${Icons.download} Export CSV</button>
         ${UI.menu([{ label: `${Icons.trash} Clear the log…`, attrs: 'id="audit-clear"', danger: true }])}`)}
      <div data-lvroot></div>`;
    const tools = facets.servers.length > 1 ? `<select class="select" data-aserver aria-label="Server"><option value="">All servers</option>${facets.servers.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}</select>` : '';
    viewer = LogViewer.mount(content.querySelector('[data-lvroot]'), {
      key: 'audit', fileName: 'dockgate-audit', tools,
      retention: 'DockGate keeps the newest 10,000 entries',
      empty: 'Nothing recorded yet.',
      onTools(el) { serverSel = el.querySelector('[data-aserver]'); serverSel?.addEventListener('change', () => viewer.reload()); },
      async load(limit) {
        const p = new URLSearchParams({ limit: String(limit) });
        if (serverSel && serverSel.value) p.set('server', serverSel.value);
        const rows = await API.get('/meta/activity?' + p.toString());
        currentRows = rows.slice().reverse(); // oldest first, like every log
        return { rows: currentRows.map(r => {
          let det = r.details || '';
          try { det = JSON.stringify(JSON.parse(det)); } catch (x) { /* plain text */ }
          const server = r.server || 'local';
          return { t: toMs(r.created_at), l: levelOf(r.action), src: r.resource_type || '',
            msg: `${r.action || ''}  ${r.resource_name || r.resource_id || '—'}${server !== 'local' ? `  @${server}` : ''}${r.source_ip ? `  from ${r.source_ip}` : ''}${det ? `  · ${det.length > 300 ? det.slice(0, 300) + '…' : det}` : ''}`,
            meta: { Server: server, Action: r.action, Resource: r.resource_name || r.resource_id || '', 'Source IP': r.source_ip || '', Details: r.details || '' } };
        }) };
      },
    });

    document.getElementById('audit-export')?.addEventListener('click', () => {
      if (!currentRows.length) { showToast('No records to export', 'warning'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([rowsToCsv(currentRows)], { type: 'text/csv;charset=utf-8' }));
      a.download = `dockgate-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    });
    document.getElementById('audit-clear')?.addEventListener('click', () => {
      showDeleteConfirm('Clear audit log', { message: 'All audit records will be deleted. Continue?', phrase: 'delete', onConfirm: async () => {
        try { await API.del('/meta/activity'); showToast('Audit log cleared'); viewer.reload(); } catch (err) { showToast(err.message, 'error'); }
      } });
    });
  }

  await render();
});
