// Server Console → Settings (DigitalOcean / Hetzner "Settings" style): one row per setting with its own
// Edit, a connection test, Docker access for the SSH user, the pinned host key, and a Danger zone that
// removes the server from DockGate. Replaces the old "Edit server" modal on the Servers list.

async function renderServerSettings(serverId, container) {
  container.innerHTML = '<div class="skeleton" style="height:160px;width:100%"></div>';
  let s;
  try { s = ((await API.get('/servers')).servers || []).find(x => x.id === serverId); }
  catch (e) { return secError(container, "Couldn't load the server", e, () => renderServerSettings(serverId, container)); }
  if (!s) { container.innerHTML = '<div class="empty-state">Server not found.</div>'; return; }
  const reload = () => { if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher(); renderServerSettings(serverId, container); };
  const save = async (body, msg) => { await API.put(`/servers/${encodeURIComponent(serverId)}`, body); showToast(msg || 'Saved'); reload(); };
  const auth = s.authMode === 'key' ? `SSH key${s.hasPassphrase ? ' (with passphrase)' : ''}` : s.authMode === 'password' ? 'Password' : 'SSH agent';

  container.innerHTML = `<div class="ui-page">
    ${UI.header('Settings', 'How DockGate knows and reaches this server.')}
    ${UI.settings([
      { label: 'Name', desc: 'Shown everywhere in DockGate. The ID stays the same.', value: `${escapeHtml(s.name || '—')} <div class="ui-sub td-mono">${escapeHtml(s.id)}</div>`, action: UI.btn('Edit', 'data-edit="name"') },
      { label: 'Description', desc: 'A note for you.', value: escapeHtml(s.description || '—'), action: UI.btn('Edit', 'data-edit="desc"') },
      { label: 'Connection', desc: 'Where DockGate connects over SSH.', value: `<span class="td-mono">${escapeHtml(s.username)}@${escapeHtml(s.host)}:${s.port || 22}</span>`, action: UI.btn('Edit', 'data-edit="conn"') },
      { label: 'Login', desc: 'How DockGate authenticates.', value: `${auth}${s.username === 'root' ? ' ' + UI.pill('warn', 'root') : ''}`, action: UI.btn('Change', 'data-edit="auth"') },
      { label: 'Connection test', desc: 'Logs in now and checks Docker.', value: '<span class="ui-sub" data-testout>—</span>', action: UI.btn('Test', 'data-test') },
      { label: 'Docker access', desc: 'Adds the SSH user to the docker group (sudo usermod -aG docker). Needs passwordless sudo.', value: '', action: UI.btn('Grant…', 'data-grant') },
      { label: 'Host key', desc: 'The server identity, pinned on first connect. A different key is refused.', value: s.hostKey ? `<span class="td-mono text-xs">${escapeHtml(s.hostKey)}</span>${s.hostKeyAt ? `<div class="ui-sub">pinned ${escapeHtml(String(s.hostKeyAt).slice(0, 16))}</div>` : ''}` : '<span class="ui-sub">not pinned yet — pinned on the next connection</span>', action: s.hostKey ? UI.btn('Re-trust…', 'data-retrust', 'btn-danger') : '' },
      { label: 'Access password', desc: 'A second password before anyone switches to this server in DockGate.', value: s.hasAccessPassword ? UI.pill('ok', 'On') : UI.pill('off', 'Off'), action: UI.btn('Edit', 'data-edit="access"') },
      { label: 'Alerts', desc: 'Telegram / email notifications for this server.', value: s.notifications_enabled === 0 ? UI.pill('off', 'Muted') : UI.pill('ok', 'On'), action: UI.btn(s.notifications_enabled === 0 ? 'Turn on' : 'Mute', 'data-alerts') },
    ])}
    <div class="ui-settings ui-danger-zone">${UI.settings([{ cls: 'ui-danger', label: 'Remove server from DockGate', desc: 'DockGate forgets this server, its SSH key file and history. Nothing on the server is changed.', value: '', action: UI.btn('Remove…', 'data-remove', 'btn-danger') }]).replace(/^<div class="ui-settings">|<\/div>$/g, '')}</div>
  </div>`;

  const q = (sel) => container.querySelector(sel);
  q('[data-test]').onclick = async (e) => {
    const out = q('[data-testout]'); e.target.disabled = true; out.textContent = 'Testing…';
    try {
      const r = await API.post('/servers/test', { id: serverId });
      out.innerHTML = r.success ? (r.docker === false ? UI.pill('warn', 'SSH OK · no Docker') : UI.pill('ok', `SSH OK · Docker ${escapeHtml(r.version)}`)) : `<span style="color:var(--danger)">${escapeHtml(sshErrorHint(r.error || 'failed'))}</span>`;
    } catch (er) { out.innerHTML = `<span style="color:var(--danger)">${escapeHtml(er.message)}</span>`; }
    finally { e.target.disabled = false; }
  };
  q('[data-grant]').onclick = () => secConfirm({
    title: 'Grant Docker access', confirmLabel: 'Grant',
    change: `<span class="td-mono">sudo usermod -aG docker ${escapeHtml(s.username)}</span> runs on the server. It takes effect on the next connection.`,
    protects: 'Nothing else changes. Needs passwordless sudo for this user.', undo: 'Remove the user from the docker group on the server (gpasswd -d).',
    onConfirm: async () => { try { const r = await API.post(`/servers/${encodeURIComponent(serverId)}/grant-docker`, {}); showToast(r.message || 'Docker access granted', 'success', 7000); } catch (e) { showToast(sshErrorHint(e.message), 'error', 10000); } },
  });
  q('[data-retrust]')?.addEventListener('click', () => confirmRetrust(serverId, reload));
  q('[data-alerts]').onclick = () => save({ notifications_enabled: s.notifications_enabled === 0 ? 1 : 0 }, s.notifications_enabled === 0 ? 'Alerts on' : 'Alerts muted').catch(e => showToast(e.message, 'error'));
  q('[data-remove]').onclick = () => showDeleteConfirm('Remove server', { message: `Remove "${escapeHtml(s.name || s.id)}" from DockGate? Its SSH key file and history are deleted here; the server itself is not touched.`, phrase: s.id, onConfirm: async () => {
    await API.del(`/servers/${encodeURIComponent(serverId)}`);
    showToast('Server removed');
    if (typeof refreshServerSwitcher === 'function') refreshServerSwitcher();
    Router.navigate('infra', { tab: 'servers' });
  } });

  const EDITS = {
    name: () => UI.dialog({ title: 'Name', body: `<div class="ui-field"><label for="ss-name">Display name</label><input class="input" id="ss-name" value="${escapeHtml(s.name || '')}" placeholder="${escapeHtml(s.id)}"><span class="ui-help">The ID <span class="td-mono">${escapeHtml(s.id)}</span> stays the same.</span></div>`, onSave: (ov) => save({ name: ov.querySelector('#ss-name').value.trim() }, 'Name saved') }),
    desc: () => UI.dialog({ title: 'Description', body: `<div class="ui-field"><label for="ss-desc">Description</label><input class="input" id="ss-desc" value="${escapeHtml(s.description || '')}"></div>`, onSave: (ov) => save({ description: ov.querySelector('#ss-desc').value.trim() }, 'Description saved') }),
    conn: () => UI.dialog({
      title: 'Connection',
      body: `<div class="ui-row"><div class="ui-field" style="flex:1;min-width:200px"><label for="ss-host">Host or IP</label><input class="input" id="ss-host" value="${escapeHtml(s.host)}"></div><div class="ui-field"><label for="ss-port">Port</label><input class="input" id="ss-port" type="number" value="${s.port || 22}" style="width:90px"></div><div class="ui-field"><label for="ss-user">User</label><input class="input" id="ss-user" value="${escapeHtml(s.username)}" style="width:130px"></div></div>
        <div class="ui-sub">Pointing DockGate at a different machine? Its host key will not match the pinned one — use Re-trust afterwards.</div>`,
      onSave: (ov) => { const host = ov.querySelector('#ss-host').value.trim(), username = ov.querySelector('#ss-user').value.trim(); if (!host || !username) throw new Error('Host and user are required'); return save({ host, username, port: Number(ov.querySelector('#ss-port').value) || 22 }, 'Connection saved'); },
    }),
    auth: () => {
      let mode = s.authMode === 'password' ? 'password' : 'key';
      UI.dialog({
        title: 'Login', saveLabel: 'Test and save',
        body: `<div class="ui-field"><span class="ui-label">How DockGate logs in</span><div class="ui-seg" data-seg>${[['key', 'SSH key'], ['password', 'Password']].map(([v, l]) => `<button type="button" data-m="${v}" aria-pressed="${mode === v}">${l}</button>`).join('')}</div></div><div data-pane></div>`,
        onOpen: (ov) => {
          const pane = ov.querySelector('[data-pane]');
          const draw = () => { pane.innerHTML = mode === 'key'
            ? `<div class="ui-field"><label for="ss-key">New private key</label><textarea class="input" id="ss-key" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="font-family:var(--font-mono);font-size:11px;width:100%"></textarea></div><div class="ui-field"><label for="ss-pp">Passphrase <span class="ui-sub" style="font-weight:400">· only if encrypted</span></label><input class="input" id="ss-pp" type="password" autocomplete="new-password"></div>`
            : `<div class="ui-field"><label for="ss-pw">New password</label><input class="input" id="ss-pw" type="password" autocomplete="new-password"></div>`; };
          ov.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; ov.querySelectorAll('[data-m]').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
          draw();
        },
        onSave: async (ov) => {
          const body = { host: s.host, port: s.port, username: s.username };
          if (mode === 'key') { body.privateKey = ov.querySelector('#ss-key').value; body.passphrase = ov.querySelector('#ss-pp').value || undefined; if (!body.privateKey.trim()) throw new Error('Paste the private key'); }
          else { body.password = ov.querySelector('#ss-pw').value; if (!body.password) throw new Error('Enter the password'); }
          const t = await API.post('/servers/test', body);
          if (!t.success) throw new Error(`Login test failed — nothing saved. ${sshErrorHint(t.error || '')}`);
          return save(body, 'Login saved');
        },
      });
    },
    access: () => UI.dialog({
      title: 'Access password',
      body: s.hasAccessPassword
        ? `<div class="ui-field"><label for="ss-ac">Current access password</label><input class="input" id="ss-ac" type="password" autocomplete="off"></div><div class="ui-field"><label for="ss-an">New access password</label><input class="input" id="ss-an" type="password" autocomplete="off"><span class="ui-help">Leave empty to remove the access password.</span></div>`
        : `<div class="ui-field"><label for="ss-an">Access password</label><input class="input" id="ss-an" type="password" autocomplete="off"><span class="ui-help">Anyone switching to this server in DockGate must enter it.</span></div>`,
      onSave: (ov) => {
        const nw = ov.querySelector('#ss-an').value;
        if (s.hasAccessPassword) { const cur = ov.querySelector('#ss-ac').value; if (!cur) throw new Error('Enter the current access password'); return save({ currentAccessPassword: cur, accessPassword: nw }, nw ? 'Access password changed' : 'Access password removed'); }
        if (!nw.trim()) throw new Error('Enter an access password');
        return save({ accessPassword: nw }, 'Access password set');
      },
    }),
  };
  container.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => EDITS[b.dataset.edit]());
}
