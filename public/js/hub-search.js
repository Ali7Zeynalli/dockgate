// Shared Docker Hub image search modal. Searches hub.docker.com via the backend proxy
// (GET /api/images/search) and calls onPick(imageName) when a result is selected.
// Used by the Run Container modal and the Images "Pull Image" modal.
// @param {(name:string)=>void} onPick  receives the chosen repository name (e.g. "nginx" or "user/repo")
function openHubSearch(onPick) {
  const body = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="input" id="hub-q" placeholder="Search Docker Hub… (e.g. nginx, postgres, grafana)" autocomplete="off" style="width:100%">
      <div id="hub-results" style="max-height:50vh;overflow:auto;display:flex;flex-direction:column;gap:4px">
        <div class="text-muted text-sm" style="padding:8px">Type to search Docker Hub.</div>
      </div>
    </div>`;
  const m = showModal('Search Docker Hub', body, []);
  const root = m.overlay;
  const q = root.querySelector('#hub-q');
  const list = root.querySelector('#hub-results');
  let timer = null;

  async function run() {
    const term = q.value.trim();
    if (!term) { list.innerHTML = '<div class="text-muted text-sm" style="padding:8px">Type to search Docker Hub.</div>'; return; }
    list.innerHTML = '<div class="text-muted text-sm" style="padding:8px">Searching…</div>';
    try {
      const data = await API.get('/images/search?q=' + encodeURIComponent(term));
      const results = data.results || [];
      if (!results.length) { list.innerHTML = '<div class="text-muted text-sm" style="padding:8px">No results.</div>'; return; }
      list.innerHTML = results.map(r => `
        <div class="hub-item" data-img="${escapeHtml(r.name)}" style="padding:8px;border:1px solid var(--border);border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:center">
          <div style="min-width:0">
            <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)} ${r.official ? '<span class="badge badge-running" style="font-size:10px">official</span>' : ''}</div>
            <div class="text-xs text-muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.description || '')}</div>
          </div>
          <div class="text-xs text-muted" style="white-space:nowrap">★ ${r.stars}</div>
        </div>`).join('');
    } catch (e) {
      list.innerHTML = `<div class="text-danger text-sm" style="padding:8px">${escapeHtml(e.message)}</div>`;
    }
  }

  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.hub-item');
    if (!item) return;
    onPick(item.dataset.img);
    m.close();
  });
  setTimeout(() => q.focus(), 50);
}
