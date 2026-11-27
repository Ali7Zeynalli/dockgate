// Honeypot bans shared with every server (server/honeypot-fleet.js). Mounted under /api/fleet-bans.
const express = require('express');
const router = express.Router();
const { stmts } = require('../db');
const { logAction } = require('../audit');
const paths = require('../paths');
const { decrypt } = require('../auth/secrets');
const runner = require('../security/runner');
const FB = require('../honeypot-fleet');

const send = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
};
const audit = (req, action, details, server = 'local') => logAction({ req, server, resourceType: 'security', resourceName: 'fleet-bans', action, details });
const cfgOf = (row) => ({ ...row, keyPath: row.key_path ? paths.keyPath(row.key_path) : null, password: decrypt(row.password), passphrase: decrypt(row.passphrase) });
function loadServer(id) {
  const row = stmts.getServer.get(id);
  if (!row || row.id === 'local' || row.type === 'local') throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  return row;
}

router.get('/', send(async () => FB.status()));

// body { enabled?, allow? }
router.put('/', send(async (req) => {
  const b = req.body || {};
  const st = FB.saveSettings(b);
  audit(req, 'fleet-bans-settings', { enabled: st.enabled, allow: st.allow.length });
  if (st.enabled) FB.sync().catch(() => {});
  return FB.status();
}));

// body { share?, receive? }. Turning receiving on or off installs or removes the jail on that server (a job).
router.put('/servers/:id', send(async (req) => {
  const row = loadServer(req.params.id);
  const b = req.body || {};
  const before = FB.flagsOf(row.id);
  FB.setFlags(row.id, { share: b.share, receive: b.receive });
  let jobId = null;
  if (b.receive !== undefined && !!b.receive !== !!before.receive) {
    const on = !!b.receive;
    jobId = runner.startPlan(cfgOf(row), on ? FB.receivePlan() : FB.stopReceivingPlan(), {
      title: on ? 'Receive bans from other servers' : 'Stop receiving bans from other servers',
      successText: on ? 'This server now bans what the honeypots of your other servers catch. The first addresses arrive with the next sync.' : 'The bans from other servers ended here.',
      onSuccess: () => { FB.q.setInstalled.run(on ? 1 : 0, row.id); audit(req, on ? 'fleet-bans-receive-on' : 'fleet-bans-receive-off', {}, row.id); if (on) FB.sync().catch(() => {}); },
      onFailure: () => { if (on) FB.setFlags(row.id, { receive: false }); },
    });
  } else audit(req, 'fleet-bans-server', { share: b.share }, row.id);
  return { jobId, status: FB.status() };
}));

router.post('/sync', send(async () => ({ result: await FB.sync(), status: FB.status() })));

// body { ip }
router.post('/unban', send(async (req) => {
  const r = await FB.unbanEverywhere(String((req.body || {}).ip || '').trim());
  audit(req, 'fleet-bans-unban', { ip: r.ip, failed: r.failed.length });
  return { ...r, status: FB.status() };
}));

module.exports = router;
