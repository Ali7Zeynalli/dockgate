// Settings → System → Backup: download an encrypted backup of DockGate's own data, the nightly copies, and
// restore (danger zone). Server side: server/backup.js, /api/backup.

async function renderBackupInto(el) {
  let info;
  try { info = await API.get('/backup'); }
  catch (e) { el.innerHTML = UI.errorState(e, { compact: true, title: 'Backup information could not be loaded' }); return; }
  const fmtSize = (b) => formatBytes(b);
  const autos = info.auto || [];
  el.innerHTML = `
    ${UI.header('Backup', 'Everything DockGate knows — servers and their logins, SSH keys, registry logins, notification channels and rules, IP lists, firewall descriptions, audit log and settings — in one file. Containers and volume data are not in it; they live on your servers.')}
    ${UI.settings([
      { label: 'Download backup', desc: 'One file, encrypted with a password you choose. Without that password nobody can read it, not even DockGate.', action: UI.primary('Download…', 'data-bk-download') },
      { label: 'Nightly copies', desc: `Every night around 03:00 (server time) a copy is kept in DockGate's data folder (newest ${info.keep}). It helps against mistakes, not against losing the disk — download a backup for that.`,
        value: autos.length ? `<span class="ui-sub">${autos.length} kept · last ${escapeHtml(autos[0].name.slice(5, 15))} · ${fmtSize(autos[0].size)}</span>` : '<span class="ui-sub">the first copy is made a few minutes after DockGate starts</span>',
        action: autos.length ? UI.btn('Show copies', 'data-bk-list') : '' },
    ])}
    <div class="ui-ph"><div class="ui-ph-text"><div class="ui-ph-title" style="color:var(--danger)">Danger zone</div></div></div>
    <div style="border:1px solid var(--danger);border-radius:var(--radius-lg);overflow:hidden">
      ${UI.settings([{ label: 'Restore from a backup', desc: `Replaces every server, key and setting in this DockGate with the ones in the file. ${info.restartsItself ? 'DockGate restarts by itself.' : 'You restart the DockGate container to finish.'}`, action: `<button class="btn btn-xs btn-secondary" data-bk-restore style="color:var(--danger)">Restore…</button>` }])}
    </div>`;

  const askPassword = (title, onSave, extra = '') => UI.dialog({
    title, context: false, saveLabel: 'Download',
    body: `<div class="ui-field"><label for="bk-p1">Password for the file (at least 12 characters)</label><input class="input" id="bk-p1" type="password" autocomplete="new-password"></div>
      <div class="ui-field"><label for="bk-p2">Password again</label><input class="input" id="bk-p2" type="password" autocomplete="new-password"></div>${extra}
      ${UI.explain('Nothing changes here; a file is downloaded.', 'Keep the password: without it the file cannot be restored. DockGate does not store it.')}`,
    onSave: async (ov) => {
      const p1 = ov.querySelector('#bk-p1').value, p2 = ov.querySelector('#bk-p2').value;
      if (p1.length < 12) throw new Error('The password needs at least 12 characters');
      if (p1 !== p2) throw new Error('The two passwords are different');
      await onSave(p1, ov);
    },
  });
  const download = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    if (!r.ok) { let msg = `HTTP ${r.status}`; try { msg = (await r.json()).error || msg; } catch (e) { /* not JSON */ } throw new Error(msg); }
    const blob = await r.blob();
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'dockgate.dgbackup';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast(`Backup downloaded · ${formatBytes(blob.size)}`);
  };

  el.querySelector('[data-bk-download]').onclick = () => askPassword('Download backup', (pw, ov) => download('/api/backup/download', { password: pw, includeCompose: ov.querySelector('#bk-compose').checked }),
    `<label class="flex gap-2 text-sm" style="align-items:center"><input type="checkbox" id="bk-compose" checked> Include the compose folders DockGate manages (Git history is left out)</label>`);

  el.querySelector('[data-bk-list]')?.addEventListener('click', () => {
    const m = showModal('Nightly copies', UI.table([{ label: 'Copy' }, { label: 'Size' }, { label: '', align: 'right' }], autos.map(a => ({ cells: [
      `<span class="td-mono">${escapeHtml(a.name)}</span>`, fmtSize(a.size),
      `${UI.btn('Download…', `data-bk-dl="${escapeHtml(a.name)}"`)} ${UI.btn('Restore…', `data-bk-rs="${escapeHtml(a.name)}"`)}`,
    ] })), { minWidth: 0 }), [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelectorAll('[data-bk-dl]').forEach(b => b.onclick = () => { m.close(); askPassword(`Download ${b.dataset.bkDl}`, (pw) => download(`/api/backup/auto/${encodeURIComponent(b.dataset.bkDl)}/download`, { password: pw })); });
    m.overlay.querySelectorAll('[data-bk-rs]').forEach(b => b.onclick = () => { m.close(); confirmRestore({ copy: b.dataset.bkRs }); });
  });

  el.querySelector('[data-bk-restore]').onclick = () => UI.dialog({
    title: 'Restore from a backup', context: false, saveLabel: 'Check the file', danger: false,
    body: `<div class="ui-field"><label for="bk-file">Backup file (.dgbackup)</label><input class="input" id="bk-file" type="file" accept=".dgbackup,.dgbak"></div>
      <div class="ui-field"><label for="bk-pw">Password of the file</label><input class="input" id="bk-pw" type="password" autocomplete="off"></div>
      <span class="ui-help">The file is checked first; nothing changes until you confirm.</span>`,
    onSave: async (ov) => {
      const f = ov.querySelector('#bk-file').files[0];
      if (!f) throw new Error('Choose the backup file');
      const pw = ov.querySelector('#bk-pw').value;
      const r = await fetch('/api/backup/inspect', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Password': pw }, body: f, credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setTimeout(() => confirmRestore({ file: f, password: pw, summary: j }), 0);
    },
  });

  function confirmRestore({ file, password, summary, copy }) {
    const s = summary;
    UI.dialog({
      title: 'Restore DockGate', context: false, saveLabel: 'Restore', danger: true,
      body: `${s ? UI.settings([
          { label: 'Backup from', value: `${escapeHtml(formatTime(s.created))} · DockGate ${escapeHtml(s.version || '?')}` },
          { label: 'Contains', value: `database, ${s.sshKeys} SSH key file${s.sshKeys === 1 ? '' : 's'}${s.includeCompose ? `, ${s.composeFiles} compose file${s.composeFiles === 1 ? '' : 's'}` : ', no compose folders'}` },
        ]) : `<p class="text-sm" style="margin:0">Nightly copy <span class="td-mono">${escapeHtml(copy)}</span>.</p>`}
        ${info.envMasterKey ? '<div class="insight-card warning"><span>This DockGate gets its master key from DG_MASTER_KEY. The backup brings its own key file; set DG_MASTER_KEY to the old value (or remove it) or stored passwords cannot be read.</span></div>' : ''}
        ${UI.explain(`Every server, key and setting here is replaced with the backup's. You log in with the backup's admin password. ${info.restartsItself ? 'DockGate restarts by itself.' : 'Then restart the DockGate container (docker restart …) to finish.'}`, 'The current data is moved to backups/pre-restore-… in the data folder first, so it can be put back by hand.')}
        <div class="ui-field"><label for="bk-confirm">Type <span class="td-mono">restore</span> to confirm</label><input class="input" id="bk-confirm" autocomplete="off"></div>`,
      onSave: async (ov) => {
        if (ov.querySelector('#bk-confirm').value.trim() !== 'restore') throw new Error('Type restore to confirm');
        let r;
        if (copy) r = await API.post(`/backup/auto/${encodeURIComponent(copy)}/restore`, { confirm: 'restore' });
        else {
          const x = await fetch('/api/backup/restore?confirm=restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Password': password }, body: file, credentials: 'same-origin' });
          r = await x.json().catch(() => ({}));
          if (!x.ok) throw new Error(r.error || `HTTP ${x.status}`);
        }
        if (r.restarting) {
          showModal('Restoring', '<p class="text-sm" style="margin:0">DockGate is restarting with the restored data. This page reloads when it is back.</p>', []);
          const wait = async () => { try { const z = await fetch('/api/auth/status', { cache: 'no-store' }); if (z.ok) { location.reload(); return; } } catch (e) { /* still down */ } setTimeout(wait, 2000); };
          setTimeout(wait, 3000);
        } else {
          showModal('Restart DockGate to finish', '<p class="text-sm" style="margin:0">The backup is checked and staged. Restart the DockGate container (for example <span class="td-mono">docker restart dockgate-control-panel</span>); the restored data is put in place before DockGate opens its database.</p>', [{ label: 'OK', className: 'btn btn-primary' }]);
        }
      },
    });
  }
}
