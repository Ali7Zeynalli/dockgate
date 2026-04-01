// System Info Page
Router.register('system', async (content) => {
  async function render() {
    try {
      const info = await API.get('/system/info');
      const df = await API.get('/system/df');
      
      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">System Information</div><div class="page-subtitle">Docker Engine & Host OS details</div></div>
        </div>

        <div class="grid-2">
          <div class="card">
             <div style="font-size:15px;font-weight:700;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:10px">Engine Information</div>
             <div class="detail-grid" style="grid-template-columns:1fr">
               <div class="detail-item"><div class="detail-label">Server Version</div><div class="detail-value">${info.ServerVersion}</div></div>
               <div class="detail-item"><div class="detail-label">OS</div><div class="detail-value">${info.OperatingSystem}</div></div>
               <div class="detail-item"><div class="detail-label">Kernel</div><div class="detail-value">${info.KernelVersion}</div></div>
               <div class="detail-item"><div class="detail-label">Architecture</div><div class="detail-value">${info.Architecture}</div></div>
               <div class="detail-item"><div class="detail-label">CPUs / Memory</div><div class="detail-value">${info.NCPU} Cores / ${formatBytes(info.MemTotal)}</div></div>
               <div class="detail-item"><div class="detail-label">Storage Driver</div><div class="detail-value">${info.Driver}</div></div>
               <div class="detail-item"><div class="detail-label">Logging Driver</div><div class="detail-value">${info.LoggingDriver}</div></div>
               <div class="detail-item"><div class="detail-label">Cgroup Version</div><div class="detail-value">${info.CgroupVersion}</div></div>
             </div>
          </div>

          <div class="card">
             <div style="font-size:15px;font-weight:700;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:10px">Docker Directories</div>
             <div class="detail-grid" style="grid-template-columns:1fr">
               <div class="detail-item"><div class="detail-label">Docker Root Dir</div><div class="detail-value mono text-sm">${info.DockerRootDir}</div></div>
               <div class="detail-item"><div class="detail-label">Runtimes</div><div class="detail-value text-sm">${Object.keys(info.Runtimes || {}).join(', ')}</div></div>
               <div class="detail-item"><div class="detail-label">Plugins</div><div class="detail-value text-sm">Vol: ${info.Plugins?.Volume?.join(', ')}<br>Net: ${info.Plugins?.Network?.join(', ')}</div></div>
               <div class="detail-item"><div class="detail-label">Registries</div><div class="detail-value text-sm">${Object.keys(info.RegistryConfig?.IndexConfigs || {}).join(', ')}</div></div>
             </div>
          </div>
        </div>
        
        <div class="card mt-3">
          <div style="font-size:15px;font-weight:700;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:10px">Raw Inspection (Docker API)</div>
          <div class="json-viewer" style="max-height: 400px">${syntaxHighlightJSON(info)}</div>
        </div>
      `;

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  await render();
});
