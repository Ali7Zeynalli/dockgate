// Resources > Networks -> a network: what it is, every container on it (addresses, aliases, ports, compose project),
// and the compose files compared with what is live (server/network-map.js), with a fix next to each difference.
Router.register('network-detail', async (content, params) => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const { id } = params;
  const pageNavId = Router._navId;
  const kv = (rows) => `<div class="detail-grid">${rows.filter(Boolean).map(([k, v]) => `<div class="detail-item"><div class="detail-label">${esc(k)}</div><div class="detail-value" style="white-space:normal;overflow-wrap:anywhere">${v}</div></div>`).join('')}</div>`;
  const lvl = { crit: ['bad', 'High'], warn: ['warn', 'Medium'], info: ['info', 'Info'] };
  let d = null, cmp = null, cmpErr = null;

  async function load() {
    try { d = await API.get(`/networks/${encodeURIComponent(id)}/details`); }
    catch (e) {
      content.innerHTML = `<div class="empty-state"><h3>Network not found</h3><p>${esc(e.message)}</p><button class="btn btn-primary mt-2" id="nw-back">Back to Networks</button></div>`;
      content.querySelector('#nw-back').onclick = () => Router.navigate('resources', { tab: 'networks' });
      return false;
    }
    return true;
  }
  async function compare() {
    cmp = null; cmpErr = null; paint();
    try { cmp = await API.get(`/networks/${encodeURIComponent(id)}/compare`); } catch (e) { cmpErr = e.message; }
    if (Router.isActiveNav(pageNavId)) paint();
  }

  function compareHtml() {
    if (cmpErr) return `<div class="insight-card danger"><div>${esc(cmpErr)}</div></div>`;
    if (!cmp) return '<div class="card" style="padding:12px 14px"><div class="ui-sub">Reading the compose files (docker compose config)...</div></div>';
    const fixBtn = (f) => !f.fix ? '' : f.fix.action === 'disconnect' ? UI.btn('Disconnect...', `data-nw-disc="${esc(f.fix.container)}"`)
      : f.fix.action === 'recreate' ? UI.btn(`Make ${esc(f.fix.service)} again...`, `data-nw-up="${esc(f.fix.project)}" data-recreate="${esc(f.fix.service)}"`)
      : UI.btn(f.fix.action === 'up-orphans' ? 'Compose up, remove old...' : 'Compose up...', `data-nw-up="${esc(f.fix.project)}" data-orphans="${f.fix.action === 'up-orphans' ? 1 : 0}"`, f.level === 'crit' ? 'btn-primary' : '');
    return `
      ${cmp.findings.length ? `<div class="ui-settings">${cmp.findings.map(f => `<div class="ui-set" style="grid-template-columns:auto minmax(0,1fr) auto">${UI.pill(lvl[f.level][0], lvl[f.level][1])}<div class="ui-set-l"><span>${esc(f.text)}</span></div><div class="ui-set-a">${fixBtn(f)}</div></div>`).join('')}</div>`
        : ''}
      ${cmp.clean ? `<div class="insight-card info" style="margin:6px 0 10px;background:var(--success-bg);color:var(--success);border-left-color:var(--success)"><div>The live network matches the compose files${cmp.projects.length ? '' : ' (no compose project uses it)'}.</div></div>` : ''}
      ${cmp.projects.length ? UI.table([{ label: 'Compose project' }, { label: 'File' }, { label: 'In the file as' }, { label: 'Services on it (file)' }],
        cmp.projects.map(p => ({ cells: [
          `<a href="#" data-nw-proj="${esc(p.project)}">${esc(p.project)}</a>`,
          p.files ? `<span class="td-mono ui-sub">${esc(p.files.join(', '))}</span>` : `<span class="ui-sub">${esc(p.error || '-')}</span>`,
          p.key ? `<span class="td-mono">${esc(p.key)}</span>${p.external ? ` ${UI.pill('info', 'external')}` : ''}` : '<span class="ui-sub">not in the file</span>',
          p.services.length ? p.services.map(s => UI.chip(esc(s))).join('') : '<span class="ui-sub">-</span>',
        ] })), { minWidth: 640 }) : ''}`;
  }

  function paint() {
    if (!d || !Router.isActiveNav(pageNavId)) return;
    document.getElementById('header-title').innerHTML = `<span class="crumb-parent">Resources</span><span class="crumb-sep">/</span><span class="crumb-parent">Networks</span><span class="crumb-sep">/</span><span class="crumb-page">${esc(d.name)}</span>`;
    const canAttach = !['host', 'none'].includes(d.name);
    const made = d.definedBy ? `Compose project <b>${esc(d.definedBy.project)}</b>${d.definedBy.key ? ` (as <span class="td-mono">${esc(d.definedBy.key)}</span>)` : ''}` : d.builtIn ? 'Docker (its own network)' : 'By hand or by another tool (docker network create)';
    content.innerHTML = `
      ${UI.header(esc(d.name), `${esc(d.driver)} network, ${d.members.length} container${d.members.length === 1 ? '' : 's'}.`,
        `${UI.btn('Back', 'data-nw-back')} ${UI.btn('Read again', 'data-nw-reload')} ${UI.btn('Compare with compose', 'data-nw-compare', 'btn-primary')}`)}
      ${kv([
        ['Made by', made],
        ['Driver', `${esc(d.driver)}, ${esc(d.scope)}`],
        ['Subnet', d.subnets.length ? d.subnets.map(s => `<span class="td-mono">${esc(s.subnet)}</span>${s.range ? ` <span class="ui-sub">range ${esc(s.range)}</span>` : ''}`).join('<br>') : '-'],
        ['Gateway', d.subnets.map(s => `<span class="td-mono">${esc(s.gateway || '-')}</span>`).join('<br>') || '-'],
        ['Internal', d.internal ? 'Yes: no way out to the internet' : 'No'],
        ['IPv6', d.ipv6 ? 'Yes' : 'No'],
        ['Attachable', d.attachable ? 'Yes' : 'No'],
        ['Created', d.created ? esc(formatTime(d.created)) : '-'],
      ])}

      ${UI.header('Compared with the compose files', 'What each compose project\'s file says about this network (docker compose config), against what is live: containers connected by hand, services that should be here and are not, aliases, fixed addresses, services no longer in the file, network settings changed in the file.')}
      ${compareHtml()}

      ${UI.header('Containers on this network', 'Stopped containers keep their place and are listed too. Aliases are the names other containers on this network reach it by.')}
      ${d.members.length ? UI.table([{ label: 'Container' }, { label: 'Compose' }, { label: 'Address' }, { label: 'Aliases' }, { label: 'Ports on the server' }, { label: '', align: 'right' }],
        d.members.map(m => ({ cells: [
          `<a href="#" data-nw-ctr="${esc(m.id)}">${esc(m.name)}</a> ${UI.pill(m.state === 'running' ? 'ok' : 'off', esc(m.state || '?'))}`,
          m.project ? `${esc(m.project)} <span class="ui-sub">/ ${esc(m.service || '-')}</span>` : '<span class="ui-sub">no compose file</span>',
          `<span class="td-mono">${esc(m.ipv4 || '-')}</span>${m.fixedIp ? ` <span class="ui-sub">fixed</span>` : ''}${m.ipv6 ? `<br><span class="td-mono ui-sub">${esc(m.ipv6)}</span>` : ''}`,
          m.aliases.length ? m.aliases.map(a => `<span class="td-mono">${esc(a)}</span>`).join(', ') : '<span class="ui-sub">-</span>',
          m.ports.length ? m.ports.map(p => `<span class="td-mono">${p.host}->${p.port}/${esc(p.proto)}</span>`).join('<br>') : '<span class="ui-sub">-</span>',
          canAttach ? UI.btn('Disconnect...', `data-nw-disc="${esc(m.name)}"`) : '',
        ] })), { minWidth: 820 }) : '<div class="ui-sub" style="margin:4px 0 10px">No container is on this network.</div>'}
      ${canAttach ? `<div style="display:flex;gap:6px;align-items:center;margin-top:8px;max-width:520px"><select class="select" id="nw-conn" style="flex:1"><option value="">Connect a container...</option></select>${UI.btn('Connect', 'data-nw-connect')}</div>
        <div class="ui-sub" style="margin-top:4px">Connecting here is not written to any compose file: the compare above shows it as connected by hand.</div>` : ''}

      ${Object.keys(d.options).length || Object.keys(d.labels).length ? `<details class="card" style="padding:10px 14px;margin-top:12px"><summary style="cursor:pointer"><b>Options and labels</b></summary>
        ${[...Object.entries(d.options), ...Object.entries(d.labels)].map(([k, v]) => `<div style="display:grid;grid-template-columns:minmax(200px,1fr) 2fr;gap:8px;font-size:12px;margin-top:4px"><span class="td-mono ui-sub" style="overflow-wrap:anywhere">${esc(k)}</span><span class="td-mono" style="overflow-wrap:anywhere">${esc(v)}</span></div>`).join('')}</details>` : ''}`;
    wire(canAttach);
  }

  function wire(canAttach) {
    const q = (s) => content.querySelectorAll(s);
    content.querySelector('[data-nw-back]').onclick = () => Router.navigate('resources', { tab: 'networks' });
    content.querySelector('[data-nw-reload]').onclick = async () => { if (await load()) { paint(); compare(); } };
    content.querySelector('[data-nw-compare]').onclick = () => compare();
    q('[data-nw-ctr]').forEach(a => a.onclick = (e) => { e.preventDefault(); Router.navigate('container-detail', { id: a.dataset.nwCtr }); });
    q('[data-nw-proj]').forEach(a => a.onclick = (e) => { e.preventDefault(); Router.navigate('deploy', { tab: 'compose', project: a.dataset.nwProj }); });
    q('[data-nw-disc]').forEach(b => b.onclick = () => showConfirm('Disconnect from the network', `Take <b>${esc(b.dataset.nwDisc)}</b> off <b>${esc(d.name)}</b>? It can no longer reach the containers here by name or address.`, async () => {
      try { await API.post(`/networks/${encodeURIComponent(id)}/disconnect`, { container: b.dataset.nwDisc, force: true }); showToast(`Disconnected ${b.dataset.nwDisc}`); if (await load()) { paint(); compare(); } }
      catch (e) { showToast(e.message, 'error'); }
    }, true));
    q('[data-nw-up]').forEach(b => b.onclick = () => {
      const p = b.dataset.nwUp, orphans = b.dataset.orphans === '1', svc = b.dataset.recreate || '';
      const cmd = svc ? `docker compose up -d --force-recreate --no-deps ${svc}` : `docker compose up -d${orphans ? ' --remove-orphans' : ''}`;
      const what = svc ? `The containers of ${esc(svc)} are made again from the file (a short break for them). The other services are not touched.`
        : `Containers whose settings changed are made again (a short break for them)${orphans ? ', and containers of services no longer in the file are removed' : ''}.`;
      showConfirm(svc ? `Make ${svc} again` : 'Compose up', `Run <span class="td-mono">${esc(cmd)}</span> for <b>${esc(p)}</b>? ${what}`, async () => {
        try { const r = await API.post(`/compose/${encodeURIComponent(p)}/up${svc ? `?recreate=${encodeURIComponent(svc)}` : orphans ? '?orphans=1' : ''}`); await followJob(r.jobId, p); if (await load()) { paint(); compare(); } }
        catch (e) { showToast(e.message, 'error', 9000); }
      });
    });
    if (canAttach) {
      const sel = content.querySelector('#nw-conn');
      API.get('/containers').then(list => {
        const on = new Set(d.members.map(m => m.name));
        sel.insertAdjacentHTML('beforeend', (list || []).filter(c => !on.has(c.name)).map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join(''));
      }).catch(() => {});
      content.querySelector('[data-nw-connect]').onclick = async () => {
        if (!sel.value) { showToast('Pick a container', 'warning'); return; }
        try { await API.post(`/networks/${encodeURIComponent(id)}/connect`, { container: sel.value }); showToast(`Connected ${sel.value}`); if (await load()) { paint(); compare(); } }
        catch (e) { showToast(e.message, 'error'); }
      };
    }
  }

  // A compose job: its log until it ends.
  function followJob(jobId, project) {
    return new Promise((resolve) => {
      const m = showModal(`Compose up - ${esc(project)}`, '<div class="ui-sub" id="nwj-phase">Starting...</div><pre id="nwj-log" style="max-height:50vh;overflow:auto;background:#000;color:#ddd;padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap;margin-top:8px"></pre>', [{ label: 'Close', className: 'btn btn-secondary' }]);
      const root = m.overlay;
      const tick = async () => {
        let j; try { j = await API.get(`/compose/deploy-job/${jobId}`); } catch (e) { root.querySelector('#nwj-phase').textContent = e.message; resolve(); return; }
        root.querySelector('#nwj-log').textContent = j.log || '';
        root.querySelector('#nwj-phase').textContent = j.status === 'running' ? `Running: ${j.phase || ''}` : j.status === 'done' ? 'Done' : `Failed: ${j.error || ''}`;
        if (j.status === 'running' && document.body.contains(root)) setTimeout(tick, 1200); else resolve();
      };
      tick();
    });
  }

  if (await load()) { paint(); compare(); }
});
