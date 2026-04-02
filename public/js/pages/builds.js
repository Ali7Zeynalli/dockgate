/**
 * Builds səhifəsi — real-time build izləmə və build tarixçəsi
 * Niyə: Docker image build prosesini canlı izləmək və keçmiş buildləri görmək
 * Modul: Frontend builds page
 * İstifadə: public/js/app.js naviqasiyası ilə
 */
Router.register('builds', async (content) => {
  // Aktiv build vəziyyəti
  let activeBuild = null;
  let buildLogEl = null;

  // Tab vəziyyəti
  let activeTab = 'history';

  async function render() {
    content.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Builds</div>
          <div class="page-subtitle">Docker image build et və tarixçəni izlə</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="new-build-btn">${Icons.play} New Build</button>
          <button class="btn btn-secondary" id="builds-refresh">${Icons.refresh}</button>
        </div>
      </div>

      <div class="tab-bar" style="margin-bottom: 16px;">
        <button class="tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history">Build Tarixçəsi</button>
        <button class="tab-btn ${activeTab === 'cache' ? 'active' : ''}" data-tab="cache">Build Cache</button>
        ${activeBuild ? `<button class="tab-btn ${activeTab === 'live' ? 'active' : ''}" data-tab="live" style="color: var(--accent)">● Live Build</button>` : ''}
      </div>

      <div id="tab-content"></div>
    `;

    // Tab hadisələri
    content.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        render();
      });
    });

    document.getElementById('new-build-btn')?.addEventListener('click', showNewBuildModal);
    document.getElementById('builds-refresh')?.addEventListener('click', render);

    // Aktiv tab-ı render et
    if (activeTab === 'history') await renderHistory();
    else if (activeTab === 'cache') await renderCache();
    else if (activeTab === 'live') renderLiveBuild();
  }

  // Build tarixçəsi tab-ı
  async function renderHistory() {
    const tabContent = document.getElementById('tab-content');
    try {
      const builds = await API.get('/builds');

      if (builds.length === 0) {
        tabContent.innerHTML = `
          <div class="empty-state">
            <span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">${Icons.layers}</span>
            <h3>Build tarixçəsi boşdur</h3>
            <p>Hələ heç bir image build edilməyib. "New Build" düyməsinə basın.</p>
          </div>
        `;
        return;
      }

      tabContent.innerHTML = `
        <div class="page-actions" style="margin-bottom: 12px; justify-content: flex-end;">
          <button class="btn btn-danger btn-sm" id="clear-history">${Icons.trash} Tarixçəni Təmizlə</button>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Image Tag</th>
                <th>Dockerfile</th>
                <th>Başlama Vaxtı</th>
                <th>Müddət</th>
                <th>Image ID</th>
                <th>Əməliyyatlar</th>
              </tr>
            </thead>
            <tbody>
              ${builds.map(b => `
                <tr>
                  <td>${buildStatusBadge(b.status)}</td>
                  <td class="td-mono">${escapeHtml(b.image_tag || 'untagged')}</td>
                  <td class="text-sm">${escapeHtml(b.dockerfile || 'Dockerfile')}</td>
                  <td class="text-sm">${b.started_at ? timeAgo(b.started_at) : '-'}</td>
                  <td class="text-sm">${b.duration_ms ? formatDuration(b.duration_ms) : (b.status === 'building' ? 'davam edir...' : '-')}</td>
                  <td class="td-mono text-sm">${b.image_id ? b.image_id.replace('sha256:', '').substring(0, 12) : '-'}</td>
                  <td>
                    <button class="btn btn-sm btn-secondary view-build-log" data-id="${b.id}" title="Loqu göstər">${Icons.eye}</button>
                    <button class="btn btn-sm btn-danger delete-build" data-id="${b.id}" title="Sil">${Icons.trash}</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      // Loq baxış hadisələri
      tabContent.querySelectorAll('.view-build-log').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          try {
            const build = await API.get(`/builds/${id}`);
            showModal('Build Loqu — ' + escapeHtml(build.image_tag || build.id.substring(0, 8)), `
              <div style="margin-bottom: 8px;">
                <span>${buildStatusBadge(build.status)}</span>
                ${build.duration_ms ? `<span class="text-sm text-muted" style="margin-left: 8px;">${formatDuration(build.duration_ms)}</span>` : ''}
                ${build.error ? `<div style="color: var(--danger); margin-top: 8px;">${escapeHtml(build.error)}</div>` : ''}
              </div>
              <pre class="build-log-viewer" style="background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 12px; max-height: 400px; overflow: auto; font-size: 12px; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-all;">${escapeHtml(build.log || 'Loq mövcud deyil')}</pre>
            `, [{ label: 'Bağla', className: 'btn btn-secondary' }]);
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

      // Silmə hadisələri
      tabContent.querySelectorAll('.delete-build').forEach(btn => {
        btn.addEventListener('click', () => {
          showConfirm('Build Sil', 'Bu build qeydini silmək istəyirsiniz?', async () => {
            try {
              await API.del(`/builds/${btn.dataset.id}`);
              showToast('Build silindi', 'success');
              render();
            } catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      });

      // Tarixçəni təmizlə
      document.getElementById('clear-history')?.addEventListener('click', () => {
        showConfirm('Tarixçəni Təmizlə', 'Bütün build tarixçəsi silinəcək. Davam etmək istəyirsiniz?', async () => {
          try {
            await API.del('/builds');
            showToast('Tarixçə təmizləndi', 'success');
            render();
          } catch (err) { showToast(err.message, 'error'); }
        }, true);
      });

    } catch (err) {
      tabContent.innerHTML = `<div class="empty-state"><h3>Xəta</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  // Build cache tab-ı — qruplaşdırılmış görünüş
  async function renderCache() {
    const tabContent = document.getElementById('tab-content');
    try {
      const cache = await API.get('/builds/cache');
      const totalSize = cache.reduce((a, b) => a + (b.Size || 0), 0);

      if (cache.length === 0) {
        tabContent.innerHTML = `
          <div class="empty-state">
            <span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">${Icons.layers}</span>
            <h3>Build cache boşdur</h3>
            <p>Docker builder cache-də heç bir element yoxdur.</p>
          </div>
        `;
        return;
      }

      // Cache elementlərini Parent əlaqəsinə görə ağac strukturuna yığ
      const byId = {};
      cache.forEach(item => { byId[item.ID] = item; });

      // Root-ları tap — Parent-i olmayan və ya Parent-i siyahıda olmayan elementlər
      const childrenOf = {};
      const roots = [];
      cache.forEach(item => {
        const parentId = item.Parent || '';
        if (!parentId || !byId[parentId]) {
          roots.push(item);
        } else {
          if (!childrenOf[parentId]) childrenOf[parentId] = [];
          childrenOf[parentId].push(item);
        }
      });

      // Hər root-dan başlayaraq bütün uşaqları topla (build paketi)
      function collectDescendants(id) {
        const items = [];
        const children = childrenOf[id] || [];
        for (const child of children) {
          items.push(child);
          items.push(...collectDescendants(child.ID));
        }
        return items;
      }

      // Build paketlərini yarat
      const groups = [];
      const usedIds = new Set();

      roots.forEach(root => {
        const descendants = collectDescendants(root.ID);
        const all = [root, ...descendants];
        all.forEach(i => usedIds.add(i.ID));
        const groupSize = all.reduce((a, b) => a + (b.Size || 0), 0);

        // Qrup adını təyin et — description-dan və ya tipindən
        let groupName = root.Description || '';
        if (!groupName || groupName === 'Təsvir yoxdur') {
          // Uşaqlardan mənalı bir ad tap
          const meaningful = all.find(i => i.Description && !i.Description.startsWith('mount') && !i.Description.startsWith('local'));
          groupName = meaningful?.Description || root.Type || 'Build Layer';
        }
        // Uzun adları qısalt
        if (groupName.length > 80) groupName = groupName.substring(0, 77) + '...';

        groups.push({
          name: groupName,
          root,
          items: all,
          totalSize: groupSize,
          inUse: all.some(i => i.InUse),
          shared: all.some(i => i.Shared),
        });
      });

      // İstifadə olunmayan tək elementlər (əgər varsa)
      const orphans = cache.filter(i => !usedIds.has(i.ID));
      if (orphans.length > 0) {
        groups.push({
          name: 'Digər cache elementləri',
          root: null,
          items: orphans,
          totalSize: orphans.reduce((a, b) => a + (b.Size || 0), 0),
          inUse: orphans.some(i => i.InUse),
          shared: false,
        });
      }

      tabContent.innerHTML = `
        <div class="page-actions" style="margin-bottom: 12px; justify-content: space-between;">
          <span class="text-sm text-muted">${groups.length} build paketi · ${cache.length} layer · ${formatBytes(totalSize)} ümumi</span>
          <button class="btn btn-danger btn-sm" id="prune-cache">${Icons.trash} Cache Təmizlə</button>
        </div>
        <div id="cache-groups"></div>
      `;

      const groupsContainer = document.getElementById('cache-groups');

      groups.forEach((group, idx) => {
        const groupEl = document.createElement('div');
        groupEl.style.cssText = 'margin-bottom: 8px;';
        groupEl.innerHTML = `
          <div class="cache-group-header" data-group="${idx}" style="display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); cursor: pointer; transition: all 150ms ease; user-select: none;">
            <span class="cache-group-chevron" style="transition: transform 200ms ease; display: flex;">${Icons.chevronRight}</span>
            <span style="flex: 1; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
            <span class="badge badge-created" style="font-size: 10px;">${group.items.length} layer</span>
            ${group.inUse ? '<span class="text-accent text-xs font-bold">İstifadədə</span>' : ''}
            ${group.shared ? '<span class="text-muted text-xs">Paylaşılan</span>' : ''}
            <span class="text-sm" style="min-width: 70px; text-align: right;">${formatBytes(group.totalSize)}</span>
          </div>
          <div class="cache-group-body" data-group-body="${idx}" style="display: none; border: 1px solid var(--border); border-top: none; border-radius: 0 0 var(--radius-lg) var(--radius-lg); overflow: hidden;">
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th style="text-align:left;padding:8px 16px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);border-bottom:1px solid var(--border);background:rgba(0,0,0,0.15);">Cache ID</th>
                  <th style="text-align:left;padding:8px 16px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);border-bottom:1px solid var(--border);background:rgba(0,0,0,0.15);">Tip</th>
                  <th style="text-align:left;padding:8px 16px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);border-bottom:1px solid var(--border);background:rgba(0,0,0,0.15);">Təsvir</th>
                  <th style="text-align:left;padding:8px 16px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);border-bottom:1px solid var(--border);background:rgba(0,0,0,0.15);">Ölçü</th>
                  <th style="text-align:left;padding:8px 16px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);border-bottom:1px solid var(--border);background:rgba(0,0,0,0.15);">Vəziyyət</th>
                </tr>
              </thead>
              <tbody>
                ${group.items.map(b => `
                  <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding:10px 16px;font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);">${(b.ID || 'N/A').substring(0, 15)}...</td>
                    <td style="padding:10px 16px;"><span class="badge ${b.Type === 'regular' ? 'badge-running' : 'badge-created'}">${escapeHtml(b.Type || 'Unknown')}</span></td>
                    <td style="padding:10px 16px;max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono);font-size:12px;" title="${escapeHtml(b.Description || '')}">${escapeHtml(b.Description || 'Təsvir yoxdur')}</td>
                    <td style="padding:10px 16px;font-size:13px;">${formatBytes(b.Size || 0)}</td>
                    <td style="padding:10px 16px;font-size:12px;">
                      ${b.InUse ? '<span class="text-accent font-bold">İstifadədə</span>' : '<span class="text-muted">Boş</span>'}
                      ${b.Shared ? ' · Paylaşılan' : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
        groupsContainer.appendChild(groupEl);

        // Açılıb-bağlanma hadisəsi
        const header = groupEl.querySelector(`[data-group="${idx}"]`);
        const body = groupEl.querySelector(`[data-group-body="${idx}"]`);
        const chevron = header.querySelector('.cache-group-chevron');

        header.addEventListener('click', () => {
          const isOpen = body.style.display !== 'none';
          body.style.display = isOpen ? 'none' : 'block';
          chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
          header.style.borderRadius = isOpen ? 'var(--radius-lg)' : 'var(--radius-lg) var(--radius-lg) 0 0';
        });

        header.addEventListener('mouseenter', () => { header.style.borderColor = 'var(--border-hover)'; });
        header.addEventListener('mouseleave', () => { header.style.borderColor = 'var(--border)'; });
      });

      document.getElementById('prune-cache')?.addEventListener('click', () => {
        showConfirm('Cache Təmizlə', 'Bütün build cache silinəcək. Növbəti buildlər daha uzun çəkə bilər.', async () => {
          try {
            showToast('Cache təmizlənir...', 'info');
            const res = await API.post('/builds/cache/prune');
            let space = res.SpaceReclaimedStr ? ` (${res.SpaceReclaimedStr.replace('Total reclaimed space:', '').trim()})` : '';
            showToast(`Cache təmizləndi${space}`, 'success');
            renderCache();
          } catch (err) { showToast(err.message, 'error'); }
        }, true);
      });

    } catch (err) {
      tabContent.innerHTML = `<div class="empty-state"><h3>Xəta</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  // Live build tab-ı — real-time loq göstərir
  function renderLiveBuild() {
    const tabContent = document.getElementById('tab-content');
    if (!activeBuild) {
      tabContent.innerHTML = `<div class="empty-state"><h3>Aktiv build yoxdur</h3></div>`;
      return;
    }

    tabContent.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
        <span class="badge badge-running" style="animation: pulse 1.5s infinite;">● Building</span>
        <span class="td-mono">${escapeHtml(activeBuild.tag || 'untagged')}</span>
        <button class="btn btn-danger btn-sm" id="cancel-build">${Icons.stop} Dayandır</button>
      </div>
      <div id="build-log-live" style="background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 12px; height: 500px; overflow-y: auto; font-size: 12px; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-all; line-height: 1.6;"></div>
    `;

    buildLogEl = document.getElementById('build-log-live');

    // Əvvəlki loqları göstər
    if (activeBuild.logs) {
      buildLogEl.textContent = activeBuild.logs;
      buildLogEl.scrollTop = buildLogEl.scrollHeight;
    }

    document.getElementById('cancel-build')?.addEventListener('click', () => {
      socket.emit('build:cancel');
      showToast('Build dayandırılır...', 'info');
    });
  }

  // Yeni build modal-ı
  function showNewBuildModal() {
    const { close } = showModal('Yeni Image Build', `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="display: block; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary);">Image Tag</label>
          <input type="text" id="build-tag" class="input" placeholder="myapp:latest" style="width: 100%;" />
        </div>
        <div>
          <label style="display: block; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary);">Context (Git repo URL və ya remote tarball URL)</label>
          <input type="text" id="build-context" class="input" placeholder="https://github.com/user/repo.git" style="width: 100%;" />
        </div>
        <div>
          <label style="display: block; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary);">Dockerfile yolu</label>
          <input type="text" id="build-dockerfile" class="input" placeholder="Dockerfile" value="Dockerfile" style="width: 100%;" />
        </div>
        <div style="display: flex; gap: 16px;">
          <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="build-nocache" /> Cache istifadə etmə
          </label>
          <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="build-pull" /> Base image-i yenilə
          </label>
        </div>
      </div>
    `, [
      { label: 'Ləğv et', className: 'btn btn-secondary' },
      { label: 'Build Başlat', className: 'btn btn-primary', onClick: () => startBuild(close) },
    ]);
  
}
  // Build başlat
  function startBuild() {
    const tag = document.getElementById('build-tag')?.value.trim();
    const contextValue = document.getElementById('build-context')?.value.trim();
    const dockerfile = document.getElementById('build-dockerfile')?.value.trim() || 'Dockerfile';
    const nocache = document.getElementById('build-nocache')?.checked || false;
    const pull = document.getElementById('build-pull')?.checked || false;

    if (!contextValue) {
      showToast('Context (URL) daxil edin', 'error');
      return;
    }

    // Aktiv build vəziyyətini qur
    activeBuild = { tag: tag || 'untagged', logs: '', startTime: Date.now() };

    // WebSocket ilə build başlat
    socket.emit('build:start', {
      contextType: 'url',
      contextValue,
      tag,
      dockerfile,
      nocache,
      pull,
    });

    showToast('Build başladı...', 'info');
    activeTab = 'live';
    render();
  }

  // WebSocket build hadisələri
  function onBuildLog({ buildId, data }) {
    if (!activeBuild) return;
    activeBuild.logs += data;
    if (buildLogEl) {
      buildLogEl.textContent += data;
      buildLogEl.scrollTop = buildLogEl.scrollHeight;
    }
  }

  function onBuildComplete({ buildId, status, duration, imageId }) {
    const tag = activeBuild?.tag || 'untagged';
    activeBuild = null;
    buildLogEl = null;

    if (status === 'success') {
      showToast(`Build uğurla tamamlandı: ${tag} (${formatDuration(duration)})`, 'success');
    } else {
      showToast(`Build uğursuz oldu: ${tag}`, 'error');
    }

    activeTab = 'history';
    render();
  }

  function onBuildError({ buildId, error }) {
    showToast(`Build xətası: ${error}`, 'error');
    activeBuild = null;
    buildLogEl = null;
    activeTab = 'history';
    render();
  }

  function onBuildCancelled() {
    showToast('Build dayandırıldı', 'warning');
    activeBuild = null;
    buildLogEl = null;
    activeTab = 'history';
    render();
  }

  // Socket listener-ləri qoş
  socket.on('build:log', onBuildLog);
  socket.on('build:complete', onBuildComplete);
  socket.on('build:error', onBuildError);
  socket.on('build:cancelled', onBuildCancelled);

  // Yardımçı funksiyalar
  function buildStatusBadge(status) {
    const map = {
      'success': '<span class="badge badge-running">Uğurlu</span>',
      'failed': '<span class="badge badge-exited">Uğursuz</span>',
      'building': '<span class="badge badge-created" style="animation: pulse 1.5s infinite;">Building</span>',
    };
    return map[status] || `<span class="badge">${escapeHtml(status)}</span>`;
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return m + 'm ' + rs + 's';
  }

  // Səhifə yüklə
  await render();

  // Cleanup — səhifədən çıxanda listener-ləri sil
  return () => {
    socket.off('build:log', onBuildLog);
    socket.off('build:complete', onBuildComplete);
    socket.off('build:error', onBuildError);
    socket.off('build:cancelled', onBuildCancelled);
  };
});
