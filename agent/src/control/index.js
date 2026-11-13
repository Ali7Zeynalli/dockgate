// The agent as a local controller. DockGate sends signed rules and commands through a unix socket inside this
// container (no network port): only someone who can `docker exec` into it — root on the server — can reach it,
// and only messages signed by the DockGate that installed the agent are taken. The loops keep replicas and heal
// unhealthy containers by the last rules, also while DockGate is away.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { verify } = require('./verify');
const { healDecision } = require('./heal-decision');
const ex = require('./executor');

const STATE_DIR = process.env.DG_STATE_DIR || '/var/lib/dockgate-agent';
const SOCK_DIR = process.env.DG_SOCK_DIR || '/run/dockgate-agent';
const SOCK = path.join(SOCK_DIR, 'cmd.sock');
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const TICK_MS = Number(process.env.DG_CONTROL_TICK_MS) || 30000;
const OVERRIDE = '/docker-compose.dockgate.yml';

/** Only the shape and limits DockGate may send; anything else in a rules file is dropped. */
function cleanRules(body) {
  const out = { version: Number(body && body.version) || 0, projects: {} };
  for (const [p, svcs] of Object.entries((body && body.projects) || {})) {
    if (!NAME.test(p) || !svcs || typeof svcs !== 'object') continue;
    for (const [s, r] of Object.entries(svcs)) {
      if (!NAME.test(s) || !r || typeof r !== 'object') continue;
      const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
      (out.projects[p] = out.projects[p] || {})[s] = {
        replicas: int(r.replicas, 0, ex.MAX_REPLICAS), min: int(r.min, 0, ex.MAX_REPLICAS), max: int(r.max, 1, ex.MAX_REPLICAS),
        heal: r.heal === true, healPerHour: int(r.healPerHour, 1, 20) ?? 3, keep: r.keep !== false,
      };
    }
  }
  return out;
}

class Controller {
  constructor(docker, { serverId, publicKeyPem, notify = async () => {}, log = console.log }) {
    this.docker = docker; this.serverId = serverId; this.pub = publicKeyPem; this.notify = notify; this.log = log;
    this.state = { lastSeq: 0, rules: null, rulesAt: 0, history: [], heal: {}, short: {} };
    this.enabled = !!(serverId && publicKeyPem);
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8'))); } catch (e) { /* first start */ }
    // A new key (agent reinstalled by another DockGate, or the key rotated): its numbers start over, and the old rules go.
    const fp = publicKeyPem ? require('crypto').createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16) : null;
    if (this.state.key !== fp) Object.assign(this.state, { key: fp, lastSeq: 0, rules: null, rulesAt: 0 });
  }
  save() {
    try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); const f = path.join(STATE_DIR, 'state.json'); fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); } catch (e) { this.log('[control] state not saved:', e.message); }
  }
  record(entry) {
    this.state.history.unshift({ t: Date.now(), ...entry });
    this.state.history = this.state.history.slice(0, 200);
    this.save();
  }

  /** A message from the socket: verify, then store rules or run one whitelisted action. */
  async handle(raw) {
    if (!this.enabled) return { ok: false, reason: 'control is off (no key)' };
    const v = verify(raw, this.pub, this.serverId, this.state);
    if (!v.ok) {
      this.record({ kind: 'rejected', reason: v.reason });
      if (Date.now() - (this.lastRejectNotice || 0) > 600000) { // at most one notice in 10 minutes
        this.lastRejectNotice = Date.now();
        await this.notify(`🛑 Rejected a command (${v.reason}) — it was not signed by the DockGate that installed this agent.`).catch(() => {});
      }
      return { ok: false, reason: v.reason };
    }
    this.state.lastSeq = v.msg.seq;
    if (v.msg.kind === 'rules') {
      this.state.rules = cleanRules(v.msg.body);
      this.state.rulesAt = Date.now();
      this.save();
      return { ok: true, version: this.state.rules.version };
    }
    const { action, args } = v.msg.body || {};
    try {
      const r = await ex.execute(action, args, { docker: this.docker, rules: this.state.rules });
      if (action !== 'state') this.record({ kind: 'command', action, args, ok: r.ok, reason: r.reason, container: r.container });
      else this.save();
      return { ...r, control: this.view() };
    } catch (e) {
      this.record({ kind: 'command', action, args, ok: false, reason: e.message });
      return { ok: false, reason: e.message };
    }
  }

  startSocket() {
    if (!this.enabled) return null;
    fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(SOCK_DIR, 0o700);
    try { fs.unlinkSync(SOCK); } catch (e) { /* not there */ }
    const srv = net.createServer((conn) => {
      let buf = '';
      conn.setTimeout(20000, () => conn.destroy());
      conn.on('data', async (d) => {
        buf += d.toString('utf8');
        if (buf.length > 300 * 1024) { conn.end(JSON.stringify({ ok: false, reason: 'too big' }) + '\n'); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const reply = await this.handle(buf.slice(0, nl)).catch(e => ({ ok: false, reason: e.message }));
        conn.end(JSON.stringify(reply) + '\n');
      });
    });
    srv.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch (e) { /* best effort */ } });
    this.server = srv;
    return srv;
  }

  /** What DockGate reads back: the rules it has, recent actions, what it is healing. */
  view() {
    return { enabled: this.enabled, rulesVersion: this.state.rules ? this.state.rules.version : null, rulesAt: this.state.rulesAt, lastSeq: this.state.lastSeq, history: this.state.history.slice(0, 50) };
  }

  /** Is a deploy going on in this project (a container made in the last 2 minutes, or one being made)? */
  async busy(project) {
    const all = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) });
    return all.some(c => c.State === 'created' || c.State === 'restarting' || (Date.now() / 1000 - c.Created) < 120);
  }

  /** TCP check of a container without a health check, from a helper in its network namespace (the agent's own image). */
  async probe(container) {
    const ct = await this.docker.getContainer(container).inspect();
    const port = Object.keys(ct.Config.ExposedPorts || {}).map(k => k.split('/')).find(([, proto]) => proto === 'tcp');
    if (!port) return null; // nothing to probe
    const self = await this.docker.getContainer(process.env.HOSTNAME || '').inspect().catch(() => null);
    if (!self) return null;
    const js = `const s=require('net').connect(${Number(port[0])},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)`;
    const h = await this.docker.createContainer({ Image: self.Config.Image, Cmd: ['node', '-e', js], Labels: { 'dockgate.role': 'probe' },
      HostConfig: { NetworkMode: `container:${ct.Id}`, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 32 * 1048576 } });
    try { await h.start(); const r = await h.wait(); return r.StatusCode === 0; } finally { await h.remove({ force: true }).catch(() => {}); }
  }

  async tick() {
    const rules = this.state.rules;
    if (!this.enabled || !rules) return;
    for (const [project, svcs] of Object.entries(rules.projects)) {
      if (await this.busy(project).catch(() => true)) continue;
      for (const [service, rule] of Object.entries(svcs)) {
        const reps = await ex.replicasOf(this.docker, project, service).catch(() => []);
        if (rule.heal) for (const rep of reps) await this.healOne(project, service, rule, rep).catch(e => this.log('[control] heal:', e.message));
        if (rule.keep && Number.isInteger(rule.replicas)) await this.keepReplicas(project, service, rule, reps).catch(e => this.log('[control] replicas:', e.message));
      }
    }
  }

  async healOne(project, service, rule, rep) {
    const ct = await this.docker.getContainer(rep.id).inspect();
    const h = this.state.heal[rep.id] = this.state.heal[rep.id] || { fails: 0, restarts: [], stopped: false };
    h.since = new Date(ct.State.StartedAt).getTime();
    const status = ct.State.Health ? ct.State.Health.Status : null;
    let healthy;
    if (status) healthy = status !== 'unhealthy'; // its own health check (starting counts as fine)
    else { const p = await this.probe(rep.id); if (p === null) return; healthy = p; }
    if (healthy) { h.fails = 0; h.stopped = false; return; }
    h.fails++;
    const d = healDecision(h, Date.now(), { healPerHour: rule.healPerHour });
    if (d === 'restart') {
      await this.docker.getContainer(rep.id).restart({ t: 10 });
      h.restarts = [...(h.restarts || []).filter(t => Date.now() - t < 3600000), Date.now()]; h.fails = 0;
      this.record({ kind: 'heal', action: 'restart', project, service, container: rep.name, ok: true });
      await this.notify(`🩺 ${rep.name} was unhealthy — restarted (${h.restarts.length} in the last hour).`).catch(() => {});
    } else if ((d === 'stop' || d === 'rollback') && !h.stopped) {
      h.stopped = true;
      this.record({ kind: 'heal', action: 'gave up', project, service, container: rep.name, ok: false, reason: `still unhealthy after ${rule.healPerHour} restarts in an hour` });
      await this.notify(`🛑 ${rep.name} is still unhealthy after ${rule.healPerHour} restarts in an hour — the agent stopped restarting it. Look at its logs.`).catch(() => {});
    } else this.save();
  }

  /** Bring back replicas that are gone — only while the running ones were made with DockGate's override (else: drift, DockGate shows it). */
  async keepReplicas(project, service, rule, reps) {
    const key = `${project}/${service}`;
    if (reps.length >= rule.replicas) { delete this.state.short[key]; return; }
    const tpl = reps.find(r => r.state === 'running');
    if (!tpl) return;
    if (!String(tpl.labels['com.docker.compose.project.config_files'] || '').includes(OVERRIDE)) return; // started without the override: not ours to fix
    this.state.short[key] = (this.state.short[key] || 0) + 1;
    if (this.state.short[key] < 2) { this.save(); return; } // two checks in a row, so a deploy in between is not mistaken
    const r = await ex.execute('add-replica', { project, service }, { docker: this.docker, rules: this.state.rules });
    this.record({ kind: 'replicas', action: 'add', project, service, ok: r.ok, container: r.container, reason: r.reason });
    if (r.ok) await this.notify(`🔁 ${project}/${service} had ${reps.length} of ${rule.replicas} replicas — the agent started ${r.container}.`).catch(() => {});
  }

  start() {
    if (!this.enabled) { this.log('[control] off — no key from DockGate (update the agent from DockGate to turn it on)'); return; }
    this.startSocket();
    this.timer = setInterval(() => this.tick().catch(e => this.log('[control] tick:', e.message)), TICK_MS);
    this.log(`[control] on — rules v${this.state.rules ? this.state.rules.version : '-'}`);
  }
  stop() { clearInterval(this.timer); try { this.server && this.server.close(); } catch (e) { /* closed */ } }
}

module.exports = { Controller, cleanRules, SOCK };
