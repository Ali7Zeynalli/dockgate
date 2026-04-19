/**
 * Kubernetes client wrapper — kubeconfig loading, context switching, API clients
 * Analog of server/docker.js for Kubernetes
 * Used by: server/routes/k8s/* and server/index.js WebSocket handlers
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const k8s = require('@kubernetes/client-node');
const { stmts } = require('./db');

// ============ KUBECONFIG RESOLUTION ============

/**
 * Kubeconfig fayl yolunu tapır.
 * Sıra: DB-dəki path → $KUBECONFIG → ~/.kube/config
 * Returns: { path, source } və ya null
 */
function resolveKubeconfigPath() {
  const dbPath = stmts.getSetting.get('k8s_kubeconfig_path')?.value;
  if (dbPath && fs.existsSync(dbPath)) {
    return { path: dbPath, source: 'settings' };
  }

  const envPath = process.env.KUBECONFIG;
  if (envPath && fs.existsSync(envPath)) {
    return { path: envPath, source: 'env' };
  }

  const defaultPath = path.join(os.homedir(), '.kube', 'config');
  if (fs.existsSync(defaultPath)) {
    return { path: defaultPath, source: 'default' };
  }

  return null;
}

/**
 * KubeConfig obyektini yükləyir və aktiv context tətbiq edir.
 * Cache etmir — hər dəfə təzə oxuyur (context dəyişmələri dərhal tətbiq olunsun).
 */
function loadKubeConfig() {
  const resolved = resolveKubeconfigPath();
  if (!resolved) {
    throw new Error('Kubeconfig faylı tapılmadı. Settings → Kubernetes bölməsində path göstər.');
  }

  const kc = new k8s.KubeConfig();
  kc.loadFromFile(resolved.path);

  // DB-də saxlanmış aktiv context-i tətbiq et
  const activeContext = stmts.getSetting.get('k8s_active_context')?.value;
  if (activeContext && kc.getContexts().find(c => c.name === activeContext)) {
    kc.setCurrentContext(activeContext);
  }

  return { kc, source: resolved.source, path: resolved.path };
}

// ============ API CLIENTS ============

function getCoreApi() {
  const { kc } = loadKubeConfig();
  return kc.makeApiClient(k8s.CoreV1Api);
}

function getAppsApi() {
  const { kc } = loadKubeConfig();
  return kc.makeApiClient(k8s.AppsV1Api);
}

function getVersionApi() {
  const { kc } = loadKubeConfig();
  return kc.makeApiClient(k8s.VersionApi);
}

// ============ CLUSTER INFO ============

/**
 * Cluster-ə qoşulmanı yoxlayır və əsas məlumatları qaytarır.
 * UI-dəki "Test Connection" üçündür.
 */
async function testConnection() {
  try {
    const { kc, source, path: kcPath } = loadKubeConfig();
    const versionApi = kc.makeApiClient(k8s.VersionApi);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Paralel sorğular
    const [versionRes, nodesRes, namespacesRes] = await Promise.all([
      versionApi.getCode(),
      coreApi.listNode(),
      coreApi.listNamespace(),
    ]);

    const version = versionRes.gitVersion || versionRes.body?.gitVersion || 'unknown';
    const nodes = nodesRes.items || nodesRes.body?.items || [];
    const namespaces = namespacesRes.items || namespacesRes.body?.items || [];

    return {
      success: true,
      context: kc.getCurrentContext(),
      source,
      path: kcPath,
      version,
      nodeCount: nodes.length,
      namespaceCount: namespaces.length,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      code: err.code,
    };
  }
}

/**
 * Bütün cluster məlumatı — Dashboard üçün
 */
async function getClusterInfo() {
  const { kc } = loadKubeConfig();
  const versionApi = kc.makeApiClient(k8s.VersionApi);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  const [versionRes, nodesRes, namespacesRes] = await Promise.all([
    versionApi.getCode(),
    coreApi.listNode(),
    coreApi.listNamespace(),
  ]);

  const version = versionRes.gitVersion || versionRes.body?.gitVersion;
  const nodes = (nodesRes.items || nodesRes.body?.items || []).map(n => ({
    name: n.metadata?.name,
    status: getNodeReadyStatus(n),
    role: getNodeRole(n),
    version: n.status?.nodeInfo?.kubeletVersion,
    os: n.status?.nodeInfo?.osImage,
    architecture: n.status?.nodeInfo?.architecture,
    created: n.metadata?.creationTimestamp,
  }));
  const namespaces = (namespacesRes.items || namespacesRes.body?.items || []).map(ns => ({
    name: ns.metadata?.name,
    status: ns.status?.phase,
    created: ns.metadata?.creationTimestamp,
  }));

  return {
    context: kc.getCurrentContext(),
    version,
    nodes,
    namespaces,
    nodeCount: nodes.length,
    namespaceCount: namespaces.length,
  };
}

function getNodeReadyStatus(node) {
  const readyCondition = node.status?.conditions?.find(c => c.type === 'Ready');
  return readyCondition?.status === 'True' ? 'Ready' : 'NotReady';
}

function getNodeRole(node) {
  const labels = node.metadata?.labels || {};
  if (labels['node-role.kubernetes.io/control-plane'] !== undefined) return 'control-plane';
  if (labels['node-role.kubernetes.io/master'] !== undefined) return 'master';
  return 'worker';
}

// ============ CONTEXTS ============

function listContexts() {
  const { kc } = loadKubeConfig();
  const currentContext = kc.getCurrentContext();
  return kc.getContexts().map(c => ({
    name: c.name,
    cluster: c.cluster,
    user: c.user,
    namespace: c.namespace || 'default',
    isCurrent: c.name === currentContext,
  }));
}

function setActiveContext(contextName) {
  const { kc } = loadKubeConfig();
  const exists = kc.getContexts().find(c => c.name === contextName);
  if (!exists) throw new Error(`Context tapılmadı: ${contextName}`);
  stmts.setSetting.run('k8s_active_context', contextName);
  return { context: contextName };
}

// ============ NAMESPACES ============

async function listNamespaces() {
  const coreApi = getCoreApi();
  const res = await coreApi.listNamespace();
  const items = res.items || res.body?.items || [];
  return items.map(ns => ({
    name: ns.metadata?.name,
    status: ns.status?.phase,
    created: ns.metadata?.creationTimestamp,
    labels: ns.metadata?.labels || {},
  }));
}

// ============ MODE CHECK ============

function isEnabled() {
  return stmts.getSetting.get('k8s_enabled')?.value === 'true';
}

// ============ KUBECONFIG CONTENT (masked) ============

function getKubeconfigSummary() {
  try {
    const resolved = resolveKubeconfigPath();
    if (!resolved) return { configured: false };

    const content = fs.readFileSync(resolved.path, 'utf8');
    const lines = content.split('\n').length;
    const stat = fs.statSync(resolved.path);

    const { kc } = loadKubeConfig();
    return {
      configured: true,
      path: resolved.path,
      source: resolved.source,
      size: stat.size,
      lines,
      contexts: kc.getContexts().length,
      currentContext: kc.getCurrentContext(),
    };
  } catch (err) {
    return { configured: false, error: err.message };
  }
}

module.exports = {
  resolveKubeconfigPath,
  loadKubeConfig,
  getCoreApi,
  getAppsApi,
  getVersionApi,
  testConnection,
  getClusterInfo,
  listContexts,
  setActiveContext,
  listNamespaces,
  isEnabled,
  getKubeconfigSummary,
};
