// Networks Page
Router.register('networks', async (content) => {
  let selectedIds = new Set();
  let refreshTimer = null;

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      const networks = await API.get('/networks');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      // Clean up selectedIds that are no longer visible
      const visibleIds = new Set(networks.map(n => n.id));
      for (const id of selectedIds) {
        if (!visibleIds.has(id)) selectedIds.delete(id);
      }

      // Only user-created, empty networks can be removed/selected
      const removableNetworks = networks.filter(n => !['bridge', 'host', 'none'].includes(n.name) && n.containers === 0);

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Networks</div><div class="page-subtitle">${networks.length} network(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="net-new">${Icons.network} New Network</button>
            <button class="btn btn-secondary" id="net-refresh">${Icons.refresh}</button>
          </div>
        </div>

        ${selectedIds.size > 0 ? `
        <div class="card mb-2" style="padding:12px 18px;display:flex;align-items:center;gap:12px;background:var(--accent-dim)">
          <span class="text-sm font-bold">${selectedIds.size} selected</span>
          <button class="btn btn-sm btn-danger" id="bulk-remove">${Icons.trash} Remove</button>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-ghost" id="bulk-clear">Clear</button>
        </div>` : ''}

        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th style="width:40px"><div class="checkbox ${removableNetworks.length > 0 && selectedIds.size === removableNetworks.length ? 'checked' : ''}" id="select-all"></div></th>
              <th>Name</th><th>Driver</th><th>Scope</th><th>Subnet</th><th>Gateway</th><th>Containers</th><th>Internal</th><th style="text-align:right">Actions</th>
            </tr></thead>
            <tbody>
              ${networks.map(n => {
                const canRemove = !['bridge', 'host', 'none'].includes(n.name) && n.containers === 0;
                return `<tr class="${selectedIds.has(n.id) ? 'selected' : ''}">
                  <td>${canRemove ? `<div class="checkbox ${selectedIds.has(n.id) ? 'checked' : ''}" data-select="${n.id}"></div>` : ''}</td>
                  <td class="td-name">${escapeHtml(n.name)}</td>
                  <td><span class="badge badge-created">${n.driver}</span></td>
                  <td class="text-sm">${n.scope}</td>
                  <td class="td-mono">${n.subnet || '—'}</td>
                  <td class="td-mono">${n.gateway || '—'}</td>
                  <td><span class="badge ${n.containers > 0 ? 'badge-running' : 'badge-dead'}">${n.containers}</span></td>
                  <td>${n.internal ? '<span class="badge badge-paused">Yes</span>' : '<span class="badge badge-dead">No</span>'}</td>
                  <td><div class="td-actions">
                    <button class="btn-icon" title="Inspect" data-inspect="${n.id}">${Icons.eye}</button>
                    <button class="btn-icon" title="Clone" data-clone="${n.id}">${Icons.copy}</button>
                    ${canRemove ? `<button class="btn-icon" title="Remove" data-remove="${n.id}" data-name="${escapeHtml(n.name)}" style="color:var(--danger)">${Icons.trash}</button>` : ''}
                  </div></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('net-refresh')?.addEventListener('click', render);
      document.getElementById('net-new')?.addEventListener('click', () => openNetworkCreate());

      // Clone — prefill the create form from an existing network's config (N4)
      content.querySelectorAll('[data-clone]').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const d = await API.get(`/networks/${btn.dataset.clone}`);
          const ipam = (d.IPAM?.Config || [])[0] || {};
          openNetworkCreate({ name: d.Name + '-clone', driver: d.Driver, subnet: ipam.Subnet || '', gateway: ipam.Gateway || '', iprange: ipam.IPRange || '', internal: d.Internal, attachable: d.Attachable, ipv6: d.EnableIPv6, _clone: true });
        } catch (e) { showToast(e.message, 'error'); }
      }));

      // Single remove
      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          showConfirm('Remove Network', `Remove <strong>${btn.dataset.name}</strong>?`, async () => {
            try { await API.del(`/networks/${btn.dataset.remove}`); showToast('Network removed'); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      });

      // Inspect (+ live connect/disconnect)
      content.querySelectorAll('[data-inspect]').forEach(btn => {
        btn.addEventListener('click', () => openNetworkInspect(btn.dataset.inspect));
      });

      // Selection — only removable networks can be selected
      content.querySelectorAll('[data-select]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = el.dataset.select;
          if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
          render();
        });
      });

      document.getElementById('select-all')?.addEventListener('click', () => {
        if (selectedIds.size === removableNetworks.length) selectedIds.clear();
        else removableNetworks.forEach(n => selectedIds.add(n.id));
        render();
      });

      // Bulk actions
      document.getElementById('bulk-clear')?.addEventListener('click', () => { selectedIds.clear(); render(); });

      document.getElementById('bulk-remove')?.addEventListener('click', () => {
        showConfirm('Remove Selected Networks', `Remove ${selectedIds.size} network(s)?`, async () => {
          await bulkRun([...selectedIds], (id) => API.del(`/networks/${id}`), 'Removed');
          selectedIds.clear();
          render();
        }, true);
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  // Suggest a free private subnet (+ gateway + IP range) avoiding the ones already in use.
  // `used` is the list of existing subnets; `extra` lets the Suggest button advance past the current value.
  function suggestSubnet(used, extra = []) {
    const taken = new Set([...used, ...extra].filter(Boolean).map(s => s.split('/')[0].split('.').slice(0, 2).join('.')));
    const make = (b) => ({ subnet: `${b}.0.0/16`, gateway: `${b}.0.1`, iprange: `${b}.0.0/24` });
    for (let i = 18; i <= 31; i++) { const b = `172.${i}`; if (!taken.has(b)) return make(b); }
    for (let i = 20; i <= 250; i++) { const b = `10.${i}`; if (!taken.has(b)) return make(b); }
    return { subnet: '', gateway: '', iprange: '' };
  }

  // Rich create form (N2) — also used by Clone (N4) with a prefilled config. Auto-suggests a free subnet.
  async function openNetworkCreate(prefill = {}) {
    const drivers = ['bridge', 'macvlan', 'ipvlan', 'overlay'];
    // Existing subnets → suggest a free one (the page list already carries each network's subnet)
    let used = [];
    try { used = (await API.get('/networks').catch(() => [])).map(n => n.subnet).filter(Boolean); } catch (e) {}
    const sug = suggestSubnet(used); // a clone's copied subnet would conflict, so always offer a fresh one
    const subnet0 = prefill._clone || !prefill.subnet ? sug.subnet : prefill.subnet;
    const gw0 = prefill._clone || !prefill.gateway ? sug.gateway : prefill.gateway;
    const ipr0 = prefill._clone || !prefill.iprange ? sug.iprange : prefill.iprange;
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label for="nc-name">Name *</label><input class="input" id="nc-name" value="${escapeHtml(prefill.name || '')}"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:140px"><label>Driver</label><select class="select" id="nc-driver">${drivers.map(d => `<option value="${d}" ${d === (prefill.driver || 'bridge') ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="input-group" style="flex:1;min-width:140px"><label style="display:flex;justify-content:space-between;align-items:center">Subnet <button type="button" id="nc-suggest" class="btn btn-xs btn-ghost" style="font-weight:400">↻ Suggest</button></label><input class="input" id="nc-subnet" placeholder="172.20.0.0/16" value="${escapeHtml(subnet0)}"></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:140px"><label>Gateway</label><input class="input" id="nc-gateway" placeholder="172.20.0.1" value="${escapeHtml(gw0)}"></div>
        <div class="input-group" style="flex:1;min-width:140px"><label>IP range (optional)</label><input class="input" id="nc-iprange" value="${escapeHtml(ipr0)}"></div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="nc-internal" ${prefill.internal ? 'checked' : ''}> Internal</label>
        <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="nc-attachable" ${prefill.attachable ? 'checked' : ''}> Attachable</label>
        <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="nc-ipv6" ${prefill.ipv6 ? 'checked' : ''}> IPv6</label>
      </div>
      <div id="nc-overlay-note" class="text-xs text-muted" style="display:none">An <strong>overlay</strong> network spans multiple Docker hosts. Keep <strong>Attachable</strong> on if standalone containers should also use it.</div>
      ${prefill._clone ? '<div class="text-xs text-muted">Cloning copies the config — pick a different subnet to avoid an overlap conflict.</div>' : ''}
    </div>`;
    const m = showModal(prefill._clone ? 'Clone Network' : 'New Network', body, []);
    const root = m.overlay;
    // Overlay spans multiple hosts; default Attachable on and show a note.
    const driverSel = root.querySelector('#nc-driver');
    const overlayNote = root.querySelector('#nc-overlay-note');
    const syncOverlay = () => {
      const isOverlay = driverSel.value === 'overlay';
      overlayNote.style.display = isOverlay ? 'block' : 'none';
      if (isOverlay && !root.querySelector('#nc-attachable').checked) root.querySelector('#nc-attachable').checked = true;
    };
    driverSel.addEventListener('change', syncOverlay);
    syncOverlay();
    // Suggest → pick the next free subnet (advances past the current one)
    root.querySelector('#nc-suggest')?.addEventListener('click', () => {
      const cur = root.querySelector('#nc-subnet').value.trim();
      const s = suggestSubnet(used, [cur]);
      if (!s.subnet) { showToast('No free subnet found', 'warning'); return; }
      root.querySelector('#nc-subnet').value = s.subnet;
      root.querySelector('#nc-gateway').value = s.gateway;
      root.querySelector('#nc-iprange').value = s.iprange;
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Create';
    root.querySelector('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const name = root.querySelector('#nc-name').value.trim();
      if (!name) { showToast('Name required', 'warning'); return; }
      const config = {
        Name: name,
        Driver: root.querySelector('#nc-driver').value,
        Internal: root.querySelector('#nc-internal').checked,
        Attachable: root.querySelector('#nc-attachable').checked,
        EnableIPv6: root.querySelector('#nc-ipv6').checked,
      };
      const subnet = root.querySelector('#nc-subnet').value.trim();
      if (subnet) {
        const ipamCfg = { Subnet: subnet };
        const gw = root.querySelector('#nc-gateway').value.trim(); if (gw) ipamCfg.Gateway = gw;
        const ipr = root.querySelector('#nc-iprange').value.trim(); if (ipr) ipamCfg.IPRange = ipr;
        config.IPAM = { Config: [ipamCfg] };
      }
      btn.disabled = true; btn.textContent = 'Creating…';
      try { await API.post('/networks', config); showToast(`Network "${name}" created`); m.close(); render(); }
      catch (e) { showToast(e.message, 'error', 9000); btn.disabled = false; btn.textContent = 'Create'; }
    });
  }

  // Inspect modal with live container connect/disconnect (networks themselves are immutable).
  async function openNetworkInspect(id) {
    let data, containers = [];
    try { [data, containers] = await Promise.all([API.get(`/networks/${id}`), API.get('/containers').catch(() => [])]); }
    catch (err) { showToast(err.message, 'error'); return; }
    const connected = Object.entries(data.Containers || {}); // [endpointId, { Name, IPv4Address, ... }]
    const connectedNames = new Set(connected.map(([, c]) => c.Name));
    const ipam = (data.IPAM?.Config || [])[0] || {};
    const candidates = (containers || []).filter(c => !connectedNames.has(c.name)).map(c => c.name);
    const canAttach = !['host', 'none'].includes(data.Name);
    const body = `
      <div class="detail-grid" style="grid-template-columns:1fr 1fr">
        <div class="detail-item"><div class="detail-label">Name</div><div class="detail-value">${escapeHtml(data.Name)}</div></div>
        <div class="detail-item"><div class="detail-label">Driver</div><div class="detail-value">${data.Driver}</div></div>
        <div class="detail-item"><div class="detail-label">Scope</div><div class="detail-value">${data.Scope}</div></div>
        <div class="detail-item"><div class="detail-label">Internal</div><div class="detail-value">${data.Internal ? 'Yes' : 'No'}</div></div>
        <div class="detail-item"><div class="detail-label">Subnet</div><div class="detail-value td-mono">${ipam.Subnet || '—'}</div></div>
        <div class="detail-item"><div class="detail-label">Gateway</div><div class="detail-value td-mono">${ipam.Gateway || '—'}</div></div>
      </div>
      <div class="mt-2"><div class="detail-label mb-1">Connected Containers</div>
        ${connected.length ? `<div class="table-wrapper"><table><thead><tr><th>Name</th><th>IPv4</th><th></th></tr></thead><tbody>
          ${connected.map(([, c]) => `<tr><td class="td-mono">${escapeHtml(c.Name)}</td><td class="td-mono">${c.IPv4Address || '—'}</td><td style="text-align:right">${canAttach ? `<button class="btn btn-xs btn-secondary" data-disc="${escapeHtml(c.Name)}">Disconnect</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="text-muted text-sm">No containers connected.</div>'}
      </div>
      ${canAttach ? `<div class="mt-2" style="display:flex;gap:6px;align-items:center">
        <select class="select" id="net-conn-sel" style="flex:1"><option value="">Connect a container…</option>${candidates.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
        <button class="btn btn-sm btn-primary" id="net-conn-btn">Connect</button>
      </div>` : ''}`;
    const m = showModal('Network: ' + escapeHtml(data.Name), body, [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    root.querySelector('#net-conn-btn')?.addEventListener('click', async () => {
      const c = root.querySelector('#net-conn-sel').value;
      if (!c) { showToast('Pick a container', 'warning'); return; }
      try { await API.post(`/networks/${id}/connect`, { container: c }); showToast(`Connected ${c}`); m.close(); render(); openNetworkInspect(id); }
      catch (e) { showToast(e.message, 'error'); }
    });
    root.querySelectorAll('[data-disc]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post(`/networks/${id}/disconnect`, { container: b.dataset.disc, force: true }); showToast(`Disconnected ${b.dataset.disc}`); m.close(); render(); openNetworkInspect(id); }
      catch (e) { showToast(e.message, 'error'); }
    }));
  }

  await render();
  // Auto-refresh (skips while a modal is open or an input is focused) + cleanup on navigation
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
