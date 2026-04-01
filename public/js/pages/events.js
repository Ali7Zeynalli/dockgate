// Docker Events Page
Router.register('events', async (content) => {
  let cleanupFns = [];
  
  async function render() {
    content.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">Docker Events</div><div class="page-subtitle">Real-time system events stream</div></div>
      </div>
      
      <div class="log-toolbar mb-3">
        <button class="btn btn-secondary" id="event-pause">${Icons.pause} Pause</button>
        <button class="btn btn-secondary" id="event-clear">Clear</button>
      </div>
      
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead>
          <tbody id="events-tbody"></tbody>
        </table>
         <div id="empty-state" class="empty-state" style="padding: 40px">Waiting for events...</div>
      </div>
    `;

    const tbody = document.getElementById('events-tbody');
    const empty = document.getElementById('empty-state');
    const pauseBtn = document.getElementById('event-pause');
    let isPaused = false;
    let eventCount = 0;

    socket.emit('events:subscribe');

    const onEventData = (event) => {
      if (isPaused) return;
      if (empty) empty.style.display = 'none';
      
      const tr = document.createElement('tr');
      const time = new Date(event.time * 1000).toLocaleTimeString();
      const type = event.Type || 'unknown';
      const action = event.Action || '';
      
      // Determine color based on action
      let actionClass = 'badge-created';
      if (action.includes('start') || action.includes('connect')) actionClass = 'badge-running';
      if (action.includes('die') || action.includes('stop') || action.includes('disconnect')) actionClass = 'badge-stopped';
      if (action.includes('destroy') || action.includes('remove')) actionClass = 'badge-dead';
      
      // Format actor name
      let nameStr = '—';
      const attrs = event.Actor?.Attributes;
      if (attrs) {
        if (attrs.name) nameStr = attrs.name;
        else if (event.Actor.ID) nameStr = event.Actor.ID.substring(0, 12);
      }
      
      // Format details
      const details = Object.entries(attrs || {})
        .filter(([k]) => k !== 'name' && k !== 'image')
        .map(([k,v]) => `${k}=${v}`)
        .join(', ');

      tr.innerHTML = `
        <td class="text-sm text-muted">${time}</td>
        <td class="td-mono">${type}</td>
        <td><span class="badge ${actionClass}">${action}</span></td>
        <td class="td-name">${escapeHtml(nameStr)}</td>
        <td class="text-xs text-muted" style="max-width: 300px; white-space: normal;">${escapeHtml(details)}</td>
      `;
      
      tbody.prepend(tr);
      eventCount++;
      
      // Keep only last 100 events
      if (eventCount > 100 && tbody.lastChild) {
        tbody.removeChild(tbody.lastChild);
        eventCount--;
      }
    };

    socket.on('events:data', onEventData);
    cleanupFns.push(() => {
      socket.off('events:data', onEventData);
      socket.emit('events:unsubscribe');
    });

    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.innerHTML = isPaused ? `${Icons.play} Resume` : `${Icons.pause} Pause`;
    });

    document.getElementById('event-clear').addEventListener('click', () => {
      tbody.innerHTML = '';
      eventCount = 0;
      if (empty) empty.style.display = 'block';
    });
  }
  
  await render();
  return () => { cleanupFns.forEach(fn => { try { fn(); } catch(e){} }); };
});
