// System info — rendered as a tab inside Settings (Settings → System), not a sidebar page.
// Global so settings.js can call it: renderSystemInfo(tabContentEl).
async function renderSystemInfo(content) {
    try {
      const info = await API.get('/system/info');
      content.innerHTML = `
        ${UI.header('System', 'The Docker engine and operating system DockGate is connected to.')}

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
               <div class="detail-item"><div class="detail-label">Plugins</div><div class="detail-value text-sm">Vol: ${info.Plugins?.Volume?.join(', ') || '—'}<br>Net: ${info.Plugins?.Network?.join(', ') || '—'}</div></div>
               <div class="detail-item"><div class="detail-label">Registries</div><div class="detail-value text-sm">${Object.keys(info.RegistryConfig?.IndexConfigs || {}).join(', ')}</div></div>
             </div>
          </div>
        </div>
        
        <div class="card mt-3">
          <div style="font-size:15px;font-weight:700;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:10px">Raw Inspection (Docker API)</div>
          <div class="json-viewer" style="max-height: 400px">${syntaxHighlightJSON(info)}</div>
        </div>
      `;

    } catch (err) { content.innerHTML = `${UI.errorState(err)}`; }
}
