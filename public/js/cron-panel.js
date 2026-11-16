// Server Console → Cron: scheduled jobs of the server — crontabs, /etc/cron.d, cron.daily…, systemd timers.
// Editable: the SSH user's crontab, root's crontab (sudo) and /etc/cron.d/dockgate. Everything else is shown
// as it is (system and package files are not rewritten; ⋯ → Open in Files to change one yourself).
async function renderCronPanel(serverId, container) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  container.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>';
  let d;
  try { d = await API.get(`/servers/${serverId}/cron`); }
  catch (e) { container.innerHTML = UI.errorState(e, { title: "The server's cron jobs could not be read" }); return; }
  const reload = () => renderCronPanel(serverId, container);
  const st = Store.view('cron-' + serverId);
  const filter = st.get('filter', 'all');
  const local = (ms) => new Date(ms);
  const fmtServer = (ms) => { const x = new Date(ms + d.offsetMin * 60000); return x.toISOString().slice(0, 16).replace('T', ' '); };
  const fmtWhen = (ms) => {
    if (!ms) return '—';
    const diff = ms - Date.now(), abs = Math.abs(diff), m = Math.round(abs / 60000);
    const rel = m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
    return `${fmtServer(ms)} <span class="ui-sub">(${diff > 0 ? 'in ' + rel : rel + ' ago'})</span>`;
  };
  const yourOffset = -new Date().getTimezoneOffset();
  const tzTxt = (o) => `UTC${o >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(o) / 60)).padStart(2, '0')}:${String(Math.abs(o) % 60).padStart(2, '0')}`;
  const all = d.sources.flatMap(s => s.jobs.map(j => ({ ...j, src: s })));
  const failed = all.filter(j => j.lastCode != null && j.lastCode !== 0);
  const counts = { all: all.length + d.timers.length, user: 0, root: 0, dockgate: 0, system: 0, timers: d.timers.length, failed: failed.length };
  all.forEach(j => { if (['user', 'root', 'dockgate'].includes(j.src.id)) counts[j.src.id]++; else counts.system++; });
  const shown = all.filter(j => filter === 'all' || (filter === 'system' ? !j.src.editable && !['user', 'root', 'dockgate'].includes(j.src.id) : filter === 'failed' ? (j.lastCode != null && j.lastCode !== 0) : j.src.id === filter));
  const editable = d.sources.filter(s => s.editable);

  const toggle = (j) => j.src.editable ? `<div class="toggle ${j.enabled ? 'active' : ''}" role="switch" tabindex="0" aria-checked="${j.enabled}" aria-label="On" data-toggle="${esc(j.src.id)}|${j.index}"></div>` : `<span class="ui-sub" title="Read only">${j.enabled ? 'on' : 'off'}</span>`;
  const ago = (ms) => { const m = Math.round(Math.abs(Date.now() - ms) / 60000); return `<span title="${fmtServer(ms)} server time">${m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'} ago</span>`; };
  const last = (j) => {
    if (j.lastCode != null) return j.lastCode === 0 ? `<span style="color:var(--success)">✓</span> ${ago(j.lastRun)}` : `<span style="color:var(--danger);font-weight:600">✗ exit ${j.lastCode}</span> · ${ago(j.lastRun)}`;
    return j.lastRun ? `<span class="ui-sub">started</span> ${ago(j.lastRun)}` : '<span class="ui-sub">—</span>';
  };
  const cmdShort = (c) => String(c).replace(/^(\/usr\/local\/lib\/dockgate\/dg-cron|~\/\.dockgate\/bin\/dg-cron)\s+\S+\s+/, '').replace(/\s+>>\s+\S+\/[\w.-]+\.log 2>&1$/, '');
  const notes = d.sources.filter(s => s.note).map(s => `<div class="insight-card warning" style="margin:0 0 8px"><div><b>${esc(s.label)}</b>: ${esc(s.note)}</div></div>`).join('');

  container.innerHTML = `
    ${UI.header('Cron jobs', 'Scheduled commands on this server: crontabs, /etc/cron.d and systemd timers. Jobs run on the server\'s clock.',
      `<span class="ui-chip">Server time <b class="td-mono" style="margin-left:4px">${fmtServer(Date.now()).slice(11)} ${esc(d.tzName || tzTxt(d.offsetMin))}</b>${d.offsetMin !== yourOffset ? ` <span class="ui-sub" style="margin-left:4px">· yours ${tzTxt(yourOffset)}</span>` : ''}</span>
       ${d.cronRunning ? UI.pill('ok', '● cron running') : UI.pill('bad', '● cron not running')}
       ${editable.length ? UI.primary('+ New job', 'data-new') : ''}`)}
    ${!d.cronRunning ? '<div class="insight-card danger" style="margin-bottom:10px"><div><b>No cron daemon is running.</b> None of these jobs runs until it is started (Services tab: <span class="td-mono">cron</span> / <span class="td-mono">crond</span>).</div></div>' : ''}
    ${notes}
    ${UI.chips([['all', 'All', counts.all], ['user', d.sshUser, counts.user], ...(d.sshUser !== 'root' ? [['root', 'root', counts.root]] : []), ['dockgate', 'DockGate file', counts.dockgate], ['system', 'System (read only)', counts.system], ['timers', 'systemd timers', counts.timers], ['failed', 'Failed', counts.failed]], filter)}
    ${filter !== 'timers' ? UI.table([{ label: 'On' }, { label: 'Schedule' }, { label: 'Command' }, { label: 'User · source' }, { label: 'Next run' }, { label: 'Last run' }, { label: '', align: 'right' }],
      shown.map(j => ({ cls: j.enabled ? '' : 'ui-row-off', cells: [
        toggle(j),
        `<b>${esc(j.human)}</b><div class="ui-sub td-mono">${esc(j.schedule)}</div>${j.error ? `<div class="text-danger ui-sub">${esc(j.error)}</div>` : ''}`,
        `${j.meta && j.meta.name ? `<b>${esc(j.meta.name)}</b> ${j.meta.notify ? UI.pill('info', 'alerts') : ''} ${j.meta.log ? UI.pill('off', 'log') : ''}<br>` : ''}<span class="td-mono" style="font-size:12px;display:inline-block;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom" title="${esc(j.command)}">${esc(cmdShort(j.command))}</span>`,
        `${esc(j.user)}<div class="ui-sub" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(j.src.label)}">${esc(j.src.label.replace(/ — .*$/, '').replace(/ \(package \/ system\)$/, ''))}</div>`,
        j.enabled ? (j.next[0] ? `<span title="${fmtServer(j.next[0])} server time">${fmtServer(j.next[0]).slice(5)}</span><div class="ui-sub">${(() => { const m = Math.round((j.next[0] - Date.now()) / 60000); return 'in ' + (m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'); })()}</div>` : (/@reboot/i.test(j.schedule) ? '<span class="ui-sub">at reboot</span>' : '—')) : '<span class="ui-sub">— turned off</span>',
        last(j),
        `${j.src.editable ? UI.btn('Edit', `data-edit="${esc(j.src.id)}|${j.index}"`) : ''} ${UI.menu([
          { label: 'Run now…', attrs: `data-run="${esc(j.src.id)}|${j.index}"` },
          j.meta && j.meta.log ? { label: 'Open its log', attrs: `data-log="${esc(j.src.id)}|${j.index}"` } : null,
          !j.src.editable && j.src.id.startsWith('file:') ? { label: 'Open in Files', attrs: `data-files="${esc(j.src.id.slice(5))}"` } : null,
          !j.src.editable && j.src.id === 'etc' ? { label: 'Open in Files', attrs: 'data-files="/etc/crontab"' } : null,
          j.src.editable ? '-' : null,
          j.src.editable ? { label: `${Icons.trash} Delete…`, attrs: `data-del="${esc(j.src.id)}|${j.index}"`, danger: true } : null])}`,
      ] })), { empty: 'No jobs here.', minWidth: 940 }) : ''}
    ${(filter === 'all' || filter === 'timers') && d.timers.length ? `${UI.header('systemd timers', 'Many distributions run their regular work (apt, logrotate, fstrim, certbot) with timers instead of cron. Shown, not changed.')}
      ${UI.table([{ label: 'Timer' }, { label: 'When' }, { label: 'Runs' }, { label: 'Next run' }, { label: 'Last run' }],
        d.timers.map(t => ({ cells: [`<span class="td-mono">${esc(t.unit)}</span>`, `<span class="td-mono ui-sub">${esc(t.calendar || '—')}</span>`, `<span class="td-mono">${esc(t.runs)}</span>`, t.next ? fmtWhen(t.next) : '—', t.last ? fmtWhen(t.last) : '—'] })), { minWidth: 800 })}` : ''}
    ${filter === 'all' && d.periodic.length ? `<details style="margin-top:12px"><summary class="text-sm" style="cursor:pointer">Scripts in /etc/cron.hourly, daily, weekly, monthly (${d.periodic.length})</summary><div class="ui-sub td-mono" style="margin-top:6px;line-height:1.8">${['hourly', 'daily', 'weekly', 'monthly'].map(p => { const l = d.periodic.filter(x => x.period === p); return l.length ? `<b>${p}</b>: ${l.map(x => esc(x.name)).join(', ')}` : ''; }).filter(Boolean).join('<br>')}</div></details>` : ''}
    ${failed[0] ? `<div class="insight-card danger" style="margin-top:14px"><div style="flex:1"><b>${esc(failed[0].meta && failed[0].meta.name ? failed[0].meta.name : cmdShort(failed[0].command))} failed (exit ${failed[0].lastCode})</b> ${fmtWhen(failed[0].lastRun)}<div style="margin-top:8px">${UI.btn('Run now…', `data-run="${esc(failed[0].src.id)}|${failed[0].index}"`, 'btn-primary')} ${failed[0].meta && failed[0].meta.log ? UI.btn('Open its log', `data-log="${esc(failed[0].src.id)}|${failed[0].index}"`) : ''}</div></div></div>` : ''}
    <div class="ui-sub" style="margin-top:12px">Written by DockGate: ${esc(d.sshUser)}'s crontab${d.sshUser !== 'root' ? ', root\'s crontab (sudo)' : ''} and <span class="td-mono">${esc(d.dgFile)}</span>. The crontab before each change is kept (${UI.btn('Earlier versions…', 'data-versions')}).</div>`;

  const find = (key) => { const [src, idx] = key.split('|'); return all.find(j => j.src.id === src && String(j.index) === idx); };
  container.querySelectorAll('[data-chip]').forEach(b => b.addEventListener('click', () => { st.set('filter', b.dataset.chip); reload(); }));
  container.querySelector('[data-new]')?.addEventListener('click', () => openJob(null));
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openJob(find(b.dataset.edit))));
  container.querySelectorAll('[data-files]').forEach(b => b.addEventListener('click', () => { const p = b.dataset.files; FileEditor.open({ path: p, name: p.split('/').pop() }); }));
  container.querySelectorAll('[data-toggle]').forEach(t => t.addEventListener('click', () => {
    const j = find(t.dataset.toggle);
    change(j.src.id, { action: 'toggle', index: j.index, raw: j.raw }, `${j.enabled ? 'Turn off' : 'Turn on'} this job?`, true);
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { const j = find(b.dataset.del); change(j.src.id, { action: 'delete', index: j.index, raw: j.raw }, 'Delete this job?'); }));
  container.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runNow(find(b.dataset.run))));
  container.querySelectorAll('[data-log]').forEach(b => b.addEventListener('click', () => {
    const j = find(b.dataset.log);
    const p = j.src.id === 'user' ? `~/.dockgate/cron-logs/${j.meta.name}.log` : `/var/log/dockgate-cron/${j.meta.name}.log`;
    showLog(j, p);
  }));
  container.querySelector('[data-versions]')?.addEventListener('click', versions);

  // Preview the change as a diff, then write it.
  async function change(source, op, title, quick = false) {
    let pv;
    try { pv = await API.post(`/servers/${serverId}/cron/change`, { source, op, preview: true }); } catch (e) { return showToast(e.message, 'error', 9000); }
    const diff = FileEditor.diffLines(pv.before, pv.after);
    const rows = diff.filter((x, i) => x.t !== ' ' || diff.slice(Math.max(0, i - 2), i + 3).some(y => y.t !== ' '));
    const html = `<pre class="td-mono" style="font-size:12px;max-height:40vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:0">${rows.map(x => `<div style="white-space:pre;${x.t === '+' ? 'color:var(--success);background:rgba(16,185,129,.12)' : x.t === '-' ? 'color:var(--danger);background:rgba(239,68,68,.12)' : 'opacity:.6'}">${x.t} ${esc(x.s)}</div>`).join('')}</pre>`;
    const label = { user: `${d.sshUser}'s crontab`, root: "root's crontab", dockgate: d.dgFile }[source];
    UI.dialog({ title: esc(title), saveLabel: 'Save', context: true, wide: !quick,
      body: `<div class="text-sm" style="margin-bottom:8px">What changes in <b>${esc(label)}</b>. The crontab before this change is kept under Earlier versions.</div>${html}`,
      onSave: async () => { await API.post(`/servers/${serverId}/cron/change`, { source, op }); showToast('Saved'); reload(); } });
  }

  function openJob(j) {
    const meta = (j && j.meta) || {};
    const srcOpts = editable.map(s => `<option value="${s.id}" ${j ? (j.src.id === s.id ? 'selected' : '') : (s.id === (d.sshUser === 'root' ? 'user' : 'user') ? 'selected' : '')}>${esc(s.id === 'user' ? `${d.sshUser} (SSH user) — crontab` : s.id === 'root' ? 'root — crontab (sudo)' : `${d.dgFile} (choose the user)`)}</option>`).join('');
    const presets = [['*/5 * * * *', 'Every 5 min'], ['0 * * * *', 'Hourly'], ['30 3 * * *', 'Daily 03:30'], ['0 4 * * 1', 'Weekly (Mon 04:00)'], ['0 3 1 * *', 'Monthly'], ['@reboot', 'At reboot']];
    const dlg = UI.dialog({ title: j ? 'Edit cron job' : 'New cron job', saveLabel: 'Review changes…', wide: true,
      body: `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
          <label class="ui-field"><span class="ui-label">Name</span><input class="input" id="cj-name" value="${esc(meta.name || '')}" placeholder="db-backup"><span class="ui-sub">Needed for its log and alerts</span></label>
          <label class="ui-field"><span class="ui-label">Runs as</span><select class="input" id="cj-src" ${j ? 'disabled' : ''}>${srcOpts}</select></label>
          <label class="ui-field" id="cj-userf" style="display:none"><span class="ui-label">User</span><input class="input td-mono" id="cj-user" value="${esc((j && j.user) || 'root')}"></label>
        </div>
        <div class="ui-field"><span class="ui-label">When</span><div style="display:flex;gap:6px;flex-wrap:wrap">${presets.map(([v, l]) => `<button type="button" class="ui-fchip" data-preset="${esc(v)}">${l}</button>`).join('')}</div></div>
        <div style="display:grid;grid-template-columns:minmax(200px,1fr) 2fr;gap:10px;align-items:start">
          <label class="ui-field"><span class="ui-label">Schedule (server time)</span><input class="input td-mono" id="cj-sched" value="${esc((j && j.schedule) || '30 3 * * *')}"><span class="ui-sub">minute hour day month weekday · or @daily, @hourly, @reboot</span></label>
          <div class="ui-field"><span class="ui-label" id="cj-human">—</span><div class="ui-sub td-mono" id="cj-next" style="line-height:1.7"></div></div>
        </div>
        <label class="ui-field"><span class="ui-label">Command</span><textarea class="input td-mono" id="cj-cmd" rows="2" placeholder="/opt/scripts/backup.sh">${esc(j ? cmdShort(j.command) : '')}</textarea><span class="ui-sub">Cron has a short PATH — use full paths. A % in the command means a new line to cron: write \\% for a literal one.</span></label>
        <div style="display:grid;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary)">
          <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cj-log" ${meta.log ? 'checked' : ''}> Keep its output in a log <span class="ui-sub" id="cj-logpath"></span></label>
          <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cj-fail" ${(meta.notify || []).includes('fail') ? 'checked' : ''}> Notify when it fails (exit code ≠ 0, with its last lines)</label>
          <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="cj-missed" ${(meta.notify || []).includes('missed') ? 'checked' : ''}> Notify when it does not run (no start within 30 min of its time)</label>
          <span class="ui-sub">Alerts use a small wrapper DockGate installs (<span class="td-mono">dg-cron</span>); it records how each run ended. Channels: Settings → Notifications.</span>
        </div>`,
      onOpen: (ov) => {
        const sched = ov.querySelector('#cj-sched'), src = ov.querySelector('#cj-src');
        const sync = () => {
          ov.querySelector('#cj-userf').style.display = src.value === 'dockgate' ? '' : 'none';
          const name = ov.querySelector('#cj-name').value.trim() || 'NAME';
          ov.querySelector('#cj-logpath').textContent = `— ${src.value === 'user' ? '~/.dockgate/cron-logs' : '/var/log/dockgate-cron'}/${name}.log`;
        };
        let t = null;
        const next = () => { clearTimeout(t); t = setTimeout(async () => {
          try { const r = await API.post(`/servers/${serverId}/cron/next`, { schedule: sched.value, offsetMin: d.offsetMin }); ov.querySelector('#cj-human').textContent = r.human; ov.querySelector('#cj-next').innerHTML = r.next.length ? 'Next: ' + r.next.map(x => fmtServer(x)).join(' · ') + (d.offsetMin !== yourOffset ? `<br><span>${esc(tzTxt(d.offsetMin))} server · first one is ${esc(local(r.next[0]).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))} your time</span>` : '') : (/@reboot/i.test(sched.value) ? 'Runs when the server starts' : ''); }
          catch (e) { ov.querySelector('#cj-human').textContent = 'Not a valid schedule'; ov.querySelector('#cj-next').textContent = e.message; }
        }, 250); };
        sched.addEventListener('input', next);
        ov.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { sched.value = b.dataset.preset; next(); }));
        src.addEventListener('change', sync); ov.querySelector('#cj-name').addEventListener('input', sync);
        sync(); next();
      },
      onSave: async (ov) => {
        const v = (id) => ov.querySelector('#' + id).value.trim();
        const notify = [ov.querySelector('#cj-fail').checked && 'fail', ov.querySelector('#cj-missed').checked && 'missed'].filter(Boolean);
        const entry = { schedule: v('cj-sched'), command: v('cj-cmd'), user: v('cj-user'), enabled: j ? j.enabled : true, meta: { name: v('cj-name'), notify, log: ov.querySelector('#cj-log').checked } };
        const source = j ? j.src.id : v('cj-src');
        const op = j ? { action: 'update', index: j.index, raw: j.raw, entry } : { action: 'add', entry };
        await API.post(`/servers/${serverId}/cron/change`, { source, op, preview: true }); // errors keep this dialog open
        setTimeout(() => change(source, op, j ? 'Save this job?' : 'Add this job?'), 0);
      } });
    void dlg;
  }

  async function runNow(j) {
    showConfirm('Run now', `Run <span class="td-mono">${esc(cmdShort(j.command))}</span> once now, as <b>${esc(j.user)}</b>? Its output is shown here (up to 2 minutes).`, async () => {
      const m = showModal(`Running ${esc(j.meta && j.meta.name ? j.meta.name : 'job')}…`, '<div data-out><span class="ui-sub">Running…</span></div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
      m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
      try {
        const r = await API.post(`/servers/${serverId}/cron/run`, { source: j.src.id, command: j.command, user: j.user });
        const box = m.overlay.querySelector('[data-out]');
        if (box) box.innerHTML = `<div style="margin-bottom:8px">${r.code === 0 ? UI.pill('ok', '✓ exit 0') : UI.pill('bad', `✗ exit ${r.code}`)} <span class="ui-sub">${r.ms != null ? `${(r.ms / 1000).toFixed(1)} s` : ''}</span></div><pre class="td-mono" style="font-size:12px;max-height:50vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:0;white-space:pre-wrap">${esc(r.output || '(no output)')}</pre>`;
      } catch (e) { const box = m.overlay.querySelector('[data-out]'); if (box) box.innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; }
    });
  }

  function showLog(j, path) {
    const m = showModal(`📜 ${esc(j.meta.name)}.log`, `<div class="ui-sub td-mono" style="margin-bottom:8px">${esc(path)}</div><div data-lv></div>`, [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const abs = path.startsWith('~') ? path : path;
    const viewer = LogViewer.mount(m.overlay.querySelector('[data-lv]'), { key: 'cron-log', fileName: j.meta.name, live: true, poll: 5000, liveDefault: false, height: '50vh', compact: true,
      load: async (limit) => {
        const p = abs.startsWith('~') ? abs.replace('~', (await API.get('/files/places')).home) : abs;
        try { return { text: (await API.get(`/files/tail?path=${encodeURIComponent(p)}&lines=${limit}`)).text, format: 'auto' }; }
        catch (e) { if (e.code === 'EACCES') return { text: (await API.get(`/files/tail?path=${encodeURIComponent(p)}&lines=${limit}&sudo=1`)).text, format: 'auto' }; throw e; }
      } });
    new MutationObserver((_, o) => { if (!document.body.contains(m.overlay)) { viewer.destroy(); o.disconnect(); } }).observe(document.getElementById('modal-root'), { childList: true });
  }

  async function versions() {
    const lists = await Promise.all(editable.map(s => API.get(`/servers/${serverId}/cron/versions?source=${s.id}`).then(l => l.map(v => ({ ...v, source: s.id }))).catch(() => [])));
    const list = lists.flat().sort((a, b) => b.t - a.t);
    const m = showModal('Earlier versions', list.length ? `<div class="text-sm" style="margin-bottom:8px">The crontab before each change from DockGate (the last 5 of each).</div>${list.map(v => `<button type="button" class="btn btn-secondary" style="display:flex;width:100%;justify-content:space-between;margin-bottom:6px" data-ver="${v.id}"><span>${esc({ user: d.sshUser + "'s crontab", root: "root's crontab", dockgate: d.dgFile }[v.source])}</span><span class="ui-sub">${esc(new Date(v.t).toLocaleString())}</span></button>`).join('')}` : '<div class="text-sm">No earlier version yet — one is kept with each change made here.</div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
    m.overlay.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', async () => {
      try { const v = await API.get(`/files/version?id=${b.dataset.ver}`); showModal('Earlier version', `<pre class="td-mono" style="font-size:12px;max-height:60vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:0;white-space:pre">${esc(v.content || '(empty)')}</pre><div class="ui-sub" style="margin-top:6px">To bring a job back, add it again with + New job.</div>`, [{ label: 'Close', className: 'btn btn-secondary' }]); }
      catch (e) { showToast(e.message, 'error'); }
    }));
  }
}
