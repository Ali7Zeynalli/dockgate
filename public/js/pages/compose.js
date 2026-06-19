// Compose Page
Router.register('compose', async (content) => {
  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;
  let refreshTimer = null;
  let deployTimer = null;

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
                    <button class="btn-sm btn-secondary" data-action="rebuild" data-project="${p.name}" ${dis} title="Rebuild images from source + up (docker compose up -d --build)">${Icons.layers} Rebuild</button>
                    ${p.deploySource === 'folder' ? `<button class="btn-sm btn-secondary" data-update="${p.name}" data-rpath="${escapeHtml(p.workingDir || '')}" title="Re-upload the (updated) folder & rebuild">${Icons.refresh} Update</button>` : ''}
                    <button class="btn-icon" title="Edit YAML" data-edit="${p.name}" ${dis}>${Icons.settings}</button>
                    <button class="btn-icon" title="Project files (Dockerfile, .env…)" data-files="${p.name}">${Icons.folder || Icons.compose}</button>
                    <button class="btn-icon" title="View Services" data-detail="${p.name}">${Icons.eye}</button>
                    <button class="btn-icon text-danger" title="Delete project (containers + files)" data-delproj="${p.name}" data-remote="${p.remote ? 1 : ''}">${Icons.trash}</button>
                  </div></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        `}
        <div id="deploy-console" style="margin-top:18px"></div>
      `;

      renderDeploys();
      document.getElementById('compose-refresh')?.addEventListener('click', render);
      document.getElementById('compose-new')?.addEventListener('click', () => openComposeEditor(null));
      document.getElementById('compose-folder')?.addEventListener('click', openFolderDeploy);
      document.getElementById('compose-git')?.addEventListener('click', openGitDeploy);
      content.querySelectorAll('[data-files]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openProjectFiles(btn.dataset.files); }));
      content.querySelectorAll('[data-delproj]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteProject(btn.dataset.delproj, !!btn.dataset.remote); }));
      content.querySelectorAll('[data-update]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openFolderDeploy({ update: btn.dataset.update, remotePath: btn.dataset.rpath }); }));
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

  // Remote folder picker — navigate the active server's directory tree and pick a parent folder.
  async function openRemoteFolderPicker(onPick) {
    let cwd = '/';
    try { const ctx = await API.get('/files/context'); cwd = ctx.home || '/'; } catch (e) {}
    const m = showModal('Choose a folder on the server', `
      <div class="text-xs text-muted mb-2">Open a folder, then <strong>Select</strong> it — the project folder is created inside the selected folder.</div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
        <button class="btn btn-xs btn-secondary" id="rp-up">⬆ Up</button>
        <code id="rp-path" class="text-xs" style="flex:1;word-break:break-all"></code>
      </div>
      <div id="rp-list" style="max-height:48vh;overflow-y:auto;border:1px solid var(--border);border-radius:6px"></div>`,
      [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const sel = document.createElement('button'); sel.className = 'btn btn-primary'; sel.textContent = 'Select this folder';
    root.querySelector('#modal-footer').appendChild(sel);
    sel.addEventListener('click', () => { m.close(); onPick(cwd); });
    const parentOf = (p) => { if (!p || p === '/') return '/'; const i = p.replace(/\/$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
    root.querySelector('#rp-up').addEventListener('click', () => { cwd = parentOf(cwd); load(); });
    async function load() {
      const list = root.querySelector('#rp-list');
      list.innerHTML = '<div class="text-muted text-sm" style="padding:10px">Loading…</div>';
      try {
        const d = await API.get(`/files?path=${encodeURIComponent(cwd)}`);
        cwd = d.path;
        root.querySelector('#rp-path').textContent = cwd;
        const dirs = (d.entries || []).filter(e => e.type === 'dir');
        list.innerHTML = dirs.length
          ? dirs.map(e => `<div class="rp-dir" data-d="${escapeHtml(e.name)}" style="padding:6px 10px;cursor:pointer">📁 ${escapeHtml(e.name)}</div>`).join('')
          : '<div class="text-muted text-sm" style="padding:10px">No sub-folders here — Select to use this folder.</div>';
        list.querySelectorAll('.rp-dir').forEach(el => el.addEventListener('click', () => { cwd = (cwd === '/' ? '' : cwd) + '/' + el.dataset.d; load(); }));
      } catch (e) { list.innerHTML = `<div class="text-danger" style="padding:10px">${escapeHtml(e.message)}</div>`; }
    }
    load();
  }

  // Delete a whole project: down (+volumes opt) + remove its files (remote folder / local managed dir).
  function openDeleteProject(project, isRemote) {
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="text-sm">Delete project <strong>${escapeHtml(project)}</strong>?</div>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400"><input type="checkbox" id="del-down" checked disabled> Stop &amp; remove containers (<code>docker compose down</code>)</label>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400"><input type="checkbox" id="del-files" checked> Remove the project files ${isRemote ? '(the folder on the remote server)' : '(DockGate-managed files)'}</label>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--danger,#f85149)"><input type="checkbox" id="del-vols"> Also delete data volumes — <strong>irreversible data loss</strong></label>
    </div>`;
    const m = showModal('Delete project', body, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const btn = document.createElement('button'); btn.className = 'btn btn-danger'; btn.textContent = 'Delete';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Deleting…';
      const vols = root.querySelector('#del-vols').checked ? 1 : 0;
      const files = root.querySelector('#del-files').checked ? 1 : 0;
      try {
        await API.del(`/compose/${project}?volumes=${vols}&files=${files}`);
        showToast(`Deleted "${project}"`);
        m.close();
        render();
      } catch (e) { showToast(e.message, 'error', 11000); btn.disabled = false; btn.textContent = 'Delete'; }
    });
  }

  // Phase 1 — browse/edit ALL files of a managed project (Dockerfile, .dockerignore, .env, configs…)
  function fileIcon(f, composeFile) {
    if (f.type === 'dir') return '📁';
    if (f.path === composeFile) return '🐳';
    const n = f.path.split('/').pop().toLowerCase();
    if (n === 'dockerfile' || n.endsWith('.dockerfile')) return '📦';
    if (n === '.dockerignore' || n === '.gitignore') return '🚫';
    if (n === '.env' || n.startsWith('.env')) return '🔑';
    return '📄';
  }
  function openFileEditor(project, filePath, content, onSave) {
    const m = showModal(`Edit — ${escapeHtml(filePath)}`, `<textarea id="pf-edit" class="input" spellcheck="false" style="width:100%;height:50vh;font-family:var(--font-mono,monospace);font-size:13px;white-space:pre;overflow:auto"></textarea>`, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    root.querySelector('#pf-edit').value = content; // set via value (avoids HTML-escaping issues)
    const save = document.createElement('button'); save.className = 'btn btn-primary'; save.textContent = 'Save';
    root.querySelector('#modal-footer').appendChild(save);
    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = 'Saving…';
      try {
        await API.put(`/compose/${project}/filecontent`, { path: filePath, content: root.querySelector('#pf-edit').value });
        showToast('Saved');
        m.close();
        if (onSave) onSave();
      } catch (e) { showToast(e.message, 'error', 9000); save.disabled = false; save.textContent = 'Save'; }
    });
  }
  async function editFileFromTree(project, filePath, onSave) {
    try {
      const d = await API.get(`/compose/${project}/filecontent?path=${encodeURIComponent(filePath)}`);
      if (d.isBinary) { showToast(`Binary file (${formatBytes(d.size)}) — not editable here`, 'warning', 4000); return; }
      openFileEditor(project, filePath, d.content, onSave);
    } catch (e) { showToast(e.message, 'error'); }
  }
  async function openProjectFiles(project) {
    // Open the modal immediately with a loading state, then fetch ONCE (remote = SFTP, can take a couple seconds).
    let data = { files: [], composeFile: null };
    const m = showModal(`Files — ${escapeHtml(project)}`, `<div class="text-xs text-muted mb-2">Project files (Dockerfile, .dockerignore, .env, configs…). On a remote-deployed project these are the files on the server. The compose file is also editable from here.</div><div id="pf-list" style="max-height:58vh;overflow-y:auto"><div class="text-muted text-sm" style="padding:14px">Loading…</div></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const newBtn = document.createElement('button'); newBtn.className = 'btn btn-secondary btn-sm'; newBtn.textContent = '+ New file';
    root.querySelector('#modal-footer').prepend(newBtn);
    newBtn.addEventListener('click', () => {
      const p = prompt('New file path (relative to the project), e.g. Dockerfile or conf/app.conf');
      if (p && p.trim()) openFileEditor(project, p.trim(), '', refresh);
    });
    function rowHtml(f) {
      const depth = f.path.split('/').length - 1;
      const name = f.path.split('/').pop();
      const isCompose = f.path === data.composeFile;
      const acts = f.type === 'file' ? `
        <button class="btn btn-xs btn-secondary" data-edit-file="${escapeHtml(f.path)}">Edit</button>
        ${isCompose ? '' : `<button class="btn btn-xs btn-ghost text-danger" data-del-file="${escapeHtml(f.path)}">${Icons.trash}</button>`}` : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;padding-left:${depth * 16}px">
        <span>${fileIcon(f, data.composeFile)}</span>
        <span class="td-mono text-sm" style="flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}${isCompose ? ' <span class="badge badge-running" style="font-size:9px">compose</span>' : ''}</span>
        <span class="text-xs text-muted">${f.type === 'file' ? formatBytes(f.size) : ''}</span>${acts}</div>`;
    }
    async function refresh() {
      const el = root.querySelector('#pf-list');
      if (!el) return;
      try { data = await API.get(`/compose/${project}/tree`); }
      catch (e) { if (root.querySelector('#pf-list')) el.innerHTML = `<div class="text-danger text-sm" style="padding:14px">${escapeHtml(e.message)}</div>`; return; }
      if (!root.querySelector('#pf-list')) return; // modal closed during the fetch
      el.innerHTML = data.files.length ? data.files.map(rowHtml).join('') : '<div class="text-muted text-sm" style="padding:14px">No files.</div>';
      el.querySelectorAll('[data-edit-file]').forEach(b => b.addEventListener('click', () => editFileFromTree(project, b.dataset.editFile, refresh)));
      el.querySelectorAll('[data-del-file]').forEach(b => b.addEventListener('click', () => {
        showConfirm('Delete file', `Delete "${escapeHtml(b.dataset.delFile)}"?`, async () => {
          try { await API.del(`/compose/${project}/filecontent?path=${encodeURIComponent(b.dataset.delFile)}`); showToast('Deleted'); refresh(); }
          catch (e) { showToast(e.message, 'error'); }
        }, true);
      }));
    }
    refresh();
  }

  // #2-A v2 — upload a project folder FILE BY FILE (staging session) with a live "uploaded n / total"
  // list, then finish → validate → compose up. opts.update = re-upload an existing remote project to
  // its stored folder + rebuild (project name & path locked; optional clean replace).
  // After an upload is scanned, let the user PICK which compose file(s) to deploy, which services, and how
  // to build. Each compose file = its own stack (own project). Resolves to a plan, or null if cancelled.
  function chooseDeployPlan(files, defaultProject) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (settled) return; settled = true; resolve(v); };
      const cards = files.map((f, i) => {
        const seg = f.dir === '.' ? '' : (f.dir.split('/').pop() || '');
        const stackName = (seg ? `${defaultProject}-${seg}` : defaultProject).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const svcRows = (f.services || []).length
          ? f.services.map(s => `<label style="margin-right:12px;font-size:12px"><input type="checkbox" class="fd-svc" data-i="${i}" value="${escapeHtml(s)}" checked> ${escapeHtml(s)}</label>`).join('')
          : '<span class="text-muted text-xs">no services parsed — all will be deployed</span>';
        const nets = (f.externalNets || []).length ? `<div class="text-xs text-muted" style="margin-top:2px">external network: ${f.externalNets.map(escapeHtml).join(', ')}</div>` : '';
        const err = f.parseError ? `<div class="text-xs" style="color:var(--warning);margin-top:2px">⚠ ${escapeHtml(f.parseError)}</div>` : '';
        return `<div class="card" style="padding:10px;margin-bottom:8px">
          <label style="font-weight:600;display:flex;gap:8px;align-items:center"><input type="checkbox" class="fd-stack" data-i="${i}" checked> <code>${escapeHtml(f.path)}</code></label>
          ${err}${nets}
          <div style="margin:6px 0 6px">${svcRows}</div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px">
            <label><input type="checkbox" class="fd-build" data-i="${i}" ${f.hasBuild ? 'checked' : ''}> build</label>
            <label><input type="checkbox" class="fd-nocache" data-i="${i}"> no-cache</label>
            <label><input type="checkbox" class="fd-pull" data-i="${i}"> pull</label>
            <label><input type="checkbox" class="fd-nodeps" data-i="${i}"> no-deps</label>
            <span>name: <input class="input" id="fd-sname-${i}" style="width:170px;display:inline-block;padding:2px 6px" value="${escapeHtml(stackName)}"></span>
          </div>
        </div>`;
      }).join('');
      const allNets = [...new Set(files.flatMap(f => f.externalNets || []))];
      const netRows = allNets.length ? `<div class="card" style="padding:8px 10px;margin-bottom:8px"><div style="font-weight:600;font-size:13px;margin-bottom:4px">External networks (created before deploy)</div>${allNets.map(n => `<label style="margin-right:12px;font-size:12px"><input type="checkbox" class="fd-net" value="${escapeHtml(n)}" checked> ${escapeHtml(n)}</label>`).join('')}</div>` : '';
      const body = `<div style="display:flex;flex-direction:column">
        <div class="text-xs text-muted" style="margin-bottom:8px">Pick which compose file(s) to deploy, which services, and how to build. Each file = its own stack (own project), deployed top → bottom.</div>
        ${netRows}${cards}</div>`;
      const m2 = showModal('Choose what to deploy', body, [{ label: 'Cancel', className: 'btn btn-secondary', onClick: () => settle(null) }]);
      const r2 = m2.overlay;
      r2.querySelector('.modal-close').onclick = () => { settle(null); m2.close(); };
      r2.onclick = (e) => { if (e.target === r2) { settle(null); m2.close(); } };
      const deploy = document.createElement('button');
      deploy.className = 'btn btn-primary'; deploy.textContent = 'Deploy';
      r2.querySelector('#modal-footer').appendChild(deploy);
      deploy.onclick = () => {
        const stacks = [];
        r2.querySelectorAll('.fd-stack').forEach(cb => {
          if (!cb.checked) return;
          const i = cb.dataset.i, f = files[i];
          const all = f.services || [];
          const chosen = [...r2.querySelectorAll(`.fd-svc[data-i="${i}"]`)].filter(x => x.checked).map(x => x.value);
          stacks.push({
            name: (r2.querySelector(`#fd-sname-${i}`).value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            composeFile: f.path,
            services: (chosen.length && chosen.length < all.length) ? chosen : [], // [] = all services
            build: r2.querySelector(`.fd-build[data-i="${i}"]`).checked,
            noCache: r2.querySelector(`.fd-nocache[data-i="${i}"]`).checked,
            pull: r2.querySelector(`.fd-pull[data-i="${i}"]`).checked,
            noDeps: r2.querySelector(`.fd-nodeps[data-i="${i}"]`).checked,
          });
        });
        if (!stacks.length) return showToast('Select at least one compose file', 'warning');
        if (stacks.some(s => !s.name)) return showToast('Each stack needs a name', 'warning');
        const createNets = [...r2.querySelectorAll('.fd-net')].filter(x => x.checked).map(x => x.value);
        settle({ createNets, stacks });
        m2.close();
      };
    });
  }

  function openFolderDeploy(opts = {}) {
    const isUpdate = !!opts.update;
    const remote = isUpdate ? true : isRemoteActive();
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Project name *</label><input class="input" id="fd-name" placeholder="my-app" value="${isUpdate ? escapeHtml(opts.update) : ''}" ${isUpdate ? 'readonly' : ''}></div>
      ${isUpdate ? `
      <div class="card" style="padding:10px 12px;background:var(--accent-dim)">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px">↻ Update on the remote server</div>
        <div class="text-xs text-muted">Re-pick the updated folder — files are uploaded to <code>${escapeHtml(opts.remotePath || 'its existing folder')}</code> and <code>docker compose up -d --build</code> applies the changes.</div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;margin-top:8px;font-size:13px"><input type="checkbox" id="fd-clean"> Clean replace — delete the folder's contents first (removes files you've dropped from the project)</label>
      </div>` : remote ? `
      <div class="card" style="padding:10px 12px;background:var(--accent-dim)">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">Deploy target: remote server ⭐</div>
        <div class="input-group"><label>Folder on the server (files live &amp; run here)</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="fd-rpath" placeholder="~/.dockgate/projects/&lt;project&gt;" style="flex:1;font-family:var(--font-mono,monospace)">
            <button type="button" class="btn btn-secondary btn-sm" id="fd-browse" style="white-space:nowrap">📁 Browse</button>
          </div>
          <span class="text-xs text-muted" style="margin-top:4px;display:block">Default <code>~/.dockgate/projects/&lt;project&gt;</code>. <strong>Browse</strong> to pick another parent — the project folder is created under it.</span>
        </div>
        <div class="text-xs" style="margin-top:6px;color:var(--text-secondary)">📌 These files stay on the server and survive <strong>Down / Up / restart</strong>. They're removed only when you <strong>Delete</strong> the project with “remove files”.</div>
      </div>` : ''}
      <div class="input-group"><label>Project folder (must contain a docker-compose.yml)</label>
        <input type="file" id="fd-folder" webkitdirectory directory multiple style="font-size:12px">
        <span class="text-xs text-muted" id="fd-info" style="margin-top:4px;display:block">No folder selected.</span>
      </div>
      <div id="fd-progress" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span class="text-sm" id="fd-counter">0 / 0</span>
          <span class="text-xs text-muted" id="fd-remaining"></span>
        </div>
        <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div id="fd-bar" style="height:100%;width:0%;background:var(--accent);transition:width .2s"></div></div>
        <div id="fd-list" style="margin-top:8px;max-height:180px;overflow-y:auto;font-size:12px;font-family:var(--font-mono,monospace);line-height:1.7"></div>
        <pre id="fd-joblog" class="logs-viewer" style="display:none;margin-top:8px;max-height:200px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-word"></pre>
        <div id="fd-jobnote" class="text-xs text-muted" style="display:none;margin-top:6px">You can close this — the deploy keeps running on the server.</div>
      </div>
      <div class="text-xs text-muted">${remote ? '<strong>Deploys to the active remote host</strong> (over SSH). ' : ''}Files upload one by one, then <code>docker compose up</code> runs. <code>.git</code> / <code>node_modules</code> are skipped. Bind-mount paths resolve on the daemon's host. ~50MB max.</div>
    </div>`;
    const m = showModal(isUpdate ? `Update “${opts.update}” from folder` : 'Deploy from folder', body, []);
    const root = m.overlay;
    let picked = [];
    let uploadId = null; // active staging session — aborted if the modal closes mid-upload
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
    // Browse the remote server's folders → pick a PARENT → project folder is created under it.
    root.querySelector('#fd-browse')?.addEventListener('click', () => {
      const project = root.querySelector('#fd-name').value.trim() || 'project';
      openRemoteFolderPicker((parentDir) => {
        root.querySelector('#fd-rpath').value = (parentDir === '/' ? '' : parentDir) + '/' + project;
      });
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = isUpdate ? 'Update & Rebuild' : 'Deploy';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const project = root.querySelector('#fd-name').value.trim();
      if (!project) { showToast('Project name required', 'warning'); return; }
      if (!picked.length) { showToast('Select a project folder first', 'warning'); return; }
      const bytes = picked.reduce((a, f) => a + f.size, 0);
      if (bytes > 50 * 1024 * 1024) { showToast('Folder exceeds the 50MB limit', 'error'); return; }
      btn.disabled = true; btn.textContent = 'Uploading…';
      const prog = root.querySelector('#fd-progress');
      const list = root.querySelector('#fd-list');
      const bar = root.querySelector('#fd-bar');
      const counter = root.querySelector('#fd-counter');
      const remaining = root.querySelector('#fd-remaining');
      prog.style.display = 'block';
      // Render the full file list once; each row's status icon is updated in place as it uploads.
      list.innerHTML = picked.map((f, i) => {
        const rel = f.webkitRelativePath.split('/').slice(1).join('/');
        return `<div id="fd-row-${i}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span id="fd-st-${i}">·</span> ${escapeHtml(rel)} <span class="text-muted">(${formatBytes(f.size)})</span></div>`;
      }).join('');
      const setStatus = (i, icon, color) => { const el = root.querySelector(`#fd-st-${i}`); if (el) { el.textContent = icon; el.style.color = color || ''; } };
      try {
        const startBody = { project };
        if (isUpdate) {
          startBody.update = true;
          startBody.target = { clean: !!root.querySelector('#fd-clean')?.checked };
        } else if (remote) {
          const rpath = (root.querySelector('#fd-rpath')?.value || '').trim() || `~/.dockgate/projects/${project}`;
          startBody.target = { mode: 'remote', remotePath: rpath };
        }
        const started = await API.post('/compose/deploy-folder-start', startBody);
        uploadId = started.uploadId;
        for (let i = 0; i < picked.length; i++) {
          const f = picked[i];
          setStatus(i, '⏳', 'var(--accent)');
          root.querySelector(`#fd-row-${i}`)?.scrollIntoView({ block: 'nearest' });
          const b64 = await fileToB64(f);
          await API.post('/compose/deploy-folder-file', { uploadId, path: f.webkitRelativePath.split('/').slice(1).join('/'), b64 });
          setStatus(i, '✓', 'var(--success,#3fb950)');
          counter.textContent = `${i + 1} / ${picked.length}`;
          remaining.textContent = i + 1 < picked.length ? `${picked.length - i - 1} remaining` : 'validating & starting…';
          bar.style.width = `${Math.round(((i + 1) / picked.length) * 100)}%`;
        }
        // Upload done. For a FRESH deploy, scan the tree and let the user pick compose file(s)/services/build.
        let plan = null;
        if (!isUpdate) {
          btn.textContent = 'Scanning…'; remaining.textContent = 'scanning compose files…';
          let scan = { files: [] };
          try { scan = await API.post('/compose/deploy-folder-scan', { uploadId }); } catch (e) {}
          if ((scan.files || []).length) {
            plan = await chooseDeployPlan(scan.files, project);
            if (!plan) { // cancelled → drop the staged upload, reset the modal
              if (uploadId) { API.post('/compose/deploy-folder-abort', { uploadId }).catch(() => {}); uploadId = null; }
              btn.disabled = false; btn.textContent = 'Deploy'; remaining.textContent = 'cancelled';
              return;
            }
          }
        }
        // Hand off to a background job that keeps running even if this modal closes.
        btn.textContent = isUpdate ? 'Rebuilding…' : 'Starting…';
        const finished = await API.post('/compose/deploy-folder-finish', { uploadId, up: true, plan });
        uploadId = null; // the backend job owns the staging now — aborting on close no longer applies
        const joblog = root.querySelector('#fd-joblog');
        joblog.style.display = 'block';
        root.querySelector('#fd-jobnote').style.display = 'block';
        const phaseLabel = { starting: 'starting…', clean: 'cleaning the folder…', upload: 'uploading to the server…', up: 'docker compose up…', done: 'done', error: 'failed' };
        // Poll the job; closing the modal just stops polling — the deploy still finishes server-side.
        while (true) {
          let job;
          try { job = await API.get(`/compose/deploy-job/${finished.jobId}`); }
          catch (e) { remaining.textContent = 'running in background'; break; } // job expired or modal gone
          if (!document.body.contains(root)) return; // modal closed → leave it running on the backend
          joblog.textContent = job.log || '';
          joblog.scrollTop = joblog.scrollHeight;
          remaining.textContent = phaseLabel[job.phase] || job.phase;
          if (job.status === 'done') {
            bar.style.width = '100%';
            showToast(job.result?.updated ? `Updated "${project}"` : `Deployed "${project}"`, 'success', 5000);
            // Swap the Deploy button for a fresh Close (clone drops the old deploy listener).
            const closeBtn = btn.cloneNode(true);
            closeBtn.textContent = 'Close'; closeBtn.disabled = false; closeBtn.className = 'btn btn-secondary';
            btn.replaceWith(closeBtn);
            closeBtn.addEventListener('click', () => m.close());
            render();
            return;
          }
          if (job.status === 'error') {
            showToast(job.error || 'Deploy failed', 'error', 12000);
            btn.disabled = false; btn.textContent = isUpdate ? 'Update & Rebuild' : 'Deploy';
            remaining.textContent = 'failed';
            return;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (e) {
        // Failure during the upload phase (before the job starts) → mark the file + drop staging.
        const idx = [...list.querySelectorAll('[id^="fd-st-"]')].findIndex(el => el.textContent !== '✓');
        if (idx >= 0) setStatus(idx, '✗', 'var(--danger,#f85149)');
        if (uploadId) { API.post('/compose/deploy-folder-abort', { uploadId }).catch(() => {}); uploadId = null; }
        showToast(e.message, 'error', 11000);
        btn.disabled = false; btn.textContent = isUpdate ? 'Update & Rebuild' : 'Deploy';
        remaining.textContent = 'failed';
      }
    });
  }

  // ① Deploys console — running/recent background deploy jobs, re-openable live log (modal can be closed).
  async function renderDeploys() {
    const el = document.getElementById('deploy-console');
    if (!el) return;
    let jobs = [];
    try { jobs = await API.get('/compose/deploy-jobs'); } catch (e) { return; }
    if (!document.getElementById('deploy-console')) return;
    if (!jobs.length) { el.innerHTML = ''; return; }
    const active = jobs.filter(j => j.status === 'running').length;
    const icon = (s) => s === 'running' ? '<span class="spinner" style="display:inline-block;width:10px;height:10px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite"></span>' : (s === 'done' ? '<span style="color:var(--success,#3fb950)">✓</span>' : '<span style="color:var(--danger,#f85149)">✗</span>');
    el.innerHTML = `
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">Deploys${active ? ` <span class="badge badge-running" style="font-size:10px">${active} active</span>` : ''}</div>
      <div class="table-wrapper"><table><tbody>${jobs.map(j => `<tr>
        <td style="width:24px">${icon(j.status)}</td>
        <td class="td-name">${escapeHtml(j.project)}</td>
        <td class="text-xs text-muted">${escapeHtml(j.phase)}${(j.steps && j.steps.length) ? ` <span style="opacity:.7">(${j.steps.filter(s => s.status === 'done').length}/${j.steps.length})</span>` : ''}</td>
        <td class="text-xs text-muted">${j.finishedAt ? timeAgo(j.finishedAt) : 'running…'}</td>
        <td style="text-align:right"><button class="btn btn-xs btn-secondary" data-joblog="${j.id}" data-jobproj="${escapeHtml(j.project)}">view log</button></td>
      </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-joblog]').forEach(b => b.addEventListener('click', () => openDeployLog(b.dataset.joblog, b.dataset.jobproj)));
  }

  // Per-step status icon for the deploy console (mirrors the per-file upload rows).
  function deployStepIcon(s) {
    if (s === 'done') return '<span style="color:var(--success,#3fb950)">✓</span>';
    if (s === 'failed') return '<span style="color:var(--danger,#f85149)">✗</span>';
    if (s === 'running') return '<span style="color:var(--accent)">⏳</span>';
    if (s === 'skipped') return '<span class="text-muted">∅</span>';
    return '<span class="text-muted">·</span>';
  }

  // Re-openable live log for a deploy job — per-step status + a real terminal (xterm) so docker's
  // \r progress bars and ANSI colors render correctly. Poll until done; closing just stops polling.
  function openDeployLog(jobId, project) {
    const m = showModal(`Deploy — ${escapeHtml(project)}`, `
      <div class="text-xs text-muted" id="dl-phase" style="margin-bottom:6px">…</div>
      <div id="dl-steps" style="display:flex;flex-direction:column;gap:2px;margin-bottom:8px;font-size:12px"></div>
      <div id="dl-term" style="height:46vh;background:#000;border-radius:6px;overflow:hidden;padding:6px"></div>`,
      [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    // Real terminal so \r/ANSI render right; fall back to a <pre> if xterm isn't available.
    let term = null, fit = null, pre = null, written = 0;
    const host = root.querySelector('#dl-term');
    try {
      if (typeof Terminal === 'undefined') throw new Error('no xterm');
      term = new Terminal({ convertEol: true, disableStdin: true, fontSize: 12, scrollback: 9000, fontFamily: 'var(--font-mono), monospace', theme: { background: '#000000', foreground: '#e8ecf4' } });
      try { fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); } catch (e) {}
      term.open(host);
      try { fit.fit(); } catch (e) {}
    } catch (e) {
      pre = document.createElement('pre');
      pre.className = 'logs-viewer';
      pre.style.cssText = 'margin:0;height:100%;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-word';
      host.style.padding = '0';
      host.appendChild(pre);
    }
    (async () => {
      while (document.body.contains(root)) {
        let job;
        try { job = await API.get(`/compose/deploy-job/${jobId}`); }
        catch (e) { const p = root.querySelector('#dl-phase'); if (p) p.textContent = 'job expired'; break; }
        if (!document.body.contains(root)) break;
        const phEl = root.querySelector('#dl-phase'), stepsEl = root.querySelector('#dl-steps');
        if (phEl) phEl.textContent = `${job.status} · ${job.phase}`;
        if (stepsEl) stepsEl.innerHTML = (job.steps || []).map(s => `<div>${deployStepIcon(s.status)} ${escapeHtml(s.label)}</div>`).join('');
        const log = job.log || '';
        if (term) { if (log.length > written) { term.write(log.slice(written)); written = log.length; } }
        else if (pre) { pre.textContent = log; pre.scrollTop = pre.scrollHeight; }
        if (job.status !== 'running') { renderDeploys(); break; }
        await new Promise(r => setTimeout(r, 1000));
      }
      try { if (term) term.dispose(); } catch (e) {}
    })();
  }

  await render();
  // Auto-refresh project running counts; skip while a modal/input is active
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  // Refresh the Deploys console more often while something is running (cheap; in-memory job list)
  deployTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) renderDeploys(); }, 3000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); if (deployTimer) clearInterval(deployTimer); };
});
