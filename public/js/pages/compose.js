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
            <button class="btn btn-secondary" id="compose-git">${Icons.registry || Icons.compose} Deploy from Git</button>
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
      document.getElementById('compose-git')?.addEventListener('click', openGitDeploy);
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
            const name = btn.dataset.detail;
            const [data, git] = await Promise.all([
              API.get(`/compose/${name}`),
              API.get(`/compose/${name}/git`).catch(() => ({ gitManaged: false })),
            ]);
            const webhookUrl = git.gitManaged ? `${location.origin}/api/compose/webhook/${encodeURIComponent(name)}?key=${git.webhookSecret}` : '';
            const gitSection = git.gitManaged ? `
              <div class="card mb-2" style="padding:12px;background:var(--accent-dim)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                  <div class="text-sm"><strong>Git</strong> — <code>${escapeHtml(git.repoUrl)}</code> @ <code>${escapeHtml(git.branch)}</code>${git.subdir ? ' /' + escapeHtml(git.subdir) : ''}</div>
                  <button class="btn btn-sm btn-primary" id="cd-redeploy">↻ Redeploy (pull latest)</button>
                </div>
                <div style="margin-top:8px"><div class="detail-label mb-1">Webhook URL (POST → re-deploy on push)</div><pre class="logs-viewer" style="white-space:pre-wrap;word-break:break-all;font-size:11px;padding:8px;margin:0">${escapeHtml(webhookUrl)}</pre><button class="btn btn-xs btn-secondary" id="cd-copy-hook" style="margin-top:6px">📋 Copy webhook URL</button></div>
              </div>` : '';
            const dm = showModal(`Compose: ${data.name}`, `
              ${gitSection}
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
            dm.overlay.querySelector('#cd-copy-hook')?.addEventListener('click', () => navigator.clipboard?.writeText(webhookUrl).then(() => showToast('Copied', 'success', 2000)));
            dm.overlay.querySelector('#cd-redeploy')?.addEventListener('click', async (e) => {
              const b = e.target; b.disabled = true; b.textContent = 'Redeploying…';
              try { await API.post(`/compose/${name}/redeploy`); showToast('Redeployed from Git'); dm.close(); render(); }
              catch (err) { showToast(err.message, 'error', 12000); b.disabled = false; b.textContent = '↻ Redeploy (pull latest)'; }
            });
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

  // #2-B — clone a Git repo → managed project → up. Shows the webhook URL for push-triggered re-deploys.
  function openGitDeploy() {
    const remote = isRemoteActive();
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Repository URL *</label><input class="input" id="gd-url" placeholder="https://github.com/user/repo"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:120px"><label>Branch</label><input class="input" id="gd-branch" placeholder="main"></div>
        <div class="input-group" style="flex:1;min-width:120px"><label>Subdir (monorepo, optional)</label><input class="input" id="gd-subdir" placeholder="e.g. apps/web"></div>
      </div>
      <div class="input-group"><label>Project name *</label><input class="input" id="gd-name" placeholder="my-app"></div>
      <div class="input-group"><label>Access token (private repos only)</label><input class="input" id="gd-token" type="password" placeholder="GitHub PAT with repo scope — not logged" autocomplete="new-password"></div>
      <div class="text-xs text-muted">${remote ? '<strong>Deploys to the active remote host.</strong> ' : ''}DockGate clones the repo and runs <code>docker compose up</code> (must contain a docker-compose.yml). You'll get a <strong>webhook URL</strong> to auto-redeploy on push.</div>
    </div>`;
    const m = showModal('Deploy from Git', body, []);
    const root = m.overlay;
    root.querySelector('#gd-url').addEventListener('input', (e) => {
      const nameInput = root.querySelector('#gd-name');
      if (!nameInput.value) {
        const repo = (e.target.value.split('/').pop() || '').replace(/\.git$/, '');
        if (repo) nameInput.value = repo.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      }
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Clone & Deploy';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const project = root.querySelector('#gd-name').value.trim();
      const repoUrl = root.querySelector('#gd-url').value.trim();
      if (!project || !repoUrl) { showToast('Repo URL and project name are required', 'warning'); return; }
      btn.disabled = true; btn.textContent = 'Cloning & deploying…';
      try {
        const r = await API.post('/compose/deploy-git', {
          project, repoUrl,
          branch: root.querySelector('#gd-branch').value.trim(),
          subdir: root.querySelector('#gd-subdir').value.trim(),
          token: root.querySelector('#gd-token').value,
          up: true,
        });
        m.close();
        const webhookUrl = `${location.origin}/api/compose/webhook/${encodeURIComponent(project)}?key=${r.webhookSecret}`;
        const wm = showModal('Deployed from Git ✓', `
          <div style="display:flex;flex-direction:column;gap:10px">
            <div class="text-sm">Project <strong>${escapeHtml(project)}</strong> is up (<code>${escapeHtml(r.composeFile)}</code>).</div>
            <div><div class="detail-label mb-1">Webhook URL (POST → auto re-deploy on push):</div>
              <pre class="logs-viewer" style="white-space:pre-wrap;word-break:break-all;font-size:11px;padding:10px">${escapeHtml(webhookUrl)}</pre>
              <button class="btn btn-xs btn-secondary" id="gd-copy-hook">📋 Copy webhook URL</button></div>
            <div class="text-xs text-muted">Add it as a GitHub webhook (Settings → Webhooks, content-type JSON). Keep the key secret. The webhook re-deploys onto the currently active host.</div>
          </div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
        wm.overlay.querySelector('#gd-copy-hook')?.addEventListener('click', () => navigator.clipboard?.writeText(webhookUrl).then(() => showToast('Copied', 'success', 2000)));
        render();
      } catch (e) { showToast(e.message, 'error', 12000); btn.disabled = false; btn.textContent = 'Clone & Deploy'; }
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
