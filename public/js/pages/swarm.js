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

  // ---- the job window (Create Swarm, Add servers, Rebalance, Remove node) ----
  const DONE_TEXT = { 'Create Swarm': '✓ Swarm is on', 'Add servers': '✓ Servers added', Rebalance: '✓ Rebalanced', 'Remove node': '✓ Node removed', 'Move to Swarm': '✓ Every project moved', 'Move back to Compose': '✓ Runs in Compose again', Redeploy: '✓ Deployed', 'Recover cluster': '✓ Recovered — one manager now; add managers again', 'Rotate secret': '✓ Rotated — the old version is removed', 'Edit config': '✓ Saved — the old version is removed' };
  function openJob(jobId, onDone, title = 'Create Swarm') {
    const m = showModal(esc(title), `${serverContextBanner()}<div id="sw-job-steps" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px"></div><div id="sw-job-log"></div>
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
          se.textContent = j.status === 'done' ? (DONE_TEXT[title] || '✓ Done') : `✗ ${j.error || 'Failed'}`;
          const ex = m.overlay.querySelector('#sw-job-extra');
          if (j.result && j.result.projects) {
            const lbl = { moved: ['ok', 'moved'], rolled_back: ['warn', 'put back in Compose'], changed: ['warn', 'files changed — not moved'], skipped: ['off', 'not moved'], failed: ['bad', 'failed'] };
            ex.innerHTML = `<div class="ui-ph-title" style="margin:12px 0 6px">Report</div>${UI.table([{ label: 'Project' }, { label: 'Result' }, { label: 'Down for' }, { label: 'Why' }], j.result.projects.map(x => ({ cells: [`<b>${esc(x.project)}</b>`, UI.pill(...(lbl[x.status] || ['off', esc(x.status)])), x.downtimeMs ? `${Math.round(x.downtimeMs / 1000)}s` : '—', `<span class="text-sm">${esc(x.error || '')}</span>`] })), { minWidth: 0 })}`;
          }
          if (j.result && j.result.unlockKey) {
            ex.innerHTML += `<div class="insight-card warning" style="margin-top:10px"><div><b>Unlock key</b> — after Docker restarts, the swarm stays locked until it is unlocked with this key. DockGate keeps it (encrypted) and can unlock for you; keep a copy in your password manager too. It is shown here once.<div class="sw-key" style="margin-top:6px">${esc(j.result.unlockKey)}</div></div></div>`;
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

  window.SwarmUI = { openJob: (...a) => openJob(...a), css }; // used by the Stacks / Migrate tabs (swarm-stacks.js)

  // ---- Set up Swarm… / Add servers… wizard ----
  // Modes: one (one server), several (create with several servers), add (join servers to the running swarm).
  // Nothing changes on any server before the last step.
  const checkList = (list) => list.map(c => `<div class="sw-check"><div class="ic ${c.status}">${{ ok: '✓', warn: '!', bad: '✗', info: 'i' }[c.status]}</div><div><b class="text-sm">${esc(c.label)}</b><div class="text-sm text-muted">${esc(c.detail)}</div>${c.fix ? `<div class="text-sm" style="margin-top:2px"><b>Fix:</b> ${esc(c.fix)}</div>` : ''}</div></div>`).join('');
  const tolerance = (m) => (m === 2 ? '<span style="color:var(--warning,#d97706)">2 managers tolerate no loss — use 1, 3 or 5</span>' : `${plural(m, 'manager')} · tolerates ${plural(Math.floor((m - 1) / 2), 'loss', 'losses')}`);

  function openWizard(st, onDone, { add = false } = {}) {
    const s = { step: 0, mode: add ? 'add' : 'one', checks: null, addr: '', pool: '10.0.0.0/8', subnetSize: 24, dataPort: 4789, autolock: false, certDays: 90, taskHistory: 5, addresses: [],
      list: null, picks: {}, join: null, encrypt: false };
    const active = (typeof Store !== 'undefined' && Store.get('activeServer')) || { id: 'local', name: 'Local' };
    const stepsFor = () => (s.mode === 'one' ? ['Mode', 'Server', 'Checks', 'Options', 'Create'] : s.mode === 'several' ? ['Mode', 'Servers', 'Checks', 'Network', 'Create'] : ['Servers', 'Checks', 'Network', 'Add']);
    const name = () => stepsFor()[s.step];
    const m = showModal(add ? 'Add servers to the swarm' : 'Set up Swarm', '<div id="sw-wiz"></div>', []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const footer = m.overlay.querySelector('#modal-footer');
    const back = document.createElement('button'); back.className = 'btn btn-secondary'; back.textContent = 'Back';
    const next = document.createElement('button'); next.className = 'btn btn-primary'; next.textContent = 'Next';
    const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => m.close();
    footer.append(cancel, back, next);
    const root = m.overlay.querySelector('#sw-wiz');
    const head = () => `${serverContextBanner()}<div class="sw-steps">${stepsFor().map((x, i) => `<span class="${i === s.step ? 'on' : i < s.step ? 'done' : ''}">${i < s.step ? '✓ ' : `${i + 1}. `}${x}</span>`).join('')}</div>`;
    const chosen = () => Object.entries(s.picks).filter(([, p]) => p.on).map(([id, p]) => ({ id, ...p }));
    const managers = () => chosen().filter(p => p.role === 'manager').length + (s.mode === 'several' ? 1 : 0) + (s.mode === 'add' ? (s.clusterManagers || 0) : 0);
    const serverName = (id) => { const x = (s.list || []).find(v => v.id === id); return x ? x.name : id; };

    async function loadList() {
      if (s.list) return;
      if (s.mode === 'add') {
        const [c, n] = await Promise.all([API.get('/swarm/candidates'), API.get('/swarm/nodes')]);
        s.list = c.servers; s.clusterManagers = n.managers;
      } else {
        const r = await API.get('/servers');
        s.list = r.servers.filter(x => x.id !== active.id).map(x => ({ id: x.id, name: x.name || (x.id === 'local' ? 'Local' : x.id), host: x.host || null, local: x.id === 'local' }));
      }
    }

    async function runChecks() {
      const box = root.querySelector('#sw-checks');
      box.innerHTML = '<div class="text-sm text-muted">Checking the servers… (each one over SSH, this can take a few seconds)</div>';
      next.disabled = true;
      try {
        let ok = true, html = '';
        if (s.mode !== 'add') {
          const r = await API.post('/swarm/checks', { pool: s.pool });
          s.checks = r; s.addresses = r.addresses || [];
          if (r.pool && r.pool !== s.pool) s.pool = r.pool;
          if (!s.addr && s.addresses.length) s.addr = (s.addresses.find(a => a.private) || s.addresses[0]).ip;
          ok = r.ok;
          html += `${s.mode === 'several' ? `<div class="ui-ph-title" style="margin:4px 0">${esc(active.name || active.id)} <span class="ui-sub">— first manager</span></div>` : ''}${checkList(r.checks)}`;
        }
        if (s.mode !== 'one') {
          const j = await API.post('/swarm/candidates/check', { create: s.mode === 'several', managerAddr: s.addr || undefined, dataPort: s.dataPort, servers: chosen().map(p => ({ id: p.id, role: p.role })) });
          s.join = j; ok = ok && j.ok;
          for (const x of j.servers) {
            if (!s.picks[x.id].addr) s.picks[x.id].addr = x.suggested || '';
            s.picks[x.id].addresses = x.addresses; s.picks[x.id].facts = x.facts;
            html += `<div class="ui-ph-title" style="margin:14px 0 4px">${esc(x.name)} <span class="ui-sub">— ${esc(x.role)}</span></div>${checkList(x.checks)}`;
          }
        }
        box.innerHTML = html + (ok ? '' : '<div class="insight-card danger" style="margin-top:10px"><div>Fix the red items, then <b>Run again</b>. Nothing was changed on any server.</div></div>');
        next.disabled = !ok;
      } catch (e) { box.innerHTML = UI.errorState(e, { compact: true }); }
    }

    const addrSelect = (key, list, cur, allowAuto) => `<select class="select" data-addr="${esc(key)}">${(list || []).map(a => `<option value="${esc(a.ip)}" ${a.ip === cur ? 'selected' : ''}>${esc(a.ip)}${a.iface ? ` — ${esc(a.iface)}` : ''}${a.private ? ' (private)' : ' (public)'}</option>`).join('')}${allowAuto ? `<option value="" ${!cur ? 'selected' : ''}>Let Docker choose</option>` : ''}<option value="__custom" ${!(list || []).length && !allowAuto ? 'selected' : ''}>Another address…</option></select><input class="input" data-addr-custom="${esc(key)}" placeholder="e.g. 10.0.0.5" value="${!(list || []).length && !allowAuto ? esc(cur || '') : ''}" style="margin-top:6px;${!(list || []).length && !allowAuto ? '' : 'display:none'}">`; // no list (DockGate in a container): the input is the only way
    const advanced = (open) => `<details ${open ? 'open' : ''}><summary class="text-sm" style="cursor:pointer;font-weight:600">Advanced — set now, can not be changed later</summary>
      <div class="sw-form" style="margin-top:10px">
        <label class="ui-field"><span class="ui-label">Overlay address pool</span><input class="input" data-f="pool" value="${esc(s.pool)}"><span class="ui-sub">Overlay networks take addresses from here. Must not overlap networks the servers use.</span></label>
        <label class="ui-field"><span class="ui-label">Network size (mask)</span><input class="input" type="number" data-f="subnetSize" value="${s.subnetSize}" min="16" max="29"><span class="ui-sub">/24 = 254 containers per overlay network.</span></label>
        <label class="ui-field"><span class="ui-label">Data port (VXLAN)</span><input class="input" type="number" data-f="dataPort" value="${s.dataPort}"><span class="ui-sub">4789/udp unless a cloud network already uses it.</span></label>
        <label class="ui-field"><span class="ui-label">Node certificate lifetime (days)</span><input class="input" type="number" data-f="certDays" value="${s.certDays}"><span class="ui-sub">Swarm renews certificates by itself.</span></label>
        <label class="ui-field"><span class="ui-label">Task history per slot</span><input class="input" type="number" data-f="taskHistory" value="${s.taskHistory}"><span class="ui-sub">Old tasks kept for logs and errors.</span></label>
        <label class="ui-field" style="align-self:center"><span><input type="checkbox" data-f="autolock" ${s.autolock ? 'checked' : ''}> Autolock</span><span class="ui-sub">Encrypts the swarm's keys at rest. After every Docker restart a manager stays locked until it is unlocked; DockGate keeps the key and offers Unlock.</span></label>
      </div></details>`;
    function firewallPlan() {
      const members = [...(s.mode === 'several' ? [{ name: active.name || active.id, addr: s.addr, fw: 'local-active' }] : []), ...chosen().map(p => ({ name: serverName(p.id), addr: p.addr, fw: (p.facts || {}).firewall }))];
      const ports = `2377/tcp, 7946/tcp+udp, ${s.dataPort}/udp${s.encrypt ? ', ESP' : ''}`;
      return UI.table([{ label: 'Server' }, { label: 'Firewall' }, { label: 'Allows from' }, { label: 'Ports' }], members.map(x => {
        const from = members.filter(o => o !== x).map(o => o.addr).filter(Boolean);
        const fwText = x.fw === 'ufw' ? 'UFW — rules added' : x.fw === 'firewalld' ? 'firewalld — rules added' : x.fw === 'none' ? '<span style="color:var(--warning,#d97706)">off — ports are open to everyone</span>'
          : (x.fw === 'local' || x.fw === 'local-active') && active.id === 'local' ? 'DockGate\'s own server: open these ports yourself' : x.fw === 'local' ? 'DockGate\'s own server: open these ports yourself' : 'added if a firewall is on';
        const wrap = 'style="white-space:normal;display:block;min-width:120px"';
        return { cells: [`<b>${esc(x.name)}</b><div class="ui-sub td-mono">${esc(x.addr || '?')}</div>`, `<span class="text-sm" ${wrap}>${fwText}</span>`, `<span class="td-mono text-sm" ${wrap}>${esc(from.join(', ') || '—')}</span>`, `<span class="text-sm" ${wrap}>${ports}</span>`] };
      }), { minWidth: 0 }) + (s.mode === 'add' ? '<div class="ui-sub" style="margin-top:6px">The servers already in the cluster get the same rules for the new addresses.</div>' : '');
    }

    function render() {
      back.style.display = s.step === 0 ? 'none' : '';
      next.disabled = false;
      const last = s.step === stepsFor().length - 1;
      next.textContent = !last ? 'Next' : s.mode === 'add' ? `Add ${plural(chosen().length, 'server')}` : 'Create Swarm';
      const step = name();
      if (step === 'Mode') {
        root.innerHTML = `${head()}<div class="sw-mode">
          <div class="sw-opt ${s.mode === 'one' ? 'sel' : ''}" data-mode="one"><b>One server</b><div class="text-sm text-muted" style="margin-top:4px">This server is manager and worker. You get replicas, rolling updates with automatic roll back, restarts of failed containers, secrets and configs — on one VPS. Servers can be added later.</div></div>
          <div class="sw-opt ${s.mode === 'several' ? 'sel' : ''}" data-mode="several"><b>Several servers</b><div class="text-sm text-muted" style="margin-top:4px">This server is the first manager; the servers you choose join as managers or workers. Services keep running when a server is lost. Every server must be added to DockGate first.</div></div>
        </div>`;
        root.querySelectorAll('[data-mode]').forEach(el => el.onclick = () => { s.mode = el.dataset.mode; render(); });
      } else if (step === 'Server') {
        root.innerHTML = `${head()}${UI.table([{ label: 'Server' }, { label: 'Docker' }, { label: 'CPU' }, { label: 'Role' }], [{ cells: [`<b>${esc(active.name || active.id)}</b>${active.host ? `<div class="ui-sub">${esc(active.host)}</div>` : ''}`, esc(st.dockerVersion), esc(st.arch), UI.pill('info', 'manager') + ' <span class="ui-sub">also runs tasks</span>'] }], { minWidth: 0 })}
          <p class="text-sm text-muted" style="margin-top:10px">Swarm is set up on the server in use. To use another server, switch it at the top first.</p>`;
      } else if (step === 'Servers') {
        root.innerHTML = `${head()}<div id="sw-list" class="text-sm text-muted">Loading servers…</div>`;
        next.disabled = true;
        loadList().then(() => {
          const rows = [];
          if (s.mode === 'several') rows.push({ cells: ['<input type="checkbox" checked disabled>', `<b>${esc(active.name || active.id)}</b><div class="ui-sub">server in use</div>`, '<span class="ui-sub">—</span>', UI.pill('info', 'manager') + ' <span class="ui-sub">first manager</span>'] });
          for (const x of s.list) {
            const p = s.picks[x.id] || (s.picks[x.id] = { on: false, role: 'worker', addr: '' });
            rows.push({ cells: [`<input type="checkbox" data-pick="${esc(x.id)}" ${p.on ? 'checked' : ''}>`, `<b>${esc(x.name)}</b>`, `<span class="td-mono text-sm">${esc(x.local ? 'DockGate\'s own server' : x.host || '')}</span>`,
              `<select class="select" data-role="${esc(x.id)}" style="max-width:140px"><option value="worker" ${p.role === 'worker' ? 'selected' : ''}>worker</option><option value="manager" ${p.role === 'manager' ? 'selected' : ''}>manager</option></select>`] });
          }
          root.querySelector('#sw-list').outerHTML = `${UI.table([{ label: '', width: '36px' }, { label: 'Server' }, { label: 'Address' }, { label: 'Role' }], rows, { minWidth: 0, empty: 'No other servers in DockGate.' })}
            <div class="text-sm" style="margin-top:10px" data-mgr></div>
            <div class="ui-sub" style="margin-top:6px">Only servers added to DockGate can be chosen (Servers → Add server). Managers keep the cluster state: 1, 3 or 5 of them; workers only run tasks.</div>`;
          const upd = () => { root.querySelector('[data-mgr]').innerHTML = `<b>Managers:</b> ${tolerance(managers())}`; next.disabled = !chosen().length; next.textContent = s.step === stepsFor().length - 1 ? next.textContent : 'Next'; };
          root.querySelectorAll('[data-pick]').forEach(el => el.onchange = () => { s.picks[el.dataset.pick].on = el.checked; s.join = null; upd(); });
          root.querySelectorAll('[data-role]').forEach(el => el.onchange = () => { s.picks[el.dataset.role].role = el.value; s.join = null; upd(); });
          upd();
        }).catch(e => { root.querySelector('#sw-list').innerHTML = UI.errorState(e, { compact: true }); });
      } else if (step === 'Checks') {
        root.innerHTML = `${head()}<div id="sw-checks"></div><div style="margin-top:8px">${UI.btn('Run again', 'data-recheck')}</div>`;
        root.querySelector('[data-recheck]').onclick = runChecks;
        runChecks();
      } else if (step === 'Options') {
        root.innerHTML = `${head()}
          <div class="ui-field"><span class="ui-label">Address Swarm uses</span>${addrSelect('self', s.addresses, s.addr, true)}
            <div class="ui-sub" style="margin-top:4px">With one server this only matters later, when servers join: then a private network address is best.</div></div>
          <div class="insight-card info" style="margin:10px 0"><div><b>Firewall:</b> no ports are opened on one server. Docker listens on 2377/tcp for Swarm management; keep it closed to the internet (Server Console → Firewall).</div></div>
          ${advanced(s.checks && s.checks.checks.some(c => c.id === 'pool' && c.status === 'warn'))}`;
      } else if (step === 'Network') {
        const rows = [];
        if (s.mode === 'several') rows.push({ cells: [`<b>${esc(active.name || active.id)}</b><div class="ui-sub">first manager</div>`, addrSelect('self', s.addresses, s.addr, false)] });
        for (const p of chosen()) rows.push({ cells: [`<b>${esc(serverName(p.id))}</b><div class="ui-sub">${esc(p.role)}</div>`, addrSelect(p.id, p.addresses, p.addr, false)] });
        const anyPublic = [s.mode === 'several' ? s.addr : null, ...chosen().map(p => p.addr)].filter(Boolean).some(ip => !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip));
        root.innerHTML = `${head()}
          <div class="ui-ph-title" style="margin-bottom:4px">Addresses between the servers</div>
          ${UI.table([{ label: 'Server' }, { label: 'Address Swarm uses' }], rows, { minWidth: 0 })}
          <div class="ui-sub" style="margin:6px 0 12px">A private network (Hetzner vSwitch / Cloud network, a VPC, WireGuard) is best: the Swarm ports then never face the internet.</div>
          <label class="text-sm"><input type="checkbox" data-encrypt ${s.encrypt ? 'checked' : ''}> Encrypt overlay traffic (IPsec)${anyPublic ? ' — <b>recommended: some addresses are public</b>' : ''}</label>
          <div class="ui-sub" style="margin:2px 0 12px">Used for the overlay networks DockGate creates for stacks; ESP is allowed between the servers too. Costs some CPU.</div>
          <div class="ui-ph-title" style="margin-bottom:4px">Firewall</div><div data-fw>${firewallPlan()}</div>
          ${s.mode === 'several' ? `<div style="margin-top:12px">${advanced(s.checks && s.checks.checks.some(c => c.id === 'pool' && c.status === 'warn'))}</div>` : ''}`;
        root.querySelector('[data-encrypt]').onchange = (e) => { s.encrypt = e.target.checked; readAddrs(); root.querySelector('[data-fw]').innerHTML = firewallPlan(); };
        root.querySelectorAll('[data-addr]').forEach(el => el.addEventListener('change', () => { readAddrs(); root.querySelector('[data-fw]').innerHTML = firewallPlan(); }));
      } else {
        const rows = s.mode === 'one'
          ? [['Server', esc(active.name || active.id)], ['Role', 'manager (also runs tasks)'], ['Address', esc(s.addr || 'Docker chooses')], ['Address pool', `${esc(s.pool)} · /${s.subnetSize}`], ['Data port', s.dataPort], ['Certificates', `${s.certDays} days`], ['Task history', s.taskHistory], ['Autolock', s.autolock ? 'on — the key is shown once at the end' : 'off']]
          : [...(s.mode === 'several' ? [[esc(active.name || active.id), `manager · ${esc(s.addr)} · first manager`]] : []), ...chosen().map(p => [esc(serverName(p.id)), `${esc(p.role)} · ${esc(p.addr)}`]),
            ['Managers', tolerance(managers())], ['Overlay encryption', s.encrypt ? 'on' : 'off'], ...(s.mode === 'several' ? [['Address pool', `${esc(s.pool)} · /${s.subnetSize}`], ['Autolock', s.autolock ? 'on' : 'off']] : [])];
        const what = s.mode === 'one' ? '<span class="td-mono">docker swarm init</span> on this server, then a check that the node is Ready. If the check fails, the server leaves the swarm again.'
          : `${s.mode === 'several' ? '<span class="td-mono">docker swarm init</span> on this server, then ' : ''}the firewall rules on each server, then each server joins, one at a time, and DockGate checks it is Ready. If a step fails, the servers that joined leave again and the firewall rules are deleted${s.mode === 'several' ? ' — and the swarm is removed' : ''}. Join tokens never leave DockGate.`;
        root.innerHTML = `${head()}${UI.table([{ label: '' }, { label: '' }], rows.map(r => ({ cells: [`<span class="ui-sub">${r[0]}</span>`, r[1]] })), { minWidth: 0 })}
          <div class="insight-card info" style="margin-top:10px"><div><b>What happens:</b> ${what} Running containers and compose projects are not stopped or changed.</div></div>`;
      }
      root.querySelectorAll('[data-addr]').forEach(sel => { const custom = root.querySelector(`[data-addr-custom="${sel.dataset.addr}"]`); sel.addEventListener('change', () => { custom.style.display = sel.value === '__custom' ? '' : 'none'; }); });
    }
    function readAddrs() {
      root.querySelectorAll('[data-addr]').forEach(sel => {
        const v = sel.value === '__custom' ? root.querySelector(`[data-addr-custom="${sel.dataset.addr}"]`).value.trim() : sel.value;
        if (sel.dataset.addr === 'self') s.addr = v; else if (s.picks[sel.dataset.addr]) s.picks[sel.dataset.addr].addr = v;
      });
    }
    function readAdvanced() {
      const v = (f) => root.querySelector(`[data-f="${f}"]`);
      if (!v('pool')) return;
      s.pool = v('pool').value.trim(); s.subnetSize = Number(v('subnetSize').value); s.dataPort = Number(v('dataPort').value);
      s.certDays = Number(v('certDays').value); s.taskHistory = Number(v('taskHistory').value); s.autolock = v('autolock').checked;
    }
    async function validateNetwork() {
      readAddrs(); readAdvanced();
      const ips = [...(s.mode !== 'add' && s.mode !== 'one' ? [s.addr] : []), ...(s.mode === 'one' ? [] : chosen().map(p => p.addr))];
      if (s.mode === 'one' && s.addr && !/^\d+\.\d+\.\d+\.\d+$/.test(s.addr)) { showToast('Enter an IPv4 address', 'warning'); return false; }
      if (s.mode !== 'one') {
        if (ips.some(ip => !/^\d+\.\d+\.\d+\.\d+$/.test(ip || ''))) { showToast('Every server needs an IPv4 address', 'warning'); return false; }
        if (new Set(ips).size !== ips.length) { showToast('Each server needs its own address', 'warning'); return false; }
      }
      if (s.mode === 'one' && s.addr && s.addresses.length && !s.addresses.some(x => x.ip === s.addr) && !confirm(`${s.addr} is not one of this server's addresses (${s.addresses.map(x => x.ip).join(', ')}). Docker accepts it (for a server behind NAT), but other servers must reach this server on it. Use it anyway?`)) return false;
      if (s.mode !== 'add') {
        try {
          const r = await API.post('/swarm/checks', { pool: s.pool });
          const pc = r.checks.find(c => c.id === 'pool');
          if (pc && pc.status === 'bad') { showToast(pc.detail, 'error', 8000); return false; }
          if (pc && pc.status === 'warn' && !confirm(`${pc.detail}\n\nUse this pool anyway?`)) return false;
        } catch (e) { showToast(e.message, 'error'); return false; }
      }
      return true;
    }
    back.onclick = () => { if (['Options', 'Network'].includes(name())) { readAddrs(); readAdvanced(); } s.step = Math.max(0, s.step - 1); render(); };
    next.onclick = async () => {
      if (['Options', 'Network'].includes(name()) && !(await validateNetwork())) return;
      if (s.step < stepsFor().length - 1) { s.step++; render(); return; }
      next.disabled = true;
      const init = { advertiseAddr: s.addr, pool: s.pool, subnetSize: s.subnetSize, dataPort: s.dataPort, autolock: s.autolock, certDays: s.certDays, taskHistory: s.taskHistory };
      const servers = chosen().map(p => ({ id: p.id, role: p.role, addr: p.addr }));
      try {
        const r = s.mode === 'one' ? await API.post('/swarm/init', init)
          : s.mode === 'several' ? await API.post('/swarm/cluster', { ...init, servers, encrypt: s.encrypt })
            : await API.post('/swarm/servers/add', { servers, encrypt: s.encrypt });
        m.close();
        openJob(r.jobId, (j) => {
          if (j.result && j.result.needAddress) { // the server has several addresses: ask, then start again
            const again = { ...s, step: stepsFor().indexOf(s.mode === 'one' ? 'Options' : 'Network'), addresses: j.result.addresses.map(a => ({ ...a, iface: '' })) };
            again.addr = (again.addresses.find(a => a.private) || again.addresses[0]).ip;
            openWizard(st, onDone, { add }).set(again);
          } else if (onDone) onDone();
        }, s.mode === 'add' ? 'Add servers' : 'Create Swarm');
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
      const jobBanner = job ? banner('info', '<b>A Swarm job is running.</b>', UI.btn('Open', 'data-open-job', 'btn-primary')) : '';

      if (st.state === 'inactive' || st.state === 'error' && !st.nodeId) {
        content.innerHTML = `${UI.header('Swarm', `Docker Swarm is off on <b>${esc(st.serverName)}</b>.`, job ? '' : UI.primary('Set up Swarm…', 'data-setup'))}${jobBanner}
          <div class="sw-cards">
            <div class="sw-card"><b>Replicas and self-healing</b><div class="text-sm text-muted" style="margin-top:4px">Run a service as several containers; a container that dies is started again.</div></div>
            <div class="sw-card"><b>Updates with roll back</b><div class="text-sm text-muted" style="margin-top:4px">Rolling updates, one container at a time, and back to the previous version when the new one fails.</div></div>
            <div class="sw-card"><b>Secrets and configs</b><div class="text-sm text-muted" style="margin-top:4px">Passwords and config files kept by Swarm instead of .env files.</div></div>
            <div class="sw-card"><b>One server now, more later</b><div class="text-sm text-muted" style="margin-top:4px">It works on one VPS. Servers can join the cluster later.</div></div>
          </div>
          <p class="text-sm text-muted">Turning Swarm on does not stop or change running containers or compose projects. Moving compose projects to Swarm is a separate step that comes in a later version. For several servers, add each one to DockGate first (Servers → Add server).</p>`;
      } else if (st.state === 'locked') {
        content.innerHTML = `${UI.header('Swarm', `The swarm on <b>${esc(st.serverName)}</b> is locked.`)}
          ${banner('bad', '<b>Swarm is locked.</b> Autolock is on and Docker was restarted: services keep their containers but the swarm can not be managed until it is unlocked.', UI.btn('Unlock…', 'data-unlock', 'btn-primary'))}`;
      } else if (st.state === 'active' && !st.manager) {
        content.innerHTML = `${UI.header('Swarm', `<b>${esc(st.serverName)}</b> is a worker in a swarm.`)}${banner('info', 'Workers can not show or change the cluster. Switch to a manager server at the top to manage it.')}`;
      } else if (data.quorumLost) {
        content.innerHTML = `${UI.header('Swarm', `The swarm managed through <b>${esc(st.serverName)}</b> has no leader.`)}
          ${banner('bad', `<b>Most managers can not be reached.</b> Running services keep running, but nothing can be deployed, scaled or changed. <span class="ui-sub">${esc(data.error || '')}</span>`, UI.btn('Recover cluster…', 'data-recover', 'btn-danger'))}
          <div class="sw-card"><b>Two ways out</b><div class="text-sm" style="margin-top:6px">1. <b>Wait</b> — when the lost managers come back (power, network), the cluster works again by itself. Best when they will come back.<br>2. <b>Recover cluster…</b> — only when they will not come back: DockGate takes a backup, runs <span class="td-mono">docker swarm init --force-new-cluster</span> on ${esc(st.serverName)} (a one-manager cluster that keeps every service) and removes the managers that are gone. Then add managers again.</div></div>`;
      } else if (st.state === 'pending') {
        content.innerHTML = `${UI.header('Swarm', 'Joining a swarm…')}${banner('warn', 'The server is joining a swarm. This page refreshes by itself.')}`;
      } else {
        const c = data.counts;
        const sentence = c.nodes === 1 ? `Single-server Swarm on <b>${esc(data.nodes[0].hostname)}</b>.` : `${c.nodes} servers in one cluster: ${plural(c.managers, 'manager')}, ${plural(c.nodes - c.managers, 'worker')}.`;
        const card = (k, v, tone) => `<div class="sw-card ${tone || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
        const node = (n) => `<div class="sw-node ${n.state !== 'ready' ? 'down' : ''}">
            <h4>${esc(n.hostname)} ${n.leader ? UI.pill('info', 'leader') : ''} ${UI.pill(n.state === 'ready' ? 'ok' : 'bad', esc(n.state))} ${n.availability !== 'active' ? UI.pill('warn', esc(n.availability)) : ''}</h4>
            <div class="ui-sub">${esc(n.role)} · ${esc(n.addr)} · ${esc(n.arch)} · Docker ${esc(n.engine)}</div>${n.serverName ? `<div class="ui-sub">DockGate server: ${esc(n.serverName)}</div>` : data.nodes.length > 1 && n.serverId === null ? '<div class="ui-sub" style="color:var(--warning,#d97706)">not in DockGate</div>' : ''}
            <div class="sw-chips">${n.tasks.length ? n.tasks.map(t => {
              const cls = t.state === 'running' ? 'running' : ['failed', 'rejected'].includes(t.state) ? 'failed' : 'starting';
              return `<span class="sw-chip ${cls}" title="${esc(`${t.service}${t.slot ? '.' + t.slot : ''} · ${t.state}${t.error ? ' · ' + t.error : ''} · ${t.image}`)}">${esc(t.service)}${t.slot ? '.' + t.slot : ''}</span>`;
            }).join('') : '<span class="ui-sub">No tasks</span>'}</div></div>`;
        const wAction = (w) => (w.action === 'nodes' ? UI.btn('Open Nodes', 'data-go-nodes') : w.action === 'rebalance' ? UI.btn('Rebalance…', 'data-rebalance') : w.action === 'migrate' ? UI.btn('Migrate…', 'data-go-migrate') : '');
        content.innerHTML = `${UI.header('Swarm', sentence, `${job ? '' : UI.btn('Add servers…', 'data-addsrv')}`)}${jobBanner}
          ${data.warnings.map(w => banner(w.level, esc(w.text), wAction(w))).join('')}
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
      content.querySelector('[data-open-job]')?.addEventListener('click', () => openJob(job, load, 'Swarm job'));
      content.querySelector('[data-addsrv]')?.addEventListener('click', () => openWizard(st, load, { add: true }));
      content.querySelector('[data-go-nodes]')?.addEventListener('click', () => Router.navigate('swarm', { tab: 'swarm-nodes' }));
      content.querySelector('[data-go-migrate]')?.addEventListener('click', () => Router.navigate('swarm', { tab: 'swarm-migrate' }));
      content.querySelector('[data-rebalance]')?.addEventListener('click', () => confirmRebalance(load));
      content.querySelector('[data-unlock]')?.addEventListener('click', () => unlockDialog(st, load));
      content.querySelector('[data-recover]')?.addEventListener('click', () => recoverDialog(st, load));
      stop();
      if (st.state !== 'inactive') timer = setTimeout(load, 5000);
      else if (job) timer = setTimeout(load, 3000);
    }
    await load();
    return stop;
  });

  // ---- Nodes ----
  const AVAIL = { active: null, pause: ['warn', 'paused'], drain: ['warn', 'drained'] };
  function startJob(url, body, title, onDone) {
    return API.post(url, body || {}).then(r => openJob(r.jobId, onDone, title)).catch(e => showToast(e.message, 'error', 9000));
  }
  Router.register('swarm-nodes', async (content) => {
    css();
    const navId = Router._navId;
    let timer = null, data = null;
    const stop = () => clearTimeout(timer);
    async function load() {
      if (!Router.isActiveNav(navId) || !content.isConnected) return stop();
      try { data = await API.get('/swarm/nodes'); }
      catch (e) {
        content.innerHTML = `${UI.header('Nodes', esc(e.message), UI.btn('Open Overview', 'data-go'))}`;
        content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' });
        return;
      }
      if (!Router.isActiveNav(navId)) return;
      const rows = data.nodes.map(n => {
        const av = AVAIL[n.availability];
        const menu = [
          n.availability !== 'pause' ? { label: 'Pause', attrs: `data-act="pause" data-id="${esc(n.id)}"` } : null,
          n.availability !== 'drain' ? { label: 'Drain…', attrs: `data-act="drain" data-id="${esc(n.id)}"` } : null,
          n.availability !== 'active' ? { label: 'Activate', attrs: `data-act="activate" data-id="${esc(n.id)}"` } : null,
          '-',
          n.role === 'worker' ? { label: 'Promote to manager', attrs: `data-act="promote" data-id="${esc(n.id)}"` } : { label: 'Demote to worker', attrs: `data-act="demote" data-id="${esc(n.id)}"` },
          { label: 'Labels…', attrs: `data-act="labels" data-id="${esc(n.id)}"` },
          !n.serverId ? { label: 'Add to DockGate…', attrs: `data-act="adopt" data-id="${esc(n.id)}"` } : null,
          '-',
          { label: 'Remove…', attrs: `data-act="remove" data-id="${esc(n.id)}"` },
        ].filter(Boolean);
        return { cells: [
          `<b>${esc(n.hostname)}</b> ${n.leader ? UI.pill('info', 'leader') : ''}${n.self ? ' <span class="ui-sub">· DockGate manages through this one</span>' : ''}
            <div class="ui-sub">${n.serverId ? `DockGate server: ${esc(n.serverName)}` : '<span style="color:var(--warning,#d97706)">not in DockGate</span>'}</div>`,
          `<span class="td-mono text-sm">${esc(n.addr)}</span>`,
          `${esc(n.role)}${n.role === 'manager' && n.reachability && n.reachability !== 'reachable' ? ` ${UI.pill('bad', esc(n.reachability))}` : ''}`,
          `${UI.pill(n.state === 'ready' ? 'ok' : 'bad', esc(n.state))}${av ? ' ' + UI.pill(av[0], av[1]) : ''}`,
          Object.keys(n.labels).length ? Object.entries(n.labels).map(([k, v]) => UI.chip(`${esc(k)}=${esc(v)}`, { mono: true })).join(' ') : '<span class="ui-sub">—</span>',
          String(n.tasks),
          `<span class="text-sm">${esc(n.engine)} · ${esc(n.arch)}</span>`,
          UI.menu(menu),
        ] };
      });
      content.innerHTML = `${UI.header('Nodes', `${plural(data.nodes.length, 'server')} in the cluster · ${tolerance(data.managers)}. Pause keeps a server's tasks but gives it no new ones; Drain moves its tasks to other servers.`,
        `${data.nodes.length > 1 ? UI.btn('Rebalance…', 'data-rebalance') : ''} ${UI.primary('Add servers…', 'data-add')}`)}
        ${UI.table([{ label: 'Node' }, { label: 'Address' }, { label: 'Role' }, { label: 'State' }, { label: 'Labels' }, { label: 'Tasks' }, { label: 'Docker · CPU' }, { label: '', align: 'right' }], rows, { minWidth: 900 })}`;
      content.querySelector('[data-add]').onclick = () => openWizard(null, load, { add: true });
      content.querySelector('[data-rebalance]')?.addEventListener('click', () => confirmRebalance(load));
      content.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => nodeAction(b.dataset.act, data.nodes.find(n => n.id === b.dataset.id), load)));
      stop(); timer = setTimeout(load, 10000);
    }
    async function nodeAction(act, n, done) {
      if (!n) return;
      const upd = async (body, msg) => { try { await API.post(`/swarm/nodes/${n.id}/update`, body); showToast(msg); done(); } catch (e) { showToast(e.message, 'error', 9000); } };
      if (act === 'pause') return secConfirm({ title: `Pause ${n.hostname}`, change: 'The server keeps its running tasks but gets no new ones.', protects: 'Nothing stops. Safe on one server too.', undo: 'Activate.', confirmLabel: 'Pause', onConfirm: () => upd({ availability: 'pause' }, `${n.hostname} paused`) });
      if (act === 'activate') return upd({ availability: 'active' }, data.nodes.length > 1 ? `${n.hostname} is active. Tasks do not move back by themselves — use Rebalance.` : `${n.hostname} is active`);
      if (act === 'drain') {
        let imp; try { imp = await API.get(`/swarm/nodes/${n.id}/drain-impact`); } catch (e) { return showToast(e.message, 'error'); }
        if (!imp.others) return showToast('No other active server: draining would stop every service. Use Pause, or add a server first.', 'error', 9000);
        return secConfirm({ title: `Drain ${n.hostname}`, danger: imp.stuck.length > 0,
          change: `Its tasks stop here and start on the other ${plural(imp.others, 'server')}.${imp.moves.length ? `<div style="margin-top:4px">Moves: ${imp.moves.map(x => `<b>${esc(x.service)}</b>${x.volume ? ' <span style="color:var(--warning,#d97706)">(its data volume stays on this server — the new task starts with an empty volume)</span>' : ''}`).join(', ')}</div>` : ''}`,
          protects: imp.stuck.length ? `<span style="color:var(--danger,#dc2626)">These stop and wait: ${imp.stuck.map(x => `<b>${esc(x.service)}</b> — ${esc(x.why)}`).join('; ')}</span>` : 'Every task has another server to run on.',
          undo: 'Activate the server; then Rebalance to spread tasks again.', confirmLabel: 'Drain', onConfirm: () => upd({ availability: 'drain' }, `${n.hostname} drained`) });
      }
      if (act === 'promote' || act === 'demote') {
        const after = data.managers + (act === 'promote' ? 1 : -1);
        return secConfirm({ title: `${act === 'promote' ? 'Promote' : 'Demote'} ${n.hostname}`, danger: after === 2,
          change: act === 'promote' ? 'The server becomes a manager: it keeps a copy of the cluster state and can take over as leader.' : 'The server becomes a worker: it only runs tasks.',
          protects: `After this: ${tolerance(after)}.${after === 2 ? ' With 2 managers losing either one stops cluster changes — add or remove one more.' : ''}`,
          undo: act === 'promote' ? 'Demote it again.' : 'Promote it again.', confirmLabel: act === 'promote' ? 'Promote' : 'Demote', onConfirm: () => upd({ role: act === 'promote' ? 'manager' : 'worker' }, `${n.hostname} is now a ${act === 'promote' ? 'manager' : 'worker'}`) });
      }
      if (act === 'labels') {
        const text = Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join('\n');
        const used = Object.entries(data.labelUse || {}).map(([k, svcs]) => `<b>${esc(k)}</b>: ${svcs.map(esc).join(', ')}`).join('<br>');
        return UI.dialog({ title: `Labels of ${n.hostname}`, body: `<p class="text-sm text-muted">One <span class="td-mono">key=value</span> per line, e.g. <span class="td-mono">db=true</span> or <span class="td-mono">zone=fsn1</span>. Services use them in placement rules (<span class="td-mono">node.labels.db==true</span>).</p>
            <textarea class="input" data-labels rows="6" style="font-family:var(--font-mono,monospace)">${esc(text)}</textarea>${used ? `<div class="ui-sub" style="margin-top:8px">Used by services — ${used}</div>` : ''}`,
          onSave: async (ov) => {
            const labels = {};
            for (const line of ov.querySelector('[data-labels]').value.split('\n').map(l => l.trim()).filter(Boolean)) {
              const i = line.indexOf('='); if (i < 1) throw new Error(`"${line}": write key=value`);
              labels[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
            const gone = Object.keys(n.labels).filter(k => !(k in labels) && (data.labelUse || {})[k]);
            if (gone.length && !confirm(`${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} used by services. Without it their tasks may have nowhere to run. Remove anyway?`)) return false;
            await API.post(`/swarm/nodes/${n.id}/update`, { labels }); showToast('Labels saved'); done();
          } });
      }
      if (act === 'adopt') return Router.navigate('infra', { tab: 'servers', addHost: n.addr });
      if (act === 'remove') {
        return showDeleteConfirm(`Remove ${n.hostname}`, {
          message: `${n.role === 'manager' ? 'It is demoted, then ' : ''}its tasks move to other servers (drain), ${n.serverId ? `<b>${esc(n.serverName)}</b> leaves the swarm` : 'it is removed from the list (run <span class="td-mono">docker swarm leave</span> on it yourself)'} and DockGate deletes the firewall rules it added for it. Containers of compose projects on it are not touched.`,
          phrase: n.hostname, confirmLabel: 'Remove',
          onConfirm: () => startJob(`/swarm/nodes/${n.id}/remove`, { confirm: true }, 'Remove node', done),
        });
      }
    }
    await load();
    return stop;
  });
  function confirmRebalance(done) {
    secConfirm({ title: 'Rebalance', change: 'Services that can move get their tasks restarted, one service at a time (<span class="td-mono">docker service update --force</span>), so Swarm spreads them over the active servers.',
      protects: 'Services pinned to a server, global services and services with a data volume are left alone. Each service updates with its own rolling update settings.', undo: 'Not needed.', confirmLabel: 'Rebalance',
      onConfirm: () => startJob('/swarm/rebalance', {}, 'Rebalance', done) });
  }

  async function recoverDialog(st, onDone) {
    let r; try { r = await API.get('/swarm/recovery'); } catch (e) { return showToast(e.message, 'error'); }
    if (!r.lost) { showToast('The cluster has a leader again — nothing to recover', 'success'); return onDone(); }
    showDeleteConfirm('Recover cluster', {
      message: `Use this only when the lost managers will <b>not</b> come back. On <b>${esc(r.serverName)}</b> (${esc(r.nodeAddr)}) DockGate 1) takes a backup of the swarm state, 2) runs <span class="td-mono">docker swarm init --force-new-cluster</span> — a cluster with this server as the only manager, every service and node kept — and 3) removes the managers that are down. A lost manager that comes back later must leave and join again. This can not be undone.`,
      phrase: r.serverName, confirmLabel: 'Recover',
      onConfirm: async () => { try { const x = await API.post('/swarm/recover', { confirm: r.serverName }); openJob(x.jobId, onDone, 'Recover cluster'); } catch (e) { showToast(e.message, 'error', 9000); } },
    });
  }

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
        <div class="ui-ph" style="margin-top:18px"><div class="ui-ph-text"><div class="ui-ph-title">Backups</div><div class="ui-ph-desc">The swarm state (Raft) of this manager and a plain description of services, networks, configs and nodes. Kept in DockGate's data folder, the last 7. Secrets are listed by name only — Swarm never gives their values out.</div></div><div class="ui-ph-actions">${UI.btn('How to restore', 'data-howto')} ${UI.primary('Back up now', 'data-backup')}</div></div>
        <div data-backups class="text-sm text-muted">Loading…</div>
        <div class="ui-ph" style="margin-top:18px"><div class="ui-ph-text"><div class="ui-ph-title">Turn Swarm off</div><div class="ui-ph-desc">The server leaves the swarm. With one server that removes the swarm with its services, secrets and configs. Containers of compose projects are not touched.</div></div><div class="ui-ph-actions">${UI.btn('Turn Swarm off…', 'data-leave', 'btn-danger')}</div></div>`;
      const loadBackups = async () => {
        const el = content.querySelector('[data-backups]'); if (!el) return;
        try {
          const r = await API.get('/swarm/backups');
          el.innerHTML = `<div class="flex items-center gap-2" style="margin-bottom:8px"><div class="toggle ${r.nightly ? 'active' : ''}" role="switch" tabindex="0" aria-checked="${r.nightly}" data-nightly></div><span class="text-sm">Back up every night</span></div>`
            + UI.table([{ label: 'Taken' }, { label: 'Why' }, { label: 'Size' }, { label: 'Contains' }, { label: '', align: 'right' }], r.backups.map(b => ({ cells: [
              `<span title="${esc(formatTime(b.takenAt))}">${esc(timeAgo(b.takenAt))}</span><div class="ui-sub">${esc(b.serverName)}</div>`, esc(b.reason), formatBytes(b.size),
              `<span class="text-sm">${b.raw ? 'swarm state' : '<span style="color:var(--warning,#d97706)">no swarm state</span>'} · ${b.services} service${b.services === 1 ? '' : 's'} · ${b.nodes} node${b.nodes === 1 ? '' : 's'}${b.unlockKey ? ' · unlock key (encrypted)' : ''}</span>${b.errors && b.errors.length ? `<div class="ui-sub" style="white-space:normal">${esc(b.errors.join('; '))}</div>` : ''}`,
              `<a class="btn btn-xs btn-secondary" href="/api/swarm/backups/${encodeURIComponent(b.file)}" download>Download</a>`] })), { minWidth: 640, empty: 'No backups yet.' });
          el.querySelector('[data-nightly]').onclick = async (e) => { try { await API.put('/swarm/backups/nightly', { on: !e.currentTarget.classList.contains('active') }); loadBackups(); } catch (er) { showToast(er.message, 'error'); } };
        } catch (e) { el.innerHTML = UI.errorState(e, { compact: true }); }
      };
      loadBackups();
      content.querySelector('[data-backup]').onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Backing up…';
        try { const r = await API.post('/swarm/backups', {}); showToast(`Backup taken (${formatBytes(r.size)})${r.errors.length ? ' — ' + r.errors.join('; ') : ''}`, r.errors.length ? 'warning' : 'success', 8000); loadBackups(); }
        catch (er) { showToast(er.message, 'error', 9000); }
        finally { b.disabled = false; b.textContent = 'Back up now'; }
      };
      content.querySelector('[data-howto]').onclick = () => showModal('Restore a swarm', `<div class="text-sm">
        <p><b>One manager still runs?</b> Do not restore — use Swarm → Overview → <b>Recover cluster…</b> on it.</p>
        <p><b>Every manager is lost:</b> on a new server (the same Docker version is best), with the backup's <span class="td-mono">swarm-dir.tar.gz</span>:</p>
        <ol style="padding-left:18px;line-height:1.7"><li><span class="td-mono">sudo systemctl stop docker</span></li><li><span class="td-mono">sudo rm -rf /var/lib/docker/swarm</span></li><li><span class="td-mono">sudo tar -xzf swarm-dir.tar.gz -C /var/lib/docker</span></li><li><span class="td-mono">sudo systemctl start docker</span></li><li><span class="td-mono">docker swarm init --force-new-cluster --advertise-addr &lt;its address&gt;</span></li><li>With autolock: <span class="td-mono">docker swarm unlock</span> (Show unlock key on this page)</li><li>Add the other servers again (Swarm → Add servers…) and remove the old nodes.</li></ol>
        <p class="ui-sub">The backup is a .tar with RESTORE.txt (these steps), cluster.json (services, networks, configs, nodes — plain JSON), swarm-dir.tar.gz and, with autolock, the key encrypted for this DockGate. It is not done automatically: losing every manager is rare and the steps run on a server DockGate does not know yet.</p></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
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
