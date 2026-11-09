// Docker Events page: past events from the chosen range, then live, in the shared LogViewer.
// Source = event type (container, image, network, volume …); level from the action (OOM / failed exit = error,
// stop / kill / remove = warning).
Router.register('events', async (content) => {
  const cleanupFns = [];
  content.innerHTML = `
    ${UI.header('Events', 'What Docker did on this server: containers starting and stopping, images pulled, networks and volumes changed. Past events from the chosen range, then live.')}
    <div id="events-error"></div>
    <div data-lvroot></div>`;

  const tools = `<select class="select" data-erange aria-label="Past events to load" title="Past events Docker replays before the live stream">
      <option value="900">From the last 15 min</option><option value="3600" selected>From the last hour</option><option value="86400">From the last 24 h</option><option value="604800">From the last 7 days</option><option value="0">Live only</option>
    </select>
    <button type="button" class="btn btn-sm btn-secondary" data-csv title="Download the loaded events as CSV">CSV</button>`;
  let rangeSel;
  const levelOf = (action, attrs) => {
    if (/oom/.test(action) || (action === 'die' && attrs.exitCode && attrs.exitCode !== '0') || /unhealthy/.test(action)) return 'E';
    if (/^(kill|stop|die|destroy|remove|delete|disconnect|pause)/.test(action)) return 'W';
    return 'I';
  };
  const toRow = (ev) => {
    const attrs = ev.Actor?.Attributes || {};
    const type = ev.Type || 'unknown', action = ev.Action || '';
    const actor = attrs.name || (ev.Actor?.ID || '').slice(0, 12) || '—';
    const details = Object.entries(attrs).filter(([k]) => k !== 'name').map(([k, v]) => `${k}=${v}`).join(', ');
    const t = ev.timeNano ? Math.floor(Number(ev.timeNano) / 1e6) : (ev.time ? ev.time * 1000 : Date.now());
    return { t, l: levelOf(action, attrs), src: type, msg: `${action}  ${actor}${details ? '  · ' + details : ''}`, meta: { Type: type, Action: action, Actor: actor, ID: ev.Actor?.ID || '', Details: details, _csv: [new Date(t).toISOString(), type, action, actor, details] } };
  };
  const shown = [];
  const viewer = LogViewer.mount(content.querySelector('[data-lvroot]'), {
    key: 'events', fileName: 'docker-events', tools, live: true,
    retention: 'Docker keeps only its recent events in memory; a Docker restart clears them',
    empty: 'No events yet. They appear here as Docker reports them.',
    onTools(el) {
      rangeSel = el.querySelector('[data-erange]');
      rangeSel.addEventListener('change', subscribe);
      el.querySelector('[data-csv]').addEventListener('click', () => {
        if (!shown.length) { showToast('No events to export', 'warning'); return; }
        const q = (v) => { const x = String(v == null ? '' : v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
        const csv = ['time,type,action,actor,details', ...shown.map(r => r.meta._csv.map(q).join(','))].join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `dockgate-events-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      });
    },
  });
  function subscribe() {
    viewer.clear(); shown.length = 0;
    const secs = parseInt(rangeSel.value, 10) || 0;
    socket.emit('events:subscribe', secs > 0 ? { since: Math.floor(Date.now() / 1000) - secs } : {}); // the server replaces the old stream
  }
  const onEventData = (ev) => {
    const r = toRow(ev);
    shown.push(r); if (shown.length > (viewer.limit || 10000)) shown.shift();
    viewer.push([r]);
    const box = document.getElementById('events-error'); if (box) box.innerHTML = '';
  };
  const onEventError = ({ error }) => { const box = document.getElementById('events-error'); if (box) box.innerHTML = UI.errorState(error, { compact: true }); };
  socket.on('events:data', onEventData);
  socket.on('events:error', onEventError);
  subscribe();
  window._activeResub = subscribe;
  cleanupFns.push(() => {
    socket.off('events:data', onEventData); socket.off('events:error', onEventError);
    window._activeResub = null; socket.emit('events:unsubscribe'); viewer.destroy();
  });
  return () => { cleanupFns.forEach(fn => { try { fn(); } catch (e) { /* page gone */ } }); };
});
