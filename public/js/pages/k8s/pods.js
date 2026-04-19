// K8s Pods səhifəsi
Router.register('k8s-pods', async (content) => {
  const pageNavId = Router._navId;
  let namespace = localStorage.getItem('k8s_ns') || 'all';

  async function render() {
    try {
      const [pods, namespaces] = await Promise.all([
        API.get(`/k8s/pods?namespace=${encodeURIComponent(namespace)}`),
        API.get('/k8s/cluster/namespaces').catch(() => []),
      ]);
      if (!Router.isActiveNav(pageNavId)) return;

      const nsOptions = ['<option value="all">All namespaces</option>']
        .concat(namespaces.map(n => `<option value="${escapeHtml(n.name)}" ${n.name === namespace ? 'selected' : ''}>${escapeHtml(n.name)}</option>`))
        .join('');

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Pods</div><div class="page-subtitle">${pods.length} pod${pods.length !== 1 ? 's' : ''}</div></div>
          <div class="page-actions">
            <select class="select" id="ns-select">${nsOptions}</select>
            <button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button>
          </div>
        </div>
        <div class="card">
          <div class="table-wrapper">
            <table>
              <thead><tr>
                <th>Name</th><th>Namespace</th><th>Ready</th><th>Status</th>
                <th>Restarts</th><th>Node</th><th>IP</th><th>Age</th><th>Actions</th>
              </tr></thead>
              <tbody>
                ${pods.map(p => {
                  const phaseClass = p.phase === 'Running' ? 'badge-running' :
                                     p.phase === 'Pending' ? 'badge-warning' :
                                     p.phase === 'Failed' ? 'badge-stopped' : 'badge-warning';
                  return `
                    <tr>
                      <td class="td-mono">${escapeHtml(p.name)}</td>
                      <td class="td-mono text-xs text-muted">${escapeHtml(p.namespace)}</td>
                      <td>${p.ready}</td>
                      <td><span class="badge ${phaseClass}">${escapeHtml(p.phase || '—')}</span></td>
                      <td class="text-center ${p.restarts > 5 ? 'text-danger' : ''}">${p.restarts}</td>
                      <td class="td-mono text-xs">${escapeHtml(p.node || '—')}</td>
                      <td class="td-mono text-xs">${escapeHtml(p.ip || '—')}</td>
                      <td class="text-xs text-muted">${p.created ? timeAgo(p.created) : '—'}</td>
                      <td>
                        <button class="btn btn-xs btn-ghost" data-action="inspect" data-ns="${escapeHtml(p.namespace)}" data-name="${escapeHtml(p.name)}" title="Inspect">${Icons.eye}</button>
                        <button class="btn btn-xs btn-ghost" data-action="logs" data-ns="${escapeHtml(p.namespace)}" data-name="${escapeHtml(p.name)}" title="Logs">${Icons.logs}</button>
                        <button class="btn btn-xs btn-ghost" data-action="exec" data-ns="${escapeHtml(p.namespace)}" data-name="${escapeHtml(p.name)}" title="Exec">${Icons.terminal}</button>
                        <button class="btn btn-xs btn-ghost text-danger" data-action="delete" data-ns="${escapeHtml(p.namespace)}" data-name="${escapeHtml(p.name)}" title="Delete">${Icons.trash}</button>
                      </td>
                    </tr>
                  `;
                }).join('') || '<tr><td colspan="9" class="text-center text-muted" style="padding:24px">No pods found</td></tr>'}
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
            showConfirm('Delete Pod', `Pod "${name}" silinsin?`, async () => {
              try {
                await API.del(`/k8s/pods/${ns}/${name}`);
                showToast(`Pod "${name}" silindi`);
                render();
              } catch (e) { showToast(e.message, 'error'); }
            }, true);
          } else if (action === 'inspect') {
            try {
              const data = await API.get(`/k8s/pods/${ns}/${name}`);
              showModal(`Pod: ${name}`, `<pre class="json-viewer">${syntaxHighlightJSON(JSON.stringify(data, null, 2))}</pre>`, [
                { label: 'Close', className: 'btn btn-secondary' }
              ]);
            } catch (e) { showToast(e.message, 'error'); }
          } else if (action === 'logs') {
            localStorage.setItem('k8s_log_pod', JSON.stringify({ namespace: ns, podName: name }));
            Router.navigate('k8s-pod-logs');
          } else if (action === 'exec') {
            localStorage.setItem('k8s_exec_pod', JSON.stringify({ namespace: ns, podName: name }));
            Router.navigate('k8s-pod-terminal');
          }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
