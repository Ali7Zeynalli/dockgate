// Server Console > System API (server/sysconf.js). Mounted under /api/servers. Changes run as security plans;
// the page polls /api/servers/:id/jobs/:jobId (routes/security.js) for their steps.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const { decrypt } = require('../auth/secrets');
const paths = require('../paths');
const runner = require('../security/runner');
const X = require('../sysconf');

function loadServer(req) {
  const row = stmts.getServer.get(req.params.id);
  if (!row) throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  if (row.id === 'local' || row.type === 'local') throw Object.assign(new Error('System settings are managed on remote servers (over SSH)'), { statusCode: 400 });
  return row;
}
const cfgOf = (row) => ({ ...row, keyPath: row.key_path ? paths.keyPath(row.key_path) : null, password: decrypt(row.password), passphrase: decrypt(row.passphrase) });
const send = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message, code: e.code }); }
};
const audit = (req, row, action, details) => logAction({ req, server: row.id, resourceType: 'system', resourceName: row.name || row.id, action, details });
async function current(row) { return X.parseRead(await runner.read(cfgOf(row), X.READ)); }
// preview -> { before, after } (the file as it is and as it would be); otherwise start the plan -> { jobId }
function start(req, row, plan, title, action, details, onSuccess) {
  const jobId = runner.startPlan(cfgOf(row), plan, {
    title, successText: `${title}: done.`,
    onSuccess: async () => { audit(req, row, action, details); if (onSuccess) await onSuccess(); },
    onFailure: () => audit(req, row, `${action}_failed`, details),
  });
  return { jobId };
}

router.get('/:id/system', send(async (req) => ({ ...(await current(loadServer(req))), catalog: X.CATALOG })));

router.post('/:id/system/hostname', send(async (req) => {
  const row = loadServer(req); const cur = await current(row);
  const name = String((req.body || {}).hostname || '').trim();
  return start(req, row, X.hostnamePlan(name, cur.hostsText), `Hostname -> ${name}`, 'system_hostname', { from: cur.hostname, to: name });
}));
router.post('/:id/system/hosts', send(async (req) => {
  const row = loadServer(req); const cur = await current(row);
  const r = X.hostsPlan((req.body || {}).rows || [], cur.hostsText);
  if ((req.body || {}).preview) return { before: cur.hostsText.replace(/\n*$/, '\n'), after: r.text };
  return start(req, row, r.plan, 'Update /etc/hosts', 'system_hosts', { rows: ((req.body || {}).rows || []).length });
}));
router.post('/:id/system/dns', send(async (req) => {
  const row = loadServer(req); const cur = await current(row);
  const b = req.body || {};
  const r = X.dnsPlan({ servers: b.servers, domains: b.domains, resolved: cur.dns.resolved, resolvLink: cur.dns.resolvLink, testName: b.testName || 'cloudflare.com' });
  if (b.preview) return { file: r.file, before: cur.dns.resolved ? Object.entries(cur.dns.drop).map(([k, v]) => `${k}=${v}`).join('\n') : cur.dns.resolv, after: r.text };
  return start(req, row, r.plan, 'DNS servers', 'system_dns', { servers: b.servers });
}));
router.post('/:id/system/sysctl', send(async (req) => {
  const row = loadServer(req);
  const r = X.sysctlPlan((req.body || {}).values || {});
  if ((req.body || {}).preview) { const cur = await current(row); return { before: Object.entries(cur.sysctlDrop).map(([k, v]) => `${k} = ${v}`).join('\n'), after: r.text }; }
  return start(req, row, r.plan, 'Kernel settings', 'system_sysctl', (req.body || {}).values);
}));
router.post('/:id/system/nofile', send(async (req) => {
  const row = loadServer(req); const n = (req.body || {}).nofile;
  return start(req, row, X.nofilePlan(n), `Open files -> ${n}`, 'system_nofile', { nofile: n });
}));
router.post('/:id/system/journald', send(async (req) => {
  const row = loadServer(req); const m = (req.body || {}).maxUse;
  return start(req, row, X.journaldPlan(m), `Journal size -> ${m}`, 'system_journald', { maxUse: m });
}));
// body { iface, dhcp, addresses[], gateway, dns[], mtu, newSshIp?, preview }
router.post('/:id/system/network', send(async (req) => {
  const row = loadServer(req); const cur = await current(row);
  const b = req.body || {};
  const stack = cur.net.stack.includes('netplan') ? 'netplan' : cur.net.stack.includes('nm') ? 'nm' : null;
  const newSshIp = b.newSshIp ? String(b.newSshIp).trim() : null;
  if (newSshIp && !require('net').isIP(newSshIp)) throw Object.assign(new Error('New address for DockGate: an IP address'), { statusCode: 400 });
  const id = crypto.randomBytes(4).toString('hex');
  // DockGate's address matters only for the interface that holds it
  const holds = cur.net.interfaces.some(i => i.name === b.iface && i.v4.some(a => a.ip === cur.net.sshServerIp));
  const r = X.networkPlan({ ...b, stack, sshIp: holds ? cur.net.sshServerIp : null }, { id, test: { username: row.username, ...(newSshIp ? { host: newSshIp } : {}) } });
  if (b.preview) return { stack, file: stack === 'netplan' ? X.F.netplan : 'NetworkManager connection', before: stack === 'netplan' ? ((cur.net.netplanFiles.find(f => f.path === X.F.netplan) || {}).text || '') : '', after: r.text || '(nmcli connection modify ...)' };
  return start(req, row, r.plan, `Network: ${b.iface}`, 'system_network', { iface: b.iface, dhcp: !!b.dhcp, addresses: b.addresses, gateway: b.gateway, newSshIp }, async () => {
    if (newSshIp && newSshIp !== row.host) { require('../db').db.prepare('UPDATE servers SET host = ? WHERE id = ?').run(newSshIp, row.id); try { require('../security/service').refreshConnections(row.id); } catch (e) { /* next request reconnects */ } }
  });
}));
// body { action: 'set', path?, sizeMb? } | { action: 'remove', path } | { action: 'swappiness', value }
router.post('/:id/system/swap', send(async (req) => {
  const row = loadServer(req); const cur = await current(row);
  const b = req.body || {};
  if (b.action === 'swappiness') {
    const v = require('../swap').checkSwappiness(b.value);
    const values = Object.fromEntries(Object.entries(cur.sysctlDrop).filter(([k]) => X.SYSCTL_INFO[k]));
    values['vm.swappiness'] = String(v);
    const r = X.sysctlPlan(values);
    if (b.preview) return { file: X.F.sysctl, before: Object.entries(cur.sysctlDrop).map(([k, val]) => `${k} = ${val}`).join('\n'), after: r.text };
    return start(req, row, r.plan, `Swappiness -> ${v}`, 'system_swappiness', { value: v });
  }
  const plan = X.swapPlan(b, cur.swap);
  const title = b.action === 'remove' ? `Remove swap ${b.path}` : `Swap ${b.path || '/swapfile'} -> ${b.sizeMb || require('../swap').DEFAULT_MB} MB`;
  return start(req, row, plan, title, 'system_swap', { action: b.action, path: b.path || '/swapfile', sizeMb: b.sizeMb });
}));
// body { action: 'add'|'remove', entry? | index+raw, preview }
router.post('/:id/system/fstab', send(async (req) => {
  const row = loadServer(req); const cur = await current(row);
  const b = req.body || {};
  const r = X.fstabPlan(b, cur.fstabText);
  if (b.preview) return { before: cur.fstabText.replace(/\n*$/, '\n'), after: r.text };
  return start(req, row, r.plan, b.action === 'add' ? `Mount ${b.entry && b.entry.target}` : 'Remove a mount from /etc/fstab', 'system_fstab', { action: b.action, entry: b.entry, raw: b.raw });
}));

module.exports = router;
