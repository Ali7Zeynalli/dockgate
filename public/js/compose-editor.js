// Shared Compose editor — YAML editor (2A) + guided "add service" builder (2B).
// Used by the Compose page (New Project / Edit YAML) and the Templates page (deploy a stack template).
// Global so any page can open it; on success it re-renders the Compose page via the router.
//
// @param {string|null} existing  an existing managed project name → edit mode (name readonly, YAML fetched)
// @param {object} [opts]         { prefillYaml, prefillName } — used when deploying a template (new project)
async function openComposeEditor(existing, opts = {}) {
  let yaml = '';
  if (existing) {
    try { const f = await API.get(`/compose/${existing}/file`); yaml = f.yaml || ''; }
    catch (e) { showToast('Not a DockGate-managed project — paste its YAML to adopt it', 'info', 7000); }
  } else if (opts.prefillYaml) {
    yaml = opts.prefillYaml; // deploying a stack template into a new project
  }
  const prefillName = existing || opts.prefillName || '';
  const ph = 'services:\n  web:\n    image: nginx:alpine\n    restart: unless-stopped\n    ports:\n      - "8080:80"';
  const body = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Project name *</label>
        <input class="input" id="cmp-name" placeholder="my-stack" value="${escapeHtml(prefillName)}" ${existing ? 'readonly' : ''}></div>
      <details class="card" style="padding:8px 12px">
        <summary style="cursor:pointer;font-weight:600">+ Add a service (guided)</summary>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
          <input class="input" id="gs-name" placeholder="service name (e.g. web)">
          <input class="input" id="gs-image" placeholder="image (e.g. nginx:alpine)">
          <input class="input" id="gs-ports" placeholder='ports, comma-separated (e.g. 8080:80, 443:443)'>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button type="button" class="btn btn-xs btn-secondary" data-gsvol="/var/run/docker.sock:/var/run/docker.sock:ro">+ docker.sock</button>
            <button type="button" class="btn btn-xs btn-secondary" data-gsvol="./data:/data">+ ./data</button>
            <button type="button" class="btn btn-xs btn-secondary" data-gsvol="./config:/config">+ ./config</button>
          </div>
          <input class="input" id="gs-vols" placeholder='volumes, comma-separated (e.g. ./data:/data)'>
          <div style="display:flex;align-items:center;gap:6px"><span style="flex:1;font-size:12px;color:var(--text-secondary)">env</span><button type="button" class="btn btn-xs btn-secondary" id="gs-paste-env">Paste .env</button></div>
          <textarea class="input" id="gs-env-paste" placeholder="Paste a .env (KEY=VALUE per line), then click Paste .env again to import" style="display:none;min-height:70px;font-family:var(--font-mono);font-size:12px"></textarea>
          <input class="input" id="gs-env" placeholder='env, comma-separated (e.g. KEY=val, FOO=bar)'>
          <button class="btn btn-sm btn-secondary" id="gs-add" type="button">Append service to YAML ↓</button>
        </div>
      </details>
      <div class="input-group"><label>docker-compose.yml</label>
        <textarea id="cmp-yaml" class="input" spellcheck="false" style="font-family:var(--font-mono);min-height:300px;white-space:pre;overflow:auto" placeholder="${escapeHtml(ph)}">${escapeHtml(yaml)}</textarea></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-primary" id="cmp-submit">${existing ? 'Save & Up' : 'Create & Up'}</button>
      </div>
    </div>`;
  const title = existing ? `Edit Compose: ${existing}` : (opts.prefillName ? `Deploy template: ${opts.prefillName}` : 'New Compose Project');
  const m = showModal(title, body, []);
  const root = m.overlay;
  const ta = root.querySelector('#cmp-yaml');

  // 2B — generate a service block from the guided inputs and append it to the YAML
  root.querySelector('#gs-add')?.addEventListener('click', () => {
    const name = root.querySelector('#gs-name').value.trim();
    const image = root.querySelector('#gs-image').value.trim();
    if (!name || !image) { showToast('Service name and image are required', 'warning'); return; }
    const list = (id) => root.querySelector('#' + id).value.split(',').map(s => s.trim()).filter(Boolean);
    const ports = list('gs-ports'), vols = list('gs-vols'), env = list('gs-env');
    let block = `  ${name}:\n    image: ${image}\n    restart: unless-stopped\n`;
    if (ports.length) block += '    ports:\n' + ports.map(p => `      - "${p}"`).join('\n') + '\n';
    if (vols.length) block += '    volumes:\n' + vols.map(v => `      - "${v}"`).join('\n') + '\n';
    if (env.length) block += '    environment:\n' + env.map(e => `      - ${e}`).join('\n') + '\n';
    let cur = ta.value.replace(/\s+$/, '');
    if (!/^services:/m.test(cur)) cur = (cur ? cur + '\n' : '') + 'services:';
    ta.value = cur + '\n' + block;
    ['gs-name', 'gs-image', 'gs-ports', 'gs-vols', 'gs-env'].forEach(id => { root.querySelector('#' + id).value = ''; });
  });

  // Volume presets append to the comma-separated volumes field
  root.querySelectorAll('[data-gsvol]').forEach(b => b.addEventListener('click', () => {
    const f = root.querySelector('#gs-vols');
    f.value = f.value.trim() ? f.value.replace(/,\s*$/, '') + ', ' + b.dataset.gsvol : b.dataset.gsvol;
  }));
  // Paste .env: first click reveals the textarea, second click imports its KEY=VALUE lines into the env field
  const gsPaste = root.querySelector('#gs-env-paste');
  root.querySelector('#gs-paste-env')?.addEventListener('click', () => {
    if (gsPaste.style.display === 'none') { gsPaste.style.display = 'block'; gsPaste.focus(); return; }
    const pairs = parseDotEnv(gsPaste.value);
    if (pairs.length) {
      const ef = root.querySelector('#gs-env');
      const joined = pairs.map(p => `${p.key}=${p.val}`).join(', ');
      ef.value = ef.value.trim() ? ef.value.replace(/,\s*$/, '') + ', ' + joined : joined;
      showToast(`${pairs.length} variable(s) added`);
    }
    gsPaste.value = ''; gsPaste.style.display = 'none';
  });

  root.querySelector('#cmp-submit')?.addEventListener('click', async () => {
    const project = root.querySelector('#cmp-name').value.trim();
    const yamlVal = ta.value;
    if (!project) { showToast('Project name is required', 'warning'); return; }
    if (!yamlVal.trim()) { showToast('Compose YAML is required', 'warning'); return; }
    const btn = root.querySelector('#cmp-submit');
    btn.disabled = true; btn.textContent = 'Working...';
    try {
      if (existing) await API.put(`/compose/${encodeURIComponent(existing)}/file`, { yaml: yamlVal, up: true });
      else await API.post('/compose/create', { project, yaml: yamlVal, up: true });
      showToast(`Compose project ${existing ? 'updated' : 'created'} & started`);
      m.close();
      Router.navigate('compose'); // re-render the Compose page (works whether we came from Compose or Templates)
    } catch (err) {
      showToast(err.message, 'error', 9000);
      btn.disabled = false; btn.textContent = existing ? 'Save & Up' : 'Create & Up';
    }
  });
}
