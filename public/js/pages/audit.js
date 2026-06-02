// Audit Log Page — history of all operations performed on DockGate
// Filter (server / type / action / search / limit) + CSV export + clearing.
// Since there is no auth, this is a "what was done + from where (IP)" audit, not "who did it".
Router.register('audit', async (content) => {
  let currentRows = [];

  // SQLite UTC datetime ("YYYY-MM-DD HH:MM:SS") → local readable
  function fmtTime(s) {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleString();
  }

  function actionClass(action = '') {
    const a = action.toLowerCase();
    if (/(start|create|add|unpause|build_success|switch)/.test(a)) return 'badge-running';
    if (/(stop|die|pause|restart|terminal)/.test(a)) return 'badge-created';
    if (/(remove|delete|destroy|prune|clear|kill|build_failed|cleared)/.test(a)) return 'badge-dead';
    return 'badge-created';
  }

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

  function buildQuery() {
    const p = new URLSearchParams();
    const server = document.getElementById('audit-server')?.value;
    const type = document.getElementById('audit-type')?.value;
    const action = document.getElementById('audit-action')?.value;
    const q = document.getElementById('audit-search')?.value.trim();
    const limit = document.getElementById('audit-limit')?.value || '200';
    if (server) p.set('server', server);
    if (type) p.set('type', type);
    if (action) p.set('action', action);
    if (q) p.set('q', q);
    p.set('limit', limit);
    return p.toString();
  }

  async function load() {
    const tbody = document.getElementById('audit-tbody');
    const empty = document.getElementById('audit-empty');
    if (!tbody) return;
    try {
      const rows = await API.get('/meta/activity?' + buildQuery());
      currentRows = rows;
      tbody.innerHTML = rows.map(r => {
        const det = r.details ? escapeHtml(String(r.details)) : '';
        return `
          <tr>
            <td class="text-sm text-muted" style="white-space:nowrap">${fmtTime(r.created_at)}</td>
            <td>${r.server && r.server !== 'local' ? `<span class="badge badge-created">🔐 ${escapeHtml(r.server)}</span>` : '<span class="text-muted text-sm">🖥 local</span>'}</td>
            <td class="td-mono text-sm">${escapeHtml(r.resource_type || '')}</td>
            <td><span class="badge ${actionClass(r.action)}">${escapeHtml(r.action || '')}</span></td>
            <td class="td-name text-sm">${escapeHtml(r.resource_name || r.resource_id || '—')}</td>
            <td class="td-mono text-xs text-muted">${escapeHtml(r.source_ip || '—')}</td>
            <td class="text-xs text-muted" style="max-width:280px;white-space:normal;word-break:break-all" title="${det}">${det.length > 120 ? det.slice(0, 120) + '…' : det}</td>
          </tr>`;
      }).join('');
      if (empty) empty.style.display = rows.length ? 'none' : 'block';
    } catch (err) {
      showToast('Failed to load audit log: ' + err.message, 'error');
    }
  }

  async function render() {
    // Distinct values for the filter dropdowns
    let facets = { types: [], actions: [], servers: [] };
    try { facets = await API.get('/meta/activity/facets'); } catch (e) {}

    const opt = (v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;

    content.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Audit Log</div>
          <div class="page-subtitle">Operations performed on DockGate — what, on which host, from where (IP)</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="audit-refresh">${Icons.refresh} Refresh</button>
          <button class="btn btn-secondary" id="audit-export">${Icons.download} Export CSV</button>
          <button class="btn btn-danger" id="audit-clear">${Icons.trash} Clear</button>
        </div>
      </div>

      <div class="filter-bar" style="flex-wrap:wrap;gap:8px;align-items:center">
        <div class="search-input" style="flex:1;min-width:200px">${Icons.search}<input id="audit-search" placeholder="Search — resource, action, details, IP..."></div>
        <div class="select-wrapper"><select class="select" id="audit-server"><option value="">All servers</option>${facets.servers.map(opt).join('')}</select></div>
        <div class="select-wrapper"><select class="select" id="audit-type"><option value="">All types</option>${facets.types.map(opt).join('')}</select></div>
        <div class="select-wrapper"><select class="select" id="audit-action"><option value="">All actions</option>${facets.actions.map(opt).join('')}</select></div>
        <div class="select-wrapper"><select class="select" id="audit-limit"><option>200</option><option>500</option><option>1000</option></select></div>
      </div>

      <div class="table-wrapper">
        <table>
          <thead><tr><th>Time</th><th>Server</th><th>Type</th><th>Action</th><th>Resource</th><th>Source IP</th><th>Details</th></tr></thead>
          <tbody id="audit-tbody"></tbody>
        </table>
        <div id="audit-empty" class="empty-state" style="padding:40px;display:none">No audit records</div>
      </div>
    `;

    // Filter changes → reload
    ['audit-server', 'audit-type', 'audit-action', 'audit-limit'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', load);
    });
    // Search — debounce
    let searchTimer = null;
    document.getElementById('audit-search')?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 300);
    });

    document.getElementById('audit-refresh')?.addEventListener('click', load);

    document.getElementById('audit-export')?.addEventListener('click', () => {
      if (!currentRows.length) { showToast('No records to export', 'warning'); return; }
      const csv = rowsToCsv(currentRows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dockgate-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('audit-clear')?.addEventListener('click', () => {
      showConfirm('Clear audit log', 'All audit records will be deleted. Continue?', async () => {
        try {
          await API.del('/meta/activity');
          showToast('Audit log cleared');
          render();
        } catch (err) { showToast(err.message, 'error'); }
      }, true);
    });

    await load();
  }

  await render();
});
