// Server Console > Security > Honeypot: a fake SSH server on port 22 once the real one has moved. It records who
// connects and what they try, refuses every login, and fail2ban bans each address on every port (server/honeypot.js).
async function renderHoneypotPanel(serverId, container) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  container.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>';
  let d;
  try { d = await API.get(`/servers/${serverId}/honeypot`); }
  catch (e) { container.innerHTML = UI.errorState(e, { title: 'The honeypot could not be read' }); return; }
  const reload = () => renderHoneypotPanel(serverId, container);
  const s = d.stats;
  const when = (ts) => ts ? new Date(ts).toLocaleString() : '-';
  const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  const fixLink = { 'ssh-moved': 'srv-access', 'dockgate-port': 'srv-access', docker: 'setup', fail2ban: 'setup' };
  const topTable = (title, rows, mono = true) => `<div class="card" style="padding:12px 14px"><b style="font-size:13px">${title}</b>${rows.length ? rows.map(r => `<div style="display:flex;gap:8px;justify-content:space-between;margin-top:6px;font-size:12.5px"><span class="${mono ? 'td-mono' : ''}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.value)}</span><span class="ui-sub">${r.count}</span></div>`).join('') : '<div class="ui-sub" style="margin-top:6px">nothing yet</div>'}</div>`;

  const status = d.on ? UI.pill('ok', 'on') : d.running || d.jailFile ? UI.pill('warn', 'half set up') : UI.pill('off', 'off');
  container.innerHTML = `
    ${UI.header('Honeypot', 'A fake SSH server on port 22, once the real SSH listens on another port. Nobody with a reason to be there connects to 22, so every address that does is banned on every port of this server (fail2ban) - before it finds the real SSH. It records the user names and passwords tried; every login is refused, there is no shell.',
      d.on ? `${UI.btn('Settings...', 'data-hp-set')} ${UI.btn('Turn off...', 'data-hp-off')}` : d.running || d.jailFile ? UI.btn('Remove...', 'data-hp-off') : '')}
    ${UI.settings([
      { label: 'Status', desc: d.on ? `Port 22 -> honeypot, real SSH on ${esc(d.sshPorts.join(', ') || d.dockgatePort)}${d.startedAt ? `, running since ${esc(when(d.startedAt))}` : ''}` : 'Port 22 answers nothing (or the real SSH)', value: status },
      ...(d.on || d.jailFile ? [
        { label: 'Banned', desc: `Each address that connects to port 22, banned for ${esc(d.bantimes[d.bantime] || d.bantime || '-')}, on every port${d.ipset ? ' (ipset)' : ''}. Unban in the Fail2ban tab.`, value: `<b>${d.bannedNow}</b> now <span class="ui-sub">· ${d.bannedTotal} since fail2ban started</span>`, action: UI.btn('Fail2ban', 'data-hp-f2b') },
        { label: 'Never banned', desc: 'Loopback and private networks (10.x, 172.16–31.x, 192.168.x), fail2ban\'s own allowlist (DockGate\'s address) and these', value: d.allow.length ? `<span class="td-mono">${esc(d.allow.join(' '))}</span>` : '<span class="ui-sub">no others</span>' },
      ] : []),
    ])}

    ${!d.on ? `
      ${UI.header('Before it can be turned on')}
      ${UI.table([{ label: 'Check' }, { label: 'Now' }, { label: '' }], d.checks.map(c => ({ cells: [
        `${c.ok === false ? UI.pill('bad', '✗') : c.ok ? UI.pill('ok', '✓') : UI.pill('warn', '?')} ${esc(c.label)}`, `<span class="ui-sub">${esc(c.value)}</span>`,
        c.ok === false ? `<span class="ui-sub">${esc(c.fix)}</span> ${fixLink[c.id] ? UI.btn('Open', `data-hp-go="${fixLink[c.id]}"`) : ''}` : ''] })), { minWidth: 700 })}
      <div style="margin:10px 0 14px">${UI.btn('Turn on...', `data-hp-set${d.ready ? '' : ' disabled'}`, d.ready ? 'btn-primary' : 'btn-secondary')} <span class="ui-sub">${d.ready ? 'Builds a small image on the server (node:22-alpine + the honeypot, ~2 MB on top of it), starts it on port 22, adds a fail2ban jail, then tests it. Uses about 50 MB of RAM.' : 'Fix the checks above first.'}</span></div>` : ''}

    ${d.on || s.events ? `
      ${UI.header('What it saw', `${s.events ? `The last ${s.events} events in its log (${kb(d.logBytes)}) since ${esc(when(s.since))}.` : 'Nothing yet - bots usually find port 22 within minutes.'}`)}
      ${UI.statusLine([`<b>${s.connects24h}</b> connections in 24 h`, `<b>${s.ips24h}</b> addresses in 24 h`, `<b>${s.connects}</b> connections, <b>${s.ips}</b> addresses in all`, `<b>${s.logins}</b> login attempts`])}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:10px 0">
        ${topTable('User names tried', s.topUsers)}${topTable('Passwords tried', s.topPasswords)}${topTable('Addresses', s.topIps)}${topTable('SSH programs', s.topClients)}
      </div>
      ${s.recent.length ? UI.table([{ label: 'When' }, { label: 'Address' }, { label: 'What' }, { label: 'User' }, { label: 'Password / key' }],
        s.recent.slice(0, 100).map(e => ({ cells: [`<span class="ui-sub">${esc(when(e.ts))}</span>`, `<span class="td-mono">${esc(e.ip)}</span>`,
          e.ev === 'ident' ? `connected <span class="ui-sub">${esc(e.client || '')}</span>` : esc(e.method || 'login'), `<span class="td-mono">${esc(e.user || '')}</span>`,
          `<span class="td-mono">${esc(e.password != null ? e.password : e.key || '')}</span>`] })), { minWidth: 820 }) : ''}` : ''}`;

  // ---- handlers ----
  container.querySelectorAll('[data-hp-go]').forEach(b => b.addEventListener('click', () => srvGo(b.dataset.hpGo)));
  const f2b = container.querySelector('[data-hp-f2b]'); if (f2b) f2b.addEventListener('click', () => srvGo('srv-fail2ban'));
  const setBtn = container.querySelector('[data-hp-set]');
  if (setBtn) setBtn.addEventListener('click', () => {
    if (setBtn.disabled) return;
    UI.dialog({ title: d.on ? 'Honeypot settings' : 'Turn on the SSH honeypot', saveLabel: d.on ? 'Apply' : 'Turn on', wide: true,
      body: `${d.on ? '' : `<div class="text-sm" style="margin-bottom:10px">Port 22 will answer like an SSH server. <b>Every address that connects to it is banned on every port of this server</b> - so do not use port 22 yourself: the real SSH is on <b>${esc(d.sshPorts.join(', ') || d.dockgatePort)}</b>.</div>`}
        <label class="ui-field"><span class="ui-label">Ban for</span><select class="input" id="hp-bt">${Object.entries(d.bantimes).map(([k, v]) => `<option value="${k}" ${k === (d.bantime || '30d') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label class="ui-field"><span class="ui-label">Never ban these addresses (optional)</span><textarea class="input td-mono" id="hp-allow" rows="3" placeholder="203.0.113.7&#10;198.51.100.0/24">${esc(d.allow.join('\n'))}</textarea>
          <span class="ui-sub">Your office or home address, a monitoring service. Loopback, private networks and fail2ban's allowlist (DockGate's address) are never banned anyway.</span></label>`,
      onSave: async (ov) => {
        const body = { bantime: ov.querySelector('#hp-bt').value, allow: ov.querySelector('#hp-allow').value.split(/[\s,]+/).filter(Boolean) };
        const r = await API.post(`/servers/${serverId}/honeypot`, body);
        setTimeout(async () => { const ok = await runLifelineJob(serverId, r.jobId, d.on ? 'Honeypot settings' : 'Turn on the SSH honeypot'); if (ok !== null) reload(); }, 0);
      } });
  });
  const offBtn = container.querySelector('[data-hp-off]');
  if (offBtn) offBtn.addEventListener('click', () => UI.dialog({ title: 'Turn off the SSH honeypot', saveLabel: 'Turn off', danger: true,
    body: `<div class="text-sm" style="margin-bottom:10px">The container, its image and its fail2ban jail are removed. Addresses it already banned stay banned until their time runs out - unban them in the Fail2ban tab.</div>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="hp-keep" checked> Keep its log (${kb(d.logBytes || 0)})</label>`,
    onSave: async (ov) => {
      const r = await API.post(`/servers/${serverId}/honeypot/off`, { keepLog: ov.querySelector('#hp-keep').checked });
      setTimeout(async () => { const ok = await runLifelineJob(serverId, r.jobId, 'Turn off the SSH honeypot'); if (ok !== null) reload(); }, 0);
    } }));
}
