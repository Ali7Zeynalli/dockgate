// ⌘K / Ctrl+K search — one window that finds containers, images, volumes, networks and stacks on the
// server in use, every server, every page and the common actions. Opens from the shortcut or the header
// search box; ↑ ↓ choose, Enter opens, Esc closes. Docker lists are read when the window opens (cached 30 s).
(function () {
  let cache = null, cacheAt = 0, cacheServer = null;
  let overlay = null, items = [], sel = 0;

  // After navigating, click an element once the page has drawn it (e.g. "Add server" opens the wizard).
  function navigateThenClick(path, params, selector, tries = 40) {
    Router.navigate(path, params);
    const t = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) { clearInterval(t); el.click(); } else if (--tries <= 0) clearInterval(t);
    }, 100);
  }
  function navigateThenSearch(path, params, inputSel, q, tries = 40) {
    Router.navigate(path, params);
    const t = setInterval(() => {
      const el = document.querySelector(inputSel);
      if (el) { clearInterval(t); el.value = q; el.dispatchEvent(new Event('input')); } else if (--tries <= 0) clearInterval(t);
    }, 100);
  }

  function staticItems() {
    const out = [];
    const active = Store.get('activeServer') || {};
    const remote = active.id && active.id !== 'local' && active.type !== 'local';
    for (const [key, item] of Object.entries(typeof navItems !== 'undefined' ? navItems : {})) {
      if (key === 'server-console') {
        if (!remote) continue;
        for (const [tab, label] of item.tabs) out.push({ group: 'Pages', name: label, hint: `Server Console · ${active.name || active.id}`, run: () => Router.navigate('server-console', { id: active.id, tab }) });
        continue;
      }
      if (item.tabs) for (const [tab, label] of item.tabs) out.push({ group: 'Pages', name: label, hint: item.label, run: () => Router.navigate(key, { tab }) });
      else out.push({ group: 'Pages', name: item.label, hint: '', run: () => Router.navigate(key) });
    }
    out.push(
      { group: 'Actions', name: 'Run container', hint: 'Resources', run: () => typeof openRunContainerModal === 'function' ? openRunContainerModal() : navigateThenClick('resources', { tab: 'containers' }, '#run-container-btn') },
      { group: 'Actions', name: 'Deploy stack', hint: 'Deploy', run: () => navigateThenClick('deploy', { tab: 'compose' }, '#compose-deploy-wizard') },
      { group: 'Actions', name: 'Pull image', hint: 'Images', run: () => navigateThenClick('resources', { tab: 'images' }, '#pull-image-btn') },
      { group: 'Actions', name: 'Prune unused data', hint: 'Resources', run: () => Router.navigate('resources', { tab: 'prune' }) },
      { group: 'Actions', name: 'Add server', hint: 'Servers', run: () => navigateThenClick('infra', { tab: 'servers' }, '[data-add]') },
      { group: 'Actions', name: 'Open quick terminal', hint: 'Ctrl+`', run: () => document.getElementById('btn-quick-terminal')?.click() },
    );
    return out;
  }

  async function dockerItems() {
    const active = (Store.get('activeServer') || {}).id || 'local';
    if (cache && cacheServer === active && Date.now() - cacheAt < 30000) return cache;
    const get = (u) => API.get(u).catch(() => null);
    const [ctrs, imgs, vols, nets, stacks, srv] = await Promise.all([get('/containers'), get('/images'), get('/volumes'), get('/networks'), get('/compose'), get('/servers')]);
    const out = [];
    for (const c of ctrs || []) out.push({ group: 'Containers', name: c.name, hint: `${c.state}${/\(unhealthy\)/i.test(c.status || '') ? ' · unhealthy' : ''}${c.composeProject ? ' · ' + c.composeProject : ''} · ${c.image}`, run: () => Router.navigate('container-detail', { id: c.id }) });
    for (const i of imgs || []) { const tag = (i.repoTags || [])[0] || i.shortId; out.push({ group: 'Images', name: tag === '<none>:<none>' ? i.shortId : tag, hint: `${formatBytes(i.size)}${i.inUse ? '' : ' · unused'}`, run: () => navigateThenSearch('resources', { tab: 'images' }, '#image-search', tag === '<none>:<none>' ? i.shortId : tag) }); }
    for (const v of vols || []) out.push({ group: 'Volumes', name: v.name, hint: v.inUse ? `used by ${(v.containerNames || []).join(', ')}` : 'unused', run: () => Router.navigate('resources', { tab: 'volumes' }) });
    for (const n of nets || []) out.push({ group: 'Networks', name: n.name, hint: `${n.driver}${n.subnet ? ' · ' + n.subnet : ''}`, run: () => Router.navigate('resources', { tab: 'networks' }) });
    for (const p of stacks || []) out.push({ group: 'Stacks', name: p.name, hint: `${p.running}/${p.total} running`, run: () => Router.navigate('deploy', { tab: 'compose' }) });
    for (const s of (srv && srv.servers) || []) {
      const local = s.id === 'local' || s.type === 'local';
      out.push({ group: 'Servers', name: local ? 'Local' : (s.name || s.id), hint: `${local ? 'this machine' : s.host || ''}${s.isActive ? ' · in use' : ''}`, run: () => local ? useServer('local').then(ok => ok && Router.navigate('dashboard')) : Router.navigate('server-console', { id: s.id }) });
    }
    cache = out; cacheAt = Date.now(); cacheServer = active;
    return out;
  }

  const ORDER = ['Containers', 'Stacks', 'Images', 'Volumes', 'Networks', 'Servers', 'Pages', 'Actions'];
  function score(it, q) {
    if (!q) return it.group === 'Pages' || it.group === 'Actions' ? 1 : 0;
    const n = it.name.toLowerCase(), h = (it.hint || '').toLowerCase();
    if (n === q) return 100; if (n.startsWith(q)) return 80; if (n.includes(q)) return 60; if (h.includes(q)) return 20;
    return 0;
  }
  function render(all) {
    const q = overlay.querySelector('#cmdk-q').value.trim().toLowerCase();
    const scored = all.map(it => ({ it, s: score(it, q) })).filter(x => x.s > 0);
    // Groups stay together; the group with the best match comes first (a name match beats a hint match).
    const best = {}; for (const x of scored) best[x.it.group] = Math.max(best[x.it.group] || 0, x.s);
    items = scored
      .sort((a, b) => (q ? best[b.it.group] - best[a.it.group] : 0) || ORDER.indexOf(a.it.group) - ORDER.indexOf(b.it.group) || b.s - a.s)
      .reduce((acc, x) => { const n = acc.filter(y => y.group === x.it.group).length; if (n < (q ? 6 : 8)) acc.push(x.it); return acc; }, []);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    const re = q ? new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i') : null;
    let g = '';
    overlay.querySelector('#cmdk-list').innerHTML = items.length ? items.map((it, i) => {
      const head = it.group !== g ? `<div class="cmdk-g">${it.group}</div>` : ''; g = it.group;
      const name = escapeHtml(it.name); return `${head}<div class="cmdk-it${i === sel ? ' on' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}"><span>${re ? name.replace(re, '<b>$1</b>') : name}</span><span class="cmdk-hint">${escapeHtml(it.hint || '')}</span></div>`;
    }).join('') : `<div class="cmdk-empty">Nothing matches. Try a container, image, server or page name.</div>`;
    overlay.querySelector('.cmdk-it.on')?.scrollIntoView({ block: 'nearest' });
  }

  async function open(initial = '') {
    if (overlay) { overlay.querySelector('#cmdk-q').focus(); return; }
    overlay = document.createElement('div');
    overlay.className = 'cmdk-overlay';
    overlay.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="Search DockGate">
      <input id="cmdk-q" type="text" autocomplete="off" spellcheck="false" placeholder="Search containers, images, stacks, servers, pages…" aria-label="Search" value="${escapeHtml(initial)}">
      <div id="cmdk-list" class="cmdk-list" role="listbox"><div class="cmdk-empty">Loading…</div></div>
      <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span>Server in use: ${escapeHtml((Store.get('activeServer') || {}).name || (Store.get('activeServer') || {}).id || 'local')}</span></div>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#cmdk-q');
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    let all = staticItems();
    sel = 0; render(all);
    dockerItems().then(d => { if (!overlay) return; all = [...d, ...staticItems()]; render(all); });
    input.addEventListener('input', () => { sel = 0; render(all); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(all); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(all); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cmdk-list').addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) choose(Number(it.dataset.i)); });
  }
  function choose(i) { const it = items[i]; if (!it) return; close(); try { it.run(); } catch (e) { showToast(e.message, 'error'); } }
  function close() { if (overlay) { overlay.remove(); overlay = null; } }

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); overlay ? close() : open(); }
  });
  // The header box is the visible entry point: focusing or typing in it opens the window.
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('search-input');
    if (!box) return;
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    box.placeholder = `Search or jump to…  ${isMac ? '⌘K' : 'Ctrl K'}`;
    box.setAttribute('readonly', '');
    box.addEventListener('focus', () => { box.blur(); open(); });
    document.getElementById('global-search')?.addEventListener('click', () => open());
  });
  window.openCommandPalette = open;
})();
