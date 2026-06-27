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
            <div class="row-menu" style="position:relative;display:inline-block">
              <button class="btn btn-primary row-menu-toggle" id="compose-deploy-toggle">${Icons.compose} + Deploy ▾</button>
              <div class="row-menu-pop">
                <button class="rmi" id="compose-new" ${dis}>${Icons.compose} New compose project</button>
                <button class="rmi" id="compose-git">${Icons.registry || Icons.compose} Deploy from Git</button>
                <button class="rmi" id="compose-folder">${Icons.arrowUp || Icons.compose} Deploy from folder</button>
              </div>
            </div>
            <button class="btn btn-secondary" id="compose-refresh">${Icons.refresh}</button>
          </div>
        </div>
        <div id="deploy-banner"></div>
        ${remote ? '<div class="card mb-3" style="border-left:3px solid var(--accent);padding:10px 14px;font-size:13px;color:var(--text-secondary)">Remote host active — only <strong>DockGate-managed</strong> projects can be deployed (the compose file lives on DockGate). Needs a key-based SSH server without a passphrase; bind-mount paths resolve on the remote host.</div>' : ''}
        ${projects.length === 0 ? '<div class="empty-state"><h3>No Compose Projects</h3></div>' : `
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Project Name</th><th>Status</th><th>Services</th><th>Path</th><th style="text-align:right">Actions</th></tr></thead>
              <tbody>
                ${projects.map(p => `<tr${p.deploySource === 'git' ? ` data-gitproj="${escapeHtml(p.name)}"` : ''}>
                  <td class="td-name">${p.deploySource === 'git' ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;opacity:.7"><title>Git-managed</title><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>' : ''}${escapeHtml(p.name)}</td>
                  <td><span class="badge ${p.running === p.total ? 'badge-running' : p.running > 0 ? 'badge-restarting' : 'badge-stopped'}">${p.running}/${p.total} Running</span></td>
                  <td class="text-sm">${p.services.join(', ') || '—'}</td>
                  <td class="td-mono text-xs" title="${escapeHtml(p.workingDir)}">${escapeHtml(p.workingDir) || '—'}</td>
                  <td><div class="td-actions">
                    <button class="btn-sm btn-primary" data-action="up" data-project="${p.name}" ${dis}>${Icons.play} Up</button>
                    <button class="btn-sm btn-secondary" data-action="down" data-project="${p.name}" ${dis}>${Icons.stop} Down</button>
                    <button class="btn-sm btn-secondary" data-action="restart" data-project="${p.name}" ${dis} title="Restart">${Icons.restart}</button>
                    <button class="btn-sm btn-secondary" data-action="rebuild" data-project="${p.name}" data-services="${escapeHtml((p.services || []).join(','))}" ${dis} title="Rebuild images from source + up (pick which services)">${Icons.layers} Rebuild</button>
                    ${p.deploySource === 'folder' ? `<button class="btn-sm btn-secondary" data-update="${p.name}" data-rpath="${escapeHtml(p.workingDir || '')}" data-services="${escapeHtml((p.services || []).join(','))}" title="Re-upload the (updated) folder & rebuild (pick which services)">${Icons.refresh} Update</button>` : ''}
                    <button class="btn-icon" title="Edit YAML" data-edit="${p.name}" ${dis}>${Icons.settings}</button>
                    <button class="btn-icon" title="Project files (Dockerfile, .env…)" data-files="${p.name}">${Icons.folder || Icons.compose}</button>
                    <button class="btn-icon" title="Open a terminal in this project's folder" data-term="${p.name}" data-cwd="${escapeHtml(p.workingDir || '')}">🖥</button>
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
      content.querySelectorAll('[data-term]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openProjectTerminal(btn.dataset.term, btn.dataset.cwd); }));
      content.querySelectorAll('[data-delproj]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteProject(btn.dataset.delproj, !!btn.dataset.remote); }));
      content.querySelectorAll('[data-update]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openFolderDeploy({ update: btn.dataset.update, remotePath: btn.dataset.rpath, services: (btn.dataset.services || '').split(',').filter(Boolean) }); }));
      content.querySelectorAll('[data-edit]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openComposeEditor(btn.dataset.edit); });
      });
      // "⋯ More" row menus — position:fixed so the table's overflow can't clip them. Items keep their
      // data-* attrs, so every action handler (wired above + the data-action block below) still fires;
      // here we only open/close the menu and place it under its toggle.
      content.querySelectorAll('.row-menu-toggle').forEach(t => t.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = t.parentElement.querySelector('.row-menu-pop');
        const isOpen = pop.style.display === 'flex';
        content.querySelectorAll('.row-menu-pop').forEach(p => p.style.display = 'none');
        if (!isOpen) {
          pop.style.display = 'flex';
          const r = t.getBoundingClientRect();
          const w = pop.offsetWidth || 190;
          pop.style.top = (r.bottom + 4) + 'px';
          pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        }
      }));
      content.querySelectorAll('.row-menu-pop .rmi').forEach(b => b.addEventListener('click', () => { const p = b.closest('.row-menu-pop'); if (p) p.style.display = 'none'; }));
      if (!window._cmRowMenu) {
        window._cmRowMenu = true;
        document.addEventListener('click', (e) => { if (!e.target.closest('.row-menu')) document.querySelectorAll('.row-menu-pop').forEach(p => p.style.display = 'none'); });
        window.addEventListener('resize', () => document.querySelectorAll('.row-menu-pop').forEach(p => p.style.display = 'none'));
      }

      // For git projects, check (server-cached) whether the repo has newer commits → show an "update" badge.
      content.querySelectorAll('tr[data-gitproj]').forEach(async (tr) => {
        const proj = tr.dataset.gitproj;
        try {
          const st = await API.get(`/compose/${proj}/git-status`);
          if (!st || !st.behind) return;
          const cell = tr.querySelector('.td-name');
          if (cell && !cell.querySelector('.upd-badge')) cell.insertAdjacentHTML('beforeend', ' <span class="upd-badge" title="The repo has newer commits since your last deploy — Redeploy to pull them" style="background:var(--accent);color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;letter-spacing:.4px;vertical-align:middle">UPDATE</span>');
        } catch (e) { /* unreachable repo / not git — no badge */ }
      });

      content.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const project = btn.dataset.project;
          const run = async (qs = '') => {
            try {
              const r = await API.post(`/compose/${project}/${action}${qs}`);
              if (r && r.jobId) { openDeployLog(r.jobId, project); render(); } // long op → live console
              else { showToast('Success'); render(); } // fast op (down/restart) → toast
            } catch (err) { showToast(err.message, 'error'); }
          };
          // rebuild → scan the project for ALL compose files (any name/location) + their services, let the
          // user pick which file(s)/services to rebuild, then run with the exact -f.
          if (action === 'rebuild') {
            const plan = await chooseRebuildPlan(project);
            if (!plan) return; // cancelled / nothing found
            try {
              const r = await API.post(`/compose/${project}/rebuild`, { plan });
              if (r && r.jobId) { openDeployLog(r.jobId, project); render(); }
            } catch (err) { showToast(err.message, 'error', 12000); }
          // down/restart are disruptive — confirm first (down removes containers; restart interrupts)
          } else if (action === 'down') {
            showDeleteConfirm('Compose Down', { message: `Stop and remove all containers in "${project}"?`, phrase: project, onConfirm: () => run() });
          } else if (action === 'restart') {
            showConfirm('Compose Restart', `Restart all services in "${project}"? They will be briefly interrupted.`, () => run(), true);
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
            const isLocalUrl = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
            const gitSection = git.gitManaged ? `
              <div class="card mb-2" style="padding:12px;background:var(--accent-dim)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                  <div class="text-sm" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:.85"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg><strong>Git</strong> — <code>${escapeHtml(git.repoUrl)}</code> @ <code>${escapeHtml(git.branch)}</code>${git.subdir ? ' /' + escapeHtml(git.subdir) : ''}</div>
                  <div style="display:flex;gap:6px;flex:none">
                    <button class="btn btn-sm btn-secondary" id="cd-pull" title="Pull the latest from git and see what changed — without deploying anything">⤓ Pull</button>
                    <button class="btn btn-sm btn-primary" id="cd-redeploy" title="Pull, then choose which changed stacks/services to deploy">↻ Redeploy…</button>
                  </div>
                </div>
                <details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;font-weight:600">Auto-deploy webhook — optional</summary>
                  <div class="text-xs text-muted" style="margin:6px 0">Optional. For <strong>automatic</strong> redeploy on every push. Prefer to control it yourself? Just use <strong>Redeploy</strong> above when you want — and ignore this.</div>
                  ${isLocalUrl ? `<div class="text-xs" style="color:var(--warning);margin-bottom:6px">⚠ This URL points to <code>${escapeHtml(location.host)}</code> — <strong>GitHub can't reach it.</strong> The webhook only fires if DockGate has a <strong>public</strong> URL (a domain/VPS reachable from the internet). On localhost/LAN it will never trigger.</div>` : ''}
                  <pre class="logs-viewer" style="white-space:pre-wrap;word-break:break-all;font-size:11px;padding:8px;margin:0">${escapeHtml(webhookUrl)}</pre>
                  <button class="btn btn-xs btn-secondary" id="cd-copy-hook" style="margin-top:6px">📋 Copy webhook URL</button>
                  <div class="text-xs text-muted" style="margin-top:4px">Add it in the repo (GitHub: Settings → Webhooks, content-type <code>application/json</code>). On push it re-clones + re-applies your deploy plan.</div>
                </details>
              </div>` : '';
            const dm = showModal(`Compose: ${escapeHtml(data.name)}`, `
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

            // External git checkout? (DockGate didn't deploy this, but its folder is a git repo on the host.)
            // Probe lazily; if it's an adoptable checkout, inject a "Git (detected)" card with ⤓ Pull / ↻ Redeploy.
            if (!git.gitManaged) {
              API.get(`/compose/${name}/git-detect`).then(d => {
                if (!d || !d.isGit || d.managed) return;
                const grid = dm.overlay.querySelector('.detail-grid');
                if (!grid) return;
                const sh = s => (s || '').slice(0, 7);
                const where = d.remote ? 'on the active remote server' : 'on local Docker';
                const card = document.createElement('div');
                card.className = 'card mb-2';
                card.style.cssText = 'padding:12px;background:var(--accent-dim)';
                card.innerHTML = `
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                    <div class="text-sm" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:.85"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg><strong>Git (detected)</strong> — ${d.remoteUrl ? `<code>${escapeHtml(d.remoteUrl)}</code> @ ` : ''}<code>${escapeHtml(d.branch || 'HEAD')}</code></div>
                    <div style="display:flex;gap:6px;flex:none">
                      <button class="btn btn-sm btn-secondary" id="xg-pull" title="Fast-forward this checkout from its own git remote — does not deploy">⤓ Pull</button>
                      <button class="btn btn-sm btn-primary" id="xg-redeploy" title="Pull (fast-forward), then docker compose up -d --build">↻ Redeploy…</button>
                    </div>
                  </div>
                  <div class="text-xs text-muted" style="margin-top:6px">DockGate didn't deploy this — it's your own git checkout ${where} (<code>${escapeHtml(d.repoRoot)}</code>). Pull is <strong>fast-forward only</strong> and never resets your files.${d.canPull ? '' : ` <span style="color:var(--warning)">⚠ ${escapeHtml(d.reason || 'Pull unavailable')}.</span>`}</div>`;
                grid.parentNode.insertBefore(card, grid);
                const pullBtn = card.querySelector('#xg-pull');
                const redBtn = card.querySelector('#xg-redeploy');
                if (!d.canPull) { pullBtn.disabled = true; pullBtn.style.opacity = '0.5'; pullBtn.style.cursor = 'not-allowed'; }
                pullBtn.addEventListener('click', async () => {
                  pullBtn.disabled = true; pullBtn.textContent = 'Pulling…';
                  try {
                    const r = await API.post(`/compose/${name}/adopt-pull`, {});
                    dm.close();
                    const body = r.upToDate
                      ? `<div class="text-sm">✓ Already up to date (<span class="td-mono">${sh(r.toSHA)}</span>) — nothing to pull.</div>`
                      : `<div class="text-sm" style="margin-bottom:4px">⤓ Fast-forwarded <span class="td-mono">${sh(r.fromSHA)}</span> → <span class="td-mono">${sh(r.toSHA)}</span></div>${(r.commits && r.commits.length) ? `<pre class="logs-viewer" style="max-height:170px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all;margin:6px 0">${r.commits.map(c => `${escapeHtml(c.hash || '')}  ${escapeHtml(c.date || '')}  ${escapeHtml(c.subject || '')}`).join('\n')}</pre>` : ''}<div class="text-sm" style="margin:8px 0 4px">📦 <strong>${(r.changed || []).length}</strong> file(s) changed:</div><pre class="logs-viewer" style="max-height:200px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0">${(r.changed || []).map(escapeHtml).join('\n')}</pre><div class="text-xs text-muted" style="margin-top:6px">Pulled — nothing was deployed. Use ↻ Redeploy to apply it to the containers.</div>`;
                    showModal(`Pull — ${escapeHtml(name)}`, body, [{ label: 'Close', className: 'btn btn-secondary' }]);
                    render();
                  } catch (err) {
                    pullBtn.disabled = false; pullBtn.textContent = '⤓ Pull';
                    showModal(`Pull failed — ${escapeHtml(name)}`, `<div class="text-sm" style="color:var(--danger);white-space:pre-wrap;word-break:break-all">${escapeHtml(err.message)}</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
                  }
                });
                redBtn.addEventListener('click', () => {
                  dm.close();
                  showConfirm('Redeploy (external git)', `Pull (fast-forward) <strong>${escapeHtml(name)}</strong> then run:<br><code>docker compose -p ${escapeHtml(name)} -f ${escapeHtml(d.configFiles || '')} up -d --build</code><br>in <code>${escapeHtml(d.workingDir)}</code> ${where}.<br><span class="text-xs text-muted">One-shot/stateful services are not force-recreated.</span>`, async () => {
                    try { const r = await API.post(`/compose/${name}/adopt-redeploy`, {}); if (r && r.jobId) openDeployLog(r.jobId, name); render(); }
                    catch (err) { showToast(err.message, 'error', 12000); }
                  });
                });
              }).catch(() => {});
            }
            dm.overlay.querySelector('#cd-redeploy')?.addEventListener('click', async (e) => {
              // Change-aware redeploy: pull latest → show what changed → SAME picker (only changed stacks
              // pre-selected) → deploy the chosen stacks/services. "Stage" = pull only, don't run.
              const b = e.target; b.disabled = true; b.textContent = 'Pulling…';
              let prep;
              try { prep = await API.post(`/compose/${name}/redeploy-prepare`, {}); }
              catch (err) { showToast(err.message, 'error', 12000); b.disabled = false; b.textContent = '↻ Redeploy…'; return; }
              const files = prep.files || [];
              if (!files.length) { showToast('No docker-compose files found in the repo', 'error', 9000); API.post('/compose/deploy-folder-abort', { uploadId: prep.uploadId }).catch(() => {}); b.disabled = false; b.textContent = '↻ Redeploy…'; return; }
              dm.close();
              const d = prep.diff || {};
              const preselect = d.hasBaseline ? (d.affectedStacks || []) : null; // null → all selected (no baseline yet)
              const plan = await chooseDeployPlan(files, name, { diff: d, affectedStacks: preselect });
              if (!plan) { API.post('/compose/deploy-folder-abort', { uploadId: prep.uploadId }).catch(() => {}); render(); return; }
              try {
                const fin = await API.post('/compose/deploy-folder-finish', { uploadId: prep.uploadId, up: plan.up, plan });
                if (fin && fin.jobId) openDeployLog(fin.jobId, name);
                showToast(plan.up ? 'Redeploying selected — watch the console.' : 'Pulled & staged. Up each stack when ready.', 'info', 6000);
                render();
              } catch (err) { showToast(err.message, 'error', 12000); }
            });
            dm.overlay.querySelector('#cd-pull')?.addEventListener('click', async (e) => {
              // Pull only: fetch the latest + show what changed since the last deploy. Does NOT deploy or
              // touch running containers. Offers an optional "Deploy these…" path (the same change-aware picker).
              const b = e.target; b.disabled = true; b.textContent = 'Pulling…';
              let prep;
              try { prep = await API.post(`/compose/${name}/redeploy-prepare`, {}); }
              catch (err) {
                b.disabled = false; b.textContent = '⤓ Pull';
                // Show the failure in a modal (not just a fleeting toast) so the reason is clear.
                showModal(`Pull failed — ${escapeHtml(name)}`, `<div class="text-sm" style="color:var(--danger);white-space:pre-wrap;word-break:break-all">${escapeHtml(err.message)}</div><div class="text-xs text-muted" style="margin-top:8px">Could not fetch from Git — check the repo URL/branch and the SSH key or token (Servers → SSH Keys), and that the host is reachable.</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
                return;
              }
              dm.close();
              const d = prep.diff || {};
              const lines = d.changedFiles || [];
              const commits = d.commits || [];
              const sh = s => (s || '').slice(0, 7);
              const commitsHtml = commits.length
                ? `<div class="text-sm" style="margin:8px 0 4px">⬇ <strong>${commits.length}</strong> commit(s) pulled:</div><pre class="logs-viewer" style="max-height:170px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0">${commits.map(c => `${escapeHtml(c.hash || '')}  ${escapeHtml(c.date || '')}  ${escapeHtml(c.subject || '')}${c.author ? '  — ' + escapeHtml(c.author) : ''}`).join('\n')}</pre>`
                : '';
              const body = lines.length
                ? `<div class="text-sm" style="margin-bottom:4px">⤓ Pulled <span class="td-mono">${sh(d.fromSHA)}</span> → <span class="td-mono">${sh(d.toSHA)}</span></div>${commitsHtml}<div class="text-sm" style="margin:8px 0 4px">📦 <strong>${lines.length}</strong> file(s) changed:</div><pre class="logs-viewer" style="max-height:200px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0">${lines.map(escapeHtml).join('\n')}</pre><div class="text-xs text-muted" style="margin-top:6px">Pulled — but nothing was deployed. Your running containers are untouched.</div>`
                : (d.upToDate ? `<div class="text-sm">✓ Already at the latest commit (<span class="td-mono">${sh(d.toSHA)}</span>) — nothing new to pull.</div>`
                  : `<div class="text-sm">⤓ Pulled <span class="td-mono">${sh(d.toSHA)}</span>. This project had <strong>no recorded deploy commit</strong> (deployed before commit-tracking), so this commit is now saved as the <strong>baseline</strong>.</div><div class="text-xs text-muted" style="margin-top:6px">From your <strong>next</strong> pull, the new commits &amp; changed files will show here — there was nothing earlier to compare this first pull against. (If the server may be on an older commit, use ↻ Redeploy to sync.)</div>`);
              const pm = showModal(`Pull — ${escapeHtml(name)}`, body, [{ label: 'Close', className: 'btn btn-secondary' }]);
              let consumed = false;
              if (lines.length || !d.hasBaseline) {
                const go = document.createElement('button');
                go.className = 'btn btn-primary'; go.textContent = '↻ Deploy these…';
                pm.overlay.querySelector('#modal-footer').appendChild(go);
                go.onclick = async () => {
                  consumed = true; pm.close();
                  const preselect = d.hasBaseline ? (d.affectedStacks || []) : null;
                  const plan = await chooseDeployPlan(prep.files || [], name, { diff: d, affectedStacks: preselect });
                  if (!plan) { API.post('/compose/deploy-folder-abort', { uploadId: prep.uploadId }).catch(() => {}); render(); return; }
                  try { const fin = await API.post('/compose/deploy-folder-finish', { uploadId: prep.uploadId, up: plan.up, plan }); if (fin && fin.jobId) openDeployLog(fin.jobId, name); render(); }
                  catch (err) { showToast(err.message, 'error', 12000); }
                };
              }
              // Closing without deploying → drop the staged clone (don't leave it for the TTL GC).
              const obs = new MutationObserver(() => { if (!document.body.contains(pm.overlay)) { obs.disconnect(); if (!consumed) API.post('/compose/deploy-folder-abort', { uploadId: prep.uploadId }).catch(() => {}); } });
              obs.observe(document.getElementById('modal-root'), { childList: true });
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
  async function openGitDeploy() {
    const remote = isRemoteActive();
    let keys = [];
    try { keys = await API.get('/ssh-keys'); } catch (e) {}
    const keyOpts = keys.map(k => `<option value="${k.id}">${escapeHtml(k.name)} (${escapeHtml(k.key_type)})</option>`).join('');
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Repository URL *</label><input class="input" id="gd-url" placeholder="https://github.com/user/repo"></div>
      <div class="input-group"><label>Branch (optional)</label><input class="input" id="gd-branch" placeholder="main"></div>
      <div class="input-group"><label>Project name *</label><input class="input" id="gd-name" placeholder="my-app"></div>
      ${remote ? `<div class="card" style="padding:9px 12px;background:var(--accent-dim)">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">Deploy target: remote server ⭐</div>
        <label class="text-xs text-muted">Folder on the server (files live &amp; run here)</label>
        <div style="display:flex;gap:6px;margin-top:2px">
          <input class="input" id="gd-rpath" placeholder="~/.dockgate/projects/&lt;project&gt;" style="flex:1;font-family:var(--font-mono,monospace)">
          <button type="button" class="btn btn-secondary btn-sm" id="gd-browse" style="white-space:nowrap">📁 Browse</button>
        </div>
        <span class="text-xs text-muted" style="margin-top:4px;display:block">Default <code>~/.dockgate/projects/&lt;project&gt;</code>. <strong>Browse</strong> to pick another parent — the project folder is created under it.</span>
      </div>` : ''}
      <div class="input-group"><label>Auth (for private repos)</label>
        <select class="select" id="gd-auth"><option value="token">Public / access token</option><option value="sshkey">SSH key (from store)</option></select>
      </div>
      <div class="input-group" id="gd-token-row"><label>Access token</label><input class="input" id="gd-token" type="password" placeholder="GitHub PAT with repo scope — not logged" autocomplete="new-password"></div>
      <div class="input-group" id="gd-key-row" style="display:none"><label>SSH key</label>
        ${keys.length ? `<select class="select" id="gd-key">${keyOpts}</select>` : `<div class="text-xs" style="color:var(--warning)">No SSH keys yet — create one in <b>Servers → SSH Keys</b> first.</div>`}
        <span class="text-xs text-muted" style="margin-top:4px;display:block">Use the SSH URL <code>git@github.com:owner/repo.git</code>, and add this key's public part to your Git host.</span>
        ${keys.length ? `<button type="button" class="btn btn-secondary btn-sm" id="gd-test" style="margin-top:6px;align-self:flex-start">Test key ↔ repo</button>` : ''}
      </div>
      <div class="text-xs text-muted">${remote ? '<strong>Deploys to the active remote host</strong> (clone in DockGate → transfer to the server → up there). ' : ''}DockGate clones the repo, then lets you <strong>choose which compose file(s)/services to deploy</strong> (multi-stack, like Deploy from folder). You'll get a <strong>webhook URL</strong> to auto-redeploy on push.</div>
    </div>`;
    const m = showModal('Deploy from Git', body, []);
    const root = m.overlay;
    root.querySelector('#gd-browse')?.addEventListener('click', () => {
      const project = root.querySelector('#gd-name').value.trim() || 'project';
      openRemoteFolderPicker((parentDir) => { root.querySelector('#gd-rpath').value = (parentDir === '/' ? '' : parentDir) + '/' + project; });
    });
    const authSel = root.querySelector('#gd-auth');
    authSel.addEventListener('change', () => {
      const ssh = authSel.value === 'sshkey';
      root.querySelector('#gd-token-row').style.display = ssh ? 'none' : '';
      root.querySelector('#gd-key-row').style.display = ssh ? '' : 'none';
      root.querySelector('#gd-url').placeholder = ssh ? 'git@github.com:owner/repo.git' : 'https://github.com/user/repo';
    });
    root.querySelector('#gd-test')?.addEventListener('click', async (e) => {
      const tb = e.currentTarget;
      const keyId = root.querySelector('#gd-key')?.value;
      const repoUrl = root.querySelector('#gd-url').value.trim();
      if (!keyId || !repoUrl) { showToast('Pick a key and enter the SSH repo URL', 'warning'); return; }
      tb.disabled = true; tb.textContent = 'Testing…';
      try { await API.post(`/ssh-keys/${keyId}/test`, { repoUrl }); showToast('✓ Key works — repo reachable', 'success', 4000); }
      catch (err) { showToast(err.message, 'error', 9000); }
      finally { tb.disabled = false; tb.textContent = 'Test key ↔ repo'; }
    });
    root.querySelector('#gd-url').addEventListener('input', (e) => {
      const nameInput = root.querySelector('#gd-name');
      if (!nameInput.value) {
        const repo = (e.target.value.split('/').pop() || '').replace(/\.git$/, '');
        if (repo) nameInput.value = repo.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      }
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Clone & choose what to deploy';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const project = root.querySelector('#gd-name').value.trim();
      const repoUrl = root.querySelector('#gd-url').value.trim();
      if (!project || !repoUrl) { showToast('Repo URL and project name are required', 'warning'); return; }
      const useKey = authSel.value === 'sshkey';
      const keyId = useKey ? (root.querySelector('#gd-key')?.value || '') : '';
      if (useKey && !keyId) { showToast('Select an SSH key (or create one in Servers → SSH Keys)', 'warning'); return; }
      const reset = () => { btn.disabled = false; btn.textContent = 'Clone & choose what to deploy'; };
      btn.disabled = true; btn.textContent = 'Cloning…';
      try {
        // Step 1 — clone + scan (server-side), then the SAME "Choose what to deploy" picker as folder deploy.
        const target = remote ? { mode: 'remote', remotePath: (root.querySelector('#gd-rpath')?.value || '').trim() } : undefined;
        const prep = await API.post('/compose/deploy-git-prepare', {
          project, repoUrl, branch: root.querySelector('#gd-branch').value.trim(),
          token: useKey ? '' : root.querySelector('#gd-token').value, keyId, target,
        });
        const files = prep.files || [];
        if (!files.length) { showToast('No docker-compose files found in the repo', 'error', 9000); API.post('/compose/deploy-folder-abort', { uploadId: prep.uploadId }).catch(() => {}); reset(); return; }
        btn.textContent = 'Choose…';
        const plan = await chooseDeployPlan(files, project);
        if (!plan) { API.post('/compose/deploy-folder-abort', { uploadId: prep.uploadId }).catch(() => {}); reset(); return; } // cancelled → drop the clone
        // Step 2 — shared finish (multi-stack deploy + transfer + live console + git meta for redeploy).
        const fin = await API.post('/compose/deploy-folder-finish', { uploadId: prep.uploadId, up: plan.up, plan });
        m.close();
        openDeployLog(fin.jobId, project);
        showToast('Deploying — watch the live console. Auto-redeploy webhook ready (project ▸ details).', 'info', 7000);
        render();
      } catch (e) { showToast(e.message, 'error', 12000); reset(); }
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
      ${serverContextBanner()}
      <div class="text-sm">Delete project <strong>${escapeHtml(project)}</strong>?</div>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400"><input type="checkbox" id="del-down" checked disabled> Stop &amp; remove containers (<code>docker compose down</code>)</label>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400"><input type="checkbox" id="del-files" checked> Remove the project files ${isRemote ? '(the folder on the remote server)' : '(DockGate-managed files)'}</label>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--danger,#f85149)"><input type="checkbox" id="del-vols"> Also delete data volumes — <strong>irreversible data loss</strong></label>
      <label class="text-xs text-muted" style="display:block;margin-top:4px">Type <code style="background:var(--bg-primary);padding:1px 6px;border-radius:4px;border:1px solid var(--border);font-weight:600">${escapeHtml(project)}</code> to confirm:</label>
      <input class="input" id="del-confirm" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${escapeHtml(project)}" style="width:100%;margin-top:6px" />
    </div>`;
    const m = showModal('Delete project', body, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const btn = document.createElement('button'); btn.className = 'btn btn-danger'; btn.textContent = 'Delete';
    btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed';
    root.querySelector('#modal-footer').appendChild(btn);
    const delInput = root.querySelector('#del-confirm');
    const delMatches = () => delInput.value.trim() === project;
    const delSync = () => { const ok = delMatches(); btn.disabled = !ok; btn.style.opacity = ok ? '1' : '0.5'; btn.style.cursor = ok ? 'pointer' : 'not-allowed'; };
    delInput.addEventListener('input', delSync);
    delInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && delMatches()) { e.preventDefault(); btn.click(); } });
    setTimeout(() => delInput.focus(), 50);
    btn.addEventListener('click', async () => {
      if (!delMatches()) return;
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
    // Lazy, ONE-folder-at-a-time browser (like the File Manager page) — fast even for projects with
    // node_modules / data-volume dirs, because it never recursively walks the whole tree over SFTP.
    let cwd = '';          // project-relative folder we're viewing
    let composeFile = null;
    const m = showModal(`Files — ${escapeHtml(project)}`, `
      <div class="text-xs text-muted mb-2">Project files (Dockerfile, .env, configs…). Click a folder to open it. The compose file is editable here.</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <button class="btn btn-xs btn-secondary" id="pf-up" title="Up one level">⬆</button>
        <div id="pf-crumb" style="flex:1;font-family:var(--font-mono,monospace);font-size:12px;overflow-x:auto;white-space:nowrap">/</div>
        <button class="btn btn-xs btn-secondary" id="pf-refresh" title="Refresh">${Icons.refresh}</button>
      </div>
      <div id="pf-list" style="max-height:54vh;overflow-y:auto"><div class="text-muted text-sm" style="padding:14px">Loading…</div></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const newBtn = document.createElement('button'); newBtn.className = 'btn btn-secondary btn-sm'; newBtn.textContent = '+ New file';
    root.querySelector('#modal-footer').prepend(newBtn);
    newBtn.addEventListener('click', () => {
      const name = prompt('New file name (in the current folder), e.g. Dockerfile or app.conf');
      if (!name || !name.trim()) return;
      const full = cwd ? cwd + '/' + name.trim().replace(/^\/+/, '') : name.trim().replace(/^\/+/, '');
      openFileEditor(project, full, '', list);
    });
    const parentOf = (p) => { if (!p) return ''; const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
    root.querySelector('#pf-up').addEventListener('click', () => { cwd = parentOf(cwd); list(); });
    root.querySelector('#pf-refresh').addEventListener('click', list);
    function rowHtml(e) {
      const full = cwd ? cwd + '/' + e.name : e.name;
      if (e.type === 'dir') {
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0"><span>📁</span><a href="#" data-cd="${escapeHtml(e.name)}" class="td-mono text-sm" style="flex:1;text-decoration:none;cursor:pointer">${escapeHtml(e.name)}/</a></div>`;
      }
      const isCompose = full === composeFile;
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <span>${fileIcon({ type: 'file', path: full }, composeFile)}</span>
        <span class="td-mono text-sm" style="flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.name)}${isCompose ? ' <span class="badge badge-running" style="font-size:9px">compose</span>' : ''}</span>
        <span class="text-xs text-muted">${formatBytes(e.size)}</span>
        <button class="btn btn-xs btn-secondary" data-edit-file="${escapeHtml(full)}">Edit</button>
        ${isCompose ? '' : `<button class="btn btn-xs btn-ghost text-danger" data-del-file="${escapeHtml(full)}">${Icons.trash}</button>`}
      </div>`;
    }
    async function list() {
      const el = root.querySelector('#pf-list');
      if (!el) return;
      el.innerHTML = '<div class="text-muted text-sm" style="padding:14px">Loading…</div>';
      let d;
      try { d = await API.get(`/compose/${project}/dir?sub=${encodeURIComponent(cwd)}`); }
      catch (e) { if (root.querySelector('#pf-list')) el.innerHTML = `<div class="text-danger text-sm" style="padding:14px">${escapeHtml(e.message)}</div>`; return; }
      if (!root.querySelector('#pf-list')) return; // modal closed during the fetch
      composeFile = d.composeFile;
      const crumb = root.querySelector('#pf-crumb'); if (crumb) crumb.textContent = '/' + cwd;
      el.innerHTML = (d.entries || []).length ? d.entries.map(rowHtml).join('') : '<div class="text-muted text-sm" style="padding:14px">Empty folder.</div>';
      el.querySelectorAll('[data-cd]').forEach(a => a.addEventListener('click', (ev) => { ev.preventDefault(); cwd = cwd ? cwd + '/' + a.dataset.cd : a.dataset.cd; list(); }));
      el.querySelectorAll('[data-edit-file]').forEach(b => b.addEventListener('click', () => editFileFromTree(project, b.dataset.editFile, list)));
      el.querySelectorAll('[data-del-file]').forEach(b => b.addEventListener('click', () => {
        showDeleteConfirm('Delete file', { message: `Delete "${escapeHtml(b.dataset.delFile)}"?`, phrase: b.dataset.delFile, onConfirm: async () => {
          try { await API.del(`/compose/${project}/filecontent?path=${encodeURIComponent(b.dataset.delFile)}`); showToast('Deleted'); list(); }
          catch (e) { showToast(e.message, 'error'); }
        } });
      }));
    }
    list();
  }

  // #2-A v2 — upload a project folder FILE BY FILE (staging session) with a live "uploaded n / total"
  // list, then finish → validate → compose up. opts.update = re-upload an existing remote project to
  // its stored folder + rebuild (project name & path locked; optional clean replace).
  // Small picker: choose which services to (re)build. Returns chosen names, [] for "all", or null if cancelled.
  function chooseServices(services, project, verb) {
    return new Promise((resolve) => {
      const list = (services || []).filter(Boolean);
      if (!list.length) return resolve([]); // services unknown → act on the whole project
      let settled = false;
      const settle = (v) => { if (settled) return; settled = true; resolve(v); };
      const rows = list.map(s => `<label style="display:block;margin:5px 0;font-size:13px"><input type="checkbox" class="cs-svc" value="${escapeHtml(s)}" checked> ${escapeHtml(s)}</label>`).join('');
      const body = `<div class="text-xs text-muted" style="margin-bottom:8px">${verb || 'Rebuild'} which services of <b>${escapeHtml(project)}</b>? Unchecked services are left running, untouched (<code>--no-deps</code>).</div>${rows}`;
      const m = showModal(`${verb || 'Rebuild'} services`, body, [{ label: 'Cancel', className: 'btn btn-secondary', onClick: () => settle(null) }]);
      const r = m.overlay;
      r.querySelector('.modal-close').onclick = () => { settle(null); m.close(); };
      r.onclick = (e) => { if (e.target === r) { settle(null); m.close(); } };
      const go = document.createElement('button');
      go.className = 'btn btn-primary'; go.textContent = verb || 'Rebuild';
      r.querySelector('#modal-footer').appendChild(go);
      go.onclick = () => {
        const chosen = [...r.querySelectorAll('.cs-svc')].filter(x => x.checked).map(x => x.value);
        if (!chosen.length) return showToast('Select at least one service', 'warning');
        settle(chosen.length === list.length ? [] : chosen); // all selected → [] (whole project, no --no-deps)
        m.close();
      };
    });
  }

  // Rebuild picker: scan the project for ALL compose files (any name/location) + services, let the user pick
  // which file(s)/services to rebuild + flags, with a live command preview. Returns a plan { stacks:[…] } or null.
  async function chooseRebuildPlan(project) {
    const loading = showModal(`Rebuild — ${escapeHtml(project)}`, `<div class="text-sm text-muted">Scanning the project for compose files…</div>`, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    let scan;
    try { scan = await API.get(`/compose/${encodeURIComponent(project)}/compose-files`); }
    catch (e) { loading.close(); showModal('Rebuild', `<div class="text-sm" style="color:var(--danger);white-space:pre-wrap;word-break:break-all">${escapeHtml(e.message)}</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]); return null; }
    loading.close();
    if (!scan || !scan.ok || !(scan.files || []).length) { showModal('Rebuild', `<div class="text-sm">${escapeHtml((scan && scan.reason) || 'No compose files found for this project.')}</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]); return null; }
    return new Promise((resolve) => {
      const where = scan.remote ? ' <span class="text-xs text-muted">(on remote server)</span>' : '';
      const fileRows = scan.files.map((f, i) => {
        const svcChecks = (f.services || []).length
          ? f.services.map(s => `<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0;font-size:12px"><input type="checkbox" class="rb-svc" data-fi="${i}" value="${escapeHtml(s)}" ${f.current ? 'checked' : ''}> ${escapeHtml(s)}</label>`).join('')
          : '<span class="text-xs text-muted">no services parsed</span>';
        return `<div class="card" style="padding:10px;margin-bottom:8px;background:var(--bg-primary)">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px"><code style="font-size:12px">${escapeHtml(f.path)}</code>${f.current ? '<span class="badge badge-running" style="font-size:10px">current</span>' : ''}</div>
          <div>${svcChecks}</div></div>`;
      }).join('');
      const body = `
        <div class="text-xs text-muted" style="margin-bottom:8px">Pick which services to rebuild, in which compose file${where}. Found <b>${scan.files.length}</b> file(s) (source: <b>${escapeHtml(scan.source || 'scan')}</b>). Unticked services stay untouched (<code>--no-deps</code>).</div>
        ${fileRows}
        <div style="display:flex;gap:16px;margin:6px 0 8px;flex-wrap:wrap">
          <label style="font-size:12px"><input type="checkbox" id="rb-force"> force-recreate</label>
          <label style="font-size:12px"><input type="checkbox" id="rb-nocache"> no-cache (clean build)</label>
        </div>
        <div class="text-xs text-muted" style="margin-bottom:2px">Command preview:</div>
        <pre id="rb-preview" class="logs-viewer" style="font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:130px;overflow:auto"></pre>`;
      const m = showModal(`Rebuild — ${escapeHtml(project)}`, body, [{ label: 'Cancel', className: 'btn btn-secondary', onClick: () => resolve(null) }]);
      const root = m.overlay;
      root.querySelector('.modal-close').onclick = () => { resolve(null); m.close(); };
      root.onclick = (e) => { if (e.target === root) { resolve(null); m.close(); } };
      const collect = () => {
        const force = root.querySelector('#rb-force').checked, noCache = root.querySelector('#rb-nocache').checked;
        return scan.files.map((f, i) => {
          const services = [...root.querySelectorAll(`.rb-svc[data-fi="${i}"]`)].filter(x => x.checked).map(x => x.value);
          if (!services.length) return null;
          const all = (f.services || []).length === services.length;
          return { file: f.file, base: f.path.split('/').pop(), services: all ? [] : services, noCache, force };
        }).filter(Boolean);
      };
      const preview = () => {
        const stacks = collect();
        root.querySelector('#rb-preview').textContent = stacks.length
          ? stacks.map(s => `docker compose -p ${project} -f ${s.base}${s.noCache ? '  (build --no-cache first)' : ''} up -d --build${s.force ? ' --force-recreate' : ''}${s.services.length ? ' --no-deps ' + s.services.join(' ') : ''}`).join('\n')
          : '(tick at least one service)';
      };
      root.querySelectorAll('.rb-svc, #rb-force, #rb-nocache').forEach(el => el.addEventListener('change', preview));
      preview();
      const go = document.createElement('button');
      go.className = 'btn btn-primary'; go.textContent = 'Rebuild';
      root.querySelector('#modal-footer').appendChild(go);
      go.onclick = () => {
        const stacks = collect();
        if (!stacks.length) return showToast('Tick at least one service to rebuild', 'warning');
        resolve({ stacks: stacks.map(s => ({ file: s.file, services: s.services, noCache: s.noCache, force: s.force })) });
        m.close();
      };
    });
  }

  // A clickable "?" help badge (opens the folder-deploy guide). Wire its click after the modal mounts.
  function helpBadge(id, label) {
    return `<button type="button" id="${id}" title="How folder deploy works" style="display:inline-flex;align-items:center;justify-content:center;gap:5px;height:20px;padding:0 8px;border-radius:10px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-secondary);font-size:11px;font-weight:600;cursor:pointer;line-height:1">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700">?</span>${label ? ' ' + label : ''}</button>`;
  }

  // The full "how to use folder deploy" guide — opened by the "?" badges.
  // Explains the per-stack build flags (build / no-cache / pull / no-deps) — opened from the "?" in the picker.
  function openFlagHelp() {
    showModal('Build flags — what they mean', `
      <div style="display:flex;flex-direction:column;gap:11px;font-size:13px;line-height:1.5">
        <div><strong>build</strong> — Rebuild the image from the <code>Dockerfile</code> before starting (instead of reusing the existing image). <strong>Tick when the code changed.</strong></div>
        <div><strong>no-cache</strong> — Build <strong>without Docker's cache</strong>, every layer from scratch. A clean but <strong>slow</strong> rebuild — only if the cache is stale. Usually leave off.</div>
        <div><strong>pull</strong> — Pull the latest <strong>base images</strong> (<code>FROM node:20</code> …) before building/starting. Only for a fresh base image. Usually leave off.</div>
        <div><strong>no-deps</strong> — Touch <strong>only the selected service(s)</strong> — don't start/recreate their dependencies (database, backend…). <strong>Protects data</strong> — tick it to update one service without restarting the rest.</div>
      </div>`, [{ label: 'Got it', className: 'btn btn-primary' }]);
  }

  function openDeployHelp() {
    const body = `<div style="font-size:13px;line-height:1.6;max-height:62vh;overflow:auto;padding-right:4px">
      <p style="margin-top:0;color:var(--text-secondary)">DockGate ships your project folder to the target (your local Docker, or a remote SSH host if one is active in the header) and runs <code>docker compose</code> on it — with a live, per-step terminal so you see exactly what happens.</p>

      <h4 style="margin:14px 0 4px">1 · Pick the folder</h4>
      <ul style="margin:0;padding-left:18px">
        <li>Select your project's <b>root folder</b>. Files upload one by one (<code>.git</code> and <code>node_modules</code> are skipped).</li>
        <li><b>~1 GB limit</b> (single file up to ~384 MB). If you hit it, exclude build output (<code>.next</code>, <code>dist</code>, large assets) before deploying.</li>
        <li><b>Local vs remote:</b> with a remote SSH server active in the header, files are uploaded to <i>that server</i> and run there (bind-mounts &amp; builds resolve on the remote). Otherwise they run on local Docker.</li>
      </ul>

      <h4 style="margin:14px 0 4px">2 · Choose what to deploy</h4>
      <p style="margin:0 0 6px">After upload, DockGate scans for <b>every</b> compose file (any <code>*.yml</code>/<code>*.yaml</code> that defines <code>services:</code> — including subfolders and non-standard names like <code>docker-compose.app.yml</code>). Each file becomes a card:</p>
      <ul style="margin:0;padding-left:18px">
        <li><b>Include checkbox</b> — tick the compose file(s) to deploy. <b>Each file = its own stack</b> (its own compose project), deployed top → bottom.</li>
        <li><b>Services</b> — tick which to start. All ticked = deploy everything; tick a subset to start only those.</li>
        <li><b>build</b> — build images from the Dockerfile first (<code>--build</code>).</li>
        <li><b>no-cache</b> — rebuild from scratch, ignoring the build cache.</li>
        <li><b>pull</b> — pull the newest images first (<code>--pull always</code>).</li>
        <li><b>no-deps</b> — start only the chosen services, don't auto-start their <code>depends_on</code>.</li>
        <li><b>name</b> — the compose <b>project name</b> for this stack (how it shows in the Compose list). Editable.</li>
      </ul>
      <p style="margin:6px 0 0"><b>External networks</b> — if a selected compose uses an <code>external:</code> network, it's listed at the top. Leave it ticked and DockGate <b>creates it before</b> the stacks start, so the deploy won't fail with "network not found".</p>

      <h4 style="margin:14px 0 4px">3 · Deploy</h4>
      <p style="margin:0">Click <b>Deploy</b>. The <b>Deploys</b> console shows each step — ensure network, then each stack — going <code>· pending → ⏳ running → ✓ done / ✗ failed</code>, with the live <code>docker compose</code> output in a real terminal. You can close the modal; the deploy keeps running on the server. Re-open it anytime from <b>Deploys → view log</b>.</p>

      <h4 style="margin:14px 0 4px">Three folders, each with its own compose?</h4>
      <p style="margin:0">That's the multi-stack case: select all three in the picker, give each a name, tick a shared external network if they use one, and they deploy in order as three separate projects.</p>

      <h4 style="margin:14px 0 4px">Tips</h4>
      <ul style="margin:0 0 4px;padding-left:18px">
        <li>"No services parsed" means the file's <code>${'${VAR}'}</code> couldn't resolve (e.g. a missing <code>.env</code>) — it still deploys, just with all services.</li>
        <li>To re-deploy later, use the stack's <b>Rebuild</b> / <b>Update</b> in the Compose list.</li>
        <li>Secrets you upload (<code>.env</code>, certs) pass through DockGate — only deploy folders you trust over a trusted network.</li>
      </ul>
    </div>`;
    showModal('Deploy from folder — guide', body, [{ label: 'Got it', className: 'btn btn-primary' }]);
  }

  // After an upload is scanned, let the user PICK which compose file(s) to deploy, which services, and how
  // to build. Each compose file = its own stack (own project). Resolves to a plan, or null if cancelled.
  function chooseDeployPlan(files, defaultProject, opts = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (settled) return; settled = true; resolve(v); };
      const aware = Array.isArray(opts.affectedStacks);   // change-aware redeploy: only changed stacks pre-checked
      const affected = new Set(opts.affectedStacks || []);
      const isOn = (f) => !aware || affected.has(f.path);
      const cards = files.map((f, i) => {
        const on = isOn(f);
        const seg = f.dir === '.' ? '' : (f.dir.split('/').pop() || '');
        const stackName = (seg ? `${defaultProject}-${seg}` : defaultProject).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const svcRows = (f.services || []).length
          ? f.services.map(s => `<label style="margin-right:12px;font-size:12px"><input type="checkbox" class="fd-svc" data-i="${i}" value="${escapeHtml(s)}" ${on ? 'checked' : ''}> ${escapeHtml(s)}</label>`).join('')
          : '<span class="text-muted text-xs">no services parsed — all will be deployed</span>';
        const nets = (f.externalNets || []).length ? `<div class="text-xs text-muted" style="margin-top:2px">external network: ${f.externalNets.map(escapeHtml).join(', ')}</div>` : '';
        const err = f.parseError ? `<div class="text-xs" style="color:var(--warning);margin-top:2px">⚠ ${escapeHtml(f.parseError)}</div>` : '';
        return `<div class="card fd-card" style="padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <label style="font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="checkbox" class="fd-stack" data-i="${i}" ${on ? 'checked' : ''}> <code>${escapeHtml(f.path)}</code>${aware ? (affected.has(f.path) ? ' <span style="font-size:11px;color:var(--accent);font-weight:600">● changed</span>' : ' <span style="font-size:11px;color:var(--text-muted);font-weight:400">no change · untouched</span>') : ''}</label>
            <span style="display:flex;gap:2px;flex:none"><button type="button" class="btn-icon fd-up" title="Move up (deploy earlier)">▲</button><button type="button" class="btn-icon fd-down" title="Move down (deploy later)">▼</button></span>
          </div>
          ${err}${nets}
          <div style="margin:6px 0 6px">${svcRows}</div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px">
            <label title="Rebuild the image from the Dockerfile before starting — tick when the code changed"><input type="checkbox" class="fd-build" data-i="${i}" ${f.hasBuild ? 'checked' : ''}> build</label>
            <label title="Build without Docker's cache — a full clean rebuild (slower; rarely needed)"><input type="checkbox" class="fd-nocache" data-i="${i}"> no-cache</label>
            <label title="Pull the latest base images (FROM …) before building/starting"><input type="checkbox" class="fd-pull" data-i="${i}"> pull</label>
            <label title="Touch only the selected service(s) — don't restart their dependencies (DB, etc.); protects data"><input type="checkbox" class="fd-nodeps" data-i="${i}"> no-deps</label>
            <button type="button" class="btn-icon fd-flaghelp" title="What do build / no-cache / pull / no-deps mean?" style="width:20px;height:20px;font-size:12px;flex:none">?</button>
            <span>name: <input class="input" id="fd-sname-${i}" style="width:170px;display:inline-block;padding:2px 6px" value="${escapeHtml(stackName)}"></span>
          </div>
        </div>`;
      }).join('');
      const allNets = [...new Set(files.flatMap(f => f.externalNets || []))];
      const netRows = allNets.length ? `<div class="card" style="padding:8px 10px;margin-bottom:8px"><div style="font-weight:600;font-size:13px;margin-bottom:4px">External networks (created before deploy)</div>${allNets.map(n => `<label style="margin-right:12px;font-size:12px"><input type="checkbox" class="fd-net" value="${escapeHtml(n)}" checked> ${escapeHtml(n)}</label>`).join('')}</div>` : '';
      // Change-aware redeploy: show what changed since the last deploy + a note that unticked stacks stay untouched.
      const sh = s => (s || '').slice(0, 7);
      const diffBox = (opts.diff && (opts.diff.changedFiles || []).length)
        ? `<div class="card" style="padding:8px 10px;margin-bottom:8px;background:var(--accent-dim)"><div style="font-weight:600;font-size:13px;margin-bottom:4px">📦 Changed since last deploy (${sh(opts.diff.fromSHA)} → ${sh(opts.diff.toSHA)})</div><div style="font-family:var(--font-mono,monospace);font-size:11px;max-height:120px;overflow:auto;opacity:.9">${opts.diff.changedFiles.slice(0, 60).map(escapeHtml).join('<br>')}${opts.diff.changedFiles.length > 60 ? '<br>…' : ''}</div><div class="text-xs text-muted" style="margin-top:4px">Only the changed stack(s) are pre-selected — unticked stacks keep running, untouched (data preserved).</div></div>`
        : (aware && opts.diff && opts.diff.upToDate ? `<div class="card" style="padding:8px 10px;margin-bottom:8px"><span class="text-sm">✓ Already at the latest commit — nothing new pulled. Tick a stack below to re-deploy it anyway.</span></div>` : '');
      const body = `<div style="display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
          <div class="text-xs text-muted">Pick which compose file(s) to deploy, which services, and how to build. Each file = its own stack (own project), deployed top → bottom.</div>
          ${helpBadge('cdp-help', 'Help')}
        </div>
        ${diffBox}${netRows}${cards}</div>`;
      const m2 = showModal('Choose what to deploy', body, [{ label: 'Cancel', className: 'btn btn-secondary', onClick: () => settle(null) }]);
      const r2 = m2.overlay;
      r2.querySelector('#cdp-help').onclick = openDeployHelp;
      r2.querySelectorAll('.fd-flaghelp').forEach(b => b.onclick = openFlagHelp);
      // Reorder stacks (deploy order = top → bottom). Moving the card moves its checkbox in the DOM,
      // and the Deploy handler reads .fd-stack in DOM order — so the plan order follows.
      const reorder = (card, dir) => {
        if (!card) return;
        if (dir < 0 && card.previousElementSibling && card.previousElementSibling.classList.contains('fd-card')) card.parentNode.insertBefore(card, card.previousElementSibling);
        if (dir > 0 && card.nextElementSibling && card.nextElementSibling.classList.contains('fd-card')) card.parentNode.insertBefore(card.nextElementSibling, card);
      };
      r2.querySelectorAll('.fd-up').forEach(b => b.onclick = () => reorder(b.closest('.fd-card'), -1));
      r2.querySelectorAll('.fd-down').forEach(b => b.onclick = () => reorder(b.closest('.fd-card'), 1));
      r2.querySelector('.modal-close').onclick = () => { settle(null); m2.close(); };
      r2.onclick = (e) => { if (e.target === r2) { settle(null); m2.close(); } };
      const buildPlan = () => {
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
        if (!stacks.length) { showToast('Select at least one compose file', 'warning'); return null; }
        if (stacks.some(s => !s.name)) { showToast('Each stack needs a name', 'warning'); return null; }
        const createNets = [...r2.querySelectorAll('.fd-net')].filter(x => x.checked).map(x => x.value);
        return { createNets, stacks };
      };
      // "Stage" = place the files but don't start anything; deploy each from the Compose list (Up) later.
      const stage = document.createElement('button');
      stage.className = 'btn btn-secondary'; stage.textContent = 'Stage (deploy later)'; stage.title = "Upload/clone the files but don't run — start each stack from the list when you're ready";
      r2.querySelector('#modal-footer').appendChild(stage);
      stage.onclick = () => { const p = buildPlan(); if (p) { settle({ ...p, up: false }); m2.close(); } };
      const deploy = document.createElement('button');
      deploy.className = 'btn btn-primary'; deploy.textContent = 'Deploy now';
      r2.querySelector('#modal-footer').appendChild(deploy);
      deploy.onclick = () => { const p = buildPlan(); if (p) { settle({ ...p, up: true }); m2.close(); } };
    });
  }

  function openFolderDeploy(opts = {}) {
    const isUpdate = !!opts.update;
    const remote = isUpdate ? true : isRemoteActive();
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;justify-content:flex-end">${helpBadge('fd-help', 'How this works')}</div>
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
      <div class="text-xs text-muted">${remote ? '<strong>Deploys to the active remote host</strong> (over SSH). ' : ''}Files upload one by one, then <code>docker compose up</code> runs. <code>.git</code> / <code>node_modules</code> are skipped. Bind-mount paths resolve on the daemon's host. ~1GB max (single file up to ~384MB).</div>
    </div>`;
    const m = showModal(isUpdate ? `Update “${opts.update}” from folder` : 'Deploy from folder', body, []);
    const root = m.overlay;
    root.querySelector('#fd-help')?.addEventListener('click', openDeployHelp);
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
      if (bytes > 1024 * 1024 * 1024) { showToast('Folder exceeds the 1GB limit', 'error'); return; }
      // A single file is uploaded as base64 JSON, which JSON.parse/V8 caps near ~384MB. Catch it here
      // with a clear message instead of a cryptic server error on the biggest file.
      const tooBig = picked.find(f => f.size > 380 * 1024 * 1024);
      if (tooBig) { showToast(`"${tooBig.name || tooBig.webkitRelativePath || 'a file'}" is over ~380MB — single files that large can't be uploaded this way. Use a pre-built image or git deploy.`, 'error', 11000); return; }
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
        // Upload done. Fresh deploy → scan + pick compose file(s)/services/build. Update → pick which services to rebuild.
        let plan = null, updateServices;
        const cancelDeploy = (resetLabel) => { if (uploadId) { API.post('/compose/deploy-folder-abort', { uploadId }).catch(() => {}); uploadId = null; } btn.disabled = false; btn.textContent = resetLabel; remaining.textContent = 'cancelled'; };
        if (!isUpdate) {
          btn.textContent = 'Scanning…'; remaining.textContent = 'scanning compose files…';
          let scan = { files: [] };
          try { scan = await API.post('/compose/deploy-folder-scan', { uploadId }); } catch (e) {}
          if ((scan.files || []).length) {
            plan = await chooseDeployPlan(scan.files, project);
            if (!plan) { cancelDeploy('Deploy'); return; }
          }
        } else if ((opts.services || []).length) {
          const svc = await chooseServices(opts.services, project, 'Rebuild');
          if (svc === null) { cancelDeploy('Update & Rebuild'); return; }
          updateServices = svc; // [] = all
        }
        // Hand off to a background job that keeps running even if this modal closes.
        btn.textContent = isUpdate ? 'Rebuilding…' : 'Starting…';
        const finished = await API.post('/compose/deploy-folder-finish', { uploadId, up: plan ? plan.up : true, plan, services: updateServices });
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
    const banner = document.getElementById('deploy-banner');
    if (!el && !banner) return;
    let jobs = [];
    try { jobs = await API.get('/compose/deploy-jobs'); } catch (e) { return; }
    if (!document.getElementById('deploy-console') && !document.getElementById('deploy-banner')) return;
    const running = jobs.filter(j => j.status === 'running');
    // Prominent TOP banner for any deploy in progress — live step + progress bar + one-click Watch, so a
    // running process is impossible to miss (auto-surfaces webhook-triggered deploys too).
    if (banner) {
      banner.innerHTML = running.length ? (`<style>@keyframes spin{to{transform:rotate(360deg)}}</style>` + running.map(j => {
        const steps = j.steps || [];
        const done = steps.filter(s => s.status === 'done').length;
        const cur = steps.find(s => s.status === 'running');
        const pct = steps.length ? Math.max(8, Math.round(done / steps.length * 100)) : 35;
        return `<div class="card mb-2" style="border-left:3px solid var(--accent);padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="spinner" style="display:inline-block;width:14px;height:14px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;flex:none"></span>
          <div style="flex:1;min-width:200px">
            <div style="font-weight:600;font-size:13px">Deploying <strong>${escapeHtml(j.project)}</strong> — ${escapeHtml(cur ? cur.label : j.phase)}${steps.length ? ` <span class="text-muted">(${done}/${steps.length})</span>` : ''}</div>
            <div style="height:5px;background:var(--border);border-radius:3px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent);transition:width .4s"></div></div>
          </div>
          <button class="btn btn-sm btn-primary" data-joblog="${j.id}" data-jobproj="${escapeHtml(j.project)}">${Icons.eye || '👁'} Watch</button>
        </div>`;
      }).join('')) : '';
      banner.querySelectorAll('[data-joblog]').forEach(b => b.addEventListener('click', () => openDeployLog(b.dataset.joblog, b.dataset.jobproj)));
    }
    // History table (recent jobs) at the bottom — now with an inline progress bar on running rows.
    if (!el) return;
    if (!jobs.length) { el.innerHTML = ''; return; }
    const active = running.length;
    const icon = (s) => s === 'running' ? '<span class="spinner" style="display:inline-block;width:10px;height:10px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite"></span>' : (s === 'done' ? '<span style="color:var(--success,#3fb950)">✓</span>' : '<span style="color:var(--danger,#f85149)">✗</span>');
    const collapsed = localStorage.getItem('dcc_deploys_collapsed') === '1';
    el.innerHTML = `
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      <div id="deploys-head" style="font-weight:600;font-size:13px;margin-bottom:6px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px"><span id="deploys-arrow">${collapsed ? '▸' : '▾'}</span> Deploys${active ? ` <span class="badge badge-running" style="font-size:10px">${active} active</span>` : ''} <span class="text-muted text-xs" style="font-weight:400">(${jobs.length})</span></div>
      <div id="deploys-body" style="${collapsed ? 'display:none' : ''}"><div class="table-wrapper"><table><tbody>${jobs.map(j => {
        const steps = j.steps || []; const done = steps.filter(s => s.status === 'done').length;
        const pct = steps.length ? Math.max(8, Math.round(done / steps.length * 100)) : 35;
        return `<tr>
        <td style="width:24px">${icon(j.status)}</td>
        <td class="td-name">${escapeHtml(j.project)}</td>
        <td class="text-xs text-muted" style="min-width:160px">${escapeHtml(j.phase)}${steps.length ? ` <span style="opacity:.7">(${done}/${steps.length})</span>` : ''}${j.status === 'running' ? `<div style="height:4px;background:var(--border);border-radius:2px;margin-top:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div>` : ''}</td>
        <td class="text-xs text-muted">${j.finishedAt ? timeAgo(j.finishedAt) : 'running…'}</td>
        <td style="text-align:right"><button class="btn btn-xs btn-secondary" data-joblog="${j.id}" data-jobproj="${escapeHtml(j.project)}">view log</button></td>
      </tr>`; }).join('')}</tbody></table></div></div>`;
    el.querySelector('#deploys-head')?.addEventListener('click', () => {
      const body = el.querySelector('#deploys-body'), arrow = el.querySelector('#deploys-arrow');
      const willCollapse = body.style.display !== 'none';
      body.style.display = willCollapse ? 'none' : '';
      if (arrow) arrow.textContent = willCollapse ? '▸' : '▾';
      localStorage.setItem('dcc_deploys_collapsed', willCollapse ? '1' : '0');
    });
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
    const modalRoot = document.getElementById('modal-root');
    const m = showModal(`Deploy — ${escapeHtml(project)}`, `
      <style>@keyframes dlpulse{0%,100%{opacity:1}50%{opacity:.45}}</style>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <div class="text-xs text-muted" id="dl-phase" style="flex:1;min-width:120px">…</div>
        <button class="btn btn-xs btn-secondary" id="dl-copy" type="button" title="Copy the whole log">📋 Copy</button>
        <button class="btn btn-xs btn-secondary" id="dl-dl" type="button" title="Download the log as a .txt file">⬇ Download</button>
        <button class="btn btn-xs btn-secondary" id="dl-full" type="button" title="Fullscreen">⛶</button>
      </div>
      <div id="dl-steps" style="margin-bottom:10px"></div>
      <div id="dl-term" style="height:58vh;background:#000;border-radius:6px;overflow:hidden;padding:6px"></div>`,
      [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const modalEl = root.querySelector('.modal');
    if (modalEl) { modalEl.style.width = 'min(1080px, 95vw)'; modalEl.style.maxWidth = '95vw'; }
    // Real terminal so \r/ANSI render right; fall back to a <pre> if xterm isn't available.
    let term = null, fit = null, pre = null, written = 0, fullLog = '';
    const host = root.querySelector('#dl-term');
    const refit = () => { try { fit && fit.fit(); } catch (e) {} };
    try {
      if (typeof Terminal === 'undefined') throw new Error('no xterm');
      term = new Terminal({ convertEol: true, disableStdin: true, fontSize: 12.5, scrollback: 50000, fontFamily: 'var(--font-mono), monospace', theme: { background: '#000000', foreground: '#e8ecf4' } });
      try { fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); } catch (e) {}
      term.open(host); refit();
    } catch (e) {
      pre = document.createElement('pre');
      pre.className = 'logs-viewer';
      pre.style.cssText = 'margin:0;height:100%;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word';
      host.style.padding = '0';
      host.appendChild(pre);
    }
    window.addEventListener('resize', refit);

    // Toolbar: copy / download the full log, and a fullscreen toggle.
    root.querySelector('#dl-copy')?.addEventListener('click', () => { navigator.clipboard?.writeText(fullLog).then(() => showToast('Log copied', 'success', 2000)); });
    root.querySelector('#dl-dl')?.addEventListener('click', () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([fullLog], { type: 'text/plain' }));
      a.download = `${project}-deploy.log`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    let full = false;
    root.querySelector('#dl-full')?.addEventListener('click', () => {
      full = !full;
      if (modalEl) {
        if (full) { Object.assign(modalEl.style, { position: 'fixed', inset: '10px', width: 'auto', maxWidth: 'none', height: 'auto', maxHeight: 'none', margin: '0' }); host.style.height = 'calc(100vh - 200px)'; }
        else { Object.assign(modalEl.style, { position: '', inset: '', width: 'min(1080px, 95vw)', maxWidth: '95vw', height: '', maxHeight: '', margin: '' }); host.style.height = '58vh'; }
      }
      setTimeout(refit, 60);
    });

    // Poll: stream the log live; STOP polling when the job finishes but KEEP the terminal alive so the log
    // stays readable. (Previously the terminal was disposed the moment polling stopped → black screen on re-open.)
    let polling = true;
    (async () => {
      while (polling && document.body.contains(root)) {
        let job;
        try { job = await API.get(`/compose/deploy-job/${jobId}`); }
        catch (e) { const p = root.querySelector('#dl-phase'); if (p) p.textContent = 'job expired (log no longer available)'; break; }
        if (!document.body.contains(root)) break;
        const phEl = root.querySelector('#dl-phase'), stepsEl = root.querySelector('#dl-steps');
        if (phEl) phEl.textContent = `${job.status} · ${job.phase}`;
        if (stepsEl) stepsEl.innerHTML = (job.steps || []).map((s, i, arr) => {
          const done = s.status === 'done', failed = s.status === 'failed', running = s.status === 'running';
          const color = done ? 'var(--success,#3fb950)' : failed ? 'var(--danger,#f85149)' : running ? 'var(--accent)' : 'var(--border-hover,#888)';
          const mark = done ? '✓' : failed ? '✗' : running ? '●' : (i + 1);
          const line = i < arr.length - 1 ? `<div style="width:2px;height:10px;margin-left:10px;background:${done ? 'var(--success,#3fb950)' : 'var(--border)'}"></div>` : '';
          return `<div style="display:flex;align-items:center;gap:9px">
              <span style="flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;background:${color}${running ? ';animation:dlpulse 1s ease-in-out infinite' : ''}">${mark}</span>
              <span style="font-size:12.5px;${running ? 'font-weight:600' : s.status === 'pending' ? 'opacity:.55' : ''}">${escapeHtml(s.label)}</span>
            </div>${line}`;
        }).join('');
        const log = job.log || ''; fullLog = log;
        if (term) { if (log.length > written) { term.write(log.slice(written)); written = log.length; } }
        else if (pre) { pre.textContent = log; pre.scrollTop = pre.scrollHeight; }
        if (job.status !== 'running') { renderDeploys(); break; }
        await new Promise(r => setTimeout(r, 1000));
      }
    })();

    // Dispose ONLY when the modal actually closes (X / backdrop / Close) — never on a finished-job break.
    const obs = new MutationObserver(() => {
      if (document.body.contains(root)) return;
      obs.disconnect(); polling = false;
      window.removeEventListener('resize', refit);
      try { if (term) term.dispose(); } catch (e) {}
    });
    obs.observe(modalRoot, { childList: true });
  }

  // Interactive shell opened directly in a project's folder, on the active server (remote SSH host, or the
  // local DockGate container). Reuses the hostterm:* socket channel; cwd is the project's working dir.
  function openProjectTerminal(project, cwd) {
    const modalRoot = document.getElementById('modal-root');
    const m = showModal(`Terminal — ${escapeHtml(project)}`, `
      <div class="text-xs text-muted" id="pt-status" style="margin-bottom:6px">Connecting…</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <div class="text-xs text-muted" style="flex:1;min-width:160px">Folder: <code>${escapeHtml(cwd || '(home)')}</code> · interactive shell on the active server</div>
        <div style="display:flex;gap:4px;align-items:center">
          <span class="text-xs text-muted">Size:</span>
          <button class="btn btn-xs btn-secondary" data-tsize="normal" type="button" title="Normal size">Normal</button>
          <button class="btn btn-xs btn-secondary" data-tsize="large" type="button" title="Larger">Large</button>
          <button class="btn btn-xs btn-secondary" data-tsize="full" type="button" title="Full screen">⛶ Full screen</button>
        </div>
      </div>
      <div id="pt-term" style="height:52vh;background:#000;border-radius:6px;overflow:hidden;padding:6px"></div>`,
      [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const host = root.querySelector('#pt-term');
    const statusEl = root.querySelector('#pt-status');
    if (typeof Terminal === 'undefined') { if (statusEl) statusEl.textContent = 'Terminal unavailable (xterm not loaded)'; return; }
    const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, fontFamily: 'var(--font-mono), monospace', theme: { background: '#000000', foreground: '#e8ecf4' } });
    let fit = null;
    try { fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); } catch (e) {}
    term.open(host);
    try { fit && fit.fit(); } catch (e) {}

    const onData = ({ data }) => term.write(data);
    const onEnd = () => { term.write('\r\n\x1b[33m— session ended —\x1b[0m\r\n'); if (statusEl) statusEl.textContent = 'Session ended'; };
    const onErr = ({ error }) => { term.write(`\r\n\x1b[31m— error: ${error || 'unknown'} —\x1b[0m\r\n`); if (statusEl) statusEl.textContent = 'Error: ' + (error || 'unknown'); };
    const resize = () => { try { fit && fit.fit(); socket.emit('hostterm:resize', { cols: term.cols, rows: term.rows }); } catch (e) {} };
    const onReady = ({ host: h }) => { if (statusEl) statusEl.textContent = 'Connected to ' + (h || 'host'); resize(); };

    socket.on('hostterm:data', onData).on('hostterm:end', onEnd).on('hostterm:error', onErr).on('hostterm:ready', onReady);
    term.onData(d => socket.emit('hostterm:input', d));
    window.addEventListener('resize', resize);

    // Terminal size control: Adi (normal) / Böyük (large) / ⛶ Tam ekran (full screen). Resizes the terminal
    // host AND the modal, then re-fits xterm so the shell's cols/rows track the new size. Remembered per browser.
    const modalEl = root.querySelector('.modal');
    const sizeBtns = root.querySelectorAll('[data-tsize]');
    function setTermSize(mode) {
      if (mode === 'full') { modalEl.style.maxWidth = '97vw'; modalEl.style.width = '97vw'; modalEl.style.maxHeight = '95vh'; host.style.height = '82vh'; }
      else if (mode === 'large') { modalEl.style.maxWidth = '1000px'; modalEl.style.width = '92vw'; modalEl.style.maxHeight = '92vh'; host.style.height = '72vh'; }
      else { mode = 'normal'; modalEl.style.maxWidth = ''; modalEl.style.width = ''; modalEl.style.maxHeight = ''; host.style.height = '52vh'; }
      sizeBtns.forEach(b => { const on = b.dataset.tsize === mode; b.classList.toggle('btn-primary', on); b.classList.toggle('btn-secondary', !on); });
      try { localStorage.setItem('dg_term_size', mode); } catch (e) {}
      setTimeout(resize, 70);
    }
    sizeBtns.forEach(b => b.addEventListener('click', () => setTermSize(b.dataset.tsize)));
    let savedSize = 'normal'; try { savedSize = localStorage.getItem('dg_term_size') || 'normal'; } catch (e) {}
    setTermSize(savedSize);

    socket.emit('hostterm:stop');
    setTimeout(() => { socket.emit('hostterm:start', { cols: term.cols || 80, rows: term.rows || 24, cwd: cwd || '' }); setTimeout(resize, 120); }, 60);

    // Clean up when the modal closes (X, backdrop, or Close button all remove the overlay from modal-root).
    const obs = new MutationObserver(() => {
      if (document.body.contains(root)) return;
      obs.disconnect();
      socket.emit('hostterm:stop');
      socket.off('hostterm:data', onData).off('hostterm:end', onEnd).off('hostterm:error', onErr).off('hostterm:ready', onReady);
      window.removeEventListener('resize', resize);
      try { term.dispose(); } catch (e) {}
    });
    obs.observe(modalRoot, { childList: true });
  }

  await render();
  // Auto-refresh project running counts; skip while a modal/input is active
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  // Refresh the Deploys console more often while something is running (cheap; in-memory job list)
  deployTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) renderDeploys(); }, 3000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); if (deployTimer) clearInterval(deployTimer); };
});
