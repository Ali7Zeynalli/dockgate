// Networks Page
Router.register('networks', async (content) => {
  let selectedIds = new Set();
  let refreshTimer = null;
  const view = Store.view('networks');
  let mode = view.get('mode', 'table'); // table | map

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  let data = null, lastSig = '';
  const f = { q: view.get('q', ''), driver: view.get('driver', ''), unused: view.get('unused', false), sort: view.get('sort', 'name') };

  // Reads the networks and containers. The auto refresh paints again only when something changed, so an open menu
  // or a half typed search is not thrown away every 15 seconds.
  async function load(force = true) {
    try {
      const [networks, ctrs] = await Promise.all([API.get('/networks'), API.get('/containers').catch(() => [])]);
      if (!Router.isActiveNav(pageNavId)) return;
      const sig = JSON.stringify([networks.map(n => [n.id, n.containers, n.services, n.subnet]), ctrs.map(c => [c.name, c.state, c.networks])]);
      if (!force && sig === lastSig) return;
      lastSig = sig; data = { networks, ctrs };
      render();
    } catch (err) { content.innerHTML = `${UI.errorState(err)}`; }
  }

  function render() {
    if (!data) return load(true);
    try {
      const { ctrs } = data;
      const all = data.networks;
      const usedBy = {}, netsOf = {}, ctrOf = {};
      for (const c of ctrs) { ctrOf[c.name] = c; netsOf[c.name] = (c.networks || []).filter(n => !['host', 'none'].includes(n)); for (const n of (c.networks || [])) (usedBy[n] = usedBy[n] || []).push(c.name); }
      const users = (n) => Math.max((usedBy[n.name] || []).length, n.containers || 0) + (n.services || 0);
      const q = f.q.trim().toLowerCase();
      const networks = all.filter(n => (!q || [n.name, n.driver, n.subnet, n.gateway, ...(usedBy[n.name] || [])].some(x => String(x || '').toLowerCase().includes(q)))
        && (!f.driver || n.driver === f.driver) && (!f.unused || n.removable))
        .sort((a, b) => f.sort === 'used' ? users(b) - users(a) || a.name.localeCompare(b.name) : f.sort === 'driver' ? a.driver.localeCompare(b.driver) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
      const drivers = [...new Set(all.map(n => n.driver))].sort();
      const unusedAll = all.filter(n => n.removable);

      // Clean up selectedIds that are no longer visible
      const visibleIds = new Set(networks.map(n => n.id));
      for (const id of selectedIds) {
        if (!visibleIds.has(id)) selectedIds.delete(id);
      }

      // Only user-created, empty networks can be removed/selected
      const removableNetworks = networks.filter(n => n.removable);
      const focused = document.activeElement && document.activeElement.id === 'net-q' ? document.activeElement.selectionStart : null;

      content.innerHTML = `
        ${UI.header('Networks', `${all.length} network${all.length === 1 ? '' : 's'} on this server${networks.length !== all.length ? `, ${networks.length} shown` : ''}. Docker's and Swarm's own networks, and networks with containers or Swarm services, cannot be removed.`,
          `<button class="btn btn-secondary btn-sm" id="net-refresh" title="Refresh">${Icons.refresh}</button>
           <span class="ui-seg"><button type="button" aria-pressed="${mode === 'table'}" data-net-mode="table">Table</button><button type="button" aria-pressed="${mode === 'map'}" data-net-mode="map">Map</button></span>
           <button class="btn btn-primary btn-sm" id="net-new">${Icons.network} Create network</button>`)}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px">
          <input class="input" id="net-q" placeholder="Search name, subnet, container..." value="${escapeHtml(f.q)}" style="flex:1;min-width:200px;max-width:360px">
          <select class="select" id="net-driver" style="width:auto"><option value="">Every driver</option>${drivers.map(d => `<option ${d === f.driver ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
          <select class="select" id="net-sort" style="width:auto"><option value="name" ${f.sort === 'name' ? 'selected' : ''}>Sort: name</option><option value="used" ${f.sort === 'used' ? 'selected' : ''}>Sort: most used</option><option value="driver" ${f.sort === 'driver' ? 'selected' : ''}>Sort: driver</option></select>
          <label class="text-sm" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="net-unused" ${f.unused ? 'checked' : ''}> Unused only</label>
          <span style="flex:1"></span>
          ${unusedAll.length ? `<button class="btn btn-sm btn-secondary" id="net-remove-unused" style="color:var(--danger)">${Icons.trash} Remove unused (${unusedAll.length})...</button>` : ''}
        </div>
        ${mode === 'map' ? mapHtml(networks, usedBy, netsOf, ctrOf) : ''}

        ${selectedIds.size > 0 ? `
        <div class="ui-bulk">
          <b>${selectedIds.size} selected</b>
          <span style="flex:1"></span>
          <button class="btn btn-xs btn-ghost" id="bulk-clear">Clear selection</button>
          <button class="btn btn-xs btn-secondary" id="bulk-remove" style="color:var(--danger)">${Icons.trash} Remove...</button>
        </div>` : ''}

        <div class="table-wrapper" style="${mode === 'map' ? 'display:none' : ''}">
          <table>
            <thead><tr>
              <th style="width:40px"><div class="checkbox ${removableNetworks.length > 0 && selectedIds.size === removableNetworks.length ? 'checked' : ''}" id="select-all"></div></th>
              <th>Name</th><th>Driver</th><th>Subnet</th><th>Gateway</th><th>Used by</th><th style="text-align:right">Actions</th>
            </tr></thead>
            <tbody>
              ${networks.map(n => {
                const canRemove = n.removable;
                return `<tr class="${selectedIds.has(n.id) ? 'selected' : ''}">
                  <td>${canRemove ? `<div class="checkbox ${selectedIds.has(n.id) ? 'checked' : ''}" data-select="${n.id}"></div>` : ''}</td>
                  <td class="td-name"><a href="#" data-open-net="${n.id}">${escapeHtml(n.name)}</a>${n.internal ? ' ' + UI.pill('info', 'internal') : ''}${['bridge', 'host', 'none'].includes(n.name) ? ' <span class="ui-sub">Docker default</span>' : n.builtIn ? ' <span class="ui-sub">made by Swarm</span>' : ''}</td>
                  <td class="text-sm">${escapeHtml(n.driver)}, ${escapeHtml(n.scope)}</td>
                  <td class="td-mono">${n.subnet || '-'}</td>
                  <td class="td-mono">${n.gateway || '-'}</td>
                  <td>${(usedBy[n.name] || []).length ? usedBy[n.name].slice(0, 4).map(x => UI.chip(escapeHtml(x))).join('') + (usedBy[n.name].length > 4 ? ` <span class="text-xs text-muted">+${usedBy[n.name].length - 4}</span>` : '') : n.containers ? UI.chip(String(n.containers)) : ''}${n.services ? ` ${UI.chip(`${n.services} Swarm service${n.services === 1 ? '' : 's'}`)}` : ''}${!(usedBy[n.name] || []).length && !n.containers && !n.services ? '<span class="text-muted">-</span>' : ''}</td>
                  <td><div class="td-actions" style="justify-content:flex-end">
                    ${UI.menu([
                      { label: `${Icons.eye} Open`, attrs: `data-open-net="${n.id}"` },
                      { label: `${Icons.network} Quick view`, attrs: `data-inspect="${n.id}"` },
                      { label: `${Icons.copy} Clone...`, attrs: `data-clone="${n.id}"` },
                      ...(canRemove ? ['-', { label: `${Icons.trash} Remove...`, attrs: `data-remove="${n.id}" data-name="${escapeHtml(n.name)}"`, danger: true }] : []),
                    ])}
                  </div></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('net-refresh')?.addEventListener('click', () => load(true));
      const setF = (k, v) => { f[k] = v; view.set(k, v); render(); };
      const qi = document.getElementById('net-q');
      if (focused !== null) { qi.focus(); try { qi.setSelectionRange(focused, focused); } catch (e) { /* not text */ } }
      qi.addEventListener('input', () => setF('q', qi.value));
      document.getElementById('net-driver').addEventListener('change', (e) => setF('driver', e.target.value));
      document.getElementById('net-sort').addEventListener('change', (e) => setF('sort', e.target.value));
      document.getElementById('net-unused').addEventListener('change', (e) => setF('unused', e.target.checked));
      document.getElementById('net-remove-unused')?.addEventListener('click', () => {
        showDeleteConfirm('Remove unused networks', { message: `Remove ${unusedAll.length} network${unusedAll.length === 1 ? '' : 's'} that nothing uses (no container, running or stopped, and no Swarm service)?<div class="text-xs text-muted" style="margin-top:6px;max-height:160px;overflow:auto">${unusedAll.map(n => escapeHtml(n.name)).join(', ')}</div>`, phrase: 'delete', onConfirm: async () => {
          await bulkRun(unusedAll.map(n => n.id), (id) => API.del(`/networks/${id}`), 'Removed');
          load(true);
        } });
      });
      content.querySelectorAll('[data-net-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.netMode; view.set('mode', mode); render(); }));
      content.querySelectorAll('[data-open-svc]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); Router.navigate('swarm-service', { id: a.dataset.openSvc }); }));
      content.querySelectorAll('[data-map-ctr]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); Router.navigate('container-detail', { id: a.dataset.mapCtr }); }));
      document.getElementById('net-new')?.addEventListener('click', () => openNetworkCreate());

      // Clone - prefill the create form from an existing network's config (N4)
      content.querySelectorAll('[data-clone]').forEach(btn => btn.addEventListener('click', async () => {
        try {
          openNetworkCreate(cloneConfig(await API.get(`/networks/${btn.dataset.clone}`)));
        } catch (e) { showToast(e.message, 'error'); }
      }));

      // Single remove
      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          showDeleteConfirm('Remove Network', { message: `Remove <strong>${btn.dataset.name}</strong>?`, phrase: btn.dataset.name, onConfirm: async () => {
            try { await API.del(`/networks/${btn.dataset.remove}`); showToast('Network removed'); load(true); }
            catch (err) { showToast(err.message, 'error'); }
          } });
        });
      });

      content.querySelectorAll('[data-open-net]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('network-detail', { id: a.dataset.openNet }); }));

      // Inspect (+ live connect/disconnect)
      content.querySelectorAll('[data-inspect]').forEach(btn => {
        btn.addEventListener('click', () => openNetworkInspect(btn.dataset.inspect));
      });

      // Selection - only removable networks can be selected
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
        showDeleteConfirm('Remove Selected Networks', { message: `Remove ${selectedIds.size} network(s)?`, phrase: 'delete', onConfirm: async () => {
          await bulkRun([...selectedIds], (id) => API.del(`/networks/${id}`), 'Removed');
          selectedIds.clear();
          load(true);
        } });
      });

    } catch (err) { content.innerHTML = `${UI.errorState(err)}`; }
  }
  // Map: each network with the containers on it, grouped by compose project. A container on more than one network
  // is marked with the others: that is where traffic can cross between networks (and between projects).
  function mapHtml(networks, usedBy, netsOf, ctrOf) {
    const esc = (x) => escapeHtml(String(x == null ? '' : x));
    const list = networks.filter(n => !['host', 'none', 'ingress', 'docker_gwbridge'].includes(n.name) && ((usedBy[n.name] || []).length || !n.builtIn))
      .sort((a, b) => (usedBy[b.name] || []).length - (usedBy[a.name] || []).length);
    if (!list.length) return '<div class="ui-sub" style="margin:8px 0">No networks with containers.</div>';
    const MESH = ['ingress', 'docker_gwbridge'];
    const chip = (label, href, state, others, extra = '') => `<a href="#" ${href} class="chip" title="${others.length ? `also on ${esc(others.join(', '))}` : ''}" style="text-decoration:none;${others.length ? 'border-color:var(--warning)' : ''}"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;background:${state === 'running' ? 'var(--success)' : 'var(--text-muted)'}"></span>${esc(label)}${extra}${others.length ? ` <span style="color:var(--warning);font-size:10.5px">+${others.map(esc).join(', +')}</span>` : ''}</a>`;
    const card = (n) => {
      const members = usedBy[n.name] || [];
      const groups = {};
      let stopped = 0;
      for (const m of members) {
        const c = ctrOf[m] || {};
        if (c.state !== 'running') { stopped++; continue; }
        const svc = c.labels && c.labels['com.docker.swarm.service.name'];
        const g = svc ? `Swarm${c.labels['com.docker.stack.namespace'] ? `: ${c.labels['com.docker.stack.namespace']}` : ''}` : (c.composeProject || '');
        const others = (netsOf[m] || []).filter(x => x !== n.name && !MESH.includes(x));
        const list = groups[g] = groups[g] || [];
        if (svc) { const ex = list.find(x => x.svc === svc); if (ex) { ex.count++; continue; } list.push({ svc, label: svc, count: 1, others, href: `data-open-svc="${esc(svc)}"`, state: 'running' }); }
        else list.push({ label: m, others, href: `data-map-ctr="${esc(c.id || m)}"`, state: c.state });
      }
      const projects = Object.keys(groups).filter(g => g && !g.startsWith('Swarm'));
      return `<div class="card" style="padding:10px 12px;cursor:pointer" data-open-net="${n.id}">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><b>${esc(n.name)}</b><span class="ui-sub">${esc(n.driver)}${n.subnet ? `, ${esc(n.subnet)}` : ''}</span>${n.internal ? UI.pill('info', 'internal') : ''}${projects.length > 1 ? UI.pill('warn', `${projects.length} projects`) : ''}</div>
        ${Object.entries(groups).sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1)).map(([g, items]) => `<div style="margin-top:8px"><div class="ui-sub" style="font-size:11px">${g ? esc(g) : 'no compose project'}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">${items.map(x => chip(x.label, x.href, x.state, x.others, x.svc ? ` <span class="ui-sub" style="font-size:10.5px">${x.count} task${x.count === 1 ? '' : 's'}</span>` : '')).join('')}</div></div>`).join('')}
        ${stopped ? `<div class="ui-sub" style="margin-top:6px;font-size:11px">${stopped} stopped container${stopped === 1 ? '' : 's'} keep a place here.</div>` : ''}
        ${!members.length ? '<div class="ui-sub" style="margin-top:6px">No containers. It can be removed.</div>' : ''}
      </div>`;
    };
    return `<div class="ui-sub" style="margin:2px 0 8px">Running containers, grouped by compose project (Swarm tasks by service). Those marked <span style="color:var(--warning)">+name</span> are on other networks too: traffic can cross there. Swarm\'s ingress is left out. Open a network to compare it with its compose files.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-bottom:12px">${list.map(card).join('')}</div>`;
  }

  // Suggest a free private subnet (+ gateway + IP range) avoiding the ones already in use: Docker's networks and the
  // server's own networks and routes outside Docker. `extra` lets Suggest advance past the current value.
  function suggestSubnet(used, extra = []) {
    const taken = new Set([...used, ...extra].filter(Boolean).filter(x => !x.includes(':')).flatMap(x => {
      const [b, len] = x.split('/'); const p = b.split('.').map(Number);
      // a /8 or /12 takes every /16 inside it
      if (Number(len) <= 12 && p[0] === 172) return Array.from({ length: 16 }, (_, i) => `172.${(p[1] & 0xf0) + i}`);
      if (Number(len) <= 8) return Array.from({ length: 256 }, (_, i) => `${p[0]}.${i}`);
      return [`${p[0]}.${p[1]}`];
    }));
    const make = (b) => ({ subnet: `${b}.0.0/16`, gateway: `${b}.0.1`, iprange: '' });
    for (let i = 18; i <= 31; i++) { const b = `172.${i}`; if (!taken.has(b)) return make(b); }
    for (let i = 20; i <= 250; i++) { const b = `10.${i}`; if (!taken.has(b)) return make(b); }
    return { subnet: '', gateway: '', iprange: '' };
  }
  const randomUla = () => { const h = () => Math.floor(Math.random() * 65536).toString(16); return `fd${Math.floor(Math.random() * 256).toString(16).padStart(2, '0')}:${h()}:${h()}::/64`; };
  const OPT = { mtu: 'com.docker.network.driver.mtu', bridge: 'com.docker.network.bridge.name', icc: 'com.docker.network.bridge.enable_icc', masq: 'com.docker.network.bridge.enable_ip_masquerade' };
  const COMPOSE_LABEL = /^com\.docker\.(compose|stack)\./;

  // Create form, also used by Clone with a prefilled config (every subnet, options and labels are copied).
  async function openNetworkCreate(prefill = {}) {
    const drivers = ['bridge', 'macvlan', 'ipvlan', 'overlay'];
    let used = [];
    try { used = (await API.get('/networks').catch(() => [])).flatMap(n => ((n.ipam && n.ipam.Config) || []).map(x => x.Subnet)).filter(Boolean); } catch (e) { /* none */ }
    let host = null;
    const hostP = API.get('/networks/host-info').then(h => { host = h; return h; }).catch(() => null);
    const hostUsed = () => host ? [...host.interfaces.filter(i => !i.docker && i.name !== 'lo').flatMap(i => i.addrs), ...host.routes.filter(r => !r.docker).map(r => r.dst)] : [];
    await Promise.race([hostP, new Promise(r => setTimeout(r, 2500))]);
    const sug = suggestSubnet([...used, ...hostUsed()]); // a clone's copied subnet would conflict, so always offer a fresh one
    const v4 = prefill._clone || !prefill.subnet ? sug : { subnet: prefill.subnet, gateway: prefill.gateway || '', iprange: prefill.iprange || '' };
    const o = prefill.options || {};
    const chk = (id, label, on, hint = '') => `<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}${hint ? ` <span class="ui-sub">${hint}</span>` : ''}</label>`;
    const body = `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label for="nc-name">Name *</label><input class="input" id="nc-name" value="${escapeHtml(prefill.name || '')}"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:140px"><label>Driver</label><select class="select" id="nc-driver">${drivers.map(d => `<option value="${d}" ${d === (prefill.driver || 'bridge') ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="input-group" style="flex:1;min-width:140px" data-for="lan"><label>Parent interface *</label><select class="select" id="nc-parent"><option value="">Reading the server...</option></select></div>
        <div class="input-group" style="flex:1;min-width:120px" data-for="ipvlan"><label>Mode</label><select class="select" id="nc-ipvlan-mode"><option value="l2" ${o.ipvlan_mode !== 'l3' ? 'selected' : ''}>l2</option><option value="l3" ${o.ipvlan_mode === 'l3' ? 'selected' : ''}>l3</option></select></div>
      </div>
      <div class="text-xs text-muted" data-for="lan">The containers get addresses on this interface's network, like other machines there. Use that network's subnet and gateway (your router), and an IP range outside what its DHCP hands out.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:140px"><label style="display:flex;justify-content:space-between;align-items:center">Subnet <button type="button" id="nc-suggest" class="btn btn-xs btn-ghost" style="font-weight:400">Suggest</button></label><input class="input" id="nc-subnet" placeholder="172.20.0.0/16" value="${escapeHtml(v4.subnet)}"></div>
        <div class="input-group" style="flex:1;min-width:120px"><label>Gateway</label><input class="input" id="nc-gateway" placeholder="172.20.0.1" value="${escapeHtml(v4.gateway)}"></div>
        <div class="input-group" style="flex:1;min-width:120px"><label>IP range (optional)</label><input class="input" id="nc-iprange" value="${escapeHtml(v4.iprange)}"></div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${chk('nc-internal', 'Internal', prefill.internal)}
        ${chk('nc-attachable', 'Attachable', prefill.attachable)}
        ${chk('nc-ipv6', 'IPv6', prefill.ipv6)}
      </div>
      <div style="display:${prefill.ipv6 ? 'flex' : 'none'};gap:10px;flex-wrap:wrap" id="nc-v6">
        <div class="input-group" style="flex:2;min-width:180px"><label>IPv6 subnet</label><input class="input td-mono" id="nc-subnet6" placeholder="fd12:3456:789a::/64" value="${escapeHtml(prefill.subnet6 || (prefill.ipv6 ? randomUla() : ''))}"></div>
        <div class="input-group" style="flex:1;min-width:140px"><label>IPv6 gateway (optional)</label><input class="input td-mono" id="nc-gateway6" value="${escapeHtml(prefill.gateway6 || '')}"></div>
      </div>
      <div data-conflicts></div>
      <div id="nc-overlay-note" class="text-xs text-muted" style="display:none">An <strong>overlay</strong> network spans multiple Docker hosts. Keep <strong>Attachable</strong> on if standalone containers should also use it.</div>
      <details ${o[OPT.mtu] || o[OPT.bridge] || o[OPT.icc] === 'false' || o[OPT.masq] === 'false' || Object.keys(prefill.labels || {}).length ? 'open' : ''}><summary style="cursor:pointer" class="text-sm"><b>More settings</b> <span class="ui-sub">MTU, bridge name, traffic between containers, NAT, labels</span></summary>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="input-group" style="flex:1;min-width:120px"><label>MTU</label><input class="input" id="nc-mtu" type="number" min="576" max="9000" placeholder="default (1500)" value="${escapeHtml(o[OPT.mtu] || '')}"></div>
            <div class="input-group" style="flex:1;min-width:140px" data-for="bridge"><label>Bridge name on the server</label><input class="input td-mono" id="nc-bridge" maxlength="15" placeholder="br-... (automatic)" value="${escapeHtml(o[OPT.bridge] || '')}"></div>
          </div>
          <div class="text-xs text-muted">A lower MTU (for example 1450) helps when the server is behind a VPN or a tunnel and large packets hang.</div>
          <div style="display:flex;gap:16px;flex-wrap:wrap" data-for="bridge">
            ${chk('nc-icc', 'Containers can talk to each other', o[OPT.icc] !== 'false', '(off: only through published ports)')}
            ${chk('nc-masq', 'Outgoing NAT', o[OPT.masq] !== 'false', '(off: containers leave with their own address)')}
          </div>
          <div class="input-group"><label>Labels <span class="ui-sub">one per line, key=value</span></label><textarea class="input td-mono" id="nc-labels" rows="2" placeholder="team=web">${escapeHtml(Object.entries(prefill.labels || {}).filter(([k]) => !COMPOSE_LABEL.test(k)).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea></div>
        </div>
      </details>
      ${prefill._clone ? '<div class="text-xs text-muted">Cloning copies the settings. A new free subnet is filled in, so the two do not overlap.</div>' : ''}
    </div>`;
    const m = showModal(prefill._clone ? 'Clone Network' : 'New Network', body, []);
    const root = m.overlay;
    const $ = (sel) => root.querySelector(sel);
    const driverSel = $('#nc-driver');
    const sync = () => {
      const d = driverSel.value, lan = d === 'macvlan' || d === 'ipvlan';
      root.querySelectorAll('[data-for="lan"]').forEach(el => { el.style.display = lan ? '' : 'none'; });
      root.querySelectorAll('[data-for="ipvlan"]').forEach(el => { el.style.display = d === 'ipvlan' ? '' : 'none'; });
      root.querySelectorAll('[data-for="bridge"]').forEach(el => { el.style.display = d === 'bridge' ? '' : 'none'; });
      $('#nc-overlay-note').style.display = d === 'overlay' ? 'block' : 'none';
      if (d === 'overlay' && !$('#nc-attachable').checked) $('#nc-attachable').checked = true;
      if (lan && !prefill.subnet && $('#nc-subnet').value === sug.subnet) { $('#nc-subnet').value = ''; $('#nc-gateway').value = ''; }
      check();
    };
    // the parent interfaces: the server's own, not Docker's
    hostP.then(h => {
      const sel = $('#nc-parent'); if (!sel) return;
      const ifs = h ? h.interfaces.filter(i => !i.docker && i.name !== 'lo') : [];
      sel.innerHTML = `<option value="">Pick an interface</option>${ifs.map(i => `<option value="${escapeHtml(i.name)}" ${o.parent === i.name ? 'selected' : ''}>${escapeHtml(i.name)} ${escapeHtml(i.addrs.filter(a => !a.includes(':')).join(', '))}</option>`).join('')}${o.parent && !ifs.some(i => i.name === o.parent) ? `<option selected>${escapeHtml(o.parent)}</option>` : ''}`;
      if (!h) sel.insertAdjacentHTML('afterend', '<input class="input td-mono" id="nc-parent-text" placeholder="eth0" style="margin-top:4px"><div class="text-xs text-muted">The server\'s interfaces could not be read: type the name.</div>');
    });
    // what the subnets would clash with
    let ct = null, conflicts = [];
    const check = () => {
      clearTimeout(ct);
      ct = setTimeout(async () => {
        const subs = [$('#nc-subnet').value.trim(), $('#nc-ipv6').checked ? $('#nc-subnet6').value.trim() : ''].filter(Boolean);
        const box = root.querySelector('[data-conflicts]');
        if (!subs.length) { box.innerHTML = ''; conflicts = []; return; }
        try {
          const r = await API.post('/networks/check-subnet', { subnets: subs });
          conflicts = r.conflicts;
          // a macvlan network shares the parent's network on purpose
          if (['macvlan', 'ipvlan'].includes(driverSel.value)) conflicts = conflicts.filter(c => c.kind !== 'host' && c.kind !== 'route');
          box.innerHTML = conflicts.length ? `<div class="insight-card ${conflicts.some(c => c.kind === 'docker' || c.kind === 'invalid') ? 'danger' : 'warning'}" style="display:block">${conflicts.map(c => `<div>${escapeHtml(c.text)}</div>`).join('')}
            ${conflicts.some(c => c.kind === 'host' || c.kind === 'route') && !conflicts.some(c => c.kind === 'docker' || c.kind === 'invalid') ? `<label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-weight:400"><input type="checkbox" id="nc-anyway"> Create it anyway</label>` : ''}</div>`
            : (r.hostRead ? '<div class="text-xs" style="color:var(--success)">Free: no Docker network, server network or route uses it.</div>' : '<div class="text-xs text-muted">Free among Docker networks. The server\'s own networks could not be read.</div>');
        } catch (e) { box.innerHTML = ''; conflicts = []; }
      }, 350);
    };
    ['#nc-subnet', '#nc-subnet6'].forEach(id => $(id).addEventListener('input', check));
    $('#nc-ipv6').addEventListener('change', () => { $('#nc-v6').style.display = $('#nc-ipv6').checked ? 'flex' : 'none'; if ($('#nc-ipv6').checked && !$('#nc-subnet6').value) $('#nc-subnet6').value = randomUla(); check(); });
    driverSel.addEventListener('change', sync);
    sync();
    $('#nc-suggest').addEventListener('click', () => {
      const s2 = suggestSubnet([...used, ...hostUsed()], [$('#nc-subnet').value.trim()]);
      if (!s2.subnet) { showToast('No free subnet found', 'warning'); return; }
      $('#nc-subnet').value = s2.subnet; $('#nc-gateway').value = s2.gateway; $('#nc-iprange').value = '';
      check();
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary'; btn.textContent = 'Create';
    $('#modal-footer').appendChild(btn);
    btn.addEventListener('click', async () => {
      const name = $('#nc-name').value.trim();
      if (!name) { showToast('Name required', 'warning'); return; }
      const d = driverSel.value;
      if (conflicts.some(c => c.kind === 'docker' || c.kind === 'invalid')) { showToast('Change the subnet first (see the warning)', 'warning'); return; }
      if (conflicts.some(c => c.kind === 'host' || c.kind === 'route') && !($('#nc-anyway') || {}).checked) { showToast('The subnet clashes with a network of the server: change it, or tick "Create it anyway"', 'warning', 7000); return; }
      const config = { Name: name, Driver: d, Internal: $('#nc-internal').checked, Attachable: $('#nc-attachable').checked, EnableIPv6: $('#nc-ipv6').checked, Options: {}, Labels: {} };
      if (d === 'macvlan' || d === 'ipvlan') {
        const parent = ($('#nc-parent-text') && $('#nc-parent-text').value.trim()) || $('#nc-parent').value;
        if (!parent) { showToast('Pick the parent interface', 'warning'); return; }
        config.Options.parent = parent;
        if (d === 'ipvlan') config.Options.ipvlan_mode = $('#nc-ipvlan-mode').value;
      }
      const mtu = $('#nc-mtu').value.trim(); if (mtu) config.Options[OPT.mtu] = String(Number(mtu));
      if (d === 'bridge') {
        const br = $('#nc-bridge').value.trim(); if (br) config.Options[OPT.bridge] = br;
        if (!$('#nc-icc').checked) config.Options[OPT.icc] = 'false';
        if (!$('#nc-masq').checked) config.Options[OPT.masq] = 'false';
      }
      for (const line of $('#nc-labels').value.split('\n')) { const i = line.indexOf('='); if (i > 0) config.Labels[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      const ipam = [];
      const subnet = $('#nc-subnet').value.trim();
      if (subnet) { const c = { Subnet: subnet }; const gw = $('#nc-gateway').value.trim(); if (gw) c.Gateway = gw; const ipr = $('#nc-iprange').value.trim(); if (ipr) c.IPRange = ipr; ipam.push(c); }
      if (config.EnableIPv6) { const s6 = $('#nc-subnet6').value.trim(); if (s6) { const c = { Subnet: s6 }; const g6 = $('#nc-gateway6').value.trim(); if (g6) c.Gateway = g6; ipam.push(c); } }
      if (ipam.length) config.IPAM = { Config: ipam };
      btn.disabled = true; btn.textContent = 'Creating...';
      try { await API.post('/networks', config); showToast(`Network "${name}" created`); m.close(); load(true); }
      catch (e) { showToast(e.message, 'error', 9000); btn.disabled = false; btn.textContent = 'Create'; }
    });
  }

  // Clone: every subnet (IPv4 and IPv6), options and labels of the source; a new IPv4 subnet is suggested.
  function cloneConfig(d) {
    const cfg = (d.IPAM && d.IPAM.Config) || [];
    const v4 = cfg.find(x => x.Subnet && !x.Subnet.includes(':')) || {};
    const v6 = cfg.find(x => x.Subnet && x.Subnet.includes(':')) || {};
    const opts = { ...(d.Options || {}) }; delete opts[OPT.bridge]; // the bridge name must be new
    return { name: d.Name + '-clone', driver: d.Driver, subnet: v4.Subnet || '', gateway: v4.Gateway || '', iprange: v4.IPRange || '', internal: d.Internal, attachable: d.Attachable, ipv6: d.EnableIPv6, subnet6: v6.Subnet ? randomUla() : '', options: opts, labels: d.Labels || {}, _clone: true };
  }

  // Disconnect: a normal disconnect first; when Docker refuses (the container is gone or stuck), offer to force it.
  async function disconnect(id, container, done) {
    try { await API.post(`/networks/${id}/disconnect`, { container }); showToast(`Disconnected ${container}`); done(); }
    catch (e) {
      showConfirm('Disconnect anyway?', `Docker did not disconnect <b>${escapeHtml(container)}</b>: ${escapeHtml(e.message)}<br><br>Force it? Its place on the network is removed even if the container does not answer.`, async () => {
        try { await API.post(`/networks/${id}/disconnect`, { container, force: true }); showToast(`Disconnected ${container}`); done(); }
        catch (e2) { showToast(e2.message, 'error'); }
      }, true);
    }
  }

  // Quick view: settings, every subnet, the connected containers; connect and disconnect.
  async function openNetworkInspect(id) {
    let data, containers = [];
    try { [data, containers] = await Promise.all([API.get(`/networks/${id}`), API.get('/containers').catch(() => [])]); }
    catch (err) { showToast(err.message, 'error'); return; }
    const connected = Object.entries(data.Containers || {}); // [endpointId, { Name, IPv4Address, ... }]
    const connectedNames = new Set(connected.map(([, c]) => c.Name));
    const cfg = (data.IPAM && data.IPAM.Config) || [];
    const candidates = (containers || []).filter(c => !connectedNames.has(c.name)).map(c => c.name);
    const canAttach = !['host', 'none'].includes(data.Name);
    const body = `
      <div class="detail-grid" style="grid-template-columns:1fr 1fr">
        <div class="detail-item"><div class="detail-label">Name</div><div class="detail-value">${escapeHtml(data.Name)}</div></div>
        <div class="detail-item"><div class="detail-label">Driver</div><div class="detail-value">${escapeHtml(data.Driver)}, ${escapeHtml(data.Scope)}</div></div>
        <div class="detail-item"><div class="detail-label">Internal</div><div class="detail-value">${data.Internal ? 'Yes' : 'No'}</div></div>
        <div class="detail-item"><div class="detail-label">IPv6</div><div class="detail-value">${data.EnableIPv6 ? 'Yes' : 'No'}</div></div>
        <div class="detail-item"><div class="detail-label">Subnet</div><div class="detail-value td-mono">${cfg.map(x => escapeHtml(x.Subnet || '')).filter(Boolean).join('<br>') || '-'}</div></div>
        <div class="detail-item"><div class="detail-label">Gateway</div><div class="detail-value td-mono">${cfg.map(x => escapeHtml(x.Gateway || '-')).join('<br>') || '-'}</div></div>
      </div>
      <div class="mt-2"><div class="detail-label mb-1">Connected containers</div>
        ${connected.length ? `<div class="table-wrapper"><table><thead><tr><th>Name</th><th>Address</th><th></th></tr></thead><tbody>
          ${connected.map(([, c]) => `<tr><td class="td-mono">${escapeHtml(c.Name)}</td><td class="td-mono">${escapeHtml(c.IPv4Address || '-')}${c.IPv6Address ? `<br><span class="ui-sub">${escapeHtml(c.IPv6Address)}</span>` : ''}</td><td style="text-align:right">${canAttach ? `<button class="btn btn-xs btn-secondary" data-disc="${escapeHtml(c.Name)}">Disconnect</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="text-muted text-sm">No containers connected.</div>'}
      </div>
      ${canAttach ? `<div class="mt-2" style="display:flex;gap:6px;align-items:center">
        <select class="select" id="net-conn-sel" style="flex:1"><option value="">Connect a container...</option>${candidates.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
        <button class="btn btn-sm btn-primary" id="net-conn-btn">Connect</button>
      </div>` : ''}`;
    const m = showModal('Network: ' + escapeHtml(data.Name), body, [{ label: 'Open the page', className: 'btn btn-secondary', onClick: () => Router.navigate('network-detail', { id }) }, { label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    const again = () => { m.close(); load(true); openNetworkInspect(id); };
    root.querySelector('#net-conn-btn')?.addEventListener('click', async () => {
      const c = root.querySelector('#net-conn-sel').value;
      if (!c) { showToast('Pick a container', 'warning'); return; }
      try { await API.post(`/networks/${id}/connect`, { container: c }); showToast(`Connected ${c}`); again(); }
      catch (e) { showToast(e.message, 'error'); }
    });
    root.querySelectorAll('[data-disc]').forEach(b => b.addEventListener('click', () => disconnect(id, b.dataset.disc, again)));
  }

  await load(true);
  // Auto-refresh (skips while a modal is open or an input is focused) + cleanup on navigation
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) load(false); }, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
