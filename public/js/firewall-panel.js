// Server Console → Firewall tab (UFW or firewalld). Split out of server-security.js; uses its shared
// helpers (secConfirm, secError, runLifelineJob) and service-pages.js (renderServiceBar, renderRawConfig).

async function renderFirewallPanel(serverId, container) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let f;
  try { f = await API.get(`/servers/${serverId}/firewall`); }
  catch (e) { return secError(container, "Couldn't read the firewall", e, () => renderFirewallPanel(serverId, container)); }
  const reload = () => renderFirewallPanel(serverId, container);
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

    <div class="flex justify-between items-center mb-2"><div style="font-size:15px;font-weight:700">Listening ports</div><span class="text-xs text-muted">What is reachable from where (IPv4)</span></div>
    <div class="table-wrapper" style="margin-bottom:20px"><table>
      <thead><tr><th>Port</th><th>Used by</th><th>Listens on</th><th>Reachable from</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${f.ports.length ? f.ports.map(p => {
        const [col, lbl] = EXPO[p.exposure] || ['var(--text-muted)', p.exposure];
        const key = p.port + '/' + p.proto;
        let act = '';
        if (p.exposure === 'local') act = '<span class="text-xs text-muted">bound to localhost</span>';
        else if (p.isSsh) act = '<span class="text-xs text-muted">managed in Access &amp; SSH</span>';
        else if (!f.managed) act = '<span class="text-xs text-muted">turn the firewall on first</span>';
        else if (p.exposure === 'bypass') act = `<span class="text-xs text-muted">${isFwd ? 'Docker skips firewalld' : 'turn on isolation first'}</span>`;
        else if (p.exposure === 'internal') act = `<button class="btn btn-xs btn-primary" data-open="${key}">Open to internet</button> <button class="btn btn-xs btn-secondary" data-restrict="${key}">Allow one IP…</button>`;
        else act = `<button class="btn btn-xs btn-secondary" data-close="${key}">Close</button>`;
        return `<tr>
          <td class="td-mono" style="font-weight:600">${key}</td>
          <td><div>${escapeHtml(p.usedBy)}</div><div class="text-xs text-muted">${p.kind === 'container' ? 'container · ' + escapeHtml(p.container) + (p.containerPort && p.containerPort !== p.port ? ' · inside :' + p.containerPort : '') : 'host process'}</div></td>
          <td class="td-mono text-xs">${escapeHtml(p.bind)}</td>
          <td><span style="color:${col};font-weight:600;font-size:13px">● ${lbl}</span>${p.restrictedTo ? `<div class="text-xs text-muted td-mono">${escapeHtml(p.restrictedTo)}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">${act}</td>
        </tr>`; }).join('') : '<tr><td colspan="5" class="text-sm text-muted">No listening ports found (ss / netstat unavailable?)</td></tr>'}</tbody>
    </table></div>

    ${f.managed ? `
    <div class="grid-2">
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">${isFwd ? `firewalld rules · zone ${escapeHtml(f.zone || '')}` : 'UFW rules'}</div>
        <div class="table-wrapper"><table>
          <thead><tr><th>#</th><th>To</th><th>Action</th><th>From</th><th></th></tr></thead>
          <tbody>${f.rules.length ? f.rules.map(r => `<tr>
            <td class="text-muted">${r.n}</td><td class="td-mono">${escapeHtml(r.to)}${r.v6 ? ' <span class="text-xs text-muted">v6</span>' : ''}</td>
            <td><span style="color:${r.action === 'ALLOW' || r.action === 'LIMIT' ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:12px">${escapeHtml(r.action + ' ' + r.dir)}</span></td>
            <td class="text-sm">${escapeHtml(r.from)}${r.note ? ` <span class="text-xs text-muted">· ${escapeHtml(r.note)}</span>` : ''}</td>
            <td style="text-align:right">${sshRule(r) ? '<span class="text-xs text-muted" title="Keeps SSH reachable">locked</span>' : (r.v6 && !isFwd ? '' : `<button class="btn btn-xs btn-danger" data-delrule="${r.n}">Delete</button>`)}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="text-sm text-muted">No rules</td></tr>'}</tbody>
        </table></div>
        <div class="text-xs text-muted" style="margin-top:6px">${isFwd ? 'Deleting a service removes all of its ports. A rule from one IP is a rich rule.' : 'Deleting a rule also deletes its IPv6 twin.'}</div>
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
    </div>` : ''}`;

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

  const expose = async (key, open, scope, ip) => {
    const [port, proto] = key.split('/');
    const r = await API.post(`/servers/${serverId}/firewall/expose`, { port: Number(port), proto, open, scope, ip });
    showToast(open ? `${key} opened${scope === 'ip' ? ' for ' + ip : ''}` : `${key} closed`);
    warnToast(r);
    reload();
  };
  const tryExpose = (...a) => expose(...a).catch(e => showToast(e.message, 'error', 8000));
  container.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Open ${b.dataset.open} to the internet`, confirmLabel: 'Open',
    change: 'A firewall rule lets anyone on the internet reach this port.',
    protects: 'Only this port is opened. fail2ban bans and running containers are checked afterwards.',
    undo: '"Close" on the same row.',
    onConfirm: () => tryExpose(b.dataset.open, true, 'any'),
  })));
  container.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Close ${b.dataset.close}`, danger: true, confirmLabel: 'Close',
    change: 'The rule that opens this port is removed. It stays reachable inside the server, but not from outside.',
    protects: 'The SSH port cannot be closed here. fail2ban bans and running containers are checked afterwards.',
    undo: '"Open to internet" on the same row.',
    onConfirm: () => tryExpose(b.dataset.close, false),
  })));
  container.querySelectorAll('[data-restrict]').forEach(b => b.addEventListener('click', () => {
    const m = showModal(`Allow one IP · ${b.dataset.restrict}`, `<label class="text-sm" for="fw-ip" style="font-weight:600;display:block;margin-bottom:4px">IP address or range</label><input class="input" id="fw-ip" placeholder="198.51.100.24 or 10.0.0.0/24" style="font-family:var(--font-mono);width:100%"><div data-err style="margin-top:8px"></div>`, []);
    const footer = m.overlay.querySelector('.modal-footer');
    const c = document.createElement('button'); c.className = 'btn btn-secondary'; c.textContent = 'Cancel'; c.onclick = () => m.close();
    const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = 'Allow';
    footer.append(c, ok);
    ok.onclick = async () => {
      const ip = m.overlay.querySelector('#fw-ip').value.trim();
      try { await expose(b.dataset.restrict, true, 'ip', ip); m.close(); }
      catch (e) { m.overlay.querySelector('[data-err]').innerHTML = `<div class="insight-card danger">${escapeHtml(e.message)}</div>`; }
    };
  }));
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
