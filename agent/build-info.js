// The agent's version and build id: a hash of the files that make up the image. DockGate (server/agent/deployer.js)
// and CI (.github/workflows/docker-publish.yml) both use it, so the image CI publishes has exactly the tag DockGate
// asks for. Run directly it prints "<version>-<build>".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function buildInfo(dir = __dirname) {
  const h = crypto.createHash('sha256');
  const files = ['package.json', 'package-lock.json', 'Dockerfile'].map(f => path.join(dir, f))
    .concat(fs.readdirSync(path.join(dir, 'src')).filter(f => f.endsWith('.js')).sort().map(f => path.join(dir, 'src', f)));
  for (const f of files) { if (!fs.existsSync(f)) continue; h.update(path.relative(dir, f) + '\0'); h.update(fs.readFileSync(f)); h.update('\0'); }
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || version; } catch (e) { /* keep 0.0.0 */ }
  return { version, build: h.digest('hex').slice(0, 10) };
}

module.exports = { buildInfo };
if (require.main === module) { const i = buildInfo(); process.stdout.write(`${i.version}-${i.build}\n`); }
