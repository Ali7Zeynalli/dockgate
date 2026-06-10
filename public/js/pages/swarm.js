// Swarm Page — services & nodes for the active daemon (when it's a swarm manager).
// Uses the same dockerode client/SSH Proxy as everything else; gated on /api/swarm.active.
Router.register('swarm', async (content) => {
  let tab = 'services';
  let refreshTimer = null;
  const pageNavId = Router._navId;

  async function render() {
    let info;
    try { info = await API.get('/swarm'); }
    catch (e) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`; return; }
    if (!Router.isActiveNav(pageNavId)) return;

    if (!info.active) {
      content.innerHTML = `
        <div class="page-header"><div><div class="page-title">Swarm</div><div class="page-subtitle">Not in swarm mode</div></div></div>
        <div class="empty-state" style="padding:40px">
          <h3>This host is not a Swarm manager</h3>
          <p class="text-muted">Run <code>docker swarm init</code> on the active host, then refresh.</p>
          <button class="btn btn-secondary mt-2" id="sw-refresh">${Icons.refresh} Refresh</button>
        </div>`;
      document.getElementById('sw-refresh')?.addEventListener('click', render);
      return;
    }

    content.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">Swarm</div><div class="page-subtitle">${info.nodes || '?'} node(s) · ${info.managers || '?'} manager(s)${info.isManager ? '' : ' · worker (read-only)'}</div></div>
        <div class="page-actions">
          ${info.isManager ? `<button class="btn btn-primary" id="sw-new-svc">${Icons.play} New Service</button>` : ''}
          <button class="btn btn-secondary" id="sw-refresh">${Icons.refresh}</button>
        </div>
      </div>
      <div class="tab-bar" id="sw-tabs">
        <button class="tab-btn ${tab === 'services' ? 'active' : ''}" data-tab="services">Services</button>
        <button class="tab-btn ${tab === 'stacks' ? 'active' : ''}" data-tab="stacks">Stacks</button>
        <button class="tab-btn ${tab === 'nodes' ? 'active' : ''}" data-tab="nodes">Nodes</button>
      </div>
      <div id="sw-content" style="padding-top:16px"></div>`;
    document.getElementById('sw-refresh')?.addEventListener('click', render);
    document.getElementById('sw-new-svc')?.addEventListener('click', () => openServiceCreate(render));
    document.getElementById('sw-tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (!b) return; tab = b.dataset.tab; render(); });
    if (tab === 'services') renderServices(); else if (tab === 'stacks') renderStacks(); else renderNodes();
  }

  async function renderServices() {
    const el = document.getElementById('sw-content'); if (!el) return;
    let services;
    try { services = await API.get('/swarm/services'); }
    catch (e) { el.innerHTML = `<div class="text-danger" style="padding:14px">${escapeHtml(e.message)}</div>`; return; }
    el.innerHTML = `<div class="table-wrapper"><table>
      <thead><tr><th>Name</th><th>Image</th><th>Mode</th><th>Replicas</th><th>Ports</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${services.map(s => `<tr>
        <td class="td-name">${escapeHtml(s.name)}</td>
        <td class="td-mono text-sm">${escapeHtml(s.image)}</td>
        <td class="text-sm">${s.mode}</td>
        <td><span class="badge ${s.mode === 'global' ? 'badge-running' : (s.running === s.replicas ? 'badge-running' : 'badge-restarting')}">${s.mode === 'global' ? 'global' : s.running + '/' + s.replicas}</span></td>
        <td class="text-xs">${s.ports.join(', ') || '—'}</td>
        <td style="text-align:right"><div class="td-actions">
          ${s.mode === 'replicated' ? `<button class="btn btn-xs btn-secondary" data-scale="${s.id}" data-name="${escapeHtml(s.name)}" data-rep="${s.replicas}">Scale</button>` : ''}
          <button class="btn btn-xs btn-secondary" data-update="${s.id}" data-name="${escapeHtml(s.name)}" data-img="${escapeHtml(s.image)}">Update</button>
          <button class="btn btn-xs btn-secondary" data-svclogs="${s.id}" data-name="${escapeHtml(s.name)}">Logs</button>
          <button class="btn btn-xs btn-secondary" data-tasks="${s.id}" data-name="${escapeHtml(s.name)}">Tasks</button>
          <button class="btn btn-xs btn-secondary" data-svcinspect="${s.id}" data-name="${escapeHtml(s.name)}">${Icons.eye}</button>
          <button class="btn btn-xs btn-ghost text-danger" data-rmsvc="${s.id}" data-name="${escapeHtml(s.name)}">${Icons.trash}</button>
        </div></td>
      </tr>`).join('') || '<tr><td colspan="6" class="text-muted text-sm" style="padding:14px">No services.</td></tr>'}</tbody></table></div>`;

    el.querySelectorAll('[data-scale]').forEach(b => b.addEventListener('click', () => {
      const body = `<div class="input-group"><label>Replicas for ${escapeHtml(b.dataset.name)}</label><input class="input" id="sc-rep" type="number" min="0" value="${b.dataset.rep}"></div>`;
      showModal('Scale Service', body, [
        { label: 'Cancel', className: 'btn btn-secondary' },
        { label: 'Scale', className: 'btn btn-primary', onClick: async () => {
          try { await API.post(`/swarm/services/${b.dataset.scale}/scale`, { replicas: document.getElementById('sc-rep').value }); showToast('Service scaled'); render(); }
          catch (e) { showToast(e.message, 'error', 8000); }
        } },
      ]);
    }));

    el.querySelectorAll('[data-tasks]').forEach(b => b.addEventListener('click', async () => {
      try {
        const tasks = await API.get(`/swarm/services/${b.dataset.tasks}/tasks`);
        const rows = tasks.map(t => `<tr><td class="td-mono text-xs">${(t.id || '').substring(0, 12)}</td><td>${t.slot || '—'}</td><td><span class="badge ${t.state === 'running' ? 'badge-running' : 'badge-created'}">${escapeHtml(t.state || '')}</span></td><td class="text-xs text-muted" style="word-break:break-all">${escapeHtml(t.message || '')}</td></tr>`).join('');
        showModal(`Tasks — ${escapeHtml(b.dataset.name)}`, `<div class="table-wrapper" style="max-height:55vh;overflow:auto"><table><thead><tr><th>ID</th><th>Slot</th><th>State</th><th>Message</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="text-muted">No tasks</td></tr>'}</tbody></table></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
      } catch (e) { showToast(e.message, 'error'); }
    }));

    // Rolling image update (SW-a)
    el.querySelectorAll('[data-update]').forEach(b => b.addEventListener('click', () => {
      const body = `<div class="input-group"><label>New image for ${escapeHtml(b.dataset.name)}</label><input class="input" id="up-img" value="${escapeHtml(b.dataset.img)}"></div><div class="text-xs text-muted">A rolling update is triggered with the new image.</div>`;
      showModal('Update Service', body, [
        { label: 'Cancel', className: 'btn btn-secondary' },
        { label: 'Update', className: 'btn btn-primary', onClick: async () => {
          const image = document.getElementById('up-img').value.trim();
          if (!image) { showToast('Image required', 'warning'); return; }
          try { await API.post(`/swarm/services/${b.dataset.update}/update`, { image }); showToast('Rolling update started'); render(); }
          catch (e) { showToast(e.message, 'error', 8000); }
        } },
      ]);
    }));

    // Aggregated logs (SW-a)
    el.querySelectorAll('[data-svclogs]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await API.get(`/swarm/services/${b.dataset.svclogs}/logs?tail=300`);
        showModal(`Logs — ${escapeHtml(b.dataset.name)}`, `<pre class="logs-viewer" style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px">${escapeHtml(r.logs || '(empty)')}</pre>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
      } catch (e) { showToast(e.message, 'error'); }
    }));

    // Inspect (SW-a)
    el.querySelectorAll('[data-svcinspect]').forEach(b => b.addEventListener('click', async () => {
      try {
        const data = await API.get(`/swarm/services/${b.dataset.svcinspect}`);
        showModal(`Inspect — ${escapeHtml(b.dataset.name)}`, `<div class="json-viewer" style="max-height:60vh">${syntaxHighlightJSON(data)}</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
      } catch (e) { showToast(e.message, 'error'); }
    }));

    el.querySelectorAll('[data-rmsvc]').forEach(b => b.addEventListener('click', () => {
      showConfirm('Remove Service', `Remove service <strong>${escapeHtml(b.dataset.name)}</strong>?`, async () => {
        try { await API.del(`/swarm/services/${b.dataset.rmsvc}`); showToast('Service removed'); render(); }
        catch (e) { showToast(e.message, 'error'); }
      }, true);
    }));
  }

  // Stacks (SW-b) — list (grouped by namespace label), deploy from compose, remove
  async function renderStacks() {
    const el = document.getElementById('sw-content'); if (!el) return;
    let stacks;
    try { stacks = await API.get('/swarm/stacks'); }
    catch (e) { el.innerHTML = `<div class="text-danger" style="padding:14px">${escapeHtml(e.message)}</div>`; return; }
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="text-sm text-muted">${stacks.length} stack(s)</div>
        <button class="btn btn-sm btn-primary" id="stk-deploy">${Icons.play} Deploy Stack</button>
      </div>
      <div class="table-wrapper"><table>
        <thead><tr><th>Stack</th><th>Services</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>${stacks.map(s => `<tr>
          <td class="td-name">${escapeHtml(s.name)}</td>
          <td><span class="badge badge-running">${s.services}</span></td>
          <td style="text-align:right"><div class="td-actions">
            <button class="btn btn-xs btn-secondary" data-stk-svcs="${escapeHtml(s.name)}">Services</button>
            <button class="btn btn-xs btn-ghost text-danger" data-stk-rm="${escapeHtml(s.name)}">${Icons.trash}</button>
          </div></td>
        </tr>`).join('') || '<tr><td colspan="3" class="text-muted text-sm" style="padding:14px">No stacks deployed.</td></tr>'}</tbody></table></div>`;
    el.querySelector('#stk-deploy')?.addEventListener('click', openStackDeploy);
    el.querySelectorAll('[data-stk-rm]').forEach(b => b.addEventListener('click', () => {
      showConfirm('Remove Stack', `Remove stack <strong>${escapeHtml(b.dataset.stkRm)}</strong> and all its services?`, async () => {
        try { await API.del(`/swarm/stacks/${encodeURIComponent(b.dataset.stkRm)}`); showToast('Stack removed'); render(); }
        catch (e) { showToast(e.message, 'error', 8000); }
      }, true);
    }));
    el.querySelectorAll('[data-stk-svcs]').forEach(b => b.addEventListener('click', async () => {
      try {
        const all = await API.get('/swarm/services');
        const svcs = all.filter(s => s.stack === b.dataset.stkSvcs);
        const rows = svcs.map(s => `<tr><td class="td-name">${escapeHtml(s.name)}</td><td class="td-mono text-xs">${escapeHtml(s.image)}</td><td>${s.mode === 'global' ? 'global' : s.running + '/' + s.replicas}</td></tr>`).join('');
        showModal(`Stack — ${escapeHtml(b.dataset.stkSvcs)}`, `<div class="table-wrapper"><table><thead><tr><th>Service</th><th>Image</th><th>Replicas</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="text-muted">No services</td></tr>'}</tbody></table></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
      } catch (e) { showToast(e.message, 'error'); }
    }));
  }

  function openStackDeploy() {
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Stack name *</label><input class="input" id="stk-name" placeholder="myapp"></div>
      <div class="input-group"><label>Compose file (docker-compose.yml)</label><textarea class="input" id="stk-yaml" spellcheck="false" style="min-height:220px;font-family:var(--font-mono);font-size:12px;white-space:pre" placeholder="services:\n  web:\n    image: nginx:alpine\n    deploy:\n      replicas: 2"></textarea></div>
      <div class="text-xs text-muted">Deployed with <code>docker stack deploy</code> on the local host.</div>
    </div>`;
    const m = showModal('Deploy Stack', body, []);
    const root = m.overlay;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Deploy';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const name = root.querySelector('#stk-name').value.trim();
      const compose = root.querySelector('#stk-yaml').value;
      if (!name) { showToast('Stack name required', 'warning'); return; }
      if (!compose.trim()) { showToast('Compose file required', 'warning'); return; }
      btn.disabled = true; btn.textContent = 'Deploying…';
      try { await API.post('/swarm/stacks/deploy', { name, compose }); showToast('Stack deployed'); m.close(); render(); }
      catch (e) { showToast(e.message, 'error', 12000); btn.disabled = false; btn.textContent = 'Deploy'; }
    });
  }

  async function renderNodes() {
    const el = document.getElementById('sw-content'); if (!el) return;
    let nodes;
    try { nodes = await API.get('/swarm/nodes'); }
    catch (e) { el.innerHTML = `<div class="text-danger" style="padding:14px">${escapeHtml(e.message)}</div>`; return; }
    el.innerHTML = `<div class="table-wrapper"><table>
      <thead><tr><th>Hostname</th><th>Role</th><th>State</th><th>Availability</th><th>Engine</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${nodes.map(n => `<tr>
        <td class="td-name">${escapeHtml(n.hostname || '')} ${n.leader ? '<span class="badge badge-running" style="font-size:10px">leader</span>' : ''}</td>
        <td class="text-sm">${n.role}</td>
        <td><span class="badge ${n.state === 'ready' ? 'badge-running' : 'badge-dead'}">${escapeHtml(n.state || '')}</span></td>
        <td><span class="badge ${n.availability === 'active' ? 'badge-running' : 'badge-paused'}">${escapeHtml(n.availability || '')}</span></td>
        <td class="text-xs text-muted">${escapeHtml(n.engineVersion || '')}</td>
        <td style="text-align:right"><div class="td-actions">
          ${n.availability !== 'active' ? `<button class="btn btn-xs btn-secondary" data-avail="active" data-node="${n.id}">Activate</button>` : ''}
          ${n.availability !== 'drain' ? `<button class="btn btn-xs btn-secondary" data-avail="drain" data-node="${n.id}">Drain</button>` : ''}
        </div></td>
      </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-avail]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post(`/swarm/nodes/${b.dataset.node}/availability`, { availability: b.dataset.avail }); showToast(`Node → ${b.dataset.avail}`); render(); }
      catch (e) { showToast(e.message, 'error'); }
    }));
  }

  // Create a new service (SW-a) — simplified form (name, image, replicas, ports, mounts, env)
  function openServiceCreate(onDone) {
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="input-group" style="flex:2;min-width:160px"><label>Name *</label><input class="input" id="cs-name" placeholder="web"></div>
        <div class="input-group" style="flex:1;min-width:90px"><label>Replicas</label><input class="input" id="cs-rep" type="number" min="0" value="1"></div>
      </div>
      <div class="input-group"><label>Image *</label><input class="input" id="cs-image" placeholder="nginx:latest"></div>
      <div class="input-group"><label>Ports (comma, published:target)</label><input class="input" id="cs-ports" placeholder="8080:80, 443:443"></div>
      <div class="input-group"><label>Mounts (comma, source:target[:ro])</label><input class="input" id="cs-mounts" placeholder="mydata:/data, /etc/host:/etc/app:ro"></div>
      <div class="input-group"><label>Env (one KEY=VAL per line)</label><textarea class="input" id="cs-env" style="min-height:70px;font-family:var(--font-mono);font-size:12px" placeholder="NODE_ENV=production"></textarea></div>
    </div>`;
    const m = showModal('New Service', body, []);
    const root = m.overlay;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Create';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const name = root.querySelector('#cs-name').value.trim();
      const image = root.querySelector('#cs-image').value.trim();
      if (!name || !image) { showToast('Name and image required', 'warning'); return; }
      const ports = root.querySelector('#cs-ports').value.split(',').map(s => s.trim()).filter(Boolean).map(p => {
        const [a, b] = p.split(':'); return b ? { published: a, target: b } : { target: a };
      });
      const mounts = root.querySelector('#cs-mounts').value.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [source, target, mode] = s.split(':');
        return { type: source.startsWith('/') ? 'bind' : 'volume', source, target, mode };
      }).filter(mt => mt.target);
      const env = root.querySelector('#cs-env').value.split('\n').map(s => s.trim()).filter(l => l && l.includes('='));
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        await API.post('/swarm/services', { name, image, replicas: root.querySelector('#cs-rep').value, ports, mounts, env });
        showToast(`Service "${name}" created`); m.close(); onDone && onDone();
      } catch (e) { showToast(e.message, 'error', 9000); btn.disabled = false; btn.textContent = 'Create'; }
    });
  }

  await render();
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 10000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
