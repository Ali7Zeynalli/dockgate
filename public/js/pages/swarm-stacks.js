// Swarm → Stacks and Swarm → Migrate — phase 4.
//   Migrate: compose projects on the server in use, each Ready / Attention / Not possible with the reasons;
//            choose, set replicas / port mode / update order per service, review the plan (what changes for
//            Swarm, which volumes stay), then one job moves them one at a time and puts back any that fail.
//   Stacks:  stacks on Swarm — Redeploy (reads the compose files again), Settings, History (deploy an earlier
//            one again), Move back to Compose, Remove.
// The compose files are never changed. Server side: server/swarm-stacks.js.

(() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const STATUS = { ready: ['ok', 'Ready'], attention: ['warn', 'Attention'], impossible: ['bad', 'Not possible'] };
  const LV = { info: 'var(--text-muted)', warn: 'var(--warning,#d97706)', bad: 'var(--danger,#dc2626)' };
  const findings = (list) => list.map(f => `<div class="text-sm" style="color:${LV[f.level]};white-space:normal;min-width:220px">${f.level === 'bad' ? '✗' : f.level === 'warn' ? '!' : '·'} ${esc(f.text)}</div>`).join('');
  const job = (...a) => window.SwarmUI.openJob(...a);

  // Settings per service: replicas, port mode, update order.
  function settingsTable(p, settings) {
    const set = settings.services = settings.services || {};
    return UI.table([{ label: 'Service' }, { label: 'Replicas' }, { label: 'Ports' }, { label: 'Updates' }], p.services.map(s => {
      const my = set[s.name] = set[s.name] || {};
      const data = s.volumes.length || s.binds.length || s.database;
      return { cells: [
        `<b>${esc(s.name)}</b><div class="ui-sub td-mono">${esc(s.image || '?')}</div>`,
        s.database ? '1 <span class="ui-sub">database</span>' : `<input class="input" type="number" min="0" max="100" style="width:80px" data-set="${esc(p.project)}|${esc(s.name)}|replicas" value="${my.replicas ?? 1}">`,
        s.ports.length ? `<select class="select" data-set="${esc(p.project)}|${esc(s.name)}|portMode" style="max-width:220px"><option value="ingress" ${my.portMode !== 'host' ? 'selected' : ''}>ingress — every server answers</option><option value="host" ${my.portMode === 'host' ? 'selected' : ''}>host — real client IP</option></select><div class="ui-sub">${s.ports.map(x => `${x.published || ''}→${x.target}`).join(', ')}</div>` : '<span class="ui-sub">—</span>',
        data ? '<span class="text-sm">stop-first</span><div class="ui-sub">has data: never two copies at once</div>' : `<select class="select" data-set="${esc(p.project)}|${esc(s.name)}|order" style="max-width:200px"><option value="start-first" ${my.order !== 'stop-first' ? 'selected' : ''}>start-first (no downtime)</option><option value="stop-first" ${my.order === 'stop-first' ? 'selected' : ''}>stop-first</option></select>`,
      ] };
    }), { minWidth: 0 });
  }
  function readSettings(root, all) {
    root.querySelectorAll('[data-set]').forEach(el => {
      const [proj, svc, key] = el.dataset.set.split('|');
      const st = all[proj].services[svc] = all[proj].services[svc] || {};
      st[key] = key === 'replicas' ? Number(el.value) : el.value;
    });
  }

  // ---- Migrate ----
  function openMove(projects, done) {
    const settings = Object.fromEntries(projects.map(p => [p.project, { services: {} }]));
    let step = 0, previews = null;
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
        root.innerHTML = head + projects.map(p => `<div class="ui-ph-title" style="margin:10px 0 6px">${esc(p.project)} ${UI.pill(...STATUS[p.status])}</div>${settingsTable(p, settings[p.project])}`).join('')
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
        return `<div class="ui-ph-title" style="margin:14px 0 6px">${esc(pv.project)}</div>
          ${UI.table([{ label: 'Service on Swarm' }, { label: 'Replicas' }, { label: 'Ports' }, { label: 'Updates' }, { label: 'Changes for Swarm' }], svcs.map(([n, s]) => {
            const a = pv.services.find(x => x.name === n) || { findings: [] };
            return { cells: [`<b>${esc(pv.project)}_${esc(n)}</b><div class="ui-sub td-mono">${esc(s.image)}</div>`, esc(s.deploy.replicas ?? 'global'),
              (s.ports || []).map(p => `${p.published || ''}→${p.target}/${p.protocol} <span class="ui-sub">${p.mode}</span>`).join('<br>') || '—', `<span class="text-sm">${esc(s.deploy.update_config.order)}</span>${s.deploy.placement ? `<div class="ui-sub">${esc((s.deploy.placement.constraints || []).join(', '))}</div>` : ''}`, findings(a.findings) || '<span class="ui-sub">nothing</span>'] };
          }), { minWidth: 760 })}
          <div class="text-sm" style="margin-top:6px"><b>Volumes that stay the same:</b> ${pv.volumes.length ? pv.volumes.map(v => `<span class="td-mono">${esc(v.name)}</span>`).join(', ') : 'none'}. <b>Network:</b> ${Object.values(pv.stack.networks || {}).map(n => `<span class="td-mono">${esc(n.name || '')}</span> (overlay)`).join(', ') || 'default'}.</div>`;
      }).join('') + `<div class="insight-card info" style="margin-top:12px"><div><b>What happens, one project at a time:</b> the files are read again (if they changed since this plan, the project is not moved) → <span class="td-mono">docker compose down</span> (volumes stay) → <span class="td-mono">docker stack deploy</span> under the same name → every service must run and stay up for 30 s. If not, it is put back: the stack is removed and <span class="td-mono">docker compose up -d</span> runs. <b>The project is down from compose down until its services run on Swarm</b> — usually 10–60 s. The compose files are not changed.</div></div>`;
      next.disabled = previews.every(pv => !pv.stack);
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
      `<details><summary class="text-sm" style="cursor:pointer">${p.reasons.length || p.services.some(s => s.findings.length) ? 'What changes' : 'Nothing to change'}</summary>${p.reasons.map(r => `<div class="text-sm" style="color:${LV.bad}">✗ ${esc(r)}</div>`).join('')}${p.services.map(s => s.findings.length ? `<div class="text-sm" style="margin-top:4px"><b>${esc(s.name)}</b></div>${findings(s.findings)}` : '').join('')}</details>`,
    ] }));
    content.innerHTML = `${UI.header('Migrate', `Compose projects on this server that run outside Swarm. Choose some and DockGate moves them one at a time; one that does not run on Swarm goes back to Compose by itself. The compose files are not changed.${data.nodes > 1 ? ' Services with data stay on this server (placement rule).' : ''}`, UI.primary('Review…', 'data-review'))}
      ${UI.table([{ label: '', width: '36px' }, { label: 'Project' }, { label: 'Status' }, { label: 'Services' }, { label: 'Running' }, { label: 'Details' }], rows, { minWidth: 860, empty: 'No compose projects outside Swarm on this server.' })}
      <div class="ui-sub" style="margin-top:8px"><b>Ready</b>: nothing to change. <b>Attention</b>: it can move; something is shown (a build image, a database kept at 1, depends_on conditions). <b>Not possible</b>: privileged or devices, network_mode host, no compose file — it stays in Compose.</div>`;
    content.querySelector('[data-review]').onclick = () => {
      const picked = [...content.querySelectorAll('[data-pick]:checked')].map(c => data.projects.find(p => p.project === c.dataset.pick));
      if (!picked.length) return showToast('Choose at least one project', 'warning');
      openMove(picked, () => Router.navigate('swarm', { tab: 'swarm-stacks' }));
    };
  });

  // ---- Stacks ----
  function historyDialog(s, done) {
    const m = showModal(`History · ${esc(s.name)}`, '<div data-h class="text-sm text-muted">Loading…</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    API.get(`/swarm/stacks/${encodeURIComponent(s.name)}/history`).then(({ history }) => {
      const KIND = { move: 'moved from Compose', deploy: 'deploy', redeploy: 'redeploy', previous: 'earlier deploy again', 'move-back': 'moved back to Compose' };
      const ST = { done: ['ok', 'done'], rolled_back: ['warn', 'put back in Compose'], failed: ['bad', 'failed'], running: ['warn', 'running'] };
      m.overlay.querySelector('[data-h]').innerHTML = UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Result' }, { label: 'Files' }, { label: 'From' }, { label: '', align: 'right' }], history.map((h, i) => ({ cells: [
        `<span title="${esc(formatTime(new Date(h.started_at).toISOString()))}">${esc(timeAgo(new Date(h.started_at).toISOString()))}</span>`, esc(KIND[h.kind] || h.kind),
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

  Router.register('swarm-stacks', async (content) => {
    window.SwarmUI.css();
    const navId = Router._navId;
    let timer = null, data = [];
    const stop = () => clearTimeout(timer);
    async function load() {
      if (!Router.isActiveNav(navId) || !content.isConnected) return stop();
      try { data = (await API.get('/swarm/stacks')).stacks; }
      catch (e) { content.innerHTML = UI.header('Stacks', esc(e.message), UI.btn('Open Overview', 'data-go')); content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' }); return; }
      if (!Router.isActiveNav(navId)) return;
      const KIND = { move: 'moved from Compose', redeploy: 'redeployed', previous: 'earlier deploy', 'move-back': 'moved back' };
      const rows = data.map(s => ({ cells: [
        `<b>${esc(s.name)}</b>${s.location ? `<div class="ui-sub td-mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(s.location.cwd || '')}</div>` : ''}`,
        s.managed ? (s.origin === 'compose' ? 'moved from Compose' : 'deployed by DockGate') : '<span class="ui-sub">deployed outside DockGate</span>',
        String(s.services),
        `<b style="color:${s.running < s.desired ? 'var(--warning,#d97706)' : 'inherit'}">${s.running}/${s.desired}</b>`,
        s.last ? `${esc(KIND[s.last.kind] || s.last.kind)} ${UI.pill(s.last.status === 'done' ? 'ok' : s.last.status === 'running' ? 'warn' : 'bad', esc(s.last.status))}<div class="ui-sub">${esc(timeAgo(new Date(s.last.started_at).toISOString()))}</div>` : '<span class="ui-sub">—</span>',
        UI.menu([
          s.managed ? { label: 'Redeploy', attrs: `data-a="redeploy" data-n="${esc(s.name)}"` } : null,
          s.managed ? { label: 'Swarm settings…', attrs: `data-a="settings" data-n="${esc(s.name)}"` } : null,
          { label: 'History', attrs: `data-a="history" data-n="${esc(s.name)}"` },
          { label: 'Services', attrs: `data-a="services" data-n="${esc(s.name)}"` },
          '-',
          s.managed && s.location ? { label: 'Move back to Compose…', attrs: `data-a="back" data-n="${esc(s.name)}"` } : null,
          { label: 'Remove…', attrs: `data-a="remove" data-n="${esc(s.name)}"` },
        ]),
      ] }));
      content.innerHTML = `${UI.header('Stacks', 'Compose projects running on Swarm. Each deploy reads the compose files again and adapts them for Swarm in memory — the files are not changed.', UI.primary('Move projects to Swarm…', 'data-migrate'))}
        ${UI.table([{ label: 'Stack' }, { label: 'Origin' }, { label: 'Services' }, { label: 'Tasks' }, { label: 'Last deploy' }, { label: '', align: 'right' }], rows, { minWidth: 820, empty: 'No stacks yet. Move compose projects to Swarm with Migrate.' })}`;
      content.querySelector('[data-migrate]').onclick = () => Router.navigate('swarm', { tab: 'swarm-migrate' });
      content.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => act(b.dataset.a, data.find(x => x.name === b.dataset.n))));
      stop(); timer = setTimeout(load, 8000);
    }
    function act(a, s) {
      if (!s) return;
      if (a === 'history') return historyDialog(s, load);
      if (a === 'services') return Router.navigate('swarm', { tab: 'swarm-services' });
      if (a === 'settings') return stackSettings(s, load);
      if (a === 'redeploy') return secConfirm({ title: `Redeploy ${s.name}`, change: 'The compose files are read again and deployed (docker stack deploy --prune): changed services are updated, services removed from the files are removed.', protects: 'Services update one task at a time and go back by themselves when a new task fails. Volumes stay.', undo: 'History → Deploy this again on an earlier deploy.', confirmLabel: 'Redeploy',
        onConfirm: async () => { try { const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/redeploy`, {}); job(r.jobId, load, 'Redeploy'); } catch (e) { showToast(e.message, 'error', 9000); } } });
      if (a === 'back') return secConfirm({ title: `Move ${s.name} back to Compose`, danger: true, change: `The stack is removed, DockGate waits until its network is gone, then <span class="td-mono">docker compose up -d</span> runs in ${esc((s.location || {}).cwd || 'its folder')}. It is down for a short time (usually 20–60 s).`, protects: 'Volumes keep their data: Compose uses the same volume names.', undo: 'Move it to Swarm again with Migrate.', confirmLabel: 'Move back',
        onConfirm: async () => { try { const r = await API.post(`/swarm/stacks/${encodeURIComponent(s.name)}/move-back`, { confirm: true }); job(r.jobId, load, 'Move back to Compose'); } catch (e) { showToast(e.message, 'error', 9000); } } });
      if (a === 'remove') return showDeleteConfirm(`Remove stack ${s.name}`, { message: `Its ${s.services} service${s.services === 1 ? '' : 's'} and network${s.services === 1 ? '' : 's'} are removed. Volumes, secrets and configs stay; the compose files are not touched.${s.managed ? ' To run it in Compose again, use Move back to Compose instead.' : ''}`, phrase: s.name, confirmLabel: 'Remove',
        onConfirm: async () => { try { await API.del(`/swarm/stacks/${encodeURIComponent(s.name)}`); showToast(`${s.name} removed`); load(); } catch (e) { showToast(e.message, 'error', 9000); } } });
    }
    await load();
    return stop;
  });
})();
