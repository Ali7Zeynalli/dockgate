// SQL Workbench (Tools > Databases > SQL): CodeMirror editor with completion from the database, tabs kept on the
// server, one psql session per tab (transactions, SET, temp tables live across runs), Test run that always rolls
// back, Commit / Roll back, Cancel, results with more rows, and the schema, saved queries and history beside it.
// SqlWorkbench.mount(el, { base, dbBase, db, info, initialSql, onSchemaChanged, toggleWrite }) -> { destroy }
const SqlWorkbench = (() => {
  let cmReady = null;
  function loadCM() {
    if (window.CodeMirror) return Promise.resolve();
    if (cmReady) return cmReady;
    cmReady = new Promise((resolve, reject) => {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/vendor/codemirror/codemirror.min.css'; document.head.appendChild(l);
      const s = document.createElement('script'); s.src = '/vendor/codemirror/codemirror.min.js'; s.onload = resolve; s.onerror = () => { cmReady = null; reject(new Error('The editor could not be loaded')); };
      document.head.appendChild(s);
    });
    return cmReady;
  }
  const docs = new Map(); // container|tab > CodeMirror.Doc (undo history survives page changes)
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('').slice(0, 14);
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const NULLV = '<span class="dbg-null">NULL</span>';

  // ---- statements (same rules as server/pg-sql.js split) ----
  function split(text) {
    const s = String(text || ''); const out = []; let i = 0, start = 0; const n = s.length;
    const push = (end) => { const part = s.slice(start, end); const bare = part.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim(); if (bare) { const lead = part.length - part.trimStart().length; out.push({ start: start + lead, end, sql: part.trim() }); } };
    while (i < n) {
      const c = s[i], d = s[i + 1];
      if (c === '-' && d === '-') { const e = s.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
      if (c === '/' && d === '*') { let dp = 1; i += 2; while (i < n && dp) { if (s[i] === '/' && s[i + 1] === '*') { dp++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { dp--; i += 2; } else i++; } continue; }
      if (c === "'") { const e2 = i > 0 && /[eE]/.test(s[i - 1]) && !/[\w$]/.test(s[i - 2] || ''); i++; while (i < n) { if (e2 && s[i] === '\\') { i += 2; continue; } if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; } i++; } continue; }
      if (c === '"') { i++; while (i < n) { if (s[i] === '"') { if (s[i + 1] === '"') { i += 2; continue; } i++; break; } i++; } continue; }
      if (c === '$') { const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(s.slice(i)); if (m && !/\w/.test(s[i - 1] || '')) { const e = s.indexOf(m[0], i + m[0].length); i = e < 0 ? n : e + m[0].length; continue; } }
      if (c === ';') { push(i); start = i + 1; }
      i++;
    }
    push(n);
    return out;
  }

  // ---- a small formatter: keywords in capitals, main clauses on their own line ----
  const KW = 'select|from|where|and|or|not|in|is|null|as|on|join|left|right|full|inner|outer|cross|lateral|group|by|order|having|limit|offset|union|all|distinct|insert|into|values|update|set|delete|returning|with|recursive|case|when|then|else|end|asc|desc|nulls|first|last|create|table|index|view|drop|alter|add|column|primary|key|foreign|references|unique|default|constraint|exists|between|like|ilike|begin|commit|rollback|true|false|over|partition|window|filter|using|cascade|if|materialized|explain|analyze|grant|revoke|to|truncate|vacuum|do|conflict|nothing';
  const KWRE = new RegExp(`\\b(${KW})\\b`, 'gi');
  const BREAK = /^(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION( ALL)?|VALUES|SET|RETURNING|ON CONFLICT|(LEFT |RIGHT |FULL |INNER |CROSS )?(OUTER )?JOIN|WINDOW)\b/;
  function format(text) {
    return split(text).map(st => {
      // keep quoted parts, comments and $...$ bodies as they are
      const parts = []; const keep = (m) => { parts.push(m); return `\u0001${parts.length - 1}\u0001`; };
      let s = st.sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, keep);
      s = s.replace(/\s+/g, ' ').replace(KWRE, (w) => w.toUpperCase());
      s = s.replace(/ (?=(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION|VALUES|SET|RETURNING|ON CONFLICT|(LEFT |RIGHT |FULL |INNER |CROSS )?(OUTER )?JOIN|WINDOW)\b)/g, '\n');
      s = s.replace(/ (AND|OR) /g, '\n  $1 ').replace(/,(?! )/g, ', ');
      s = s.split('\n').map(l => BREAK.test(l) || /^ {2}(AND|OR)/.test(l) ? l : '  ' + l).join('\n').replace(/^ {2}/, '');
      return s.replace(/\u0001(\d+)\u0001/g, (_, k) => parts[k]) + ';';
    }).join('\n\n');
  }

  async function mount(el, ctx) {
    const { base, dbBase } = ctx;
    el.innerHTML = `<style>
      .wb{display:grid;grid-template-columns:230px minmax(0,1fr);gap:12px;align-items:start}
      .wb.wb-noside{grid-template-columns:minmax(0,1fr)} .wb.wb-noside .wb-side{display:none} .wb.wb-single .wb-tabs{display:none}
      @media (max-width:1100px){.wb{grid-template-columns:1fr}.wb-side{display:none}}
      .wb-side{border:1px solid var(--border);border-radius:10px;padding:8px;max-height:calc(100vh - 220px);overflow:auto;font-size:12.5px}
      .wb-side .wb-it{display:flex;gap:6px;align-items:center;width:100%;text-align:left;background:none;border:0;color:var(--text-primary);padding:3px 4px;border-radius:5px;cursor:pointer;font:inherit}
      .wb-side .wb-it:hover{background:var(--bg-hover,rgba(255,255,255,.05))} .wb-side .wb-col{padding-left:20px;color:var(--text-secondary)}
      .wb-tabs{display:flex;gap:4px;align-items:center;overflow-x:auto;margin-bottom:6px}
      .wb-tab{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--border);border-radius:8px 8px 0 0;background:var(--bg-secondary);color:var(--text-secondary);cursor:pointer;font-size:12.5px;white-space:nowrap}
      .wb-tab[aria-selected=true]{color:var(--text-primary);border-color:var(--accent,#3b82f6);background:var(--bg-primary)}
      .wb-tab .wb-x{opacity:.5;border:0;background:none;color:inherit;cursor:pointer;padding:0 2px} .wb-tab .wb-x:hover{opacity:1}
      .wb-tool{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
      .wb-ed .CodeMirror{height:260px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:13px;resize:vertical;overflow:hidden}
      .wb-ed .CodeMirror-gutters{background:var(--bg-secondary);border-right:1px solid var(--border)} .wb-ed .CodeMirror-linenumber{color:var(--text-muted)}
      .wb-ed .CodeMirror-cursor{border-left-color:var(--text-primary)} .wb-ed .CodeMirror-selected,.wb-ed .CodeMirror-focused .CodeMirror-selected{background:rgba(59,130,246,.28)}
      .wb-ed .CodeMirror-activeline-background{background:rgba(127,127,127,.08)} .wb-ed .CodeMirror-matchingbracket{color:var(--success)!important;text-decoration:underline}
      .wb-ed .cm-keyword{color:#c678dd} .wb-ed .cm-string{color:#98c379} .wb-ed .cm-number{color:#d19a66} .wb-ed .cm-comment{color:var(--text-muted);font-style:italic}
      .wb-ed .cm-variable-2,.wb-ed .cm-builtin{color:#61afef} .wb-ed .cm-type{color:#e5c07b} .wb-ed .cm-operator{color:#56b6c2} .wb-ed .cm-atom{color:#d19a66}
      .wb-ed .wb-errmark{background:rgba(239,68,68,.25);border-bottom:2px wavy var(--danger)}
      .CodeMirror-hints{z-index:2000;background:var(--bg-secondary);border:1px solid var(--border);font-family:var(--font-mono,monospace);font-size:12.5px}
      .CodeMirror-hint{color:var(--text-primary)} li.CodeMirror-hint-active{background:var(--accent,#3b82f6);color:#fff}
      .wb-rtabs{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0 6px} .wb-rtab{padding:3px 10px;border:1px solid var(--border);border-radius:999px;background:none;color:var(--text-secondary);cursor:pointer;font-size:12px}
      .wb-rtab[aria-selected=true]{color:var(--text-primary);border-color:var(--accent,#3b82f6)} .wb-rtab.err{border-color:var(--danger);color:var(--danger)}
      .wb-banner{padding:6px 10px;border-radius:8px;font-size:12.5px;margin-bottom:6px}
      .wb-plan{font-size:12.5px} .wb-node{border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin:4px 0;background:var(--bg-secondary)}
      .wb-node .wb-bar{height:4px;border-radius:2px;background:var(--accent,#3b82f6);margin-top:4px;min-width:2px} .wb-node.hot .wb-bar{background:var(--danger)}
      .wb-node small{color:var(--text-muted)} .wb-kids{margin-left:18px;border-left:1px dashed var(--border);padding-left:8px}
    </style>
    <div class="wb${ctx.single ? ' wb-single' : ''}"><div class="wb-side" data-side></div><div style="min-width:0">
      <div class="wb-tabs" data-tabs></div>
      <div class="wb-tool" data-tool></div>
      <div class="wb-ed" data-ed><div class="skeleton" style="height:260px"></div></div>
      <div data-res><div class="ui-sub" style="margin-top:8px">Ctrl+Enter runs the statement at the cursor (or the selection), Ctrl+Shift+Enter runs all, 🧪 Test run does it in a transaction and rolls it back, Ctrl+Space completes names, Ctrl+/ comments a line.</div></div>
    </div></div>`;
    const $ = (s) => el.querySelector(s);
    try { await loadCM(); } catch (e) { $('[data-ed]').innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; return { destroy() {} }; }
    const st = { tabs: [], cur: null, running: false, tx: 'idle', timeoutMs: Number(localStorage.getItem('dg-wb-timeout')) || 30000, side: localStorage.getItem('dg-wb-side') || 'schema', schema: null, last: null, resTab: 0, sort: null, filter: '' };
    let alive = true;

    // ---- tabs ----
    try { st.tabs = (await API.get(`${base}/tabs`)).tabs; } catch (e) { st.tabs = []; }
    // single: one query of the page's own tab strip (the IDE layout) - this editor shows only that one
    if (ctx.single) {
      let one = st.tabs.find(t => t.id === ctx.single.id);
      const fresh = !one;
      if (!one) one = { id: ctx.single.id, name: ctx.single.name || 'Query', sql: ctx.single.sql != null ? ctx.single.sql : 'SELECT now();', position: st.tabs.length };
      st.tabs = [one]; st.cur = one.id; st.freshSingle = fresh;
    } else if (!st.tabs.length) st.tabs = [{ id: rid(), name: 'Query 1', sql: ctx.initialSql || 'SELECT now();', position: 0 }];
    else if (ctx.initialSql) st.tabs.push({ id: rid(), name: `Query ${st.tabs.length + 1}`, sql: ctx.initialSql, position: st.tabs.length });
    if (!ctx.single) st.cur = ctx.initialSql ? st.tabs[st.tabs.length - 1].id : (localStorage.getItem(`dg-wb-cur:${base}`) && st.tabs.some(t => t.id === localStorage.getItem(`dg-wb-cur:${base}`)) ? localStorage.getItem(`dg-wb-cur:${base}`) : st.tabs[0].id);
    const tab = () => st.tabs.find(t => t.id === st.cur);
    const docOf = (t) => { const k = `${base}|${t.id}`; if (!docs.has(k)) docs.set(k, CodeMirror.Doc(t.sql || '', 'text/x-pgsql')); return docs.get(k); };
    const saveTab = (t) => API.put(`${base}/tabs/${t.id}`, { name: t.name, dbname: ctx.db(), sql: t.sql, position: st.tabs.indexOf(t) }).catch(() => {});
    if (ctx.initialSql || st.freshSingle) saveTab(tab());

    $('[data-ed]').innerHTML = '';
    const cm = CodeMirror($('[data-ed]'), {
      value: '', mode: 'text/x-pgsql', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, indentUnit: 2, tabSize: 2, smartIndent: true,
      placeholder: 'Write SQL...', extraKeys: {
        'Ctrl-Enter': () => run('current'), 'Cmd-Enter': () => run('current'),
        'Shift-Ctrl-Enter': () => run('all'), 'Shift-Cmd-Enter': () => run('all'),
        'Ctrl-Space': 'autocomplete', 'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment',
        'Shift-Alt-F': () => doFormat(), 'Ctrl-S': () => saveQuery(), 'Cmd-S': () => saveQuery(),
        Tab: (c) => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  '),
      },
      hintOptions: { completeSingle: false, tables: {} },
    });
    cm.swapDoc(docOf(tab()));
    let saveT = null;
    cm.on('change', () => { const t = tab(); t.sql = cm.getValue(); clearTimeout(saveT); saveT = setTimeout(() => saveTab(t), 700); clearErr(); });
    cm.on('inputRead', (c, ch) => { if (!c.state.completionActive && /^[\w.]$/.test(ch.text[0] || '') && c.getTokenAt(c.getCursor()).type !== 'string' && c.getTokenAt(c.getCursor()).type !== 'comment') c.showHint({ completeSingle: false }); });
    let errMark = null;
    const clearErr = () => { if (errMark) { errMark.clear(); errMark = null; } };

    function drawTabs() {
      if (ctx.single) return;
      $('[data-tabs]').innerHTML = st.tabs.map(t => `<div class="wb-tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === st.cur}" title="Double-click to rename">${esc(t.name)}${st.tabs.length > 1 ? `<button type="button" class="wb-x" data-close="${t.id}" aria-label="Close">×</button>` : ''}</div>`).join('')
        + '<button type="button" class="btn btn-xs btn-ghost" data-newtab title="New tab">+</button>';
      el.querySelectorAll('[data-tab]').forEach(x => {
        x.onclick = (e) => { if (e.target.closest('[data-close]')) return; switchTo(x.dataset.tab); };
        x.ondblclick = () => { const t = st.tabs.find(y => y.id === x.dataset.tab); const n = prompt('Tab name', t.name); if (n && n.trim()) { t.name = n.trim().slice(0, 60); saveTab(t); drawTabs(); } };
      });
      el.querySelectorAll('[data-close]').forEach(b => b.onclick = async () => {
        const t = st.tabs.find(y => y.id === b.dataset.close);
        let s = null; try { s = await API.get(`${base}/session/${t.id}`); } catch (e) {}
        if (s && s.tx && s.tx !== 'idle' && !confirm('A transaction is open in this tab. Closing it rolls the transaction back. Close?')) return;
        await API.del(`${base}/tabs/${t.id}`).catch(() => {});
        docs.delete(`${base}|${t.id}`);
        st.tabs = st.tabs.filter(y => y !== t);
        if (st.cur === t.id) switchTo(st.tabs[0].id); else drawTabs();
      });
      $('[data-newtab]').onclick = () => newTab('');
    }
    function newTab(sql, name) {
      const t = { id: rid(), name: name || `Query ${st.tabs.length + 1}`, sql: sql || '', position: st.tabs.length };
      st.tabs.push(t); saveTab(t); switchTo(t.id); return t;
    }
    async function switchTo(id) {
      st.cur = id; if (!ctx.single) try { localStorage.setItem(`dg-wb-cur:${base}`, id); } catch (e) {}
      cm.swapDoc(docOf(tab())); drawTabs(); cm.focus();
      st.last = null; st.tx = 'idle';
      try { const s = await API.get(`${base}/session/${id}`); st.tx = s.tx || 'idle'; } catch (e) {}
      drawTool(); $('[data-res]').innerHTML = '';
    }

    // ---- toolbar ----
    function drawTool() {
      const w = ctx.info().allowWrite;
      $('[data-tool]').innerHTML = `
        ${UI.primary(st.running ? 'Running...' : '▶ Run', `data-run="current" ${st.running ? 'disabled' : ''} title="The statement at the cursor, or the selection (Ctrl+Enter)"`)}
        ${UI.btn('▶▶ Run all', `data-run="all" ${st.running ? 'disabled' : ''} title="Every statement (Ctrl+Shift+Enter)"`)}
        ${UI.btn('🧪 Test run', `data-run="test" ${st.running ? 'disabled' : ''} title="Run it inside a transaction and roll it back - see what it would do, nothing stays"`)}
        ${UI.menu([{ label: '📊 Explain - the plan, without running it', attrs: 'data-explain="plan"' }, { label: '📊 Explain analyze - runs it (rolled back) and times every step', attrs: 'data-explain="analyze"' }], { label: 'Explain' }).replace('>⋯<', '>📊 Explain<')}
        ${st.running ? UI.btn('⏹ Cancel', 'data-cancel', 'btn-danger') : ''}
        ${ctx.single ? UI.btn('☰', `data-sidetoggle title="Saved queries, snippets, history, schema"`) : ''} ${UI.btn('Format', 'data-format title="Shift+Alt+F"')} ${UI.btn('Save...', 'data-save title="Save as a saved query (Ctrl+S)"')}
        <select class="input" data-timeout title="Time limit per statement" style="width:auto;padding:3px 6px;font-size:12px">${[[30000, '30 s'], [60000, '1 min'], [300000, '5 min'], [600000, '10 min']].map(([v, l]) => `<option value="${v}" ${v === st.timeoutMs ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span style="flex:1"></span>
        ${st.tx === 'open' ? `${UI.pill('warn', '● Transaction open')} ${UI.btn('Commit', 'data-commit', 'btn-primary')} ${UI.btn('Roll back', 'data-rollback')}` : st.tx === 'aborted' ? `${UI.pill('bad', 'Transaction failed')} ${UI.btn('Roll back', 'data-rollback', 'btn-danger')}` : `<span class="ui-sub">${w ? 'changes allowed' : 'read-only - Test run still works'}, session on ${esc(ctx.db())}</span>`}`;
      el.querySelectorAll('[data-run]').forEach(b => b.onclick = () => run(b.dataset.run));
      el.querySelectorAll('[data-explain]').forEach(b => b.onclick = () => run(b.dataset.explain === 'analyze' ? 'explain-analyze' : 'explain'));
      const c = $('[data-cancel]'); if (c) c.onclick = async () => { try { await API.post(`${base}/session/${st.cur}/cancel`, {}); } catch (e) { showToast(e.message, 'error'); } };
      $('[data-format]').onclick = doFormat; $('[data-save]').onclick = saveQuery;
      const stg = $('[data-sidetoggle]'); if (stg) stg.onclick = () => { const w = el.querySelector('.wb'); w.classList.toggle('wb-noside'); try { localStorage.setItem('dg-wb-sidevis', w.classList.contains('wb-noside') ? '0' : '1'); } catch (e) {} if (!w.classList.contains('wb-noside')) drawSide(); };
      $('[data-timeout]').onchange = (e) => { st.timeoutMs = Number(e.target.value); try { localStorage.setItem('dg-wb-timeout', st.timeoutMs); } catch (er) {} };
      const cmt = $('[data-commit]'); if (cmt) cmt.onclick = () => endTx('commit');
      const rb = $('[data-rollback]'); if (rb) rb.onclick = () => endTx('rollback');
    }
    async function endTx(action) {
      try { const r = await API.post(`${base}/session/${st.cur}/${action}`, {}); st.tx = r.tx; showToast(action === 'commit' ? (r.ok ? 'Committed' : `Commit failed: ${r.message}`) : 'Rolled back', r.ok === false ? 'error' : 'success'); drawTool(); if (action === 'commit') ctx.onSchemaChanged(); }
      catch (e) { showToast(e.message, 'error'); }
    }
    function doFormat() { const sel = cm.somethingSelected(); const txt = sel ? cm.getSelection() : cm.getValue(); const f = format(txt); if (!f) return; if (sel) cm.replaceSelection(f); else cm.setValue(f); }

    // ---- run ----
    function pick(kind) {
      if (kind !== 'all' && cm.somethingSelected()) { const from = cm.indexFromPos(cm.getCursor('from')); return { sql: cm.getSelection(), base: from }; }
      const text = cm.getValue();
      if (kind === 'all' || kind === 'test-all') return { sql: text, base: 0 };
      const at = cm.indexFromPos(cm.getCursor());
      const sts = split(text);
      const st1 = sts.find(s => at >= s.start && at <= s.end + 1) || [...sts].reverse().find(s => s.start <= at) || sts[0];
      return st1 ? { sql: text.slice(st1.start, st1.end), base: st1.start } : { sql: '', base: 0 };
    }
    const paramValues = {}; // remembered per editor while the page is open
    async function run(kind, confirmed = false, params = null) {
      if (st.running) return;
      const explain = kind === 'explain' || kind === 'explain-analyze';
      const test = kind === 'test' || kind === 'explain-analyze';
      const p = pick(kind === 'test' ? (cm.somethingSelected() ? 'current' : 'all') : explain ? 'current' : kind);
      if (!p.sql.trim()) return;
      if (explain) {
        if (split(p.sql).length !== 1) return showToast('Explain works on one statement - put the cursor in it', 'warning');
        p.sql = `EXPLAIN (${kind === 'explain-analyze' ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${split(p.sql)[0].sql}`; p.base = -1;
      }
      st.running = true; drawTool(); clearErr();
      $('[data-res]').innerHTML = '<div class="ui-sub" style="margin-top:8px">Running...</div>';
      let r;
      try { r = await API.post(`${dbBase()}/session/${st.cur}/run`, { sql: p.sql, mode: test ? 'test' : 'run', confirm: confirmed, timeoutMs: st.timeoutMs, ...(params ? { params } : {}) }); }
      catch (e) {
        st.running = false; drawTool();
        if (e.code === 'NEEDS_PARAMS') { $('[data-res]').innerHTML = ''; return askParams(e.data.names, (vals) => run(kind, confirmed, vals)); }
        if (e.code === 'NEEDS_CONFIRM') {
          $('[data-res]').innerHTML = '';
          const list = (e.data.danger || []).map(x => `<li>${x.statement ? `Statement ${x.statement}: ` : ''}<b>${esc(x.why)}</b>${x.sql ? `<div class="td-mono ui-sub" style="font-size:12px">${esc(x.sql)}</div>` : ''}</li>`).join('');
          return showConfirm('Run it?', `<ul style="margin:0 0 8px;padding-left:18px">${list}</ul>Tip: <b>🧪 Test run</b> shows what it would do and rolls it back.`, () => run(kind, true, params), true);
        }
        $('[data-res]').innerHTML = `<div class="card" style="margin-top:8px;border-color:var(--danger);padding:10px 12px"><div class="text-danger" style="white-space:pre-wrap">${esc(e.message)}</div>${e.code === 'READ_ONLY' ? `<div style="margin-top:8px">${UI.btn('Allow changes...', 'data-allow')} ${UI.btn('🧪 Test run instead', 'data-testinstead')}</div>` : ''}</div>`;
        const a = $('[data-allow]'); if (a) a.onclick = () => ctx.toggleWrite();
        const ti = $('[data-testinstead]'); if (ti) ti.onclick = () => run('test');
        return;
      }
      st.running = false; st.tx = r.tx; st.last = { ...r, base: p.base }; st.resTab = r.results.findIndex(x => x.kind === 'rows'); if (st.resTab < 0) st.resTab = -1; st.sort = null; st.filter = '';
      if (explain && !r.error && r.results[0] && r.results[0].rows[0]) { try { st.last.plan = JSON.parse(r.results[0].rows[0][0]); st.last.analyze = kind === 'explain-analyze'; st.resTab = -2; } catch (e) {} }
      drawTool(); drawResults();
      if (r.error && r.error.offset != null && p.base >= 0) {
        const from = cm.posFromIndex(p.base + r.error.offset); const wordEnd = cm.findWordAt(from).head;
        errMark = cm.markText(from, wordEnd.ch > from.ch && wordEnd.line === from.line ? wordEnd : { line: from.line, ch: from.ch + 1 }, { className: 'wb-errmark' });
        cm.setCursor(from); cm.scrollIntoView(from, 60);
      }
      if (r.writes && !r.error && !test) ctx.onSchemaChanged();
    }

    // ---- results ----
    function drawResults() {
      const r = st.last; if (!r) return;
      const rowsRes = r.results.filter(x => x.kind === 'rows');
      const tags = r.results.filter(x => x.kind === 'tag' || x.tag);
      const banner = r.plan && r.analyze ? `<div class="wb-banner" style="background:rgba(16,185,129,.1);border:1px solid var(--success)">📊 <b>Explain analyze</b> ran the statement inside a transaction and <b>rolled it back</b>.</div>` : r.rolledBack ? `<div class="wb-banner" style="background:rgba(16,185,129,.1);border:1px solid var(--success)">🧪 <b>Test run</b> - everything above was <b>rolled back</b>; nothing changed in the database.</div>` : '';
      const tabsH = (r.plan ? `<button type="button" class="wb-rtab" data-rt="-2" aria-selected="${st.resTab === -2}">📊 Plan</button>` : '') + rowsRes.filter(() => !r.plan).map(x => `<button type="button" class="wb-rtab" data-rt="${x.index}" aria-selected="${st.resTab === x.index}">${x.statement}. ${(x.total || 0).toLocaleString()} row${x.total === 1 ? '' : 's'}</button>`).join('')
        + `<button type="button" class="wb-rtab ${r.error ? 'err' : ''}" data-rt="-1" aria-selected="${st.resTab === -1}">Messages${r.error ? ' ⚠' : ''}</button>`;
      let body = '';
      if (st.resTab === -2 && r.plan) body = planHtml(r.plan, r.analyze);
      else if (st.resTab === -1) {
        body = `<div class="card" style="padding:10px 12px;font-size:12.5px">
          ${tags.map(x => `<div><span class="ui-sub">${x.statement}.</span> <span class="td-mono">${esc(x.tag || 'OK')}</span></div>`).join('')}
          ${r.error ? `<div style="margin-top:6px"><b class="text-danger">Statement ${r.error.statement} failed</b> <span class="ui-sub">- the statements after it did not run${r.tx === 'aborted' ? '; the transaction failed - Roll back' : ''}</span><pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:4px 0 0">${esc(r.error.message)}</pre></div>` : ''}
          ${(r.notices || []).map(n => `<pre class="td-mono ui-sub" style="white-space:pre-wrap;font-size:12px;margin:4px 0 0">${n.statement}. ${esc(n.text)}</pre>`).join('')}
          <div class="ui-sub" style="margin-top:6px">${r.ms} ms, session ${r.pid}${r.tx === 'open' ? ', transaction open' : ''}</div></div>`;
      } else {
        const x = r.results.find(y => y.index === st.resTab);
        body = gridHtml(x);
      }
      $('[data-res]').innerHTML = `<div class="wb-rtabs">${tabsH}<span style="flex:1"></span><span class="ui-sub" style="align-self:center">${r.ms} ms</span></div>${banner}${body}`;
      el.querySelectorAll('[data-rt]').forEach(b => b.onclick = () => { st.resTab = Number(b.dataset.rt); st.sort = null; st.filter = ''; drawResults(); });
      bindGrid();
    }
    const view = (x) => {
      let rows = x.rows.map((row, i) => ({ row, i }));
      const f = st.filter.trim().toLowerCase();
      if (f) rows = rows.filter(o => o.row.some(v => v != null && String(v).toLowerCase().includes(f)));
      if (st.sort) { const { col, dir } = st.sort; const num = rows.every(o => o.row[col] == null || /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(o.row[col])); rows.sort((a, b) => { const va = a.row[col], vb = b.row[col]; if (va == null) return 1; if (vb == null) return -1; const c = num ? Number(va) - Number(vb) : String(va).localeCompare(String(vb)); return dir === 'desc' ? -c : c; }); }
      return rows;
    };
    function gridHtml(x) {
      const rows = view(x);
      return `<div class="dbg-bar" style="margin:0 0 6px"><input class="input" data-gfilter placeholder="Filter these rows..." value="${esc(st.filter)}" style="max-width:240px;padding:3px 8px;font-size:12px">
          <span class="ui-sub">${rows.length.toLocaleString()} shown of ${x.rows.length.toLocaleString()} loaded${x.total > x.rows.length ? `, ${x.total.toLocaleString()} in all` : ''}${x.tag ? `, <span class="td-mono">${esc(x.tag)}</span>` : ''}${x.kept ? `, kept the first ${x.kept.toLocaleString()}` : ''}</span><span style="flex:1"></span>
          ${x.more ? UI.btn('Load 1000 more', 'data-gmore') : ''}
          ${UI.menu([{ label: 'Copy as CSV', attrs: 'data-copy="csv"' }, { label: 'Copy as TSV (for Excel)', attrs: 'data-copy="tsv"' }, { label: 'Copy as JSON', attrs: 'data-copy="json"' }, { label: 'Copy as INSERT statements', attrs: 'data-copy="insert"' }, '-', { label: 'Download CSV', attrs: 'data-dl="csv"' }, { label: 'Download JSON', attrs: 'data-dl="json"' }], { label: 'Copy / export' })}</div>
        <div class="dbg-grid" style="max-height:440px"><table><thead><tr><th style="cursor:default;width:1%;color:var(--text-muted)">#</th>${x.columns.map((c, i) => `<th data-gsort="${i}">${esc(c)}${st.sort && st.sort.col === i ? (st.sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 5000).map(o => `<tr><td style="color:var(--text-muted)">${o.i + 1}</td>${o.row.map((v, ci) => `<td data-gr="${o.i}" data-gc="${ci}" title="${v === null ? 'NULL' : esc(String(v).slice(0, 400))}">${v === null ? NULLV : esc(String(v).length > 200 ? String(v).slice(0, 200) + '...' : v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${x.columns.length + 1}" class="ui-sub" style="font-family:inherit">No rows</td></tr>`}</tbody></table></div>
        <div class="ui-sub" style="margin-top:4px">Click a column to sort these rows, double-click a cell to see all of it - or to edit it, when the query reads one table with its primary key.</div>`;
    }
    function bindGrid() {
      const r = st.last; const x = r && r.results.find(y => y.index === st.resTab); if (!x) return;
      el.querySelectorAll('[data-gsort]').forEach(th => th.onclick = () => { const c = Number(th.dataset.gsort); st.sort = !st.sort || st.sort.col !== c ? { col: c, dir: 'asc' } : st.sort.dir === 'asc' ? { col: c, dir: 'desc' } : null; drawResults(); });
      const gf = $('[data-gfilter]'); if (gf) { gf.oninput = () => { st.filter = gf.value; const pos = gf.selectionStart; drawResults(); const g2 = $('[data-gfilter]'); g2.focus(); g2.setSelectionRange(pos, pos); }; }
      const gm = $('[data-gmore]'); if (gm) gm.onclick = async () => {
        gm.disabled = true;
        try { const m = await API.get(`${base}/session/${st.cur}/more?result=${x.index}&offset=${x.rows.length}&limit=1000`); x.rows = x.rows.concat(m.rows); x.more = m.more; drawResults(); }
        catch (e) { showToast(e.message, 'error'); gm.disabled = false; }
      };
      el.querySelectorAll('td[data-gr]').forEach(td => td.ondblclick = async () => {
        const ri = Number(td.dataset.gr), ci = Number(td.dataset.gc);
        const v = x.rows[ri][ci];
        const ed = await editableOf(x);
        if (ed && ed.cols.has(x.columns[ci]) && !ed.pk.includes(x.columns[ci])) {
          if (!ctx.info().allowWrite) showToast('This result can be edited - turn on "Allow changes" first', 'info', 5000);
          else return UI.dialog({ title: `Edit ${esc(x.columns[ci])} <span class="ui-sub">${esc(ed.schema)}.${esc(ed.table)}</span>`, saveLabel: 'Save the value',
            body: `<div class="ui-sub" style="margin-bottom:8px">Row ${ed.pk.map(k => `${esc(k)} = <span class="td-mono">${esc(x.rows[ri][x.columns.indexOf(k)])}</span>`).join(', ')}</div><textarea class="input td-mono" id="re-v" rows="${v != null && (v.length > 80 || v.includes('\n')) ? 6 : 2}">${esc(v == null ? '' : v)}</textarea><label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px"><input type="checkbox" id="re-null" ${v === null ? 'checked' : ''}> NULL</label>`,
            onSave: async (ov) => {
              const nv = ov.querySelector('#re-null').checked ? null : ov.querySelector('#re-v').value;
              await API.post(`${dbBase()}/row/update`, { schema: ed.schema, table: ed.table, pk: Object.fromEntries(ed.pk.map(k => [k, x.rows[ri][x.columns.indexOf(k)]])), set: { [x.columns[ci]]: nv } });
              x.rows[ri][ci] = nv; showToast('Saved'); drawResults();
            } });
        }
        let pretty = v; try { if (v && /^[[{]/.test(v.trim())) pretty = JSON.stringify(JSON.parse(v), null, 2); } catch (e) {}
        showModal(esc(x.columns[Number(td.dataset.gc)]), v === null ? `<div>${NULLV}</div>` : `<pre class="td-mono" style="white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto;margin:0">${esc(pretty)}</pre>`,
          [{ label: 'Copy', className: 'btn btn-secondary', onClick: () => navigator.clipboard.writeText(v == null ? '' : v) }, { label: 'Close', className: 'btn btn-secondary' }]);
      });
      const asText = (kind) => {
        const rows = view(x).map(o => o.row);
        const q = (v) => v === null ? '' : /[",\n\r]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
        if (kind === 'csv') return [x.columns.map(q).join(','), ...rows.map(r2 => r2.map(q).join(','))].join('\n');
        if (kind === 'tsv') return [x.columns.join('\t'), ...rows.map(r2 => r2.map(v => v === null ? '' : String(v).replace(/[\t\n\r]/g, ' ')).join('\t'))].join('\n');
        if (kind === 'json') return JSON.stringify(rows.map(r2 => Object.fromEntries(x.columns.map((c, i) => [c, r2[i]]))), null, 2);
        const tbl = (/\bfrom\s+([\w."]+)/i.exec(x.sql) || [])[1] || 'table_name';
        const lit = (v) => v === null ? 'NULL' : /^-?\d+(\.\d+)?$/.test(v) ? v : "'" + String(v).replace(/'/g, "''") + "'";
        const cols = x.columns.map(c => /^[a-z_][a-z0-9_]*$/.test(c) ? c : '"' + c.replace(/"/g, '""') + '"').join(', ');
        return rows.map(r2 => `INSERT INTO ${tbl} (${cols}) VALUES (${r2.map(lit).join(', ')});`).join('\n');
      };
      el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard.writeText(asText(b.dataset.copy)).then(() => showToast('Copied'), () => showToast('Could not copy', 'error')));
      el.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => { const blob = new Blob([asText(b.dataset.dl)], { type: b.dataset.dl === 'csv' ? 'text/csv' : 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `result.${b.dataset.dl}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
    }

    // ---- the plan of EXPLAIN (FORMAT JSON) as a tree: time of each step, rows expected vs found ----
    function planHtml(planJson, analyze) {
      const top = (planJson && planJson[0]) || {}; const root = top.Plan; if (!root) return '<div class="ui-sub">No plan.</div>';
      const total = (n) => (n['Actual Total Time'] || 0) * (n['Actual Loops'] || 1);
      const own = (n) => Math.max(0, total(n) - (n.Plans || []).reduce((a, k) => a + total(k), 0));
      let max = 0; const walk = (n) => { max = Math.max(max, analyze ? own(n) : (n['Total Cost'] || 0)); (n.Plans || []).forEach(walk); }; walk(root);
      const fmt = (x) => x == null ? '' : Number(x).toLocaleString(undefined, { maximumFractionDigits: 2 });
      const node = (n) => {
        const est = n['Plan Rows'], act = n['Actual Rows'] != null ? n['Actual Rows'] * (n['Actual Loops'] || 1) : null;
        const off = act != null && est > 0 && (act / est > 10 || est / Math.max(act, 1) > 10);
        const seqBig = n['Node Type'] === 'Seq Scan' && (act != null ? act : est) > 10000;
        const spill = /external/i.test(n['Sort Method'] || '') || (n['Temp Written Blocks'] || 0) > 0;
        const weight = analyze ? own(n) : (n['Total Cost'] || 0); const hot = max > 0 && weight / max > 0.5;
        const what = [n['Join Type'] && `${n['Join Type']} join`, n['Relation Name'] && `on <b>${esc(n.Schema ? n.Schema + '.' : '')}${esc(n['Relation Name'])}</b>${n.Alias && n.Alias !== n['Relation Name'] ? ' ' + esc(n.Alias) : ''}`, n['Index Name'] && `using <b>${esc(n['Index Name'])}</b>`].filter(Boolean).join(' ');
        const cond = ['Index Cond', 'Hash Cond', 'Merge Cond', 'Recheck Cond', 'Join Filter', 'Filter', 'Sort Key', 'Group Key'].filter(k => n[k]).map(k => `<div><small>${k}:</small> <span class="td-mono">${esc(Array.isArray(n[k]) ? n[k].join(', ') : n[k])}</span></div>`).join('');
        return `<div class="wb-node ${hot ? 'hot' : ''}"><div><b>${esc(n['Node Type'])}</b> ${what}
            ${seqBig ? UI.pill('bad', 'whole table read') : ''} ${off ? UI.pill('warn', 'row estimate off') : ''} ${spill ? UI.pill('warn', 'used disk') : ''}</div>
          <div><small>${analyze ? `${fmt(own(n))} ms here, ${fmt(total(n))} ms with what is under it, ` : ''}rows ${analyze ? `${fmt(act)} found / ` : ''}${fmt(est)} expected${n['Actual Loops'] > 1 ? `, ${fmt(n['Actual Loops'])} loops` : ''}, cost ${fmt(n['Startup Cost'])}...${fmt(n['Total Cost'])}${n['Rows Removed by Filter'] ? `, ${fmt(n['Rows Removed by Filter'])} rows removed by the filter` : ''}${n['Shared Hit Blocks'] != null ? `, buffers hit ${fmt(n['Shared Hit Blocks'])} read ${fmt(n['Shared Read Blocks'])}` : ''}</small></div>
          ${cond}<div class="wb-bar" style="width:${max > 0 ? Math.max(1, Math.round(weight / max * 100)) : 1}%"></div></div>${(n.Plans || []).length ? `<div class="wb-kids">${n.Plans.map(node).join('')}</div>` : ''}`;
      };
      return `<div class="wb-plan">${analyze ? `<div class="ui-sub" style="margin-bottom:4px">Planning ${fmt(top['Planning Time'])} ms, execution ${fmt(top['Execution Time'])} ms - red bars take the most time</div>` : '<div class="ui-sub" style="margin-bottom:4px">The plan PostgreSQL would use (costs are its own units) - Explain analyze runs it and shows real times</div>'}${node(root)}
        <details style="margin-top:8px"><summary class="ui-sub" style="cursor:pointer">The plan as JSON</summary><pre class="td-mono" style="white-space:pre-wrap;font-size:11.5px;max-height:300px;overflow:auto">${esc(JSON.stringify(planJson, null, 2))}</pre></details></div>`;
    }

    function askParams(names, done) {
      UI.dialog({ title: 'Values for the parameters', saveLabel: 'Run', body: `<div class="ui-sub" style="margin-bottom:8px">Each <span class="td-mono">:name</span> is put in as a quoted value (numbers as they are).</div>${names.map(n => `<label class="ui-field"><span class="ui-label td-mono">:${esc(n)}</span><span style="display:flex;gap:8px;align-items:center"><input class="input td-mono" data-pv="${esc(n)}" value="${esc(paramValues[n] == null ? '' : paramValues[n])}"><label style="display:flex;gap:4px;align-items:center;font-weight:400"><input type="checkbox" data-pnull="${esc(n)}" ${paramValues[n] === null ? 'checked' : ''}> NULL</label></span></label>`).join('')}`,
        onSave: async (ov) => { const vals = {}; names.forEach(n => { vals[n] = ov.querySelector(`[data-pnull="${CSS.escape(n)}"]`).checked ? null : ov.querySelector(`[data-pv="${CSS.escape(n)}"]`).value; paramValues[n] = vals[n]; }); setTimeout(() => done(vals), 0); } });
    }

    // A result of "SELECT ... FROM one_table ..." that holds its primary key can be edited in place.
    const editInfo = new Map();
    async function editableOf(x) {
      if (editInfo.has(x)) return editInfo.get(x);
      let info = null;
      const m = /^\s*select\b[\s\S]*?\bfrom\s+((?:"[^"]+"|[a-z_][\w$]*)(?:\.(?:"[^"]+"|[a-z_][\w$]*))?)(?:\s+(?:as\s+)?[a-z_]\w*)?\s*(?:where\b|order\b|limit\b|offset\b|for\b|$)/i.exec(x.sql || '');
      if (m && !/\b(join|group\s+by|union|intersect|except|distinct|having)\b/i.test(x.sql) && !/,/.test(m[0].split(/\bfrom\b/i)[1].split(/\bwhere\b|\border\b|\blimit\b/i)[0])) {
        const parts = m[1].match(/"[^"]+"|[^.]+/g).map(p2 => p2.startsWith('"') ? p2.slice(1, -1).replace(/""/g, '"') : p2.toLowerCase());
        const schema = parts.length > 1 ? parts[0] : 'public', table = parts[parts.length - 1];
        try {
          const stc = await API.get(`${dbBase()}/structure?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`);
          if ((stc.kind === 'r' || stc.kind === 'p') && stc.pk.length && stc.pk.every(k => x.columns.includes(k))) info = { schema, table, pk: stc.pk, cols: new Set(stc.columns.map(c => c.name)) };
        } catch (e) {}
      }
      editInfo.set(x, info); return info;
    }

    const SNIPPETS = [
      ['Largest tables', `SELECT schemaname, relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size, n_live_tup AS rows\nFROM pg_stat_user_tables\nORDER BY pg_total_relation_size(relid) DESC\nLIMIT 20;`],
      ['Running queries', `SELECT pid, usename, datname, state, now() - query_start AS running_for, wait_event_type, left(query, 200) AS query\nFROM pg_stat_activity\nWHERE state <> 'idle' AND pid <> pg_backend_pid()\nORDER BY query_start;`],
      ['Who blocks whom', `SELECT blocked.pid AS blocked_pid, left(blocked.query, 120) AS blocked_query,\n       blocking.pid AS blocking_pid, left(blocking.query, 120) AS blocking_query\nFROM pg_stat_activity blocked\nJOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid));`],
      ['Unused indexes', `SELECT schemaname, relname AS table, indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan\nFROM pg_stat_user_indexes\nWHERE idx_scan = 0\nORDER BY pg_relation_size(indexrelid) DESC;`],
      ['Tables read without an index', `SELECT relname AS table, seq_scan, seq_tup_read, idx_scan, n_live_tup AS rows\nFROM pg_stat_user_tables\nWHERE seq_scan > 0\nORDER BY seq_tup_read DESC\nLIMIT 20;`],
      ['Cache hit ratio', `SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2) AS cache_hit_percent\nFROM pg_stat_database;`],
      ['Dead rows (needs VACUUM)', `SELECT relname AS table, n_live_tup, n_dead_tup, round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_percent, last_autovacuum\nFROM pg_stat_user_tables\nORDER BY n_dead_tup DESC\nLIMIT 20;`],
      ['Connections by state', `SELECT datname, state, count(*)\nFROM pg_stat_activity\nGROUP BY 1, 2\nORDER BY 3 DESC;`],
      ['Table columns', `SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = 'public' AND table_name = :table\nORDER BY ordinal_position;`],
      ['Find a value in a column', `SELECT *\nFROM :"table"\nWHERE :"column"::text ILIKE '%' || :value || '%'\nLIMIT 100;`.replace(/:"table"/g, 'my_table').replace(/:"column"/g, 'my_column')],
      ['Create an index (without blocking writes)', `CREATE INDEX CONCURRENTLY IF NOT EXISTS my_table_my_column_idx\n  ON my_table (my_column);`],
      ['A read-only user', `CREATE ROLE report_user LOGIN PASSWORD 'change-me';\nGRANT CONNECT ON DATABASE current_database_name TO report_user;\nGRANT USAGE ON SCHEMA public TO report_user;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO report_user;\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO report_user;`],
      ['Rows per day', `SELECT date_trunc('day', created_at) AS day, count(*)\nFROM my_table\nWHERE created_at > now() - interval '30 days'\nGROUP BY 1\nORDER BY 1;`],
    ];

    // ---- side: schema, saved, history ----
    async function drawSide() {
      const side = $('[data-side]');
      side.innerHTML = `${UI.seg([['schema', 'Schema'], ['saved', 'Saved'], ['snippets', 'Snippets'], ['history', 'History']], st.side, 'data-sideseg')}<div data-sidebody style="margin-top:8px"><div class="skeleton" style="height:80px"></div></div>`;
      side.querySelectorAll('[data-sideseg]').forEach(b => b.onclick = () => { st.side = b.dataset.sideseg; try { localStorage.setItem('dg-wb-side', st.side); } catch (e) {} drawSide(); });
      const body = side.querySelector('[data-sidebody]');
      const ins = (text) => { cm.replaceSelection(text); cm.focus(); };
      if (st.side === 'schema') {
        if (!st.schema) { try { st.schema = await API.get(`${dbBase()}/schema-index`); setHints(); } catch (e) { body.innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; return; } }
        if (!alive) return;
        const by = {}; st.schema.tables.forEach(t => { (by[t.schema] = by[t.schema] || []).push(t); });
        body.innerHTML = `<input class="input" data-sfind placeholder="Find..." style="padding:3px 8px;font-size:12px;margin-bottom:6px">` + Object.keys(by).sort((a, b) => a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)).map(s => `<div class="ui-sub" style="margin:6px 0 2px;text-transform:uppercase;font-size:10.5px">${esc(s)}</div>${by[s].map(t => `<div data-sfrow="${esc(t.name.toLowerCase())}"><button type="button" class="wb-it" data-tbl="${esc(s)}.${esc(t.name)}" title="Click: insert the name, ▸ columns"><span data-tog style="width:10px">▸</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</span><span class="ui-sub">${t.kind === 'v' || t.kind === 'm' ? 'view' : ''}</span></button><div data-cols hidden>${t.columns.map(c => `<button type="button" class="wb-it wb-col" data-colname="${esc(c.name)}" title="${esc(c.type)}">${esc(c.name)} <span class="ui-sub" style="margin-left:auto">${esc(c.type)}</span></button>`).join('')}</div></div>`).join('')}`).join('');
        body.querySelectorAll('[data-tbl]').forEach(b => b.onclick = (e) => {
          const cols = b.nextElementSibling;
          if (e.target.closest('[data-tog]')) { cols.hidden = !cols.hidden; b.querySelector('[data-tog]').textContent = cols.hidden ? '▸' : '▾'; return; }
          const [s, ...rest] = b.dataset.tbl.split('.'); const n = rest.join('.');
          const q2 = (x) => /^[a-z_][a-z0-9_]*$/.test(x) ? x : '"' + x.replace(/"/g, '""') + '"';
          ins(s === 'public' ? q2(n) : `${q2(s)}.${q2(n)}`);
        });
        body.querySelectorAll('[data-colname]').forEach(b => b.onclick = () => ins(/^[a-z_][a-z0-9_]*$/.test(b.dataset.colname) ? b.dataset.colname : `"${b.dataset.colname.replace(/"/g, '""')}"`));
        body.querySelector('[data-sfind]').oninput = (e) => { const q2 = e.target.value.toLowerCase(); body.querySelectorAll('[data-sfrow]').forEach(r2 => { r2.style.display = !q2 || r2.dataset.sfrow.includes(q2) ? '' : 'none'; }); };
      } else if (st.side === 'snippets') {
        body.innerHTML = `<div class="ui-sub" style="margin-bottom:6px">Ready queries - a click opens one in a new tab. <span class="td-mono">:name</span> asks for a value when it runs.</div>` + SNIPPETS.map(([n], i) => `<button type="button" class="wb-it" data-snip="${i}">${esc(n)}</button>`).join('');
        body.querySelectorAll('[data-snip]').forEach(b => b.onclick = () => { const [n, q2] = SNIPPETS[Number(b.dataset.snip)]; newTab(q2, n); });
      } else if (st.side === 'saved') {
        let list; try { list = (await API.get(`${base}/saved`)).saved; } catch (e) { body.innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; return; }
        if (!alive) return;
        const folders = [...new Set(list.map(x => x.folder || ''))];
        body.innerHTML = list.length ? folders.map(f => `${f ? `<div class="ui-sub" style="margin:6px 0 2px;text-transform:uppercase;font-size:10.5px">${esc(f)}</div>` : ''}${list.filter(x => (x.folder || '') === f).map(x => `<div style="display:flex;align-items:center"><button type="button" class="wb-it" data-open="${x.id}" title="${esc(x.description || x.sql.slice(0, 200))}" style="flex:1"><span style="overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span></button><button type="button" class="wb-x" style="border:0;background:none;color:var(--text-muted);cursor:pointer" data-delq="${x.id}" title="Delete">×</button></div>`).join('')}`).join('') : '<div class="ui-sub">No saved queries yet - <b>Save...</b> keeps the current tab here.</div>';
        body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const x = list.find(y => String(y.id) === b.dataset.open); newTab(x.sql, x.name); });
        body.querySelectorAll('[data-delq]').forEach(b => b.onclick = async () => { if (!confirm('Delete this saved query?')) return; await API.del(`${base}/saved/${b.dataset.delq}`); drawSide(); });
      } else {
        const load = async (q2) => {
          let list; try { list = (await API.get(`${base}/history?q=${encodeURIComponent(q2 || '')}`)).history; } catch (e) { return `<div class="text-danger">${esc(e.message)}</div>`; }
          return list.map(h => `<button type="button" class="wb-it" data-hist="${h.id}" style="display:block" title="${esc(h.sql.slice(0, 500))}"><div class="td-mono" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.sql.replace(/\s+/g, ' ').slice(0, 80))}</div><div class="ui-sub" style="font-size:11px">${h.ok ? '✓' : '<span style="color:var(--danger)">✗</span>'} ${h.mode === 'test' ? '🧪 ' : ''}${new Date(h.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}, ${h.ms} ms${h.dbname ? ', ' + esc(h.dbname) : ''}</div></button>`).join('') || '<div class="ui-sub">Nothing yet.</div>';
        };
        body.innerHTML = `<input class="input" data-hfind placeholder="Search history..." style="padding:3px 8px;font-size:12px;margin-bottom:6px"><div data-hlist>${await load('')}</div>`;
        let hist = [];
        const bindH = async () => { body.querySelectorAll('[data-hist]').forEach(b => b.onclick = async () => { if (!hist.length) hist = (await API.get(`${base}/history`)).history; const h = hist.find(x => String(x.id) === b.dataset.hist); if (h) { const t = tab(); if (!t.sql.trim()) cm.setValue(h.sql); else newTab(h.sql); } }); };
        bindH();
        let ht = null; body.querySelector('[data-hfind]').oninput = (e) => { clearTimeout(ht); ht = setTimeout(async () => { body.querySelector('[data-hlist]').innerHTML = await load(e.target.value); hist = (await API.get(`${base}/history?q=${encodeURIComponent(e.target.value)}`)).history; bindH(); }, 250); };
      }
    }
    function setHints() {
      if (!st.schema) return;
      const tables = {};
      const path = (st.schema.searchPath || '').split(',').map(s => s.trim().replace(/"/g, ''));
      st.schema.tables.forEach(t => { const cols = t.columns.map(c => c.name); tables[`${t.schema}.${t.name}`] = cols; if (t.schema === 'public' || path.includes(t.schema)) tables[t.name] = cols; });
      cm.setOption('hintOptions', { completeSingle: false, tables });
    }
    function saveQuery() {
      UI.dialog({ title: 'Save the query', saveLabel: 'Save', body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input" id="sq-n" value="${esc(tab().name)}"></label><label class="ui-field"><span class="ui-label">Folder <span class="ui-sub">(optional)</span></span><input class="input" id="sq-f" placeholder="Reports"></label><label class="ui-field"><span class="ui-label">Description <span class="ui-sub">(optional)</span></span><input class="input" id="sq-d"></label>`,
        onSave: async (ov) => { await API.post(`${base}/saved`, { name: ov.querySelector('#sq-n').value, folder: ov.querySelector('#sq-f').value, description: ov.querySelector('#sq-d').value, sql: cm.getValue(), dbname: ctx.db() }); showToast('Saved'); if (st.side === 'saved') drawSide(); } });
    }

    if (ctx.single && localStorage.getItem('dg-wb-sidevis') !== '1') el.querySelector('.wb').classList.add('wb-noside');
    drawTabs(); drawTool(); drawSide();
    try { const s = await API.get(`${base}/session/${st.cur}`); st.tx = s.tx || 'idle'; drawTool(); } catch (e) {}
    if (!st.schema) API.get(`${dbBase()}/schema-index`).then(s => { st.schema = s; setHints(); }).catch(() => {});
    setTimeout(() => { cm.refresh(); cm.focus(); }, 30);
    return {
      destroy() { alive = false; try { cm.swapDoc(CodeMirror.Doc('')); } catch (e) {} }, // let the tab's document go (a new editor takes it)
      refreshSchema() { st.schema = null; API.get(`${dbBase()}/schema-index`).then(s => { st.schema = s; setHints(); if (st.side === 'schema') drawSide(); }).catch(() => {}); },
      redrawTool: drawTool,
      /** Close the query (single mode): asks when a transaction is open, then forgets it. -> false when kept. */
      async close() {
        let s = null; try { s = await API.get(`${base}/session/${st.cur}`); } catch (e) {}
        if (s && s.tx && s.tx !== 'idle' && !confirm('A transaction is open in this query. Closing it rolls the transaction back. Close?')) return false;
        await API.del(`${base}/tabs/${st.cur}`).catch(() => {});
        docs.delete(`${base}|${st.cur}`);
        return true;
      },
      busy: () => st.running || st.tx === 'open',
      focus: () => setTimeout(() => { cm.refresh(); cm.focus(); }, 20),
    };
  }

  return { mount, split, format };
})();
