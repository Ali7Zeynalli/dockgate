// Per-server console — a full-page management view for one remote server.
// Reached from the sidebar (Manage → Server Console) or Infrastructure → Servers → Manage.
// Tabs: Overview (recommendations) · Monitoring (graphs, processes, alerts) · Setup (components + runs) ·
// Access & SSH · Users & keys · Firewall · Fail2ban · Services (the 'manage' id is kept for old deep links) ·
// Logs (host logs) · Settings (connection, login, host key, remove).
Router.register('server-console', async (content, params) => {
  const id = params && params.id;
  if (!id) { content.innerHTML = '<div class="empty-state"><p>No server selected.</p><button class="btn btn-primary mt-2" onclick="Router.navigate(\'infra\',{tab:\'servers\'})">Back to Servers</button></div>'; return; }

  // Opening a server's console makes it the active server, so the header picker always names the server
  // on screen (and a server with an access password asks for it here, as switching in the header does).
  const navId = Router._navId;
  const activeNow = Store.get('activeServer');
  if (!activeNow || activeNow.id !== id) {
    let ok = false;
    try { ok = await useServer(id); }
    catch (e) { content.innerHTML = UI.errorState(e, { title: 'This server could not be opened' }); return; }
    if (!Router.isActiveNav(navId)) return;
    if (!ok) { showToast('Not switched — the console stays closed', 'info'); Router.navigate('infra', { tab: 'servers' }, { replace: true }); return; }
  }

  // Fetch the server row for the header (host / user). The list never exposes secrets.
  let server = { id };
  try { const data = await API.get('/servers'); server = (data.servers || []).find(s => s.id === id) || { id }; } catch (e) {}

  window.__consoleServer = { ...server, type: server.type || 'ssh' }; // confirm dialogs name THIS server
  const tabs = [['overview', 'Overview'], ['monitoring', 'Monitoring'], ['setup', 'Setup'], ['access', 'Access & SSH'], ['users', 'Users & keys'], ['firewall', 'Firewall'], ['fail2ban', 'Fail2ban'], ['manage', 'Services'], ['logs', 'Logs'], ['settings', 'Settings']];
  const validTabs = tabs.map(t => t[0]);
  let active = (params && validTabs.includes(params.tab)) ? params.tab : 'overview';

  content.innerHTML = `
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn btn-sm btn-secondary" id="con-back">← Servers</button>
        <div>
          <div class="page-title">${escapeHtml(server.id)}</div>
          <div class="page-subtitle">${server.host ? escapeHtml((server.username || '') + '@' + server.host + ':' + (server.port || 22)) : 'Server console'}</div>
        </div>
      </div>
    </div>
    <div class="tab-bar" id="con-tabs">${tabs.map(([v, l]) => `<button class="tab-btn ${v === active ? 'active' : ''}" data-ctab="${v}">${l}</button>`).join('')}</div>
    <div id="con-content" style="padding-top:18px"></div>`;

  const con = content.querySelector('#con-content');
  content.querySelector('#con-back').addEventListener('click', () => Router.navigate('infra', { tab: 'servers' }));

  const ph = (title, desc) => `<div class="empty-state" style="padding:48px 24px;text-align:center"><h3>${title}</h3><p class="text-muted">${desc}</p></div>`;
  function renderConTab(tab) {
    if (tab === 'overview') {
      con.innerHTML = '<div id="con-ov"></div><div id="con-sec" style="margin-top:16px"></div>';
      renderSecurityPosture(id, con.querySelector('#con-sec'), goTab);
      renderConsoleOverview(id, con.querySelector('#con-ov'), () => goTab('setup'));
    }
    else if (tab === 'access') renderAccessPanel(id, con);
    else if (tab === 'users') renderUsersPanel(id, con);
    else if (tab === 'firewall') renderFirewallPanel(id, con);
    else if (tab === 'fail2ban') renderFail2banPanel(id, con);
    else if (tab === 'setup') renderProvisionPanel(id, con);
    else if (tab === 'manage') renderServicesPanel(id, con); // id kept as 'manage' for old deep links
    else if (tab === 'logs') renderHostLogs(id, con);
    else if (tab === 'settings') renderServerSettings(id, con);
    else if (tab === 'monitoring') renderServerMonitoring(id, con);
    else con.innerHTML = ph('Server console', 'Pick a tab.');
  }
  function goTab(tab) {
    active = tab;
    content.querySelectorAll('#con-tabs .tab-btn').forEach(x => x.classList.toggle('active', x.dataset.ctab === tab));
    Router.updateParams({ id, tab }); // deep-link the sub-tab
    renderConTab(tab);
  }
  content.querySelector('#con-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn'); if (b) goTab(b.dataset.ctab);
  });
  renderConTab(active);
  // Arrived from "Add server" → "Create deploy user": open the wizard once, then drop the flag from the URL.
  if (params && params.wizard === '1' && typeof openDeployUserWizard === 'function') {
    Router.updateParams({ id, tab: active });
    openDeployUserWizard(id, () => Router.navigate('server-console', { id, tab: 'overview' }));
  }
});
