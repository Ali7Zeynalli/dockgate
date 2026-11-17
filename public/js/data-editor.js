// Databases → Data: a table as a spreadsheet. Click a cell to select it, Enter / double-click / typing edits it in
// place (lists for enums and booleans, a date box for dates, a JSON / long-text editor, a picker for foreign keys);
// changes wait in yellow until "Save" writes them all in ONE transaction (with a check that nobody changed those
// rows meanwhile) — or 🧪 Test does it and rolls back. Paste cells from Excel; add, copy and delete rows; open a row
// as a card with the rows it points to and the rows pointing at it.
// DataEditor.mount(el, { dbBase, schema, table, info, grid, openTable, toggleWrite, alive, kindName }) → { destroy, dirty }
const DataEditor = (() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const NULLV = '<span class="dbg-null">NULL</span>';
  const OPS = [['=', '='], ['!=', '≠'], ['contains', 'contains'], ['starts', 'starts with'], ['<', '<'], ['>', '>'], ['<=', '≤'], ['>=', '≥'], ['in', 'in (a, b)'], ['null', 'is NULL'], ['notnull', 'is not NULL']];
  const isAuto = (c) => !!(c.identity || c.generated || (c.default && /nextval\(|now\(\)|gen_random_uuid|uuid_generate|current_timestamp|current_date/i.test(c.default)));
  const editorKind = (c, v) => c.generated ? 'none' : c.enum ? 'enum' : c.category === 'B' ? 'bool' : c.base === 'date' ? 'date'
    : /^(json|jsonb|xml)$/.test(c.base) || c.category === 'A' || (v != null && (v.length > 120 || v.includes('\n'))) ? 'long' : c.fk ? 'fk' : 'text';

  async function mount(el, ctx) {
    const g = ctx.grid; // { offset, limit, sort, filters, where } — kept by the page
    const st = { d: null, sel: null, editing: null, edits: new Map(), news: [], dels: new Set(), checked: new Set(), failed: null };
    let alive = true;
    const dirty = () => st.edits.size + st.news.length + st.dels.size;

    async function load() {
      el.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:240px"></div></div>';
      try { st.d = await API.post(`${ctx.dbBase()}/rows`, { schema: ctx.schema, table: ctx.table, limit: g.limit, offset: g.offset, sort: g.sort, filters: g.filters, where: g.where }); }
      catch (e) {
        if (!alive) return;
        el.innerHTML = `<div class="card" style="padding:16px"><div class="text-danger">${esc(e.message)}</div>${g.filters.length || g.where ? `<div style="margin-top:8px">${UI.btn('Clear the filter', 'data-clear')}</div>` : ''}</div>`;
        const c = el.querySelector('[data-clear]'); if (c) c.onclick = () => { g.filters = []; g.where = ''; g.offset = 0; load(); };
        return;
      }
      if (!alive) return;
      st.edits.clear(); st.news = []; st.dels.clear(); st.checked.clear(); st.sel = null; st.failed = null;
      draw();
    }

    // ---- values ----
    const colIdx = (name) => st.d.columns.findIndex(c => c.name === name);
    const pkOf = (row) => Object.fromEntries(st.d.pk.map(p => [p, row[colIdx(p)]]));
    const valueAt = (rid, ci) => {
      if (rid[0] === 'n') { const n = st.news[Number(rid.slice(1))]; const c = st.d.columns[ci]; return n.defaults.has(c.name) ? undefined : (n.values[c.name] ?? ''); }
      const ri = Number(rid.slice(1)); const e = st.edits.get(ri); const c = st.d.columns[ci];
      return e && Object.prototype.hasOwnProperty.call(e, c.name) ? e[c.name] : st.d.rows[ri][ci];
    };
    function setValue(rid, ci, v) {
      const c = st.d.columns[ci];
      if (rid[0] === 'n') { const n = st.news[Number(rid.slice(1))]; n.defaults.delete(c.name); n.values[c.name] = v; return; }
      const ri = Number(rid.slice(1)); const orig = st.d.rows[ri][ci];
      const e = st.edits.get(ri) || {};
      if (v === orig) delete e[c.name]; else e[c.name] = v;
      if (Object.keys(e).length) st.edits.set(ri, e); else st.edits.delete(ri);
    }
    const editable = () => st.d.editable;

    // ---- drawing ----
    function cellHtml(rid, ci) {
      const c = st.d.columns[ci]; const v = valueAt(rid, ci);
      const changed = rid[0] === 'e' && st.edits.has(Number(rid.slice(1))) && Object.prototype.hasOwnProperty.call(st.edits.get(Number(rid.slice(1))), c.name);
      const sel = st.sel && st.sel.rid === rid && st.sel.ci === ci;
      const shown = v === undefined ? '<span class="dbg-null">default</span>' : v === null ? NULLV : esc(String(v).length > 200 ? String(v).slice(0, 200) + '…' : v);
      const fk = c.fk && v != null && v !== undefined && v !== '' ? ` <button type="button" class="dbg-fk" data-fkgo="${ci}" data-fkv="${esc(v)}" title="Open ${esc(c.fk.schema)}.${esc(c.fk.table)} where ${esc(c.fk.column)} = ${esc(v)}">↗</button>` : '';
      return `<td class="${changed ? 'dbg-chg' : ''} ${sel ? 'dbg-sel' : ''}" data-rid="${rid}" data-c="${ci}" title="${v == null ? (v === null ? 'NULL' : 'default') : esc(String(v).slice(0, 500))}">${shown}${fk}</td>`;
    }
    function rowHtml(rid) {
      const del = rid[0] === 'e' && st.dels.has(Number(rid.slice(1)));
      const isNew = rid[0] === 'n';
      const failed = st.failed && st.failed.rid === rid;
      return `<tr class="${del ? 'dbg-delrow' : ''} ${isNew ? 'dbg-newrow' : ''} ${failed ? 'dbg-failrow' : ''}" data-row="${rid}">
        <td class="dbg-rh">${editable() ? `<input type="checkbox" data-chk="${rid}" ${st.checked.has(rid) ? 'checked' : ''}>` : ''}<button type="button" class="dbg-open" data-card="${rid}" title="Open the row as a card">⤢</button></td>
        ${st.d.columns.map((c, ci) => cellHtml(rid, ci)).join('')}</tr>`;
    }
    function draw() {
      const d = st.d; const w = ctx.info().allowWrite; const n = dirty();
      const sortOf = (col) => { const s = g.sort.find(x => x.col === col); return s ? (s.dir === 'desc' ? ' ▼' : ' ▲') : ''; };
      el.innerHTML = `<style>
          .dbg-grid td.dbg-sel{outline:2px solid var(--accent,#3b82f6);outline-offset:-2px} .dbg-grid td.dbg-chg{background:rgba(234,179,8,.18)!important}
          .dbg-grid tr.dbg-newrow td{background:rgba(16,185,129,.10)} .dbg-grid tr.dbg-delrow td{text-decoration:line-through;opacity:.55;background:rgba(239,68,68,.10)}
          .dbg-grid tr.dbg-failrow td{box-shadow:inset 0 0 0 1px var(--danger)} .dbg-grid td.dbg-rh{font-family:inherit;white-space:nowrap;width:1%}
          .dbg-open,.dbg-fk{border:0;background:none;color:var(--text-muted);cursor:pointer;padding:0 3px;font:inherit} .dbg-open:hover,.dbg-fk:hover{color:var(--accent,#3b82f6)}
          .dbg-grid td input.dbg-in,.dbg-grid td select.dbg-in{width:100%;min-width:120px;font:inherit;padding:2px 4px;border:1px solid var(--accent,#3b82f6);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)}
          .dbg-grid:focus{outline:none} .dbg-pend{display:flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid rgba(234,179,8,.6);background:rgba(234,179,8,.08);border-radius:8px;margin-bottom:8px}
        </style>
        <div class="dbg-bar">
          <b style="font-size:15px">${esc(ctx.schema)}.${esc(ctx.table)}</b> <span class="ui-sub">${esc((ctx.kindName || {})[d.kind] || '')}${d.estimate >= 0 ? ` · ≈ ${d.estimate.toLocaleString()} rows` : ''}</span>
          <span style="flex:1"></span>
          ${UI.btn('🕘 Changes', 'data-history title="Who changed this table, when, and how"')} ${UI.btn('Count rows', 'data-count')} ${UI.btn('↻', 'data-reload title="Reload (drops changes not saved)"')}
          ${UI.menu([{ label: 'Export CSV', attrs: 'data-export="csv"' }, { label: 'Export JSON lines', attrs: 'data-export="json"' }], { label: 'Export' })}
          ${editable() ? `${UI.btn('+ Row', 'data-add')} ${UI.btn('Copy row', 'data-dup title="Copy the ticked row (or the selected one) as a new row"')} ${UI.btn('Delete', 'data-delsel title="Mark the ticked rows for deletion"', 'btn-danger')}` : `<span class="ui-sub" title="Rows are changed by primary key">${d.kind === 'r' || d.kind === 'p' ? 'no primary key — edit with SQL' : 'not editable'}</span>`}
        </div>
        ${n ? `<div class="dbg-pend"><b>${n} change${n === 1 ? '' : 's'} not saved</b><span class="ui-sub">${st.edits.size ? `${st.edits.size} edited` : ''}${st.news.length ? ` · ${st.news.length} new` : ''}${st.dels.size ? ` · ${st.dels.size} to delete` : ''}</span><span style="flex:1"></span>
          ${UI.btn('Review…', 'data-review')} ${UI.btn('🧪 Test', 'data-test title="Do it all in a transaction and roll it back"')} ${UI.btn('Discard', 'data-discard')} ${w ? UI.primary(`Save ${n}`, 'data-save') : UI.btn('Allow changes to save…', 'data-allow', 'btn-primary')}</div>` : ''}
        <div class="dbg-bar">
          ${g.filters.map((f, i) => UI.chip(`${esc(f.col)} ${esc((OPS.find(o => o[0] === f.op) || [f.op, f.op])[1])} ${f.op === 'null' || f.op === 'notnull' ? '' : esc(f.value)}`, { remove: i })).join('')}
          <select class="input" data-fcol style="width:auto;max-width:170px;padding:3px 6px;font-size:12px"><option value="">+ Filter…</option>${d.columns.map(c => `<option>${esc(c.name)}</option>`).join('')}</select>
          <span data-fmore style="display:none;gap:6px;align-items:center"><select class="input" data-fop style="width:auto;padding:3px 6px;font-size:12px">${OPS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select><input class="input td-mono" data-fval style="width:160px;padding:3px 8px;font-size:12px" placeholder="value"> ${UI.btn('Add', 'data-fadd')}</span>
          <input class="input td-mono" data-where style="flex:1;min-width:160px;padding:3px 8px;font-size:12px" placeholder="WHERE … (any condition, Enter)" value="${esc(g.where)}">
        </div>
        <div class="dbg-grid" tabindex="0" data-gridbox><table><thead><tr><th class="dbg-rh" style="cursor:default">${editable() ? '<input type="checkbox" data-chkall>' : ''}</th>${d.columns.map(c => `<th data-sort="${esc(c.name)}" title="${esc(c.type)}${c.notnull ? ' · NOT NULL' : ''}${c.default ? ' · default ' + c.default : ''}${c.fk ? ` · → ${c.fk.schema}.${c.fk.table}(${c.fk.column})` : ''}">${d.pk.includes(c.name) ? '🔑 ' : c.fk ? '↗ ' : ''}${esc(c.name)}${sortOf(c.name)}<small>${esc(c.type)}</small></th>`).join('')}</tr></thead>
          <tbody>${st.news.map((x, i) => rowHtml('n' + i)).join('')}${d.rows.map((r, i) => rowHtml('e' + i)).join('') || (st.news.length ? '' : `<tr><td colspan="${d.columns.length + 1}" class="ui-sub" style="font-family:inherit;padding:14px">No rows${g.filters.length || g.where ? ' match the filter' : ''}.</td></tr>`)}</tbody></table></div>
        <div class="dbg-bar" style="margin-top:8px">
          <span class="ui-sub">Rows ${d.rows.length ? `${g.offset + 1}–${g.offset + d.rows.length}` : '0'} · ${editable() ? 'click a cell, then type, Enter or double-click to edit · Tab / arrows move · paste cells from Excel · Ctrl+0 = NULL' : 'double-click a cell to see it'}</span><span style="flex:1"></span>
          <select class="input" data-limit style="width:auto;padding:3px 6px;font-size:12px">${[50, 100, 200, 500].map(x => `<option ${x === g.limit ? 'selected' : ''}>${x}</option>`).join('')}</select>
          ${UI.btn('‹ Prev', `data-prev ${g.offset <= 0 ? 'disabled' : ''}`)} ${UI.btn('Next ›', `data-next ${d.rows.length < g.limit ? 'disabled' : ''}`)}
        </div>`;
      bind();
    }
    const redrawRow = (rid) => { const tr = el.querySelector(`tr[data-row="${rid}"]`); if (!tr) return draw(); const tmp = document.createElement('tbody'); tmp.innerHTML = rowHtml(rid); tr.replaceWith(tmp.firstElementChild); bindRow(el.querySelector(`tr[data-row="${rid}"]`)); };
    const refreshPending = () => { const had = !!el.querySelector('.dbg-pend'); if (had !== !!dirty() || had) { const box = el.querySelector('[data-gridbox]'); const top = box ? box.scrollTop : 0, left = box ? box.scrollLeft : 0; draw(); const b2 = el.querySelector('[data-gridbox]'); if (b2) { b2.scrollTop = top; b2.scrollLeft = left; } } };

    // ---- interaction ----
    function guardLeave(fn) { if (!dirty()) return fn(); showConfirm('Changes not saved', `${dirty()} change${dirty() === 1 ? '' : 's'} would be lost. Go on?`, fn, true); }
    function bind() {
      const m = el;
      m.querySelector('[data-reload]').onclick = () => guardLeave(load);
      m.querySelector('[data-count]').onclick = async (e) => { const b = e.target; b.disabled = true; try { const r = await API.post(`${ctx.dbBase()}/count`, { schema: ctx.schema, table: ctx.table, filters: g.filters, where: g.where }); b.textContent = `${r.count.toLocaleString()} rows`; } catch (er) { showToast(er.message, 'error'); b.disabled = false; } };
      m.querySelectorAll('[data-export]').forEach(b => b.onclick = () => { window.location.href = `/api${ctx.dbBase()}/export?schema=${encodeURIComponent(ctx.schema)}&table=${encodeURIComponent(ctx.table)}&format=${b.dataset.export}`; });
      m.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => guardLeave(() => { const col = th.dataset.sort; const cur = g.sort.find(x => x.col === col); g.sort = !cur ? [{ col, dir: 'asc' }] : cur.dir === 'asc' ? [{ col, dir: 'desc' }] : []; g.offset = 0; load(); }));
      m.querySelector('[data-limit]').onchange = (e) => guardLeave(() => { g.limit = Number(e.target.value); g.offset = 0; load(); });
      m.querySelector('[data-prev]').onclick = () => guardLeave(() => { g.offset = Math.max(0, g.offset - g.limit); load(); });
      m.querySelector('[data-next]').onclick = () => guardLeave(() => { g.offset += g.limit; load(); });
      const fcol = m.querySelector('[data-fcol]'), fmore = m.querySelector('[data-fmore]');
      fcol.onchange = () => { fmore.style.display = fcol.value ? 'inline-flex' : 'none'; if (fcol.value) m.querySelector('[data-fval]').focus(); };
      const addF = () => guardLeave(() => { g.filters.push({ col: fcol.value, op: m.querySelector('[data-fop]').value, value: m.querySelector('[data-fval]').value }); g.offset = 0; load(); });
      m.querySelector('[data-fadd]').onclick = addF;
      m.querySelector('[data-fval]').onkeydown = (e) => { if (e.key === 'Enter') addF(); };
      m.querySelectorAll('[data-chip-remove]').forEach(x => x.onclick = () => guardLeave(() => { g.filters.splice(Number(x.dataset.chipRemove), 1); g.offset = 0; load(); }));
      m.querySelector('[data-where]').onkeydown = (e) => { if (e.key === 'Enter') guardLeave(() => { g.where = e.target.value.trim(); g.offset = 0; load(); }); };
      const ca = m.querySelector('[data-chkall]'); if (ca) ca.onchange = () => { m.querySelectorAll('[data-chk]').forEach(x => { x.checked = ca.checked; ca.checked ? st.checked.add(x.dataset.chk) : st.checked.delete(x.dataset.chk); }); };
      const on = (sel, fn) => { const x = m.querySelector(sel); if (x) x.onclick = fn; };
      on('[data-add]', () => addRow());
      on('[data-history]', () => historyPanel());
      on('[data-dup]', () => dupRow());
      on('[data-delsel]', () => markDelete());
      on('[data-discard]', () => showConfirm('Discard changes', `Drop the ${dirty()} change(s) not saved?`, () => { st.edits.clear(); st.news = []; st.dels.clear(); st.failed = null; draw(); }));
      on('[data-save]', () => save(false));
      on('[data-test]', () => save(true));
      on('[data-review]', () => review());
      on('[data-allow]', () => ctx.toggleWrite());
      m.querySelectorAll('tbody tr[data-row]').forEach(bindRow);
      const box = m.querySelector('[data-gridbox]');
      box.onkeydown = keys;
      box.addEventListener('paste', paste);
      box.addEventListener('copy', (e) => { if (st.sel && !st.editing) { const v = valueAt(st.sel.rid, st.sel.ci); e.clipboardData.setData('text/plain', v == null ? '' : String(v)); e.preventDefault(); } });
    }
    function bindRow(tr) {
      if (!tr) return;
      tr.querySelectorAll('td[data-c]').forEach(td => {
        td.onclick = (e) => { if (e.target.closest('[data-fkgo]') || st.editing) return; select(td.dataset.rid, Number(td.dataset.c)); };
        td.ondblclick = (e) => { if (e.target.closest('[data-fkgo]')) return; startEdit(td.dataset.rid, Number(td.dataset.c)); };
      });
      const chk = tr.querySelector('[data-chk]'); if (chk) chk.onchange = () => { chk.checked ? st.checked.add(chk.dataset.chk) : st.checked.delete(chk.dataset.chk); };
      const card = tr.querySelector('[data-card]'); if (card) card.onclick = () => openCard(card.dataset.card);
      tr.querySelectorAll('[data-fkgo]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const c = st.d.columns[Number(b.dataset.fkgo)]; guardLeave(() => ctx.openTable(c.fk.schema, c.fk.table, [{ col: c.fk.column, op: '=', value: b.dataset.fkv }])); });
    }
    function select(rid, ci) {
      const prev = st.sel; st.sel = { rid, ci };
      if (prev) { const p = el.querySelector(`td[data-rid="${prev.rid}"][data-c="${prev.ci}"]`); if (p) p.classList.remove('dbg-sel'); }
      const td = el.querySelector(`td[data-rid="${rid}"][data-c="${ci}"]`); if (td) { td.classList.add('dbg-sel'); td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      el.querySelector('[data-gridbox]').focus({ preventScroll: true });
    }
    const order = () => [...st.news.map((x, i) => 'n' + i), ...st.d.rows.map((x, i) => 'e' + i)];
    function move(dr, dc) {
      if (!st.sel) return; const rows = order(); let r = rows.indexOf(st.sel.rid) + dr, c = st.sel.ci + dc;
      if (c >= st.d.columns.length) { c = 0; r++; } if (c < 0) { c = st.d.columns.length - 1; r--; }
      if (r < 0 || r >= rows.length) return; select(rows[r], c);
    }
    function keys(e) {
      if (st.editing) return;
      if (!st.sel) { if (e.key.startsWith('Arrow')) { const r = order()[0]; if (r) select(r, 0); e.preventDefault(); } return; }
      const k = e.key;
      if (k === 'ArrowDown') { move(1, 0); e.preventDefault(); } else if (k === 'ArrowUp') { move(-1, 0); e.preventDefault(); }
      else if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) { move(0, 1); e.preventDefault(); } else if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) { move(0, -1); e.preventDefault(); }
      else if (k === 'Enter' || k === 'F2') { startEdit(st.sel.rid, st.sel.ci); e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && k === '0') { setCell(st.sel.rid, st.sel.ci, null); e.preventDefault(); }
      else if (k === 'Escape') { st.sel = null; draw(); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { startEdit(st.sel.rid, st.sel.ci, k); e.preventDefault(); }
    }
    function canEditCell(rid, ci) {
      const c = st.d.columns[ci];
      if (!editable() || c.generated) return false;
      if (rid[0] === 'e' && st.dels.has(Number(rid.slice(1)))) return false;
      return true;
    }
    function setCell(rid, ci, v) {
      if (!canEditCell(rid, ci)) return;
      const c = st.d.columns[ci];
      if (v === null && c.notnull && !(rid[0] === 'n')) return showToast(`${c.name} can not be NULL`, 'warning');
      setValue(rid, ci, v); st.failed = null; redrawRow(rid); refreshPending(); select(rid, ci);
    }

    // in-place editors
    function startEdit(rid, ci, typed) {
      const c = st.d.columns[ci]; const v = valueAt(rid, ci);
      if (!canEditCell(rid, ci)) { return viewValue(c, v); }
      const kind = editorKind(c, v == null ? null : String(v));
      if (kind === 'long') return longEditor(rid, ci);
      const td = el.querySelector(`td[data-rid="${rid}"][data-c="${ci}"]`); if (!td) return;
      st.editing = { rid, ci };
      const cur = v == null ? '' : String(v);
      if (kind === 'enum' || kind === 'bool') {
        const opts = kind === 'enum' ? c.enum : ['true', 'false'];
        td.innerHTML = `<select class="dbg-in">${c.notnull ? '' : `<option value="\u0000" ${v === null ? 'selected' : ''}>NULL</option>`}${opts.map(o => `<option ${o === cur || (kind === 'bool' && cur[0] === o[0] && cur !== '') ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else {
        td.innerHTML = `<input class="dbg-in td-mono" ${kind === 'date' ? 'type="date"' : ''} ${kind === 'fk' ? `list="dbg-fkl-${ci}"` : ''} value="${esc(typed != null ? typed : cur)}">${kind === 'fk' ? `<datalist id="dbg-fkl-${ci}"></datalist>` : ''}`;
      }
      const inp = td.querySelector('.dbg-in'); inp.focus();
      if (inp.select && typed == null && kind !== 'date') inp.select();
      else if (typed != null && inp.setSelectionRange) { const n = inp.value.length; inp.setSelectionRange(n, n); } // keep typing after the first letter
      if (kind === 'fk') { const fill = async () => { try { const r = await API.get(`${ctx.dbBase()}/fk-lookup?schema=${encodeURIComponent(c.fk.schema)}&table=${encodeURIComponent(c.fk.table)}&column=${encodeURIComponent(c.fk.column)}&q=${encodeURIComponent(inp.value)}`); const dl = td.querySelector('datalist'); if (dl) dl.innerHTML = r.options.map(o => `<option value="${esc(o.key)}">${esc(o.label || '')}</option>`).join(''); } catch (e) {} }; let t = null; inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(fill, 250); }); fill(); }
      let done = false;
      const finish = (commit, then) => {
        if (done) return; done = true; st.editing = null;
        if (commit) { const raw = inp.value; setValue(rid, ci, raw === '\u0000' ? null : raw); st.failed = null; }
        redrawRow(rid); refreshPending(); select(rid, ci); if (then) then();
      };
      inp.onkeydown = (e) => {
        e.stopPropagation(); // the grid's own keys must not act on the same key press
        if (e.key === 'Enter') { e.preventDefault(); finish(true, () => move(1, 0)); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(true, () => move(0, e.shiftKey ? -1 : 1)); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if ((e.ctrlKey || e.metaKey) && e.key === '0' && !c.notnull) { e.preventDefault(); done = true; st.editing = null; setValue(rid, ci, null); redrawRow(rid); refreshPending(); select(rid, ci); }
      };
      inp.onblur = () => setTimeout(() => finish(true), 0);
      if (inp.tagName === 'SELECT') inp.onchange = () => finish(true);
    }
    function viewValue(c, v) {
      let pretty = v; try { if (v && /^[[{]/.test(String(v).trim())) pretty = JSON.stringify(JSON.parse(v), null, 2); } catch (e) {}
      showModal(`${esc(c.name)} <span class="ui-sub">${esc(c.type)}</span>`, v === null ? `<div>${NULLV}</div>` : `<pre class="td-mono" style="white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto;margin:0">${esc(pretty)}</pre>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    }
    function longEditor(rid, ci) {
      const c = st.d.columns[ci]; const v = valueAt(rid, ci);
      const isJson = /^jsonb?$/.test(c.base);
      UI.dialog({ title: `${esc(c.name)} <span class="ui-sub">${esc(c.type)}</span>`, saveLabel: 'Keep', wide: true,
        body: `<textarea class="input td-mono" id="le-v" rows="14" spellcheck="false" style="white-space:pre">${esc(v == null ? '' : (isJson ? (() => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch (e) { return v; } })() : v))}</textarea>
          <div style="display:flex;gap:10px;align-items:center;margin-top:8px">${isJson ? UI.btn('Format JSON', 'data-jfmt') : ''}<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="le-null" ${v === null ? 'checked' : ''} ${c.notnull ? 'disabled' : ''}> NULL</label><span class="ui-sub" data-jmsg></span></div>
          <div class="ui-sub" style="margin-top:6px">"Keep" puts the value in the grid — Save there writes it.</div>`,
        onOpen: (ov) => {
          const ta = ov.querySelector('#le-v'), msg = ov.querySelector('[data-jmsg]');
          const check = () => { if (!isJson) return true; try { JSON.parse(ta.value); msg.textContent = '✓ valid JSON'; msg.style.color = 'var(--success)'; return true; } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--danger)'; return false; } };
          if (isJson) { ta.addEventListener('input', check); check(); const f = ov.querySelector('[data-jfmt]'); f.onclick = () => { try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); check(); } catch (e) {} }; }
        },
        onSave: async (ov) => {
          const nul = ov.querySelector('#le-null').checked; const ta = ov.querySelector('#le-v');
          if (!nul && isJson) { try { JSON.parse(ta.value); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); } }
          const val = nul ? null : (isJson ? JSON.stringify(JSON.parse(ta.value)) : ta.value);
          setValue(rid, ci, val); st.failed = null; redrawRow(rid); refreshPending();
        } });
    }

    // rows
    function addRow(values) {
      const defaults = new Set(st.d.columns.filter(c => isAuto(c) || c.default).map(c => c.name));
      const n = { values: {}, defaults };
      if (values) Object.entries(values).forEach(([k, v]) => { n.values[k] = v; defaults.delete(k); });
      st.news.unshift(n);
      draw(); select('n0', st.d.columns.findIndex(c => !c.generated && !isAuto(c)) >= 0 ? st.d.columns.findIndex(c => !c.generated && !isAuto(c)) : 0);
    }
    function dupRow() {
      const rid = [...st.checked][0] || (st.sel && st.sel.rid);
      if (!rid) return showToast('Tick a row or select a cell in it first', 'warning');
      const values = {};
      st.d.columns.forEach((c, ci) => { if (isAuto(c) || c.generated) return; const v = valueAt(rid, ci); if (v !== undefined) values[c.name] = v; });
      st.d.pk.forEach(k => { const c = st.d.columns[colIdx(k)]; if (!isAuto(c)) values[k] = ''; });
      addRow(values); showToast('Copied as a new row — give it a new key if it needs one', 'info');
    }
    function markDelete() {
      const rids = [...st.checked];
      if (!rids.length) return showToast('Tick the rows to delete first', 'warning');
      rids.forEach(rid => { if (rid[0] === 'n') st.news[Number(rid.slice(1))] = null; else st.dels.add(Number(rid.slice(1))); });
      st.news = st.news.filter(Boolean); st.checked.clear(); draw();
      showToast(`${rids.length} row(s) marked — Save deletes them`, 'info');
    }
    function paste(e) {
      if (st.editing || !st.sel || !editable()) return;
      const text = e.clipboardData.getData('text/plain'); if (!text) return;
      e.preventDefault();
      const grid = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
      let rows = order(); const r0 = rows.indexOf(st.sel.rid);
      const need = r0 + grid.length - rows.length;
      for (let i = 0; i < need; i++) st.news.push({ values: {}, defaults: new Set(st.d.columns.filter(c => isAuto(c) || c.default).map(c => c.name)) });
      rows = order(); let count = 0;
      grid.forEach((cells, i) => cells.forEach((v, j) => { const ci = st.sel.ci + j; const rid = rows[r0 + i]; if (ci < st.d.columns.length && rid && canEditCell(rid, ci)) { setValue(rid, ci, v === '' && !st.d.columns[ci].notnull && rid[0] === 'e' && valueAt(rid, ci) === null ? null : v); count++; } }));
      draw(); showToast(`${count} cell(s) pasted — Save writes them`, 'info');
    }

    // ---- save ----
    function changeList() {
      const out = []; const where = [];
      st.edits.forEach((set, ri) => { if (st.dels.has(ri)) return; const row = st.d.rows[ri]; out.push({ op: 'update', pk: pkOf(row), set: { ...set }, orig: Object.fromEntries(Object.keys(set).map(k => [k, row[colIdx(k)]])) }); where.push('e' + ri); });
      st.news.forEach((n, i) => { const values = {}; Object.entries(n.values).forEach(([k, v]) => { if (!n.defaults.has(k)) values[k] = v; }); out.push({ op: 'insert', values }); where.push('n' + i); });
      st.dels.forEach(ri => { out.push({ op: 'delete', pk: pkOf(st.d.rows[ri]) }); where.push('e' + ri); });
      return { changes: out, where };
    }
    async function save(test) {
      const { changes, where } = changeList();
      if (!changes.length) return;
      if (!test && st.dels.size) { const ok = await new Promise(res => showConfirm('Save changes', `This deletes <b>${st.dels.size}</b> row(s) and saves the other changes in one transaction. Go on?`, () => res(true), true)); if (!ok) return; }
      try {
        const r = await API.post(`${ctx.dbBase()}/changes`, { schema: ctx.schema, table: ctx.table, changes, test });
        if (test) { showToast(`🧪 All ${changes.length} change(s) would succeed — rolled back, nothing saved`, 'success', 6000); return; }
        showToast(`Saved: ${[r.update && `${r.update} edited`, r.insert && `${r.insert} added`, r.delete && `${r.delete} deleted`].filter(Boolean).join(', ')}`);
        load();
      } catch (e) {
        st.failed = e.data && e.data.at != null ? { rid: where[e.data.at] } : null;
        draw();
        if (e.code === 'CONFLICT') showModal('Changed by someone else', `<div class="text-sm">${esc(e.message)}</div>`, [{ label: 'Keep my edits', className: 'btn btn-secondary' }, { label: 'Reload (drop my edits)', className: 'btn btn-danger', onClick: () => load() }]);
        else showToast(e.message, 'error', 12000);
      }
    }
    function review() {
      const { changes } = changeList();
      const show = (o) => Object.entries(o || {}).map(([k, v]) => `<span class="td-mono">${esc(k)}</span> = ${v === null ? NULLV : `<span class="td-mono">${esc(String(v).slice(0, 80))}</span>`}`).join(', ');
      showModal(`${changes.length} change(s) to ${esc(ctx.schema)}.${esc(ctx.table)}`, `<div style="max-height:55vh;overflow:auto;font-size:12.5px">${changes.map((c, i) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="ui-sub">${i + 1}.</span> ${c.op === 'update' ? `<b>Edit</b> row ${show(c.pk)}: ${show(c.set)} <span class="ui-sub">(was ${show(c.orig)})</span>` : c.op === 'insert' ? `<b>Add</b> ${show(c.values) || 'a row of defaults'}` : `<b style="color:var(--danger)">Delete</b> row ${show(c.pk)}`}</div>`).join('')}</div><div class="ui-sub" style="margin-top:8px">All in one transaction: if one fails, none is saved. An edit is refused if someone changed that row since you loaded it.</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    }

    // ---- the row as a card ----
    async function openCard(rid) {
      const d = st.d; const rows = order(); let pos = rows.indexOf(rid);
      const ov = document.createElement('div'); ov.className = 'modal-overlay';
      ov.innerHTML = `<div class="modal ui-modal-wide" style="max-width:860px;width:min(860px,96vw)"><div class="modal-header"><div class="modal-title" data-ct></div><span style="flex:1"></span>${UI.btn('‹', 'data-cprev title="Previous row"')} ${UI.btn('›', 'data-cnext title="Next row"')} <button class="btn-icon modal-close" data-cclose>✕</button></div><div class="modal-body" data-cb style="max-height:70vh;overflow:auto"></div><div class="modal-footer" data-cf></div></div>`;
      document.getElementById('modal-root').appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector('[data-cclose]').onclick = close; ov.onclick = (e) => { if (e.target === ov) close(); };
      const render = async () => {
        const r = rows[pos]; const isNew = r[0] === 'n';
        const can = editable() && !(r[0] === 'e' && st.dels.has(Number(r.slice(1))));
        ov.querySelector('[data-ct]').innerHTML = `${esc(ctx.schema)}.${esc(ctx.table)} <span class="ui-sub">${isNew ? 'new row' : d.pk.map(k => `${esc(k)} = ${esc(valueAt(r, colIdx(k)))}`).join(', ')}</span>`;
        ov.querySelector('[data-cb]').innerHTML = `<div style="display:grid;grid-template-columns:minmax(140px,220px) minmax(0,1fr);gap:8px 14px;align-items:start">${d.columns.map((c, ci) => {
          const v = valueAt(r, ci); const kind = editorKind(c, v == null ? null : String(v));
          const lab = `<div><div class="td-mono" style="font-weight:600">${d.pk.includes(c.name) ? '🔑 ' : ''}${esc(c.name)}</div><div class="ui-sub" style="font-size:11px">${esc(c.type)}${c.notnull ? ' · required' : ''}</div></div>`;
          let field;
          const dis = !can || c.generated ? 'disabled' : '';
          if (kind === 'enum' || kind === 'bool') field = `<select class="input" data-cf="${ci}" ${dis}>${c.notnull ? '' : `<option value="\u0000" ${v === null ? 'selected' : ''}>NULL</option>`}${(kind === 'enum' ? c.enum : ['true', 'false']).map(o => `<option ${String(v) === o || (kind === 'bool' && v != null && String(v)[0] === o[0]) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
          else if (kind === 'long') field = `<textarea class="input td-mono" rows="${Math.min(10, Math.max(3, String(v || '').split('\n').length))}" data-cf="${ci}" ${dis} spellcheck="false">${esc(v == null ? '' : v)}</textarea>`;
          else field = `<input class="input td-mono" ${kind === 'date' ? 'type="date"' : ''} data-cf="${ci}" value="${esc(v == null ? '' : v)}" ${dis} placeholder="${v === null ? 'NULL' : v === undefined ? 'default' : ''}">`;
          const extra = `${!c.notnull && can && !c.generated ? `<label style="display:flex;gap:4px;align-items:center;font-weight:400;font-size:12px"><input type="checkbox" data-cnull="${ci}" ${v === null ? 'checked' : ''}> NULL</label>` : ''}${c.fk && v != null && v !== undefined && v !== '' ? `<span class="ui-sub" data-fklabel="${ci}"></span> ${UI.btn('Open ↗', `data-cfk="${ci}"`)}` : ''}`;
          return `${lab}<div><div>${field}</div>${extra ? `<div style="display:flex;gap:8px;align-items:center;margin-top:4px">${extra}</div>` : ''}</div>`;
        }).join('')}</div><div data-refs style="margin-top:14px"></div>`;
        ov.querySelector('[data-cf]').innerHTML = `<span class="ui-sub" style="margin-right:auto">${can ? 'Changes go to the grid as not saved — Save writes them all in one transaction.' : (editable() ? 'Marked for deletion.' : 'Read-only table.')}</span>${UI.btn('Close', 'data-cclose2')} ${can ? UI.primary('Keep changes', 'data-ckeep') : ''}`;
        ov.querySelector('[data-cclose2]').onclick = close;
        ov.querySelector('[data-cprev]').disabled = pos <= 0; ov.querySelector('[data-cnext]').disabled = pos >= rows.length - 1;
        const keep = ov.querySelector('[data-ckeep]');
        if (keep) keep.onclick = () => {
          d.columns.forEach((c, ci) => {
            const f = ov.querySelector(`[data-cf="${ci}"]`); if (!f || f.disabled) return;
            const nb = ov.querySelector(`[data-cnull="${ci}"]`);
            let nv = nb && nb.checked ? null : f.value === '\u0000' ? null : f.value;
            const cur = valueAt(r, ci);
            if (cur === undefined && nv === '') return; // a default left as it is
            if (nv !== (cur == null ? (cur === null ? null : '') : String(cur))) setValue(r, ci, nv);
          });
          st.failed = null; close(); draw(); if (dirty()) showToast(`${dirty()} change(s) waiting — Save writes them`, 'info');
        };
        ov.querySelectorAll('[data-cfk]').forEach(b => b.onclick = () => { const c = d.columns[Number(b.dataset.cfk)]; const v = valueAt(r, Number(b.dataset.cfk)); close(); guardLeave(() => ctx.openTable(c.fk.schema, c.fk.table, [{ col: c.fk.column, op: '=', value: v }])); });
        // labels of the rows foreign keys point to, and the rows pointing here
        d.columns.forEach(async (c, ci) => {
          const span = ov.querySelector(`[data-fklabel="${ci}"]`); if (!span) return;
          try { const x = await API.get(`${ctx.dbBase()}/fk-lookup?schema=${encodeURIComponent(c.fk.schema)}&table=${encodeURIComponent(c.fk.table)}&column=${encodeURIComponent(c.fk.column)}&key=${encodeURIComponent(valueAt(r, ci))}`); const o = x.options[0]; span.innerHTML = o ? (o.label ? `→ ${esc(o.label)}` : '→ exists') : '<span style="color:var(--danger)">→ no such row</span>'; } catch (e) {}
        });
        const refsBox = ov.querySelector('[data-refs]');
        if (!isNew && d.pk.length) {
          try {
            const x = await API.post(`${ctx.dbBase()}/referencing`, { schema: ctx.schema, table: ctx.table, pk: pkOf(d.rows[Number(r.slice(1))]) });
            if (rows[pos] !== r) return;
            refsBox.innerHTML = x.refs.length ? `<div class="ui-label" style="margin-bottom:6px">Rows pointing here</div>${x.refs.map((f, i) => `<div style="display:flex;gap:10px;align-items:center;padding:4px 0"><span class="td-mono">${esc(f.schema)}.${esc(f.table)}</span><span class="ui-sub">via ${esc(f.column)}</span><b>${Number(f.count).toLocaleString()}</b><span class="ui-sub">row${Number(f.count) === 1 ? '' : 's'}</span>${Number(f.count) ? UI.btn('Open', `data-ref="${i}"`) : ''}</div>`).join('')}` : '';
            refsBox.querySelectorAll('[data-ref]').forEach(b => b.onclick = () => { const f = x.refs[Number(b.dataset.ref)]; close(); guardLeave(() => ctx.openTable(f.schema, f.table, [{ col: f.column, op: '=', value: f.value }])); });
          } catch (e) { refsBox.innerHTML = ''; }
        }
        if (!isNew && d.pk.length) whoWrote(ov.querySelector('[data-refs]'), pkOf(d.rows[Number(r.slice(1))]), () => rows[pos] === r, close);
        if (ctx.onCard) ctx.onCard(ov, { rid: r, row: r[0] === 'e' ? d.rows[Number(r.slice(1))] : null, pk: r[0] === 'e' ? pkOf(d.rows[Number(r.slice(1))]) : null, columns: d.columns });
      };
      ov.querySelector('[data-cprev]').onclick = () => { if (pos > 0) { pos--; render(); } };
      ov.querySelector('[data-cnext]').onclick = () => { if (pos < rows.length - 1) { pos++; render(); } };
      render();
    }


    // ---- who wrote it ----
    const H = () => `${ctx.dbBase()}/history`;
    const when = (t) => t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '';
    const OPN = { I: ['ok', 'added'], U: ['warn', 'changed'], D: ['bad', 'deleted'] };
    const fmtV = (v) => v === null || v === undefined ? NULLV : `<span class="td-mono">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 300)}</span>`;
    function diffHtml(ch) {
      const cols = ch.op === 'U' ? (ch.changed || []) : Object.keys(ch.op === 'D' ? ch.old || {} : ch.new || {});
      return `<table style="width:100%;font-size:12.5px;border-collapse:collapse">${cols.map(c => `<tr style="border-top:1px solid var(--border)"><td class="td-mono" style="padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap">${esc(c)}</td>${ch.op === 'U' ? `<td style="padding:4px 8px;vertical-align:top;color:var(--danger)">${fmtV((ch.old || {})[c])}</td><td style="padding:4px 0">→</td><td style="padding:4px 8px;vertical-align:top;color:var(--success)">${fmtV((ch.new || {})[c])}</td>` : `<td style="padding:4px 8px" colspan="3">${fmtV((ch.op === 'D' ? ch.old : ch.new)[c])}</td>`}</tr>`).join('')}</table>`;
    }
    const whoLine = (ch) => `<b>${esc(ch.user)}</b>${ch.app ? ` <span class="ui-sub">via</span> ${esc(ch.app)}` : ''}${ch.client ? ` <span class="ui-sub">from</span> <span class="td-mono">${esc(ch.client)}</span>` : ` <span class="ui-sub">(local socket)</span>`}`;
    async function restoreChange(ch, after) {
      const what = ch.op === 'D' ? 'bring the deleted row back' : ch.op === 'U' ? 'put the whole row back as it was before this change' : 'remove the row this insert added';
      if (!ctx.info().allowWrite) return showToast('Turn on "Allow changes" first', 'warning');
      showConfirm('Restore', `This will <b>${what}</b> (key ${esc(JSON.stringify(ch.key))}). The restore is itself recorded. Go on?`, async () => {
        try { const r = await API.post(`${H()}/restore`, { schema: ctx.schema, table: ctx.table, id: ch.id }); showToast(`Done — ${r.restored}`); if (after) after(); guardLeave(load); } catch (e) { showToast(e.message, 'error', 10000); }
      }, true);
    }
    async function enableTracking(after) {
      if (!ctx.info().allowWrite) return showToast('Turn on "Allow changes" first — tracking adds a trigger to the table', 'warning', 6000);
      UI.dialog({ title: `Track changes of ${esc(ctx.schema)}.${esc(ctx.table)}`, saveLabel: 'Turn on',
        body: `<div class="text-sm" style="margin-bottom:8px">From now on every INSERT, UPDATE and DELETE of this table — from your app, from psql, from DockGate — is written down: <b>which database user</b>, <b>which application</b> (its application_name), <b>from which address</b>, <b>when</b>, and the <b>old and new values</b>. Changes made before this are not known.</div>
          <div class="ui-sub" style="margin-bottom:8px">DockGate adds the schema <span class="td-mono">dockgate_audit</span> (a table of changes and one trigger function) and a trigger on this table. Each change costs one extra insert; on a table with very many writes, that adds up. Turning it off removes the trigger.</div>
          <label class="ui-field"><span class="ui-label">Keep changes for (days)</span><input class="input" type="number" id="tr-days" value="90" min="1" max="3650"></label>`,
        onSave: async (ov2) => { await API.post(`${H()}/enable`, { schema: ctx.schema, table: ctx.table, keepDays: Number(ov2.querySelector('#tr-days').value) }); showToast('Tracking is on'); if (after) after(); } });
    }
    async function whoWrote(box, pk, still, closeCard) {
      const sec = document.createElement('div'); sec.style.marginTop = '16px'; sec.innerHTML = '<div class="ui-label" style="margin-bottom:6px">Who wrote it</div><div class="ui-sub">Loading…</div>'; box.after(sec);
      let x; try { x = await API.post(`${H()}/row`, { schema: ctx.schema, table: ctx.table, pk }); } catch (e) { sec.innerHTML = `<div class="ui-label">Who wrote it</div><div class="text-danger text-sm">${esc(e.message)}</div>`; return; }
      if (!still()) return;
      const last = x.history[0];
      const head = `<div class="ui-label" style="margin-bottom:6px">Who wrote it</div>
        <div class="text-sm" style="margin-bottom:8px">${last ? `Last ${OPN[last.op][1]} <b>${when(last.at)}</b> by ${whoLine(last)}` : x.committed ? `Last written <b>${when(x.committed)}</b> (transaction ${esc(x.xmin)})` : `Last written in transaction <span class="td-mono">${esc(x.xmin)}</span> <span class="ui-sub">— the time is not recorded (track_commit_timestamp is off)</span>`}</div>`;
      const tracked = x.tracked ? `<div class="ui-sub" style="margin-bottom:6px">Change tracking is on for this table${x.since ? ` since ${when(x.since)}` : ''} · kept ${x.keepDays} days</div>${x.history.length ? x.history.map((h, i) => `<details style="border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-bottom:6px"><summary style="cursor:pointer;font-size:12.5px">${UI.pill(OPN[h.op][0], OPN[h.op][1])} ${when(h.at)} · ${whoLine(h)}${h.op === 'U' ? ` · <span class="td-mono">${esc((h.changed || []).join(', '))}</span>` : ''}</summary><div style="margin-top:6px">${diffHtml(h)}</div>${h.op !== 'I' ? `<div style="margin-top:6px">${UI.btn(h.op === 'U' ? 'Put the row back as before this' : 'Bring it back', `data-hrest="${i}"`)}</div>` : ''}</details>`).join('') : '<div class="ui-sub">No change of this row since tracking began.</div>'}`
        : `<div class="ui-sub" style="margin-bottom:6px">PostgreSQL does not keep who changed a row. ${UI.btn('Track changes of this table…', 'data-htrack')} records it from now on — the user, the application, the address, old and new values.</div>`;
      const mine = x.dockgate.length ? `<div class="ui-label" style="margin:10px 0 4px">Edits made from DockGate</div>${x.dockgate.map(m => `<div class="ui-sub" style="font-size:12px">${esc(m.at)} UTC · ${esc(m.action.replace('db_', '').replace(/_/g, ' '))}${m.columns ? ` · <span class="td-mono">${esc(m.columns.join(', '))}</span>` : ''}${m.from ? ` · from ${esc(m.from)}` : ''}</div>`).join('')}` : '';
      sec.innerHTML = head + tracked + mine;
      sec.querySelectorAll('[data-hrest]').forEach(b => b.onclick = () => restoreChange(x.history[Number(b.dataset.hrest)], closeCard));
      const tr = sec.querySelector('[data-htrack]'); if (tr) tr.onclick = () => enableTracking(() => { sec.remove(); whoWrote(box, pk, still, closeCard); });
    }
    async function historyPanel() {
      const f = { op: '', user: '', q: '' };
      const ov = document.createElement('div'); ov.className = 'modal-overlay';
      ov.innerHTML = `<div class="modal ui-modal-wide" style="max-width:980px;width:min(980px,96vw)"><div class="modal-header"><div class="modal-title">Changes of ${esc(ctx.schema)}.${esc(ctx.table)}</div><span style="flex:1"></span><button class="btn-icon modal-close" data-hclose>✕</button></div><div class="modal-body" data-hb style="max-height:72vh;overflow:auto"><div class="skeleton" style="height:120px"></div></div></div>`;
      document.getElementById('modal-root').appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector('[data-hclose]').onclick = close; ov.onclick = (e) => { if (e.target === ov) close(); };
      const body = ov.querySelector('[data-hb]');
      const render = async () => {
        let x; try { x = await API.post(`${H()}/log`, { schema: ctx.schema, table: ctx.table, ...f }); } catch (e) { body.innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; return; }
        const s = x.status;
        const top = s.tracked ? `<div class="dbg-bar">${UI.pill('ok', '● Tracking on')} <span class="ui-sub">since ${when(s.since)} · kept ${s.keepDays} days · ${Number(s.count).toLocaleString()} changes kept</span><span style="flex:1"></span>${UI.btn('Turn off…', 'data-hoff')}</div>`
          : `<div class="card" style="padding:12px;margin-bottom:10px"><b>Change tracking is off for this table.</b><div class="ui-sub" style="margin:4px 0 8px">PostgreSQL does not keep who changed a row. Turn it on to record every change from now on: the database user, the application, the address, the time, old and new values — and to bring rows back.${s.count ? ` ${Number(s.count).toLocaleString()} earlier changes are still kept.` : ''}</div>${UI.btn('Track changes…', 'data-hon', 'btn-primary')}${s.commitTimes ? '' : '<div class="ui-sub" style="margin-top:6px">Commit times are not recorded on this server (track_commit_timestamp is off), so without tracking only the transaction of the last change is known.</div>'}</div>`;
        body.innerHTML = `${top}
          <div class="dbg-bar"><select class="input" data-hop style="width:auto;padding:3px 6px;font-size:12px"><option value="">All changes</option><option value="I" ${f.op === 'I' ? 'selected' : ''}>Added</option><option value="U" ${f.op === 'U' ? 'selected' : ''}>Changed</option><option value="D" ${f.op === 'D' ? 'selected' : ''}>Deleted</option></select>
            <select class="input" data-huser style="width:auto;padding:3px 6px;font-size:12px"><option value="">Any user</option>${(x.users || []).map(u => `<option ${u === f.user ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
            <input class="input" data-hq placeholder="A value in the row…" value="${esc(f.q)}" style="max-width:220px;padding:3px 8px;font-size:12px"></div>
          ${x.changes.length ? x.changes.map((h, i) => `<details style="border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-bottom:6px"><summary style="cursor:pointer;font-size:12.5px">${UI.pill(OPN[h.op][0], OPN[h.op][1])} <span class="td-mono">${esc(Object.entries(h.key || {}).map(([k, v]) => `${k}=${v}`).join(', '))}</span> · ${when(h.at)} · ${whoLine(h)}${h.op === 'U' ? ` · <span class="td-mono">${esc((h.changed || []).join(', '))}</span>` : ''}</summary><div style="margin-top:6px">${diffHtml(h)}</div>${h.op !== 'I' ? `<div style="margin-top:6px">${UI.btn(h.op === 'U' ? 'Put the row back as before this' : 'Bring the row back', `data-lrest="${i}"`)}</div>` : ''}</details>`).join('') : `<div class="ui-sub">${s.schema ? 'No changes match.' : ''}</div>`}`;
        const on = body.querySelector('[data-hon]'); if (on) on.onclick = () => enableTracking(render);
        const off = body.querySelector('[data-hoff]'); if (off) off.onclick = () => UI.dialog({ title: 'Turn tracking off', saveLabel: 'Turn off', danger: true, body: `<div class="text-sm">The trigger is removed; new changes are no longer recorded.</div><label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px"><input type="checkbox" id="h-drop"> Also delete the ${Number(s.count).toLocaleString()} changes kept</label>`,
          onSave: async (ov2) => { await API.post(`${H()}/disable`, { schema: ctx.schema, table: ctx.table, dropLog: ov2.querySelector('#h-drop').checked }); showToast('Tracking is off'); render(); } });
        body.querySelector('[data-hop]').onchange = (e) => { f.op = e.target.value; render(); };
        body.querySelector('[data-huser]').onchange = (e) => { f.user = e.target.value; render(); };
        body.querySelector('[data-hq]').onkeydown = (e) => { if (e.key === 'Enter') { f.q = e.target.value; render(); } };
        body.querySelectorAll('[data-lrest]').forEach(b => b.onclick = () => restoreChange(x.changes[Number(b.dataset.lrest)], render));
      };
      render();
    }

    const onUnload = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    await load();
    return { destroy() { alive = false; window.removeEventListener('beforeunload', onUnload); }, dirty, reload: load, guardLeave, redraw: () => { if (st.d) draw(); } };
  }

  return { mount };
})();
