// K8s Services səhifəsi
Router.register('k8s-services', async (content) => {
  const pageNavId = Router._navId;
  let namespace = localStorage.getItem('k8s_ns') || 'all';

  async function render() {
    try {
      const [svcs, namespaces] = await Promise.all([
        API.get(`/k8s/services?namespace=${encodeURIComponent(namespace)}`),
        API.get('/k8s/cluster/namespaces').catch(() => []),
      ]);
      if (!Router.isActiveNav(pageNavId)) return;

      const nsOptions = ['<option value="all">All namespaces</option>']
        .concat(namespaces.map(n => `<option value="${escapeHtml(n.name)}" ${n.name === namespace ? 'selected' : ''}>${escapeHtml(n.name)}</option>`))
        .join('');

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Services</div><div class="page-subtitle">${svcs.length} service${svcs.length !== 1 ? 's' : ''}</div></div>
          <div class="page-actions">
            <select class="select" id="ns-select">${nsOptions}</select>
            <button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button>
          </div>
        </div>
        <div class="card">
          <div class="table-wrapper">
            <table>
              <thead><tr>
                <th>Name</th><th>Namespace</th><th>Type</th><th>Cluster IP</th>
                <th>External</th><th>Ports</th><th>Age</th><th></th>
              </tr></thead>
              <tbody>
                ${svcs.map(s => {
                  const external = s.loadBalancerIP || (s.externalIPs.length ? s.externalIPs.join(', ') : '—');
                  const ports = s.ports.map(p => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(', ');
                  return `
                    <tr>
                      <td class="td-mono">${escapeHtml(s.name)}</td>
                      <td class="td-mono text-xs text-muted">${escapeHtml(s.namespace)}</td>
                      <td><span class="badge ${s.type === 'LoadBalancer' ? 'badge-running' : 'badge-warning'}">${escapeHtml(s.type || '—')}</span></td>
                      <td class="td-mono text-xs">${escapeHtml(s.clusterIP || '—')}</td>
                      <td class="td-mono text-xs">${escapeHtml(external)}</td>
                      <td class="td-mono text-xs">${escapeHtml(ports)}</td>
                      <td class="text-xs text-muted">${s.created ? timeAgo(s.created) : '—'}</td>
                      <td><button class="btn btn-xs btn-ghost" data-action="inspect" data-ns="${escapeHtml(s.namespace)}" data-name="${escapeHtml(s.name)}">${Icons.eye}</button></td>
                    </tr>
                  `;
                }).join('') || '<tr><td colspan="8" class="text-center text-muted" style="padding:24px">No services found</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('ns-select').addEventListener('change', (e) => {
        namespace = e.target.value; localStorage.setItem('k8s_ns', namespace); render();
      });
      document.getElementById('refresh-btn').addEventListener('click', render);

      content.querySelectorAll('[data-action="inspect"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const { ns, name } = btn.dataset;
          try {
            const data = await API.get(`/k8s/services/${ns}/${name}`);
            showModal(`Service: ${name}`, `<pre class="json-viewer">${syntaxHighlightJSON(JSON.stringify(data, null, 2))}</pre>`, [
              { label: 'Close', className: 'btn btn-secondary' }
            ]);
          } catch (e) { showToast(e.message, 'error'); }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
