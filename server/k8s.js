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

// ============ PODS ============

async function listPods(namespace) {
  const coreApi = getCoreApi();
  const res = namespace && namespace !== 'all'
    ? await coreApi.listNamespacedPod({ namespace })
    : await coreApi.listPodForAllNamespaces();
  const items = res.items || res.body?.items || [];
  return items.map(p => {
    const containers = p.status?.containerStatuses || [];
    const readyCount = containers.filter(c => c.ready).length;
    const totalCount = containers.length;
    const restarts = containers.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    return {
      name: p.metadata?.name,
      namespace: p.metadata?.namespace,
      uid: p.metadata?.uid,
      node: p.spec?.nodeName,
      phase: p.status?.phase,
      ready: `${readyCount}/${totalCount}`,
      readyCount,
      totalCount,
      restarts,
      ip: p.status?.podIP,
      created: p.metadata?.creationTimestamp,
      containers: (p.spec?.containers || []).map(c => ({
        name: c.name,
        image: c.image,
        ports: (c.ports || []).map(p => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', '),
      })),
      labels: p.metadata?.labels || {},
    };
  });
}

async function inspectPod(namespace, name) {
  const coreApi = getCoreApi();
  const res = await coreApi.readNamespacedPod({ namespace, name });
  return res.body || res;
}

async function deletePod(namespace, name, options = {}) {
  const coreApi = getCoreApi();
  await coreApi.deleteNamespacedPod({
    namespace,
    name,
    gracePeriodSeconds: options.grace ?? 30,
  });
  return { success: true };
}

async function getPodLogs(namespace, name, { container, tail = 200, timestamps = false, previous = false } = {}) {
  const coreApi = getCoreApi();
  const res = await coreApi.readNamespacedPodLog({
    namespace,
    name,
    container,
    tailLines: tail,
    timestamps,
    previous,
  });
  return typeof res === 'string' ? res : (res.body || '');
}

// ============ DEPLOYMENTS ============

async function listDeployments(namespace) {
  const appsApi = getAppsApi();
  const res = namespace && namespace !== 'all'
    ? await appsApi.listNamespacedDeployment({ namespace })
    : await appsApi.listDeploymentForAllNamespaces();
  const items = res.items || res.body?.items || [];
  return items.map(d => ({
    name: d.metadata?.name,
    namespace: d.metadata?.namespace,
    uid: d.metadata?.uid,
    replicas: d.spec?.replicas ?? 0,
    ready: d.status?.readyReplicas ?? 0,
    available: d.status?.availableReplicas ?? 0,
    updated: d.status?.updatedReplicas ?? 0,
    strategy: d.spec?.strategy?.type,
    created: d.metadata?.creationTimestamp,
    images: (d.spec?.template?.spec?.containers || []).map(c => c.image),
    labels: d.metadata?.labels || {},
  }));
}

async function inspectDeployment(namespace, name) {
  const appsApi = getAppsApi();
  const res = await appsApi.readNamespacedDeployment({ namespace, name });
  return res.body || res;
}

async function scaleDeployment(namespace, name, replicas) {
  const appsApi = getAppsApi();
  const body = { spec: { replicas: parseInt(replicas, 10) } };
  await appsApi.patchNamespacedDeploymentScale({
    namespace,
    name,
    body,
  }, { headers: { 'Content-Type': 'application/merge-patch+json' } });
  return { success: true, replicas: parseInt(replicas, 10) };
}

async function restartDeployment(namespace, name) {
  const appsApi = getAppsApi();
  const now = new Date().toISOString();
  // Patch annotation triggers rollout restart (kubectl rollout restart works this way)
  const body = {
    spec: {
      template: {
        metadata: {
          annotations: { 'kubectl.kubernetes.io/restartedAt': now },
        },
      },
    },
  };
  await appsApi.patchNamespacedDeployment({
    namespace,
    name,
    body,
  }, { headers: { 'Content-Type': 'application/merge-patch+json' } });
  return { success: true, restartedAt: now };
}

async function deleteDeployment(namespace, name) {
  const appsApi = getAppsApi();
  await appsApi.deleteNamespacedDeployment({ namespace, name });
  return { success: true };
}

// ============ SERVICES ============

async function listServices(namespace) {
  const coreApi = getCoreApi();
  const res = namespace && namespace !== 'all'
    ? await coreApi.listNamespacedService({ namespace })
    : await coreApi.listServiceForAllNamespaces();
  const items = res.items || res.body?.items || [];
  return items.map(s => ({
    name: s.metadata?.name,
    namespace: s.metadata?.namespace,
    uid: s.metadata?.uid,
    type: s.spec?.type,
    clusterIP: s.spec?.clusterIP,
    externalIPs: s.spec?.externalIPs || [],
    loadBalancerIP: s.status?.loadBalancer?.ingress?.[0]?.ip || s.status?.loadBalancer?.ingress?.[0]?.hostname,
    ports: (s.spec?.ports || []).map(p => ({
      name: p.name,
      port: p.port,
      targetPort: p.targetPort,
      nodePort: p.nodePort,
      protocol: p.protocol || 'TCP',
    })),
    selector: s.spec?.selector || {},
    created: s.metadata?.creationTimestamp,
  }));
}

async function inspectService(namespace, name) {
  const coreApi = getCoreApi();
  const res = await coreApi.readNamespacedService({ namespace, name });
  return res.body || res;
}

// ============ CONFIGMAPS ============

async function listConfigMaps(namespace) {
  const coreApi = getCoreApi();
  const res = namespace && namespace !== 'all'
    ? await coreApi.listNamespacedConfigMap({ namespace })
    : await coreApi.listConfigMapForAllNamespaces();
  const items = res.items || res.body?.items || [];
  return items.map(c => ({
    name: c.metadata?.name,
    namespace: c.metadata?.namespace,
    uid: c.metadata?.uid,
    keys: Object.keys(c.data || {}),
    keyCount: Object.keys(c.data || {}).length,
    created: c.metadata?.creationTimestamp,
  }));
}

async function getConfigMap(namespace, name) {
  const coreApi = getCoreApi();
  const res = await coreApi.readNamespacedConfigMap({ namespace, name });
  const cm = res.body || res;
  return {
    name: cm.metadata?.name,
    namespace: cm.metadata?.namespace,
    created: cm.metadata?.creationTimestamp,
    labels: cm.metadata?.labels || {},
    data: cm.data || {},
  };
}

// ============ SECRETS ============

async function listSecrets(namespace) {
  const coreApi = getCoreApi();
  const res = namespace && namespace !== 'all'
    ? await coreApi.listNamespacedSecret({ namespace })
    : await coreApi.listSecretForAllNamespaces();
  const items = res.items || res.body?.items || [];
  return items.map(s => ({
    name: s.metadata?.name,
    namespace: s.metadata?.namespace,
    uid: s.metadata?.uid,
    type: s.type,
    keys: Object.keys(s.data || {}),
    keyCount: Object.keys(s.data || {}).length,
    created: s.metadata?.creationTimestamp,
  }));
}

async function getSecret(namespace, name, { reveal = false } = {}) {
  const coreApi = getCoreApi();
  const res = await coreApi.readNamespacedSecret({ namespace, name });
  const s = res.body || res;
  const data = {};
  // Secret data Base64 encoded-dir. Reveal=true olarsa decode et
  for (const [k, v] of Object.entries(s.data || {})) {
    if (reveal) {
      try { data[k] = Buffer.from(v, 'base64').toString('utf8'); }
      catch(e) { data[k] = '[binary data]'; }
    } else {
      data[k] = '••••••••';
    }
  }
  return {
    name: s.metadata?.name,
    namespace: s.metadata?.namespace,
    type: s.type,
    created: s.metadata?.creationTimestamp,
    keys: Object.keys(s.data || {}),
    data,
    revealed: reveal,
  };
}

// ============ NODES ============

async function listNodes() {
  const coreApi = getCoreApi();
  const res = await coreApi.listNode();
  const items = res.items || res.body?.items || [];
  return items.map(n => {
    const capacity = n.status?.capacity || {};
    const allocatable = n.status?.allocatable || {};
    return {
      name: n.metadata?.name,
      status: getNodeReadyStatus(n),
      role: getNodeRole(n),
      version: n.status?.nodeInfo?.kubeletVersion,
      os: n.status?.nodeInfo?.osImage,
      kernel: n.status?.nodeInfo?.kernelVersion,
      architecture: n.status?.nodeInfo?.architecture,
      containerRuntime: n.status?.nodeInfo?.containerRuntimeVersion,
      cpu: capacity.cpu,
      memory: capacity.memory,
      pods: capacity.pods,
      cpuAllocatable: allocatable.cpu,
      memoryAllocatable: allocatable.memory,
      created: n.metadata?.creationTimestamp,
      addresses: (n.status?.addresses || []).map(a => ({ type: a.type, address: a.address })),
    };
  });
}

// ============ RAW KUBECONFIG (for WebSocket Log/Exec streaming) ============

function getKubeConfig() {
  return loadKubeConfig().kc;
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
  getKubeConfig,
  testConnection,
  getClusterInfo,
  listContexts,
  setActiveContext,
  listNamespaces,
  listPods, inspectPod, deletePod, getPodLogs,
  listDeployments, inspectDeployment, scaleDeployment, restartDeployment, deleteDeployment,
  listServices, inspectService,
  listConfigMaps, getConfigMap,
  listSecrets, getSecret,
  listNodes,
  isEnabled,
  getKubeconfigSummary,
};
