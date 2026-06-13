// Tabbed section wrapper — hosts several existing top-level routes as TABS inside one page, so the
// sidebar can collapse many Docker items into a few entries (Resources / Deploy / Activity) without
// rewriting each page. It invokes the existing Router handler for the active tab into a sub-container,
// manages that handler's cleanup, and bumps Router._navId on every tab switch so the previous tab's
// in-flight async / pollers self-invalidate (the same stale-render protection Router.navigate uses).
//
// renderTabbedSection(content, params, { tabs: [[routeKey,label],...], default: routeKey })
function renderTabbedSection(content, params, config) {
  const valid = config.tabs.map(t => t[0]);
  let active = (params && valid.includes(params.tab)) ? params.tab : config.default;
  content.innerHTML = `
    <div class="tab-bar" id="sec-tabs">${config.tabs.map(([k, l]) => `<button class="tab-btn ${k === active ? 'active' : ''}" data-sec="${k}">${l}</button>`).join('')}</div>
    <div id="sec-content" style="padding-top:18px"></div>`;
  const sub = content.querySelector('#sec-content');
  let subCleanup = null;

  async function show(tab) {
    // Tear down the previous tab (clears its setInterval etc.) before showing the next.
    if (subCleanup) { try { subCleanup(); } catch (e) {} subCleanup = null; }
    const handler = Router.routes[tab];
    if (!handler) { sub.innerHTML = '<div class="empty-state"><p>Not found</p></div>'; return; }
    // Bump the nav id so any in-flight async from the previous tab discards itself (isActiveNav).
    const navId = ++Router._navId;
    sub.innerHTML = '<div class="empty-state"><div class="skeleton" style="width:200px;height:24px;margin-bottom:16px"></div><div class="skeleton" style="width:300px;height:16px"></div></div>';
    try {
      const cleanup = await handler(sub, params);
      if (Router._navId !== navId) { if (typeof cleanup === 'function') { try { cleanup(); } catch (e) {} } return; } // switched again mid-load
      subCleanup = (typeof cleanup === 'function') ? cleanup : null;
    } catch (e) {
      if (Router._navId === navId) sub.innerHTML = `<div class="empty-state"><h3>Error loading tab</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  content.querySelector('#sec-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn'); if (!b) return;
    active = b.dataset.sec;
    content.querySelectorAll('#sec-tabs .tab-btn').forEach(x => x.classList.toggle('active', x.dataset.sec === active));
    Router.updateParams({ tab: active }); // deep-link the sub-tab (#/resources?tab=images)
    show(active);
  });

  show(active);
  // Wrapper cleanup (called by Router on navigating away) tears down the active sub-tab.
  return () => { if (subCleanup) { try { subCleanup(); } catch (e) {} } };
}

// The three consolidated sections. The sub-routes (containers/images/...) stay registered by their own
// page files — we just invoke their handlers here. Default tab = the most-used page in each group.
Router.register('resources', (content, params) => renderTabbedSection(content, params, {
  tabs: [['containers', 'Containers'], ['images', 'Images'], ['builds', 'Builds'], ['volumes', 'Volumes'], ['networks', 'Networks']],
  default: 'containers',
}));
Router.register('deploy', (content, params) => renderTabbedSection(content, params, {
  tabs: [['compose', 'Compose'], ['templates', 'App Templates']],
  default: 'compose',
}));
Router.register('activity', (content, params) => renderTabbedSection(content, params, {
  tabs: [['logs', 'Logs'], ['terminal', 'Terminal'], ['events', 'Events'], ['files', 'Files'], ['audit', 'Audit Log']],
  default: 'logs',
}));
