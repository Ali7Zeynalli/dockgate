// Container image update with a record and a way back.
//
// Update:   pull the same tag → keep the old image (tagged dockgate-rollback/<name>:previous) → recreate the
//           container → watch it for a short while (still running, healthy if it has a healthcheck) →
//           if it fails, put the old image back automatically.
// Roll back: point the tag at the image the container had before an update, recreate, watch the same way.
//
// Compose services are recreated with `docker compose up -d --no-deps <service>` — the compose file is
// never edited: the tag on the server is moved back to the old image, so compose starts that one.
// Standalone containers keep their old container (renamed and stopped) until the new one is up, so a failed
// update restores the exact container that ran before.
//
// Every run is a row in image_update_history (who, when, which image, version and digest before → after,
// result, log). It is keyed by server + container name (and compose project/service), not by container ID,
// because the ID changes on every recreate.
const crypto = require('crypto');
const { db, stmts } = require('./db');
const dockerService = require('./docker');
const IU = require('./image-updates');
const { logAction } = require('./audit');

db.exec(`CREATE TABLE IF NOT EXISTS image_update_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  container_name TEXT NOT NULL,
  project TEXT,
  service TEXT,
  image TEXT NOT NULL,
  kind TEXT NOT NULL,            -- update | rollback
  status TEXT NOT NULL,          -- running | updated | no_change | rolled_back | failed
  from_image_id TEXT,
  to_image_id TEXT,
  from_digest TEXT,
  to_digest TEXT,
  from_version TEXT,
  to_version TEXT,
  from_created TEXT,
  to_created TEXT,
  old_container_id TEXT,
  new_container_id TEXT,
  error TEXT,
  log TEXT,
  source_ip TEXT,
  started_at INTEGER,
  finished_at INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_iuh_name ON image_update_history (server_id, container_name, id)');
// A run that was going when DockGate stopped can not finish any more.
db.prepare("UPDATE image_update_history SET status = 'failed', error = 'DockGate stopped during the update', finished_at = ? WHERE status = 'running'").run(Date.now());

const insertRow = db.prepare(`INSERT INTO image_update_history (server_id, container_name, project, service, image, kind, status,
  from_image_id, from_digest, from_version, from_created, old_container_id, source_ip, started_at)
  VALUES (@server_id, @container_name, @project, @service, @image, @kind, 'running',
  @from_image_id, @from_digest, @from_version, @from_created, @old_container_id, @source_ip, @started_at)`);
const finishRow = db.prepare(`UPDATE image_update_history SET status = @status, to_image_id = @to_image_id, to_digest = @to_digest,
  to_version = @to_version, to_created = @to_created, new_container_id = @new_container_id, error = @error, log = @log,
  finished_at = @finished_at WHERE id = @id`);
const getRow = db.prepare('SELECT * FROM image_update_history WHERE id = ?');

const LOG_MAX = 20000;
const KEEP_PER_CONTAINER = 50;
const WATCH_MS = () => Math.max(0, Number(process.env.IMAGE_UPDATE_WATCH_MS) || 10000);
const HEALTH_MAX_MS = () => Math.max(WATCH_MS(), Number(process.env.IMAGE_UPDATE_HEALTH_MS) || 90000);
const jobs = new Map();
const busy = new Set(); // server:name being changed

let composeExec = null; // (project, args[], onData) → Promise, set by routes/compose.js
let composeRecord = null; // records the run in the stack's deploy history (Deploy → Compose stacks)
function setComposeExec(fn, record) { composeExec = fn; composeRecord = record || null; }

const COLS = `id, server_id, container_name, project, service, image, kind, status, from_image_id, to_image_id, from_digest, to_digest,
  from_version, to_version, from_created, to_created, old_container_id, new_container_id, error, source_ip, started_at, finished_at`;
const jobOfRow = new Map(); // history id → job id while it runs

/** History rows for a container (newest first), without the log. A running row carries its job_id. */
function history({ serverId, name, project, service, limit = 50 }) {
  const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
  let rows;
  if (project && service) {
    rows = db.prepare(`SELECT ${COLS} FROM image_update_history WHERE server_id = ? AND ((project = ? AND service = ?) OR container_name = ?) ORDER BY id DESC LIMIT ?`)
      .all(serverId, project, service, name || '', lim);
  } else if (name) rows = db.prepare(`SELECT ${COLS} FROM image_update_history WHERE server_id = ? AND container_name = ? ORDER BY id DESC LIMIT ?`).all(serverId, name, lim);
  else rows = db.prepare(`SELECT ${COLS} FROM image_update_history WHERE server_id = ? ORDER BY id DESC LIMIT ?`).all(serverId, lim);
  return rows.map(r => (r.status === 'running' && jobOfRow.has(r.id) ? { ...r, job_id: jobOfRow.get(r.id) } : r));
}
function logOf(id) { const r = getRow.get(Number(id)); return r ? { id: r.id, server_id: r.server_id, container_name: r.container_name, log: r.log || '', status: r.status } : null; }
function trim(serverId, name) {
  db.prepare(`DELETE FROM image_update_history WHERE server_id = ? AND container_name = ? AND id NOT IN
    (SELECT id FROM image_update_history WHERE server_id = ? AND container_name = ? ORDER BY id DESC LIMIT ?)`).run(serverId, name, serverId, name, KEEP_PER_CONTAINER);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const short = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);

/** A repository name that is valid for `docker tag` (lowercase, safe characters). */
function rollbackRepo(name) {
  return 'dockgate-rollback/' + (String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100) || 'container');
}

/** Split "host:5000/repo:tag" → { repo: "host:5000/repo", tag: "tag" }. */
function splitTag(ref) {
  const s = String(ref);
  const slash = s.lastIndexOf('/'), colon = s.lastIndexOf(':');
  if (colon > slash) return { repo: s.slice(0, colon), tag: s.slice(colon + 1) };
  return { repo: s, tag: 'latest' };
}

async function imageFacts(client, idOrRef, repo) {
  const im = await client.getImage(idOrRef).inspect();
  const ref = IU.parseRef(repo) || {};
  return {
    id: im.Id,
    digests: ref.repo ? IU.localDigests(im, ref) : [],
    version: IU.versionOf(im.Config, ref.repo || ''),
    created: im.Created ? String(im.Created).slice(0, 19) : null,
  };
}

function pullWith(client, ref, log) {
  const authconfig = dockerService.lookupAuthConfig ? dockerService.lookupAuthConfig(ref) : undefined;
  return new Promise((resolve, reject) => {
    client.pull(ref, authconfig ? { authconfig } : {}, (err, stream) => {
      if (err) return reject(err);
      const seen = new Set();
      client.modem.followProgress(stream, (e, out) => {
        if (e) return reject(e);
        const bad = (out || []).find(o => o && o.error);
        if (bad) return reject(new Error(bad.error));
        resolve(out);
      }, (ev) => {
        if (!ev || !ev.status) return;
        const line = ev.id ? `${ev.id}: ${ev.status}` : ev.status;
        if (/Downloading|Extracting|Waiting/.test(ev.status)) return; // progress noise
        if (!seen.has(line)) { seen.add(line); log(line); }
      });
    });
  });
}

/** The containers of a compose service (one per replica). */
async function serviceContainers(client, project, service) {
  const list = await client.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`] } });
  return list.sort((a, b) => b.Created - a.Created);
}

/**
 * Watch containers after a recreate: they must stay running for WATCH_MS; one with a healthcheck must turn
 * healthy (up to HEALTH_MAX_MS). Throws with the reason when they do not.
 */
async function watch(client, ids, log) {
  const t0 = Date.now(), watchMs = WATCH_MS(), maxMs = HEALTH_MAX_MS();
  if (!watchMs) return;
  log(`Watching ${ids.length > 1 ? `${ids.length} containers` : 'the new container'} for ${Math.round(watchMs / 1000)}s…`);
  const restarts = new Map();
  for (;;) {
    let waitingHealth = false;
    for (const id of ids) {
      const i = await client.getContainer(id).inspect();
      const st = i.State || {};
      if (!restarts.has(id)) restarts.set(id, i.RestartCount || 0);
      if (st.Restarting || (i.RestartCount || 0) > restarts.get(id)) throw new Error(`the new container keeps restarting (exit code ${st.ExitCode})`);
      if (!st.Running) throw new Error(`the new container stopped (exit code ${st.ExitCode}${st.Error ? ', ' + st.Error : ''})`);
      if (st.Health) {
        if (st.Health.Status === 'unhealthy') {
          const last = (st.Health.Log || []).slice(-1)[0];
          throw new Error('the new container is unhealthy' + (last && last.Output ? `: ${String(last.Output).trim().slice(0, 200)}` : ''));
        }
        if (st.Health.Status !== 'healthy') waitingHealth = true;
      }
    }
    const el = Date.now() - t0;
    if (el >= watchMs && !waitingHealth) { log('✓ The new container is running' + (ids.length ? '' : '')); return; }
    if (el >= maxMs) throw new Error('the new container did not become healthy in time');
    await sleep(1000);
  }
}

/** Last lines of a container's log, for the job log when it failed. */
async function tailLog(client, id, log) {
  try {
    const buf = await client.getContainer(id).logs({ stdout: true, stderr: true, tail: 20 });
    const text = dockerService.demuxLogs ? dockerService.demuxLogs(buf) : String(buf);
    const lines = String(text).split('\n').filter(Boolean).slice(-20);
    if (lines.length) { log('Last log lines of the new container:'); lines.forEach(l => log('  ' + l.slice(0, 300))); }
  } catch (e) { /* no log */ }
}

// ---- standalone container: rename the old one, start a new one, restore the old one if it fails ----

/**
 * Settings for the new container: what `docker inspect` shows minus what came from the OLD image. Inspect
 * merges the image's Env, Cmd, Labels … into the container config; copying those would pin the old image's
 * values (e.g. PG_VERSION=15.8, an old CMD) onto the new one. Values the user set are kept.
 */
function configFrom(info, image, oldImageConfig) {
  const c = info.Config || {};
  const ic = oldImageConfig || {};
  const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  const own = (v, iv) => (same(v, iv) ? undefined : v);
  const imgEnv = new Set(ic.Env || []);
  const imgLabels = ic.Labels || {};
  const labels = {};
  for (const [k, v] of Object.entries(c.Labels || {})) if (imgLabels[k] !== v) labels[k] = v;
  const ports = {};
  for (const p of Object.keys(c.ExposedPorts || {})) if (!(ic.ExposedPorts || {})[p]) ports[p] = {};
  const cfg = {
    name: (info.Name || '').replace(/^\//, ''),
    Image: image,
    Hostname: c.Hostname,
    Domainname: c.Domainname,
    Env: (c.Env || []).filter(e => !imgEnv.has(e)),
    Labels: labels,
    ExposedPorts: ports,
    Tty: c.Tty,
    OpenStdin: c.OpenStdin,
    HostConfig: info.HostConfig,
  };
  // Entrypoint and Cmd go together: a new Entrypoint resets the image's Cmd.
  const ep = own(c.Entrypoint, ic.Entrypoint), cmd = own(c.Cmd, ic.Cmd);
  if (ep !== undefined) { cfg.Entrypoint = ep; cfg.Cmd = c.Cmd; } else if (cmd !== undefined) cfg.Cmd = cmd;
  for (const k of ['WorkingDir', 'User', 'Healthcheck', 'StopSignal']) { const v = own(c[k], ic[k]); if (v !== undefined) cfg[k] = v; }
  // A hostname Docker made up from the old container ID would be wrong for the new one.
  if (cfg.Hostname && info.Id.startsWith(cfg.Hostname)) delete cfg.Hostname;
  return cfg;
}

/**
 * Replace a standalone container with one built from `image` (same settings). The old container is
 * renamed and stopped first; returns { newId, undo, commit } — undo() restores the old container,
 * commit() removes it.
 */
async function swapContainer(client, info, image, log) {
  let oldImageConfig = {};
  try { oldImageConfig = (await client.getImage(info.Image).inspect()).Config || {}; } catch (e) { /* image gone: keep everything */ }
  const name = (info.Name || '').replace(/^\//, '');
  const oldName = `${name}-dockgate-old-${Date.now().toString(36)}`;
  const old = client.getContainer(info.Id);
  const wasRunning = !!(info.State && info.State.Running);
  log(`Renaming the current container to ${oldName}`);
  await old.rename({ name: oldName });
  try { if (wasRunning) { log('Stopping it'); await old.stop({ t: 15 }); } }
  catch (e) { if (e.statusCode !== 304) { await old.rename({ name }).catch(() => {}); throw e; } }
  let created = null;
  const undo = async () => {
    log(`Restoring the previous container ${name}`);
    if (created) await created.remove({ force: true }).catch(() => {});
    await old.rename({ name });
    if (wasRunning) await old.start().catch(e => { if (e.statusCode !== 304) throw e; });
  };
  try {
    log(`Creating ${name} from ${image}`);
    created = await client.createContainer(configFrom(info, image, oldImageConfig));
    const nets = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
    const primary = info.HostConfig && info.HostConfig.NetworkMode;
    for (const net of Object.keys(nets)) {
      if (net === primary || ['default', 'bridge', 'host', 'none'].includes(net)) continue;
      const aliases = (nets[net].Aliases || []).filter(a => a !== info.Id.slice(0, 12));
      await client.getNetwork(net).connect({ Container: created.id, EndpointConfig: aliases.length ? { Aliases: aliases } : {} }).catch(() => {});
    }
    if (wasRunning) await created.start();
  } catch (e) {
    await undo().catch(u => log('✗ Could not restore the previous container: ' + u.message));
    throw e;
  }
  return { newId: created.id, wasRunning, undo, commit: async () => { await old.remove({ force: true }).catch(() => {}); } };
}

// ---- notifications ----

function serverRow(serverId) {
  if (!serverId || serverId === 'local') return { id: 'local', type: 'local' };
  return stmts.getServers.all().find(s => s.id === serverId) || { id: serverId };
}
async function notify(row) {
  try {
    const HM = require('./notifications/health-monitor');
    const srv = serverRow(row.server_id);
    const where = HM.serverLabel(srv);
    const ver = (a, b) => (a || b) ? ` ${a || short(row.from_image_id)} → ${b || short(row.to_image_id)}` : '';
    const esc = (s) => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    if (row.status === 'updated') {
      const what = row.kind === 'rollback' ? 'rolled back' : 'updated';
      await HM.deliver('image_updated', srv, `${row.container_name} ${what} on ${where}`,
        `🟢 ${row.container_name} ${what} on ${where}\n${row.image}${ver(row.from_version, row.to_version)}`,
        `<p><b>${esc(row.container_name)}</b> was ${what} on ${esc(where)}.</p><p>${esc(row.image)}${esc(ver(row.from_version, row.to_version))}</p>`);
    } else if (row.status === 'rolled_back' || row.status === 'failed') {
      const what = row.status === 'rolled_back' ? 'update failed — the previous image is running again' : `${row.kind === 'rollback' ? 'roll back' : 'update'} failed`;
      await HM.deliver('image_update_failed', srv, `${row.container_name}: ${what}`,
        `🔴 ${row.container_name} on ${where}: ${what}\n${row.image}\n${row.error || ''}`,
        `<p><b>${esc(row.container_name)}</b> on ${esc(where)}: ${esc(what)}.</p><p>${esc(row.image)}</p><p>${esc(row.error || '')}</p>`);
    }
  } catch (e) { console.warn('[image-update] notify:', e.message); }
}

// ---- the job ----

function newJob(kind, name) {
  const job = { id: crypto.randomBytes(8).toString('hex'), kind, container: name, status: 'running', phase: 'starting', steps: [], log: '', error: null, result: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > 3600000) jobs.delete(k);
  return job;
}
const logTo = (job) => (line) => { job.log += `${line}\n`; if (job.log.length > LOG_MAX * 2) job.log = job.log.slice(-LOG_MAX); };
function step(job, id, status, label) {
  let s = job.steps.find(x => x.id === id);
  if (!s) { s = { id, label: label || id, status: 'pending' }; job.steps.push(s); }
  if (label) s.label = label;
  s.status = status;
  if (status === 'running') job.phase = s.label;
}

/**
 * Start an update (kind 'update') or a roll back to the image of history row `historyId` (kind 'rollback')
 * for container `containerId` on the server in use. Returns the job right away; it runs in the background.
 */
async function start({ containerId, kind = 'update', historyId = null, sourceIp = null }) {
  const serverId = dockerService.getActiveServerId() || 'local';
  const client = dockerService.docker;
  let info = null;
  let target = null;
  if (kind === 'rollback') {
    target = getRow.get(Number(historyId));
    if (!target || target.server_id !== serverId) throw Object.assign(new Error('That update record is not on this server'), { statusCode: 404 });
    if (!target.from_image_id) throw Object.assign(new Error('That record has no previous image'), { statusCode: 400 });
    if (!containerId) {
      const list = target.project && target.service
        ? await serviceContainers(client, target.project, target.service)
        : await client.listContainers({ all: true, filters: { name: [`^/${target.container_name}$`] } });
      if (!list.length) throw Object.assign(new Error(`Container ${target.container_name} is not on this server any more`), { statusCode: 404 });
      containerId = list[0].Id;
    }
  }
  info = await client.getContainer(containerId).inspect();
  const name = (info.Name || '').replace(/^\//, '');
  const labels = info.Config.Labels || {};
  const project = labels['com.docker.compose.project'] || null;
  const service = labels['com.docker.compose.service'] || null;
  const ref = info.Config.Image;
  const parsed = IU.parseRef(ref);
  if (!parsed) throw Object.assign(new Error('This container was started from an image ID — there is no tag to update'), { statusCode: 400 });
  if (parsed.pinned) throw Object.assign(new Error('This container is pinned to a digest (image@sha256:…) — change the pin to update it'), { statusCode: 400 });
  if (project && service && !composeExec) throw Object.assign(new Error('Compose is not available'), { statusCode: 500 });
  if (kind === 'rollback') {
    try { await client.getImage(target.from_image_id).inspect(); }
    catch (e) { throw Object.assign(new Error(`The previous image ${short(target.from_image_id)} is not on the server any more (removed by a prune?) — it can not be rolled back`), { statusCode: 409 }); }
  }
  const lock = `${serverId}:${project && service ? `${project}/${service}` : name}`;
  if (busy.has(lock)) throw Object.assign(new Error('An update of this container is already running'), { statusCode: 409 });
  busy.add(lock);
  let job, log, before, rowId;
  try {
  job = newJob(kind, name);
  log = logTo(job);
  before = await imageFacts(client, info.Image, ref).catch(() => ({ id: info.Image, digests: [], version: null, created: null }));
  rowId = insertRow.run({ server_id: serverId, container_name: name, project, service, image: ref, kind,
    from_image_id: before.id, from_digest: before.digests[0] || null, from_version: before.version, from_created: before.created,
    old_container_id: info.Id, source_ip: sourceIp, started_at: job.startedAt }).lastInsertRowid;
  job.historyId = rowId;
  jobOfRow.set(rowId, job.id);
  } catch (e) { busy.delete(lock); throw e; } // never leave the container locked when the job could not start
  const isCompose = !!(project && service);

  const sameServer = () => { if ((dockerService.getActiveServerId() || 'local') !== serverId) throw new Error('The server in use was switched during the update — switch back to finish it'); };
  const retag = async (imageId) => { const { repo, tag } = splitTag(ref); await client.getImage(imageId).tag({ repo, tag }); log(`Tagged ${short(imageId)} as ${ref}`); };
  const composeUp = async () => { sameServer(); log(`$ docker compose up -d --no-deps ${service}`); await composeExec(project, ['up', '-d', '--no-deps', service], (c) => log(String(c).replace(/\n$/, ''))); };
  // Recreate with the image the tag points at now; returns { ids, undo, commit }.
  const recreate = async () => {
    if (isCompose) {
      await composeUp();
      const list = await serviceContainers(client, project, service);
      return { ids: list.filter(c => c.State === 'running').map(c => c.Id), all: list.map(c => c.Id) };
    }
    const sw = await swapContainer(client, info, ref, log);
    return { ids: sw.wasRunning ? [sw.newId] : [], all: [sw.newId], undo: sw.undo, commit: sw.commit };
  };

  (async () => {
    let result = { status: 'failed', to: null, newId: null, error: null };
    try {
      let toId;
      // Hold the current image by a tag of its own before anything moves the image tag: with the containerd
      // image store an image whose last tag moves away is removed at once.
      const keepRepo = rollbackRepo(isCompose ? `${project}-${service}` : name);
      const untag = (t) => client.getImage(`${keepRepo}:${t}`).remove({ noprune: true }).catch(() => {});
      const keep = async () => {
        step(job, 'keep', 'running', 'Keep the current image for a roll back');
        await client.getImage(before.id).tag({ repo: keepRepo, tag: 'previous' });
        log(`Kept ${short(before.id)} as ${keepRepo}:previous`);
        step(job, 'keep', 'done');
      };
      if (kind === 'update') {
        await client.getImage(before.id).tag({ repo: keepRepo, tag: 'pending' });
        step(job, 'pull', 'running', `Pull ${ref}`);
        try {
          if (isCompose) { sameServer(); log(`$ docker compose pull ${service}`); await composeExec(project, ['pull', service], (c) => log(String(c).replace(/\n$/, ''))); }
          else { log(`$ docker pull ${ref}`); await pullWith(client, ref, log); }
          step(job, 'pull', 'done');
          toId = (await client.getImage(ref).inspect()).Id;
          if (toId === before.id) {
            log('The registry has no newer image than the one this container runs — nothing to do.');
            result = { status: 'no_change', to: before, newId: info.Id };
            return;
          }
          await keep();
        } finally { await untag('pending'); }
      } else {
        toId = target.from_image_id;
        await client.getImage(toId).tag({ repo: keepRepo, tag: 'target' });
        try {
          await keep();
          step(job, 'retag', 'running', `Point ${ref} at the previous image`);
          await retag(toId);
          step(job, 'retag', 'done');
        } finally { await untag('target'); }
      }
      const after = await imageFacts(client, toId, ref);
      log(`${kind === 'update' ? 'Update' : 'Roll back'}: ${before.version || short(before.id)} → ${after.version || short(after.id)}`);
      step(job, 'recreate', 'running', isCompose ? `Recreate service ${service}` : `Recreate ${name}`);
      const rc = await recreate();
      step(job, 'recreate', 'done');
      step(job, 'watch', 'running', 'Check the new container');
      try {
        if (rc.ids.length) await watch(client, rc.ids, log);
        else log('The container was not running before — it is left stopped.');
        step(job, 'watch', 'done');
      } catch (e) {
        step(job, 'watch', 'failed');
        log('✗ ' + e.message);
        for (const id of rc.ids) await tailLog(client, id, log);
        step(job, 'undo', 'running', 'Put the previous image back');
        try {
          if (rc.undo) await rc.undo();
          else { await retag(before.id); await composeUp(); }
          step(job, 'undo', 'done');
          log(`✓ The previous image (${before.version || short(before.id)}) is running again`);
          result = { status: 'rolled_back', to: after, newId: null, error: e.message };
        } catch (u) {
          step(job, 'undo', 'failed');
          log('✗ Putting the previous image back failed: ' + u.message);
          result = { status: 'failed', to: after, newId: null, error: `${e.message}; putting the previous image back failed: ${u.message}` };
        }
        return;
      }
      if (rc.commit) await rc.commit();
      result = { status: 'updated', to: after, newId: rc.all[0] || null };
      log(kind === 'update' ? '✓ Updated' : '✓ Rolled back');
    } catch (e) {
      (job.steps || []).forEach(s => { if (s.status === 'running') s.status = 'failed'; });
      const msg = String((e && (e.stderr || e.message)) || e).trim().slice(0, 1000);
      log('✗ ' + msg);
      result = { status: 'failed', to: null, newId: null, error: msg };
    } finally {
      busy.delete(lock);
      jobOfRow.delete(rowId);
      const to = result.to || {};
      finishRow.run({ id: rowId, status: result.status, to_image_id: to.id || null, to_digest: (to.digests || [])[0] || null, to_version: to.version || null,
        to_created: to.created || null, new_container_id: result.newId, error: result.error || null, log: job.log.slice(-LOG_MAX), finished_at: Date.now() });
      trim(serverId, name);
      // The stored "newer image" row now reflects what runs.
      try {
        const now = result.status === 'updated' ? to : before;
        if (now && now.digests) IU.refreshLocal(serverId, ref, { digests: now.digests, version: now.version, created: now.created });
      } catch (e) { /* next check fixes it */ }
      const row = getRow.get(rowId);
      const ver = `${row.from_version || short(row.from_image_id)} → ${row.to_version || short(row.to_image_id)}`;
      logAction({ sourceIp, server: serverId, resourceId: result.newId || info.Id, resourceType: 'container', resourceName: name,
        action: kind === 'update' ? 'image_update' : 'image_rollback',
        details: { status: result.status, image: ref, versions: ver, project, service, error: result.error || undefined } });
      job.status = result.status === 'updated' || result.status === 'no_change' ? 'done' : 'error';
      job.error = result.error || null;
      job.result = { status: result.status, historyId: rowId, newContainerId: result.newId, row };
      job.phase = job.status === 'done' ? 'done' : 'error';
      job.finishedAt = Date.now();
      if (result.status !== 'no_change') notify(row);
      if (isCompose && composeRecord && result.status !== 'no_change') {
        composeRecord({ project, kind: kind === 'update' ? 'image update' : 'image rollback', status: result.status === 'updated' ? 'done' : 'error',
          error: result.status === 'rolled_back' ? `${result.error} — the previous image was put back` : result.error, sourceIp, startedAt: job.startedAt, finishedAt: Date.now(),
          details: { service, image: ref, from: row.from_version || short(row.from_image_id), to: row.to_version || short(row.to_image_id), result: result.status, historyId: rowId } }).catch(() => {});
      }
    }
  })();
  return job;
}

function getJob(id) { return jobs.get(id) || null; }

/** The image a container can be rolled back to: the last successful update's previous image, if still on the server. */
async function rollbackTarget(serverId, name, project, service, currentImageId) {
  const rows = history({ serverId, name, project, service, limit: 20 });
  const last = rows.find(r => r.kind === 'update' && r.status === 'updated');
  if (!last || !last.from_image_id) return null;
  if (currentImageId && last.from_image_id === currentImageId) return null; // already on the previous image
  try { await dockerService.docker.getImage(last.from_image_id).inspect(); }
  catch (e) { return { ...last, missing: true }; }
  return last;
}

module.exports = { start, getJob, history, logOf, rollbackTarget, setComposeExec, configFrom, swapContainer, _rollbackRepo: rollbackRepo, _splitTag: splitTag };
