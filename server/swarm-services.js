// Swarm services — phase 3.
//
// The Settings form is a plain model (10 sections) that maps to Docker's ServiceSpec both ways:
// formFromSpec() fills the form from a service, specFromForm() writes the form onto a copy of the service's
// spec, so fields the form does not show (Privileges, Isolation, …) are kept as they are.
// New services get safe defaults: rolling update one task at a time, start-first, automatic roll back when
// the new task fails within 15 s; restart on any exit with a 5 s delay; json-file logs 10 MB × 3.
const dockerService = require('./docker');
const swarm = require('./swarm');
const { logAction } = require('./audit');

const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

// ---- units ----

/** "10s", "1m30s", "500ms", "2h", "15" (seconds) → nanoseconds. Empty → undefined. */
function parseDur(v, what = 'duration') {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1e9);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g; let m, ns = 0, used = '';
  while ((m = re.exec(s))) { ns += Number(m[1]) * { ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 }[m[2]]; used += m[0]; }
  if (!used || used !== s) throw bad(`${what}: write it like 10s, 1m30s or 500ms`);
  return Math.round(ns);
}
function fmtDur(ns) {
  if (!ns) return '';
  let s = ns / 1e9; if (s < 1) return `${Math.round(ns / 1e6)}ms`;
  const h = Math.floor(s / 3600); s -= h * 3600; const mi = Math.floor(s / 60); s -= mi * 60;
  return `${h ? h + 'h' : ''}${mi ? mi + 'm' : ''}${s ? +s.toFixed(3) + 's' : ''}` || '0s';
}
/** "512M", "1G", "256m", "1048576" → bytes. */
function parseBytes(v, what = 'size') {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(String(v).trim());
  if (!m) throw bad(`${what}: write it like 512M or 1G`);
  return Math.round(Number(m[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]);
}
function fmtBytes(b) {
  if (!b) return '';
  for (const [u, n] of [['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]]) if (b % n === 0 || b >= n * 10) return `${+(b / n).toFixed(2)}${u}`;
  return String(b);
}
/** Split a command line like a shell does (quotes, backslashes) — no expansion. */
function splitArgs(s) {
  const out = []; let cur = '', q = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; }
    else if (c === '"' || c === "'") { q = c; any = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; any = true; }
    else if (/\s/.test(c)) { if (cur || any) { out.push(cur); cur = ''; any = false; } }
    else cur += c;
  }
  if (q) throw bad('A quote is not closed in the command');
  if (cur || any) out.push(cur);
  return out;
}
const joinArgs = (a) => (a || []).map(x => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${String(x).replace(/'/g, `'\\''`)}'`)).join(' ');
const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
const kv = (list, what) => {
  const o = {};
  for (const l of lines(list)) { const i = l.indexOf('='); if (i < 1) throw bad(`${what}: "${l}" — write key=value`); o[l.slice(0, i).trim()] = l.slice(i + 1); }
  return o;
};
const toLines = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`);
const num = (v, what, lo, hi) => {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${what} must be between ${lo} and ${hi}`);
  return n;
};

// ---- defaults ----

const DEFAULT_UPDATE = { Parallelism: 1, Delay: 5e9, FailureAction: 'rollback', Monitor: 15e9, MaxFailureRatio: 0, Order: 'start-first' };
const DEFAULT_ROLLBACK = { Parallelism: 1, Delay: 0, FailureAction: 'pause', Monitor: 5e9, MaxFailureRatio: 0, Order: 'stop-first' };
const DEFAULT_RESTART = { Condition: 'any', Delay: 5e9, MaxAttempts: 0 };
const DEFAULT_LOG = { Name: 'json-file', Options: { 'max-size': '10m', 'max-file': '3' } };
const DB_IMAGE = /(^|\/)(postgres|postgis|mysql|mariadb|mongo|mongodb|redis|valkey|keydb|elasticsearch|opensearch|cassandra|clickhouse|influxdb|timescaledb|couchdb|neo4j|rabbitmq|minio|etcd|zookeeper)(:|@|$)/i;
const isDatabase = (image) => DB_IMAGE.test(String(image || '').replace(/^docker\.io\//, '').replace(/^library\//, ''));

// ---- form ⇄ spec ----

function modeOf(spec) {
  const m = spec.Mode || {};
  if (m.Global) return 'global';
  if (m.ReplicatedJob) return 'replicated-job';
  if (m.GlobalJob) return 'global-job';
  return 'replicated';
}
function upd(u) {
  u = u || {};
  return { order: u.Order || 'stop-first', parallelism: u.Parallelism ?? 1, delay: fmtDur(u.Delay), monitor: fmtDur(u.Monitor), failureAction: u.FailureAction || 'pause', maxFailureRatio: u.MaxFailureRatio ?? 0 };
}

function formFromSpec(spec) {
  const tt = spec.TaskTemplate || {};
  const cs = tt.ContainerSpec || {};
  const res = tt.Resources || {};
  const pl = tt.Placement || {};
  const rp = tt.RestartPolicy || {};
  const hc = cs.Healthcheck;
  const ep = spec.EndpointSpec || {};
  const ld = tt.LogDriver || null;
  const mode = modeOf(spec);
  return {
    name: spec.Name,
    general: {
      mode, replicas: mode === 'replicated' ? (spec.Mode.Replicated.Replicas ?? 1) : mode === 'replicated-job' ? (spec.Mode.ReplicatedJob.TotalCompletions ?? 1) : '',
      image: String(cs.Image || '').split('@')[0], entrypoint: joinArgs(cs.Command), command: joinArgs(cs.Args), user: cs.User || '', workdir: cs.Dir || '', hostname: cs.Hostname || '',
    },
    resources: {
      cpus: res.Limits && res.Limits.NanoCPUs ? res.Limits.NanoCPUs / 1e9 : '', memory: fmtBytes(res.Limits && res.Limits.MemoryBytes),
      cpusReserve: res.Reservations && res.Reservations.NanoCPUs ? res.Reservations.NanoCPUs / 1e9 : '', memoryReserve: fmtBytes(res.Reservations && res.Reservations.MemoryBytes),
      pids: res.Limits && res.Limits.Pids ? res.Limits.Pids : '',
      generic: ((res.Reservations && res.Reservations.GenericResources) || []).map(g => g.DiscreteResourceSpec ? `${g.DiscreteResourceSpec.Kind}=${g.DiscreteResourceSpec.Value}` : g.NamedResourceSpec ? `${g.NamedResourceSpec.Kind}=${g.NamedResourceSpec.Value}` : '').filter(Boolean),
    },
    placement: { constraints: pl.Constraints || [], spread: (pl.Preferences || []).map(p => p.Spread && p.Spread.SpreadDescriptor).filter(Boolean), maxPerNode: pl.MaxReplicas || '' },
    update: upd(spec.UpdateConfig),
    rollback: upd(spec.RollbackConfig),
    restart: { condition: rp.Condition || 'any', delay: fmtDur(rp.Delay), maxAttempts: rp.MaxAttempts || 0, window: fmtDur(rp.Window) },
    health: !hc ? { mode: 'image' } : (hc.Test && hc.Test[0] === 'NONE') ? { mode: 'none' } : {
      mode: 'custom', test: hc.Test ? (hc.Test[0] === 'CMD-SHELL' ? hc.Test.slice(1).join(' ') : joinArgs(hc.Test.slice(1))) : '', shell: !hc.Test || hc.Test[0] === 'CMD-SHELL',
      interval: fmtDur(hc.Interval), timeout: fmtDur(hc.Timeout), retries: hc.Retries || '', startPeriod: fmtDur(hc.StartPeriod),
    },
    env: {
      env: cs.Env || [],
      secrets: (cs.Secrets || []).map(x => ({ name: x.SecretName, target: x.File ? x.File.Name : '' })),
      configs: (cs.Configs || []).map(x => ({ name: x.ConfigName, target: x.File ? x.File.Name : '' })),
      labels: toLines(spec.Labels), containerLabels: toLines(cs.Labels),
    },
    network: {
      ports: (ep.Ports || []).map(p => ({ published: p.PublishedPort || '', target: p.TargetPort, protocol: p.Protocol || 'tcp', mode: p.PublishMode || 'ingress' })),
      endpointMode: ep.Mode || 'vip',
      networks: (tt.Networks || spec.Networks || []).map(n => ({ name: n.Target, aliases: (n.Aliases || []).join(', ') })),
      dns: (cs.DNSConfig && cs.DNSConfig.Nameservers) || [], extraHosts: cs.Hosts || [],
    },
    mounts: (cs.Mounts || []).map(mt => ({ type: mt.Type, source: mt.Source || '', target: mt.Target, readonly: !!mt.ReadOnly, driver: mt.VolumeOptions && mt.VolumeOptions.DriverConfig ? mt.VolumeOptions.DriverConfig.Name || '' : '' })),
    advanced: {
      capAdd: cs.CapabilityAdd || [], capDrop: cs.CapabilityDrop || [], sysctls: toLines(cs.Sysctls),
      ulimits: (cs.Ulimits || []).map(u => `${u.Name}=${u.Soft}:${u.Hard}`), readOnly: !!cs.ReadOnly, init: !!cs.Init,
      stopGrace: fmtDur(cs.StopGracePeriod), stopSignal: cs.StopSignal || '',
      logDriver: ld ? ld.Name : '', logOpts: ld ? toLines(ld.Options) : [],
    },
  };
}

function updFrom(f, def, what) {
  if (!f) return def;
  const o = String(f.order || def.Order);
  if (!['start-first', 'stop-first'].includes(o)) throw bad(`${what}: order must be start-first or stop-first`);
  const fa = String(f.failureAction || def.FailureAction);
  if (!['rollback', 'pause', 'continue'].includes(fa) || (what === 'Rollback' && fa === 'rollback')) throw bad(`${what}: failure action must be ${what === 'Rollback' ? 'pause or continue' : 'rollback, pause or continue'}`);
  return {
    Parallelism: num(f.parallelism, `${what}: parallelism`, 0, 100) ?? def.Parallelism,
    Delay: parseDur(f.delay, `${what}: delay`) ?? 0,
    FailureAction: fa,
    Monitor: parseDur(f.monitor, `${what}: monitor`) ?? 0,
    MaxFailureRatio: num(f.maxFailureRatio, `${what}: max failure ratio`, 0, 1) ?? 0,
    Order: o,
  };
}

/**
 * Write the form onto a copy of `base` (an existing spec, or {} for a new service). Throws a 400 with the reason.
 * secretIds / configIds: Map name → ID (Docker needs both).
 */
function specFromForm(form, base = {}, { secretIds = new Map(), configIds = new Map() } = {}) {
  const spec = JSON.parse(JSON.stringify(base || {}));
  const isNew = !base || !base.Name;
  const g = form.general || {};
  if (isNew) {
    const name = String(form.name || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) throw bad('Name: letters, digits, dot, dash or underscore (up to 63)');
    spec.Name = name;
  }
  spec.TaskTemplate = spec.TaskTemplate || {};
  const tt = spec.TaskTemplate;
  tt.ContainerSpec = tt.ContainerSpec || {};
  const cs = tt.ContainerSpec;
  // General
  const image = String(g.image || '').trim();
  if (!image || /\s/.test(image)) throw bad('Image is required (e.g. nginx:1.27)');
  const oldImage = String(cs.Image || '').split('@')[0];
  cs.Image = image === oldImage ? cs.Image : image; // keep the pinned digest when the image did not change
  const mode = g.mode || 'replicated';
  const reps = num(g.replicas, 'Replicas', 0, 1000);
  if (isNew || modeOf(spec) !== mode) {
    spec.Mode = mode === 'global' ? { Global: {} } : mode === 'replicated-job' ? { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: reps ?? 1 } } : mode === 'global-job' ? { GlobalJob: {} } : { Replicated: { Replicas: reps ?? 1 } };
    if (!isNew) throw bad('The mode of a service can not be changed — create a new service');
  } else if (mode === 'replicated') spec.Mode = { Replicated: { Replicas: reps ?? 1 } };
  else if (mode === 'replicated-job') spec.Mode.ReplicatedJob.TotalCompletions = reps ?? 1;
  const ent = String(g.entrypoint || '').trim(), cmd = String(g.command || '').trim();
  if (ent) cs.Command = splitArgs(ent); else delete cs.Command;
  if (cmd) cs.Args = splitArgs(cmd); else delete cs.Args;
  for (const [k, f] of [['User', 'user'], ['Dir', 'workdir'], ['Hostname', 'hostname']]) { const v = String(g[f] || '').trim(); if (v) cs[k] = v; else delete cs[k]; }
  // Resources
  const r = form.resources || {};
  const lim = {}, resv = {};
  const cpus = num(r.cpus, 'CPU limit', 0.01, 1024), cpusR = num(r.cpusReserve, 'CPU reservation', 0.01, 1024);
  if (cpus) lim.NanoCPUs = Math.round(cpus * 1e9);
  if (cpusR) resv.NanoCPUs = Math.round(cpusR * 1e9);
  const mem = parseBytes(r.memory, 'Memory limit'), memR = parseBytes(r.memoryReserve, 'Memory reservation');
  if (mem) { if (mem < 6 * 1024 * 1024) throw bad('Memory limit: at least 6M'); lim.MemoryBytes = mem; }
  if (memR) resv.MemoryBytes = memR;
  if (mem && memR && memR > mem) throw bad('Memory reservation is bigger than the limit');
  const pids = num(r.pids, 'PID limit', 1, 4194304); if (pids) lim.Pids = pids;
  const gen = lines(r.generic).map(l => { const m = /^([\w.-]+)=(\d+)$/.exec(l); if (!m) throw bad(`Generic resource "${l}": write KIND=count, e.g. NVIDIA-GPU=1`); return { DiscreteResourceSpec: { Kind: m[1], Value: Number(m[2]) } }; });
  if (gen.length) resv.GenericResources = gen;
  tt.Resources = { ...(Object.keys(lim).length ? { Limits: lim } : {}), ...(Object.keys(resv).length ? { Reservations: resv } : {}) };
  // Placement
  const p = form.placement || {};
  const constraints = lines(p.constraints);
  for (const c of constraints) if (!/^(node|engine)\.[\w.-]+\s*(==|!=)\s*\S+$/.test(c)) throw bad(`Constraint "${c}": write e.g. node.labels.db==true or node.role!=manager`);
  const spread = lines(p.spread);
  for (const s of spread) if (!/^node\.labels\.[\w.-]+$/.test(s)) throw bad(`Spread "${s}": write a node label, e.g. node.labels.zone`);
  const maxPer = num(p.maxPerNode, 'Max per server', 0, 1000);
  tt.Placement = { ...(tt.Placement && tt.Placement.Platforms ? { Platforms: tt.Placement.Platforms } : {}), Constraints: constraints, Preferences: spread.map(s => ({ Spread: { SpreadDescriptor: s } })), ...(maxPer ? { MaxReplicas: maxPer } : {}) };
  // Updates & rollback
  spec.UpdateConfig = updFrom(form.update, DEFAULT_UPDATE, 'Update');
  spec.RollbackConfig = updFrom(form.rollback, DEFAULT_ROLLBACK, 'Rollback');
  // Restart
  const rs = form.restart || {};
  if (rs.condition && !['any', 'on-failure', 'none'].includes(rs.condition)) throw bad('Restart condition must be any, on-failure or none');
  tt.RestartPolicy = { Condition: rs.condition || 'any', Delay: parseDur(rs.delay, 'Restart delay') ?? 5e9, MaxAttempts: num(rs.maxAttempts, 'Max attempts', 0, 1000) ?? 0, ...(parseDur(rs.window, 'Restart window') ? { Window: parseDur(rs.window, 'Restart window') } : {}) };
  // Health check
  const h = form.health || { mode: 'image' };
  if (h.mode === 'none') cs.Healthcheck = { Test: ['NONE'] };
  else if (h.mode === 'custom') {
    const test = String(h.test || '').trim();
    if (!test) throw bad('Health check: enter the command');
    cs.Healthcheck = { Test: h.shell === false ? ['CMD', ...splitArgs(test)] : ['CMD-SHELL', test], Interval: parseDur(h.interval, 'Health interval') || 0, Timeout: parseDur(h.timeout, 'Health timeout') || 0, Retries: num(h.retries, 'Health retries', 0, 100) || 0, StartPeriod: parseDur(h.startPeriod, 'Health start period') || 0 };
  } else delete cs.Healthcheck;
  // Env & secrets
  const e = form.env || {};
  const env = lines(e.env);
  for (const x of env) if (!/^[^=\s]+=/.test(x)) throw bad(`Environment "${x.slice(0, 40)}": write NAME=value`);
  cs.Env = env;
  const ref = (list, ids, kind) => (list || []).filter(x => x && x.name).map(x => {
    const id = ids.get(x.name);
    if (!id) throw bad(`${kind} "${x.name}" does not exist`);
    const target = String(x.target || '').trim() || (kind === 'Secret' ? x.name : `/${x.name}`);
    return { [`${kind}ID`]: id, [`${kind}Name`]: x.name, File: { Name: target, UID: '0', GID: '0', Mode: kind === 'Secret' ? 0o444 : 0o444 } };
  });
  cs.Secrets = ref(e.secrets, secretIds, 'Secret');
  cs.Configs = ref(e.configs, configIds, 'Config');
  spec.Labels = kv(e.labels, 'Service label');
  cs.Labels = kv(e.containerLabels, 'Container label');
  // Ports & network
  const n = form.network || {};
  const ports = (n.ports || []).filter(x => x && (x.target || x.published)).map(x => {
    const target = num(x.target, 'Container port', 1, 65535), published = num(x.published, 'Published port', 1, 65535);
    if (!target) throw bad('Each port needs the container port');
    const proto = x.protocol || 'tcp'; if (!['tcp', 'udp', 'sctp'].includes(proto)) throw bad('Port protocol must be tcp, udp or sctp');
    const pm = x.mode || 'ingress'; if (!['ingress', 'host'].includes(pm)) throw bad('Port mode must be ingress or host');
    return { Protocol: proto, TargetPort: target, ...(published ? { PublishedPort: published } : {}), PublishMode: pm };
  });
  const em = n.endpointMode || 'vip';
  if (!['vip', 'dnsrr'].includes(em)) throw bad('Endpoint mode must be vip or dnsrr');
  if (em === 'dnsrr' && ports.some(x => x.PublishMode === 'ingress')) throw bad('DNS round robin can not publish ports in ingress mode — use host mode');
  spec.EndpointSpec = { Mode: em, Ports: ports };
  if (ports.some(x => x.PublishMode === 'host') && spec.UpdateConfig.Order === 'start-first') spec.UpdateConfig.Order = 'stop-first'; // two tasks can not hold the same host port
  tt.Networks = (n.networks || []).filter(x => x && x.name).map(x => ({ Target: String(x.name).trim(), ...(String(x.aliases || '').trim() ? { Aliases: String(x.aliases).split(',').map(a => a.trim()).filter(Boolean) } : {}) }));
  delete spec.Networks; // deprecated place
  const dns = lines(n.dns); for (const d of dns) if (!swarm.isIPv4(d) && !/^[0-9a-f:]+$/i.test(d)) throw bad(`DNS server "${d}" is not an IP address`);
  if (dns.length) cs.DNSConfig = { ...(cs.DNSConfig || {}), Nameservers: dns }; else if (cs.DNSConfig) delete cs.DNSConfig.Nameservers;
  const hosts = lines(n.extraHosts); for (const x of hosts) if (!/^\S+\s+\S+/.test(x)) throw bad(`Extra host "${x}": write "IP hostname"`);
  cs.Hosts = hosts;
  // Mounts
  cs.Mounts = (form.mounts || []).filter(x => x && x.target).map(x => {
    const type = x.type || 'volume'; if (!['volume', 'bind', 'tmpfs'].includes(type)) throw bad('Mount type must be volume, bind or tmpfs');
    const target = String(x.target).trim(); if (!target.startsWith('/')) throw bad(`Mount target "${target}" must be an absolute path`);
    const source = String(x.source || '').trim();
    if (type === 'bind' && !source.startsWith('/')) throw bad(`Bind mount source "${source}" must be an absolute path on the server`);
    const mt = { Type: type, Target: target, ReadOnly: !!x.readonly, ...(type !== 'tmpfs' && source ? { Source: source } : {}) };
    if (type === 'volume' && String(x.driver || '').trim()) mt.VolumeOptions = { DriverConfig: { Name: String(x.driver).trim() } };
    return mt;
  });
  // Advanced
  const a = form.advanced || {};
  const caps = (l) => lines(l).map(c => { const u = c.toUpperCase(); if (!/^(CAP_)?[A-Z_]+$/.test(u)) throw bad(`Capability "${c}" is not valid`); return u.startsWith('CAP_') ? u : `CAP_${u}`; });
  cs.CapabilityAdd = caps(a.capAdd); cs.CapabilityDrop = caps(a.capDrop);
  if (!cs.CapabilityAdd.length) delete cs.CapabilityAdd; if (!cs.CapabilityDrop.length) delete cs.CapabilityDrop;
  cs.Sysctls = kv(a.sysctls, 'Sysctl');
  cs.Ulimits = lines(a.ulimits).map(l => { const m = /^([a-z]+)=(-?\d+)(?::(-?\d+))?$/.exec(l); if (!m) throw bad(`Ulimit "${l}": write name=soft:hard, e.g. nofile=1024:4096`); return { Name: m[1], Soft: Number(m[2]), Hard: Number(m[3] ?? m[2]) }; });
  cs.ReadOnly = !!a.readOnly;
  if (a.init) cs.Init = true; else delete cs.Init;
  const grace = parseDur(a.stopGrace, 'Stop grace period'); if (grace) cs.StopGracePeriod = grace; else delete cs.StopGracePeriod;
  if (String(a.stopSignal || '').trim()) cs.StopSignal = String(a.stopSignal).trim(); else delete cs.StopSignal;
  if (String(a.logDriver || '').trim()) tt.LogDriver = { Name: String(a.logDriver).trim(), Options: kv(a.logOpts, 'Log option') };
  else if (isNew) tt.LogDriver = DEFAULT_LOG;
  else delete tt.LogDriver;
  return spec;
}

/** A form for a new service with the defaults filled in. */
function newForm() {
  const f = formFromSpec({ Name: '', Mode: { Replicated: { Replicas: 1 } }, TaskTemplate: { ContainerSpec: {}, RestartPolicy: DEFAULT_RESTART, LogDriver: DEFAULT_LOG }, UpdateConfig: DEFAULT_UPDATE, RollbackConfig: DEFAULT_ROLLBACK, EndpointSpec: { Mode: 'vip', Ports: [] } });
  f.name = '';
  return f;
}

// ---- reading ----

async function mgr() {
  const st = await swarm.status();
  if (st.state !== 'active') throw Object.assign(new Error('Swarm is not active on the server in use'), { statusCode: 409 });
  if (!st.manager) throw Object.assign(new Error('The server in use is a worker — switch to a manager at the top'), { statusCode: 409 });
  return { c: dockerService.docker, serverId: st.serverId };
}
async function idMaps(c) {
  const [secrets, configs] = await Promise.all([c.listSecrets().catch(() => []), c.listConfigs().catch(() => [])]);
  return { secretIds: new Map(secrets.map(s => [s.Spec.Name, s.ID])), configIds: new Map(configs.map(s => [s.Spec.Name, s.ID])) };
}
const stackOf = (spec) => (spec.Labels || {})['com.docker.stack.namespace'] || null;

async function list() {
  const { c } = await mgr();
  let upd = {};
  try { const st = await swarm.status(); if (st.clusterId) upd = require('./swarm-images').results(st.clusterId); } catch (e) { /* no check yet */ }
  const [services, tasks, nodes] = await Promise.all([c.listServices({ status: true }), c.listTasks(), c.listNodes()]);
  const host = new Map(nodes.map(n => [n.ID, n.Description.Hostname]));
  return services.map(s => {
    const mine = tasks.filter(t => t.ServiceID === s.ID);
    const current = mine.filter(t => t.DesiredState === 'running' || t.DesiredState === 'ready' || (s.Spec.Mode.ReplicatedJob || s.Spec.Mode.GlobalJob ? t.DesiredState === 'complete' : false));
    const failed = mine.filter(t => ['failed', 'rejected'].includes(t.Status.State)).sort((a, b) => new Date(b.Status.Timestamp) - new Date(a.Status.Timestamp))[0];
    const pending = current.find(t => ['pending', 'assigned'].includes(t.Status.State) && t.Status.Err);
    const running = current.filter(t => t.Status.State === 'running').length;
    const desired = s.ServiceStatus ? s.ServiceStatus.DesiredTasks : current.length;
    let problem = null;
    if (pending) problem = pending.Status.Err;
    else if (running < desired && failed) problem = `${failed.Status.Err || failed.Status.State}${failed.Status.ContainerStatus && failed.Status.ContainerStatus.ExitCode ? ` (exit code ${failed.Status.ContainerStatus.ExitCode})` : ''}`;
    const us = s.UpdateStatus || null;
    return {
      id: s.ID, name: s.Spec.Name, image: String(s.Spec.TaskTemplate.ContainerSpec.Image || '').split('@')[0], mode: modeOf(s.Spec),
      desired, running, stack: stackOf(s.Spec), database: isDatabase(s.Spec.TaskTemplate.ContainerSpec.Image),
      volumes: (s.Spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume'),
      tasks: current.sort((a, b) => (a.Slot || 0) - (b.Slot || 0)).map(t => ({ id: t.ID, slot: t.Slot || null, state: t.Status.State, node: host.get(t.NodeID) || '', error: t.Status.Err || null })),
      ports: ((s.Endpoint && s.Endpoint.Ports) || (s.Spec.EndpointSpec && s.Spec.EndpointSpec.Ports) || []).map(p => ({ published: p.PublishedPort, target: p.TargetPort, protocol: p.Protocol, mode: p.PublishMode })),
      update: us ? { state: us.State, message: us.Message || '', completedAt: us.CompletedAt || null, startedAt: us.StartedAt || null } : null,
      hasPrevious: !!s.PreviousSpec, problem, updatedAt: s.UpdatedAt, createdAt: s.CreatedAt,
      endpointMode: (s.Spec.EndpointSpec && s.Spec.EndpointSpec.Mode) || 'vip', vips: ((s.Endpoint && s.Endpoint.VirtualIPs) || []).map(v => v.Addr),
      newer: imageState(upd[s.ID], s.Spec.TaskTemplate.ContainerSpec.Image),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function get(id) {
  const { c } = await mgr();
  const s = await c.getService(id).inspect();
  const [secrets, configs, networks] = await Promise.all([c.listSecrets().catch(() => []), c.listConfigs().catch(() => []), c.listNetworks({ filters: JSON.stringify({ driver: ['overlay'] }) }).catch(() => [])]);
  const netName = new Map(networks.map(n => [n.Id, n.Name]));
  const form = formFromSpec(s.Spec);
  form.network.networks = form.network.networks.map(n => ({ ...n, name: netName.get(n.name) || n.name }));
  return { id: s.ID, version: s.Version.Index, form, stack: stackOf(s.Spec), image: s.Spec.TaskTemplate.ContainerSpec.Image, hasPrevious: !!s.PreviousSpec, choices: choicesFrom(secrets, configs, networks) };
}
const choicesFrom = (secrets, configs, networks) => ({ secrets: secrets.map(s => s.Spec.Name).sort(), configs: configs.map(s => s.Spec.Name).sort(), networks: networks.filter(n => n.Name !== 'ingress').map(n => n.Name).sort() });
async function choices() {
  const { c } = await mgr();
  const [secrets, configs, networks] = await Promise.all([c.listSecrets().catch(() => []), c.listConfigs().catch(() => []), c.listNetworks({ filters: JSON.stringify({ driver: ['overlay'] }) }).catch(() => [])]);
  return { form: newForm(), choices: choicesFrom(secrets, configs, networks) };
}

/** Task history of a service, newest first. */
async function tasks(id) {
  const { c } = await mgr();
  const [ts, nodes] = await Promise.all([c.listTasks({ filters: JSON.stringify({ service: [id] }) }), c.listNodes()]);
  const host = new Map(nodes.map(n => [n.ID, n.Description.Hostname]));
  // DockGate server of each node (for a terminal into a task on another node)
  const where = new Map();
  try { const ns = await require('./swarm-cluster').nodes(); for (const n of ns.nodes) where.set(n.id, n.serverId || (n.self ? (dockerService.getActiveServerId() || 'local') : null)); } catch (e) { /* no mapping */ }
  return ts.sort((a, b) => new Date(b.CreatedAt) - new Date(a.CreatedAt)).slice(0, 200).map(t => ({
    id: t.ID, slot: t.Slot || null, node: host.get(t.NodeID) || (t.NodeID ? t.NodeID.slice(0, 12) : '—'), state: t.Status.State, desired: t.DesiredState,
    serverId: where.get(t.NodeID) || null, containerId: t.Status.ContainerStatus && t.Status.ContainerStatus.ContainerID ? t.Status.ContainerStatus.ContainerID : null,
    message: t.Status.Message || '', error: t.Status.Err || null, exitCode: t.Status.ContainerStatus ? t.Status.ContainerStatus.ExitCode : null,
    container: t.Status.ContainerStatus && t.Status.ContainerStatus.ContainerID ? t.Status.ContainerStatus.ContainerID.slice(0, 12) : null,
    image: String((t.Spec.ContainerSpec || {}).Image || '').split('@')[0], createdAt: t.CreatedAt, updatedAt: t.Status.Timestamp,
  }));
}

/** docker service logs → rows for the log viewer (source = name.slot @ server). */
async function logs(id, { tail = 1000 } = {}) {
  const { c } = await mgr();
  const lim = Math.min(Math.max(parseInt(tail) || 1000, 1), 10000);
  const [s, ts, nodes] = await Promise.all([c.getService(id).inspect(), c.listTasks({ filters: JSON.stringify({ service: [id] }) }), c.listNodes()]);
  const host = new Map(nodes.map(n => [n.ID, n.Description.Hostname]));
  const slot = new Map(ts.map(t => [t.ID, t.Slot ? `${s.Spec.Name}.${t.Slot}` : `${s.Spec.Name}.${(host.get(t.NodeID) || t.NodeID || '').slice(0, 12)}`]));
  const buf = await c.getService(id).logs({ stdout: true, stderr: true, timestamps: true, details: true, tail: lim });
  const text = dockerService.demuxLogs(buf);
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\S+)\s+(\S*com\.docker\.swarm\.\S+)\s?(.*)$/.exec(line);
    if (!m) { if (line.trim()) rows.push({ t: null, msg: line }); continue; }
    const attrs = Object.fromEntries(m[2].split(',').map(x => x.split('=')));
    const task = attrs['com.docker.swarm.task.id'], node = attrs['com.docker.swarm.node.id'];
    rows.push({ t: Date.parse(m[1]) || null, src: `${slot.get(task) || (task || '').slice(0, 12)} @ ${host.get(node) || (node || '').slice(0, 12)}`, msg: m[3] });
  }
  return { rows, service: s.Spec.Name };
}

// ---- changes ----

const auth = (image) => (dockerService.lookupAuthConfig ? dockerService.lookupAuthConfig(String(image || '')) : undefined);
async function writeSpec(c, id, version, spec, query = {}) {
  const a = auth(spec.TaskTemplate.ContainerSpec.Image);
  const opts = { _query: { version, ...query }, _body: spec };
  if (a) opts.authconfig = a;
  try { return await c.getService(id).update(opts); }
  catch (e) { throw Object.assign(new Error(swarm.dockerMsg(e) || e.message), { statusCode: e.statusCode === 404 ? 404 : 400 }); }
}
const audit = (serverId, sourceIp, name, action, details) => logAction({ sourceIp, server: serverId, resourceType: 'swarm-service', resourceName: name, action, details });
function dbGuard(image, replicas, hasVolume, confirmDb) {
  if (replicas > 1 && isDatabase(image) && !confirmDb) throw Object.assign(new Error(`${String(image).split(':')[0]} looks like a database: ${replicas} replicas are ${replicas} separate databases${hasVolume ? ' sharing nothing (each has its own volume on its server)' : ''}, not one database with copies. Use 1 replica unless the image is built for clustering.`), { statusCode: 409, needConfirm: 'database' });
}

async function create(form, { sourceIp } = {}) {
  const { c, serverId } = await mgr();
  const spec = specFromForm(form, null, await idMaps(c));
  const reps = spec.Mode.Replicated ? spec.Mode.Replicated.Replicas : 1;
  dbGuard(spec.TaskTemplate.ContainerSpec.Image, reps, (spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume'), form.confirmDb);
  let r;
  const a = auth(spec.TaskTemplate.ContainerSpec.Image);
  try { r = await c.createService(a ? { ...spec, authconfig: a } : spec); }
  catch (e) { throw Object.assign(new Error(swarm.dockerMsg(e) || e.message), { statusCode: 400 }); }
  audit(serverId, sourceIp, spec.Name, 'swarm_service_create', { image: spec.TaskTemplate.ContainerSpec.Image, mode: modeOf(spec), replicas: reps });
  return { id: r.ID || r.id };
}

async function save(id, form, { sourceIp, version } = {}) {
  const { c, serverId } = await mgr();
  const s = await c.getService(id).inspect();
  if (version && Number(version) !== s.Version.Index) throw Object.assign(new Error('The service changed since the form was opened — open it again'), { statusCode: 409 });
  const spec = specFromForm(form, s.Spec, await idMaps(c));
  const reps = spec.Mode.Replicated ? spec.Mode.Replicated.Replicas : 1;
  dbGuard(spec.TaskTemplate.ContainerSpec.Image, reps, (spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume'), form.confirmDb);
  await writeSpec(c, id, s.Version.Index, spec);
  audit(serverId, sourceIp, s.Spec.Name, 'swarm_service_update', { image: spec.TaskTemplate.ContainerSpec.Image, stack: stackOf(s.Spec) });
  return { ok: true };
}

async function scale(id, replicas, { sourceIp, confirmDb } = {}) {
  const { c, serverId } = await mgr();
  const s = await c.getService(id).inspect();
  if (!s.Spec.Mode.Replicated) throw bad('Only replicated services can be scaled');
  const n = num(replicas, 'Replicas', 0, 1000);
  if (n === undefined) throw bad('Enter the number of replicas');
  dbGuard(s.Spec.TaskTemplate.ContainerSpec.Image, n, (s.Spec.TaskTemplate.ContainerSpec.Mounts || []).some(m => m.Type === 'volume'), confirmDb);
  const spec = JSON.parse(JSON.stringify(s.Spec)); spec.Mode = { Replicated: { Replicas: n } };
  await writeSpec(c, id, s.Version.Index, spec);
  audit(serverId, sourceIp, s.Spec.Name, 'swarm_service_scale', { from: s.Spec.Mode.Replicated.Replicas, to: n });
  return { ok: true };
}

async function setImage(id, image, { sourceIp } = {}) {
  const { c, serverId } = await mgr();
  const s = await c.getService(id).inspect();
  const img = String(image || '').trim();
  if (!img || /\s/.test(img)) throw bad('Enter the image, e.g. nginx:1.27');
  const spec = JSON.parse(JSON.stringify(s.Spec));
  const before = spec.TaskTemplate.ContainerSpec.Image;
  spec.TaskTemplate.ContainerSpec.Image = img;
  spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + (img === String(before).split('@')[0] ? 1 : 0); // same tag: pull it again
  await writeSpec(c, id, s.Version.Index, spec);
  audit(serverId, sourceIp, s.Spec.Name, 'swarm_service_image', { from: String(before).split('@')[0], to: img });
  return { ok: true };
}

/** The stored check result, if it is still about the image the service runs now. */
function imageState(row, image) {
  if (!row) return null;
  const { digest } = require('./swarm-images').splitImage(image);
  if (row.current_digest !== digest) return null; // the service changed since the check
  return { status: row.status, version: row.remote_version, created: row.remote_created, error: row.error, checkedAt: row.checked_at };
}

/** Check the services' images against their registries now (the cluster of the server in use). */
async function checkImages() {
  const { c } = await mgr();
  const st = await swarm.status();
  await require('./swarm-images').check(c, st.clusterId);
  return { services: await list() };
}

/** Update a service to the newest build of its tag: tag@digest from the registry, so every node runs it. */
async function updateToNewest(id, { sourceIp } = {}) {
  const { c } = await mgr();
  const s = await c.getService(id).inspect();
  const SI = require('./swarm-images'); const IU = require('./image-updates');
  const { tagRef, digest } = SI.splitImage(s.Spec.TaskTemplate.ContainerSpec.Image);
  const ref = IU.parseRef(tagRef);
  if (!ref || ref.pinned) throw bad('The service image is not a tag');
  let remote;
  try { remote = await require('./registry-browse').getRemoteDigest(IU.registryFor(ref.host), ref.repo, ref.tag); }
  catch (e) { throw bad(`Registry: ${e.message}`); }
  if (remote === digest) return { ok: true, current: true };
  await setImage(id, `${tagRef}@${remote}`, { sourceIp });
  return { ok: true, digest: remote };
}

async function rollback(id, { sourceIp } = {}) {
  const { c, serverId } = await mgr();
  const s = await c.getService(id).inspect();
  if (!s.PreviousSpec) throw bad('This service has no previous version');
  await writeSpec(c, id, s.Version.Index, s.Spec, { rollback: 'previous' });
  audit(serverId, sourceIp, s.Spec.Name, 'swarm_service_rollback', { to: String(s.PreviousSpec.TaskTemplate.ContainerSpec.Image).split('@')[0] });
  return { ok: true };
}

async function restart(id, { sourceIp } = {}) {
  const { c, serverId } = await mgr();
  const s = await c.getService(id).inspect();
  const spec = JSON.parse(JSON.stringify(s.Spec));
  spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
  await writeSpec(c, id, s.Version.Index, spec);
  audit(serverId, sourceIp, s.Spec.Name, 'swarm_service_restart', {});
  return { ok: true };
}

async function remove(id, { sourceIp } = {}) {
  const { c, serverId } = await mgr();
  const s = await c.getService(id).inspect();
  await c.getService(id).remove();
  audit(serverId, sourceIp, s.Spec.Name, 'swarm_service_remove', { image: String(s.Spec.TaskTemplate.ContainerSpec.Image).split('@')[0], stack: stackOf(s.Spec) });
  return { ok: true, name: s.Spec.Name };
}

/** Live update progress: UpdateStatus + current tasks. */
async function progress(id) {
  const { c } = await mgr();
  const [s, ts, nodes] = await Promise.all([c.getService(id).inspect(), c.listTasks({ filters: JSON.stringify({ service: [id] }) }), c.listNodes()]);
  const host = new Map(nodes.map(n => [n.ID, n.Description.Hostname]));
  return {
    name: s.Spec.Name, image: String(s.Spec.TaskTemplate.ContainerSpec.Image).split('@')[0], update: s.UpdateStatus || null,
    tasks: ts.filter(t => t.DesiredState === 'running' || ['running', 'starting', 'preparing', 'pending', 'assigned', 'accepted', 'ready'].includes(t.Status.State))
      .sort((a, b) => new Date(b.CreatedAt) - new Date(a.CreatedAt)).slice(0, 30)
      .map(t => ({ slot: t.Slot || null, state: t.Status.State, desired: t.DesiredState, node: host.get(t.NodeID) || '', image: String((t.Spec.ContainerSpec || {}).Image || '').split('@')[0], error: t.Status.Err || null })),
  };
}

// ---- CPU and memory per service ----
let statsCache = { at: 0, data: null, server: null };
/**
 * CPU % and memory of every service's running tasks, summed. Read with `docker stats` from each node's DockGate
 * server (a node not in DockGate has no numbers). Cached for 10 s.
 */
async function stats() {
  const { serverId } = await mgr();
  if (statsCache.data && statsCache.server === serverId && Date.now() - statsCache.at < 10000) return statsCache.data;
  const cl = require('./swarm-cluster');
  const ns = await cl.nodes();
  const out = {}; const missing = [];
  await Promise.all(ns.nodes.map(async (n) => {
    const sid = n.serverId || (n.self ? serverId : null);
    if (!sid) { missing.push(n.hostname); return; }
    try {
      const row = sid === 'local' ? null : require('./db').stmts.getServer.get(sid);
      const c = sid === 'local' ? dockerService.createLocalClient() : dockerService.createSshClient(row);
      const list = await c.listContainers({ filters: JSON.stringify({ label: ['com.docker.swarm.service.id'] }) });
      await Promise.all(list.map(async (ct) => {
        const svcId = ct.Labels['com.docker.swarm.service.id'];
        try {
          const st = dockerService.parseStats(await c.getContainer(ct.Id).stats({ stream: false }));
          const o = out[svcId] || (out[svcId] = { cpu: 0, memBytes: 0, tasks: 0, nodes: new Set() });
          o.cpu += st.cpuPercent || 0; o.memBytes += st.memoryUsage || 0; o.tasks++; o.nodes.add(n.hostname);
        } catch (e) { /* the task stopped meanwhile */ }
      }));
    } catch (e) { missing.push(n.hostname); }
  }));
  for (const k of Object.keys(out)) out[k] = { cpu: Math.round(out[k].cpu * 10) / 10, memBytes: out[k].memBytes, tasks: out[k].tasks, nodes: [...out[k].nodes] };
  const data = { services: out, missing };
  statsCache = { at: Date.now(), data, server: serverId };
  return data;
}

module.exports = { checkImages, updateToNewest, writeSpec, stats, list, get, choices, tasks, logs, create, save, scale, setImage, rollback, restart, remove, progress, formFromSpec, specFromForm, newForm, parseDur, fmtDur, parseBytes, splitArgs, isDatabase };

// ---- service history (Services → Graphs): CPU and memory of each service, every 2 minutes, kept 48 hours ----
const { db: hdb } = require('./db');
hdb.exec(`CREATE TABLE IF NOT EXISTS swarm_service_samples (
  cluster_id TEXT NOT NULL, service_id TEXT NOT NULL, t INTEGER NOT NULL, cpu REAL, mem INTEGER, tasks INTEGER
)`);
hdb.exec('CREATE INDEX IF NOT EXISTS swarm_service_samples_idx ON swarm_service_samples (cluster_id, service_id, t)');
const addSample = hdb.prepare('INSERT INTO swarm_service_samples (cluster_id, service_id, t, cpu, mem, tasks) VALUES (?, ?, ?, ?, ?, ?)');
const KEEP_MS = 48 * 3600 * 1000;
let sampleTimer = null, sampling = false;

/** One sample of every service of the swarm the server in use manages (skipped when it is not a manager). */
async function sampleOnce(now = Date.now()) {
  if (sampling) return 0;
  sampling = true;
  try {
    const st = await swarm.status();
    if (st.state !== 'active' || !st.manager || !st.clusterId) return 0;
    statsCache.at = 0; // fresh numbers
    const data = await stats();
    const services = await dockerService.docker.listServices();
    const tx = hdb.transaction(() => {
      for (const s of services) {
        const x = data.services[s.ID] || { cpu: 0, memBytes: 0, tasks: 0 };
        addSample.run(st.clusterId, s.ID, now, x.cpu, x.memBytes, x.tasks);
      }
      hdb.prepare('DELETE FROM swarm_service_samples WHERE t < ?').run(now - KEEP_MS);
    });
    tx();
    return services.length;
  } catch (e) { return 0; } finally { sampling = false; }
}
function startSampler() { if (!sampleTimer) { sampleTimer = setInterval(sampleOnce, 2 * 60 * 1000); if (sampleTimer.unref) sampleTimer.unref(); setTimeout(sampleOnce, 20000).unref?.(); } }

/** Samples of one service for the last `hours` (1–48). */
async function history(id, hours = 6) {
  const st = await swarm.status();
  if (!st.clusterId) throw bad('Swarm is not active');
  const h = Math.min(Math.max(Number(hours) || 6, 1), 48);
  const rows = hdb.prepare('SELECT t, cpu, mem, tasks FROM swarm_service_samples WHERE cluster_id = ? AND service_id = ? AND t >= ? ORDER BY t').all(st.clusterId, id, Date.now() - h * 3600 * 1000);
  return { hours: h, every: 120, samples: rows };
}

module.exports.sampleOnce = sampleOnce;
module.exports.startSampler = startSampler;
module.exports.history = history;
