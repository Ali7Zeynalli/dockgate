// Images Page
Router.register('images', async (content) => {
  let currentFilter = 'all';
  let currentSearch = '';
  let selectedIds = new Set();
  let refreshTimer = null;

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      let images = await API.get('/images');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      const allCount = images.length;
      if (currentFilter === 'inuse') images = images.filter(i => i.inUse);
      else if (currentFilter === 'unused') images = images.filter(i => !i.inUse);
      else if (currentFilter === 'dangling') images = images.filter(i => i.isDangling);

      if (currentSearch) {
        const q = currentSearch.toLowerCase();
        images = images.filter(i =>
          (i.repoTags[0] || '').toLowerCase().includes(q) ||
          i.shortId.toLowerCase().includes(q)
        );
      }

      // Clean up selectedIds that are no longer visible
      const visibleIds = new Set(images.map(i => i.id));
      for (const id of selectedIds) {
        if (!visibleIds.has(id)) selectedIds.delete(id);
      }

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Images</div><div class="page-subtitle">${images.length} image(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="pull-image-btn">${Icons.download} Pull Image</button>
            <button class="btn btn-secondary" id="images-refresh">${Icons.refresh}</button>
          </div>
        </div>
        <div class="filter-bar">
          <button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">All (${allCount})</button>
          <button class="filter-btn ${currentFilter === 'inuse' ? 'active' : ''}" data-filter="inuse">In Use</button>
          <button class="filter-btn ${currentFilter === 'unused' ? 'active' : ''}" data-filter="unused">Unused</button>
          <button class="filter-btn ${currentFilter === 'dangling' ? 'active' : ''}" data-filter="dangling">Dangling</button>
          <div style="flex:1"></div>
          <div class="search-input">
            <span class="nav-item-icon">${Icons.search}</span>
            <input type="text" placeholder="Search images..." value="${escapeHtml(currentSearch)}" id="image-search">
          </div>
        </div>

        ${selectedIds.size > 0 ? `
        <div class="card mb-2" style="padding:12px 18px;display:flex;align-items:center;gap:12px;background:var(--accent-dim)">
          <span class="text-sm font-bold">${selectedIds.size} selected</span>
          <button class="btn btn-sm btn-danger" id="bulk-remove">${Icons.trash} Remove</button>
          <button class="btn btn-sm btn-danger" id="bulk-force-remove">${Icons.trash} Force Remove</button>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-ghost" id="bulk-clear">Clear</button>
        </div>` : ''}

        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th style="width:40px"><div class="checkbox ${images.length > 0 && selectedIds.size === images.length ? 'checked' : ''}" id="select-all"></div></th>
              <th>Repository</th><th>Tag</th><th>Image ID</th><th>Size</th><th>Created</th><th>Containers</th><th style="text-align:right">Actions</th>
            </tr></thead>
            <tbody>
              ${images.map(img => {
                const [repo, tag] = (img.repoTags[0] || '<none>:<none>').split(':');
                return `<tr class="${selectedIds.has(img.id) ? 'selected' : ''}">
                  <td><div class="checkbox ${selectedIds.has(img.id) ? 'checked' : ''}" data-select="${img.id}"></div></td>
                  <td class="td-name">${escapeHtml(repo)}</td>
                  <td><span class="badge badge-created">${escapeHtml(tag || 'latest')}</span></td>
                  <td class="td-mono">${img.shortId}</td>
                  <td class="text-sm">${formatBytes(img.size)}</td>
                  <td class="text-muted text-sm">${timeAgo(img.created)}</td>
                  <td><span class="badge ${img.inUse ? 'badge-running' : 'badge-dead'}">${img.containers}</span></td>
                  <td>
                    <div class="td-actions">
                      <button class="btn-icon" title="Inspect" data-inspect="${img.id}">${Icons.eye}</button>
                      <button class="btn-icon" title="Remove" data-remove="${img.id}" data-name="${escapeHtml(repo + ':' + tag)}" style="color:var(--danger)">${Icons.trash}</button>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      // Filter buttons
      content.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; render(); }));
      document.getElementById('images-refresh')?.addEventListener('click', render);

      // Search
      const searchInput = document.getElementById('image-search');
      if (searchInput) {
        let timeout;
        searchInput.addEventListener('input', () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => { currentSearch = searchInput.value; render(); }, 300);
        });
      }

      // Pull image
      document.getElementById('pull-image-btn')?.addEventListener('click', () => {
        showModal('Pull Image', '<div class="input-group"><label>Image Name (e.g., nginx:latest)</label><input type="text" id="pull-image-input" placeholder="nginx:latest"></div>', [
          { label: 'Cancel', className: 'btn btn-secondary' },
          { label: 'Pull', className: 'btn btn-primary', onClick: async () => {
            const image = document.getElementById('pull-image-input')?.value;
            if (!image) return;
            showToast(`Pulling ${image}...`, 'info');
            try { await API.post('/images/pull', { image }); showToast(`Pulled ${image}`); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }},
        ]);
      });

      // Single remove
      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const imgId = btn.dataset.remove;
          const name = btn.dataset.name;
          showConfirm('Remove Image', `Remove <strong>${name}</strong>?`, async () => {
            try { await API.del(`/images/${encodeURIComponent(imgId)}`); showToast(`Removed ${name}`); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      });

      // Inspect
      content.querySelectorAll('[data-inspect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const data = await API.get(`/images/${encodeURIComponent(btn.dataset.inspect)}`);
            showModal('Image Inspect', `<div class="json-viewer" style="max-height:400px">${syntaxHighlightJSON(JSON.stringify(data, null, 2))}</div>`, [
              { label: 'Close', className: 'btn btn-secondary' },
            ]);
          } catch (err) { showToast(err.message, 'error'); }
        });
      });

      // Selection
      content.querySelectorAll('[data-select]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = el.dataset.select;
          if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
          render();
        });
      });

      document.getElementById('select-all')?.addEventListener('click', () => {
        if (selectedIds.size === images.length) selectedIds.clear();
        else images.forEach(i => selectedIds.add(i.id));
        render();
      });

      // Bulk actions
      document.getElementById('bulk-clear')?.addEventListener('click', () => { selectedIds.clear(); render(); });

      document.getElementById('bulk-remove')?.addEventListener('click', () => {
        showConfirm('Remove Selected', `Remove ${selectedIds.size} image(s)?`, async () => {
          let removed = 0;
          for (const id of selectedIds) {
            try { await API.del(`/images/${encodeURIComponent(id)}`); removed++; } catch(e) {}
          }
          showToast(`Removed ${removed}/${selectedIds.size} images`);
          selectedIds.clear();
          render();
        }, true);
      });

      document.getElementById('bulk-force-remove')?.addEventListener('click', () => {
        showConfirm('Force Remove Selected', `Force remove ${selectedIds.size} image(s)? This will also remove images currently in use.`, async () => {
          let removed = 0;
          for (const id of selectedIds) {
            try { await API.del(`/images/${encodeURIComponent(id)}?force=true`); removed++; } catch(e) {}
          }
          showToast(`Force removed ${removed}/${selectedIds.size} images`);
          selectedIds.clear();
          render();
        }, true);
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  await render();
  refreshTimer = setInterval(render, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
