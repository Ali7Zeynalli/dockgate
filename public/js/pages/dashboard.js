// Dashboard Page / Dashboard Səhifəsi
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

        <!-- Summary Cards / Xülasə Kartları -->
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

        <!-- Quick Actions / Sürətli Əməliyyatlar -->
        ${s.running > 0 || s.stopped > 0 ? `
        <div class="card" style="margin-bottom:20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="font-size:15px;font-weight:700;">Quick Actions</div>
            <div style="display:flex;gap:8px;">
              ${s.stopped > 0 ? `<button class="btn btn-sm btn-secondary" id="qa-start-all">${Icons.play} Start All Stopped</button>` : ''}
              ${s.running > 0 ? `<button class="btn btn-sm btn-secondary" id="qa-stop-all">${Icons.stop} Stop All Running</button>` : ''}
              ${s.running > 0 ? `<button class="btn btn-sm btn-secondary" id="qa-restart-all">${Icons.restart} Restart All</button>` : ''}
            </div>
          </div>
        </div>` : ''}

        <!-- Container Resource Monitor / Konteyner Resurs Monitoru -->
        ${data.containerStats && data.containerStats.length > 0 ? `
        <div class="card" style="margin-bottom:20px;">
          <div style="font-size:15px;font-weight:700;margin-bottom:16px;">Container Resources</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <!-- CPU Usage / CPU İstifadəsi -->
            <div>
              <div class="text-xs text-muted" style="margin-bottom:10px;font-weight:600;">CPU USAGE</div>
              ${data.containerStats.slice(0, 5).map(cs => `
                <div style="margin-bottom:10px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <span class="text-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%;" title="${escapeHtml(cs.name)}">${escapeHtml(cs.name)}</span>
                    <span class="text-xs" style="font-weight:600;color:${cs.cpuPercent > 80 ? 'var(--danger)' : cs.cpuPercent > 50 ? 'var(--warning)' : 'var(--success)'};">${cs.cpuPercent.toFixed(1)}%</span>
                  </div>
                  <div class="disk-bar"><div class="disk-bar-fill ${cs.cpuPercent > 80 ? 'red' : cs.cpuPercent > 50 ? 'yellow' : 'green'}" style="width:${Math.min(cs.cpuPercent, 100)}%;transition:width 0.5s;"></div></div>
                </div>
              `).join('')}
            </div>
            <!-- Memory Usage / Yaddaş İstifadəsi -->
            <div>
              <div class="text-xs text-muted" style="margin-bottom:10px;font-weight:600;">MEMORY USAGE</div>
              ${[...data.containerStats].sort((a, b) => b.memoryPercent - a.memoryPercent).slice(0, 5).map(cs => `
                <div style="margin-bottom:10px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <span class="text-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;" title="${escapeHtml(cs.name)}">${escapeHtml(cs.name)}</span>
                    <span class="text-xs text-muted">${formatBytes(cs.memoryUsage)} / ${formatBytes(cs.memoryLimit)}</span>
                  </div>
                  <div class="disk-bar"><div class="disk-bar-fill ${cs.memoryPercent > 80 ? 'red' : cs.memoryPercent > 50 ? 'yellow' : 'blue'}" style="width:${Math.min(cs.memoryPercent, 100)}%;transition:width 0.5s;"></div></div>
                </div>
              `).join('')}
            </div>
          </div>
          <!-- Network I/O Summary / Şəbəkə I/O Xülasəsi -->
          ${data.containerStats.some(cs => cs.networkRx > 0 || cs.networkTx > 0) ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
            <div class="text-xs text-muted" style="margin-bottom:10px;font-weight:600;">NETWORK I/O (Top 5)</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:8px;">
              ${[...data.containerStats].sort((a, b) => (b.networkRx + b.networkTx) - (a.networkRx + a.networkTx)).slice(0, 5).map(cs => `
                <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:8px 12px;">
                  <div class="text-sm" style="font-weight:500;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(cs.name)}">${escapeHtml(cs.name)}</div>
                  <div style="display:flex;gap:12px;">
                    <span class="text-xs"><span style="color:var(--success);">↓</span> ${formatBytes(cs.networkRx)}</span>
                    <span class="text-xs"><span style="color:var(--accent);">↑</span> ${formatBytes(cs.networkTx)}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>` : ''}
        </div>` : ''}

        <!-- Health Status + Uptime / Sağlamlıq + İşləmə Müddəti -->
        <div class="grid-2 mb-3">
          <!-- Container Health / Konteyner Sağlamlığı -->
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px;">Health Status</div>
            ${data.containerDetails && data.containerDetails.length > 0 ? `
              <div style="display:flex;gap:16px;margin-bottom:16px;">
                ${data.healthStats.healthy > 0 ? `<div style="text-align:center;"><div style="font-size:24px;font-weight:800;color:var(--success);">${data.healthStats.healthy}</div><div class="text-xs text-muted">Healthy</div></div>` : ''}
                ${data.healthStats.unhealthy > 0 ? `<div style="text-align:center;"><div style="font-size:24px;font-weight:800;color:var(--danger);">${data.healthStats.unhealthy}</div><div class="text-xs text-muted">Unhealthy</div></div>` : ''}
                ${data.healthStats.starting > 0 ? `<div style="text-align:center;"><div style="font-size:24px;font-weight:800;color:var(--warning);">${data.healthStats.starting}</div><div class="text-xs text-muted">Starting</div></div>` : ''}
                <div style="text-align:center;"><div style="font-size:24px;font-weight:800;color:var(--text-muted);">${data.healthStats.noHealthcheck}</div><div class="text-xs text-muted">No Check</div></div>
              </div>
              <canvas id="health-chart" height="120"></canvas>
            ` : '<div class="text-muted text-sm">No running containers</div>'}
          </div>

          <!-- Container Uptime & Restarts / İşləmə Müddəti & Yenidən Başlamalar -->
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px;">Uptime & Restarts</div>
            ${data.containerDetails && data.containerDetails.length > 0 ? `
              <div style="max-height:280px;overflow-y:auto;">
                ${data.containerDetails
                  .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
                  .map(cd => {
                    const uptime = cd.startedAt ? timeDuration(cd.startedAt) : 'N/A';
                    return `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
                      <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${cd.health === 'healthy' ? 'var(--success)' : cd.health === 'unhealthy' ? 'var(--danger)' : cd.health === 'starting' ? 'var(--warning)' : 'var(--text-muted)'};" title="${cd.health}"></span>
                      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(cd.name)}">${escapeHtml(cd.name)}</span>
                      <span class="text-xs text-muted" title="Uptime">⏱ ${uptime}</span>
                      ${cd.restartCount > 0 ? `<span class="badge badge-stopped" title="Restart count">${Icons.restart} ${cd.restartCount}</span>` : ''}
                    </div>`;
                  }).join('')}
              </div>
            ` : '<div class="text-muted text-sm">No running containers</div>'}
          </div>
        </div>

        <!-- Disk Usage + System Info / Disk İstifadəsi + Sistem Məlumatı -->
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

        <!-- Port Map + Top Images / Port Xəritəsi + Ən Böyük Image-lər -->
        <div class="grid-2 mb-3">
          <!-- Port Map / Port Xəritəsi -->
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px;">Port Map</div>
            ${data.portMap && data.portMap.length > 0 ? `
              <div style="max-height:260px;overflow-y:auto;">
                <table style="width:100%;font-size:12px;border-collapse:collapse;">
                  <thead>
                    <tr style="border-bottom:1px solid var(--border);">
                      <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:600;">Host Port</th>
                      <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:600;">Container</th>
                      <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:600;">Port</th>
                      <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:600;">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${data.portMap.map(p => `
                      <tr style="border-bottom:1px solid var(--border);">
                        <td style="padding:6px 8px;font-family:var(--font-mono);font-weight:600;">${p.hostIp}:${p.hostPort}</td>
                        <td style="padding:6px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;" title="${escapeHtml(p.container)}">${escapeHtml(p.container)}</td>
                        <td style="padding:6px 8px;font-family:var(--font-mono);">${p.containerPort}/${p.protocol}</td>
                        <td style="padding:6px 8px;"><span class="badge badge-${p.state === 'running' ? 'running' : 'stopped'}">${p.state}</span></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="text-muted text-sm">No exposed ports</div>'}
          </div>

          <!-- Top Images by Size / Ən Böyük Image-lər -->
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px;">Top Images by Size</div>
            ${data.topImages && data.topImages.length > 0 ? `
              <div style="max-height:260px;overflow-y:auto;">
                ${data.topImages.map((img, i) => {
                  const maxSize = data.topImages[0].size || 1;
                  const pct = (img.size / maxSize) * 100;
                  return `
                  <div style="margin-bottom:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                      <span class="text-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%;" title="${escapeHtml(img.tag)}">${escapeHtml(img.tag)}</span>
                      <span class="text-xs" style="display:flex;align-items:center;gap:6px;">
                        ${!img.inUse ? '<span style="color:var(--warning);font-size:10px;" title="Unused">●</span>' : ''}
                        <span class="text-muted">${formatBytes(img.size)}</span>
                      </span>
                    </div>
                    <div class="disk-bar"><div class="disk-bar-fill blue" style="width:${pct}%"></div></div>
                  </div>`;
                }).join('')}
              </div>
            ` : '<div class="text-muted text-sm">No images found</div>'}
          </div>
        </div>

        <!-- Insights + Activity / Təhlillər + Fəaliyyət -->
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

      // Event listeners / Hadisə dinləyiciləri
      document.getElementById('dash-refresh')?.addEventListener('click', render);

      // Quick Actions handlers / Sürətli əməliyyat hadisələri
      document.getElementById('qa-start-all')?.addEventListener('click', () => {
        showConfirm('Start All Stopped', 'Start all stopped containers?', async () => {
          try {
            const containers = await API.get('/containers?all=true');
            const stopped = containers.filter(c => c.state === 'exited');
            for (const c of stopped) { await API.post(`/containers/${c.id}/start`).catch(() => {}); }
            showToast(`Started ${stopped.length} container(s)`, 'success');
            render();
          } catch(e) { showToast(e.message, 'error'); }
        });
      });

      document.getElementById('qa-stop-all')?.addEventListener('click', () => {
        showConfirm('Stop All Running', 'Stop all running containers? This may affect active services.', async () => {
          try {
            const containers = await API.get('/containers?all=true');
            const running = containers.filter(c => c.state === 'running');
            for (const c of running) { await API.post(`/containers/${c.id}/stop`).catch(() => {}); }
            showToast(`Stopped ${running.length} container(s)`, 'success');
            render();
          } catch(e) { showToast(e.message, 'error'); }
        }, true);
      });

      document.getElementById('qa-restart-all')?.addEventListener('click', () => {
        showConfirm('Restart All Running', 'Restart all running containers?', async () => {
          try {
            const containers = await API.get('/containers?all=true');
            const running = containers.filter(c => c.state === 'running');
            for (const c of running) { await API.post(`/containers/${c.id}/restart`).catch(() => {}); }
            showToast(`Restarted ${running.length} container(s)`, 'success');
            render();
          } catch(e) { showToast(e.message, 'error'); }
        });
      });

      // Health pie chart / Sağlamlıq pie chart-ı
      const healthCanvas = document.getElementById('health-chart');
      if (healthCanvas && data.healthStats) {
        const hs = data.healthStats;
        const total = hs.healthy + hs.unhealthy + hs.starting + hs.noHealthcheck;
        if (total > 0) {
          new Chart(healthCanvas, {
            type: 'doughnut',
            data: {
              labels: ['Healthy', 'Unhealthy', 'Starting', 'No Healthcheck'],
              datasets: [{
                data: [hs.healthy, hs.unhealthy, hs.starting, hs.noHealthcheck],
                backgroundColor: ['#00d4aa', '#ff4d6a', '#ffb224', '#555570'],
                borderWidth: 0,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              cutout: '65%',
              plugins: {
                legend: {
                  position: 'right',
                  labels: { color: '#9ca3af', font: { size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 },
                },
              },
            },
          });
        }
      }

    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Cannot connect to Docker</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary mt-2" onclick="Router.navigate('dashboard')">Retry</button></div>`;
    }
  }

  await render();
  refreshTimer = setInterval(render, 15000);

  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});

// Helper: duration from ISO date to now / ISO tarixdən indiyə qədər müddət
function timeDuration(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return 'just started';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
