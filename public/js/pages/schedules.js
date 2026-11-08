// Tools → Schedules: jobs DockGate runs by itself (server/schedules.js). Table with the last result and the
// next run, an On switch that saves at once, Run now, and one dialog to add or edit a task.
Router.register('schedules', async (content) => {
  const pageNavId = Router._navId;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const KIND = { prune: 'Prune unused data', volume_backup: 'Back up a volume', git_sync: 'Sync Git stacks' };
  const PRUNE = [['build_cache', 'Build cache'], ['images', 'Unused images'], ['containers', 'Stopped containers'], ['networks', 'Unused networks']];
  const when = (s) => s.freq === 'hourly' ? `every hour at :${(s.at || '00:00').slice(3)}` : s.freq === 'weekly' ? `every ${DAYS[s.weekday]} ${s.at}` : `every day ${s.at}`;
  const at = (ms) => ms ? formatTime(new Date(ms).toISOString()) : '—';
  const detail = (s) => s.kind === 'volume_backup' ? `to ${escapeHtml(s.params.dir)} on the server · keep ${s.params.keep}`
    : s.kind === 'git_sync' ? (s.params.projects && s.params.projects.length ? `stacks ${escapeHtml(s.params.projects.join(', '))}` : 'every DockGate-managed Git stack') + ' · only when there is a new commit'
    : 'unused volumes are never pruned';

  let data;
  async function render() {
    try { data = await API.get('/schedules'); }
    catch (e) { content.innerHTML = UI.errorState(e); return; }
    if (!Router.isActiveNav(pageNavId)) return;
    const srvName = (id) => (data.servers.find(x => x.id === id) || { name: id }).name;
    const rows = data.schedules.map(s => ({ cells: [
      `<b>${escapeHtml(s.name)}</b><div class="ui-sub">${detail(s)}</div>`,
      escapeHtml(srvName(s.server_id)),
      `<span class="text-sm">${when(s)}</span>`,
      s.running ? UI.pill('info', 'running…') : !s.last_run_at ? '<span class="text-muted">not run yet</span>'
        : `${UI.pill(s.last_status === 'ok' ? 'ok' : 'bad', s.last_status === 'ok' ? 'done' : 'failed')}<div class="ui-sub" title="${escapeHtml(s.last_message || '')}">${escapeHtml((s.last_message || '').slice(0, 90))}</div><div class="ui-sub">${at(s.last_run_at)} · ${Math.max(1, Math.round((s.last_duration_ms || 0) / 1000))} s</div>`,
      s.enabled ? `<span class="text-sm">${at(s.next_run_at)}</span>` : '<span class="text-muted">off</span>',
      `<div class="toggle ${s.enabled ? 'active' : ''}" role="switch" tabindex="0" aria-checked="${!!s.enabled}" aria-label="On" data-sch-toggle="${s.id}"></div>`,
      `${UI.btn('Run now', `data-sch-run="${s.id}" ${s.running ? 'disabled' : ''}`)} ${UI.menu([{ label: 'Edit…', attrs: `data-sch-edit="${s.id}"` }, '-', { label: `${Icons.trash} Delete…`, attrs: `data-sch-del="${s.id}"`, danger: true }])}`,
    ] }));
    content.innerHTML = `${UI.header('Schedules', `Jobs DockGate runs by itself on a server. Times are in ${escapeHtml(data.timezone)} (Settings → General → Timezone). A failed run sends the "Scheduled task failed" alert.`, UI.primary('Add schedule', 'data-sch-add'))}
      <div class="sch-table">${UI.table([{ label: 'Task' }, { label: 'Server' }, { label: 'When' }, { label: 'Last run' }, { label: 'Next' }, { label: 'On' }, { label: '', align: 'right' }], rows,
        { empty: 'No scheduled tasks yet. Add one to prune unused data, back up a volume or keep Git stacks in sync.', minWidth: 860 })}</div>`;

    content.querySelector('[data-sch-add]').onclick = () => openDialog(null);
    content.querySelectorAll('[data-sch-edit]').forEach(b => b.addEventListener('click', () => openDialog(data.schedules.find(s => String(s.id) === b.dataset.schEdit))));
    content.querySelectorAll('[data-sch-del]').forEach(b => b.addEventListener('click', () => {
      const s = data.schedules.find(x => String(x.id) === b.dataset.schDel);
      showConfirm('Delete scheduled task', `"${escapeHtml(s.name)}" stops running. Files it already made (backups) stay where they are.`, async () => {
        try { await API.del(`/schedules/${s.id}`); showToast('Task deleted'); render(); } catch (e) { showToast(e.message, 'error'); }
      }, true);
    }));
    content.querySelectorAll('[data-sch-run]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Running…';
      try {
        const r = await API.post(`/schedules/${b.dataset.schRun}/run`, {});
        showToast(r.result && r.result.ok ? `Done · ${r.result.message}` : `Failed · ${(r.result && r.result.message) || ''}`, r.result && r.result.ok ? 'success' : 'error', 9000);
      } catch (e) { showToast(e.message, 'error', 8000); }
      render();
    }));
    content.querySelectorAll('[data-sch-toggle]').forEach(t => {
      const flip = async () => {
        const on = !t.classList.contains('active');
        t.classList.toggle('active', on); t.setAttribute('aria-checked', on);
        try { await API.put(`/schedules/${t.dataset.schToggle}`, { enabled: on }); showToast(`Saved · ${on ? 'on' : 'off'}`); render(); }
        catch (e) { t.classList.toggle('active', !on); showToast(e.message, 'error'); }
      };
      t.addEventListener('click', flip);
      t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    });
  }

  async function openDialog(s) {
    const cur = s || { kind: 'prune', server_id: (Store.get('activeServer') || {}).id || 'local', freq: 'daily', at: '03:30', weekday: 0, params: { build_cache: true, images: true } };
    let vols = [];
    try { vols = (await API.get('/volumes')).map(v => v.name); } catch (e) { /* free text then */ }
    const opt = (list, v) => list.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
    const body = `
      <div class="ui-field"><label for="sc-kind">Task</label><select class="select" id="sc-kind">${opt(Object.entries(KIND), cur.kind)}</select></div>
      <div class="ui-field"><label for="sc-srv">Server</label><select class="select" id="sc-srv">${opt(data.servers.map(x => [x.id, x.name]), cur.server_id)}</select></div>
      <div class="flex gap-2" style="flex-wrap:wrap">
        <div class="ui-field"><label for="sc-freq">How often</label><select class="select" id="sc-freq">${opt([['daily', 'Every day'], ['weekly', 'Every week'], ['hourly', 'Every hour']], cur.freq)}</select></div>
        <div class="ui-field" data-show="weekly"><label for="sc-day">Day</label><select class="select" id="sc-day">${opt(DAYS.map((d, i) => [i, d]), cur.weekday ?? 0)}</select></div>
        <div class="ui-field"><label for="sc-at">Time (HH:MM; hourly uses the minutes)</label><input class="input" id="sc-at" value="${escapeHtml(cur.at || '03:30')}" style="width:110px"></div>
      </div>
      <div data-kind="prune" class="ui-field"><span class="ui-label">Prune</span>${PRUNE.map(([k, l]) => `<label class="flex gap-2 text-sm" style="align-items:center"><input type="checkbox" data-prune="${k}" ${cur.kind === 'prune' && cur.params[k] ? 'checked' : ''}> ${l}</label>`).join('')}<span class="ui-help">Unused volumes are not offered: deleting data on a timer is too easy to regret.</span></div>
      <div data-kind="volume_backup" style="display:grid;gap:10px">
        <div class="ui-field"><label for="sc-vol">Volume</label><input class="input" id="sc-vol" list="sc-vols" value="${escapeHtml(cur.params.volume || '')}" placeholder="shop_pgdata"><datalist id="sc-vols">${vols.map(v => `<option value="${escapeHtml(v)}">`).join('')}</datalist><span class="ui-help">The list shows the volumes of the server in use; type the name for another server.</span></div>
        <div class="ui-field"><label for="sc-dir">Folder on the server</label><input class="input td-mono" id="sc-dir" value="${escapeHtml(cur.params.dir || '/var/backups/dockgate')}"></div>
        <div class="ui-field"><label for="sc-keep">Keep the newest</label><div class="flex gap-2" style="align-items:center"><input class="input" id="sc-keep" type="number" min="1" max="365" value="${cur.params.keep || 7}" style="width:90px"><span class="text-sm text-muted">backups</span></div></div>
      </div>
      <div data-kind="git_sync" class="ui-field"><label for="sc-proj">Stacks (empty = every DockGate-managed Git stack on that server)</label><input class="input" id="sc-proj" value="${escapeHtml((cur.params.projects || []).join(', '))}" placeholder="shop, blog"><span class="ui-help">A stack is redeployed only when its branch has a new commit.</span></div>
      <div class="ui-field"><label for="sc-name">Name (optional)</label><input class="input" id="sc-name" value="${escapeHtml(s ? s.name : '')}" placeholder="filled in from the task"></div>`;
    UI.dialog({
      title: s ? 'Edit scheduled task' : 'Add scheduled task', context: false, saveLabel: 'Save', body,
      onOpen: (ov) => {
        const sync = () => {
          const k = ov.querySelector('#sc-kind').value, f = ov.querySelector('#sc-freq').value;
          ov.querySelectorAll('[data-kind]').forEach(x => { x.style.display = x.dataset.kind === k ? '' : 'none'; });
          ov.querySelector('[data-show="weekly"]').style.display = f === 'weekly' ? '' : 'none';
        };
        ov.querySelector('#sc-kind').addEventListener('change', sync);
        ov.querySelector('#sc-freq').addEventListener('change', sync);
        sync();
      },
      onSave: async (ov) => {
        const kind = ov.querySelector('#sc-kind').value;
        const params = kind === 'prune' ? Object.fromEntries([...ov.querySelectorAll('[data-prune]')].map(c => [c.dataset.prune, c.checked]))
          : kind === 'volume_backup' ? { volume: ov.querySelector('#sc-vol').value.trim(), dir: ov.querySelector('#sc-dir').value.trim(), keep: Number(ov.querySelector('#sc-keep').value) }
          : { projects: ov.querySelector('#sc-proj').value.split(',').map(x => x.trim()).filter(Boolean) };
        const body2 = { kind, server_id: ov.querySelector('#sc-srv').value, freq: ov.querySelector('#sc-freq').value, at: ov.querySelector('#sc-at').value.trim(), weekday: Number(ov.querySelector('#sc-day').value), params, name: ov.querySelector('#sc-name').value.trim() };
        if (s) await API.put(`/schedules/${s.id}`, body2); else await API.post('/schedules', body2);
        showToast(s ? 'Task saved' : 'Task added');
        render();
      },
    });
  }

  await render();
  const timer = setInterval(() => { if (Router.isActiveNav(pageNavId) && !document.querySelector('.modal-overlay')) render(); }, 15000);
  return () => clearInterval(timer);
});
