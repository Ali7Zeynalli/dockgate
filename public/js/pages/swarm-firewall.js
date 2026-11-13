// Swarm → Firewall: the ports Swarm services publish, on every server of the cluster (server/swarm-firewall.js).
// One row per port, one column per server: open (to whom), closed, or open to everyone because nothing filters it.
// Open / Close writes the same `ufw route allow` rule on every server with Docker port isolation.
(() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const COLOR = { open: 'var(--success)', closed: 'var(--text-muted)', unknown: 'var(--text-muted)' };

  Router.register('swarm-firewall', async (content) => {
    window.SwarmUI && SwarmUI.css && SwarmUI.css();
    let data = null;
    async function load() {
      content.innerHTML = '<div class="ui-sub">Reading the firewalls of the cluster…</div>';
      try { data = await API.get('/swarm/firewall'); } catch (e) { content.innerHTML = UI.header('Firewall', esc(e.message)); return; }
      render();
    }
    function cell(o) {
      return `<span class="text-sm" style="color:${o.risk ? 'var(--danger)' : COLOR[o.state] || 'inherit'};white-space:normal">${o.risk ? '⚠ ' : o.state === 'open' ? '● ' : '○ '}${esc(o.text)}</span>`;
    }
    function render() {
      const risky = data.servers.filter(s => s.firewall.error || !s.firewall.managed || !s.firewall.isolation);
      const rows = data.ports.map(p => ({ cells: [
        `<b>${p.published}/${esc(p.proto)}</b><div class="ui-sub">${esc(p.service)} → ${p.target}</div>`,
        `<span class="text-sm">${p.mode === 'host' ? 'host' : 'ingress'}</span><div class="ui-sub">${p.mode === 'host' ? 'servers with a task' : 'every server answers'}</div>`,
        ...p.on.map(cell),
        `${p.asked ? `<div class="ui-sub" style="margin-bottom:4px">kept: ${esc(p.asked.sources.map(x => (x === 'any4' || x === 'any6' ? 'anyone' : x)).join(', '))}</div>` : ''}<button class="btn btn-xs btn-primary" data-open="${p.published}|${esc(p.proto)}">Open…</button> <button class="btn btn-xs btn-secondary" data-close="${p.published}|${esc(p.proto)}">Close</button>`,
      ] }));
      content.innerHTML = `${UI.header('Firewall', 'The ports Swarm services publish, on every server of the cluster. Docker sends this traffic past the normal firewall rules: with <b>Docker port isolation</b> (Server Console → Firewall → Docker ports) it is dropped unless a rule here lets it through. Open and Close change every server at once; a server that joins later gets the same rules, and the rule of a service that is removed goes too.', UI.btn('Check now', 'data-sync'))}
        ${risky.length ? `<div class="insight-card warning" style="margin-bottom:10px"><div><b>Not protected:</b> ${risky.map(s => `<b>${esc(s.hostname)}</b> — ${esc(s.firewall.error || (!s.firewall.managed ? 'no firewall' : s.firewall.backend === 'firewalld' ? 'firewalld (Docker publishes past it)' : 'Docker port isolation is off'))}`).join('; ')}. Every Swarm port is open to everyone there.</div></div>` : ''}
        ${data.ports.length ? UI.table([{ label: 'Port' }, { label: 'Mode' }, ...data.servers.map(s => ({ label: `${s.hostname}${s.role === 'manager' ? ' ★' : ''}` })), { label: '' }], rows, { minWidth: 600 + data.servers.length * 160 }) : '<div class="ui-sub">No Swarm service publishes a port.</div>'}
        <div class="ui-sub" style="margin-top:8px">★ manager. Ingress ports are checked by their published port, host-mode ports by the container port (that is where Docker sends them).</div>
        <div data-fw-log class="text-sm td-mono" style="white-space:pre-wrap;margin-top:8px"></div>`;
      const sy = content.querySelector('[data-sync]'); if (sy) sy.onclick = async () => { try { const r = await API.post('/swarm/firewall/sync', {}); showToast(r.skipped ? 'Swarm is not active here' : `${(r.changed || []).length} change(s)`); } catch (e) { showToast(e.message, 'error'); } load(); };
      content.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openDialog(...b.dataset.open.split('|')));
      content.querySelectorAll('[data-close]').forEach(b => b.onclick = () => run(b.dataset.close.split('|'), []));
    }
    function openDialog(port, proto) {
      const p = data.ports.find(x => String(x.published) === port && x.proto === proto);
      const cur = (p.asked && p.asked.sources) || ['any4', 'any6'];
      const body = `<div class="text-sm" style="margin-bottom:10px">Who may reach <b>${esc(port)}/${esc(proto)}</b> (${esc(p.service)}) on every server of the cluster.</div>
        <label class="ui-field"><span class="ui-label">From</span><select class="select" data-who>
          <option value="any" ${cur.includes('any4') ? 'selected' : ''}>Anyone</option>
          <option value="list" ${cur.some(x => x.startsWith('@')) ? 'selected' : ''}>An IP list</option>
          <option value="ip" ${!cur.includes('any4') && !cur.some(x => x.startsWith('@')) ? 'selected' : ''}>Addresses</option></select></label>
        <label class="ui-field" style="margin-top:8px"><span class="ui-label">IP list name, or addresses (comma separated)</span><input class="input" data-src value="${esc(cur.filter(x => x !== 'any4' && x !== 'any6').map(x => x.replace(/^@/, '')).join(', '))}" placeholder="office, or 203.0.113.7, 10.0.0.0/8"><span class="ui-sub">IP lists are made in Server Console → Firewall → IP lists.</span></label>`;
      let picked = null;
      const d = showModal(`Open ${esc(port)}/${esc(proto)} on the cluster`, body, [
        { label: 'Cancel', className: 'btn btn-secondary' },
        { label: 'Open on every server', className: 'btn btn-primary', onClick: () => {
          const who = d.overlay.querySelector('[data-who]').value, src = d.overlay.querySelector('[data-src]').value.split(',').map(x => x.trim()).filter(Boolean);
          picked = who === 'any' ? ['any4', 'any6'] : who === 'list' ? src.slice(0, 1).map(x => `@${x}`) : src;
          setTimeout(() => (picked.length ? run([port, proto], picked) : showToast('Give a list name or an address', 'error')), 0);
        } },
      ]);
    }
    async function run([port, proto], sources) {
      const logEl = content.querySelector('[data-fw-log]');
      content.querySelectorAll('button').forEach(b => { b.disabled = true; });
      if (logEl) logEl.textContent = `${sources.length ? 'Opening' : 'Closing'} ${port}/${proto} on every server…`;
      let text = '';
      try {
        const r = await API.post('/swarm/firewall/apply', { port: Number(port), proto, sources });
        text = r.results.map(x => `${x.ok ? '✓' : x.skipped ? '–' : '✗'} ${x.hostname}: ${x.text}`).join('\n');
        showToast(`${port}/${proto}: ${sources.length ? 'opened' : 'closed'}`);
      } catch (e) { text = e.message; showToast(e.message, 'error'); }
      await load();
      const l2 = content.querySelector('[data-fw-log]'); if (l2) l2.textContent = text;
    }
    await load();
  });
})();
