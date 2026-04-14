// Volumes Page
Router.register('volumes', async (content) => {
  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      const volumes = await API.get('/volumes');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;
      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Volumes</div><div class="page-subtitle">${volumes.length} volume(s)</div></div>
          <div class="page-actions"><button class="btn btn-secondary" id="vol-refresh">${Icons.refresh}</button></div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th>Created</th><th>Containers</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>
              ${volumes.map(v => `<tr>
                <td class="td-name td-mono" style="max-width:200px">${escapeHtml(v.name)}</td>
                <td class="text-sm">${v.driver}</td>
                <td class="td-mono text-xs" style="max-width:250px" title="${escapeHtml(v.mountpoint)}">${escapeHtml(v.mountpoint)}</td>
                <td class="text-muted text-sm">${v.createdAt ? timeAgo(v.createdAt) : 'N/A'}</td>
                <td><span class="badge ${v.inUse ? 'badge-running' : 'badge-dead'}">${v.attachedContainers}</span></td>
                <td><span class="badge ${v.inUse ? 'badge-running' : 'badge-stopped'}">${v.inUse ? 'In Use' : 'Unused'}</span></td>
                <td><div class="td-actions">
                  <button class="btn-icon" title="Inspect" data-inspect="${v.name}">${Icons.eye}</button>
                  ${!v.inUse ? `<button class="btn-icon" title="Remove" data-remove="${v.name}" style="color:var(--danger)">${Icons.trash}</button>` : ''}
                </div></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('vol-refresh')?.addEventListener('click', render);

      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          showConfirm('Remove Volume', `Remove <strong>${btn.dataset.remove}</strong>? This will delete all data in this volume.`, async () => {
            try { await API.del(`/volumes/${btn.dataset.remove}`); showToast('Volume removed'); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      });

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
                <div class="detail-item"><div class="detail-label">Created</div><div class="detail-value">${data.CreatedAt ? new Date(data.CreatedAt).toLocaleString() : 'N/A'}</div></div>
              </div>
              ${Object.keys(data.Labels || {}).length > 0 ? `<div class="mt-2"><div class="detail-label mb-1">Labels</div><pre class="json-viewer" style="max-height:200px">${syntaxHighlightJSON(JSON.stringify(data.Labels, null, 2))}</pre></div>` : ''}
            `, [{ label: 'Close', className: 'btn btn-secondary' }]);
          } catch (err) { showToast(err.message, 'error'); }
        });
      });
    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  await render();
});
