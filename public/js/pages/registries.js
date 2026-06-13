// Registries Page — manage private image-registry credentials (ghcr.io, GitLab, Docker Hub private, …).
// Stored credentials are auto-matched by registry host when pulling/pushing images, so private
// images "just work" from the Run modal, Images pull, and Compose. Passwords are never shown back.
async function renderRegistriesInto(content, { embedded = false } = {}) {
  // Well-known registries offered as autocomplete suggestions for the address field.
  const PRESETS = ['docker.io', 'ghcr.io', 'registry.gitlab.com', 'quay.io', 'registry-1.docker.io'];

  async function load() {
    const tbody = document.getElementById('reg-tbody');
    const empty = document.getElementById('reg-empty');
    if (!tbody) return;
    try {
      const rows = await API.get('/registries');
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td class="td-name">${escapeHtml(r.name || r.server_address)}</td>
          <td class="td-mono text-sm">${escapeHtml(r.server_address)}</td>
          <td class="text-sm">${escapeHtml(r.username)}</td>
          <td class="text-muted text-sm">••••••••</td>
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
        <thead><tr><th>Name</th><th>Address</th><th>Username</th><th>Password</th><th>Added</th><th style="text-align:right">Actions</th></tr></thead>
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
