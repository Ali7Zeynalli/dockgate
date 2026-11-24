// Server Console > System: hostname, /etc/hosts, DNS, network interfaces, kernel (sysctl), open-file limit, journal
// size, disks (/etc/fstab), swap and a catalog of the server's config files. Every change shows what changes, then runs as a
// guarded job (backup -> write -> check with the owning tool -> apply; restored when a check fails). Network changes
// keep the change only when a new SSH login works - otherwise the server restores it by itself after 120 s.
/** System, or one section of it when the container says which (Server > System tabs). */
async function renderSystemPanel(serverId, container) {
  await renderSystemPanelAll(serverId, container);
  if (container.dataset.only) UI.onlySections(container, [container.dataset.only]);
}
async function renderSystemPanelAll(serverId, container) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  container.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>';
  let d;
  try { d = await API.get(`/servers/${serverId}/system`); }
  catch (e) { container.innerHTML = UI.errorState(e, { title: "The server's settings could not be read" }); return; }
  const reload = () => renderSystemPanel(serverId, container);
  const st = Store.view('system-' + serverId);
  const stack = d.net.stack.includes('netplan') ? 'netplan' : d.net.stack.includes('nm') ? 'NetworkManager' : null;
  const dnsNow = d.dns.resolved ? (d.dns.drop.DNS || (d.dns.resolvectl.match(/\d+\.\d+\.\d+\.\d+|[0-9a-f:]{6,}/gi) || []).filter((x, i, a) => a.indexOf(x) === i).join(' ')) : d.dns.servers.join(' ');
  const diffHtml = (before, after) => {
    const diff = FileEditor.diffLines(before || '', after || '');
    return `<pre class="td-mono" style="font-size:12px;max-height:40vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:0">${diff.map(x => `<div style="white-space:pre;${x.t === '+' ? 'color:var(--success);background:rgba(16,185,129,.12)' : x.t === '-' ? 'color:var(--danger);background:rgba(239,68,68,.12)' : 'opacity:.6'}">${x.t} ${esc(x.s)}</div>`).join('')}</pre>`;
  };
  const run = async (path, body, title) => { const r = await API.post(`/servers/${serverId}/system/${path}`, body); const ok = await runLifelineJob(serverId, r.jobId, title); if (ok !== null) reload(); return ok; };
  // preview first (the file before and after), then run
  const reviewThenRun = async (path, body, title, note = '') => {
    const pv = await API.post(`/servers/${serverId}/system/${path}`, { ...body, preview: true });
    showModal(esc(title), `${serverContextBanner()}<div class="text-sm" style="margin-bottom:8px">What changes${pv.file ? ` in <span class="td-mono">${esc(pv.file)}</span>` : ''}. The previous file is kept until every check passed${note ? ', ' + note : ''}.</div>${diffHtml(pv.before, pv.after)}`,
      [{ label: 'Cancel', className: 'btn btn-secondary' }, { label: 'Apply', className: 'btn btn-primary', onClick: () => run(path, body, title).catch(e => showToast(e.message, 'error', 9000)) }]);
  };
  const iface = (i) => {
    const def = d.net.defaultRoute && d.net.defaultRoute.dev === i.name;
    const ssh = i.v4.some(a => a.ip === d.net.sshServerIp);
    return { cells: [
      `<b class="td-mono">${esc(i.name)}</b>${def ? ` ${UI.pill('info', 'default route')}` : ''}${ssh ? ` ${UI.pill('warn', 'DockGate connects here')}` : ''}${i.docker ? ` ${UI.pill('off', 'Docker / virtual')}` : ''}`,
      i.state === 'UP' ? UI.pill('ok', 'up') : UI.pill(i.state === 'DOWN' ? 'bad' : 'off', esc(String(i.state || '').toLowerCase())),
      i.v4.map(a => `<span class="td-mono">${esc(a.ip)}/${a.prefix}</span>${a.dynamic ? ' <span class="ui-sub">DHCP</span>' : ''}`).join('<br>') || '<span class="ui-sub">-</span>',
      i.v6.map(a => `<span class="td-mono ui-sub">${esc(a.ip)}/${a.prefix}</span>`).join('<br>') || '<span class="ui-sub">-</span>',
      `<span class="td-mono">${esc(i.mtu)}</span>`,
      !i.docker && stack ? UI.btn('Edit...', `data-net="${esc(i.name)}"`) : '',
    ] };
  };
  const fstabRows = d.fstab.filter(l => l.kind === 'entry' && l.fstype !== 'swap'); // swap lines are under Swap
  const mounted = (t) => d.mounts.some(m => m.target === t);

  const sw = d.swap || { devices: [], fstab: [] };
  const gb = (mb) => mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
  function swapHtml() {
    const total = sw.devices.reduce((a, x) => a + x.sizeMb, 0), used = sw.devices.reduce((a, x) => a + x.usedMb, 0);
    const off = (sw.fstab || []).filter(p => !sw.devices.some(x => x.path === p));
    const rows = [
      ...sw.devices.map(x => ({ cells: [`<span class="td-mono">${esc(x.path)}</span>`, esc(x.type), gb(x.sizeMb), `${gb(x.usedMb)}${x.sizeMb ? ` <span class="ui-sub">(${Math.round(x.usedMb * 100 / x.sizeMb)}%)</span>` : ''}`, `<span class="td-mono">${esc(x.prio)}</span>`,
        x.type === 'file' ? `${UI.btn('Resize...', `data-swresize="${esc(x.path)}"`)} ${UI.btn('Turn off & remove...', `data-swrm="${esc(x.path)}"`)}` : '<span class="ui-sub">partition - not changed here</span>'] })),
      ...off.map(p => ({ cells: [`<span class="td-mono">${esc(p)}</span> ${UI.pill('warn', 'in fstab, not on')}`, '-', '-', '-', '-', p.startsWith('/dev/') ? '' : UI.btn('Remove...', `data-swrm="${esc(p)}"`)] })),
    ];
    return `<div style="margin:14px 0 6px"><b>Swap</b> <span class="ui-sub">· ${total ? `${gb(total)}, ${gb(used)} in use` : 'none'}${sw.ramMb ? `, RAM ${gb(sw.ramMb)}` : ''}, a safety net when memory runs out (builds, spikes): without it the kernel stops a process instead.</span></div>
      ${sw.container ? `<div class="insight-card warning" style="margin-bottom:8px"><div>This server is a container (<b>${esc(sw.container)}</b>): its host decides swap, a swap file can not be turned on here.</div></div>` : ''}
      ${rows.length ? UI.table([{ label: 'Swap' }, { label: 'Type' }, { label: 'Size' }, { label: 'In use' }, { label: 'Priority' }, { label: '', align: 'right' }], rows, { minWidth: 760 }) : ''}
      ${UI.settings([{ label: 'Swappiness', desc: '10 keeps apps in RAM and swaps only under pressure; 60 is the kernel default. Written to /etc/sysctl.d/99-dockgate.conf, the same file as Kernel &amp; limits.', value: `<span class="td-mono">${esc(sw.swappiness || '-')}</span>${sw.dockgate ? ` <span class="ui-sub">· DockGate: ${esc(sw.dockgate)}</span>` : ''}${sw.legacy && !sw.dockgate ? ` <span class="ui-sub">· older file 99-swappiness.conf: ${esc(sw.legacy)}</span>` : ''}`, action: UI.btn('Edit', 'data-swappiness') }])}
      <div style="margin:6px 0 12px">${!sw.container && !sw.devices.some(x => x.path === '/swapfile') ? UI.btn(sw.devices.length ? '+ Add swap file...' : `+ Create swap file (${gb(sw.defaultMb || 4096)})...`, 'data-swadd') : ''}</div>`;
  }

  container.innerHTML = `
    ${UI.header('System', `${esc(d.os || 'Linux')}, the server's own settings. Each change shows what changes in the file, is checked by the tool that owns it, and is restored when a check fails.`)}

    ${UI.header('Name and addresses')}
    ${UI.settings([
      { label: 'Hostname', desc: 'The server\'s name (also set on the 127.0.1.1 line of /etc/hosts)', value: `<span class="td-mono">${esc(d.hostname)}</span>`, action: UI.btn('Edit', 'data-hostname') },
      { label: '/etc/hosts', desc: 'Names this server resolves itself (before DNS)', value: `${d.hosts.filter(h => h.kind === 'entry' && !/^(127\.|::1|fe00:|ff0)/.test(h.ip)).length} entries`, action: UI.btn('Edit', 'data-hosts') },
      { label: 'DNS servers', desc: d.dns.resolved ? 'systemd-resolved (DockGate writes a drop-in file)' : `/etc/resolv.conf${d.dns.resolvLink && d.dns.resolvLink !== '/etc/resolv.conf' ? ` -> ${esc(d.dns.resolvLink)} (managed elsewhere)` : ''}`, value: `<span class="td-mono">${esc(dnsNow || '-')}</span>`, action: UI.btn('Edit', 'data-dns') },
    ])}

    ${UI.header('Network', stack ? `Managed by ${stack}. A change is applied, then kept only when a new SSH login works - otherwise the server restores it by itself after 120 seconds.` : 'Neither netplan nor NetworkManager manages this server\'s network - its files can be edited in Files (see Config files below).')}
    ${UI.table([{ label: 'Interface' }, { label: 'State' }, { label: 'IPv4' }, { label: 'IPv6' }, { label: 'MTU' }, { label: '', align: 'right' }], d.net.interfaces.filter(i => !i.docker || st.get('showVirtual', false)).map(iface), { minWidth: 760 })}
    <div class="ui-sub" style="margin:4px 0 0">${d.net.defaultRoute ? `Default route via <span class="td-mono">${esc(d.net.defaultRoute.gateway || '-')}</span> on <span class="td-mono">${esc(d.net.defaultRoute.dev)}</span>, ` : ''}<a href="#" data-virtual>${st.get('showVirtual', false) ? 'Hide' : 'Show'} Docker and virtual interfaces (${d.net.interfaces.filter(i => i.docker).length})</a></div>

    ${UI.header('Kernel and limits')}
    ${UI.table([{ label: 'Setting' }, { label: 'Now' }, { label: 'Set by DockGate' }, { label: 'Hint' }],
      d.sysctl.map(s => ({ cells: [`<b>${esc(s.label)}</b><div class="ui-sub td-mono">${esc(s.key)}</div>`, `<span class="td-mono">${esc(s.now || '-')}</span>`, s.dockgate ? `<span class="td-mono">${esc(s.dockgate)}</span>` : '<span class="ui-sub">-</span>', `<span class="ui-sub">${esc(s.hint)}</span>`] })), { minWidth: 720 })}
    <div style="margin:6px 0 12px">${UI.btn('Edit kernel settings...', 'data-sysctl')} <span class="ui-sub">Written to <span class="td-mono">/etc/sysctl.d/99-dockgate.conf</span>; the kernel checks each value before it is kept.</span></div>
    ${UI.settings([
      { label: 'Open files limit', desc: 'For logins and services (nofile). Services get it when they restart.', value: `<span class="td-mono">${esc(d.nofile.soft)}</span> <span class="ui-sub">/ hard ${esc(d.nofile.hard)}</span>${d.nofile.dockgate ? ` <span class="ui-sub">· DockGate: ${esc(d.nofile.dockgate)}</span>` : ''}`, action: UI.btn('Edit', 'data-nofile') },
      { label: 'Journal size', desc: 'The most disk the system journal may use', value: `${esc(d.journal.usage || '-')}${d.journal.maxUse ? ` <span class="ui-sub">· limit ${esc(d.journal.maxUse)}</span>` : ''}`, action: UI.btn('Edit', 'data-journal') },
      { label: 'Docker daemon', desc: 'Log size limits and live-restore', value: '<span class="ui-sub">in Services > Docker</span>', action: UI.btn('Open', 'data-docker') },
    ])}

    ${UI.header('Disks', '/etc/fstab - what is mounted at boot. A new line is checked with findmnt and mounted once before it is kept; the root and boot file systems are not removed here.')}
    ${UI.table([{ label: 'Mount point' }, { label: 'Source' }, { label: 'Type' }, { label: 'Options' }, { label: 'Use' }, { label: '', align: 'right' }],
      fstabRows.map(l => { const u = d.df.find(x => x.target === l.target); return { cells: [`<span class="td-mono">${esc(l.target)}</span> ${mounted(l.target) ? '' : UI.pill('warn', 'not mounted')}`, `<span class="td-mono ui-sub">${esc(l.source)}</span>`, esc(l.fstype), `<span class="td-mono ui-sub">${esc(l.options)}</span>`, u ? `${esc(u.used)} / ${esc(u.size)} <span class="ui-sub">(${esc(u.pct)})</span>` : '<span class="ui-sub">-</span>', ['/', '/boot', '/boot/efi'].includes(l.target) ? '' : UI.btn('Remove...', `data-fsrm="${l.i}"`)] }; }), { minWidth: 820 })}
    <div style="margin:6px 0 12px">${UI.btn('+ Add mount...', 'data-fsadd')}</div>
    ${swapHtml()}

    ${UI.header('Config files', 'Where things are set on this server. Files open in the editor (diff before save, earlier versions, sudo); folders open in Quick Files. A ✓ means the editor checks it before or after saving.')}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">${d.catalog.map(g => `<div class="card" style="padding:12px 14px"><b style="font-size:13px">${esc(g.group)}</b>${g.items.map(([p, desc, chk]) => `<div style="display:flex;gap:8px;align-items:baseline;margin-top:6px"><a href="#" data-open="${esc(p)}" class="td-mono" style="font-size:12.5px">${esc(p)}</a>${chk ? '<span title="Checked by the editor" style="color:var(--success)">✓</span>' : ''}<span class="ui-sub" style="flex:1;text-align:right">${esc(desc)}</span></div>`).join('')}</div>`).join('')}</div>`;

  // ---- handlers ----
  container.querySelector('[data-virtual]').addEventListener('click', (e) => { e.preventDefault(); st.set('showVirtual', !st.get('showVirtual', false)); reload(); });
  container.querySelector('[data-docker]').addEventListener('click', () => srvGo('srv-docker'));
  container.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); const p = a.dataset.open;
    if (/\/$|\.d$|\/netplan$|connections$|sites-available$|logrotate\.d$/.test(p)) QuickFiles.open(p); else FileEditor.open({ path: p, name: p.split('/').pop() });
  }));
  container.querySelector('[data-hostname]').addEventListener('click', () => UI.dialog({ title: 'Hostname', saveLabel: 'Apply',
    body: `<label class="ui-field"><span class="ui-label">New hostname</span><input class="input td-mono" id="sy-hn" value="${esc(d.hostname)}"><span class="ui-sub">e.g. web-1 or web-1.example.com. Docker Swarm shows nodes by this name.</span></label>`,
    onSave: async (ov) => { const v = ov.querySelector('#sy-hn').value.trim(); if (v === d.hostname) return; setTimeout(() => run('hostname', { hostname: v }, `Hostname -> ${v}`).catch(e => showToast(e.message, 'error', 9000)), 0); } }));
  container.querySelector('[data-hosts]').addEventListener('click', () => {
    const rows = d.hosts.filter(h => h.kind === 'entry' && !/^(127\.|::1|fe00:|ff0)/.test(h.ip));
    const rowHtml = (r = {}) => `<div data-hrow style="display:grid;grid-template-columns:160px 1fr 160px 32px;gap:6px;margin-bottom:6px"><input class="input td-mono" data-ip placeholder="10.0.0.5" value="${esc(r.ip || '')}"><input class="input td-mono" data-names placeholder="db db.internal" value="${esc((r.names || []).join(' '))}"><input class="input" data-comment placeholder="comment" value="${esc(r.comment || '')}"><button type="button" class="btn btn-xs btn-ghost" data-hdel aria-label="Remove">×</button></div>`;
    UI.dialog({ title: '/etc/hosts', saveLabel: 'Review changes...', wide: true,
      body: `<div class="ui-sub" style="margin-bottom:8px">localhost lines stay as they are. One address per row, several names separated by spaces.</div><div data-hrows>${rows.map(rowHtml).join('')}</div>${UI.btn('+ Add row', 'data-hadd')}`,
      onOpen: (ov) => {
        const wire = () => ov.querySelectorAll('[data-hdel]').forEach(b => { b.onclick = () => b.closest('[data-hrow]').remove(); });
        ov.querySelector('[data-hadd]').onclick = () => { ov.querySelector('[data-hrows]').insertAdjacentHTML('beforeend', rowHtml()); wire(); };
        wire();
      },
      onSave: async (ov) => {
        const list = [...ov.querySelectorAll('[data-hrow]')].map(r => ({ ip: r.querySelector('[data-ip]').value.trim(), names: r.querySelector('[data-names]').value.trim(), comment: r.querySelector('[data-comment]').value.trim() })).filter(r => r.ip || r.names);
        await API.post(`/servers/${serverId}/system/hosts`, { rows: list, preview: true });
        setTimeout(() => reviewThenRun('hosts', { rows: list }, 'Update /etc/hosts').catch(e => showToast(e.message, 'error', 9000)), 0);
      } });
  });
  container.querySelector('[data-dns]').addEventListener('click', () => UI.dialog({ title: 'DNS servers', saveLabel: 'Review changes...',
    body: `<label class="ui-field"><span class="ui-label">Servers</span><input class="input td-mono" id="sy-dns" value="${esc(dnsNow)}" placeholder="1.1.1.1 9.9.9.9"><span class="ui-sub">Up to 6, separated by spaces. Common: 1.1.1.1 (Cloudflare), 8.8.8.8 (Google), 9.9.9.9 (Quad9) - or your provider's.</span></label>
      <label class="ui-field"><span class="ui-label">Search domains (optional)</span><input class="input td-mono" id="sy-dom" value="${esc(d.dns.drop.Domains || '')}" placeholder="internal.example.com"></label>
      <label class="ui-field"><span class="ui-label">Test with this name</span><input class="input td-mono" id="sy-test" value="cloudflare.com"><span class="ui-sub">After the change the server resolves it; if it can not, the previous DNS is restored.</span></label>`,
    onSave: async (ov) => {
      const body = { servers: ov.querySelector('#sy-dns').value, domains: ov.querySelector('#sy-dom').value, testName: ov.querySelector('#sy-test').value.trim() };
      await API.post(`/servers/${serverId}/system/dns`, { ...body, preview: true });
      setTimeout(() => reviewThenRun('dns', body, 'DNS servers').catch(e => showToast(e.message, 'error', 9000)), 0);
    } }));
  container.querySelector('[data-sysctl]').addEventListener('click', () => UI.dialog({ title: 'Kernel settings', saveLabel: 'Review changes...', wide: true,
    body: `<div class="ui-sub" style="margin-bottom:8px">Empty = not set by DockGate (the system's value stays).</div>${d.sysctl.map(s => `<label style="display:grid;grid-template-columns:220px 140px 1fr;gap:8px;align-items:center;margin-bottom:6px"><span><b>${esc(s.label)}</b><br><span class="ui-sub td-mono">${esc(s.key)}</span></span>${s.choices ? `<select class="input" data-sk="${esc(s.key)}"><option value="">-</option>${s.choices.map(c => `<option ${String(s.dockgate) === c ? 'selected' : ''}>${c}</option>`).join('')}</select>` : `<input class="input td-mono" data-sk="${esc(s.key)}" value="${esc(s.dockgate || '')}" placeholder="${esc(s.now)}">`}<span class="ui-sub">now ${esc(s.now || '-')}, ${esc(s.hint)}</span></label>`).join('')}`,
    onSave: async (ov) => {
      const values = {}; ov.querySelectorAll('[data-sk]').forEach(i => { if (i.value.trim()) values[i.dataset.sk] = i.value.trim(); });
      await API.post(`/servers/${serverId}/system/sysctl`, { values, preview: true });
      setTimeout(() => reviewThenRun('sysctl', { values }, 'Kernel settings').catch(e => showToast(e.message, 'error', 9000)), 0);
    } }));
  container.querySelector('[data-nofile]').addEventListener('click', () => UI.dialog({ title: 'Open files limit', saveLabel: 'Apply',
    body: `<label class="ui-field"><span class="ui-label">Files per process</span><input class="input td-mono" id="sy-nf" type="number" min="1024" max="1048576" value="${esc(d.nofile.dockgate || 65536)}"><span class="ui-sub">65536 suits most servers; databases and proxies may need 262144 or more.</span></label>`,
    onSave: async (ov) => { const v = ov.querySelector('#sy-nf').value; setTimeout(() => run('nofile', { nofile: v }, `Open files -> ${v}`).catch(e => showToast(e.message, 'error', 9000)), 0); } }));
  container.querySelector('[data-journal]').addEventListener('click', () => UI.dialog({ title: 'Journal size', saveLabel: 'Apply',
    body: `<label class="ui-field"><span class="ui-label">At most</span><input class="input td-mono" id="sy-jm" value="${esc(d.journal.maxUse || '1G')}"><span class="ui-sub">e.g. 500M, 1G, 2G. Older entries beyond it are removed now.</span></label>`,
    onSave: async (ov) => { const v = ov.querySelector('#sy-jm').value.trim(); setTimeout(() => run('journald', { maxUse: v }, `Journal size -> ${v}`).catch(e => showToast(e.message, 'error', 9000)), 0); } }));

  container.querySelectorAll('[data-net]').forEach(b => b.addEventListener('click', () => {
    const i = d.net.interfaces.find(x => x.name === b.dataset.net);
    const dhcp = i.v4.some(a => a.dynamic) || !i.v4.length;
    const gw = d.net.defaultRoute && d.net.defaultRoute.dev === i.name ? d.net.defaultRoute.gateway : '';
    const sshHere = i.v4.some(a => a.ip === d.net.sshServerIp);
    UI.dialog({ title: `Network, ${esc(i.name)}`, saveLabel: 'Review changes...', wide: true,
      body: `${sshHere ? `<div class="insight-card warning" style="margin-bottom:10px"><div>DockGate connects to <b class="td-mono">${esc(d.net.sshServerIp)}</b> on this interface. Keep that address, or give the new one below - DockGate then tests a login to it and switches to it.</div></div>` : ''}
        <div class="ui-field"><span class="ui-label">IPv4</span>${UI.seg([['dhcp', 'DHCP (automatic)'], ['static', 'Static']], dhcp ? 'dhcp' : 'static', 'data-mode')}</div>
        <div data-static style="${dhcp ? 'display:none' : ''}">
          <label class="ui-field"><span class="ui-label">Addresses (one per line, with prefix)</span><textarea class="input td-mono" id="sy-addr" rows="2">${esc(i.v4.map(a => `${a.ip}/${a.prefix}`).join('\n'))}</textarea></label>
          <label class="ui-field"><span class="ui-label">Gateway</span><input class="input td-mono" id="sy-gw" value="${esc(gw || '')}" placeholder="203.0.113.1"></label>
        </div>
        <label class="ui-field"><span class="ui-label">DNS (optional)</span><input class="input td-mono" id="sy-ndns" placeholder="1.1.1.1 9.9.9.9"></label>
        <label class="ui-field"><span class="ui-label">MTU (optional)</span><input class="input td-mono" id="sy-mtu" value="${esc(i.mtu)}"></label>
        ${sshHere ? `<label class="ui-field"><span class="ui-label">New address DockGate should use (only if it changes)</span><input class="input td-mono" id="sy-newip" placeholder="leave empty to keep ${esc(d.net.sshServerIp)}"></label>` : ''}
        <div class="ui-sub">Applied, then kept only when a new SSH login works. If the server stops answering, it restores the previous settings by itself after 120 seconds.</div>`,
      onOpen: (ov) => { ov.querySelectorAll('[data-mode]').forEach(x => x.addEventListener('click', () => { ov.querySelectorAll('[data-mode]').forEach(y => y.setAttribute('aria-pressed', String(y === x))); ov.querySelector('[data-static]').style.display = x.dataset.mode === 'static' ? '' : 'none'; })); },
      onSave: async (ov) => {
        const mode = ov.querySelector('[data-mode][aria-pressed="true"]').dataset.mode;
        const body = { iface: i.name, dhcp: mode === 'dhcp', addresses: ov.querySelector('#sy-addr').value.split('\n').map(s => s.trim()).filter(Boolean), gateway: ov.querySelector('#sy-gw').value.trim(), dns: ov.querySelector('#sy-ndns').value.split(/[\s,]+/).filter(Boolean), mtu: ov.querySelector('#sy-mtu').value.trim(), newSshIp: (ov.querySelector('#sy-newip') || {}).value || '' };
        await API.post(`/servers/${serverId}/system/network`, { ...body, preview: true });
        setTimeout(() => reviewThenRun('network', body, `Network: ${i.name}`, 'kept only when a new SSH login works; restored by the server after 120 s otherwise').catch(e => showToast(e.message, 'error', 9000)), 0);
      } });
  }));

  const swapDialog = (path, sizeMb, title) => UI.dialog({ title, saveLabel: 'Apply',
    body: `<label class="ui-field"><span class="ui-label">Size</span><select class="input" id="sw-size">${[1024, 2048, 4096, 8192, 16384].map(m => `<option value="${m}" ${m === sizeMb ? 'selected' : ''}>${gb(m)}</option>`).join('')}</select>
      <span class="ui-sub">4 GB suits most servers. Needs the size + 1 GB free on the disk${sw.rootFreeMb ? ` (free on /: ${gb(sw.rootFreeMb)})` : ''}.</span></label>
      <div class="ui-sub">File <span class="td-mono">${esc(path)}</span>${sw.devices.some(x => x.path === path) ? ' - turned off first (only when the RAM can take back what is in it), then made again at the new size' : ''}. A file the kernel does not take is removed again, and the reason shown.</div>`,
    onSave: async (ov) => { const sizeMb = Number(ov.querySelector('#sw-size').value); setTimeout(() => run('swap', { action: 'set', path, sizeMb }, `Swap ${path} -> ${gb(sizeMb)}`).catch(e => showToast(e.message, 'error', 9000)), 0); } });
  const swAdd = container.querySelector('[data-swadd]');
  if (swAdd) swAdd.addEventListener('click', () => swapDialog('/swapfile', sw.defaultMb || 4096, 'Create a swap file'));
  container.querySelectorAll('[data-swresize]').forEach(b => b.addEventListener('click', () => { const x = sw.devices.find(v => v.path === b.dataset.swresize); swapDialog(x.path, [1024, 2048, 4096, 8192, 16384].includes(x.sizeMb) ? x.sizeMb : 4096, `Resize ${x.path}`); }));
  container.querySelectorAll('[data-swrm]').forEach(b => b.addEventListener('click', () => {
    const x = sw.devices.find(v => v.path === b.dataset.swrm);
    showModal(`Turn off &amp; remove ${esc(b.dataset.swrm)}`, `${serverContextBanner()}<div class="text-sm">The swap is turned off, its line taken out of /etc/fstab and the file deleted.${x && x.usedMb ? ` <b>${gb(x.usedMb)}</b> is in it now: it is moved back to RAM first, and nothing is changed when the free RAM (${gb(sw.availMb || 0)}) can not take it.` : ''}</div>`,
      [{ label: 'Cancel', className: 'btn btn-secondary' }, { label: 'Turn off & remove', className: 'btn btn-danger', onClick: () => run('swap', { action: 'remove', path: b.dataset.swrm }, `Remove swap ${b.dataset.swrm}`).catch(e => showToast(e.message, 'error', 9000)) }]);
  }));
  container.querySelector('[data-swappiness]').addEventListener('click', () => UI.dialog({ title: 'Swappiness', saveLabel: 'Review changes...',
    body: `<label class="ui-field"><span class="ui-label">vm.swappiness</span><input class="input td-mono" id="sw-sp" type="number" min="0" max="200" value="${esc(sw.dockgate || sw.swappiness || 10)}"><span class="ui-sub">0–200. 10 is a good value for servers; 60 is the kernel default. Applied now, kept after a reboot.</span></label>`,
    onSave: async (ov) => { const value = ov.querySelector('#sw-sp').value.trim(); await API.post(`/servers/${serverId}/system/swap`, { action: 'swappiness', value, preview: true }); setTimeout(() => reviewThenRun('swap', { action: 'swappiness', value }, `Swappiness -> ${value}`).catch(e => showToast(e.message, 'error', 9000)), 0); } }));

  container.querySelectorAll('[data-fsrm]').forEach(b => b.addEventListener('click', () => {
    const l = d.fstab.find(x => String(x.i) === b.dataset.fsrm);
    reviewThenRun('fstab', { action: 'remove', index: l.i, raw: l.raw }, `Remove ${l.target} from /etc/fstab`, 'it stays mounted until the next reboot or umount').catch(e => showToast(e.message, 'error', 9000));
  }));
  container.querySelector('[data-fsadd]').addEventListener('click', () => {
    const free = [];
    const walk = (list) => (list || []).forEach(x => { if (x.uuid && !x.mountpoint && x.fstype && x.fstype !== 'swap') free.push(x); walk(x.children); });
    walk(d.blk);
    UI.dialog({ title: 'Add a mount', saveLabel: 'Review changes...', wide: true,
      body: `${free.length ? `<div class="ui-field"><span class="ui-label">Disks not mounted</span><div style="display:flex;gap:6px;flex-wrap:wrap">${free.map(x => `<button type="button" class="ui-fchip" data-pick="UUID=${esc(x.uuid)}" data-fs="${esc(x.fstype)}">${esc(x.name)}, ${esc(x.size)}, ${esc(x.fstype)}</button>`).join('')}</div></div>` : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          <label class="ui-field"><span class="ui-label">Source</span><input class="input td-mono" id="fs-src" placeholder="UUID=..., server:/export, //server/share"></label>
          <label class="ui-field"><span class="ui-label">Mount point</span><input class="input td-mono" id="fs-tgt" placeholder="/mnt/data"></label>
          <label class="ui-field"><span class="ui-label">File system</span><input class="input td-mono" id="fs-type" placeholder="ext4, xfs, nfs, cifs"></label>
          <label class="ui-field"><span class="ui-label">Options</span><input class="input td-mono" id="fs-opt" value="defaults,nofail"><span class="ui-sub"><b>nofail</b>: the server still starts if this disk is missing</span></label>
        </div>`,
      onOpen: (ov) => ov.querySelectorAll('[data-pick]').forEach(x => x.addEventListener('click', () => { ov.querySelector('#fs-src').value = x.dataset.pick; ov.querySelector('#fs-type').value = x.dataset.fs; })),
      onSave: async (ov) => {
        const entry = { source: ov.querySelector('#fs-src').value.trim(), target: ov.querySelector('#fs-tgt').value.trim(), fstype: ov.querySelector('#fs-type').value.trim(), options: ov.querySelector('#fs-opt').value.trim() };
        await API.post(`/servers/${serverId}/system/fstab`, { action: 'add', entry, preview: true });
        setTimeout(() => reviewThenRun('fstab', { action: 'add', entry }, `Mount ${entry.target}`, 'it is mounted once now; if that fails the file is restored').catch(e => showToast(e.message, 'error', 9000)), 0);
      } });
  });
}
