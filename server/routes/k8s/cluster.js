/**
 * Kubernetes cluster endpoint-ləri — connection test, info, contexts, namespaces
 * Module: K8s Cluster | Used by: server/index.js (K8s mode aktivsə qoşulur)
 */
const express = require('express');
const router = express.Router();
const k8sService = require('../../k8s');
const { stmts } = require('../../db');

// Middleware — bütün K8s route-lar üçün mode yoxlaması
router.use((req, res, next) => {
  if (!k8sService.isEnabled()) {
    return res.status(400).json({ error: 'Kubernetes mode aktiv deyil. Settings-dən aktivləşdir.' });
  }
  next();
});

// GET /api/k8s/cluster/status — kubeconfig yoxlanması (mode-a ehtiyac yox, istisna)
// Bu endpoint mode-dan əvvəl setup üçün lazımdır, lakin başqa bir yolda həll edəcəyik:
// ayrıca /api/k8s/setup route-u yaradacağıq (bax: k8s-setup.js)

// GET /api/k8s/cluster/info — cluster haqqında ətraflı məlumat
router.get('/info', async (req, res) => {
  try {
    const info = await k8sService.getClusterInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/k8s/cluster/contexts — kubeconfig-dəki bütün context-lər
router.get('/contexts', (req, res) => {
  try {
    res.json(k8sService.listContexts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/k8s/cluster/context — aktiv context-i dəyiş
router.post('/context', (req, res) => {
  try {
    const { context } = req.body;
    if (!context) return res.status(400).json({ error: 'context parametri tələb olunur' });
    const result = k8sService.setActiveContext(context);
    stmts.logActivity.run('', 'k8s', 'context', 'switch', JSON.stringify(result));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/k8s/cluster/namespaces — bütün namespace-lər
router.get('/namespaces', async (req, res) => {
  try {
    const namespaces = await k8sService.listNamespaces();
    res.json(namespaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
