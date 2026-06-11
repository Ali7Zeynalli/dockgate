// Compose Page
Router.register('compose', async (content) => {
  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;
  let refreshTimer = null;

  // The Compose editor (New Project / Edit YAML) now lives in the shared global openComposeEditor()
  // (public/js/compose-editor.js) so the Templates page can reuse it to deploy stack templates.

  async function render() {
    try {
      const projects = await API.get('/compose');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;
      // Compose runs the host `docker compose` CLI. On a remote SSH host it targets that daemon via
      // DOCKER_HOST=ssh (DockGate-managed projects only; key-auth, no passphrase). The backend returns a
      // clear 400 if unsupported, so we no longer pre-disable — just show an informational note.
      const remote = isRemoteActive();
      const dis = '';
      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Compose Projects</div><div class="page-subtitle">${projects.length} project(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="compose-new" ${dis}>${Icons.compose} New Project</button>
            <button class="btn btn-secondary" id="compose-folder">${Icons.arrowUp || Icons.compose} Deploy from folder</button>
            <button class="btn btn-secondary" id="compose-refresh">${Icons.refresh}</button>
          </div>
        </div>
        ${remote ? '<div class="card mb-3" style="border-left:3px solid var(--accent);padding:10px 14px;font-size:13px;color:var(--text-secondary)">Remote host active — only <strong>DockGate-managed</strong> projects can be deployed (the compose file lives on DockGate). Needs a key-based SSH server without a passphrase; bind-mount paths resolve on the remote host.</div>' : ''}
        ${projects.length === 0 ? '<div class="empty-state"><h3>No Compose Projects</h3></div>' : `
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Project Name</th><th>Status</th><th>Services</th><th>Path</th><th style="text-align:right">Actions</th></tr></thead>
              <tbody>
                ${projects.map(p => `<tr>
                  <td class="td-name">${escapeHtml(p.name)}</td>
                  <td><span class="badge ${p.running === p.total ? 'badge-running' : p.running > 0 ? 'badge-restarting' : 'badge-stopped'}">${p.running}/${p.total} Running</span></td>
                  <td class="text-sm">${p.services.join(', ') || '—'}</td>
                  <td class="td-mono text-xs" title="${escapeHtml(p.workingDir)}">${escapeHtml(p.workingDir) || '—'}</td>
                  <td><div class="td-actions">
                    <button class="btn-sm btn-primary" data-action="up" data-project="${p.name}" ${dis}>${Icons.play} Up</button>
                    <button class="btn-sm btn-secondary" data-action="down" data-project="${p.name}" ${dis}>${Icons.stop} Down</button>
                    <button class="btn-sm btn-secondary" data-action="restart" data-project="${p.name}" ${dis}>${Icons.restart}</button>
                    <button class="btn-sm btn-secondary" data-action="build" data-project="${p.name}" ${dis} title="docker compose build — rebuild services that have a build: section">${Icons.layers} Build</button>
                    <button class="btn-icon" title="Edit YAML" data-edit="${p.name}" ${dis}>${Icons.settings}</button>
                    <button class="btn-icon" title="View Services" data-detail="${p.name}">${Icons.eye}</button>
                  </div></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        `}
      `;

      document.getElementById('compose-refresh')?.addEventListener('click', render);
      document.getElementById('compose-new')?.addEventListener('click', () => openComposeEditor(null));
      document.getElementById('compose-folder')?.addEventListener('click', openFolderDeploy);
      content.querySelectorAll('[data-edit]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openComposeEditor(btn.dataset.edit); });
      });

      content.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const project = btn.dataset.project;
          const run = async () => {
            try {
              showToast(`${action}ing project ${project}...`, 'info');
              await API.post(`/compose/${project}/${action}`);
              showToast('Success');
              render();
            } catch (err) { showToast(err.message, 'error'); }
          };
          // down/restart are disruptive — confirm first (down removes containers; restart interrupts)
          if (action === 'down') {
            showConfirm('Compose Down', `Stop and remove all containers in "${project}"?`, run, true);
          } else if (action === 'restart') {
            showConfirm('Compose Restart', `Restart all services in "${project}"? They will be briefly interrupted.`, run, true);
          } else {
            run();
          }
        });
      });

      content.querySelectorAll('[data-detail]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const data = await API.get(`/compose/${btn.dataset.detail}`);
            showModal(`Compose: ${data.name}`, `
              <div class="detail-grid mb-2">
                <div class="detail-item"><div class="detail-label">Working Directory</div><div class="detail-value mono">${escapeHtml(data.workingDir)}</div></div>
                <div class="detail-item"><div class="detail-label">Config Files</div><div class="detail-value mono">${escapeHtml(data.configFiles)}</div></div>
              </div>
              <div class="table-wrapper">
                <table>
                  <thead><tr><th>Service</th><th>Container</th><th>State</th></tr></thead>
                  <tbody>${data.services.map(s => `<tr>
                    <td class="td-name">${escapeHtml(s.name)}</td>
                    <td class="td-mono text-sm">${escapeHtml(s.containerName)}</td>
                    <td><span class="badge badge-${s.state}">${s.status}</span></td>
                  </tr>`).join('')}</tbody>
                </table>
              </div>
            `, [{ label: 'Close', className: 'btn btn-secondary' }]);
          } catch (e) { showToast(e.message, 'error'); }
        });
      });
    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  // Read a File as base64 (without the data: prefix)
  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // #2-A — upload a whole project folder → managed project → compose up (active daemon, local or remote)
  function openFolderDeploy() {
    const remote = isRemoteActive();
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Project name *</label><input class="input" id="fd-name" placeholder="my-app"></div>
      <div class="input-group"><label>Project folder (must contain a docker-compose.yml)</label>
        <input type="file" id="fd-folder" webkitdirectory directory multiple style="font-size:12px">
        <span class="text-xs text-muted" id="fd-info" style="margin-top:4px;display:block">No folder selected.</span>
      </div>
      <div class="text-xs text-muted">${remote ? '<strong>Deploys to the active remote host</strong> (over SSH). ' : ''}Files upload to DockGate, then <code>docker compose up</code> runs. <code>.git</code> / <code>node_modules</code> are skipped. Build contexts upload to the daemon; bind-mount paths resolve on the daemon's host. Best with image-based compose; ~50MB max.</div>
    </div>`;
    const m = showModal('Deploy from folder', body, []);
    const root = m.overlay;
    let picked = [];
    root.querySelector('#fd-folder').addEventListener('change', (e) => {
      picked = [...e.target.files].filter(f => {
        const rel = f.webkitRelativePath.split('/').slice(1).join('/');
        return rel && !rel.startsWith('.git/') && !/(^|\/)node_modules\//.test(rel);
      });
      const folderName = e.target.files[0]?.webkitRelativePath.split('/')[0];
      const nameInput = root.querySelector('#fd-name');
      if (folderName && !nameInput.value) nameInput.value = folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const hasCompose = picked.some(f => /(^|\/)(docker-)?compose\.ya?ml$/.test(f.webkitRelativePath));
      const bytes = picked.reduce((a, f) => a + f.size, 0);
      root.querySelector('#fd-info').innerHTML = `${picked.length} file(s), ${formatBytes(bytes)}${hasCompose ? '' : ' — <span style="color:var(--warning)">⚠ no docker-compose.yml found</span>'}`;
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Deploy';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const project = root.querySelector('#fd-name').value.trim();
      if (!project) { showToast('Project name required', 'warning'); return; }
      if (!picked.length) { showToast('Select a project folder first', 'warning'); return; }
      const bytes = picked.reduce((a, f) => a + f.size, 0);
      if (bytes > 50 * 1024 * 1024) { showToast('Folder exceeds the 50MB limit', 'error'); return; }
      btn.disabled = true; btn.textContent = 'Reading…';
      try {
        const files = [];
        for (const f of picked) {
          files.push({ path: f.webkitRelativePath.split('/').slice(1).join('/'), b64: await fileToB64(f) });
        }
        btn.textContent = 'Deploying…';
        const r = await API.post('/compose/deploy-folder', { project, files, up: true });
        showToast(`Deployed "${project}" (${r.composeFile})`);
        m.close();
        render();
      } catch (e) { showToast(e.message, 'error', 11000); btn.disabled = false; btn.textContent = 'Deploy'; }
    });
  }

  await render();
  // Auto-refresh project running counts; skip while a modal/input is active
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
