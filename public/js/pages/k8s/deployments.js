// K8s Deployments səhifəsi
Router.register('k8s-deployments', async (content) => {
  const pageNavId = Router._navId;
  let namespace = localStorage.getItem('k8s_ns') || 'all';

  async function render() {
    try {
      const [deps, namespaces] = await Promise.all([
        API.get(`/k8s/deployments?namespace=${encodeURIComponent(namespace)}`),
        API.get('/k8s/cluster/namespaces').catch(() => []),
      ]);
      if (!Router.isActiveNav(pageNavId)) return;

      const nsOptions = ['<option value="all">All namespaces</option>']
        .concat(namespaces.map(n => `<option value="${escapeHtml(n.name)}" ${n.name === namespace ? 'selected' : ''}>${escapeHtml(n.name)}</option>`))
        .join('');

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Deployments</div><div class="page-subtitle">${deps.length} deployment${deps.length !== 1 ? 's' : ''}</div></div>
          <div class="page-actions">
            <select class="select" id="ns-select">${nsOptions}</select>
            <button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button>
          </div>
        </div>
        <div class="card">
          <div class="table-wrapper">
            <table>
              <thead><tr>
                <th>Name</th><th>Namespace</th><th>Ready</th><th>Up-to-date</th>
                <th>Available</th><th>Strategy</th><th>Images</th><th>Age</th><th>Actions</th>
              </tr></thead>
              <tbody>
                ${deps.map(d => {
                  const healthy = d.ready === d.replicas;
                  return `
                    <tr>
                      <td class="td-mono">${escapeHtml(d.name)}</td>
                      <td class="td-mono text-xs text-muted">${escapeHtml(d.namespace)}</td>
                      <td class="${healthy ? '' : 'text-warning'}">${d.ready}/${d.replicas}</td>
                      <td>${d.updated}</td>
                      <td>${d.available}</td>
                      <td class="text-xs text-muted">${escapeHtml(d.strategy || '—')}</td>
                      <td class="td-mono text-xs">${d.images.map(i => `<div>${escapeHtml(i)}</div>`).join('')}</td>
                      <td class="text-xs text-muted">${d.created ? timeAgo(d.created) : '—'}</td>
                      <td>
                        <button class="btn btn-xs btn-ghost" data-action="inspect" data-ns="${escapeHtml(d.namespace)}" data-name="${escapeHtml(d.name)}" title="Inspect">${Icons.eye}</button>
                        <button class="btn btn-xs btn-ghost" data-action="scale" data-ns="${escapeHtml(d.namespace)}" data-name="${escapeHtml(d.name)}" data-replicas="${d.replicas}" title="Scale">${Icons.arrowUp}</button>
                        <button class="btn btn-xs btn-ghost" data-action="restart" data-ns="${escapeHtml(d.namespace)}" data-name="${escapeHtml(d.name)}" title="Rollout restart">${Icons.restart}</button>
                        <button class="btn btn-xs btn-ghost text-danger" data-action="delete" data-ns="${escapeHtml(d.namespace)}" data-name="${escapeHtml(d.name)}" title="Delete">${Icons.trash}</button>
                      </td>
                    </tr>
                  `;
                }).join('') || '<tr><td colspan="9" class="text-center text-muted" style="padding:24px">No deployments found</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('ns-select').addEventListener('change', (e) => {
        namespace = e.target.value;
        localStorage.setItem('k8s_ns', namespace);
        render();
      });
      document.getElementById('refresh-btn').addEventListener('click', render);

      content.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const { action, ns, name } = btn.dataset;
          if (action === 'delete') {
            showConfirm('Delete Deployment', `"${name}" silinsin? (Pod-lar da silinəcək)`, async () => {
              try { await API.del(`/k8s/deployments/${ns}/${name}`); showToast(`Deployment silindi`); render(); }
              catch (e) { showToast(e.message, 'error'); }
            }, true);
          } else if (action === 'restart') {
            showConfirm('Rollout Restart', `"${name}" deployment-i yenidən başladılsın?`, async () => {
              try { await API.post(`/k8s/deployments/${ns}/${name}/restart`); showToast(`Rollout restart başladı`); render(); }
              catch (e) { showToast(e.message, 'error'); }
            });
          } else if (action === 'scale') {
            const current = btn.dataset.replicas;
            showModal(`Scale ${name}`, `
              <div>
                <div class="text-sm text-muted" style="margin-bottom:8px;">Current replicas: ${current}</div>
                <input type="number" class="input" id="scale-val" value="${current}" min="0" max="100" style="width:100%;" />
              </div>
            `, [
              { label: 'Cancel', className: 'btn btn-secondary' },
              { label: 'Scale', className: 'btn btn-primary', onClick: async () => {
                const val = parseInt(document.getElementById('scale-val').value);
                try { await API.post(`/k8s/deployments/${ns}/${name}/scale`, { replicas: val }); showToast(`Scaled to ${val}`); render(); }
                catch (e) { showToast(e.message, 'error'); }
              }},
            ]);
          } else if (action === 'inspect') {
            try {
              const data = await API.get(`/k8s/deployments/${ns}/${name}`);
              showModal(`Deployment: ${name}`, `<pre class="json-viewer">${syntaxHighlightJSON(JSON.stringify(data, null, 2))}</pre>`, [
                { label: 'Close', className: 'btn btn-secondary' }
              ]);
            } catch (e) { showToast(e.message, 'error'); }
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
