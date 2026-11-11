// Swarm → Services — phase 3. One row per service: replicas (a square per task), ports, the last update and,
// when a task does not run, why. Actions: Scale, Update image (rolling, automatic roll back), Rollback, Restart,
// Traffic, Logs, Tasks, Settings (the full form in 10 sections), Remove; New service… uses the same form.
// Server side: server/swarm-services.js.

(() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const STYLE = `
  .svc-sq{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:2px;background:var(--border)}
  .svc-sq.running{background:var(--success,#16a34a)} .svc-sq.failed,.svc-sq.rejected{background:var(--danger,#dc2626)}
  .svc-sq.pending,.svc-sq.assigned,.svc-sq.preparing,.svc-sq.starting,.svc-sq.accepted,.svc-sq.ready{background:var(--warning,#d97706)}
  .svc-form{display:grid;grid-template-columns:180px 1fr;gap:16px;min-height:420px} @media(max-width:720px){.svc-form{grid-template-columns:1fr}}
  .svc-nav{display:flex;flex-direction:column;gap:2px} @media(max-width:720px){.svc-nav{flex-direction:row;flex-wrap:wrap}}
  .svc-nav button{text-align:left;padding:7px 10px;border-radius:8px;border:0;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px}
  .svc-nav button.on{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary);font-weight:600}
  .svc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px} @media(max-width:640px){.svc-grid{grid-template-columns:1fr}}
  .svc-rows{display:flex;flex-direction:column;gap:6px} .svc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .svc-row .input,.svc-row .select{flex:1;min-width:90px}
  .svc-sec{display:none} .svc-sec.on{display:block}
  `;
  function css() { if (!document.getElementById('svc-style')) { const s = document.createElement('style'); s.id = 'svc-style'; s.textContent = STYLE; document.head.appendChild(s); } }
  const UPD = { updating: ['warn', 'updating'], completed: ['ok', 'updated'], paused: ['bad', 'update paused'], rollback_started: ['warn', 'rolling back'], rollback_paused: ['bad', 'roll back paused'], rollback_completed: ['warn', 'rolled back'] };

  // ---- update progress window ----
  function watch(id, title, onDone) {
    const m = showModal(esc(title), `${serverContextBanner()}<div data-st class="text-sm" style="font-weight:600;margin-bottom:8px">⏳ Waiting for Swarm…</div><div data-msg class="ui-sub" style="margin-bottom:8px"></div><div data-tasks></div>
      <div class="ui-sub" style="margin-top:8px">Swarm does the update; closing this window does not stop it. The Services list shows its state.</div>`, []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const close = document.createElement('button'); close.className = 'btn btn-secondary'; close.textContent = 'Close';
    const doClose = () => { m.close(); if (onDone) onDone(); };
    close.onclick = doClose; m.overlay.querySelector('.modal-close').onclick = doClose;
    m.overlay.querySelector('#modal-footer').appendChild(close);
    const t0 = Date.now();
    const poll = async () => {
      if (!m.overlay.isConnected) return;
      try {
        const p = await API.get(`/swarm/services/${id}/progress`);
        const u = p.update;
        const st = m.overlay.querySelector('[data-st]');
        const state = u ? u.State : null;
        const done = state && ['completed', 'paused', 'rollback_completed', 'rollback_paused'].includes(state);
        const text = { updating: '⏳ Updating, one task at a time…', completed: '✓ Updated', paused: '✗ Update paused — a new task failed', rollback_started: '↩ The new version failed — rolling back…', rollback_completed: '↩ Rolled back to the previous version', rollback_paused: '✗ Roll back paused' }[state] || (Date.now() - t0 > 8000 ? '✓ Done (no rolling update was needed)' : '⏳ Waiting for Swarm…');
        st.textContent = text;
        st.style.color = state === 'completed' || (!state && Date.now() - t0 > 8000) ? '#16a34a' : /paused/.test(state || '') ? '#dc2626' : state === 'rollback_completed' ? '#d97706' : '';
        m.overlay.querySelector('[data-msg]').textContent = u && u.Message ? u.Message : '';
        m.overlay.querySelector('[data-tasks]').innerHTML = UI.table([{ label: 'Task' }, { label: 'Server' }, { label: 'Image' }, { label: 'State' }],
          p.tasks.map(t => ({ cells: [`${esc(p.name)}${t.slot ? '.' + t.slot : ''}`, esc(t.node), `<span class="td-mono text-sm">${esc(t.image)}</span>`, `${UI.pill(t.state === 'running' ? 'ok' : ['failed', 'rejected'].includes(t.state) ? 'bad' : 'warn', esc(t.state))}${t.desired === 'shutdown' ? ' <span class="ui-sub">stopping</span>' : ''}${t.error ? `<div class="ui-sub">${esc(t.error)}</div>` : ''}`] })), { minWidth: 0 });
        if (done || (!state && Date.now() - t0 > 8000)) { close.className = 'btn btn-primary'; setTimeout(poll, 4000); return; }
      } catch (e) { /* retry */ }
      setTimeout(poll, 1500);
    };
    poll();
  }

  // API call that asks once more when the server says "this looks like a database".
  async function withDbConfirm(call) {
    try { return await call(false); }
    catch (e) {
      if (e && /looks like a database/.test(e.message || '')) { if (confirm(`${e.message}\n\nContinue anyway?`)) return call(true); return null; }
      throw e;
    }
  }

  // ---- the form ----
  const SECTIONS = [['general', 'General'], ['resources', 'Resources'], ['placement', 'Placement'], ['update', 'Updates & rollback'], ['restart', 'Restart'], ['health', 'Health check'], ['env', 'Env & secrets'], ['network', 'Ports & network'], ['mounts', 'Mounts'], ['advanced', 'Advanced']];
  function field(path, label, value, { type = 'text', hint = '', options = null, placeholder = '' } = {}) {
    const v = value == null ? '' : value;
    const input = options ? `<select class="select" data-p="${path}">${options.map(o => { const [val, lbl] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lbl)}</option>`; }).join('')}</select>`
      : type === 'lines' ? `<textarea class="input" data-p="${path}" data-lines rows="4" placeholder="${esc(placeholder)}" style="font-family:var(--font-mono,monospace)">${esc((v || []).join('\n'))}</textarea>`
        : type === 'check' ? `<label class="text-sm"><input type="checkbox" data-p="${path}" ${v ? 'checked' : ''}> ${label}</label>`
          : `<input class="input" data-p="${path}" type="${type}" value="${esc(v)}" placeholder="${esc(placeholder)}">`;
    if (type === 'check') return `<div class="ui-field">${input}${hint ? `<span class="ui-sub">${hint}</span>` : ''}</div>`;
    return `<label class="ui-field"><span class="ui-label">${label}</span>${input}${hint ? `<span class="ui-sub">${hint}</span>` : ''}</label>`;
  }
  // Row editors for lists of objects (ports, mounts, networks, secrets, configs)
  function rows(key, list, cols, empty) {
    const row = (x) => `<div class="svc-row" data-row="${key}">${cols.map(c => c.options
      ? `<select class="select" data-k="${c.k}" title="${esc(c.label)}">${c.options.map(o => `<option ${String(x[c.k] ?? c.def ?? '') === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : c.check ? `<label class="text-sm" style="flex:none"><input type="checkbox" data-k="${c.k}" ${x[c.k] ? 'checked' : ''}> ${esc(c.label)}</label>`
        : `<input class="input" data-k="${c.k}" placeholder="${esc(c.label)}" value="${esc(x[c.k] ?? '')}" ${c.list ? `list="${c.list}"` : ''}>`).join('')}<button type="button" class="btn btn-xs btn-secondary" data-del-row title="Remove">✕</button></div>`;
    return `<div class="svc-rows" data-rows="${key}">${(list || []).map(row).join('')}</div><div style="margin-top:6px">${UI.btn(`+ Add`, `data-add-row="${key}"`)}</div><template data-tpl="${key}">${row({})}</template>${empty ? `<div class="ui-sub" style="margin-top:4px">${empty}</div>` : ''}`;
  }

  function openForm({ id = null, onDone } = {}) {
    css();
    const m = showModal(id ? 'Service settings' : 'New service', '<div data-body class="text-sm text-muted">Loading…</div>', []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const body = m.overlay.querySelector('[data-body]');
    const footer = m.overlay.querySelector('#modal-footer');
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
    const save = document.createElement('button'); save.className = 'btn btn-primary'; save.textContent = id ? 'Save (rolling update)' : 'Create service';
    footer.append(cancel, save);
    (async () => {
      let d;
      try { d = id ? await API.get(`/swarm/services/${id}`) : await API.get('/swarm/services/new'); }
      catch (e) { body.innerHTML = UI.errorState(e, { compact: true }); save.disabled = true; return; }
      const f = d.form, ch = d.choices;
      const g = f.general, r = f.resources, pl = f.placement, u = f.update, rb = f.rollback, rs = f.restart, h = f.health, e = f.env, n = f.network, a = f.advanced;
      const isNew = !id;
      const dur = 'e.g. 10s, 1m30s';
      const sec = {
        general: `<div class="svc-grid">
            ${isNew ? field('name', 'Name', f.name, { placeholder: 'api', hint: 'Letters, digits, dot, dash, underscore.' }) : `<div class="ui-field"><span class="ui-label">Name</span><b>${esc(f.name)}</b></div>`}
            ${field('general.image', 'Image', g.image, { placeholder: 'nginx:1.27', hint: 'Pulled on every server that runs a task. Private registries use the login from Deploy → Registries.' })}
            ${isNew ? field('general.mode', 'Mode', g.mode, { options: [['replicated', 'Replicated — a number of tasks'], ['global', 'Global — one task on every server'], ['replicated-job', 'Job — runs to completion'], ['global-job', 'Global job — once on every server']] }) : `<div class="ui-field"><span class="ui-label">Mode</span>${esc(g.mode)}</div>`}
            ${field('general.replicas', 'Replicas', g.replicas, { type: 'number', hint: 'For replicated services and jobs.' })}
            ${field('general.entrypoint', 'Entrypoint', g.entrypoint, { placeholder: 'empty = the image\'s', hint: 'Replaces the image ENTRYPOINT.' })}
            ${field('general.command', 'Command', g.command, { placeholder: 'empty = the image\'s', hint: 'Arguments; quotes work as in a shell.' })}
            ${field('general.user', 'User', g.user, { placeholder: 'e.g. 1000:1000' })}
            ${field('general.workdir', 'Working directory', g.workdir)}
            ${field('general.hostname', 'Hostname', g.hostname, { hint: 'Templates work: {{.Service.Name}}-{{.Task.Slot}}' })}
          </div>`,
        resources: `<div class="svc-grid">
            ${field('resources.cpus', 'CPU limit', r.cpus, { type: 'number', placeholder: '0.5', hint: 'CPUs per task (0.5 = half a core).' })}
            ${field('resources.memory', 'Memory limit', r.memory, { placeholder: '512M', hint: 'A task above it is killed (exit code 137).' })}
            ${field('resources.cpusReserve', 'CPU reservation', r.cpusReserve, { type: 'number', hint: 'Swarm only places a task where this much is free.' })}
            ${field('resources.memoryReserve', 'Memory reservation', r.memoryReserve, { placeholder: '256M' })}
            ${field('resources.pids', 'PID limit', r.pids, { type: 'number', hint: 'Stops fork bombs.' })}
            ${field('resources.generic', 'Generic resources (GPU …)', r.generic, { type: 'lines', placeholder: 'NVIDIA-GPU=1', hint: 'KIND=count; the servers must announce them in daemon.json.' })}
          </div>`,
        placement: `${field('placement.constraints', 'Constraints', pl.constraints, { type: 'lines', placeholder: 'node.labels.db==true\nnode.role!=manager', hint: 'Every line must match. Node labels are set in Swarm → Nodes → Labels.' })}
            ${field('placement.spread', 'Spread over', pl.spread, { type: 'lines', placeholder: 'node.labels.zone', hint: 'Tasks are spread evenly over the values of this label (e.g. zones).' })}
            ${field('placement.maxPerNode', 'At most per server', pl.maxPerNode, { type: 'number', hint: 'Empty = no limit.' })}`,
        update: `<div class="ui-ph-title" style="margin-bottom:6px">Update</div><div class="svc-grid">
            ${field('update.order', 'Order', u.order, { options: [['start-first', 'start-first — the new task starts before the old one stops'], ['stop-first', 'stop-first — the old one stops first']], hint: 'start-first means no downtime; tasks with host-mode ports always use stop-first.' })}
            ${field('update.parallelism', 'Tasks at a time', u.parallelism, { type: 'number', hint: '0 = all at once.' })}
            ${field('update.delay', 'Delay between them', u.delay, { placeholder: dur })}
            ${field('update.monitor', 'Watch each new task for', u.monitor, { placeholder: dur, hint: 'A task that fails in this time counts as a failed update.' })}
            ${field('update.failureAction', 'When it fails', u.failureAction, { options: [['rollback', 'roll back to the previous version'], ['pause', 'pause the update'], ['continue', 'continue']] })}
            ${field('update.maxFailureRatio', 'Failures allowed (0–1)', u.maxFailureRatio, { type: 'number' })}
          </div><div class="ui-ph-title" style="margin:12px 0 6px">Roll back</div><div class="svc-grid">
            ${field('rollback.order', 'Order', rb.order, { options: ['stop-first', 'start-first'] })}
            ${field('rollback.parallelism', 'Tasks at a time', rb.parallelism, { type: 'number' })}
            ${field('rollback.delay', 'Delay', rb.delay, { placeholder: dur })}
            ${field('rollback.monitor', 'Watch for', rb.monitor, { placeholder: dur })}
            ${field('rollback.failureAction', 'When it fails', rb.failureAction, { options: ['pause', 'continue'] })}
            ${field('rollback.maxFailureRatio', 'Failures allowed (0–1)', rb.maxFailureRatio, { type: 'number' })}
          </div>`,
        restart: `<div class="svc-grid">
            ${field('restart.condition', 'Restart when', rs.condition, { options: [['any', 'it stops for any reason'], ['on-failure', 'it fails (exit code not 0)'], ['none', 'never']] })}
            ${field('restart.delay', 'Wait before restarting', rs.delay, { placeholder: dur })}
            ${field('restart.maxAttempts', 'Max attempts', rs.maxAttempts, { type: 'number', hint: '0 = no limit.' })}
            ${field('restart.window', 'Count attempts within', rs.window, { placeholder: 'e.g. 2m', hint: 'With max attempts: stops a task that keeps crashing.' })}
          </div>`,
        health: `${field('health.mode', 'Health check', h.mode, { options: [['image', 'Use the image\'s health check'], ['custom', 'Custom'], ['none', 'Turn it off']] })}
            <div data-health-custom style="${h.mode === 'custom' ? '' : 'display:none'}"><div class="svc-grid">
            ${field('health.test', 'Command', h.test, { placeholder: 'curl -fs http://localhost:8080/health || exit 1', hint: 'Runs in a shell inside the task. Exit 0 = healthy.' })}
            ${field('health.interval', 'Every', h.interval, { placeholder: '30s' })}
            ${field('health.timeout', 'Timeout', h.timeout, { placeholder: '5s' })}
            ${field('health.retries', 'Failures before unhealthy', h.retries, { type: 'number' })}
            ${field('health.startPeriod', 'Start period', h.startPeriod, { placeholder: '30s', hint: 'Failures in this time after start do not count.' })}
            </div></div><div class="ui-sub" style="margin-top:6px">With start-first updates the old task keeps running until the new one is healthy.</div>`,
        env: `${field('env.env', 'Environment', e.env, { type: 'lines', placeholder: 'NAME=value', hint: 'One NAME=value per line. Use secrets for passwords.' })}
            <div class="ui-label" style="margin-top:10px">Secrets</div>${rows('secrets', e.secrets, [{ k: 'name', label: 'secret', list: 'svc-secrets' }, { k: 'target', label: 'file name in /run/secrets (default: its name)' }], ch.secrets.length ? '' : 'No secrets yet — create them in Swarm → Secrets & configs.')}
            <div class="ui-label" style="margin-top:10px">Configs</div>${rows('configs', e.configs, [{ k: 'name', label: 'config', list: 'svc-configs' }, { k: 'target', label: 'path in the task, e.g. /etc/nginx/nginx.conf' }])}
            <div class="svc-grid" style="margin-top:10px">${field('env.labels', 'Service labels', e.labels, { type: 'lines', placeholder: 'traefik.enable=true' })}${field('env.containerLabels', 'Container labels', e.containerLabels, { type: 'lines' })}</div>
            <datalist id="svc-secrets">${ch.secrets.map(x => `<option value="${esc(x)}">`).join('')}</datalist><datalist id="svc-configs">${ch.configs.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`,
        network: `<div class="ui-label">Ports</div>${rows('ports', n.ports, [{ k: 'published', label: 'published (server) port' }, { k: 'target', label: 'container port' }, { k: 'protocol', label: 'protocol', options: ['tcp', 'udp', 'sctp'], def: 'tcp' }, { k: 'mode', label: 'mode', options: ['ingress', 'host'], def: 'ingress' }])}
            <div class="ui-sub" style="margin-top:4px"><b>ingress</b>: the port answers on every server and requests are spread over the tasks; the app sees an internal IP, not the client's. <b>host</b>: only servers running a task answer, the app sees the real client IP (needed for nginx logs and fail2ban), one task per server for that port.</div>
            <div class="svc-grid" style="margin-top:10px">${field('network.endpointMode', 'Endpoint mode', n.endpointMode, { options: [['vip', 'VIP — one virtual IP, Swarm balances'], ['dnsrr', 'DNS round robin — the name returns every task']] })}</div>
            <div class="ui-label" style="margin-top:10px">Networks</div>${rows('networks', n.networks, [{ k: 'name', label: 'overlay network', list: 'svc-nets' }, { k: 'aliases', label: 'aliases, comma separated' }], ch.networks.length ? `Overlay networks: ${ch.networks.map(esc).join(', ')}` : 'No overlay networks yet — create one in Swarm → Networks; without one the service is only on ingress.')}
            <div class="svc-grid" style="margin-top:10px">${field('network.dns', 'DNS servers', n.dns, { type: 'lines', placeholder: '1.1.1.1' })}${field('network.extraHosts', 'Extra hosts', n.extraHosts, { type: 'lines', placeholder: '10.0.0.5 db.internal' })}</div>
            <datalist id="svc-nets">${ch.networks.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`,
        mounts: `${rows('mounts', f.mounts, [{ k: 'type', label: 'type', options: ['volume', 'bind', 'tmpfs'], def: 'volume' }, { k: 'source', label: 'volume name or server path' }, { k: 'target', label: 'path in the task' }, { k: 'driver', label: 'volume driver (optional)' }, { k: 'readonly', label: 'read-only', check: true }])}
            <div class="ui-sub" style="margin-top:6px">A named volume lives on the server where the task runs: if the task moves to another server it starts with an empty volume. For data, pin the service to one server (Placement) or use a shared volume driver (NFS). A bind path must exist on every server that may run the task.</div>`,
        advanced: `<div class="svc-grid">
            ${field('advanced.capAdd', 'Add capabilities', a.capAdd, { type: 'lines', placeholder: 'NET_ADMIN' })}
            ${field('advanced.capDrop', 'Drop capabilities', a.capDrop, { type: 'lines', placeholder: 'ALL' })}
            ${field('advanced.sysctls', 'Sysctls', a.sysctls, { type: 'lines', placeholder: 'net.core.somaxconn=1024' })}
            ${field('advanced.ulimits', 'Ulimits', a.ulimits, { type: 'lines', placeholder: 'nofile=1024:4096' })}
            ${field('advanced.stopGrace', 'Stop grace period', a.stopGrace, { placeholder: '10s', hint: 'Time to shut down before it is killed.' })}
            ${field('advanced.stopSignal', 'Stop signal', a.stopSignal, { placeholder: 'SIGTERM' })}
            ${field('advanced.logDriver', 'Log driver', a.logDriver, { placeholder: 'json-file' })}
            ${field('advanced.logOpts', 'Log options', a.logOpts, { type: 'lines', placeholder: 'max-size=10m\nmax-file=3' })}
            ${field('advanced.readOnly', 'Read-only root filesystem', a.readOnly, { type: 'check' })}
            ${field('advanced.init', 'Run an init process (reaps zombies)', a.init, { type: 'check' })}
          </div><div class="insight-card info" style="margin-top:10px"><div><b>privileged</b> and <b>devices</b> are not here: Swarm services do not support them. A container that needs them stays a Compose project.</div></div>`,
      };
      body.innerHTML = `${serverContextBanner()}${d.stack ? `<div class="insight-card warning" style="margin-bottom:10px"><div>This service belongs to stack <b>${esc(d.stack)}</b>. A new deploy of the stack writes its compose settings over what you change here.</div></div>` : ''}
        <div class="svc-form"><div class="svc-nav">${SECTIONS.map(([k, l], i) => `<button type="button" data-sec="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div>${SECTIONS.map(([k], i) => `<div class="svc-sec ${i === 0 ? 'on' : ''}" data-secbody="${k}">${sec[k]}</div>`).join('')}<div data-err></div></div></div>`;
      body.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => {
        body.querySelectorAll('[data-sec]').forEach(x => x.classList.toggle('on', x === b));
        body.querySelectorAll('[data-secbody]').forEach(x => x.classList.toggle('on', x.dataset.secbody === b.dataset.sec));
      });
      body.querySelector('[data-p="health.mode"]').onchange = (ev) => { body.querySelector('[data-health-custom]').style.display = ev.target.value === 'custom' ? '' : 'none'; };
      body.addEventListener('click', (ev) => {
        const add = ev.target.closest('[data-add-row]');
        if (add) { const k = add.dataset.addRow; body.querySelector(`[data-rows="${k}"]`).insertAdjacentHTML('beforeend', body.querySelector(`[data-tpl="${k}"]`).innerHTML); }
        const del = ev.target.closest('[data-del-row]'); if (del) del.closest('[data-row]').remove();
      });
      const read = () => {
        const out = JSON.parse(JSON.stringify(f));
        body.querySelectorAll('[data-p]').forEach(el => {
          const path = el.dataset.p.split('.'); let o = out;
          for (const k of path.slice(0, -1)) o = o[k] = o[k] || {};
          o[path[path.length - 1]] = el.type === 'checkbox' ? el.checked : el.hasAttribute('data-lines') ? el.value.split('\n').map(x => x.trim()).filter(Boolean) : el.value;
        });
        const listOf = (k) => [...body.querySelectorAll(`[data-row="${k}"]`)].map(r => { const o = {}; r.querySelectorAll('[data-k]').forEach(i => { o[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value.trim(); }); return o; });
        out.env.secrets = listOf('secrets').filter(x => x.name); out.env.configs = listOf('configs').filter(x => x.name);
        out.network.ports = listOf('ports').filter(x => x.target || x.published); out.network.networks = listOf('networks').filter(x => x.name);
        out.mounts = listOf('mounts').filter(x => x.target);
        out.health.shell = true;
        return out;
      };
      save.onclick = async () => {
        const err = body.querySelector('[data-err]'); err.innerHTML = ''; save.disabled = true;
        try {
          const form = read();
          const r = await withDbConfirm((confirmDb) => (id ? API.put(`/swarm/services/${id}`, { form: { ...form, confirmDb }, version: d.version }) : API.post('/swarm/services', { form: { ...form, confirmDb } })));
          if (!r) { save.disabled = false; return; }
          m.close();
          showToast(id ? 'Saved — Swarm updates the tasks' : `Service ${form.name} created`);
          watch(id || r.id, id ? `Update ${form.name || f.name}` : `Start ${form.name}`, onDone);
        } catch (e2) { err.innerHTML = `<div class="insight-card danger" style="margin-top:10px"><div>${esc(e2.message)}</div></div>`; save.disabled = false; }
      };
    })();
  }

  // ---- small dialogs ----
  function scaleDialog(s, done) {
    UI.dialog({ title: `Scale ${s.name}`, saveLabel: 'Scale',
      body: `<label class="ui-field"><span class="ui-label">Replicas</span><input class="input" type="number" min="0" max="1000" data-n value="${s.desired}"></label>
        <div class="ui-sub">Now ${s.running}/${s.desired} running. 0 stops every task but keeps the service.${s.database ? ' <b style="color:var(--warning,#d97706)">This looks like a database: more than 1 replica means separate databases, not copies.</b>' : ''}</div>`,
      onSave: async (ov) => {
        const n = Number(ov.querySelector('[data-n]').value);
        const r = await withDbConfirm((confirmDb) => API.post(`/swarm/services/${s.id}/scale`, { replicas: n, confirmDb }));
        if (!r) return false;
        showToast(`${s.name}: ${n} replica${n === 1 ? '' : 's'}`); done();
      } });
  }
  function imageDialog(s, done) {
    UI.dialog({ title: `Update ${s.name}`, saveLabel: 'Update',
      body: `<label class="ui-field"><span class="ui-label">Image</span><input class="input" data-img value="${esc(s.image)}"></label>
        <div class="ui-sub">Change the tag (e.g. <span class="td-mono">${esc(s.image.split(':')[0])}:new-version</span>), or keep it to pull the same tag again. Tasks are replaced by the service's update settings (by default one at a time, the new one first); if a new task fails, Swarm goes back to the previous version by itself.</div>`,
      onSave: async (ov) => { await API.post(`/swarm/services/${s.id}/image`, { image: ov.querySelector('[data-img]').value.trim() }); watch(s.id, `Update ${s.name}`, done); } });
  }
  async function logsDialog(s) {
    const m = showModal(`Logs · ${esc(s.name)}`, '<div data-lv></div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    LogViewer.mount(m.overlay.querySelector('[data-lv]'), { key: 'swarm-service', fileName: `${s.name}-logs`, height: '60vh', live: true, poll: 5000, liveDefault: false,
      desc: 'docker service logs — every task in one place; the source is task @ server.', empty: 'No log lines yet.',
      load: async (limit) => { const r = await API.get(`/swarm/services/${s.id}/logs?tail=${limit}`); return { rows: r.rows }; } });
  }
  async function tasksDialog(s) {
    const m = showModal(`Tasks · ${esc(s.name)}`, '<div data-t class="text-sm text-muted">Loading…</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    try {
      const { tasks } = await API.get(`/swarm/services/${s.id}/tasks`);
      m.overlay.querySelector('[data-t]').innerHTML = `<div class="ui-sub" style="margin-bottom:6px">Where each task ran, and when and why it stopped. Swarm keeps a few old tasks per slot (Cluster settings → Task history).</div>` + UI.table([{ label: 'Task' }, { label: 'Server' }, { label: 'State' }, { label: 'Why' }, { label: 'Image' }, { label: 'When' }, { label: '', align: 'right' }],
        tasks.map(t => ({ cells: [`${esc(s.name)}${t.slot ? '.' + t.slot : ''}<div class="ui-sub td-mono">${esc(t.id.slice(0, 12))}</div>`, esc(t.node), `${UI.pill(t.state === 'running' ? 'ok' : ['failed', 'rejected'].includes(t.state) ? 'bad' : ['shutdown', 'complete'].includes(t.state) ? 'off' : 'warn', esc(t.state))}<div class="ui-sub">wanted: ${esc(t.desired)}</div>`,
          `<span class="text-sm">${esc(t.error || t.message)}${t.exitCode ? ` · exit code ${t.exitCode}${t.exitCode === 137 ? ' (killed: memory limit or stop timeout)' : ''}` : ''}</span>`, `<span class="td-mono text-sm">${esc(t.image)}</span>`, `<span class="ui-sub" title="${esc(formatTime(t.updatedAt))}">${esc(timeAgo(t.updatedAt))}</span>`,
          `<span style="white-space:nowrap">${t.state === 'running' && t.containerId ? UI.btn('Terminal', `data-term="${esc(t.id)}"`) : ''} ${UI.btn('Inspect', `data-insp="${esc(t.id)}"`)}</span>`] })), { minWidth: 900 });
      const el = m.overlay.querySelector('[data-t]');
      el.querySelectorAll('[data-term]').forEach(b => b.onclick = () => { const t = tasks.find(x => x.id === b.dataset.term); SwarmUI.terminal({ containerId: t.containerId, serverId: t.serverId, node: t.node, title: `${s.name}${t.slot ? '.' + t.slot : ''} @ ${t.node}` }); });
      el.querySelectorAll('[data-insp]').forEach(b => b.onclick = () => SwarmUI.inspect('task', b.dataset.insp, `task ${b.dataset.insp.slice(0, 12)}`));
    } catch (e) { m.overlay.querySelector('[data-t]').innerHTML = UI.errorState(e, { compact: true }); }
  }
  function graphsDialog(s) {
    const m = showModal(`Graphs · ${esc(s.name)}`, `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><select class="select" data-h style="width:auto"><option value="1">Last hour</option><option value="6" selected>Last 6 hours</option><option value="24">Last 24 hours</option><option value="48">Last 48 hours</option></select><span class="ui-sub">All running tasks summed, every 2 minutes. DockGate records while the server in use is a manager of this swarm.</span></div>
      <div class="ui-label">CPU</div><div style="height:180px"><canvas data-cpu></canvas></div>
      <div class="ui-label" style="margin-top:12px">Memory</div><div style="height:180px"><canvas data-mem></canvas></div>
      <div data-empty class="ui-sub" style="margin-top:8px"></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const cs = getComputedStyle(document.documentElement);
    const grid = cs.getPropertyValue('--border').trim() || 'rgba(128,128,128,.2)', tick = cs.getPropertyValue('--text-muted').trim() || '#888';
    let charts = [];
    const draw = async () => {
      let r; try { r = await API.get(`/swarm/services/${s.id}/history?hours=${m.overlay.querySelector('[data-h]').value}`); } catch (e) { m.overlay.querySelector('[data-empty]').textContent = e.message; return; }
      charts.forEach(c => c.destroy()); charts = [];
      const labels = r.samples.map(x => new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      m.overlay.querySelector('[data-empty]').textContent = r.samples.length ? `${r.samples.length} samples` : 'No samples yet — the first one is taken within 2 minutes after DockGate starts.';
      const opts = (fmt) => ({ responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) } } },
        scales: { x: { ticks: { color: tick, maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, font: { size: 10 }, callback: fmt } } },
        elements: { point: { radius: 0 }, line: { tension: 0.25, borderWidth: 2 } } });
      charts.push(new Chart(m.overlay.querySelector('[data-cpu]'), { type: 'line', data: { labels, datasets: [{ data: r.samples.map(x => x.cpu), borderColor: '#00b37e', backgroundColor: 'rgba(0,179,126,0.12)', fill: true }] }, options: opts(v => `${Math.round(v * 10) / 10}%`) }));
      charts.push(new Chart(m.overlay.querySelector('[data-mem]'), { type: 'line', data: { labels, datasets: [{ data: r.samples.map(x => x.mem), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', fill: true }] }, options: opts(v => formatBytes(v)) }));
    };
    m.overlay.querySelector('[data-h]').onchange = draw;
    draw();
  }
  function trafficDialog(s) {
    const ing = s.ports.filter(p => p.mode === 'ingress'), host = s.ports.filter(p => p.mode === 'host');
    const running = s.tasks.filter(t => t.state === 'running');
    showModal(`Traffic · ${esc(s.name)}`, `
      <p class="text-sm"><b>Inside the cluster</b> other services reach it by name <span class="td-mono">${esc(s.name)}</span>${s.endpointMode === 'vip' ? ` — one virtual IP${s.vips.length ? ` (${s.vips.map(esc).join(', ')})` : ''}; Swarm spreads connections over the ${running.length} running task${running.length === 1 ? '' : 's'}.` : ' — DNS round robin: the name returns every task\'s address and the client picks one.'}</p>
      ${ing.length ? `<p class="text-sm"><b>Ingress ports</b> ${ing.map(p => `<span class="td-mono">${p.published}→${p.target}/${p.protocol}</span>`).join(', ')}: every server in the cluster answers on the port (routing mesh) and passes the connection to a task, possibly on another server. The app sees an internal address as the client, not the visitor's IP.</p>` : ''}
      ${host.length ? `<p class="text-sm"><b>Host ports</b> ${host.map(p => `<span class="td-mono">${p.published || '?'}→${p.target}/${p.protocol}</span>`).join(', ')}: only the servers that run a task answer, and the app sees the real client IP. Put a load balancer or DNS in front of those servers.</p>` : ''}
      ${!s.ports.length ? '<p class="text-sm">No published ports: only other services on the same overlay network can reach it.</p>' : ''}
      ${UI.table([{ label: 'Task' }, { label: 'Server' }, { label: 'State' }], s.tasks.map(t => ({ cells: [`${esc(s.name)}${t.slot ? '.' + t.slot : ''}`, esc(t.node), UI.pill(t.state === 'running' ? 'ok' : 'warn', esc(t.state))] })), { minWidth: 0 })}
      <p class="ui-sub" style="margin-top:8px">Sticky sessions and weighted (canary) routing are not part of Swarm — put Traefik or Caddy in front for that.</p>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
  }

  // One action on a service, from the list or the service page. load(kind) runs after it; kind 'removed' after Remove.
  function serviceAction(a, s, load = () => {}) {
    if (!s) return;
    if (a === 'scale') return scaleDialog(s, load);
    if (a === 'image') return imageDialog(s, load);
    if (a === 'newest') return secConfirm({ title: `Update ${s.name} to the newest image`, change: `The registry has a newer build of <span class="td-mono">${esc(s.image)}</span>${s.newer.version ? ` (${esc(s.newer.version)})` : ''}. Its tasks are replaced one at a time with exactly that build on every server.`, protects: 'If new tasks fail, the service goes back by itself (its update settings). Volumes stay.', undo: 'Roll back to previous.', confirmLabel: 'Update', onConfirm: async () => { try { const r = await API.post(`/swarm/services/${s.id}/update-newest`, {}); if (r.current) { showToast('Already the newest build'); load(); } else watch(s.id, `Update ${s.name}`, load); } catch (e) { showToast(e.message, 'error', 9000); } } });
    if (a === 'logs') return logsDialog(s);
    if (a === 'tasks') return tasksDialog(s);
    if (a === 'traffic') return trafficDialog(s);
    if (a === 'graphs') return graphsDialog(s);
    if (a === 'inspect') return SwarmUI.inspect('service', s.id, s.name);
    if (a === 'settings') return openForm({ id: s.id, onDone: load });
    if (a === 'rollback') return secConfirm({ title: `Roll back ${s.name}`, change: 'The service goes back to its previous settings and image (docker service rollback), using its roll back settings.', protects: 'Volumes stay. Tasks are replaced the same way as an update.', undo: 'Roll back again returns to the version before.', confirmLabel: 'Roll back', onConfirm: async () => { try { await API.post(`/swarm/services/${s.id}/rollback`, {}); watch(s.id, `Roll back ${s.name}`, load); } catch (e) { showToast(e.message, 'error', 9000); } } });
    if (a === 'restart') return secConfirm({ title: `Restart ${s.name}`, change: 'Every task is replaced, one at a time, with the same settings (docker service update --force).', protects: 'With start-first updates the service keeps answering while it restarts.', undo: 'Not needed.', confirmLabel: 'Restart', onConfirm: async () => { try { await API.post(`/swarm/services/${s.id}/restart`, {}); watch(s.id, `Restart ${s.name}`, load); } catch (e) { showToast(e.message, 'error', 9000); } } });
    if (a === 'remove') return showDeleteConfirm(`Remove ${s.name}`, { message: `The service and its ${s.desired} task${s.desired === 1 ? '' : 's'} are removed. Volumes stay on the servers.${s.stack ? ` It belongs to stack <b>${esc(s.stack)}</b>: the next deploy of the stack creates it again.` : ''}`, phrase: s.name, confirmLabel: 'Remove',
      onConfirm: async () => { try { await API.del(`/swarm/services/${s.id}`); showToast(`${s.name} removed`); load('removed'); } catch (e) { showToast(e.message, 'error', 9000); } } });
  }
  window.SwarmUI.serviceAction = serviceAction;
  window.SwarmUI.openServiceForm = openForm;
  window.SwarmUI.watchService = watch;
  window.SwarmUI.svcCss = css;

  // ---- the list ----
  Router.register('swarm-services', async (content) => {
    css();
    const navId = Router._navId;
    let timer = null, data = [];
    const stop = () => clearTimeout(timer);
    async function load() {
      if (!Router.isActiveNav(navId) || !content.isConnected) return stop();
      let st = { services: {} };
      try { [data, st] = await Promise.all([API.get('/swarm/services').then(r => r.services), API.get('/swarm/services/stats').catch(() => ({ services: {} }))]); }
      catch (e) {
        content.innerHTML = UI.header('Services', esc(e.message), UI.btn('Open Overview', 'data-go'));
        content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' });
        return;
      }
      if (!Router.isActiveNav(navId)) return;
      const rowsHtml = data.map(s => {
        const upd = s.update && UPD[s.update.state];
        const menu = [
          { label: 'Open', attrs: `data-open-svc="${s.id}"` },
          '-',
          s.mode === 'replicated' ? { label: 'Scale…', attrs: `data-a="scale" data-id="${s.id}"` } : null,
          s.newer && s.newer.status === 'update' ? { label: 'Update to newest…', attrs: `data-a="newest" data-id="${s.id}"` } : null,
          { label: 'Update image…', attrs: `data-a="image" data-id="${s.id}"` },
          s.hasPrevious ? { label: 'Roll back to previous', attrs: `data-a="rollback" data-id="${s.id}"` } : null,
          { label: 'Restart (one by one)', attrs: `data-a="restart" data-id="${s.id}"` },
          '-',
          { label: 'Logs', attrs: `data-a="logs" data-id="${s.id}"` },
          { label: 'Tasks', attrs: `data-a="tasks" data-id="${s.id}"` },
          { label: 'Traffic', attrs: `data-a="traffic" data-id="${s.id}"` },
          { label: 'Graphs', attrs: `data-a="graphs" data-id="${s.id}"` },
          { label: 'Settings…', attrs: `data-a="settings" data-id="${s.id}"` },
          { label: 'Inspect (JSON)', attrs: `data-a="inspect" data-id="${s.id}"` },
          '-',
          { label: 'Remove…', attrs: `data-a="remove" data-id="${s.id}"` },
        ];
        return { cells: [
          `<a href="#" class="td-name" data-open-svc="${s.id}" title="Open the service: tasks, logs, terminal, files, settings"><b>${esc(s.name)}</b></a>${s.stack ? ` ${UI.chip(`stack ${esc(s.stack)}`)}` : ''}${s.database ? ' <span class="ui-sub">database</span>' : ''}`,
          `<span class="td-mono text-sm">${esc(s.image)}</span>${s.newer ? (s.newer.status === 'update' ? `<div>${UI.pill('info', 'newer image')}${s.newer.version ? ` <span class="ui-sub">${esc(s.newer.version)}</span>` : ''}</div>` : s.newer.status === 'error' ? `<div class="ui-sub" title="${esc(s.newer.error || '')}">check failed</div>` : '') : ''}`,
          `<span class="text-sm">${esc(s.mode)}</span>`,
          `<b style="color:${s.running < s.desired ? 'var(--warning,#d97706)' : 'inherit'}">${s.running}/${s.desired}</b><div style="margin-top:3px">${s.tasks.slice(0, 24).map(t => `<span class="svc-sq ${esc(t.state)}" title="${esc(`${s.name}${t.slot ? '.' + t.slot : ''} · ${t.state}${t.node ? ' · ' + t.node : ''}${t.error ? ' · ' + t.error : ''}`)}"></span>`).join('')}</div>`,
          (() => { const x = st.services[s.id]; return x ? `<span class="text-sm">${x.cpu}%</span> · <span class="text-sm">${formatBytes(x.memBytes)}</span><div class="ui-sub">${x.tasks} task${x.tasks === 1 ? '' : 's'} measured</div>` : '<span class="ui-sub">—</span>'; })(),
          s.ports.length ? s.ports.map(p => `<span class="td-mono text-sm">${p.published || ''}${p.published ? '→' : ''}${p.target}/${p.protocol}</span>${p.mode === 'host' ? ' <span class="ui-sub">host</span>' : ''}`).join('<br>') : '<span class="ui-sub">—</span>',
          `${upd ? UI.pill(upd[0], upd[1]) : '<span class="ui-sub">—</span>'}${s.update && s.update.message && s.update.state !== 'completed' ? `<div class="ui-sub" style="max-width:240px;white-space:normal">${esc(s.update.message)}</div>` : ''}${s.problem ? `<div class="text-sm" style="color:var(--danger,#dc2626);max-width:280px;white-space:normal">${esc(s.problem)}</div>` : ''}`,
          UI.menu(menu),
        ] };
      });
      content.innerHTML = `${UI.header('Services', `${data.length} service${data.length === 1 ? '' : 's'}. Updates replace tasks one at a time and go back by themselves when a new task fails (each service's update settings).`, `${UI.btn('Check for updates', 'data-check')} ${UI.primary('New service…', 'data-new')}`)}
        ${UI.table([{ label: 'Service' }, { label: 'Image' }, { label: 'Mode' }, { label: 'Tasks' }, { label: 'CPU · Memory' }, { label: 'Ports' }, { label: 'Last update' }, { label: '', align: 'right' }], rowsHtml, { minWidth: 1060, empty: 'No services yet. Create one with New service…, or deploy a stack (next version).' })}`;
      content.querySelector('[data-new]').onclick = () => openForm({ onDone: load });
      content.querySelector('[data-check]').onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
        try {
          const r = await API.post('/swarm/services/check-images', {});
          const n = r.services.filter(x => x.newer && x.newer.status === 'update').length;
          const f = r.services.filter(x => x.newer && x.newer.status === 'error').length;
          showToast(n ? `${n} service${n === 1 ? ' has' : 's have'} a newer image` : 'All service images are up to date', n ? 'info' : 'success');
          if (f) showToast(`${f} could not be checked — hover "check failed" for the reason`, 'warning', 8000);
          load();
        } catch (er) { showToast(er.message, 'error', 9000); b.disabled = false; b.textContent = 'Check for updates'; }
      };
      content.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => serviceAction(b.dataset.a, data.find(x => x.id === b.dataset.id), load)));
      content.querySelectorAll('[data-open-svc]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('swarm-service', { id: a.dataset.openSvc }); }));
      stop(); timer = setTimeout(load, 5000);
    }
    await load();
    return stop;
  });
})();
