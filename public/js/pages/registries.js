// Registries Page — manage private image-registry credentials (ghcr.io, GitLab, Docker Hub private, …).
// Stored credentials are auto-matched by registry host when pulling/pushing images, so private
// images "just work" from the Run modal, Images pull, and Compose. Passwords are never shown back.
async function renderRegistriesInto(content, { embedded = false } = {}) {
  // Well-known registries offered as autocomplete suggestions for the address field.
  const PRESETS = ['docker.io', 'ghcr.io', 'registry.gitlab.com', 'quay.io', 'registry-1.docker.io'];

  // Provider label derived from the host (for the Type badge).
  function regType(addr) {
    const a = (addr || '').toLowerCase();
    if (a.includes('ghcr.io')) return 'GitHub';
    if (a.includes('gitlab')) return 'GitLab';
    if (a.includes('quay.io')) return 'Quay';
    if (a.includes('docker.io') || a.includes('index.docker')) return 'Docker Hub';
    return 'Custom';
  }
  // Connection status pill from the cached Test-login result.
  function statusPill(r) {
    if (r.last_test_status === 'ok') return '<span class="badge badge-running">Connected</span>';
    if (r.last_test_status === 'fail') return '<span class="badge badge-dead">Auth failed</span>';
    return '<span class="badge badge-created">Untested</span>';
  }

  let regCache = [];
  async function load() {
    const tbody = document.getElementById('reg-tbody');
    const empty = document.getElementById('reg-empty');
    if (!tbody) return;
    try {
      const rows = await API.get('/registries');
      regCache = rows;
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td class="td-name">${escapeHtml(r.name || r.server_address)} <span class="badge badge-created" style="font-size:10px;margin-left:4px">${regType(r.server_address)}</span></td>
          <td class="td-mono text-sm">${escapeHtml(r.server_address)}</td>
          <td class="text-sm">${escapeHtml(r.username)}</td>
          <td>${statusPill(r)}</td>
          <td><button class="btn btn-secondary btn-sm" data-browse="${r.id}" title="Browse repositories">${Icons.registry} ${r.trackedRepos || 0} repo${r.trackedRepos === 1 ? '' : 's'}</button></td>
          <td class="text-sm text-muted" style="white-space:nowrap">${formatTime(r.created_at)}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-secondary btn-sm" data-test="${r.id}" title="Test login">${Icons.refresh} Test</button>
            <button class="btn btn-secondary btn-sm" data-edit="${r.id}" title="Edit">Edit</button>
            <button class="btn btn-danger btn-sm" data-del="${r.id}" data-addr="${escapeHtml(r.server_address)}" title="Delete">${Icons.trash}</button>
          </td>
        </tr>`).join('');
      if (empty) empty.style.display = rows.length ? 'none' : 'block';
    } catch (err) {
      showToast('Failed to load registries: ' + err.message, 'error');
    }
  }

  // Browse the repositories tracked under a registry (auto-tracked on push + user-pinned), and list a
  // repo's tags via the registry v2 API (digest/size fetched lazily per tag on click).
  function openBrowse(reg) {
    const m = showModal(`Browse — ${escapeHtml(reg.name || reg.server_address)}`, `
      <div style="display:flex;flex-direction:column;gap:10px;min-width:520px">
        <div class="text-xs text-muted">Repositories pushed through DockGate are tracked automatically. ${escapeHtml(regType(reg.server_address))} doesn't always allow listing the whole catalog, so DockGate tracks repos by name — add others below.</div>
        <div style="display:flex;gap:6px">
          <input class="input" id="brw-repo" placeholder="owner/app" spellcheck="false" style="flex:1">
          <button class="btn btn-secondary" id="brw-add">Track</button>
        </div>
        <div id="brw-list"><div class="text-muted text-sm">Loading…</div></div>
      </div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = document.getElementById('modal-root');
    const listEl = root.querySelector('#brw-list');

    async function loadRepos() {
      try {
        const repos = await API.get(`/registries/${reg.id}/repos`);
        if (!repos.length) { listEl.innerHTML = '<div class="text-muted text-sm" style="padding:10px 0">No tracked repositories yet. Push an image here, or add one above.</div>'; return; }
        listEl.innerHTML = repos.map(rp => `
          <div class="card" style="padding:10px;margin-bottom:6px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <div><span class="td-mono" style="font-weight:600">${escapeHtml(rp.repo)}</span>${rp.last_pushed_at ? `<span class="text-xs text-muted" style="margin-left:8px">pushed ${formatTime(rp.last_pushed_at)}</span>` : ''}</div>
              <div style="display:flex;gap:6px;flex:none">
                <button class="btn btn-xs btn-secondary" data-tags="${escapeHtml(rp.repo)}">${Icons.tag} Tags</button>
                <button class="btn btn-xs btn-secondary text-danger" data-untrack="${escapeHtml(rp.repo)}">Untrack</button>
              </div>
            </div>
            <div class="brw-tags" data-tagsfor="${escapeHtml(rp.repo)}" style="display:none;margin-top:8px"></div>
          </div>`).join('');
      } catch (e) { listEl.innerHTML = `<div class="text-danger text-sm">${escapeHtml(e.message)}</div>`; }
    }

    root.querySelector('#brw-add').addEventListener('click', async () => {
      const repo = root.querySelector('#brw-repo').value.trim();
      if (!repo) return;
      try { await API.post(`/registries/${reg.id}/repos`, { repo }); root.querySelector('#brw-repo').value = ''; loadRepos(); }
      catch (e) { showToast(e.message, 'error'); }
    });

    listEl.addEventListener('click', async (e) => {
      const untrackBtn = e.target.closest('[data-untrack]');
      if (untrackBtn) {
        const repo = untrackBtn.dataset.untrack;
        try { await API.del(`/registries/${reg.id}/repos?repo=${encodeURIComponent(repo)}`); loadRepos(); } catch (err) { showToast(err.message, 'error'); }
        return;
      }
      const tagsBtn = e.target.closest('[data-tags]');
      if (tagsBtn) {
        const repo = tagsBtn.dataset.tags;
        const box = listEl.querySelector(`.brw-tags[data-tagsfor="${CSS.escape(repo)}"]`);
        if (!box) return;
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        box.style.display = 'block'; box.innerHTML = '<div class="text-muted text-xs">Loading tags…</div>';
        try {
          const data = await API.get(`/registries/${reg.id}/tags?repo=${encodeURIComponent(repo)}`);
          const tags = data.tags || [];
          box.innerHTML = tags.length
            ? tags.map(t => `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;flex-wrap:wrap"><button class="btn btn-xs btn-secondary" data-manifest="${escapeHtml(repo)}" data-ref="${escapeHtml(t)}">${escapeHtml(t)}</button><span class="text-xs text-muted" data-info="${escapeHtml(repo + '|' + t)}"></span></div>`).join('')
            : '<div class="text-muted text-xs">No tags.</div>';
        } catch (err) { box.innerHTML = `<div class="text-danger text-xs">${escapeHtml(err.message)}</div>`; }
        return;
      }
      const mBtn = e.target.closest('[data-manifest]');
      if (mBtn) {
        const repo = mBtn.dataset.manifest, ref = mBtn.dataset.ref;
        const info = listEl.querySelector(`[data-info="${CSS.escape(repo + '|' + ref)}"]`);
        if (info) info.textContent = '…';
        try {
          const mi = await API.get(`/registries/${reg.id}/manifest?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
          if (info) info.textContent = `${mi.size ? formatBytes(mi.size) : ''} ${mi.digest ? mi.digest.slice(0, 19) + '…' : ''}`.trim() || '—';
        } catch (err) { if (info) info.textContent = '✗ ' + err.message; }
      }
    });

    loadRepos();
  }

  // Add / edit form in a modal. `existing` (a registry row from the table) → edit mode.
  function openForm(existing = null) {
    const isEdit = !!existing;
    const body = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="input-group">
          <label>Display name (optional)</label>
          <input class="input" id="reg-name" placeholder="e.g. My GitHub Registry" value="${existing ? escapeHtml(existing.name || '') : ''}">
        </div>
        <div class="input-group">
          <label>Registry address *</label>
          <input class="input" id="reg-addr" list="reg-addr-list" placeholder="ghcr.io" value="${existing ? escapeHtml(existing.server_address) : ''}">
          <datalist id="reg-addr-list">${PRESETS.map(p => `<option value="${p}">`).join('')}</datalist>
          <span class="text-xs text-muted">Host only — e.g. <code>ghcr.io</code>, <code>registry.gitlab.com</code>, <code>docker.io</code> for Docker Hub.<br>GitHub (<code>ghcr.io</code>): password = a Personal Access Token with <code>read:packages</code> (<code>write:packages</code> to push). Then pull using the full ref, e.g. <code>ghcr.io/user/image:tag</code> — the stored credential is attached automatically.</span>
        </div>
        <div class="input-group">
          <label>Username *</label>
          <input class="input" id="reg-user" placeholder="username" value="${existing ? escapeHtml(existing.username) : ''}">
        </div>
        <div class="input-group">
          <label>Password / token ${isEdit ? '<span class="text-xs text-muted">(leave blank to keep current)</span>' : '*'}</label>
          <input class="input" id="reg-pass" type="password" placeholder="${isEdit ? '••••••••' : 'password or access token'}" autocomplete="new-password">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary" id="reg-test">${Icons.refresh} Test login</button>
          <span id="reg-test-result" class="text-sm"></span>
        </div>
      </div>`;

    const m = showModal(isEdit ? 'Edit registry' : 'Add registry', body, []);
    const root = document.getElementById('modal-root');

    // Add a Save button to the footer manually so the modal stays open on validation errors.
    const footer = root.querySelector('#modal-footer');
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.innerHTML = `${Icons.key} ${isEdit ? 'Save' : 'Add registry'}`;
    footer.appendChild(saveBtn);

    const val = (id) => root.querySelector('#' + id).value.trim();

    // Test login — uses the form values (or, in edit mode with a blank password, the stored one)
    root.querySelector('#reg-test').addEventListener('click', async () => {
      const result = root.querySelector('#reg-test-result');
      const addr = val('reg-addr'), user = val('reg-user'), pass = root.querySelector('#reg-pass').value;
      result.textContent = 'Testing…'; result.style.color = 'var(--text-secondary)';
      try {
        // Edit mode + blank password → test the stored credential by id
        const payload = (isEdit && !pass)
          ? { id: existing.id }
          : { serverAddress: addr, username: user, password: pass };
        const res = await API.post('/registries/test', payload);
        result.textContent = '✓ ' + (res.status || 'Login Succeeded');
        result.style.color = 'var(--success, #16a34a)';
      } catch (err) {
        result.textContent = '✗ ' + err.message;
        result.style.color = 'var(--danger)';
      }
    });

    saveBtn.addEventListener('click', async () => {
      const name = val('reg-name'), addr = val('reg-addr'), user = val('reg-user');
      const pass = root.querySelector('#reg-pass').value;
      if (!addr) { showToast('Registry address is required', 'warning'); return; }
      if (!user) { showToast('Username is required', 'warning'); return; }
      if (!isEdit && !pass) { showToast('Password is required', 'warning'); return; }

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        if (isEdit) {
          await API.put('/registries/' + existing.id, { name, serverAddress: addr, username: user, password: pass });
          showToast('Registry updated');
        } else {
          await API.post('/registries', { name, serverAddress: addr, username: user, password: pass });
          showToast('Registry added');
        }
        m.close();
        load();
      } catch (err) {
        showToast(err.message, 'error', 8000);
        saveBtn.disabled = false; saveBtn.innerHTML = `${Icons.key} ${isEdit ? 'Save' : 'Add registry'}`;
      }
    });
  }

  content.innerHTML = `
    ${embedded ? `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px">
      <button class="btn btn-secondary" id="reg-refresh">${Icons.refresh} Refresh</button>
      <button class="btn btn-primary" id="reg-add">${Icons.key} Add Registry</button>
    </div>` : `<div class="page-header">
      <div>
        <div class="page-title">Registries</div>
        <div class="page-subtitle">Private registry credentials — used automatically when pulling or pushing images</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="reg-refresh">${Icons.refresh} Refresh</button>
        <button class="btn btn-primary" id="reg-add">${Icons.key} Add Registry</button>
      </div>
    </div>`}

    <div class="table-wrapper">
      <table>
        <thead><tr><th>Name</th><th>Address</th><th>Username</th><th>Status</th><th>Repos</th><th>Added</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody id="reg-tbody"></tbody>
      </table>
      <div id="reg-empty" class="empty-state" style="padding:40px;display:none">
        No registries yet. Add one to pull/push private images.
      </div>
    </div>
  `;

  document.getElementById('reg-refresh')?.addEventListener('click', load);
  document.getElementById('reg-add')?.addEventListener('click', () => openForm());

  // Row action delegation
  document.getElementById('reg-tbody')?.addEventListener('click', async (e) => {
    const testBtn = e.target.closest('[data-test]');
    const editBtn = e.target.closest('[data-edit]');
    const delBtn = e.target.closest('[data-del]');
    const browseBtn = e.target.closest('[data-browse]');

    if (browseBtn) {
      const reg = regCache.find(r => String(r.id) === browseBtn.dataset.browse);
      if (reg) openBrowse(reg);
      return;
    }

    if (testBtn) {
      const id = testBtn.dataset.test;
      const original = testBtn.innerHTML;
      testBtn.disabled = true; testBtn.textContent = 'Testing…';
      try {
        const res = await API.post('/registries/test', { id });
        showToast('✓ ' + (res.status || 'Login Succeeded'));
      } catch (err) {
        showToast('✗ ' + err.message, 'error', 8000);
      } finally {
        testBtn.disabled = false; testBtn.innerHTML = original;
        load(); // refresh the status pill from the cached test result
      }
      return;
    }

    if (editBtn) {
      // Fetch the current list to get the full row (the list never includes the password)
      try {
        const rows = await API.get('/registries');
        const row = rows.find(r => String(r.id) === editBtn.dataset.edit);
        if (row) openForm(row);
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    if (delBtn) {
      const id = delBtn.dataset.del;
      showConfirm('Delete registry', `Remove the credential for "${delBtn.dataset.addr}"? Pulling private images from it will stop working.`, async () => {
        try {
          await API.del('/registries/' + id);
          showToast('Registry deleted');
          load();
        } catch (err) { showToast(err.message, 'error'); }
      }, true);
    }
  });

  await load();
}
