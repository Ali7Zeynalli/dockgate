// Edit files in a container or a volume (server/file-edit.js): text editor, new file, new folder, rename,
// delete. base: '/containers/<id>' or '/volumes/<name>'. Used by the container Files tab and the volume
// file browser.
const FileEditUI = (() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const join = (dir, name) => (dir === '/' || dir === '' ? '' : dir.replace(/\/$/, '')) + '/' + name;
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

  /** Open a text file in an editor; Save writes it back (owner and mode stay). content: prefill for a new file. */
  async function editor(base, path, { onSaved, content = null } = {}) {
    let text = content;
    if (text === null) {
      try { text = (await API.get(`${base}/text?path=${encodeURIComponent(path)}`)).content; }
      catch (e) { return showToast(e.message, 'error', 8000); }
    }
    const m = showModal(`Edit · ${esc(path)}`, `<textarea class="input" data-fe-text rows="22" spellcheck="false" style="font-family:var(--font-mono,monospace);font-size:12px;white-space:pre;tab-size:4;width:100%">${esc(text)}</textarea>
      <div class="ui-sub" style="margin-top:6px">Text files up to 1 MB. Saving replaces the file; it keeps its owner and permissions. A running app may need a restart to read it again.</div>`, []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const ta = m.overlay.querySelector('[data-fe-text]');
    const footer = m.overlay.querySelector('#modal-footer');
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
    const save = document.createElement('button'); save.className = 'btn btn-primary'; save.textContent = 'Save';
    save.onclick = async () => {
      save.disabled = true;
      try { const r = await API.put(`${base}/text`, { path, content: ta.value }); showToast(r.created ? `Created ${baseName(path)}` : `Saved ${baseName(path)}`); m.close(); onSaved && onSaved(); }
      catch (e) { showToast(e.message, 'error', 8000); save.disabled = false; }
    };
    footer.append(cancel, save);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save.click(); }
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('\t', s, ta.selectionEnd, 'end'); }
    });
    setTimeout(() => ta.focus(), 50);
  }

  function askName(title, label, value, onOk) {
    UI.dialog({ title, saveLabel: 'OK', body: `<label class="ui-field"><span class="ui-label">${esc(label)}</span><input class="input" data-fe-name value="${esc(value || '')}"></label>`,
      onSave: async (ov) => { const v = ov.querySelector('[data-fe-name]').value.trim(); if (!v || v.includes('/')) throw new Error('Give a name without /'); await onOk(v); } });
  }
  const newFile = (base, dir, done) => askName('New file', 'File name', '', async (n) => editor(base, join(dir, n), { content: '', onSaved: done }));
  const newFolder = (base, dir, done) => askName('New folder', 'Folder name', '', async (n) => { await API.post(`${base}/mkdir`, { path: join(dir, n) }); showToast(`Folder ${n} created`); done && done(); });
  const rename = (base, path, done) => askName(`Rename ${baseName(path)}`, 'New name', baseName(path), async (n) => { await API.post(`${base}/rename`, { path, name: n }); showToast(`Renamed to ${n}`); done && done(); });
  function remove(base, path, isDir, done) {
    showDeleteConfirm(`Delete ${baseName(path)}`, {
      message: `<span class="td-mono">${esc(path)}</span>${isDir ? ' and <b>everything in it</b>' : ''} is deleted. This can not be undone.`,
      phrase: baseName(path), confirmLabel: 'Delete',
      onConfirm: async () => { try { await API.post(`${base}/delete-path`, { path }); showToast(`Deleted ${baseName(path)}`); done && done(); } catch (e) { showToast(e.message, 'error', 8000); } },
    });
  }

  /** Buttons for one row of a file list: Edit (text files) and a ⋯ menu with Rename / Delete. */
  function rowActions(path, isDir) {
    return `${isDir ? '' : `<button class="btn btn-xs btn-secondary" data-fe-edit="${esc(path)}">Edit</button> `}${UI.menu([
      { label: 'Rename…', attrs: `data-fe-rename="${esc(path)}"` },
      '-',
      { label: 'Delete…', attrs: `data-fe-delete="${esc(path)}" data-fe-dir="${isDir ? 1 : 0}"`, danger: true },
    ])}`;
  }
  /** Header buttons for the current folder. */
  const folderActions = () => `<button class="btn btn-xs btn-secondary" data-fe-newfile>New file</button> <button class="btn btn-xs btn-secondary" data-fe-newdir>New folder</button>`;
  /** Bind the buttons above inside root; reload() shows the folder again after a change. */
  function bind(root, base, dir, reload) {
    root.querySelectorAll('[data-fe-edit]').forEach(b => b.addEventListener('click', () => editor(base, b.dataset.feEdit, { onSaved: reload })));
    root.querySelectorAll('[data-fe-rename]').forEach(b => b.addEventListener('click', () => rename(base, b.dataset.feRename, reload)));
    root.querySelectorAll('[data-fe-delete]').forEach(b => b.addEventListener('click', () => remove(base, b.dataset.feDelete, b.dataset.feDir === '1', reload)));
    root.querySelector('[data-fe-newfile]')?.addEventListener('click', () => newFile(base, dir, reload));
    root.querySelector('[data-fe-newdir]')?.addEventListener('click', () => newFolder(base, dir, reload));
  }
  return { editor, newFile, newFolder, rename, remove, rowActions, folderActions, bind };
})();
