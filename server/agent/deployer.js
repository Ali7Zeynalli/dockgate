// Edge Notifier Agent deployer. Pushes the outbound-only notifier container onto a managed host
// over a PER-HOST dockerode client (createSshClient) — never via setActiveServer, which would mutate
// the module-global active daemon that the rest of the app shares. Channel creds are read from the
// global smtp_config + the per-server override (server_channels), decrypted, and injected as env.
// When an agent is installed/started on a host, the central EventMonitor for that host is stopped
// (double-send guard); on remove/stop it is restarted.

const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { stmts, db } = require('../db');
const { createSshClient, createLocalClient } = require('../docker');
const { decrypt } = require('../auth/secrets');
const telegram = require('../notifications/telegram');
const mailer = require('../notifications/mailer');
const monitorManager = require('../notifications/monitor-manager');

const IMAGE_REF = process.env.NOTIFIER_AGENT_IMAGE || 'dockgate/notifier-agent:1.0.0';
const AGENT_NAME = 'dockgate-notifier';
const AGENT_VERSION = '1.0.0';
const LABEL_FILTER = ['dockgate.role=notifier-agent'];

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
  const diskGb = stmts.getSetting.get('disk_threshold_gb')?.value;

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

function containerSpec(env) {
  return {
    Image: IMAGE_REF,
    name: AGENT_NAME,
    Env: env,
    Labels: { 'dockgate.role': 'notifier-agent', 'dockgate.version': AGENT_VERSION },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'],
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

// Build the agent image on DockGate's LOCAL daemon from the bundled notifier-agent/ context.
// Uses the host `docker` CLI (same assumption as compose/stack deploy). So the operator never has
// to run `docker build` by hand — the first install builds it automatically.
function buildAgentImage(log) {
  return new Promise((resolve, reject) => {
    const ctx = path.join(__dirname, '..', '..', 'notifier-agent');
    execFile('docker', ['build', '-t', IMAGE_REF, ctx], { maxBuffer: 16 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('agent image build failed: ' + String(stderr || err.message).trim().slice(-400)));
      log('built agent image locally\n');
      resolve();
    });
  });
}

// Make sure IMAGE_REF exists on the target. Order: already present → pull → (airgapped) save from
// DockGate's local daemon and load onto the target. forcePull skips the present-check (used by Update).
async function ensureImage(client, log, forcePull) {
  if (!forcePull) {
    try { await client.getImage(IMAGE_REF).inspect(); log(`image present: ${IMAGE_REF}\n`); return; }
    catch (e) { /* not present — pull */ }
  }
  log(`pulling ${IMAGE_REF} ...\n`);
  try {
    await pullOn(client, IMAGE_REF);
    log('pull complete\n');
    return;
  } catch (pErr) {
    log(`pull unavailable (${pErr.message}); shipping the locally-built image instead ...\n`);
    const local = createLocalClient();
    let localHas = false;
    try { await local.getImage(IMAGE_REF).inspect(); localHas = true; } catch (e) {}
    if (!localHas) {
      // Not on DockGate's daemon either → build it from the bundled context (automatic, one-time).
      log(`agent image not built yet — building ${IMAGE_REF} on DockGate's host ...\n`);
      await buildAgentImage(log);
    }
    const tar = await new Promise((res, rej) => local.getImage(IMAGE_REF).get((err, stream) => (err ? rej(err) : res(stream))));
    await new Promise((res, rej) => {
      client.loadImage(tar, {}, (err, stream) => {
        if (err) return rej(err);
        client.modem.followProgress(stream, (e) => (e ? rej(e) : res()));
      });
    });
    log('loaded image onto target\n');
  }
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

async function installOne(serverId, log, onPhase, forcePull) {
  const env = buildEnv(serverId);
  if (!envHasChannel(env)) {
    throw new Error('No notification channel configured — set Telegram or SMTP in Settings, or a per-server override.');
  }
  const client = clientFor(serverId);
  onPhase('pulling');
  await ensureImage(client, log, forcePull);
  onPhase('creating');
  await removeExisting(client, log);
  const cont = await client.createContainer(containerSpec(env));
  await cont.start();
  log(`started ${AGENT_NAME}\n`);
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
    return { installed: true, running, state: running ? 'running' : 'stopped', version: c.Labels?.['dockgate.version'] || null };
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

// kind: 'install' | 'update' | 'reconfigure' | 'install-all' | 'remove'
function runJob(kind, serverIds, sourceIp) {
  const id = newJobId();
  const total = serverIds.length;
  stmts.insertAgentJob.run(id, kind, total === 1 ? serverIds[0] : null, 'running', total, sourceIp || null);
  const perServer = serverIds.map(sid => ({ id: sid, state: 'pending', message: '' }));
  stmts.setAgentJobServers.run(JSON.stringify(perServer), id);

  const forcePull = (kind === 'update');

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
        else await installOne(sid, appendLog, onPhase, forcePull);
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

module.exports = {
  IMAGE_REF, AGENT_NAME, AGENT_VERSION,
  installOne, removeOne, powerOne, statusOne, statusAll, runJob,
};
