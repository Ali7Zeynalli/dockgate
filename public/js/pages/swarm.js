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
        <div class="card" style="max-width:580px;margin:24px auto;padding:24px">
          <h3 style="margin-top:0">Initialize Swarm</h3>
          <p class="text-muted text-sm">Turn the active host into a swarm <strong>manager</strong>. Other VPSes can then join it as workers/managers (you'll get the join command here).</p>
          <div class="input-group" style="margin:14px 0">
            <label>Advertise address — this host's reachable IP (optional, auto-detected if blank)</label>
            <input class="input" id="sw-adv" placeholder="e.g. 203.0.113.10">
            <span class="text-xs text-muted" style="margin-top:6px;display:block">
              <strong>Remote SSH server:</strong> leave this blank — DockGate auto-advertises that server's host IP, so other VPSes can join it.<br>
              <strong>Just this local machine:</strong> enter <code>127.0.0.1</code> (single-node swarm).<br>
              Override only if the host has multiple IPs and you want a specific one.
            </span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" id="sw-init">${Icons.swarm} Initialize Swarm</button>
            <button class="btn btn-secondary" id="sw-refresh">${Icons.refresh} Refresh</button>
          </div>
        </div>`;
      document.getElementById('sw-refresh')?.addEventListener('click', render);
      document.getElementById('sw-init')?.addEventListener('click', async () => {
        const btn = document.getElementById('sw-init'); btn.disabled = true; btn.textContent = 'Initializing…';
        try { await API.post('/swarm/init', { advertiseAddr: document.getElementById('sw-adv').value.trim() }); showToast('Swarm initialized'); render(); }
        catch (e) { showToast(e.message, 'error', 10000); btn.disabled = false; btn.textContent = 'Initialize Swarm'; }
      });
      return;
    }

    content.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">Swarm</div><div class="page-subtitle">${info.nodes || '?'} node(s) · ${info.managers || '?'} manager(s)${info.isManager ? '' : ' · worker (read-only)'}</div></div>
        <div class="page-actions">
          ${info.isManager ? `<button class="btn btn-primary" id="sw-new-svc">${Icons.play} New Service</button>` : ''}
          ${info.isManager ? `<button class="btn btn-secondary" id="sw-join">Join a node</button>` : ''}
          <button class="btn btn-secondary" id="sw-refresh">${Icons.refresh}</button>
          <button class="btn btn-ghost text-danger" id="sw-leave" title="Leave the swarm">Leave</button>
        </div>
      </div>
      <div class="tab-bar" id="sw-tabs">
        <button class="tab-btn ${tab === 'services' ? 'active' : ''}" data-tab="services">Services</button>
        <button class="tab-btn ${tab === 'stacks' ? 'active' : ''}" data-tab="stacks">Stacks</button>
        <button class="tab-btn ${tab === 'secrets' ? 'active' : ''}" data-tab="secrets">Secrets &amp; Configs</button>
        <button class="tab-btn ${tab === 'nodes' ? 'active' : ''}" data-tab="nodes">Nodes</button>
      </div>
      <div id="sw-content" style="padding-top:16px"></div>`;
    document.getElementById('sw-refresh')?.addEventListener('click', render);
    document.getElementById('sw-new-svc')?.addEventListener('click', () => openSwarmServiceCreate({}, render));
    document.getElementById('sw-join')?.addEventListener('click', openJoinTokens);
    document.getElementById('sw-leave')?.addEventListener('click', () => {
      showConfirm('Leave Swarm', 'Leave the swarm on this host? On the last manager this destroys the swarm and all its services.', async () => {
        try { await API.post('/swarm/leave', { force: true }); showToast('Left the swarm'); render(); }
        catch (e) { showToast(e.message, 'error', 9000); }
      }, true);
    });
    document.getElementById('sw-tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (!b) return; tab = b.dataset.tab; render(); });
    if (tab === 'services') renderServices();
    else if (tab === 'stacks') renderStacks();
    else if (tab === 'secrets') renderSecretsConfigs();
    else renderNodes();
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

  // Join tokens (SW-bootstrap) — one-click auto-join for DockGate's SSH servers + manual fallback command
  async function openJoinTokens() {
    let t, servers = [];
    try { t = await API.get('/swarm/jointokens'); }
    catch (e) { showToast(e.message, 'error'); return; }
    try { servers = (await API.get('/servers')).servers || []; } catch (e) {}
    // Joinable = remote SSH servers that aren't the active manager
    const joinable = servers.filter(s => s.id !== 'local' && !s.isActive);
    const loopback = /^(127\.|::1|0\.0\.0\.0)/.test(t.address || '');
    const workerCmd = `docker swarm join --token ${t.worker} ${t.address}`;
    const managerCmd = `docker swarm join --token ${t.manager} ${t.address}`;

    const autoSection = `
      <div class="card" style="padding:14px;background:var(--accent-dim)">
        <div style="font-weight:600;margin-bottom:6px">Auto-join one of your servers (no manual command)</div>
        ${loopback ? `<div class="text-xs" style="color:var(--warning);margin-bottom:8px">⚠ The manager advertises <code>${escapeHtml(t.address)}</code> — other nodes can't reach a loopback address. Re-initialize the swarm with the manager's public IP (Leave → Initialize with its IP) for auto-join to work.</div>` : ''}
        ${joinable.length ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select class="select" id="join-server" style="flex:1;min-width:160px">${joinable.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)}${s.host ? ' (' + escapeHtml(s.host) + ')' : ''}</option>`).join('')}</select>
            <select class="select" id="join-role" style="width:130px"><option value="worker">worker</option><option value="manager">manager</option></select>
            <button class="btn btn-primary" id="join-go" ${loopback ? 'disabled' : ''}>Join →</button>
          </div>
          <div class="text-xs text-muted" style="margin-top:6px">DockGate connects to the chosen server and runs the join for you. Ports <code>2377/tcp</code>, <code>7946/tcp+udp</code>, <code>4789/udp</code> must be open between the VPSes.</div>
        ` : `<div class="text-xs text-muted">Add other VPSes as SSH servers (Settings → Servers) to enable one-click join.</div>`}
      </div>`;

    const body = `<div style="display:flex;flex-direction:column;gap:14px">
      ${autoSection}
      <details><summary class="text-sm" style="cursor:pointer">Or run the command manually on the other VPS</summary>
        <div style="margin-top:10px"><div class="detail-label mb-1">Worker:</div><pre class="logs-viewer" style="white-space:pre-wrap;word-break:break-all;font-size:12px;padding:10px">${escapeHtml(workerCmd)}</pre></div>
        <div style="margin-top:8px"><div class="detail-label mb-1">Manager (HA):</div><pre class="logs-viewer" style="white-space:pre-wrap;word-break:break-all;font-size:12px;padding:10px">${escapeHtml(managerCmd)}</pre></div>
      </details>
    </div>`;
    const m = showModal('Join a node to the swarm', body, [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('#join-go')?.addEventListener('click', async () => {
      const serverId = m.overlay.querySelector('#join-server').value;
      const role = m.overlay.querySelector('#join-role').value;
      const btn = m.overlay.querySelector('#join-go');
      btn.disabled = true; btn.textContent = 'Joining…';
      try {
        const r = await API.post('/swarm/nodes/join', { serverId, role });
        showToast(`${serverId} (${r.host}) joined as ${role}`);
        m.close(); render();
      } catch (e) { showToast(e.message, 'error', 12000); btn.disabled = false; btn.textContent = 'Join →'; }
    });
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

  // Secrets & Configs (SW-c) — one tab, two sections
  async function renderSecretsConfigs() {
    const el = document.getElementById('sw-content'); if (!el) return;
    let secrets = [], configs = [];
    try { [secrets, configs] = await Promise.all([API.get('/swarm/secrets'), API.get('/swarm/configs')]); }
    catch (e) { el.innerHTML = `<div class="text-danger" style="padding:14px">${escapeHtml(e.message)}</div>`; return; }
    const tableFor = (items, kind) => `<div class="table-wrapper"><table>
      <thead><tr><th>Name</th><th>Created</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${items.map(x => `<tr>
        <td class="td-name">${escapeHtml(x.name || '')}</td>
        <td class="text-muted text-sm">${x.createdAt ? timeAgo(x.createdAt) : ''}</td>
        <td style="text-align:right"><button class="btn btn-xs btn-ghost text-danger" data-rm-${kind}="${x.id}" data-name="${escapeHtml(x.name || '')}">${Icons.trash}</button></td>
      </tr>`).join('') || `<tr><td colspan="3" class="text-muted text-sm" style="padding:12px">No ${kind}s.</td></tr>`}</tbody></table></div>`;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 8px"><h3 style="margin:0;font-size:15px">Secrets</h3><button class="btn btn-xs btn-primary" id="new-secret">New Secret</button></div>
      ${tableFor(secrets, 'secret')}
      <div style="display:flex;justify-content:space-between;align-items:center;margin:22px 0 8px"><h3 style="margin:0;font-size:15px">Configs</h3><button class="btn btn-xs btn-primary" id="new-config">New Config</button></div>
      ${tableFor(configs, 'config')}`;
    el.querySelector('#new-secret')?.addEventListener('click', () => openSecretCreate('secret'));
    el.querySelector('#new-config')?.addEventListener('click', () => openSecretCreate('config'));
    el.querySelectorAll('[data-rm-secret]').forEach(b => b.addEventListener('click', () => rmSecretConfig('secret', b.dataset.rmSecret, b.dataset.name)));
    el.querySelectorAll('[data-rm-config]').forEach(b => b.addEventListener('click', () => rmSecretConfig('config', b.dataset.rmConfig, b.dataset.name)));
  }

  function rmSecretConfig(kind, id, name) {
    showConfirm(`Remove ${kind}`, `Remove ${kind} <strong>${escapeHtml(name)}</strong>? An in-use ${kind} can't be removed.`, async () => {
      try { await API.del(`/swarm/${kind}s/${id}`); showToast(`${kind} removed`); render(); }
      catch (e) { showToast(e.message, 'error', 8000); }
    }, true);
  }

  function openSecretCreate(kind) {
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Name *</label><input class="input" id="sc-name" placeholder="db_password"></div>
      <div class="input-group"><label>Value *</label><textarea class="input" id="sc-data" style="min-height:100px;font-family:var(--font-mono);font-size:12px" placeholder="the ${kind} value"></textarea></div>
      ${kind === 'secret' ? '<div class="text-xs text-muted">Secret values are write-only — they cannot be read back after creation.</div>' : ''}
    </div>`;
    const m = showModal(`New ${kind === 'secret' ? 'Secret' : 'Config'}`, body, []);
    const root = m.overlay;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Create';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const name = root.querySelector('#sc-name').value.trim();
      const data = root.querySelector('#sc-data').value;
      if (!name || !data) { showToast('Name and value required', 'warning'); return; }
      btn.disabled = true; btn.textContent = 'Creating…';
      try { await API.post(`/swarm/${kind}s`, { name, data }); showToast(`${kind} created`); m.close(); render(); }
      catch (e) { showToast(e.message, 'error', 9000); btn.disabled = false; btn.textContent = 'Create'; }
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
          ${!n.leader ? `<button class="btn btn-xs btn-ghost text-danger" data-noderm="${n.id}" data-host="${escapeHtml(n.hostname || '')}">${Icons.trash}</button>` : ''}
        </div></td>
      </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-avail]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post(`/swarm/nodes/${b.dataset.node}/availability`, { availability: b.dataset.avail }); showToast(`Node → ${b.dataset.avail}`); render(); }
      catch (e) { showToast(e.message, 'error'); }
    }));
    el.querySelectorAll('[data-noderm]').forEach(b => b.addEventListener('click', () => {
      showConfirm('Remove Node', `Remove node <strong>${escapeHtml(b.dataset.host)}</strong> from the swarm? Drain it first; this forces removal of a down node.`, async () => {
        try { await API.del(`/swarm/nodes/${b.dataset.noderm}?force=1`); showToast('Node removed'); render(); }
        catch (e) { showToast(e.message, 'error', 8000); }
      }, true);
    }));
  }

  // "New Service" formu artıq qlobal openSwarmServiceCreate-dədir (swarm-service-modal.js) —
  // cross-module giriş nöqtələri (Images → Deploy as Service və s.) də onu istifadə edir.

  await render();
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 10000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
