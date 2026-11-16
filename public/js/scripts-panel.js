// Server Console → Scripts: build a shell script from blocks (backup a database or volume, copy it away, delete
// old files, restart a container, check a URL or the disk, send a message, any command), see the script it
// makes, save it to the server, run it once, or schedule it in Cron with its log and alerts.
async function renderScriptsPanel(serverId, container) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  container.innerHTML = '<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>';
  let d;
  try { d = await API.get(`/servers/${serverId}/scripts`); }
  catch (e) { container.innerHTML = UI.errorState(e, { title: 'Scripts could not be loaded' }); return; }
  const reload = () => renderScriptsPanel(serverId, container);
  const B = d.blocks;
  const when = (ms) => ms ? `${new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '—';

  container.innerHTML = `
    ${UI.header('Scripts', 'Build a script from blocks — DockGate writes the shell for it, safely quoted. Save it to the server, run it once, or schedule it in Cron with its log and alerts.', UI.primary('+ New script', 'data-new'))}
    ${d.scripts.length ? UI.table([{ label: 'Script' }, { label: 'Steps' }, { label: 'On the server' }, { label: 'Last run' }, { label: '', align: 'right' }],
      d.scripts.map(s => ({ cells: [
        `<b>${esc(s.name)}</b>${s.spec.title ? `<div class="ui-sub">${esc(s.spec.title)}</div>` : ''}`,
        `<span class="ui-sub">${s.spec.steps.map(x => esc((B[x.type] || {}).label || x.type)).join(' → ')}</span>`,
        s.path ? `<span class="td-mono" style="font-size:12px">${esc(s.path)}</span>` : '<span class="ui-sub">not written</span>',
        s.lastRunAt ? `${s.lastCode === 0 ? '<span style="color:var(--success)">✓</span>' : `<span style="color:var(--danger);font-weight:600">✗ exit ${s.lastCode}</span>`} <span class="ui-sub">${when(s.lastRunAt)}</span>` : '<span class="ui-sub">—</span>',
        `${UI.btn('Run', `data-run="${s.id}"`)} ${UI.btn('Schedule…', `data-sched="${s.id}"`)} ${UI.btn('Edit', `data-edit="${s.id}"`)} ${UI.menu([{ label: 'Open the file', attrs: `data-file="${s.id}"` }, '-', { label: `${Icons.trash} Delete…`, attrs: `data-del="${s.id}"`, danger: true }])}`,
      ] })), { minWidth: 900 })
      : `<div class="card" style="padding:22px">
          <div style="font-weight:700;margin-bottom:6px">Start from a template</div>
          ${templateCards()}
        </div>`}
    <div class="ui-sub" style="margin-top:10px">Scripts are written root-owned to <span class="td-mono">/opt/dockgate/scripts</span> when the SSH user has passwordless sudo (else to <span class="td-mono">~/.dockgate/scripts</span>). Edit them here — a change made to the file on the server is replaced on the next save.</div>`;

  const byId = (id) => d.scripts.find(s => String(s.id) === String(id));
  container.querySelector('[data-new]').addEventListener('click', () => pickTemplate());
  container.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => useTemplate(b.dataset.tpl)));
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.edit); editor(s, JSON.parse(JSON.stringify(s.spec))); }));
  container.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.file); if (s.path) FileEditor.open({ path: s.path, name: s.path.split('/').pop() }); }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.del);
    showDeleteConfirm('Delete script', { message: `Delete <b>${esc(s.name)}</b> and its file on the server? A cron job that runs it stays — remove it in the Cron tab.`, phrase: s.name, onConfirm: async () => { try { await API.del(`/servers/${serverId}/scripts/${s.id}`); showToast('Deleted'); reload(); } catch (e) { showToast(e.message, 'error'); } } }); }));
  container.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runNow(byId(b.dataset.run))));
  container.querySelectorAll('[data-sched]').forEach(b => b.addEventListener('click', () => schedule(byId(b.dataset.sched))));

  // Templates grouped by category; each card names its steps.
  function templateCards() {
    const cats = [...new Set(d.templates.map(t => t.category || 'Other'))];
    return cats.map(c => `<div class="ui-label" style="margin:12px 0 6px">${esc(c)}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">${d.templates.filter(t => (t.category || 'Other') === c).map(t => `<button type="button" class="card" data-tpl="${esc(t.id)}" style="text-align:left;padding:12px 14px;cursor:pointer;border:1px solid var(--border);color:var(--text-primary);font:inherit"><b>${esc(t.title)}</b><div class="ui-sub" style="margin-top:4px">${t.steps.map(x => esc(B[x.type].label)).join(' → ')}</div>${t.steps.some(x => B[x.type].root) ? '<div class="ui-sub" style="margin-top:4px;color:var(--warning)">needs root (passwordless sudo)</div>' : ''}</button>`).join('')}</div>`).join('');
  }
  function pickTemplate() {
    const m = showModal('New script', `<div class="text-sm" style="margin-bottom:10px">Start empty or from a template — every step can be changed afterwards.</div>
      <button type="button" class="btn btn-secondary" data-empty style="width:100%;margin-bottom:4px">Empty script</button>
      <div style="max-height:60vh;overflow:auto">${templateCards()}</div>`, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    m.overlay.querySelector('[data-empty]').onclick = () => { m.close(); editor(null, { name: '', title: '', steps: [] }); };
    m.overlay.querySelectorAll('[data-tpl]').forEach(x => { x.onclick = () => { m.close(); useTemplate(x.dataset.tpl); }; });
  }
  // Ask the template's questions first (containers, volumes and project folders of this server to pick from).
  async function useTemplate(id) {
    const t = d.templates.find(x => x.id === id);
    const fill = (answers) => {
      const steps = JSON.parse(JSON.stringify(t.steps));
      for (const p of t.params || []) { const v = answers[p.key] != null ? answers[p.key] : p.def; for (const [i, f] of p.targets) if (steps[i]) steps[i][f] = v; }
      editor(null, { name: t.name, title: t.title, steps }, t.schedule);
    };
    if (!(t.params || []).length) return fill({});
    const [containers, volumes, projects] = await Promise.all([API.get('/containers').catch(() => []), API.get('/volumes').catch(() => []), API.get('/compose').catch(() => [])]);
    const opts = { container: (containers || []).map(c => c.name), volume: (volumes || []).map(v => v.name), compose: (projects || []).map(p => p.workingDir).filter(Boolean) };
    const field = (p) => {
      const list = opts[p.kind] || [];
      return `<label class="ui-field"><span class="ui-label">${esc(p.label)}</span><input class="input td-mono" data-ans="${esc(p.key)}" value="${esc(list.includes(p.def) || !list.length ? p.def : list[0])}" list="tp-${esc(p.key)}">${list.length ? `<datalist id="tp-${esc(p.key)}">${list.map(v => `<option value="${esc(v)}">`).join('')}</datalist><span class="ui-sub">${list.length} on this server — type or pick</span>` : ''}</label>`;
    };
    UI.dialog({ title: esc(t.title), saveLabel: 'Next: review the steps', body: `<div class="text-sm" style="margin-bottom:8px">A few answers, then the script opens with them — every step can still be changed.</div>${t.params.map(field).join('')}`,
      onSave: async (ov) => { const a = {}; ov.querySelectorAll('[data-ans]').forEach(i => { a[i.dataset.ans] = i.value.trim(); }); setTimeout(() => fill(a), 0); } });
  }

  function editor(script, spec, suggestSchedule) {
    const groups = [...new Set(Object.values(B).map(b => b.group))];
    const fieldHtml = (s, i) => (B[s.type].fields || []).map(([k, label, kind, ph, req]) => {
      const v = s[k] == null ? '' : s[k];
      const input = kind === 'select' ? `<select class="input" data-f="${k}" data-i="${i}">${ph.map(o => `<option ${String(v) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : kind === 'textarea' ? `<textarea class="input td-mono" rows="2" data-f="${k}" data-i="${i}" placeholder="${esc(ph)}">${esc(v)}</textarea>`
        : `<input class="input ${kind === 'number' ? '' : 'td-mono'}" ${kind === 'number' ? 'type="number"' : ''} data-f="${k}" data-i="${i}" value="${esc(v)}" placeholder="${esc(ph)}">`;
      return `<label class="ui-field" style="margin:0"><span class="ui-label">${esc(label)}${req ? '' : ' <span class="ui-sub">(optional)</span>'}</span>${input}</label>`;
    }).join('');
    const stepsHtml = () => spec.steps.map((s, i) => `<div class="card" style="padding:10px 12px;margin-bottom:8px" data-step="${i}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><b style="flex:1">${i + 1}. ${esc(B[s.type].label)}</b><button type="button" class="btn btn-xs btn-ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" class="btn btn-xs btn-ghost" data-down="${i}" ${i === spec.steps.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button type="button" class="btn btn-xs btn-ghost text-danger" data-rm="${i}" aria-label="Remove">×</button></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <select class="input" data-when="${i}" style="width:auto;padding:2px 6px;font-size:12px" title="When this step runs"><option value="always" ${s.when !== 'if_failed' ? 'selected' : ''}>run always</option><option value="if_failed" ${s.when === 'if_failed' ? 'selected' : ''}>run only if an earlier step failed</option></select>
          <select class="input" data-onfail="${i}" style="width:auto;padding:2px 6px;font-size:12px" title="If this step fails"><option value="stop" ${s.onFail !== 'continue' ? 'selected' : ''}>if it fails: stop</option><option value="continue" ${s.onFail === 'continue' ? 'selected' : ''}>if it fails: go on</option></select>
        </div>
        ${s.when === 'if_failed' ? '<div class="ui-sub" style="margin-bottom:6px;color:var(--warning)">Runs only when an earlier step failed (a fix). If it works, the run counts as fixed.</div>' : ''}
        ${B[s.type].root ? '<div class="ui-sub" style="margin-bottom:6px">Needs root — the script is written root-owned when the SSH user has passwordless sudo.</div>' : ''}
        ${B[s.type].desc ? `<div class="ui-sub" style="margin-bottom:6px">${esc(B[s.type].desc)}</div>` : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">${fieldHtml(s, i)}</div></div>`).join('') || '<div class="ui-sub" style="padding:10px">No steps yet — add one below.</div>';
    const dlg = UI.dialog({ title: script ? `Edit ${esc(script.name)}` : 'New script', saveLabel: script ? 'Save to the server' : 'Create on the server', wide: true,
      body: `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          <label class="ui-field"><span class="ui-label">Name</span><input class="input td-mono" id="sb-name" value="${esc(spec.name)}" placeholder="db-backup"><span class="ui-sub">lowercase, digits, . _ - · the file is NAME.sh</span></label>
          <label class="ui-field"><span class="ui-label">Description (optional)</span><input class="input" id="sb-title" value="${esc(spec.title || '')}"></label></div>
        <div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px;align-items:start">
          <div><div data-steps style="max-height:52vh;overflow:auto">${stepsHtml()}</div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><select class="input" data-add style="max-width:320px"><option value="">+ Add a step…</option>${groups.map(g => `<optgroup label="${esc(g)}">${Object.entries(B).filter(([, b]) => b.group === g).map(([k, b]) => `<option value="${k}">${esc(b.label)}</option>`).join('')}</optgroup>`).join('')}</select></div></div>
          <div><div class="ui-label" style="margin-bottom:4px">The script DockGate writes</div><pre data-preview class="td-mono" style="margin:0;font-size:11.5px;line-height:1.5;max-height:58vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:10px;white-space:pre"></pre></div>
        </div>`,
      onOpen: (ov) => {
        const box = ov.querySelector('[data-steps]'), pre = ov.querySelector('[data-preview]');
        let t = null;
        const preview = () => { clearTimeout(t); t = setTimeout(async () => {
          spec.name = ov.querySelector('#sb-name').value.trim(); spec.title = ov.querySelector('#sb-title').value.trim();
          try { const r = await API.post(`/servers/${serverId}/scripts/preview`, { ...spec, name: spec.name || 'script' }); pre.style.color = ''; pre.textContent = r.text; }
          catch (e) { pre.style.color = 'var(--danger)'; pre.textContent = e.message; }
        }, 300); };
        const redraw = () => { box.innerHTML = stepsHtml(); wire(); preview(); };
        const wire = () => {
          box.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('input', () => { const s = spec.steps[Number(inp.dataset.i)]; s[inp.dataset.f] = inp.type === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value; preview(); }));
          box.querySelectorAll('[data-onfail]').forEach(sel => sel.addEventListener('change', () => { spec.steps[Number(sel.dataset.onfail)].onFail = sel.value; preview(); }));
          box.querySelectorAll('[data-when]').forEach(sel => sel.addEventListener('change', () => { spec.steps[Number(sel.dataset.when)].when = sel.value; redraw(); }));
          box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { spec.steps.splice(Number(b.dataset.rm), 1); redraw(); });
          box.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = Number(b.dataset.up); [spec.steps[i - 1], spec.steps[i]] = [spec.steps[i], spec.steps[i - 1]]; redraw(); });
          box.querySelectorAll('[data-down]').forEach(b => b.onclick = () => { const i = Number(b.dataset.down); [spec.steps[i + 1], spec.steps[i]] = [spec.steps[i], spec.steps[i + 1]]; redraw(); });
        };
        ov.querySelectorAll('[data-add]').forEach(sel => sel.addEventListener('change', () => { if (!sel.value) return; spec.steps.push({ type: sel.value }); sel.value = ''; redraw(); box.scrollTop = box.scrollHeight; }));
        ov.querySelector('#sb-name').addEventListener('input', preview); ov.querySelector('#sb-title').addEventListener('input', preview);
        wire(); preview();
      },
      onSave: async (ov) => {
        spec.name = ov.querySelector('#sb-name').value.trim(); spec.title = ov.querySelector('#sb-title').value.trim();
        const saved = script ? await API.put(`/servers/${serverId}/scripts/${script.id}`, spec) : await API.post(`/servers/${serverId}/scripts`, spec);
        showToast(`Saved to ${saved.path}`);
        reload();
        if (!script && suggestSchedule) setTimeout(() => schedule(saved, suggestSchedule), 300);
      } });
    void dlg;
  }

  async function runNow(s) {
    showConfirm('Run now', `Run <b>${esc(s.name)}</b> once now${s.path && s.path.startsWith('/opt/') ? ' as root' : ''}? Its output is shown here (up to 5 minutes).`, async () => {
      const m = showModal(`Running ${esc(s.name)}…`, '<div data-out><span class="ui-sub">Running…</span></div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
      m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
      try {
        const r = await API.post(`/servers/${serverId}/scripts/${s.id}/run`, {});
        const box = m.overlay.querySelector('[data-out]');
        if (box) box.innerHTML = `<div style="margin-bottom:8px">${r.code === 0 ? UI.pill('ok', '✓ exit 0') : UI.pill('bad', `✗ exit ${r.code}`)} <span class="ui-sub">${r.ms != null ? (r.ms / 1000).toFixed(1) + ' s' : ''}</span></div><pre class="td-mono" style="font-size:12px;max-height:55vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:0;white-space:pre-wrap">${esc(r.output || '(no output)')}</pre>`;
      } catch (e) { const box = m.overlay.querySelector('[data-out]'); if (box) box.innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; }
      reload();
    });
  }

  function schedule(s, suggest) {
    UI.dialog({ title: `Schedule ${esc(s.name)}`, saveLabel: 'Add to Cron',
      body: `<label class="ui-field"><span class="ui-label">When (cron schedule, server time)</span><input class="input td-mono" id="sc-when" value="${esc(suggest || '30 3 * * *')}"><span class="ui-sub">e.g. 30 3 * * * (daily 03:30) · 0 4 * * 0 (Sundays 04:00) · */5 * * * * (every 5 min)</span></label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="sc-log" checked> Keep its output in a log</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="sc-fail" checked> Notify when it fails</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="sc-missed"> Notify when it does not run</label>
        <div class="ui-sub" style="margin-top:6px">Added as a job named ${esc(s.name)} in ${s.path && s.path.startsWith('/opt/') ? "root's" : "the SSH user's"} crontab; change or remove it in the Cron tab.</div>`,
      onSave: async (ov) => {
        await API.post(`/servers/${serverId}/scripts/${s.id}/schedule`, { schedule: ov.querySelector('#sc-when').value.trim(), log: ov.querySelector('#sc-log').checked, notify: [ov.querySelector('#sc-fail').checked && 'fail', ov.querySelector('#sc-missed').checked && 'missed'].filter(Boolean) });
        showToast('Scheduled — see the Cron tab');
      } });
  }
}
