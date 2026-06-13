// Per-server console — a full-page management view for one remote server.
// Reached from Infrastructure → Servers → Manage (Router.navigate('server-console', { id })).
// Tabs: Setup (provisioning) + Monitoring / Logs / Overview (placeholders until host monitoring, PHASE 3).
Router.register('server-console', async (content, params) => {
  const id = params && params.id;
  if (!id) { content.innerHTML = '<div class="empty-state"><p>No server selected.</p><button class="btn btn-primary mt-2" onclick="Router.navigate(\'infra\',{tab:\'servers\'})">Back to Servers</button></div>'; return; }

  // Fetch the server row for the header (host / user). The list never exposes secrets.
  let server = { id };
  try { const data = await API.get('/servers'); server = (data.servers || []).find(s => s.id === id) || { id }; } catch (e) {}

  const tabs = [['setup', 'Setup'], ['monitoring', 'Monitoring'], ['logs', 'Logs'], ['overview', 'Overview']];
  const validTabs = tabs.map(t => t[0]);
  let active = (params && validTabs.includes(params.tab)) ? params.tab : 'setup';

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

  const ph = (title, desc) => `<div class="empty-state" style="padding:48px 24px;text-align:center"><h3>${title}</h3><p class="text-muted">${desc}</p><p class="text-xs text-muted" style="margin-top:8px">Bu tab host monitoring (PHASE 3) ilə gələcək.</p></div>`;
  function renderConTab(tab) {
    if (tab === 'setup') renderProvisionPanel(id, con);
    else if (tab === 'monitoring') con.innerHTML = ph('Monitoring', 'CPU / RAM / disk / load / uptime — canlı göstəricilər.');
    else if (tab === 'logs') con.innerHTML = ph('Logs', 'Host logları (journald / auth / dmesg).');
    else con.innerHTML = ph('Overview', 'Readiness + canlı gauge + Docker xülasə.');
  }
  content.querySelector('#con-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn'); if (!b) return;
    content.querySelectorAll('#con-tabs .tab-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); active = b.dataset.ctab; renderConTab(active);
    Router.updateParams({ id, tab: active }); // deep-link the sub-tab
  });
  renderConTab(active);
});
