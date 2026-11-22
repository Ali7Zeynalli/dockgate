'use strict';
// System → Help: the guide index, search and pages (server/help.js), and the Markdown renderer (public/js/help.js) —
// nothing in a guide page becomes HTML, links to other pages stay inside DockGate, images come from the guide.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('../../server/help');

test('index follows guide/README.md; every page it names exists', () => {
  const i = H.index();
  assert.equal(i.available, true);
  assert.ok(i.groups.length >= 5);
  for (const g of i.groups) for (const p of g.pages) assert.ok(fs.existsSync(path.join(H.DIR, `${p.doc}.md`)), `${p.doc}.md exists`);
  assert.ok(i.groups.some(g => g.pages.some(p => p.doc === 'proxies')));
});

test('a page by name only; no way out of the guide folder', () => {
  assert.match(H.doc('proxies').title, /Proxies/);
  for (const bad of ['../package', '..%2fserver', 'proxies.md', '', 'a/b']) assert.throws(() => H.doc(bad), /Not a guide page|not found/);
  assert.throws(() => H.doc('no-such-page'), /not found/);
});

test('search finds sections, best first, with their anchor', () => {
  const r = H.search('reload hook certbot');
  assert.ok(r.length); assert.equal(r[0].doc, 'proxies'); assert.ok(r[0].anchor); assert.ok(r[0].snippet.length > 10);
  assert.deepEqual(H.search('x'), []);
});

test('every image a guide page shows is in guide/images', () => {
  for (const f of fs.readdirSync(H.DIR).filter(x => x.endsWith('.md'))) {
    for (const m of fs.readFileSync(path.join(H.DIR, f), 'utf8').matchAll(/!\[[^\]]*\]\((images\/[^)\s]+)\)/g)) assert.ok(fs.existsSync(path.join(H.DIR, m[1])), `${f}: ${m[1]}`);
  }
});

test('the renderer: headings with anchors, lists, tables, code, quotes, links and images — HTML in the text stays text', () => {
  const ctx = { window: {}, document: { addEventListener() {} }, location: { hash: '#/proxies' }, CSS: { escape: (s) => s }, API: {}, console };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/help.js'), 'utf8'), ctx);
  const Help = ctx.window.Help;
  const html = Help.render([
    '# Title', '', 'Text with **bold**, `code <b>`, a [page](compose.md#deploy-from-git) and [site](https://example.com).', '',
    '<script>alert(1)</script>', '', '- one', '  - nested', '- two', '', '1. first', '2. second', '',
    '| A | B |', '|---|---|', '| x | `y` |', '', '> **Where:** here', '', '```bash', 'echo <hi>', '```', '', '![Shot](images/proxies-sites.png)', '', '## Who renews what'].join('\n'));
  assert.match(html, /<h1 id="help-title"/); assert.match(html, /<h2 id="help-who-renews-what"/);
  assert.match(html, /<b>bold<\/b>/); assert.match(html, /<code>code &lt;b&gt;<\/code>/);
  assert.match(html, /href="#\/help\?doc=compose&h=deploy-from-git"/); assert.match(html, /href="https:\/\/example\.com" target="_blank"/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<th>A<\/th>/); assert.match(html, /<td><code>y<\/code><\/td>/);
  assert.match(html, /<blockquote class="help-quote"><p><b>Where:<\/b> here<\/p><\/blockquote>/);
  assert.match(html, /<pre class="help-code"><code>echo &lt;hi&gt;<\/code><\/pre>/);
  assert.match(html, /<img src="\/api\/help\/images\/proxies-sites\.png"/);
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '![i](http://evil.example/x.png)']) { const h = Help.render(bad); assert.doesNotMatch(h, /href=|src=/, bad); }
  assert.equal(JSON.stringify(Help.docFor('srv-firewall')), JSON.stringify({ doc: 'server-console', h: '' })); // objects from the vm context
  assert.equal(JSON.stringify(Help.docFor('databases')), JSON.stringify({ doc: 'tools', h: 'databases' }));
  assert.equal(Help.docFor('help'), null);
});
