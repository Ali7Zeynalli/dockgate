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
      try { data = await API.get(`/compose/${encodeURIComponent(project)}/scaling`); } catch (e) { root.innerHTML = UI.errorState ? UI.errorState(e) : `<div class="text-sm" style="color:var(--danger)">${esc(e.message)}</div>`; return; }
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
        const state = s.drift ? UI.pill('warn', `drift: ${s.replicas} running, ${s.wanted} wanted`) : s.replicas ? UI.pill('ok', `${s.replicas} running`) : UI.pill('off', 'stopped');
        return { cells: [
          `<b>${esc(s.name)}</b><div class="ui-sub td-mono">${esc(s.image || '')}</div>${notes.length ? `<div style="margin-top:4px;white-space:normal;max-width:280px">${notes.join('<br>')}</div>` : ''}`,
          `<div style="display:flex;align-items:center;gap:6px"><button class="btn btn-xs btn-secondary" data-minus="${esc(s.name)}" ${s.wanted <= 0 ? 'disabled' : ''}>−</button><b style="min-width:22px;text-align:center">${s.wanted}</b><button class="btn btn-xs btn-secondary" data-plus="${esc(s.name)}" ${!canMore || s.wanted >= 20 ? 'disabled' : ''} title="${canMore ? 'Add a replica' : esc(sc.block)}">+</button></div>`,
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
        <div data-sc-log class="text-sm td-mono" style="white-space:pre-wrap;margin-top:8px"></div>`;
      root.querySelectorAll('[data-heal]').forEach(t => t.onclick = () => heal(t.dataset.heal, t.getAttribute('aria-checked') !== 'true'));
      root.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => change(b.dataset.plus, +1));
      root.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => change(b.dataset.minus, -1));
      root.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => apply(b.dataset.fix, Number(b.dataset.n), false));
      const ov = root.querySelector('[data-ov]'); if (ov) ov.onclick = showOverride;
      const rs = root.querySelector('[data-reset]'); if (rs) rs.onclick = reset;
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
