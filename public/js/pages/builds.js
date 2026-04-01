// Builds History & Cache Page
Router.register('builds', async (content) => {
  async function render() {
    try {
      const builds = await API.get('/builds');
      
      const totalSize = builds.reduce((a, b) => a + (b.Size || 0), 0);
      
      content.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">Builds & Cache</div>
            <div class="page-subtitle">${builds.length} build history element(s) · ${formatBytes(totalSize)} total size</div>
          </div>
          <div class="page-actions">
            <button class="btn btn-danger" id="prune-builds">${Icons.trash} Clear Build History</button>
            <button class="btn btn-secondary" id="builds-refresh">${Icons.refresh}</button>
          </div>
        </div>

        ${builds.length === 0 ? `
          <div class="empty-state">
            <span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">${Icons.layers}</span>
            <h3>No Build History</h3>
            <p>Your docker builder cache is completely empty.</p>
          </div>
        ` : `
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Cache ID</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Size</th>
                  <th>Usage / Context</th>
                </tr>
              </thead>
              <tbody>
                ${builds.map(b => `
                  <tr>
                    <td class="td-mono">${(b.ID || 'N/A').substring(0, 15)}...</td>
                    <td><span class="badge ${b.Type === 'regular' ? 'badge-running' : 'badge-created'}">${escapeHtml(b.Type || 'Unknown')}</span></td>
                    <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(b.Description || '')}">
                      <span class="td-mono text-sm">${escapeHtml(b.Description || 'No description')}</span>
                    </td>
                    <td>${formatBytes(b.Size || 0)}</td>
                    <td class="text-sm">
                      ${b.InUse ? '<span class="text-accent font-bold">In Use</span>' : '<span class="text-muted">Idle</span>'} 
                      ${b.Shared ? ' · Shared' : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      `;

      document.getElementById('builds-refresh')?.addEventListener('click', render);

      document.getElementById('prune-builds')?.addEventListener('click', () => {
        showConfirm('Clear Build History', 'Are you sure you want to clear all build history and cache? This cannot be undone and your next image builds might take longer.', async () => {
          try {
            showToast('Clearing build history...', 'info');
            const res = await API.post('/builds/prune');
            let space = res.SpaceReclaimedStr ? ` (${res.SpaceReclaimedStr.replace('Total reclaimed space:', '').trim()})` : '';
            showToast(`Build history cleared${space}`, 'success');
            render();
          } catch (err) {
            showToast(err.message, 'error');
          }
        }, true);
      });

    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
