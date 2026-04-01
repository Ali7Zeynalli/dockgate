// Images Page
Router.register('images', async (content) => {
  let currentFilter = 'all';
  let refreshTimer = null;

  async function render() {
    try {
      let images = await API.get('/images');
      if (currentFilter === 'inuse') images = images.filter(i => i.inUse);
      else if (currentFilter === 'unused') images = images.filter(i => !i.inUse);
      else if (currentFilter === 'dangling') images = images.filter(i => i.isDangling);

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Images</div><div class="page-subtitle">${images.length} image(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="pull-image-btn">${Icons.download} Pull Image</button>
            <button class="btn btn-secondary" id="images-refresh">${Icons.refresh}</button>
          </div>
        </div>
        <div class="filter-bar">
          <button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
          <button class="filter-btn ${currentFilter === 'inuse' ? 'active' : ''}" data-filter="inuse">In Use</button>
          <button class="filter-btn ${currentFilter === 'unused' ? 'active' : ''}" data-filter="unused">Unused</button>
          <button class="filter-btn ${currentFilter === 'dangling' ? 'active' : ''}" data-filter="dangling">Dangling</button>
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Repository</th><th>Tag</th><th>Image ID</th><th>Size</th><th>Created</th><th>Containers</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>
              ${images.map(img => {
                const [repo, tag] = (img.repoTags[0] || '<none>:<none>').split(':');
                return `<tr>
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

      content.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; render(); }));
      document.getElementById('images-refresh')?.addEventListener('click', render);

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
    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  await render();
  refreshTimer = setInterval(render, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
