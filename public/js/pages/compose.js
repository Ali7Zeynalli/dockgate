// Compose Page
Router.register('compose', async (content) => {
  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;
  let refreshTimer = null;

  // YAML editor (2A) + guided "add service" builder (2B). Create new or edit a managed project.
  async function openComposeEditor(existing) {
    let yaml = '';
    if (existing) {
      try { const f = await API.get(`/compose/${existing}/file`); yaml = f.yaml || ''; }
      catch (e) { showToast('Not a DockGate-managed project — paste its YAML to adopt it', 'info', 7000); }
    }
    const ph = 'services:\n  web:\n    image: nginx:alpine\n    restart: unless-stopped\n    ports:\n      - "8080:80"';
    const body = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="input-group"><label>Project name *</label>
          <input class="input" id="cmp-name" placeholder="my-stack" value="${escapeHtml(existing || '')}" ${existing ? 'readonly' : ''}></div>
        <details class="card" style="padding:8px 12px">
          <summary style="cursor:pointer;font-weight:600">+ Add a service (guided)</summary>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
            <input class="input" id="gs-name" placeholder="service name (e.g. web)">
            <input class="input" id="gs-image" placeholder="image (e.g. nginx:alpine)">
            <input class="input" id="gs-ports" placeholder='ports, comma-separated (e.g. 8080:80, 443:443)'>
            <input class="input" id="gs-vols" placeholder='volumes, comma-separated (e.g. ./data:/data)'>
            <input class="input" id="gs-env" placeholder='env, comma-separated (e.g. KEY=val, FOO=bar)'>
            <button class="btn btn-sm btn-secondary" id="gs-add" type="button">Append service to YAML ↓</button>
          </div>
        </details>
        <div class="input-group"><label>docker-compose.yml</label>
          <textarea id="cmp-yaml" class="input" spellcheck="false" style="font-family:var(--font-mono);min-height:300px;white-space:pre;overflow:auto" placeholder="${escapeHtml(ph)}">${escapeHtml(yaml)}</textarea></div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-primary" id="cmp-submit">${existing ? 'Save & Up' : 'Create & Up'}</button>
        </div>
      </div>`;
    const m = showModal(existing ? `Edit Compose: ${existing}` : 'New Compose Project', body, []);
    const root = m.overlay;
    const ta = root.querySelector('#cmp-yaml');

    // 2B — generate a service block from the guided inputs and append it to the YAML
    root.querySelector('#gs-add')?.addEventListener('click', () => {
      const name = root.querySelector('#gs-name').value.trim();
      const image = root.querySelector('#gs-image').value.trim();
      if (!name || !image) { showToast('Service name and image are required', 'warning'); return; }
      const list = (id) => root.querySelector('#' + id).value.split(',').map(s => s.trim()).filter(Boolean);
      const ports = list('gs-ports'), vols = list('gs-vols'), env = list('gs-env');
      let block = `  ${name}:\n    image: ${image}\n    restart: unless-stopped\n`;
      if (ports.length) block += '    ports:\n' + ports.map(p => `      - "${p}"`).join('\n') + '\n';
      if (vols.length) block += '    volumes:\n' + vols.map(v => `      - "${v}"`).join('\n') + '\n';
      if (env.length) block += '    environment:\n' + env.map(e => `      - ${e}`).join('\n') + '\n';
      let cur = ta.value.replace(/\s+$/, '');
      if (!/^services:/m.test(cur)) cur = (cur ? cur + '\n' : '') + 'services:';
      ta.value = cur + '\n' + block;
      ['gs-name', 'gs-image', 'gs-ports', 'gs-vols', 'gs-env'].forEach(id => { root.querySelector('#' + id).value = ''; });
    });

    root.querySelector('#cmp-submit')?.addEventListener('click', async () => {
      const project = root.querySelector('#cmp-name').value.trim();
      const yamlVal = ta.value;
      if (!project) { showToast('Project name is required', 'warning'); return; }
      if (!yamlVal.trim()) { showToast('Compose YAML is required', 'warning'); return; }
      const btn = root.querySelector('#cmp-submit');
      btn.disabled = true; btn.textContent = 'Working...';
      try {
        if (existing) await API.put(`/compose/${encodeURIComponent(existing)}/file`, { yaml: yamlVal, up: true });
        else await API.post('/compose/create', { project, yaml: yamlVal, up: true });
        showToast(`Compose project ${existing ? 'updated' : 'created'} & started`);
        m.close();
        render();
      } catch (err) {
        showToast(err.message, 'error', 9000);
        btn.disabled = false; btn.textContent = existing ? 'Save & Up' : 'Create & Up';
      }
    });
  }

  async function render() {
    try {
      const projects = await API.get('/compose');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;
      // Compose runs the host `docker compose` CLI against host-filesystem paths → local-only.
      // On a remote SSH host the actions return 400, so gate them in the UI proactively.
      const remote = isRemoteActive();
      const dis = remote ? 'disabled title="Switch to Local — Compose runs on the host filesystem"' : '';
      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Compose Projects</div><div class="page-subtitle">${projects.length} project(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="compose-new" ${dis}>${Icons.compose} New Project</button>
            <button class="btn btn-secondary" id="compose-refresh">${Icons.refresh}</button>
          </div>
        </div>
        ${remote ? '<div class="card mb-3" style="border-left:3px solid var(--warning);padding:10px 14px;font-size:13px;color:var(--text-secondary)">A remote SSH host is active. Compose actions run on the local host only — switch to <strong>Local</strong> to manage Compose projects.</div>' : ''}
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
  await render();
  // Auto-refresh project running counts; skip while a modal/input is active
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
