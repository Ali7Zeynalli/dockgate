// Images Page
Router.register('images', async (content) => {
  let currentFilter = 'all';
  let currentSearch = '';
  let selectedIds = new Set();
  let refreshTimer = null;

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      let images = await API.get('/images');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      const allCount = images.length;
      if (currentFilter === 'inuse') images = images.filter(i => i.inUse);
      else if (currentFilter === 'unused') images = images.filter(i => !i.inUse);
      else if (currentFilter === 'dangling') images = images.filter(i => i.isDangling);

      if (currentSearch) {
        const q = currentSearch.toLowerCase();
        images = images.filter(i =>
          (i.repoTags[0] || '').toLowerCase().includes(q) ||
          i.shortId.toLowerCase().includes(q)
        );
      }

      // Clean up selectedIds that are no longer visible
      const visibleIds = new Set(images.map(i => i.id));
      for (const id of selectedIds) {
        if (!visibleIds.has(id)) selectedIds.delete(id);
      }

      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Images</div><div class="page-subtitle">${images.length} image(s)</div></div>
          <div class="page-actions">
            <button class="btn btn-primary" id="pull-image-btn">${Icons.download} Pull Image</button>
            <button class="btn btn-secondary" id="load-image-btn" title="Load an image from a .tar">${Icons.layers} Load</button>
            <button class="btn btn-secondary" id="images-refresh">${Icons.refresh}</button>
          </div>
        </div>
        <div class="filter-bar">
          <button class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">All (${allCount})</button>
          <button class="filter-btn ${currentFilter === 'inuse' ? 'active' : ''}" data-filter="inuse">In Use</button>
          <button class="filter-btn ${currentFilter === 'unused' ? 'active' : ''}" data-filter="unused">Unused</button>
          <button class="filter-btn ${currentFilter === 'dangling' ? 'active' : ''}" data-filter="dangling">Dangling</button>
          <div style="flex:1"></div>
          <div class="search-input">
            <span class="nav-item-icon">${Icons.search}</span>
            <input type="text" placeholder="Search images..." value="${escapeHtml(currentSearch)}" id="image-search">
          </div>
        </div>

        ${selectedIds.size > 0 ? `
        <div class="card mb-2" style="padding:12px 18px;display:flex;align-items:center;gap:12px;background:var(--accent-dim)">
          <span class="text-sm font-bold">${selectedIds.size} selected</span>
          <button class="btn btn-sm btn-danger" id="bulk-remove">${Icons.trash} Remove</button>
          <button class="btn btn-sm btn-danger" id="bulk-force-remove">${Icons.trash} Force Remove</button>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-ghost" id="bulk-clear">Clear</button>
        </div>` : ''}

        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th style="width:40px"><div class="checkbox ${images.length > 0 && selectedIds.size === images.length ? 'checked' : ''}" id="select-all"></div></th>
              <th>Repository</th><th>Tag</th><th>Image ID</th><th>Size</th><th>Created</th><th>Containers</th><th style="text-align:right">Actions</th>
            </tr></thead>
            <tbody>
              ${images.map(img => {
                // Split on the LAST colon so registry ports survive (e.g. localhost:5000/app:1.0 → repo, tag=1.0)
                const full = img.repoTags[0] || '<none>:<none>';
                const ci = full.lastIndexOf(':');
                const repo = ci > 0 ? full.slice(0, ci) : full;
                const tag = ci > 0 ? full.slice(ci + 1) : '';
                return `<tr class="${selectedIds.has(img.id) ? 'selected' : ''}">
                  <td><div class="checkbox ${selectedIds.has(img.id) ? 'checked' : ''}" data-select="${img.id}"></div></td>
                  <td class="td-name">${escapeHtml(repo)}</td>
                  <td><span class="badge badge-created">${escapeHtml(tag || 'latest')}</span></td>
                  <td class="td-mono">${img.shortId}</td>
                  <td class="text-sm">${formatBytes(img.size)}</td>
                  <td class="text-muted text-sm">${timeAgo(img.created)}</td>
                  <td><span class="badge ${img.inUse ? 'badge-running' : 'badge-dead'}">${img.containers}</span></td>
                  <td>
                    <div class="td-actions">
                      <button class="btn-icon" title="Run container" data-run="${escapeHtml(full)}">${Icons.play}</button>
                      <button class="btn-icon" title="Layers / history" data-layers="${img.id}">${Icons.layers}</button>
                      <button class="btn-icon" title="Tags" data-tags="${img.id}">${Icons.tag}</button>
                      <button class="btn-icon" title="Save (download tar)" data-save="${img.id}">${Icons.download}</button>
                      ${repo !== '<none>' ? `<button class="btn-icon" title="Push to registry" data-push="${escapeHtml(full)}" data-pushid="${img.id}">${Icons.arrowUp}</button>` : ''}
                      <button class="btn-icon" title="Build from this (FROM)" data-buildfrom="${escapeHtml(full)}">${Icons.compose}</button>
                      <button class="btn-icon" title="Inspect" data-inspect="${img.id}">${Icons.eye}</button>
                      <button class="btn-icon" title="Remove" data-remove="${img.id}" data-name="${escapeHtml(full)}" style="color:var(--danger)">${Icons.trash}</button>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      // Filter buttons
      content.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => { currentFilter = btn.dataset.filter; render(); }));
      document.getElementById('images-refresh')?.addEventListener('click', render);

      // Search
      const searchInput = document.getElementById('image-search');
      if (searchInput) {
        let timeout;
        searchInput.addEventListener('input', () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => { currentSearch = searchInput.value; render(); }, 300);
        });
      }

      // Load image from a .tar (I2)
      document.getElementById('load-image-btn')?.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.tar';
        inp.onchange = async () => {
          const f = inp.files && inp.files[0];
          if (!f) return;
          showToast(`Loading ${f.name}…`, 'info');
          try {
            const r = await fetch('/api/images/load', { method: 'POST', headers: { 'Content-Type': 'application/x-tar' }, body: f });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'Load failed');
            showToast('Image loaded'); render();
          } catch (e) { showToast(e.message, 'error', 8000); }
        };
        inp.click();
      });

      // Pull image
      document.getElementById('pull-image-btn')?.addEventListener('click', () => {
        const m = showModal('Pull Image',
          '<div class="input-group"><label>Image Name (e.g., nginx:latest)</label><input type="text" id="pull-image-input" placeholder="nginx:latest"></div>' +
          `<button type="button" class="btn btn-xs btn-secondary" id="pull-hub-btn">${Icons.search} Search Docker Hub</button>` +
          '<div class="text-xs text-muted" style="margin-top:8px">Private image? Use the full reference (e.g. <code>ghcr.io/user/app:tag</code>) and add the registry under <strong>Registries</strong> first — the stored credential is attached automatically.</div>', [
          { label: 'Cancel', className: 'btn btn-secondary' },
          { label: 'Pull', className: 'btn btn-primary', onClick: async () => {
            const image = document.getElementById('pull-image-input')?.value;
            if (!image) return;
            showToast(`Pulling ${image}...`, 'info');
            try { await API.post('/images/pull', { image }); showToast(`Pulled ${image}`); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }},
        ]);
        // Search Docker Hub → fill the image name field
        m.overlay.querySelector('#pull-hub-btn')?.addEventListener('click', () => openHubSearch(name => {
          m.overlay.querySelector('#pull-image-input').value = name;
        }));
      });

      // Run a container from this image (opens the guided Run modal pre-filled)
      content.querySelectorAll('[data-run]').forEach(btn => {
        btn.addEventListener('click', () => openRunContainerModal(btn.dataset.run));
      });

      // Push this image to a registry (live console; credential auto-matched by host)
      content.querySelectorAll('[data-push]').forEach(btn => {
        btn.addEventListener('click', () => openPushModal(btn.dataset.push, btn.dataset.pushid));
      });

      // Single remove
      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const imgId = btn.dataset.remove;
          const name = btn.dataset.name;
          showDeleteConfirm('Remove Image', { message: `Remove <strong>${name}</strong>?`, phrase: name, onConfirm: async () => {
            try { await API.del(`/images/${encodeURIComponent(imgId)}`); showToast(`Removed ${name}`); render(); }
            catch (err) { showToast(err.message, 'error'); }
          } });
        });
      });

      // Inspect
      content.querySelectorAll('[data-inspect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const data = await API.get(`/images/${encodeURIComponent(btn.dataset.inspect)}`);
            showModal('Image Inspect', `<div class="json-viewer" style="max-height:400px">${syntaxHighlightJSON(JSON.stringify(data, null, 2))}</div>`, [
              { label: 'Close', className: 'btn btn-secondary' },
            ]);
          } catch (err) { showToast(err.message, 'error'); }
        });
      });

      // Layers / history (I1)
      content.querySelectorAll('[data-layers]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const hist = await API.get(`/images/${encodeURIComponent(btn.dataset.layers)}/history`);
            const rows = (hist || []).map(h => {
              const cmd = (h.CreatedBy || '').replace(/^\/bin\/sh -c (#\(nop\)\s*)?/, '').trim();
              return `<tr><td class="text-xs text-muted" style="white-space:nowrap;vertical-align:top">${formatBytes(h.Size || 0)}</td><td class="td-mono text-xs" style="white-space:pre-wrap;word-break:break-all">${escapeHtml(cmd || '—')}</td></tr>`;
            }).join('');
            showModal('Image Layers', `<div class="table-wrapper" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Size</th><th>Created By</th></tr></thead><tbody>${rows}</tbody></table></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
          } catch (e) { showToast(e.message, 'error'); }
        });
      });

      // Tags — add / untag (I4)
      content.querySelectorAll('[data-tags]').forEach(btn => {
        btn.addEventListener('click', () => openTagsModal(btn.dataset.tags));
      });

      // Build from this image (I3) → hand off to the Builds page with an inline Dockerfile prefilled
      content.querySelectorAll('[data-buildfrom]').forEach(btn => btn.addEventListener('click', () => {
        sessionStorage.setItem('dgt_build_from', btn.dataset.buildfrom);
        Router.navigate('resources',{tab:'builds'});
      }));

      // Save image → download tar (I2)
      content.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = `/api/images/${encodeURIComponent(btn.dataset.save)}/save`;
        a.download = 'image.tar';
        document.body.appendChild(a); a.click(); a.remove();
        showToast('Saving image…', 'info');
      }));

      // Selection
      content.querySelectorAll('[data-select]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = el.dataset.select;
          if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
          render();
        });
      });

      document.getElementById('select-all')?.addEventListener('click', () => {
        if (selectedIds.size === images.length) selectedIds.clear();
        else images.forEach(i => selectedIds.add(i.id));
        render();
      });

      // Bulk actions
      document.getElementById('bulk-clear')?.addEventListener('click', () => { selectedIds.clear(); render(); });

      document.getElementById('bulk-remove')?.addEventListener('click', () => {
        showDeleteConfirm('Remove Selected', { message: `Remove ${selectedIds.size} image(s)?`, phrase: 'delete', onConfirm: async () => {
          await bulkRun([...selectedIds], (id) => API.del(`/images/${encodeURIComponent(id)}`), 'Removed');
          selectedIds.clear();
          render();
        } });
      });

      document.getElementById('bulk-force-remove')?.addEventListener('click', () => {
        showDeleteConfirm('Force Remove Selected', { message: `Force remove ${selectedIds.size} image(s)? This will also remove images currently in use.`, phrase: 'delete', onConfirm: async () => {
          await bulkRun([...selectedIds], (id) => API.del(`/images/${encodeURIComponent(id)}?force=true`), 'Force removed');
          selectedIds.clear();
          render();
        } });
      });

    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }

  // Tag management — list current tags, add a new one, untag (I4)
  async function openTagsModal(id) {
    let info;
    try { info = await API.get(`/images/${encodeURIComponent(id)}`); }
    catch (e) { showToast(e.message, 'error'); return; }
    const tags = (info.RepoTags || []).filter(t => t && t !== '<none>:<none>');
    const body = `
      <div class="detail-label mb-1">Current tags</div>
      ${tags.length ? `<div style="display:flex;flex-direction:column;gap:4px">${tags.map(t => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px"><span class="td-mono text-sm" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(t)}</span><button class="btn btn-xs btn-secondary" data-untag="${escapeHtml(t)}">Untag</button></div>`).join('')}</div>` : '<div class="text-muted text-sm">No tags.</div>'}
      <div class="mt-2" style="display:flex;gap:6px;align-items:center">
        <input class="input" id="newtag" placeholder="repo:tag (e.g. myrepo/app:1.0)" style="flex:1">
        <button class="btn btn-sm btn-primary" id="addtag-btn">Add tag</button>
      </div>`;
    const m = showModal('Image Tags', body, [{ label: 'Close', className: 'btn btn-secondary' }]);
    const root = m.overlay;
    root.querySelector('#addtag-btn')?.addEventListener('click', async () => {
      const v = root.querySelector('#newtag').value.trim();
      if (!v) { showToast('Enter repo:tag', 'warning'); return; }
      const ci = v.lastIndexOf(':');
      const repo = ci > 0 ? v.slice(0, ci) : v;
      const tag = ci > 0 ? v.slice(ci + 1) : 'latest';
      try { await API.post(`/images/${encodeURIComponent(id)}/tag`, { repo, tag }); showToast('Tag added'); m.close(); render(); openTagsModal(id); }
      catch (e) { showToast(e.message, 'error'); }
    });
    root.querySelectorAll('[data-untag]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post('/images/untag', { tag: b.dataset.untag }); showToast('Untagged'); m.close(); render(); openTagsModal(id); }
      catch (e) { showToast(e.message, 'error'); }
    }));
  }

  await render();
  refreshTimer = setInterval(() => { if (!shouldSkipAutoRefresh()) render(); }, 15000);
  return () => { if (refreshTimer) clearInterval(refreshTimer); };
});

// Split a full image ref into { repo, tag } on the LAST colon after the last slash (registry ports survive).
function splitImageRef(ref) {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { repo: ref, tag: 'latest' };
}

// Resolve an image ref into { host, repoPath, tag } using Docker's host rule (first slash-segment is a
// registry host only if it has a '.'/':' or is 'localhost'; otherwise the registry is Docker Hub).
function parseImageRef(ref) {
  const slash = ref.indexOf('/');
  const first = slash >= 0 ? ref.slice(0, slash) : '';
  let host, rest;
  if (first && (first.includes('.') || first.includes(':') || first === 'localhost')) { host = first; rest = ref.slice(slash + 1); }
  else { host = 'docker.io'; rest = ref; }
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  let tag = 'latest', repoPath = rest;
  if (lastColon > lastSlash) { tag = rest.slice(lastColon + 1); repoPath = rest.slice(0, lastColon); }
  return { host, repoPath, tag };
}

// Best-effort web URL to view a pushed image in its registry's UI (null when the provider is unknown).
function registryWebUrl(host, repoPath) {
  if (!repoPath) return null;
  const parts = repoPath.split('/');
  if (host === 'ghcr.io') { const owner = parts[0]; const last = parts[parts.length - 1]; return owner && parts.length > 1 ? `https://github.com/${owner}/${last}/pkgs/container/${last}` : null; }
  if (host === 'docker.io') return `https://hub.docker.com/${parts.length === 1 ? '_/' + parts[0] : 'r/' + repoPath}`;
  if (host === 'registry.gitlab.com') return `https://gitlab.com/${repoPath}/container_registry`;
  if (host === 'quay.io') return `https://quay.io/repository/${repoPath}`;
  return null;
}

// Which stored registry (if any) authenticates a push to `host` (Docker Hub has several aliases).
function matchRegistry(host, registries) {
  const HUB = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'https://index.docker.io/v1/'];
  const candidates = host === 'docker.io' ? HUB : [host];
  return (registries || []).find(r => candidates.includes(r.server_address)) || null;
}

// Push an image to a registry with a live progress console + a post-push result card (digest/size/link).
// Global so the Images page AND the Builds page can both call it. Backend streams over Socket.io.
async function openPushModal(repoTag, imageId) {
  const m = showModal('Push image to registry', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group">
        <label>Target reference</label>
        <input class="input" id="push-ref" value="${escapeHtml(repoTag)}" placeholder="ghcr.io/owner/app:tag" spellcheck="false">
      </div>
      <div id="push-reg" class="text-xs" style="min-height:16px"></div>
      <div class="text-xs text-muted">The credential is matched automatically by registry host — add it under <strong>Servers → Registries</strong> first, with <strong>write/push</strong> access. To push a local image, change the reference to a full registry path: DockGate re-tags it for you, then pushes.</div>
      <pre id="push-log" style="display:none;background:var(--bg-primary,#0d1117);border:1px solid var(--border);border-radius:8px;padding:10px;height:280px;overflow:auto;font-family:var(--font-mono,monospace);font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>
      <div id="push-result" style="display:none"></div>
    </div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);

  const go = document.createElement('button');
  go.className = 'btn btn-primary'; go.textContent = 'Push';
  m.overlay.querySelector('#modal-footer').appendChild(go);

  const refEl = m.overlay.querySelector('#push-ref');
  const regEl = m.overlay.querySelector('#push-reg');
  const pre = m.overlay.querySelector('#push-log');
  const resultEl = m.overlay.querySelector('#push-result');

  // Phase B — live "which registry will be used" hint for the current target reference.
  let registries = [];
  const updateBadge = () => {
    const ref = refEl.value.trim();
    if (!ref) { regEl.innerHTML = ''; return; }
    const { host } = parseImageRef(ref);
    const reg = matchRegistry(host, registries);
    regEl.innerHTML = reg
      ? `<span style="color:var(--success,#22c55e)">✓ Will authenticate as <strong>${escapeHtml(reg.name || reg.server_address)}</strong> (${escapeHtml(host)})</span>`
      : `<span style="color:var(--warning,#f59e0b)">⚠ No stored credential for <strong>${escapeHtml(host)}</strong> — push is anonymous (fails for private). Add it under Servers → Registries.</span>`;
  };
  refEl.addEventListener('input', updateBadge);
  API.get('/registries').then(rows => { registries = rows || []; updateBadge(); }).catch(() => {});
  updateBadge();

  const byId = {}, idOrder = [], plain = [];
  let auxResult = null;
  const render = () => { pre.textContent = [...plain, ...idOrder.map(id => byId[id])].join('\n'); pre.scrollTop = pre.scrollHeight; };
  const addEvent = (ev) => {
    if (!ev) return;
    if (ev.error) { plain.push('✖ ' + ev.error); }
    else if (ev.aux) { auxResult = ev.aux; }              // structured final event — not all daemons emit it
    else if (ev.id) { if (!(ev.id in byId)) idOrder.push(ev.id); byId[ev.id] = ev.id.slice(0, 12) + ': ' + (ev.status || '') + (ev.progress ? ' ' + ev.progress : ''); }
    else if (ev.status) {
      plain.push(ev.status);
      // Fallback when there's no aux event: the digest+size arrive as a status line "…: digest: sha256:… size: 1234".
      const md = ev.status.match(/digest:\s*(sha256:[0-9a-f]+)\s+size:\s*(\d+)/i);
      if (md) { auxResult = auxResult || {}; if (!auxResult.Digest) auxResult.Digest = md[1]; if (!auxResult.Size) auxResult.Size = parseInt(md[2], 10); }
    }
    render();
  };

  // Phase A — post-push result card: tag · digest (+copy) · compressed size · registry · view link.
  const showResult = (d) => {
    const ref = refEl.value.trim();
    const { host, repoPath } = parseImageRef(ref);
    const digest = (d && d.digest) || (auxResult && auxResult.Digest) || '';
    const size = (d && d.size) || (auxResult && auxResult.Size) || 0;
    const url = registryWebUrl(host, repoPath);
    resultEl.innerHTML = `
      <div class="card" style="padding:12px;margin-top:10px;border-color:var(--success,#22c55e)">
        <div style="font-weight:600;margin-bottom:8px;color:var(--success,#22c55e)">✔ Pushed ${escapeHtml(ref)}</div>
        <div class="text-xs" style="display:flex;flex-direction:column;gap:4px">
          ${digest ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="text-muted">Digest:</span> <span class="td-mono" style="word-break:break-all">${escapeHtml(digest)}</span> <button class="btn btn-xs btn-secondary" id="push-copy-digest">Copy</button></div>` : ''}
          ${size ? `<div><span class="text-muted">Compressed size:</span> ${formatBytes(size)}</div>` : ''}
          <div><span class="text-muted">Registry:</span> ${escapeHtml(host)}</div>
          ${url ? `<div style="margin-top:2px"><a href="${url}" target="_blank" rel="noopener" class="btn btn-xs btn-secondary">${Icons.externalLink} View in registry</a></div>` : ''}
        </div>
      </div>`;
    resultEl.style.display = 'block';
    const cp = resultEl.querySelector('#push-copy-digest');
    if (cp) cp.onclick = () => navigator.clipboard?.writeText(digest).then(() => showToast('Copied'));
  };

  const onStarted = (d) => { plain.push('Pushing ' + d.repoTag + ' …'); render(); };
  const onProgress = (ev) => addEvent(ev);
  const onDone = (d) => { plain.push('✔ Pushed ' + d.repoTag); render(); go.disabled = false; go.textContent = 'Push again'; showToast('Pushed ' + d.repoTag, 'success'); showResult(d); cleanup(); };
  const onErr = (d) => { plain.push('✖ ' + (d.error || 'Push failed')); render(); go.disabled = false; go.textContent = 'Retry'; showToast(d.error || 'Push failed', 'error', 8000); cleanup(); };
  const cleanup = () => {
    socket.off('image:push:started', onStarted);
    socket.off('image:push:progress', onProgress);
    socket.off('image:push:done', onDone);
    socket.off('image:push:error', onErr);
  };

  // Detach the socket listeners whenever the modal goes away (Close button, X, or backdrop click).
  const mo = new MutationObserver(() => { if (!m.overlay.isConnected) { cleanup(); mo.disconnect(); } });
  mo.observe(document.getElementById('modal-root'), { childList: true });

  go.onclick = async () => {
    const targetRef = refEl.value.trim();
    if (!targetRef) return showToast('Target reference required', 'warning');
    go.disabled = true; go.textContent = 'Pushing…';
    // Re-tag first if pushing to a different reference than the image currently carries.
    if (targetRef !== repoTag) {
      try {
        const { repo, tag } = splitImageRef(targetRef);
        await API.post(`/images/${encodeURIComponent(imageId || repoTag)}/tag`, { repo, tag });
      } catch (e) { showToast('Tag failed: ' + e.message, 'error'); go.disabled = false; go.textContent = 'Push'; return; }
    }
    pre.style.display = 'block';
    resultEl.style.display = 'none'; auxResult = null;
    plain.length = 0; idOrder.length = 0; for (const k in byId) delete byId[k];
    cleanup(); // avoid double-binding if pushing again
    socket.on('image:push:started', onStarted);
    socket.on('image:push:progress', onProgress);
    socket.on('image:push:done', onDone);
    socket.on('image:push:error', onErr);
    socket.emit('image:push', { repoTag: targetRef });
  };
}
