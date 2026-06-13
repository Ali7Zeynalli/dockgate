// Per-server console — a full-page management view for one remote server.
// Reached from the sidebar (Manage → Server Console) or Infrastructure → Servers → Manage.
// Tabs: Overview (readiness + live host metrics) · Setup (provisioning) · Manage (service control) · Logs (host logs).
Router.register('server-console', async (content, params) => {
  const id = params && params.id;
  if (!id) { content.innerHTML = '<div class="empty-state"><p>No server selected.</p><button class="btn btn-primary mt-2" onclick="Router.navigate(\'infra\',{tab:\'servers\'})">Back to Servers</button></div>'; return; }

  // Fetch the server row for the header (host / user). The list never exposes secrets.
  let server = { id };
  try { const data = await API.get('/servers'); server = (data.servers || []).find(s => s.id === id) || { id }; } catch (e) {}

  const tabs = [['overview', 'Overview'], ['setup', 'Setup'], ['manage', 'Manage'], ['logs', 'Logs']];
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
    if (tab === 'overview') renderConsoleOverview(id, con, () => goTab('setup'));
    else if (tab === 'setup') renderProvisionPanel(id, con);
    else if (tab === 'manage') renderServiceManager(id, con);
    else if (tab === 'logs') renderHostLogs(id, con);
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
});
