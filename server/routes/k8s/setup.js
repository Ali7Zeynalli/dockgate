/**
 * Kubernetes setup endpoint-ləri — mode aktiv olmadan işləyir
 * Məqsəd: kubeconfig test, mode toggle, ilkin qurma
 * Module: K8s Setup | Used by: Settings UI → Kubernetes tab
 */
const express = require('express');
const router = express.Router();
const k8sService = require('../../k8s');
const { stmts } = require('../../db');

// GET /api/k8s-setup/status — kubeconfig + mode statusu
router.get('/status', (req, res) => {
  try {
    const enabled = k8sService.isEnabled();
    const summary = k8sService.getKubeconfigSummary();
    res.json({ enabled, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/k8s-setup/test — cluster-ə qoşulmanı yoxla
router.post('/test', async (req, res) => {
  try {
    const result = await k8sService.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/k8s-setup/enable — K8s mode-u aktivləşdir
router.post('/enable', async (req, res) => {
  try {
    // Aktivləşdirmədən əvvəl connection test et
    const test = await k8sService.testConnection();
    if (!test.success) {
      return res.status(400).json({
        error: 'Kubernetes mode aktivləşdirilə bilmədi: ' + test.error,
        testResult: test,
      });
    }
    stmts.setSetting.run('k8s_enabled', 'true');
    stmts.logActivity.run('', 'k8s', 'mode', 'enable', JSON.stringify({ context: test.context }));
    res.json({ success: true, ...test });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/k8s-setup/disable — K8s mode-u deaktivləşdir
router.post('/disable', (req, res) => {
  try {
    stmts.setSetting.run('k8s_enabled', 'false');
    stmts.logActivity.run('', 'k8s', 'mode', 'disable', '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/k8s-setup/kubeconfig-path — manual path təyin et
router.post('/kubeconfig-path', (req, res) => {
  try {
    const { path } = req.body;
    if (path === undefined) return res.status(400).json({ error: 'path tələb olunur (boş string də ola bilər)' });
    stmts.setSetting.run('k8s_kubeconfig_path', String(path || ''));
    res.json({ success: true, path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
