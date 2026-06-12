// Global Swarm "New Service" form — the Run-modal conveniences (Hub search, datalists,
// row-based ports/mounts/env, .env paste, image-ENV suggestions) applied to swarm services,
// plus swarm-only sections (replicas, restart condition, overlay network, secrets/configs mounts).
// Used by the Swarm page and cross-module entry points (Images → "Deploy as Swarm service",
// Run modal → "Deploy to Swarm").
// prefill: { name, image, replicas, ports:[{published,target,proto}], mounts:[{source,target,mode}],
//            env:["K=V"...], cmd }   ·   onDone() — called after a successful create.
async function openSwarmServiceCreate(prefill = {}, onDone) {
  const p = prefill || {};
  let images = [], volumes = [], networks = [], secrets = [], configs = [];
  try {
    [images, volumes, networks, secrets, configs] = await Promise.all([
      API.get('/images').catch(() => []),
      API.get('/volumes').catch(() => []),
      API.get('/networks').catch(() => []),
      API.get('/swarm/secrets').catch(() => []),
      API.get('/swarm/configs').catch(() => []),
    ]);
  } catch (e) { /* datalists fall back to free text */ }

  const imageOpts = (images || [])
    .map(i => (i.repoTags && i.repoTags[0] !== '<none>:<none>') ? i.repoTags[0] : null)
    .filter(Boolean);
  const volOpts = (volumes || []).map(v => v.name).filter(Boolean);
  // A swarm service can ONLY attach to a swarm-scoped overlay network (a local bridge network yields
  // "network ... cannot be used with services" — 403). So offer only those.
  const netOpts = (networks || []).filter(n => n.driver === 'overlay' && n.scope === 'swarm' && n.name !== 'ingress');

  const row = (cells) => `<div class="sw-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">${cells}<button type="button" class="btn-icon sw-row-del" title="Remove" style="color:var(--danger)">${Icons.trash}</button></div>`;
  const portRow = () => row(`<input class="input sw-p-pub" placeholder="published (e.g. 8080)" style="flex:1"><span>:</span><input class="input sw-p-tgt" placeholder="target (e.g. 80)" style="flex:1"><select class="select sw-p-proto" style="width:80px"><option value="tcp">tcp</option><option value="udp">udp</option></select>`);
  const mntRow = () => row(`<input class="input sw-m-src" list="sw-vol-list" placeholder="volume name or /host/path" style="flex:2"><span>:</span><input class="input sw-m-tgt" placeholder="container path" style="flex:2"><select class="select sw-m-mode" style="width:80px"><option value="rw">rw</option><option value="ro">ro</option></select>`);
  const envRow = () => row(`<input class="input sw-e-key" list="sw-env-keys" placeholder="KEY" style="flex:1"><span>=</span><input class="input sw-e-val" placeholder="value" style="flex:2">`);
  const secRow = () => row(`<select class="select sw-s-id" style="flex:1">${secrets.map(s => `<option value="${s.id}" data-name="${escapeHtml(s.name || '')}">${escapeHtml(s.name || s.id)}</option>`).join('')}</select><span>→</span><input class="input sw-s-tgt" placeholder="/run/secrets/<name>" style="flex:1">`);
  const cfgRow = () => row(`<select class="select sw-c-id" style="flex:1">${configs.map(c => `<option value="${c.id}" data-name="${escapeHtml(c.name || '')}">${escapeHtml(c.name || c.id)}</option>`).join('')}</select><span>→</span><input class="input sw-c-tgt" placeholder="/<name>" style="flex:1">`);

  const body = `
    <div class="sw-svc-form" style="display:flex;flex-direction:column;gap:12px">
      <div class="input-group">
        <label for="sws-image">Image *</label>
        <input class="input" id="sws-image" list="sws-image-list" placeholder="e.g. nginx:alpine" value="${escapeHtml(p.image || '')}">
        <datalist id="sws-image-list">${imageOpts.map(o => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
        <button type="button" class="btn btn-xs btn-secondary" id="sws-hub-btn" style="margin-top:6px">${Icons.search} Search Docker Hub</button>
        <span class="text-xs text-muted" style="display:block;margin-top:4px">Each node pulls the image itself when a task is scheduled on it.</span>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="input-group" style="flex:2;min-width:160px"><label for="sws-name">Service name *</label><input class="input" id="sws-name" placeholder="web" value="${escapeHtml(p.name || '')}"></div>
        <div class="input-group" style="flex:1;min-width:90px"><label>Replicas</label><input class="input" id="sws-rep" type="number" min="0" value="${p.replicas != null ? p.replicas : 1}"></div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:160px"><label>Restart condition</label>
          <select class="select" id="sws-restart">
            <option value="any" selected>any (default)</option>
            <option value="on-failure">on-failure</option>
            <option value="none">none</option>
          </select>
        </div>
        <div class="input-group" style="flex:1;min-width:160px"><label>Network (overlay)</label>
          <select class="select" id="sws-network">
            <option value="">— none (ingress only) —</option>
            ${netOpts.map(n => `<option value="${escapeHtml(n.name)}">${escapeHtml(n.name)}</option>`).join('')}
          </select>
          <span class="text-xs text-muted">${netOpts.length ? 'Only swarm overlay networks attach to a service.' : 'No overlay networks yet — create one in <strong>Networks</strong> (driver: overlay) for service-to-service DNS.'}</span>
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="input-group" style="flex:1;min-width:120px"><label>CPU limit / replica (optional)</label><input class="input" id="sws-cpus" placeholder="e.g. 0.5"></div>
        <div class="input-group" style="flex:1;min-width:120px"><label>Memory limit / replica (optional)</label><input class="input" id="sws-memory" placeholder="e.g. 512m"></div>
      </div>
      <div class="input-group"><label>Command override (optional)</label><input class="input" id="sws-cmd" placeholder="e.g. sleep 3600" value="${escapeHtml(p.cmd || '')}"></div>

      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><label style="font-weight:600">Published ports</label><button type="button" class="btn btn-xs btn-secondary" id="sws-add-port">+ Add port</button></div><div id="sws-ports"></div></div>
      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap"><label style="font-weight:600">Mounts</label><div style="display:flex;gap:4px;flex-wrap:wrap">
        <button type="button" class="btn btn-xs btn-secondary" data-swmntpreset="/var/run/docker.sock|/var/run/docker.sock|ro" title="Mount the Docker socket (read-only)">+ docker.sock</button>
        <button type="button" class="btn btn-xs btn-secondary" data-swmntpreset="appdata|/data|rw" title="Named volume → /data">+ data vol</button>
        <button type="button" class="btn btn-xs btn-secondary" id="sws-add-mnt">+ Add mount</button>
      </div></div><div id="sws-mnts"></div></div>
      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap"><label style="font-weight:600">Environment</label><div style="display:flex;gap:4px">
        <button type="button" class="btn btn-xs btn-secondary" id="sws-paste-env-btn">${Icons.copy} Paste .env</button>
        <button type="button" class="btn btn-xs btn-secondary" id="sws-add-env">+ Add variable</button>
      </div></div>
      <div id="sws-env-paste" style="display:none;margin-bottom:8px">
        <textarea class="input" id="sws-env-paste-ta" placeholder="Paste a .env — one KEY=VALUE per line" style="width:100%;min-height:84px;font-family:var(--font-mono);font-size:12px"></textarea>
        <div style="display:flex;gap:6px;margin-top:4px"><button type="button" class="btn btn-xs btn-primary" id="sws-env-import">Import ↓</button><button type="button" class="btn btn-xs btn-secondary" id="sws-env-paste-cancel">Cancel</button></div>
      </div>
      <div id="sws-envs"></div></div>

      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><label style="font-weight:600">Secrets ${secrets.length ? '' : '<span class="text-xs text-muted" style="font-weight:400">(none in the swarm yet)</span>'}</label><button type="button" class="btn btn-xs btn-secondary" id="sws-add-sec" ${secrets.length ? '' : 'disabled'}>+ Mount secret</button></div><div id="sws-secs"></div></div>
      <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><label style="font-weight:600">Configs ${configs.length ? '' : '<span class="text-xs text-muted" style="font-weight:400">(none in the swarm yet)</span>'}</label><button type="button" class="btn btn-xs btn-secondary" id="sws-add-cfg" ${configs.length ? '' : 'disabled'}>+ Mount config</button></div><div id="sws-cfgs"></div></div>

      <datalist id="sw-vol-list">${volOpts.map(o => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
      <datalist id="sw-env-keys"></datalist>
    </div>`;

  const m = showModal('New Swarm Service', body, []);
  const root = m.overlay;

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.id = 'sws-submit';
  submitBtn.innerHTML = `${Icons.play} Create Service`;
  root.querySelector('#modal-footer').appendChild(submitBtn);

  root.querySelector('#sws-hub-btn')?.addEventListener('click', () => openHubSearch(name => {
    root.querySelector('#sws-image').value = name;
  }));

  // Repeatable rows (same pattern as the Run modal)
  const addRow = (listId, builder, fill) => {
    const list = root.querySelector('#' + listId);
    const wrap = document.createElement('div');
    wrap.innerHTML = builder();
    const el = wrap.firstElementChild;
    el.querySelector('.sw-row-del')?.addEventListener('click', () => el.remove());
    if (fill) fill(el);
    list.appendChild(el);
    return el;
  };
  root.querySelector('#sws-add-port')?.addEventListener('click', () => addRow('sws-ports', portRow));
  root.querySelector('#sws-add-mnt')?.addEventListener('click', () => addRow('sws-mnts', mntRow));
  root.querySelector('#sws-add-env')?.addEventListener('click', () => addRow('sws-envs', envRow));
  root.querySelector('#sws-add-sec')?.addEventListener('click', () => addRow('sws-secs', secRow, el => {
    const sel = el.querySelector('.sw-s-id');
    el.querySelector('.sw-s-tgt').value = '/run/secrets/' + (sel.selectedOptions[0]?.dataset.name || '');
  }));
  root.querySelector('#sws-add-cfg')?.addEventListener('click', () => addRow('sws-cfgs', cfgRow, el => {
    const sel = el.querySelector('.sw-c-id');
    el.querySelector('.sw-c-tgt').value = '/' + (sel.selectedOptions[0]?.dataset.name || '');
  }));

  // Cross-module prefill rows
  (p.ports || []).forEach(pt => addRow('sws-ports', portRow, el => {
    el.querySelector('.sw-p-pub').value = pt.published || '';
    el.querySelector('.sw-p-tgt').value = pt.target || '';
    if (pt.proto) el.querySelector('.sw-p-proto').value = pt.proto;
  }));
  (p.mounts || []).forEach(mt => addRow('sws-mnts', mntRow, el => {
    el.querySelector('.sw-m-src').value = mt.source || '';
    el.querySelector('.sw-m-tgt').value = mt.target || '';
    if (mt.mode) el.querySelector('.sw-m-mode').value = mt.mode;
  }));
  (p.env || []).forEach(e => {
    const s = typeof e === 'string' ? e : `${e.key}=${e.val ?? ''}`;
    const i = s.indexOf('=');
    if (i < 1) return;
    addRow('sws-envs', envRow, el => {
      el.querySelector('.sw-e-key').value = s.slice(0, i);
      el.querySelector('.sw-e-val').value = s.slice(i + 1);
    });
  });

  // Mount quick-presets
  root.querySelectorAll('[data-swmntpreset]').forEach(b => b.addEventListener('click', () => {
    const [source, target, mode] = b.dataset.swmntpreset.split('|');
    addRow('sws-mnts', mntRow, el => {
      el.querySelector('.sw-m-src').value = source;
      el.querySelector('.sw-m-tgt').value = target;
      if (mode) el.querySelector('.sw-m-mode').value = mode;
    });
  }));

  // Paste .env (shared parseDotEnv)
  const pastePanel = root.querySelector('#sws-env-paste');
  root.querySelector('#sws-paste-env-btn')?.addEventListener('click', () => {
    const open = pastePanel.style.display === 'none';
    pastePanel.style.display = open ? 'block' : 'none';
    if (open) root.querySelector('#sws-env-paste-ta').focus();
  });
  root.querySelector('#sws-env-paste-cancel')?.addEventListener('click', () => { pastePanel.style.display = 'none'; });
  root.querySelector('#sws-env-import')?.addEventListener('click', () => {
    const pairs = parseDotEnv(root.querySelector('#sws-env-paste-ta').value);
    pairs.forEach(pr => addRow('sws-envs', envRow, el => {
      el.querySelector('.sw-e-key').value = pr.key;
      el.querySelector('.sw-e-val').value = pr.val;
    }));
    root.querySelector('#sws-env-paste-ta').value = '';
    pastePanel.style.display = 'none';
    showToast(pairs.length ? `${pairs.length} variable(s) imported` : 'No KEY=VALUE lines found', pairs.length ? 'success' : 'warning');
  });

  // ENV key suggestions from the locally-present image's Config.Env
  const localImageShortId = (name) => {
    const img = (images || []).find(i => (i.repoTags || []).includes(name));
    return img ? img.shortId : null;
  };
  async function loadEnvKeysFor(name) {
    const dl = root.querySelector('#sw-env-keys');
    const id = localImageShortId((name || '').trim());
    if (!id) { dl.innerHTML = ''; return; }
    try {
      const info = await API.get('/images/' + encodeURIComponent(id));
      const keys = (info?.Config?.Env || []).map(e => String(e).split('=')[0]).filter(Boolean);
      dl.innerHTML = keys.map(k => `<option value="${escapeHtml(k)}">`).join('');
    } catch (e) { dl.innerHTML = ''; }
  }
  let imgTimer = null;
  root.querySelector('#sws-image').addEventListener('input', () => {
    clearTimeout(imgTimer);
    imgTimer = setTimeout(() => loadEnvKeysFor(root.querySelector('#sws-image').value), 400);
  });
  loadEnvKeysFor(p.image || '');

  root.querySelector('#sws-submit')?.addEventListener('click', async () => {
    const image = root.querySelector('#sws-image').value.trim();
    const name = root.querySelector('#sws-name').value.trim();
    if (!name || !image) { showToast('Name and image are required', 'warning'); return; }
    const ports = [...root.querySelectorAll('#sws-ports .sw-row')].map(r => ({
      published: r.querySelector('.sw-p-pub').value.trim(),
      target: r.querySelector('.sw-p-tgt').value.trim(),
      proto: r.querySelector('.sw-p-proto').value,
    })).filter(pt => pt.target);
    const mounts = [...root.querySelectorAll('#sws-mnts .sw-row')].map(r => ({
      source: r.querySelector('.sw-m-src').value.trim(),
      target: r.querySelector('.sw-m-tgt').value.trim(),
      mode: r.querySelector('.sw-m-mode').value,
      type: r.querySelector('.sw-m-src').value.trim().startsWith('/') ? 'bind' : 'volume',
    })).filter(mt => mt.source && mt.target);
    const env = [...root.querySelectorAll('#sws-envs .sw-row')].map(r => {
      const k = r.querySelector('.sw-e-key').value.trim();
      return k ? `${k}=${r.querySelector('.sw-e-val').value}` : null;
    }).filter(Boolean);
    const svcSecrets = [...root.querySelectorAll('#sws-secs .sw-row')].map(r => {
      const sel = r.querySelector('.sw-s-id');
      return { id: sel.value, name: sel.selectedOptions[0]?.dataset.name || '', target: r.querySelector('.sw-s-tgt').value.trim() };
    }).filter(s => s.id);
    const svcConfigs = [...root.querySelectorAll('#sws-cfgs .sw-row')].map(r => {
      const sel = r.querySelector('.sw-c-id');
      return { id: sel.value, name: sel.selectedOptions[0]?.dataset.name || '', target: r.querySelector('.sw-c-tgt').value.trim() };
    }).filter(c => c.id);

    const payload = {
      name, image,
      replicas: root.querySelector('#sws-rep').value,
      restart: root.querySelector('#sws-restart').value,
      network: root.querySelector('#sws-network').value,
      cpus: root.querySelector('#sws-cpus').value.trim(),
      memory: root.querySelector('#sws-memory').value.trim(),
      cmd: root.querySelector('#sws-cmd').value.trim(),
      ports, mounts, env, secrets: svcSecrets, configs: svcConfigs,
    };

    submitBtn.disabled = true; submitBtn.textContent = 'Creating…';
    try {
      await API.post('/swarm/services', payload);
      showToast(`Service "${name}" created`);
      m.close();
      if (onDone) onDone();
    } catch (err) {
      showToast(err.message, 'error', 9000);
      submitBtn.disabled = false; submitBtn.innerHTML = `${Icons.play} Create Service`;
    }
  });
}
