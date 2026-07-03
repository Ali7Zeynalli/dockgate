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
  // Opt-in two-pane view (opens on demand; the default single-pane File Manager stays unchanged).
  // LEFT  = YOUR COMPUTER: a browsable tree of the folder/files you pick or drop (navigate in & out);
  //         tick items → upload into the remote folder on the right, structure preserved.
  // RIGHT = the REMOTE server: browse + download files/folders back to your computer.
  // Cross-platform by design: only browser file APIs (identical on Windows/macOS/Linux and on
  // Chrome/Edge/Firefox/Safari) and POSIX ('/') paths — a Windows client's back-slashes are normalized
  // so they never reach the host. A browser can only show what you pick — not the whole disk.
  function openExplorer() {
    let rcwd = cwd;                    // remote cwd (RIGHT pane)
    let lprefix = '';                  // local virtual cwd (LEFT pane); '' = root, else ends with '/'
    let busy = false;                  // an upload is in flight
    const staged = [];                 // { file, rel } picked/dropped items (rel = POSIX, from a picked root)
    const localSel = new Set();        // ticked LOCAL immediate-child full paths (lprefix + name)
    const remoteSel = new Map();       // ticked REMOTE child name -> isDir (batch download)
    const madeDirs = new Set();        // remote dirs already mkdir-ed during an upload

    // Normalize any path → safe POSIX relative ('\' → '/', drop '.'/empty, reject '..').
    const toRel = (raw) => {
      const segs = String(raw || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
      return (!segs.length || segs.some(s => s === '..')) ? '' : segs.join('/');
    };

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
          <!-- LEFT: YOUR COMPUTER (browsable tree) -->
          <div style="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);flex-wrap:wrap">
              <span class="text-xs text-muted" style="font-weight:700;letter-spacing:.5px">YOUR COMPUTER</span>
              <button class="btn btn-xs btn-secondary" id="fx-lup" type="button" title="Up one level">⬆</button>
              <div id="fx-lcrumbs" style="flex:1;min-width:70px;font-family:var(--font-mono,monospace);font-size:12px;overflow-x:auto;white-space:nowrap"></div>
              <button class="btn btn-xs btn-secondary" id="fx-pick" type="button">Choose files</button>
              <button class="btn btn-xs btn-secondary" id="fx-pickdir" type="button">Choose folder</button>
            </div>
            <div id="fx-local" style="flex:1;overflow:auto;min-height:0;padding:4px"></div>
            <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px">
              <span class="text-xs text-muted" id="fx-info" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
              <button class="btn btn-xs btn-ghost" id="fx-clear" type="button">Clear</button>
              <button class="btn btn-primary btn-sm" id="fx-upload" type="button" disabled>Upload →</button>
            </div>
          </div>
          <!-- RIGHT: REMOTE server -->
          <div style="flex:1;display:flex;flex-direction:column;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border)">
              <span class="text-xs text-muted" style="font-weight:700;letter-spacing:.5px">REMOTE</span>
              <button class="btn btn-xs btn-secondary" id="fx-up" type="button" title="Up one level">⬆</button>
              <div id="fx-crumbs" style="flex:1;min-width:0;font-family:var(--font-mono,monospace);font-size:12px;overflow-x:auto;white-space:nowrap"></div>
            </div>
            <div id="fx-remote" style="flex:1;overflow:auto;min-height:0"></div>
            <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px">
              <span class="text-xs text-muted" id="fx-rinfo" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
              <button class="btn btn-secondary btn-sm" id="fx-download" type="button" disabled>← Download</button>
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
      if (!busy) {
        const sel = localSel.size;
        $('fx-info').textContent = sel ? `${sel} selected → ${rcwd}`
          : staged.length ? `Tick items to upload → ${rcwd}` : 'Pick or drop a folder / files to begin.';
      }
      $('fx-upload').disabled = busy || !staged.length;
      $('fx-rinfo').textContent = remoteSel.size ? `${remoteSel.size} selected → your Downloads` : '';
      $('fx-download').disabled = busy || remoteSel.size === 0;
    }

    // ---- LEFT: your computer — a browsable tree DERIVED from the flat staged[] list ----
    function localChildren(prefix) {
      const dirs = new Map(); const files = [];
      for (const it of staged) {
        if (prefix && !it.rel.startsWith(prefix)) continue;
        const rest = it.rel.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) files.push({ name: rest, isDir: false, size: it.file.size });
        else { const n = rest.slice(0, slash); const d = dirs.get(n) || { count: 0, size: 0 }; d.count++; d.size += it.file.size; dirs.set(n, d); }
      }
      const cmp = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return [...[...dirs].map(([name, d]) => ({ name, isDir: true, count: d.count, size: d.size })).sort(cmp), ...files.sort(cmp)];
    }
    function removeLocal(full, isDir) {
      const keep = staged.filter(it => isDir ? !(it.rel === full || it.rel.startsWith(full + '/')) : it.rel !== full);
      staged.splice(0, staged.length, ...keep);
      for (const k of [...localSel]) if (k === full || k.startsWith(full + '/')) localSel.delete(k);
      renderLocal();
    }
    function renderLocal() {
      const segs = lprefix.split('/').filter(Boolean); let acc = '';
      const cr = ['<a href="#" data-lcrumb="" style="text-decoration:none" title="Picked items">💻</a>'];
      segs.forEach(s => { acc += s + '/'; cr.push(`<a href="#" data-lcrumb="${escapeHtml(acc)}" style="text-decoration:none">${escapeHtml(s)}</a>`); });
      $('fx-lcrumbs').innerHTML = cr.join('<span style="opacity:.35;margin:0 2px">/</span>');
      $('fx-lcrumbs').querySelectorAll('[data-lcrumb]').forEach(a => a.onclick = (e) => { e.preventDefault(); lprefix = a.dataset.lcrumb; localSel.clear(); renderLocal(); });
      $('fx-lup').disabled = !lprefix;
      const el = $('fx-local');
      if (!staged.length) {
        el.innerHTML = `<div class="text-muted" style="text-align:center;padding:34px 12px;font-size:13px;border:2px dashed var(--border);border-radius:8px;margin:6px">Drag a folder or files here, or use “Choose folder / Choose files”.<br><span style="font-size:11px;opacity:.8">A browser only shows what you pick — not your whole disk.</span></div>`;
      } else {
        el.innerHTML = localChildren(lprefix).map(c => {
          const full = lprefix + c.name, fe = escapeHtml(full), nm = escapeHtml(c.name);
          const meta = c.isDir ? `${c.count} item(s) · ${formatBytes(c.size)}` : formatBytes(c.size);
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--border)">
            <input type="checkbox" data-lsel="${fe}" ${localSel.has(full) ? 'checked' : ''}>
            ${c.isDir ? `<a href="#" data-lcd="${nm}" style="flex:1;min-width:0;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📁 ${nm}</a>`
                      : `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${nm}</span>`}
            <span class="text-xs text-muted">${meta}</span>
            <button class="btn btn-xs btn-ghost" data-lrm="${fe}" data-isdir="${c.isDir ? 1 : 0}" type="button" title="Remove">✕</button>
          </div>`;
        }).join('');
      }
      el.querySelectorAll('[data-lcd]').forEach(a => a.onclick = (e) => { e.preventDefault(); lprefix = lprefix + a.dataset.lcd + '/'; localSel.clear(); renderLocal(); });
      el.querySelectorAll('[data-lsel]').forEach(cb => cb.onchange = () => { if (cb.checked) localSel.add(cb.dataset.lsel); else localSel.delete(cb.dataset.lsel); updateInfo(); });
      el.querySelectorAll('[data-lrm]').forEach(b => b.onclick = () => removeLocal(b.dataset.lrm, b.dataset.isdir === '1'));
      updateInfo();
    }
    function addLocal(items) {
      for (const it of items) {
        const rel = toRel(it.rel); if (!rel) continue;
        const i = staged.findIndex(s => s.rel === rel);
        if (i >= 0) staged[i] = { file: it.file, rel }; else staged.push({ file: it.file, rel });
      }
      lprefix = ''; localSel.clear(); renderLocal();
    }
    const fileInput = $('fx-file'), dirInput = $('fx-dir');
    $('fx-pick').onclick = () => fileInput.click();
    $('fx-pickdir').onclick = () => dirInput.click();
    fileInput.onchange = () => { addLocal([...fileInput.files].map(f => ({ file: f, rel: f.name }))); fileInput.value = ''; };
    dirInput.onchange = () => { addLocal([...dirInput.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name }))); dirInput.value = ''; };
    $('fx-lup').onclick = () => { if (!lprefix) return; const s = lprefix.split('/').filter(Boolean); s.pop(); lprefix = s.length ? s.join('/') + '/' : ''; localSel.clear(); renderLocal(); };
    $('fx-clear').onclick = () => { staged.length = 0; localSel.clear(); lprefix = ''; renderLocal(); };

    const dz = $('fx-local');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.style.background = 'var(--accent-dim)'; }));
    ['dragleave', 'dragend'].forEach(ev => dz.addEventListener(ev, () => { dz.style.background = ''; }));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); dz.style.background = '';
      $('fx-info').textContent = 'Reading dropped items…';
      addLocal(await collectDrop(e.dataTransfer));
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
        if (entry.isFile) entry.file(f => { out.push({ file: f, rel: (prefix ? prefix + '/' : '') + entry.name }); resolve(); }, () => resolve());
        else if (entry.isDirectory) {
          const reader = entry.createReader(); const kids = [];
          const step = () => reader.readEntries(ents => {
            if (!ents.length) Promise.all(kids.map(k => readEntry(k, (prefix ? prefix + '/' : '') + entry.name, out))).then(resolve);
            else { kids.push(...ents); step(); }
          }, () => resolve());
          step();
        } else resolve();
      });
    }

    // ---- RIGHT: remote browser (navigate, tick → batch download, per-row download) ----
    function downloadRemote(name, isDir) {
      const full = (rcwd === '/' ? '' : rcwd) + '/' + name;
      if (isDir) download(`/api/files/download-folder?path=${encodeURIComponent(full)}`, name + '.tar.gz');
      else download(`/api/files/download?path=${encodeURIComponent(full)}`, name);
    }
    async function renderRemote() {
      const segs = rcwd.split('/').filter(Boolean); let acc = '';
      const cr = ['<a href="#" data-fxcrumb="/" style="text-decoration:none" title="Root">🖥</a>'];
      segs.forEach((s) => { acc += '/' + s; cr.push(`<a href="#" data-fxcrumb="${escapeHtml(acc)}" style="text-decoration:none">${escapeHtml(s)}</a>`); });
      $('fx-crumbs').innerHTML = cr.join('<span style="opacity:.35;margin:0 2px">/</span>');
      $('fx-crumbs').querySelectorAll('[data-fxcrumb]').forEach(a => a.onclick = (e) => { e.preventDefault(); rcwd = a.dataset.fxcrumb; remoteSel.clear(); renderRemote(); });
      const body = $('fx-remote');
      body.innerHTML = '<div class="text-muted" style="padding:14px">Loading…</div>';
      try {
        const d = await API.get(`/files?path=${encodeURIComponent(rcwd)}`);
        rcwd = d.path;
        body.innerHTML = d.entries.length ? d.entries.map((e) => {
          const isDir = e.type === 'dir';
          const icon = isDir ? '📁' : (e.type === 'link' ? '🔗' : '📄');
          const nm = escapeHtml(e.name);
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--border)">
            <input type="checkbox" data-rsel="${nm}" data-isdir="${isDir ? 1 : 0}" ${remoteSel.has(e.name) ? 'checked' : ''}>
            ${isDir ? `<a href="#" data-fxcd="${nm}" style="flex:1;min-width:0;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} ${nm}</a>`
                    : `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} ${nm}</span>`}
            <span class="text-xs text-muted">${isDir ? '' : formatBytes(e.size)}</span>
            <button class="btn btn-xs btn-secondary" data-fxdl="${nm}" data-isdir="${isDir ? 1 : 0}" type="button" title="Download to your computer">↓</button>
          </div>`;
        }).join('') : '<div class="text-muted" style="padding:14px">Empty directory.</div>';
        body.querySelectorAll('[data-fxcd]').forEach(a => a.onclick = (e) => { e.preventDefault(); rcwd = (rcwd === '/' ? '' : rcwd) + '/' + a.dataset.fxcd; remoteSel.clear(); renderRemote(); });
        body.querySelectorAll('[data-rsel]').forEach(cb => cb.onchange = () => { if (cb.checked) remoteSel.set(cb.dataset.rsel, cb.dataset.isdir === '1'); else remoteSel.delete(cb.dataset.rsel); updateInfo(); });
        body.querySelectorAll('[data-fxdl]').forEach(b => b.onclick = () => downloadRemote(b.dataset.fxdl, b.dataset.isdir === '1'));
      } catch (e) { body.innerHTML = `<div class="text-danger" style="padding:14px">${escapeHtml(e.message)}</div>`; }
      updateInfo();
    }
    $('fx-up').onclick = () => { rcwd = parentOf(rcwd); remoteSel.clear(); renderRemote(); };
    $('fx-download').onclick = async () => {
      const items = [...remoteSel.entries()];
      if (!items.length) return;
      for (let i = 0; i < items.length; i++) {
        downloadRemote(items[i][0], items[i][1]);
        if (i < items.length - 1) await new Promise(r => setTimeout(r, 400)); // dodge multi-download throttling
      }
      showToast(`Downloading ${items.length} item(s) to your Downloads…`, 'info', 4000);
    };

    // ---- Upload: structure-preserving into the remote cwd (what-you-see-uploads-here) ----
    async function ensureRemoteDir(base, relDir) {
      if (!relDir) return;
      let cur = base;
      for (const s of relDir.split('/').filter(Boolean)) {
        const full = (cur === '/' ? '' : cur) + '/' + s;
        if (!madeDirs.has(full)) { try { await API.post('/files/mkdir', { path: cur, name: s }); } catch (e) { /* exists / race */ } madeDirs.add(full); }
        cur = full;
      }
    }
    async function uploadOneTo(base, file, rel) {
      const cut = rel.lastIndexOf('/');
      const relDir = cut > 0 ? rel.slice(0, cut) : '';
      const name = cut >= 0 ? rel.slice(cut + 1) : rel;
      await ensureRemoteDir(base, relDir);
      const destDir = relDir ? (base === '/' ? '' : base) + '/' + relDir : base;
      const r = await fetch(`/api/files/upload?path=${encodeURIComponent(destDir)}&name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
    }
    $('fx-upload').onclick = async () => {
      if (!staged.length || busy) return;
      const R = rcwd, P = lprefix;
      // ticked immediate children at P; if none ticked, upload every child of the current view
      let names = [...localSel].filter(f => f.startsWith(P) && f.slice(P.length).indexOf('/') === -1).map(f => f.slice(P.length));
      if (!names.length) names = localChildren(P).map(c => c.name);
      const jobs = [];
      for (const name of names) {
        const asFile = staged.find(it => it.rel === P + name);
        if (asFile) { jobs.push({ file: asFile.file, rel: name }); continue; }
        const fp = P + name + '/';
        for (const it of staged) if (it.rel.startsWith(fp)) jobs.push({ file: it.file, rel: it.rel.slice(P.length) });
      }
      if (!jobs.length) return;
      busy = true; madeDirs.clear(); $('fx-clear').disabled = true; updateInfo();
      const total = jobs.length; let done = 0, fail = 0;
      for (const j of jobs) {
        $('fx-info').textContent = `Uploading ${done + fail + 1}/${total}: ${j.rel}`;
        try { await uploadOneTo(R, j.file, j.rel); done++; } catch (e) { fail++; showToast(`${j.rel}: ${e.message}`, 'error', 8000); }
      }
      busy = false; $('fx-clear').disabled = false;
      showToast(`Uploaded ${done}/${total}${fail ? `, ${fail} failed` : ''}`, fail ? 'warning' : 'success');
      localSel.clear(); renderLocal();
      if (rcwd === R) renderRemote();
    };

    renderLocal();
    renderRemote();
  }

  await render();
});
