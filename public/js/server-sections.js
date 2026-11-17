// The SERVER group of the sidebar: what was one "Server Console" page with 13 tabs is five sections — Status,
// Security, System, Software, Automation — each working on the server picked in the top bar (as the Docker
// pages do). Their tabs reuse the console panels as they were. Old links (#/server-console?id=…&tab=…) switch
// to that server and open the tab's new place.
const SRV_ICONS = {
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5z"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
  software: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/></svg>',
  automation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  databases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  uptime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
};

// old console tab → [section, tab]
const SRV_OLD_TABS = {
  overview: ['srv-status', 'srv-overview'], monitoring: ['srv-status', 'srv-monitoring'], logs: ['srv-status', 'srv-logs'], settings: ['srv-status', 'srv-connection'],
  access: ['srv-security', 'srv-access'], users: ['srv-security', 'srv-users'], firewall: ['srv-security', 'srv-firewall'], fail2ban: ['srv-security', 'srv-fail2ban'],
  system: ['srv-system', 'srv-names'], setup: ['srv-software', 'srv-setup'], manage: ['srv-software', 'srv-services'], docker: ['srv-software', 'srv-docker'],
  cron: ['srv-automation', 'srv-cron'], scripts: ['srv-automation', 'srv-scripts'],
};
/** Open a server page by its old console tab name or its new tab name (used by the panels' "open …" links). */
function srvGo(tab, extra = {}) {
  const hit = SRV_OLD_TABS[tab] || (typeof navItems !== 'undefined' ? Object.entries(navItems).filter(([k]) => k.startsWith('srv-')).map(([k, v]) => (v.tabs.some(([t]) => t === tab) ? [k, tab] : null)).find(Boolean) : null);
  if (hit) Router.navigate(hit[0], { tab: hit[1], ...extra });
}

const srvActive = () => { const a = (typeof Store !== 'undefined' && Store.get('activeServer')) || {}; return { ...a, remote: !!a.id && a.id !== 'local' && a.type !== 'local' }; };
/** A server page: the server in use (an SSH server unless anyServer), a line naming it, then the panel. */
async function srvEnsureActive() { // the store may not have the server in use yet right after a page load
  if (srvActive().id) return;
  try { const d = await API.get('/servers'); const a = (d.servers || []).find(x => x.isActive) || (d.servers || []).find(x => x.id === 'local'); if (a && !srvActive().id) Store.set('activeServer', a); } catch (e) { /* the page says it */ }
}
function srvPage(render, { anyServer = false } = {}) {
  return async (content, params) => {
    await srvEnsureActive();
    const a = srvActive();
    if (!anyServer && !a.remote) {
      let list = [];
      try { list = ((await API.get('/servers')).servers || []).filter(s => s.type !== 'local'); } catch (e) { /* the message alone */ }
      content.innerHTML = `<div class="card" style="padding:24px;max-width:680px"><b>This page works on a server reached over SSH.</b>
        <div class="ui-sub" style="margin-top:6px">The top bar shows <b>${escapeHtml(a.name || 'Local')}</b>. ${list.length ? 'Pick a server:' : 'Add one in Servers → Add server.'}</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${list.map(s => UI.btn(escapeHtml(s.name || s.id), `data-srv-use="${escapeHtml(s.id)}"`, 'btn-primary')).join('')} ${UI.btn('Servers', 'data-srv-list')}</div></div>`;
      content.querySelectorAll('[data-srv-use]').forEach(b => b.onclick = async () => { try { if (await useServer(b.dataset.srvUse)) Router.navigate(Store.get('currentPage'), Store.get('currentParams') || {}); } catch (e) { showToast(e.message, 'error'); } });
      content.querySelector('[data-srv-list]').onclick = () => Router.navigate('infra', { tab: 'servers' });
      return;
    }
    window.__consoleServer = { ...a, type: a.type || 'ssh' }; // confirm dialogs name this server
    content.innerHTML = `${a.remote ? `<div class="ui-sub" style="margin:-4px 0 12px;display:flex;gap:8px;align-items:center">${SRV_ICONS.status.replace('<svg ', '<svg width="13" height="13" ')}<b style="color:var(--text-primary)">${escapeHtml(a.name || a.id)}</b><span class="td-mono">${escapeHtml(`${a.username || ''}@${a.host || ''}:${a.port || 22}`)}</span></div>` : ''}<div data-srv-body></div>`;
    return render(a.id, content.querySelector('[data-srv-body]'), params || {});
  };
}

// one system service on its own tab (Docker engine, Time sync, Auto updates): state bar, settings, config, log
function srvServiceTab(item, title, desc) {
  return srvPage(async (id, el) => {
    el.innerHTML = `${UI.header(title, desc)}<div data-bar style="margin-bottom:14px"></div><div data-page></div>`;
    const reload = () => Router.navigate(Store.get('currentPage'), Store.get('currentParams') || {});
    renderServiceBar(id, item, el.querySelector('[data-bar]'), { onChange: reload });
    renderServicePage(id, item, el.querySelector('[data-page]'));
  });
}
// one section of a panel that shows several (System, Cron): the panel draws all, the others are hidden
const srvSection = (fn, section) => srvPage((id, el) => { el.dataset.only = section; return fn(id, el); });

const SRV_PAGES = {
  'srv-overview': srvPage((id, el, params) => {
    el.innerHTML = '<div data-ov></div><div data-sec style="margin-top:16px"></div>';
    renderSecurityPosture(id, el.querySelector('[data-sec]'), (tab) => srvGo(tab));
    renderConsoleOverview(id, el.querySelector('[data-ov]'), () => srvGo('setup'));
    if (params.wizard === '1' && typeof openDeployUserWizard === 'function') {
      Router.updateParams({ tab: 'srv-overview' });
      openDeployUserWizard(id, () => srvGo('srv-overview'));
    }
  }),
  'srv-monitoring': srvPage((id, el) => renderServerMonitoring(id, el)),
  'srv-alerts': srvPage((id, el) => { el.innerHTML = '<div data-al></div>'; return renderServerAlerts(id, el.querySelector('[data-al]')); }),
  'srv-logs': srvPage((id, el) => renderHostLogs(id, el)),
  'srv-sysinfo': srvPage((id, el) => renderSystemInfo(el), { anyServer: true }),
  'srv-connection': srvPage((id, el) => renderServerSettings(id, el)),
  'srv-access': srvPage((id, el) => renderAccessPanel(id, el)),
  'srv-users': srvPage((id, el) => renderUsersPanel(id, el)),
  'srv-firewall': srvPage((id, el) => renderFirewallPanel(id, el)),
  'srv-fail2ban': srvPage((id, el) => renderFail2banPanel(id, el)),
  'srv-names': srvSection((id, el) => renderSystemPanel(id, el), 'Name and addresses'),
  'srv-network': srvSection((id, el) => renderSystemPanel(id, el), 'Network'),
  'srv-time': srvServiceTab('timesync', 'Time sync', 'Keeps the server\'s clock right (chrony): NTP sources and how far off the clock is.'),
  'srv-disks': srvSection((id, el) => renderSystemPanel(id, el), 'Disks'),
  'srv-kernel': srvSection((id, el) => renderSystemPanel(id, el), 'Kernel and limits'),
  'srv-configs': srvSection((id, el) => renderSystemPanel(id, el), 'Config files'),
  'srv-setup': srvPage((id, el) => renderProvisionPanel(id, el)),
  'srv-services': srvPage((id, el) => renderServicesPanel(id, el)),
  'srv-docker': srvServiceTab('docker', 'Docker engine', 'The container engine on this server: log size limits, live-restore and the daemon\'s state.'),
  'srv-updates': srvServiceTab('unattended-upgrades', 'Auto updates', 'Security updates installed by themselves, and when the server may restart for them.'),
  'srv-cron': srvSection((id, el) => renderCronPanel(id, el), 'cron'),
  'srv-timers': srvSection((id, el) => renderCronPanel(id, el), 'timers'),
  'srv-scripts': srvPage((id, el) => renderScriptsPanel(id, el)),
};
Object.entries(SRV_PAGES).forEach(([k, fn]) => Router.register(k, fn));

// Old #/server-console?id=…&tab=… links (bookmarks, other pages): use that server, open the tab's new place.
Router.register('server-console', async (content, params = {}) => {
  const navId = Router._navId;
  if (params.id && srvActive().id !== params.id) {
    let ok = false;
    try { ok = await useServer(params.id); } catch (e) { content.innerHTML = UI.errorState(e, { title: 'This server could not be opened' }); return; }
    if (!Router.isActiveNav(navId)) return;
    if (!ok) { showToast('Not switched', 'info'); Router.navigate('infra', { tab: 'servers' }, { replace: true }); return; }
  }
  const [sec, tab] = SRV_OLD_TABS[params.tab] || SRV_OLD_TABS.overview;
  Router.navigate(sec, { tab, ...(params.wizard ? { wizard: params.wizard } : {}) }, { replace: true });
});
