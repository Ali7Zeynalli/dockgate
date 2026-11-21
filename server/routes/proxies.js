// Web → Proxies & SSL (server/proxies.js) — the server in use. Read-only (PX1). Mounted at /api/proxies.
const express = require('express');
const router = express.Router();
const PX = require('../proxies');
const { logAction } = require('../audit');
const send = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); } };

router.get('/', send((req) => PX.scan({ fresh: req.query.fresh === '1' })));
router.get('/certs', send(() => PX.certificates()));
router.get('/:id/files', send((req) => PX.files(req.params.id)));
router.get('/:id/logs', send((req) => PX.logs(req.params.id, req.query.which, req.query.tail)));
router.post('/:id/test', send(async (req) => { const r = await PX.testConfig(req.params.id); logAction({ req, resourceType: 'proxy', resourceName: req.params.id, action: 'proxy_test', details: { ok: r.ok, command: r.command } }); return r; }));

module.exports = router;
