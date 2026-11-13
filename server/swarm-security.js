// Is a service as well protected on Swarm as it was in Compose (and back)? A security profile is read from a
// compose / stack service, or from a running container, and two profiles are compared field by field:
// same, changed, or weaker. Swarm's stack file drops security_opt; DockGate puts no-new-privileges and the seccomp
// / AppArmor mode back on the Swarm service itself (Docker 25+, API 1.44), so the usual hardening is kept.
const fs = require('fs');
const path = require('path');

const capList = (l) => [...new Set((l || []).map(c => String(c).toUpperCase().replace(/^CAP_/, '')))].sort();
const kindOf = (v) => (!v || v === 'default' || v === 'docker-default' ? 'default' : v === 'unconfined' || v === 'disabled' ? 'unconfined' : 'custom');

/** security_opt entries → { noNewPrivileges, seccomp: { kind, value }, apparmor: { kind, value } } */
function parseSecurityOpt(list) {
  const out = { noNewPrivileges: false, seccomp: { kind: 'default', value: null }, apparmor: { kind: 'default', value: null } };
  for (const o of list || []) {
    const s = String(o);
    if (/^no-new-privileges([:=]true)?$/i.test(s)) out.noNewPrivileges = true;
    const sc = /^seccomp[:=](.+)$/i.exec(s); if (sc) out.seccomp = { kind: kindOf(sc[1]), value: sc[1] };
    const aa = /^apparmor[:=](.+)$/i.exec(s); if (aa) out.apparmor = { kind: kindOf(aa[1]), value: aa[1] };
  }
  return out;
}

/**
 * The profile of a compose service, or (onSwarm) of a service in a stack file — both in compose format. In Compose a
 * port is open on its host_ip (0.0.0.0 without one; `docker compose config` writes mode: ingress anyway); on Swarm
 * an ingress port answers on every server.
 */
function profileOfService(s = {}, { onSwarm = false } = {}) {
  const sec = parseSecurityOpt(s.security_opt);
  return {
    user: String(s.user || ''), readOnly: !!s.read_only, capAdd: capList(s.cap_add), capDrop: capList(s.cap_drop),
    noNewPrivileges: sec.noNewPrivileges, seccomp: sec.seccomp.kind, apparmor: sec.apparmor.kind,
    privileged: !!s.privileged, pidHost: s.pid === 'host', ipcHost: s.ipc === 'host', userns: String(s.userns_mode || ''),
    mounts: (s.volumes || []).filter(v => v && (v.type === 'bind' || v.type === 'volume')).map(v => ({ target: v.target, rw: !v.read_only })),
    ports: (s.ports || []).filter(p => p && p.published !== undefined && p.published !== '' && p.published !== null)
      .map(p => ({ port: Number(p.published), proto: p.protocol || 'tcp', ip: onSwarm ? (p.mode === 'host' ? '0.0.0.0' : 'every server') : (p.host_ip || '0.0.0.0') })),
  };
}

/**
 * The profile of a running container. ports: pass the published ports of a Swarm service (a task container has
 * none of its own); otherwise its port bindings are used.
 */
function profileOfContainer(ct, ports = null) {
  const h = ct.HostConfig || {};
  const sec = parseSecurityOpt(h.SecurityOpt);
  const aa = ct.AppArmorProfile !== undefined && ct.AppArmorProfile !== '' ? kindOf(ct.AppArmorProfile) : sec.apparmor.kind;
  const own = [];
  for (const [k, binds] of Object.entries(h.PortBindings || {})) {
    const [port, proto] = k.split('/');
    for (const b of binds || []) own.push({ port: Number(b.HostPort || port), proto: proto || 'tcp', ip: b.HostIp || '0.0.0.0' });
  }
  return {
    user: String((ct.Config || {}).User || ''), readOnly: !!h.ReadonlyRootfs, capAdd: capList(h.CapAdd), capDrop: capList(h.CapDrop),
    noNewPrivileges: sec.noNewPrivileges, seccomp: sec.seccomp.kind, apparmor: aa,
    privileged: !!h.Privileged, pidHost: h.PidMode === 'host', ipcHost: h.IpcMode === 'host', userns: String(h.UsernsMode || ''),
    mounts: (ct.Mounts || []).filter(m => m.Type === 'bind' || m.Type === 'volume').map(m => ({ target: m.Destination, rw: !!m.RW })),
    ports: ports || own,
  };
}

/** Ports a stack service publishes, from its live spec (for profileOfContainer of a task). */
function portsOfServiceSpec(svc) {
  return (((svc.Spec || {}).EndpointSpec || {}).Ports || []).filter(p => p.PublishedPort)
    .map(p => ({ port: p.PublishedPort, proto: p.Protocol || 'tcp', ip: p.PublishMode === 'host' ? '0.0.0.0' : 'every server' }));
}

const isRoot = (u) => !u || /^(root|0)(:.*)?$/.test(u);
// Weaker: a port tied to one address now open on all of them. 0.0.0.0 → every server is how Swarm ingress works:
// a change (the other servers of the cluster answer too; Swarm → Firewall decides who reaches them), not weaker.
const specific = (ip) => ip !== '0.0.0.0' && ip !== 'every server' && ip !== '::';
const wider = (a, b) => a !== b && specific(a) && !specific(b);

/** Field-by-field comparison → [{ field, before, after, verdict: 'same'|'changed'|'weaker', why }] */
function compareProfiles(a, b) {
  const rows = [];
  const row = (field, before, after, verdict, why) => rows.push({ field, before, after, verdict, why: why || '' });
  const yes = (v) => (v ? 'yes' : 'no');
  row('user', a.user || 'root (image default)', b.user || 'root (image default)', a.user === b.user ? 'same' : !isRoot(a.user) && isRoot(b.user) ? 'weaker' : 'changed', !isRoot(a.user) && isRoot(b.user) ? 'it would run as root' : '');
  row('read-only file system', yes(a.readOnly), yes(b.readOnly), a.readOnly === b.readOnly ? 'same' : a.readOnly ? 'weaker' : 'changed', a.readOnly && !b.readOnly ? 'it could write to its own file system' : '');
  row('no-new-privileges', yes(a.noNewPrivileges), yes(b.noNewPrivileges), a.noNewPrivileges === b.noNewPrivileges ? 'same' : a.noNewPrivileges ? 'weaker' : 'changed', a.noNewPrivileges && !b.noNewPrivileges ? 'a process could gain rights (setuid)' : '');
  const lvl = { custom: 2, default: 1, unconfined: 0 };
  for (const [k, label] of [['seccomp', 'seccomp'], ['apparmor', 'AppArmor']]) {
    const v = a[k] === b[k] ? 'same' : lvl[b[k]] < lvl[a[k]] ? 'weaker' : 'changed';
    row(label, a[k], b[k], v, v === 'weaker' ? (b[k] === 'unconfined' ? 'no filter at all' : 'its own profile would be replaced by Docker\'s default') : '');
  }
  // privileged had every capability: the ones cap_add gives instead are not more than before
  const lost = a.capDrop.filter(c => !b.capDrop.includes(c)), gained = a.privileged ? [] : b.capAdd.filter(c => !a.capAdd.includes(c));
  row('dropped capabilities', a.capDrop.join(', ') || '—', b.capDrop.join(', ') || '—', lost.length ? 'weaker' : a.capDrop.join() === b.capDrop.join() ? 'same' : 'changed', lost.length ? `it would keep ${lost.join(', ')}` : '');
  row('added capabilities', a.capAdd.join(', ') || '—', b.capAdd.join(', ') || '—', gained.length ? 'weaker' : a.capAdd.join() === b.capAdd.join() ? 'same' : 'changed', gained.length ? `it would also get ${gained.join(', ')}` : '');
  row('privileged', yes(a.privileged), yes(b.privileged), a.privileged === b.privileged ? 'same' : b.privileged ? 'weaker' : 'changed');
  row('host PID namespace', yes(a.pidHost), yes(b.pidHost), a.pidHost === b.pidHost ? 'same' : b.pidHost ? 'weaker' : 'changed', !b.pidHost && a.pidHost ? 'it no longer sees the server\'s processes (more isolated; check the app still works)' : '');
  row('host IPC namespace', yes(a.ipcHost), yes(b.ipcHost), a.ipcHost === b.ipcHost ? 'same' : b.ipcHost ? 'weaker' : 'changed', !b.ipcHost && a.ipcHost ? 'more isolated; check the app still works' : '');
  row('user namespace', a.userns || 'default', b.userns || 'default', a.userns === b.userns ? 'same' : a.userns && !b.userns ? 'weaker' : 'changed', a.userns && !b.userns ? 'root in the container would be root on the server' : '');
  const mb = Object.fromEntries(b.mounts.map(m => [m.target, m]));
  const rwNow = a.mounts.filter(m => !m.rw && mb[m.target] && mb[m.target].rw).map(m => m.target);
  const newMounts = b.mounts.filter(m => !a.mounts.some(x => x.target === m.target)).map(m => m.target);
  row('mounts', a.mounts.map(m => `${m.target}${m.rw ? '' : ' (ro)'}`).join(', ') || '—', b.mounts.map(m => `${m.target}${m.rw ? '' : ' (ro)'}`).join(', ') || '—',
    rwNow.length ? 'weaker' : newMounts.length ? 'changed' : 'same', rwNow.length ? `writable now: ${rwNow.join(', ')}` : newMounts.length ? `new: ${newMounts.join(', ')}` : '');
  const key = (p) => `${p.port}/${p.proto}`;
  const pa = Object.fromEntries(a.ports.map(p => [key(p), p.ip])), pb = Object.fromEntries(b.ports.map(p => [key(p), p.ip]));
  const opened = Object.keys(pb).filter(k => !(k in pa)), widened = Object.keys(pb).filter(k => k in pa && wider(pa[k], pb[k]));
  const fmt = (m) => Object.entries(m).map(([k, ip]) => `${ip}:${k}`).join(', ') || '—';
  row('published ports', fmt(pa), fmt(pb), opened.length || widened.length ? 'weaker' : JSON.stringify(pa) === JSON.stringify(pb) ? 'same' : 'changed',
    [opened.length ? `newly open: ${opened.join(', ')}` : '', widened.length ? `reachable more widely: ${widened.map(k => `${k} (${pa[k]} → ${pb[k]})`).join(', ')}` : '',
      Object.keys(pb).some(k => pa[k] === '0.0.0.0' && pb[k] === 'every server') ? 'Swarm ingress: every server of the cluster answers on it' : ''].filter(Boolean).join('; '));
  return rows;
}

/**
 * What DockGate sets on the Swarm service so the hardening of the compose service is kept:
 * { privileges (Docker API ContainerSpec.Privileges) | null, kept: [labels], lost: [labels] }.
 * readFile(p) reads a seccomp profile next to the compose files (local or over SSH); without it a custom profile is lost.
 */
async function privilegesFor(s, { cwd = null, readFile = null } = {}) {
  const sec = parseSecurityOpt(s.security_opt);
  const p = {}, kept = [], lost = [];
  if (sec.noNewPrivileges) { p.NoNewPrivileges = true; kept.push('no-new-privileges'); }
  if (sec.seccomp.kind === 'unconfined') { p.Seccomp = { Mode: 'unconfined' }; kept.push('seccomp unconfined'); }
  else if (sec.seccomp.kind === 'custom') {
    const file = cwd && !path.isAbsolute(sec.seccomp.value) ? path.posix.join(cwd, sec.seccomp.value) : sec.seccomp.value;
    let text = null;
    try { text = readFile ? await readFile(file) : fs.readFileSync(file, 'utf8'); JSON.parse(text); } catch (e) { text = null; }
    if (text) { p.Seccomp = { Mode: 'custom', Profile: text }; kept.push(`seccomp profile ${sec.seccomp.value}`); } else lost.push(`seccomp profile ${sec.seccomp.value} (not readable)`);
  }
  if (sec.apparmor.kind === 'unconfined') { p.AppArmor = { Mode: 'disabled' }; kept.push('AppArmor unconfined'); }
  else if (sec.apparmor.kind === 'custom') lost.push(`AppArmor profile ${sec.apparmor.value} (Swarm has only Docker's default)`);
  return { privileges: Object.keys(p).length ? p : null, kept, lost };
}

/** The profile a service will have on Swarm: its stack-file form, plus what DockGate sets on the service. */
function predictOnSwarm(stackSvc, kept = {}) {
  const prof = profileOfService(stackSvc, { onSwarm: true });
  if (kept.privileges) {
    if (kept.privileges.NoNewPrivileges) prof.noNewPrivileges = true;
    if (kept.privileges.Seccomp) prof.seccomp = kindOf(kept.privileges.Seccomp.Mode);
    if (kept.privileges.AppArmor) prof.apparmor = kindOf(kept.privileges.AppArmor.Mode);
  }
  return prof;
}

const weakerRows = (rows) => rows.filter(r => r.verdict === 'weaker');

module.exports = { parseSecurityOpt, profileOfService, profileOfContainer, portsOfServiceSpec, compareProfiles, privilegesFor, predictOnSwarm, weakerRows };
