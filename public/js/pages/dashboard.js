// Dashboard Page
Router.register('dashboard', async (content) => {
  let refreshTimer = null;

  async function render() {
    try {
      const data = await API.get('/dashboard');
      const s = data.summary;
      const disk = data.diskUsage;
      const totalDisk = disk.images + disk.containers + disk.volumes + disk.buildCache;

      content.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">Dashboard</div>
            <div class="page-subtitle">Overview of your Docker environment</div>
          </div>
          <div class="page-actions">
            <button class="btn btn-secondary" onclick="Router.navigate('cleanup')">${Icons.cleanup} Cleanup</button>
            <button class="btn btn-primary" id="dash-refresh">${Icons.refresh} Refresh</button>
          </div>
        </div>

        <!-- Summary Cards -->
        <div class="summary-grid">
          <div class="summary-card" onclick="Router.navigate('containers')">
            <div class="summary-card-icon teal">
              <span class="nav-item-icon">${Icons.container}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.totalContainers}</div>
              <div class="summary-card-label">Total Containers</div>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-card-icon green">
              <span class="nav-item-icon">${Icons.play}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.running}</div>
              <div class="summary-card-label">Running</div>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-card-icon red">
              <span class="nav-item-icon">${Icons.stop}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.stopped}</div>
              <div class="summary-card-label">Stopped</div>
            </div>
          </div>
          <div class="summary-card" onclick="Router.navigate('images')">
            <div class="summary-card-icon blue">
              <span class="nav-item-icon">${Icons.image}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.totalImages}</div>
              <div class="summary-card-label">Images</div>
            </div>
          </div>
          <div class="summary-card" onclick="Router.navigate('volumes')">
            <div class="summary-card-icon purple">
              <span class="nav-item-icon">${Icons.volume}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.totalVolumes}</div>
              <div class="summary-card-label">Volumes</div>
            </div>
          </div>
          <div class="summary-card" onclick="Router.navigate('networks')">
            <div class="summary-card-icon yellow">
              <span class="nav-item-icon">${Icons.network}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.totalNetworks}</div>
              <div class="summary-card-label">Networks</div>
            </div>
          </div>
          ${s.restarting > 0 ? `
          <div class="summary-card">
            <div class="summary-card-icon yellow">
              <span class="nav-item-icon">${Icons.restart}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.restarting}</div>
              <div class="summary-card-label">Restarting</div>
            </div>
          </div>` : ''}
          ${s.composeProjects > 0 ? `
          <div class="summary-card" onclick="Router.navigate('compose')">
            <div class="summary-card-icon teal">
              <span class="nav-item-icon">${Icons.compose}</span>
            </div>
            <div class="summary-card-content">
              <div class="summary-card-value">${s.composeProjects}</div>
              <div class="summary-card-label">Compose Projects</div>
            </div>
          </div>` : ''}
        </div>

        <!-- Disk Usage + System Info -->
        <div class="grid-2 mb-3">
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px">Disk Usage</div>
            <div style="font-size:24px;font-weight:800;margin-bottom:16px">${formatBytes(totalDisk)}</div>
            <div style="margin-bottom:12px">
              <div class="flex justify-between items-center text-sm mb-1">
                <span>Images</span><span class="text-muted">${formatBytes(disk.images)}</span>
              </div>
              <div class="disk-bar"><div class="disk-bar-fill blue" style="width:${totalDisk ? (disk.images/totalDisk*100) : 0}%"></div></div>
            </div>
            <div style="margin-bottom:12px">
              <div class="flex justify-between items-center text-sm mb-1">
                <span>Containers</span><span class="text-muted">${formatBytes(disk.containers)}</span>
              </div>
              <div class="disk-bar"><div class="disk-bar-fill green" style="width:${totalDisk ? (disk.containers/totalDisk*100) : 0}%"></div></div>
            </div>
            <div style="margin-bottom:12px">
              <div class="flex justify-between items-center text-sm mb-1">
                <span>Volumes</span><span class="text-muted">${formatBytes(disk.volumes)}</span>
              </div>
              <div class="disk-bar"><div class="disk-bar-fill purple" style="width:${totalDisk ? (disk.volumes/totalDisk*100) : 0}%"></div></div>
            </div>
            <div>
              <div class="flex justify-between items-center text-sm mb-1">
                <span>Build Cache</span><span class="text-muted">${formatBytes(disk.buildCache)}</span>
              </div>
              <div class="disk-bar"><div class="disk-bar-fill yellow" style="width:${totalDisk ? (disk.buildCache/totalDisk*100) : 0}%"></div></div>
            </div>
          </div>

          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px">System Info</div>
            <div class="detail-grid" style="grid-template-columns: 1fr">
              <div class="detail-item"><div class="detail-label">Docker Version</div><div class="detail-value">${data.system.dockerVersion || 'N/A'}</div></div>
              <div class="detail-item"><div class="detail-label">OS</div><div class="detail-value">${data.system.os || 'N/A'}</div></div>
              <div class="detail-item"><div class="detail-label">Architecture</div><div class="detail-value">${data.system.architecture || 'N/A'}</div></div>
              <div class="detail-item"><div class="detail-label">CPUs</div><div class="detail-value">${data.system.cpus || 'N/A'}</div></div>
              <div class="detail-item"><div class="detail-label">Memory</div><div class="detail-value">${data.system.memory ? formatBytes(data.system.memory) : 'N/A'}</div></div>
              <div class="detail-item"><div class="detail-label">Storage Driver</div><div class="detail-value">${data.system.storageDriver || 'N/A'}</div></div>
            </div>
          </div>
        </div>

        <!-- Insights + Activity -->
        <div class="grid-2">
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px">Smart Insights</div>
            ${data.insights.length === 0 ? '<div class="text-muted text-sm">No issues detected. Everything looks good! ✨</div>' :
              data.insights.map(i => `
                <div class="insight-card ${i.type}">
                  <span class="nav-item-icon">${i.type === 'warning' ? Icons.alert : Icons.info}</span>
                  <span>${i.message}</span>
                </div>
              `).join('')}
          </div>

          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px">Recent Activity</div>
            ${data.recentActivity.length === 0 ? '<div class="text-muted text-sm">No recent activity</div>' :
              `<div style="max-height:260px;overflow-y:auto">
                ${data.recentActivity.map(a => `
                  <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
                    <span class="badge badge-${a.action === 'start' ? 'running' : a.action === 'stop' ? 'stopped' : a.action === 'remove' ? 'dead' : 'created'}">
                      ${a.action}
                    </span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.resource_name || '')}</span>
                    <span class="text-muted text-xs">${timeAgo(a.created_at)}</span>
                  </div>
                `).join('')}
              </div>`}
          </div>
        </div>
      `;

      document.getElementById('dash-refresh')?.addEventListener('click', render);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Cannot connect to Docker</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary mt-2" onclick="Router.navigate('dashboard')">Retry</button></div>`;
    }
  }

  await render();
  refreshTimer = setInterval(render, 15000);

  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
