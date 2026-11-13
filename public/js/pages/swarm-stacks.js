// Swarm → Stacks and Swarm → Migrate — phase 4.
//   Migrate: compose projects on the server in use, each Ready / Attention / Not possible with the reasons;
//            choose, set replicas / port mode / update order per service, review the plan (what changes for
//            Swarm, which volumes stay), then one job moves them one at a time and puts back any that fail.
//   Stacks:  stacks on Swarm — Redeploy (reads the compose files again), Settings, History (deploy an earlier
//            one again), Move back to Compose, Remove.
// The compose files are never changed. Server side: server/swarm-stacks.js.

(() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const STATUS = { ready: ['ok', 'Ready'], attention: ['warn', 'Attention'], partial: ['warn', 'Part can move'], impossible: ['bad', 'Not possible'] };
  const LV = { info: 'var(--text-muted)', warn: 'var(--warning,#d97706)', bad: 'var(--danger,#dc2626)' };
  const findings = (list) => list.map(f => `<div class="text-sm" style="color:${LV[f.level]};white-space:normal;min-width:220px">${f.level === 'bad' ? '✗' : f.level === 'warn' ? '!' : '·'} ${esc(f.text)}</div>`).join('');
  const job = (...a) => window.SwarmUI.openJob(...a);

  // Settings per service: replicas, port mode, update order.
  function settingsTable(p, settings) {
    const set = settings.services = settings.services || {};
    return UI.table([{ label: 'Service' }, { label: 'Replicas' }, { label: 'Ports' }, { label: 'Updates' }], p.services.map(s => {
      const my = set[s.name] = set[s.name] || {};
      // Less protected on Swarm only: it stays unless "Move anyway" is ticked (recorded in the audit log).
      const anyway = s.securityOnly ? `<label class="text-sm" style="display:flex;gap:6px;align-items:center;margin-top:6px;white-space:normal"><input type="checkbox" data-set="${esc(p.project)}|${esc(s.name)}|moveAnyway" ${my.moveAnyway ? 'checked' : ''}> Move anyway — less protected on Swarm</label>` : '';
      // privileged with a known image family: run with only the capabilities it needs, when accepted
      const caps = s.capFixable && s.capHint ? `<label class="text-sm" style="display:flex;gap:6px;align-items:center;margin-top:6px;white-space:normal"><input type="checkbox" data-set="${esc(p.project)}|${esc(s.name)}|capInstead" ${my.capInstead ? 'checked' : ''}> Run with cap_add ${esc(s.capHint.caps.join(', '))} instead of privileged</label>` : '';
      if (s.stays && !(s.securityOnly && my.moveAnyway) && !(s.capFixable && my.capInstead)) return { cells: [`<b>${esc(s.name)}</b><div class="ui-sub td-mono">${esc(s.image || '?')}</div>`, '<span class="text-sm" style="color:var(--warning,#d97706)">stays in Compose</span>', `${s.securityOnly ? securityList(s) : `<span class="ui-sub">${esc((s.findings.find(f => f.level === 'bad') || {}).text || '')}</span>`}${anyway}${caps}`, '<span class="ui-sub">connected to the stack network</span>'] };
      const data = s.volumes.length || s.binds.length || s.database;
      return { cells: [
        `<b>${esc(s.name)}</b><div class="ui-sub td-mono">${esc(s.image || '?')}</div>`,
        s.database ? '1 <span class="ui-sub">database</span>' : `<input class="input" type="number" min="0" max="100" style="width:80px" data-set="${esc(p.project)}|${esc(s.name)}|replicas" value="${my.replicas ?? 1}">`,
        portsCell(p, s, my),
        data ? '<span class="text-sm">stop-first</span><div class="ui-sub">has data: never two copies at once</div>' : `<select class="select" data-set="${esc(p.project)}|${esc(s.name)}|order" style="max-width:200px"><option value="start-first" ${my.order !== 'stop-first' ? 'selected' : ''}>start-first (no downtime)</option><option value="stop-first" ${my.order === 'stop-first' ? 'selected' : ''}>stop-first</option></select>`,
      ] };
    }), { minWidth: 0 });
  }
  // Build & push: services with build: need their image in a registry to run on several servers.
  let registriesCache = [];
  function buildNote(p, st) {
    const built = p.services.filter(s => s.build && !(s.stays && !s.securityOnly)).map(s => s.name);
    if (!built.length) return '';
    const regs = registriesCache;
    const cur = (st.build && st.build.registryId) || '';
    return `<div class="insight-card ${cur ? 'info' : 'warning'}" style="margin-bottom:8px;display:block"><div><b>Build &amp; push</b> — ${built.map(esc).join(', ')} ${built.length === 1 ? 'is' : 'are'} built from source. Swarm does not build, and the other servers can only pull an image from a registry: DockGate builds with Compose, tags it <span class="td-mono">&lt;registry&gt;/${esc(p.project)}-&lt;service&gt;:&lt;time&gt;</span>, pushes it, and does so again on every Redeploy. Your files are not changed.</div>
      <div style="margin-top:8px"><select class="select" data-set="${esc(p.project)}|__build|registryId" style="max-width:360px"><option value="">Do not push — use the image built on this server (one server only)</option>${regs.map(r => `<option value="${r.id}" ${String(r.id) === String(cur) ? 'selected' : ''}>${esc(r.name || r.server_address)} (${esc(r.server_address)})</option>`).join('')}</select>${regs.length ? '' : ' <span class="ui-sub">No registry logins yet — add one in Deploy → Registries.</span>'}</div></div>`;
  }
  // What would be weaker on Swarm, field by field.
  function securityList(s) {
    return (s.security || []).filter(r => r.verdict === 'weaker').map(r => `<div class="text-sm" style="color:var(--danger,#dc2626);white-space:normal">✗ ${esc(r.field)}: ${esc(r.before)} → ${esc(r.after)}${r.why ? ` <span class="ui-sub">(${esc(r.why)})</span>` : ''}</div>`).join('');
  }
  // Ports: open ones get ingress / host; ones only this server could reach (127.0.0.1) stay inside unless asked.
  function portsCell(p, s, my) {
    if (s.hostNetwork) return '<span class="text-sm">host network</span><div class="ui-sub">same as network_mode: host</div>';
    if (!s.ports.length) return '<span class="ui-sub">— inside only</span>';
    const open = s.ports.filter(x => x.scope === 'any'), local = s.ports.filter(x => x.scope === 'local'), addr = s.ports.filter(x => x.scope === 'address');
    const list = (xs) => xs.map(x => `${x.hostIp ? `${x.hostIp}:` : ''}${x.published || ''}→${x.target}`).join(', ');
    let h = '';
    if (open.length) h += `<select class="select" data-set="${esc(p.project)}|${esc(s.name)}|portMode" style="max-width:220px"><option value="ingress" ${my.portMode !== 'host' ? 'selected' : ''}>ingress — every server answers</option><option value="host" ${my.portMode === 'host' ? 'selected' : ''}>host — real client IP</option></select><div class="ui-sub">${esc(list(open))}</div>`;
    if (local.length) h += `<select class="select" data-set="${esc(p.project)}|${esc(s.name)}|localPorts" style="max-width:220px;margin-top:4px"><option value="inside" ${my.localPorts !== 'host' ? 'selected' : ''}>inside only — not published</option><option value="host" ${my.localPorts === 'host' ? 'selected' : ''}>this server only (host mode)</option></select><div class="ui-sub">${esc(list(local))} — was only on this server</div>`;
    if (addr.length) h += `<div class="text-sm" style="margin-top:4px">host mode</div><div class="ui-sub">${esc(list(addr))} — tied to one address: allow it in the firewall</div>`;
    return h;
  }
  // A Compose network shared with other projects: what DockGate does about it.
  function bridgeNote(p) {
    return (p.bridges || []).map(b => `<div class="insight-card info" style="margin-bottom:8px"><div><b>Shares the network ${esc(b.name)}${b.users.length ? ` with ${esc(b.users.join(', '))}` : ''}.</b> A stack can not join a Compose bridge, so DockGate makes its Swarm twin <span class="td-mono">${esc(b.twin)}</span>: the moved services join it, and the containers still in Compose are connected to it too, by the same names. Nothing stops. Move the project that publishes the ports (nginx) last.</div></div>`).join('');
  }
  function readSettings(root, all) {
    root.querySelectorAll('[data-set]').forEach(el => {
      const [proj, svc, key] = el.dataset.set.split('|');
      if (svc === '__build') { if (el.value) all[proj].build = { registryId: Number(el.value) }; else delete all[proj].build; return; }
      const st = all[proj].services[svc] = all[proj].services[svc] || {};
      if (el.type === 'checkbox') { if (el.checked) st[key] = true; else delete st[key]; return; }
      if (key === 'replicas') { const n = Number(el.value); if (el.value.trim() === '' || !Number.isInteger(n) || n < 0) { delete st[key]; return; } st[key] = n; } // empty → the default (1)
      else st[key] = el.value;
    });
  }

  // ---- Migrate ----
  function openMove(projects, done) {
    const settings = Object.fromEntries(projects.map(p => [p.project, { services: {} }]));
    let step = 0, previews = null, registries = null;
    const m = showModal(`Move ${projects.length} project${projects.length > 1 ? 's' : ''} to Swarm`, '<div data-w></div>', []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const root = m.overlay.querySelector('[data-w]');
    const footer = m.overlay.querySelector('#modal-footer');
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
    const back = document.createElement('button'); back.className = 'btn btn-secondary'; back.textContent = 'Back';
    const next = document.createElement('button'); next.className = 'btn btn-primary';
    footer.append(cancel, back, next);
    async function render() {
      back.style.display = step ? '' : 'none';
      const head = `${serverContextBanner()}<div class="sw-steps"><span class="${step === 0 ? 'on' : 'done'}">${step ? '✓' : '1.'} Settings</span><span class="${step === 1 ? 'on' : ''}">2. Plan</span></div>`;
      if (step === 0) {
        next.textContent = 'Review the plan'; next.disabled = false;
        if (registries === null && projects.some(p => p.services.some(s => s.build))) { registries = await API.get('/registries').catch(() => []); registriesCache = Array.isArray(registries) ? registries : []; }
        root.innerHTML = head + projects.map(p => `<div class="ui-ph-title" style="margin:10px 0 6px">${esc(p.project)} ${UI.pill(...STATUS[p.status])}</div>${bridgeNote(p)}${buildNote(p, settings[p.project])}${settingsTable(p, settings[p.project])}`).join('')
          + '<div class="ui-sub" style="margin-top:8px">Safe defaults are filled in: 1 replica, databases always 1. Host ports allow one task per server; with one server keep 1 replica for a service with host ports.</div>';
        return;
      }
      next.textContent = `Move ${projects.length} project${projects.length > 1 ? 's' : ''}`; next.disabled = true;
      root.innerHTML = head + '<div class="text-sm text-muted">Reading the compose files and building the plan…</div>';
      try {
        previews = await Promise.all(projects.map(p => API.post('/swarm/migrate/preview', { project: p.project, settings: settings[p.project] })));
      } catch (e) { root.innerHTML = head + UI.errorState(e, { compact: true }); return; }
      root.innerHTML = head + previews.map(pv => {
        if (!pv.stack) return `<div class="ui-ph-title" style="margin:10px 0 6px">${esc(pv.project)} ${UI.pill('bad', 'Not possible')}</div>${pv.reasons.map(r => `<div class="text-sm" style="color:${LV.bad}">✗ ${esc(r)}</div>`).join('')}`;
        const svcs = Object.entries(pv.stack.services);
        const sname = pv.status === 'partial' ? `${pv.project}-swarm` : pv.project;
        return `<div class="ui-ph-title" style="margin:14px 0 6px">${esc(pv.project)}${pv.status === 'partial' ? ` <span class="ui-sub">→ stack ${esc(sname)}</span>` : ''}</div>
          ${pv.status === 'partial' ? `<div class="insight-card warning" style="margin-bottom:8px"><div><b>Part of the project moves.</b> ${(pv.stays || []).map(x => `<b>${esc(x)}</b>`).join(', ')} stay${(pv.stays || []).length === 1 ? 's' : ''} in Compose and ${(pv.stays || []).length === 1 ? 'is' : 'are'} connected to the stack network, so the services reach each other by name as before. Only the moving services are stopped in Compose (<span class="td-mono">docker compose rm -s</span>). While part runs on Swarm, Compose Up for the project is refused (it would start those services twice).</div></div>` : ''}
          ${UI.table([{ label: 'Service on Swarm' }, { label: 'Replicas' }, { label: 'Ports' }, { label: 'Updates' }, { label: 'Changes for Swarm' }], svcs.map(([n, s]) => {
            const a = pv.services.find(x => x.name === n) || { findings: [] };
            return { cells: [`<b>${esc(sname)}_${esc(n)}</b><div class="ui-sub td-mono">${esc(s.image)}</div>`, esc(s.deploy.replicas ?? 'global'),
              (s.ports || []).map(p => `${p.published || ''}→${p.target}/${p.protocol} <span class="ui-sub">${p.mode}</span>`).join('<br>') || '—', `<span class="text-sm">${esc(s.deploy.update_config.order)}</span>${s.deploy.placement ? `<div class="ui-sub">${esc((s.deploy.placement.constraints || []).join(', '))}</div>` : ''}`, findings(a.findings) || '<span class="ui-sub">nothing</span>'] };
          }), { minWidth: 760 })}
          <div class="text-sm" style="margin-top:6px"><b>Volumes that stay the same:</b> ${pv.volumes.length ? pv.volumes.map(v => `<span class="td-mono">${esc(v.name)}</span>`).join(', ') : 'none'}. <b>Network:</b> ${Object.entries(pv.stack.networks || {}).map(([k, n]) => `<span class="td-mono">${esc(n.name || `${sname}_${k}`)}</span> (overlay)`).join(', ') || `${esc(sname)}_default (overlay)`}.</div>`;
      }).join('') + `<div class="insight-card info" style="margin-top:12px"><div><b>What happens, one project at a time:</b> the files are read again (if they changed since this plan, the project is not moved) → <span class="td-mono">docker compose down</span> (volumes stay) → <span class="td-mono">docker stack deploy</span> under the same name → every service must run and stay up for 30 s. If not, it is put back: the stack is removed and <span class="td-mono">docker compose up -d</span> runs. <b>The project is down from compose down until its services run on Swarm</b> — usually 10–60 s. The compose files are not changed.${previews.some(pv => pv.status === 'partial') ? ' <b>For part of a project</b> only the moving services are stopped, and the stack gets the name <i>project</i>-swarm.' : ''}</div></div>`;
      next.disabled = previews.every(pv => !pv.stack || !Object.keys(pv.stack.services || {}).length);
    }
    back.onclick = () => { step = 0; render(); };
    next.onclick = async () => {
      if (step === 0) { readSettings(root, settings); step = 1; render(); return; }
      const ok = previews.filter(pv => pv.stack);
      secConfirm({ title: `Move ${ok.length} project${ok.length > 1 ? 's' : ''} to Swarm`, danger: true,
        change: `${ok.map(p => `<b>${esc(p.project)}</b>`).join(', ')} stop in Compose and start on Swarm, one at a time. Each is down for a short time.`,
        protects: 'Volumes keep their data. A project whose services do not run on Swarm is put back in Compose by itself. A project whose files changed after this plan is not touched.',
        undo: 'Swarm → Stacks → Move back to Compose, at any time.', confirmLabel: 'Move',
        onConfirm: async () => {
          try { const r = await API.post('/swarm/migrate', { plans: ok.map(p => ({ project: p.project, hash: p.hash, settings: settings[p.project] })) }); m.close(); job(r.jobId, done, 'Move to Swarm'); }
          catch (e) { showToast(e.message, 'error', 9000); }
        } });
    };
    render();
  }

  Router.register('swarm-migrate', async (content, params) => {
    window.SwarmUI.css();
    const navId = Router._navId;
    content.innerHTML = UI.header('Migrate', 'Reading the compose projects on this server…');
    let data;
    try { data = await API.get('/swarm/migrate'); }
    catch (e) { content.innerHTML = UI.header('Migrate', esc(e.message), UI.btn('Open Overview', 'data-go')); content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' }); return; }
    if (!Router.isActiveNav(navId)) return;
    const pre = params && params.project ? String(params.project) : null;
    const rows = data.projects.map(p => ({ cells: [
      `<input type="checkbox" data-pick="${esc(p.project)}" ${p.status === 'impossible' ? 'disabled' : ''} ${pre === p.project && p.status !== 'impossible' ? 'checked' : ''}>`,
      `<b>${esc(p.project)}</b>${p.location ? `<div class="ui-sub td-mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(p.location.cwd || '')}</div>` : ''}`,
      UI.pill(...STATUS[p.status]),
      `<span class="text-sm">${p.services.map(s => esc(s.name)).join(', ') || '—'}</span>`,
      `${p.running}/${p.total}`,
      `${(p.bridges || []).length ? `<div class="ui-sub">shares ${esc(p.bridges.map(b => b.name).join(', '))} — joins its Swarm twin</div>` : ''}<details><summary class="text-sm" style="cursor:pointer">${p.reasons.length || p.services.some(s => s.findings.length) ? 'What changes' : 'Nothing to change'}</summary>${p.reasons.map(r => `<div class="text-sm" style="color:${LV.bad}">✗ ${esc(r)}</div>`).join('')}${p.services.map(s => s.findings.length ? `<div class="text-sm" style="margin-top:4px"><b>${esc(s.name)}</b></div>${findings(s.findings)}` : '').join('')}</details>`,
    ] }));
    content.innerHTML = `${UI.header('Migrate', `Compose projects on this server that run outside Swarm. Choose some and DockGate moves them one at a time; one that does not run on Swarm goes back to Compose by itself. The compose files are not changed.${data.nodes > 1 ? ' Services with data stay on this server (placement rule).' : ''}`, UI.primary('Review…', 'data-review'))}
      ${UI.table([{ label: '', width: '36px' }, { label: 'Project' }, { label: 'Status' }, { label: 'Services' }, { label: 'Running' }, { label: 'Details' }], rows, { minWidth: 860, empty: 'No compose projects outside Swarm on this server.' })}
      <div class="ui-sub" style="margin-top:8px"><b>Ready</b>: nothing to change. <b>Attention</b>: it can move; something is shown (a build image, a database kept at 1, depends_on conditions). <b>Part can move</b>: some services can not run on Swarm (privileged, devices, network_mode) — the others move to the stack <i>project</i>-swarm, those stay in Compose and are connected to the stack network so they reach each other by name; volumes keep their names. <b>Not possible</b>: no service can move, or no compose file.</div>
      <div class="ui-ph" style="margin-top:18px"><div class="ui-ph-text"><div class="ui-ph-title">Containers started with docker run</div><div class="ui-ph-desc">DockGate writes a stack file from the container (image, command, environment, ports, volumes, restart policy) for you to check, then moves it: the container is stopped and kept, the stack deployed, and the container started again if the stack does not come up.</div></div></div>
      <div data-cts class="text-sm text-muted">Loading…</div>`;
    API.get('/swarm/containers').then(({ containers }) => {
      const el = content.querySelector('[data-cts]'); if (!el) return;
      el.innerHTML = UI.table([{ label: 'Container' }, { label: 'Image' }, { label: 'State' }, { label: '', align: 'right' }], containers.map(x => ({ cells: [
        `<b>${esc(x.name)}</b>`, `<span class="td-mono text-sm">${esc(x.image)}</span>`, `${UI.pill(x.state === 'running' ? 'ok' : 'off', esc(x.state))} <span class="ui-sub">${esc(x.status)}</span>`, UI.btn('Move to Swarm…', `data-ct="${esc(x.id)}"`)] })), { minWidth: 640, empty: 'No containers started with docker run on this server.' });
      el.querySelectorAll('[data-ct]').forEach(b => b.onclick = async () => {
        try { const g = await API.get(`/swarm/containers/${encodeURIComponent(b.dataset.ct)}/stack-file`); stackEditor({ mode: 'container', containerId: b.dataset.ct, container: g.container, name: g.name, yaml: g.yaml, notes: g.notes, onDone: () => Router.navigate('swarm', { tab: 'swarm-stacks' }) }); }
        catch (e) { showToast(e.message, 'error', 9000); }
      });
    }).catch(e => { const el = content.querySelector('[data-cts]'); if (el) el.innerHTML = UI.errorState(e, { compact: true }); });
    content.querySelector('[data-review]').onclick = () => {
      const picked = [...content.querySelectorAll('[data-pick]:checked')].map(c => data.projects.find(p => p.project === c.dataset.pick));
      if (!picked.length) return showToast('Choose at least one project', 'warning');
      openMove(picked, () => Router.navigate('swarm', { tab: 'swarm-stacks' }));
    };
  });

  // ---- stack file editor: New stack / Edit stack file / Take over / Move a container to Swarm ----
  // o: { mode: 'new'|'edit'|'takeover'|'container', name, yaml, env, notes, containerId, container, onDone }
  async function stackEditor(o) {
    const titles = { new: 'New stack', edit: `Stack file of ${o.name}`, takeover: `Take over ${o.name}`, container: `Move ${o.container} to Swarm` };
    const saveLabel = { new: 'Deploy', edit: 'Save and deploy', takeover: 'Take over', container: 'Move to Swarm' }[o.mode];
    let templates = [];
    const NOTE = { info: 'var(--text-muted)', warn: 'var(--warning,#d97706)', bad: 'var(--danger,#dc2626)' };
    const intro = {
      new: 'Paste a stack file (compose format) or start from an app template. DockGate checks it, deploys it with <span class="td-mono">docker stack deploy</span> and keeps it: Edit stack file… changes it later.',
      edit: 'Saving deploys the file again: changed services are updated one task at a time and go back by themselves when a new task fails. Services removed from the file are removed.',
      takeover: 'This file was written from the services that run now. Check it, then save: DockGate keeps it for Redeploy and Edit stack file. Nothing is deployed now.',
      container: `This file was written from the container. <b>${esc(o.container || '')}</b> is stopped (kept, its restart policy set to "no") and the stack deployed. If the service does not come up, the container is started again. Named volumes are used by their own name, so the data stays.`,
    }[o.mode];
    const m = showModal(titles[o.mode], `${serverContextBanner()}<p class="text-sm">${intro}</p>
      ${(o.notes || []).length ? `<div style="margin:8px 0">${o.notes.map(n => `<div class="text-sm" style="color:${NOTE[n.level]}">${n.level === 'bad' ? '✗' : n.level === 'warn' ? '!' : '·'} ${esc(n.text)}</div>`).join('')}</div>` : ''}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0">
        ${o.mode === 'new' || o.mode === 'container' ? `<label class="ui-field" style="flex:1;min-width:200px"><span class="ui-label">Stack name</span><input class="input" data-name value="${esc(o.name || '')}" placeholder="myapp"></label>` : ''}
        ${o.mode === 'new' ? `<label class="ui-field" style="flex:2;min-width:240px"><span class="ui-label">Start from an app template (optional)</span><select class="select" data-tpl><option value="">Loading templates…</option></select></label>` : ''}
      </div>
      <label class="ui-field"><span class="ui-label">Stack file</span><textarea class="input" data-yaml rows="18" spellcheck="false" style="font-family:var(--font-mono,monospace);font-size:12px;white-space:pre;tab-size:2">${esc(o.yaml || '')}</textarea></label>
      <label class="ui-field" style="margin-top:8px"><span class="ui-label">Variables (optional)</span><textarea class="input" data-env rows="3" spellcheck="false" placeholder="TAG=1.27&#10;DB_PASSWORD=…" style="font-family:var(--font-mono,monospace);font-size:12px">${esc(o.env || '')}</textarea><span class="ui-sub">KEY=VALUE per line, filled in for \${KEY} in the file. Kept encrypted in DockGate.</span></label>
      <div data-out class="text-sm" style="margin-top:8px"></div>`, []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const ov = m.overlay, out = ov.querySelector('[data-out]');
    const footer = ov.querySelector('#modal-footer');
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; footer.appendChild(b); return b; };
    mk('Cancel', 'btn btn-secondary', () => m.close());
    const val = () => ({ yaml: ov.querySelector('[data-yaml]').value, env: ov.querySelector('[data-env]').value, name: ov.querySelector('[data-name]') ? ov.querySelector('[data-name]').value.trim() : o.name });
    mk('Check', 'btn btn-secondary', async () => {
      try { await API.post('/swarm/stacks/check', val()); out.innerHTML = `<span style="color:var(--success,#16a34a)">✓ The file is valid.</span>`; }
      catch (e) { out.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
    });
    const save = mk(saveLabel, 'btn btn-primary', async () => {
      const v = val();
      save.disabled = true;
      try {
        let r;
        if (o.mode === 'new') r = await API.post('/swarm/stacks', v);
        else if (o.mode === 'edit') r = await API.put(`/swarm/stacks/${encodeURIComponent(o.name)}/file`, v);
        else if (o.mode === 'takeover') { await API.post(`/swarm/stacks/${encodeURIComponent(o.name)}/take-over`, v); m.close(); showToast(`DockGate manages ${o.name} now`); return o.onDone && o.onDone(); }
        else r = await API.post(`/swarm/containers/${encodeURIComponent(o.containerId)}/move`, v);
        m.close();
        job(r.jobId, o.onDone, o.mode === 'container' ? 'Move to Swarm' : o.mode === 'new' ? 'Deploy' : 'Redeploy');
      } catch (e) { out.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; save.disabled = false; }
    });
    if (o.mode === 'new') {
      const sel = ov.querySelector('[data-tpl]');
      try {
        const cat = await API.get('/templates');
        templates = (cat.templates || []).filter(t => t.type === 2 || t.type === 3 || t.compose);
        sel.innerHTML = '<option value="">—</option>' + templates.map((t, i) => `<option value="${i}">${esc(t.title || t.name || 'Template')}</option>`).join('');
      } catch (e) { sel.innerHTML = '<option value="">Templates could not be loaded</option>'; }
      sel.onchange = async () => {
        const t = templates[Number(sel.value)]; if (!t) return;
        out.textContent = 'Loading the template…';
        try {
          const yaml = await window.TemplatesUI.resolveStackYaml(t);
          ov.querySelector('[data-yaml]').value = yaml;
          const nm = ov.querySelector('[data-name]'); if (!nm.value) nm.value = (t.title || 'stack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
          out.innerHTML = '<span class="ui-sub">Template loaded. Swarm ignores container_name and build; Check shows other problems.</span>';
        } catch (e) { out.innerHTML = `<span style="color:var(--danger,#dc2626)">${esc(e.message)}</span>`; }
      };
    }
  }
  window.SwarmUI.stackEditor = stackEditor;
  /** Move a stack that came from Compose back to Compose (Stacks menu, and the Compose page). */
  function moveBackConfirm(s, done) {
    secConfirm({ title: `Move ${s.name} back to Compose`, danger: true, change: `The stack is removed, DockGate waits until its network is gone, then <span class="td-mono">docker compose up -d</span> runs in ${esc((s.location || {}).cwd || 'its folder')}. It is down for a short time (usually 20–60 s).`, protects: 'Volumes keep their data: Compose uses the same volume names.', undo: 'Move it to Swarm again with Migrate.', confirmLabel: 'Move back',
      onConfirm: async () => { try { const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/move-back`, { confirm: true }); job(r.jobId, done, 'Move back to Compose'); } catch (e) { showToast(e.message, 'error', 9000); } } });
  }
  window.SwarmUI.moveBack = async (name, done) => {
    let list; try { list = (await API.get('/swarm/stacks')).stacks; } catch (e) { return showToast(e.message, 'error', 9000); }
    const st = list.find(x => x.name === name);
    if (!st || !st.managed || !st.location) return showToast(`${name} can not be moved back from here — open Swarm → Stacks`, 'error', 9000);
    moveBackConfirm(st, done);
  };
  /** Move one compose project to Swarm from anywhere (Deploy → Compose stacks): analyse it, then the usual dialog. */
  window.SwarmUI.moveProject = async (name, done) => {
    showToast(`Reading ${name}…`, 'info', 2500);
    let data;
    try { data = await API.get('/swarm/migrate'); } catch (e) { return showToast(e.message, 'error', 9000); }
    const p = data.projects.find(x => x.project === name);
    if (!p) return showToast(`${name} is not a compose project on this server (or it runs on Swarm already)`, 'error', 9000);
    if (p.status === 'impossible') {
      return showModal(`${esc(name)} can not move to Swarm`, `${p.reasons.map(r => `<div class="text-sm" style="color:${LV.bad}">✗ ${esc(r)}</div>`).join('')}${p.services.map(s => s.findings.length ? `<div class="text-sm" style="margin-top:6px"><b>${esc(s.name)}</b></div>${findings(s.findings)}` : '').join('')}`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    }
    openMove([p], done);
  };

  // ---- Stacks ----
  // What a deploy of a stack was, in words that fit where the stack came from (Compose, a container, a stack file).
  function kindLabel(kind, s, short = false) {
    const ct = s && s.origin === 'container';
    const map = short
      ? { move: ct ? 'moved from container' : 'moved from Compose', deploy: 'deployed', redeploy: 'redeployed', previous: 'earlier deploy', 'move-back': 'moved back' }
      : { move: ct ? 'moved from container' : 'moved from Compose', deploy: 'deploy', redeploy: 'redeploy', previous: 'earlier deploy again', 'move-back': ct ? 'moved back to the container' : 'moved back to Compose' };
    return map[kind] || kind;
  }
  function historyDialog(s, done) {
    const m = showModal(`History · ${esc(s.name)}`, '<div data-h class="text-sm text-muted">Loading…</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    API.get(`/swarm/stacks/${encodeURIComponent(s.name)}/history`).then(({ history }) => {
      const ST = { done: ['ok', 'done'], rolled_back: ['warn', s.origin === 'container' ? 'container started again' : 'put back in Compose'], failed: ['bad', 'failed'], running: ['warn', 'running'] };
      m.overlay.querySelector('[data-h]').innerHTML = UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Result' }, { label: 'Files' }, { label: 'From' }, { label: '', align: 'right' }], history.map((h, i) => ({ cells: [
        `<span title="${esc(formatTime(new Date(h.started_at).toISOString()))}">${esc(timeAgo(new Date(h.started_at).toISOString()))}</span>`, esc(kindLabel(h.kind, s)),
        `${UI.pill(...(ST[h.status] || ['off', esc(h.status)]))}${h.downtime_ms ? ` <span class="ui-sub">down ${Math.round(h.downtime_ms / 1000)}s</span>` : ''}${h.error ? `<div class="ui-sub" style="max-width:300px;white-space:normal">${esc(h.error)}</div>` : ''}`,
        `<span class="td-mono text-sm">${esc(h.hash || '—')}</span>`, `<span class="ui-sub">${esc(h.source_ip || '—')}</span>`,
        h.has_stack && h.status === 'done' && i > 0 && s.managed ? UI.btn('Deploy this again…', `data-again="${h.id}"`) : ''] })), { minWidth: 720, empty: 'No deploys recorded.' });
      m.overlay.querySelectorAll('[data-again]').forEach(b => b.onclick = () => secConfirm({ title: `Deploy an earlier version of ${s.name}`, change: 'The stack file of that deploy is deployed again (not the compose files as they are now).', protects: 'Services that change are updated one task at a time and go back by themselves when a new task fails.', undo: 'Redeploy reads the compose files again.', confirmLabel: 'Deploy',
        onConfirm: async () => { try { const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/redeploy`, { deployId: Number(b.dataset.again) }); m.close(); job(r.jobId, done, 'Redeploy'); } catch (e) { showToast(e.message, 'error', 9000); } } }));
    }).catch(e => { m.overlay.querySelector('[data-h]').innerHTML = UI.errorState(e, { compact: true }); });
  }
  async function stackSettings(s, done) {
    let pv;
    try { pv = await API.post('/swarm/migrate/preview', { project: s.name }); } catch (e) { return showToast(e.message, 'error'); }
    const settings = { [s.name]: pv.settings && pv.settings.services ? pv.settings : { services: {} } }; // the stored ones
    UI.dialog({ title: `Swarm settings of ${s.name}`, wide: true, saveLabel: 'Save and redeploy',
      body: `${settingsTable({ project: s.name, services: pv.services }, settings[s.name])}<div class="ui-sub" style="margin-top:6px">Saved in DockGate (not in the compose file) and used by every deploy of this stack.</div>`,
      onSave: async (ov) => { readSettings(ov, settings); const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/redeploy`, { settings: settings[s.name] }); job(r.jobId, done, 'Redeploy'); } });
  }

  Router.register('swarm-stacks', async (content, params) => {
    window.SwarmUI.css();
    let focus = params && params.stack ? String(params.stack) : null; // opened for one stack: show it
    const navId = Router._navId;
    let timer = null, data = [];
    const stop = () => clearTimeout(timer);
    async function load() {
      if (!Router.isActiveNav(navId) || !content.isConnected) return stop();
      try { data = (await API.get('/swarm/stacks')).stacks; }
      catch (e) { content.innerHTML = UI.header('Stacks', esc(e.message), UI.btn('Open Overview', 'data-go')); content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' }); return; }
      if (!Router.isActiveNav(navId)) return;
      const rows = data.map(s => ({ cells: [
        `<b>${esc(s.name)}</b>${s.location ? `<div class="ui-sub td-mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(s.location.cwd || '')}</div>` : ''}`,
        s.managed ? ({ compose: 'moved from Compose', yaml: 'stack file in DockGate', container: `moved from container ${esc(s.fromContainer || '')}` }[s.origin] || 'deployed by DockGate') : '<span class="ui-sub">deployed outside DockGate</span>',
        String(s.services),
        `<b style="color:${s.running < s.desired ? 'var(--warning,#d97706)' : 'inherit'}">${s.running}/${s.desired}</b>`,
        s.last ? `${esc(kindLabel(s.last.kind, s, true))} ${UI.pill(s.last.status === 'done' ? 'ok' : s.last.status === 'running' ? 'warn' : 'bad', esc(s.last.status))}<div class="ui-sub">${esc(timeAgo(new Date(s.last.started_at).toISOString()))}</div>` : '<span class="ui-sub">—</span>',
        UI.menu([
          s.managed ? { label: 'Redeploy', attrs: `data-a="redeploy" data-n="${esc(s.name)}"` } : null,
          s.hasFile ? { label: 'Edit stack file…', attrs: `data-a="file" data-n="${esc(s.name)}"` } : null,
          s.managed && s.origin === 'compose' ? { label: 'Swarm settings…', attrs: `data-a="settings" data-n="${esc(s.name)}"` } : null,
          !s.managed && s.services ? { label: 'Take over…', attrs: `data-a="takeover" data-n="${esc(s.name)}"` } : null,
          { label: 'History', attrs: `data-a="history" data-n="${esc(s.name)}"` },
          { label: 'Services', attrs: `data-a="services" data-n="${esc(s.name)}"` },
          '-',
          s.managed && s.location ? { label: 'Move back to Compose…', attrs: `data-a="back" data-n="${esc(s.name)}"` } : null,
          s.origin === 'container' ? { label: 'Move back to the container…', attrs: `data-a="back-ct" data-n="${esc(s.name)}"` } : null,
          { label: 'Remove…', attrs: `data-a="remove" data-n="${esc(s.name)}"` },
        ]),
      ] }));
      content.innerHTML = `${UI.header('Stacks', 'Stacks on Swarm. A stack moved from Compose reads its compose files again on each deploy (adapted in memory, the files are not changed); a stack file kept in DockGate is edited here.', `${UI.btn('Move projects to Swarm…', 'data-migrate')} ${UI.primary('New stack…', 'data-newstack')}`)}
        ${UI.table([{ label: 'Stack' }, { label: 'Origin' }, { label: 'Services' }, { label: 'Tasks' }, { label: 'Last deploy' }, { label: '', align: 'right' }], rows, { minWidth: 820, empty: 'No stacks yet. Move compose projects to Swarm with Migrate.' })}`;
      if (focus) { // once: mark its row and bring it into view
        const row = [...content.querySelectorAll('.ui-table tbody tr')].find(tr => tr.querySelector('td b')?.textContent === focus);
        if (row) { row.style.outline = '2px solid var(--accent)'; row.style.outlineOffset = '-2px'; row.scrollIntoView({ block: 'center' }); setTimeout(() => { row.style.outline = ''; }, 4000); }
        focus = null;
      }
      content.querySelector('[data-migrate]').onclick = () => Router.navigate('swarm', { tab: 'swarm-migrate' });
      content.querySelector('[data-newstack]').onclick = () => stackEditor({ mode: 'new', yaml: 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n    deploy:\n      replicas: 2\n', onDone: load });
      content.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => act(b.dataset.a, data.find(x => x.name === b.dataset.n))));
      stop(); timer = setTimeout(load, 8000);
    }
    function act(a, s) {
      if (!s) return;
      if (a === 'history') return historyDialog(s, load);
      if (a === 'services') return Router.navigate('swarm', { tab: 'swarm-services' });
      if (a === 'settings') return stackSettings(s, load);
      if (a === 'file') return API.get(`/swarm/stacks/${encodeURIComponent(s.name)}/file`).then(f => stackEditor({ mode: 'edit', name: s.name, yaml: f.yaml, env: f.env, onDone: load })).catch(e => showToast(e.message, 'error'));
      if (a === 'takeover') return API.get(`/swarm/stacks/${encodeURIComponent(s.name)}/written`).then(f => stackEditor({ mode: 'takeover', name: s.name, yaml: f.yaml, onDone: load })).catch(e => showToast(e.message, 'error'));
      if (a === 'back-ct') return secConfirm({ title: `Move ${s.name} back to the container`, danger: true, change: `The stack is removed, then the container <b>${esc(s.fromContainer || '')}</b> gets its restart policy back and starts. It is down for a short time.`, protects: 'Volumes keep their data: the container uses the same volumes.', undo: 'Move it to Swarm again (Migrate → Containers).', confirmLabel: 'Move back',
        onConfirm: async () => { try { const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/move-back`, { confirm: true }); job(r.jobId, load, 'Move back to the container'); } catch (e) { showToast(e.message, 'error', 9000); } } });
      if (a === 'redeploy') return secConfirm({ title: `Redeploy ${s.name}`, change: 'The compose files are read again and deployed (docker stack deploy --prune): changed services are updated, services removed from the files are removed.', protects: 'Services update one task at a time and go back by themselves when a new task fails. Volumes stay.', undo: 'History → Deploy this again on an earlier deploy.', confirmLabel: 'Redeploy',
        onConfirm: async () => { try { const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/redeploy`, {}); job(r.jobId, load, 'Redeploy'); } catch (e) { showToast(e.message, 'error', 9000); } } });
      if (a === 'back') return moveBackConfirm(s, load);
      if (a === 'remove') return showDeleteConfirm(`Remove stack ${s.name}`, { message: `Its ${s.services} service${s.services === 1 ? '' : 's'} and network${s.services === 1 ? '' : 's'} are removed. Volumes, secrets and configs stay; the compose files are not touched.${s.managed ? ' To run it in Compose again, use Move back to Compose instead.' : ''}`, phrase: s.name, confirmLabel: 'Remove',
        onConfirm: async () => { try { await API.del(`/swarm/stacks/${encodeURIComponent(s.name)}`); showToast(`${s.name} removed`); load(); } catch (e) { showToast(e.message, 'error', 9000); } } });
    }
    await load();
    return stop;
  });
})();
