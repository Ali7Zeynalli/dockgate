// Image update — one place for the "newer image" flow used by Containers and the container detail page:
// the confirm dialog (version before → after), the live job window (steps + log, can be closed and
// reopened), the update history table, the stored log of a past run and the roll back.
// Server side: server/image-update-runner.js (routes under /api/containers/…/image-update(s)).

const ImageUpdate = (() => {
  const short = (id) => String(id || '').replace(/^sha256:/, '').slice(0, 12);
  const ver = (v, digest) => (v ? escapeHtml(v) : digest ? `<span class="td-mono">${escapeHtml(short(digest))}</span>` : '?');
  const day = (iso) => (iso ? escapeHtml(String(iso).slice(0, 10)) : '');
  const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : '');
  const major = (v) => { const m = String(v || '').match(/(\d+)/); return m ? Number(m[1]) : null; };

  /** "15.8 → 15.19" for a newer-image check row (falls back to digests). */
  function checkChange(c) {
    if (!c) return '';
    return `${ver(c.local_version, c.local_digest)} → ${ver(c.remote_version, c.remote_digest)}`;
  }

  function resultPill(r) {
    switch (r.status) {
      case 'running': return UI.pill('warn', 'Running');
      case 'updated': return UI.pill('ok', r.kind === 'rollback' ? 'Rolled back' : 'Updated');
      case 'no_change': return UI.pill('off', 'Already newest');
      case 'rolled_back': return UI.pill('warn', 'Failed · previous image restored');
      default: return UI.pill('bad', 'Failed');
    }
  }

  // ---- live job window ----
  /** opts.afterClose: call onDone when the window is closed (a page that navigates away would close it). */
  function openJob(jobId, title, onDone, { afterClose = false } = {}) {
    const m = showModal(escapeHtml(title || 'Image update'), `
      <div id="iu-steps" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px"></div>
      <div id="iu-log"></div>
      <div id="iu-status" style="margin-top:10px;font-size:13px;font-weight:600;color:var(--text-muted)">⏳ Working…</div>
      <div class="ui-sub" style="margin-top:4px">Closing this window does not stop the update. Reopen it from the container's Updates tab or Containers → Update history.</div>`, []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const footer = m.overlay.querySelector('#modal-footer');
    const closeBtn = document.createElement('button');
    let endedJob = null;
    const close = () => { m.close(); if (afterClose && endedJob && onDone) onDone(endedJob); };
    closeBtn.className = 'btn btn-secondary'; closeBtn.textContent = 'Close'; closeBtn.onclick = close;
    m.overlay.querySelector('.modal-close').onclick = close;
    m.overlay.onclick = (e) => { if (e.target === m.overlay) close(); };
    footer.appendChild(closeBtn);
    const viewer = LogViewer.mount(m.overlay.querySelector('#iu-log'), { key: 'image-update', fileName: `image-update-${jobId}`, live: true, limits: null, compact: true, height: '300px', empty: 'Starting…' });
    let sent = 0, finished = false, sawRunning = false, timer = null;
    const feed = (log, all) => { const lines = String(log || '').split('\n'); const upto = all ? lines.length : lines.length - 1; if (upto > sent) { viewer.push(lines.slice(sent, upto).join('\n')); sent = upto; } };
    const icon = { pending: '○', running: '⏳', done: '✓', failed: '✗' };
    const color = { pending: 'var(--text-muted)', running: 'var(--text-primary)', done: '#16a34a', failed: '#dc2626' };
    async function poll() {
      if (!m.overlay.isConnected) { clearTimeout(timer); return; }
      try {
        const j = await API.get(`/containers/image-updates/job/${jobId}`);
        if (j.status === 'running') sawRunning = true;
        feed(j.log, j.status !== 'running');
        const st = m.overlay.querySelector('#iu-steps');
        if (st) st.innerHTML = (j.steps || []).map(s => `<div class="text-sm" style="color:${color[s.status]}">${icon[s.status] || '○'} ${escapeHtml(s.label)}</div>`).join('');
        const se = m.overlay.querySelector('#iu-status');
        if (j.status !== 'running' && !finished) {
          finished = true;
          const r = (j.result || {}).status;
          const msg = { updated: j.kind === 'rollback' ? '✓ Rolled back' : '✓ Updated', no_change: '✓ Already the newest image — nothing changed',
            rolled_back: `⚠ The new container failed (${j.error || ''}) — the previous image is running again`, failed: `✗ Failed: ${j.error || ''}` }[r] || '✗ Failed';
          if (se) { se.style.color = r === 'updated' || r === 'no_change' ? '#16a34a' : r === 'rolled_back' ? '#d97706' : '#dc2626'; se.textContent = msg; }
          closeBtn.className = 'btn btn-primary';
          if (sawRunning) { showToast(msg.replace(/^[✓⚠✗] /, ''), r === 'updated' || r === 'no_change' ? 'success' : 'error', 9000); endedJob = j; if (onDone && !afterClose) onDone(j); }
          return;
        }
      } catch (e) {
        const se = m.overlay.querySelector('#iu-status');
        if (se && /not found/i.test(e.message)) { se.textContent = e.message; return; }
      }
      timer = setTimeout(poll, 1200);
    }
    poll();
    return m;
  }

  // ---- confirm + start ----
  /** ctx: { id, name, image, project, service, check } — check is the newer-image row (may be null). */
  function confirmUpdate(ctx, onDone, jobOpts) {
    const c = ctx.check || {};
    const inStack = ctx.project && ctx.service;
    const majorJump = major(c.local_version) != null && major(c.remote_version) != null && major(c.local_version) !== major(c.remote_version);
    const change = `<b>${escapeHtml(ctx.image)}</b>${c.remote_digest ? `: ${checkChange(c)}${c.remote_created ? ` <span class="ui-sub">(built ${day(c.remote_created)})</span>` : ''}` : ''}.<br>
      ${ctx.pulled ? 'The newer image of this tag is already on the server (another container using it was updated, or it was pulled). ' : ''}DockGate pulls the same tag, keeps the current image as a roll back point, then ${inStack
        ? `recreates only service <b>${escapeHtml(ctx.service)}</b> of stack <b>${escapeHtml(ctx.project)}</b> (<span class="td-mono">docker compose up -d --no-deps ${escapeHtml(ctx.service)}</span>)`
        : 'recreates the container with the same settings (the old one is kept stopped until the new one runs)'} and watches the new container for a few seconds${' '}(and its healthcheck, if it has one).`;
    const protects = `If the new container stops, keeps restarting or turns unhealthy, the previous image is put back automatically. Volumes are not touched and ${inStack ? 'the compose file is not changed' : 'settings stay the same'}.`
      + (majorJump ? `<div style="margin-top:6px;color:var(--danger,#dc2626)"><b>Major version change (${escapeHtml(c.local_version)} → ${escapeHtml(c.remote_version)}).</b> A database may convert its data files on the first start and the old version can not read them back — back up the volume first.</div>` : '');
    const undo = 'Roll back from the container\'s Updates tab while the previous image is on the server (DockGate keeps the last one; a full image prune removes it). A roll back changes the image only — data a new version already converted stays converted.';
    secConfirm({ title: `Update ${ctx.name}`, change, protects, undo, confirmLabel: 'Pull and update', onConfirm: async () => {
      try {
        const r = await API.post(`/containers/${encodeURIComponent(ctx.id)}/image-update`, {});
        openJob(r.jobId, `Update ${ctx.name}`, onDone, jobOpts);
      } catch (e) { showToast(e.message, 'error', 9000); }
    } });
  }

  function confirmRollback(row, onDone, jobOpts) {
    secConfirm({ title: `Roll back ${row.container_name}`,
      change: `<b>${escapeHtml(row.image)}</b> goes back to the image it ran before the update of ${escapeHtml(formatTime(iso(row.started_at)))}: ${ver(row.to_version, row.to_image_id)} → <b>${ver(row.from_version, row.from_image_id)}</b>. The tag on the server is pointed at that image and the ${row.project ? `service <b>${escapeHtml(row.service)}</b> is` : 'container is'} recreated.`,
      protects: 'The same check runs as for an update: if the container does not stay up, the current image is put back. The compose file is not changed — the next Update pulls the newest image again.',
      undo: 'Update again — the newer image is pulled from the registry.',
      confirmLabel: 'Roll back', onConfirm: async () => {
        try {
          const r = await API.post(`/containers/image-updates/${row.id}/rollback`, {});
          openJob(r.jobId, `Roll back ${row.container_name}`, onDone, jobOpts);
        } catch (e) { showToast(e.message, 'error', 9000); }
      } });
  }

  async function showLog(id) {
    try {
      const r = await API.get(`/containers/image-updates/${id}/log`);
      const m = showModal(`Update log · ${escapeHtml(r.container_name)}`, '<div id="iu-past-log"></div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
      m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
      const v = LogViewer.mount(m.overlay.querySelector('#iu-past-log'), { key: 'image-update', fileName: `image-update-${id}`, live: false, limits: null, compact: true, height: '380px', empty: 'No log stored.' });
      v.setText(r.log || '');
    } catch (e) { showToast(e.message, 'error'); }
  }

  /** History table. opts: { container: show the container column, rollbackId: row id offering Roll back }. */
  function historyTable(rows, { container = false, rollbackId = null, empty = 'No image updates yet.' } = {}) {
    const cols = [{ label: 'When' }, ...(container ? [{ label: 'Container' }] : []), { label: 'Image' }, { label: 'Version' }, { label: 'Result' }, { label: 'From' }, { label: '', align: 'right' }];
    return UI.table(cols, rows.map(r => ({ cells: [
      `<span class="text-sm" title="${escapeHtml(formatTime(iso(r.started_at)))}">${escapeHtml(timeAgo(iso(r.started_at)))}</span><div class="ui-sub">${r.kind === 'rollback' ? 'Roll back' : 'Update'}</div>`,
      ...(container ? [`<b>${escapeHtml(r.container_name)}</b>${r.project ? `<div class="ui-sub">${escapeHtml(r.project)} / ${escapeHtml(r.service)}</div>` : ''}`] : []),
      `<span class="td-mono text-sm">${escapeHtml(r.image)}</span>`,
      `<span class="text-sm">${ver(r.from_version, r.from_image_id)} → ${r.to_image_id || r.to_version ? ver(r.to_version, r.to_image_id) : '…'}</span>${r.to_digest ? `<div class="ui-sub td-mono" title="${escapeHtml(r.to_digest)}">${escapeHtml(short(r.from_digest))} → ${escapeHtml(short(r.to_digest))}</div>` : ''}`,
      `${resultPill(r)}${r.error ? `<div class="ui-sub" style="max-width:280px;white-space:normal">${escapeHtml(r.error.slice(0, 160))}</div>` : ''}`,
      `<span class="ui-sub">${escapeHtml(r.source_ip || '—')}</span>`,
      (r.status === 'running' && r.job_id ? UI.btn('Open', `data-iu-job="${escapeHtml(r.job_id)}" data-iu-name="${escapeHtml(r.container_name)}"`, 'btn-primary') : UI.btn('Log', `data-iu-log="${r.id}"`))
        + (rollbackId === r.id ? ' ' + UI.btn('Roll back', `data-iu-rollback="${r.id}"`) : ''),
    ] })), { empty, minWidth: container ? 860 : 720 });
  }
  /** Wire the buttons of historyTable() inside el. */
  function bindHistory(el, rows, onDone, jobOpts) {
    el.querySelectorAll('[data-iu-log]').forEach(b => b.addEventListener('click', () => showLog(b.dataset.iuLog)));
    el.querySelectorAll('[data-iu-job]').forEach(b => b.addEventListener('click', () => openJob(b.dataset.iuJob, `Update ${b.dataset.iuName}`, onDone, jobOpts)));
    el.querySelectorAll('[data-iu-rollback]').forEach(b => b.addEventListener('click', () => {
      const row = rows.find(r => String(r.id) === b.dataset.iuRollback); if (row) confirmRollback(row, onDone, jobOpts);
    }));
  }

  /** Containers → Update history: every update on the server in use. */
  async function openHistory() {
    const m = showModal('Image update history', '<div id="iu-hist" class="text-sm text-muted">Loading…</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const load = async () => {
      const el = m.overlay.querySelector('#iu-hist'); if (!el) return;
      try {
        const { rows } = await API.get('/containers/image-updates/history?limit=200');
        el.innerHTML = `<div class="ui-sub" style="margin-bottom:8px">Updates and roll backs started from DockGate on this server, newest first (the last 50 per container are kept). Roll back is offered on the container's page → Updates.</div>${historyTable(rows, { container: true })}`;
        bindHistory(el, rows, load);
      } catch (e) { el.innerHTML = UI.errorState(e, { compact: true }); }
    };
    load();
  }

  return { openJob, confirmUpdate, confirmRollback, showLog, historyTable, bindHistory, openHistory, checkChange, resultPill, ver };
})();
