// Shared Compose editor — YAML editor (2A) + guided "add service" builder (2B, row-based).
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

  // Existing volumes + local images power the guided panel's datalists (best-effort).
  let volumes = [], imagesList = [];
  try { [volumes, imagesList] = await Promise.all([API.get('/volumes').catch(() => []), API.get('/images').catch(() => [])]); } catch (e) {}
  const volOpts = (volumes || []).map(v => v.name).filter(Boolean);
  const imageOpts = (imagesList || []).map(i => (i.repoTags && i.repoTags[0] !== '<none>:<none>') ? i.repoTags[0] : null).filter(Boolean);

  const ph = 'services:\n  web:\n    image: nginx:alpine\n    restart: unless-stopped\n    ports:\n      - "8080:80"';

  // Repeatable rows (mirror the Run modal's guided UX).
  const row = (cells) => `<div class="gs-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">${cells}<button type="button" class="btn-icon gs-row-del" title="Remove" style="color:var(--danger)">${Icons.trash}</button></div>`;
  const portRow = () => row(`<input class="input gs-p-host" placeholder="host (e.g. 8080)" style="flex:1"><span>:</span><input class="input gs-p-cont" placeholder="container (e.g. 80)" style="flex:1">`);
  const volRow = () => row(`<input class="input gs-v-host" list="gs-vol-list" placeholder="host path or volume" style="flex:2"><span>:</span><input class="input gs-v-cont" placeholder="container path" style="flex:2"><select class="select gs-v-mode" style="width:72px"><option value="rw">rw</option><option value="ro">ro</option></select>`);
  const envRow = () => row(`<input class="input gs-e-key" list="gs-env-keys" placeholder="KEY" style="flex:1"><span>=</span><input class="input gs-e-val" placeholder="value" style="flex:2">`);

  const body = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Project name *</label>
        <input class="input" id="cmp-name" placeholder="my-stack" value="${escapeHtml(prefillName)}" ${existing ? 'readonly' : ''}>
        <span class="text-xs text-muted">Private images (e.g. <code>ghcr.io/...</code>) pull automatically if you've added the registry under <strong>Registries</strong> — no <code>docker login</code> needed.</span></div>
      <details class="card" style="padding:8px 12px">
        <summary style="cursor:pointer;font-weight:600">+ Add a service (guided)</summary>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
          <input class="input" id="gs-name" placeholder="service name (e.g. web)">
          <input class="input" id="gs-image" list="gs-image-list" placeholder="image (e.g. nginx:alpine)">

          <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><label style="font-weight:600;font-size:12px">Ports</label><button type="button" class="btn btn-xs btn-secondary" id="gs-add-port">+ Port</button></div><div id="gs-ports"></div></div>

          <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:4px;flex-wrap:wrap"><label style="font-weight:600;font-size:12px">Volumes</label><div style="display:flex;gap:4px;flex-wrap:wrap">
            <button type="button" class="btn btn-xs btn-secondary" data-gsvolp="/var/run/docker.sock|/var/run/docker.sock|ro">+ sock</button>
            <button type="button" class="btn btn-xs btn-secondary" data-gsvolp="./data|/data|rw">+ ./data</button>
            <button type="button" class="btn btn-xs btn-secondary" data-gsvolp="./config|/config|rw">+ ./config</button>
            <button type="button" class="btn btn-xs btn-secondary" id="gs-add-vol">+ Vol</button>
          </div></div><div id="gs-vols"></div></div>

          <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:4px;flex-wrap:wrap"><label style="font-weight:600;font-size:12px">Environment</label><div style="display:flex;gap:4px">
            <button type="button" class="btn btn-xs btn-secondary" id="gs-paste-env">${Icons.copy} Paste .env</button>
            <button type="button" class="btn btn-xs btn-secondary" id="gs-add-env">+ Env</button>
          </div></div>
          <div id="gs-env-paste-wrap" style="display:none;margin-bottom:6px">
            <textarea class="input" id="gs-env-paste" placeholder="Paste a .env — one KEY=VALUE per line" style="width:100%;min-height:70px;font-family:var(--font-mono);font-size:12px"></textarea>
            <div style="margin-top:4px;display:flex;gap:6px"><button type="button" class="btn btn-xs btn-primary" id="gs-env-import">Import ↓</button><button type="button" class="btn btn-xs btn-secondary" id="gs-env-cancel">Cancel</button></div>
          </div>
          <div id="gs-envs"></div>

          <button class="btn btn-sm btn-secondary" id="gs-add" type="button">Append service to YAML ↓</button>
          <datalist id="gs-vol-list">${volOpts.map(o => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
          <datalist id="gs-image-list">${imageOpts.map(o => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
          <datalist id="gs-env-keys"></datalist>
        </div>
      </details>
      <div class="input-group"><label>docker-compose.yml</label>
        <textarea id="cmp-yaml" class="input" spellcheck="false" style="font-family:var(--font-mono);min-height:260px;white-space:pre;overflow:auto" placeholder="${escapeHtml(ph)}">${escapeHtml(yaml)}</textarea></div>
    </div>`;
  const title = existing ? `Edit Compose: ${existing}` : (opts.prefillName ? `Deploy template: ${opts.prefillName}` : 'New Compose Project');
  const m = showModal(title, body, []);
  const root = m.overlay;
  const ta = root.querySelector('#cmp-yaml');

  // Submit lives in the sticky modal footer so it's always visible.
  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.id = 'cmp-submit';
  submitBtn.textContent = existing ? 'Save & Up' : 'Create & Up';
  root.querySelector('#modal-footer').appendChild(submitBtn);

  // Cross-module: eyni compose YAML SWARM STACK kimi də deploy oluna bilər (docker stack deploy,
  // yalnız lokal manager). Düymə yalnız aktiv daemon swarm manager olduqda görünür.
  API.get('/swarm').then(s => {
    if (!s || !s.active || !s.isManager) return;
    const stkBtn = document.createElement('button');
    stkBtn.className = 'btn btn-secondary';
    stkBtn.textContent = 'Deploy as Stack (Swarm)';
    root.querySelector('#modal-footer').prepend(stkBtn);
    stkBtn.addEventListener('click', async () => {
      const project = root.querySelector('#cmp-name').value.trim() || existing || '';
      const yamlVal = ta.value;
      if (!project) { showToast('Project/stack name is required', 'warning'); return; }
      if (!yamlVal.trim()) { showToast('Compose YAML is required', 'warning'); return; }
      stkBtn.disabled = true; stkBtn.textContent = 'Deploying…';
      try {
        await API.post('/swarm/stacks/deploy', { name: project, compose: yamlVal });
        showToast(`Stack "${project}" deployed`);
        m.close();
        Router.navigate('swarm');
      } catch (err) {
        showToast(err.message, 'error', 10000);
        stkBtn.disabled = false; stkBtn.textContent = 'Deploy as Stack (Swarm)';
      }
    });
  }).catch(() => {});

  // Repeatable-row machinery (addRow can prefill the new row's inputs).
  const addRow = (listId, builder, fill) => {
    const list = root.querySelector('#' + listId);
    const wrap = document.createElement('div');
    wrap.innerHTML = builder();
    const el = wrap.firstElementChild;
    el.querySelector('.gs-row-del')?.addEventListener('click', () => el.remove());
    if (fill) fill(el);
    list.appendChild(el);
    return el;
  };
  const wire = (btnId, listId, builder) => root.querySelector('#' + btnId)?.addEventListener('click', () => addRow(listId, builder));
  wire('gs-add-port', 'gs-ports', portRow);
  wire('gs-add-vol', 'gs-vols', volRow);
  wire('gs-add-env', 'gs-envs', envRow);

  // Volume presets → prefilled volume row
  root.querySelectorAll('[data-gsvolp]').forEach(b => b.addEventListener('click', () => {
    const [h, c, mode] = b.dataset.gsvolp.split('|');
    addRow('gs-vols', volRow, el => {
      el.querySelector('.gs-v-host').value = h;
      el.querySelector('.gs-v-cont').value = c;
      if (mode) el.querySelector('.gs-v-mode').value = mode;
    });
  }));

  // Paste .env → bulk env rows
  const pasteWrap = root.querySelector('#gs-env-paste-wrap');
  root.querySelector('#gs-paste-env')?.addEventListener('click', () => {
    const open = pasteWrap.style.display === 'none';
    pasteWrap.style.display = open ? 'block' : 'none';
    if (open) root.querySelector('#gs-env-paste').focus();
  });
  root.querySelector('#gs-env-cancel')?.addEventListener('click', () => { pasteWrap.style.display = 'none'; });
  root.querySelector('#gs-env-import')?.addEventListener('click', () => {
    const pairs = parseDotEnv(root.querySelector('#gs-env-paste').value);
    pairs.forEach(pr => addRow('gs-envs', envRow, el => {
      el.querySelector('.gs-e-key').value = pr.key;
      el.querySelector('.gs-e-val').value = pr.val;
    }));
    root.querySelector('#gs-env-paste').value = '';
    pasteWrap.style.display = 'none';
    showToast(pairs.length ? `${pairs.length} variable(s) imported` : 'No KEY=VALUE lines found', pairs.length ? 'success' : 'warning');
  });

  // Suggest env keys from the chosen (local) image
  const localShortId = (name) => { const img = (imagesList || []).find(i => (i.repoTags || []).includes(name)); return img ? img.shortId : null; };
  async function loadGsEnvKeys(name) {
    const dl = root.querySelector('#gs-env-keys');
    const id = localShortId((name || '').trim());
    if (!id) { dl.innerHTML = ''; return; }
    try {
      const info = await API.get('/images/' + encodeURIComponent(id));
      const keys = (info?.Config?.Env || []).map(e => String(e).split('=')[0]).filter(Boolean);
      dl.innerHTML = keys.map(k => `<option value="${escapeHtml(k)}">`).join('');
    } catch (e) { dl.innerHTML = ''; }
  }
  let gsImgTimer = null;
  root.querySelector('#gs-image').addEventListener('input', () => {
    clearTimeout(gsImgTimer);
    gsImgTimer = setTimeout(() => loadGsEnvKeys(root.querySelector('#gs-image').value), 400);
  });

  // Build a service block from the rows and append it to the YAML.
  root.querySelector('#gs-add')?.addEventListener('click', () => {
    const name = root.querySelector('#gs-name').value.trim();
    const image = root.querySelector('#gs-image').value.trim();
    if (!name || !image) { showToast('Service name and image are required', 'warning'); return; }
    const ports = [...root.querySelectorAll('#gs-ports .gs-row')].map(r => {
      const h = r.querySelector('.gs-p-host').value.trim(), c = r.querySelector('.gs-p-cont').value.trim();
      return c ? (h ? `${h}:${c}` : c) : null;
    }).filter(Boolean);
    const vols = [...root.querySelectorAll('#gs-vols .gs-row')].map(r => {
      const h = r.querySelector('.gs-v-host').value.trim(), c = r.querySelector('.gs-v-cont').value.trim(), mode = r.querySelector('.gs-v-mode').value;
      if (!h || !c) return null;
      return mode === 'ro' ? `${h}:${c}:ro` : `${h}:${c}`;
    }).filter(Boolean);
    const env = [...root.querySelectorAll('#gs-envs .gs-row')].map(r => {
      const k = r.querySelector('.gs-e-key').value.trim(), v = r.querySelector('.gs-e-val').value;
      return k ? `${k}=${v}` : null;
    }).filter(Boolean);

    let block = `  ${name}:\n    image: ${image}\n    restart: unless-stopped\n`;
    if (ports.length) block += '    ports:\n' + ports.map(p => `      - "${p}"`).join('\n') + '\n';
    if (vols.length) block += '    volumes:\n' + vols.map(v => `      - "${v}"`).join('\n') + '\n';
    if (env.length) block += '    environment:\n' + env.map(e => `      - ${e}`).join('\n') + '\n';
    let cur = ta.value.replace(/\s+$/, '');
    if (!/^services:/m.test(cur)) cur = (cur ? cur + '\n' : '') + 'services:';
    ta.value = cur + '\n' + block;

    // reset the guided panel for the next service
    root.querySelector('#gs-name').value = '';
    root.querySelector('#gs-image').value = '';
    ['gs-ports', 'gs-vols', 'gs-envs'].forEach(id => { root.querySelector('#' + id).innerHTML = ''; });
    root.querySelector('#gs-env-keys').innerHTML = '';
  });

  submitBtn.addEventListener('click', async () => {
    const project = root.querySelector('#cmp-name').value.trim();
    const yamlVal = ta.value;
    if (!project) { showToast('Project name is required', 'warning'); return; }
    if (!yamlVal.trim()) { showToast('Compose YAML is required', 'warning'); return; }
    submitBtn.disabled = true; submitBtn.textContent = 'Working...';
    try {
      if (existing) await API.put(`/compose/${encodeURIComponent(existing)}/file`, { yaml: yamlVal, up: true });
      else await API.post('/compose/create', { project, yaml: yamlVal, up: true });
      showToast(`Compose project ${existing ? 'updated' : 'created'} & started`);
      m.close();
      Router.navigate('compose'); // re-render the Compose page (works whether we came from Compose or Templates)
    } catch (err) {
      showToast(err.message, 'error', 9000);
      submitBtn.disabled = false; submitBtn.textContent = existing ? 'Save & Up' : 'Create & Up';
    }
  });
}
