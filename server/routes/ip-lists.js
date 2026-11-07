// IP lists for firewall port sources (Firewall tab → IP lists). Official lists are fetched only when the
// user asks ("Check for updates") and saved only after they confirm the shown difference.
const express = require('express');
const router = express.Router();
const IPL = require('../security/iplists');
const { logAction } = require('../audit');

const send = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
};
const audit = (req, action, l, details) => logAction({ req, resourceType: 'ip-list', resourceId: l.id, resourceName: l.name, action, details });

router.get('/', send(() => ({ lists: IPL.all() })));
// paste helper: canonical addresses + what was not understood
router.post('/parse', send((req) => IPL.parseSourceText((req.body || {}).text)));
router.post('/', send((req) => { const l = IPL.saveCustom(null, req.body || {}); audit(req, 'ip-list-create', l, { count: l.items.length }); return l; }));
router.put('/:id', send((req) => { const l = IPL.saveCustom(req.params.id, req.body || {}); audit(req, 'ip-list-edit', l, { count: l.items.length }); return l; }));
router.delete('/:id', send((req) => { const l = IPL.get(req.params.id); IPL.removeCustom(req.params.id); audit(req, 'ip-list-delete', l, {}); return { success: true }; }));
router.post('/:id/check', send((req) => IPL.checkOfficial(req.params.id)));
router.post('/:id/update', send((req) => {
  const items = (req.body || {}).items;
  if (!Array.isArray(items)) throw Object.assign(new Error('items required'), { statusCode: 400 });
  const l = IPL.saveOfficial(req.params.id, items);
  audit(req, 'ip-list-update', l, { count: l.items.length });
  return l;
}));

module.exports = router;
