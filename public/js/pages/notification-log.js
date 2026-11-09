// Observe → Notifications: every alert DockGate sent (email, Telegram, webhook) and whether it arrived, in the
// shared LogViewer. Moved here from Settings (Settings → Notifications links to it). Failed deliveries are errors.
Router.register('notification-log', async (content) => {
  const toMs = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z')); return Number.isFinite(t) ? t : null; };
  const CH = { telegram: 'Telegram', email: 'Email', webhook: 'Webhook' };
  content.innerHTML = `
    ${UI.header('Notifications sent', 'Every alert DockGate sent, where it went, and whether it arrived. Channels and rules are in Settings → Notifications.',
      `<button class="btn btn-secondary btn-sm" id="nl-settings">Notification settings</button>
       ${UI.menu([{ label: `${Icons.trash} Clear the log…`, attrs: 'id="nl-clear"', danger: true }])}`)}
    <div data-lvroot></div>`;
  const viewer = LogViewer.mount(content.querySelector('[data-lvroot]'), {
    key: 'notification-log', fileName: 'dockgate-notifications',
    retention: 'DockGate keeps the newest 10,000 entries',
    empty: 'No alerts sent yet. Set up a channel and rules in Settings → Notifications.',
    async load(limit) {
      const rows = await API.get(`/meta/notifications/log?limit=${limit}`);
      return { rows: rows.slice().reverse().map(l => {
        const ch = CH[l.channel] || l.channel || 'Email';
        const ok = l.status === 'sent';
        return { t: toMs(l.created_at), l: ok ? 'I' : 'E', src: ch,
          msg: `${ok ? 'sent' : (l.status || 'failed')}  ${l.event_type || ''}  ${l.subject || ''}${l.recipient ? `  → ${l.recipient}` : ''}${l.error ? `  · ${l.error}` : ''}`,
          meta: { Channel: ch, Event: l.event_type, Subject: l.subject, Recipient: l.recipient, Status: l.status, Error: l.error || '' } };
      }) };
    },
  });
  content.querySelector('#nl-settings').addEventListener('click', () => Router.navigate('settings', { tab: 'notifications' }));
  content.querySelector('#nl-clear')?.addEventListener('click', () => {
    showDeleteConfirm('Clear notification log', { message: 'Permanently clear the entire notification history log?', phrase: 'delete', confirmLabel: 'Clear', onConfirm: async () => {
      try { await API.delete('/meta/notifications/log'); showToast('Log cleared'); viewer.reload(); } catch (e) { showToast(e.message, 'error'); }
    } });
  });
  return () => viewer.destroy();
});
