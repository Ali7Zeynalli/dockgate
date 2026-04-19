// K8s Pod Logs səhifəsi — WebSocket streaming
Router.register('k8s-pod-logs', async (content) => {
  let selected = null;
  try { selected = JSON.parse(localStorage.getItem('k8s_log_pod') || 'null'); } catch(e) {}

  let pods = [];
  try {
    pods = await API.get('/k8s/pods?namespace=all');
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const podOptions = pods.map(p => {
    const sel = selected && selected.podName === p.name && selected.namespace === p.namespace ? 'selected' : '';
    return `<option value="${escapeHtml(p.namespace)}::${escapeHtml(p.name)}" ${sel}>${escapeHtml(p.namespace)}/${escapeHtml(p.name)}</option>`;
  }).join('');

  content.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Pod Logs</div></div>
      <div class="page-actions">
        <select class="select" id="pod-select" style="min-width:280px;">
          <option value="">— Pod seç —</option>
          ${podOptions}
        </select>
        <button class="btn btn-secondary" id="pause-btn">Pause</button>
        <button class="btn btn-secondary" id="clear-btn">Clear</button>
      </div>
    </div>
    <div class="card">
      <div class="log-viewer" id="log-viewer" style="height:calc(100vh - 220px);overflow-y:auto;font-family:var(--font-mono);font-size:12px;padding:12px;background:var(--bg-primary);white-space:pre-wrap;word-break:break-all;"></div>
    </div>
  `;

  const viewer = document.getElementById('log-viewer');
  const podSelect = document.getElementById('pod-select');
  let paused = false;
  let autoScroll = true;

  viewer.addEventListener('scroll', () => {
    autoScroll = (viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 20);
  });

  function subscribe(namespace, podName) {
    socket.emit('k8s:logs:unsubscribe');
    viewer.textContent = '';
    socket.emit('k8s:logs:subscribe', { namespace, podName, tail: 200, follow: true });
  }

  socket.on('k8s:logs:data', ({ data }) => {
    if (paused) return;
    viewer.textContent += data;
    if (autoScroll) viewer.scrollTop = viewer.scrollHeight;
  });

  socket.on('k8s:logs:error', ({ error }) => {
    viewer.textContent += `\n[ERROR] ${error}\n`;
  });

  podSelect.addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [ns, name] = e.target.value.split('::');
    localStorage.setItem('k8s_log_pod', JSON.stringify({ namespace: ns, podName: name }));
    subscribe(ns, name);
  });

  document.getElementById('pause-btn').addEventListener('click', function() {
    paused = !paused;
    this.textContent = paused ? 'Resume' : 'Pause';
  });
  document.getElementById('clear-btn').addEventListener('click', () => {
    viewer.textContent = '';
  });

  // Auto-select if came from Pods page
  if (selected) {
    subscribe(selected.namespace, selected.podName);
  }

  // Cleanup on page leave
  return () => {
    socket.emit('k8s:logs:unsubscribe');
    socket.off('k8s:logs:data');
    socket.off('k8s:logs:error');
  };
});
