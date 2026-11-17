// Tools → Databases — a database client in the page: the Explorer on the left (container → database → schema →
// Tables / Views / Materialized views / Sequences / Functions → table → columns, indexes, foreign keys, triggers),
// tabs on the right (table data, design, SQL queries, database overview, admin, backups — a single click opens a
// preview tab, a double click or an edit keeps it), right-click menus on every node and tab, a status bar.
// PostgreSQL in containers of the server picked in the top bar (server/pg-studio.js); read-only until "Allow changes".
Router.register('databases', async (content, params = {}) => {
  const navId = Router._navId;
  const alive = () => Router.isActiveNav(navId);
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const enc = encodeURIComponent;
  const kindName = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table', S: 'sequence' };
  const srvId = (Store.get('activeServer') || {}).id || 'local';
  const LS = `dg-dbx:${srvId}`;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(`${LS}:${k}`); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(`${LS}:${k}`, JSON.stringify(v)); } catch (e) { /* private window */ } };
  const quoteId = (n) => /^[a-z_][a-z0-9_]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
  const qn = (s, t) => `${quoteId(s)}.${quoteId(t)}`;
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  // st.c / st.db / st.info / st.view: the ACTIVE tab's context — the admin and backup views below read them
  const st = { c: null, db: null, s: null, t: null, view: null, info: null,
    containers: [], infos: {}, infoErr: {}, objects: {}, structs: {}, loading: new Set(),
    open: new Set(lsGet('open', [])), filter: '', tabs: [], active: null, sel: null };
  const base = () => `/databases/${enc(st.c)}`;
  const dbBase = () => `${base()}/db/${enc(st.db)}`;
  const baseOf = (c) => `/databases/${enc(c)}`;
  const dbBaseOf = (c, db) => `${baseOf(c)}/db/${enc(db)}`;

  const IC = {
    server: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/></svg>',
    db: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/></svg>',
    schema: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5h4l1.5 1.5H14v7H2z"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z"/></svg>',
    table: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6.5h12M6 6.5V13M10 6.5V13"/></svg>',
    view: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    mview: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="8" cy="8" r="2"/></svg>',
    seq: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4h2v8M8 4h3v4H8v4h3"/></svg>',
    fn: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.5 2.5c-2 0-2.5 1.5-2.8 3.5L6.5 13.5c-.3 1.5-1 2-2.5 2M5 6.5h5.5"/></svg>',
    col: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="2" width="6" height="12" rx="1"/></svg>',
    key: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#e5c07b" stroke-width="1.6"><circle cx="5" cy="8" r="3"/><path d="M8 8h6.5M12 8v2.5M14.5 8v2"/></svg>',
    fk: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#61afef" stroke-width="1.6"><path d="M6.5 9.5l3-3M5 7.5L3.5 9a2.1 2.1 0 003 3L8 10.5M11 8.5L12.5 7a2.1 2.1 0 00-3-3L8 5.5"/></svg>',
    idx: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3v10M6 5h7M6 8h5M6 11h7"/></svg>',
    trg: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/></svg>',
    sql: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 2.5h7l3 3v8H3z"/><path d="M5.5 8.5h5M5.5 11h3.5"/></svg>',
    design: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 13.5l1-3.5 7.5-7.5 2.5 2.5L5.5 12.5z"/></svg>',
    admin: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5"/></svg>',
    backup: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2v8M5 7l3 3 3-3M2.5 11v2.5h11V11"/></svg>',
    chev: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6 4l4 4-4 4z"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v3h-3"/></svg>',
    collapse: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4-3 4 3M4 10l4 3 4-3"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>',
  };
  const relIcon = (k) => (k === 'v' ? IC.view : k === 'm' ? IC.mview : k === 'S' ? IC.seq : IC.table);
  const FOLDERS = [['tables', 'Tables', (r) => r.kind === 'r' || r.kind === 'p' || r.kind === 'f'], ['views', 'Views', (r) => r.kind === 'v'], ['mviews', 'Materialized views', (r) => r.kind === 'm'], ['seqs', 'Sequences', (r) => r.kind === 'S']];

  content.innerHTML = `<style>
    .dbx{display:grid;grid-template-columns:var(--dbx-w,290px) 5px minmax(0,1fr);height:calc(100vh - 132px);min-height:520px;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-secondary)}
    @media (max-width:900px){.dbx{grid-template-columns:1fr;grid-template-rows:38vh 0 minmax(0,1fr);height:auto;min-height:calc(100vh - 132px)}.dbx-sp{display:none}}
    .dbx-exp{display:flex;flex-direction:column;min-width:0;min-height:0}
    .dbx-exp-h{display:flex;align-items:center;gap:2px;padding:8px 8px 6px 12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);font-weight:600}
    .dbx-ib{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;background:none;color:var(--text-secondary);border-radius:5px;cursor:pointer}
    .dbx-ib:hover{background:var(--bg-hover,rgba(255,255,255,.07));color:var(--text-primary)}
    .dbx-find{margin:0 8px 6px;padding:4px 8px;font-size:12.5px;height:28px}
    .dbx-tree{flex:1;overflow:auto;padding:2px 0 12px;font-size:13px;user-select:none;outline:none}
    .dbx-n{display:flex;align-items:center;gap:5px;height:24px;padding-right:10px;cursor:pointer;white-space:nowrap;color:var(--text-primary)}
    .dbx-n:hover{background:var(--bg-hover,rgba(255,255,255,.05))} .dbx-n.sel{background:var(--accent-soft,rgba(59,130,246,.18))}
    .dbx-tw{width:14px;display:inline-flex;justify-content:center;color:var(--text-muted);flex:0 0 14px;transition:transform .12s} .dbx-tw.open{transform:rotate(90deg)} .dbx-tw.leaf{visibility:hidden}
    .dbx-ic{display:inline-flex;color:var(--text-secondary);flex:0 0 auto} .dbx-n .dbx-ic.c-on{color:var(--success,#22c55e)} .dbx-n .dbx-ic.c-off{color:var(--text-muted)}
    .dbx-lb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis} .dbx-n.dim .dbx-lb{color:var(--text-secondary)}
    .dbx-meta{color:var(--text-muted);font-size:11px;margin-left:6px;flex:0 0 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis}
    .dbx-msg{padding:4px 10px;font-size:12px;color:var(--text-muted)} .dbx-msg.err{color:var(--danger)}
    .dbx-sp{cursor:col-resize;background:var(--border);opacity:.35} .dbx-sp:hover,.dbx-sp.drag{opacity:1;background:var(--accent,#3b82f6)}
    .dbx-main{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--bg-primary)}
    .dbx-tabs{display:flex;overflow-x:auto;overflow-y:hidden;background:var(--bg-secondary);border-bottom:1px solid var(--border);min-height:36px;flex:0 0 auto;scrollbar-width:thin}
    .dbx-tab{display:flex;align-items:center;gap:6px;padding:0 6px 0 11px;height:36px;border-right:1px solid var(--border);font-size:12.5px;color:var(--text-secondary);cursor:pointer;white-space:nowrap;max-width:260px;flex:0 0 auto}
    .dbx-tab:hover{color:var(--text-primary)} .dbx-tab.on{background:var(--bg-primary);color:var(--text-primary);box-shadow:inset 0 2px 0 var(--accent,#3b82f6)}
    .dbx-tab.pv .dbx-tt{font-style:italic} .dbx-tt{overflow:hidden;text-overflow:ellipsis} .dbx-tsub{color:var(--text-muted);font-size:11px}
    .dbx-x{border:0;background:none;color:inherit;opacity:0;cursor:pointer;width:20px;height:20px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1}
    .dbx-tab:hover .dbx-x,.dbx-tab.on .dbx-x{opacity:.65} .dbx-x:hover{opacity:1;background:var(--bg-hover,rgba(255,255,255,.1))}
    .dbx-panes{flex:1;overflow:auto;min-height:0} .dbx-pane{padding:14px 16px;display:none} .dbx-pane.on{display:block}
    .dbx-status{display:flex;gap:12px;align-items:center;height:26px;padding:0 10px;font-size:11.5px;border-top:1px solid var(--border);background:var(--bg-secondary);color:var(--text-secondary);flex:0 0 auto;white-space:nowrap;overflow:hidden}
    .dbx-status button{border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0 4px;border-radius:4px} .dbx-status button:hover{background:var(--bg-hover,rgba(255,255,255,.08));color:var(--text-primary)}
    .dbx-menu{position:fixed;z-index:3000;min-width:230px;max-width:320px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:4px;font-size:13px}
    .dbx-mi{display:flex;gap:8px;align-items:center;width:100%;padding:6px 10px;border:0;background:none;color:var(--text-primary);border-radius:5px;text-align:left;cursor:pointer;font:inherit}
    .dbx-mi:hover:not([disabled]){background:var(--accent,#3b82f6);color:#fff} .dbx-mi[disabled]{opacity:.45;cursor:default} .dbx-mi.danger{color:var(--danger)} .dbx-mi.danger:hover{color:#fff;background:var(--danger)}
    .dbx-mi kbd{margin-left:auto;font:inherit;font-size:11px;opacity:.6} .dbx-ms{height:1px;background:var(--border);margin:4px 2px} .dbx-mh{padding:4px 10px 2px;font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dbx-welcome{max-width:760px;margin:30px auto;padding:0 10px} .dbx-welcome h3{margin:0 0 6px}
    .dbx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:14px}
    .dbx-card{border:1px solid var(--border);border-radius:10px;padding:12px;cursor:pointer;background:var(--bg-secondary)} .dbx-card:hover{border-color:var(--accent,#3b82f6)}
    .dbx-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px} .dbx-head b{font-size:15px}
    .dbg-grid{overflow:auto;max-height:calc(100vh - 330px);border:1px solid var(--border);border-radius:10px}
    .dbg-grid table{border-collapse:separate;border-spacing:0;font-size:12.5px;width:max-content;min-width:100%}
    .dbg-grid th{position:sticky;top:0;background:var(--bg-secondary,#1e293b);z-index:1;text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none}
    .dbg-grid th small{display:block;font-weight:400;color:var(--text-muted);font-size:10.5px}
    .dbg-grid td{padding:5px 10px;border-bottom:1px solid var(--border);white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono,monospace)}
    .dbg-grid tr:hover td{background:var(--bg-hover,rgba(255,255,255,.03))} .dbg-grid td.dbg-ed{cursor:text}
    .dbg-null{color:var(--text-muted);font-style:italic;font-family:inherit}
    .dbg-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
  </style>
  <div class="dbx" style="--dbx-w:${Math.max(200, Math.min(560, lsGet('w', 290)))}px">
    <aside class="dbx-exp">
      <div class="dbx-exp-h"><span style="flex:1">Explorer</span>
        <button type="button" class="dbx-ib" data-x-newq title="New query">${IC.plus}</button>
        <button type="button" class="dbx-ib" data-x-refresh title="Refresh">${IC.refresh}</button>
        <button type="button" class="dbx-ib" data-x-collapse title="Collapse all">${IC.collapse}</button></div>
      <input class="input dbx-find" data-x-find placeholder="Filter tables, views, functions…">
      <div class="dbx-tree" data-tree tabindex="0"><div class="dbx-msg">Loading…</div></div>
    </aside>
    <div class="dbx-sp" data-split></div>
    <section class="dbx-main">
      <div class="dbx-tabs" data-tabs role="tablist"></div>
      <div class="dbx-panes" data-panes></div>
      <div class="dbx-status" data-status></div>
    </section>
  </div>`;
  const root = content.querySelector('.dbx');
  // fill the window below the top bar
  const fit = () => { if (!root.isConnected) { window.removeEventListener('resize', fit); return; } if (window.innerWidth <= 900) { root.style.height = ''; return; } const top = root.getBoundingClientRect().top + window.scrollY; root.style.height = Math.max(520, window.innerHeight - top - 16) + 'px'; };
  window.addEventListener('resize', fit); requestAnimationFrame(fit);
  const treeEl = () => root.querySelector('[data-tree]');
  const panesEl = () => root.querySelector('[data-panes]');
  const activeTab = () => st.tabs.find(t => t.id === st.active) || null;
  const paneOf = (t) => panesEl().querySelector(`[data-pane="${t.id}"]`);
  const curPane = () => { const t = activeTab(); return t ? paneOf(t) : panesEl(); };
  const mainEl = curPane;

  // ---------- data loading ----------
  async function loadContainers() {
    try { const r = await API.get('/databases'); st.containers = r.containers; }
    catch (e) { if (alive()) { treeEl().innerHTML = `<div class="dbx-msg err">${esc(e.message)}</div>`; panesEl().innerHTML = `<div class="dbx-pane on">${UI.errorState(e, { title: 'Databases could not be loaded' })}</div>`; } return false; }
    return true;
  }
  async function ensureInfo(c, force) {
    if (st.infos[c] && !force) return st.infos[c];
    const cont = st.containers.find(x => x.name === c);
    if (!cont || cont.state !== 'running') { st.infoErr[c] = `${c} is ${cont ? cont.state : 'missing'} — start the container to open it`; return null; }
    st.loading.add(`c|${c}`); drawTree();
    try { st.infos[c] = await API.get(`${baseOf(c)}/info`); delete st.infoErr[c]; }
    catch (e) { st.infoErr[c] = e.message; delete st.infos[c]; }
    st.loading.delete(`c|${c}`);
    if (st.c === c) st.info = st.infos[c] || null;
    drawTree(); drawStatus();
    return st.infos[c] || null;
  }
  async function reloadInfo(c) { return ensureInfo(c, true); }
  async function ensureObjects(c, db, force) {
    const k = `${c}|${db}`;
    if (st.objects[k] && !force) return st.objects[k];
    st.loading.add(`d|${k}`); drawTree();
    try { st.objects[k] = await API.get(`${dbBaseOf(c, db)}/objects`); }
    catch (e) { st.objects[k] = { error: e.message, relations: [], functions: [] }; }
    st.loading.delete(`d|${k}`); drawTree();
    return st.objects[k];
  }
  async function ensureStruct(c, db, s, t, force) {
    const k = `${c}|${db}|${s}|${t}`;
    if (st.structs[k] && !force) return st.structs[k];
    st.loading.add(`t|${k}`); drawTree();
    try { st.structs[k] = await API.get(`${dbBaseOf(c, db)}/structure?schema=${enc(s)}&table=${enc(t)}`); }
    catch (e) { st.structs[k] = { error: e.message }; }
    st.loading.delete(`t|${k}`); drawTree();
    return st.structs[k];
  }
  function forgetDb(c, db) { const k = `${c}|${db}`; delete st.objects[k]; Object.keys(st.structs).forEach(x => { if (x.startsWith(k + '|')) delete st.structs[x]; }); }

  // ---------- Explorer ----------
  const saveOpen = () => lsSet('open', [...st.open].slice(-400));
  function row(key, depth, { icon, label, meta = '', open = null, title = '', cls = '', iconCls = '' }) {
    const tw = open == null ? '<span class="dbx-tw leaf"></span>' : `<span class="dbx-tw ${open ? 'open' : ''}" data-tw>${IC.chev}</span>`;
    return `<div class="dbx-n ${st.sel === key ? 'sel' : ''} ${cls}" data-k="${esc(key)}" style="padding-left:${6 + depth * 14}px" title="${esc(title)}">${tw}<span class="dbx-ic ${iconCls}">${icon}</span><span class="dbx-lb">${label}</span>${meta ? `<span class="dbx-meta">${meta}</span>` : ''}</div>`;
  }
  const msg = (depth, text, err) => `<div class="dbx-msg ${err ? 'err' : ''}" style="padding-left:${26 + depth * 14}px">${text}</div>`;
  function drawTree() {
    if (!treeEl()) return;
    const q = st.filter.trim().toLowerCase();
    const hit = (n) => !q || String(n).toLowerCase().includes(q);
    let h = '';
    if (!st.containers.length) h = `<div class="dbx-msg" style="padding:10px 12px">No PostgreSQL container on this server. DockGate finds containers of the postgres, postgis, timescaledb, pgvector, supabase/postgres and bitnami/postgresql images — pick another server in the top bar, or deploy one from Deploy → App templates.</div>`;
    for (const c of st.containers) {
      const ck = `c|${c.name}`; const co = st.open.has(ck); const info = st.infos[c.name];
      h += row(ck, 0, { icon: IC.server, iconCls: c.state === 'running' ? 'c-on' : 'c-off', label: esc(c.name), meta: c.state !== 'running' ? esc(c.state) : info ? `PG ${esc(String(info.serverVersion).split(' ')[0])}` : '', open: co, title: `${c.name} · ${c.image || ''} · ${c.state}` });
      if (!co) continue;
      if (st.loading.has(ck)) { h += msg(1, 'Connecting…'); continue; }
      if (st.infoErr[c.name]) { h += msg(1, `⚠ ${esc(st.infoErr[c.name]).slice(0, 220)}`, true) + `<div class="dbx-msg" style="padding-left:40px"><a href="#" data-conn="${esc(c.name)}">Connection settings…</a></div>`; continue; }
      if (!info) continue;
      for (const d of info.databases.filter(x => x.connect)) {
        const dk = `d|${c.name}|${d.name}`; const dop = st.open.has(dk); const ok = `${c.name}|${d.name}`; const obj = st.objects[ok];
        h += row(dk, 1, { icon: IC.db, label: esc(d.name), meta: d.size != null ? formatBytes(d.size) : '', open: dop });
        if (!dop) continue;
        if (st.loading.has(`d|${ok}`)) { h += msg(2, 'Loading…'); continue; }
        if (!obj) continue;
        if (obj.error) { h += msg(2, `⚠ ${esc(obj.error)}`, true); continue; }
        const schemas = [...new Set([...obj.relations.map(r => r.schema), ...obj.functions.map(f => f.schema)])].sort((a, b) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)));
        if (!schemas.length) h += msg(2, 'No tables yet.');
        for (const s of schemas) {
          const sk = `s|${c.name}|${d.name}|${s}`; const so = st.open.has(sk) || !!q;
          const rels = obj.relations.filter(r => r.schema === s); const fns = obj.functions.filter(f => f.schema === s);
          if (q && !rels.some(r => hit(r.name)) && !fns.some(f => hit(f.name))) continue;
          h += row(sk, 2, { icon: IC.schema, label: esc(s), meta: `${rels.length}`, open: so });
          if (!so) continue;
          for (const [fk, flabel, test] of FOLDERS) {
            const items = rels.filter(test).filter(r => hit(r.name)).sort((a, b) => a.name.localeCompare(b.name));
            if (!items.length && (q || fk !== 'tables')) continue;
            const fkey = `f|${c.name}|${d.name}|${s}|${fk}`; const fo = st.open.has(fkey) || !!q;
            h += row(fkey, 3, { icon: IC.folder, label: `${flabel}`, meta: `${items.length}`, open: fo, cls: 'dim' });
            if (!fo) continue;
            if (!items.length) h += msg(4, 'None.');
            for (const r of items) {
              const tk = `t|${c.name}|${d.name}|${s}|${r.name}`; const to = st.open.has(tk) && r.kind !== 'S';
              h += row(tk, 4, { icon: relIcon(r.kind), label: esc(r.name), meta: r.kind === 'S' || r.kind === 'v' ? '' : `${r.rows >= 0 ? '≈' + Number(r.rows).toLocaleString() + ' · ' : ''}${formatBytes(r.size)}`, open: r.kind === 'S' ? null : to, title: `${s}.${r.name} — ${kindName[r.kind] || r.kind}` });
              if (!to) continue;
              const skey = `${c.name}|${d.name}|${s}|${r.name}`;
              if (st.loading.has(`t|${skey}`)) { h += msg(5, 'Loading…'); continue; }
              const x = st.structs[skey]; if (!x) continue;
              if (x.error) { h += msg(5, `⚠ ${esc(x.error)}`, true); continue; }
              const fkCols = new Set(); (x.constraints || []).filter(k => k.type === 'f').forEach(k => { const m = /FOREIGN KEY \(([^)]+)\)/.exec(k.def || ''); if (m) m[1].split(',').forEach(n => fkCols.add(n.trim().replace(/^"|"$/g, ''))); });
              const groups = [['cols', 'Columns', x.columns || []], ['idx', 'Indexes', x.indexes || []], ['fks', 'Foreign keys', (x.constraints || []).filter(k => k.type === 'f')], ['trg', 'Triggers', x.triggers || []]];
              for (const [gk, gl, list] of groups) {
                if (!list.length && gk !== 'cols') continue;
                const gkey = `g|${skey}|${gk}`; const go = gk === 'cols' ? !st.open.has(gkey + '|closed') : st.open.has(gkey);
                h += row(gkey, 5, { icon: IC.folder, label: gl, meta: `${list.length}`, open: go, cls: 'dim' });
                if (!go) continue;
                if (gk === 'cols') list.forEach(col => { h += row(`k|${skey}|${col.name}`, 6, { icon: (x.pk || []).includes(col.name) ? IC.key : fkCols.has(col.name) ? IC.fk : IC.col, label: esc(col.name), meta: `${esc(col.type)}${col.notnull ? ' · not null' : ''}`, title: `${col.name} ${col.type}${col.default ? ' default ' + col.default : ''}${col.comment ? ' — ' + col.comment : ''}` }); });
                if (gk === 'idx') list.forEach(i => { h += row(`i|${skey}|${i.name}`, 6, { icon: IC.idx, label: esc(i.name), meta: i.primary ? 'primary' : i.unique ? 'unique' : '', title: i.def }); });
                if (gk === 'fks') list.forEach(k => { h += row(`x|${skey}|${k.name}`, 6, { icon: IC.fk, label: esc(k.name), meta: esc((/REFERENCES ([^\s(]+)/.exec(k.def || '') || [])[1] || ''), title: k.def }); });
                if (gk === 'trg') list.forEach(tg => { h += row(`r|${skey}|${tg.name}`, 6, { icon: IC.trg, label: esc(tg.name), meta: tg.enabled ? '' : 'disabled', title: tg.def }); });
              }
            }
          }
          const fl = fns.filter(f => hit(f.name));
          if (fl.length) {
            const fkey = `f|${c.name}|${d.name}|${s}|fns`; const fo = st.open.has(fkey) || !!q;
            h += row(fkey, 3, { icon: IC.folder, label: 'Functions', meta: `${fl.length}`, open: fo, cls: 'dim' });
            if (fo) fl.forEach((f, n) => { h += row(`n|${c.name}|${d.name}|${s}|${n}|${f.name}`, 4, { icon: IC.fn, label: `${esc(f.name)}<span class="dbx-meta" style="margin-left:2px">(${esc(f.args)})</span>`, meta: esc(f.result), title: `${f.name}(${f.args}) → ${f.result}` }); });
          }
        }
      }
    }
    const top = treeEl().scrollTop; treeEl().innerHTML = h; treeEl().scrollTop = top;
  }
  const parts = (key) => key.split('|');
  async function toggle(key, force) {
    const isOpen = key.startsWith('g|') && key.endsWith('|cols') ? !st.open.has(key + '|closed') : st.open.has(key);
    const want = force == null ? !isOpen : force;
    if (key.startsWith('g|') && key.endsWith('|cols')) { if (want) st.open.delete(key + '|closed'); else st.open.add(key + '|closed'); }
    else if (want) st.open.add(key); else st.open.delete(key);
    saveOpen(); drawTree();
    if (!want) return;
    const p = parts(key);
    if (p[0] === 'c') await ensureInfo(p[1]);
    if (p[0] === 'd') {
      const o = await ensureObjects(p[1], p[2]);
      const seen = new Set(lsGet('seenDb', []));
      if (o && !o.error && !seen.has(`${p[1]}|${p[2]}`)) { // the first time: show public → Tables at once
        seen.add(`${p[1]}|${p[2]}`); lsSet('seenDb', [...seen].slice(-200));
        const sch = o.relations.some(r => r.schema === 'public') ? 'public' : (o.relations[0] || {}).schema;
        if (sch) { st.open.add(`s|${p[1]}|${p[2]}|${sch}`); st.open.add(`f|${p[1]}|${p[2]}|${sch}|tables`); saveOpen(); drawTree(); }
      }
    }
    if (p[0] === 't') await ensureStruct(p[1], p[2], p[3], p[4]);
  }
  function select(key) { st.sel = key; treeEl().querySelectorAll('.dbx-n.sel').forEach(x => x.classList.remove('sel')); const n = treeEl().querySelector(`[data-k="${CSS.escape(key)}"]`); if (n) n.classList.add('sel'); }
  const relOf = (c, db, s, t) => { const o = st.objects[`${c}|${db}`]; return o && o.relations ? o.relations.find(r => r.schema === s && r.name === t) : null; };
  function nodeOpen(key, pin) {
    const p = parts(key);
    if (p[0] === 't') { const r = relOf(p[1], p[2], p[3], p[4]); return openTab({ type: r && r.kind === 'S' ? 'design' : 'data', c: p[1], db: p[2], s: p[3], t: p[4] }, { pin }); }
    if (p[0] === 'n') return showFunction(p[1], p[2], p[3], p[5]);
    if (p[0] === 'k' || p[0] === 'i' || p[0] === 'x' || p[0] === 'r') return openTab({ type: 'design', c: p[1], db: p[2], s: p[3], t: p[4] }, { pin });
    if (p[0] === 'd' && pin) return openTab({ type: 'overview', c: p[1], db: p[2] }, { pin: true });
    return null;
  }
  treeEl().addEventListener('click', (e) => {
    const a = e.target.closest('[data-conn]'); if (a) { e.preventDefault(); return connection(a.dataset.conn); }
    const n = e.target.closest('.dbx-n'); if (!n) return;
    const key = n.dataset.k; select(key);
    const p = parts(key);
    if (e.target.closest('[data-tw]') || ['c', 'd', 's', 'f', 'g'].includes(p[0])) return toggle(key);
    nodeOpen(key, false);
  });
  treeEl().addEventListener('dblclick', (e) => { const n = e.target.closest('.dbx-n'); if (!n || e.target.closest('[data-tw]')) return; const p = parts(n.dataset.k); if (p[0] === 'd') { toggle(n.dataset.k, true); nodeOpen(n.dataset.k, true); } else if (!['c', 's', 'f', 'g'].includes(p[0])) nodeOpen(n.dataset.k, true); });
  treeEl().addEventListener('contextmenu', (e) => { const n = e.target.closest('.dbx-n'); if (!n) return; e.preventDefault(); select(n.dataset.k); nodeMenu(n.dataset.k, e.clientX, e.clientY); });
  treeEl().addEventListener('keydown', (e) => {
    const nodes = [...treeEl().querySelectorAll('.dbx-n')]; if (!nodes.length) return;
    let i = nodes.findIndex(x => x.dataset.k === st.sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, Math.min(nodes.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); select(nodes[i].dataset.k); nodes[i].scrollIntoView({ block: 'nearest' }); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0) { const k = nodes[i].dataset.k; if (nodes[i].querySelector('[data-tw]')) toggle(k, e.key === 'ArrowRight'); }
    else if (e.key === 'Enter' && i >= 0) { const k = nodes[i].dataset.k; if (nodes[i].querySelector('[data-tw]') && !k.startsWith('t|')) toggle(k); else nodeOpen(k, true); }
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && i >= 0) { e.preventDefault(); const r = nodes[i].getBoundingClientRect(); nodeMenu(nodes[i].dataset.k, r.left + 40, r.bottom); }
  });
  root.querySelector('[data-x-find]').addEventListener('input', (e) => { st.filter = e.target.value; drawTree(); });
  root.querySelector('[data-x-collapse]').onclick = () => { st.open.clear(); saveOpen(); drawTree(); };
  root.querySelector('[data-x-refresh]').onclick = () => refreshAll();
  root.querySelector('[data-x-newq]').onclick = () => { const t = activeTab(); const c = t ? t.c : (st.containers.find(x => x.state === 'running') || {}).name; if (!c) return; const info = st.infos[c]; newQuery(c, t && t.db ? t.db : info ? info.database : null); };
  async function refreshAll() {
    const keepOpen = [...st.open];
    st.infos = {}; st.infoErr = {}; st.objects = {}; st.structs = {};
    if (!(await loadContainers())) return;
    drawTree();
    for (const k of keepOpen) { const p = parts(k); if (p[0] === 'c') await ensureInfo(p[1]); }
    for (const k of keepOpen) { const p = parts(k); if (p[0] === 'd' && st.infos[p[1]]) await ensureObjects(p[1], p[2]); }
    for (const k of keepOpen) { const p = parts(k); if (p[0] === 't' && st.objects[`${p[1]}|${p[2]}`]) await ensureStruct(p[1], p[2], p[3], p[4]); }
    const t = activeTab(); if (t) st.info = st.infos[t.c] || null;
    drawStatus();
  }
  // the splitter
  (() => {
    const sp = root.querySelector('[data-split]'); let x0 = 0, w0 = 0;
    const move = (e) => { const w = Math.max(200, Math.min(560, w0 + e.clientX - x0)); root.style.setProperty('--dbx-w', w + 'px'); };
    const up = (e) => { sp.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); lsSet('w', parseInt(getComputedStyle(root).getPropertyValue('--dbx-w'), 10) || 290); };
    sp.addEventListener('mousedown', (e) => { e.preventDefault(); x0 = e.clientX; w0 = root.querySelector('.dbx-exp').getBoundingClientRect().width; sp.classList.add('drag'); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
  })();

  // ---------- context menus ----------
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', escKey, true); }
  const outside = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
  const escKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  function showMenu(x, y, items) {
    closeMenu();
    menuEl = document.createElement('div'); menuEl.className = 'dbx-menu'; menuEl.setAttribute('role', 'menu');
    menuEl.innerHTML = items.filter(Boolean).map((it, i) => it === '-' ? '<div class="dbx-ms"></div>' : it.header ? `<div class="dbx-mh">${esc(it.header)}</div>` : `<button type="button" role="menuitem" class="dbx-mi ${it.danger ? 'danger' : ''}" data-mi="${i}" ${it.disabled ? 'disabled' : ''} title="${esc(it.title || '')}">${esc(it.label)}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`).join('');
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    const list = items.filter(Boolean);
    menuEl.querySelectorAll('[data-mi]').forEach(b => b.onclick = () => { const it = list[Number(b.dataset.mi)]; closeMenu(); try { const p = it.act(); if (p && p.catch) p.catch(e => showToast(e.message, 'error', 8000)); } catch (e) { showToast(e.message, 'error', 8000); } });
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', escKey, true); }, 0);
    const first = menuEl.querySelector('.dbx-mi:not([disabled])'); if (first) first.focus();
  }
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => showToast('Copied', 'success', 1500));
  function nodeMenu(key, x, y) {
    const p = parts(key);
    if (p[0] === 'c') {
      const c = p[1]; const info = st.infos[c];
      return showMenu(x, y, [{ header: c },
        { label: 'New query', kbd: '', act: async () => { const i = await ensureInfo(c); if (i) newQuery(c, i.database); } },
        { label: 'Refresh', act: async () => { Object.keys(st.objects).forEach(k => { if (k.startsWith(c + '|')) forgetDb(c, k.split('|')[1]); }); await reloadInfo(c); } },
        '-',
        { label: 'Users, sessions and databases', act: async () => { const i = await ensureInfo(c); if (i) openTab({ type: 'admin', c, db: i.database }, { pin: true }); } },
        { label: 'Backups', act: () => openTab({ type: 'backups', c }, { pin: true }) },
        { label: 'Connection settings…', act: () => connection(c) },
        '-',
        info ? { label: info.allowWrite ? 'Make it read-only' : 'Allow changes…', act: () => toggleWrite(c) } : null]);
    }
    if (p[0] === 'd') {
      const [, c, db] = p;
      return showMenu(x, y, [{ header: `${c} › ${db}` },
        { label: 'New query', act: () => newQuery(c, db) },
        { label: 'Open — tables, sizes, rows', act: () => openTab({ type: 'overview', c, db }, { pin: true }) },
        { label: 'New table…', act: () => newTable(c, db, 'public') },
        { label: 'Refresh', act: () => { forgetDb(c, db); return ensureObjects(c, db, true); } },
        '-',
        { label: 'Users, sessions, VACUUM', act: () => openTab({ type: 'admin', c, db }, { pin: true }) },
        { label: 'Backups', act: () => openTab({ type: 'backups', c }, { pin: true }) },
        '-', { label: 'Copy name', act: () => copy(db) }]);
    }
    if (p[0] === 's') {
      const [, c, db, s] = p;
      return showMenu(x, y, [{ header: `${db} › ${s}` }, { label: 'New query', act: () => newQuery(c, db, `SET search_path TO ${quoteId(s)};\n\n`) }, { label: 'New table…', act: () => newTable(c, db, s) }, { label: 'Refresh', act: () => { forgetDb(c, db); return ensureObjects(c, db, true); } }, '-', { label: 'Copy name', act: () => copy(s) }]);
    }
    if (p[0] === 'f') {
      const [, c, db, s, kind] = p;
      return showMenu(x, y, [kind === 'tables' ? { label: 'New table…', act: () => newTable(c, db, s) } : null, { label: 'Refresh', act: () => { forgetDb(c, db); return ensureObjects(c, db, true); } }]);
    }
    if (p[0] === 't') {
      const [, c, db, s, t] = p; const r = relOf(c, db, s, t) || { kind: 'r' }; const isTable = r.kind === 'r' || r.kind === 'p'; const isSeq = r.kind === 'S';
      const w = !!(st.infos[c] && st.infos[c].allowWrite);
      return showMenu(x, y, [{ header: `${s}.${t} — ${kindName[r.kind] || 'table'}` },
        isSeq ? null : { label: 'Open data', kbd: 'click', act: () => openTab({ type: 'data', c, db, s, t }, { pin: false }) },
        isSeq ? null : { label: 'Open in a new tab', kbd: 'double-click', act: () => openTab({ type: 'data', c, db, s, t }, { pin: true, fresh: true }) },
        { label: 'Design — columns, indexes, keys', act: () => openTab({ type: 'design', c, db, s, t }, { pin: true }) },
        '-',
        isSeq ? null : { label: 'New query: SELECT', act: () => genSql('select', c, db, s, t) },
        isTable ? { label: 'New query: INSERT', act: () => genSql('insert', c, db, s, t) } : null,
        isTable ? { label: 'New query: UPDATE', act: () => genSql('update', c, db, s, t) } : null,
        isTable ? { label: 'New query: DELETE', act: () => genSql('delete', c, db, s, t) } : null,
        r.kind === 'v' || r.kind === 'm' ? { label: 'New query: view definition', act: () => newQuery(c, db, `SELECT pg_get_viewdef('${qn(s, t).replace(/'/g, "''")}'::regclass, true);\n`) } : null,
        '-',
        isSeq ? null : { label: 'Count rows', act: () => countRows(c, db, s, t) },
        isSeq ? null : { label: 'Export CSV', act: () => { window.location.href = `/api${dbBaseOf(c, db)}/export?schema=${enc(s)}&table=${enc(t)}&format=csv`; } },
        isSeq ? null : { label: 'Export JSON lines', act: () => { window.location.href = `/api${dbBaseOf(c, db)}/export?schema=${enc(s)}&table=${enc(t)}&format=json`; } },
        { label: 'Copy name', act: () => copy(qn(s, t)) },
        isTable || r.kind === 'm' ? '-' : null,
        isTable ? { label: 'VACUUM ANALYZE', disabled: !w, title: w ? '' : 'Allow changes first', act: () => withCtx(c, db, () => maintain('vacuum', s, t)) } : null,
        isTable || r.kind === 'm' ? { label: r.kind === 'm' ? 'REFRESH MATERIALIZED VIEW' : 'ANALYZE', disabled: !w, title: w ? '' : 'Allow changes first', act: () => (r.kind === 'm' ? runDanger(c, db, `REFRESH MATERIALIZED VIEW ${qn(s, t)}`, `Refresh ${s}.${t}?`, null) : withCtx(c, db, () => maintain('analyze', s, t))) } : null,
        '-',
        isTable ? { label: 'Empty (TRUNCATE)…', danger: true, disabled: !w, title: w ? '' : 'Allow changes first', act: () => runDanger(c, db, `TRUNCATE TABLE ${qn(s, t)}`, `Delete <b>every row</b> of <span class="td-mono">${esc(s)}.${esc(t)}</span>? This can not be undone.`, t) } : null,
        { label: `Drop ${kindName[r.kind] || 'table'}…`, danger: true, disabled: !w, title: w ? '' : 'Allow changes first', act: () => runDanger(c, db, `DROP ${r.kind === 'v' ? 'VIEW' : r.kind === 'm' ? 'MATERIALIZED VIEW' : r.kind === 'S' ? 'SEQUENCE' : r.kind === 'f' ? 'FOREIGN TABLE' : 'TABLE'} ${qn(s, t)}`, `Drop <span class="td-mono">${esc(s)}.${esc(t)}</span> and its data? Objects that depend on it make it fail (nothing is dropped then).`, t, { drop: { c, db, s, t } }) }]);
    }
    if (p[0] === 'k') {
      const [, c, db, s, t, col] = p;
      return showMenu(x, y, [{ header: `${t}.${col}` }, { label: 'Copy name', act: () => copy(col) }, { label: 'New query: SELECT this column', act: () => newQuery(c, db, `SELECT ${quoteId(col)}, count(*)\nFROM ${qn(s, t)}\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT 100;\n`) }, { label: 'Design', act: () => openTab({ type: 'design', c, db, s, t }, { pin: true }) }]);
    }
    if (p[0] === 'n') {
      const [, c, db, s, , fname] = p;
      return showMenu(x, y, [{ header: `${s}.${fname}()` }, { label: 'Show the definition', act: () => showFunction(c, db, s, fname) }, { label: 'Copy name', act: () => copy(`${quoteId(s)}.${quoteId(fname)}`) }]);
    }
    if (p[0] === 'i' || p[0] === 'x' || p[0] === 'r') {
      const [, c, db, s, t, name] = p;
      return showMenu(x, y, [{ header: name }, { label: 'Copy name', act: () => copy(name) }, { label: 'Design', act: () => openTab({ type: 'design', c, db, s, t }, { pin: true }) }]);
    }
    return null;
  }

  // ---------- actions ----------
  async function withCtx(c, db, fn) { const prev = { c: st.c, db: st.db, info: st.info }; st.c = c; st.db = db; st.info = await ensureInfo(c); try { return await fn(); } finally { const t = activeTab(); if (t) { st.c = t.c; st.db = t.db; st.info = st.infos[t.c] || null; } else Object.assign(st, prev); } }
  function newQuery(c, db, sql = '', title) {
    if (!c || !db) return showToast('Open a database first', 'info');
    const n = st.tabs.filter(t => t.type === 'sql').length + 1;
    return openTab({ type: 'sql', c, db, wb: rid(), title: title || `Query ${n}`, sql: sql || `-- ${db}\nSELECT now();\n` }, { pin: true, fresh: true });
  }
  function newTable(c, db, s) { return openTab({ type: 'create', c, db, s: s || 'public' }, { pin: true, fresh: true }); }
  async function genSql(kind, c, db, s, t) {
    const x = await ensureStruct(c, db, s, t);
    if (!x || x.error) throw new Error(x ? x.error : 'Could not read the table');
    const q = qn(s, t); const cols = x.columns || []; const pk = (x.pk && x.pk.length ? x.pk : cols.slice(0, 1).map(k => k.name));
    const writable = cols.filter(k => !k.generated && k.identity !== 'a');
    const where = pk.map(k => `${quoteId(k)} = NULL /* ${(cols.find(y => y.name === k) || {}).type || ''} */`).join('\n  AND ');
    const sql = {
      select: `SELECT ${cols.map(k => quoteId(k.name)).join(', ') || '*'}\nFROM ${q}\nLIMIT 100;\n`,
      insert: `INSERT INTO ${q} (${writable.map(k => quoteId(k.name)).join(', ')})\nVALUES (\n${writable.map((k, i) => `  ${k.default ? 'DEFAULT' : 'NULL'}${i < writable.length - 1 ? ',' : ' '} -- ${k.name} ${k.type}${k.notnull ? ' not null' : ''}`).join('\n')}\n)\nRETURNING *;\n`,
      update: `UPDATE ${q}\nSET ${writable.filter(k => !pk.includes(k.name)).map(k => `${quoteId(k.name)} = ${quoteId(k.name)}`).join(',\n    ')}\nWHERE ${where}\nRETURNING *;\n`,
      delete: `DELETE FROM ${q}\nWHERE ${where}\nRETURNING *;\n`,
    }[kind];
    return newQuery(c, db, sql, `${kind.toUpperCase()} ${t}`);
  }
  async function showFunction(c, db, s, fname) {
    return newQuery(c, db, `SELECT pg_get_functiondef(p.oid) AS definition\nFROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\nWHERE n.nspname = '${s.replace(/'/g, "''")}' AND p.proname = '${fname.replace(/'/g, "''")}';\n`, `ƒ ${fname}`);
  }
  async function countRows(c, db, s, t) {
    showToast(`Counting ${s}.${t}…`, 'info', 2000);
    const r = await API.post(`${dbBaseOf(c, db)}/count`, { schema: s, table: t });
    showToast(`${s}.${t}: ${Number(r.count).toLocaleString()} rows`, 'success', 6000);
  }
  async function runDanger(c, db, sql, message, phrase, { drop } = {}) {
    const info = await ensureInfo(c);
    if (!info || !info.allowWrite) return showToast('Allow changes first (status bar or the container menu)', 'info', 5000);
    const go = async () => {
      try {
        const r = await API.post(`${dbBaseOf(c, db)}/sql`, { sql, confirm: true });
        if (r.error) throw new Error(r.error.message);
        showToast(`Done: ${sql.split(' ').slice(0, 3).join(' ')}`, 'success');
        if (drop) { st.tabs.filter(x => x.c === drop.c && x.db === drop.db && x.s === drop.s && x.t === drop.t).forEach(x => closeTab(x.id, true)); }
        forgetDb(c, db); await ensureObjects(c, db, true);
        st.tabs.filter(x => x.c === c && x.db === db && (x.type === 'data' || x.type === 'overview') && x.inst && x.inst.reload).forEach(x => x.inst.reload());
        st.tabs.filter(x => x.c === c && x.db === db && x.type === 'overview' && x.id === st.active).forEach(x => renderTab(x, true));
      } catch (e) { showToast(e.message, 'error', 10000); }
    };
    if (phrase) showDeleteConfirm(sql.split(' ').slice(0, 2).join(' '), { message: `${message}<pre class="td-mono" style="font-size:12px;margin:8px 0 0">${esc(sql)}</pre>`, phrase, confirmLabel: 'Run', onConfirm: go });
    else showConfirm('Run', `${message}<pre class="td-mono" style="font-size:12px;margin:8px 0 0">${esc(sql)}</pre>`, go);
  }

  // ---------- tabs ----------
  const keyOf = (t) => (t.type === 'sql' ? `sql|${t.wb}` : t.type === 'create' ? `create|${t.id}` : t.type === 'backups' ? `backups|${t.c}` : t.type === 'data' || t.type === 'design' ? `${t.type}|${t.c}|${t.db}|${t.s}|${t.t}` : `${t.type}|${t.c}|${t.db}`);
  const tabIcon = (t) => ({ data: relIcon((relOf(t.c, t.db, t.s, t.t) || {}).kind), design: IC.design, create: IC.plus, sql: IC.sql, overview: IC.db, admin: IC.admin, backups: IC.backup }[t.type] || IC.table);
  const tabTitle = (t) => (t.type === 'create' ? 'New table' : t.type === 'data' ? t.t : t.type === 'design' ? `${t.t}` : t.type === 'sql' ? t.title : t.type === 'overview' ? t.db : t.type === 'admin' ? `Admin · ${t.db}` : `Backups · ${t.c}`);
  const tabSub = (t) => (t.type === 'design' ? 'design' : t.type === 'sql' || t.type === 'overview' || t.type === 'create' ? t.db : t.type === 'data' ? (t.s !== 'public' ? t.s : '') : '');
  function persistTabs() {
    lsSet('tabs', st.tabs.map(t => ({ id: t.id, type: t.type, c: t.c, db: t.db, s: t.s, t: t.t, wb: t.wb, title: t.title, preview: !!t.preview, grid: t.grid ? { limit: t.grid.limit, sort: t.grid.sort, filters: t.grid.filters, where: t.grid.where } : undefined })));
    lsSet('active', st.active);
    const a = activeTab();
    Router.updateParams({ tab: 'databases', ...(a ? { c: a.c, ...(a.db ? { db: a.db } : {}), ...(a.t ? { s: a.s, t: a.t } : {}), view: a.type } : {}) });
  }
  const freshGrid = (g) => ({ offset: 0, limit: (g && g.limit) || 100, sort: (g && g.sort) || [], filters: (g && g.filters) || [], where: (g && g.where) || '', sel: new Set() });
  async function openTab(spec, { pin = false, fresh = false } = {}) {
    const t0 = { id: rid(), preview: !pin, ...spec };
    if (t0.type === 'data') t0.grid = freshGrid(spec.grid);
    if (t0.type === 'sql') t0.preview = false;
    const same = !fresh && st.tabs.find(t => keyOf(t) === keyOf(t0));
    if (same) { if (pin) same.preview = false; if (spec.grid && same.inst && same.grid) { Object.assign(same.grid, freshGrid(spec.grid)); same.inst.reload && same.inst.reload(); } return activate(same.id); }
    const pv = !pin ? st.tabs.find(t => t.preview) : null;
    if (pv && !(pv.inst && pv.inst.dirty && pv.inst.dirty())) {
      const i = st.tabs.indexOf(pv); destroyTab(pv); st.tabs.splice(i, 1, t0);
    } else {
      const i = st.tabs.findIndex(t => t.id === st.active);
      st.tabs.splice(i < 0 ? st.tabs.length : i + 1, 0, t0);
    }
    return activate(t0.id);
  }
  function destroyTab(t) { try { if (t.inst && t.inst.destroy) t.inst.destroy(); } catch (e) {} t.inst = null; const p = paneOf(t); if (p) p.remove(); }
  async function closeTab(id, force) {
    const t = st.tabs.find(x => x.id === id); if (!t) return;
    if (!force && t.inst && t.inst.dirty && t.inst.dirty()) return activate(id).then(() => t.inst.guardLeave(() => closeTab(id, true)));
    if (!force && t.type === 'sql' && t.inst && t.inst.close) { if (!(await t.inst.close())) return; }
    else if (t.type === 'sql' && !t.inst) API.del(`${baseOf(t.c)}/tabs/${t.wb}`).catch(() => {});
    const i = st.tabs.indexOf(t);
    destroyTab(t); st.tabs.splice(i, 1);
    if (st.active === id) { const n = st.tabs[i] || st.tabs[i - 1]; st.active = n ? n.id : null; if (n) return activate(n.id); }
    drawTabs(); drawStatus(); persistTabs(); if (!st.tabs.length) drawWelcome();
  }
  async function activate(id) {
    const t = st.tabs.find(x => x.id === id); if (!t) return;
    st.active = id;
    st.c = t.c; st.db = t.db || null; st.s = t.s || null; st.t = t.t || null; st.view = t.type;
    const w = panesEl().querySelector('[data-welcome]'); if (w) w.remove();
    panesEl().querySelectorAll('.dbx-pane').forEach(p => p.classList.remove('on'));
    let pane = paneOf(t);
    const isNew = !pane;
    if (!pane) { pane = document.createElement('div'); pane.className = 'dbx-pane'; pane.dataset.pane = t.id; panesEl().appendChild(pane); }
    pane.classList.add('on');
    drawTabs(); persistTabs();
    st.info = await ensureInfo(t.c);
    if (st.active !== id) return;
    drawStatus();
    if (t.db && st.open.has(`d|${t.c}|${t.db}`) && !st.objects[`${t.c}|${t.db}`]) ensureObjects(t.c, t.db);
    if (t.t) { const k = `t|${t.c}|${t.db}|${t.s}|${t.t}`; select(k); }
    if (isNew) await renderTab(t);
    else if (t.inst && t.inst.focus) t.inst.focus();
  }
  function drawTabs() {
    const el = root.querySelector('[data-tabs]');
    el.innerHTML = st.tabs.map(t => `<div class="dbx-tab ${t.id === st.active ? 'on' : ''} ${t.preview ? 'pv' : ''}" role="tab" aria-selected="${t.id === st.active}" data-tab="${t.id}" title="${esc(`${t.c}${t.db ? ' › ' + t.db : ''}${t.t ? ' › ' + t.s + '.' + t.t : ''}${t.preview ? ' — preview (double-click to keep)' : ''}`)}"><span class="dbx-ic">${tabIcon(t)}</span><span class="dbx-tt">${esc(tabTitle(t))}</span>${tabSub(t) ? `<span class="dbx-tsub">${esc(tabSub(t))}</span>` : ''}<button type="button" class="dbx-x" data-close="${t.id}" title="Close">×</button></div>`).join('');
    const on = el.querySelector('.dbx-tab.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const tabsEl = root.querySelector('[data-tabs]');
  tabsEl.addEventListener('click', (e) => { const x = e.target.closest('[data-close]'); if (x) { e.stopPropagation(); return closeTab(x.dataset.close); } const t = e.target.closest('[data-tab]'); if (t) activate(t.dataset.tab); });
  tabsEl.addEventListener('auxclick', (e) => { if (e.button !== 1) return; const t = e.target.closest('[data-tab]'); if (t) { e.preventDefault(); closeTab(t.dataset.tab); } });
  tabsEl.addEventListener('dblclick', (e) => { const t = e.target.closest('[data-tab]'); if (!t) return; const x = st.tabs.find(y => y.id === t.dataset.tab); if (!x) return; if (x.preview) { x.preview = false; drawTabs(); persistTabs(); } else if (x.type === 'sql') { const n = prompt('Query name', x.title); if (n && n.trim()) { x.title = n.trim().slice(0, 60); drawTabs(); persistTabs(); } } });
  tabsEl.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-tab]'); if (!el) return; e.preventDefault();
    const t = st.tabs.find(y => y.id === el.dataset.tab); const i = st.tabs.indexOf(t);
    const closeMany = async (list) => { for (const x of list) await closeTab(x.id); };
    showMenu(e.clientX, e.clientY, [
      { label: 'Close', kbd: 'middle-click', act: () => closeTab(t.id) },
      { label: 'Close others', disabled: st.tabs.length < 2, act: () => closeMany(st.tabs.filter(x => x !== t)) },
      { label: 'Close to the right', disabled: i === st.tabs.length - 1, act: () => closeMany(st.tabs.slice(i + 1)) },
      { label: 'Close all', act: () => closeMany([...st.tabs]) },
      '-',
      t.preview ? { label: 'Keep open', act: () => { t.preview = false; drawTabs(); persistTabs(); } } : null,
      t.type === 'sql' ? { label: 'Rename…', act: () => { const n = prompt('Query name', t.title); if (n && n.trim()) { t.title = n.trim().slice(0, 60); drawTabs(); persistTabs(); } } } : null,
      t.type === 'data' ? { label: 'Design', act: () => openTab({ type: 'design', c: t.c, db: t.db, s: t.s, t: t.t }, { pin: true }) } : null,
      t.type === 'design' ? { label: 'Open data', act: () => openTab({ type: 'data', c: t.c, db: t.db, s: t.s, t: t.t }, { pin: true }) } : null,
      t.t ? { label: 'Reveal in Explorer', act: () => reveal(t) } : null,
    ]);
  });
  async function reveal(t) {
    for (const k of [`c|${t.c}`, `d|${t.c}|${t.db}`, `s|${t.c}|${t.db}|${t.s}`]) await toggle(k, true);
    const r = relOf(t.c, t.db, t.s, t.t); const f = FOLDERS.find(([, , test]) => r && test(r)); if (f) await toggle(`f|${t.c}|${t.db}|${t.s}|${f[0]}`, true);
    const k = `t|${t.c}|${t.db}|${t.s}|${t.t}`; select(k); const n = treeEl().querySelector(`[data-k="${CSS.escape(k)}"]`); if (n) n.scrollIntoView({ block: 'center' });
  }
  // an edit keeps a preview tab
  panesEl().addEventListener('keydown', () => { const t = activeTab(); if (t && t.preview) { t.preview = false; drawTabs(); persistTabs(); } }, true);
  panesEl().addEventListener('dblclick', () => { const t = activeTab(); if (t && t.preview) { t.preview = false; drawTabs(); persistTabs(); } }, true);

  async function renderTab(t, again) {
    const pane = paneOf(t); if (!pane) return;
    if (again && t.inst) { try { t.inst.destroy(); } catch (e) {} t.inst = null; }
    const info = st.infos[t.c];
    if (!info) { pane.innerHTML = `<div class="card" style="padding:20px"><b style="color:var(--danger)">Could not open ${esc(t.c)}</b><pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:8px 0">${esc(st.infoErr[t.c] || '')}</pre><div class="ui-sub">DockGate runs <span class="td-mono">psql</span> inside the container as the user from its POSTGRES_USER (or "postgres"). Set another user, database or password under Connection settings.</div><div style="margin-top:10px">${UI.btn('Connection settings…', 'data-conn')} ${UI.btn('Try again', 'data-retry')}</div></div>`; pane.querySelector('[data-conn]').onclick = () => connection(t.c); pane.querySelector('[data-retry]').onclick = async () => { await reloadInfo(t.c); renderTab(t); }; return; }
    if (t.type === 'data') {
      const ed = await DataEditor.mount(pane, {
        dbBase: () => dbBaseOf(t.c, t.db), schema: t.s, table: t.t, info: () => st.infos[t.c], grid: t.grid || (t.grid = freshGrid()), kindName,
        toggleWrite: () => toggleWrite(t.c), alive: () => alive() && st.tabs.includes(t),
        openTable: (schema, table, filters) => openTab({ type: 'data', c: t.c, db: t.db, s: schema, t: table, grid: { filters: filters || [] } }, { pin: true }),
        onCard: () => {},
      });
      if (st.tabs.includes(t) && alive()) t.inst = ed; else ed.destroy();
    } else if (t.type === 'sql') {
      const w = await SqlWorkbench.mount(pane, {
        base: baseOf(t.c), dbBase: () => dbBaseOf(t.c, t.db), db: () => t.db, info: () => st.infos[t.c],
        single: { id: t.wb, name: t.title, sql: t.sql }, initialSql: null,
        onSchemaChanged: () => { forgetDb(t.c, t.db); if (st.open.has(`d|${t.c}|${t.db}`)) ensureObjects(t.c, t.db, true); },
        toggleWrite: () => toggleWrite(t.c),
      });
      delete t.sql;
      if (st.tabs.includes(t) && alive()) t.inst = w; else w.destroy();
    } else if (t.type === 'design' || t.type === 'create') await drawDesign(t, pane);
    else if (t.type === 'overview') await drawOverview(t, pane);
    else if (t.type === 'admin') { await withCtx(t.c, t.db, () => drawAdmin(pane)); }
    else if (t.type === 'backups') { await withCtx(t.c, t.db || info.database, () => drawBackups(pane)); }
  }

  // ---------- welcome ----------
  function drawWelcome() {
    if (st.tabs.length) return;
    panesEl().querySelectorAll('.dbx-pane').forEach(p => p.classList.remove('on'));
    let w = panesEl().querySelector('[data-welcome]');
    if (!w) { w = document.createElement('div'); w.className = 'dbx-pane on'; w.dataset.welcome = '1'; panesEl().appendChild(w); }
    w.innerHTML = `<div class="dbx-welcome"><h3>Databases</h3><div class="ui-sub">PostgreSQL in the containers of <b>${esc((Store.get('activeServer') || {}).name || (Store.get('activeServer') || {}).host || 'this server')}</b>, reached with <span class="td-mono">docker exec … psql</span> — no port opened. Open a container on the left: a click on a table opens its data, a double-click keeps the tab, a right-click shows everything you can do.</div>
      ${st.containers.length ? `<div class="dbx-cards">${st.containers.map(c => `<div class="dbx-card" data-wc="${esc(c.name)}"><div style="display:flex;gap:8px;align-items:center"><span class="dbx-ic ${c.state === 'running' ? 'c-on' : 'c-off'}" style="color:${c.state === 'running' ? 'var(--success)' : 'var(--text-muted)'}">${IC.server}</span><b>${esc(c.name)}</b></div><div class="ui-sub" style="margin-top:4px">${esc(c.image || '')} · ${esc(c.state)}</div><div style="margin-top:8px;display:flex;gap:6px">${UI.btn('New query', `data-wq="${esc(c.name)}"`, 'btn-primary')} ${UI.btn('Open', `data-wo="${esc(c.name)}"`)}</div></div>`).join('')}</div>` : ''}
      <div class="ui-sub" style="margin-top:16px">Keys: in the Explorer ↑ ↓ move, → ← open and close, Enter opens, Shift+F10 the menu · in a query Ctrl+Enter runs the statement at the cursor, Ctrl+Shift+Enter all · middle-click closes a tab.</div></div>`;
    w.querySelectorAll('[data-wo]').forEach(b => b.onclick = (e) => { e.stopPropagation(); toggle(`c|${b.dataset.wo}`, true); });
    w.querySelectorAll('[data-wq]').forEach(b => b.onclick = async (e) => { e.stopPropagation(); const i = await ensureInfo(b.dataset.wq); if (i) newQuery(b.dataset.wq, i.database); });
    w.querySelectorAll('[data-wc]').forEach(b => b.onclick = () => toggle(`c|${b.dataset.wc}`, true));
  }

  // ---------- status bar ----------
  function drawStatus() {
    const el = root.querySelector('[data-status]'); if (!el) return;
    const t = activeTab(); const i = t ? st.infos[t.c] : null;
    if (!t) { el.innerHTML = `<span>${st.containers.length} PostgreSQL container${st.containers.length === 1 ? '' : 's'}</span>`; return; }
    el.innerHTML = `<span title="Container">${IC.server.replace('width="15" height="15"', 'width="12" height="12"')} ${esc(t.c)}</span>${t.db ? `<span>› ${esc(t.db)}</span>` : ''}${t.t ? `<span>› ${esc(t.s)}.${esc(t.t)}</span>` : ''}
      ${i ? `<span style="color:var(--text-muted)">PostgreSQL ${esc(String(i.serverVersion).split(' ')[0])} · ${esc(i.user)}${i.superuser ? ' (superuser)' : ''}</span>` : ''}
      <span style="flex:1"></span>
      ${i && i.production ? `<span style="color:var(--danger);font-weight:600">● production</span>` : ''}
      ${i ? `<button type="button" data-s-rw title="${i.allowWrite ? 'Changes are allowed — click to make it read-only' : 'Statements that change data are refused — click to allow changes'}" style="${i.allowWrite ? 'color:var(--warning)' : ''}">${i.allowWrite ? '✎ Changes allowed' : '🔒 Read-only'}</button>` : ''}
      <button type="button" data-s-conn>Connection…</button>`;
    const rw = el.querySelector('[data-s-rw]'); if (rw) rw.onclick = () => toggleWrite(t.c);
    el.querySelector('[data-s-conn]').onclick = () => connection(t.c);
  }

  // ---------- design: the table's structure, edited like a sheet (server/pg-ddl.js) ----------
  // Changes wait (yellow = changed, green = new, struck = dropped) until Save: Show SQL, 🧪 Test (rolled back),
  // Discard, Save — all in one transaction. "New table" is the same editor with a name.
  const TYPES = ['bigint', 'integer', 'smallint', 'numeric(12,2)', 'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(1)', 'uuid', 'date', 'timestamptz', 'timestamp', 'time', 'interval', 'jsonb', 'json', 'bytea', 'inet', 'cidr', 'text[]', 'integer[]', 'bigint[]'];
  const DZ_CSS = `<style>
    .dz-sub{display:flex;gap:2px;border-bottom:1px solid var(--border);margin:0 0 12px}
    .dz-sub button{border:0;background:none;color:var(--text-secondary);padding:7px 12px;cursor:pointer;font:inherit;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
    .dz-sub button.on{color:var(--text-primary);border-bottom-color:var(--accent,#3b82f6)}
    .dz-grid{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
    .dz-grid th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);padding:6px 6px;border-bottom:1px solid var(--border);white-space:nowrap;font-weight:600}
    .dz-grid td{padding:3px 4px;border-bottom:1px solid var(--border);vertical-align:middle}
    .dz-grid input[type=text]{width:100%;min-width:60px;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--text-primary);padding:4px 6px;font:inherit;font-family:var(--font-mono,monospace);font-size:12.5px}
    .dz-grid input[type=text]:hover{border-color:var(--border)} .dz-grid input[type=text]:focus{border-color:var(--accent,#3b82f6);outline:none;background:var(--bg-secondary)}
    .dz-grid tr.chg td{background:rgba(234,179,8,.08)} .dz-grid td.chg input{background:rgba(234,179,8,.16)} .dz-grid tr.new td{background:rgba(34,197,94,.09)}
    .dz-grid tr.del td{background:rgba(239,68,68,.08)} .dz-grid tr.del input{text-decoration:line-through;opacity:.6}
    .dz-grid .dz-c{text-align:center;width:1%} .dz-n{color:var(--text-muted);width:1%;text-align:right;padding-right:8px!important}
    .dz-bar{position:sticky;bottom:-14px;margin:14px -16px -14px;padding:10px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--bg-secondary);border-top:1px solid var(--border);z-index:2}
    .dz-pend{padding:6px 10px;border:1px dashed var(--success,#22c55e);border-radius:8px;margin:6px 0;display:flex;gap:8px;align-items:center;font-size:12.5px}
    .dz-pend.drop{border-color:var(--danger)} .dz-x{border:0;background:none;color:var(--text-muted);cursor:pointer;font-size:15px;padding:0 4px} .dz-x:hover{color:var(--danger)}
  </style>`;
  const dzCol = (c, pk) => ({ orig: c ? { ...c, pk: pk.includes(c.name) } : null, name: c ? c.name : '', type: c ? c.type : 'text', notnull: c ? !!c.notnull : false, default: c ? (c.default || '') : '', comment: c ? (c.comment || '') : '', identity: c ? !!c.identity : false, pk: c ? pk.includes(c.name) : false, unique: false, del: false, isNew: !c });
  function dzOps(t) {
    const z = t.dz; const ops = [];
    if (t.type === 'create') {
      const list = z.draft.filter(c => !c.del && c.name.trim());
      return [{ op: 'createTable', schema: z.schema, name: z.name.trim(), comment: z.comment || undefined, columns: list.map(c => ({ name: c.name.trim(), type: c.type, notnull: c.notnull, default: c.default, comment: c.comment, identity: c.identity, pk: c.pk, unique: c.unique })) }];
    }
    for (const c of z.draft) {
      if (c.isNew) { if (!c.del && c.name.trim()) ops.push({ op: 'addColumn', name: c.name.trim(), type: c.type, notnull: c.notnull, default: c.default || undefined, comment: c.comment || undefined, identity: c.identity, unique: c.unique }); continue; }
      const o = c.orig;
      if (c.del) { ops.push({ op: 'dropColumn', name: o.name }); continue; }
      const a = { op: 'alterColumn', name: o.name }; let any = false;
      if (c.type.trim() !== o.type) { a.type = c.type.trim(); a.using = `${quoteId(o.name)}::${c.type.trim()}`; any = true; }
      if (c.notnull !== !!o.notnull) { a.notnull = c.notnull; any = true; }
      if ((c.default || '') !== (o.default || '') && !o.identity) { a.default = c.default.trim() === '' ? null : c.default; any = true; }
      if (c.identity !== !!o.identity) { a.identity = c.identity; any = true; }
      if ((c.comment || '') !== (o.comment || '')) { a.comment = c.comment; any = true; }
      if (c.name.trim() !== o.name) { a.rename = c.name.trim(); any = true; }
      if (any) ops.push(a);
    }
    return ops.concat(z.queued.map(({ label, ...op }) => op));
  }
  const dzDirty = (t) => !!(t.dz && (t.type === 'create' || dzOps(t).length));

  async function drawDesign(t, pane) {
    const creating = t.type === 'create';
    let s = null;
    if (!creating) {
      if (!t.dz || t.dzReload) { pane.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>'; }
      s = await ensureStruct(t.c, t.db, t.s, t.t, !!t.dzReload || !t.dz);
      if (!pane.isConnected) return;
      if (!s || s.error) { pane.innerHTML = `<div class="card text-danger" style="padding:16px">${esc(s ? s.error : 'Not found')}</div>`; return; }
    }
    const editableKind = creating || s.kind === 'r' || s.kind === 'p';
    if (!t.dz || t.dzReload) {
      t.dz = creating
        ? { sub: 'cols', schema: t.s || 'public', name: '', comment: '', draft: [{ ...dzCol(null, []), name: 'id', type: 'bigint', identity: true, pk: true, notnull: true }, { ...dzCol(null, []), name: 'created_at', type: 'timestamptz', default: 'now()', notnull: true }, { ...dzCol(null, []), name: '' }], queued: [] }
        : { sub: (t.dz && t.dz.sub) || 'cols', draft: s.columns.map(c => dzCol(c, s.pk || [])), queued: [] };
      t.dzReload = false;
    }
    const z = t.dz; const info = st.infos[t.c];
    if (!t.inst) t.inst = { dirty: () => dzDirty(t), guardLeave: (go) => showConfirm('Changes not saved', 'The structure changes of this tab are not saved. Close it and drop them?', go, true), destroy() {}, reload: () => { t.dzReload = true; drawDesign(t, pane); } };
    const ctype = { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check', x: 'exclusion' };
    const pre = (x) => `<pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:0;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:10px">${esc(x)}</pre>`;
    const schemas = () => { const o = st.objects[`${t.c}|${t.db}`]; return o && o.schemas ? o.schemas : [...new Set(['public', ...((o && o.relations) || []).map(r => r.schema)])]; };
    const draw = () => {
      const ops = editableKind ? (() => { try { return dzOps(t); } catch (e) { return []; } })() : [];
      const cons = creating ? [] : s.constraints.filter(c => c.type !== 'n');
      const subs = creating ? [['cols', `Columns (${z.draft.filter(c => !c.del && c.name).length})`]]
        : [['cols', `Columns (${s.columns.length})`], ['idx', `Indexes (${s.indexes.length})`], ['keys', `Keys & checks (${cons.length})`], ...(s.triggers.length ? [['trg', `Triggers (${s.triggers.length})`]] : []), ['ddl', 'DDL']];
      const head = creating
        ? `<div class="dbx-head"><span class="dbx-ic">${IC.plus}</span><b>New table</b><span class="ui-sub">in ${esc(t.db)}</span></div>
           <div class="dbg-bar"><label class="ui-field" style="margin:0"><span class="ui-label">Schema</span><select class="input" data-z-schema style="width:auto">${schemas().map(x => `<option ${x === z.schema ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
             <label class="ui-field" style="margin:0;flex:1;min-width:200px"><span class="ui-label">Table name</span><input class="input td-mono" data-z-name value="${esc(z.name)}" placeholder="orders"></label>
             <label class="ui-field" style="margin:0;flex:2;min-width:200px"><span class="ui-label">Comment</span><input class="input" data-z-comment value="${esc(z.comment)}" placeholder="(optional)"></label></div>`
        : `<div class="dbx-head"><span class="dbx-ic">${relIcon(s.kind)}</span><b>${esc(s.schema)}.${esc(s.name)}</b><span class="ui-sub">${esc(kindName[s.kind] || s.kind)} · ${formatBytes(s.size)}${s.rows >= 0 && s.kind !== 'v' && s.kind !== 'S' ? ` · ≈ ${Number(s.rows).toLocaleString()} rows` : ''}</span><span style="flex:1"></span>
            ${s.kind !== 'S' ? UI.btn('Open data', 'data-d-data', 'btn-primary') : ''} ${UI.btn('New query', 'data-d-q')} ${editableKind ? UI.btn('Table ▾', 'data-d-tbl') : ''} ${UI.btn('Refresh', 'data-d-ref')}</div>
           ${s.comment ? `<div class="ui-sub" style="margin:-4px 0 8px">${esc(s.comment)}</div>` : ''}`;
      let body = '';
      if (z.sub === 'cols' && (creating || editableKind)) {
        body = `<datalist id="dz-types-${t.id}">${TYPES.map(x => `<option value="${x}">`).join('')}</datalist>
          <div style="overflow-x:auto"><table class="dz-grid"><thead><tr><th></th>${creating ? '<th class="dz-c" title="Primary key">PK</th>' : '<th></th>'}<th>Name</th><th>Type</th><th class="dz-c" title="NOT NULL">Not null</th><th>Default</th><th class="dz-c" title="Generated by default as identity (auto number)">Identity</th>${creating ? '<th class="dz-c">Unique</th>' : ''}<th>Comment</th><th></th></tr></thead><tbody>
          ${z.draft.map((c, i) => {
            const o = c.orig; const ch = (k) => (!c.isNew && o && String(c[k] ?? '') !== String(k === 'notnull' || k === 'identity' ? !!o[k] : (o[k] ?? '')) ? 'chg' : '');
            const rowCls = c.del ? 'del' : c.isNew && !creating ? 'new' : ['name', 'type', 'notnull', 'default', 'identity', 'comment'].some(k => ch(k)) ? 'chg' : '';
            return `<tr class="${rowCls}" data-r="${i}"><td class="dz-n">${i + 1}</td>
              <td class="dz-c">${creating ? `<input type="checkbox" data-f="pk" ${c.pk ? 'checked' : ''}>` : c.pk ? IC.key : ''}</td>
              <td class="${ch('name')}"><input type="text" data-f="name" value="${esc(c.name)}" placeholder="column_name" ${c.del ? 'disabled' : ''}></td>
              <td class="${ch('type')}"><input type="text" data-f="type" value="${esc(c.type)}" list="dz-types-${t.id}" ${c.del ? 'disabled' : ''}></td>
              <td class="dz-c ${ch('notnull')}"><input type="checkbox" data-f="notnull" ${c.notnull || c.pk ? 'checked' : ''} ${c.del || (creating && c.pk) ? 'disabled' : ''}></td>
              <td class="${ch('default')}"><input type="text" data-f="default" value="${esc(c.identity ? '' : c.default)}" placeholder="${c.identity ? 'auto number' : 'none'}" ${c.del || c.identity ? 'disabled' : ''}></td>
              <td class="dz-c ${ch('identity')}"><input type="checkbox" data-f="identity" ${c.identity ? 'checked' : ''} ${c.del ? 'disabled' : ''}></td>
              ${creating ? `<td class="dz-c"><input type="checkbox" data-f="unique" ${c.unique ? 'checked' : ''}></td>` : ''}
              <td class="${ch('comment')}"><input type="text" data-f="comment" value="${esc(c.comment)}" placeholder="" ${c.del ? 'disabled' : ''}></td>
              <td class="dz-c"><button type="button" class="dz-x" data-del="${i}" title="${c.del ? 'Keep it' : c.isNew ? 'Remove' : 'Drop this column'}">${c.del ? '↺' : '×'}</button></td></tr>`;
          }).join('')}</tbody></table></div>
          <div style="margin-top:8px">${UI.btn('+ Add column', 'data-z-add')}</div>`;
      } else if (z.sub === 'cols') {
        body = UI.table([{ label: '#' }, { label: 'Column' }, { label: 'Type' }, { label: 'Null' }, { label: 'Default' }, { label: 'Comment' }], s.columns.map((c, n) => ({ cells: [`<span class="ui-sub">${n + 1}</span>`, `<b class="td-mono">${esc(c.name)}</b>`, `<span class="td-mono">${esc(c.type)}</span>`, c.notnull ? 'NOT NULL' : '<span class="ui-sub">null</span>', `<span class="td-mono" style="font-size:12px">${esc(c.default || '')}</span>`, `<span class="ui-sub">${esc(c.comment || '')}</span>`] })), { minWidth: 600 })
          + (s.viewdef ? `<div class="ui-label" style="margin:16px 0 6px">Definition</div>${pre(s.viewdef)}` : '') + (s.sequence ? `<div class="ui-label" style="margin:16px 0 6px">Sequence</div>${pre(Object.entries(s.sequence).map(([k, v]) => `${k}: ${v}`).join('\n'))}` : '');
      } else if (z.sub === 'idx') {
        const dropped = new Set(z.queued.filter(q => q.op === 'dropIndex').map(q => q.name));
        body = `${UI.table([{ label: 'Name' }, { label: 'Definition' }, { label: 'Size' }, { label: '', align: 'right' }], s.indexes.map(i => ({ cls: dropped.has(i.name) ? 'dz-dropped' : '', cells: [`<span class="td-mono" style="${dropped.has(i.name) ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(i.name)}</span> ${i.primary ? UI.pill('info', 'primary') : i.unique ? UI.pill('off', 'unique') : ''}`, `<span class="td-mono" style="font-size:12px">${esc(i.def)}</span>`, formatBytes(i.size), i.primary || !editableKind ? '' : dropped.has(i.name) ? UI.btn('Keep', `data-undrop-idx="${esc(i.name)}"`) : UI.btn('Drop', `data-drop-idx="${esc(i.name)}"`, 'btn-danger')] })), { empty: 'No indexes.', minWidth: 560 })}
          ${z.queued.filter(q => q.op === 'addIndex').map(q => `<div class="dz-pend">+ <span class="td-mono">${esc(q.label)}</span><span style="flex:1"></span><button type="button" class="dz-x" data-unq="${z.queued.indexOf(q)}">×</button></div>`).join('')}
          ${editableKind ? `<div style="margin-top:8px">${UI.btn('+ Add index', 'data-z-idx')}</div>` : ''}`;
      } else if (z.sub === 'keys') {
        const dropped = new Set(z.queued.filter(q => q.op === 'dropConstraint').map(q => q.name));
        body = `${UI.table([{ label: 'Name' }, { label: 'Kind' }, { label: 'Definition' }, { label: '', align: 'right' }], cons.map(c => ({ cells: [`<span class="td-mono" style="${dropped.has(c.name) ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(c.name)}</span>`, esc(ctype[c.type] || c.type), `<span class="td-mono" style="font-size:12px">${esc(c.def)}</span>`, !editableKind ? '' : dropped.has(c.name) ? UI.btn('Keep', `data-undrop-con="${esc(c.name)}"`) : UI.btn('Drop', `data-drop-con="${esc(c.name)}"`, 'btn-danger')] })), { empty: 'No keys or checks.', minWidth: 560 })}
          ${z.queued.filter(q => /^add(ForeignKey|Unique|Check|PrimaryKey)$/.test(q.op)).map(q => `<div class="dz-pend">+ <span class="td-mono">${esc(q.label)}</span><span style="flex:1"></span><button type="button" class="dz-x" data-unq="${z.queued.indexOf(q)}">×</button></div>`).join('')}
          ${editableKind ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${UI.btn('+ Foreign key', 'data-z-fk')} ${UI.btn('+ Unique', 'data-z-uq')} ${UI.btn('+ Check', 'data-z-ck')} ${!s.pk.length ? UI.btn('+ Primary key', 'data-z-pk') : ''}</div>` : ''}
          ${s.referencedBy.length ? `<div class="ui-label" style="margin:16px 0 6px">Referenced by</div>${UI.table([{ label: 'Table' }, { label: 'Constraint' }], s.referencedBy.map(c => ({ cells: [`<a href="#" class="td-mono" data-d-ref-t="${esc(c.table)}">${esc(c.table)}</a>`, `<span class="td-mono" style="font-size:12px">${esc(c.name)}: ${esc(c.def)}</span>`] })))}` : ''}`;
      } else if (z.sub === 'trg') {
        const tq = new Map(z.queued.filter(q => q.op === 'enableTrigger').map(q => [q.name, q.enable]));
        body = s.triggers.map(x => { const on = tq.has(x.name) ? tq.get(x.name) : x.enabled; return `<div style="display:flex;gap:8px;align-items:center;margin:10px 0 4px"><b class="td-mono">${esc(x.name)}</b>${on ? UI.pill('ok', 'enabled') : UI.pill('off', 'disabled')}${tq.has(x.name) ? UI.pill('warn', 'changed') : ''}<span style="flex:1"></span>${editableKind ? UI.btn(on ? 'Disable' : 'Enable', `data-trg="${esc(x.name)}" data-on="${on ? 1 : 0}" data-was="${x.enabled ? 1 : 0}"`) : ''}</div>${pre(x.def)}`; }).join('');
      } else if (z.sub === 'ddl') {
        const lines = s.columns.map(c => `  ${quoteId(c.name)} ${c.type}${c.identity ? ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` : ''}${c.notnull ? ' NOT NULL' : ''}${c.default && !c.identity ? ` DEFAULT ${c.default}` : ''}`)
          .concat(cons.filter(c => c.type !== 't').map(c => `  CONSTRAINT ${quoteId(c.name)} ${c.def}`));
        const ddl = `CREATE TABLE ${qn(s.schema, s.name)} (\n${lines.join(',\n')}\n);\n${s.indexes.filter(i => !i.primary && !cons.some(c => c.name === i.name)).map(i => i.def + ';').join('\n')}${s.comment ? `\nCOMMENT ON TABLE ${qn(s.schema, s.name)} IS '${s.comment.replace(/'/g, "''")}';` : ''}${s.columns.filter(c => c.comment).map(c => `\nCOMMENT ON COLUMN ${qn(s.schema, s.name)}.${quoteId(c.name)} IS '${c.comment.replace(/'/g, "''")}';`).join('')}`;
        body = `<div class="dbg-bar">${UI.btn('Copy', 'data-z-copyddl')} ${UI.btn('Open in a query', 'data-z-ddlq')}<span class="ui-sub">Made from the catalog — sequences, grants and triggers are not in it.</span></div>${pre(ddl)}`;
        t._ddl = ddl;
      }
      const n = creating ? (z.name.trim() ? 1 : 0) : ops.length;
      pane.innerHTML = DZ_CSS + head + (subs.length > 1 ? `<div class="dz-sub">${subs.map(([k, l]) => `<button type="button" data-sub="${k}" class="${z.sub === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : '') + body
        + (editableKind && (creating || n) ? `<div class="dz-bar"><b>${creating ? 'New table' : `${n} change${n === 1 ? '' : 's'}`}</b><span class="ui-sub">${info.allowWrite ? (creating ? '' : 'saved together, in one transaction') : '🔒 read-only — Test works; allow changes to save'}</span><span style="flex:1"></span>
            ${UI.btn('Show SQL', 'data-z-sql')} ${UI.btn('🧪 Test', 'data-z-test')} ${creating ? '' : UI.btn('Discard', 'data-z-discard')} ${UI.primary(creating ? 'Create table' : 'Save', 'data-z-save')}</div>` : '');
      bind();
    };
    const qOp = (op, label) => { z.queued.push({ ...op, label }); draw(); };
    const tablesOfDb = () => { const o = st.objects[`${t.c}|${t.db}`]; return o ? o.relations.filter(r => r.kind === 'r' || r.kind === 'p') : []; };
    const colOpts = (sel) => (creating ? [] : s.columns).map(c => `<option ${c.name === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const colChecks = (cls) => s.columns.map(c => `<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" class="${cls}" value="${esc(c.name)}"> <span class="td-mono">${esc(c.name)}</span> <span class="ui-sub">${esc(c.type)}</span></label>`).join('');
    const picked = (ov, cls) => [...ov.querySelectorAll(`.${cls}:checked`)].map(x => x.value);
    function bind() {
      pane.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { z.sub = b.dataset.sub; draw(); });
      // columns sheet
      pane.querySelectorAll('tr[data-r] [data-f]').forEach(inp => {
        const ev = inp.type === 'checkbox' ? 'change' : 'input';
        inp.addEventListener(ev, () => {
          const c = z.draft[Number(inp.closest('tr').dataset.r)]; const f = inp.dataset.f;
          c[f] = inp.type === 'checkbox' ? inp.checked : inp.value;
          if (f === 'pk' && c.pk) c.notnull = true;
          if (inp.type === 'checkbox') draw(); else { const tr = inp.closest('tr'); const o = c.orig; if (o) { const same = String(c[f] ?? '') === String(o[f] ?? ''); inp.closest('td').classList.toggle('chg', !same); } refreshBar(); if (c === z.draft[z.draft.length - 1] && creating && c.name) { z.draft.push(dzCol(null, [])); draw(); const ni = pane.querySelector(`tr[data-r="${z.draft.length - 2}"] [data-f="${f}"]`); if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); } } }
        });
      });
      pane.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const i = Number(b.dataset.del); const c = z.draft[i]; if (c.isNew) z.draft.splice(i, 1); else c.del = !c.del; draw(); });
      const add = pane.querySelector('[data-z-add]'); if (add) add.onclick = () => { z.draft.push(dzCol(null, [])); draw(); const r = pane.querySelector(`tr[data-r="${z.draft.length - 1}"] [data-f="name"]`); if (r) r.focus(); };
      const zs = pane.querySelector('[data-z-schema]'); if (zs) zs.onchange = () => { z.schema = zs.value; };
      const zn = pane.querySelector('[data-z-name]'); if (zn) zn.oninput = () => { z.name = zn.value; refreshBar(); };
      const zc = pane.querySelector('[data-z-comment]'); if (zc) zc.oninput = () => { z.comment = zc.value; };
      // indexes, keys, triggers
      pane.querySelectorAll('[data-drop-idx]').forEach(b => b.onclick = () => qOp({ op: 'dropIndex', name: b.dataset.dropIdx }, `drop index ${b.dataset.dropIdx}`));
      pane.querySelectorAll('[data-undrop-idx]').forEach(b => b.onclick = () => { z.queued = z.queued.filter(q => !(q.op === 'dropIndex' && q.name === b.dataset.undropIdx)); draw(); });
      pane.querySelectorAll('[data-drop-con]').forEach(b => b.onclick = () => qOp({ op: 'dropConstraint', name: b.dataset.dropCon }, `drop ${b.dataset.dropCon}`));
      pane.querySelectorAll('[data-undrop-con]').forEach(b => b.onclick = () => { z.queued = z.queued.filter(q => !(q.op === 'dropConstraint' && q.name === b.dataset.undropCon)); draw(); });
      pane.querySelectorAll('[data-unq]').forEach(b => b.onclick = () => { z.queued.splice(Number(b.dataset.unq), 1); draw(); });
      pane.querySelectorAll('[data-trg]').forEach(b => b.onclick = () => { const want = b.dataset.on !== '1'; z.queued = z.queued.filter(q => !(q.op === 'enableTrigger' && q.name === b.dataset.trg)); if (want !== (b.dataset.was === '1')) z.queued.push({ op: 'enableTrigger', name: b.dataset.trg, enable: want, label: `${want ? 'enable' : 'disable'} trigger ${b.dataset.trg}` }); draw(); });
      const zi = pane.querySelector('[data-z-idx]'); if (zi) zi.onclick = () => UI.dialog({ title: 'Add index', saveLabel: 'Add',
        body: `<div class="ui-label">Columns (in this order)</div><div style="max-height:220px;overflow:auto;margin-bottom:8px">${colChecks('zi-c')}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap"><label class="ui-field" style="flex:1"><span class="ui-label">Name (optional)</span><input class="input td-mono" id="zi-n"></label><label class="ui-field"><span class="ui-label">Method</span><select class="input" id="zi-m"><option>btree</option><option>hash</option><option>gin</option><option>gist</option><option>brin</option></select></label></div>
          <label class="ui-field"><span class="ui-label">Only rows where (optional, a partial index)</span><input class="input td-mono" id="zi-w" placeholder="deleted_at IS NULL"></label>
          <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="zi-u"> Unique</label>
          <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin-top:4px"><input type="checkbox" id="zi-cc"> CONCURRENTLY — does not block writes on a busy table (made after the other changes, not in a transaction)</label>`,
        onSave: async (ov) => { const c = picked(ov, 'zi-c'); if (!c.length) throw new Error('Pick at least one column'); const op = { op: 'addIndex', columns: c, unique: ov.querySelector('#zi-u').checked, method: ov.querySelector('#zi-m').value, name: ov.querySelector('#zi-n').value.trim() || undefined, where: ov.querySelector('#zi-w').value.trim() || undefined, concurrently: ov.querySelector('#zi-cc').checked }; qOp(op, `${op.unique ? 'unique ' : ''}index on (${c.join(', ')})${op.method !== 'btree' ? ' using ' + op.method : ''}`); } });
      const zf = pane.querySelector('[data-z-fk]'); if (zf) zf.onclick = () => UI.dialog({ title: 'Add foreign key', saveLabel: 'Add',
        body: `<label class="ui-field"><span class="ui-label">Column</span><select class="input td-mono" id="zf-c">${colOpts()}</select></label>
          <label class="ui-field"><span class="ui-label">Points to the table</span><select class="input td-mono" id="zf-t">${tablesOfDb().map(r => `<option value="${esc(r.schema)}|${esc(r.name)}">${r.schema !== 'public' ? esc(r.schema) + '.' : ''}${esc(r.name)}</option>`).join('')}</select></label>
          <label class="ui-field"><span class="ui-label">Its column</span><select class="input td-mono" id="zf-rc"><option>…</option></select></label>
          <div style="display:flex;gap:10px"><label class="ui-field" style="flex:1"><span class="ui-label">When that row is deleted</span><select class="input" id="zf-d"><option value="NO ACTION">refuse (no action)</option><option value="CASCADE">delete these rows too (cascade)</option><option value="SET NULL">set this column to NULL</option><option value="RESTRICT">refuse at once (restrict)</option></select></label>
            <label class="ui-field" style="flex:1"><span class="ui-label">When its key changes</span><select class="input" id="zf-u"><option value="NO ACTION">refuse (no action)</option><option value="CASCADE">change these too (cascade)</option><option value="SET NULL">set NULL</option></select></label></div>
          <label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="zf-nv"> Do not check the rows there now (NOT VALID) — only new rows</label><div data-zf-warn class="ui-sub" style="color:var(--warning);margin-top:6px"></div>`,
        onOpen: (ov) => {
          const ts = ov.querySelector('#zf-t'), rc = ov.querySelector('#zf-rc'), cc = ov.querySelector('#zf-c'), warn = ov.querySelector('[data-zf-warn]'); let ref = null;
          const check = () => { const a = s.columns.find(c => c.name === cc.value); const b = ref && (ref.columns || []).find(c => c.name === rc.value); const base = (x) => String(x || '').replace(/\(.*$/, '').replace(/^character varying$/, 'varchar').trim();
            warn.textContent = a && b && base(a.type) !== base(b.type) ? `⚠ ${a.name} is ${a.type} and ${b.name} is ${b.type} — PostgreSQL refuses a key between different types. Change one of the types first.` : b && ref && !(ref.pk || []).includes(b.name) && !(ref.indexes || []).some(i => i.unique && new RegExp('\\(' + b.name + '\\)').test(i.def)) ? `⚠ ${b.name} is not a primary key or unique there — PostgreSQL needs one of those.` : ''; };
          const load = async () => { const [rs, rt] = ts.value.split('|'); rc.innerHTML = '<option>…</option>'; ref = await ensureStruct(t.c, t.db, rs, rt); rc.innerHTML = (ref.columns || []).map(c => `<option ${(ref.pk || []).includes(c.name) ? 'selected' : ''}>${esc(c.name)}</option>`).join(''); check(); };
          ts.onchange = load; rc.onchange = check; cc.onchange = check; if (ts.value) load();
        },
        onSave: async (ov) => { const [rs, rt] = ov.querySelector('#zf-t').value.split('|'); const c = ov.querySelector('#zf-c').value, rc = ov.querySelector('#zf-rc').value; if (!rt || !rc || rc === '…') throw new Error('Pick the table and its column'); qOp({ op: 'addForeignKey', columns: [c], refSchema: rs, refTable: rt, refColumns: [rc], onDelete: ov.querySelector('#zf-d').value, onUpdate: ov.querySelector('#zf-u').value, notValid: ov.querySelector('#zf-nv').checked }, `${c} → ${rt}.${rc}`); } });
      const zu = pane.querySelector('[data-z-uq]'); if (zu) zu.onclick = () => UI.dialog({ title: 'Add unique', saveLabel: 'Add', body: `<div class="ui-sub" style="margin-bottom:6px">No two rows may have the same values in these columns.</div>${colChecks('zu-c')}`, onSave: async (ov) => { const c = picked(ov, 'zu-c'); if (!c.length) throw new Error('Pick at least one column'); qOp({ op: 'addUnique', columns: c }, `unique (${c.join(', ')})`); } });
      const zp = pane.querySelector('[data-z-pk]'); if (zp) zp.onclick = () => UI.dialog({ title: 'Add primary key', saveLabel: 'Add', body: `<div class="ui-sub" style="margin-bottom:6px">Rows are found and edited by it; its columns become NOT NULL and unique.</div>${colChecks('zp-c')}`, onSave: async (ov) => { const c = picked(ov, 'zp-c'); if (!c.length) throw new Error('Pick at least one column'); qOp({ op: 'addPrimaryKey', columns: c }, `primary key (${c.join(', ')})`); } });
      const zk = pane.querySelector('[data-z-ck]'); if (zk) zk.onclick = () => UI.dialog({ title: 'Add check', saveLabel: 'Add', body: `<label class="ui-field"><span class="ui-label">Every row must satisfy</span><input class="input td-mono" id="zk-e" placeholder="price >= 0"></label><label class="ui-field"><span class="ui-label">Name (optional)</span><input class="input td-mono" id="zk-n"></label>`, onSave: async (ov) => { const e = ov.querySelector('#zk-e').value.trim(); if (!e) throw new Error('Write the condition'); qOp({ op: 'addCheck', expr: e, name: ov.querySelector('#zk-n').value.trim() || undefined }, `check (${e})`); } });
      // header
      const d = pane.querySelector('[data-d-data]'); if (d) d.onclick = () => openTab({ type: 'data', c: t.c, db: t.db, s: t.s, t: t.t }, { pin: true });
      const nq = pane.querySelector('[data-d-q]'); if (nq) nq.onclick = () => genSql('select', t.c, t.db, t.s, t.t).catch(e => showToast(e.message, 'error'));
      const rf = pane.querySelector('[data-d-ref]'); if (rf) rf.onclick = () => (dzDirty(t) ? showConfirm('Refresh', 'Drop the changes not saved and read the table again?', () => { t.dzReload = true; drawDesign(t, pane); }, true) : (t.dzReload = true, drawDesign(t, pane)));
      const tb = pane.querySelector('[data-d-tbl]'); if (tb) tb.onclick = () => { const r = tb.getBoundingClientRect(); tableMenu(t, r.left, r.bottom + 2); };
      pane.querySelectorAll('[data-d-ref-t]').forEach(a => a.onclick = (e) => { e.preventDefault(); const v = a.dataset.dRefT.replace(/"/g, ''); const [sch, tbl] = v.includes('.') ? v.split('.') : ['public', v]; openTab({ type: 'design', c: t.c, db: t.db, s: sch, t: tbl }, { pin: true }); });
      const cd = pane.querySelector('[data-z-copyddl]'); if (cd) cd.onclick = () => copy(t._ddl);
      const dq = pane.querySelector('[data-z-ddlq]'); if (dq) dq.onclick = () => newQuery(t.c, t.db, t._ddl, `DDL ${t.t}`);
      // the bar
      const bs = pane.querySelector('[data-z-sql]'); if (bs) bs.onclick = () => showSql();
      const bt = pane.querySelector('[data-z-test]'); if (bt) bt.onclick = () => run(true);
      const bd = pane.querySelector('[data-z-discard]'); if (bd) bd.onclick = () => showConfirm('Discard', 'Drop every change not saved in this tab?', () => { t.dz = null; t.dzReload = false; drawDesign(t, pane); });
      const bv = pane.querySelector('[data-z-save]'); if (bv) bv.onclick = () => save();
    }
    function refreshBar() { const had = !!pane.querySelector('.dz-bar'); const now = creating || dzOps(t).length > 0; if (had !== now) draw(); else { const b = pane.querySelector('.dz-bar b'); if (b && !creating) { const n = dzOps(t).length; b.textContent = `${n} change${n === 1 ? '' : 's'}`; } } }
    const body = () => ({ schema: creating ? z.schema : t.s, table: creating ? undefined : t.t, ops: dzOps(t) });
    async function showSql() {
      try {
        const r = await API.post(`${dbBaseOf(t.c, t.db)}/ddl/preview`, body());
        const text = r.statements.map(x => x.sql + ';').join('\n\n');
        showModal('The SQL of these changes', `<div class="ui-sub" style="margin-bottom:6px">${r.statements.length} statement${r.statements.length === 1 ? '' : 's'}, run in one transaction${r.statements.some(x => x.concurrent) ? ' (CONCURRENTLY ones after it)' : ''}.</div>${pre(text)}`, [{ label: 'Copy', className: 'btn btn-secondary', onClick: () => copy(text) }, { label: 'Open in a query', className: 'btn btn-secondary', onClick: () => newQuery(t.c, t.db, text, creating ? 'CREATE TABLE' : `ALTER ${t.t}`) }, { label: 'Close', className: 'btn btn-primary' }]);
      } catch (e) { showToast(e.message, 'error', 9000); }
    }
    async function run(test) {
      try {
        const r = await API.post(`${dbBaseOf(t.c, t.db)}/ddl/apply`, { ...body(), test, confirm: !test });
        if (test) return showToast(`🧪 Test passed — ${r.statements.length} statement${r.statements.length === 1 ? '' : 's'} ran and were rolled back. Nothing changed.`, 'success', 6000);
        showToast(creating ? `Created ${z.schema}.${z.name}` : 'Saved', 'success');
        forgetDb(t.c, t.db); ensureObjects(t.c, t.db, true);
        if (creating) { const name = z.name.trim(), sch = z.schema; closeTab(t.id, true); openTab({ type: 'design', c: t.c, db: t.db, s: sch, t: name }, { pin: true }); return; }
        st.tabs.filter(x => x !== t && x.c === t.c && x.db === t.db && x.s === t.s && x.t === t.t && x.type === 'data' && x.inst && x.inst.reload).forEach(x => x.inst.reload());
        t.dzReload = true; drawDesign(t, pane);
      } catch (e) { showModal(test ? 'Test failed' : 'Not saved', `<div class="text-sm" style="color:var(--danger);white-space:pre-wrap">${esc(e.message)}</div>${e.data && e.data.statement ? `<div class="ui-label" style="margin-top:10px">The statement</div>${pre(e.data.statement)}` : ''}`, [{ label: 'Close', className: 'btn btn-secondary' }]); }
    }
    async function save() {
      if (creating && !z.name.trim()) return showToast('Name the table first', 'info');
      if (!info.allowWrite) return showConfirm('Allow changes?', `The connection to <b>${esc(t.c)}</b> is read-only. Allow changes and save?`, async () => { await setWrite(true, t.c); save(); });
      let r; try { r = await API.post(`${dbBaseOf(t.c, t.db)}/ddl/preview`, body()); } catch (e) { return showToast(e.message, 'error', 9000); }
      const risky = r.statements.some(x => /DROP|TYPE /.test(x.sql));
      showConfirm(creating ? 'Create table' : 'Save structure changes', `${r.statements.length} statement${r.statements.length === 1 ? '' : 's'} in one transaction${info.production ? ' — <b style="color:var(--danger)">production</b>' : ''}${risky ? '. <b>Dropping columns or changing types can lose data</b> — 🧪 Test first, back up if in doubt.' : ''}:${pre(r.statements.map(x => x.sql + ';').join('\n'))}`, () => run(false), risky || !!info.production);
    }
    draw();
  }

  // Table ▾ (and the tree): rename, move, duplicate, comment — each shows its SQL, can be tested, then runs
  function quickDdl(t, ops, title, done) {
    UI.dialog({ title, saveLabel: 'Run', wide: false, body: '<div data-q-sql><div class="skeleton" style="height:60px"></div></div>',
      onOpen: async (ov, { save }) => {
        try { const r = await API.post(`${dbBaseOf(t.c, t.db)}/ddl/preview`, { schema: t.s, table: t.t, ops }); ov.querySelector('[data-q-sql]').innerHTML = `<pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:0">${esc(r.statements.map(x => x.sql + ';').join('\n'))}</pre><div style="margin-top:8px">${UI.btn('🧪 Test', 'data-q-test')}</div>`;
          ov.querySelector('[data-q-test]').onclick = async () => { try { await API.post(`${dbBaseOf(t.c, t.db)}/ddl/apply`, { schema: t.s, table: t.t, ops, test: true }); showToast('🧪 Test passed — rolled back', 'success'); } catch (e) { showToast(e.message, 'error', 9000); } };
        } catch (e) { ov.querySelector('[data-q-sql]').innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; save.disabled = true; }
      },
      onSave: async () => {
        if (!(st.infos[t.c] || {}).allowWrite) throw new Error('Allow changes first (status bar)');
        await API.post(`${dbBaseOf(t.c, t.db)}/ddl/apply`, { schema: t.s, table: t.t, ops, confirm: true });
        showToast('Done'); forgetDb(t.c, t.db); await ensureObjects(t.c, t.db, true); if (done) done();
      } });
  }
  function tableMenu(t, x, y) {
    const retarget = (s2, t2) => { st.tabs.filter(o => o.c === t.c && o.db === t.db && o.s === t.s && o.t === t.t).forEach(o => { o.s = s2; o.t = t2; o.dzReload = true; destroyTab(o); }); persistTabs(); const a = activeTab(); if (a) { panesEl().querySelectorAll('.dbx-pane').forEach(p => p.classList.remove('on')); activate(a.id); } drawTabs(); };
    const ask = (title, label, value, fn) => UI.dialog({ title, saveLabel: 'Next', body: `<label class="ui-field"><span class="ui-label">${label}</span><input class="input td-mono" id="qa-v" value="${esc(value)}"></label>`, onSave: async (ov) => { const v = ov.querySelector('#qa-v').value.trim(); if (!v) throw new Error('Needed'); setTimeout(() => fn(v), 50); } });
    showMenu(x, y, [{ header: `${t.s}.${t.t}` },
      { label: 'Rename…', act: () => ask('Rename table', 'New name', t.t, (v) => quickDdl(t, [{ op: 'renameTable', name: v }], `Rename ${t.t}`, () => retarget(t.s, v))) },
      { label: 'Move to another schema…', act: () => ask('Move to schema', 'Schema (must exist)', t.s, (v) => quickDdl(t, [{ op: 'setSchema', schema: v }], `Move ${t.t}`, () => retarget(v, t.t))) },
      { label: 'Duplicate…', act: () => UI.dialog({ title: `Duplicate ${t.t}`, saveLabel: 'Next', body: `<label class="ui-field"><span class="ui-label">New table</span><input class="input td-mono" id="du-n" value="${esc(t.t)}_copy"></label><label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="du-d" checked> With the rows</label><div class="ui-sub" style="margin-top:6px">Columns, defaults, constraints and indexes are copied (LIKE … INCLUDING ALL); serial columns keep using the old sequence.</div>`, onSave: async (ov) => { const n = ov.querySelector('#du-n').value.trim(), wd = ov.querySelector('#du-d').checked; setTimeout(() => quickDdl(t, [{ op: 'duplicate', name: n, withData: wd }], `Duplicate ${t.t}`, () => openTab({ type: 'design', c: t.c, db: t.db, s: t.s, t: n }, { pin: true })), 50); } }) },
      { label: 'Comment…', act: () => ask('Table comment', 'Comment (empty removes it)', (st.structs[`${t.c}|${t.db}|${t.s}|${t.t}`] || {}).comment || ' ', (v) => quickDdl(t, [{ op: 'comment', text: v.trim() }], 'Comment', () => { t.dzReload = true; renderTab(t, true); })) },
      '-',
      ...(nodeMenuItems(`t|${t.c}|${t.db}|${t.s}|${t.t}`).filter(it => it && it !== '-' && /VACUUM|ANALYZE|TRUNCATE|Drop/.test(it.label || ''))),
    ]);
  }
  const nodeMenuItems = (key) => { let items = null; const real = showMenu; showMenu = (x, y, list) => { items = list; }; try { nodeMenu(key, 0, 0); } finally { showMenu = real; } return items || []; };

  // ---------- database overview (the tables of a database, like a file list) ----------
  async function drawOverview(t, pane) {
    pane.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>';
    const o = await ensureObjects(t.c, t.db, true);
    if (!pane.isConnected) return;
    if (o.error) { pane.innerHTML = `<div class="card text-danger" style="padding:16px">${esc(o.error)}</div>`; return; }
    const info = st.infos[t.c]; const d = info.databases.find(x => x.name === t.db) || {};
    const w = info.allowWrite;
    const rels = o.relations.slice().sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    const total = rels.reduce((n, r) => n + (Number(r.size) || 0), 0);
    const view = { q: t.ovq || '', sel: new Set() };
    const draw = () => {
      const q = view.q.toLowerCase(); const list = rels.filter(r => !q || `${r.schema}.${r.name}`.toLowerCase().includes(q));
      pane.innerHTML = `
        <div class="dbx-head"><span class="dbx-ic">${IC.db}</span><b>${esc(t.db)}</b><span class="ui-sub">${d.size != null ? formatBytes(d.size) : ''} · ${rels.filter(r => r.kind === 'r' || r.kind === 'p').length} tables · ${rels.filter(r => r.kind === 'v' || r.kind === 'm').length} views · ${o.functions.length} functions · owner ${esc(d.owner || '?')}</span><span style="flex:1"></span>
          ${UI.btn('New query', 'data-o-q', 'btn-primary')} ${UI.btn('+ New table', 'data-o-nt')} ${UI.btn('Admin', 'data-o-adm')} ${UI.btn('Backups', 'data-o-bk')} ${UI.btn('Refresh', 'data-o-ref')}</div>
        <div class="dbg-bar"><input class="input" data-o-find placeholder="Filter…" value="${esc(view.q)}" style="max-width:280px;padding:4px 10px">
          <span class="ui-sub" data-o-n>${list.length} of ${rels.length}</span><span style="flex:1"></span>
          <span class="ui-sub">With the ticked:</span> ${UI.btn('ANALYZE', `data-o-bulk="analyze" ${w ? '' : 'disabled title="Allow changes first"'}`)} ${UI.btn('VACUUM ANALYZE', `data-o-bulk="vacuum" ${w ? '' : 'disabled title="Allow changes first"'}`)} ${UI.btn('Empty…', `data-o-bulk="truncate" ${w ? '' : 'disabled title="Allow changes first"'}`, 'btn-danger')} ${UI.btn('Drop…', `data-o-bulk="drop" ${w ? '' : 'disabled title="Allow changes first"'}`, 'btn-danger')}</div>
        ${UI.table([{ label: '<input type="checkbox" data-o-all title="Tick all shown">' }, { label: 'Name' }, { label: 'Kind' }, { label: 'Rows ≈', align: 'right' }, { label: 'Size', align: 'right' }, { label: '', align: 'right' }], list.map(r => ({ cells: [
          r.kind === 'S' ? '' : `<input type="checkbox" data-o-ck="${esc(r.schema)}|${esc(r.name)}" ${view.sel.has(`${r.schema}|${r.name}`) ? 'checked' : ''}>`,
          `<span class="dbx-ic" style="vertical-align:-3px">${relIcon(r.kind)}</span> <a href="#" class="td-mono" data-o-open="${esc(r.schema)}|${esc(r.name)}">${r.schema !== 'public' ? `<span class="ui-sub">${esc(r.schema)}.</span>` : ''}${esc(r.name)}</a>`,
          `<span class="ui-sub">${esc(kindName[r.kind] || r.kind)}</span>`,
          `<span style="font-variant-numeric:tabular-nums">${r.kind === 'v' || r.kind === 'S' || r.rows < 0 ? '—' : Number(r.rows).toLocaleString()}</span>`,
          `<span style="font-variant-numeric:tabular-nums">${r.kind === 'v' ? '—' : formatBytes(r.size)}</span>`,
          `<div class="td-actions" style="justify-content:flex-end">${r.kind !== 'S' ? UI.btn('Data', `data-o-data="${esc(r.schema)}|${esc(r.name)}"`) : ''} ${UI.btn('Design', `data-o-design="${esc(r.schema)}|${esc(r.name)}"`)} <button type="button" class="btn btn-xs btn-ghost" data-o-menu="${esc(r.schema)}|${esc(r.name)}" title="More">⋯</button></div>`] })), { empty: 'No tables yet — create one with a CREATE TABLE in a new query.', minWidth: 640 })}
        <div class="ui-sub" style="margin-top:8px">Total ${formatBytes(total)} in tables, indexes and views. Rows are the planner's estimate — "Count rows" in a table's menu counts exactly.</div>`;
      const f = pane.querySelector('[data-o-find]'); f.oninput = () => { view.q = f.value; t.ovq = f.value; const pos = f.selectionStart; draw(); const g = pane.querySelector('[data-o-find]'); g.focus(); g.setSelectionRange(pos, pos); };
      const sp = (v) => v.split('|');
      pane.querySelectorAll('[data-o-open],[data-o-data]').forEach(a => a.onclick = (e) => { e.preventDefault(); const [s, n] = sp(a.dataset.oOpen || a.dataset.oData); const r = relOf(t.c, t.db, s, n); openTab({ type: r && r.kind === 'S' ? 'design' : 'data', c: t.c, db: t.db, s, t: n }, { pin: true }); });
      pane.querySelectorAll('[data-o-design]').forEach(a => a.onclick = () => { const [s, n] = sp(a.dataset.oDesign); openTab({ type: 'design', c: t.c, db: t.db, s, t: n }, { pin: true }); });
      pane.querySelectorAll('[data-o-menu]').forEach(a => a.onclick = (e) => { const [s, n] = sp(a.dataset.oMenu); const r = a.getBoundingClientRect(); nodeMenu(`t|${t.c}|${t.db}|${s}|${n}`, r.left - 180, r.bottom + 2); });
      pane.querySelectorAll('[data-o-ck]').forEach(c => c.onchange = () => { if (c.checked) view.sel.add(c.dataset.oCk); else view.sel.delete(c.dataset.oCk); });
      const all = pane.querySelector('[data-o-all]'); if (all) all.onchange = () => { list.filter(r => r.kind !== 'S').forEach(r => { if (all.checked) view.sel.add(`${r.schema}|${r.name}`); else view.sel.delete(`${r.schema}|${r.name}`); }); draw(); };
      pane.querySelector('[data-o-q]').onclick = () => newQuery(t.c, t.db);
      pane.querySelector('[data-o-nt]').onclick = () => newTable(t.c, t.db, 'public');
      pane.querySelector('[data-o-adm]').onclick = () => openTab({ type: 'admin', c: t.c, db: t.db }, { pin: true });
      pane.querySelector('[data-o-bk]').onclick = () => openTab({ type: 'backups', c: t.c }, { pin: true });
      pane.querySelector('[data-o-ref]').onclick = () => { forgetDb(t.c, t.db); renderTab(t, true); };
      pane.querySelectorAll('[data-o-bulk]').forEach(b => b.onclick = () => {
        const picked = [...view.sel].map(sp).map(([s, n]) => ({ s, n, r: relOf(t.c, t.db, s, n) })).filter(x => x.r);
        if (!picked.length) return showToast('Tick one or more first', 'info');
        const k = b.dataset.oBulk;
        const tables = picked.filter(x => x.r.kind === 'r' || x.r.kind === 'p');
        const stmt = k === 'analyze' ? picked.filter(x => x.r.kind !== 'v').map(x => `ANALYZE ${qn(x.s, x.n)};`) : k === 'vacuum' ? tables.map(x => `VACUUM ANALYZE ${qn(x.s, x.n)};`)
          : k === 'truncate' ? (tables.length ? [`TRUNCATE TABLE ${tables.map(x => qn(x.s, x.n)).join(', ')};`] : [])
          : picked.map(x => `DROP ${x.r.kind === 'v' ? 'VIEW' : x.r.kind === 'm' ? 'MATERIALIZED VIEW' : x.r.kind === 'f' ? 'FOREIGN TABLE' : 'TABLE'} ${qn(x.s, x.n)};`);
        if (!stmt.length) return showToast('Nothing to do for these', 'info');
        const sql = stmt.join('\n');
        if (k === 'vacuum') { // VACUUM can not run inside a transaction block: one after another through maintain
          return showConfirm('VACUUM ANALYZE', `Run VACUUM ANALYZE on ${tables.length} table(s)? It runs alongside your apps.`, async () => { for (const x of tables) { try { await API.post(`${dbBaseOf(t.c, t.db)}/maintain`, { action: 'vacuum', schema: x.s, table: x.n }); } catch (e) { showToast(`${x.n}: ${e.message}`, 'error', 8000); } } showToast('VACUUM ANALYZE done'); forgetDb(t.c, t.db); renderTab(t, true); });
        }
        const msgs = { analyze: `Update the planner statistics of ${picked.length} object(s)?`, truncate: `Delete <b>every row</b> of ${tables.length} table(s)? This can not be undone.`, drop: `Drop ${picked.length} object(s) and their data? If another object depends on one, nothing is dropped.` };
        runDanger(t.c, t.db, sql, msgs[k], k === 'analyze' ? null : `${k} ${picked.length}`, k === 'drop' ? {} : {}).then(() => { if (k === 'drop') picked.forEach(x => st.tabs.filter(y => y.c === t.c && y.db === t.db && y.s === x.s && y.t === x.n).forEach(y => closeTab(y.id, true))); });
      });
    };
    draw();
  }

  // ---------- connection, read-only ----------
  async function setWrite(on, c = st.c) {
    const r = await API.put(`${baseOf(c)}/settings`, { allowWrite: on });
    if (st.infos[c]) st.infos[c].allowWrite = r.allowWrite;
    if (st.c === c && st.info) st.info.allowWrite = r.allowWrite;
    drawStatus(); drawTree();
    for (const t of st.tabs.filter(x => x.c === c)) {
      if (t.inst && t.type === 'data' && t.inst.redraw) t.inst.redraw();
      else if (t.inst && t.type === 'sql' && t.inst.redrawTool) t.inst.redrawTool();
      else if (t.type === 'design' || t.type === 'overview' || t.type === 'admin') { if (t.id === st.active) renderTab(t, true); else { const p = paneOf(t); if (p) p.remove(); } }
    }
  }
  async function toggleWrite(c = st.c) {
    const i = await ensureInfo(c); if (!i) return;
    if (i.allowWrite) return setWrite(false, c).then(() => showToast('Read-only again'));
    showConfirm('Allow changes', `Allow statements and edits that <b>change data</b> on <b>${esc(c)}</b>${i.production ? ' — <b style="color:var(--danger)">marked as production</b>' : ''}? Dangerous SQL still asks first, and every change is in the audit log.`, () => setWrite(true, c).then(() => showToast('Changes allowed')), !!i.production);
  }
  function connection(c = st.c) {
    const i = st.infos[c], cont = st.containers.find(x => x.name === c) || {}, s = cont.settings || {};
    UI.dialog({ title: `Connection to ${esc(c)}`, saveLabel: 'Save',
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
        await API.put(`${baseOf(c)}/settings`, body);
        showToast('Saved'); await loadContainers(); await reloadInfo(c);
        for (const t of st.tabs.filter(x => x.c === c)) { if (t.id === st.active) renderTab(t, true); else { destroyTab(t); } }
      } });
  }
  // what the admin and backup views below call to redraw the page around them
  function drawShell() { drawTree(); drawStatus(); }
  function openOverview(c, db) { forgetDb(c, db); return openTab({ type: 'overview', c, db }, { pin: true }); }

  // ---------- admin and backups (shown in their tabs) ----------
  async function drawAdmin(pane = curPane()) {
    pane.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>';
    let a;
    try { a = await API.get(`${dbBase()}/admin`); } catch (e) { if (alive()) pane.innerHTML = `<div class="card text-danger" style="padding:16px">${esc(e.message)}</div>`; return; }
    if (!alive() || !pane.isConnected) return;
    const w = st.info.allowWrite;
    const ago = (s) => s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
    const when = (t) => t ? new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
    const pct = Math.round(a.connections / a.maxConnections * 100);
    pane.innerHTML = `
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
    const m = pane;
    const post = async (url, body, okMsg) => { try { await API.post(url, body); showToast(okMsg); drawAdmin(); } catch (e) { showToast(e.message, 'error', 9000); } };
    m.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => post(`${base()}/session`, { pid: b.dataset.cancel, action: 'cancel' }, 'Query stopped'));
    m.querySelectorAll('[data-term]').forEach(b => b.onclick = () => showConfirm('Terminate session', `Close connection <b>${esc(b.dataset.term)}</b>? Its open transaction is rolled back.`, () => post(`${base()}/session`, { pid: b.dataset.term, action: 'terminate' }, 'Session closed'), true));
    m.querySelectorAll('[data-opendb]').forEach(b => b.onclick = () => { openOverview(st.c, b.dataset.opendb); });
    m.querySelectorAll('[data-mt]').forEach(b => b.onclick = () => maintain(b.dataset.mt));
    m.querySelectorAll('[data-mtt]').forEach(b => b.onclick = () => maintain(b.dataset.mtt, b.dataset.s, b.dataset.t));
    const nr = m.querySelector('[data-newrole]'); if (nr) nr.onclick = () => newRole();
    const nd = m.querySelector('[data-newdb]'); if (nd) nd.onclick = () => UI.dialog({ title: 'New database', saveLabel: 'Create',
      body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input td-mono" id="nd-n" placeholder="app"></label><label class="ui-field"><span class="ui-label">Owner</span><select class="input" id="nd-o">${a.roles.filter(r => r.login).map(r => `<option ${r.name === st.info.user ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`,
      onSave: async (ov) => { await API.post(`${base()}/databases`, { database: ov.querySelector('#nd-n').value.trim(), owner: ov.querySelector('#nd-o').value }); showToast('Created'); st.info = await reloadInfo(st.c); drawShell(); drawTree(); drawAdmin(); } });
    m.querySelectorAll('[data-dropdb]').forEach(b => b.onclick = () => showDeleteConfirm('Drop database', { message: `Drop <b>${esc(b.dataset.dropdb)}</b> and everything in it? Its sessions are closed first. Make a backup before, if in doubt.`, phrase: b.dataset.dropdb,
      onConfirm: async () => { try { await API.post(`${base()}/databases/drop`, { database: b.dataset.dropdb, confirm: b.dataset.dropdb }); showToast('Dropped'); st.info = await reloadInfo(st.c); drawShell(); drawTree(); drawAdmin(); } catch (e) { showToast(e.message, 'error', 9000); } } }));
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
    const url = `${dbBase()}/maintain`;
    const what = table ? `${schema}.${table}` : `the whole database ${st.db}`;
    const label = { vacuum: 'VACUUM ANALYZE', analyze: 'ANALYZE', reindex: 'REINDEX', vacuum_full: 'VACUUM FULL' }[action];
    showConfirm(label, `Run <b>${label}</b> on <b>${esc(what)}</b>?${action === 'vacuum_full' ? ' VACUUM FULL rewrites the table and <b>locks it</b> until it ends.' : action === 'reindex' ? ' REINDEX blocks writes to the table while it runs.' : ' It runs alongside normal work.'}`, async () => {
      showToast(`${label} running…`, 'info');
      try { const r = await API.post(url, { action, schema, table }); showToast(`${label} done in ${(r.ms / 1000).toFixed(1)} s`); if (st.view === 'admin') drawAdmin(); } catch (e) { showToast(e.message, 'error', 9000); }
    }, action === 'vacuum_full');
  }

  // ---------- Backups ----------
  async function drawBackups(pane = curPane()) {
    pane.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:200px"></div></div>';
    let b;
    try { b = await API.get(`${base()}/backups`); } catch (e) { if (alive()) pane.innerHTML = `<div class="card text-danger" style="padding:16px">${esc(e.message)}</div>`; return; }
    if (!alive() || !pane.isConnected) return;
    const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    pane.innerHTML = `
      <div class="dbg-bar"><b>Backups of ${esc(st.c)}</b><span class="ui-sub">in <span class="td-mono">${esc(b.dir)}</span>${b.local ? ' (DockGate\'s data folder)' : ' on the server'}</span><span style="flex:1"></span>
        ${b.local ? '' : UI.btn('Schedule…', 'data-sched')} ${UI.primary('Back up now', 'data-bk')}</div>
      ${UI.table([{ label: 'Backup' }, { label: 'Size' }, { label: 'Made' }, { label: '', align: 'right' }], b.files.map(f => ({ cells: [
        `${f.whole ? UI.pill('info', 'whole server') : `<b>${esc(f.database)}</b>`} <span class="ui-sub">${f.format === 'custom' ? 'pg_dump custom' : 'SQL, gzip'}</span><div class="td-mono ui-sub" style="font-size:11px">${esc(f.name)}</div>`,
        formatBytes(f.size), when(f.mtime),
        `${UI.btn('Download', `data-dl="${esc(f.name)}"`)} ${f.restorable ? UI.btn('Restore…', `data-rs="${esc(f.name)}"`) : UI.btn('How to restore', `data-howto="${esc(f.name)}"`)} ${UI.menu([{ label: `${Icons.trash} Delete…`, attrs: `data-delbk="${esc(f.name)}"`, danger: true }])}`] })), { empty: 'No backups yet — "Back up now" makes one.', minWidth: 620 })}
      <div class="ui-sub" style="margin-top:10px">A restore goes into a <b>new database</b> first, so you can look at it; then <b>Swap</b> puts it in place of the old one (kept, renamed). ${b.local ? 'Scheduled backups run on SSH servers (Scripts + Cron).' : 'Scheduled backups are a script in Server Console → Scripts with a Cron job, its log and failure alerts.'}</div>`;
    const m = pane;
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
    let sp = null;
    const sc = m.querySelector('[data-sched]'); if (sc) sc.onclick = () => UI.dialog({ title: 'Scheduled backups', saveLabel: 'Schedule',
      body: `<label class="ui-field"><span class="ui-label">What</span><select class="input" id="sc-d">${st.info.databases.filter(d => d.connect).map(d => `<option value="${esc(d.name)}" ${d.name === st.db ? 'selected' : ''}>Database ${esc(d.name)}</option>`).join('')}<option value="">The whole server (pg_dumpall)</option></select></label>
        <div class="ui-field"><span class="ui-label">When</span>${SchedulePicker.html('15 3 * * *')}</div>
        <label class="ui-field"><span class="ui-label">Keep for (days)</span><input class="input" id="sc-k" type="number" value="7" min="1" max="365"></label>
        <div class="ui-sub">Makes the script <span class="td-mono">pg-backup-…</span> in Server Console → Scripts (SQL .sql.gz files in this folder, older ones deleted, disk checked) and its Cron job — with a log and alerts when it fails or does not run.</div>`,
      onOpen: (ov) => { sp = SchedulePicker.bind(ov); },
      onSave: async (ov) => { const r = await API.post(`${base()}/backups/schedule`, { database: ov.querySelector('#sc-d').value, schedule: sp.value(), keepDays: Number(ov.querySelector('#sc-k').value) }); showToast(`Scheduled ${SchedulePicker.describe(sp.value()).toLowerCase()} — script ${r.script}`); } });
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
        st.info = await reloadInfo(st.c);
        const can = st.info.databases.some(x => x.name === f.database);
        const rm = showModal('Restored', `<div class="text-sm">The backup is in the new database <b>${esc(r.database)}</b> (${(r.ms / 1000).toFixed(1)} s). Open it to check it.${can ? ` When it looks right, <b>Swap</b> puts it in place of <b>${esc(f.database)}</b> — the current one is kept, renamed <span class="td-mono">${esc(f.database)}_before_…</span>. Apps connected to ${esc(f.database)} are disconnected for a moment.` : ''}</div>`,
          [{ label: 'Close', className: 'btn btn-secondary' }, { label: 'Open it', className: 'btn btn-secondary', onClick: () => { openOverview(st.c, r.database); } },
           ...(can ? [{ label: `Swap in place of ${f.database}`, className: 'btn btn-danger', onClick: () => swap(r.database, f.database) }] : [])]);
        const ft = rm.overlay.querySelector('.modal-footer'); if (ft) { ft.style.flexWrap = 'wrap'; ft.style.gap = '8px'; }
        drawShell(); drawTree(); drawBackups();
      } });
  }
  function swap(restored, into) {
    showDeleteConfirm('Swap databases', { message: `Put <b>${esc(restored)}</b> in place of <b>${esc(into)}</b>? Sessions on both are closed; the current <b>${esc(into)}</b> is kept as <span class="td-mono">${esc(into)}_before_…</span>.`, phrase: into,
      onConfirm: async () => { try { const r = await API.post(`${base()}/backups/swap`, { restored, into }); showToast(`Swapped — the old one is ${r.kept}`, 'success', 9000); st.info = await reloadInfo(st.c); openOverview(st.c, into); } catch (e) { showToast(e.message, 'error', 10000); } } });
  }


  // ---------- start ----------
  if (!(await loadContainers()) || !alive()) return;
  st.tabs = lsGet('tabs', []).filter(t => t && t.type && t.id && st.containers.some(c => c.name === t.c)).map(t => ({ ...t, grid: t.type === 'data' ? freshGrid(t.grid) : undefined }));
  if (!st.containers.some(c => [...st.open].some(k => k === `c|${c.name}`))) { const run = st.containers.find(c => c.state === 'running'); if (run) st.open.add(`c|${run.name}`); }
  drawTree(); drawStatus();
  await Promise.all([...st.open].filter(k => k.startsWith('c|') && st.containers.some(c => `c|${c.name}` === k && c.state === 'running')).map(k => ensureInfo(k.slice(2))));
  if (!alive()) return;
  await Promise.all([...st.open].filter(k => k.startsWith('d|')).map(k => { const p = parts(k); return st.infos[p[1]] && st.infos[p[1]].databases.some(d => d.name === p[2]) ? ensureObjects(p[1], p[2]) : null; }));
  [...st.open].filter(k => k.startsWith('t|')).forEach(k => { const p = parts(k); if (st.objects[`${p[1]}|${p[2]}`] && relOf(p[1], p[2], p[3], p[4])) ensureStruct(p[1], p[2], p[3], p[4]); });
  if (!alive()) return;
  if (params.c && st.containers.some(c => c.name === params.c)) {
    const c = params.c; st.open.add(`c|${c}`); saveOpen();
    const i = await ensureInfo(c);
    if (i) {
      const db = params.db && i.databases.some(d => d.name === params.db) ? params.db : i.database;
      st.open.add(`d|${c}|${db}`); saveOpen(); ensureObjects(c, db);
      if (params.t) await openTab({ type: params.view === 'design' ? 'design' : 'data', c, db, s: params.s || 'public', t: params.t }, { pin: true });
      else if (params.view === 'sql') await newQuery(c, db);
      else { const ex = st.tabs.find(t => t.c === c && (t.db === db || !t.db)); if (ex) await activate(ex.id); else await openTab({ type: 'overview', c, db }, { pin: true }); }
    } else drawWelcome();
  } else if (st.tabs.length) {
    const a = lsGet('active', null);
    await activate(st.tabs.some(t => t.id === a) ? a : st.tabs[0].id);
  } else drawWelcome();
  drawTabs(); drawStatus();
});
