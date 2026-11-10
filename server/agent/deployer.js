// Edge Observability Agent deployer. Pushes the outbound-only agent container onto a managed host
// over a PER-HOST dockerode client (createSshClient) — never via setActiveServer, which would mutate
// the module-global active daemon that the rest of the app shares. Channel creds are read from the
// global smtp_config + the per-server override (server_channels), decrypted, and injected as env.
// When an agent is installed/started on a host, the central EventMonitor for that host is stopped
// (double-send guard); on remove/stop it is restarted.

const crypto = require('crypto');
const path = require('path');
const { stmts, db } = require('../db');
const { createSshClient, createLocalClient } = require('../docker');
const { decrypt } = require('../auth/secrets');
const telegram = require('../notifications/telegram');
const mailer = require('../notifications/mailer');
const monitorManager = require('../notifications/monitor-manager');

const fs = require('fs');

// The agent image is built from the agent/ folder that ships inside DockGate. Its tag carries the agent's version
// and a hash of its code, so any change to the agent gives a new tag: "Update" then really ships new code, and
// DockGate can tell which servers run an older build. (Before, the tag was a fixed dockgate/agent:1.0.0: Update
// re-shipped the image built at the first install, and tried to pull that name from Docker Hub first.)
// AGENT_IMAGE (env) pins one ready image from a registry you trust instead.
const AGENT_DIR = path.join(__dirname, '..', '..', 'agent');
const agentBuildInfo = (dir = AGENT_DIR) => require('../../agent/build-info').buildInfo(dir);
const { version: AGENT_VERSION, build: AGENT_BUILD } = agentBuildInfo();
const REGISTRY_IMAGE = process.env.AGENT_IMAGE || '';
// CI publishes this exact tag for amd64 and arm64 (one multi-arch image): a server pulls it and Docker picks the
// variant for its CPU. AGENT_REPOSITORY points to another registry; AGENT_PULL=0 never pulls (build / copy only).
const IMAGE_REPO = (process.env.AGENT_REPOSITORY || 'ghcr.io/ali7zeynalli/dockgate-agent').toLowerCase();
const PULL_PUBLISHED = process.env.AGENT_PULL !== '0';
const IMAGE_REF = REGISTRY_IMAGE || `${IMAGE_REPO}:${AGENT_VERSION}-${AGENT_BUILD}`;
const AGENT_NAME = 'dockgate-agent';
const LABEL_FILTER = ['dockgate.role=agent'];
// Agent images DockGate made earlier (old fixed tag, or an older build): removed after an update.
const isOldAgentTag = (t) => t !== IMAGE_REF && (t.startsWith(IMAGE_REPO + ':') || t.startsWith('dockgate-agent:') || t.startsWith('dockgate/agent:'));

// ---- channel resolution (global smtp_config, overridden per-server) ----

function resolveChannels(serverId) {
  const g = mailer.getSmtpSettings();          // global SMTP, smtp_pass already decrypted
  const gt = telegram.getTelegramSettings();   // global Telegram, token already decrypted
  const ov = stmts.getServerChannel.get(serverId) || {};
  const pick = (o, gv) => (o !== undefined && o !== null && o !== '') ? o : gv;
  return {
    tg: {
      token: pick(ov.tg_token ? decrypt(ov.tg_token) : '', gt.token),
      chatId: pick(ov.tg_chat_id, gt.chatId),
    },
    smtp: {
      host: pick(ov.smtp_host, g.smtp_host),
      port: pick(ov.smtp_port, g.smtp_port),
      user: pick(ov.smtp_user, g.smtp_user),
      pass: pick(ov.smtp_pass ? decrypt(ov.smtp_pass) : '', g.smtp_pass),
      from: pick(ov.smtp_from, g.smtp_from),
      to: pick(ov.smtp_to, g.smtp_to),
    },
  };
}

function buildEnv(serverId) {
  const { tg, smtp } = resolveChannels(serverId);
  const rulesRows = db.prepare('SELECT event_type, enabled, cooldown_minutes FROM notification_rules').all();
  const rules = {};
  for (const r of rulesRows) rules[r.event_type] = { enabled: !!r.enabled, cooldown_minutes: r.cooldown_minutes };
  const tz = stmts.getSetting.get('timezone')?.value || 'auto';
  // The agent watches Docker's disk use with the same limit as the "Docker uses a lot of disk space" rule.
  let diskGb = stmts.getSetting.get('disk_threshold_gb')?.value;
  try { const r = stmts.getRule.get('disk_threshold'); const gb = r && JSON.parse(r.params || '{}').gb; if (gb) diskGb = String(gb); } catch (e) { /* keep the setting */ }

  const env = [
    `SERVER_LABEL=${serverId}`,
    `TIMEZONE=${tz}`,
    `RULES_JSON=${JSON.stringify(rules)}`,
  ];
  if (diskGb) env.push(`DISK_THRESHOLD_GB=${diskGb}`);
  if (tg.token && tg.chatId) env.push(`TG_TOKEN=${tg.token}`, `TG_CHAT_ID=${tg.chatId}`);
  if (smtp.host && smtp.port && smtp.from && smtp.to) {
    env.push(`SMTP_HOST=${smtp.host}`, `SMTP_PORT=${smtp.port}`, `SMTP_FROM=${smtp.from}`, `SMTP_TO=${smtp.to}`);
    if (smtp.user) env.push(`SMTP_USER=${smtp.user}`);
    if (smtp.pass) env.push(`SMTP_PASS=${smtp.pass}`);
  }
  return env;
}

function envHasChannel(env) {
  return env.some(e => e.startsWith('TG_TOKEN=')) || env.some(e => e.startsWith('SMTP_HOST='));
}

function containerSpec(env, image = IMAGE_REF, labels = { version: AGENT_VERSION, build: REGISTRY_IMAGE ? '' : AGENT_BUILD }) {
  return {
    Image: image,
    name: AGENT_NAME,
    Env: env,
    Labels: { 'dockgate.role': 'agent', 'dockgate.version': labels.version || '', 'dockgate.build': labels.build || '' },
    HostConfig: {
      Binds: [
        '/var/run/docker.sock:/var/run/docker.sock:ro',
        '/proc:/host/proc:ro',
        '/sys:/host/sys:ro',
        '/var/log:/host/var/log:ro',
      ],
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 96 * 1024 * 1024,   // 96 MB
      NanoCpus: 250000000,        // 0.25 CPU
      SecurityOpt: ['no-new-privileges'],
      // NO PortBindings — outbound-only
    },
  };
}

// ---- per-host client ----

function clientFor(serverId) {
  if (serverId === 'local') return createLocalClient();
  const server = stmts.getServer.get(serverId);
  if (!server) throw new Error(`server not found: ${serverId}`);
  return createSshClient(server);
}

function pullOn(client, ref) {
  return new Promise((resolve, reject) => {
    client.pull(ref, {}, (err, stream) => {
      if (err) return reject(err);
      client.modem.followProgress(stream, (e, out) => (e ? reject(e) : resolve(out)));
    });
  });
}

// Build the agent image on DockGate's LOCAL daemon from the bundled agent/ folder, through the Docker Engine API.
// (The `docker build` CLI needs the buildx plugin, which DockGate's image does not have: every build failed with
// "BuildKit is enabled but the buildx component is missing", so Update stopped before touching the old agent.)
// One build at a time; a second caller waits for the first.
const building = new Map(); // daemon key ('local' or server id) -> build in progress
function agentContextFiles(dir = AGENT_DIR) {
  const files = ['Dockerfile', 'package.json', 'package-lock.json'].filter(f => fs.existsSync(path.join(dir, f)));
  return files.concat(fs.readdirSync(path.join(dir, 'src')).filter(f => f.endsWith('.js')).sort().map(f => 'src/' + f));
}
function buildAgentImage(log, client = createLocalClient(), key = 'local') {
  if (building.has(key)) return building.get(key);
  const job = new Promise((resolve, reject) => {
    log(key === 'local' ? `building ${IMAGE_REF} on DockGate's host (first time only, can take a few minutes) …\n` : `building ${IMAGE_REF} on the server itself (it pulls node:22-alpine and npm packages; a few minutes) …\n`);
    client.buildImage({ context: AGENT_DIR, src: agentContextFiles() }, { t: IMAGE_REF, labels: JSON.stringify({ 'dockgate.role': 'agent-image' }), rm: true, forcerm: true }, (err, stream) => {
      if (err) return reject(new Error('agent image build failed: ' + err.message));
      let failed = null;
      client.modem.followProgress(stream, (e) => {
        if (e || failed) return reject(new Error('agent image build failed: ' + String(failed || e.message).trim().slice(-400)));
        log('built the agent image\n');
        resolve();
      }, (ev) => {
        if (ev && (ev.error || ev.errorDetail)) failed = ev.error || (ev.errorDetail && ev.errorDetail.message);
        else if (ev && ev.stream && /^Step \d+\/\d+/.test(ev.stream)) log(ev.stream.trim() + '\n');
      });
    });
  }).finally(() => { building.delete(key); });
  building.set(key, job);
  return job;
}

async function hasImage(client, ref) { try { await client.getImage(ref).inspect(); return true; } catch (e) { return false; } }

// CPU architecture of a daemon (docker info: x86_64 / aarch64 …) and of an image (amd64 / arm64 …), in one naming.
const ARCH = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64', armv7l: 'arm', armhf: 'arm', arm: 'arm', i386: '386', i686: '386', ppc64le: 'ppc64le', s390x: 's390x' };
const archName = (a) => ARCH[String(a || '').toLowerCase()] || String(a || '').toLowerCase();
async function daemonArch(client) { try { return archName((await client.info()).Architecture); } catch (e) { return ''; } }
async function imageArch(client, ref) { try { return archName((await client.getImage(ref).inspect()).Architecture); } catch (e) { return null; } }

async function copyImage(local, client, log) {
  log(`copying ${IMAGE_REF} to the server …\n`);
  const tar = await new Promise((res, rej) => local.getImage(IMAGE_REF).get((err, stream) => (err ? rej(err) : res(stream))));
  await new Promise((res, rej) => {
    client.loadImage(tar, {}, (err, stream) => {
      if (err) return rej(err);
      client.modem.followProgress(stream, (e) => (e ? rej(e) : res()));
    });
  });
  if (!await hasImage(client, IMAGE_REF)) throw new Error('the image did not arrive on the server');
  log('image copied\n');
}

// Make sure IMAGE_REF is on the target, built for the target's CPU.
//   AGENT_IMAGE set: present → done (Update pulls again); else pull it from that registry (multi-arch is the registry's job).
//   default:
//     - present and for the server's CPU → done; present for another CPU (copied by an earlier version) → removed, see below;
//     - pull the multi-arch image CI published (GHCR); Docker takes the variant for the server's CPU;
//     - no pull (no internet, package not public, CI not finished yet):
//     - DockGate's host has the same CPU → build there once and copy it over (works without internet on the server);
//     - another CPU (an ARM server managed from an x86 DockGate) → build on the server itself. Before, the x86 image was
//       copied there and the agent died with "exec format error";
//     - the copy fails → build on the server as a last try.
async function ensureImage(client, log, forcePull, isLocal, key = 'local') {
  if (REGISTRY_IMAGE) {
    if (!forcePull && await hasImage(client, IMAGE_REF)) { log(`image present: ${IMAGE_REF}\n`); return; }
    log(`pulling ${IMAGE_REF} …\n`);
    await pullOn(client, IMAGE_REF);
    log('pull complete\n');
    return;
  }
  const target = await daemonArch(client);
  const have = await imageArch(client, IMAGE_REF);
  if (have && (!target || have === target)) { log(`image present: ${IMAGE_REF}\n`); return; }
  if (have) {
    log(`the image on the server is for ${have}, the server is ${target}: removing it\n`);
    try { await client.getImage(IMAGE_REF).remove({ force: true }); } catch (e) { /* replaced below anyway */ }
  }
  // 1. The published multi-arch image: the server's Docker picks the variant for its CPU. Nothing to build or copy.
  if (PULL_PUBLISHED) {
    try {
      log(`pulling ${IMAGE_REF} …\n`);
      await pullOn(client, IMAGE_REF);
      const got = await imageArch(client, IMAGE_REF);
      if (got && (!target || got === target)) { log(`pulled the ${got} image\n`); return; }
      log(`the registry has no ${target} image for this tag\n`);
      try { await client.getImage(IMAGE_REF).remove({ force: true }); } catch (e) { /* replaced below */ }
    } catch (e) { log(`pull unavailable (${String(e.message).slice(0, 160)}); building it instead\n`); }
  }
  // 2. Build: on DockGate's host and copy (same CPU), or on the server itself (another CPU).
  if (isLocal) { await buildAgentImage(log, client, 'local'); return; }
  const local = createLocalClient();
  const here = await daemonArch(local);
  if (target && here && target !== here) {
    log(`the server is ${target}, DockGate's host is ${here}: building the agent on the server\n`);
    await buildAgentImage(log, client, key);
  } else {
    if (!await hasImage(local, IMAGE_REF)) await buildAgentImage(log, local, 'local');
    try { await copyImage(local, client, log); }
    catch (e) { log(`copy failed (${e.message}): building the agent on the server instead\n`); await buildAgentImage(log, client, key); }
  }
  const got = await imageArch(client, IMAGE_REF);
  if (!got) throw new Error('the agent image is not on the server');
  if (target && got !== target) throw new Error(`the agent image is for ${got} but the server is ${target}`);
}

// Remove agent images DockGate made earlier that no container uses any more (best effort, never fails a job).
// A started agent can still die at once (wrong CPU, a crash on boot) and then restart in a loop. Watch it for a few
// seconds; if it is not running steadily, fail with its last log lines so the previous agent is put back.
const STARTUP_WATCH_MS = Number(process.env.AGENT_STARTUP_WATCH_MS || 6000);
async function checkStaysUp(cont, log) {
  await new Promise(r => setTimeout(r, STARTUP_WATCH_MS));
  let st;
  try { st = (await cont.inspect()).State || {}; } catch (e) { return; } // cannot tell: do not fail the job on it
  if (st.Running && !st.Restarting && !(st.ExitCode > 0)) return;
  let tail = '';
  try { const b = await cont.logs({ stdout: true, stderr: true, tail: 5 }); tail = String(Buffer.isBuffer(b) ? b.toString('utf8') : b).replace(/[\x00-\x08]/g, '').trim(); } catch (e) { /* no logs */ }
  throw new Error(`the new agent stopped right after starting${st.ExitCode ? ` (exit ${st.ExitCode})` : ''}${tail ? ': ' + tail.split('\n').pop().slice(0, 300) : ''}`);
}

async function removeOldImages(client, log) {
  try {
    const imgs = await client.listImages();
    for (const im of imgs) {
      const old = (im.RepoTags || []).filter(isOldAgentTag);
      for (const t of old) {
        try { await client.getImage(t).remove(); log(`removed old agent image ${t}\n`); } catch (e) { /* still in use */ }
      }
    }
  } catch (e) { /* listing failed: leave them */ }
}

async function removeExisting(client, log) {
  let list = [];
  try { list = await client.listContainers({ all: true, filters: { label: LABEL_FILTER } }); } catch (e) {}
  for (const c of list) {
    log(`removing existing agent ${c.Id.substring(0, 12)}\n`);
    const cont = client.getContainer(c.Id);
    try { await cont.stop({ t: 5 }); } catch (e) {}
    try { await cont.remove({ force: true }); } catch (e) {}
  }
  // Also clear any leftover container holding the fixed name (label may be absent on an old build).
  try { await client.getContainer(AGENT_NAME).remove({ force: true }); } catch (e) {}
}

// ---- operations ----

// Install / update / reconfigure one host. The new image is in place before the old agent is touched; the old
// container is renamed (not deleted) until the new one runs, and comes back if the new one fails to start.
// reconfigure keeps the image the agent runs now (settings change, code does not); install and update use the
// current build.
async function installOne(serverId, log, onPhase, kind = 'install') {
  const env = buildEnv(serverId);
  if (!envHasChannel(env)) {
    log('⚠ No notification channel configured — agent will run in metrics-only mode (Telegram/SMTP can be added later via reconfigure)\n');
  }
  const isLocal = serverId === 'local';
  const client = clientFor(serverId);
  let existing = [];
  try { existing = await client.listContainers({ all: true, filters: { label: LABEL_FILTER } }); } catch (e) { /* none */ }
  let image = IMAGE_REF, labels;
  if (kind === 'reconfigure' && existing[0]) {
    image = existing[0].Image; labels = { version: existing[0].Labels?.['dockgate.version'], build: existing[0].Labels?.['dockgate.build'] };
    log(`keeping the agent's current image (${image})\n`);
  } else {
    onPhase('pulling');
    await ensureImage(client, log, kind === 'update', isLocal, serverId);
  }
  onPhase('creating');
  const backups = [];
  for (const c of existing) {
    const cont = client.getContainer(c.Id);
    const wasRunning = c.State === 'running';
    try { await cont.stop({ t: 5 }); } catch (e) { /* already stopped */ }
    try { await cont.rename({ name: `${AGENT_NAME}-old-${Date.now()}-${backups.length}` }); backups.push({ cont, wasRunning }); log(`stopped the current agent ${c.Id.substring(0, 12)}\n`); }
    catch (e) { try { await cont.remove({ force: true }); } catch (e2) { /* gone */ } }
  }
  try { await client.getContainer(AGENT_NAME).remove({ force: true }); } catch (e) { /* no leftover with the fixed name */ }
  let cont;
  try {
    cont = await client.createContainer(containerSpec(env, image, labels));
    await cont.start();
    await checkStaysUp(cont, log);
  } catch (e) {
    log(`the new agent did not start (${e.message}); putting the previous one back\n`);
    if (cont) { try { await cont.remove({ force: true }); } catch (e2) { /* gone */ } }
    for (const b of backups) {
      try { await b.cont.rename({ name: AGENT_NAME }); if (b.wasRunning) await b.cont.start(); log('previous agent restored\n'); break; } catch (e2) { log(`could not restore the previous agent: ${e2.message}\n`); }
    }
    throw e;
  }
  for (const b of backups) { try { await b.cont.remove({ force: true }); } catch (e) { /* leave it */ } }
  log(`started ${AGENT_NAME}${labels ? '' : ` (v${AGENT_VERSION}${REGISTRY_IMAGE ? '' : ', build ' + AGENT_BUILD})`}\n`);
  if (kind !== 'reconfigure') await removeOldImages(client, log);
  onPhase('done');
  // Double-send guard: the on-host agent now covers this host, so stop the central monitor for it.
  try { monitorManager.stopMonitor(serverId); log('central monitor stopped for this host\n'); } catch (e) {}
  return { id: cont.id };
}

async function removeOne(serverId, log) {
  const client = clientFor(serverId);
  await removeExisting(client, log || (() => {}));
  // Hand watching back to the central monitor.
  try { monitorManager.startMonitor(serverId); } catch (e) {}
}

async function powerOne(serverId, action) {
  if (action !== 'start' && action !== 'stop') throw new Error('action must be start | stop');
  const client = clientFor(serverId);
  const list = await client.listContainers({ all: true, filters: { label: LABEL_FILTER } });
  if (!list.length) throw new Error('agent is not installed on this host');
  const cont = client.getContainer(list[0].Id);
  if (action === 'stop') {
    await cont.stop({ t: 5 });
    try { monitorManager.startMonitor(serverId); } catch (e) {}   // host unwatched → resume central
  } else {
    await cont.start();
    try { monitorManager.stopMonitor(serverId); } catch (e) {}    // agent active → central off
  }
}

async function statusOne(serverId) {
  let client;
  try { client = clientFor(serverId); } catch (e) { return { installed: false, running: false, state: 'absent', version: null }; }
  try {
    const list = await client.listContainers({ all: true, filters: { label: LABEL_FILTER } });
    if (!list.length) return { installed: false, running: false, state: 'absent', version: null };
    const c = list[0];
    const running = c.State === 'running';
    const version = c.Labels?.['dockgate.version'] || null, build = c.Labels?.['dockgate.build'] || null;
    // An agent without a build label predates build tags (1.0.0): it is older than any current build.
    const updateAvailable = REGISTRY_IMAGE ? (c.Image !== IMAGE_REF) : build !== AGENT_BUILD;
    return { installed: true, running, state: running ? 'running' : 'stopped', version, build, updateAvailable };
  } catch (e) {
    return { installed: false, running: false, state: 'unreachable', version: null, error: e.message };
  }
}

async function statusAll() {
  const out = {};
  const servers = stmts.getServers.all().filter(s => s.type !== 'local' && s.id !== 'local');
  await Promise.all(servers.map(async (s) => { out[s.id] = await statusOne(s.id); }));
  return out;
}

// ---- async job runner (re-openable progress, persisted in agent_jobs) ----

function newJobId() { return 'aj_' + crypto.randomBytes(6).toString('hex'); }

// A job runs inside DockGate's process. If DockGate restarted while one ran (an update of DockGate itself), the
// row would say "running" for good and the Edge agent page would show it as running forever. Close those at start.
try {
  db.prepare("UPDATE agent_jobs SET status = 'failed', error = 'DockGate restarted while this job ran', log = log || ?, finished_at = CURRENT_TIMESTAMP WHERE status = 'running'")
    .run('\nERROR: DockGate restarted while this job ran. Check the server in Servers → Edge agent and run Update again.\n');
} catch (e) { /* table missing in an old database: nothing to close */ }

// kind: 'install' | 'update' | 'reconfigure' | 'install-all' | 'remove'
function runJob(kind, serverIds, sourceIp) {
  const id = newJobId();
  const total = serverIds.length;
  stmts.insertAgentJob.run(id, kind, total === 1 ? serverIds[0] : null, 'running', total, sourceIp || null);
  const perServer = serverIds.map(sid => ({ id: sid, state: 'pending', message: '' }));
  stmts.setAgentJobServers.run(JSON.stringify(perServer), id);

  (async () => {
    let ok = 0, failed = 0;
    const appendLog = (s) => { try { stmts.appendAgentJobLog.run(s, id); } catch (e) {} };
    const saveServers = () => { try { stmts.setAgentJobServers.run(JSON.stringify(perServer), id); } catch (e) {} };

    for (let i = 0; i < serverIds.length; i++) {
      const sid = serverIds[i];
      perServer[i].state = 'working'; saveServers();
      const onPhase = (ph) => { perServer[i].state = ph; saveServers(); try { stmts.updateAgentJobProgress.run(ok, failed, ph, id); } catch (e) {} };
      try {
        appendLog(`\n=== ${sid} ===\n`);
        if (kind === 'remove') await removeOne(sid, appendLog);
        else await installOne(sid, appendLog, onPhase, kind === 'install-all' ? 'install' : kind);
        perServer[i].state = 'done'; ok++;
      } catch (e) {
        perServer[i].state = 'failed'; perServer[i].message = e.message; failed++;
        appendLog(`ERROR: ${e.message}\n`);
      }
      saveServers();
      try { stmts.updateAgentJobProgress.run(ok, failed, perServer[i].state, id); } catch (e) {}
    }

    const status = (ok === 0 && failed > 0) ? 'failed' : 'done';
    try { stmts.finishAgentJob.run(status, ok, failed, failed ? `${failed} of ${total} failed` : null, id); } catch (e) {}
    try { stmts.trimAgentJobs.run(); } catch (e) {}
  })();

  return id;
}

/** What DockGate would install now: shown on the Edge agent page next to each server's running build. */
const current = () => ({ version: AGENT_VERSION, build: REGISTRY_IMAGE ? null : AGENT_BUILD, image: IMAGE_REF });

module.exports = {
  IMAGE_REF, AGENT_NAME, AGENT_VERSION, AGENT_BUILD, agentBuildInfo, current, isOldAgentTag,
  installOne, removeOne, powerOne, statusOne, statusAll, runJob,
};
