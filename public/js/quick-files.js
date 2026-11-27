// Quick Files - the file browser (file-browser.js) in a window over any page, like Quick Terminal.
// Header button "Files" or Ctrl+Shift+F. z-index 950: dialogs (.modal-overlay, 1000) and the editor (1200) open above it. Minimize keeps the folder and the open editor; it follows the server
// picked in the header and remembers the last folder per server.
// QuickFiles.open(path?) - also for "Open folder" links elsewhere.
window.QuickFiles = (() => {
  let ov = null, fb = null, state = 'closed', serverId = null; // closed | open | min
  const KEY = 'dg_qf_path_';
  const lastPath = (id) => { try { return localStorage.getItem(KEY + id) || ''; } catch (e) { return ''; } };
  const keepPath = (id, p) => { try { localStorage.setItem(KEY + id, p); } catch (e) {} };
  const activeId = () => (Store.get('activeServer') || {}).id || 'local';

  function build() {
    ov = document.createElement('div');
    ov.id = 'quick-files';
    ov.style.cssText = 'position:fixed;inset:0;z-index:950;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `<div class="card" data-qf-win style="width:min(1200px,96vw);height:min(820px,90vh);display:flex;flex-direction:column;padding:0;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">
        <strong style="flex:1">📁 Quick Files <span class="ui-sub" data-qf-srv></span></strong>
        <button class="btn btn-xs btn-ghost" data-qf-page title="Open Tools > Files">Open page</button>
        <button class="btn btn-xs btn-ghost" data-qf-max title="Maximize">⤢</button>
        <button class="btn btn-xs btn-ghost" data-qf-min title="Minimize (Esc) - keeps the folder">-</button>
        <button class="btn btn-xs btn-ghost" data-qf-close title="Close">×</button>
      </div>
      <div data-qf-body style="flex:1;min-height:0;overflow:auto;padding:12px 14px"></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) minimize(); });
    ov.querySelector('[data-qf-min]').onclick = minimize;
    ov.querySelector('[data-qf-close]').onclick = close;
    ov.querySelector('[data-qf-page]').onclick = () => { minimize(); Router.navigate('files'); };
    ov.querySelector('[data-qf-max]').onclick = () => {
      const w = ov.querySelector('[data-qf-win]'), big = w.dataset.big !== '1';
      w.dataset.big = big ? '1' : '';
      w.style.width = big ? '100vw' : 'min(1200px,96vw)'; w.style.height = big ? '100vh' : 'min(820px,90vh)';
      ov.style.padding = big ? '0' : '20px';
    };
  }

  async function mountFor(id, path) {
    if (fb) { fb.destroy(); fb = null; }
    serverId = id;
    const srv = Store.get('activeServer') || {};
    ov.querySelector('[data-qf-srv]').textContent = `- ${srv.name || srv.label || id}`;
    const body = ov.querySelector('[data-qf-body]');
    body.innerHTML = '';
    const el = document.createElement('div'); body.appendChild(el);
    fb = await FileBrowser.mount(el, { compact: true, startPath: path || lastPath(id) || '/', onCwd: (p) => keepPath(id, p) });
  }

  async function open(path) {
    if (!ov) build();
    ov.style.display = 'flex'; state = 'open'; badge();
    const id = activeId();
    if (!fb || id !== serverId) await mountFor(id, path);
    else if (path) fb.go(path);
  }
  function minimize() { if (!ov) return; ov.style.display = 'none'; state = 'min'; badge(); }
  function close() { if (fb) { fb.destroy(); fb = null; } if (ov) { ov.remove(); ov = null; } state = 'closed'; serverId = null; badge(); }
  function toggle() { state === 'open' ? minimize() : open(); }
  function badge() {
    const b = document.getElementById('btn-quick-files'); if (!b) return;
    b.classList.toggle('active', state === 'open');
    b.title = state === 'min' ? 'Quick Files - minimized, click to show (Ctrl+Shift+F)' : 'Quick Files (Ctrl+Shift+F)';
    const dot = b.querySelector('[data-qf-dot]'); if (dot) dot.style.display = state === 'min' ? '' : 'none';
  }

  function init() {
    document.getElementById('btn-quick-files')?.addEventListener('click', toggle);
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggle(); return; }
      if (e.key === 'Escape' && state === 'open' && !e.defaultPrevented && !document.querySelector('.modal-overlay')) minimize();
    });
    // Another server picked in the header: show its files (when the window is open), else on the next open.
    Store.on('activeServer', (s) => { if (state === 'open' && s && s.id !== serverId) mountFor(s.id); });
  }
  return { init, open, close, minimize };
})();
