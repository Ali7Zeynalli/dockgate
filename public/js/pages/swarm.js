// Swarm — phase 1: one server. Sidebar Docker → Swarm.
//   Overview          inactive: what Swarm gives + "Set up Swarm…"; active: sentence, warnings, four numbers,
//                     "Where tasks run" (a card per node with its tasks), last Swarm events. Refreshes every 5 s.
//   Cluster settings  cluster facts, autolock key, leave the swarm.
// Set up Swarm… is a five step wizard; nothing changes on the server before the last step. The Create job
// runs on DockGate: its window can be closed and opened again. Server side: server/swarm.js.

(() => {
  const STYLE = `
  .sw-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0}
  .sw-card{border:1px solid var(--border);background:var(--bg-card);border-radius:var(--radius-lg);padding:12px 14px}
  .sw-card .k{font-size:12px;color:var(--text-muted)} .sw-card .v{font-size:22px;font-weight:600;margin-top:2px}
  .sw-card.ok .v{color:var(--success,#16a34a)} .sw-card.warn .v{color:var(--warning,#d97706)}
  .sw-nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin:8px 0 14px}
  .sw-node{border:1px solid var(--border);background:var(--bg-card);border-radius:var(--radius-lg);padding:12px}
  .sw-node.down{opacity:.6;border-style:dashed}
  .sw-node h4{margin:0 0 2px;font-size:14px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .sw-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
  .sw-chip{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--border);font-family:var(--font-mono,monospace)}
  .sw-chip.running{background:rgba(22,163,74,.12);border-color:rgba(22,163,74,.4)}
  .sw-chip.starting{background:rgba(217,119,6,.12);border-color:rgba(217,119,6,.4)}
  .sw-chip.failed{background:rgba(220,38,38,.12);border-color:rgba(220,38,38,.45)}
  .sw-steps{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .sw-steps span{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted)}
  .sw-steps span.on{border-color:var(--accent);color:var(--text-primary);font-weight:600}
  .sw-steps span.done{color:var(--success,#16a34a)}
  .sw-mode{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
  .sw-opt{border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px;cursor:pointer;background:var(--bg-card)}
  .sw-opt.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
  .sw-opt.dis{opacity:.55;cursor:not-allowed}
  .sw-check{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)} .sw-check:last-child{border-bottom:0}
  .sw-check .ic{width:18px;flex:none;font-weight:700} .sw-check .ok{color:var(--success,#16a34a)} .sw-check .warn{color:var(--warning,#d97706)} .sw-check .bad{color:var(--danger,#dc2626)} .sw-check .info{color:var(--text-muted)}
  .sw-form{display:grid;grid-template-columns:1fr 1fr;gap:10px} @media(max-width:640px){.sw-form{grid-template-columns:1fr}}
  .sw-key{font-family:var(--font-mono,monospace);word-break:break-all;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;user-select:all}
  `;
  function css() { if (!document.getElementById('sw-style')) { const s = document.createElement('style'); s.id = 'sw-style'; s.textContent = STYLE; document.head.appendChild(s); } }
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const banner = (level, html, actions = '') => `<div class="insight-card ${level === 'bad' ? 'danger' : level === 'warn' ? 'warning' : 'info'}" style="margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:220px">${html}</div>${actions ? `<div style="display:flex;gap:6px">${actions}</div>` : ''}</div>`;

  // ---- the job window (Create Swarm) ----
  function openJob(jobId, onDone) {
    const m = showModal('Create Swarm', `${serverContextBanner()}<div id="sw-job-steps" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px"></div><div id="sw-job-log"></div>
      <div id="sw-job-status" style="margin-top:10px;font-weight:600;font-size:13px;color:var(--text-muted)">⏳ Working…</div><div id="sw-job-extra"></div>
      <div class="ui-sub" style="margin-top:4px">Closing this window does not stop the job. Reopen it from Swarm → Overview.</div>`, []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const close = document.createElement('button'); close.className = 'btn btn-secondary'; close.textContent = 'Close';
    let ended = null;
    const doClose = () => { m.close(); if (ended && onDone) onDone(ended); };
    close.onclick = doClose; m.overlay.querySelector('.modal-close').onclick = doClose;
    m.overlay.querySelector('#modal-footer').appendChild(close);
    const viewer = LogViewer.mount(m.overlay.querySelector('#sw-job-log'), { key: 'swarm-job', fileName: `swarm-${jobId}`, live: true, limits: null, compact: true, height: '260px', empty: 'Starting…' });
    let sent = 0, timer = null;
    const icon = { pending: '○', running: '⏳', done: '✓', failed: '✗' }, color = { pending: 'var(--text-muted)', running: 'var(--text-primary)', done: '#16a34a', failed: '#dc2626' };
    const poll = async () => {
      if (!m.overlay.isConnected) return;
      try {
        const j = await API.get(`/swarm/job/${jobId}`);
        const lines = String(j.log || '').split('\n'); const upto = j.finishedAt ? lines.length : lines.length - 1;
        if (upto > sent) { viewer.push(lines.slice(sent, upto).join('\n')); sent = upto; }
        m.overlay.querySelector('#sw-job-steps').innerHTML = (j.steps || []).map(s => `<div class="text-sm" style="color:${color[s.status]}">${icon[s.status] || '○'} ${esc(s.label)}</div>`).join('');
        if (j.finishedAt) {
          ended = j;
          const se = m.overlay.querySelector('#sw-job-status');
          se.style.color = j.status === 'done' ? '#16a34a' : '#dc2626';
          se.textContent = j.status === 'done' ? '✓ Swarm is on' : `✗ ${j.error || 'Failed'}`;
          const ex = m.overlay.querySelector('#sw-job-extra');
          if (j.result && j.result.unlockKey) {
            ex.innerHTML = `<div class="insight-card warning" style="margin-top:10px"><div><b>Unlock key</b> — after Docker restarts, the swarm stays locked until it is unlocked with this key. DockGate keeps it (encrypted) and can unlock for you; keep a copy in your password manager too. It is shown here once.<div class="sw-key" style="margin-top:6px">${esc(j.result.unlockKey)}</div></div></div>`;
          }
          close.className = 'btn btn-primary';
          return;
        }
      } catch (e) { /* retry */ }
      timer = setTimeout(poll, 1000);
    };
    poll();
    return m;
  }

  // ---- Set up Swarm… wizard ----
  function openWizard(st, onDone) {
    const steps = ['Mode', 'Server', 'Checks', 'Options', 'Create'];
    const s = { step: 0, mode: 'one', checks: null, addr: '', pool: '10.0.0.0/8', subnetSize: 24, dataPort: 4789, autolock: false, certDays: 90, taskHistory: 5, addresses: [] };
    const active = (typeof Store !== 'undefined' && Store.get('activeServer')) || { id: 'local', name: 'Local' };
    const m = showModal('Set up Swarm', '<div id="sw-wiz"></div>', []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const footer = m.overlay.querySelector('#modal-footer');
    const back = document.createElement('button'); back.className = 'btn btn-secondary'; back.textContent = 'Back';
    const next = document.createElement('button'); next.className = 'btn btn-primary'; next.textContent = 'Next';
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
    footer.append(cancel, back, next);
    const root = m.overlay.querySelector('#sw-wiz');
    const head = () => `${serverContextBanner()}<div class="sw-steps">${steps.map((x, i) => `<span class="${i === s.step ? 'on' : i < s.step ? 'done' : ''}">${i < s.step ? '✓ ' : `${i + 1}. `}${x}</span>`).join('')}</div>`;

    async function runChecks() {
      root.querySelector('#sw-checks').innerHTML = '<div class="text-sm text-muted">Checking the server…</div>';
      next.disabled = true;
      try {
        const r = await API.post('/swarm/checks', { pool: s.pool });
        s.checks = r; s.addresses = r.addresses || [];
        if (r.pool && r.pool !== s.pool) s.pool = r.pool; // a free pool when the default overlaps
        if (!s.addr && s.addresses.length) s.addr = (s.addresses.find(a => a.private) || s.addresses[0]).ip;
        root.querySelector('#sw-checks').innerHTML = r.checks.map(c => `<div class="sw-check"><div class="ic ${c.status}">${{ ok: '✓', warn: '!', bad: '✗', info: 'i' }[c.status]}</div><div><b class="text-sm">${esc(c.label)}</b><div class="text-sm text-muted">${esc(c.detail)}</div>${c.fix ? `<div class="text-sm" style="margin-top:2px"><b>Fix:</b> ${esc(c.fix)}</div>` : ''}</div></div>`).join('')
          + (r.ok ? '' : '<div class="insight-card danger" style="margin-top:10px"><div>Fix the red items, then <b>Run again</b>. Nothing was changed on the server.</div></div>');
        next.disabled = !r.ok;
      } catch (e) { root.querySelector('#sw-checks').innerHTML = UI.errorState(e, { compact: true }); }
    }

    function render() {
      back.style.display = s.step === 0 ? 'none' : '';
      next.disabled = false;
      next.textContent = s.step === 4 ? 'Create Swarm' : 'Next';
      if (s.step === 0) {
        root.innerHTML = `${head()}<div class="sw-mode">
          <div class="sw-opt sel" data-mode="one"><b>One server</b><div class="text-sm text-muted" style="margin-top:4px">This server is manager and worker. You get replicas, rolling updates with automatic roll back, restarts of failed containers, secrets and configs — on one VPS. Servers can be added later.</div></div>
          <div class="sw-opt dis" title="Comes with the Nodes page in the next version"><b>Several servers</b><div class="text-sm text-muted" style="margin-top:4px">Managers and workers on several servers. Comes in the next version, together with the Nodes page.</div></div>
        </div>`;
      } else if (s.step === 1) {
        root.innerHTML = `${head()}${UI.table([{ label: 'Server' }, { label: 'Docker' }, { label: 'CPU' }, { label: 'Role' }], [{ cells: [`<b>${esc(active.name || active.id)}</b>${active.host ? `<div class="ui-sub">${esc(active.host)}</div>` : ''}`, esc(st.dockerVersion), esc(st.arch), UI.pill('info', 'manager') + ' <span class="ui-sub">also runs tasks</span>'] }], { minWidth: 0 })}
          <p class="text-sm text-muted" style="margin-top:10px">Swarm is set up on the server in use. To use another server, switch it at the top first.</p>`;
      } else if (s.step === 2) {
        root.innerHTML = `${head()}<div id="sw-checks"></div><div style="margin-top:8px">${UI.btn('Run again', 'data-recheck')}</div>`;
        root.querySelector('[data-recheck]').onclick = runChecks;
        runChecks();
      } else if (s.step === 3) {
        const opts = s.addresses.map(a => `<option value="${esc(a.ip)}" ${a.ip === s.addr ? 'selected' : ''}>${esc(a.ip)}${a.iface ? ` — ${esc(a.iface)}` : ''}${a.private ? ' (private)' : ' (public)'}</option>`).join('');
        root.innerHTML = `${head()}
          <div class="ui-field"><span class="ui-label">Address Swarm uses</span>
            <select class="select" data-f="addr">${opts}<option value="" ${!s.addr ? 'selected' : ''}>Let Docker choose</option><option value="__custom">Another address…</option></select>
            <input class="input" data-f="addrCustom" placeholder="e.g. 10.0.0.5" style="margin-top:6px;display:none">
            <div class="ui-sub" style="margin-top:4px">With one server this only matters later, when servers join: then a private network address is best.</div></div>
          <div class="insight-card info" style="margin:10px 0"><div><b>Firewall:</b> no ports are opened on one server. Docker listens on 2377/tcp for Swarm management; keep it closed to the internet (Server Console → Firewall).</div></div>
          <details ${s.checks && s.checks.checks.some(c => c.id === 'pool' && c.status === 'warn') ? 'open' : ''}><summary class="text-sm" style="cursor:pointer;font-weight:600">Advanced — set now, can not be changed later</summary>
            <div class="sw-form" style="margin-top:10px">
              <label class="ui-field"><span class="ui-label">Overlay address pool</span><input class="input" data-f="pool" value="${esc(s.pool)}"><span class="ui-sub">Overlay networks take addresses from here. Must not overlap networks the server uses.</span></label>
              <label class="ui-field"><span class="ui-label">Network size (mask)</span><input class="input" type="number" data-f="subnetSize" value="${s.subnetSize}" min="16" max="29"><span class="ui-sub">/24 = 254 containers per overlay network.</span></label>
              <label class="ui-field"><span class="ui-label">Data port (VXLAN)</span><input class="input" type="number" data-f="dataPort" value="${s.dataPort}"><span class="ui-sub">4789/udp unless a cloud network already uses it.</span></label>
              <label class="ui-field"><span class="ui-label">Node certificate lifetime (days)</span><input class="input" type="number" data-f="certDays" value="${s.certDays}"><span class="ui-sub">Swarm renews certificates by itself.</span></label>
              <label class="ui-field"><span class="ui-label">Task history per slot</span><input class="input" type="number" data-f="taskHistory" value="${s.taskHistory}"><span class="ui-sub">Old tasks kept for logs and errors.</span></label>
              <label class="ui-field" style="align-self:center"><span><input type="checkbox" data-f="autolock" ${s.autolock ? 'checked' : ''}> Autolock</span><span class="ui-sub">Encrypts the swarm's keys at rest. After every Docker restart the swarm stays locked until it is unlocked; DockGate keeps the key and offers Unlock.</span></label>
            </div></details>`;
        const sel = root.querySelector('[data-f="addr"]'), custom = root.querySelector('[data-f="addrCustom"]');
        sel.onchange = () => { custom.style.display = sel.value === '__custom' ? '' : 'none'; };
      } else {
        const rows = [['Server', esc(active.name || active.id)], ['Role', 'manager (also runs tasks)'], ['Address', esc(s.addr || 'Docker chooses')], ['Address pool', `${esc(s.pool)} · /${s.subnetSize}`], ['Data port', s.dataPort], ['Certificates', `${s.certDays} days`], ['Task history', s.taskHistory], ['Autolock', s.autolock ? 'on — the key is shown once at the end' : 'off']];
        root.innerHTML = `${head()}${UI.table([{ label: '' }, { label: '' }], rows.map(r => ({ cells: [`<span class="ui-sub">${r[0]}</span>`, r[1]] })), { minWidth: 0 })}
          <div class="insight-card info" style="margin-top:10px"><div><b>What happens:</b> <span class="td-mono">docker swarm init</span> on this server, then a check that the node is Ready. Running containers and compose projects are not stopped or changed. If the check fails, the server leaves the swarm again.</div></div>`;
      }
      root.querySelectorAll('[data-mode]').forEach(el => el.onclick = () => { s.mode = el.dataset.mode; });
    }
    function readOptions() {
      const v = (f) => root.querySelector(`[data-f="${f}"]`);
      if (!v('pool')) return;
      const a = v('addr').value;
      s.addr = a === '__custom' ? v('addrCustom').value.trim() : a;
      s.pool = v('pool').value.trim(); s.subnetSize = Number(v('subnetSize').value); s.dataPort = Number(v('dataPort').value);
      s.certDays = Number(v('certDays').value); s.taskHistory = Number(v('taskHistory').value); s.autolock = v('autolock').checked;
    }
    back.onclick = () => { if (s.step === 3) readOptions(); s.step = Math.max(0, s.step - 1); render(); };
    next.onclick = async () => {
      if (s.step === 3) {
        readOptions();
        if (s.addr && !/^\d+\.\d+\.\d+\.\d+$/.test(s.addr)) { showToast('Enter an IPv4 address', 'warning'); return; }
        if (s.addr && s.addresses.length && !s.addresses.some(x => x.ip === s.addr) && !confirm(`${s.addr} is not one of this server's addresses (${s.addresses.map(x => x.ip).join(', ')}). Docker accepts it (for a server behind NAT), but other servers must reach this server on it. Use it anyway?`)) return;
        // the pool may have changed: check it before going on
        try {
          const r = await API.post('/swarm/checks', { pool: s.pool });
          const pc = r.checks.find(c => c.id === 'pool');
          if (pc && pc.status === 'bad') { showToast(pc.detail, 'error', 8000); return; }
          if (pc && pc.status === 'warn' && !confirm(`${pc.detail}\n\nUse this pool anyway?`)) return;
        } catch (e) { showToast(e.message, 'error'); return; }
      }
      if (s.step < 4) { s.step++; render(); return; }
      next.disabled = true;
      try {
        const r = await API.post('/swarm/init', { advertiseAddr: s.addr, pool: s.pool, subnetSize: s.subnetSize, dataPort: s.dataPort, autolock: s.autolock, certDays: s.certDays, taskHistory: s.taskHistory });
        m.close();
        openJob(r.jobId, (j) => {
          if (j.result && j.result.needAddress) { // the server has several addresses: ask, then start again
            const again = { ...s, step: 3, addresses: j.result.addresses.map(a => ({ ...a, iface: '' })) };
            again.addr = (again.addresses.find(a => a.private) || again.addresses[0]).ip;
            openWizard(st, onDone).set(again);
          } else if (onDone) onDone();
        });
      } catch (e) { next.disabled = false; showToast(e.message, 'error', 9000); }
    };
    render();
    return { set: (state) => { Object.assign(s, state); render(); } };
  }

  // ---- Overview ----
  Router.register('swarm-overview', async (content) => {
    css();
    const navId = Router._navId;
    let timer = null;
    const stop = () => clearTimeout(timer);

    async function load() {
      if (!Router.isActiveNav(navId) || !content.isConnected) return stop();
      let data;
      try { data = await API.get('/swarm/overview'); }
      catch (e) { content.innerHTML = UI.errorState(e, { title: 'Swarm status could not be read' }); return; }
      if (!Router.isActiveNav(navId)) return;
      const st = data.status;
      const job = (await API.get('/swarm/status').catch(() => ({}))).job;
      const jobBanner = job ? banner('info', '<b>Create Swarm is running.</b>', UI.btn('Open', 'data-open-job', 'btn-primary')) : '';

      if (st.state === 'inactive' || st.state === 'error' && !st.nodeId) {
        content.innerHTML = `${UI.header('Swarm', `Docker Swarm is off on <b>${esc(st.serverName)}</b>.`, job ? '' : UI.primary('Set up Swarm…', 'data-setup'))}${jobBanner}
          <div class="sw-cards">
            <div class="sw-card"><b>Replicas and self-healing</b><div class="text-sm text-muted" style="margin-top:4px">Run a service as several containers; a container that dies is started again.</div></div>
            <div class="sw-card"><b>Updates with roll back</b><div class="text-sm text-muted" style="margin-top:4px">Rolling updates, one container at a time, and back to the previous version when the new one fails.</div></div>
            <div class="sw-card"><b>Secrets and configs</b><div class="text-sm text-muted" style="margin-top:4px">Passwords and config files kept by Swarm instead of .env files.</div></div>
            <div class="sw-card"><b>One server now, more later</b><div class="text-sm text-muted" style="margin-top:4px">It works on one VPS. Servers can join the cluster later.</div></div>
          </div>
          <p class="text-sm text-muted">Turning Swarm on does not stop or change running containers or compose projects. Moving compose projects to Swarm is a separate step that comes in a later version.</p>`;
      } else if (st.state === 'locked') {
        content.innerHTML = `${UI.header('Swarm', `The swarm on <b>${esc(st.serverName)}</b> is locked.`)}
          ${banner('bad', '<b>Swarm is locked.</b> Autolock is on and Docker was restarted: services keep their containers but the swarm can not be managed until it is unlocked.', UI.btn('Unlock…', 'data-unlock', 'btn-primary'))}`;
      } else if (st.state === 'active' && !st.manager) {
        content.innerHTML = `${UI.header('Swarm', `<b>${esc(st.serverName)}</b> is a worker in a swarm.`)}${banner('info', 'Workers can not show or change the cluster. Switch to a manager server at the top to manage it.')}`;
      } else if (st.state === 'pending') {
        content.innerHTML = `${UI.header('Swarm', 'Joining a swarm…')}${banner('warn', 'The server is joining a swarm. This page refreshes by itself.')}`;
      } else {
        const c = data.counts;
        const sentence = c.nodes === 1 ? `Single-server Swarm on <b>${esc(data.nodes[0].hostname)}</b>.` : `${c.nodes} servers in one cluster: ${plural(c.managers, 'manager')}, ${plural(c.nodes - c.managers, 'worker')}.`;
        const card = (k, v, tone) => `<div class="sw-card ${tone || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
        const node = (n) => `<div class="sw-node ${n.state !== 'ready' ? 'down' : ''}">
            <h4>${esc(n.hostname)} ${n.leader ? UI.pill('info', 'leader') : ''} ${UI.pill(n.state === 'ready' ? 'ok' : 'bad', esc(n.state))} ${n.availability !== 'active' ? UI.pill('warn', esc(n.availability)) : ''}</h4>
            <div class="ui-sub">${esc(n.role)} · ${esc(n.addr)} · ${esc(n.arch)} · Docker ${esc(n.engine)}</div>
            <div class="sw-chips">${n.tasks.length ? n.tasks.map(t => {
              const cls = t.state === 'running' ? 'running' : ['failed', 'rejected'].includes(t.state) ? 'failed' : 'starting';
              return `<span class="sw-chip ${cls}" title="${esc(`${t.service}${t.slot ? '.' + t.slot : ''} · ${t.state}${t.error ? ' · ' + t.error : ''} · ${t.image}`)}">${esc(t.service)}${t.slot ? '.' + t.slot : ''}</span>`;
            }).join('') : '<span class="ui-sub">No tasks</span>'}</div></div>`;
        content.innerHTML = `${UI.header('Swarm', sentence, '<span class="ui-sub">Services and stacks come in the next versions.</span>')}${jobBanner}
          ${data.warnings.map(w => banner(w.level, esc(w.text))).join('')}
          <div class="sw-cards">
            ${card('Ready servers', `${c.ready}/${c.nodes}`, c.ready === c.nodes ? 'ok' : 'warn')}
            ${card('Managers', `${c.managers} <span class="ui-sub" style="font-size:12px">· tolerates ${plural(c.tolerates, 'loss', 'losses')}</span>`, c.managers === 2 ? 'warn' : '')}
            ${card('Services', c.services)}
            ${card('Running tasks', `${c.running}/${c.desired}`, c.running < c.desired ? 'warn' : c.desired ? 'ok' : '')}
          </div>
          <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Where tasks run</div><div class="ui-ph-desc">Green runs, amber is starting, red failed (hover for the error).</div></div></div>
          <div class="sw-nodes">${data.nodes.map(node).join('')}</div>
          <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Recent Swarm events</div><div class="ui-ph-desc">Services, nodes, secrets and configs, last 24 hours.</div></div></div>
          ${UI.table([{ label: 'When' }, { label: 'What' }, { label: 'Name' }, { label: 'Detail' }], data.events.map(e => ({ cells: [
            `<span class="ui-sub" title="${esc(formatTime(new Date(e.time * 1000).toISOString()))}">${esc(timeAgo(e.time))}</span>`, `${esc(e.type)} ${esc(e.action)}`, `<b>${esc(e.name || String(e.id || '').slice(0, 12))}</b>`, `<span class="ui-sub td-mono">${esc(e.detail)}</span>`] })), { empty: 'No Swarm events in the last 24 hours.', minWidth: 560 })}`;
      }
      content.querySelector('[data-setup]')?.addEventListener('click', () => openWizard(st, load));
      content.querySelector('[data-open-job]')?.addEventListener('click', () => openJob(job, load));
      content.querySelector('[data-unlock]')?.addEventListener('click', () => unlockDialog(st, load));
      stop();
      if (st.state !== 'inactive') timer = setTimeout(load, 5000);
      else if (job) timer = setTimeout(load, 3000);
    }
    await load();
    return stop;
  });

  function unlockDialog(st, onDone) {
    UI.dialog({ title: 'Unlock the swarm', saveLabel: 'Unlock',
      body: `<p class="text-sm">${st.hasStoredKey ? 'DockGate has the unlock key stored. Leave the field empty to use it, or enter another key.' : 'Enter the unlock key (SWMKEY-1-…) you saved when Swarm was set up.'}</p>
        <input class="input" data-key placeholder="${st.hasStoredKey ? 'Use the stored key' : 'SWMKEY-1-…'}" autocomplete="off">`,
      onSave: async (ov) => { await API.post('/swarm/unlock', { key: ov.querySelector('[data-key]').value.trim() }); showToast('Swarm unlocked'); onDone && onDone(); } });
  }

  // ---- Cluster settings ----
  Router.register('swarm-settings', async (content) => {
    css();
    async function load() {
      let d;
      try { d = await API.get('/swarm/settings'); } catch (e) { content.innerHTML = UI.errorState(e); return; }
      const st = d.status;
      if (!d.cluster) {
        content.innerHTML = `${UI.header('Cluster settings', st.state === 'locked' ? 'The swarm is locked — unlock it on the Overview.' : st.state === 'active' ? 'This server is a worker; switch to a manager.' : 'Swarm is off on this server.', st.state === 'inactive' ? UI.btn('Open Overview', 'data-go') : '')}`;
        content.querySelector('[data-go]')?.addEventListener('click', () => Router.navigate('swarm', { tab: 'swarm-overview' }));
        return;
      }
      const c = d.cluster;
      content.innerHTML = `${UI.header('Cluster settings', `Swarm on <b>${esc(st.serverName)}</b>.`)}
        ${UI.settings([
          { label: 'Cluster ID', value: `<span class="td-mono">${esc(c.id)}</span>` },
          { label: 'Created', value: esc(formatTime(c.createdAt)) },
          { label: 'Overlay address pool', desc: 'Set when the swarm was created.', value: `<span class="td-mono">${esc((c.defaultAddrPool || []).join(', '))}</span> · /${esc(c.subnetSize)}` },
          { label: 'Data port', value: esc(c.dataPort) },
          { label: 'Node certificate lifetime', value: `${esc(c.certExpiryDays)} days` },
          { label: 'Task history per slot', value: esc(c.taskHistory) },
          { label: 'Autolock', desc: c.autolock ? 'After a Docker restart the swarm is locked until it is unlocked with the key.' : 'Off: the swarm starts unlocked after a Docker restart.', value: c.autolock ? UI.pill('ok', 'on') : UI.pill('off', 'off'), action: c.autolock && st.hasStoredKey ? UI.btn('Show unlock key…', 'data-showkey') : '' },
        ])}
        <div class="ui-ph" style="margin-top:18px"><div class="ui-ph-text"><div class="ui-ph-title">Turn Swarm off</div><div class="ui-ph-desc">The server leaves the swarm. With one server that removes the swarm with its services, secrets and configs. Containers of compose projects are not touched.</div></div><div class="ui-ph-actions">${UI.btn('Turn Swarm off…', 'data-leave', 'btn-danger')}</div></div>`;
      content.querySelector('[data-showkey]')?.addEventListener('click', () => secConfirm({ title: 'Show the unlock key', change: 'The key is shown on screen.', protects: 'Showing it is recorded in the audit log.', undo: '—', confirmLabel: 'Show', onConfirm: async () => {
        try { const r = await API.post('/swarm/unlock-key', {}); showModal('Unlock key', `<div class="sw-key">${esc(r.key || '(none stored)')}</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]); } catch (e) { showToast(e.message, 'error'); }
      } }));
      content.querySelector('[data-leave]')?.addEventListener('click', async () => {
        let services = 0; try { services = (await API.get('/swarm/overview')).counts.services; } catch (e) { /* ignore */ }
        showDeleteConfirm('Turn Swarm off', {
          message: `The server <b>${esc(st.serverName)}</b> leaves the swarm.${services ? ` <b>${plural(services, 'service')} and ${services === 1 ? 'its' : 'their'} containers are removed.</b>` : ''} Compose projects keep running.`,
          phrase: st.serverName, confirmLabel: 'Turn Swarm off',
          onConfirm: async () => {
            try { await API.post('/swarm/leave', { confirm: true }); showToast('Swarm is off'); Router.navigate('swarm', { tab: 'swarm-overview' }); }
            catch (e) { showToast(e.message, 'error', 9000); }
          },
        });
      });
    }
    await load();
  });
})();
