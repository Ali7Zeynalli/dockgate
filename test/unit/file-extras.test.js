'use strict';
// Tools → Files extras: Places, log tail (local), compose check, and the editor's syntax colouring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');
const { execFileSync } = require('child_process');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dockgate-fx-'));
const ROOT = path.join(BASE, 'host');
fs.mkdirSync(path.join(ROOT, 'srv', 'app', 'logs'), { recursive: true });
fs.mkdirSync(path.join(BASE, 'outside'));
fs.writeFileSync(path.join(BASE, 'outside', 'secret.log'), 'x\n');
process.env.FILES_ROOT = ROOT;
const fx = require('../../server/file-extras');
const A = { id: 'local', s: { id: 'local' } };

test('places on Local: the shared folders; nothing outside FILES_ROOT', async () => {
  const p = await fx.places(A);
  assert.equal(p.home, ROOT);
  assert.deepEqual(p.common, [path.join(ROOT, 'srv')]);
  assert.ok(Array.isArray(p.projects));
});

test('tail on Local: the last N lines; a path outside the shared folders is refused', async () => {
  const f = path.join(ROOT, 'srv/app/logs/app.log');
  fs.writeFileSync(f, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = await fx.tail(A, f, 3);
  assert.equal(r.text, 'line 298\nline 299\nline 300');
  assert.equal((await fx.tail(A, f, 99999)).text.split('\n').length, 300, 'capped at the file');
  await assert.rejects(fx.tail(A, path.join(BASE, 'outside', 'secret.log'), 3), /outside|No such/);
  await assert.rejects(fx.tail(A, ROOT + '/srv/../../outside/secret.log', 3), /outside|No such/);
  await assert.rejects(fx.tail(A, path.join(ROOT, 'srv/app/logs'), 3), /Not a file/);
});

let hasCompose = false;
try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); hasCompose = true; } catch (e) {}
test('compose check runs docker compose config on the unsaved content', { skip: !hasCompose && 'docker compose not installed' }, async () => {
  const f = path.join(ROOT, 'srv/app/docker-compose.yml');
  const good = await fx.checkCompose(A, f, 'services:\n  web:\n    image: nginx\n');
  assert.equal(good.ok, true, good.output);
  const bad = await fx.checkCompose(A, f, 'services:\n  web:\n    image: [\n');
  assert.equal(bad.ok, false);
  assert.ok(bad.output.length > 0);
  assert.ok(!/\.dg-check-/.test(bad.output), 'the temporary file name is not shown');
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('.dg-check-')), [], 'temporary file removed');
});

test('nginx check is for remote servers only', async () => {
  assert.equal((await fx.checkNginx(A)).ok, null);
});

test('editor colouring: keys, strings, comments, numbers — and the text stays the same', () => {
  const ctx = { window: {}, escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/file-editor.js'), 'utf8'), ctx);
  const FE = ctx.window.FileEditor;
  assert.equal(FE.langOf('/srv/app/docker-compose.yml', 'docker-compose.yml'), 'yaml');
  assert.equal(FE.langOf('/etc/nginx/conf.d/site.conf', 'site.conf'), 'nginx');
  assert.equal(FE.langOf('/srv/app/.env', '.env'), 'conf');
  assert.equal(FE.langOf('/srv/app/Dockerfile', 'Dockerfile'), 'shell');
  assert.equal(FE.langOf('/srv/app/README.md', 'README.md'), null);
  const y = 'services:\n  web:\n    image: "nginx" # x <b>\n    replicas: 2';
  const h = FE.highlight(y, 'yaml');
  assert.match(h, /<span class="hl-k">services<\/span>/);
  assert.match(h, /<span class="hl-s">&quot;nginx&quot;<\/span>/);
  assert.match(h, /<span class="hl-c"># x &lt;b&gt;<\/span>/);
  assert.match(h, /<span class="hl-n">2<\/span>/);
  const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const [lang, src] of [['yaml', y], ['json', '{"a": [1, true, null, "x"]}'], ['nginx', 'server {\n  listen 80; # c\n  root $root;\n}'], ['shell', 'FROM node:22\nRUN echo "$HOME" # hi'], ['conf', '[s]\nKEY=value # c']]) {
    assert.equal(plain(FE.highlight(src, lang)), src, `${lang}: text unchanged`);
  }
});
