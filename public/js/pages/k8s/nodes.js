// K8s Nodes səhifəsi
Router.register('k8s-nodes', async (content) => {
  const pageNavId = Router._navId;

  async function render() {
    try {
      const nodes = await API.get('/k8s/nodes');
      if (!Router.isActiveNav(pageNavId)) return;

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Nodes</div><div class="page-subtitle">${nodes.length} node${nodes.length !== 1 ? 's' : ''} in cluster</div></div>
          <div class="page-actions"><button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button></div>
        </div>
        <div class="card">
          <div class="table-wrapper">
            <table>
              <thead><tr>
                <th>Name</th><th>Status</th><th>Role</th><th>Version</th>
                <th>OS</th><th>CPU</th><th>Memory</th><th>Pods</th><th>Age</th>
              </tr></thead>
              <tbody>
                ${nodes.map(n => `
                  <tr>
                    <td class="td-mono">${escapeHtml(n.name)}</td>
                    <td><span class="badge ${n.status === 'Ready' ? 'badge-running' : 'badge-stopped'}">${escapeHtml(n.status)}</span></td>
                    <td class="text-xs">${escapeHtml(n.role)}</td>
                    <td class="td-mono text-xs">${escapeHtml(n.version || '—')}</td>
                    <td class="text-xs">${escapeHtml(n.os || '—')}</td>
                    <td class="td-mono text-xs">${escapeHtml(n.cpu || '—')}</td>
                    <td class="td-mono text-xs">${escapeHtml(n.memory || '—')}</td>
                    <td class="td-mono text-xs">${escapeHtml(n.pods || '—')}</td>
                    <td class="text-xs text-muted">${n.created ? timeAgo(n.created) : '—'}</td>
                  </tr>
                `).join('') || '<tr><td colspan="9" class="text-center text-muted" style="padding:24px">No nodes</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('refresh-btn').addEventListener('click', render);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
