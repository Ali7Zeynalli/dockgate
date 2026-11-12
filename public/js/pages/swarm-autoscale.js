// Swarm → Auto Scaling: every autoscale rule in one place (server/swarm-autoscale.js).
//   Capacity  — CPU and memory of the active servers, what services reserve, what is free.
//   Rules     — one row per service: replicas, CPU and memory now, when it adds and removes, room, state.
//   History   — every change autoscale made, on every service.
//   A 4-step dialog makes or changes a rule, for one service or several sharing it (each judged by its own load).
(() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const MB = 1048576, GB = 1073741824;
  const fmtCpu = (v) => `${Math.round(v * 100) / 100} CPU`;
  const usage = (v) => (v == null ? '<span class="ui-sub">—</span>' : `<span class="text-sm" style="color:${v >= 80 ? 'var(--danger)' : v >= 65 ? 'var(--warning)' : 'inherit'}">${v}%</span>`);
  // Same as the server's room(): replicas with this guarantee that fit, server by server.
  const roomFor = (cap, cpuRes, memRes) => (!cpuRes && !memRes ? null : cap.nodes.filter(n => n.active).reduce((a, n) => a + Math.max(0, Math.min(cpuRes ? Math.floor((n.cpu - n.cpuReserved) / cpuRes + 1e-9) : Infinity, memRes ? Math.floor((n.mem - n.memReserved) / memRes) : Infinity)), 0));
  const upText = (r) => `CPU &gt; ${r.cpuUp}%${r.memUp !== null ? ` <b>${r.logic}</b> memory &gt; ${r.memUp}%` : ''} · ${r.upMinutes} min`;
  const downText = (r) => `CPU &lt; ${r.cpuDown}%${r.memDown !== null ? ` and memory &lt; ${r.memDown}%` : ''} · ${r.downMinutes} min`;

  Router.register('swarm-scaling', async (content, params) => {
    window.SwarmUI && SwarmUI.css && SwarmUI.css();
    const navId = Router._navId;
    let timer = null, data = null, filter = '', openedEdit = false;
    const stop = () => clearTimeout(timer);

    async function load() {
      if (!Router.isActiveNav(navId) || !content.isConnected) return stop();
      try { data = await API.get('/swarm/autoscale'); }
      catch (e) { content.innerHTML = UI.header('Auto Scaling', esc(e.message), UI.btn('Open Overview', 'data-go')); content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' }); return; }
      if (!Router.isActiveNav(navId)) return;
      if (document.querySelector('#modal-root .modal-overlay')) { stop(); timer = setTimeout(load, 15000); return; } // do not redraw under an open dialog
      render();
      if (params && params.edit && !openedEdit) { openedEdit = true; const r = data.rules.find(x => x.serviceId === params.edit); ruleDialog(r ? [r.serviceId] : [params.edit], r || null); }
      stop(); timer = setTimeout(load, 15000);
    }

    function render() {
      const cap = data.capacity;
      const card = (label, used, total, fmt) => { const p = total ? Math.round(used / total * 100) : 0; return `<div class="sw-card"><div class="ui-sub">${label}</div><div style="font-size:18px;font-weight:600">${fmt(used)} of ${fmt(total)}</div><div style="height:6px;border-radius:9px;background:var(--bg-primary);margin-top:6px;overflow:hidden"><div style="width:${Math.min(p, 100)}%;height:100%;background:${p >= 85 ? 'var(--danger)' : p >= 70 ? 'var(--warning)' : 'var(--accent)'}"></div></div></div>`; };
      const act = cap.nodes.filter(n => n.active), off = cap.nodes.filter(n => !n.active);
      const rows = data.rules.map(r => ({ cells: [
        `<a href="#" class="td-name" data-svc="${esc(r.serviceId)}"><b>${esc(r.serviceName)}</b></a>`,
        `<b>${r.replicas}</b> <span class="ui-sub">${r.min}–${r.max}${r.step > 1 ? ` · ±${r.step}` : ''}</span>`,
        r.now ? `${usage(r.now.cpu)} · ${r.now.mem != null ? usage(r.now.mem) : '<span class="ui-sub">no memory limit</span>'}<div class="ui-sub">${r.basis === 'every' ? 'every replica' : 'average'} · ${r.now.measured}/${r.now.tasks} measured</div>` : '<span class="ui-sub">first reading soon</span>',
        `<div class="text-sm" style="white-space:normal;min-width:220px"><span class="ui-sub">add</span> ${upText(r)}</div><div class="text-sm" style="white-space:normal"><span class="ui-sub">remove</span> ${downText(r)}</div>`,
        `<span class="td-mono text-sm">${r.limits.cpu ? fmtCpu(r.limits.cpu) : 'no CPU limit'} · ${r.limits.mem ? formatBytes(r.limits.mem) : 'no memory limit'}</span>${r.limits.cpuRes || r.limits.memRes ? `<div class="ui-sub">min ${r.limits.cpuRes ? fmtCpu(r.limits.cpuRes) : '0'} · ${formatBytes(r.limits.memRes || 0)}</div>` : '<div class="ui-sub" style="color:var(--warning)">no guarantee: room unknown</div>'}`,
        `<div style="white-space:normal;max-width:170px">${UI.pill(...r.state)}</div><div class="ui-sub" style="margin-top:4px">${r.room == null ? 'room unknown' : `room: ${r.room} more fit`}</div>`,
        UI.menu([{ label: 'Edit…', attrs: `data-edit="${esc(r.serviceId)}"` }, { label: r.enabled ? 'Pause' : 'Resume', attrs: `data-tog="${esc(r.serviceId)}" data-on="${r.enabled ? 0 : 1}"` }, { label: 'Open service', attrs: `data-svc="${esc(r.serviceId)}"` }, '-', { label: 'Remove rule…', attrs: `data-del="${esc(r.serviceId)}" data-name="${esc(r.serviceName)}"` }]),
      ] }));
      const hist = data.history.filter(h => !filter || h.serviceId === filter);
      content.innerHTML = `${UI.header('Auto Scaling', 'Docker Swarm does not scale by itself. DockGate checks each service with a rule every ' + (data.interval === 30 ? '30 seconds' : 'minute') + ' and adds or removes replicas by its <b>own</b> CPU and memory: only the busy service changes. Swarm spreads the traffic over the replicas through the ingress network.',
          `${UI.btn('Settings…', 'data-settings')} ${UI.btn(data.paused ? 'Resume all' : 'Pause all', 'data-pauseall')} ${UI.primary('Add a rule…', 'data-add')}`)}
        ${data.paused ? '<div class="insight-card warning" style="margin-bottom:12px"><div><b>Autoscale is paused for every service.</b> Replicas stay as they are until you resume.</div></div>' : ''}
        <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Cluster capacity</div><div class="ui-ph-desc">What the active servers have, what running services reserve (guarantee), and what is free for new replicas.${off.length ? ` ${off.map(n => esc(n.hostname)).join(', ')} ${off.length > 1 ? 'are' : 'is'} paused, drained or down and ${off.length > 1 ? 'get' : 'gets'} no new replicas.` : ''}</div></div></div>
        <div class="sw-cards">${card('CPU reserved', cap.cpuReserved, cap.cpu, fmtCpu)}${card('Memory reserved', cap.memReserved, cap.mem, (v) => formatBytes(v))}
          <div class="sw-card"><div class="ui-sub">Free for new replicas</div><div style="font-size:18px;font-weight:600">${fmtCpu(cap.cpuFree)} · ${formatBytes(cap.memFree)}</div><div class="ui-sub">${act.map(n => `${esc(n.hostname)} ${fmtCpu(Math.max(0, n.cpu - n.cpuReserved))} · ${formatBytes(Math.max(0, n.mem - n.memReserved))}`).join(' — ')}</div></div></div>
        <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Rules</div><div class="ui-ph-desc">One row per service. "Room" is how many more replicas fit with the guarantee each replica has.</div></div></div>
        ${UI.table([{ label: 'Service' }, { label: 'Replicas' }, { label: 'CPU · memory now' }, { label: 'Scales when' }, { label: 'Each replica' }, { label: 'State' }, { label: '', align: 'right' }], rows, { minWidth: 960, empty: 'No rules yet. Add a rule to let a service grow and shrink with its load.' })}
        <div class="ui-ph" style="margin-top:16px"><div class="ui-ph-text"><div class="ui-ph-title">History</div><div class="ui-ph-desc">Every change autoscale made, last 30 days. Also in Observe → Audit log and the <i>Swarm autoscale</i> notification.</div></div>
          <select class="select" data-filter style="width:auto"><option value="">All services</option>${data.rules.map(r => `<option value="${esc(r.serviceId)}" ${filter === r.serviceId ? 'selected' : ''}>${esc(r.serviceName)}</option>`).join('')}</select></div>
        ${UI.table([{ label: 'When' }, { label: 'Service' }, { label: 'Replicas' }, { label: 'Why' }], hist.map(h => ({ cells: [`<span class="ui-sub" title="${esc(formatTime(new Date(h.t).toISOString()))}">${esc(timeAgo(new Date(h.t).toISOString()))}</span>`, `<b>${esc(h.service || '')}</b>`, `${h.ok ? '' : UI.pill('bad', /^not placed/.test(h.reason) ? 'not placed' : 'failed') + ' '}${h.from} → ${h.to}`, `<span class="text-sm">${esc(h.reason)}</span>`] })), { minWidth: 640, empty: 'No changes yet.' })}
        <div class="ui-sub" style="margin-top:8px">Not offered for global services and databases. Autoscale does not create servers: a replica that fits on no server waits as pending, and you are told.</div>`;
      content.querySelector('[data-add]').onclick = () => ruleDialog([], null);
      content.querySelector('[data-settings]').onclick = settingsDialog;
      content.querySelector('[data-pauseall]').onclick = async () => { try { await API.put('/swarm/autoscale/settings', { paused: !data.paused }); showToast(data.paused ? 'Autoscale resumed' : 'Autoscale paused for every service'); load(); } catch (e) { showToast(e.message, 'error'); } };
      content.querySelector('[data-filter]').onchange = (e) => { filter = e.target.value; render(); };
      content.querySelectorAll('[data-svc]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('swarm-service', { id: a.dataset.svc, tab: 'autoscale' }); }));
      content.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { const r = data.rules.find(x => x.serviceId === b.dataset.edit); ruleDialog([r.serviceId], r); }));
      content.querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', async () => { try { await API.post(`/swarm/services/${encodeURIComponent(b.dataset.tog)}/autoscale/enabled`, { on: b.dataset.on === '1' }); load(); } catch (e) { showToast(e.message, 'error'); } }));
      content.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => showDeleteConfirm(`Remove the autoscale rule of ${b.dataset.name}`, { message: 'Autoscale stops for this service. Its replicas stay as they are now.', phrase: b.dataset.name, confirmLabel: 'Remove',
        onConfirm: async () => { try { await API.del(`/swarm/services/${encodeURIComponent(b.dataset.del)}/autoscale`); showToast('Rule removed'); load(); } catch (e) { showToast(e.message, 'error'); } } })));
    }

    function settingsDialog() {
      UI.dialog({ title: 'Auto Scaling settings', body: UI.settings([
        { label: 'Check every', desc: 'how often every rule is checked', value: `<select class="select" data-int style="width:auto"><option value="60" ${data.interval === 60 ? 'selected' : ''}>1 minute</option><option value="30" ${data.interval === 30 ? 'selected' : ''}>30 seconds</option></select>` },
        { label: 'When a replica does not fit', desc: 'no active server has the guarantee free', value: `<select class="select" data-pend style="width:auto"><option value="wait" ${data.pending === 'wait' ? 'selected' : ''}>Add it anyway: it waits as pending, you are told</option><option value="skip" ${data.pending === 'skip' ? 'selected' : ''}>Add no more until the waiting one is placed</option></select>` },
        { label: 'Notifications', desc: 'the "Swarm autoscale changed a service" rule in Settings → Notifications', action: UI.btn('Open', 'data-notif') }]),
        onOpen: (ov) => { ov.querySelector('[data-notif]').onclick = () => Router.navigate('settings', { tab: 'notifications' }); },
        onSave: async (ov) => { await API.put('/swarm/autoscale/settings', { interval: Number(ov.querySelector('[data-int]').value), pending: ov.querySelector('[data-pend]').value }); showToast('Saved'); load(); } });
    }

    // ---- help shown by the ? next to each field ----
    const HELP = {
      services: ['Services', 'The services this rule is for. Several can share one rule, but each is still measured on its own: only the busy one gets more replicas. Global services (one task per server) and databases are not offered.'],
      cpuLimit: ['CPU limit', 'The most CPU one replica may use, in cores: 0.5 is half a core. CPU % is measured against this limit, so "CPU above 80%" means 0.4 of 0.5. Too high a limit and the service never looks busy; too low and it is slowed down. A good start: 1.5× what one replica uses at busy times.'],
      memLimit: ['Memory limit', 'The most memory one replica may use, in MB. A replica that goes over is stopped by Docker and started again. Needed for a memory rule, since memory % is measured against it. A good start: 1.5× the highest use of one replica.'],
      cpuReserve: ['CPU guaranteed', 'CPU that Swarm keeps free for each replica (reservation). Swarm places a replica only on a server that still has this much free, and DockGate uses it to count how many more replicas fit. Set it to what one replica usually uses.'],
      memReserve: ['Memory guaranteed', 'Memory that Swarm keeps free for each replica. Like the CPU guarantee, it decides where a replica can go and how many more fit. Set it to what one replica usually uses.'],
      cpuUp: ['Add at CPU %', 'Add a replica when the CPU per replica stays above this % of its limit for the minutes on the right. 70–80% leaves room for a spike while the new replica starts.'],
      memOn: ['Memory too', 'Also look at memory. "or": memory alone can add a replica (apps that need more memory under load). "and": both CPU and memory must be high (stops a memory-hungry but idle app from growing). Needs a memory limit.'],
      memUp: ['Add at memory %', 'With memory on: add a replica when memory per replica stays above this % of its limit.'],
      upMinutes: ['Add after', 'How long the load must stay high before a replica is added. Short (1–3 min) reacts fast but may react to a brief spike; 5 min is a safe default.'],
      basis: ['Measured as', '"The average": the mean of all replicas — the usual choice. "Every replica is busy": the least busy replica must be over the limit, so one stuck or hot replica (a long report, a loop) does not add more.'],
      cpuDown: ['Remove at CPU %', 'Remove a replica when CPU stays below this %. Must be at least 10 below the add %, or the service would go up and down.'],
      memDown: ['Remove at memory %', 'With memory on: memory must also be below this % to remove. Many apps keep memory after the load is gone, so CPU and memory must both be low.'],
      downMinutes: ['Remove after', 'How long the load must stay low before a replica is removed. Longer than "add after" (10 min by default), so a short quiet moment does not shrink the service.'],
      stepN: ['Replicas per change', 'How many replicas are added or removed at once (1–5). 1 is gentle; 2–3 helps a service that gets sudden large traffic.'],
      coolUp: ['Wait after adding', 'After adding, wait this long before the next change, so new replicas start and take traffic before DockGate looks again.'],
      coolDown: ['Wait after removing', 'After removing, wait this long before the next change.'],
      min: ['Minimum replicas', 'Never fewer. Keep at least 2 for a service that must stay up while a server restarts. A service below the minimum is raised at once.'],
      max: ['Maximum replicas', 'Never more. Keep it within what the servers can hold — the check below tells whether it fits. A service above the maximum is lowered at once.'],
      spread: ['Spread over the servers', 'Placement preference spread=node.id: Swarm puts replicas on different servers, so one server going down does not take all of them.'],
      enabled: ['Turn on now', 'Off saves the rule paused: the limits are set now, scaling starts when you resume it.'],
      suggest: ['Suggested values', 'DockGate keeps the CPU and memory of every service for 48 hours (Services → Graphs). From that it suggests the limits (1.5× busy use), the guarantees (usual use) and the range (usual load → minimum, busiest moment × 1.5 → maximum, cut to what fits). It needs about an hour of readings. Change any value you like.'],
    };
    const q = (k) => (HELP[k] ? `<button type="button" class="as-q" data-help="${k}" title="What is this?">?</button>` : '');
    if (!document.getElementById('as-help-css')) {
      const st = document.createElement('style'); st.id = 'as-help-css';
      st.textContent = `.as-q{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:5px;border-radius:50%;border:1px solid var(--border-color,#3a4560);background:transparent;color:var(--text-secondary,#9aa4b8);font-size:10px;font-weight:700;line-height:1;cursor:pointer;padding:0;vertical-align:middle}
.as-q:hover,.as-q.on{background:var(--accent);border-color:var(--accent);color:#fff}
.as-pop{position:fixed;z-index:10001;max-width:340px;padding:10px 12px;border-radius:10px;background:var(--bg-secondary,#1b2436);border:1px solid var(--border-color,#3a4560);box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:12.5px;line-height:1.5;color:var(--text-primary)}
.as-pop b{display:block;margin-bottom:3px}
.as-sug{color:var(--accent)}`;
      document.head.appendChild(st);
    }

    // ---- the rule dialog: Services → Each replica → When to scale → Limits and check ----
    function ruleDialog(serviceIds, existing) {
      const d = data.defaults;
      const first = data.services.find(s => s.id === serviceIds[0]);
      const lim = first ? first.limits : { cpu: 0, mem: 0, cpuRes: 0, memRes: 0 };
      const W = {
        step: existing ? 1 : (serviceIds.length ? 1 : 0), svcs: [...serviceIds],
        cpuLimit: lim.cpu || '', memLimit: lim.mem ? Math.round(lim.mem / MB) : '', cpuReserve: lim.cpuRes || '', memReserve: lim.memRes ? Math.round(lim.memRes / MB) : '',
        cpuUp: existing ? existing.cpuUp : 80, memOn: existing ? existing.memUp !== null : false, memUp: existing && existing.memUp !== null ? existing.memUp : 70, logic: existing ? existing.logic : 'or', basis: existing ? existing.basis : 'average', upMinutes: existing ? existing.upMinutes : d.upMinutes,
        cpuDown: existing ? existing.cpuDown : 30, memDown: existing && existing.memDown !== null ? existing.memDown : 40, downMinutes: existing ? existing.downMinutes : d.downMinutes,
        stepN: existing ? existing.step : 1, coolUp: existing ? existing.coolUpMinutes : d.coolUpMinutes, coolDown: existing ? existing.coolDownMinutes : d.coolDownMinutes,
        min: existing ? existing.min : Math.max(1, first ? first.replicas : 1), max: existing ? existing.max : Math.max(3, (first ? first.replicas : 1) + 2), spread: true, enabled: existing ? existing.enabled : true,
      };
      const STEPS = ['Services', 'Each replica', 'When to scale', 'Limits and check'];
      const m = showModal(existing ? `Autoscale rule of ${esc(existing.serviceName)}` : 'Add an autoscale rule', `${serverContextBanner()}<div data-rd></div><div data-rd-err class="text-sm" style="color:var(--danger);margin-top:8px"></div>`, []);
      m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
      const root = m.overlay.querySelector('[data-rd]'), err = m.overlay.querySelector('[data-rd-err]');
      const footer = m.overlay.querySelector('#modal-footer');
      const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.onclick = fn; footer.appendChild(b); return b; };
      mk('Cancel', 'btn-secondary', () => m.close());
      const back = mk('Back', 'btn-secondary', () => { read(); W.step--; draw(); });
      const next = mk('Next', 'btn-primary', () => go());
      const sugWhy = (k) => (W.sug && W.sug.values && W.sugApplied && W.sug.why[k] && String(W[k]) === String(W.sug.values[k]) ? W.sug.why[k] : '');
      const num = (k, label, hint = '', step = 1, extra = '') => { const why = sugWhy(k); return `<div class="ui-field" style="flex:1;min-width:150px"><span class="ui-label">${label}${q(k)}</span><input class="input" type="number" step="${step}" data-w="${k}" value="${esc(W[k])}" ${extra}>${why ? `<span class="ui-sub as-sug">suggested: ${esc(why)}</span>` : hint ? `<span class="ui-sub">${hint}</span>` : ''}</div>`; };
      // the ? popover
      let pop = null;
      const closePop = () => { if (pop) { pop.remove(); pop = null; } m.overlay.querySelectorAll('.as-q.on').forEach(x => x.classList.remove('on')); };
      m.overlay.addEventListener('click', (e) => {
        const b = e.target.closest('.as-q');
        if (!b) { if (!e.target.closest('.as-pop')) closePop(); return; }
        e.preventDefault(); e.stopPropagation();
        const was = b.classList.contains('on'); closePop(); if (was) return;
        const [t, txt] = HELP[b.dataset.help];
        pop = document.createElement('div'); pop.className = 'as-pop'; pop.innerHTML = `<b>${esc(t)}</b>${esc(txt)}`;
        document.body.appendChild(pop); b.classList.add('on');
        const r = b.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 12));
        const top = r.bottom + 8 + h > window.innerHeight ? r.top - h - 8 : r.bottom + 8;
        pop.style.left = `${left}px`; pop.style.top = `${top}px`;
      }, true);
      const oldClose = m.close; m.close = (...a) => { closePop(); return oldClose(...a); };
      // suggestions from the last 48 hours
      async function suggest(apply) {
        W.sugBusy = true; draw();
        try { W.sug = await API.post('/swarm/autoscale/suggest', { services: W.svcs }); W.sugFor = W.svcs.join(','); }
        catch (e) { W.sug = { error: e.message }; }
        W.sugBusy = false;
        if (apply && W.sug.values) { const v = W.sug.values; Object.assign(W, { cpuLimit: v.cpuLimit, cpuReserve: v.cpuReserve, memLimit: v.memLimit, memReserve: v.memReserve, min: v.min, max: v.max, memOn: v.memOn }); W.sugApplied = true; }
        draw();
      }
      const sugBox = () => {
        if (W.sugBusy) return '<div class="insight-card info" style="margin-bottom:10px"><div>Reading the last 48 hours of use…</div></div>';
        if (!W.sug) return `<div style="margin-bottom:10px">${UI.btn('Suggest from use', 'data-sug')}${q('suggest')}</div>`;
        if (W.sug.error) return `<div class="insight-card warning" style="margin-bottom:10px"><div>Could not read the history: ${esc(W.sug.error)}</div></div>`;
        if (!W.sug.values) return `<div class="insight-card warning" style="margin-bottom:10px"><div><b>Not enough history yet.</b> Suggestions need about an hour of readings (one every 2 minutes); ${W.sug.per.map(x => `${esc(x.name)} has ${x.readings}`).join(', ')}. The usual values are shown.${q('suggest')}</div></div>`;
        return `<div class="insight-card success" style="margin-bottom:10px"><div><b>${W.sugApplied ? 'Suggested' : 'Suggestion ready'} from the last ${W.sug.hours} h of use.</b>${q('suggest')} ${W.sugApplied ? 'Change any value you like.' : ''}${W.sug.notes.length ? `<div class="ui-sub" style="margin-top:4px">${W.sug.notes.map(esc).join('<br>')}</div>` : ''}<div style="margin-top:6px">${UI.btn(W.sugApplied ? 'Suggest again' : 'Use the suggestion', 'data-sug')}</div></div></div>`;
      };
      function read() {
        root.querySelectorAll('[data-w]').forEach(i => { W[i.dataset.w] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value; });
        if (W.step === 0) W.svcs = [...root.querySelectorAll('[data-wsvc]:checked')].map(c => c.dataset.wsvc);
      }
      function draw() {
        err.textContent = '';
        back.style.display = W.step && !(existing && W.step === 1) ? '' : 'none';
        next.textContent = W.step === 3 ? (existing ? 'Save' : 'Turn on') : 'Next';
        const chosen = data.services.filter(s => W.svcs.includes(s.id));
        const head = `<div class="sw-steps">${STEPS.map((s, i) => `<span class="${i === W.step ? 'on' : i < W.step ? 'done' : ''}">${i < W.step ? '✓' : `${i + 1}.`} ${s}</span>`).join('')}</div>`;
        if (W.step === 0) {
          root.innerHTML = head + `<p class="text-sm text-muted">One service, or several that share this rule. Each is still judged by its own load: only the busy one changes.${q('services')}</p>`
            + data.services.map(s => `<label class="text-sm" style="display:block;margin:5px 0"><input type="checkbox" data-wsvc="${esc(s.id)}" ${W.svcs.includes(s.id) ? 'checked' : ''} ${s.database ? 'disabled' : ''}> <b>${esc(s.name)}</b> <span class="ui-sub">${s.database ? 'database — not offered' : `${s.replicas} replica${s.replicas === 1 ? '' : 's'} · ${esc(s.image)}${s.hasRule ? ' · has a rule (it is replaced)' : ''}${s.hasVolume ? ' · has a volume' : ''}`}</span></label>`).join('')
            + (data.services.length ? '' : '<div class="ui-sub">No replicated services on this swarm.</div>');
          return;
        }
        if (W.step === 1) {
          const vol = chosen.some(s => s.hasVolume);
          root.innerHTML = head + sugBox() + `<p class="text-sm text-muted">What each replica may use (limit) and what it is guaranteed. CPU and memory % are measured against the limit; the guarantee keeps Swarm from placing a replica where it does not fit, and tells how many more fit. Leave a field empty to keep what the service has.</p>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${num('cpuLimit', 'CPU limit', 'e.g. 0.5 — without one, % of one core', 0.05)}${num('memLimit', 'Memory limit (MB)', 'needed for a memory rule', 64)}${num('cpuReserve', 'CPU guaranteed', 'e.g. 0.25', 0.05)}${num('memReserve', 'Memory guaranteed (MB)', 'e.g. 256', 64)}</div>
            ${chosen.length > 1 ? '<div class="ui-sub" style="margin-top:6px">These values are set on every chosen service.</div>' : ''}
            ${vol ? '<div class="insight-card warning" style="margin-top:10px"><div><b>A chosen service mounts a volume or folder.</b> Each replica uses the volume of the server it runs on; a new replica on another server starts with an empty one. Fine for caches and stateless apps.</div></div>' : ''}`;
          root.querySelectorAll('[data-sug]').forEach(b => b.addEventListener('click', () => { read(); suggest(true); }));
          return;
        }
        if (W.step === 2) {
          root.innerHTML = head + `<div class="ui-label" style="margin-bottom:6px">Add a replica when</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">${num('cpuUp', 'CPU above (%)')}
              <label class="ui-field" style="min-width:150px"><span class="ui-label"><input type="checkbox" data-w="memOn" ${W.memOn ? 'checked' : ''}> and/or memory${q('memOn')}</span><select class="select" data-w="logic"><option value="or" ${W.logic === 'or' ? 'selected' : ''}>or</option><option value="and" ${W.logic === 'and' ? 'selected' : ''}>and</option></select></label>
              ${num('memUp', 'memory above (%)')}${num('upMinutes', 'for (minutes)')}</div>
            ${W.sugApplied && W.sug.why.memOn && W.memOn === W.sug.values.memOn ? `<div class="ui-sub as-sug" style="margin-top:4px">memory ${W.memOn ? 'on' : 'off'}, suggested: ${esc(W.sug.why.memOn)}</div>` : ''}
            <div class="text-sm" style="margin:10px 0">Measured as${q('basis')} ${UI.seg([['average', 'the average of the replicas'], ['every', 'every replica is busy']], W.basis, 'data-basis')}</div>
            <div class="ui-label" style="margin:10px 0 6px">Remove a replica when (all must be low)</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">${num('cpuDown', 'CPU below (%)')}${num('memDown', 'memory below (%)', 'with a memory rule')}${num('downMinutes', 'for (minutes)')}</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">${num('stepN', 'Replicas per change', '1 to 5')}${num('coolUp', 'Wait after adding (min)', 'lets new replicas settle')}${num('coolDown', 'Wait after removing (min)')}</div>
            <div class="ui-sub" style="margin-top:8px">"Every replica is busy" adds only when the least busy replica is over the limit: one stuck replica does not add more. Removing needs CPU <b>and</b> memory low, since many apps keep memory after the load is gone.</div>`;
          root.querySelectorAll('[data-basis]').forEach(b => b.addEventListener('click', () => { read(); W.basis = b.dataset.basis; draw(); }));
          return;
        }
        // step 3: limits and the capacity check
        const cpuRes = W.cpuReserve !== '' ? Number(W.cpuReserve) : (first ? first.limits.cpuRes : 0);
        const memRes = (W.memReserve !== '' ? Number(W.memReserve) * MB : (first ? first.limits.memRes : 0));
        const extra = chosen.reduce((a, s) => a + Math.max(0, Number(W.max) - s.replicas), 0);
        const fit = roomFor(data.capacity, cpuRes, memRes);
        const fits = fit == null ? null : fit >= extra;
        root.innerHTML = head + `<div style="display:flex;gap:10px;flex-wrap:wrap">${num('min', 'Minimum replicas', 'never fewer')}${num('max', 'Maximum replicas', 'never more')}</div>
          <label class="text-sm" style="display:block;margin:10px 0"><input type="checkbox" data-w="spread" ${W.spread ? 'checked' : ''}> Spread the replicas over the servers (placement preference <span class="td-mono">spread=node.id</span>)${q('spread')}</label>
          <label class="text-sm" style="display:block;margin:0 0 10px"><input type="checkbox" data-w="enabled" ${W.enabled ? 'checked' : ''}> Turn the rule on now${q('enabled')}</label>
          ${fits == null ? '<div class="insight-card warning"><div><b>Room unknown.</b> Set a CPU or memory guarantee (step 2) so DockGate can tell whether more replicas fit.</div></div>'
            : `<div class="insight-card ${fits ? 'success' : 'danger'}"><div><b>${fits ? 'Fits.' : 'Does not fit.'}</b> At the maximum, ${chosen.length > 1 ? `${chosen.length} services need` : 'it needs'} ${extra} more replica${extra === 1 ? '' : 's'}; ${fit} fit on the active servers with ${cpuRes ? fmtCpu(cpuRes) : 'no CPU'} and ${memRes ? formatBytes(memRes) : 'no memory'} guaranteed each.${fits ? '' : ' Lower the maximum or the guarantee, or add a server.'}</div></div>`}
          <div class="text-sm" style="margin-top:10px"><b>Summary:</b> ${chosen.map(s => esc(s.name)).join(', ')} · add ${W.stepN} when CPU &gt; ${W.cpuUp}%${W.memOn ? ` ${W.logic} memory &gt; ${W.memUp}%` : ''} for ${W.upMinutes} min (${W.basis === 'every' ? 'every replica' : 'average'}) · remove when CPU &lt; ${W.cpuDown}%${W.memOn ? ` and memory &lt; ${W.memDown}%` : ''} for ${W.downMinutes} min · ${W.min}–${W.max} replicas.</div>`;
        root.querySelectorAll('[data-w="max"],[data-w="min"]').forEach(i => i.addEventListener('change', () => { read(); draw(); }));
      }
      async function go() {
        read(); err.textContent = '';
        if (W.step === 0) { if (!W.svcs.length) { err.textContent = 'Choose at least one service.'; return; } }
        if (W.step === 2 && W.memOn && !W.memLimit && data.services.filter(s => W.svcs.includes(s.id)).some(s => !s.limits.mem)) { err.textContent = 'A memory rule needs a memory limit: set one in step 2 (Each replica).'; return; }
        if (W.step < 3) {
          W.step++;
          if (W.step === 1 && !existing && W.sugFor !== W.svcs.join(',')) { W.sug = null; W.sugApplied = false; suggest(true); return; }
          draw(); return;
        }
        next.disabled = true;
        try {
          const r = await API.put('/swarm/autoscale/rules', {
            services: W.svcs, enabled: W.enabled, min: W.min, max: W.max, cpuUp: W.cpuUp, cpuDown: W.cpuDown, memUp: W.memOn ? W.memUp : null, memDown: W.memOn ? W.memDown : null,
            logic: W.logic, basis: W.basis, step: W.stepN, upMinutes: W.upMinutes, downMinutes: W.downMinutes, coolUpMinutes: W.coolUp, coolDownMinutes: W.coolDown, spread: W.spread,
            resources: { cpuLimit: W.cpuLimit, memLimit: W.memLimit, cpuReserve: W.cpuReserve, memReserve: W.memReserve },
          });
          m.close(); showToast(`${W.enabled ? 'Autoscale is on' : 'Rule saved (paused)'}: ${r.saved.join(', ')}`); load();
        } catch (e) { err.textContent = e.message; next.disabled = false; }
      }
      if (!existing && W.step === 1) suggest(true); else draw();
    }

    await load();
    return stop;
  });
})();
