// Alert rules — Settings → Notifications (shared rules) and Server Console → Monitoring (this server's limits).
// Server rules (reachability, disk, memory, CPU) are checked by the health monitor once a minute; Docker
// rules fire on Docker events. A switch saves at once; limits and the quiet period are edited in a dialog.

const ALERT_FIELDS = { minutes: 'minutes', percent: '%', gb: 'GB' };
const ALERT_LABEL = { minutes: 'For', percent: 'Above', gb: 'Above' };

/** "When" text for a rule and its limits. */
function alertWhen(type, p) {
  p = p || {};
  switch (type) {
    case 'server_down': return `no answer for <b>${p.minutes ?? 3} min</b>`;
    case 'server_up': return 'after a "not reachable" alert';
    case 'host_disk': return `any disk above <b>${p.percent ?? 85}%</b>`;
    case 'host_mem': return `above <b>${p.percent ?? 90}%</b> for <b>${p.minutes ?? 5} min</b>`;
    case 'host_cpu': return `above <b>${p.percent ?? 90}%</b> for <b>${p.minutes ?? 10} min</b>`;
    case 'disk_threshold': return `Docker uses more than <b>${p.gb ?? 50} GB</b>`;
    default: return 'when Docker reports it';
  }
}

/** Limit inputs for a rule (in the order the "When" text reads). */
function alertLimitFields(limits, values, prefix = 'al') {
  const order = ['percent', 'gb', 'minutes'].filter(k => limits && limits[k]);
  if (!order.length) return '';
  return `<div class="ui-field"><span class="ui-label">Limit</span><div class="flex items-center gap-2" style="flex-wrap:wrap">${order.map(k => {
    const [lo, hi] = limits[k];
    return `<label class="text-sm" for="${prefix}-${k}">${ALERT_LABEL[k]}</label><input class="input" id="${prefix}-${k}" data-limit="${k}" type="number" min="${lo}" max="${hi}" value="${escapeHtml(String(values && values[k] != null ? values[k] : ''))}" style="width:90px"><span class="text-sm text-muted">${ALERT_FIELDS[k]}</span>`;
  }).join('')}</div></div>`;
}
const readLimits = (ov) => { const o = {}; ov.querySelectorAll('[data-limit]').forEach(i => { o[i.dataset.limit] = i.value; }); return o; };

async function renderAlertRules(el) {
  let rules = [];
  try { rules = await API.get('/meta/notifications/rules'); }
  catch (e) { el.innerHTML = UI.errorState(e, { compact: true, title: 'The alert rules could not be loaded' }); return; }
  const table = (list) => UI.table([{ label: 'Alert' }, { label: 'When' }, { label: 'Quiet period' }, { label: 'On' }, { label: '', align: 'right' }],
    list.map(r => ({ cells: [
      `<b>${escapeHtml(r.description || r.event_type)}</b><div class="ui-sub td-mono">${escapeHtml(r.event_type)}</div>`,
      `<span class="text-sm">${alertWhen(r.event_type, r.params)}</span>`,
      `<span class="ui-sub">${r.event_type === 'server_up' ? '—' : Number(r.cooldown_minutes) ? `${r.cooldown_minutes} min` : 'none'}</span>`,
      `<div class="toggle ${r.enabled ? 'active' : ''}" role="switch" tabindex="0" aria-checked="${!!r.enabled}" aria-label="${escapeHtml(r.description || r.event_type)}" data-rule-toggle="${escapeHtml(r.event_type)}"></div>`,
      UI.btn('Edit', `data-rule-edit="${escapeHtml(r.event_type)}"`),
    ] })), { minWidth: 680 });
  const health = rules.filter(r => r.health), docker = rules.filter(r => !r.health);
  el.innerHTML = `${UI.header('Rules', 'Which events send an alert. They apply to every server; a server can use its own limits in its console → Monitoring. Switches save at once.')}
    <div class="ui-ph" style="margin-top:4px"><div class="ui-ph-text"><div class="ui-ph-title">Server</div><div class="ui-ph-desc">Checked once a minute for every server over its existing SSH login: does it answer, how full are the disks, memory and CPU.</div></div></div>
    ${table(health)}
    <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Docker</div></div></div>
    ${table(docker)}`;

  const save = async (type, body, msg) => {
    await API.put(`/meta/notifications/rules/${encodeURIComponent(type)}`, body);
    showToast(msg);
    if (typeof edgeAgentSync === 'function') edgeAgentSync(true); // installed agents get the new rules
  };
  el.querySelectorAll('[data-rule-toggle]').forEach(t => {
    const flip = async () => {
      const on = !t.classList.contains('active');
      t.classList.toggle('active', on); t.setAttribute('aria-checked', on);
      const r = rules.find(x => x.event_type === t.dataset.ruleToggle);
      try { await save(r.event_type, { enabled: on }, `Saved · ${r.description} ${on ? 'on' : 'off'}`); }
      catch (e) { t.classList.toggle('active', !on); t.setAttribute('aria-checked', !on); showToast(e.message, 'error'); }
    };
    t.addEventListener('click', flip);
    t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  });
  el.querySelectorAll('[data-rule-edit]').forEach(b => b.addEventListener('click', () => {
    const r = rules.find(x => x.event_type === b.dataset.ruleEdit);
    const quiet = r.event_type !== 'server_up';
    UI.dialog({
      title: `Edit · ${r.description}`, context: false,
      body: `${alertLimitFields(r.limits, r.params)}
        ${quiet ? `<div class="ui-field"><label for="al-cd">Quiet period</label><div class="flex items-center gap-2"><input class="input" id="al-cd" type="number" min="0" max="1440" value="${Number(r.cooldown_minutes) || 0}" style="width:90px"><span class="text-sm text-muted">minutes</span></div><span class="ui-help">After an alert, the same alert for the same server waits this long. 0 sends every time.${r.event_type === 'server_down' ? ' "Not reachable" is sent once per outage either way.' : ''}</span></div>` : '<p class="text-sm text-muted" style="margin:0">Sent once when a server that was reported as not reachable answers again. It has nothing to set.</p>'}`,
      saveLabel: 'Save',
      onSave: async (ov) => {
        const body = {};
        if (r.limits && Object.keys(r.limits).length) body.params = readLimits(ov);
        if (quiet) body.cooldown_minutes = Number(ov.querySelector('#al-cd').value) || 0;
        if (!Object.keys(body).length) return;
        await save(r.event_type, body, `Saved · ${r.description}`);
        renderAlertRules(el);
      },
    });
  }));
}

/** Server Console → Monitoring: the server rules as they apply here, plus the shared Docker rules. */
async function renderServerAlerts(serverId, el) {
  let data, list, rules;
  try {
    [data, list, rules] = await Promise.all([API.get(`/servers/${encodeURIComponent(serverId)}/alerts`), API.get('/servers'), API.get('/meta/notifications/rules')]);
  } catch (e) { el.innerHTML = UI.errorState(e, { compact: true, title: 'Alerts could not be loaded' }); return; }
  const s = (list.servers || []).find(x => x.id === serverId) || { id: serverId };
  const muted = s.notifications_enabled === 0;
  const st = data.status, last = st && st.last;
  const now = {
    server_down: !st ? '<span class="ui-sub">first check pending</span>' : st.reachable ? UI.pill('ok', 'reachable') : UI.pill('bad', `no answer since ${formatTime(st.since)}`),
    host_disk: last && last.diskPct != null ? `<span class="ui-sub">fullest disk ${Math.round(last.diskPct)}%</span>` : '',
    host_mem: last && last.memPct != null ? `<span class="ui-sub">${Math.round(last.memPct)}%</span>` : '',
    host_cpu: last && last.cpu != null ? `<span class="ui-sub">${Math.round(last.cpu)}%</span>` : '',
  };
  const uses = (r) => !r.enabled ? UI.pill('off', 'off for all servers') : r.mode === 'off' ? UI.pill('off', 'off here') : r.mode === 'custom' ? UI.pill('info', 'own limit') : UI.pill('ok', 'shared');
  const health = data.rules.filter(r => r.event_type !== 'server_up');
  el.innerHTML = UI.header('Alerts', `Limits for ${escapeHtml(s.name || s.id)}. Shared limits come from Settings → Notifications; change one here to give this server its own.`,
      `${UI.btn(muted ? 'Turn on for this server' : 'Mute this server', 'data-mute')}${UI.btn('Edit shared rules', 'data-rules')}`) +
    (muted ? `<div class="insight-card warning" style="margin-bottom:10px"><span>Alerts are muted for this server. Checks still run; nothing is sent.</span></div>` : '') +
    UI.table([{ label: 'Alert' }, { label: 'Shared' }, { label: 'This server' }, { label: 'Uses' }, { label: 'Now' }, { label: '', align: 'right' }],
      health.map(r => ({ cells: [
        `<b>${escapeHtml(r.description)}</b>`,
        `<span class="text-sm text-muted">${alertWhen(r.event_type, r.shared)}</span>`,
        `<span class="text-sm">${r.mode === 'off' ? 'off' : alertWhen(r.event_type, r.effective.params)}</span>`,
        uses(r), now[r.event_type] || '',
        UI.btn('Edit', `data-salert="${escapeHtml(r.event_type)}"`),
      ] })), { minWidth: 760 }) +
    `<div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title">Docker</div><div class="ui-ph-desc">Shared by every server.</div></div></div>` +
    UI.table([{ label: 'Alert' }, { label: 'Status' }, { label: 'Quiet period' }], (rules || []).filter(r => !r.health).map(r => ({ cells: [
      `<b>${escapeHtml(r.description || r.event_type)}</b>`,
      muted ? UI.pill('off', 'muted for this server') : (r.enabled ? UI.pill('ok', 'On') : UI.pill('off', 'Off')),
      `<span class="ui-sub">${Number(r.cooldown_minutes) || 0} min</span>`,
    ] })), { minWidth: 520, empty: 'No alert rules.' });

  el.querySelector('[data-rules]').onclick = () => Router.navigate('settings', { tab: 'notifications' });
  el.querySelector('[data-mute]').onclick = async () => {
    try { await API.put(`/servers/${encodeURIComponent(serverId)}`, { notifications_enabled: muted ? 1 : 0 }); showToast(muted ? 'Alerts on for this server' : 'Alerts muted for this server'); renderServerAlerts(serverId, el); }
    catch (e) { showToast(e.message, 'error'); }
  };
  el.querySelectorAll('[data-salert]').forEach(b => b.addEventListener('click', () => {
    const r = data.rules.find(x => x.event_type === b.dataset.salert);
    let mode = r.mode;
    const vals = r.own || r.shared;
    UI.dialog({
      title: `${s.name || s.id} · ${r.description}`, context: false,
      body: `<div class="ui-field"><span class="ui-label">For this server</span>${UI.seg([['default', 'Shared limit'], ['custom', 'Own limit'], ['off', 'Off']], mode, 'data-amode')}</div>
        <div data-own ${mode === 'custom' ? '' : 'hidden'}>${alertLimitFields(r.limits, vals, 'sa')}</div>
        <p class="ui-sub" style="margin:0">Shared: ${alertWhen(r.event_type, r.shared)}.${r.enabled ? '' : ' This rule is off for all servers in Settings → Notifications.'}</p>`,
      onOpen: (ov) => ov.querySelectorAll('[data-amode]').forEach(x => x.addEventListener('click', () => {
        mode = x.dataset.amode;
        ov.querySelectorAll('[data-amode]').forEach(y => y.setAttribute('aria-pressed', String(y === x)));
        ov.querySelector('[data-own]').hidden = mode !== 'custom';
      })),
      onSave: async (ov) => {
        await API.put(`/servers/${encodeURIComponent(serverId)}/alerts/${encodeURIComponent(r.event_type)}`, { mode, params: mode === 'custom' ? readLimits(ov) : undefined });
        showToast(`Saved · ${r.description}`);
        renderServerAlerts(serverId, el);
      },
    });
  }));
}
