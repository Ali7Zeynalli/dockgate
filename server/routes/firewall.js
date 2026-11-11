// Firewall routes (Server Console → Firewall), mounted under /api/servers.
// Rules are shown and edited the way cloud firewalls do it: inbound and outbound tables, one rule =
// direction · action · protocol · port · sources/destinations · description. The model lives in
// security/fwmodel.js; this file reads the server, enforces the safety rules and runs the changes.
// DockGate never lets a change cut its own SSH access: such changes run as a lifeline job (backup,
// rollback armed, new SSH login tested, restored on failure).
const express = require('express');
const router = express.Router();
const { db } = require('../db');
const P = require('../security/parse');
const plans = require('../security/plans');
const runner = require('../security/runner');
const IPL = require('../security/iplists');
const FW = require('../security/fwmodel');
const { loadServer, cfgOf, requireConfirm, send, audit, newId, readState, runOrThrow } = require('../security/route-helpers');

db.exec(`CREATE TABLE IF NOT EXISTS fw_rule_desc (
  server_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (server_id, rule_key)
)`);
const descStmts = {
  all: db.prepare('SELECT rule_key, description FROM fw_rule_desc WHERE server_id = ?'),
  set: db.prepare('INSERT INTO fw_rule_desc (server_id, rule_key, description) VALUES (?, ?, ?) ON CONFLICT(server_id, rule_key) DO UPDATE SET description = excluded.description'),
  del: db.prepare('DELETE FROM fw_rule_desc WHERE server_id = ? AND rule_key = ?'),
};

// ---------------------------------------------------------------- read
function parseDefaults(text, backend) {
  if (backend === 'firewalld') return { incoming: 'deny', outgoing: 'allow', routed: null };
  const m = /Default:\s*(\w+)\s*\(incoming\),\s*(\w+)\s*\(outgoing\)(?:,\s*(\w+)\s*\(routed\))?/i.exec(String(text || ''));
  const norm = (v) => (v ? (v.toLowerCase() === 'allow' ? 'allow' : 'deny') : null);
  return m ? { incoming: norm(m[1]), outgoing: norm(m[2]), routed: norm(m[3]) } : { incoming: 'deny', outgoing: 'allow', routed: null };
}

async function firewallOf(row) {
  const sec = await readState(row, plans.READ_FIREWALL);
  const ufw = P.parseUfwNumbered(sec.ufw);
  const firewalld = /running/.test(sec.firewalld || '');
  const fwd = firewalld ? P.parseFirewalld(sec.fwd, sec.fwdsvc) : null;
  const isolation = Number(sec.iso || 0) > 0;
  const t = P.parseSshdT(sec.sshdT);
  const sshPort = t.port[0] || row.port || 22;
  // firewalld wins when it runs and UFW is not active (ufw can be installed on RHEL without being used)
  const backend = ufw.active ? 'ufw' : (firewalld ? 'firewalld' : ((sec.ufwbin || '').trim() ? 'ufw' : 'none'));
  const raw = backend === 'firewalld' ? (fwd ? fwd.rules : []) : ufw.rules;
  const managed = ufw.active || !!(fwd && fwd.active);
  const dockgateIp = IPL.normalizeSource((sec.me || '').trim());
  const lists = IPL.all();
  const { groups, locked } = managed ? FW.groupRules({ backend, rules: raw, lists, dockgateIp }) : { groups: [], locked: [] };
  const desc = Object.fromEntries(descStmts.all.all(row.id).map(d => [d.rule_key, d.description]));
  const listeners = P.parseSs(sec.ss);
  const docker = P.parseDockerPorts(sec.docker);
  const dockerIsolation = backend === 'ufw' && isolation;
  for (const g of groups) {
    g.description = desc[g.key] || '';
    g.isSsh = g.dir === 'in' && !g.container && FW.coversPort(g, sshPort, 'tcp') && g.action !== 'deny';
    g.swarm = g.entries.length > 0 && g.entries.every(e => e.tag === 'swarm'); // added by Swarm (server/swarm-cluster.js)
    if (g.dir === 'in' && g.container) {
      const d = docker.find(x => x.containerPort === g.container && (!g.proto || x.proto === g.proto));
      g.usedBy = d ? `${d.container} (container)` : 'container';
      g.hostPort = d ? d.hostPort : null;
    } else if (g.dir === 'in' && g.port && !g.port.includes('-')) {
      const l = listeners.find(x => x.port === Number(g.port) && (!g.proto || x.proto === g.proto));
      const d = docker.find(x => x.hostPort === Number(g.port));
      g.usedBy = l ? (l.process === 'docker-proxy' && d ? `${d.container} (container)` : l.process || 'listening') : null;
    }
  }
  // listening ports no inbound rule covers (reachable only inside the server) and container ports
  const inbound = groups.filter(g => g.dir === 'in');
  const covered = (port, proto, container) => inbound.some(g => (container ? g.container === port : !g.container && FW.coversPort(g, port, proto)) && g.action !== 'deny');
  const idle = [], bypass = [], seen = new Set();
  for (const d of docker) {
    if (P.isLoopback(d.hostIp)) continue;
    const k = `c${d.containerPort}/${d.proto}`; if (seen.has(k)) continue; seen.add(k);
    if (backend === 'firewalld' || (managed && !dockerIsolation)) bypass.push({ port: d.hostPort, containerPort: d.containerPort, proto: d.proto, usedBy: d.container });
    else if (managed && !covered(d.containerPort, d.proto, true)) idle.push({ port: d.hostPort, containerPort: d.containerPort, proto: d.proto, usedBy: `${d.container} (container)`, container: true });
  }
  for (const l of listeners) {
    if (P.isLoopback(l.bind) || l.process === 'docker-proxy' || docker.some(d => d.hostPort === l.port)) continue;
    const k = `h${l.port}/${l.proto}`; if (seen.has(k)) continue; seen.add(k);
    if (managed && !covered(l.port, l.proto, false)) idle.push({ port: l.port, proto: l.proto, usedBy: l.process || 'unknown', container: false });
  }
  const sortRule = (a, b) => (Number((a.port || '0').split('-')[0]) - Number((b.port || '0').split('-')[0])) || String(a.proto).localeCompare(String(b.proto));
  return {
    backend, active: ufw.active || firewalld, managed, ufwActive: ufw.active, firewalld, zone: fwd ? fwd.zone : null,
    dockerIsolation, isolationSupported: backend === 'ufw', sshPort, dockgateIp,
    ipv6: backend !== 'ufw' || !/^IPV6=no/m.test(sec.ufw6 || ''),
    defaults: parseDefaults(sec.ufwv, backend),
    inbound: inbound.sort(sortRule), outbound: groups.filter(g => g.dir === 'out').sort(sortRule),
    idle: idle.sort((a, b) => a.port - b.port), bypass,
    locked: locked.map(l => ({ n: l.n, reason: l.locked, to: l.raw.to, from: l.raw.from, action: l.raw.action, dir: l.raw.dir })),
    rules: raw, // as the firewall stores them (Advanced)
    _groups: groups, // server side only — stripped before sending
  };
}
// the client gets rules, not the raw entries behind them
const strip = (g) => { const { entries, ...rest } = g; return rest; };
const publicView = (fw) => { const { _groups, ...rest } = fw; return { ...rest, inbound: rest.inbound.map(strip), outbound: rest.outbound.map(strip) }; };

// ---- health check around firewall changes
async function healthOf(row) {
  try {
    const sec = await readState(row, plans.READ_HEALTH);
    const bans = String(sec.f2bbans || '').split('\n').map(Number).filter(n => Number.isFinite(n));
    return { f2bActive: /^active/m.test(sec.f2b || ''), f2bBanned: bans.reduce((a, b) => a + b, 0), containers: Number((sec.docker || '').trim()) || 0 };
  } catch (e) { return null; }
}
/** Human warnings when something changed that a firewall change should not have touched. */
function healthWarnings(before, after) {
  if (!before || !after) return [];
  const w = [];
  if (before.f2bActive && !after.f2bActive) w.push('fail2ban stopped running after this change — start it in the Fail2ban tab.');
  else if (after.f2bBanned < before.f2bBanned) w.push(`fail2ban now holds ${after.f2bBanned} ban(s), it had ${before.f2bBanned} — some bans may have been dropped. Check the Fail2ban tab.`);
  if (after.containers < before.containers) w.push(`${before.containers - after.containers} container(s) stopped running during this change.`);
  return w;
}
async function runFirewallOp(row, plan, title) {
  const before = await healthOf(row);
  await runOrThrow(row, plan, title);
  return healthWarnings(before, await healthOf(row));
}


const requireUfw = (fw) => { if (!fw.ufwActive) throw P.httpError(400, fw.backend === 'firewalld' ? 'This works with UFW only — this server uses firewalld' : 'UFW is not active — turn the firewall on first'); };
const requireManaged = (fw) => { if (!fw.managed) throw P.httpError(400, fw.firewalld ? "firewalld runs but its default zone couldn't be read" : 'The firewall is off — turn it on first'); };

router.get('/:id/firewall', send(async (req) => publicView(await firewallOf(loadServer(req)))));

/**
 * Create, edit or delete one rule.
 *   body: { original: <rule key>|null, rule: { dir, action, proto, port, containers, container, description },
 *           sources: ['any4','any6','@list','1.2.3.4',…] (empty = delete), dryRun }
 */
router.post('/:id/firewall/rule', send(async (req) => {
  const row = loadServer(req);
  const { original, rule, sources, dryRun } = req.body || {};
  if (!Array.isArray(sources) || sources.length > 60) throw P.httpError(400, 'sources must be a list (at most 60 entries — use an IP list for more)');
  const fw = await firewallOf(row);
  requireManaged(fw);
  const lists = IPL.all();
  const old = original ? fw._groups.find(g => g.key === original) : null;
  if (original && !old) throw P.httpError(404, 'This rule changed on the server — refresh the page');
  let want = null;
  if (sources.length) {
    want = FW.normRule(rule || {});
    if (want.dir === 'out' && fw.backend !== 'ufw') throw P.httpError(400, 'Outbound rules need UFW — firewalld filters incoming traffic here');
    if (want.dir === 'in' && want.container) {
      if (!fw.dockerIsolation) throw P.httpError(400, 'Turn on Docker port isolation first — until then every container port is public');
    } else want.container = null;
    if (want.dir === 'out' && want.containers && !fw.dockerIsolation) throw P.httpError(400, 'Rules for containers need Docker port isolation (Firewall → Docker ports) — without it container traffic skips UFW');
    if (want.dir === 'in') want.containers = false;
    want.remotes = FW.expandRemotes(sources, lists, fw.dockgateIp);
    if (want.remotes.length > 1000) throw P.httpError(400, 'At most 1000 addresses per rule');
    if (!fw.ipv6 && want.remotes.some(r => r.remote === 'any6' || (r.remote !== 'any4' && IPL.isV6(r.remote)))) throw P.httpError(400, 'UFW has IPv6 switched off on this server (IPV6=no in /etc/default/ufw) — IPv6 addresses cannot be added. Remove them, or turn IPv6 on in /etc/default/ufw and reload UFW.');
    want.key = FW.ruleKey(want);
    const clash = fw._groups.find(g => g.key === want.key && (!old || g.key !== old.key));
    if (clash) throw P.httpError(400, 'A rule with this direction, action, protocol and port already exists — edit that rule instead');
  } else if (!old) throw P.httpError(400, 'Add at least one source or destination');
  // SSH must stay reachable for DockGate after the change
  const touchesSsh = [old, want].some(g => g && g.dir === 'in' && !g.container && FW.coversPort(g, fw.sshPort, 'tcp'));
  if (touchesSsh) {
    const after = fw._groups.filter(g => !old || g.key !== old.key).concat(want ? [{ ...want, remotes: want.remotes.map(r => r.remote) }] : []);
    if (!fw.dockgateIp && !after.some(g => g.dir === 'in' && !g.container && FW.coversPort(g, fw.sshPort, 'tcp') && g.remotes.includes('any4'))) throw P.httpError(400, "DockGate could not see its own IP on this server, so it cannot check that SSH stays reachable — keep Any IPv4 on the SSH port");
    if (!FW.sshReachable(after, fw.sshPort, fw.dockgateIp, fw.defaults.incoming)) throw P.httpError(400, `After this change DockGate (${fw.dockgateIp}) could no longer reach SSH on port ${fw.sshPort} — keep DockGate's IP, a range that contains it, or Any IPv4`);
  }
  const plan = FW.planChange({ backend: fw.backend, zone: fw.zone, old, want });
  const summary = {
    add: plan.add.map(a => (a.route ? 'containers: ' : '') + a.remote), remove: plan.remove.map(r => (r.route ? 'containers: ' : '') + r.remote),
    commands: plan.cmds, family: want ? FW.familyOf(want.remotes.map(r => r.remote)) : null, ssh: touchesSsh, key: want ? want.key : null,
  };
  const descChanged = want && (want.description || '') !== ((old && old.description) || '');
  if (dryRun) return { ...summary, applied: false };
  const saveDesc = () => {
    if (old && (!want || old.key !== want.key)) descStmts.del.run(row.id, old.key);
    if (want) { if (want.description) descStmts.set.run(row.id, want.key, want.description); else descStmts.del.run(row.id, want.key); }
  };
  if (!plan.cmds.length) { if (descChanged) saveDesc(); return { ...summary, applied: !!descChanged }; }
  const details = { original: original || null, key: summary.key, dir: (want || old).dir, port: (want || old).port, added: plan.add.length, removed: plan.remove.length };
  const title = `${want ? (old ? 'Edit' : 'Add') : 'Delete'} ${(want || old).dir === 'out' ? 'outbound' : 'inbound'} rule`;
  if (touchesSsh) {
    const before = await healthOf(row);
    const jobId = runner.startPlan(cfgOf(row), plans.sourcesLifelinePlan({ id: newId(), backend: fw.backend, zone: fw.zone, cmds: plan.cmds, test: { username: row.username } }), {
      title, successText: `Saved. ${plan.add.length} firewall entr${plan.add.length === 1 ? 'y' : 'ies'} added, ${plan.remove.length} removed. A new SSH login worked.`,
      onSuccess: async () => { saveDesc(); audit(req, row, 'firewall-rule-save', details); return { warnings: healthWarnings(before, await healthOf(row)) }; },
    });
    return { ...summary, jobId };
  }
  const warnings = await runFirewallOp(row, { steps: [{ label: title, cmd: plan.cmds.join(' && ') }] }, 'Firewall');
  saveDesc();
  audit(req, row, 'firewall-rule-save', details);
  return { ...summary, applied: true, warnings };
}));
// Default policy (UFW): what happens to traffic no rule matches.
router.post('/:id/firewall/default', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const { direction, policy } = req.body || {};
  if (!['incoming', 'outgoing'].includes(direction) || !['allow', 'deny'].includes(policy)) throw P.httpError(400, 'direction must be incoming or outgoing, policy allow or deny');
  const fw = await firewallOf(row);
  requireUfw(fw);
  if (direction === 'incoming' && policy === 'deny' && !FW.sshReachable(fw._groups.map(g => ({ ...g })), fw.sshPort, fw.dockgateIp, 'deny')) throw P.httpError(400, `No rule lets DockGate reach SSH on port ${fw.sshPort} — add one before blocking incoming traffic`);
  if (fw.defaults[direction] === policy) return { success: true, unchanged: true };
  const warnings = await runFirewallOp(row, { steps: [{ label: `Default ${direction}: ${policy}`, cmd: `{{S}}ufw default ${policy} ${direction} >/dev/null` }] }, 'Firewall');
  audit(req, row, 'firewall-default', { direction, policy });
  return { success: true, warnings };
}));

// Advanced: delete one raw entry by its number (entries DockGate cannot show as rules).
router.delete('/:id/firewall/rules/:n', send(async (req) => {
  const row = loadServer(req);
  const n = Number(req.params.n);
  const fw = await firewallOf(row);
  requireManaged(fw);
  const rule = fw.rules.find(r => r.n === n);
  if (!rule) throw P.httpError(404, 'Rule not found — refresh the list');
  let removeRules = [rule];
  if (fw.backend === 'firewalld') removeRules = fw.rules.filter(r => r.kind === rule.kind && r.key === rule.key);
  const remaining = fw.rules.filter(r => !removeRules.includes(r));
  const { groups } = FW.groupRules({ backend: fw.backend, rules: remaining, lists: IPL.all(), dockgateIp: fw.dockgateIp });
  if (!FW.sshReachable(groups, fw.sshPort, fw.dockgateIp, fw.defaults.incoming)) throw P.httpError(400, 'This entry keeps SSH reachable for DockGate — it cannot be deleted');
  const cmd = fw.backend === 'firewalld' ? plans.fwdRemoveCmd(fw.zone, removeRules) : plans.deleteRulesCmd([n]);
  const warnings = await runFirewallOp(row, { steps: [{ label: `Delete entry #${n}`, cmd }] }, 'Firewall');
  audit(req, row, 'firewall-entry-delete', { n, to: rule.to, action: rule.action, from: rule.from });
  return { success: true, warnings };
}));

router.post('/:id/firewall/docker-isolation', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const enable = req.body.enable !== false;
  const fw = await firewallOf(row);
  requireUfw(fw);
  const keepPublic = [];
  for (const k of (Array.isArray(req.body.keepPublic) ? req.body.keepPublic : [])) {
    const [port, proto] = String(k).split('/');
    const p = fw.ports.find(x => x.kind === 'container' && x.port === Number(port) && x.proto === proto);
    if (!p) throw P.httpError(400, `${k} is not a published container port`);
    keepPublic.push({ port: p.containerPort, proto: p.proto });
  }
  const plan = plans.isolationPlan({ id: newId(), enable, keepPublic, test: { username: row.username } });
  const before = await healthOf(row);
  const jobId = runner.startPlan(cfgOf(row), plan, {
    title: enable ? 'Docker port isolation' : 'Turn off Docker port isolation',
    successText: enable ? `Isolation is on. Public container ports: ${(req.body.keepPublic || []).join(', ') || 'none'}.` : 'Isolation is off — published container ports bypass UFW again.',
    onSuccess: async () => {
      audit(req, row, 'firewall-docker-isolation', { enable, keepPublic: req.body.keepPublic || [] });
      return { warnings: healthWarnings(before, await healthOf(row)) };
    },
  });
  return { jobId };
}));


// Switch UFW on (lifeline: SSH allowed first, new-login test, auto-off on failure) or off.
router.post('/:id/firewall/ufw', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const fw = await firewallOf(row);
  if (fw.firewalld) throw P.httpError(400, 'This server uses firewalld — UFW and firewalld must not run together. Manage firewalld in Setup → Firewall.');
  if (req.body.enable === false) {
    if (!fw.ufwActive) return { success: true, unchanged: true };
    const warnings = await runFirewallOp(row, { steps: [{ label: 'Switch the firewall off', cmd: plans.UFW_DISABLE }] }, 'Firewall');
    audit(req, row, 'firewall-off', {});
    return { success: true, warnings };
  }
  if (fw.ufwActive) return { success: true, unchanged: true };
  const sshPorts = [...new Set([fw.sshPort, row.port || 22].filter(Boolean))];
  const webPorts = req.body.allowWeb === false ? [] : [80, 443];
  const before = await healthOf(row);
  const jobId = runner.startPlan(cfgOf(row), plans.ufwEnablePlan({ id: newId(), sshPorts, webPorts, test: { username: row.username } }), {
    title: 'Switch the firewall on',
    successText: `The firewall is on. Open from outside: ${[...sshPorts, ...webPorts].map(p => p + '/tcp').join(', ')}. Everything else incoming is blocked.`,
    onSuccess: async () => {
      audit(req, row, 'firewall-on', { sshPorts, webPorts });
      return { warnings: healthWarnings(before, await healthOf(row)) };
    },
  });
  return { jobId };
}));

// Reload UFW from its saved rules (Firewall tab), then check fail2ban + containers survived.
router.post('/:id/firewall/reload', send(async (req) => {
  const row = loadServer(req);
  requireConfirm(req.body);
  const fw = await firewallOf(row);
  requireManaged(fw);
  const fwd = fw.backend === 'firewalld';
  const warnings = await runFirewallOp(row, { steps: [{ label: fwd ? 'Reload firewalld' : 'Reload UFW', cmd: fwd ? plans.FWD_RELOAD : plans.UFW_RELOAD }] }, 'Firewall');
  audit(req, row, 'firewall-reload', {});
  return { success: true, warnings };
}));


module.exports = router;
module.exports.firewallOf = firewallOf; // used by Swarm (server/swarm-cluster.js) to open the cluster ports
module.exports._test = { parseDefaults, firewallOf };
