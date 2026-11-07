// Shared building blocks for the server pages, so every section looks and edits the same way:
// page header (title · one line · actions), status line, standard table with row actions, settings rows
// (label · description · value · Edit), pills, chips and one form dialog. Pages pass HTML strings in and
// attach their own listeners; the kit only renders.
const UI = {
  esc: (s) => escapeHtml(String(s == null ? '' : s)),

  /** Page section header: title, one line of description, actions on the right. */
  header(title, desc, actions = '') {
    return `<div class="ui-ph"><div class="ui-ph-text">${title ? `<div class="ui-ph-title">${title}</div>` : ''}${desc ? `<div class="ui-ph-desc">${desc}</div>` : ''}</div>${actions ? `<div class="ui-ph-actions">${actions}</div>` : ''}</div>`;
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

  /**
   * A failure explained for people: what happened, the likely reason, the next step (Retry, switch
   * server, open Setup / Settings) and the technical message folded under "Details".
   */
  errorState(err, { title, compact = false } = {}) {
    const msg = String((err && err.message) || err || '');
    const srv = (typeof Store !== 'undefined' && Store.get('activeServer')) || {};
    const remote = !!srv.id && srv.id !== 'local' && srv.type !== 'local';
    const name = UI.esc(srv.name || srv.id || 'this server');
    let head, cause, acts = [['retry', 'Retry', 'btn-primary']];
    if (/host key/i.test(msg)) {
      head = "The server's identity changed";
      cause = `The SSH host key of ${name} is not the one DockGate pinned. If you rebuilt or reinstalled the server, re-trust the key in its Settings; otherwise someone may be intercepting the connection.`;
      acts.push(['settings', 'Open server Settings']);
    } else if (/docker\.sock|ENOENT|Cannot connect to the Docker daemon|docker daemon|Docker is not (installed|running)|permission denied.*docker/i.test(msg)) {
      head = 'Docker is not reachable';
      cause = remote
        ? `Docker is not running on ${name}, or the SSH user may not use it. Setup can install Docker and grant the user access.`
        : 'DockGate cannot reach the local Docker socket (/var/run/docker.sock). Mount it into the DockGate container, or switch to a remote server.';
      acts.push(remote ? ['setup', 'Open Setup'] : ['servers', 'Switch server']);
    } else if (/authentication|auth failed|all configured authentication|incorrect password/i.test(msg)) {
      head = 'DockGate could not log in';
      cause = `${name} refused the SSH login. Check the user and the key or password in the server's Settings.`;
      acts.push(['settings', 'Open server Settings']);
    } else if (/timed? ?out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|unreachable|not found — check the server address/i.test(msg)) {
      head = 'The server is not reachable';
      cause = `${name} did not answer. Check that it is running and that DockGate can reach it (address, port, firewall).`;
      acts.push(['servers', 'Switch server']);
    } else {
      head = title || 'Something went wrong';
      cause = 'The request failed. Retry, or open the details below.';
    }
    if (remote && !acts.some(a => a[0] === 'servers')) acts.push(['servers', 'Switch server']);
    return `<div class="ui-error${compact ? ' ui-error-compact' : ''}" role="alert">
      <div class="ui-error-title">${head}</div>
      <p class="ui-error-cause">${cause}</p>
      <div class="ui-error-actions">${acts.map(([k, l, c]) => `<button type="button" class="btn btn-sm ${c || 'btn-secondary'}" data-err-act="${k}">${l}</button>`).join('')}</div>
      ${msg ? `<details class="ui-error-details"><summary>Details</summary><pre>${UI.esc(msg)}</pre></details>` : ''}
    </div>`;
  },

  /** "What changes / what protects you" box used inside dialogs. */
  explain(change, protects) {
    return `<div class="ui-explain"><div><b>What changes</b> ${change}</div>${protects ? `<div><b>What protects you</b> ${protects}</div>` : ''}</div>`;
  },
};

// Buttons of UI.errorState work on every page (delegated once).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-err-act]');
  if (!b) return;
  const srv = (typeof Store !== 'undefined' && Store.get('activeServer')) || {};
  const act = b.dataset.errAct;
  if (act === 'retry') Router.navigate(Store.get('currentPage') || 'dashboard', Store.get('currentParams') || {});
  else if (act === 'servers') Router.navigate('infra', { tab: 'servers' });
  else if (act === 'setup' && srv.id) Router.navigate('server-console', { id: srv.id, tab: 'setup' });
  else if (act === 'settings' && srv.id) Router.navigate('server-console', { id: srv.id, tab: 'settings' });
});

/** Release-note text → HTML: escaped first, then **bold**, `code` and [text](https://link). */
function mdInline(text) {
  return escapeHtml(String(text || ''))
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>');
}
