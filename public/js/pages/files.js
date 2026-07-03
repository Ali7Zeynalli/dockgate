// File Manager page — browse / upload / download / edit / copy / move / delete on the ACTIVE remote SSH
// server (SFTP for listing & transfer, SSH for copy/move/recursive-delete/archive). For Local it shows a
// "switch to a remote server" notice (local browsing not enabled yet).
Router.register('files', async (content) => {
  let ctx = { remote: false };
  let cwd = '/';
  let clipboard = null;            // { mode:'copy'|'cut', items:[{path,name,isDir}] }
  const selected = new Map();      // name -> { isDir } for rows ticked in the current dir
  const pageNavId = Router._navId;

  function parentOf(p) {
    if (!p || p === '/') return '/';
    const i = p.replace(/\/$/, '').lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  function joinPath(name) { return (cwd === '/' ? '' : cwd) + '/' + name; }
  // Recognized archive formats → friendly label (drives the 📦 Extract row action).
  function archiveKind(name) {
    const n = (name || '').toLowerCase();
    if (/\.(tar\.gz|tgz)$/.test(n)) return 'tar.gz';
    if (/\.(tar\.bz2|tbz2)$/.test(n)) return 'tar.bz2';
    if (/\.(tar\.xz|txz)$/.test(n)) return 'tar.xz';
    if (/\.tar$/.test(n)) return 'tar';
    if (/\.zip$/.test(n)) return 'zip';
    if (/\.gz$/.test(n)) return 'gz';
    return null;
  }

  function header() {
    const sub = ctx.remote
      ? `Browse & manage files on <strong>${escapeHtml(ctx.host || ctx.serverId)}</strong> over SSH`
      : 'Server file manager';
    return `<div class="page-header mb-3"><div><div class="page-title">Files</div><div class="page-subtitle">${sub}</div></div></div>`;
  }

  // Clickable breadcrumb for the current path.
  function breadcrumb() {
    const segs = cwd.split('/').filter(Boolean);
    let acc = '';
    const crumbs = [`<a href="#" data-crumb="/" class="fm-crumb" style="text-decoration:none" title="Root">🖥</a>`];
    segs.forEach((s) => { acc += '/' + s; crumbs.push(`<a href="#" data-crumb="${escapeHtml(acc)}" class="fm-crumb" style="text-decoration:none">${escapeHtml(s)}</a>`); });
    return crumbs.join('<span style="opacity:.35;margin:0 2px">/</span>');
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
      <div class="card mb-2" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px">
        <button class="btn btn-secondary btn-sm" id="f-up" title="Up one level">⬆</button>
        <div id="f-crumbs" style="flex:1;min-width:200px;font-family:var(--font-mono,monospace);font-size:12.5px;overflow-x:auto;white-space:nowrap"></div>
        <button class="btn btn-secondary btn-sm" id="f-refresh" title="Refresh">${Icons.refresh}</button>
        <button class="btn btn-secondary btn-sm" id="f-mkdir">+ Folder</button>
        <button class="btn btn-secondary btn-sm" id="f-newfile">+ File</button>
        <button class="btn btn-primary btn-sm" id="f-upload">⬆ Upload</button>
        <button class="btn btn-secondary btn-sm" id="f-explorer" title="Two-pane transfer between your computer and this server (Windows/macOS/Linux)">⇆ Explorer</button>
        <button class="btn btn-secondary btn-sm" id="f-paste" style="display:none"></button>
        <input type="file" id="f-file" style="display:none">
      </div>
      <div class="card mb-2" id="f-bulk" style="display:none;align-items:center;gap:8px;padding:8px 14px;background:var(--accent-dim)">
        <span class="text-sm" id="f-bulk-count" style="font-weight:600"></span>
        <div style="flex:1"></div>
        <button class="btn btn-xs btn-secondary" id="f-bulk-copy">📋 Copy</button>
        <button class="btn btn-xs btn-secondary" id="f-bulk-cut">✂ Cut</button>
        <button class="btn btn-xs btn-ghost text-danger" id="f-bulk-del">${Icons.trash} Delete</button>
        <button class="btn btn-xs btn-ghost" id="f-bulk-clear">Clear</button>
      </div>
      <div class="table-wrapper"><table>
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="f-all" title="Select all"></th>
          <th>Name</th><th>Size</th><th>Modified</th><th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="f-tbody"><tr><td colspan="5" class="text-muted" style="padding:14px">Loading…</td></tr></tbody>
      </table></div>`;

    wireToolbar();
    list();
  }

  function wireToolbar() {
    document.getElementById('f-up').addEventListener('click', () => { cwd = parentOf(cwd); list(); });
    document.getElementById('f-refresh').addEventListener('click', list);
    document.getElementById('f-mkdir').addEventListener('click', async () => {
      const name = prompt('New folder name:');
      if (!name || !name.trim()) return;
      try { await API.post('/files/mkdir', { path: cwd, name: name.trim() }); showToast('Folder created'); list(); }
      catch (e) { showToast(e.message, 'error', 9000); }
    });
    document.getElementById('f-newfile').addEventListener('click', async () => {
      const name = prompt('New file name:');
      if (!name || !name.trim()) return;
      const clean = name.trim().replace(/[/\\]/g, '');
      try { await API.post('/files/write', { path: joinPath(clean), content: '' }); showToast('File created'); list(); openEditor(clean); }
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
    document.getElementById('f-paste').addEventListener('click', doPaste);
    document.getElementById('f-all').addEventListener('change', (e) => {
      const tbody = document.getElementById('f-tbody');
      tbody.querySelectorAll('[data-sel]').forEach(cb => {
        cb.checked = e.target.checked;
        const name = cb.dataset.sel;
        if (e.target.checked) selected.set(name, { isDir: cb.dataset.isdir === '1' }); else selected.delete(name);
      });
      updateBulk();
    });
    document.getElementById('f-bulk-clear').addEventListener('click', () => { selected.clear(); list(); });
    document.getElementById('f-bulk-copy').addEventListener('click', () => setClipboard('copy'));
    document.getElementById('f-bulk-cut').addEventListener('click', () => setClipboard('cut'));
    document.getElementById('f-bulk-del').addEventListener('click', bulkDelete);
    document.getElementById('f-explorer').addEventListener('click', openExplorer);
  }

  function renderCrumbs() { const el = document.getElementById('f-crumbs'); if (!el) return; el.innerHTML = breadcrumb();
    el.querySelectorAll('[data-crumb]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); cwd = a.dataset.crumb; list(); })); }

  function updatePasteBtn() {
    const btn = document.getElementById('f-paste'); if (!btn) return;
    if (clipboard && clipboard.items.length) { btn.style.display = ''; btn.textContent = `📋 Paste ${clipboard.items.length} (${clipboard.mode})`; }
    else btn.style.display = 'none';
  }
  function updateBulk() {
    const bar = document.getElementById('f-bulk'); if (!bar) return;
    if (selected.size) { bar.style.display = 'flex'; document.getElementById('f-bulk-count').textContent = `${selected.size} selected`; }
    else bar.style.display = 'none';
  }

  function setClipboard(mode) {
    const items = [...selected.entries()].map(([name, v]) => ({ path: joinPath(name), name, isDir: v.isDir }));
    if (!items.length) return;
    clipboard = { mode, items };
    showToast(`${mode === 'copy' ? 'Copied' : 'Cut'} ${items.length} item(s) — go to a folder and Paste`, 'info', 4000);
    selected.clear(); list(); updatePasteBtn();
  }

  async function doPaste() {
    if (!clipboard || !clipboard.items.length) return;
    const mode = clipboard.mode;
    const btn = document.getElementById('f-paste'); if (btn) { btn.disabled = true; btn.textContent = 'Pasting…'; }
    let ok = 0, fail = 0;
    for (const it of clipboard.items) {
      try {
        if (mode === 'copy') await API.post('/files/copy', { src: it.path, destDir: cwd });
        else await API.post('/files/move', { src: it.path, destDir: cwd });
        ok++;
      } catch (e) { fail++; showToast(`${it.name}: ${e.message}`, 'error', 9000); }
    }
    if (mode === 'cut') clipboard = null;   // a cut is consumed once pasted
    showToast(`${mode === 'copy' ? 'Copied' : 'Moved'} ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'warning' : 'success');
    list(); updatePasteBtn();
  }

  function bulkDelete() {
    const items = [...selected.entries()].map(([name, v]) => ({ name, isDir: v.isDir }));
    if (!items.length) return;
    const anyDir = items.some(i => i.isDir);
    showDeleteConfirm('Delete selected', { message: `Delete <strong>${items.length}</strong> item(s)?${anyDir ? ' Folders are removed with <strong>all their contents</strong>.' : ''} This cannot be undone.`, phrase: 'delete', onConfirm: async () => {
      let ok = 0, fail = 0;
      for (const it of items) {
        try { await API.del(`/files?path=${encodeURIComponent(joinPath(it.name))}&isDir=${it.isDir ? 1 : 0}&recursive=${it.isDir ? 1 : 0}`); ok++; }
        catch (e) { fail++; showToast(`${it.name}: ${e.message}`, 'error', 9000); }
      }
      showToast(`Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'warning' : 'success');
      selected.clear(); list();
    } });
  }

  async function list() {
    const tbody = document.getElementById('f-tbody');
    if (!tbody) return;
    selected.clear(); updateBulk(); updatePasteBtn();
    const allCb = document.getElementById('f-all'); if (allCb) allCb.checked = false;
    try {
      const d = await API.get(`/files?path=${encodeURIComponent(cwd)}`);
      cwd = d.path;
      renderCrumbs();
      tbody.innerHTML = d.entries.length ? d.entries.map(e => {
        const isDir = e.type === 'dir';
        const icon = isDir ? '📁' : (e.type === 'link' ? '🔗' : '📄');
        const nm = escapeHtml(e.name);
        const nameCell = isDir
          ? `<a href="#" data-cd="${nm}" class="td-name">${icon} ${nm}</a>`
          : `<a href="#" data-edit="${nm}" class="td-name" title="Open / edit">${icon} ${nm}</a>`;
        return `<tr>
          <td><input type="checkbox" data-sel="${nm}" data-isdir="${isDir ? 1 : 0}"></td>
          <td>${nameCell}</td>
          <td class="text-xs text-muted">${isDir ? '' : formatBytes(e.size)}</td>
          <td class="text-xs text-muted">${e.mtime ? formatTime(e.mtime) : ''}</td>
          <td style="text-align:right"><div class="td-actions">
            ${isDir
              ? `<button class="btn btn-xs btn-secondary" data-dlf="${nm}" title="Download folder (.tar.gz)">${Icons.download || '↓'}</button>`
              : `<button class="btn btn-xs btn-secondary" data-edit="${nm}" title="Edit">✎</button>
                 <button class="btn btn-xs btn-secondary" data-dl="${nm}" title="Download">${Icons.download || '↓'}</button>
                 ${archiveKind(e.name) ? `<button class="btn btn-xs btn-secondary" data-extract="${nm}" title="Extract archive">📦</button>` : ''}`}
            <button class="btn btn-xs btn-ghost" data-cp="${nm}" data-isdir="${isDir ? 1 : 0}" title="Copy">📋</button>
            <button class="btn btn-xs btn-ghost" data-ct="${nm}" data-isdir="${isDir ? 1 : 0}" title="Cut">✂</button>
            <button class="btn btn-xs btn-secondary" data-rn="${nm}">Rename</button>
            <button class="btn btn-xs btn-ghost text-danger" data-rm="${nm}" data-isdir="${isDir ? 1 : 0}" title="Delete">${Icons.trash}</button>
          </div></td></tr>`;
      }).join('') : '<tr><td colspan="5" class="text-muted" style="padding:14px">Empty directory.</td></tr>';
      wireRows();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-danger" style="padding:14px">${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function wireRows() {
    const tbody = document.getElementById('f-tbody');
    tbody.querySelectorAll('[data-cd]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); cwd = joinPath(a.dataset.cd); list(); }));
    tbody.querySelectorAll('[data-edit]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); openEditor(a.dataset.edit); }));
    tbody.querySelectorAll('[data-sel]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) selected.set(cb.dataset.sel, { isDir: cb.dataset.isdir === '1' }); else selected.delete(cb.dataset.sel);
      updateBulk();
    }));
    tbody.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => download(`/api/files/download?path=${encodeURIComponent(joinPath(b.dataset.dl))}`, b.dataset.dl)));
    tbody.querySelectorAll('[data-dlf]').forEach(b => b.addEventListener('click', () => download(`/api/files/download-folder?path=${encodeURIComponent(joinPath(b.dataset.dlf))}`, b.dataset.dlf + '.tar.gz')));
    tbody.querySelectorAll('[data-extract]').forEach(b => b.addEventListener('click', () => openExtract(b.dataset.extract)));
    tbody.querySelectorAll('[data-cp]').forEach(b => b.addEventListener('click', () => { clipboard = { mode: 'copy', items: [{ path: joinPath(b.dataset.cp), name: b.dataset.cp, isDir: b.dataset.isdir === '1' }] }; showToast(`Copied "${b.dataset.cp}" — go to a folder and Paste`, 'info', 4000); updatePasteBtn(); }));
    tbody.querySelectorAll('[data-ct]').forEach(b => b.addEventListener('click', () => { clipboard = { mode: 'cut', items: [{ path: joinPath(b.dataset.ct), name: b.dataset.ct, isDir: b.dataset.isdir === '1' }] }; showToast(`Cut "${b.dataset.ct}" — go to a folder and Paste`, 'info', 4000); updatePasteBtn(); }));
    tbody.querySelectorAll('[data-rn]').forEach(b => b.addEventListener('click', async () => {
      const next = prompt('Rename to:', b.dataset.rn);
      if (!next || next.trim() === b.dataset.rn) return;
      try { await API.post('/files/rename', { oldPath: joinPath(b.dataset.rn), newPath: joinPath(next.trim().replace(/[/\\]/g, '')) }); showToast('Renamed'); list(); }
      catch (e) { showToast(e.message, 'error', 9000); }
    }));
    tbody.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      const isDir = b.dataset.isdir === '1';
      const msg = isDir
        ? `Delete folder "<strong>${escapeHtml(b.dataset.rm)}</strong>" and <strong>all its contents</strong>? This cannot be undone.`
        : `Delete file "<strong>${escapeHtml(b.dataset.rm)}</strong>"?`;
      showDeleteConfirm('Delete', { message: msg, phrase: b.dataset.rm, onConfirm: async () => {
        try { await API.del(`/files?path=${encodeURIComponent(joinPath(b.dataset.rm))}&isDir=${isDir ? 1 : 0}&recursive=${isDir ? 1 : 0}`); showToast('Deleted'); list(); }
        catch (e) { showToast(e.message, 'error', 9000); }
      } });
    }));
  }

  function download(url, filename) {
    const a = document.createElement('a'); a.href = url; if (filename) a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // In-browser text editor for a file in the current dir.
  async function openEditor(name) {
    const p = joinPath(name);
    let data;
    try { data = await API.get(`/files/read?path=${encodeURIComponent(p)}`); }
    catch (e) { showToast(e.message, 'error', 9000); return; }
    if (data.isBinary) { showToast(`"${name}" is binary or larger than 2 MB — can't edit here. Download it instead.`, 'warning', 8000); return; }
    const m = showModal(`Edit — ${escapeHtml(name)}`, `
      <div class="text-xs text-muted" style="margin-bottom:6px">${escapeHtml(p)} · ${formatBytes(data.size || 0)}</div>
      <textarea id="fe-text" class="input" spellcheck="false" style="width:100%;height:55vh;font-family:var(--font-mono,monospace);font-size:12px;white-space:pre;overflow:auto"></textarea>
      <div style="margin-top:10px;display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-secondary" id="fe-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="fe-save" type="button">Save</button>
      </div>`, []);
    const ta = m.overlay.querySelector('#fe-text');
    ta.value = data.content || '';
    m.overlay.querySelector('#fe-cancel').onclick = () => m.close();
    m.overlay.querySelector('#fe-save').onclick = async (e) => {
      const b = e.target; b.disabled = true; b.textContent = 'Saving…';
      try { await API.post('/files/write', { path: p, content: ta.value }); showToast('Saved'); m.close(); list(); }
      catch (err) { showToast(err.message, 'error', 9000); b.disabled = false; b.textContent = 'Save'; }
    };
  }

  // Extract an archive on the remote host. Default → a new subfolder named after the archive (safest).
  function openExtract(name) {
    const fmt = archiveKind(name);
    const stem = name.replace(/\.(tar\.(gz|bz2|xz)|tgz|tbz2|txz|tar|zip|gz)$/i, '') || 'extracted';
    const m = showModal(`Extract — ${escapeHtml(name)}`, `
      ${serverContextBanner()}
      <div class="text-sm" style="margin-bottom:8px">Detected format: <strong>${escapeHtml(fmt || '?')}</strong></div>
      <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:8px">
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="radio" name="ex-dest" value="sub" checked> Into a new subfolder: <code>${escapeHtml(stem)}/</code></label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="radio" name="ex-dest" value="here"> Here (current folder)</label>
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" id="ex-overwrite"> Overwrite files that already exist</label>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" id="ex-del"> Delete the archive after a successful extract</label>
      <div class="text-xs text-muted" style="margin-top:8px">Extracted on the server — path traversal and out-of-tree symlinks are blocked.</div>
      <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-secondary" id="ex-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="ex-go" type="button">📦 Extract</button>
      </div>`, []);
    m.overlay.querySelector('#ex-cancel').onclick = () => m.close();
    m.overlay.querySelector('#ex-go').onclick = async (e) => {
      const b = e.target; b.disabled = true; b.textContent = 'Extracting…';
      const here = m.overlay.querySelector('input[name="ex-dest"]:checked').value === 'here';
      const overwrite = m.overlay.querySelector('#ex-overwrite').checked;
      const deleteAfter = m.overlay.querySelector('#ex-del').checked;
      try {
        await API.post('/files/extract', { path: joinPath(name), here, overwrite, deleteAfter });
        showToast(`Extracted "${name}"`, 'success'); m.close(); list();
      } catch (err) { showToast(err.message, 'error', 10000); b.disabled = false; b.textContent = '📦 Extract'; }
    };
  }

  // ── Explorer / Transfer mode ──────────────────────────────────────────────────────────────────
  // Opt-in two-pane view (opens on demand; the default page stays single-pane and unchanged).
  // LEFT  = this remote server: browse + download files/folders TO your computer.
  // RIGHT = your computer: drag-drop or pick files & FOLDERS → upload to the remote folder on the left.
  // Cross-platform by design: uses only browser file APIs (identical on Windows/macOS/Linux) and POSIX
  // ('/') remote paths — a Windows client's back-slashes are normalized so they never reach the host.
  function openExplorer() {
    let rcwd = cwd;                    // remote cwd inside the explorer (starts where you are)
    const staged = [];                 // { file, rel } local items staged for upload (rel is POSIX)
    const madeDirs = new Set();        // remote dirs already created during an upload (avoid re-mkdir)

    const ov = document.createElement('div');
    ov.className = 'fm-explorer-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:1200;background:var(--overlay-bg,rgba(0,0,0,.55));display:flex;padding:2vh 2vw';
    ov.innerHTML = `
      <div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0;padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)">
          <strong style="font-size:15px">⇆ Explorer — your computer ⇄ ${escapeHtml(ctx.host || ctx.serverId || 'server')}</strong>
          <div style="flex:1"></div>
          <button class="btn btn-secondary btn-sm" id="fx-close" type="button">✕ Close</button>
        </div>
        <div style="flex:1;display:flex;min-height:0">
          <div style="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border)">
              <span class="text-xs text-muted" style="font-weight:700;letter-spacing:.5px">REMOTE</span>
              <button class="btn btn-xs btn-secondary" id="fx-up" type="button" title="Up one level">⬆</button>
              <div id="fx-crumbs" style="flex:1;min-width:0;font-family:var(--font-mono,monospace);font-size:12px;overflow-x:auto;white-space:nowrap"></div>
            </div>
            <div id="fx-remote" style="flex:1;overflow:auto;min-height:0"></div>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border)">
              <span class="text-xs text-muted" style="font-weight:700;letter-spacing:.5px">YOUR COMPUTER</span>
              <div style="flex:1"></div>
              <button class="btn btn-xs btn-secondary" id="fx-pick" type="button">Choose files</button>
              <button class="btn btn-xs btn-secondary" id="fx-pickdir" type="button">Choose folder</button>
            </div>
            <div id="fx-drop" style="flex:1;overflow:auto;min-height:0;padding:10px"></div>
            <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px">
              <span class="text-xs text-muted" id="fx-info" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
              <button class="btn btn-xs btn-ghost" id="fx-clear" type="button">Clear</button>
              <button class="btn btn-primary btn-sm" id="fx-upload" type="button" disabled>⬆ Upload → remote</button>
            </div>
          </div>
        </div>
      </div>
      <input type="file" id="fx-file" multiple style="display:none">
      <input type="file" id="fx-dir" webkitdirectory multiple style="display:none">`;
    document.body.appendChild(ov);
    const $ = (id) => ov.querySelector('#' + id);

    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); list(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('fx-close').onclick = close;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

    function updateInfo() {
      $('fx-info').textContent = staged.length ? `${staged.length} item(s) → ${rcwd}` : 'Drag files/folders here, or use “Choose” above.';
      $('fx-upload').disabled = !staged.length;
    }

    // ---- LEFT: remote browser (navigate + download to your computer) ----
    async function renderRemote() {
      const segs = rcwd.split('/').filter(Boolean); let acc = '';
      const cr = ['<a href="#" data-fxcrumb="/" style="text-decoration:none" title="Root">🖥</a>'];
      segs.forEach((s) => { acc += '/' + s; cr.push(`<a href="#" data-fxcrumb="${escapeHtml(acc)}" style="text-decoration:none">${escapeHtml(s)}</a>`); });
      $('fx-crumbs').innerHTML = cr.join('<span style="opacity:.35;margin:0 2px">/</span>');
      $('fx-crumbs').querySelectorAll('[data-fxcrumb]').forEach(a => a.onclick = (e) => { e.preventDefault(); rcwd = a.dataset.fxcrumb; renderRemote(); });
      const body = $('fx-remote');
      body.innerHTML = '<div class="text-muted" style="padding:14px">Loading…</div>';
      try {
        const d = await API.get(`/files?path=${encodeURIComponent(rcwd)}`);
        rcwd = d.path;
        body.innerHTML = d.entries.length ? d.entries.map((e) => {
          const isDir = e.type === 'dir';
          const icon = isDir ? '📁' : (e.type === 'link' ? '🔗' : '📄');
          const nm = escapeHtml(e.name);
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--border)">
            ${isDir ? `<a href="#" data-fxcd="${nm}" style="flex:1;min-width:0;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} ${nm}</a>`
                    : `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} ${nm}</span>`}
            <span class="text-xs text-muted">${isDir ? '' : formatBytes(e.size)}</span>
            <button class="btn btn-xs btn-secondary" data-fxdl="${nm}" data-isdir="${isDir ? 1 : 0}" type="button" title="Download to your computer">↓</button>
          </div>`;
        }).join('') : '<div class="text-muted" style="padding:14px">Empty directory.</div>';
        body.querySelectorAll('[data-fxcd]').forEach(a => a.onclick = (e) => { e.preventDefault(); rcwd = (rcwd === '/' ? '' : rcwd) + '/' + a.dataset.fxcd; renderRemote(); });
        body.querySelectorAll('[data-fxdl]').forEach(b => b.onclick = () => {
          const name = b.dataset.fxdl, isDir = b.dataset.isdir === '1';
          const full = (rcwd === '/' ? '' : rcwd) + '/' + name;
          if (isDir) download(`/api/files/download-folder?path=${encodeURIComponent(full)}`, name + '.tar.gz');
          else download(`/api/files/download?path=${encodeURIComponent(full)}`, name);
        });
      } catch (e) { body.innerHTML = `<div class="text-danger" style="padding:14px">${escapeHtml(e.message)}</div>`; }
      updateInfo();
    }
    $('fx-up').onclick = () => { rcwd = parentOf(rcwd); renderRemote(); };

    // ---- RIGHT: your computer (stage files/folders, then upload) ----
    function renderStaged() {
      const el = $('fx-drop');
      el.innerHTML = staged.length
        ? staged.map((s, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-bottom:1px solid var(--border);font-size:12.5px">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.rel)}">${s.rel.includes('/') ? '📁' : '📄'} ${escapeHtml(s.rel)}</span>
            <span class="text-xs text-muted">${formatBytes(s.file.size)}</span>
            <button class="btn btn-xs btn-ghost" data-unstage="${i}" type="button" title="Remove">✕</button></div>`).join('')
        : `<div class="text-muted" style="text-align:center;padding:36px 10px;font-size:13px;border:2px dashed var(--border);border-radius:8px">Drag files or folders here,<br>or use “Choose files / Choose folder”.</div>`;
      el.querySelectorAll('[data-unstage]').forEach(b => b.onclick = () => { staged.splice(+b.dataset.unstage, 1); renderStaged(); });
      updateInfo();
    }
    const fileInput = $('fx-file'), dirInput = $('fx-dir');
    $('fx-pick').onclick = () => fileInput.click();
    $('fx-pickdir').onclick = () => dirInput.click();
    fileInput.onchange = () => { for (const f of fileInput.files) staged.push({ file: f, rel: f.name }); fileInput.value = ''; renderStaged(); };
    dirInput.onchange = () => { for (const f of dirInput.files) staged.push({ file: f, rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }); dirInput.value = ''; renderStaged(); };
    $('fx-clear').onclick = () => { staged.length = 0; renderStaged(); };

    const drop = $('fx-drop');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.style.background = 'var(--accent-dim)'; }));
    ['dragleave', 'dragend'].forEach(ev => drop.addEventListener(ev, () => { drop.style.background = ''; }));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); drop.style.background = '';
      $('fx-info').textContent = 'Reading dropped items…';
      const items = await collectDrop(e.dataTransfer);
      staged.push(...items); renderStaged();
    });

    // Recursively read dropped files/folders (webkitGetAsEntry) → [{file, rel}] with POSIX rel paths.
    function collectDrop(dt) {
      const roots = [];
      if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
        for (const it of dt.items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) roots.push(en); }
      }
      if (!roots.length) return Promise.resolve([...(dt.files || [])].map(f => ({ file: f, rel: f.name })));
      const out = [];
      return Promise.all(roots.map(en => readEntry(en, '', out))).then(() => out);
    }
    function readEntry(entry, prefix, out) {
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file(f => { out.push({ file: f, rel: (prefix ? prefix + '/' : '') + entry.name }); resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
          const reader = entry.createReader(); const kids = [];
          const step = () => reader.readEntries(ents => {
            if (!ents.length) { Promise.all(kids.map(k => readEntry(k, (prefix ? prefix + '/' : '') + entry.name, out))).then(resolve); }
            else { kids.push(...ents); step(); }
          }, () => resolve());
          step();
        } else resolve();
      });
    }

    // Ensure a POSIX relative dir exists under rcwd (walk + mkdir each segment; ignore "already exists").
    async function ensureRemoteDir(relDir) {
      if (!relDir) return;
      let base = rcwd;
      for (const s of relDir.split('/').filter(Boolean)) {
        const full = (base === '/' ? '' : base) + '/' + s;
        if (!madeDirs.has(full)) { try { await API.post('/files/mkdir', { path: base, name: s }); } catch (e) { /* exists / race — the upload will report a real error if the dir is truly missing */ } madeDirs.add(full); }
        base = full;
      }
    }
    async function uploadOne(file, rel) {
      const cut = rel.lastIndexOf('/');
      const relDir = cut > 0 ? rel.slice(0, cut) : '';
      const name = cut >= 0 ? rel.slice(cut + 1) : rel;
      await ensureRemoteDir(relDir);
      const destDir = relDir ? (rcwd === '/' ? '' : rcwd) + '/' + relDir : rcwd;
      const r = await fetch(`/api/files/upload?path=${encodeURIComponent(destDir)}&name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
    }
    $('fx-upload').onclick = async () => {
      if (!staged.length) return;
      $('fx-upload').disabled = true; $('fx-clear').disabled = true;
      madeDirs.clear();
      const total = staged.length; let done = 0, fail = 0;
      for (const s of staged.slice()) {
        $('fx-info').textContent = `Uploading ${done + fail + 1}/${total}: ${s.rel}`;
        try { await uploadOne(s.file, s.rel); done++; } catch (e) { fail++; showToast(`${s.rel}: ${e.message}`, 'error', 8000); }
      }
      showToast(`Uploaded ${done}/${total}${fail ? `, ${fail} failed` : ''}`, fail ? 'warning' : 'success');
      staged.length = 0; $('fx-clear').disabled = false; renderStaged(); renderRemote();
    };

    renderRemote();
    renderStaged();
  }

  await render();
});
