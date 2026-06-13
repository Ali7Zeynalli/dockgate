// App Templates (marketplace) — a catalog of ready-to-deploy apps in the Portainer "App Templates"
// v2 format. Click Deploy → a container template prefills the Run modal; a stack template prefills the
// shared Compose editor. Source is the bundled catalog by default, or a configurable `template_url`.
Router.register('templates', async (content) => {
  let all = [];      // every template from the catalog
  let source = '';   // 'bundled' | 'remote' | 'bundled-fallback'
  let swarmOk = false; // aktiv daemon swarm manager-dirsə stack template-lərdə "Swarm" düyməsi çıxır

  // "80/tcp" or "8080:80/tcp" → { host, container, proto } for the Run modal.
  function parsePort(p) {
    if (typeof p !== 'string') return null;
    const [hostCont, proto] = p.split('/');
    const parts = hostCont.split(':');
    const container = (parts.length > 1 ? parts[1] : parts[0]).trim();
    const host = parts.length > 1 ? parts[0].trim() : '';
    if (!container) return null;
    return { host, container, proto: (proto || 'tcp').trim() };
  }

  // Build the Run-modal prefill object from a type-1 (container) template.
  function toRunPrefill(t) {
    const slug = (t.title || t.image || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return {
      image: t.image,
      name: slug,
      pull: true,
      ports: (t.ports || []).map(parsePort).filter(Boolean),
      volumes: (t.volumes || []).map(v => ({ host: v.bind || '', container: v.container || '', mode: v.readonly ? 'ro' : 'rw' }))
        .filter(v => v.container),
      env: (t.env || []).map(e => ({ key: e.name, val: e.default != null ? e.default : (e.preset || '') }))
        .filter(e => e.key),
    };
  }

  // Resolve the compose YAML for a stack template: inline `compose`/`stackfile`, else fetch the repository file.
  async function resolveStackYaml(t) {
    if (t.compose) return t.compose;
    if (typeof t.stackfile === 'string' && t.stackfile.includes('\n')) return t.stackfile; // inline content
    const repo = t.repository;
    if (repo && repo.url) {
      // Build a raw URL: <repo.url>/raw/<branch?>/<stackfile> is unreliable across hosts, so try the
      // common GitHub raw form, falling back to <url>/<stackfile>.
      const file = repo.stackfile || 'docker-compose.yml';
      const base = repo.url.replace(/\.git$/, '').replace(/\/$/, '');
      const candidates = [
        `${base}/raw/main/${file}`,
        `${base}/raw/master/${file}`,
        `${base}/${file}`,
      ];
      for (const url of candidates) {
        try {
          const r = await API.get('/templates/stackfile?url=' + encodeURIComponent(url));
          if (r && r.yaml && r.yaml.trim()) return r.yaml;
        } catch (e) { /* try next candidate */ }
      }
    }
    throw new Error('No compose content found for this template');
  }

  async function deploy(t) {
    try {
      if (t.type === 1) {
        openRunContainerModal(toRunPrefill(t));
      } else {
        showToast('Loading compose definition…', 'info', 2000);
        const yaml = await resolveStackYaml(t);
        const slug = (t.title || 'stack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        openComposeEditor(null, { prefillYaml: yaml, prefillName: slug });
      }
    } catch (err) {
      showToast('Cannot deploy: ' + err.message, 'error', 8000);
    }
  }

  // Stack template → SWARM STACK (docker stack deploy). Yalnız swarm manager aktiv olduqda görünür.
  async function deployToSwarm(t) {
    try {
      showToast('Loading compose definition…', 'info', 2000);
      const yaml = await resolveStackYaml(t);
      const slug = (t.title || 'stack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const body = `<div class="input-group"><label>Stack name</label><input class="input" id="tpl-stk-name" value="${escapeHtml(slug)}"></div>
        <div class="text-xs text-muted">Deployed with <code>docker stack deploy</code> on the local manager.</div>`;
      const m = showModal(`Deploy to Swarm — ${escapeHtml(t.title || '')}`, body, []);
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary'; btn.textContent = 'Deploy Stack';
      m.overlay.querySelector('#modal-footer').appendChild(btn);
      btn.addEventListener('click', async () => {
        const name = m.overlay.querySelector('#tpl-stk-name').value.trim();
        if (!name) { showToast('Stack name required', 'warning'); return; }
        btn.disabled = true; btn.textContent = 'Deploying…';
        try {
          await API.post('/swarm/stacks/deploy', { name, compose: yaml });
          showToast(`Stack "${name}" deployed`); m.close(); Router.navigate('deploy',{tab:'swarm'});
        } catch (e) { showToast(e.message, 'error', 10000); btn.disabled = false; btn.textContent = 'Deploy Stack'; }
      });
    } catch (err) {
      showToast('Cannot deploy: ' + err.message, 'error', 8000);
    }
  }

  // Build the <img src> for a logo. `data:` URIs are already inline/same-origin → use as-is;
  // http(s) logos go through our same-origin proxy so external CORP: same-origin can't block them.
  function logoSrc(logo) {
    return /^data:/i.test(logo) ? escapeHtml(logo) : '/api/templates/logo?url=' + encodeURIComponent(logo);
  }

  function cardHtml(t, idx) {
    const isStack = t.type === 2 || t.type === 3;
    const cats = (t.categories || []).slice(0, 3).map(c => `<span class="badge badge-created" style="font-size:10px">${escapeHtml(c)}</span>`).join(' ');
    const logo = t.logo
      ? `<img src="${logoSrc(t.logo)}" alt="" loading="lazy" style="width:40px;height:40px;object-fit:contain;border-radius:6px;background:var(--bg-primary)" onerror="this.style.visibility='hidden'">`
      : `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">${Icons.template}</div>`;
    return `
      <div class="card" data-tpldetail="${idx}" style="display:flex;flex-direction:column;gap:8px;padding:14px;cursor:pointer" title="Click for details">
        <div style="display:flex;gap:10px;align-items:center">
          ${logo}
          <div style="min-width:0">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.title || t.image || 'App')}</div>
            <div class="text-xs text-muted">${isStack ? '🧩 Stack' : '📦 Container'}${t.image ? ' · ' + escapeHtml(t.image) : ''}</div>
          </div>
        </div>
        <div class="text-sm text-muted" style="flex:1;min-height:34px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(t.description || '')}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">${cats}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" data-deploy="${idx}" style="flex:1">${Icons.play} Deploy</button>
          ${isStack && swarmOk ? `<button class="btn btn-secondary btn-sm" data-deploysw="${idx}" title="Deploy as a Swarm stack">${Icons.swarm}</button>` : ''}
        </div>
      </div>`;
  }

  // Format a big count (Docker Hub pulls/stars) compactly: 1234567 → 1.2M.
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // App detail modal — full description, env vars, ports, volumes + Docker Hub popularity (pulls/stars).
  function openTemplateDetail(t) {
    const isStack = t.type === 2 || t.type === 3;
    const cats = (t.categories || []).map(c => `<span class="badge badge-created" style="font-size:10px">${escapeHtml(c)}</span>`).join(' ');
    const env = (t.env || []).map(e => `<li><code>${escapeHtml(e.name || '')}</code>${e.label ? ' — ' + escapeHtml(e.label) : ''}${e.default != null && e.default !== '' ? ' <span class="text-muted">= ' + escapeHtml(String(e.default)) + '</span>' : ''}</li>`).join('');
    const ports = (t.ports || []).map(p => escapeHtml(typeof p === 'string' ? p : (p.host ? `${p.host}:${p.container}` : JSON.stringify(p)))).join(', ');
    const vols = (t.volumes || []).map(v => escapeHtml(typeof v === 'string' ? v : (v.container || v.bind || JSON.stringify(v)))).join(', ');
    const desc = t.note || t.description || '';
    const body = `<div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:12px;align-items:center">
        ${t.logo ? `<img src="${logoSrc(t.logo)}" alt="" style="width:56px;height:56px;object-fit:contain;border-radius:8px;background:var(--bg-primary)" onerror="this.style.display='none'">` : ''}
        <div style="min-width:0">
          <div style="font-weight:700;font-size:16px">${escapeHtml(t.title || t.image || 'App')}</div>
          <div class="text-xs text-muted">${isStack ? '🧩 Stack' : '📦 Container'}${t.image ? ' · <code>' + escapeHtml(t.image) + '</code>' : ''}${t.platform ? ' · ' + escapeHtml(t.platform) : ''}</div>
          <div id="tpl-hub" class="text-xs text-muted" style="margin-top:3px">Loading popularity…</div>
        </div>
      </div>
      ${cats ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${cats}</div>` : ''}
      ${desc ? `<div class="text-sm" style="line-height:1.5">${escapeHtml(desc)}</div>` : ''}
      ${env ? `<div><div class="detail-label mb-1">Environment variables</div><ul class="text-xs" style="margin:0;padding-left:18px;line-height:1.7">${env}</ul></div>` : ''}
      ${ports ? `<div class="text-xs"><strong>Ports:</strong> ${ports}</div>` : ''}
      ${vols ? `<div class="text-xs"><strong>Volumes:</strong> ${vols}</div>` : ''}
    </div>`;
    const m = showModal(t.title || 'App', body, [{ label: 'Close', className: 'btn btn-secondary' }]);
    const dep = document.createElement('button');
    dep.className = 'btn btn-primary'; dep.innerHTML = `${Icons.play} Deploy`;
    m.overlay.querySelector('#modal-footer').appendChild(dep);
    dep.addEventListener('click', () => { m.close(); deploy(t); });
    // Docker Hub popularity (proxied server-side, cached). Non-Hub images → just hide the line.
    if (t.image) {
      API.get(`/templates/hubstats?image=${encodeURIComponent(t.image)}`).then(s => {
        const el = m.overlay.querySelector('#tpl-hub'); if (!el) return;
        if (s && s.available) el.innerHTML = `⭐ Docker Hub: <strong>${fmtNum(s.pulls)}</strong> pulls · <strong>${fmtNum(s.stars)}</strong> stars${s.url ? ` · <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">view</a>` : ''}`;
        else el.style.display = 'none';
      }).catch(() => { const el = m.overlay.querySelector('#tpl-hub'); if (el) el.style.display = 'none'; });
    } else { const el = m.overlay.querySelector('#tpl-hub'); if (el) el.style.display = 'none'; }
  }

  function applyFilters() {
    const q = (document.getElementById('tpl-search')?.value || '').trim().toLowerCase();
    const cat = document.getElementById('tpl-cat')?.value || '';
    const grid = document.getElementById('tpl-grid');
    const empty = document.getElementById('tpl-empty');
    if (!grid) return;
    const filtered = all
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => {
        if (cat && !(t.categories || []).includes(cat)) return false;
        if (q) {
          const hay = `${t.title || ''} ${t.description || ''} ${t.image || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    grid.innerHTML = filtered.map(({ t, idx }) => cardHtml(t, idx)).join('');
    if (empty) empty.style.display = filtered.length ? 'none' : 'block';
  }

  // Well-known Portainer-format catalogs (verified). The community list aggregates 500+ apps,
  // overlapping heavily with the services Portainer and Coolify offer.
  const PRESETS = [
    { label: 'Community 500+ (default)', url: '' },
    { label: 'Portainer Official', url: 'https://raw.githubusercontent.com/portainer/templates/v3/templates.json' },
    { label: 'Bundled (offline only)', url: 'bundled' },
  ];

  // Configure the catalog source (template_url) in a small modal.
  async function openSourceModal() {
    let current = '';
    try { current = (await API.get('/meta/settings')).template_url || ''; } catch (e) {}
    const body = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="text-sm text-muted">Pick a catalog or paste any Portainer-format <code>templates.json</code> URL. <strong>Blank = the default community catalog (500+ apps)</strong> — loads automatically. Choose <em>Bundled</em> to force the offline ~15 set.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${PRESETS.map(p => `<button type="button" class="btn btn-xs btn-secondary" data-preset="${escapeHtml(p.url)}">${escapeHtml(p.label)}</button>`).join('')}
        </div>
        <input class="input" id="tpl-url" placeholder="https://.../templates.json" value="${escapeHtml(current)}">
      </div>`;
    const m = showModal('Template source', body, []);
    const root = m.overlay;
    // Preset buttons fill the input (user then clicks Save & reload)
    root.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      root.querySelector('#tpl-url').value = b.dataset.preset;
    }));
    const footer = root.querySelector('#modal-footer');
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = 'Save & reload';
    footer.appendChild(save);
    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = 'Saving…';
      try {
        await API.post('/meta/settings', { template_url: root.querySelector('#tpl-url').value.trim() });
        m.close();
        await load();
      } catch (e) {
        showToast(e.message, 'error'); save.disabled = false; save.textContent = 'Save & reload';
      }
    });
  }

  async function load() {
    try {
      const data = await API.get('/templates');
      all = Array.isArray(data.templates) ? data.templates : [];
      source = data.source || '';
      render(data);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:40px"><h3>Failed to load templates</h3><div class="text-muted">${escapeHtml(err.message)}</div></div>`;
    }
  }

  function render(data) {
    const cats = [...new Set(all.flatMap(t => t.categories || []))].sort();
    const srcLabel = source === 'remote' ? `remote (${all.length})`
      : source === 'bundled-fallback' ? `bundled — remote failed: ${escapeHtml(data.error || '')}`
      : `bundled (${all.length})`;
    content.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">App Templates</div>
          <div class="page-subtitle">Deploy ready-made apps — source: ${srcLabel}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="tpl-source">${Icons.settings} Source</button>
          <button class="btn btn-secondary" id="tpl-refresh">${Icons.refresh} Refresh</button>
        </div>
      </div>

      <div class="filter-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <div class="search-input" style="flex:1;min-width:200px">${Icons.search}<input id="tpl-search" placeholder="Search templates…"></div>
        <div class="select-wrapper"><select class="select" id="tpl-cat"><option value="">All categories</option>${cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select></div>
      </div>

      <div id="tpl-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px"></div>
      <div id="tpl-empty" class="empty-state" style="padding:40px;display:none">No templates match.</div>
    `;

    document.getElementById('tpl-refresh')?.addEventListener('click', load);
    document.getElementById('tpl-source')?.addEventListener('click', openSourceModal);
    document.getElementById('tpl-search')?.addEventListener('input', applyFilters);
    document.getElementById('tpl-cat')?.addEventListener('change', applyFilters);
    document.getElementById('tpl-grid')?.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-deploysw]');
      if (sw) {
        const t = all[parseInt(sw.dataset.deploysw, 10)];
        if (t) deployToSwarm(t);
        return;
      }
      const btn = e.target.closest('[data-deploy]');
      if (btn) { const t = all[parseInt(btn.dataset.deploy, 10)]; if (t) deploy(t); return; }
      // Anywhere else on the card → open the app detail view.
      const card = e.target.closest('[data-tpldetail]');
      if (card) { const t = all[parseInt(card.dataset.tpldetail, 10)]; if (t) openTemplateDetail(t); }
    });

    applyFilters();

    // Swarm manager aktivdirsə stack kartlarında "Swarm" düyməsini göstər (grid yenidən render olunur)
    API.get('/swarm').then(s => {
      if (s && s.active && s.isManager && !swarmOk) { swarmOk = true; applyFilters(); }
    }).catch(() => {});
  }

  await load();
});
