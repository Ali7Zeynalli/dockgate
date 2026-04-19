// K8s Pod Terminal — WebSocket exec (xterm.js)
Router.register('k8s-pod-terminal', async (content) => {
  let selected = null;
  try { selected = JSON.parse(localStorage.getItem('k8s_exec_pod') || 'null'); } catch(e) {}

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
      <div><div class="page-title">Pod Terminal</div></div>
      <div class="page-actions">
        <select class="select" id="pod-select" style="min-width:260px;">
          <option value="">— Pod seç —</option>
          ${podOptions}
        </select>
        <select class="select" id="shell-select">
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
        </select>
        <button class="btn btn-primary" id="connect-btn">Connect</button>
      </div>
    </div>
    <div class="card terminal-container" style="height:calc(100vh - 220px);padding:8px;background:#000;">
      <div id="terminal" style="width:100%;height:100%;"></div>
    </div>
  `;

  const term = new Terminal({
    fontFamily: 'monospace', fontSize: 14,
    theme: { background: '#000', foreground: '#fff' },
    cursorBlink: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  setTimeout(() => fitAddon.fit(), 50);

  window.addEventListener('resize', () => fitAddon.fit());

  term.onData((data) => {
    socket.emit('k8s:exec:input', data);
  });

  let attached = false;

  function connect() {
    const sel = document.getElementById('pod-select').value;
    if (!sel) { showToast('Pod seç', 'warning'); return; }
    const [ns, name] = sel.split('::');
    const shell = document.getElementById('shell-select').value;
    localStorage.setItem('k8s_exec_pod', JSON.stringify({ namespace: ns, podName: name }));

    socket.emit('k8s:exec:stop');
    term.clear();
    term.write(`\r\nConnecting to ${ns}/${name} (${shell})...\r\n`);
    socket.emit('k8s:exec:start', { namespace: ns, podName: name, command: [shell] });
    attached = true;
  }

  socket.on('k8s:exec:ready', () => {
    term.write('\r\n\x1b[32m[connected]\x1b[0m\r\n');
    const { cols, rows } = term;
    socket.emit('k8s:exec:resize', { cols, rows });
  });

  socket.on('k8s:exec:data', ({ data }) => {
    term.write(data);
  });

  socket.on('k8s:exec:end', () => {
    term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
  });

  socket.on('k8s:exec:error', ({ error }) => {
    term.write(`\r\n\x1b[31m[error] ${error}\x1b[0m\r\n`);
  });

  term.onResize(({ cols, rows }) => {
    if (attached) socket.emit('k8s:exec:resize', { cols, rows });
  });

  document.getElementById('connect-btn').addEventListener('click', connect);

  if (selected) {
    // Auto connect if came from Pods page
    setTimeout(connect, 100);
  }

  return () => {
    socket.emit('k8s:exec:stop');
    socket.off('k8s:exec:ready');
    socket.off('k8s:exec:data');
    socket.off('k8s:exec:end');
    socket.off('k8s:exec:error');
    term.dispose();
  };
});
