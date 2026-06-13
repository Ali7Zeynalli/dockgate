// Edge Notifier Agent — deploy/manage the outbound-only notifier container on managed hosts.
// All actions are DockGate-initiated outbound SSH; the agent itself has no inbound surface.
const express = require('express');
const router = express.Router();
const deployer = require('../agent/deployer');
const { stmts } = require('../db');
const { encrypt } = require('../auth/secrets');
const { logAction } = require('../audit');

function validateId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }
function sourceIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
}

// GET /api/agent/status — { serverId: { installed, running, state, version } } per remote server
router.get('/status', async (req, res) => {
  try { res.json(await deployer.statusAll()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/install { serverId } — async job
router.post('/install', (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!validateId(serverId)) return res.status(400).json({ error: 'valid serverId required' });
    const jobId = deployer.runJob('install', [serverId], sourceIp(req));
    logAction({ req, server: serverId, resourceType: 'agent', resourceName: serverId, action: 'agent_install' });
    res.json({ jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/update { serverId } — pull a newer image + recreate
router.post('/update', (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!validateId(serverId)) return res.status(400).json({ error: 'valid serverId required' });
    const jobId = deployer.runJob('update', [serverId], sourceIp(req));
    logAction({ req, server: serverId, resourceType: 'agent', resourceName: serverId, action: 'agent_update' });
    res.json({ jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/reconfigure { serverId } — recreate with current settings (channel/rule changes)
router.post('/reconfigure', (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!validateId(serverId)) return res.status(400).json({ error: 'valid serverId required' });
    const jobId = deployer.runJob('reconfigure', [serverId], sourceIp(req));
    logAction({ req, server: serverId, resourceType: 'agent', resourceName: serverId, action: 'agent_reconfigure' });
    res.json({ jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/install-all { serverIds? } — fan-out over all remote servers (or a subset)
router.post('/install-all', (req, res) => {
  try {
    let ids = (req.body && Array.isArray(req.body.serverIds)) ? req.body.serverIds : null;
    if (!ids) ids = stmts.getServers.all().filter(s => s.type !== 'local' && s.id !== 'local').map(s => s.id);
    ids = ids.filter(validateId);
    if (!ids.length) return res.status(400).json({ error: 'no target servers' });
    const jobId = deployer.runJob('install-all', ids, sourceIp(req));
    logAction({ req, resourceType: 'agent', resourceName: 'all', action: 'agent_install_all', details: { count: ids.length } });
    res.json({ jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/remove { serverId } — synchronous (stop+rm, restart central monitor)
router.post('/remove', async (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!validateId(serverId)) return res.status(400).json({ error: 'valid serverId required' });
    await deployer.removeOne(serverId);
    logAction({ req, server: serverId, resourceType: 'agent', resourceName: serverId, action: 'agent_remove' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/power { serverId, action: 'start'|'stop' }
router.post('/power', async (req, res) => {
  try {
    const { serverId, action } = req.body || {};
    if (!validateId(serverId)) return res.status(400).json({ error: 'valid serverId required' });
    if (action !== 'start' && action !== 'stop') return res.status(400).json({ error: "action must be 'start' or 'stop'" });
    await deployer.powerOne(serverId, action);
    logAction({ req, server: serverId, resourceType: 'agent', resourceName: serverId, action: `agent_${action}` });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/sync — re-push the CURRENT settings (rules + channel) to every installed agent.
// Called automatically when notification rules / channels change so central edits propagate.
router.post('/sync', async (req, res) => {
  try {
    const status = await deployer.statusAll();
    const ids = Object.keys(status).filter(id => status[id] && status[id].installed);
    if (!ids.length) return res.json({ jobId: null, count: 0 });
    const jobId = deployer.runJob('reconfigure', ids, sourceIp(req));
    logAction({ req, resourceType: 'agent', resourceName: 'all', action: 'agent_sync', details: { count: ids.length } });
    res.json({ jobId, count: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/agent/job/:id — re-openable progress (survives a closed modal/browser)
router.get('/job/:id', (req, res) => {
  try {
    const row = stmts.getAgentJob.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'job not found' });
    let servers = [];
    try { servers = JSON.parse(row.servers || '[]'); } catch (e) {}
    res.json({
      id: row.id, kind: row.kind, status: row.status, phase: row.phase,
      total: row.total, ok: row.ok, failed: row.failed,
      log: row.log || '', error: row.error, servers,
      started_at: row.started_at, finished_at: row.finished_at,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/agent/jobs — recent deploy jobs
router.get('/jobs', (req, res) => {
  try { res.json(stmts.getAgentJobs.all(20)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- per-server channel override (a different Telegram/SMTP per host) ----

// GET /api/agent/channel/:serverId — masked override (or { override:false })
router.get('/channel/:serverId', (req, res) => {
  try {
    const row = stmts.getServerChannel.get(req.params.serverId);
    if (!row) return res.json({ override: false });
    res.json({
      override: true,
      tg_token: row.tg_token ? '••••••••' : '',
      tg_chat_id: row.tg_chat_id || '',
      smtp_host: row.smtp_host || '',
      smtp_port: row.smtp_port || '',
      smtp_user: row.smtp_user || '',
      smtp_pass: row.smtp_pass ? '••••••••' : '',
      smtp_from: row.smtp_from || '',
      smtp_to: row.smtp_to || '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agent/channel/:serverId — upsert override (secrets encrypted at rest)
router.post('/channel/:serverId', (req, res) => {
  try {
    const sid = req.params.serverId;
    if (!validateId(sid)) return res.status(400).json({ error: 'invalid serverId' });
    const b = req.body || {};
    const existing = stmts.getServerChannel.get(sid) || {};
    // Secret fields: keep the stored (encrypted) value when omitted or masked; '' clears; else encrypt.
    const secret = (val, oldEnc) => {
      if (val === undefined) return oldEnc || null;
      if (typeof val === 'string' && val.startsWith('••••')) return oldEnc || null;
      if (val === '') return null;
      return encrypt(String(val));
    };
    // Plain fields: keep old when omitted; '' clears.
    const plain = (val, old) => (val === undefined ? (old ?? null) : (val === '' ? null : String(val)));
    stmts.upsertServerChannel.run({
      server_id: sid,
      tg_token: secret(b.tg_token, existing.tg_token),
      tg_chat_id: plain(b.tg_chat_id, existing.tg_chat_id),
      smtp_host: plain(b.smtp_host, existing.smtp_host),
      smtp_port: plain(b.smtp_port, existing.smtp_port),
      smtp_user: plain(b.smtp_user, existing.smtp_user),
      smtp_pass: secret(b.smtp_pass, existing.smtp_pass),
      smtp_from: plain(b.smtp_from, existing.smtp_from),
      smtp_to: plain(b.smtp_to, existing.smtp_to),
    });
    logAction({ req, server: sid, resourceType: 'agent', resourceName: sid, action: 'agent_channel_set' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/agent/channel/:serverId — revert this host to the global channel
router.delete('/channel/:serverId', (req, res) => {
  try {
    stmts.deleteServerChannel.run(req.params.serverId);
    logAction({ req, server: req.params.serverId, resourceType: 'agent', resourceName: req.params.serverId, action: 'agent_channel_clear' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
