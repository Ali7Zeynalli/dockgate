// K8s ConfigMaps səhifəsi
Router.register('k8s-configmaps', async (content) => {
  const pageNavId = Router._navId;
  let namespace = localStorage.getItem('k8s_ns') || 'all';

  async function render() {
    try {
      const [cms, namespaces] = await Promise.all([
        API.get(`/k8s/configmaps?namespace=${encodeURIComponent(namespace)}`),
        API.get('/k8s/cluster/namespaces').catch(() => []),
      ]);
      if (!Router.isActiveNav(pageNavId)) return;

      const nsOptions = ['<option value="all">All namespaces</option>']
        .concat(namespaces.map(n => `<option value="${escapeHtml(n.name)}" ${n.name === namespace ? 'selected' : ''}>${escapeHtml(n.name)}</option>`))
        .join('');

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">ConfigMaps</div><div class="page-subtitle">${cms.length} configmap${cms.length !== 1 ? 's' : ''}</div></div>
          <div class="page-actions">
            <select class="select" id="ns-select">${nsOptions}</select>
            <button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button>
          </div>
        </div>
        <div class="card">
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Name</th><th>Namespace</th><th>Keys</th><th>Age</th><th></th></tr></thead>
              <tbody>
                ${cms.map(c => `
                  <tr>
                    <td class="td-mono">${escapeHtml(c.name)}</td>
                    <td class="td-mono text-xs text-muted">${escapeHtml(c.namespace)}</td>
                    <td>${c.keyCount}</td>
                    <td class="text-xs text-muted">${c.created ? timeAgo(c.created) : '—'}</td>
                    <td><button class="btn btn-xs btn-ghost" data-action="view" data-ns="${escapeHtml(c.namespace)}" data-name="${escapeHtml(c.name)}">${Icons.eye}</button></td>
                  </tr>
                `).join('') || '<tr><td colspan="5" class="text-center text-muted" style="padding:24px">No configmaps found</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('ns-select').addEventListener('change', (e) => {
        namespace = e.target.value; localStorage.setItem('k8s_ns', namespace); render();
      });
      document.getElementById('refresh-btn').addEventListener('click', render);

      content.querySelectorAll('[data-action="view"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const { ns, name } = btn.dataset;
          try {
            const data = await API.get(`/k8s/configmaps/${ns}/${name}`);
            const body = Object.entries(data.data || {}).map(([k, v]) => `
              <div style="margin-bottom:12px;">
                <div class="text-xs text-muted" style="margin-bottom:4px;">${escapeHtml(k)}</div>
                <pre style="background:var(--bg-primary);padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;">${escapeHtml(v)}</pre>
              </div>
            `).join('') || '<div class="text-muted text-sm">No data keys</div>';
            showModal(`ConfigMap: ${name}`, body, [{ label: 'Close', className: 'btn btn-secondary' }]);
          } catch (e) { showToast(e.message, 'error'); }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
