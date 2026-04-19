// K8s Secrets səhifəsi
Router.register('k8s-secrets', async (content) => {
  const pageNavId = Router._navId;
  let namespace = localStorage.getItem('k8s_ns') || 'all';

  async function render() {
    try {
      const [secrets, namespaces] = await Promise.all([
        API.get(`/k8s/secrets?namespace=${encodeURIComponent(namespace)}`),
        API.get('/k8s/cluster/namespaces').catch(() => []),
      ]);
      if (!Router.isActiveNav(pageNavId)) return;

      const nsOptions = ['<option value="all">All namespaces</option>']
        .concat(namespaces.map(n => `<option value="${escapeHtml(n.name)}" ${n.name === namespace ? 'selected' : ''}>${escapeHtml(n.name)}</option>`))
        .join('');

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Secrets</div><div class="page-subtitle">${secrets.length} secret${secrets.length !== 1 ? 's' : ''}</div></div>
          <div class="page-actions">
            <select class="select" id="ns-select">${nsOptions}</select>
            <button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button>
          </div>
        </div>
        <div class="card">
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Name</th><th>Namespace</th><th>Type</th><th>Keys</th><th>Age</th><th></th></tr></thead>
              <tbody>
                ${secrets.map(s => `
                  <tr>
                    <td class="td-mono">${escapeHtml(s.name)}</td>
                    <td class="td-mono text-xs text-muted">${escapeHtml(s.namespace)}</td>
                    <td class="text-xs">${escapeHtml(s.type || '—')}</td>
                    <td>${s.keyCount}</td>
                    <td class="text-xs text-muted">${s.created ? timeAgo(s.created) : '—'}</td>
                    <td><button class="btn btn-xs btn-ghost" data-action="view" data-ns="${escapeHtml(s.namespace)}" data-name="${escapeHtml(s.name)}">${Icons.eye}</button></td>
                  </tr>
                `).join('') || '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No secrets found</td></tr>'}
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
          let revealed = false;

          async function renderSecret() {
            try {
              const data = await API.get(`/k8s/secrets/${ns}/${name}?reveal=${revealed}`);
              const body = `
                <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
                  <button class="btn btn-sm btn-secondary" id="toggle-reveal">${revealed ? 'Hide' : 'Reveal'} values</button>
                </div>
                ${Object.entries(data.data || {}).map(([k, v]) => `
                  <div style="margin-bottom:12px;">
                    <div class="text-xs text-muted" style="margin-bottom:4px;">${escapeHtml(k)}</div>
                    <pre style="background:var(--bg-primary);padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;">${escapeHtml(v)}</pre>
                  </div>
                `).join('') || '<div class="text-muted text-sm">No data keys</div>'}
              `;
              // Re-render modal içərik
              const modalBody = document.querySelector('.modal-body');
              if (modalBody) {
                modalBody.innerHTML = body;
                document.getElementById('toggle-reveal')?.addEventListener('click', () => {
                  revealed = !revealed;
                  renderSecret();
                });
              }
            } catch (e) { showToast(e.message, 'error'); }
          }

          showModal(`Secret: ${name}`, '<div class="text-muted">Loading...</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
          renderSecret();
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  await render();
});
