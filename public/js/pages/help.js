// System → Help (public/js/help.js renders the Markdown): the guide index, search and one page at a time.
Router.register('help', async (content, params = {}) => {
  const navId = Router._navId; const alive = () => Router.isActiveNav(navId);
  const e = (s) => escapeHtml(String(s == null ? '' : s));
  let idx; try { idx = await API.get('/help'); } catch (er) { content.innerHTML = UI.errorState(er); return; }
  if (!alive()) return;
  if (!idx.available) { content.innerHTML = `${UI.header('Help', 'The guide inside DockGate.')}<div class="card" style="padding:20px"><div class="ui-sub">The guide is not in this installation. Read it at <a href="https://github.com/Ali7Zeynalli/dockgate/tree/main/guide" target="_blank" rel="noopener">github.com/Ali7Zeynalli/dockgate/guide ↗</a>.</div></div>`; return; }
  const doc = params.doc || '';
  content.innerHTML = `${UI.header('Help', 'How each part of DockGate works, where to click, and what to do when something goes wrong — the same guide as in the repository, for this version.')}
    <div class="help-layout">
      <aside class="card help-index"><input class="input" data-hq placeholder="Search the guide" value="${e(params.q || '')}" style="width:100%;margin-bottom:10px">
        <a href="#/help" class="help-link ${!doc ? 'active' : ''}">Start</a>
        ${idx.groups.map(g => `<div class="help-group">${e(g.title)}</div>${g.pages.map(p => `<a href="#/help?doc=${encodeURIComponent(p.doc)}${p.anchor ? `&h=${encodeURIComponent(p.anchor)}` : ''}" class="help-link ${doc === p.doc && (!p.anchor || params.h === p.anchor) ? 'active' : ''}" title="${e(p.about)}">${e(p.title)}</a>`).join('')}`).join('')}
      </aside>
      <article class="card help-doc help-main" data-hbody><div class="ui-sub">Opening…</div></article>
    </div>`;
  const body = content.querySelector('[data-hbody]');
  const show = async () => {
    const q = content.querySelector('[data-hq]').value.trim();
    if (q.length > 1) {
      let r = []; try { r = await API.get(`/help/search?q=${encodeURIComponent(q)}`); } catch (er) { /* none */ }
      if (!alive()) return;
      body.innerHTML = `<h2 class="help-h">Search: ${e(q)}</h2>${r.length ? r.map(x => `<a class="help-hit" href="#/help?doc=${encodeURIComponent(x.doc)}${x.anchor ? `&h=${encodeURIComponent(x.anchor)}` : ''}"><b>${e(x.heading)}</b> <span class="ui-sub">· ${e(x.title)}</span><div class="ui-sub">${e(x.snippet)}</div></a>`).join('') : '<div class="ui-sub">Nothing found.</div>'}`;
      return;
    }
    if (!doc) { body.innerHTML = `<h1 class="help-h">DockGate guide</h1>${Help.render(idx.intro)}${idx.groups.map(g => `<h2 class="help-h">${e(g.title)}</h2><ul>${g.pages.map(p => `<li><a href="#/help?doc=${encodeURIComponent(p.doc)}">${e(p.title)}</a>${p.about ? ` — ${e(p.about)}` : ''}</li>`).join('')}</ul>`).join('')}`; return; }
    try {
      const d = await API.get(`/help/doc/${encodeURIComponent(doc)}`);
      if (!alive()) return;
      body.innerHTML = Help.render(d.text);
      const t = params.h && body.querySelector(`#help-${CSS.escape(params.h)}`);
      if (t) {
        // images above the heading load later and push it down: scroll again once they are in
        const above = [...body.querySelectorAll('img')].filter(im => im.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
        above.forEach(im => { im.loading = 'eager'; });
        t.scrollIntoView({ block: 'start' });
        Promise.all(above.map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))).then(() => { if (alive()) t.scrollIntoView({ block: 'start' }); });
      } else window.scrollTo(0, 0);
    } catch (er) { body.innerHTML = UI.errorState(er); }
  };
  let tmr; content.querySelector('[data-hq]').oninput = () => { clearTimeout(tmr); tmr = setTimeout(show, 250); };
  show();
});
