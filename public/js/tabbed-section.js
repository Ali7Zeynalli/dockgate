// Tabbed section wrapper — hosts several existing routes as the pages of one section (Resources, Deploy,
// Observe, Tools). The sidebar lists the pages, so there is no second tab bar on the page itself. It invokes
// the existing Router handler for the active page into a sub-container, manages that handler's cleanup, and
// bumps Router._navId so the previous page's in-flight async / pollers self-invalidate.
//
// renderTabbedSection(content, params, { tabs: [[routeKey,label],...], default: routeKey })
function renderTabbedSection(content, params, config) {
  const valid = config.tabs.map(t => t[0]);
  let active = (params && valid.includes(params.tab)) ? params.tab : config.default;
  content.innerHTML = `<div id="sec-content"></div>`;
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
      if (Router._navId === navId) sub.innerHTML = UI.errorState(e);
    }
  }

  show(active);
  // Wrapper cleanup (called by Router on navigating away) tears down the active sub-tab.
  return () => { if (subCleanup) { try { subCleanup(); } catch (e) {} } };
}

// The sections are defined once, in navItems (app.js): the same list drives the sidebar and these pages.
['resources', 'deploy', 'observe', 'tools'].forEach(key => Router.register(key, (content, params) => {
  const item = navItems[key];
  return renderTabbedSection(content, params, { tabs: item.tabs, default: item.default });
}));
// Old #/activity links: Router.resolve sends them to Observe, Tools or Resources → Prune. The route stays
// registered so a stale link still reaches resolve.
Router.register('activity', (content, params) => Router.navigate('activity', params, { replace: true }));
