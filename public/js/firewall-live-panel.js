// Server Console > Security > Live firewall: the rules as the kernel holds them (server/firewall-live.js), where each
// one comes from, "will this connection pass?", differences between the files and the live firewall, and the
// connections dropped in the last hour.
async function renderFirewallLivePanel(serverId, container) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  container.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>';
  let d;
  try { d = await API.get(`/servers/${serverId}/firewall/live`); }
  catch (e) { container.innerHTML = UI.errorState(e, { title: 'The live firewall could not be read' }); return; }
  const reload = () => renderFirewallLivePanel(serverId, container);
  const pillOf = { ufw: 'info', docker: 'off', fail2ban: 'warn', dockgate: 'ok', unknown: 'bad', system: 'off' };
  const src = (s) => UI.pill(pillOf[s.kind] || 'off', esc(s.label));
  const lvl = { crit: 'bad', warn: 'warn', info: 'info' };
  const cf = '172.68.234.207'; // an address in Cloudflare's 172.64.0.0/13

  container.innerHTML = `
    ${UI.header('Live firewall', `The rules as the kernel holds them right now (${esc(d.iptables || 'iptables')}${d.dockerBackend === 'nftables' ? ', Docker on its nftables backend' : ''}), not only what UFW lists. Each rule shows where it comes from.`, UI.btn('Read again', 'data-lf-reload'))}

    ${d.problems.length ? `${UI.header('Needs attention')}
      <div class="ui-settings">${d.problems.map(p => `<div class="ui-set" style="grid-template-columns:auto minmax(0,1fr) auto">${UI.pill(lvl[p.level] || 'warn', p.level === 'crit' ? 'High' : p.level === 'warn' ? 'Medium' : 'Info')}<div class="ui-set-l"><span>${esc(p.text)}</span></div><div class="ui-set-a">${p.fix === 'remove-leftover' ? UI.btn('Remove them...', 'data-lf-fix="remove-leftover"', 'btn-primary') : ''}</div></div>`).join('')}</div>` : `<div class="insight-card info" style="margin:6px 0 10px"><div>No differences between the firewall files and the live firewall, and nothing to web ports was dropped in the last hour.</div></div>`}

    ${UI.header('Will this connection pass?', 'A new connection from an address to a port of this server, walked through the rules the kernel uses: Docker\'s port forwarding to a container (FORWARD) or the server itself (INPUT).')}
    <div class="card" style="padding:12px 14px">
      <div style="display:grid;grid-template-columns:minmax(180px,1.4fr) 110px 100px auto;gap:8px;align-items:end">
        <label class="ui-field" style="margin:0"><span class="ui-label">From</span><input class="input td-mono" id="lf-src" value="${cf}" placeholder="203.0.113.9"></label>
        <label class="ui-field" style="margin:0"><span class="ui-label">Port</span><input class="input td-mono" id="lf-port" value="443" type="number" min="1" max="65535"></label>
        <label class="ui-field" style="margin:0"><span class="ui-label">Protocol</span><select class="input" id="lf-proto"><option>tcp</option><option>udp</option></select></label>
        <div>${UI.btn('Check', 'data-lf-check', 'btn-primary')}</div>
      </div>
      <div class="ui-sub" style="margin-top:6px">Try: <a href="#" data-lf-src="${cf}">Cloudflare</a>, <a href="#" data-lf-src="8.8.8.8">any internet address</a>${d.hostIp ? `, <a href="#" data-lf-src="10.0.0.5">a private network</a>` : ''}</div>
      <div data-lf-result style="margin-top:10px"></div>
    </div>

    ${d.ports.length ? `${UI.header('Ports Docker forwards to containers')}
      ${UI.table([{ label: 'Port on the server' }, { label: 'Container' }, { label: 'To' }, { label: '', align: 'right' }],
        d.ports.map(p => ({ cells: [`<span class="td-mono">${p.hostPort}/${esc(p.proto)}</span>`, esc(p.owner || '-'), `<span class="td-mono ui-sub">${esc(p.ip)}:${p.port}</span>`, UI.btn('Check from the internet', `data-lf-try="${p.hostPort}/${esc(p.proto)}"`)] })), { minWidth: 620 })}` : ''}

    ${UI.header('Dropped in the last hour', 'From the kernel log (UFW BLOCK, UFW DOCKER BLOCK). Logging is rate limited, so the counts are a sample.')}
    ${d.drops.length ? UI.table([{ label: 'Port' }, { label: 'Dropped' }, { label: 'Most from' }, { label: 'Last' }, { label: 'By' }],
      d.drops.map(g => ({ cells: [`<b class="td-mono">${g.dport ? `${g.dport}/${esc(g.proto)}` : esc(g.proto)}</b>${[80, 443].includes(g.dport) ? ` ${UI.pill('bad', 'web')}` : ''}`, String(g.count),
        g.sources.map(s => `<span class="td-mono">${esc(s.src)}</span> <span class="ui-sub">${s.count}</span>`).join('<br>'), `<span class="ui-sub">${esc(g.last)}</span>`,
        `<span class="ui-sub">${g.prefix === 'UFW DOCKER BLOCK' ? `Docker port isolation (to a container${g.out ? `, ${esc(g.out)}` : ''})` : 'UFW (the server)'}</span>`] })), { minWidth: 760 }) : '<div class="ui-sub" style="margin:4px 0 10px">Nothing dropped in the last hour (or the kernel log cannot be read).</div>'}

    ${UI.header('All rules', 'As iptables-save prints them, in order. A packet goes down a chain until a rule decides; a jump goes into another chain and comes back when that one ends without deciding.')}
    ${d.tables.map(t => `<details class="card" style="padding:10px 14px;margin-bottom:8px"><summary style="cursor:pointer"><b>${esc(t.name)}</b> <span class="ui-sub">${t.chains.reduce((a, c) => a + c.rules.length, 0)} rules in ${t.chains.length} chains</span></summary>
      ${t.chains.filter(c => c.rules.length).map(c => `<div style="margin-top:10px"><b class="td-mono" style="font-size:12.5px">${esc(c.name)}</b>${c.policy ? ` <span class="ui-sub">default ${esc(c.policy)}</span>` : ''}
        ${c.rules.map(r => `<div style="display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:8px;align-items:center;margin-top:4px;font-size:12px"><span class="ui-sub">${r.n}</span><span class="td-mono" style="overflow-wrap:anywhere">${esc(r.text.replace(/^-A \S+ /, ''))}</span>${src(r.source)}</div>`).join('')}</div>`).join('')}
    </details>`).join('')}`;

  // ---- handlers ----
  container.querySelector('[data-lf-reload]').addEventListener('click', reload);
  const result = container.querySelector('[data-lf-result]');
  const check = async () => {
    const body = { src: container.querySelector('#lf-src').value.trim(), port: Number(container.querySelector('#lf-port').value), proto: container.querySelector('#lf-proto').value };
    result.innerHTML = '<div class="ui-sub">Checking...</div>';
    try {
      const r = await API.post(`/servers/${serverId}/firewall/live/check`, body);
      if (r.verdict === 'unknown') { result.innerHTML = `<div class="insight-card warning"><div>${esc(r.why)}</div></div>`; return; }
      const ok = r.verdict === 'pass';
      result.innerHTML = `<div class="insight-card ${ok ? 'info' : 'danger'}" style="display:block${ok ? ';background:var(--success-bg);color:var(--success);border-left-color:var(--success)' : ''}">
          <div style="font-weight:700">${ok ? 'Passes' : 'Blocked'}: ${esc(body.src)} -> ${body.port}/${esc(body.proto)}</div>
          <div style="margin-top:4px">${esc(r.path)}.</div>
          <div style="margin-top:4px">Decided by ${esc(r.rule.chain)}${r.rule.n ? ` rule ${r.rule.n}` : ''}: <span class="td-mono">${esc(r.rule.text)}</span> ${src(r.rule.source)}</div></div>
        ${r.trace.length ? `<details style="margin-top:6px"><summary class="ui-sub" style="cursor:pointer">The way through the rules (${r.trace.length} steps)</summary>${r.trace.map(t => `<div style="display:grid;grid-template-columns:160px minmax(0,1fr) auto;gap:8px;font-size:12px;margin-top:4px"><span class="td-mono ui-sub">${esc(t.chain)} #${t.n}</span><span><span class="td-mono">${esc(t.text.replace(/^-A \S+ /, ''))}</span> <span class="ui-sub">${esc(t.note)}</span></span>${src(t.source)}</div>`).join('')}</details>` : ''}`;
    } catch (e) { result.innerHTML = `<div class="insight-card danger"><div>${esc(e.message)}</div></div>`; }
  };
  container.querySelector('[data-lf-check]').addEventListener('click', check);
  container.querySelectorAll('[data-lf-src]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); container.querySelector('#lf-src').value = a.dataset.lfSrc; check(); }));
  container.querySelectorAll('[data-lf-try]').forEach(b => b.addEventListener('click', () => {
    const [port, proto] = b.dataset.lfTry.split('/');
    container.querySelector('#lf-src').value = '8.8.8.8'; container.querySelector('#lf-port').value = port; container.querySelector('#lf-proto').value = proto;
    container.querySelector('[data-lf-result]').scrollIntoView({ block: 'center' }); check();
  }));
  container.querySelector('[data-lf-fix="remove-leftover"]')?.addEventListener('click', () => UI.dialog({ title: 'Remove the leftover isolation rules', saveLabel: 'Remove them', danger: false,
    body: '<div class="text-sm">DockGate\'s Docker port isolation rules are taken out of the live firewall. Published container ports become reachable as they were before isolation. fail2ban\'s rules (honeypot, bans from other servers) and any rule you added yourself stay.</div>',
    onSave: async () => { const r = await API.post(`/servers/${serverId}/firewall/live/fix`, { fix: 'remove-leftover' }); setTimeout(async () => { const ok = await runLifelineJob(serverId, r.jobId, 'Remove leftover isolation rules'); if (ok !== null) reload(); }, 0); } }));
}
