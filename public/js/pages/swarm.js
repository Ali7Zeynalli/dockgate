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
        <div class="page-actions"><button class="btn btn-secondary" id="sw-refresh">${Icons.refresh}</button></div>
      </div>
      <div class="tab-bar" id="sw-tabs">
        <button class="tab-btn ${tab === 'services' ? 'active' : ''}" data-tab="services">Services</button>
        <button class="tab-btn ${tab === 'nodes' ? 'active' : ''}" data-tab="nodes">Nodes</button>
      </div>
      <div id="sw-content" style="padding-top:16px"></div>`;
    document.getElementById('sw-refresh')?.addEventListener('click', render);
    document.getElementById('sw-tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (!b) return; tab = b.dataset.tab; render(); });
    if (tab === 'services') renderServices(); else renderNodes();
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
          <button class="btn btn-xs btn-secondary" data-tasks="${s.id}" data-name="${escapeHtml(s.name)}">Tasks</button>
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

    el.querySelectorAll('[data-rmsvc]').forEach(b => b.addEventListener('click', () => {
      showConfirm('Remove Service', `Remove service <strong>${escapeHtml(b.dataset.name)}</strong>?`, async () => {
        try { await API.del(`/swarm/services/${b.dataset.rmsvc}`); showToast('Service removed'); render(); }
        catch (e) { showToast(e.message, 'error'); }
      }, true);
    }));
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

  await render();
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 10000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
