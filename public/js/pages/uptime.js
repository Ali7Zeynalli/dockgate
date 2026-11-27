// Observe > Uptime: are the sites answering? HTTP(S) / SSL / TCP / DNS checks DockGate runs every 30 s - 1 h,
// uptime per period, response time, incidents, certificate days left. One check's page: #/observe?tab=uptime&id=N.
const UptimePage = (() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const TYPE = { http: 'HTTP(S)', ssl: 'SSL', tcp: 'TCP', dns: 'DNS' };
  const pctTxt = (v) => (v == null ? '-' : `${v >= 99.995 ? '100' : v.toFixed(v >= 99 ? 2 : 1)}%`);
  const dur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`; };
  const when = (t) => (t ? formatTime(new Date(t).toISOString(), { dateStyle: 'medium', timeStyle: 'short' }) : '-'); // ms -> formatTime reads numbers as seconds

  function statusOf(c) {
    const s = c.state || {};
    if (!c.enabled) return { key: 'paused', pill: UI.pill('off', c.pausedUntil ? `Paused until ${formatTime(new Date(c.pausedUntil).toISOString(), { timeStyle: 'short' })}` : 'Paused') };
    if (s.status === 'down') return { key: 'down', pill: UI.pill('bad', `● Down ${dur(Date.now() - s.since)}`) };
    if (s.status === 'up' && s.slow) return { key: 'slow', pill: UI.pill('warn', '● Slow') };
    const bad = s.places ? Object.values(s.places).filter(p => !p.ok) : [];
    if (s.status === 'up' && bad.length) return { key: 'up', pill: UI.pill('ok', '● Up') + ` <span class="ui-sub" title="${esc(bad.map(p => `${p.label}: ${p.error}`).join(', '))}" style="color:var(--warning)">${bad.length} place${bad.length > 1 ? 's' : ''} failing</span>` };
    if (s.status === 'up') return { key: 'up', pill: UI.pill('ok', '● Up') };
    if (s.fails) return { key: 'pending', pill: UI.pill('warn', `Failing (${s.fails}/${c.fails})`) };
    return { key: 'pending', pill: UI.pill('off', 'Waiting for the first check') };
  }
  function certCell(c) {
    const x = c.state && c.state.cert;
    if (!x) return '<span class="ui-sub">-</span>';
    if (x.daysLeft < 0) return '<span class="text-danger" style="font-weight:600">expired</span>';
    if (!x.nameOk) return '<span class="text-danger" style="font-weight:600">wrong name</span>';
    const tone = x.daysLeft <= 14 ? 'color:var(--warning);font-weight:600' : 'color:var(--text-secondary)';
    return `<span style="${tone}" title="${esc(x.issuer)}, until ${esc(new Date(x.validTo).toLocaleDateString())}">${x.daysLeft} days</span>`;
  }
  function bar(b) {
    const col = ['var(--bg-elevated)', 'var(--success)', 'var(--warning)', 'var(--danger)'];
    const tip = ['no checks', 'all up', 'some failed', 'down'];
    return `<span style="display:inline-flex;gap:2px;align-items:flex-end;height:18px" aria-label="Last 24 hours">${(b || []).map(v => `<span title="${tip[v]}" style="display:block;width:5px;height:${v === 3 ? 18 : v === 2 ? 14 : v === 1 ? 11 : 6}px;border-radius:2px;background:${col[v]}"></span>`).join('')}</span>`;
  }
  const targetLine = (c) => {
    const k = c.config || {};
    if (c.type === 'http') return `${k.from && (k.from.length > 1 || k.from[0] !== 'dockgate') ? `[${k.from.length} places] ` : ''}${k.method || 'GET'} ${c.target}, expect ${k.expect || '200-399'}${k.contains ? `, "${k.contains}"` : ''}`;
    if (c.type === 'tcp') return `TCP ${c.target}`;
    if (c.type === 'dns') return `DNS ${c.target}${k.expectIp ? ` -> ${k.expectIp}` : ''}`;
    return `SSL ${c.target}`;
  };

  // ---- link to Docker ----
  const linkLabel = (l) => `${l.kind === 'compose' ? 'Compose' : l.kind === 'swarm' ? 'Swarm service' : 'Container'}: ${l.name}${l.server && l.server !== 'local' ? ` (${l.server})` : ''}`;
  async function fillLinks(sel, current) {
    const server = (Store.get('activeServer') || {}).id || 'local';
    const add = (label, items) => { if (!items.length) return; const g = document.createElement('optgroup'); g.label = label; items.forEach(([l, txt]) => { const o = document.createElement('option'); o.value = JSON.stringify(l); o.textContent = txt; if (current && current.kind === l.kind && current.name === l.name && current.server === l.server) o.selected = true; g.appendChild(o); }); sel.appendChild(g); };
    if (current) [...sel.options].forEach(o => { if (o.value && o.value !== '' && o.selected) o.remove(); });
    const [projects, containers, services] = await Promise.all([API.get('/compose').catch(() => []), API.get('/containers').catch(() => []), API.get('/swarm/services').then(r => r.services || []).catch(() => [])]);
    add('Compose projects', (projects || []).filter(p => p.name && !p.onSwarm).map(p => [{ server, kind: 'compose', name: p.name }, p.name]));
    add('Swarm services', (services || []).map(x => [{ server, kind: 'swarm', name: x.name || x.Spec?.Name }, x.name || x.Spec?.Name]).filter(x => x[1]));
    add('Containers', (containers || []).filter(c => !c.composeProject).map(c => [{ server, kind: 'container', name: c.name }, c.name]));
    if (current && ![...sel.options].some(o => o.selected && o.value)) { const o = document.createElement('option'); o.value = JSON.stringify(current); o.textContent = linkLabel(current) + ' (not on this server)'; o.selected = true; sel.appendChild(o); }
  }
  function contextHtml(x, c) {
    if (!x) return '';
    if (x.error) return `<div class="ui-sub text-danger">${esc(x.error)}</div>`;
    return `<div class="text-sm" style="margin-bottom:6px">${esc(x.summary || '')}</div>
      ${(x.items || []).slice(0, 8).map(i => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px"><span class="td-mono">${esc(i.name)}</span><span style="color:${i.state === 'running' && !/unhealthy|restarting/i.test(i.detail || '') ? 'var(--success)' : 'var(--danger)'}">${esc(i.state)}${i.detail ? `, ${esc(i.detail)}` : ''}</span></div>`).join('')}
      ${x.logs ? `<div class="ui-sub" style="margin-top:8px">Last lines${x.from ? ` of <span class="td-mono">${esc(x.from)}</span>` : ''}</div><pre class="td-mono" style="margin:4px 0 0;padding:8px;border-radius:8px;background:var(--bg-primary);border:1px solid var(--border);font-size:11.5px;white-space:pre-wrap;max-height:220px;overflow:auto">${esc(x.logs)}</pre>` : ''}`;
  }

  // ---- list ----
  async function renderList(content) {
    let list = [];
    try { list = await API.get('/uptime'); } catch (e) { content.innerHTML = UI.errorState(e, { title: 'Uptime could not be loaded' }); return; }
    const st = Store.view('uptime');
    const filter = st.get('filter', 'all');
    const counts = { all: list.length, down: 0, slow: 0, paused: 0, cert: 0 };
    list.forEach(c => { const k = statusOf(c).key; if (counts[k] != null) counts[k]++; const x = c.state && c.state.cert; if (x && (x.daysLeft <= 14 || !x.nameOk)) counts.cert++; });
    const up = list.filter(c => statusOf(c).key === 'up' || statusOf(c).key === 'slow').length;
    const shown = list.filter(c => filter === 'all' || (filter === 'cert' ? (c.state.cert && (c.state.cert.daysLeft <= 14 || !c.state.cert.nameOk)) : statusOf(c).key === filter));
    const downList = list.filter(c => statusOf(c).key === 'down');
    content.innerHTML = `
      ${UI.header('Uptime', 'Are your sites answering? DockGate checks them from outside the container: status code, response time, the SSL certificate. Alerts go to the channels of Settings > Notifications.',
        `${UI.btn('Alert rules', 'id="ut-rules"')} ${list.length ? (list.some(c => c.enabled) ? UI.btn('Pause all...', 'id="ut-pauseall"') : UI.btn('Resume all', 'id="ut-resumeall"')) : ''} ${UI.primary('+ New check', 'id="ut-new"')}`)}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px">
        <div class="card" style="padding:14px 16px"><div class="ui-sub">Checks</div><div style="font-size:24px;font-weight:700">${list.length}</div></div>
        <div class="card" style="padding:14px 16px"><div class="ui-sub">Up</div><div style="font-size:24px;font-weight:700;color:var(--success)">${up}</div></div>
        <div class="card" style="padding:14px 16px;${downList.length ? 'border-color:var(--danger);background:var(--danger-bg)' : ''}"><div class="ui-sub">Down</div><div style="font-size:24px;font-weight:700;color:${downList.length ? 'var(--danger)' : 'inherit'}">${downList.length}${downList[0] ? ` <span style="font-size:13px;font-weight:500">${esc(downList[0].name)}</span>` : ''}</div></div>
        <div class="card" style="padding:14px 16px;${counts.cert ? 'border-color:var(--warning)' : ''}"><div class="ui-sub">Certificates ≤ 14 days or invalid</div><div style="font-size:24px;font-weight:700;color:${counts.cert ? 'var(--warning)' : 'inherit'}">${counts.cert}</div></div>
      </div>
      ${list.length ? UI.chips([['all', 'All', counts.all], ['down', 'Down', counts.down], ['slow', 'Slow', counts.slow], ['paused', 'Paused', counts.paused], ['cert', 'Certificates', counts.cert]], filter) : ''}
      ${list.length ? UI.table([{ label: 'Name' }, { label: 'Status' }, { label: 'Uptime 24 h, 30 d' }, { label: 'Response' }, { label: 'Last 24 h' }, { label: 'SSL' }, { label: '', align: 'right' }],
        shown.map(c => {
          const s = c.state || {};
          const slowTone = s.slow ? 'color:var(--warning);font-weight:600' : s.status === 'down' ? 'color:var(--danger);font-weight:600' : '';
          return { cells: [
            `<a href="#" data-open="${c.id}" class="td-name">${esc(c.name)}</a><div class="ui-sub td-mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(targetLine(c))}</div>`,
            statusOf(c).pill + (s.status === 'down' && s.lastError ? `<div class="ui-sub text-danger" style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(s.lastError)}">${esc(s.lastError)}</div>` : ''),
            `<b>${pctTxt(c.uptime24)}</b> <span class="ui-sub">- ${pctTxt(c.uptime30)}</span>`,
            `<span class="td-mono" style="${slowTone}">${s.status === 'down' ? '-' : s.lastMs != null ? `${s.lastMs} ms` : '-'}</span>`,
            bar(c.bar),
            certCell(c),
            UI.menu([
              { label: 'Check now', attrs: `data-run="${c.id}"` },
              { label: 'Open', attrs: `data-open="${c.id}"` },
              { label: 'Edit...', attrs: `data-edit="${c.id}"` },
              c.enabled ? { label: 'Pause...', attrs: `data-pause="${c.id}"` } : { label: 'Resume', attrs: `data-resume="${c.id}"` },
              '-', { label: `${Icons.trash} Delete...`, attrs: `data-del="${c.id}"`, danger: true }]),
          ] };
        }), { empty: 'Nothing matches this filter.', minWidth: 900 })
        : `<div class="card" style="padding:28px;text-align:center;display:grid;gap:10px;justify-items:center"><div style="font-weight:700;font-size:16px">No checks yet</div><div class="text-sm text-muted" style="max-width:560px">Add the address of a site, an API, a database port or a certificate. DockGate checks it every minute and tells you when it stops answering, gets slow, or its certificate is about to expire.</div>${UI.primary('+ New check', 'data-new2')}</div>`}`;
    const reload = () => renderList(content);
    // Domains found in proxy labels of the active server, without a check yet.
    API.get('/uptime/suggest/proxies').then(sug => {
      if (!sug.length || !document.body.contains(content) || st.get('hideSug', '') === sug.map(x => x.host).join(',')) return;
      const box = document.createElement('div');
      box.className = 'insight-card info'; box.style.marginTop = '14px';
      box.innerHTML = `<div style="flex:1"><b>Found in your proxies - add a check?</b><div class="text-sm" style="margin:4px 0 8px">${sug.slice(0, 6).map(x => `<span class="td-mono">${esc(x.host)}</span> <span class="ui-sub">(${esc(x.via)} of ${esc(x.container)})</span>`).join(', ')}</div>
        <div style="display:flex;gap:8px">${UI.btn(sug.length > 1 ? `Add ${Math.min(sug.length, 6)} checks` : 'Add check', 'data-sug-add', 'btn-primary')} ${UI.btn('Not now', 'data-sug-hide')}</div></div>`;
      content.appendChild(box);
      box.querySelector('[data-sug-hide]').onclick = () => { st.set('hideSug', sug.map(x => x.host).join(',')); box.remove(); };
      box.querySelector('[data-sug-add]').onclick = async () => {
        for (const x of sug.slice(0, 6)) { try { await API.post('/uptime', { type: 'http', name: x.host, target: `https://${x.host}/`, interval: 60, fails: 2, link: x.link, config: { certAlerts: true } }); } catch (e) { showToast(`${x.host}: ${e.message}`, 'error'); } }
        showToast('Checks added'); setTimeout(reload, 2500);
      };
    }).catch(() => {});
    content.querySelector('#ut-new')?.addEventListener('click', () => openForm(null, reload));
    content.querySelector('[data-new2]')?.addEventListener('click', () => openForm(null, reload));
    content.querySelector('#ut-rules')?.addEventListener('click', () => Router.navigate('settings', { tab: 'notifications' }));
    content.querySelector('#ut-resumeall')?.addEventListener('click', async () => { try { const r = await API.post('/uptime/pause-all', { paused: false }); showToast(`${r.count} resumed`); reload(); } catch (e) { showToast(e.message, 'error'); } });
    content.querySelector('#ut-pauseall')?.addEventListener('click', () => UI.dialog({ title: 'Pause all checks', saveLabel: 'Pause all', context: false,
      body: `<div class="text-sm" style="margin-bottom:10px">No checks and no alerts while paused - for planned work on everything. Paused time does not count against uptime.</div>
        <label class="ui-field"><span class="ui-label">For</span><select class="input" id="ut-pamin"><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="240">4 hours</option><option value="1440">1 day</option><option value="0">Until I resume them</option></select></label>`,
      onSave: async (ov) => { const r = await API.post('/uptime/pause-all', { paused: true, minutes: Number(ov.querySelector('#ut-pamin').value) || null }); showToast(`${r.count} paused`); reload(); } }));
    content.querySelectorAll('[data-chip]').forEach(b => b.addEventListener('click', () => { st.set('filter', b.dataset.chip); reload(); }));
    content.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); Router.navigate('observe', { tab: 'uptime', id: a.dataset.open }); }));
    content.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; showToast('Checking...', 'info', 2000);
      try { const r = await API.post(`/uptime/${b.dataset.run}/check`, {}); showToast(r.ok ? `✓ ${r.status ? r.status + ', ' : ''}${r.ms} ms` : `✗ ${r.error}`, r.ok ? 'success' : 'error', 6000); } catch (e) { showToast(e.message, 'error'); }
      reload();
    }));
    wireCommon(content, list, reload);
  }

  function wireCommon(content, list, reload) {
    const byId = (id) => list.find(c => String(c.id) === String(id));
    content.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openForm(byId(b.dataset.edit), reload)));
    content.querySelectorAll('[data-resume]').forEach(b => b.addEventListener('click', async () => { try { await API.post(`/uptime/${b.dataset.resume}/pause`, { paused: false }); showToast('Resumed'); reload(); } catch (e) { showToast(e.message, 'error'); } }));
    content.querySelectorAll('[data-pause]').forEach(b => b.addEventListener('click', () => {
      const c = byId(b.dataset.pause);
      UI.dialog({ title: `Pause ${esc(c.name)}`, saveLabel: 'Pause', context: false,
        body: `<div class="text-sm" style="margin-bottom:10px">No checks and no alerts while paused - for planned work. Paused time does not count against uptime.</div>
          <label class="ui-field"><span class="ui-label">For</span><select class="input" id="ut-pmin"><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="240">4 hours</option><option value="1440">1 day</option><option value="0">Until I resume it</option></select></label>`,
        onSave: async (ov) => { await API.post(`/uptime/${c.id}/pause`, { paused: true, minutes: Number(ov.querySelector('#ut-pmin').value) || null }); showToast('Paused'); reload(); } });
    }));
    content.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      const c = byId(b.dataset.del);
      showDeleteConfirm('Delete check', { message: `Delete <b>${esc(c.name)}</b> and its history (results and incidents)?`, phrase: c.name, onConfirm: async () => {
        try { await API.del(`/uptime/${c.id}`); showToast('Deleted'); if (content.dataset.detail) Router.navigate('observe', { tab: 'uptime' }); else reload(); } catch (e) { showToast(e.message, 'error'); }
      } });
    }));
  }

  // ---- one check ----
  let chart = null;
  async function renderDetail(content, id, range = '24h') {
    let c;
    try { c = await API.get(`/uptime/${id}?range=${range}`); } catch (e) { content.innerHTML = UI.errorState(e, { title: 'This check could not be loaded' }); return; }
    content.dataset.detail = '1';
    const s = c.state || {}, x = s.cert;
    const tiles = [['24 hours', c.periods.d1], ['7 days', c.periods.d7], ['30 days', c.periods.d30], ['90 days', c.periods.d90]];
    const down = s.status === 'down';
    content.innerHTML = `
      <div class="ui-sub" style="margin-bottom:8px"><a href="#" data-back>Observe / Uptime</a> / <b>${esc(c.name)}</b></div>
      ${UI.header(`${esc(c.name)} ${statusOf(c).pill}`, `<span class="td-mono">${esc(targetLine(c))}</span>, every ${c.interval >= 60 ? c.interval / 60 + ' min' : c.interval + ' s'}, down after ${c.fails} failure${c.fails > 1 ? 's' : ''} in a row`,
        `${UI.btn('Check now', `data-run="${c.id}"`)} ${c.enabled ? UI.btn('Pause...', `data-pause="${c.id}"`) : UI.btn('Resume', `data-resume="${c.id}"`)} ${UI.btn('Edit...', `data-edit="${c.id}"`)} ${UI.menu([{ label: `${Icons.trash} Delete...`, attrs: `data-del="${c.id}"`, danger: true }])}`)}
      ${s.deploying && Date.now() - s.deploying < 5 * 60000 ? `<div class="insight-card info" style="margin-bottom:14px"><div>Waiting - DockGate is deploying or restarting <b>${esc(c.config.link ? c.config.link.name : '')}</b>; checks start again 3 minutes after.</div></div>` : ''}
      ${down ? `<div class="insight-card danger" style="margin-bottom:14px"><div><b>Down since ${when(s.since)} (${dur(Date.now() - s.since)})</b><div class="text-sm" style="margin-top:4px">${esc(s.lastError || '')}</div></div></div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px">
        ${tiles.map(([l, p]) => `<div class="card" style="padding:14px 16px"><div class="ui-sub">Uptime ${l}</div><div style="font-size:22px;font-weight:700">${pctTxt(p.uptime)}</div><div class="ui-sub">${p.avgMs != null ? `avg ${p.avgMs} ms, ` : ''}${p.n} checks</div></div>`).join('')}
        <div class="card" style="padding:14px 16px"><div class="ui-sub">Last check</div><div style="font-size:22px;font-weight:700">${down ? 'failed' : s.lastMs != null ? s.lastMs + ' ms' : '-'}</div><div class="ui-sub">${s.lastAt ? timeAgo(new Date(s.lastAt).toISOString()) : 'not yet'}${s.lastStatus ? ', HTTP ' + s.lastStatus : ''}</div></div>
      </div>
      <div class="card" style="padding:14px 16px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px"><b style="flex:1">Response time</b>${UI.seg([['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['90d', '90 d']], range, 'data-range')}</div>
        <div style="position:relative;height:200px"><canvas id="ut-chart"></canvas></div>
        <div class="ui-sub" style="margin-top:6px">Red: periods with failed checks. Gaps: paused or no checks.</div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:2 1 520px;min-width:0">
          ${UI.header('Incidents', 'Each time it was down: when, how long, why.')}
          ${UI.table([{ label: 'Started' }, { label: 'Lasted' }, { label: 'Cause' }],
            (c.incidents || []).map(i => ({ cells: [when(i.start), i.end ? dur(i.end - i.start) : `<span class="text-danger" style="font-weight:600">ongoing, ${dur(Date.now() - i.start)}</span>`, `<span class="text-sm">${esc(i.cause || '')}</span>`] })),
            { empty: 'No incidents - it has not been down.', minWidth: 520 })}
        </div>
        <div style="flex:1 1 300px;min-width:0;display:grid;gap:14px">
          ${x ? `<div class="card" style="padding:14px 16px;display:grid;gap:6px;font-size:13px">
            <b>SSL certificate</b>
            <div style="display:flex;justify-content:space-between;gap:8px"><span class="ui-sub">Expires</span><span>${new Date(x.validTo).toLocaleDateString()}, <b style="color:${x.daysLeft < 0 ? 'var(--danger)' : x.daysLeft <= 14 ? 'var(--warning)' : 'var(--success)'}">${x.daysLeft < 0 ? 'expired' : x.daysLeft + ' days'}</b></span></div>
            <div style="display:flex;justify-content:space-between;gap:8px"><span class="ui-sub">Issuer</span><span>${esc(x.issuer || '-')}</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px"><span class="ui-sub">Names</span><span class="td-mono" style="font-size:12px;text-align:right">${esc((x.names || []).slice(0, 4).join(', ') || '-')}</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px"><span class="ui-sub">Valid for this name</span><span style="color:${x.nameOk ? 'var(--success)' : 'var(--danger)'}">${x.nameOk ? 'yes' : 'no'}</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px"><span class="ui-sub">Trusted</span><span style="color:${x.authorized ? 'var(--success)' : 'var(--warning)'}">${x.authorized ? 'yes' : esc(x.error || 'no')}</span></div>
            ${c.config.certAlerts ? '<span class="ui-sub">Alerts at 30, 14, 7, 1 days left</span>' : '<span class="ui-sub">Certificate alerts are off for this check</span>'}
          </div>` : ''}
          ${c.config.link ? `<div class="card" style="padding:14px 16px;display:grid;gap:8px;font-size:13px">
            <div style="display:flex;align-items:center;gap:8px"><b style="flex:1">${esc(linkLabel(c.config.link))}</b>${UI.btn('Restart', 'data-restart')} ${UI.btn('Refresh', 'data-ctx')}</div>
            <div data-ctxbox><span class="ui-sub">Loading...</span></div>
            <span class="ui-sub">While DockGate deploys, restarts or updates it (and for 3 minutes after), this check waits - no false "down".</span>
          </div>` : ''}
          ${s.places ? `<div class="card" style="padding:14px 16px;display:grid;gap:6px;font-size:13px">
            <b>Checked from</b>
            ${Object.values(s.places).map(p => `<div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(p.label)}</span><span style="color:${p.ok ? 'var(--success)' : 'var(--danger)'}">${p.ok ? `✓ ${p.ms} ms` : `✗ ${esc(p.error)}`}</span></div>`).join('')}
            <span class="ui-sub">Down only when every place fails.</span>
          </div>` : ''}
          <div class="card" style="padding:14px 16px;display:grid;gap:6px;font-size:13px">
            <b>Alerts</b>
            <span class="ui-sub">Down after ${c.fails} failure${c.fails > 1 ? 's' : ''} in a row, back up after one success${c.config.slowMs ? `, slow above ${c.config.slowMs} ms on ${c.config.slowCount} checks` : ''}${c.config.certAlerts ? ', certificate' : ''}. Sent to the channels of Settings > Notifications.</span>
          </div>
        </div>
      </div>`;
    content.querySelector('[data-back]').addEventListener('click', (e) => { e.preventDefault(); Router.navigate('observe', { tab: 'uptime' }); });
    content.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => renderDetail(content, id, b.dataset.range)));
    content.querySelector('[data-run]').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking...';
      try { const r = await API.post(`/uptime/${c.id}/check`, {}); showToast(r.ok ? `✓ ${r.status ? r.status + ', ' : ''}${r.ms} ms` : `✗ ${r.error}`, r.ok ? 'success' : 'error', 6000); } catch (er) { showToast(er.message, 'error'); }
      renderDetail(content, id, range);
    });
    wireCommon(content, [c], () => renderDetail(content, id, range));
    drawChart(content, c, range);
    if (c.config.link) {
      const box = content.querySelector('[data-ctxbox]');
      const load = () => API.get(`/uptime/${c.id}/context`).then(x => { if (box) box.innerHTML = contextHtml(x, c) || '<span class="ui-sub">-</span>'; }).catch(e => { if (box) box.innerHTML = `<span class="text-danger">${esc(e.message)}</span>`; });
      load();
      content.querySelector('[data-ctx]').onclick = load;
      content.querySelector('[data-restart]').onclick = () => showConfirm('Restart', `Restart <b>${esc(linkLabel(c.config.link))}</b>?`, async () => {
        try { const r = await API.post(`/uptime/${c.id}/restart`, {}); showToast(`Restarted: ${r.restarted.join(', ')}`); setTimeout(load, 3000); } catch (e) { showToast(e.message, 'error'); }
      });
    }
  }
  function drawChart(content, c, range) {
    if (chart) { try { chart.destroy(); } catch (e) {} chart = null; }
    const cv = content.querySelector('#ut-chart'); if (!cv || typeof Chart === 'undefined') return;
    const pts = c.series || [];
    const lbl = (t) => { const d = new Date(t); return range === '24h' ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + (range === '7d' ? ' ' + d.getHours() + ':00' : ''); };
    chart = new Chart(cv, {
      type: 'bar',
      data: { labels: pts.map(p => lbl(p.t)), datasets: [{ label: 'avg ms', data: pts.map(p => (p.n ? p.avg : null)), backgroundColor: pts.map(p => (p.n && p.ok < p.n ? '#ef4444' : '#3b82f6')), borderRadius: 2, barPercentage: 1, categoryPercentage: 0.9 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        scales: { y: { beginAtZero: true, ticks: { color: '#9ca3af', font: { size: 10 }, callback: (v) => v + ' ms' }, grid: { color: 'rgba(255,255,255,0.06)' } }, x: { ticks: { color: '#9ca3af', font: { size: 10 }, maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => { const p = pts[ctx.dataIndex]; return p.n ? `avg ${p.avg} ms, max ${p.max} ms, ${p.ok}/${p.n} ok` : 'no checks'; } } } } },
    });
  }

  // ---- new / edit ----
  function openForm(c, done) {
    const k = (c && c.config) || {};
    const type = (c && c.type) || 'http';
    const sel = (v, opts) => opts.map(([val, l]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
    const d = UI.dialog({ title: c ? `Edit ${esc(c.name)}` : 'New check', saveLabel: c ? 'Save' : 'Add check', wide: true, context: false,
      body: `
        <div class="ui-field"><span class="ui-label">Type</span>${UI.seg([['http', 'HTTP(S)'], ['ssl', 'SSL only'], ['tcp', 'TCP port'], ['dns', 'DNS']], type, 'data-type')}</div>
        <div class="ui-field"><span class="ui-label" id="ut-tlabel">URL</span><div style="display:flex;gap:8px"><select class="input" id="ut-method" style="width:100px">${sel(k.method || 'GET', [['GET', 'GET'], ['HEAD', 'HEAD'], ['POST', 'POST']])}</select><input class="input td-mono" id="ut-target" value="${esc(c ? c.target : '')}" placeholder="https://example.com/health" style="flex:1"></div><span class="ui-sub" id="ut-thint"></span></div>
        <label class="ui-field"><span class="ui-label">Name</span><input class="input" id="ut-name" value="${esc(c ? c.name : '')}" placeholder="shown in the list and in alerts (default: the address)"></label>
        <div data-only="http" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          <label class="ui-field"><span class="ui-label">Expected status</span><input class="input td-mono" id="ut-expect" value="${esc(k.expect || '200-399')}"><span class="ui-sub">200, 200-399, 2xx, 200,301</span></label>
          <label class="ui-field"><span class="ui-label">Page must contain</span><input class="input" id="ut-contains" value="${esc(k.contains || '')}" placeholder="optional"></label>
          <label class="ui-field"><span class="ui-label">Page must not contain</span><input class="input" id="ut-notcontains" value="${esc(k.notContains || '')}" placeholder="e.g. Error, maintenance"></label>
        </div>
        <div data-only="dns"><label class="ui-field"><span class="ui-label">Expected address (optional)</span><input class="input td-mono" id="ut-expectip" value="${esc(k.expectIp || '')}" placeholder="203.0.113.10"></label></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
          <label class="ui-field"><span class="ui-label">Every</span><select class="input" id="ut-int">${sel(c ? c.interval : 60, [[30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [900, '15 min'], [1800, '30 min'], [3600, '1 h']])}</select></label>
          <label class="ui-field"><span class="ui-label">Down after</span><select class="input" id="ut-fails">${sel(c ? c.fails : 2, [[1, '1 failure'], [2, '2 failures in a row'], [3, '3 failures in a row'], [5, '5 failures in a row']])}</select></label>
          <label class="ui-field"><span class="ui-label">Timeout</span><select class="input" id="ut-timeout">${sel(k.timeout || 10, [[5, '5 s'], [10, '10 s'], [20, '20 s'], [30, '30 s']])}</select></label>
          <label class="ui-field"><span class="ui-label">Slow above (ms)</span><input class="input td-mono" id="ut-slow" type="number" min="0" value="${esc(k.slowMs || '')}" placeholder="off"><span class="ui-sub">on 3 checks in a row</span></label>
        </div>
        <div class="ui-field"><span class="ui-label">Check from</span><div id="ut-from" style="display:flex;gap:14px;flex-wrap:wrap"><label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" value="dockgate" ${!k.from || k.from.includes('dockgate') ? 'checked' : ''}> DockGate</label></div><span class="ui-sub">Other servers run the same check over SSH (curl, nc, openssl, getent). With several places it is down only when every place fails. When DockGate runs on the site's own server, add another server to see it from outside.</span></div>
        <label class="ui-field"><span class="ui-label">Linked to (optional)</span><select class="input" id="ut-link"><option value="">Nothing</option>${k.link ? `<option value="${esc(JSON.stringify(k.link))}" selected>${esc(linkLabel(k.link))}</option>` : ''}</select><span class="ui-sub">A container, Compose project or Swarm service of the server picked in the top bar. Alerts then show its state and last log lines, the page offers Restart, and the check waits while DockGate deploys it.</span></label>
        <label data-only="http ssl" style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="ut-cert" ${k.certAlerts === false ? '' : 'checked'}> Certificate alerts: 30, 14, 7, 1 days before it expires, and when it is invalid</label>
        <details data-only="http"><summary class="text-sm" style="cursor:pointer">Advanced</summary>
          <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px"><input type="checkbox" id="ut-follow" ${k.follow === false ? '' : 'checked'}> Follow redirects</label>
          <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="ut-ignoretls" ${k.ignoreTls ? 'checked' : ''}> Ignore certificate errors (self-signed) - the certificate is still shown</label>
          <label class="ui-field" style="margin-top:8px"><span class="ui-label">Headers (one per line, Name: value)</span><textarea class="input td-mono" id="ut-headers" rows="3" placeholder="Authorization: Bearer ...">${esc(Object.entries(k.headers || {}).map(([a, b]) => `${a}: ${b}`).join('\n'))}</textarea><span class="ui-sub">Stored in DockGate's database; avoid long-lived secrets.</span></label>
        </details>
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary)"><button type="button" class="btn btn-sm btn-secondary" id="ut-test">Test now</button><span class="text-sm" id="ut-tres" style="flex:1">Runs from the places ticked above.</span></div>`,
      onOpen: (ov) => {
        let t = type;
        const show = () => {
          ov.querySelectorAll('[data-only]').forEach(el => { el.style.display = el.dataset.only.split(' ').includes(t) ? '' : 'none'; });
          ov.querySelector('#ut-method').style.display = t === 'http' ? '' : 'none';
          const L = { http: ['URL', 'https://example.com/health', 'http:// or https://'], ssl: ['Host', 'example.com', 'host or host:port (default 443)'], tcp: ['Host and port', 'db.internal:5432', 'host:port - a database, SMTP, Redis...'], dns: ['Name', 'example.com', 'resolves to an address'] }[t];
          ov.querySelector('#ut-tlabel').textContent = L[0]; ov.querySelector('#ut-target').placeholder = L[1]; ov.querySelector('#ut-thint').textContent = L[2];
        };
        ov.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => { t = b.dataset.type; ov.querySelectorAll('[data-type]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); show(); }));
        show();
        ov._type = () => t;
        fillLinks(ov.querySelector('#ut-link'), k.link);
        API.get('/servers').then(d => { const box = ov.querySelector('#ut-from'); (d.servers || []).filter(x => x.id !== 'local' && x.type !== 'local').forEach(x => { const l = document.createElement('label'); l.style.cssText = 'display:flex;gap:6px;align-items:center;font-weight:400'; l.innerHTML = `<input type="checkbox" value="${esc(x.id)}" ${(k.from || []).includes(x.id) ? 'checked' : ''}> ${esc(x.name || x.id)}`; box.appendChild(l); }); }).catch(() => {});
        ov.querySelector('#ut-test').addEventListener('click', async (e) => {
          const b = e.currentTarget, out = ov.querySelector('#ut-tres');
          b.disabled = true; out.textContent = 'Checking...'; out.style.color = '';
          try {
            const r = await API.post('/uptime/test', read(ov));
            out.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
            out.textContent = (r.ok ? `✓ ${r.status ? r.status + ', ' : ''}${r.ms} ms${r.cert ? `, certificate ${r.cert.daysLeft} days` : ''}${r.detail ? ', ' + r.detail : ''}` : `✗ ${r.error}`) + (r.places ? ' - ' + Object.values(r.places).map(p => `${p.label}: ${p.ok ? p.ms + ' ms' : p.error}`).join(', ') : '');
          } catch (er) { out.style.color = 'var(--danger)'; out.textContent = er.message; }
          b.disabled = false;
        });
      },
      onSave: async (ov) => {
        const body = read(ov);
        if (c) await API.put(`/uptime/${c.id}`, body); else await API.post('/uptime', body);
        showToast(c ? 'Saved' : 'Check added - the first result comes in a few seconds');
        setTimeout(done, c ? 0 : 2500); if (!c) done();
      } });
    void d;
  }
  function read(ov) {
    const v = (id) => (ov.querySelector('#' + id) || {}).value;
    const ch = (id) => !!(ov.querySelector('#' + id) || {}).checked;
    const headers = {};
    String(v('ut-headers') || '').split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    let link = null; try { link = v('ut-link') ? JSON.parse(v('ut-link')) : null; } catch (e) { link = null; }
    const from = [...ov.querySelectorAll('#ut-from input:checked')].map(i => i.value);
    return { type: ov._type(), target: v('ut-target'), link, name: v('ut-name'), interval: Number(v('ut-int')), fails: Number(v('ut-fails')),
      config: { method: v('ut-method'), expect: v('ut-expect'), contains: v('ut-contains'), notContains: v('ut-notcontains'), expectIp: v('ut-expectip'),
        link, from, timeout: Number(v('ut-timeout')), slowMs: v('ut-slow') === '' ? 0 : Number(v('ut-slow')), slowCount: 3, certAlerts: ch('ut-cert'), follow: ch('ut-follow'), ignoreTls: ch('ut-ignoretls'), headers } };
  }

  // Sidebar badge: how many checks are down (every minute).
  async function badge() {
    try {
      const list = await API.get('/uptime');
      const n = list.filter(c => c.enabled && c.state && c.state.status === 'down').length;
      const el = document.getElementById('badge-observe-uptime');
      if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; el.style.background = 'var(--danger)'; el.style.color = '#fff'; }
    } catch (e) { /* signed out or offline */ }
  }
  setTimeout(badge, 4000); setInterval(badge, 60000);

  return { renderList, renderDetail, badge };
})();

Router.register('uptime', async (content, params = {}) => {
  if (params.id) await UptimePage.renderDetail(content, params.id, params.range || '24h');
  else await UptimePage.renderList(content);
  const t = setInterval(() => { if (document.body.contains(content) && !document.querySelector('.modal-overlay')) (params.id ? UptimePage.renderDetail(content, params.id, '24h') : UptimePage.renderList(content)); }, 30000);
  return () => clearInterval(t);
});
