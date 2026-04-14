// System Cleanup Page
Router.register('cleanup', async (content) => {
  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      const preview = await API.get('/cleanup/preview');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;
      
      const pruneOptions = [
        {
          id: 'containers',
          title: 'Stopped Containers',
          desc: 'Remove all stopped containers',
          count: preview.stoppedContainers.length,
          size: preview.estimatedSpace.containers, // It's just a count realistically for containers
          warning: false
        },
        {
          id: 'images',
          title: 'Unused Images',
          desc: 'Remove all images without at least one container associated with them',
          count: preview.unusedImages.length,
          size: preview.estimatedSpace.images,
          warning: true
        },
        {
          id: 'volumes',
          title: 'Unused Volumes',
          desc: 'Remove all anonymous and named volumes not used by any container',
          count: preview.unusedVolumes.length,
          size: 0,
          warning: true
        },
        {
          id: 'networks',
          title: 'Unused Networks',
          desc: 'Remove all custom networks not used by at least one container',
          count: preview.unusedNetworks.length,
          size: 0,
          warning: false
        },
        {
          id: 'build_cache',
          title: 'Build Cache',
          desc: 'Remove all internal and external docker builder caches to free up space',
          count: preview.estimatedSpace.buildCache > 0 ? 1 : 0, 
          size: preview.estimatedSpace.buildCache,
          warning: false
        }
      ];

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">System Cleanup</div><div class="page-subtitle">Safely remove unused data to free up space</div></div>
          <div class="page-actions"><button class="btn btn-secondary" id="cleanup-refresh">${Icons.refresh}</button></div>
        </div>

        <div class="grid-2">
          <div>
            ${pruneOptions.map(opt => `
              <div class="card mb-2">
                <div class="cleanup-section-header">
                  <div class="cleanup-section-title">
                    ${opt.title}
                    ${opt.count > 0 ? `<span class="cleanup-count">${opt.count}</span>` : ''}
                  </div>
                  <button class="btn-sm ${opt.count > 0 ? 'btn-primary' : 'btn-secondary'}" 
                          data-prune="${opt.id}" ${opt.count === 0 ? 'disabled' : ''}>
                    ${opt.id === 'build_cache' ? 'Clear Cache' : `Clean ${opt.count} Items`}
                  </button>
                </div>
                <div class="text-muted text-sm">${opt.desc}</div>
                ${opt.size > 0 ? `<div class="text-sm font-bold text-accent mt-1">Reclaimable space: ~${formatBytes(opt.size)}</div>` : ''}
              </div>
            `).join('')}
          </div>
          
          <div>
             <div class="card" style="border-color:var(--danger)">
                <div class="cleanup-section-header">
                  <div class="cleanup-section-title" style="color:var(--danger)">${Icons.alert} Full System Prune</div>
                </div>
                <div class="text-muted text-sm mb-2">
                  This will remove all unused containers, networks, images (both dangling and unreferenced), and optionally, volumes. 
                  <strong>This action cannot be undone.</strong>
                </div>
                <div class="input-group" style="margin-bottom: 12px">
                  <label style="display:flex;align-items:center;cursor:pointer;gap:8px">
                    <input type="checkbox" id="prune-volumes" style="width:16px;height:16px"> 
                    Include Volumes (deletes all unused persistent data)
                  </label>
                </div>
                <button class="btn btn-danger" id="full-prune-btn">${Icons.trash} Full Prune</button>
             </div>
          </div>
        </div>
      `;

      document.getElementById('cleanup-refresh')?.addEventListener('click', render);

      content.querySelectorAll('[data-prune]').forEach(btn => {
        btn.addEventListener('click', () => {
          const type = btn.dataset.prune;
          showConfirm(`Prune ${type}`, `Are you sure you want to remove all unused ${type}?`, async () => {
            try {
              showToast(`Cleaning ${type}...`, 'info');
              const res = await API.post(`/cleanup/${type}`);
              let space = res.SpaceReclaimed ? ` (${formatBytes(res.SpaceReclaimed)})` : (res.SpaceReclaimedStr ? ` (${res.SpaceReclaimedStr.replace('Total reclaimed space:', '').trim()})` : '');
              showToast(`Cleanup successful${space}`);
              render();
            } catch (err) { showToast(err.message, 'error'); }
          }, type === 'volumes' || type === 'images');
        });
      });

      document.getElementById('full-prune-btn').addEventListener('click', () => {
        const includeVols = document.getElementById('prune-volumes').checked;
        showConfirm(`Full System Prune`, `Are you absolutely sure? This will delete ALL unused data${includeVols ? ' INCLUDING VOLUMES.' : '.'}`, async () => {
          try {
             showToast(`Starting full system prune...`, 'warn');
             const res = await API.post(`/cleanup/system?volumes=${includeVols}`);
             showToast(`System pruned successfully`);
             render();
          } catch(err) { showToast(err.message, 'error'); }
        }, true);
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  
  await render();
});
