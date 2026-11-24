// System > Help: the guide (guide/*.md, shipped in the image) read inside DockGate - the index from guide/README.md,
// one page at a time, and a search over every page by section. The Markdown is sent as text; the browser renders it.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'guide');
const NAME = /^[a-z0-9][a-z0-9-]{0,80}$/;
const err = (m, code = 400) => Object.assign(new Error(m), { statusCode: code });

/** GitHub's heading anchors: lower case, punctuation out, spaces -> dashes. */
function slug(h) {
  return String(h).toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
}
const cache = new Map(); // name -> { mtime, text }
function read(name) {
  if (name !== 'README' && !NAME.test(String(name || ''))) throw err('Not a guide page');
  const file = path.join(DIR, `${name}.md`);
  let st; try { st = fs.statSync(file); } catch (e) { throw err('Guide page not found', 404); }
  const hit = cache.get(name); if (hit && hit.mtime === st.mtimeMs) return hit.text;
  const text = fs.readFileSync(file, 'utf8'); cache.set(name, { mtime: st.mtimeMs, text }); return text;
}
const titleOf = (text, name) => ((text.match(/^#\s+(.+)$/m) || [])[1] || name).trim();
function available() { try { return fs.statSync(path.join(DIR, 'README.md')).isFile(); } catch (e) { return false; } }

/** The index: the groups and pages of guide/README.md, then pages it does not name. */
function index() {
  if (!available()) return { available: false, groups: [] };
  const text = read('README');
  const groups = []; let cur = null; const named = new Set();
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.+)$/); if (h) { cur = { title: h[1].trim(), pages: [] }; groups.push(cur); continue; }
    const m = line.match(/^\s*-\s+\[([^\]]+)\]\(([a-z0-9-]+)\.md(?:#([^)]*))?\)\s*(?:-|-)?\s*(.*)$/i);
    if (m && cur) { cur.pages.push({ title: m[1], doc: m[2], anchor: m[3] || null, about: m[4] || '' }); named.add(m[2]); }
  }
  const rest = fs.readdirSync(DIR).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => f.slice(0, -3)).filter(n => NAME.test(n) && !named.has(n));
  if (rest.length) groups.push({ title: 'More', pages: rest.map(n => ({ title: titleOf(read(n), n), doc: n, anchor: null, about: '' })) });
  return { available: true, intro: text.split(/^##\s/m)[0].replace(/^#.*\n/, '').trim(), groups: groups.filter(g => g.pages.length) };
}
function doc(name) { const text = read(name); return { doc: name, title: titleOf(text, name), text }; }

/** Search every page, section by section: [{ doc, title, heading, anchor, snippet, score }] */
function search(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 8);
  if (!words.length || !available()) return [];
  const out = [];
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.md'))) {
    const name = f.slice(0, -3); if (!NAME.test(name) && name !== 'README') continue;
    const text = read(name); const title = titleOf(text, name);
    const parts = text.split(/^(?=#{1,4}\s)/m);
    for (const part of parts) {
      const heading = ((part.match(/^#{1,4}\s+(.+)$/m) || [])[1] || title).trim();
      const low = part.toLowerCase();
      if (!words.every(w => low.includes(w))) continue;
      let score = 0; for (const w of words) { score += low.split(w).length - 1; if (heading.toLowerCase().includes(w)) score += 8; if (title.toLowerCase().includes(w)) score += 4; }
      const body = part.replace(/^#{1,4}\s+.+$/m, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[`*_>|#]/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
      const at = Math.max(0, body.toLowerCase().indexOf(words[0]) - 60);
      out.push({ doc: name === 'README' ? '' : name, title, heading, anchor: heading === title ? null : slug(heading), snippet: (at ? '...' : '') + body.slice(at, at + 200) + (body.length > at + 200 ? '...' : ''), score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 30);
}

module.exports = { index, doc, search, slug, DIR, available };
