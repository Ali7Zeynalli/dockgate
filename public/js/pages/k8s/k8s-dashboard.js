// K8s Dashboard — cluster overview
Router.register('k8s-dashboard', async (content) => {
  const pageNavId = Router._navId;

  async function render() {
    try {
      const [cluster, pods, deps, services] = await Promise.all([
        API.get('/k8s/cluster/info'),
        API.get('/k8s/pods').catch(() => []),
        API.get('/k8s/deployments').catch(() => []),
        API.get('/k8s/services').catch(() => []),
      ]);
      if (!Router.isActiveNav(pageNavId)) return;

      const running = pods.filter(p => p.phase === 'Running').length;
      const pending = pods.filter(p => p.phase === 'Pending').length;
      const failed = pods.filter(p => p.phase === 'Failed').length;
      const readyNodes = cluster.nodes.filter(n => n.status === 'Ready').length;

      const topPods = [...pods].sort((a, b) => b.restarts - a.restarts).slice(0, 5);

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Kubernetes Overview</div><div class="page-subtitle">Context: <span class="td-mono">${escapeHtml(cluster.context)}</span> — ${escapeHtml(cluster.version || '—')}</div></div>
          <div class="page-actions"><button class="btn btn-secondary" id="refresh-btn">${Icons.refresh}</button></div>
        </div>

        <div class="grid-4" style="margin-bottom:16px;">
          <div class="metric-card">
            <div class="metric-label">Nodes</div>
            <div class="metric-value">${readyNodes}<span class="text-muted text-sm">/${cluster.nodeCount}</span></div>
            <div class="text-xs text-muted">Ready</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Namespaces</div>
            <div class="metric-value">${cluster.namespaceCount}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Pods</div>
            <div class="metric-value">${pods.length}</div>
            <div class="text-xs">
              <span style="color:var(--success);">${running} running</span>
              ${pending > 0 ? `, <span style="color:var(--warning);">${pending} pending</span>` : ''}
              ${failed > 0 ? `, <span style="color:var(--danger);">${failed} failed</span>` : ''}
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Workloads</div>
            <div class="metric-value">${deps.length}</div>
            <div class="text-xs text-muted">Deployments</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">Nodes</div>
            <div class="table-wrapper">
              <table>
                <thead><tr><th>Name</th><th>Status</th><th>Role</th><th>Version</th></tr></thead>
                <tbody>
                  ${cluster.nodes.map(n => `
                    <tr>
                      <td class="td-mono text-sm">${escapeHtml(n.name)}</td>
                      <td><span class="badge ${n.status === 'Ready' ? 'badge-running' : 'badge-stopped'}">${escapeHtml(n.status)}</span></td>
                      <td class="text-xs">${escapeHtml(n.role)}</td>
                      <td class="td-mono text-xs">${escapeHtml(n.version || '—')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-title">Pods with most restarts</div>
            <div class="table-wrapper">
              <table>
                <thead><tr><th>Pod</th><th>Namespace</th><th>Restarts</th><th>Status</th></tr></thead>
                <tbody>
                  ${topPods.map(p => `
                    <tr>
                      <td class="td-mono text-sm">${escapeHtml(p.name)}</td>
                      <td class="td-mono text-xs text-muted">${escapeHtml(p.namespace)}</td>
                      <td class="${p.restarts > 5 ? 'text-danger' : ''}">${p.restarts}</td>
                      <td><span class="badge ${p.phase === 'Running' ? 'badge-running' : 'badge-warning'}">${escapeHtml(p.phase)}</span></td>
                    </tr>
                  `).join('') || '<tr><td colspan="4" class="text-center text-muted">No pods</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="card-title">Services (LoadBalancer / NodePort)</div>
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Name</th><th>Namespace</th><th>Type</th><th>Cluster IP</th><th>Ports</th></tr></thead>
              <tbody>
                ${services.filter(s => s.type !== 'ClusterIP').slice(0, 10).map(s => `
                  <tr>
                    <td class="td-mono text-sm">${escapeHtml(s.name)}</td>
                    <td class="td-mono text-xs text-muted">${escapeHtml(s.namespace)}</td>
                    <td><span class="badge badge-running">${escapeHtml(s.type)}</span></td>
                    <td class="td-mono text-xs">${escapeHtml(s.clusterIP || '—')}</td>
                    <td class="td-mono text-xs">${s.ports.map(p => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(', ')}</td>
                  </tr>
                `).join('') || '<tr><td colspan="5" class="text-center text-muted">No external services</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('refresh-btn').addEventListener('click', render);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p><p class="text-xs text-muted">Kubernetes mode aktiv olduğuna və cluster-ə çıxışınız olduğuna əmin olun.</p></div>`;
    }
  }

  await render();
});
