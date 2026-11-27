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
        `${UI.btn('Back', 'data-nw-back')} ${UI.btn('Read again', 'data-nw-reload')} ${d.builtIn ? '' : UI.btn('Change settings...', 'data-nw-change')} ${UI.btn('Compare with compose', 'data-nw-compare', 'btn-primary')}`)}
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
      ${canAttach ? `<div style="display:flex;gap:6px;align-items:end;margin-top:8px;flex-wrap:wrap">
          <label class="ui-field" style="margin:0;flex:2;min-width:200px"><span class="ui-label">Container</span><select class="select" id="nw-conn"><option value="">Connect a container...</option></select></label>
          <label class="ui-field" style="margin:0;flex:2;min-width:160px"><span class="ui-label">Aliases (optional)</span><input class="input td-mono" id="nw-conn-alias" placeholder="db, postgres"></label>
          <label class="ui-field" style="margin:0;flex:1;min-width:140px"><span class="ui-label">Fixed address (optional)</span><input class="input td-mono" id="nw-conn-ip" placeholder="${esc((d.subnets[0] || {}).gateway ? (d.subnets[0].gateway.replace(/\.\d+$/, '.50')) : '172.30.0.50')}"></label>
          ${UI.btn('Connect', 'data-nw-connect')}</div>
        <div class="ui-sub" style="margin-top:4px">Connecting here is not written to any compose file: the compare above shows it as connected by hand.</div>` : ''}

      ${UI.header('Can a container reach another?', 'Checked from inside the first container\'s network: is the name found (Docker\'s DNS), which address and network it gives, and does the port answer. The first container must be running.')}
      <div class="card" style="padding:12px 14px">
        <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
          <label class="ui-field" style="margin:0;flex:2;min-width:180px"><span class="ui-label">From</span><select class="select" id="nw-r-from">${d.members.filter(m => m.state === 'running').map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('') || '<option value="">no running container here</option>'}</select></label>
          <label class="ui-field" style="margin:0;flex:2;min-width:180px"><span class="ui-label">To (name, alias or address)</span><input class="input td-mono" id="nw-r-to" list="nw-r-names" placeholder="db"><datalist id="nw-r-names">${[...new Set(d.members.flatMap(m => [m.name, ...m.aliases, m.service].filter(Boolean)))].map(n => `<option value="${esc(n)}">`).join('')}</datalist></label>
          <label class="ui-field" style="margin:0;width:110px"><span class="ui-label">Port (optional)</span><input class="input" id="nw-r-port" type="number" min="1" max="65535" placeholder="5432"></label>
          ${UI.btn('Check', 'data-nw-reach', 'btn-primary')}
        </div>
        <div data-nw-reach-res style="margin-top:10px"></div>
      </div>

      <details class="card" style="padding:10px 14px;margin-top:12px" data-nw-hist><summary style="cursor:pointer"><b>History</b> <span class="ui-sub">what DockGate did to this network: created, connected, disconnected, changed</span></summary><div data-nw-hist-body class="ui-sub" style="margin-top:8px">Reading...</div></details>

      ${Object.keys(d.options).length || Object.keys(d.labels).length ? `<details class="card" style="padding:10px 14px;margin-top:12px"><summary style="cursor:pointer"><b>Options and labels</b></summary>
        ${[...Object.entries(d.options), ...Object.entries(d.labels)].map(([k, v]) => `<div style="display:grid;grid-template-columns:minmax(200px,1fr) 2fr;gap:8px;font-size:12px;margin-top:4px"><span class="td-mono ui-sub" style="overflow-wrap:anywhere">${esc(k)}</span><span class="td-mono" style="overflow-wrap:anywhere">${esc(v)}</span></div>`).join('')}</details>` : ''}`;
    wire(canAttach);
  }

  function wire(canAttach) {
    const q = (s) => content.querySelectorAll(s);
    content.querySelector('[data-nw-back]').onclick = () => Router.navigate('resources', { tab: 'networks' });
    content.querySelector('[data-nw-reload]').onclick = async () => { if (await load()) { paint(); compare(); } };
    content.querySelector('[data-nw-compare]').onclick = () => compare();
    content.querySelector('[data-nw-change]')?.addEventListener('click', openChange);
    content.querySelector('[data-nw-reach]').onclick = async () => {
      const box = content.querySelector('[data-nw-reach-res]');
      const body = { from: content.querySelector('#nw-r-from').value, to: content.querySelector('#nw-r-to').value.trim(), port: content.querySelector('#nw-r-port').value.trim() || undefined };
      if (!body.from) { showToast('No running container to check from', 'warning'); return; }
      if (!body.to) { showToast('To: a name, alias or address', 'warning'); return; }
      box.innerHTML = '<div class="ui-sub">Checking (a small helper container joins the first one\'s network for a few seconds)...</div>';
      try {
        const r = await API.post(`/networks/${encodeURIComponent(id)}/reach`, body);
        const row = (ok, title, text) => `<div style="display:flex;gap:8px;align-items:flex-start;margin:4px 0">${UI.pill(ok === true ? 'ok' : ok === false ? 'bad' : 'off', ok === true ? 'yes' : ok === false ? 'no' : 'skipped')}<div class="text-sm"><b>${title}</b> ${text}</div></div>`;
        const found = r.resolved.length > 0;
        const tcp = r.tcp === 'open' ? true : ['refused', 'timeout'].includes(r.tcp) ? false : null;
        box.innerHTML = row(found, 'Name found:', found ? r.addresses.map(a => `<span class="td-mono">${esc(a.ip)}</span>${a.network ? ` on ${esc(a.network)}${a.shared ? '' : ` <span style="color:var(--danger)">(${esc(r.from)} is not on that network: it can not reach it)</span>` }` : ''}`).join(', ') : `<span class="td-mono">${esc(body.to)}</span> is not known to ${esc(r.from)}'s DNS (${esc(r.nameserver || '?')}). The name must be a container or alias on a network ${esc(r.from)} is on (${esc(r.fromNetworks.join(', '))}).`)
          + (body.port ? row(tcp, `Port ${esc(body.port)}:`, r.tcp === 'open' ? 'answers.' : r.tcp === 'refused' ? 'refused: nothing listens there (wrong port, or the service is down or listens only on 127.0.0.1).' : r.tcp === 'timeout' ? 'no answer in 3 seconds: dropped on the way (an internal network, a firewall rule) or the address is not reachable.' : 'not checked.') : '');
      } catch (e) { box.innerHTML = `<div class="insight-card danger"><div>${esc(e.message)}</div></div>`; }
    };
    content.querySelector('[data-nw-hist]').addEventListener('toggle', async (e) => {
      if (!e.target.open || e.target.dataset.loaded) return;
      e.target.dataset.loaded = '1';
      const b = content.querySelector('[data-nw-hist-body]');
      try {
        const rows = await API.get(`/networks/${encodeURIComponent(id)}/history`);
        const what = (r) => { let x = {}; try { x = JSON.parse(r.details || '{}'); } catch (er) { /* text */ }
          const c = x.container ? ` <span class="td-mono">${esc(x.container)}</span>` : '';
          return ({ create: 'Created', remove: 'Removed', connect: `Connected${c}${x.aliases && x.aliases.length ? ` as ${esc(x.aliases.join(', '))}` : ''}${x.ipv4 ? ` at ${esc(x.ipv4)}` : ''}`, disconnect: `Disconnected${c}`, recreate: `Settings changed (${esc(Object.entries(x.changes || {}).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => `${k} ${v}`).join(', '))})`, 'network-connect': `Connected <span class="td-mono">${esc(r.resource_name)}</span>`, 'network-disconnect': `Disconnected <span class="td-mono">${esc(r.resource_name)}</span>` })[r.action] || esc(r.action); };
        b.innerHTML = rows.length ? rows.map(r => `<div style="display:grid;grid-template-columns:170px minmax(0,1fr) auto;gap:8px;font-size:12.5px;margin-top:4px"><span class="ui-sub">${esc(formatTime(String(r.created_at).replace(' ', 'T') + 'Z'))}</span><span>${what(r)}</span><span class="ui-sub td-mono">${esc(r.source_ip || '')}</span></div>`).join('') : 'Nothing recorded for this network. Changes made outside DockGate (docker network ... on the server) are not here.';
      } catch (er) { b.textContent = er.message; }
    });
    q('[data-nw-ctr]').forEach(a => a.onclick = (e) => { e.preventDefault(); Router.navigate('container-detail', { id: a.dataset.nwCtr }); });
    q('[data-nw-proj]').forEach(a => a.onclick = (e) => { e.preventDefault(); Router.navigate('deploy', { tab: 'compose', project: a.dataset.nwProj }); });
    q('[data-nw-disc]').forEach(b => b.onclick = () => showConfirm('Disconnect from the network', `Take <b>${esc(b.dataset.nwDisc)}</b> off <b>${esc(d.name)}</b>? It can no longer reach the containers here by name or address.`, async () => {
      const c = b.dataset.nwDisc, after = async () => { showToast(`Disconnected ${c}`); if (await load()) { paint(); compare(); } };
      try { await API.post(`/networks/${encodeURIComponent(id)}/disconnect`, { container: c }); await after(); }
      catch (e) {
        showConfirm('Disconnect anyway?', `Docker did not disconnect <b>${esc(c)}</b>: ${esc(e.message)}<br><br>Force it? Its place on the network is removed even if the container does not answer.`, async () => {
          try { await API.post(`/networks/${encodeURIComponent(id)}/disconnect`, { container: c, force: true }); await after(); }
          catch (e2) { showToast(e2.message, 'error'); }
        }, true);
      }
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
        const ip = content.querySelector('#nw-conn-ip').value.trim();
        const body = { container: sel.value, aliases: content.querySelector('#nw-conn-alias').value.trim() };
        if (ip) body[ip.includes(':') ? 'ipv6' : 'ipv4'] = ip;
        try { await API.post(`/networks/${encodeURIComponent(id)}/connect`, body); showToast(`Connected ${sel.value}`); if (await load()) { paint(); compare(); } }
        catch (e) { showToast(e.message, 'error'); }
      };
    }
  }

  // Change settings: the network is made again with the new settings and every container goes back to it.
  async function openChange() {
    let chk;
    try { chk = await API.get(`/networks/${encodeURIComponent(id)}/recreate-check`); } catch (e) { showToast(e.message, 'error'); return; }
    if (chk.refusal) {
      const proj = d.definedBy && d.definedBy.project;
      showModal('Change settings', `<div class="text-sm">${esc(chk.refusal)}</div>`, [...(proj ? [{ label: `Open ${proj}`, className: 'btn btn-primary', onClick: () => Router.navigate('deploy', { tab: 'compose', project: proj }) }] : []), { label: 'Close', className: 'btn btn-secondary' }]);
      return;
    }
    const s4 = d.subnets.find(x => !x.subnet.includes(':')) || {}, s6 = d.subnets.find(x => x.subnet.includes(':')) || {};
    const o = d.options || {};
    const running = chk.members.filter(m => m.state === 'running');
    const chk1 = (idn, label, on, hint = '') => `<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="${idn}" ${on ? 'checked' : ''}> ${label}${hint ? ` <span class="ui-sub">${hint}</span>` : ''}</label>`;
    UI.dialog({ title: `Change settings: ${d.name}`, saveLabel: 'Make it again with these settings', danger: true, wide: true,
      body: `<div class="text-sm" style="color:var(--text-secondary)">Docker can not change a network in place. DockGate disconnects the containers, removes the network, creates it again under the same name with these settings, and connects every container back with its aliases. If a step fails after the removal, the old network comes back.</div>
        <div class="insight-card ${running.length ? 'warning' : 'info'}" style="display:block;margin:8px 0">${chk.members.length ? `${chk.members.length} container${chk.members.length === 1 ? '' : 's'} on it${running.length ? `, ${running.length} running: they can not reach each other over this network for a few seconds` : ''}: ${chk.members.map(m => esc(m.name)).join(', ')}.` : 'No container is on it.'}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="ui-field" style="margin:0;flex:1;min-width:150px"><span class="ui-label">Subnet</span><input class="input td-mono" id="ch-subnet" value="${esc(s4.subnet || '')}"></label>
          <label class="ui-field" style="margin:0;flex:1;min-width:130px"><span class="ui-label">Gateway</span><input class="input td-mono" id="ch-gateway" value="${esc(s4.gateway || '')}"></label>
          <label class="ui-field" style="margin:0;flex:1;min-width:130px"><span class="ui-label">IP range</span><input class="input td-mono" id="ch-range" value="${esc(s4.range || '')}"></label>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">${chk1('ch-internal', 'Internal', d.internal, '(no way out to the internet)')}${chk1('ch-attachable', 'Attachable', d.attachable)}${chk1('ch-ipv6', 'IPv6', d.ipv6)}</div>
        <div style="display:${d.ipv6 ? 'flex' : 'none'};gap:10px;flex-wrap:wrap;margin-top:8px" id="ch-v6"><label class="ui-field" style="margin:0;flex:2;min-width:180px"><span class="ui-label">IPv6 subnet</span><input class="input td-mono" id="ch-subnet6" value="${esc(s6.subnet || '')}" placeholder="fd12:3456:789a::/64"></label></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
          <label class="ui-field" style="margin:0;flex:1;min-width:120px"><span class="ui-label">MTU</span><input class="input" id="ch-mtu" type="number" min="576" max="9000" placeholder="default" value="${esc(o['com.docker.network.driver.mtu'] || '')}"></label>
        </div>
        ${d.driver === 'bridge' ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">${chk1('ch-icc', 'Containers can talk to each other', o['com.docker.network.bridge.enable_icc'] !== 'false')}${chk1('ch-masq', 'Outgoing NAT', o['com.docker.network.bridge.enable_ip_masquerade'] !== 'false')}</div>` : ''}
        <div data-ch-conf style="margin-top:8px"></div>
        <div class="ui-sub" style="margin-top:6px">A container with a fixed address keeps it when it fits the new subnet; otherwise it gets a new one (the log says which).</div>`,
      onOpen: (ov) => {
        const q = (x) => ov.querySelector(x);
        q('#ch-ipv6').addEventListener('change', () => { q('#ch-v6').style.display = q('#ch-ipv6').checked ? 'flex' : 'none'; });
        let t = null;
        const check = () => { clearTimeout(t); t = setTimeout(async () => {
          const subs = [q('#ch-subnet').value.trim(), q('#ch-ipv6').checked ? q('#ch-subnet6').value.trim() : ''].filter(Boolean);
          try { const r = await API.post('/networks/check-subnet', { subnets: subs, except: d.name }); q('[data-ch-conf]').innerHTML = r.conflicts.length ? `<div class="insight-card warning" style="display:block">${r.conflicts.map(c => `<div>${esc(c.text)}</div>`).join('')}</div>` : ''; } catch (e) { /* no check */ }
        }, 350); };
        ['#ch-subnet', '#ch-subnet6'].forEach(x => q(x).addEventListener('input', check));
        check();
      },
      onSave: async (ov) => {
        const q = (x) => ov.querySelector(x);
        const changes = { subnet: q('#ch-subnet').value.trim(), gateway: q('#ch-gateway').value.trim(), ipRange: q('#ch-range').value.trim(), internal: q('#ch-internal').checked, attachable: q('#ch-attachable').checked, ipv6: q('#ch-ipv6').checked, subnet6: q('#ch-subnet6').value.trim(), mtu: q('#ch-mtu').value.trim() };
        if (q('#ch-icc')) { changes.icc = q('#ch-icc').checked; changes.masquerade = q('#ch-masq').checked; }
        const r = await API.post(`/networks/${encodeURIComponent(id)}/recreate`, { changes });
        setTimeout(async () => {
          const j = await followNetJob(r.jobId, d.name);
          // the network has a new id after a successful change: open it by name
          if (j && j.status === 'done') { showToast(`${d.name} has the new settings, every container is back`); Router.navigate('network-detail', { id: d.name }, { replace: true }); }
          else if (await load()) { paint(); compare(); }
        }, 0);
      } });
  }

  // A network job: its steps and log until it ends.
  function followNetJob(jobId, name) {
    return new Promise((resolve) => {
      const m = showModal(`Change settings - ${esc(name)}`, '<div id="nwr-steps"></div><pre id="nwr-log" style="max-height:44vh;overflow:auto;background:#000;color:#ddd;padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap;margin-top:8px"></pre>', [{ label: 'Close', className: 'btn btn-secondary' }]);
      const root = m.overlay;
      const tick = async () => {
        let j; try { j = await API.get(`/networks/jobs/${jobId}`); } catch (e) { root.querySelector('#nwr-steps').textContent = e.message; resolve(null); return; }
        root.querySelector('#nwr-steps').innerHTML = j.steps.map(st => `<div style="display:flex;gap:8px;align-items:center;margin:3px 0">${UI.pill(st.status === 'done' ? 'ok' : st.status === 'failed' ? 'bad' : 'info', st.status === 'done' ? 'done' : st.status === 'failed' ? 'failed' : 'running')}<span class="text-sm">${esc(st.label)}</span></div>`).join('') + (j.status !== 'running' ? `<div class="text-sm" style="margin-top:6px;font-weight:600;color:${j.status === 'done' ? 'var(--success)' : 'var(--danger)'}">${j.status === 'done' ? 'Done: the network has the new settings and every container is back.' : `Failed: ${esc(j.error || '')}`}</div>` : '');
        root.querySelector('#nwr-log').textContent = j.log || '';
        if (j.status === 'running') setTimeout(tick, 800); else resolve(j);
      };
      tick();
    });
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
