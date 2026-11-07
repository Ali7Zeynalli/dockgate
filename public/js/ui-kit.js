// Shared building blocks for the server pages, so every section looks and edits the same way:
// page header (title · one line · actions), status line, standard table with row actions, settings rows
// (label · description · value · Edit), pills, chips and one form dialog. Pages pass HTML strings in and
// attach their own listeners; the kit only renders.
const UI = {
  esc: (s) => escapeHtml(String(s == null ? '' : s)),

  /** Page section header: title, one line of description, actions on the right. */
  header(title, desc, actions = '') {
    return `<div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">${title}</div>${desc ? `<div class="ui-ph-desc">${desc}</div>` : ''}</div>${actions ? `<div class="ui-ph-actions">${actions}</div>` : ''}</div>`;
  },

  /** One-line summary bar: [html, html, …] with optional actions on the right. */
  statusLine(items, actions = '') {
    return `<div class="ui-status">${items.filter(Boolean).map(i => `<span>${i}</span>`).join('')}${actions ? `<span class="ui-status-actions">${actions}</span>` : ''}</div>`;
  },

  /** level: ok · warn · bad · off · info */
  pill(level, text) { return `<span class="ui-pill ui-pill-${level}">${text}</span>`; },

  chip(text, { tone = '', title = '', remove = null, mono = false } = {}) {
    const x = remove != null ? `<button type="button" class="ui-chip-x" data-chip-remove="${UI.esc(remove)}" aria-label="Remove">×</button>` : '';
    return `<span class="ui-chip ${tone ? 'ui-chip-' + tone : ''} ${mono ? 'td-mono' : ''}"${title ? ` title="${UI.esc(title)}"` : ''}>${text}${x}</span>`;
  },

  btn(label, attrs = '', cls = 'btn-secondary') { return `<button type="button" class="btn btn-xs ${cls}" ${attrs}>${label}</button>`; },
  primary(label, attrs = '') { return `<button type="button" class="btn btn-sm btn-primary" ${attrs}>${label}</button>`; },

  /**
   * Standard table. cols: [{ label, align, width }], rows: [{ cells: [html…], cls }], or html strings.
   * Row actions go in the last cell (right aligned) by convention.
   */
  table(cols, rows, { empty = 'Nothing here yet.', minWidth = 640 } = {}) {
    const head = cols.map(c => `<th${c.align === 'right' ? ' style="text-align:right"' : ''}${c.width ? ` style="width:${c.width}"` : ''}>${c.label || ''}</th>`).join('');
    const body = rows.length ? rows.map(r => typeof r === 'string' ? r : `<tr class="${r.cls || ''}">${r.cells.map((c, i) => `<td${cols[i] && cols[i].align === 'right' ? ' class="ui-td-actions"' : ''}>${c}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="text-sm text-muted">${empty}</td></tr>`;
    return `<div class="table-wrapper ui-table"><table style="min-width:${minWidth}px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  /** Settings list: [{ label, desc, value, action }] — one row per setting with its own Edit. */
  settings(rows) {
    return `<div class="ui-settings">${rows.map(r => `<div class="ui-set${r.cls ? ' ' + r.cls : ''}"><div class="ui-set-l"><b>${r.label}</b>${r.desc ? `<span>${r.desc}</span>` : ''}</div><div class="ui-set-v">${r.value == null ? '' : r.value}</div><div class="ui-set-a">${r.action || ''}</div></div>`).join('')}</div>`;
  },

  /**
   * Form dialog built on showModal. body: html; onSave(overlay) may return a promise; throwing keeps the
   * dialog open and shows the message. Returns { overlay, close }.
   */
  dialog({ title, body, saveLabel = 'Save', danger = false, onSave, onOpen, wide = false, context = true }) {
    const m = showModal(title, `${context && typeof serverContextBanner === 'function' ? serverContextBanner() : ''}<div class="ui-dlg">${body}</div><div class="ui-dlg-err" data-ui-err></div>`, []);
    if (wide) m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const footer = m.overlay.querySelector('.modal-footer');
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
    const save = document.createElement('button'); save.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`; save.textContent = saveLabel; save.dataset.uiSave = '1';
    footer.append(cancel, save);
    const err = m.overlay.querySelector('[data-ui-err]');
    save.onclick = async () => {
      err.innerHTML = ''; save.disabled = true;
      try { const keep = await onSave(m.overlay); if (keep !== false) m.close(); }
      catch (e) { err.innerHTML = `<div class="insight-card danger" style="margin-top:10px"><div>${UI.esc(e.message)}</div></div>`; }
      finally { save.disabled = false; }
    };
    if (onOpen) onOpen(m.overlay, { save, close: m.close });
    return { overlay: m.overlay, close: m.close, save };
  },

  /** "What changes / what protects you" box used inside dialogs. */
  explain(change, protects) {
    return `<div class="ui-explain"><div><b>What changes</b> ${change}</div>${protects ? `<div><b>What protects you</b> ${protects}</div>` : ''}</div>`;
  },
};
