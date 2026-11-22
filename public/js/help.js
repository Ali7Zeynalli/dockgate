// System → Help: the guide (guide/*.md) read inside DockGate. A small Markdown renderer (headings, lists, tables,
// code, quotes, images, links — no HTML from the text is kept), the Help page (index, search, a page), and the
// "?" button on each page that opens its guide in a side panel without leaving the page.
window.Help = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const slug = (h) => String(h).toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');

  // ---- Markdown → HTML ----
  /** links: (doc, anchor) → href for a guide page; the text is escaped first, so nothing in it becomes markup. */
  function inline(text, link) {
    const codes = [];
    let s = esc(text).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
      const url = /^images\//.test(src) ? `/api/help/${src}` : /^https:\/\//.test(src) ? src : '';
      return url ? `<a href="${url}" target="_blank" rel="noopener" class="help-img"><img src="${url}" alt="${alt}" loading="lazy"></a>` : '';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const md = href.match(/^([a-z0-9-]+)\.md(?:#([\w-]+))?$/i) || href.match(/^#([\w-]+)$/) && [null, '', href.slice(1)];
      if (md) return `<a href="${link(md[1] || '', md[2] || '')}" data-help-doc="${esc(md[1] || '')}" data-help-h="${esc(md[2] || '')}">${label}</a>`;
      if (/^https?:\/\//.test(href.replace(/&amp;/g, '&'))) return `<a href="${href}" target="_blank" rel="noopener">${label} ↗</a>`;
      return label;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>').replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
  }
  function render(md, link = (d, h) => `#/help?doc=${encodeURIComponent(d)}${h ? `&h=${encodeURIComponent(h)}` : ''}`) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = []; let i = 0;
    const listBlock = (start) => { // nested lists by indent
      const items = []; const base = lines[start].match(/^(\s*)/)[1].length; let j = start;
      const ordered = /^\s*\d+\.\s/.test(lines[start]);
      while (j < lines.length) {
        const l = lines[j]; const ind = l.match(/^(\s*)/)[1].length;
        const m = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
        if (m && ind === base && /^\s*\d+\.\s/.test(l) !== ordered) break; // a list of the other kind starts
        if (m && ind === base) { items.push({ text: m[1], sub: [] }); j++; continue; }
        if (l.trim() && ind > base && items.length) { items[items.length - 1].sub.push(l); j++; continue; }
        if (!l.trim() && j + 1 < lines.length && (lines[j + 1].match(/^(\s*)/)[1].length > base || ((ordered ? /^\s*\d+\.\s/ : /^\s*[-*]\s/).test(lines[j + 1]) && lines[j + 1].match(/^(\s*)/)[1].length === base))) { j++; continue; }
        break;
      }
      const html = `<${ordered ? 'ol' : 'ul'}>${items.map(it => `<li>${inline(it.text, link)}${it.sub.length ? render(it.sub.map(x => x.slice(Math.min(base + 2, x.match(/^(\s*)/)[1].length))).join('\n'), link) : ''}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
      return { html, next: j };
    };
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^```(\w*)/))) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre class="help-code"><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
      if ((m = l.match(/^(#{1,4})\s+(.+)$/))) { const n = m[1].length; out.push(`<h${n} id="help-${slug(m[2])}" class="help-h">${inline(m[2], link)}</h${n}>`); i++; continue; }
      if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote class="help-quote">${render(buf.join('\n'), link)}</blockquote>`); continue; }
      if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="help-table"><table><thead><tr>${head.map(h => `<th>${inline(h, link)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*(?:[-*]|\d+\.)\s+/.test(l)) { const b = listBlock(i); out.push(b.html); i = b.next; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*\||\s*(?:[-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++].trim());
      out.push(`<p>${inline(buf.join(' '), link)}</p>`);
    }
    return out.join('\n');
  }

  // ---- which guide page belongs to which part of DockGate ----
  const MAP = {
    dashboard: 'dashboard-and-monitoring', monitoring: 'dashboard-and-monitoring',
    containers: 'containers', container: 'containers', images: 'images', volumes: 'volumes', networks: 'networks', builds: 'builds', prune: 'prune',
    compose: 'compose', templates: 'templates-and-registries', tasks: 'tasks', registries: 'templates-and-registries',
    'swarm-overview': 'swarm-setup-and-nodes', 'swarm-nodes': 'swarm-setup-and-nodes', 'swarm-services': 'swarm-services', 'swarm-stacks': 'swarm-stacks-and-migrate', 'swarm-migrate': 'swarm-stacks-and-migrate',
    'swarm-scaling': 'swarm-auto-scaling', 'swarm-secrets': 'swarm-secrets-and-networks', 'swarm-networks': 'swarm-secrets-and-networks', 'swarm-firewall': 'swarm-firewall', 'swarm-settings': 'swarm-cluster',
    logs: 'observe', events: 'observe', uptime: 'observe', audit: 'observe', 'notification-log': 'observe', proxies: 'proxies',
    databases: 'tools#databases', terminal: 'tools', files: 'tools', schedules: 'tools',
    servers: 'servers', sshkeys: 'servers', agent: 'servers', general: 'settings', security: 'settings', notifications: 'settings', update: 'settings',
  };
  const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0] || 'dashboard');
  function docFor(r = route()) { const v = MAP[r] || (r.startsWith('srv-') ? 'server-console' : null); if (!v) return null; const [doc, h] = v.split('#'); return { doc, h: h || '' }; }

  // ---- the side panel ----
  let panel = null;
  async function open(doc, h) {
    if (!panel) {
      panel = document.createElement('div'); panel.className = 'help-panel';
      panel.innerHTML = '<div class="help-panel-head"><b data-hp-title>Guide</b><span style="flex:1"></span><a class="btn btn-xs btn-secondary" data-hp-full>Open in Help</a><button type="button" class="btn-icon" data-hp-close title="Close (Esc)">✕</button></div><div class="help-panel-body help-doc" data-hp-body></div>';
      document.body.appendChild(panel);
      panel.querySelector('[data-hp-close]').onclick = close;
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && panel.classList.contains('open')) close(); });
    }
    panel.classList.add('open');
    const body = panel.querySelector('[data-hp-body]'); body.innerHTML = '<div class="ui-sub">Opening…</div>';
    panel.querySelector('[data-hp-full]').href = `#/help?doc=${encodeURIComponent(doc)}${h ? `&h=${encodeURIComponent(h)}` : ''}`;
    panel.querySelector('[data-hp-full]').onclick = () => close();
    try {
      const d = await API.get(`/help/doc/${encodeURIComponent(doc)}`);
      panel.querySelector('[data-hp-title]').textContent = d.title;
      body.innerHTML = render(d.text, (dd, hh) => `#/help?doc=${encodeURIComponent(dd || doc)}${hh ? `&h=${encodeURIComponent(hh)}` : ''}`);
      body.querySelectorAll('[data-help-doc]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); open(a.dataset.helpDoc || doc, a.dataset.helpH); });
      const t = h && body.querySelector(`#help-${CSS.escape(h)}`); body.scrollTop = t ? t.offsetTop - 8 : 0;
      if (t) { const above = [...body.querySelectorAll('img')].filter(im => im.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); above.forEach(im => { im.loading = 'eager'; }); Promise.all(above.map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))).then(() => { body.scrollTop = t.offsetTop - 8; }); }
    } catch (er) { body.innerHTML = `<div class="ui-sub">${esc(er.message)}</div>`; }
  }
  function close() { if (panel) panel.classList.remove('open'); }
  /** The "?" button for a page header (nothing when the page has no guide). */
  function button() { const d = docFor(); return d ? `<button type="button" class="btn btn-xs btn-ghost help-q" data-help-q="${esc(d.doc)}" data-help-qh="${esc(d.h)}" title="What this page does (guide)">?</button>` : ''; }
  document.addEventListener('click', (ev) => { const b = ev.target.closest && ev.target.closest('[data-help-q]'); if (b) { ev.preventDefault(); open(b.dataset.helpQ, b.dataset.helpQh); } });

  return { render, docFor, open, close, button, slug, MAP };
})();
