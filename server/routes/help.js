// System > Help (server/help.js): the guide inside DockGate. Mounted at /api/help (behind the login).
const express = require('express');
const path = require('path');
const router = express.Router();
const H = require('../help');
const send = (fn) => (req, res) => { try { res.json(fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); } };

router.get('/', send(() => H.index()));
router.get('/search', send((req) => H.search(req.query.q)));
router.get('/doc/:name', send((req) => H.doc(req.params.name)));
router.use('/images', express.static(path.join(H.DIR, 'images'), { maxAge: '7d', fallthrough: false, index: false, dotfiles: 'deny' }));

module.exports = router;
