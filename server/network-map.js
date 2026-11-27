// Resources > Networks > a network's page: what is on it and how it got there, and whether that matches the compose
// files. Two pure parts (tested without Docker):
//   describe(net, containers): the network (driver, subnets, options) and every container on it with its addresses,
//     aliases, published ports, and the compose project and service it belongs to. Containers that are stopped are
//     listed too (Docker keeps their place on the network).
//   compare(desc, configs): for every compose project on the network (or the one that made it), the project's
//     `docker compose config` against what is live: containers attached by hand, services that should be on it and
//     are not, aliases and fixed addresses that differ, services no longer in the file, and a network whose settings
//     in the file differ from the live one (Compose can not change a network in place).
// Routes (server/routes/networks.js) read Docker and run `docker compose config`; the fixes are existing actions
// (disconnect, compose up).

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';
const NETKEY = 'com.docker.compose.network';
const FILES = 'com.docker.compose.project.config_files';
const WORKDIR = 'com.docker.compose.project.working_dir';

const nameOf = (c) => String((c.Names || [])[0] || c.Name || c.Id || '').replace(/^\//, '');
const shortAliases = (list, c) => (list || []).filter(a => a && a !== nameOf(c) && !String(c.Id || '').startsWith(a));

/** The network and its members. `containers` is docker's container list (all: true), optionally with `inspect`. */
function describe(net, containers) {
  const labels = net.Labels || {};
  const ipam = (net.IPAM && net.IPAM.Config) || [];
  const members = [];
  for (const c of containers || []) {
    const nets = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
    const key = Object.keys(nets).find(k => k === net.Name || (nets[k] && nets[k].NetworkID === net.Id));
    if (!key) continue;
    const n = nets[key] || {};
    const live = (net.Containers || {})[c.Id] || {};
    const ins = c.inspect && c.inspect.NetworkSettings && c.inspect.NetworkSettings.Networks && c.inspect.NetworkSettings.Networks[key];
    const L = c.Labels || {};
    const cfgIp = ((ins || n).IPAMConfig || {}) || {};
    members.push({
      id: c.Id, name: nameOf(c), state: c.State || '', image: c.Image || '',
      ipv4: n.IPAddress || String(live.IPv4Address || '').split('/')[0] || '',
      ipv6: n.GlobalIPv6Address || String(live.IPv6Address || '').split('/')[0] || '',
      mac: n.MacAddress || live.MacAddress || '',
      fixedIp: cfgIp.IPv4Address || '',
      aliases: [...new Set(shortAliases([...((ins && ins.Aliases) || n.Aliases || []), ...((ins && ins.DNSNames) || n.DNSNames || [])], c))],
      ports: (c.Ports || []).filter(p => p.PublicPort).map(p => ({ host: p.PublicPort, port: p.PrivatePort, proto: p.Type, ip: p.IP || '' }))
        .filter((p, i, a) => a.findIndex(x => x.host === p.host && x.proto === p.proto) === i),
      project: L[PROJECT] || null, service: L[SERVICE] || null,
      files: L[FILES] || null, workdir: L[WORKDIR] || null,
    });
  }
  members.sort((a, b) => (!a.project - !b.project) || String(a.project || '').localeCompare(String(b.project || '')) || a.name.localeCompare(b.name));
  const definedBy = labels[PROJECT] ? { project: labels[PROJECT], key: labels[NETKEY] || null } : null;
  const projects = [...new Set([definedBy && definedBy.project, ...members.map(m => m.project)].filter(Boolean))];
  const builtIn = ['bridge', 'host', 'none', 'ingress', 'docker_gwbridge'].includes(net.Name) || !!net.Ingress;
  return {
    id: net.Id, name: net.Name, driver: net.Driver, scope: net.Scope, created: net.Created,
    internal: !!net.Internal, attachable: !!net.Attachable, ipv6: !!net.EnableIPv6, builtIn,
    subnets: ipam.map(x => ({ subnet: x.Subnet || '', gateway: x.Gateway || '', range: x.IPRange || '' })),
    options: net.Options || {}, labels,
    definedBy, projects, members,
    standalone: members.filter(m => !m.project).map(m => m.name),
  };
}

/** The networks a service is on in `docker compose config` JSON: { key: { aliases, ipv4 } }, {} with network_mode. */
function serviceNets(svc) {
  if (!svc || svc.network_mode) return {};
  const n = svc.networks;
  if (!n) return { default: {} };
  if (Array.isArray(n)) return Object.fromEntries(n.map(k => [k, {}]));
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, { aliases: (v && v.aliases) || [], ipv4: (v && v.ipv4_address) || '' }]));
}

/**
 * desc: describe(...). configs: { project: { config } | { error, files } }. others: the containers that are not on this
 * network ({ name, project, service, state }), to find those that should be. Returns { projects, findings, clean }.
 * A finding: { level: crit | warn | info, kind, project, service?, container?, text, fix? }, fix one of
 *   { action: 'disconnect', container }, { action: 'up', project }, { action: 'up-orphans', project },
 *   { action: 'recreate', project, service } (compose up does not touch a running container whose aliases drifted).
 */
function compare(desc, configs, others = []) {
  const findings = [], projects = [];
  const add = (f) => findings.push(f);
  for (const p of desc.projects) {
    const got = configs[p] || {};
    const live = desc.members.filter(m => m.project === p);
    const info = { project: p, files: got.files || null, source: got.source || null, error: got.error || null, key: null, external: false, services: [] };
    projects.push(info);
    if (!got.config) {
      add({ level: 'info', kind: 'no-file', project: p, text: `${p}: its compose file could not be read, so it is not compared${got.error ? ` (${got.error})` : ''}.` });
      continue;
    }
    const cfg = got.config;
    const nets = cfg.networks || {};
    const key = Object.keys(nets).find(k => (nets[k] && (nets[k].name || `${cfg.name || p}_${k}`)) === desc.name) || null;
    info.key = key; info.external = !!(key && nets[key].external);
    const services = cfg.services || {};
    for (const [sname, svc] of Object.entries(services)) {
      const on = key ? serviceNets(svc)[key] : null;
      const ctrs = live.filter(m => m.service === sname);
      if (on) info.services.push(sname);
      if (on && !ctrs.length) {
        if (!others.some(o => o.project === p && o.service === sname && o.state === 'running')) add({ level: 'info', kind: 'not-running', project: p, service: sname, text: `${p} / ${sname} is on this network in the file, but has no container now.`, fix: { action: 'up', project: p } });
        continue;
      }
      for (const m of ctrs) {
        if (!on) {
          add({ level: 'warn', kind: 'manual', project: p, service: sname, container: m.name, text: `${m.name} is on this network, but ${sname} in ${p}'s compose file does not list it: it was connected by hand (or the file changed). The next compose up leaves it as it is, a new container is made without it.`, fix: { action: 'disconnect', container: m.name } });
          continue;
        }
        const missing = (on.aliases || []).filter(a => !m.aliases.includes(a));
        if (missing.length && m.state === 'running') add({ level: 'warn', kind: 'alias', project: p, service: sname, container: m.name, text: `${m.name} should answer to ${missing.join(', ')} on this network (the file), but does not. Other containers that use that name can not reach it.`, fix: { action: 'recreate', project: p, service: sname } });
        if (on.ipv4 && m.ipv4 && on.ipv4 !== m.ipv4 && m.state === 'running') add({ level: 'warn', kind: 'ip', project: p, service: sname, container: m.name, text: `${m.name} has ${m.ipv4} here, the file fixes it to ${on.ipv4}.`, fix: { action: 'recreate', project: p, service: sname } });
      }
    }
    // the service is on the network in the file but its running container is not
    for (const sname of info.services) {
      for (const c of others.filter(o => o.project === p).filter(o => o.service === sname && o.state === 'running')) {
        add({ level: 'crit', kind: 'missing', project: p, service: sname, container: c.name, text: `${c.name} (${p} / ${sname}) should be on this network (the file), but is not: it can not reach the others here.`, fix: { action: 'up', project: p } });
      }
    }
    for (const m of live.filter(x => x.service && !services[x.service])) {
      add({ level: 'warn', kind: 'orphan', project: p, service: m.service, container: m.name, text: `${m.name}: its service ${m.service} is no longer in ${p}'s compose file. It stays on this network until it is removed.`, fix: { action: 'up-orphans', project: p } });
    }
    if (desc.definedBy && desc.definedBy.project === p && !key) {
      add({ level: 'warn', kind: 'gone-from-file', project: p, text: `${p} made this network, but its compose file no longer has it.${desc.members.length ? '' : ' Nothing uses it: it can be removed.'}` });
    }
    if (key && !info.external && desc.definedBy && desc.definedBy.project === p) {
      const want = nets[key] || {};
      const diffs = [];
      if ((want.driver || 'bridge') !== desc.driver) diffs.push(`driver ${want.driver || 'bridge'} in the file, ${desc.driver} live`);
      if (!!want.internal !== desc.internal) diffs.push(`internal ${want.internal ? 'on' : 'off'} in the file, ${desc.internal ? 'on' : 'off'} live`);
      if (!!want.enable_ipv6 !== desc.ipv6 && want.enable_ipv6 !== undefined) diffs.push(`IPv6 ${want.enable_ipv6 ? 'on' : 'off'} in the file, ${desc.ipv6 ? 'on' : 'off'} live`);
      const wantSub = ((want.ipam && want.ipam.config) || []).map(x => x.subnet).filter(Boolean);
      const liveSub = desc.subnets.map(s => s.subnet);
      if (wantSub.length && wantSub.some(s => !liveSub.includes(s))) diffs.push(`subnet ${wantSub.join(', ')} in the file, ${liveSub.join(', ') || 'none'} live`);
      if (diffs.length) add({ level: 'warn', kind: 'definition', project: p, text: `The network in ${p}'s file differs from the live one: ${diffs.join('; ')}. Compose can not change a network in place: compose down and up makes it again (the containers stop for that time).` });
    }
  }
  for (const name of desc.standalone) add({ level: 'info', kind: 'standalone', container: name, text: `${name} was started without a compose file (docker run or by hand), so no file says it belongs here.` });
  if (!desc.projects.length && !desc.members.length && !desc.builtIn) add({ level: 'info', kind: 'unused', text: 'No container uses this network and no compose project made it. It can be removed.' });
  const order = { crit: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { projects, findings, clean: !findings.some(f => f.level !== 'info') };
}

module.exports = { describe, compare, serviceNets, LABELS: { PROJECT, SERVICE, NETKEY, FILES, WORKDIR } };
