// Volumes Page
Router.register('volumes', async (content) => {
  let selectedNames = new Set();
  let refreshTimer = null;

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      const volumes = await API.get('/volumes');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      // Clean up selectedNames that are no longer visible
      const visibleNames = new Set(volumes.map(v => v.name));
      for (const name of selectedNames) {
        if (!visibleNames.has(name)) selectedNames.delete(name);
      }

      const removableVolumes = volumes.filter(v => !v.inUse);

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Volumes</div><div class="page-subtitle">${volumes.length} volume(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="vol-new">${Icons.volume} New Volume</button>
            <button class="btn btn-secondary" id="vol-refresh">${Icons.refresh}</button>
          </div>
        </div>

        ${selectedNames.size > 0 ? `
        <div class="card mb-2" style="padding:12px 18px;display:flex;align-items:center;gap:12px;background:var(--accent-dim)">
          <span class="text-sm font-bold">${selectedNames.size} selected</span>
          <button class="btn btn-sm btn-danger" id="bulk-remove">${Icons.trash} Remove</button>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-ghost" id="bulk-clear">Clear</button>
        </div>` : ''}

        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th style="width:40px"><div class="checkbox ${volumes.length > 0 && selectedNames.size === removableVolumes.length && removableVolumes.length > 0 ? 'checked' : ''}" id="select-all"></div></th>
              <th>Name</th><th>Driver</th><th>Mountpoint</th><th>Created</th><th>Containers</th><th>Status</th><th style="text-align:right">Actions</th>
            </tr></thead>
            <tbody>
              ${volumes.map(v => `<tr class="${selectedNames.has(v.name) ? 'selected' : ''}">
                <td>${!v.inUse ? `<div class="checkbox ${selectedNames.has(v.name) ? 'checked' : ''}" data-select="${escapeHtml(v.name)}"></div>` : ''}</td>
                <td class="td-name td-mono" style="max-width:200px">${escapeHtml(v.name)}</td>
                <td class="text-sm">${v.driver}</td>
                <td class="td-mono text-xs" style="max-width:250px" title="${escapeHtml(v.mountpoint)}">${escapeHtml(v.mountpoint)}</td>
                <td class="text-muted text-sm">${v.createdAt ? timeAgo(v.createdAt) : 'N/A'}</td>
                <td><span class="badge ${v.inUse ? 'badge-running' : 'badge-dead'}">${v.attachedContainers}</span></td>
                <td><span class="badge ${v.inUse ? 'badge-running' : 'badge-stopped'}">${v.inUse ? 'In Use' : 'Unused'}</span></td>
                <td><div class="td-actions">
                  <button class="btn-icon" title="Inspect" data-inspect="${escapeHtml(v.name)}">${Icons.eye}</button>
                  <button class="btn-icon" title="Backup (download tar.gz)" data-backup="${escapeHtml(v.name)}">${Icons.download}</button>
                  <button class="btn-icon" title="Restore (upload tar.gz)" data-restore="${escapeHtml(v.name)}">${Icons.arrowUp}</button>
                  <button class="btn-icon" title="Clone" data-clone="${escapeHtml(v.name)}">${Icons.copy}</button>
                  ${!v.inUse ? `<button class="btn-icon" title="Remove" data-remove="${escapeHtml(v.name)}" style="color:var(--danger)">${Icons.trash}</button>` : ''}
                </div></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('vol-refresh')?.addEventListener('click', render);
      document.getElementById('vol-new')?.addEventListener('click', openVolumeCreate);

      // Backup → download tar.gz (V1)
      content.querySelectorAll('[data-backup]').forEach(btn => btn.addEventListener('click', () => {
        const name = btn.dataset.backup;
        const a = document.createElement('a');
        a.href = `/api/volumes/${encodeURIComponent(name)}/backup`;
        a.download = `${name}.tar.gz`;
        document.body.appendChild(a); a.click(); a.remove();
        showToast('Backup started…', 'info');
      }));

      // Restore ← upload tar.gz (V2)
      content.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => {
        const name = btn.dataset.restore;
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.tar.gz,.tgz,.gz,.tar';
        inp.onchange = async () => {
          const f = inp.files && inp.files[0];
          if (!f) return;
          showToast(`Restoring into ${name}…`, 'info');
          try {
            const r = await fetch(`/api/volumes/${encodeURIComponent(name)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: f });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'Restore failed');
            showToast('Volume restored'); render();
          } catch (e) { showToast(e.message, 'error', 8000); }
        };
        inp.click();
      }));

      // Clone (V4)
      content.querySelectorAll('[data-clone]').forEach(btn => btn.addEventListener('click', () => {
        const src = btn.dataset.clone;
        const body = `<div class="input-group"><label>New volume name *</label><input class="input" id="clone-dest" value="${escapeHtml(src)}-copy"></div><div class="text-xs text-muted">Copies all data from <b>${escapeHtml(src)}</b> into a new volume.</div>`;
        const m = showModal('Clone Volume', body, []);
        const root = m.overlay;
        const b = document.createElement('button');
        b.className = 'btn btn-primary'; b.textContent = 'Clone';
        root.querySelector('#modal-footer').appendChild(b);
        b.addEventListener('click', async () => {
          const dest = root.querySelector('#clone-dest').value.trim();
          if (!dest) { showToast('Name required', 'warning'); return; }
          b.disabled = true; b.textContent = 'Cloning…';
          try { await API.post(`/volumes/${encodeURIComponent(src)}/clone`, { dest }); showToast(`Cloned to "${dest}"`); m.close(); render(); }
          catch (e) { showToast(e.message, 'error', 9000); b.disabled = false; b.textContent = 'Clone'; }
        });
      }));

      // Single remove
      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          showConfirm('Remove Volume', `Remove <strong>${escapeHtml(btn.dataset.remove)}</strong>? This will delete all data in this volume.`, async () => {
            try { await API.del(`/volumes/${btn.dataset.remove}`); showToast('Volume removed'); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      });

      // Inspect
      content.querySelectorAll('[data-inspect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const data = await API.get(`/volumes/${btn.dataset.inspect}`);
            showModal('Volume Details', `
              <div class="detail-grid" style="grid-template-columns:1fr">
                <div class="detail-item"><div class="detail-label">Name</div><div class="detail-value mono">${escapeHtml(data.Name)}</div></div>
                <div class="detail-item"><div class="detail-label">Driver</div><div class="detail-value">${data.Driver}</div></div>
                <div class="detail-item"><div class="detail-label">Mountpoint</div><div class="detail-value mono">${escapeHtml(data.Mountpoint)}</div></div>
                <div class="detail-item"><div class="detail-label">Scope</div><div class="detail-value">${data.Scope}</div></div>
                <div class="detail-item"><div class="detail-label">Created</div><div class="detail-value">${data.CreatedAt ? formatTime(data.CreatedAt) : 'N/A'}</div></div>
              </div>
              ${Object.keys(data.Labels || {}).length > 0 ? `<div class="mt-2"><div class="detail-label mb-1">Labels</div><pre class="json-viewer" style="max-height:200px">${syntaxHighlightJSON(JSON.stringify(data.Labels, null, 2))}</pre></div>` : ''}
            `, [{ label: 'Close', className: 'btn btn-secondary' }]);
          } catch (err) { showToast(err.message, 'error'); }
        });
      });

      // Selection — only unused volumes can be selected
      content.querySelectorAll('[data-select]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = el.dataset.select;
          if (selectedNames.has(name)) selectedNames.delete(name); else selectedNames.add(name);
          render();
        });
      });

      document.getElementById('select-all')?.addEventListener('click', () => {
        if (selectedNames.size === removableVolumes.length) selectedNames.clear();
        else removableVolumes.forEach(v => selectedNames.add(v.name));
        render();
      });

      // Bulk actions
      document.getElementById('bulk-clear')?.addEventListener('click', () => { selectedNames.clear(); render(); });

      document.getElementById('bulk-remove')?.addEventListener('click', () => {
        showConfirm('Remove Selected Volumes', `Remove ${selectedNames.size} volume(s)? This will delete all data in these volumes.`, async () => {
          await bulkRun([...selectedNames], (name) => API.del(`/volumes/${name}`), 'Removed');
          selectedNames.clear();
          render();
        }, true);
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  // Rich create form (V5) — name, driver, driver options & labels (comma KEY=val)
  function openVolumeCreate() {
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Name *</label><input class="input" id="vc-name" placeholder="my-volume"></div>
      <div class="input-group"><label>Driver</label><input class="input" id="vc-driver" value="local"></div>
      <div class="input-group"><label>Driver options (comma KEY=val, optional)</label><input class="input" id="vc-opts" placeholder="type=nfs, o=addr=1.2.3.4, device=:/path"></div>
      <div class="input-group"><label>Labels (comma KEY=val, optional)</label><input class="input" id="vc-labels" placeholder="env=prod, app=web"></div>
    </div>`;
    const m = showModal('New Volume', body, []);
    const root = m.overlay;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Create';
    root.querySelector('#modal-footer').appendChild(btn);
    const kv = (s) => { const o = {}; (s || '').split(',').map(x => x.trim()).filter(Boolean).forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; };
    btn.addEventListener('click', async () => {
      const name = root.querySelector('#vc-name').value.trim();
      if (!name) { showToast('Name required', 'warning'); return; }
      const config = { Name: name, Driver: root.querySelector('#vc-driver').value.trim() || 'local' };
      const opts = kv(root.querySelector('#vc-opts').value); if (Object.keys(opts).length) config.DriverOpts = opts;
      const labels = kv(root.querySelector('#vc-labels').value); if (Object.keys(labels).length) config.Labels = labels;
      btn.disabled = true; btn.textContent = 'Creating…';
      try { await API.post('/volumes', config); showToast(`Volume "${name}" created`); m.close(); render(); }
      catch (e) { showToast(e.message, 'error', 9000); btn.disabled = false; btn.textContent = 'Create'; }
    });
  }

  await render();
  // Auto-refresh (status / attached-container counts go stale as containers change) + cleanup
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
