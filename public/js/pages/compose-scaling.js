// Deploy → Compose stacks → ⋯ → Scaling & health: replicas of each service with one click, without Swarm.
// DockGate writes its choices to its own override file (never the compose files); what changes is shown first.
window.ComposeScaling = (() => {
  const esc = (s) => escapeHtml(String(s ?? ''));
  const mb = (b) => (b ? (b >= 1073741824 ? `${Math.round(b / 107374182.4) / 10} GB` : `${Math.round(b / 1048576)} MB`) : '');

  async function open(project) {
    const m = showModal(`Scaling & health — ${esc(project)}`, '<div data-sc>Reading the project…</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const root = m.overlay.querySelector('[data-sc]');
    let data;
    async function load() {
      try { data = await API.get(`/compose/${encodeURIComponent(project)}/scaling`); data.history = (await API.get(`/compose/${encodeURIComponent(project)}/scaling/history`).catch(() => ({ history: [] }))).history; } catch (e) { root.innerHTML = UI.errorState ? UI.errorState(e) : `<div class="text-sm" style="color:var(--danger)">${esc(e.message)}</div>`; return; }
      render();
    }
    function render() {
      if (data.onSwarm) { root.innerHTML = `<div class="insight-card info"><div><b>${esc(project)} runs on Swarm</b> as stack ${esc(data.stack)}. Replicas and scaling are in Swarm → Services and Swarm → Auto Scaling.</div></div>`; return; }
      if (data.unresolved) { root.innerHTML = `<div class="insight-card warning"><div>${esc(data.unresolved)}</div></div>`; return; }
      const rows = data.services.map(s => {
        const sc = s.scalable;
        const canMore = sc.ok;
        const lim = s.limits.cpu || s.limits.mem ? `${s.limits.cpu ? `${s.limits.cpu} CPU` : 'no CPU limit'} · ${s.limits.mem ? mb(s.limits.mem) : 'no memory limit'}` : '<span style="color:var(--warning)">no limits</span>';
        const notes = [];
        if (!canMore) notes.push(`<span class="ui-sub">${esc(sc.block)}</span>`);
        else if (sc.fixes.length && !(s.fixes.dropPorts && s.fixes.dropName)) notes.push(`<span class="ui-sub">more than 1 needs: ${sc.fixes.map(f => (f === 'dropPorts' ? `host port ${esc(s.ports.join(', '))} behind the proxy` : `container_name ${esc(s.containerName)} dropped (kept as alias)`)).join(' · ')}</span>`);
        if (s.fixes.dropPorts) notes.push('<span class="ui-sub">host port moved behind the proxy</span>');
        if (s.fixes.dropName) notes.push(`<span class="ui-sub">still answers as ${esc((s.aliases || []).join(', ') || s.containerName || 'its old name')}</span>`);
        for (const b of s.behind) notes.push(`<span class="ui-sub">behind ${esc(b.name)}${b.usesResolver ? ' (finds new replicas by itself)' : ' — reloaded after each change'}</span>`);
        for (const b of s.behind.filter(x => x.connectTimeout > 5)) notes.push(`<span class="ui-sub" style="color:var(--warning)">${esc(b.name)} waits ${b.connectTimeout} s for a replica that just stopped — add <span class="td-mono">proxy_connect_timeout 2s;</span> so a request moves on to another replica at once</span>`);
        const state = s.drift ? UI.pill('warn', `drift: ${s.replicas} running, ${s.wanted} wanted`) : s.replicas ? UI.pill('ok', `${s.replicas} running`) : UI.pill('off', 'stopped');
        return { cells: [
          `<b>${esc(s.name)}</b>${s.rollable ? ` <button class="btn btn-xs btn-secondary" data-roll="${esc(s.name)}" title="New replicas with the current compose file and image, one at a time, without downtime">Roll out…</button>` : ''}<div class="ui-sub td-mono">${esc(s.image || '')}</div>${notes.length ? `<div style="margin-top:4px;white-space:normal;max-width:280px">${notes.join('<br>')}</div>` : ''}`,
          `${s.auto && s.auto.mode === 'auto' ? `<b>${s.replicas}</b> <span class="ui-sub">of ${s.auto.min}–${s.auto.max}</span>` : `<div style="display:flex;align-items:center;gap:6px"><button class="btn btn-xs btn-secondary" data-minus="${esc(s.name)}" ${s.wanted <= 0 ? 'disabled' : ''}>−</button><b style="min-width:22px;text-align:center">${s.wanted}</b><button class="btn btn-xs btn-secondary" data-plus="${esc(s.name)}" ${!canMore || s.wanted >= 20 ? 'disabled' : ''} title="${canMore ? 'Add a replica' : esc(sc.block)}">+</button></div>`}${autoChip(s)}`,
          `<span class="text-sm">${lim}</span><div class="ui-sub">from your compose file</div>`,
          `${state}${s.drift ? ` <button class="btn btn-xs btn-secondary" data-fix="${esc(s.name)}" data-n="${s.wanted}">Fix</button>` : ''}`,
          healCell(s),
        ] };
      });
      root.innerHTML = `${UI.header('Replicas', 'Docker runs each service as this many containers and spreads requests over them by name. Your compose files are not changed: DockGate keeps its choices in its own override file and shows what changes first.',
          `${data.override ? `${UI.btn('Show the override', 'data-ov')} ${UI.btn('Back to the files…', 'data-reset')}` : ''}`)}
        ${UI.table([{ label: 'Service' }, { label: 'Replicas' }, { label: 'Limits' }, { label: 'State' }, { label: 'Auto-heal' }], rows, { minWidth: 700 })}
        ${executorNote()}
        ${data.services.some(s => s.drift) ? '<div class="insight-card warning" style="margin-top:10px"><div><b>Drift.</b> The running replicas differ from what was set — most often a <span class="td-mono">docker compose up</span> run on the server without DockGate\'s override. <b>Fix</b> sets them again.</div></div>' : ''}
        <div class="ui-sub" style="margin-top:8px">Docker Compose ${esc(data.composeVersion || '?')} on this server.</div>
        ${historyBlock()}
        <div data-sc-log class="text-sm td-mono" style="white-space:pre-wrap;margin-top:8px"></div>`;
      root.querySelectorAll('[data-roll]').forEach(b => b.onclick = () => rollOut(b.dataset.roll));
      root.querySelectorAll('[data-rule]').forEach(b => b.onclick = () => ruleDialog(b.dataset.rule));
      root.querySelectorAll('[data-apply]').forEach(b => b.onclick = () => applySuggestion(b.dataset.apply, Number(b.dataset.to)));
      root.querySelectorAll('[data-heal]').forEach(t => t.onclick = () => heal(t.dataset.heal, t.getAttribute('aria-checked') !== 'true'));
      root.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => change(b.dataset.plus, +1));
      root.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => change(b.dataset.minus, -1));
      root.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => apply(b.dataset.fix, Number(b.dataset.n), false));
      const ov = root.querySelector('[data-ov]'); if (ov) ov.onclick = showOverride;
      const rs = root.querySelector('[data-reset]'); if (rs) rs.onclick = reset;
    }
    // Auto Scaling: the mode under the replicas, and the button to the rule.
    function autoChip(s) {
      const a = s.auto;
      if (!s.scalable.ok) return '';
      let label = 'Auto scaling: off', cls = 'off';
      if (a && a.mode === 'suggest') { label = `Suggest ${a.min}–${a.max}`; cls = 'info'; }
      if (a && a.mode === 'auto') { const sim = a.simulateUntil && a.simulateUntil > Date.now(); label = sim ? `Simulating until ${new Date(a.simulateUntil).toLocaleString()}` : `Auto ${a.min}–${a.max}`; cls = sim ? 'warn' : 'ok'; }
      return `<div style="margin-top:6px"><button class="btn btn-xs btn-secondary" data-rule="${esc(s.name)}" title="Auto Scaling rule">${UI.pill(cls, esc(label))}</button></div>`;
    }
    function historyBlock() {
      const h = data.history || [];
      if (!h.length) return '';
      const what = (e) => {
        if (e.mode === 'full') return `<span style="color:var(--danger)">server full</span> — wanted more than ${e.from}`;
        if (e.mode === 'off') return 'not measured';
        const arrow = `${e.from} → ${e.to}`;
        if (e.mode === 'suggest') return `suggests ${arrow}`;
        if (e.mode === 'simulate') return `would scale ${arrow}`;
        return e.ok ? `scaled ${arrow}` : `<span style="color:var(--danger)">${arrow} failed</span>`;
      };
      const latestSuggest = {};
      for (const e of h) if (e.mode === 'suggest' && !(e.service in latestSuggest)) latestSuggest[e.service] = e;
      const rows = h.slice(0, 30).map(e => ({ cells: [
        `<span class="text-sm" style="white-space:normal">${esc(new Date(e.t).toLocaleString())}</span>`,
        `<b>${esc(e.service)}</b>`,
        `${what(e)}${e.mode === 'suggest' && latestSuggest[e.service] === e && (data.services.find(x => x.name === e.service) || {}).replicas !== e.to ? ` <button class="btn btn-xs btn-primary" data-apply="${esc(e.service)}" data-to="${e.to}">Apply</button>` : ''}`,
        `<span class="ui-sub" style="white-space:normal;display:block;max-width:250px">${esc(e.reason || '')}</span>`,
        `<span class="ui-sub">${esc(e.executor === 'agent' ? 'agent' : 'DockGate')}</span>`,
      ] }));
      return `<div style="margin-top:16px">${UI.header('Auto Scaling history', 'What Auto Scaling did, would do (Suggest, Simulating), or could not do (server full).')}${UI.table([{ label: 'When' }, { label: 'Service' }, { label: 'What' }, { label: 'Why' }, { label: 'By' }], rows, { minWidth: 700 })}</div>`;
    }
    async function rollOut(name) {
      const s = data.services.find(x => x.name === name);
      window.__dgRollPull = true;
      const ok = await confirmDialog(`Roll out ${name}`, `<div class="text-sm">DockGate starts a new replica of <b>${esc(name)}</b> with the compose file and image as they are now, waits until it is ready (healthy, or running steadily), then stops one old replica gracefully — ${s.replicas} time${s.replicas === 1 ? '' : 's'}. Requests keep being served the whole time.<br><br>If the first new replica is not ready, it is removed and nothing old is touched.</div><label class="text-sm" style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" checked onchange="window.__dgRollPull=this.checked"> Pull the image first</label>`, 'Roll out');
      if (!ok) return;
      const pull = window.__dgRollPull !== false;
      const logEl = root.querySelector('[data-sc-log]');
      root.querySelectorAll('button').forEach(b => { b.disabled = true; });
      if (logEl) logEl.textContent = `Rolling out ${name}…`;
      try { const r = await API.post(`/compose/${encodeURIComponent(project)}/scaling/${encodeURIComponent(name)}/rollout`, { pull }); showToast(`${name}: ${r.replaced} replica${r.replaced === 1 ? '' : 's'} updated without downtime`); if (logEl) logEl.textContent = r.log || ''; }
      catch (e) { showToast(e.message, 'error'); if (logEl) logEl.textContent = e.message; }
      const keep = logEl ? logEl.textContent : '';
      await load();
      const l2 = root.querySelector('[data-sc-log]'); if (l2) l2.textContent = keep;
    }
    async function applySuggestion(name, to) {
      root.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { const r = await API.post(`/compose/${encodeURIComponent(project)}/scaling/${encodeURIComponent(name)}/apply`, { to }); showToast(`${name}: ${r.from} → ${r.to} replicas`); } catch (e) { showToast(e.message, 'error'); }
      await load();
    }
    function ruleDialog(name) {
      const s = data.services.find(x => x.name === name);
      const a = s.auto || { mode: 'off', min: Math.max(1, s.replicas || 1), max: Math.max(3, s.replicas || 1), cpuUp: 75, cpuDown: 25, memUp: null, memDown: null, logic: 'or', basis: 'average', step: 1, upMinutes: 5, downMinutes: 10, coolUpMinutes: 3, coolDownMinutes: 10 };
      const num = (k, label, help, v, lo, hi) => `<label class="ui-field"><span class="ui-label">${label}</span><input class="input" type="number" min="${lo}" max="${hi}" data-k="${k}" value="${v ?? ''}"><span class="ui-sub">${help}</span></label>`;
      const sim = a.mode === 'auto' && a.simulateUntil > Date.now();
      const body = `
        <div class="text-sm" style="margin-bottom:10px">Measured against the limits in your compose file: <b>${s.limits.cpu ? `${s.limits.cpu} CPU` : 'no CPU limit'}</b> · <b>${s.limits.mem ? mb(s.limits.mem) : 'no memory limit'}</b> per replica. A replica is added only when the server has room for its limits.</div>
        <label class="ui-field" style="margin-bottom:10px"><span class="ui-label">Mode</span><select class="select" data-k="mode">
          <option value="off" ${a.mode === 'off' ? 'selected' : ''}>Off</option>
          <option value="suggest" ${a.mode === 'suggest' ? 'selected' : ''}>Suggest — write what it would do; you apply it</option>
          <option value="auto" ${a.mode === 'auto' ? 'selected' : ''}>Auto — change the replicas</option></select></label>
        ${a.mode !== 'auto' ? '<label class="text-sm" style="display:flex;gap:6px;align-items:center;margin:-4px 0 10px"><input type="checkbox" data-k="skipSimulation"> With Auto, skip the 24 h simulation (it only writes what it would do first)</label>' : ''}
        ${sim ? `<label class="text-sm" style="display:flex;gap:6px;align-items:center;margin:-4px 0 10px"><input type="checkbox" data-k="startNow"> Simulating until ${esc(new Date(a.simulateUntil).toLocaleString())} — start acting now</label>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          ${num('min', 'Minimum replicas', 'never fewer', a.min, 1, 20)}${num('max', 'Maximum replicas', 'never more (up to 20)', a.max, 1, 20)}
          ${num('cpuUp', 'Add at CPU %', 'of its CPU limit, per replica', a.cpuUp, 10, 100)}${num('cpuDown', 'Remove at CPU %', 'at least 10 below', a.cpuDown, 1, 90)}
          ${s.limits.mem ? `${num('memUp', 'Add at memory % (optional)', 'of its memory limit', a.memUp, 10, 100)}${num('memDown', 'Remove at memory %', 'at least 10 below', a.memDown, 1, 90)}` : ''}
          ${num('upMinutes', 'Add after (minutes)', 'busy this long', a.upMinutes, 1, 30)}${num('downMinutes', 'Remove after (minutes)', 'quiet this long', a.downMinutes, 2, 60)}
          ${num('coolUpMinutes', 'Wait after adding (min)', 'before the next change', a.coolUpMinutes, 1, 60)}${num('coolDownMinutes', 'Wait after removing (min)', 'before the next change', a.coolDownMinutes, 1, 60)}
          ${num('step', 'Replicas per change', '1–5', a.step, 1, 5)}
        </div>`;
      const d = showModal(`Auto Scaling — ${esc(name)}`, body, [
        { label: 'Cancel', className: 'btn btn-secondary' },
        { label: 'Save', className: 'btn btn-primary', onClick: async () => {
          const v = {};
          d.overlay.querySelectorAll('[data-k]').forEach(el => { v[el.dataset.k] = el.type === 'checkbox' ? el.checked : (el.tagName === 'SELECT' ? el.value : (el.value === '' ? null : Number(el.value))); });
          try { await API.put(`/compose/${encodeURIComponent(project)}/scaling/${encodeURIComponent(name)}/rule`, { ...a, ...v }); showToast(`${name}: Auto Scaling ${v.mode}`); await load(); } catch (e) { showToast(e.message, 'error'); return false; }
          return true;
        } },
      ]);
    }
    // Auto-heal: own health check, or the agent's port check; without either there is nothing to watch.
    function healCell(s) {
      const agent = data.control && data.control.executor === 'agent';
      const how = s.healthcheck ? 'own health check' : agent ? (s.exposed ? 'agent checks the port' : 'no port to check') : 'needs a health check or the agent';
      const can = s.healthcheck || (agent && s.exposed);
      return `<div style="display:flex;align-items:center;gap:8px"><div class="toggle ${s.heal ? 'active' : ''}" role="switch" tabindex="0" aria-checked="${s.heal}" data-heal="${esc(s.name)}" ${!can && !s.heal ? 'style="opacity:.4;pointer-events:none"' : ''}></div></div><div class="ui-sub" style="white-space:normal;max-width:130px">${esc(how)}</div>`;
    }
    function executorNote() {
      const c = data.control || {};
      if (c.executor === 'agent') return `<div class="insight-card success" style="margin-top:10px"><div><b>The agent on this server runs these rules</b> (rules v${esc(c.ackedVersion)}). It keeps the replicas and heals by them also while DockGate is offline.</div></div>`;
      if (c.hasKey) return `<div class="insight-card warning" style="margin-top:10px"><div><b>DockGate runs these rules</b> — the agent has not taken the latest ones yet${c.error ? ` (${esc(c.error)})` : ''}. It retries every 10 minutes.</div></div>`;
      return '<div class="ui-sub" style="margin-top:8px">DockGate runs these rules while it is online. With the <b>Edge agent</b> (Servers → Edge agent, updated) they keep working when DockGate is offline.</div>';
    }
    async function heal(name, on) {
      try { await API.put(`/compose/${encodeURIComponent(project)}/scaling/${encodeURIComponent(name)}/heal`, { on }); showToast(`${name}: auto-heal ${on ? 'on' : 'off'}`); } catch (e) { showToast(e.message, 'error'); }
      await load();
    }
    async function change(name, delta) {
      const s = data.services.find(x => x.name === name);
      const n = Math.max(0, Math.min(20, s.wanted + delta));
      const needs = n > 1 ? s.scalable.fixes.filter(f => !s.fixes[f]) : [];
      if (needs.length) {
        const lines = needs.map(f => (f === 'dropPorts'
          ? `<li><b>Host port ${esc(s.ports.join(', '))} is removed</b> from ${esc(name)}: two replicas can not take one port. Requests must come through the proxy (e.g. nginx → <span class="td-mono">http://${esc(name)}:…</span>).</li>`
          : `<li><b>container_name ${esc(s.containerName)} is dropped</b>: two containers can not share a name. It stays a name other services reach it by.</li>`)).join('');
        const ok = await confirmDialog(`${name}: ${s.wanted} → ${n} replicas`, `<ul class="text-sm" style="padding-left:18px">${lines}</ul><div class="ui-sub">Written to DockGate's override, not your files. ${esc(name)} is recreated once. "Back to the files" undoes it.</div>`, 'Apply');
        if (!ok) return;
        return apply(name, n, true);
      }
      return apply(name, n, false);
    }
    async function apply(name, n, acceptFixes) {
      const logEl = root.querySelector('[data-sc-log]');
      root.querySelectorAll('button').forEach(b => { b.disabled = true; });
      if (logEl) logEl.textContent = `${name} → ${n}…`;
      try {
        const r = await API.put(`/compose/${encodeURIComponent(project)}/scaling/${encodeURIComponent(name)}/replicas`, { replicas: n, acceptFixes });
        showToast(`${name}: ${r.from} → ${r.to} replicas`);
      } catch (e) {
        showToast(e.message, 'error');
        if (logEl) logEl.textContent = e.message;
      }
      await load();
    }
    async function showOverride() {
      try {
        const r = await API.get(`/compose/${encodeURIComponent(project)}/scaling/override`);
        showModal('DockGate\'s override', `<div class="ui-sub td-mono" style="margin-bottom:6px">${esc(r.path || '')}</div><pre class="logs-viewer" style="white-space:pre-wrap;font-size:12px;padding:10px">${esc(r.text || '(empty)')}</pre>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
      } catch (e) { showToast(e.message, 'error'); }
    }
    async function reset() {
      const ok = await confirmDialog('Back to the compose files', `<div class="text-sm">DockGate removes its override; <span class="td-mono">docker compose up -d</span> then runs the services as your files say (replicas, ports and names come back). Extra replicas are removed.</div>`, 'Go back');
      if (!ok) return;
      try { await API.del(`/compose/${encodeURIComponent(project)}/scaling`); showToast('Back to the compose files'); } catch (e) { showToast(e.message, 'error'); }
      await load();
    }
    // A small confirm on top of the panel: resolves true / false.
    function confirmDialog(title, body, label) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const d = showModal(esc(title), body, [
          { label: 'Cancel', className: 'btn btn-secondary', onClick: () => finish(false) },
          { label, className: 'btn btn-primary', onClick: () => finish(true) },
        ]);
        // Closed with × or a click outside: no.
        const obs = new MutationObserver(() => { if (!document.body.contains(d.overlay)) { obs.disconnect(); finish(false); } });
        obs.observe(document.getElementById('modal-root'), { childList: true });
      });
    }
    await load();
  }
  return { open };
})();
