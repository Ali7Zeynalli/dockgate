// Containers Page
Router.register('containers', async (content) => {
  let currentFilter = 'all';
  let currentSearch = '';
  let currentSort = 'name';
  let currentView = 'table';
  let selectedIds = new Set();
  let refreshTimer = null;
  let groupByProject = Store.get('groupByProject') ?? true; // Default to grouping

  // Capture navId at registration time to detect stale renders
  // Qeydiyyat zamanı navId-ni saxla ki, köhnə renderləri aşkar edək
  const pageNavId = Router._navId;

  async function render() {
    try {
      // Use already fetched data for counts — avoid duplicate API call
      // Artıq çəkilmiş datadan istifadə et — təkrar API çağırışından qaç
      const allContainers = await API.get('/containers');
      if (!Router.isActiveNav(pageNavId)) return;

      // Filter
      let containers = [...allContainers];
      if (currentFilter !== 'all') {
        containers = containers.filter(c => {
          if (currentFilter === 'running') return c.state === 'running';
          if (currentFilter === 'stopped') return c.state === 'exited';
          if (currentFilter === 'restarting') return c.state === 'restarting';
          if (currentFilter === 'paused') return c.state === 'paused';
          return true;
        });
      }

      // Search
      if (currentSearch) {
        const q = currentSearch.toLowerCase();
        containers = containers.filter(c =>
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          c.shortId.toLowerCase().includes(q) ||
          c.ports.some(p => String(p.PublicPort).includes(q))
        );
      }

      // Sort
      containers.sort((a, b) => {
        if (currentSort === 'name') return a.name.localeCompare(b.name);
        if (currentSort === 'status') return a.state.localeCompare(b.state);
        if (currentSort === 'created') return b.created - a.created;
        if (currentSort === 'image') return a.image.localeCompare(b.image);
        return 0;
      });

      const counts = {
        all: allContainers.length,
        running: allContainers.filter(c => c.state === 'running').length,
        stopped: allContainers.filter(c => c.state === 'exited').length,
      };

      content.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">Containers</div>
            <div class="page-subtitle">${containers.length} container(s)</div>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" id="run-container-btn">${Icons.play} Run Container</button>
            <button class="btn btn-ghost ${currentView === 'table' ? 'active' : ''}" id="view-table" title="Table View">${Icons.layers}</button>
            <button class="btn btn-ghost ${currentView === 'card' ? 'active' : ''}" id="view-card" title="Card View">${Icons.dashboard}</button>
            <button class="btn btn-ghost ${currentView === 'topology' ? 'active' : ''}" id="view-topology" title="Topology View (read-only)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="6" r="2.3"/><circle cx="19" cy="6" r="2.3"/><circle cx="12" cy="18" r="2.3"/><path d="M7 7.4 10.6 15.8M17 7.4 13.4 15.8M7.3 6h9.4"/></svg></button>
            <button class="btn btn-secondary" id="containers-refresh">${Icons.refresh}</button>
          </div>
        </div>

        <div class="filter-bar">
          <button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">All (${counts.all})</button>
          <button class="filter-btn ${currentFilter === 'running' ? 'active' : ''}" data-filter="running">Running</button>
          <button class="filter-btn ${currentFilter === 'stopped' ? 'active' : ''}" data-filter="stopped">Stopped</button>
          <button class="filter-btn ${currentFilter === 'restarting' ? 'active' : ''}" data-filter="restarting">Restarting</button>
          <button class="filter-btn ${currentFilter === 'paused' ? 'active' : ''}" data-filter="paused">Paused</button>
          <div style="flex:1"></div>
          
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-right:12px;" class="text-sm text-muted">
            <input type="checkbox" id="group-toggle" ${groupByProject ? 'checked' : ''} style="width:14px;height:14px">
            Group by Compose
          </label>

          <div class="search-input">
            <span class="nav-item-icon">${Icons.search}</span>
            <input type="text" placeholder="Search containers..." value="${escapeHtml(currentSearch)}" id="container-search">
          </div>
          <select class="select" id="container-sort">
            <option value="name" ${currentSort === 'name' ? 'selected' : ''}>Sort: Name</option>
            <option value="status" ${currentSort === 'status' ? 'selected' : ''}>Sort: Status</option>
            <option value="created" ${currentSort === 'created' ? 'selected' : ''}>Sort: Newest</option>
            <option value="image" ${currentSort === 'image' ? 'selected' : ''}>Sort: Image</option>
          </select>
        </div>

        ${selectedIds.size > 0 ? `
        <div class="card mb-2" style="padding:12px 18px;display:flex;align-items:center;gap:12px;background:var(--accent-dim)">
          <span class="text-sm font-bold">${selectedIds.size} selected</span>
          <button class="btn btn-sm btn-secondary" id="bulk-start">${Icons.play} Start</button>
          <button class="btn btn-sm btn-secondary" id="bulk-stop">${Icons.stop} Stop</button>
          <button class="btn btn-sm btn-secondary" id="bulk-restart">${Icons.restart} Restart</button>
          <button class="btn btn-sm btn-danger" id="bulk-remove">${Icons.trash} Remove</button>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-ghost" id="bulk-clear">Clear</button>
        </div>` : ''}

        <div id="containers-content">
          ${currentView === 'table' ? renderTable(containers)
            : currentView === 'topology' ? renderTopology(containers)
            : renderCards(containers)}
        </div>
      `;

      bindEvents(containers);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function getGroupedContainers(containers) {
    if (!groupByProject) return { '': containers }; // Single group
    const groups = {};
    containers.forEach(c => {
      const key = c.composeProject || '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });
    return groups;
  }

  function getSortedGroupKeys(groups) {
    return Object.keys(groups).sort((a,b) => {
      if (a === '' && b !== '') return 1; // standalone at bottom
      if (b === '' && a !== '') return -1;
      return a.localeCompare(b);
    });
  }

  function renderTableRows(list) {
    return list.map(c => `
      <tr class="${selectedIds.has(c.id) ? 'selected' : ''}" data-id="${c.id}">
        <td><div class="checkbox ${selectedIds.has(c.id) ? 'checked' : ''}" data-select="${c.id}"></div></td>
        <td>
          <div class="td-name" data-detail="${c.id}">
            ${c.isFavorite ? '<span style="color:var(--warning);margin-right:4px">★</span>' : ''}
            ${escapeHtml(c.name)}
          </div>
          <div class="td-mono text-xs" style="margin-top:2px">${c.shortId}</div>
        </td>
        <td><span class="td-mono">${escapeHtml(c.image)}</span></td>
        <td><span class="badge badge-${c.state}"><span class="badge-dot"></span> ${c.state}</span></td>
        <td class="text-sm">
          ${[...new Map(c.ports.filter(p => p.PublicPort).map(p => [`${p.PublicPort}:${p.PrivatePort}`, p])).values()].map(p =>
            `<a href="${dockerHostUrl(p.PublicPort)}" target="_blank" style="margin-right:6px">${p.PublicPort}→${p.PrivatePort}</a>`
          ).join('') || '<span class="text-muted">—</span>'}
        </td>
        <td class="text-muted text-sm">${timeAgo(c.created)}</td>
        <td>
          <div class="td-actions">
            ${c.state === 'running' ? `
              <button class="btn-icon" title="Stop" data-action="stop" data-id="${c.id}">${Icons.stop}</button>
              <button class="btn-icon" title="Restart" data-action="restart" data-id="${c.id}">${Icons.restart}</button>
            ` : `
              <button class="btn-icon" title="Start" data-action="start" data-id="${c.id}">${Icons.play}</button>
            `}
            <button class="btn-icon" title="Logs" data-action="logs" data-id="${c.id}">${Icons.logs}</button>
            ${c.state === 'running' ? `<button class="btn-icon" title="Terminal" data-action="terminal" data-id="${c.id}">${Icons.terminal}</button>` : ''}
            <button class="btn-icon" title="Inspect" data-detail="${c.id}">${Icons.eye}</button>
            <button class="btn-icon" title="Remove" data-action="remove" data-id="${c.id}" style="color:var(--danger)">${Icons.trash}</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderTable(containers) {
    if (containers.length === 0) return '<div class="empty-state"><span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">' + Icons.container + '</span><h3>No containers</h3><p>No containers match your filter criteria</p></div>';

    let tbody = '';
    const groups = getGroupedContainers(containers);
    const keys = getSortedGroupKeys(groups);

    if (groupByProject && keys.length > 1) {
      for (const k of keys) {
        const groupSelected = groups[k].every(c => selectedIds.has(c.id));
        tbody += `<tr><td colspan="7" style="background:var(--bg-lighter);font-weight:600;padding:12px;font-size:13px;border-top:2px solid var(--border)">
          <div style="display:flex;align-items:center;gap:12px">
            <div class="checkbox ${groupSelected ? 'checked' : ''}" data-group-select="${escapeHtml(k)}"></div>
            <div>
              ${k ? `📦 Compose Project: <span class="text-accent">${escapeHtml(k)}</span>` : `🔸 Standalone Containers`}
              <span class="badge badge-created" style="margin-left:8px;font-size:11px">${groups[k].length}</span>
            </div>
          </div>
        </td></tr>`;
        tbody += renderTableRows(groups[k]);
      }
    } else {
      tbody = renderTableRows(containers);
    }

    return `
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th style="width:40px"><div class="checkbox ${selectedIds.size === containers.length ? 'checked' : ''}" id="select-all"></div></th>
              <th>Name</th>
              <th>Image</th>
              <th>Status</th>
              <th>Ports</th>
              <th>Created</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${tbody}
          </tbody>
        </table>
      </div>`;
  }

  function renderCardItems(list) {
    return list.map(c => `
      <div class="container-card" data-detail="${c.id}">
        <div class="container-card-header">
          <span class="container-card-name">${escapeHtml(c.name)}</span>
          <span class="badge badge-${c.state}"><span class="badge-dot"></span> ${c.state}</span>
        </div>
        <div class="container-card-image">${escapeHtml(c.image)}</div>
        <div class="container-card-meta">
          <span class="td-mono">${c.shortId}</span>
          <span>${timeAgo(c.created)}</span>
          ${[...new Map(c.ports.filter(p => p.PublicPort).map(p => [`${p.PublicPort}:${p.PrivatePort}`, p])).values()].map(p => `<a href="${dockerHostUrl(p.PublicPort)}" target="_blank" onclick="event.stopPropagation()">:${p.PublicPort}</a>`).join('')}
        </div>
        <div class="container-card-actions" onclick="event.stopPropagation()">
          ${c.state === 'running' ? `
            <button class="btn btn-xs btn-secondary" data-action="stop" data-id="${c.id}">${Icons.stop} Stop</button>
            <button class="btn btn-xs btn-secondary" data-action="restart" data-id="${c.id}">${Icons.restart} Restart</button>
          ` : `
            <button class="btn btn-xs btn-primary" data-action="start" data-id="${c.id}">${Icons.play} Start</button>
          `}
          <button class="btn btn-xs btn-secondary" data-action="logs" data-id="${c.id}">${Icons.logs} Logs</button>
          <div style="flex:1"></div>
          <button class="btn btn-xs btn-ghost" data-action="remove" data-id="${c.id}" style="color:var(--danger)">${Icons.trash}</button>
        </div>
      </div>
    `).join('');
  }

  function renderCards(containers) {
    if (containers.length === 0) return '<div class="empty-state"><h3>No containers</h3></div>';

    let html = '';
    const groups = getGroupedContainers(containers);
    const keys = getSortedGroupKeys(groups);

    if (groupByProject && keys.length > 1) {
      for (const k of keys) {
        html += `
          <div style="font-weight:600;font-size:14px;margin:24px 0 12px 0;border-bottom:1px solid var(--border);padding-bottom:6px">
             ${k ? `📦 Compose Project: <span class="text-accent">${escapeHtml(k)}</span>` : `🔸 Standalone Containers`}
             <span class="badge badge-created" style="margin-left:8px">${groups[k].length}</span>
          </div>
          <div class="container-grid">
            ${renderCardItems(groups[k])}
          </div>
        `;
      }
    } else {
      html = `<div class="container-grid">${renderCardItems(containers)}</div>`;
    }

    return html;
  }

  // ---- Topology view (read-only) ----------------------------------------
  // A live, read-only graph of the running containers: nodes are containers
  // (grouped by Compose project), edges come from `depends_on` labels (falling
  // back to shared custom networks), published ports are flagged public. No
  // backend call beyond the container list already fetched; nothing is mutated.
  function ensureTopoStyles() {
    if (document.getElementById('dg-topo-css')) return;
    const s = document.createElement('style');
    s.id = 'dg-topo-css';
    s.textContent = `
      .topo-legend{display:flex;align-items:center;gap:14px;padding:10px 4px;flex-wrap:wrap}
      .topo-leg{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text-secondary)}
      .topo-scroll{overflow:auto;max-height:calc(100vh - 268px);border:1px solid var(--border);border-radius:12px;background:var(--bg-secondary)}
      .topo-canvas{position:relative;min-width:100%}
      .topo-svg{position:absolute;inset:0;pointer-events:none}
      .topo-edge{fill:none;stroke:var(--border-hover);stroke-width:1.6}
      .topo-edge.pub{stroke:var(--success);stroke-dasharray:4 3;stroke-width:2}
      .topo-zone-label{position:absolute;font-weight:600;font-size:12px;color:var(--text-secondary)}
      .topo-node{position:absolute;box-sizing:border-box;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:8px 10px;cursor:pointer;transition:border-color .12s,transform .12s,box-shadow .12s;box-shadow:0 1px 3px rgba(0,0,0,.18);overflow:hidden}
      .topo-node:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.28)}
      .topo-node.pub{border-left:3px solid var(--success)}
      .topo-node-h{display:flex;align-items:center;gap:6px}
      .topo-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--text-muted)}
      .topo-dot.running{background:var(--success)}
      .topo-dot.restarting,.topo-dot.paused{background:var(--warning)}
      .topo-dot.dead{background:var(--danger)}
      .topo-name{font-weight:600;font-size:12.5px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
      .topo-pub{font-size:10px;color:var(--success);font-weight:700;flex:none}
      .topo-img{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
      .topo-meta{font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
    `;
    document.head.appendChild(s);
  }
  function topoShortImage(img) {
    let s = String(img || '').replace(/^sha256:/, '').replace(/@sha256:.*/, '');
    const parts = s.split('/'); s = parts[parts.length - 1];
    return s.length > 26 ? s.slice(0, 25) + '…' : s;
  }
  function topoRole(c) {
    const img = (c.image || '').toLowerCase();
    if (/(nginx|caddy|traefik|haproxy|envoy|varnish|apache|httpd|proxy)/.test(img)) return 'proxy';
    if (/(postgres|mysql|mariadb|mongo|redis|clickhouse|rabbitmq|kafka|nats|memcached|elastic|meili|cockroach|influx|couch|cassandra|etcd|minio)/.test(img)) return 'data';
    return 'app';
  }
  function topoCustomNets(c) {
    return (c.networks || []).filter(n => !['bridge', 'host', 'none', ''].includes(n));
  }
  function renderTopology(containers) {
    ensureTopoStyles();
    if (!containers.length) return '<div class="empty-state"><h3>Nothing to visualize</h3><p>No containers match the current filter.</p></div>';

    const groups = getGroupedContainers(containers);
    const keys = getSortedGroupKeys(groups);
    const CARDW = 196, CARDH = 62, COLGAP = 78, ROWGAP = 14, LABELH = 30, BANDGAP = 30, PADX = 18, PADY = 14;
    const tierIdx = { proxy: 0, app: 1, data: 2 };
    const colX = t => PADX + tierIdx[t] * (CARDW + COLGAP);

    const nodes = [], byId = {}, zones = [];
    let bandTop = PADY;
    keys.forEach(k => {
      const list = groups[k];
      const tiers = { proxy: [], app: [], data: [] };
      list.forEach(c => tiers[topoRole(c)].push(c));
      zones.push({ label: k ? ('📦 ' + k) : '🔸 Standalone', x: PADX, y: bandTop });
      const bodyTop = bandTop + LABELH;
      let maxRows = 0;
      ['proxy', 'app', 'data'].forEach(t => {
        tiers[t].forEach((c, i) => {
          const node = { c, x: colX(t), y: bodyTop + i * (CARDH + ROWGAP), pub: (c.ports || []).some(p => p.PublicPort) };
          nodes.push(node); byId[c.id] = node;
        });
        maxRows = Math.max(maxRows, tiers[t].length);
      });
      bandTop = bodyTop + Math.max(1, maxRows) * (CARDH + ROWGAP) + BANDGAP;
    });
    const canvasW = PADX * 2 + 3 * CARDW + 2 * COLGAP;
    const canvasH = bandTop + PADY;

    // edges: prefer compose depends_on (directed), else app→data on a shared network
    const edges = [];
    keys.forEach(k => {
      const list = groups[k];
      const svcMap = {};
      list.forEach(c => { if (c.composeService) svcMap[c.composeService] = c; });
      let hasDep = false;
      list.forEach(c => {
        const dep = c.labels && c.labels['com.docker.compose.depends_on'];
        if (!dep) return;
        dep.split(',').map(s => s.split(':')[0].trim()).filter(Boolean).forEach(sv => {
          const t = svcMap[sv];
          if (t && byId[c.id] && byId[t.id]) { edges.push([byId[c.id], byId[t.id]]); hasDep = true; }
        });
      });
      if (!hasDep) {
        const apps = list.filter(c => topoRole(c) !== 'data');
        const datas = list.filter(c => topoRole(c) === 'data');
        apps.forEach(a => datas.forEach(d => {
          const shared = topoCustomNets(a).some(n => topoCustomNets(d).includes(n));
          if ((shared || topoCustomNets(a).length === 0) && byId[a.id] && byId[d.id]) edges.push([byId[a.id], byId[d.id]]);
        }));
      }
    });

    const edgePath = (a, b) => {
      let sx = a.x + CARDW, sx2 = b.x;
      if (b.x < a.x) { sx = a.x; sx2 = b.x + CARDW; }
      const y1 = a.y + CARDH / 2, y2 = b.y + CARDH / 2;
      const dx = Math.max(38, Math.abs(sx2 - sx) * 0.5) * (sx2 >= sx ? 1 : -1);
      return `M${sx},${y1} C${sx + dx},${y1} ${sx2 - dx},${y2} ${sx2},${y2}`;
    };
    const edgeSvg = edges.map(([a, b]) => `<path class="topo-edge" d="${edgePath(a, b)}" marker-end="url(#topo-arrow)"/>`).join('');
    const pubSvg = nodes.filter(n => n.pub).map(n => `<path class="topo-edge pub" d="M${n.x - 15},${n.y + CARDH / 2} L${n.x - 1},${n.y + CARDH / 2}"/>`).join('');

    const nodeHtml = nodes.map(n => {
      const c = n.c, nets = topoCustomNets(c);
      const pubPorts = [...new Set((c.ports || []).filter(p => p.PublicPort).map(p => p.PublicPort))];
      return `<div class="topo-node ${n.pub ? 'pub' : ''}" data-detail="${c.id}" title="${escapeHtml(c.name)} · ${escapeHtml(c.image)}" style="left:${n.x}px;top:${n.y}px;width:${CARDW}px;height:${CARDH}px">
        <div class="topo-node-h"><span class="topo-dot ${escapeHtml(c.state)}"></span><span class="topo-name">${escapeHtml(c.composeService || c.name)}</span>${n.pub ? `<span class="topo-pub">🌐 :${pubPorts[0]}</span>` : ''}</div>
        <div class="topo-img">${escapeHtml(topoShortImage(c.image))}</div>
        <div class="topo-meta">${escapeHtml(c.state)}${nets.length ? ' · ' + escapeHtml(nets.slice(0, 2).join(', ')) : ''}</div>
      </div>`;
    }).join('');
    const zoneHtml = zones.map(z => `<div class="topo-zone-label" style="left:${z.x}px;top:${z.y}px">${escapeHtml(z.label)}</div>`).join('');

    return `
      <div class="topo-legend">
        <span class="text-muted text-sm">Read-only topology — drawn live from running containers &amp; their Compose links.</span>
        <span style="flex:1"></span>
        <span class="topo-leg"><span class="topo-dot running"></span>running</span>
        <span class="topo-leg"><span class="topo-dot exited"></span>stopped</span>
        <span class="topo-leg"><span style="width:16px;border-top:2px dashed var(--success);display:inline-block"></span>published</span>
        <span class="topo-leg text-muted">columns: edge · app · data</span>
      </div>
      <div class="topo-scroll"><div class="topo-canvas" style="width:${canvasW}px;height:${canvasH}px">
        <svg class="topo-svg" width="${canvasW}" height="${canvasH}"><defs>
          <marker id="topo-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--border-hover)"/></marker>
        </defs>${edgeSvg}${pubSvg}</svg>
        ${zoneHtml}${nodeHtml}
      </div></div>
    `;
  }

  function bindEvents(containers) {
    // Grouping
    document.getElementById('group-toggle')?.addEventListener('change', (e) => {
      groupByProject = e.target.checked;
      Store.set('groupByProject', groupByProject);
      render();
    });

    // Filter buttons
    content.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; render(); });
    });

    // Search
    const searchInput = document.getElementById('container-search');
    if (searchInput) {
      let timeout;
      searchInput.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => { currentSearch = searchInput.value; render(); }, 300);
      });
    }

    // Sort
    document.getElementById('container-sort')?.addEventListener('change', (e) => { currentSort = e.target.value; render(); });

    // View toggle
    document.getElementById('view-table')?.addEventListener('click', () => { currentView = 'table'; render(); });
    document.getElementById('view-card')?.addEventListener('click', () => { currentView = 'card'; render(); });
    document.getElementById('view-topology')?.addEventListener('click', () => { currentView = 'topology'; render(); });

    // Run a new container (guided modal)
    document.getElementById('run-container-btn')?.addEventListener('click', () => openRunContainerModal());

    // Refresh
    document.getElementById('containers-refresh')?.addEventListener('click', render);

    // Detail navigation
    content.querySelectorAll('[data-detail]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]') || e.target.closest('[data-select]') || e.target.closest('a')) return;
        Router.navigate('container-detail', { id: el.dataset.detail });
      });
    });

    // Actions
    content.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const name = containers.find(c => c.id === id)?.name || id.substring(0, 12);

        if (action === 'remove') {
          showDeleteConfirm('Remove Container', { message: `Are you sure you want to remove <strong>${escapeHtml(name)}</strong>?`, phrase: name, onConfirm: async () => {
            try { await API.post(`/containers/${id}/remove`, { force: true }); showToast(`Removed ${name}`); render(); }
            catch (err) { showToast(err.message, 'error'); }
          } });
          return;
        }
        if (action === 'logs') { Router.navigate('container-detail', { id, tab: 'logs' }); return; }
        if (action === 'terminal') { Router.navigate('container-detail', { id, tab: 'terminal' }); return; }

        try {
          await API.post(`/containers/${id}/${action}`);
          showToast(`${action} → ${name}`, 'success');
          render();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    // Selection
    content.querySelectorAll('[data-select]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.select;
        if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
        render();
      });
    });

    // Group Selection
    content.querySelectorAll('[data-group-select]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupKey = el.dataset.groupSelect;
        const groupContainers = containers.filter(c => (c.composeProject || '') === groupKey);
        const allSelected = groupContainers.every(c => selectedIds.has(c.id));
        
        if (allSelected) {
          groupContainers.forEach(c => selectedIds.delete(c.id));
        } else {
          groupContainers.forEach(c => selectedIds.add(c.id));
        }
        render();
      });
    });

    document.getElementById('select-all')?.addEventListener('click', () => {
      if (selectedIds.size === containers.length) selectedIds.clear();
      else containers.forEach(c => selectedIds.add(c.id));
      render();
    });

    // Bulk actions
    document.getElementById('bulk-clear')?.addEventListener('click', () => { selectedIds.clear(); render(); });
    ['start', 'stop', 'restart'].forEach(action => {
      document.getElementById(`bulk-${action}`)?.addEventListener('click', async () => {
        const ids = [...selectedIds];
        await bulkRun(ids, (id) => API.post(`/containers/${id}/${action}`), action);
        selectedIds.clear();
        render();
      });
    });
    document.getElementById('bulk-remove')?.addEventListener('click', () => {
      showDeleteConfirm('Remove Selected', { message: `Remove ${selectedIds.size} container(s)?`, phrase: 'delete', onConfirm: async () => {
        const ids = [...selectedIds];
        await bulkRun(ids, (id) => API.post(`/containers/${id}/remove`, { force: true }), 'Removed');
        selectedIds.clear();
        render();
      } });
    });
  }

  await render();
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 10000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});
