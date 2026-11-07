// Server Console → Firewall tab (UFW or firewalld). Split out of server-security.js; uses its shared
// helpers (secConfirm, secError, runLifelineJob) and service-pages.js (renderServiceBar, renderRawConfig).

async function renderFirewallPanel(serverId, container) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let f;
  try { f = await API.get(`/servers/${serverId}/firewall`); }
  catch (e) { return secError(container, "Couldn't read the firewall", e, () => renderFirewallPanel(serverId, container)); }
  const reload = () => renderFirewallPanel(serverId, container);
  const lists = (await API.get('/firewall-lists').catch(() => ({ lists: [] }))).lists || [];
  const bypass = f.ports.filter(p => p.exposure === 'bypass');
  const isFwd = f.backend === 'firewalld';
  const fwName = isFwd ? 'firewalld' : 'UFW';
  const EXPO = {
    public:     ['var(--warning)', 'Public'],
    restricted: ['var(--accent)', 'Restricted'],
    internal:   ['var(--success)', 'Internal only'],
    local:      ['var(--text-muted)', 'This server only'],
    bypass:     ['var(--danger)', `Public · bypasses ${fwName}`],
  };
  const statCard = (label, value, sub) => `<div class="card"><div class="text-xs text-muted" style="text-transform:uppercase;font-weight:600;letter-spacing:.04em">${label}</div><div style="font-weight:700;margin-top:4px">${value}</div><div class="text-xs text-muted">${sub}</div></div>`;
  const sshRule = (r) => { const m = /^(\d+)(\/tcp)?$/.exec(r.to); return m && Number(m[1]) === f.sshPort && r.dir === 'IN' && r.action !== 'DENY' && !r.v6; };

  let banner = '';
  if (!f.active) {
    banner = `<div class="card" style="border-left:3px solid var(--danger);margin-bottom:16px"><div class="flex justify-between items-center" style="gap:12px;flex-wrap:wrap"><div style="min-width:0;flex:1"><div style="font-weight:700;font-size:15px;color:var(--danger)">The firewall is off — every listening port is reachable from the internet</div><div class="text-sm text-muted" style="margin-top:4px">Turning it on blocks all incoming traffic except SSH (${f.sshPort}/tcp) and, if you keep them, 80 and 443. DockGate tests a new SSH login and switches it off again by itself if that fails.</div></div><button class="btn btn-danger" data-ufwon>Turn the firewall on</button></div></div>`;
  } else if (isFwd) {
    banner = `<div class="insight-card ${bypass.length ? 'warning' : 'info'}" style="margin-bottom:16px"><div>This server uses firewalld (zone <b>${escapeHtml(f.zone || '?')}</b>). Ports and rules below are managed in that zone; every change is saved permanently and applied with a reload.${bypass.length ? ` <b>${bypass.length} container port${bypass.length === 1 ? '' : 's'}</b> published by Docker skip${bypass.length === 1 ? 's' : ''} firewalld — publish them on 127.0.0.1 in the compose file if they should stay private. Docker port isolation is available with UFW only.` : ''}</div></div>`;
  } else if (!f.dockerIsolation && bypass.length) {
    banner = `
    <div class="card" style="border-left:3px solid var(--danger);margin-bottom:16px">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:12px">
        <div style="min-width:0;flex:1">
          <div style="font-weight:700;font-size:15px;color:var(--danger)">${bypass.length} container port${bypass.length === 1 ? ' is' : 's are'} open to the internet despite UFW</div>
          <div class="text-sm text-muted" style="margin-top:4px;max-width:72ch">Docker writes its own iptables rules, so ports published with <span class="td-mono">-p</span> skip UFW entirely. Turn on Docker port isolation: containers keep talking to each other and to this server, but only the ports you choose are reachable from outside.</div>
        </div>
        <button class="btn btn-danger" data-iso>Turn on Docker port isolation</button>
      </div>
    </div>`;
  }

  container.innerHTML = `
    <div class="flex gap-1 items-start" style="margin-bottom:12px;flex-wrap:wrap"><div data-ufwbar style="flex:1;min-width:280px"></div>${f.managed ? '<button class="btn btn-sm btn-secondary" data-ufwreload style="margin-top:6px">Reload rules</button>' : ''}</div>
    ${banner}
    <div class="grid-4" style="margin-bottom:16px">
      ${statCard('Firewall', f.active ? '<span style="color:var(--success)">● Active</span>' : '<span style="color:var(--danger)">○ Inactive</span>', escapeHtml(f.backend === 'none' ? 'not installed' : f.backend.toUpperCase()) + (f.ufwActive ? ' · <a href="#" data-ufwoff style="color:var(--danger)">turn off</a>' : ''))}
      ${statCard('Incoming', f.active ? 'Deny by default' : 'Allow all', 'Outgoing: allow')}
      ${statCard('Docker ports', f.dockerIsolation ? '<span style="color:var(--success)">● Isolated</span>' : (f.managed ? `<span style="color:var(--danger)">● Bypass ${fwName}</span>` : '—'), f.dockerIsolation ? `DOCKER-USER chain · <a href="#" data-iso-off style="color:var(--accent)">turn off</a>` : (isFwd ? 'isolation needs UFW' : 'DOCKER-USER chain'))}
      ${statCard('SSH', `${f.sshPort}/tcp`, 'Always kept open')}
    </div>

    <div class="flex justify-between items-center mb-2" style="gap:10px;flex-wrap:wrap"><div><div style="font-size:15px;font-weight:700">Ports</div><div class="text-xs text-muted">Who can reach each port from outside · IPv4 and IPv6 together</div></div>${f.managed ? '<button class="btn btn-sm btn-primary" data-addport>Add port rule</button>' : ''}</div>
    <div class="table-wrapper" style="margin-bottom:20px"><table>
      <thead><tr><th>Port</th><th>Used by</th><th>Who can reach it</th><th>Family</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${f.ports.length ? f.ports.map((p, i) => {
        const [col, lbl] = EXPO[p.exposure] || ['var(--text-muted)', p.exposure];
        let act = '';
        if (p.exposure === 'local') act = '<span class="text-xs text-muted">bound to localhost</span>';
        else if (!f.managed) act = '<span class="text-xs text-muted">turn the firewall on first</span>';
        else if (p.exposure === 'bypass') act = `<span class="text-xs text-muted">${isFwd ? 'Docker skips firewalld' : 'turn on isolation first'}</span>`;
        else if (p.locked) act = `<span class="text-xs text-muted" title="${escapeHtml(p.locked)}">edit in the rules list</span>`;
        else act = `<button class="btn btn-xs ${p.sources && p.sources.length ? 'btn-secondary' : 'btn-primary'}" data-src="${i}">${p.sources && p.sources.length ? 'Edit' : 'Allow…'}</button>${p.sources && p.sources.length && !p.isSsh ? ` <button class="btn btn-xs btn-danger" data-closeport="${i}">Close</button>` : ''}`;
        const reach = p.sources && p.exposure !== 'bypass' && p.exposure !== 'local'
          ? (p.sources.length ? `<div class="flex gap-1" style="flex-wrap:wrap">${p.sources.map(x => fwSourceChip(x, lists, f.dockgateIp)).join('')}</div>${p.outdated && p.outdated.length ? `<div class="text-xs" style="color:var(--warning);margin-top:4px">${p.outdated.map(id => escapeHtml((lists.find(l => l.id === id) || {}).name || id)).join(', ')}: an older version is applied here — <a href="#" data-src="${i}">update</a></div>` : ''}${p.sourceCount ? `<div class="text-xs text-muted" style="margin-top:3px">${p.sourceCount} address${p.sourceCount === 1 ? '' : 'es'}</div>` : ''}`
            : '<span style="color:var(--success);font-weight:600;font-size:13px">● Internal only</span><div class="text-xs text-muted">containers and this server only</div>')
          : `<span style="color:${col};font-weight:600;font-size:13px">● ${lbl}</span>`;
        return `<tr>
          <td class="td-mono" style="font-weight:600;white-space:nowrap">${p.port}/${p.proto}${p.isSsh ? ' <span class="text-xs text-muted">SSH</span>' : ''}</td>
          <td><div>${escapeHtml(p.usedBy)}</div><div class="text-xs text-muted">${p.noListener ? 'nothing listens yet' : (p.kind === 'container' ? 'container · ' + escapeHtml(p.container) + (p.containerPort && p.containerPort !== p.port ? ' · inside :' + p.containerPort : '') : 'host · ' + escapeHtml(p.bind))}</div></td>
          <td style="min-width:0">${reach}</td>
          <td>${p.family ? `<span class="text-xs" style="border:1px solid var(--border);border-radius:6px;padding:1px 6px;white-space:nowrap">${p.family}</span>` : '<span class="text-xs text-muted">—</span>'}</td>
          <td style="text-align:right;white-space:nowrap">${act}</td>
        </tr>`; }).join('') : '<tr><td colspan="5" class="text-sm text-muted">No listening ports found (ss / netstat unavailable?)</td></tr>'}</tbody>
    </table></div>
    <div data-iplists style="margin-bottom:20px"></div>

    ${f.managed ? `
    <details ${f.rules.length <= 12 ? 'open' : ''} style="margin-bottom:8px"><summary style="cursor:pointer;font-size:15px;font-weight:700;margin-bottom:8px">All ${isFwd ? 'firewalld' : 'UFW'} rules (${f.rules.length}) <span class="text-xs text-muted" style="font-weight:400">· one rule per source, as the firewall stores them</span></summary>
    <div class="grid-2">
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">${isFwd ? `firewalld rules · zone ${escapeHtml(f.zone || '')}` : 'UFW rules'}</div>
        <div class="table-wrapper"><table>
          <thead><tr><th>#</th><th>To</th><th>Action</th><th>From</th><th></th></tr></thead>
          <tbody>${f.rules.length ? f.rules.map(r => `<tr>
            <td class="text-muted">${r.n}</td><td class="td-mono">${escapeHtml(r.to)}${r.v6 ? ' <span class="text-xs text-muted">v6</span>' : ''}</td>
            <td><span style="color:${r.action === 'ALLOW' || r.action === 'LIMIT' ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:12px">${escapeHtml(r.action + ' ' + r.dir)}</span></td>
            <td class="text-sm">${escapeHtml(r.from)}${r.note ? ` <span class="text-xs text-muted">· ${escapeHtml(r.note)}</span>` : ''}</td>
            <td style="text-align:right">${sshRule(r) ? '<span class="text-xs text-muted" title="Keeps SSH reachable">locked</span>' : (r.v6 && !isFwd && r.from === 'Anywhere' ? '' : `<button class="btn btn-xs btn-danger" data-delrule="${r.n}">Delete</button>`)}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="text-sm text-muted">No rules</td></tr>'}</tbody>
        </table></div>
        <div class="text-xs text-muted" style="margin-top:6px">${isFwd ? 'Deleting a service removes all of its ports. A rule from one IP is a rich rule.' : 'Deleting an "Anywhere" rule also deletes its IPv6 twin. To change who can reach a port, use Edit in the Ports table.'}</div>
      </div>
      <div class="card" style="align-self:start">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">Add rule</div>
        <form data-rule style="display:grid;gap:10px">
          <div class="flex gap-1"><input class="input" id="fw-port" type="number" min="1" max="65535" placeholder="Port, e.g. 8443" style="flex:1"><select class="select" id="fw-proto" style="width:90px"><option>tcp</option><option>udp</option></select></div>
          <input class="input" id="fw-from" placeholder="From: any, or 198.51.100.24 / 10.0.0.0/24" value="any">
          <div class="tab-bar" id="fw-act"><button class="tab-btn active" type="button" data-a="allow">Allow</button><button class="tab-btn" type="button" data-a="deny">Deny</button></div>
          <button class="btn btn-sm btn-primary" type="submit">Add rule</button>
          <div data-err></div>
        </form>
      </div>
    </div></details>` : ''}`;

  renderServiceBar(serverId, 'firewall', container.querySelector('[data-ufwbar]'), { label: 'Firewall service', onChange: reload });
  if (f.backend === 'ufw') { const rawEl = document.createElement('div'); rawEl.style.marginTop = '16px'; container.appendChild(rawEl); renderRawConfig(serverId, 'firewall', '/etc/default/ufw', rawEl, { label: '/etc/default/ufw', high: true }); }
  // Warnings when a firewall change touched something it should not have (fail2ban bans, containers).
  const warnToast = (r) => (r && r.warnings || []).forEach(w => showToast(w, 'warning', 12000));
  container.querySelector('[data-ufwreload]')?.addEventListener('click', () => secConfirm({
    title: 'Reload firewall rules', confirmLabel: 'Reload',
    change: isFwd ? 'firewalld re-reads its permanent configuration. Rules added only at runtime (not with --permanent) are dropped.' : 'UFW re-reads its saved rules (including the Docker isolation rules).',
    protects: 'Open connections, including SSH, stay up. Afterwards DockGate checks that fail2ban still holds its bans and that no container stopped.',
    undo: 'Nothing to undo — the saved rules are applied as they are.',
    onConfirm: async () => {
      try { const r = await API.post(`/servers/${serverId}/firewall/reload`, { confirm: true }); showToast('Firewall reloaded'); warnToast(r); reload(); } catch (e) { showToast(e.message, 'error', 8000); }
    },
  }));
  container.querySelector('[data-ufwon]')?.addEventListener('click', () => {
    const m = showModal('Turn the firewall on', `
      ${serverContextBanner()}
      <div class="detail-grid" style="grid-template-columns:1fr;gap:10px">
        <div class="detail-item"><div class="detail-label">What changes</div><div class="detail-value" style="white-space:normal;word-break:normal">UFW is switched on: incoming connections are blocked unless a rule allows them. Outgoing traffic is not affected.</div></div>
        <div class="detail-item"><div class="detail-label">What protects you</div><div class="detail-value" style="white-space:normal;word-break:normal">SSH (${f.sshPort}/tcp) is allowed before switching on. DockGate then opens a new SSH login; if it fails, the firewall is switched off again (and on the server itself after 120 s if DockGate loses contact).</div></div>
        <div class="detail-item"><div class="detail-label">How to undo</div><div class="detail-value" style="white-space:normal;word-break:normal">"turn off" next to the firewall state on this page.</div></div>
      </div>
      <label class="flex items-center gap-2" style="margin-top:12px"><input type="checkbox" id="ufw-web" checked> Keep web traffic open (80/tcp, 443/tcp)</label>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-danger'; ok.textContent = 'Turn on';
    footer.append(c, ok);
    ok.onclick = async () => {
      const allowWeb = m.overlay.querySelector('#ufw-web').checked;
      m.close();
      try {
        const { jobId } = await API.post(`/servers/${serverId}/firewall/ufw`, { enable: true, allowWeb, confirm: true });
        if (jobId) { const okk = await runLifelineJob(serverId, jobId, 'Switch the firewall on'); if (okk) showToast('Firewall on'); }
        reload();
      } catch (e) { showToast(e.message, 'error', 8000); }
    };
  });
  container.querySelector('[data-ufwoff]')?.addEventListener('click', (e) => {
    e.preventDefault();
    secConfirm({
      title: 'Turn the firewall off', danger: true, confirmLabel: 'Turn off',
      change: 'UFW is switched off. Every listening port becomes reachable from the internet; Docker port isolation stops working.',
      protects: 'Nothing is locked out by this — SSH stays reachable. fail2ban bans and running containers are checked afterwards.',
      undo: 'Turn the firewall on again here; your rules are kept.',
      onConfirm: async () => {
        try { const r = await API.post(`/servers/${serverId}/firewall/ufw`, { enable: false, confirm: true }); showToast('Firewall off', 'warning'); warnToast(r); reload(); }
        catch (er) { showToast(er.message, 'error', 8000); }
      },
    });
  });
  const runIsolation = async (enable, keepPublic) => {
    try {
      const { jobId } = await API.post(`/servers/${serverId}/firewall/docker-isolation`, { enable, keepPublic, confirm: true });
      const okk = await runLifelineJob(serverId, jobId, enable ? 'Docker port isolation' : 'Turn off Docker port isolation');
      if (okk) showToast(enable ? 'Docker port isolation on' : 'Docker port isolation off');
      reload();
    } catch (e) { showToast(e.message, 'error', 8000); }
  };
  // Isolation: list current bypassing ports and ask which stay public (default closed; web ports pre-ticked).
  container.querySelector('[data-iso]')?.addEventListener('click', () => {
    const m = showModal('Turn on Docker port isolation', `
      ${serverContextBanner()}
      <p class="text-sm" style="color:var(--text-secondary);margin-bottom:10px">After this, container ports are closed to the internet unless you open them. Inside the server nothing changes. Choose which of these currently public ports should <b>stay</b> public:</p>
      <div style="display:grid;gap:6px;margin-bottom:12px">${bypass.map(p => `<label class="flex items-center gap-2" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer"><input type="checkbox" value="${p.port}/${p.proto}" ${[80, 443].includes(p.port) ? 'checked' : ''}><span class="td-mono" style="font-weight:600;min-width:72px">${p.port}/${p.proto}</span><span class="text-sm">${escapeHtml(p.usedBy)}</span>${p.containerPort !== p.port ? `<span class="text-xs text-muted">→ :${p.containerPort}</span>` : ''}</label>`).join('')}</div>
      <div class="text-xs text-muted">Web traffic (80/443) is ticked by default. Databases and dashboards should usually stay closed. When UFW manages IPv6 (IPV6=yes), the same rules are written for IPv6 too.</div>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-danger'; ok.textContent = 'Turn on isolation';
    footer.append(c, ok);
    ok.onclick = () => { const keep = [...m.overlay.querySelectorAll('input[type=checkbox]:checked')].map(x => x.value); m.close(); runIsolation(true, keep); };
  });
  container.querySelector('[data-iso-off]')?.addEventListener('click', (e) => {
    e.preventDefault();
    secConfirm({ title: 'Turn off Docker port isolation', change: 'The DOCKER-USER rules are removed. Every published container port becomes reachable from the internet again.', protects: 'SSH is tested with a new connection; on failure the previous rules come back.', undo: 'Turn isolation on again here.', danger: true, confirmLabel: 'Turn off', onConfirm: () => runIsolation(false, []) });
  });

  container.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); openSourcesDialog(serverId, f, lists, f.ports[Number(b.dataset.src)], reload); }));
  container.querySelector('[data-addport]')?.addEventListener('click', () => openSourcesDialog(serverId, f, lists, null, reload));
  container.querySelectorAll('[data-closeport]').forEach(b => b.addEventListener('click', () => {
    const p = f.ports[Number(b.dataset.closeport)];
    secConfirm({
      title: `Close ${p.port}/${p.proto}`, danger: true, confirmLabel: 'Close',
      change: `Every rule that opens this port is removed (${p.sourceCount || (p.sources.includes('any') ? 'anyone' : 0)}${p.sourceCount ? ' addresses' : ''}). It stays reachable inside the server, but not from outside.`,
      protects: 'The SSH port cannot be closed. fail2ban bans and running containers are checked afterwards.',
      undo: '"Allow…" on the same row.',
      onConfirm: async () => {
        try { const r = await API.post(`/servers/${serverId}/firewall/ports/sources`, { port: p.port, proto: p.proto, sources: [] }); showToast(`${p.port}/${p.proto} closed`); warnToast(r); reload(); }
        catch (er) { showToast(er.message, 'error', 8000); }
      },
    });
  }));
  if (f.managed) renderIpLists(container.querySelector('[data-iplists]'), lists, reload);
  container.querySelectorAll('[data-delrule]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Delete rule #${b.dataset.delrule}`, danger: true, confirmLabel: 'Delete rule',
    change: isFwd ? 'The rule is removed from the permanent firewalld configuration and firewalld is reloaded. For a service, all of its ports go.' : 'The rule (and its IPv6 twin) is removed from UFW immediately.',
    protects: 'The rule that keeps SSH reachable cannot be deleted. fail2ban bans and running containers are checked afterwards.',
    undo: 'Add the same rule again with "Add rule".',
    onConfirm: async () => {
      try { const r = await API.del(`/servers/${serverId}/firewall/rules/${b.dataset.delrule}`); showToast('Rule deleted'); warnToast(r); reload(); } catch (e) { showToast(e.message, 'error', 8000); }
    },
  })));
  let action = 'allow';
  container.querySelector('#fw-act')?.addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (!b) return; action = b.dataset.a; container.querySelectorAll('#fw-act .tab-btn').forEach(x => x.classList.toggle('active', x === b)); });
  container.querySelector('[data-rule]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { port: Number(container.querySelector('#fw-port').value), proto: container.querySelector('#fw-proto').value, from: container.querySelector('#fw-from').value.trim() || 'any', action };
    try { const r = await API.post(`/servers/${serverId}/firewall/rules`, body); showToast('Rule added'); warnToast(r); reload(); }
    catch (er) { container.querySelector('[data-rule] [data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(er.message)}</div>`; }
  });
}

// ---------------------------------------------------------------- port sources
function fwSourceChip(s, lists, dockgateIp, removable) {
  const x = removable ? ` <button type="button" data-rm="${escapeHtml(s)}" aria-label="Remove" style="all:unset;cursor:pointer;color:var(--text-muted);padding:0 2px">×</button>` : '';
  const base = 'display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:999px;padding:1px 9px;font-size:12px;white-space:nowrap;';
  if (s === 'any') return `<span style="${base}color:var(--warning)">Anyone (internet)${x}</span>`;
  if (s === '@dockgate') return `<span style="${base}color:var(--accent)" title="${escapeHtml(dockgateIp || '')}">DockGate's IP${x}</span>`;
  if (s[0] === '@') { const l = lists.find(y => y.id === s.slice(1)); return `<span style="${base}color:${s === '@cloudflare' ? '#f38020' : '#a78bfa'}">${escapeHtml(l ? l.name : s.slice(1))}${l ? ' · ' + l.items.length : ''}${x}</span>`; }
  return `<span style="${base}" class="td-mono">${escapeHtml(s)}${x}</span>`;
}

/** Add a port rule (p = null) or edit who can reach a port. Shows the exact change before applying. */
function openSourcesDialog(serverId, f, lists, p, reload) {
  const isNew = !p;
  let mode = p && p.sources && p.sources.includes('any') ? 'any' : 'list';
  let sources = p && p.sources ? p.sources.filter(s => s !== 'any') : [];
  // an outdated list on this port: keep it selected, saving applies the current version
  let note = '', hint = null, previewSeq = 0;
  const m = showModal(isNew ? 'Add port rule' : `Who can reach ${p.port}/${p.proto}`, `${serverContextBanner()}<div data-body style="display:grid;gap:12px"></div>`, []);
  const body = m.overlay.querySelector('[data-body]');
  const footer = m.overlay.querySelector('.modal-footer');
  const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
  const save = document.createElement('button'); save.className = 'btn btn-primary'; save.textContent = isNew ? 'Add rule' : 'Apply changes';
  footer.append(cancel, save);
  const portOf = () => isNew ? { port: Number(body.querySelector('#src-port')?.value), proto: body.querySelector('#src-proto')?.value || 'tcp' } : { port: p.port, proto: p.proto };
  const wanted = () => (mode === 'any' ? ['any'] : sources);
  const official = lists.filter(l => l.kind === 'official');
  const preview = async () => {
    const seq = ++previewSeq; const box = body.querySelector('[data-preview]'); if (!box) return;
    const { port, proto } = portOf();
    if (!(port >= 1 && port <= 65535)) { box.innerHTML = '<span class="text-xs text-muted">Enter a port to see the change.</span>'; save.disabled = true; return; }
    box.innerHTML = '<span class="text-xs text-muted">Checking…</span>';
    try {
      const r = await API.post(`/servers/${serverId}/firewall/ports/sources`, { port, proto, sources: wanted(), dryRun: true });
      if (seq !== previewSeq) return;
      save.disabled = !r.commands.length;
      box.innerHTML = `<div class="text-xs">${r.commands.length ? `<b style="color:var(--success)">+${r.add.length}</b> rule${r.add.length === 1 ? '' : 's'} · <b style="color:var(--danger)">−${r.remove.length}</b> · ${r.keep} unchanged${r.family ? ' · ' + r.family : ''}${r.ssh ? ' · SSH: a new login is tested, rollback after 120 s if it fails' : ''}` : 'No change.'}</div>
        ${r.commands.length ? `<details style="margin-top:6px"><summary class="text-xs text-muted" style="cursor:pointer">Commands (${r.commands.length})</summary><pre class="td-mono" style="font-size:11.5px;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;background:var(--bg-secondary,rgba(0,0,0,.2));border-radius:8px;white-space:pre-wrap">${escapeHtml(r.commands.map(c => c.replace(/\{\{S\}\}/g, '').replace(/ >\/dev\/null$/, '')).join('\n'))}</pre></details>` : ''}`;
    } catch (e) { if (seq !== previewSeq) return; save.disabled = true; box.innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
  const draw = () => {
    body.innerHTML = `
      ${isNew ? `<div class="flex gap-1" style="flex-wrap:wrap"><div style="display:grid;gap:4px"><label class="text-sm" for="src-port" style="font-weight:600">Port</label><input class="input" id="src-port" type="number" min="1" max="65535" placeholder="8443" style="width:120px" value="${escapeHtml(body.dataset.port || '')}"></div><div style="display:grid;gap:4px"><label class="text-sm" for="src-proto" style="font-weight:600">Protocol</label><select class="select" id="src-proto" style="width:90px"><option ${body.dataset.proto !== 'udp' ? 'selected' : ''}>tcp</option><option ${body.dataset.proto === 'udp' ? 'selected' : ''}>udp</option></select></div></div>` : ''}
      <div style="display:grid;gap:6px"><div class="text-sm" style="font-weight:600">Who can reach this port</div>
        <div class="tab-bar" style="width:max-content;max-width:100%"><button type="button" class="tab-btn ${mode === 'any' ? 'active' : ''}" data-mode="any">Anyone (internet)</button><button type="button" class="tab-btn ${mode === 'list' ? 'active' : ''}" data-mode="list">Only these sources</button></div></div>
      ${mode === 'list' ? `
        <div style="display:grid;gap:6px"><div class="text-sm" style="font-weight:600">Sources <span class="text-xs text-muted" style="font-weight:400">· IPv4 and IPv6 together</span></div>
          <div class="flex gap-1" style="flex-wrap:wrap">${sources.length ? sources.map(s => fwSourceChip(s, lists, f.dockgateIp, true)).join('') : '<span class="text-xs text-muted">No sources: the port is closed to the outside.</span>'}</div></div>
        ${note ? `<div class="insight-card info" style="font-size:13px"><div>${note}</div></div>` : ''}
        ${hint ? `<div class="insight-card warning" style="font-size:13px"><div>These are exactly <b>${escapeHtml(hint.name)}</b>'s official ranges. Use the ${escapeHtml(hint.name)} list instead: when it changes, every port is updated with one click.<div class="flex gap-1" style="margin-top:8px;flex-wrap:wrap"><button type="button" class="btn btn-xs btn-primary" data-uselist="${hint.id}">Use the ${escapeHtml(hint.name)} list</button><button type="button" class="btn btn-xs btn-secondary" data-keepips>Keep separate addresses</button></div></div></div>` : ''}
        <div style="display:grid;gap:4px"><label class="text-sm" for="src-paste" style="font-weight:600">Add addresses or ranges</label>
          <textarea class="input" id="src-paste" rows="3" placeholder="Paste here: one per line, or separated by spaces or commas. IPv4 and IPv6 can be mixed." style="font-family:var(--font-mono);font-size:12.5px;width:100%;resize:vertical"></textarea>
          <div class="flex justify-between items-center" style="gap:8px;flex-wrap:wrap"><span class="text-xs text-muted">Ctrl+Enter adds</span><button type="button" class="btn btn-xs btn-secondary" data-paste>Add</button></div><div data-perr class="text-xs" style="color:var(--danger)"></div></div>
        <div style="display:grid;gap:6px"><div class="text-sm" style="font-weight:600">Lists</div><div class="flex gap-1" style="flex-wrap:wrap">
          ${f.dockgateIp ? `<button type="button" class="btn btn-xs btn-secondary" data-preset="@dockgate" ${sources.includes('@dockgate') ? 'disabled' : ''}>+ DockGate's IP (${escapeHtml(f.dockgateIp)})</button>` : ''}
          ${lists.filter(l => l.items.length).map(l => `<button type="button" class="btn btn-xs btn-secondary" data-preset="@${l.id}" ${sources.includes('@' + l.id) ? 'disabled' : ''}>+ ${escapeHtml(l.name)} (${l.items.length})</button>`).join('')}
        </div></div>` : ''}
      <div data-preview></div>`;
    body.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; draw(); });
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { sources = sources.filter(s => s !== b.dataset.rm); hint = null; draw(); });
    body.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { sources.push(b.dataset.preset); draw(); });
    body.querySelector('[data-uselist]')?.addEventListener('click', () => { const l = hint; sources = sources.filter(s => !l.items.includes(s)); if (!sources.includes('@' + l.id)) sources.push('@' + l.id); note = `Replaced ${l.items.length} addresses with the ${escapeHtml(l.name)} list.`; hint = null; draw(); });
    body.querySelector('[data-keepips]')?.addEventListener('click', () => { hint = null; draw(); });
    const paste = async () => {
      const ta = body.querySelector('#src-paste');
      try {
        const r = await API.post('/firewall-lists/parse', { text: ta.value });
        if (r.invalid.length) { body.querySelector('[data-perr]').textContent = `Not an IP address or range: ${r.invalid.slice(0, 6).join(', ')}${r.invalid.length > 6 ? ' …' : ''}`; return; }
        if (r.valid.some(v => v === '0.0.0.0/0' || v === '::/0')) { body.querySelector('[data-perr]').textContent = 'Use "Anyone (internet)" instead of 0.0.0.0/0 or ::/0'; return; }
        const fresh = r.valid.filter(v => !sources.includes(v)); fresh.forEach(v => sources.push(v));
        const n6 = fresh.filter(v => v.includes(':')).length;
        note = fresh.length ? `Added ${fresh.length} address${fresh.length === 1 ? '' : 'es'}: ${fresh.length - n6} IPv4 + ${n6} IPv6.${r.valid.length > fresh.length ? ` ${r.valid.length - fresh.length} were already there.` : ''}` : 'All of these are already in the sources.';
        hint = official.find(l => l.items.length && l.items.every(x => sources.includes(x))) || null;
        draw();
      } catch (e) { body.querySelector('[data-perr]').textContent = e.message; }
    };
    body.querySelector('[data-paste]')?.addEventListener('click', paste);
    body.querySelector('#src-paste')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); paste(); } });
    body.querySelector('#src-port')?.addEventListener('change', (e) => { body.dataset.port = e.target.value; preview(); });
    body.querySelector('#src-proto')?.addEventListener('change', (e) => { body.dataset.proto = e.target.value; preview(); });
    preview();
  };
  save.onclick = async () => {
    const { port, proto } = portOf();
    save.disabled = true;
    try {
      const r = await API.post(`/servers/${serverId}/firewall/ports/sources`, { port, proto, sources: wanted() });
      m.close();
      if (r.jobId) { const ok = await runLifelineJob(serverId, r.jobId, `Sources for ${port}/${proto}`); if (ok) showToast(`${port}/${proto} updated`); }
      else { showToast(`${port}/${proto}: +${r.add.length} −${r.remove.length} rules`); (r.warnings || []).forEach(w => showToast(w, 'warning', 12000)); }
      reload();
    } catch (e) { save.disabled = false; const box = body.querySelector('[data-preview]'); if (box) box.innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
  draw();
}

// ---------------------------------------------------------------- IP lists
function renderIpLists(el, lists, reloadPanel) {
  const kindLabel = { official: 'official', custom: 'yours' };
  el.innerHTML = `
    <div class="flex justify-between items-center mb-2" style="gap:10px;flex-wrap:wrap"><div><div style="font-size:15px;font-weight:700">IP lists</div><div class="text-xs text-muted">Use a list as a port source. Official lists change only when you check and confirm.</div></div><button class="btn btn-sm btn-secondary" data-newlist>New list</button></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px">${lists.map(l => `
      <div class="card" style="display:grid;gap:6px;align-content:start">
        <div class="flex justify-between items-center"><b>${escapeHtml(l.name)}</b><span class="text-xs text-muted">${kindLabel[l.kind] || l.kind}</span></div>
        <div class="text-xs text-muted">${l.items.length ? `${l.v4} IPv4 · ${l.v6} IPv6` : 'Not loaded yet — "Check for updates" loads it'}${l.source ? ' · ' + escapeHtml(l.source) : ''}${l.fetchedAt ? ' · fetched ' + escapeHtml(l.fetchedAt) : (l.kind === 'official' && l.items.length ? ' · built-in copy' : '')}</div>
        <div class="flex gap-1" style="flex-wrap:wrap;margin-top:2px">${l.kind === 'official' ? `<button class="btn btn-xs btn-secondary" data-check="${l.id}">Check for updates</button>` : `<button class="btn btn-xs btn-secondary" data-editlist="${l.id}">Edit</button><button class="btn btn-xs btn-danger" data-dellist="${l.id}">Delete</button>`}</div>
      </div>`).join('')}</div>`;
  el.querySelector('[data-newlist]').onclick = () => openListDialog(null, reloadPanel);
  el.querySelectorAll('[data-editlist]').forEach(b => b.onclick = () => openListDialog(lists.find(l => l.id === b.dataset.editlist), reloadPanel));
  el.querySelectorAll('[data-dellist]').forEach(b => b.onclick = () => {
    const l = lists.find(x => x.id === b.dataset.dellist);
    secConfirm({ title: `Delete list "${escapeHtml(l.name)}"`, danger: true, confirmLabel: 'Delete list',
      change: 'The list is removed from DockGate. Firewall rules already on servers stay — they show as separate addresses.',
      protects: 'No server is changed.', undo: 'Create the list again with the same addresses; ports are recognised again.',
      onConfirm: async () => { try { await API.del(`/firewall-lists/${l.id}`); showToast('List deleted'); reloadPanel(); } catch (e) { showToast(e.message, 'error', 8000); } } });
  });
  el.querySelectorAll('[data-check]').forEach(b => b.onclick = async () => {
    const l = lists.find(x => x.id === b.dataset.check);
    b.disabled = true; b.textContent = 'Checking…';
    let r;
    try { r = await API.post(`/firewall-lists/${l.id}/check`); }
    catch (e) { showToast(e.message, 'error', 10000); b.disabled = false; b.textContent = 'Check for updates'; return; }
    b.disabled = false; b.textContent = 'Check for updates';
    if (!r.add.length && !r.remove.length) { showToast(`${l.name} is up to date`); return; }
    const m = showModal(`${escapeHtml(l.name)} · update`, `
      <div class="text-sm" style="margin-bottom:8px">${r.add.length} new range${r.add.length === 1 ? '' : 's'}, ${r.remove.length} removed.</div>
      <pre class="td-mono" style="font-size:12px;max-height:240px;overflow:auto;padding:8px;border-radius:8px;background:var(--bg-secondary,rgba(0,0,0,.2))">${r.add.map(x => `<span style="color:var(--success)">+ ${escapeHtml(x)}</span>`).join('\n')}${r.add.length && r.remove.length ? '\n' : ''}${r.remove.map(x => `<span style="color:var(--danger)">− ${escapeHtml(x)}</span>`).join('\n')}</pre>
      <div class="text-xs text-muted">Saving updates the list in DockGate. Servers are not changed yet: ports that use the list then show "an older version is applied here" with an <b>update</b> link, so you apply it per port and see the exact rules first.</div>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Save the new version';
    footer.append(c, ok);
    ok.onclick = async () => { try { await API.post(`/firewall-lists/${l.id}/update`, { items: r.upstream }); m.close(); showToast(`${l.name} saved`); reloadPanel(); } catch (e) { showToast(e.message, 'error', 8000); } };
  });
}

function openListDialog(l, reloadPanel) {
  const m = showModal(l ? `Edit list · ${escapeHtml(l.name)}` : 'New IP list', `
    <div style="display:grid;gap:10px">
      <div style="display:grid;gap:4px"><label class="text-sm" for="ipl-name" style="font-weight:600">Name</label><input class="input" id="ipl-name" value="${escapeHtml(l ? l.name : '')}" placeholder="Office, VPN, Partner API…" maxlength="40"></div>
      <div style="display:grid;gap:4px"><label class="text-sm" for="ipl-items" style="font-weight:600">Addresses <span class="text-xs text-muted" style="font-weight:400">· one per line, IPv4 and IPv6</span></label><textarea class="input" id="ipl-items" rows="8" style="font-family:var(--font-mono);font-size:12.5px;width:100%;resize:vertical">${escapeHtml(l ? l.items.join('\n') : '')}</textarea></div>
      ${l ? '<div class="text-xs text-muted">Ports that use this list then show "an older version is applied here" until you update them.</div>' : ''}
      <div data-err></div>
    </div>`, []);
  const footer = m.overlay.querySelector('.modal-footer');
  const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
  const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Save list';
  footer.append(c, ok);
  ok.onclick = async () => {
    const body = { name: m.overlay.querySelector('#ipl-name').value, items: m.overlay.querySelector('#ipl-items').value };
    try { if (l) await API.put(`/firewall-lists/${l.id}`, body); else await API.post('/firewall-lists', body); m.close(); showToast('List saved'); reloadPanel(); }
    catch (e) { m.overlay.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
  };
}
