// File Manager page (Phase 2) — browse/upload/download/mkdir/rename/delete on the ACTIVE remote SSH
// server (SFTP). For Local, it shows a "switch to a remote server" notice (Phase 3 deferred).
Router.register('files', async (content) => {
  let ctx = { remote: false };
  let cwd = '/';
  const pageNavId = Router._navId;

  function parentOf(p) {
    if (!p || p === '/') return '/';
    const i = p.replace(/\/$/, '').lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  function header() {
    const sub = ctx.remote
      ? `Browse & manage files on <strong>${escapeHtml(ctx.host || ctx.serverId)}</strong> over SSH`
      : 'Server file manager';
    return `<div class="page-header mb-3"><div><div class="page-title">Files</div><div class="page-subtitle">${sub}</div></div></div>`;
  }

  async function render() {
    try { ctx = await API.get('/files/context'); } catch (e) { ctx = { remote: false }; }
    if (!Router.isActiveNav(pageNavId)) return;

    if (!ctx.remote) {
      content.innerHTML = `${header()}
        <div class="empty-state" style="padding:50px;text-align:center">
          <span class="nav-item-icon" style="width:48px;height:48px;opacity:.3;margin:0 auto 12px">${Icons.folder}</span>
          <h3>No remote server selected</h3>
          <p>The file manager works on a <strong>remote SSH server</strong>. Switch to one in the header (or add a server in <strong>Settings → Servers</strong>). Local host browsing is not enabled.</p>
        </div>`;
      return;
    }

    content.innerHTML = `${header()}
      <div class="card mb-3" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px">
        <button class="btn btn-secondary btn-sm" id="f-up" title="Up one level">⬆</button>
        <input class="input" id="f-path" value="${escapeHtml(cwd)}" style="flex:1;min-width:200px;font-family:var(--font-mono,monospace)">
        <button class="btn btn-secondary btn-sm" id="f-go">Go</button>
        <button class="btn btn-secondary btn-sm" id="f-refresh" title="Refresh">${Icons.refresh}</button>
        <button class="btn btn-secondary btn-sm" id="f-mkdir">+ Folder</button>
        <button class="btn btn-primary btn-sm" id="f-upload">⬆ Upload</button>
        <input type="file" id="f-file" style="display:none">
      </div>
      <div class="table-wrapper"><table>
        <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody id="f-tbody"><tr><td colspan="4" class="text-muted" style="padding:14px">Loading…</td></tr></tbody>
      </table></div>`;

    document.getElementById('f-up').addEventListener('click', () => { cwd = parentOf(cwd); list(); });
    document.getElementById('f-refresh').addEventListener('click', list);
    document.getElementById('f-go').addEventListener('click', () => { cwd = document.getElementById('f-path').value.trim() || '/'; list(); });
    document.getElementById('f-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { cwd = e.target.value.trim() || '/'; list(); } });
    document.getElementById('f-mkdir').addEventListener('click', async () => {
      const name = prompt('New folder name:');
      if (!name || !name.trim()) return;
      try { await API.post('/files/mkdir', { path: cwd, name: name.trim() }); showToast('Folder created'); list(); }
      catch (e) { showToast(e.message, 'error', 9000); }
    });
    const fileInput = document.getElementById('f-file');
    document.getElementById('f-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const btn = document.getElementById('f-upload');
      btn.disabled = true; btn.textContent = 'Uploading…';
      try {
        const r = await fetch(`/api/files/upload?path=${encodeURIComponent(cwd)}&name=${encodeURIComponent(f.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
        showToast(`Uploaded ${f.name}`); list();
      } catch (e) { showToast(e.message, 'error', 9000); }
      finally { btn.disabled = false; btn.innerHTML = '⬆ Upload'; fileInput.value = ''; }
    });

    list();
  }

  async function list() {
    const tbody = document.getElementById('f-tbody');
    if (!tbody) return;
    try {
      const d = await API.get(`/files?path=${encodeURIComponent(cwd)}`);
      cwd = d.path;
      const pathInput = document.getElementById('f-path');
      if (pathInput) pathInput.value = cwd;
      tbody.innerHTML = d.entries.length ? d.entries.map(e => {
        const isDir = e.type === 'dir';
        const icon = isDir ? '📁' : (e.type === 'link' ? '🔗' : '📄');
        const nameCell = isDir
          ? `<a href="#" data-cd="${escapeHtml(e.name)}" class="td-name">${icon} ${escapeHtml(e.name)}</a>`
          : `<span class="td-name">${icon} ${escapeHtml(e.name)}</span>`;
        return `<tr>
          <td>${nameCell}</td>
          <td class="text-xs text-muted">${isDir ? '' : formatBytes(e.size)}</td>
          <td class="text-xs text-muted">${e.mtime ? formatTime(e.mtime) : ''}</td>
          <td style="text-align:right"><div class="td-actions">
            ${isDir ? '' : `<button class="btn btn-xs btn-secondary" data-dl="${escapeHtml(e.name)}" title="Download">${Icons.download || '↓'}</button>`}
            <button class="btn btn-xs btn-secondary" data-rn="${escapeHtml(e.name)}">Rename</button>
            <button class="btn btn-xs btn-ghost text-danger" data-rm="${escapeHtml(e.name)}" data-isdir="${isDir ? 1 : 0}">${Icons.trash}</button>
          </div></td></tr>`;
      }).join('') : '<tr><td colspan="4" class="text-muted" style="padding:14px">Empty directory.</td></tr>';
      wireRows();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-danger" style="padding:14px">${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function joinPath(name) { return (cwd === '/' ? '' : cwd) + '/' + name; }

  function wireRows() {
    const tbody = document.getElementById('f-tbody');
    tbody.querySelectorAll('[data-cd]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); cwd = joinPath(a.dataset.cd); list(); }));
    tbody.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => {
      const url = `/api/files/download?path=${encodeURIComponent(joinPath(b.dataset.dl))}`;
      const a = document.createElement('a'); a.href = url; a.download = b.dataset.dl; document.body.appendChild(a); a.click(); a.remove();
    }));
    tbody.querySelectorAll('[data-rn]').forEach(b => b.addEventListener('click', async () => {
      const next = prompt('Rename to:', b.dataset.rn);
      if (!next || next.trim() === b.dataset.rn) return;
      try { await API.post('/files/rename', { oldPath: joinPath(b.dataset.rn), newPath: joinPath(next.trim().replace(/[/\\]/g, '')) }); showToast('Renamed'); list(); }
      catch (e) { showToast(e.message, 'error', 9000); }
    }));
    tbody.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      const isDir = b.dataset.isdir === '1';
      showConfirm('Delete', `Delete ${isDir ? 'folder' : 'file'} "${escapeHtml(b.dataset.rm)}"?${isDir ? ' (must be empty)' : ''}`, async () => {
        try { await API.del(`/files?path=${encodeURIComponent(joinPath(b.dataset.rm))}&isDir=${isDir ? 1 : 0}`); showToast('Deleted'); list(); }
        catch (e) { showToast(e.message, 'error', 9000); }
      }, true);
    }));
  }

  await render();
});
