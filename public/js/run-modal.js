// Shared "Run Container" guided form — used by the Images page (per-image) and the
// Containers page (header button). Pulls (optionally) → creates → starts via POST /containers/run.
async function openRunContainerModal(prefill = '') {
  // Accept either an image string (Images/Containers buttons) or a full prefill object from a
  // template: { image, name, ports:[{host,container,proto}], volumes:[{host,container,mode}], env:[{key,val}], pull }.
  const p = (typeof prefill === 'string') ? { image: prefill } : (prefill || {});
  const prefillImage = p.image || '';
  let images = [];
  let networks = [];
  let volumes = [];
  try {
    [images, networks, volumes] = await Promise.all([
      API.get('/images').catch(() => []),
      API.get('/networks').catch(() => []),
      API.get('/volumes').catch(() => []),
    ]);
  } catch (e) { /* dropdowns just fall back to free text / defaults */ }

  const imageOpts = (images || [])
    .map(i => (i.repoTags && i.repoTags[0] !== '<none>:<none>') ? i.repoTags[0] : null)
    .filter(Boolean);
  const netOpts = (networks || []).map(n => n.name);
  const volOpts = (volumes || []).map(v => v.name).filter(Boolean); // existing named volumes for the host datalist

  const row = (cells) => `<div class="run-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">${cells}<button type="button" class="btn-icon run-row-del" title="Remove" style="color:var(--danger)">${Icons.trash}</button></div>`;
  const portRow = () => row(`<input class="input run-p-host" placeholder="host (e.g. 8080)" style="flex:1"><span>:</span><input class="input run-p-cont" placeholder="container (e.g. 80)" style="flex:1"><select class="select run-p-proto" style="width:80px"><option value="tcp">tcp</option><option value="udp">udp</option></select>`);
  const volRow = () => row(`<input class="input run-v-host" list="run-vol-list" placeholder="host path or volume name" style="flex:2"><span>:</span><input class="input run-v-cont" placeholder="container path" style="flex:2"><select class="select run-v-mode" style="width:80px"><option value="rw">rw</option><option value="ro">ro</option></select>`);
  const envRow = () => row(`<input class="input run-e-key" list="run-env-keys" placeholder="KEY" style="flex:1"><span>=</span><input class="input run-e-val" placeholder="value" style="flex:2">`);

  const body = `
    <div class="run-form" style="display:flex;flex-direction:column;gap:12px">
      <div class="input-group">
        <label for="run-image">Image *</label>
        <input class="input" id="run-image" list="run-image-list" placeholder="e.g. nginx:alpine" value="${escapeHtml(prefillImage)}">
        <datalist id="run-image-list">${imageOpts.map(o => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-weight:400"><input type="checkbox" id="run-pull"${p.pull ? ' checked' : ''}> Pull image before running</label>
        <button type="button" class="btn btn-xs btn-secondary" id="run-hub-btn" style="margin-top:6px">${Icons.search} Search Docker Hub</button>
      </div>
      <div class="input-group"><label for="run-name">Container name (optional)</label><input class="input" id="run-name" placeholder="my-app" value="${escapeHtml(p.name || '')}"></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:160px"><label>Restart policy</label>
          <select class="select" id="run-restart">
            <option value="no">no</option>
            <option value="unless-stopped" selected>unless-stopped</option>
            <option value="always">always</option>
            <option value="on-failure">on-failure</option>
          </select>
        </div>
        <div class="input-group" style="flex:1;min-width:160px"><label>Network</label>
          <select class="select" id="run-network">
            <option value="">default (bridge)</option>
            ${netOpts.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:120px"><label>CPUs (optional)</label><input class="input" id="run-cpus" placeholder="e.g. 0.5"></div>
        <div class="input-group" style="flex:1;min-width:120px"><label>Memory (optional)</label><input class="input" id="run-memory" placeholder="e.g. 512m"></div>
      </div>
      <div class="input-group"><label>Command override (optional)</label><input class="input" id="run-cmd" placeholder="e.g. sleep 3600"></div>

      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><label style="font-weight:600">Ports</label><button type="button" class="btn btn-xs btn-secondary" id="run-add-port">+ Add port</button></div><div id="run-ports"></div></div>
      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap"><label style="font-weight:600">Volumes</label><div style="display:flex;gap:4px;flex-wrap:wrap">
        <button type="button" class="btn btn-xs btn-secondary" data-volpreset="/var/run/docker.sock|/var/run/docker.sock|ro" title="Mount the Docker socket (read-only)">+ docker.sock</button>
        <button type="button" class="btn btn-xs btn-secondary" data-volpreset="./data|/data|rw">+ ./data</button>
        <button type="button" class="btn btn-xs btn-secondary" data-volpreset="./config|/config|rw">+ ./config</button>
        <button type="button" class="btn btn-xs btn-secondary" id="run-add-vol">+ Add volume</button>
      </div></div><div id="run-vols"></div></div>
      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap"><label style="font-weight:600">Environment</label><div style="display:flex;gap:4px">
        <button type="button" class="btn btn-xs btn-secondary" id="run-paste-env-btn">${Icons.copy} Paste .env</button>
        <button type="button" class="btn btn-xs btn-secondary" id="run-add-env">+ Add variable</button>
      </div></div>
      <div id="run-env-paste" style="display:none;margin-bottom:8px">
        <textarea class="input" id="run-env-paste-ta" placeholder="Paste a .env — one KEY=VALUE per line" style="width:100%;min-height:84px;font-family:var(--font-mono);font-size:12px"></textarea>
        <div style="display:flex;gap:6px;margin-top:4px"><button type="button" class="btn btn-xs btn-primary" id="run-env-import">Import ↓</button><button type="button" class="btn btn-xs btn-secondary" id="run-env-paste-cancel">Cancel</button></div>
      </div>
      <div id="run-envs"></div></div>

      <datalist id="run-vol-list">${volOpts.map(o => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
      <datalist id="run-env-keys"></datalist>
    </div>`;

  const m = showModal('Run Container', body, []);
  const root = m.overlay;

  // Run button lives in the (sticky) modal footer so it's always visible regardless of form length.
  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.id = 'run-submit';
  submitBtn.innerHTML = `${Icons.play} Run Container`;
  root.querySelector('#modal-footer').appendChild(submitBtn);

  // Cross-module handoff: convert the current form into a Swarm service prefill.
  // Only shown when the active daemon is a swarm manager.
  API.get('/swarm').then(s => {
    if (!s || !s.active || !s.isManager) return;
    const swBtn = document.createElement('button');
    swBtn.className = 'btn btn-secondary';
    swBtn.textContent = 'Deploy to Swarm →';
    swBtn.title = 'Open the Swarm service form with these values';
    root.querySelector('#modal-footer').prepend(swBtn);
    swBtn.addEventListener('click', () => {
      const prefill = {
        image: root.querySelector('#run-image').value.trim(),
        name: root.querySelector('#run-name').value.trim(),
        cmd: root.querySelector('#run-cmd').value.trim(),
        ports: [...root.querySelectorAll('#run-ports .run-row')].map(r => ({
          published: r.querySelector('.run-p-host').value.trim(),
          target: r.querySelector('.run-p-cont').value.trim(),
          proto: r.querySelector('.run-p-proto').value,
        })).filter(pt => pt.target),
        mounts: [...root.querySelectorAll('#run-vols .run-row')].map(r => ({
          source: r.querySelector('.run-v-host').value.trim(),
          target: r.querySelector('.run-v-cont').value.trim(),
          mode: r.querySelector('.run-v-mode').value,
        })).filter(mt => mt.source && mt.target),
        env: [...root.querySelectorAll('#run-envs .run-row')].map(r => {
          const k = r.querySelector('.run-e-key').value.trim();
          return k ? `${k}=${r.querySelector('.run-e-val').value}` : null;
        }).filter(Boolean),
      };
      m.close();
      openSwarmServiceCreate(prefill, () => Router.navigate('deploy',{tab:'swarm'}));
    });
  }).catch(() => {});

  // Search Docker Hub → fill the image field with the chosen repository
  root.querySelector('#run-hub-btn')?.addEventListener('click', () => openHubSearch(name => {
    root.querySelector('#run-image').value = name;
    root.querySelector('#run-pull').checked = true; // a Hub image is usually not present locally yet
  }));

  // Repeatable rows — addRow can optionally fill the new row's inputs (used for template prefill)
  const addRow = (listId, builder, fill) => {
    const list = root.querySelector('#' + listId);
    const wrap = document.createElement('div');
    wrap.innerHTML = builder();
    const el = wrap.firstElementChild;
    el.querySelector('.run-row-del')?.addEventListener('click', () => el.remove());
    if (fill) fill(el);
    list.appendChild(el);
    return el;
  };
  const wire = (addBtnId, listId, builder) => {
    root.querySelector('#' + addBtnId)?.addEventListener('click', () => addRow(listId, builder));
  };
  wire('run-add-port', 'run-ports', portRow);
  wire('run-add-vol', 'run-vols', volRow);
  wire('run-add-env', 'run-envs', envRow);

  // Prefill rows from a template (no-op for the plain image-string usage)
  (p.ports || []).forEach(pt => addRow('run-ports', portRow, el => {
    el.querySelector('.run-p-host').value = pt.host || '';
    el.querySelector('.run-p-cont').value = pt.container || '';
    if (pt.proto) el.querySelector('.run-p-proto').value = pt.proto;
  }));
  (p.volumes || []).forEach(v => addRow('run-vols', volRow, el => {
    el.querySelector('.run-v-host').value = v.host || '';
    el.querySelector('.run-v-cont').value = v.container || '';
    if (v.mode) el.querySelector('.run-v-mode').value = v.mode;
  }));
  (p.env || []).forEach(e => addRow('run-envs', envRow, el => {
    el.querySelector('.run-e-key').value = e.key || '';
    el.querySelector('.run-e-val').value = e.val != null ? e.val : '';
  }));

  // Volume quick-presets → add a prefilled volume row
  root.querySelectorAll('[data-volpreset]').forEach(b => b.addEventListener('click', () => {
    const [host, container, mode] = b.dataset.volpreset.split('|');
    addRow('run-vols', volRow, el => {
      el.querySelector('.run-v-host').value = host;
      el.querySelector('.run-v-cont').value = container;
      if (mode) el.querySelector('.run-v-mode').value = mode;
    });
  }));

  // Paste .env → bulk-create env rows
  const pastePanel = root.querySelector('#run-env-paste');
  root.querySelector('#run-paste-env-btn')?.addEventListener('click', () => {
    const open = pastePanel.style.display === 'none';
    pastePanel.style.display = open ? 'block' : 'none';
    if (open) root.querySelector('#run-env-paste-ta').focus();
  });
  root.querySelector('#run-env-paste-cancel')?.addEventListener('click', () => { pastePanel.style.display = 'none'; });
  root.querySelector('#run-env-import')?.addEventListener('click', () => {
    const pairs = parseDotEnv(root.querySelector('#run-env-paste-ta').value);
    pairs.forEach(pr => addRow('run-envs', envRow, el => {
      el.querySelector('.run-e-key').value = pr.key;
      el.querySelector('.run-e-val').value = pr.val;
    }));
    root.querySelector('#run-env-paste-ta').value = '';
    pastePanel.style.display = 'none';
    showToast(pairs.length ? `${pairs.length} variable(s) imported` : 'No KEY=VALUE lines found', pairs.length ? 'success' : 'warning');
  });

  // Suggest env keys declared by the selected (local) image → datalist on the KEY inputs
  const localImageShortId = (name) => {
    const img = (images || []).find(i => (i.repoTags || []).includes(name));
    return img ? img.shortId : null;
  };
  async function loadEnvKeysFor(name) {
    const dl = root.querySelector('#run-env-keys');
    const id = localImageShortId((name || '').trim());
    if (!id) { dl.innerHTML = ''; return; }
    try {
      const info = await API.get('/images/' + encodeURIComponent(id));
      const keys = (info?.Config?.Env || []).map(e => String(e).split('=')[0]).filter(Boolean);
      dl.innerHTML = keys.map(k => `<option value="${escapeHtml(k)}">`).join('');
    } catch (e) { dl.innerHTML = ''; }
  }
  let imgTimer = null;
  root.querySelector('#run-image').addEventListener('input', () => {
    clearTimeout(imgTimer);
    imgTimer = setTimeout(() => loadEnvKeysFor(root.querySelector('#run-image').value), 400);
  });
  loadEnvKeysFor(prefillImage); // initial (template / image-button prefill)

  root.querySelector('#run-submit')?.addEventListener('click', async () => {
    const image = root.querySelector('#run-image').value.trim();
    if (!image) { showToast('Image is required', 'warning'); return; }
    const ports = [...root.querySelectorAll('#run-ports .run-row')].map(r => ({
      host: r.querySelector('.run-p-host').value.trim(),
      container: r.querySelector('.run-p-cont').value.trim(),
      proto: r.querySelector('.run-p-proto').value,
    })).filter(p => p.container);
    const volumes = [...root.querySelectorAll('#run-vols .run-row')].map(r => ({
      host: r.querySelector('.run-v-host').value.trim(),
      container: r.querySelector('.run-v-cont').value.trim(),
      mode: r.querySelector('.run-v-mode').value,
    })).filter(v => v.host && v.container);
    const env = [...root.querySelectorAll('#run-envs .run-row')].map(r => {
      const k = r.querySelector('.run-e-key').value.trim();
      const v = r.querySelector('.run-e-val').value;
      return k ? `${k}=${v}` : null;
    }).filter(Boolean);

    const payload = {
      image,
      name: root.querySelector('#run-name').value.trim(),
      restart: root.querySelector('#run-restart').value,
      network: root.querySelector('#run-network').value,
      cmd: root.querySelector('#run-cmd').value,
      cpus: root.querySelector('#run-cpus').value.trim(),
      memory: root.querySelector('#run-memory').value.trim(),
      pull: root.querySelector('#run-pull').checked,
      ports, volumes, env,
    };

    const btn = root.querySelector('#run-submit');
    btn.disabled = true; btn.textContent = 'Running...';
    try {
      await API.post('/containers/run', payload);
      showToast('Container started');
      m.close();
      Router.navigate('resources',{tab:'containers'});
    } catch (err) {
      showToast(err.message, 'error', 8000);
      btn.disabled = false; btn.innerHTML = `${Icons.play} Run Container`;
    }
  });
}
