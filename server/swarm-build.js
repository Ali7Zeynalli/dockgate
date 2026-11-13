// Build & push for Swarm: a service with `build:` runs on several servers only from an image in a registry. DockGate
// builds it with Compose (the project's own build settings), tags it <registry>/<project>-<service>:<time> and pushes
// it with the login stored in Deploy → Registries; the stack then uses that tag. The compose files are not changed.
// On every Redeploy from the compose files it builds and pushes again, so the servers run what the files say now.
const dockerService = require('./docker');
const { stmts } = require('./db');
const bad = (code, m) => Object.assign(new Error(m), { statusCode: code });

const DOCKER_HUB = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'https://index.docker.io/v1/'];
/** The repository a service is pushed to, in this registry. */
function repoFor(registry, project, service) {
  const name = `${project}-${service}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const host = String(registry.server_address || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (DOCKER_HUB.includes(registry.server_address) || DOCKER_HUB.includes(host)) return `${String(registry.username).toLowerCase()}/${name}`;
  return `${host}/${name}`;
}
const tagNow = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261113-101530

function registryById(id) {
  const r = stmts.getRegistry.get(Number(id));
  if (!r) throw bad(404, 'That registry login is no longer in Deploy → Registries');
  return r;
}

/** Build one service with Compose, tag it for the registry and push it. Returns the pushed image reference. */
async function buildAndPush({ project, service, cfgService, r, registry, tag = tagNow(), log = () => {} }) {
  const h = require('./routes/compose').composeHelpers;
  log(`$ docker compose build ${service}`);
  await h.runResolved(r, project, ['build', service], (c) => String(c).split('\n').filter(Boolean).forEach(l => log('  ' + l)));
  const built = (cfgService && cfgService.image) || `${project}-${service}`;
  const repo = repoFor(registry, project, service);
  await dockerService.docker.getImage(built).tag({ repo, tag });
  log(`  tagged ${built} as ${repo}:${tag}`);
  log(`$ docker push ${repo}:${tag}`);
  await dockerService.pushImage(`${repo}:${tag}`);
  log(`  pushed ${repo}:${tag}`);
  return `${repo}:${tag}`;
}

/** Build and push every `build:` service of a config that the stack contains. Returns { service: image }. */
async function buildAll({ project, cfg, r, registryId, only = null, log = () => {} }) {
  const registry = registryById(registryId);
  const tag = tagNow();
  const images = {};
  for (const [name, s] of Object.entries(cfg.services || {})) {
    if (!s.build || (only && !only.includes(name))) continue;
    images[name] = await buildAndPush({ project, service: name, cfgService: s, r, registry, tag, log });
  }
  return images;
}

module.exports = { repoFor, tagNow, registryById, buildAndPush, buildAll };
