// Tools → Databases: PostgreSQL in containers of the server picked in the top bar (server/pg-studio.js).
// Left: container, database, tables / views / functions. Right: Data · Structure · SQL · Admin · Backups.
// Read-only until "Allow changes"; rows are changed by primary key only; dangerous SQL asks first.
Router.register('databases', async (content, params = {}) => {
  const navId = Router._navId;
  const alive = () => Router.isActiveNav(navId);
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const enc = encodeURIComponent;
  const st = { c: params.c || null, db: params.db || null, s: params.s || null, t: params.t || null, view: params.view || 'data',
    containers: [], info: null, objects: null, filterText: '', grid: { offset: 0, limit: 100, sort: [], filters: [], where: '', sel: new Set() }, sqlText: null, lastSql: null };
  const base = () => `/databases/${enc(st.c)}`;
  const dbBase = () => `${base()}/db/${enc(st.db)}`;
  const save = () => Router.updateParams({ tab: 'databases', ...(st.c ? { c: st.c } : {}), ...(st.db ? { db: st.db } : {}), ...(st.t ? { s: st.s, t: st.t } : {}), view: st.view });
  const NULLV = '<span class="dbg-null">NULL</span>';
  const kindName = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table', S: 'sequence' };

  content.innerHTML = `<style>
    .dbg-wrap{display:grid;grid-template-columns:270px minmax(0,1fr);gap:14px;align-items:start}
    @media (max-width:900px){.dbg-wrap{grid-template-columns:1fr}}
    .dbg-side{position:sticky;top:8px;max-height:calc(100vh - 140px);display:flex;flex-direction:column;padding:10px}
    .dbg-tree{overflow:auto;flex:1;margin-top:8px;font-size:13px}
    .dbg-tree .dbg-sch{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin:10px 4px 4px}
    .dbg-obj{display:flex;gap:6px;align-items:center;width:100%;text-align:left;background:none;border:0;color:var(--text-primary);padding:4px 6px;border-radius:6px;cursor:pointer;font:inherit}
    .dbg-obj:hover{background:var(--bg-hover,rgba(255,255,255,.05))} .dbg-obj[aria-current=true]{background:var(--accent-soft,rgba(59,130,246,.15));color:var(--accent,#3b82f6)}
    .dbg-obj .dbg-k{font-size:10px;color:var(--text-muted);min-width:14px} .dbg-obj .dbg-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dbg-grid{overflow:auto;max-height:calc(100vh - 290px);border:1px solid var(--border);border-radius:10px}
    .dbg-grid table{border-collapse:separate;border-spacing:0;font-size:12.5px;width:max-content;min-width:100%}
    .dbg-grid th{position:sticky;top:0;background:var(--bg-secondary,#1e293b);z-index:1;text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none}
    .dbg-grid th small{display:block;font-weight:400;color:var(--text-muted);font-size:10.5px}
    .dbg-grid td{padding:5px 10px;border-bottom:1px solid var(--border);white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono,monospace)}
    .dbg-grid tr:hover td{background:var(--bg-hover,rgba(255,255,255,.03))} .dbg-grid td.dbg-ed{cursor:text}
    .dbg-null{color:var(--text-muted);font-style:italic;font-family:inherit}
    .dbg-sql{width:100%;min-height:170px;font-family:var(--font-mono,monospace);font-size:13px;line-height:1.5;resize:vertical;tab-size:2}
    .dbg-res{margin-top:12px} .dbg-res .card{margin-bottom:10px;padding:10px 12px}
    .dbg-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
  </style><div data-root><div class="card"><div class="skeleton" style="width:100%;height:200px"></div></div></div>`;
  const root = content.querySelector('[data-root]');

  // ---------- load ----------
  async function loadContainers() {
    let r;
    try { r = await API.get('/databases'); } catch (e) { if (alive()) root.innerHTML = UI.errorState(e, { title: 'Databases could not be loaded' }); return; }
    if (!alive()) return;
    st.containers = r.containers;
    if (!st.containers.length) {
      root.innerHTML = `${UI.header('Databases', 'PostgreSQL running in containers on this server — browse and edit tables, run SQL, manage users, back up and restore.')}
        <div class="card" style="padding:24px"><b>No PostgreSQL container on this server.</b><div class="ui-sub" style="margin-top:6px">DockGate finds containers of the postgres, postgis, timescaledb, pgvector, supabase/postgres and bitnami/postgresql images. Pick another server in the top bar, or deploy one from Deploy → App templates.</div></div>`;
      return;
    }
    if (!st.c || !st.containers.some(c => c.name === st.c)) { const run = st.containers.find(c => c.state === 'running'); st.c = (run || st.containers[0]).name; st.db = null; st.t = null; }
    await loadInfo();
  }
  async function loadInfo() {
    const cont = st.containers.find(c => c.name === st.c);
    st.info = null; st.objects = null;
    drawShell();
    if (!cont || cont.state !== 'running') { mainEl().innerHTML = `<div class="card" style="padding:20px"><b>${esc(st.c)} is ${esc(cont ? cont.state : 'missing')}.</b><div class="ui-sub" style="margin-top:6px">Start the container to open its databases.</div></div>`; return; }
    try { st.info = await API.get(`${base()}/info`); } catch (e) { if (!alive()) return; mainEl().innerHTML = connectError(e); bindConnErr(); return; }
    if (!alive()) return;
    if (!st.db || !st.info.databases.some(d => d.name === st.db)) { st.db = st.info.database; st.t = null; }
    drawShell();
    await loadObjects();
  }
  async function loadObjects() {
    treeEl().innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try { st.objects = await API.get(`${dbBase()}/objects`); } catch (e) { if (alive()) treeEl().innerHTML = `<div class="text-danger text-sm">${esc(e.message)}</div>`; return; }
    if (!alive()) return;
    if (st.t && !st.objects.relations.some(r => r.schema === st.s && r.name === st.t)) st.t = null;
    drawTree(); drawMain();
  }
  const connectError = (e) => `<div class="card" style="padding:20px"><b style="color:var(--danger)">Could not log in to ${esc(st.c)}</b><pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:8px 0">${esc(e.message)}</pre><div class="ui-sub">DockGate runs <span class="td-mono">psql</span> inside the container as the user from its POSTGRES_USER (or "postgres"). Set another user, database or password under Connection.</div><div style="margin-top:10px">${UI.btn('Connection…', 'data-conn')} ${UI.btn('Try again', 'data-retry')}</div></div>`;
  const bindConnErr = () => { const r = root.querySelector('[data-retry]'); if (r) r.onclick = loadInfo; };

  // ---------- shell ----------
  const mainEl = () => root.querySelector('[data-main]');
  const treeEl = () => root.querySelector('[data-tree]');
  function drawShell() {
    const i = st.info;
    const ro = !i || !i.allowWrite;
    root.innerHTML = `${UI.header('Databases', 'PostgreSQL running in containers on this server — reached with <span class="td-mono">docker exec … psql</span>, no port opened.',
      `${i ? `<button type="button" class="btn btn-sm ${ro ? 'btn-secondary' : 'btn-danger'}" data-rw title="${ro ? 'Statements that change data are refused' : 'Changes are allowed — click to make it read-only'}">${ro ? '🔒 Read-only' : '✎ Changes allowed'}</button>` : ''} ${UI.btn('Connection…', 'data-conn')}`)}
      <div class="dbg-wrap">
        <div class="card dbg-side">
          <label class="ui-field" style="margin:0 0 6px"><span class="ui-label">Container</span><select class="input" data-pick-c>${st.containers.map(c => `<option value="${esc(c.name)}" ${c.name === st.c ? 'selected' : ''}>${esc(c.name)}${c.state !== 'running' ? ' (' + esc(c.state) + ')' : ''}</option>`).join('')}</select></label>
          ${i ? `<label class="ui-field" style="margin:0"><span class="ui-label">Database</span><select class="input" data-pick-db>${i.databases.filter(d => d.connect).map(d => `<option value="${esc(d.name)}" ${d.name === st.db ? 'selected' : ''}>${esc(d.name)}${d.size != null ? ' · ' + formatBytes(d.size) : ''}</option>`).join('')}</select></label>
            <div class="ui-sub" style="margin-top:6px">PostgreSQL ${esc(i.serverVersion)} · ${esc(i.user)}${i.superuser ? ' (superuser)' : ''}${i.production ? ' · ' + UI.pill('bad', 'production') : ''}</div>
            <input class="input" data-find placeholder="Find a table…" style="margin-top:8px" value="${esc(st.filterText)}">` : ''}
          <div class="dbg-tree" data-tree>${i ? '' : '<div class="skeleton" style="height:120px"></div>'}</div>
        </div>
        <div style="min-width:0">
          ${i ? `<div class="tab-bar" style="margin-bottom:12px">${[['data', 'Data'], ['structure', 'Structure'], ['sql', 'SQL'], ['admin', 'Admin'], ['backups', 'Backups']].map(([v, l]) => `<button class="tab-btn ${st.view === v ? 'active' : ''}" data-view="${v}">${l}</button>`).join('')}</div>` : ''}
          <div data-main><div class="card"><div class="skeleton" style="width:100%;height:200px"></div></div></div>
        </div>
      </div>`;
    root.querySelector('[data-pick-c]').onchange = (e) => { st.c = e.target.value; st.db = null; st.t = null; save(); loadInfo(); };
    const pdb = root.querySelector('[data-pick-db]'); if (pdb) pdb.onchange = (e) => { st.db = e.target.value; st.t = null; resetGrid(); save(); loadObjects(); };
    const f = root.querySelector('[data-find]'); if (f) f.oninput = () => { st.filterText = f.value; drawTree(); };
    root.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { st.view = b.dataset.view; root.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x === b)); save(); drawMain(); });
    const rw = root.querySelector('[data-rw]'); if (rw) rw.onclick = toggleWrite;
    root.querySelectorAll('[data-conn]').forEach(b => b.onclick = connection);
  }
  const resetGrid = () => { st.grid = { offset: 0, limit: st.grid.limit, sort: [], filters: [], where: '', sel: new Set() }; };

  function drawTree() {
    const o = st.objects; if (!o || !treeEl()) return;
    const q = st.filterText.trim().toLowerCase();
    const rel = o.relations.filter(r => !q || r.name.toLowerCase().includes(q));
    const fns = o.functions.filter(f => !q || f.name.toLowerCase().includes(q));
    const schemas = [...new Set([...rel.map(r => r.schema), ...fns.map(f => f.schema)])].sort((a, b) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)));
    const ic = { r: 'T', p: 'T', v: 'V', m: 'M', f: 'F', S: '#' };
    treeEl().innerHTML = schemas.length ? schemas.map(s => `<div class="dbg-sch">${esc(s)}</div>${rel.filter(r => r.schema === s).sort((a, b) => (a.kind === 'S') - (b.kind === 'S') || a.name.localeCompare(b.name)).map(r => `<button type="button" class="dbg-obj" data-obj data-s="${esc(r.schema)}" data-t="${esc(r.name)}" aria-current="${r.schema === st.s && r.name === st.t}" title="${esc(kindName[r.kind] || r.kind)}${r.rows >= 0 && r.kind !== 'S' && r.kind !== 'v' ? ' · ≈' + r.rows + ' rows' : ''} · ${formatBytes(r.size)}"><span class="dbg-k">${ic[r.kind] || '?'}</span><span class="dbg-n">${esc(r.name)}</span><span class="ui-sub">${r.kind === 'S' || r.kind === 'v' ? '' : formatBytes(r.size)}</span></button>`).join('')}${fns.filter(f => f.schema === s).map(f => `<div class="dbg-obj" style="cursor:default" title="${esc(f.name)}(${esc(f.args)}) → ${esc(f.result)}"><span class="dbg-k">ƒ</span><span class="dbg-n">${esc(f.name)}(${esc(f.args)})</span></div>`).join('')}`).join('')
      : `<div class="ui-sub" style="padding:6px">${q ? 'Nothing matches.' : 'No tables yet in this database.'}</div>`;
    treeEl().querySelectorAll('[data-obj]').forEach(b => b.onclick = () => {
      st.s = b.dataset.s; st.t = b.dataset.t; resetGrid();
      if (st.view !== 'data' && st.view !== 'structure') st.view = 'data';
      root.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === st.view));
      treeEl().querySelectorAll('[data-obj]').forEach(x => x.setAttribute('aria-current', String(x === b)));
      save(); drawMain();
    });
  }

  function drawMain() {
    if (!st.info || !mainEl()) return;
    if (st.view === 'sql') return drawSql();
    if (st.view === 'admin') return drawAdmin();
    if (st.view === 'backups') return drawBackups();
    if (!st.t) { mainEl().innerHTML = `<div class="card" style="padding:22px"><b>Pick a table on the left</b><div class="ui-sub" style="margin-top:6px">${st.objects ? `${st.objects.relations.filter(r => r.kind === 'r' || r.kind === 'p').length} tables, ${st.objects.relations.filter(r => r.kind === 'v' || r.kind === 'm').length} views in ${esc(st.db)}.` : ''} Or write a query in the SQL tab.</div></div>`; return; }
    return st.view === 'structure' ? drawStructure() : drawData();
  }

  // ---------- Data ----------
  async function drawData() {
    const g = st.grid;
    mainEl().innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>';
    let d;
    try { d = await API.post(`${dbBase()}/rows`, { schema: st.s, table: st.t, limit: g.limit, offset: g.offset, sort: g.sort, filters: g.filters, where: g.where }); }
    catch (e) { if (alive()) mainEl().innerHTML = `<div class="card" style="padding:16px"><div class="text-danger">${esc(e.message)}</div>${g.filters.length || g.where ? `<div style="margin-top:8px">${UI.btn('Clear the filter', 'data-clear')}</div>` : ''}</div>`; const c = mainEl().querySelector('[data-clear]'); if (c) c.onclick = () => { g.filters = []; g.where = ''; g.offset = 0; drawData(); }; return; }
    if (!alive() || st.view !== 'data') return;
    const canEdit = d.editable && st.info.allowWrite;
    const sortOf = (col) => { const s = g.sort.find(x => x.col === col); return s ? (s.dir === 'desc' ? ' ▼' : ' ▲') : ''; };
    const pkIdx = d.pk.map(p => d.columns.findIndex(c => c.name === p));
    const keyOf = (row) => JSON.stringify(pkIdx.map(i => row[i]));
    const cell = (v) => v === null ? NULLV : esc(v.length > 200 ? v.slice(0, 200) + '…' : v);
    const ops = [['=', '='], ['!=', '≠'], ['contains', 'contains'], ['starts', 'starts with'], ['<', '<'], ['>', '>'], ['<=', '≤'], ['>=', '≥'], ['in', 'in (a, b)'], ['null', 'is NULL'], ['notnull', 'is not NULL']];
    mainEl().innerHTML = `
      <div class="dbg-bar">
        <b style="font-size:15px">${esc(st.s)}.${esc(st.t)}</b> <span class="ui-sub">${esc(kindName[d.kind] || '')}${d.estimate >= 0 ? ` · ≈ ${d.estimate.toLocaleString()} rows` : ''}</span>
        <span style="flex:1"></span>
        ${UI.btn('Count rows', 'data-count')} ${UI.btn('↻', 'data-reload title="Reload"')}
        ${UI.menu([{ label: 'Export CSV', attrs: 'data-export="csv"' }, { label: 'Export JSON lines', attrs: 'data-export="json"' }], { label: 'Export' })}
        ${d.editable ? (canEdit ? `${UI.btn('+ Row', 'data-add')} ${UI.btn('Delete selected', 'data-delsel', 'btn-danger')}` : '<span class="ui-sub" title="Turn on Allow changes to edit">read-only</span>') : `<span class="ui-sub" title="Rows are changed by primary key">${d.kind === 'r' || d.kind === 'p' ? 'no primary key — edit with SQL' : 'not editable'}</span>`}
      </div>
      <div class="dbg-bar">
        ${g.filters.map((f, i) => UI.chip(`${esc(f.col)} ${esc((ops.find(o => o[0] === f.op) || [f.op, f.op])[1])} ${f.op === 'null' || f.op === 'notnull' ? '' : esc(f.value)}`, { remove: i })).join('')}
        <select class="input" data-fcol style="width:auto;max-width:170px;padding:3px 6px;font-size:12px"><option value="">+ Filter…</option>${d.columns.map(c => `<option>${esc(c.name)}</option>`).join('')}</select>
        <span data-fmore style="display:none;gap:6px;align-items:center"><select class="input" data-fop style="width:auto;padding:3px 6px;font-size:12px">${ops.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select><input class="input td-mono" data-fval style="width:160px;padding:3px 8px;font-size:12px" placeholder="value"> ${UI.btn('Add', 'data-fadd')}</span>
        <input class="input td-mono" data-where style="flex:1;min-width:160px;padding:3px 8px;font-size:12px" placeholder="WHERE … (any condition, Enter)" value="${esc(g.where)}">
      </div>
      <div class="dbg-grid"><table><thead><tr>${canEdit ? '<th style="width:28px;cursor:default"><input type="checkbox" data-selall></th>' : ''}${d.columns.map(c => `<th data-sort="${esc(c.name)}" title="${esc(c.type)}${c.notnull ? ' · NOT NULL' : ''}${c.default ? ' · default ' + c.default : ''}">${d.pk.includes(c.name) ? '🔑 ' : ''}${esc(c.name)}${sortOf(c.name)}<small>${esc(c.type)}</small></th>`).join('')}</tr></thead>
        <tbody>${d.rows.length ? d.rows.map((row, ri) => `<tr>${canEdit ? `<td style="font-family:inherit"><input type="checkbox" data-sel="${ri}" ${g.sel.has(keyOf(row)) ? 'checked' : ''}></td>` : ''}${row.map((v, ci) => `<td class="${canEdit ? 'dbg-ed' : ''}" data-r="${ri}" data-c="${ci}" title="${v === null ? 'NULL' : esc(v.length > 500 ? v.slice(0, 500) + '…' : v)}">${cell(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${d.columns.length + 1}" class="ui-sub" style="font-family:inherit;padding:14px">No rows${g.filters.length || g.where ? ' match the filter' : ''}.</td></tr>`}</tbody></table></div>
      <div class="dbg-bar" style="margin-top:8px">
        <span class="ui-sub">Rows ${d.rows.length ? `${g.offset + 1}–${g.offset + d.rows.length}` : '0'}${canEdit ? ' · double-click a cell to edit it' : ' · double-click a cell to see it'}</span><span style="flex:1"></span>
        <select class="input" data-limit style="width:auto;padding:3px 6px;font-size:12px">${[50, 100, 200, 500].map(n => `<option ${n === g.limit ? 'selected' : ''}>${n}</option>`).join('')}</select>
        ${UI.btn('‹ Prev', `data-prev ${g.offset <= 0 ? 'disabled' : ''}`)} ${UI.btn('Next ›', `data-next ${d.rows.length < g.limit ? 'disabled' : ''}`)}
      </div>`;
    const m = mainEl();
    m.querySelector('[data-reload]').onclick = drawData;
    m.querySelector('[data-count]').onclick = async (e) => { const b = e.target; b.disabled = true; try { const r = await API.post(`${dbBase()}/count`, { schema: st.s, table: st.t, filters: g.filters, where: g.where }); b.textContent = `${r.count.toLocaleString()} rows`; } catch (er) { showToast(er.message, 'error'); b.disabled = false; } };
    m.querySelectorAll('[data-export]').forEach(b => b.onclick = () => { window.location.href = `/api${dbBase()}/export?schema=${enc(st.s)}&table=${enc(st.t)}&format=${b.dataset.export}`; });
    m.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => { const col = th.dataset.sort; const cur = g.sort.find(x => x.col === col); g.sort = !cur ? [{ col, dir: 'asc' }] : cur.dir === 'asc' ? [{ col, dir: 'desc' }] : []; g.offset = 0; drawData(); });
    m.querySelector('[data-limit]').onchange = (e) => { g.limit = Number(e.target.value); g.offset = 0; drawData(); };
    m.querySelector('[data-prev]').onclick = () => { g.offset = Math.max(0, g.offset - g.limit); drawData(); };
    m.querySelector('[data-next]').onclick = () => { g.offset += g.limit; drawData(); };
    const fcol = m.querySelector('[data-fcol]'), fmore = m.querySelector('[data-fmore]');
    fcol.onchange = () => { fmore.style.display = fcol.value ? 'inline-flex' : 'none'; if (fcol.value) m.querySelector('[data-fval]').focus(); };
    const addF = () => { const op = m.querySelector('[data-fop]').value; g.filters.push({ col: fcol.value, op, value: m.querySelector('[data-fval]').value }); g.offset = 0; drawData(); };
    m.querySelector('[data-fadd]').onclick = addF;
    m.querySelector('[data-fval]').onkeydown = (e) => { if (e.key === 'Enter') addF(); };
    m.querySelectorAll('[data-chip-remove]').forEach(x => x.onclick = () => { g.filters.splice(Number(x.dataset.chipRemove), 1); g.offset = 0; drawData(); });
    m.querySelector('[data-where]').onkeydown = (e) => { if (e.key === 'Enter') { g.where = e.target.value.trim(); g.offset = 0; drawData(); } };
    m.querySelectorAll('td[data-r]').forEach(td => td.ondblclick = () => editCell(d, Number(td.dataset.r), Number(td.dataset.c), canEdit));
    const sa = m.querySelector('[data-selall]');
    if (sa) sa.onchange = () => { d.rows.forEach(r => sa.checked ? g.sel.add(keyOf(r)) : g.sel.delete(keyOf(r))); m.querySelectorAll('[data-sel]').forEach(x => { x.checked = sa.checked; }); };
    m.querySelectorAll('[data-sel]').forEach(x => x.onchange = () => { const k = keyOf(d.rows[Number(x.dataset.sel)]); x.checked ? g.sel.add(k) : g.sel.delete(k); });
    const add = m.querySelector('[data-add]'); if (add) add.onclick = () => insertRow(d);
    const ds = m.querySelector('[data-delsel]'); if (ds) ds.onclick = () => deleteSelected(d);
  }

  function editCell(d, ri, ci, canEdit) {
    const col = d.columns[ci], row = d.rows[ri], v = row[ci];
    const pk = Object.fromEntries(d.pk.map(p => [p, row[d.columns.findIndex(c => c.name === p)]]));
    if (!canEdit) {
      showModal(`${esc(col.name)} <span class="ui-sub">${esc(col.type)}</span>`, v === null ? `<div>${NULLV}</div>` : `<pre class="td-mono" style="white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto;margin:0">${esc(v)}</pre>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
      return;
    }
    const long = v != null && (v.length > 80 || v.includes('\n')) || /json|text|xml/.test(col.type);
    UI.dialog({ title: `Edit ${esc(col.name)} <span class="ui-sub">${esc(col.type)}</span>`, saveLabel: 'Save the value',
      body: `<div class="ui-sub" style="margin-bottom:8px">Row ${Object.entries(pk).map(([k, x]) => `${esc(k)} = <span class="td-mono">${esc(x)}</span>`).join(', ')} in ${esc(st.s)}.${esc(st.t)}</div>
        ${long ? `<textarea class="input td-mono" id="ce-v" rows="8" spellcheck="false">${esc(v == null ? '' : v)}</textarea>` : `<input class="input td-mono" id="ce-v" value="${esc(v == null ? '' : v)}">`}
        <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px"><input type="checkbox" id="ce-null" ${v === null ? 'checked' : ''} ${col.notnull ? 'disabled' : ''}> NULL${col.notnull ? ' <span class="ui-sub">(not allowed — NOT NULL)</span>' : ''}</label>`,
      onSave: async (ov) => {
        const isNull = ov.querySelector('#ce-null').checked;
        await API.post(`${dbBase()}/row/update`, { schema: st.s, table: st.t, pk, set: { [col.name]: isNull ? null : ov.querySelector('#ce-v').value } });
        showToast('Saved'); drawData();
      } });
  }

  function insertRow(d) {
    const fields = d.columns.map(c => {
      const auto = c.identity || c.generated || (c.default && /nextval\(|now\(\)|gen_random_uuid|uuid_generate|current_timestamp/i.test(c.default));
      return `<label class="ui-field"><span class="ui-label">${d.pk.includes(c.name) ? '🔑 ' : ''}${esc(c.name)} <span class="ui-sub">${esc(c.type)}${c.notnull ? ' · required' : ''}${c.default ? ' · default ' + esc(c.default) : ''}</span></span>
        <span style="display:flex;gap:8px;align-items:center"><input class="input td-mono" data-ins="${esc(c.name)}" ${c.generated ? 'disabled' : ''} placeholder="${auto ? '(default)' : ''}"><label style="display:flex;gap:4px;align-items:center;font-weight:400;white-space:nowrap"><input type="checkbox" data-insdef="${esc(c.name)}" ${auto || c.generated ? 'checked' : ''}> default</label></span></label>`;
    }).join('');
    UI.dialog({ title: `New row in ${esc(st.s)}.${esc(st.t)}`, saveLabel: 'Insert', wide: true, body: `<div class="ui-sub" style="margin-bottom:8px">"default" leaves the column to the database (its default, serial or NULL). An empty box is an empty text.</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 14px">${fields}</div>`,
      onOpen: (ov) => ov.querySelectorAll('[data-ins]').forEach(i => i.addEventListener('input', () => { const cb = ov.querySelector(`[data-insdef="${CSS.escape(i.dataset.ins)}"]`); if (cb && i.value !== '') cb.checked = false; })),
      onSave: async (ov) => {
        const values = {};
        ov.querySelectorAll('[data-ins]').forEach(i => { const cb = ov.querySelector(`[data-insdef="${CSS.escape(i.dataset.ins)}"]`); if (!cb.checked) values[i.dataset.ins] = i.value; });
        await API.post(`${dbBase()}/row/insert`, { schema: st.s, table: st.t, values });
        showToast('Row added'); drawData();
      } });
  }

  function deleteSelected(d) {
    const keys = [...st.grid.sel].map(k => JSON.parse(k)).map(vals => Object.fromEntries(d.pk.map((p, i) => [p, vals[i]])));
    if (!keys.length) return showToast('Tick the rows to delete first', 'warning');
    showConfirm('Delete rows', `Delete <b>${keys.length}</b> row${keys.length > 1 ? 's' : ''} from <b>${esc(st.s)}.${esc(st.t)}</b>? This can not be undone (rows that other tables point to may refuse).`, async () => {
      try { const r = await API.post(`${dbBase()}/row/delete`, { schema: st.s, table: st.t, pks: keys }); showToast(`${r.deleted} deleted`); st.grid.sel.clear(); drawData(); } catch (e) { showToast(e.message, 'error', 9000); }
    }, true);
  }

  // ---------- Structure ----------
  async function drawStructure() {
    mainEl().innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>';
    let s;
    try { s = await API.get(`${dbBase()}/structure?schema=${enc(st.s)}&table=${enc(st.t)}`); } catch (e) { if (alive()) mainEl().innerHTML = `<div class="card text-danger" style="padding:16px">${esc(e.message)}</div>`; return; }
    if (!alive() || st.view !== 'structure') return;
    const pre = (t) => `<pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:0;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:10px">${esc(t)}</pre>`;
    const ctype = { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check', x: 'exclusion', t: 'trigger', n: 'not null' };
    mainEl().innerHTML = `
      <div class="dbg-bar"><b style="font-size:15px">${esc(s.schema)}.${esc(s.name)}</b><span class="ui-sub">${esc(kindName[s.kind] || s.kind)} · ${formatBytes(s.size)}${s.rows >= 0 && s.kind !== 'v' ? ` · ≈ ${s.rows.toLocaleString()} rows` : ''}</span><span style="flex:1"></span>
        ${st.info.allowWrite && (s.kind === 'r' || s.kind === 'p' || s.kind === 'm') ? `${UI.btn('VACUUM', 'data-mt="vacuum"')} ${UI.btn('ANALYZE', 'data-mt="analyze"')}` : ''} ${UI.btn('Query it in SQL', 'data-q')}</div>
      ${s.comment ? `<div class="ui-sub" style="margin-bottom:8px">${esc(s.comment)}</div>` : ''}
      ${s.columns.length ? UI.table([{ label: 'Column' }, { label: 'Type' }, { label: 'Null' }, { label: 'Default' }, { label: 'Comment' }], s.columns.map(c => ({ cells: [
        `${s.pk.includes(c.name) ? '🔑 ' : ''}<b class="td-mono">${esc(c.name)}</b>`, `<span class="td-mono">${esc(c.type)}</span>`, c.notnull ? 'NOT NULL' : '<span class="ui-sub">null</span>',
        `<span class="td-mono" style="font-size:12px">${c.identity ? 'identity ' + (c.identity === 'a' ? 'always' : 'by default') : c.generated ? 'generated' : esc(c.default || '')}</span>`, `<span class="ui-sub">${esc(c.comment || '')}</span>`] })), { minWidth: 600 }) : ''}
      ${s.indexes.length ? `<div class="ui-label" style="margin:16px 0 6px">Indexes</div>${UI.table([{ label: 'Name' }, { label: 'Definition' }, { label: 'Size' }], s.indexes.map(i => ({ cells: [`<span class="td-mono">${esc(i.name)}</span> ${i.primary ? UI.pill('info', 'primary') : i.unique ? UI.pill('off', 'unique') : ''}`, `<span class="td-mono" style="font-size:12px">${esc(i.def)}</span>`, formatBytes(i.size)] })))}` : ''}
      ${s.constraints.filter(c => c.type !== 'n').length ? `<div class="ui-label" style="margin:16px 0 6px">Constraints</div>${UI.table([{ label: 'Name' }, { label: 'Type' }, { label: 'Definition' }], s.constraints.filter(c => c.type !== 'n').map(c => ({ cells: [`<span class="td-mono">${esc(c.name)}</span>`, esc(ctype[c.type] || c.type), `<span class="td-mono" style="font-size:12px">${esc(c.def)}</span>`] })))}` : ''}
      ${s.referencedBy.length ? `<div class="ui-label" style="margin:16px 0 6px">Referenced by</div>${UI.table([{ label: 'Table' }, { label: 'Constraint' }], s.referencedBy.map(c => ({ cells: [`<span class="td-mono">${esc(c.table)}</span>`, `<span class="td-mono" style="font-size:12px">${esc(c.name)}: ${esc(c.def)}</span>`] })))}` : ''}
      ${s.triggers.length ? `<div class="ui-label" style="margin:16px 0 6px">Triggers</div>${s.triggers.map(t => pre(t.def + (t.enabled ? '' : '  -- disabled'))).join('<div style="height:6px"></div>')}` : ''}
      ${s.viewdef ? `<div class="ui-label" style="margin:16px 0 6px">Definition</div>${pre(s.viewdef)}` : ''}
      ${s.sequence ? `<div class="ui-label" style="margin:16px 0 6px">Sequence</div>${pre(Object.entries(s.sequence).map(([k, v]) => `${k}: ${v}`).join('\n'))}` : ''}`;
    mainEl().querySelector('[data-q]').onclick = () => { st.sqlText = `SELECT *\nFROM ${quoteId(s.schema)}.${quoteId(s.name)}\nLIMIT 100;`; st.view = 'sql'; root.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === 'sql')); save(); drawSql(); };
    mainEl().querySelectorAll('[data-mt]').forEach(b => b.onclick = () => maintain(b.dataset.mt, s.schema, s.name));
  }
  const quoteId = (n) => /^[a-z_][a-z0-9_]*$/.test(n) ? n : '"' + n.replace(/"/g, '""') + '"';

  // ---------- SQL ----------
  const histKey = () => `dg-sql-history:${st.c}`;
  const history = () => { try { return JSON.parse(localStorage.getItem(histKey()) || '[]'); } catch (e) { return []; } };
  function drawSql() {
    if (st.sqlText == null) st.sqlText = st.t ? `SELECT *\nFROM ${quoteId(st.s)}.${quoteId(st.t)}\nLIMIT 100;` : 'SELECT now();';
    const h = history();
    mainEl().innerHTML = `
      <div class="dbg-bar"><b>SQL on ${esc(st.db)}</b><span class="ui-sub">${st.info.allowWrite ? 'changes allowed' : 'read-only session'} · each statement on its own · up to 1000 rows each · 30 s per statement</span><span style="flex:1"></span>
        ${h.length ? `<select class="input" data-hist style="width:auto;max-width:260px;padding:3px 6px;font-size:12px"><option value="">History…</option>${h.map((x, i) => `<option value="${i}">${esc(x.replace(/\s+/g, ' ').slice(0, 70))}</option>`).join('')}</select>` : ''}
        ${UI.primary('Run  (Ctrl+Enter)', 'data-run')}</div>
      <textarea class="input dbg-sql" data-sql spellcheck="false">${esc(st.sqlText)}</textarea>
      <div class="dbg-res" data-res>${st.lastSql ? '' : '<div class="ui-sub">Results show here. Statements that change data need "Allow changes"; DROP, TRUNCATE and DELETE / UPDATE without WHERE ask first.</div>'}</div>`;
    const ta = mainEl().querySelector('[data-sql]');
    ta.oninput = () => { st.sqlText = ta.value; };
    ta.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); st.sqlText = ta.value; }
    };
    mainEl().querySelector('[data-run]').onclick = () => run();
    const hs = mainEl().querySelector('[data-hist]'); if (hs) hs.onchange = () => { if (hs.value !== '') { ta.value = st.sqlText = h[Number(hs.value)]; hs.value = ''; } };
    if (st.lastSql) showResults(st.lastSql);
    setTimeout(() => ta.focus(), 20);
  }
  async function run(confirm = false) {
    const ta = mainEl().querySelector('[data-sql]');
    const sel = ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;
    if (!sel.trim()) return;
    const box = mainEl().querySelector('[data-res]');
    box.innerHTML = '<div class="ui-sub">Running…</div>';
    let r;
    try { r = await API.post(`${dbBase()}/sql`, { sql: sel, confirm }); }
    catch (e) {
      if (e.code === 'NEEDS_CONFIRM') {
        box.innerHTML = '';
        const list = (e.data.danger || []).map(x => `<li>${x.statement ? `Statement ${x.statement}: ` : ''}<b>${esc(x.why)}</b>${x.sql ? `<div class="td-mono ui-sub" style="font-size:12px">${esc(x.sql)}</div>` : ''}</li>`).join('');
        return showConfirm('Run it?', `<ul style="margin:0 0 8px;padding-left:18px">${list}</ul>Run on <b>${esc(st.db)}</b> in <b>${esc(st.c)}</b>?`, () => run(true), true);
      }
      box.innerHTML = `<div class="card" style="border-color:var(--danger)"><div class="text-danger" style="white-space:pre-wrap">${esc(e.message)}</div>${e.code === 'READ_ONLY' ? `<div style="margin-top:8px">${UI.btn('Allow changes…', 'data-allow')}</div>` : ''}</div>`;
      const a = box.querySelector('[data-allow]'); if (a) a.onclick = toggleWrite;
      return;
    }
    const h = history().filter(x => x !== sel); h.unshift(sel); try { localStorage.setItem(histKey(), JSON.stringify(h.slice(0, 30))); } catch (e) {}
    st.lastSql = r; showResults(r);
    if (r.writes && !r.error) loadObjectsQuiet();
  }
  async function loadObjectsQuiet() { try { st.objects = await API.get(`${dbBase()}/objects`); if (alive()) drawTree(); } catch (e) {} }
  function showResults(r) {
    const box = mainEl().querySelector('[data-res]'); if (!box) return;
    const parts = r.results.map((x, i) => {
      if (x.kind === 'tag') return `<div class="card"><span class="ui-sub">${x.statement}.</span> <b class="td-mono">${esc(x.tag)}</b></div>`;
      return `<div class="card"><div class="dbg-bar" style="margin-bottom:6px"><span class="ui-sub">${x.statement}.</span> <b>${x.total || x.rows.length} row${(x.total || x.rows.length) === 1 ? '' : 's'}</b>${x.truncated ? `<span style="color:var(--warning)"> · showing the first ${x.rows.length} — add LIMIT</span>` : ''}${x.tag ? ` · <span class="td-mono">${esc(x.tag)}</span>` : ''}<span style="flex:1"></span>${UI.btn('Copy CSV', `data-copy="${i}"`)}</div>
        <div class="dbg-grid" style="max-height:420px"><table><thead><tr>${x.columns.map(c => `<th style="cursor:default">${esc(c)}</th>`).join('')}</tr></thead><tbody>${x.rows.map(row => `<tr>${row.map(v => `<td title="${v === null ? 'NULL' : esc(String(v).slice(0, 500))}">${v === null ? NULLV : esc(String(v).length > 200 ? String(v).slice(0, 200) + '…' : v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${x.columns.length || 1}" class="ui-sub" style="font-family:inherit">No rows</td></tr>`}</tbody></table></div></div>`;
    });
    if (r.error) parts.push(`<div class="card" style="border-color:var(--danger)"><b class="text-danger">Statement ${r.error.statement} failed</b> <span class="ui-sub">— the statements after it did not run${r.writes ? '; an open transaction was rolled back' : ''}</span><pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:6px 0 0">${esc(r.error.message)}</pre></div>`);
    if (r.notices) parts.push(`<div class="card"><div class="ui-label">Notices</div><pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:4px 0 0">${esc(r.notices)}</pre></div>`);
    box.innerHTML = `<div class="ui-sub" style="margin-bottom:6px">${r.ms} ms</div>${parts.join('') || '<div class="ui-sub">Done.</div>'}`;
    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
      const x = r.results[Number(b.dataset.copy)];
      const q = (v) => v === null ? '' : /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
      navigator.clipboard.writeText([x.columns.map(q).join(','), ...x.rows.map(row => row.map(q).join(','))].join('\n')).then(() => showToast('Copied'), () => showToast('Could not copy', 'error'));
    });
  }

  // ---------- Admin ----------
  async function drawAdmin() {
    mainEl().innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>';
    let a;
    try { a = await API.get(`${dbBase()}/admin`); } catch (e) { if (alive()) mainEl().innerHTML = `<div class="card text-danger" style="padding:16px">${esc(e.message)}</div>`; return; }
    if (!alive() || st.view !== 'admin') return;
    const w = st.info.allowWrite;
    const ago = (s) => s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
    const when = (t) => t ? new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
    const pct = Math.round(a.connections / a.maxConnections * 100);
    mainEl().innerHTML = `
      ${UI.statusLine([`Connections <b>${a.connections}</b> / ${a.maxConnections} ${pct >= 80 ? UI.pill('warn', pct + '%') : ''}`, `Up ${ago(a.uptime)}`, ...Object.entries(a.settings || {}).filter(([k]) => ['shared_buffers', 'work_mem', 'max_wal_size', 'timezone'].includes(k)).map(([k, v]) => `${esc(k)} <span class="td-mono">${esc(v)}</span>`)])}
      ${w ? '' : '<div class="ui-sub" style="margin:8px 0">Read-only: turn on "Allow changes" to stop sessions, manage users and databases, or run VACUUM.</div>'}
      <div class="ui-label" style="margin:16px 0 6px">Sessions (${a.sessions.length})</div>
      ${UI.table([{ label: 'PID' }, { label: 'User / database' }, { label: 'State' }, { label: 'For' }, { label: 'Query' }, { label: '', align: 'right' }], a.sessions.map(x => ({ cells: [
        `<span class="td-mono">${x.pid}</span>${x.me ? ' ' + UI.pill('info', 'DockGate') : ''}`, `${esc(x.user)} / ${esc(x.db)}<div class="ui-sub">${esc(x.app || '')} ${esc(x.client || 'local')}</div>`,
        `${x.state === 'active' ? UI.pill('ok', 'active') : x.state === 'idle in transaction' ? UI.pill('warn', 'idle in transaction') : `<span class="ui-sub">${esc(x.state || '')}</span>`}${x.wait ? `<div class="ui-sub">${esc(x.wait)}</div>` : ''}`,
        ago(x.since), x.me ? '<span class="ui-sub">this page</span>' : `<span class="td-mono" title="${esc(x.query)}" style="font-size:11.5px;white-space:normal;max-width:420px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(x.query)}</span>`,
        x.me || !w ? '' : `${UI.btn('Cancel', `data-cancel="${x.pid}" title="Stop its query"`)} ${UI.btn('Terminate', `data-term="${x.pid}" title="Close the connection"`, 'btn-danger')}`] })), { minWidth: 820 })}
      <div class="dbg-bar" style="margin:18px 0 6px"><span class="ui-label" style="margin:0">Users and roles</span><span style="flex:1"></span>${w ? UI.btn('+ New user', 'data-newrole') : ''}</div>
      ${UI.table([{ label: 'Role' }, { label: 'Can' }, { label: 'Member of' }, { label: '', align: 'right' }], a.roles.map(r => ({ cells: [
        `<b>${esc(r.name)}</b>`, [r.super && UI.pill('bad', 'superuser'), r.login ? 'login' : '<span class="ui-sub">no login</span>', r.createdb && 'create db', r.createrole && 'create role', r.replication && 'replication'].filter(Boolean).join(' · '),
        `<span class="ui-sub">${esc((r.memberOf || []).join(', '))}</span>`,
        w ? UI.menu([{ label: 'Set password…', attrs: `data-pw="${esc(r.name)}"` }, { label: 'Grant on a database…', attrs: `data-grant="${esc(r.name)}"` }, '-', { label: 'Drop…', attrs: `data-droprole="${esc(r.name)}"`, danger: true }]) : ''] })), { minWidth: 640 })}
      <div class="dbg-bar" style="margin:18px 0 6px"><span class="ui-label" style="margin:0">Databases</span><span style="flex:1"></span>${w ? UI.btn('+ New database', 'data-newdb') : ''}</div>
      ${UI.table([{ label: 'Database' }, { label: 'Owner' }, { label: 'Size' }, { label: '', align: 'right' }], st.info.databases.map(d => ({ cells: [
        `<b>${esc(d.name)}</b>${d.name === st.db ? ' ' + UI.pill('info', 'open') : ''}`, esc(d.owner), d.size != null ? formatBytes(d.size) : '<span class="ui-sub">no access</span>',
        `${d.name !== st.db && d.connect ? UI.btn('Open', `data-opendb="${esc(d.name)}"`) : ''} ${w && d.name !== st.info.login.dbname ? UI.btn('Drop…', `data-dropdb="${esc(d.name)}"`, 'btn-danger') : ''}`] })), { minWidth: 560 })}
      <div class="dbg-bar" style="margin:18px 0 6px"><span class="ui-label" style="margin:0">Tables in ${esc(st.db)} — largest first</span><span style="flex:1"></span>${w ? `${UI.btn('VACUUM ANALYZE the database', 'data-mt="vacuum"')}` : ''}</div>
      ${UI.table([{ label: 'Table' }, { label: 'Rows' }, { label: 'Dead rows' }, { label: 'Size' }, { label: 'Last vacuum' }, { label: 'Last analyze' }, { label: '', align: 'right' }], a.tables.map(t => ({ cells: [
        `<span class="td-mono">${esc(t.schema)}.${esc(t.name)}</span>`, Number(t.live).toLocaleString(), `${Number(t.dead).toLocaleString()}${t.live > 0 && t.dead / (t.live + t.dead) > 0.2 ? ' ' + UI.pill('warn', Math.round(t.dead / (t.live + t.dead) * 100) + '%') : ''}`,
        formatBytes(t.size), `<span class="ui-sub">${when(t.last_vacuum || t.last_autovacuum)}</span>`, `<span class="ui-sub">${when(t.last_analyze || t.last_autoanalyze)}</span>`,
        w ? UI.menu([{ label: 'VACUUM ANALYZE', attrs: `data-mtt="vacuum" data-s="${esc(t.schema)}" data-t="${esc(t.name)}"` }, { label: 'ANALYZE', attrs: `data-mtt="analyze" data-s="${esc(t.schema)}" data-t="${esc(t.name)}"` }, { label: 'REINDEX', attrs: `data-mtt="reindex" data-s="${esc(t.schema)}" data-t="${esc(t.name)}"` }, '-', { label: 'VACUUM FULL (locks the table)…', attrs: `data-mtt="vacuum_full" data-s="${esc(t.schema)}" data-t="${esc(t.name)}"`, danger: true }]) : ''] })), { minWidth: 760 })}
      ${a.statements ? `<div class="ui-label" style="margin:18px 0 6px">Slowest queries (pg_stat_statements)</div>${a.slow ? UI.table([{ label: 'Query' }, { label: 'Calls' }, { label: 'Total ms' }, { label: 'Mean ms' }], a.slow.map(q => ({ cells: [`<span class="td-mono" style="font-size:11.5px;white-space:normal;display:block;max-width:520px">${esc(q.query)}</span>`, q.calls, q.total_ms, q.mean_ms] })), { minWidth: 700 }) : `<div class="ui-sub">${esc(a.slowError || 'not readable')}</div>`}` : '<div class="ui-sub" style="margin-top:14px">Slow queries: add the pg_stat_statements extension to see them here.</div>'}`;
    const m = mainEl();
    const post = async (url, body, okMsg) => { try { await API.post(url, body); showToast(okMsg); drawAdmin(); } catch (e) { showToast(e.message, 'error', 9000); } };
    m.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => post(`${base()}/session`, { pid: b.dataset.cancel, action: 'cancel' }, 'Query stopped'));
    m.querySelectorAll('[data-term]').forEach(b => b.onclick = () => showConfirm('Terminate session', `Close connection <b>${esc(b.dataset.term)}</b>? Its open transaction is rolled back.`, () => post(`${base()}/session`, { pid: b.dataset.term, action: 'terminate' }, 'Session closed'), true));
    m.querySelectorAll('[data-opendb]').forEach(b => b.onclick = () => { st.db = b.dataset.opendb; st.t = null; resetGrid(); save(); drawShell(); loadObjects(); });
    m.querySelectorAll('[data-mt]').forEach(b => b.onclick = () => maintain(b.dataset.mt));
    m.querySelectorAll('[data-mtt]').forEach(b => b.onclick = () => maintain(b.dataset.mtt, b.dataset.s, b.dataset.t));
    const nr = m.querySelector('[data-newrole]'); if (nr) nr.onclick = () => newRole();
    const nd = m.querySelector('[data-newdb]'); if (nd) nd.onclick = () => UI.dialog({ title: 'New database', saveLabel: 'Create',
      body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input td-mono" id="nd-n" placeholder="app"></label><label class="ui-field"><span class="ui-label">Owner</span><select class="input" id="nd-o">${a.roles.filter(r => r.login).map(r => `<option ${r.name === st.info.user ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`,
      onSave: async (ov) => { await API.post(`${base()}/databases`, { database: ov.querySelector('#nd-n').value.trim(), owner: ov.querySelector('#nd-o').value }); showToast('Created'); st.info = await API.get(`${base()}/info`); drawShell(); drawTree(); drawAdmin(); } });
    m.querySelectorAll('[data-dropdb]').forEach(b => b.onclick = () => showDeleteConfirm('Drop database', { message: `Drop <b>${esc(b.dataset.dropdb)}</b> and everything in it? Its sessions are closed first. Make a backup before, if in doubt.`, phrase: b.dataset.dropdb,
      onConfirm: async () => { try { await API.post(`${base()}/databases/drop`, { database: b.dataset.dropdb, confirm: b.dataset.dropdb }); showToast('Dropped'); st.info = await API.get(`${base()}/info`); drawShell(); drawTree(); drawAdmin(); } catch (e) { showToast(e.message, 'error', 9000); } } }));
    m.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => UI.dialog({ title: `Password for ${esc(b.dataset.pw)}`, saveLabel: 'Set',
      body: `<label class="ui-field"><span class="ui-label">New password</span><input class="input td-mono" id="pw" type="text" autocomplete="off" value="${esc(randomPw())}"><span class="ui-sub">At least 8 characters. Update the apps that use it.</span></label>`,
      onSave: async (ov) => { await API.post(`${base()}/roles/password`, { role: b.dataset.pw, password: ov.querySelector('#pw').value }); showToast('Password set'); } }));
    m.querySelectorAll('[data-grant]').forEach(b => b.onclick = () => UI.dialog({ title: `Grant ${esc(b.dataset.grant)} a database`, saveLabel: 'Grant',
      body: `<label class="ui-field"><span class="ui-label">Database</span><select class="input" id="gr-d">${st.info.databases.map(d => `<option ${d.name === st.db ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label><label class="ui-field"><span class="ui-label">Access</span><select class="input" id="gr-a"><option value="all">Read and write (all tables, also later ones)</option><option value="read">Read only (SELECT)</option></select></label>`,
      onSave: async (ov) => { await API.post(`${base()}/roles/grant`, { role: b.dataset.grant, database: ov.querySelector('#gr-d').value, access: ov.querySelector('#gr-a').value }); showToast('Granted'); drawAdmin(); } }));
    m.querySelectorAll('[data-droprole]').forEach(b => b.onclick = () => showDeleteConfirm('Drop role', { message: `Drop the role <b>${esc(b.dataset.droprole)}</b>? It fails while it owns objects or has grants.`, phrase: b.dataset.droprole,
      onConfirm: async () => { try { await API.post(`${base()}/roles/drop`, { role: b.dataset.droprole }); showToast('Dropped'); drawAdmin(); } catch (e) { showToast(e.message, 'error', 10000); } } }));
  }
  const randomPw = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 22); };
  function newRole() {
    UI.dialog({ title: 'New user', saveLabel: 'Create',
      body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input td-mono" id="nr-n" placeholder="app_user"></label>
        <label class="ui-field"><span class="ui-label">Password</span><input class="input td-mono" id="nr-p" type="text" autocomplete="off" value="${esc(randomPw())}"><span class="ui-sub">Copy it now — it is not shown again.</span></label>
        <label class="ui-field"><span class="ui-label">Access to</span><select class="input" id="nr-d"><option value="">— none yet —</option>${st.info.databases.map(d => `<option ${d.name === st.db ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        <label class="ui-field"><span class="ui-label">As</span><select class="input" id="nr-a"><option value="all">Read and write</option><option value="read">Read only</option></select></label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="nr-c"> May create databases</label>`,
      onSave: async (ov) => {
        await API.post(`${base()}/roles`, { role: ov.querySelector('#nr-n').value.trim(), password: ov.querySelector('#nr-p').value, database: ov.querySelector('#nr-d').value || null, access: ov.querySelector('#nr-a').value, createdb: ov.querySelector('#nr-c').checked });
        showToast('User created'); drawAdmin();
      } });
  }
  function maintain(action, schema, table) {
    const what = table ? `${schema}.${table}` : `the whole database ${st.db}`;
    const label = { vacuum: 'VACUUM ANALYZE', analyze: 'ANALYZE', reindex: 'REINDEX', vacuum_full: 'VACUUM FULL' }[action];
    showConfirm(label, `Run <b>${label}</b> on <b>${esc(what)}</b>?${action === 'vacuum_full' ? ' VACUUM FULL rewrites the table and <b>locks it</b> until it ends.' : action === 'reindex' ? ' REINDEX blocks writes to the table while it runs.' : ' It runs alongside normal work.'}`, async () => {
      showToast(`${label} running…`, 'info');
      try { const r = await API.post(`${dbBase()}/maintain`, { action, schema, table }); showToast(`${label} done in ${(r.ms / 1000).toFixed(1)} s`); if (st.view === 'admin') drawAdmin(); } catch (e) { showToast(e.message, 'error', 9000); }
    }, action === 'vacuum_full');
  }

  // ---------- Backups ----------
  async function drawBackups() {
    mainEl().innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:200px"></div></div>';
    let b;
    try { b = await API.get(`${base()}/backups`); } catch (e) { if (alive()) mainEl().innerHTML = `<div class="card text-danger" style="padding:16px">${esc(e.message)}</div>`; return; }
    if (!alive() || st.view !== 'backups') return;
    const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    mainEl().innerHTML = `
      <div class="dbg-bar"><b>Backups of ${esc(st.c)}</b><span class="ui-sub">in <span class="td-mono">${esc(b.dir)}</span>${b.local ? ' (DockGate\'s data folder)' : ' on the server'}</span><span style="flex:1"></span>
        ${b.local ? '' : UI.btn('Schedule…', 'data-sched')} ${UI.primary('Back up now', 'data-bk')}</div>
      ${UI.table([{ label: 'Backup' }, { label: 'Size' }, { label: 'Made' }, { label: '', align: 'right' }], b.files.map(f => ({ cells: [
        `${f.whole ? UI.pill('info', 'whole server') : `<b>${esc(f.database)}</b>`} <span class="ui-sub">${f.format === 'custom' ? 'pg_dump custom' : 'SQL, gzip'}</span><div class="td-mono ui-sub" style="font-size:11px">${esc(f.name)}</div>`,
        formatBytes(f.size), when(f.mtime),
        `${UI.btn('Download', `data-dl="${esc(f.name)}"`)} ${f.restorable ? UI.btn('Restore…', `data-rs="${esc(f.name)}"`) : UI.btn('How to restore', `data-howto="${esc(f.name)}"`)} ${UI.menu([{ label: `${Icons.trash} Delete…`, attrs: `data-delbk="${esc(f.name)}"`, danger: true }])}`] })), { empty: 'No backups yet — "Back up now" makes one.', minWidth: 620 })}
      <div class="ui-sub" style="margin-top:10px">A restore goes into a <b>new database</b> first, so you can look at it; then <b>Swap</b> puts it in place of the old one (kept, renamed). ${b.local ? 'Scheduled backups run on SSH servers (Scripts + Cron).' : 'Scheduled backups are a script in Server Console → Scripts with a Cron job, its log and failure alerts.'}</div>`;
    const m = mainEl();
    m.querySelector('[data-bk]').onclick = () => UI.dialog({ title: `Back up ${esc(st.c)}`, saveLabel: 'Back up now',
      body: `<label class="ui-field"><span class="ui-label">What</span><select class="input" id="bk-w">${st.info.databases.filter(d => d.connect).map(d => `<option value="db:${esc(d.name)}" ${d.name === st.db ? 'selected' : ''}>Database ${esc(d.name)}${d.size != null ? ' · ' + formatBytes(d.size) : ''}</option>`).join('')}<option value="all">The whole server — every database and the users (pg_dumpall)</option></select></label>
        <label class="ui-field"><span class="ui-label">Format</span><select class="input" id="bk-f"><option value="custom">pg_dump custom (.dump) — compressed, restore a single table if needed</option><option value="sql">Plain SQL (.sql.gz) — readable, works with any psql</option></select></label>
        <div class="ui-sub">It runs while the database is in use (a consistent snapshot); large databases take a while.</div>`,
      onOpen: (ov) => { const w = ov.querySelector('#bk-w'), f = ov.querySelector('#bk-f'); w.onchange = () => { f.disabled = w.value === 'all'; if (f.disabled) f.value = 'sql'; }; },
      onSave: async (ov) => {
        const w = ov.querySelector('#bk-w').value;
        const r = await API.post(`${base()}/backups`, w === 'all' ? { kind: 'all' } : { database: w.slice(3), kind: ov.querySelector('#bk-f').value });
        showToast(`Backed up: ${r.file} (${formatBytes(r.size)})`); drawBackups();
      } });
    const sc = m.querySelector('[data-sched]'); if (sc) sc.onclick = () => UI.dialog({ title: 'Scheduled backups', saveLabel: 'Schedule',
      body: `<label class="ui-field"><span class="ui-label">What</span><select class="input" id="sc-d">${st.info.databases.filter(d => d.connect).map(d => `<option value="${esc(d.name)}" ${d.name === st.db ? 'selected' : ''}>Database ${esc(d.name)}</option>`).join('')}<option value="">The whole server (pg_dumpall)</option></select></label>
        <label class="ui-field"><span class="ui-label">When (cron, server time)</span><input class="input td-mono" id="sc-w" value="15 3 * * *"><span class="ui-sub">15 3 * * * = every night at 03:15 · 0 */6 * * * = every 6 hours</span></label>
        <label class="ui-field"><span class="ui-label">Keep for (days)</span><input class="input" id="sc-k" type="number" value="7" min="1" max="365"></label>
        <div class="ui-sub">Makes the script <span class="td-mono">pg-backup-…</span> in Server Console → Scripts (SQL .sql.gz files in this folder, older ones deleted, disk checked) and its Cron job — with a log and alerts when it fails or does not run.</div>`,
      onSave: async (ov) => { const r = await API.post(`${base()}/backups/schedule`, { database: ov.querySelector('#sc-d').value, schedule: ov.querySelector('#sc-w').value.trim(), keepDays: Number(ov.querySelector('#sc-k').value) }); showToast(`Scheduled — script ${r.script}`); } });
    m.querySelectorAll('[data-dl]').forEach(x => x.onclick = () => { window.location.href = `/api${base()}/backups/${enc(x.dataset.dl)}/download`; });
    m.querySelectorAll('[data-delbk]').forEach(x => x.onclick = () => showDeleteConfirm('Delete backup', { message: `Delete <span class="td-mono">${esc(x.dataset.delbk)}</span>?`, phrase: 'delete',
      onConfirm: async () => { try { await API.del(`${base()}/backups/${enc(x.dataset.delbk)}`); showToast('Deleted'); drawBackups(); } catch (e) { showToast(e.message, 'error'); } } }));
    m.querySelectorAll('[data-howto]').forEach(x => showHowTo(x, b));
    m.querySelectorAll('[data-rs]').forEach(x => x.onclick = () => restore(b.files.find(f => f.name === x.dataset.rs)));
  }
  function showHowTo(btn, b) {
    btn.onclick = () => showModal('Restore a whole-server backup', `<div class="text-sm">A <span class="td-mono">pg_dumpall</span> file holds every database and the users. It is restored into an <b>empty</b> PostgreSQL server (a new container), so nothing running is overwritten:</div>
      <pre class="td-mono" style="white-space:pre-wrap;font-size:12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:10px">gunzip -c ${esc(b.dir)}/${esc(btn.dataset.howto)} | docker exec -i NEW_CONTAINER psql -U postgres -d postgres</pre>
      <div class="ui-sub">To bring back one database from it, make a per-database backup instead (Back up now → Database).</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
  }
  function restore(f) {
    if (!st.info.allowWrite) return showConfirm('Allow changes?', 'A restore makes a new database. Turn on "Allow changes" for this connection?', async () => { await setWrite(true); restore(f); });
    const d = new Date(), tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    UI.dialog({ title: 'Restore into a new database', saveLabel: 'Restore',
      body: `<div class="text-sm" style="margin-bottom:8px">From <span class="td-mono">${esc(f.name)}</span> (database <b>${esc(f.database)}</b>). Nothing that exists is changed.</div>
        <label class="ui-field"><span class="ui-label">New database</span><input class="input td-mono" id="rs-n" value="${esc((f.database + '_restored_' + tag).slice(0, 63))}"></label>
        ${f.format === 'custom' ? '<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="rs-o" checked> Keep owners and grants (turn off when the users of the backup do not exist here)</label>' : ''}`,
      onSave: async (ov) => {
        const target = ov.querySelector('#rs-n').value.trim();
        const o = ov.querySelector('#rs-o');
        showToast('Restoring…', 'info');
        const r = await API.post(`${base()}/backups/restore`, { file: f.name, target, keepOwners: o ? o.checked : true });
        st.info = await API.get(`${base()}/info`);
        const can = st.info.databases.some(x => x.name === f.database);
        const rm = showModal('Restored', `<div class="text-sm">The backup is in the new database <b>${esc(r.database)}</b> (${(r.ms / 1000).toFixed(1)} s). Open it to check it.${can ? ` When it looks right, <b>Swap</b> puts it in place of <b>${esc(f.database)}</b> — the current one is kept, renamed <span class="td-mono">${esc(f.database)}_before_…</span>. Apps connected to ${esc(f.database)} are disconnected for a moment.` : ''}</div>`,
          [{ label: 'Close', className: 'btn btn-secondary' }, { label: 'Open it', className: 'btn btn-secondary', onClick: () => { st.db = r.database; st.t = null; st.view = 'data'; save(); drawShell(); loadObjects(); } },
           ...(can ? [{ label: `Swap in place of ${f.database}`, className: 'btn btn-danger', onClick: () => swap(r.database, f.database) }] : [])]);
        const ft = rm.overlay.querySelector('.modal-footer'); if (ft) { ft.style.flexWrap = 'wrap'; ft.style.gap = '8px'; }
        drawShell(); drawTree(); drawBackups();
      } });
  }
  function swap(restored, into) {
    showDeleteConfirm('Swap databases', { message: `Put <b>${esc(restored)}</b> in place of <b>${esc(into)}</b>? Sessions on both are closed; the current <b>${esc(into)}</b> is kept as <span class="td-mono">${esc(into)}_before_…</span>.`, phrase: into,
      onConfirm: async () => { try { const r = await API.post(`${base()}/backups/swap`, { restored, into }); showToast(`Swapped — the old one is ${r.kept}`, 'success', 9000); st.info = await API.get(`${base()}/info`); st.db = into; save(); drawShell(); loadObjects(); } catch (e) { showToast(e.message, 'error', 10000); } } });
  }

  // ---------- connection ----------
  async function setWrite(on) { const r = await API.put(`${base()}/settings`, { allowWrite: on }); st.info.allowWrite = r.allowWrite; drawShell(); drawTree(); drawMain(); }
  function toggleWrite() {
    if (!st.info) return;
    if (st.info.allowWrite) return setWrite(false).then(() => showToast('Read-only again'));
    showConfirm('Allow changes', `Allow statements and edits that <b>change data</b> on <b>${esc(st.c)}</b>${st.info.production ? ' — <b style="color:var(--danger)">marked as production</b>' : ''}? Dangerous SQL still asks first, and every change is in the audit log.`, () => setWrite(true).then(() => showToast('Changes allowed')), !!st.info.production);
  }
  function connection() {
    const i = st.info, c = st.containers.find(x => x.name === st.c) || {}, s = c.settings || {};
    UI.dialog({ title: `Connection to ${esc(st.c)}`, saveLabel: 'Save',
      body: `<div class="ui-sub" style="margin-bottom:8px">DockGate runs <span class="td-mono">psql</span> inside the container. Leave a box empty to use what the container's environment says (POSTGRES_USER, POSTGRES_DB, POSTGRES_PASSWORD).</div>
        <label class="ui-field"><span class="ui-label">User</span><input class="input td-mono" id="cn-u" value="${esc(s.user || '')}" placeholder="${esc(i ? i.login.user : 'postgres')}"></label>
        <label class="ui-field"><span class="ui-label">Login database</span><input class="input td-mono" id="cn-d" value="${esc(s.dbname || '')}" placeholder="${esc(i ? i.login.dbname : 'postgres')}"></label>
        <label class="ui-field"><span class="ui-label">Password</span><input class="input td-mono" id="cn-p" type="password" autocomplete="new-password" placeholder="${s.hasPassword ? '(saved — type to change)' : '(from the container, if any)'}"><span class="ui-sub">Usually not needed: inside the container the local socket trusts its users. Stored encrypted.</span>${s.hasPassword ? '<label style="display:flex;gap:6px;align-items:center;font-weight:400;margin-top:4px"><input type="checkbox" id="cn-pc"> forget the saved password</label>' : ''}</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cn-w" ${i && i.allowWrite ? 'checked' : ''}> Allow changes (otherwise every session is read-only)</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:6px"><input type="checkbox" id="cn-x" ${i && i.production ? 'checked' : ''}> Production — ask before every statement that changes data</label>`,
      onSave: async (ov) => {
        const body = { user: ov.querySelector('#cn-u').value.trim(), dbname: ov.querySelector('#cn-d').value.trim(), allowWrite: ov.querySelector('#cn-w').checked, production: ov.querySelector('#cn-x').checked };
        const p = ov.querySelector('#cn-p').value; const pc = ov.querySelector('#cn-pc');
        if (p) body.password = p; else if (pc && pc.checked) body.password = '';
        await API.put(`${base()}/settings`, body);
        showToast('Saved'); const r = await API.get('/databases'); st.containers = r.containers; await loadInfo();
      } });
  }

  await loadContainers();
});
