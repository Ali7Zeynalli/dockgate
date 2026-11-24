// Server Console > Scripts: build a shell script from blocks (backup a database or volume, copy it away, delete
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
  const isRoot = (s) => !!(s.path && (s.path.startsWith('/opt/dockgate/') || s.spec.root));
  const when = (ms) => ms ? `${new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '-';

  container.innerHTML = `
    ${UI.header('Scripts', 'Build a script from blocks - DockGate writes the shell for it, safely quoted. Save it to the server, run it once, or schedule it in Cron with its log and alerts.', `${UI.btn('Add existing...', 'data-existing title="A script that is on the server already - it stays where it is"')} ${UI.primary('+ New script', 'data-new')}`)}
    ${d.scripts.length ? UI.table([{ label: 'Script' }, { label: 'Steps' }, { label: 'On the server' }, { label: 'Last run' }, { label: '', align: 'right' }],
      d.scripts.map(s => ({ cells: [
        `<b>${esc(s.name)}</b>${s.spec.title ? `<div class="ui-sub">${esc(s.spec.title)}</div>` : ''}`,
        s.kind === 'code' ? `${UI.pill('info', s.spec.external ? 'own code, added from the server' : 'own code')}` : `<span class="ui-sub">${s.spec.steps.map(x => esc((B[x.type] || {}).label || x.type)).join(' -> ')}</span>`,
        s.path ? `<span class="td-mono" style="font-size:12px">${esc(s.path)}</span>` : '<span class="ui-sub">not written</span>',
        s.lastRunAt ? `${s.lastCode === 0 ? '<span style="color:var(--success)">✓</span>' : `<span style="color:var(--danger);font-weight:600">✗ exit ${s.lastCode}</span>`} <span class="ui-sub">${when(s.lastRunAt)}</span>` : '<span class="ui-sub">-</span>',
        `${UI.btn('Run', `data-run="${s.id}"`)} ${UI.btn('Schedule...', `data-sched="${s.id}"`)} ${UI.btn('Edit', `data-edit="${s.id}"`)} ${UI.menu([s.kind === 'code' ? { label: 'Description...', attrs: `data-title="${s.id}"` } : { label: 'Open the file', attrs: `data-file="${s.id}"` }, ...(s.kind === 'blocks' ? [{ label: 'Convert to code...', attrs: `data-tocode="${s.id}"` }] : []), '-', { label: `${Icons.trash} ${s.spec.external ? 'Remove from the list...' : 'Delete...'}`, attrs: `data-del="${s.id}"`, danger: true }])}`,
      ] })), { minWidth: 900 }) : ''}
    <div class="card" style="padding:22px;margin-top:${d.scripts.length ? '16px' : '0'}">
      <div style="font-weight:700;margin-bottom:2px">Templates (${d.templates.length})</div>
      <div class="ui-sub">Pick one - DockGate asks only what it needs (which container, which site...), then opens it in the editor.</div>
      ${templateCards()}
    </div>
    <div class="ui-sub" style="margin-top:10px">Two kinds: <b>blocks</b> (DockGate writes the file from the steps) and <b>own code</b> (the file is your shell - edit it here with Versions and a <span class="td-mono">bash -n</span> check). Scripts are written root-owned to <span class="td-mono">/opt/dockgate/scripts</span> when the SSH user has passwordless sudo (else to <span class="td-mono">~/.dockgate/scripts</span>). Edit them here - a blocks script whose file was changed on the server is not replaced without asking. A script added from the server stays where it is.</div>`;

  const byId = (id) => d.scripts.find(s => String(s.id) === String(id));
  container.querySelector('[data-new]').addEventListener('click', () => pickTemplate());
  container.querySelector('[data-existing]').addEventListener('click', () => addExisting());
  container.querySelectorAll('[data-tocode]').forEach(b => b.addEventListener('click', () => convert(byId(b.dataset.tocode))));
  container.querySelectorAll('[data-title]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.title);
    UI.dialog({ title: `Description of ${esc(s.name)}`, body: `<label class="ui-field"><span class="ui-label">Description</span><input class="input" id="sc-t" value="${esc(s.spec.title || '')}"></label>`,
      onSave: async (ov) => { await API.put(`/servers/${serverId}/scripts/${s.id}/title`, { title: ov.querySelector('#sc-t').value.trim() }); reload(); } }); }));
  container.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => useTemplate(b.dataset.tpl)));
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.edit); if (s.kind === 'code') openCode(s); else editor(s, JSON.parse(JSON.stringify(s.spec))); }));
  container.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.file); if (s.path) FileEditor.open({ path: s.path, name: s.path.split('/').pop() }); }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { const s = byId(b.dataset.del);
    showDeleteConfirm(s.spec.external ? 'Remove from the list' : 'Delete script', { message: s.spec.external ? `Remove <b>${esc(s.name)}</b> from DockGate's list? The file <span class="td-mono">${esc(s.path)}</span> stays on the server as it is.` : `Delete <b>${esc(s.name)}</b> and its file on the server? A cron job that runs it stays - remove it in the Cron tab.`, phrase: s.name, onConfirm: async () => { try { await API.del(`/servers/${serverId}/scripts/${s.id}`); showToast('Deleted'); reload(); } catch (e) { showToast(e.message, 'error'); } } }); }));
  container.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runNow(byId(b.dataset.run))));
  container.querySelectorAll('[data-sched]').forEach(b => b.addEventListener('click', () => schedule(byId(b.dataset.sched))));

  // Templates grouped by category; each card names its steps.
  function templateCards() {
    const cats = [...new Set(d.templates.map(t => t.category || 'Other'))];
    return cats.map(c => `<div class="ui-label" style="margin:12px 0 6px">${esc(c)}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">${d.templates.filter(t => (t.category || 'Other') === c).map(t => `<button type="button" class="card" data-tpl="${esc(t.id)}" style="text-align:left;padding:12px 14px;cursor:pointer;border:1px solid var(--border);color:var(--text-primary);font:inherit"><b>${esc(t.title)}</b><div class="ui-sub" style="margin-top:4px">${t.steps.map(x => esc(B[x.type].label)).join(' -> ')}</div>${t.steps.some(x => B[x.type].root) ? '<div class="ui-sub" style="margin-top:4px;color:var(--warning)">needs root (passwordless sudo)</div>' : ''}</button>`).join('')}</div>`).join('');
  }
  function pickTemplate() {
    const m = showModal('New script', `<div class="text-sm" style="margin-bottom:10px">Start empty or from a template - every step can be changed afterwards.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px">
        <button type="button" class="btn btn-secondary" data-empty title="Steps from blocks - DockGate writes the shell">Empty - from blocks</button>
        <button type="button" class="btn btn-secondary" data-code title="A .sh you write yourself, with blocks to insert">Write my own code</button>
      </div>
      <div style="max-height:60vh;overflow:auto">${templateCards()}</div>`, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    m.overlay.querySelector('[data-empty]').onclick = () => { m.close(); editor(null, { name: '', title: '', steps: [] }); };
    m.overlay.querySelector('[data-code]').onclick = () => { m.close(); newCode(); };
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
      return `<label class="ui-field"><span class="ui-label">${esc(p.label)}</span><input class="input td-mono" data-ans="${esc(p.key)}" value="${esc(list.includes(p.def) || !list.length ? p.def : list[0])}" list="tp-${esc(p.key)}">${list.length ? `<datalist id="tp-${esc(p.key)}">${list.map(v => `<option value="${esc(v)}">`).join('')}</datalist><span class="ui-sub">${list.length} on this server - type or pick</span>` : ''}</label>`;
    };
    UI.dialog({ title: esc(t.title), saveLabel: 'Next: review the steps', body: `<div class="text-sm" style="margin-bottom:8px">A few answers, then the script opens with them - every step can still be changed.</div>${t.params.map(field).join('')}`,
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
        ${B[s.type].root ? '<div class="ui-sub" style="margin-bottom:6px">Needs root - the script is written root-owned when the SSH user has passwordless sudo.</div>' : ''}
        ${B[s.type].desc ? `<div class="ui-sub" style="margin-bottom:6px">${esc(B[s.type].desc)}</div>` : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">${fieldHtml(s, i)}</div></div>`).join('') || '<div class="ui-sub" style="padding:10px">No steps yet - add one below.</div>';
    const dlg = UI.dialog({ title: script ? `Edit ${esc(script.name)}` : 'New script', saveLabel: script ? 'Save to the server' : 'Create on the server', wide: true,
      body: `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          <label class="ui-field"><span class="ui-label">Name</span><input class="input td-mono" id="sb-name" value="${esc(spec.name)}" placeholder="db-backup"><span class="ui-sub">lowercase, digits, . _ -, the file is NAME.sh</span></label>
          <label class="ui-field"><span class="ui-label">Description (optional)</span><input class="input" id="sb-title" value="${esc(spec.title || '')}"></label></div>
        <div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px;align-items:start">
          <div><div data-steps style="max-height:52vh;overflow:auto">${stepsHtml()}</div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><select class="input" data-add style="max-width:320px"><option value="">+ Add a step...</option>${groups.map(g => `<optgroup label="${esc(g)}">${Object.entries(B).filter(([, b]) => b.group === g).map(([k, b]) => `<option value="${k}">${esc(b.label)}</option>`).join('')}</optgroup>`).join('')}</select></div></div>
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
        let saved;
        try { saved = script ? await API.put(`/servers/${serverId}/scripts/${script.id}`, spec) : await API.post(`/servers/${serverId}/scripts`, spec); }
        catch (e) {
          if (e.code !== 'CHANGED') throw e;
          const v = await changedChoice(script, e.data && e.data.current);
          if (v === 'force') saved = await API.put(`/servers/${serverId}/scripts/${script.id}?force=1`, spec);
          else if (v === 'keep') { const c = await API.post(`/servers/${serverId}/scripts/${script.id}/to-code`, {}); showToast('Kept the server\'s version - it is now your own code'); reload(); openCode(c); return; }
          else return false;
        }
        showToast(`Saved to ${saved.path}`);
        reload();
        if (!script && suggestSchedule) setTimeout(() => schedule(saved, suggestSchedule), 300);
      } });
    void dlg;
  }

  // The file was changed on the server since DockGate wrote it: keep that ( -> own code) or write the steps over it.
  function changedChoice(script, current) {
    return new Promise((resolve) => {
      let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const m = showModal('Changed on the server', `<div class="text-sm" style="margin-bottom:8px">Someone changed <span class="td-mono">${esc(script.path)}</span> on the server after DockGate wrote it. Saving the steps would replace that change.</div>
        ${current != null ? `<div class="ui-label" style="margin-bottom:4px">On the server now</div><pre class="td-mono" style="margin:0;font-size:11.5px;max-height:40vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;white-space:pre">${esc(current)}</pre>` : ''}`,
        [{ label: 'Cancel', className: 'btn btn-secondary', onClick: () => fin(null) },
         { label: 'Keep the server\'s version (make it own code)', className: 'btn btn-secondary', onClick: () => fin('keep') },
         { label: 'Write my steps over it', className: 'btn btn-danger', onClick: () => fin('force') }]);
      m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
      const obs = new MutationObserver(() => { if (!document.body.contains(m.overlay)) { obs.disconnect(); fin(null); } }); obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Own code: the file on the server is the script. The file editor gives highlighting, Ctrl+S, the diff before
  // saving, Versions, a bash -n check, and "changed on the server" - plus Insert block here.
  function openCode(s) {
    if (!s.path) return showToast('This script has no file yet', 'error');
    FileEditor.open({ path: s.path, name: s.path.split('/').pop(), onSaved: () => reload(),
      actions: [{ label: '+ Insert block', title: 'Put a DockGate block (backup, check, restart...) at the cursor', run: (ed) => insertBlock(ed) }] });
  }

  function insertBlock(ed) {
    const groups = [...new Set(Object.values(B).map(b => b.group))];
    let step = { type: '' };
    const fields = () => !step.type ? '' : (B[step.type].fields || []).map(([k, label, kind, ph, req]) => {
      const v = step[k] == null ? '' : step[k];
      const input = kind === 'select' ? `<select class="input" data-f="${k}">${ph.map(o => `<option ${String(v) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : kind === 'textarea' ? `<textarea class="input td-mono" rows="2" data-f="${k}" placeholder="${esc(ph)}">${esc(v)}</textarea>`
        : `<input class="input ${kind === 'number' ? '' : 'td-mono'}" ${kind === 'number' ? 'type="number"' : ''} data-f="${k}" value="${esc(v)}" placeholder="${esc(ph)}">`;
      return `<label class="ui-field"><span class="ui-label">${esc(label)}${req ? '' : ' <span class="ui-sub">(optional)</span>'}</span>${input}</label>`;
    }).join('') + (B[step.type].desc ? `<div class="ui-sub">${esc(B[step.type].desc)}</div>` : '');
    const m = UI.dialog({ title: 'Insert a block', saveLabel: 'Insert at the cursor', body: `<label class="ui-field"><span class="ui-label">Block</span><select class="input" data-type><option value="">Choose...</option>${groups.map(g => `<optgroup label="${esc(g)}">${Object.entries(B).filter(([, b]) => b.group === g).map(([k, b]) => `<option value="${k}">${esc(b.label)}</option>`).join('')}</optgroup>`).join('')}</select></label><div data-fields></div><div class="ui-sub" style="margin-top:6px">The block is pasted as plain shell, with its values quoted - change it freely afterwards.</div>`,
      onOpen: (ov) => {
        const box = ov.querySelector('[data-fields]');
        ov.querySelector('[data-type]').addEventListener('change', (e) => { step = { type: e.target.value }; box.innerHTML = fields(); });
      },
      onSave: async (ov) => {
        if (!step.type) throw new Error('Choose a block');
        ov.querySelectorAll('[data-f]').forEach(i => { step[i.dataset.f] = i.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value; });
        const r = await API.post(`/servers/${serverId}/scripts/snippet`, step);
        ed.insert('\n' + r.text);
      } });
    m.overlay.style.zIndex = 1300; // above the file editor
  }

  function newCode() {
    UI.dialog({ title: 'Write my own script', saveLabel: 'Create and open the editor',
      body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input td-mono" id="nc-name" placeholder="my-backup"><span class="ui-sub">lowercase, digits, . _ -, the file is NAME.sh</span></label>
        <label class="ui-field"><span class="ui-label">Description (optional)</span><input class="input" id="nc-title"></label>
        <label class="ui-field"><span class="ui-label">Start with</span><textarea class="input td-mono" id="nc-code" rows="9" spellcheck="false" style="white-space:pre">#!/usr/bin/env bash
# Your own script (DockGate > Server Console > Scripts)
set -euo pipefail

echo "Hello from $(hostname)"
</textarea><span class="ui-sub">Paste a whole script here if you have one. It is checked with <span class="td-mono">bash -n</span> before it is written.</span></label>`,
      onSave: async (ov) => {
        const c = await API.post(`/servers/${serverId}/scripts/code`, { name: ov.querySelector('#nc-name').value.trim(), title: ov.querySelector('#nc-title').value.trim(), code: ov.querySelector('#nc-code').value });
        showToast(`Written to ${c.path}`); reload(); setTimeout(() => openCode(c), 200);
      } });
  }

  function convert(s) {
    showConfirm('Convert to code', `<b>${esc(s.name)}</b> becomes your own code: the file on the server (as it is now) is the script, and you edit it as text. The steps are not kept - this can not be undone.`, async () => {
      try { const c = await API.post(`/servers/${serverId}/scripts/${s.id}/to-code`, {}); showToast('Converted'); reload(); openCode(c); } catch (e) { showToast(e.message, 'error'); }
    });
  }

  // A script that is on the server already: pick one DockGate found (crontab ones first) or type its path.
  async function addExisting() {
    const m = UI.dialog({ title: 'Add a script from the server', saveLabel: 'Add to the list', wide: true,
      body: `<div class="text-sm" style="margin-bottom:8px">The file stays where it is - DockGate runs, schedules and edits it there, and never moves or deletes it.</div>
        <div data-found><div class="skeleton" style="width:100%;height:120px"></div></div>
        <div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:10px;margin-top:10px">
          <label class="ui-field"><span class="ui-label">Path</span><input class="input td-mono" id="ae-path" placeholder="/root/backup.sh"></label>
          <label class="ui-field"><span class="ui-label">Name in the list <span class="ui-sub">(optional)</span></span><input class="input td-mono" id="ae-name" placeholder="from the file name"></label>
        </div>`,
      onOpen: async (ov) => {
        const box = ov.querySelector('[data-found]');
        let r; try { r = await API.get(`/servers/${serverId}/scripts/discover`); } catch (e) { box.innerHTML = `<div class="text-danger text-sm">${esc(e.message)}</div>`; return; }
        if (!r.files.length) { box.innerHTML = '<div class="ui-sub">No other .sh files found in the usual places (/opt, /root, /home, /usr/local/bin, /srv, /var/www, crontabs) - type the path below.</div>'; return; }
        box.innerHTML = `<div class="ui-label" style="margin-bottom:4px">Found on the server (${r.files.length})</div><div style="max-height:40vh;overflow:auto;border:1px solid var(--border);border-radius:8px">${r.files.map(f => `<label style="display:flex;gap:10px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--border);font-weight:400;cursor:pointer"><input type="radio" name="ae-pick" value="${esc(f.path)}"><span class="td-mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12.5px">${esc(f.path)}</span>${f.inCron ? UI.pill('info', 'in cron') : ''}<span class="ui-sub">${esc(f.owner)}, ${formatBytes(f.size)}</span></label>`).join('')}</div>`;
        box.querySelectorAll('[name=ae-pick]').forEach(x => x.addEventListener('change', () => { ov.querySelector('#ae-path').value = x.value; }));
      },
      onSave: async (ov) => {
        const c = await API.post(`/servers/${serverId}/scripts/existing`, { path: ov.querySelector('#ae-path').value.trim(), name: ov.querySelector('#ae-name').value.trim() });
        showToast(`Added ${c.name}`); reload();
      } });
    void m;
  }

  async function runNow(s) {
    showConfirm('Run now', `Run <b>${esc(s.name)}</b> once now${isRoot(s) ? ' as root' : ''}? Its output is shown here (up to 5 minutes).`, async () => {
      const m = showModal(`Running ${esc(s.name)}...`, '<div data-out><span class="ui-sub">Running...</span></div>', [{ label: 'Close', className: 'btn btn-secondary' }]);
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
    let sp = null;
    UI.dialog({ title: `Schedule ${esc(s.name)}`, saveLabel: 'Add to Cron',
      body: `<div class="ui-field"><span class="ui-label">When</span>${SchedulePicker.html(suggest || '30 3 * * *', { minutes: true })}</div>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="sc-log" checked> Keep its output in a log</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="sc-fail" checked> Notify when it fails</label>
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="sc-missed"> Notify when it does not run</label>
        <div class="ui-sub" style="margin-top:6px">Added as a job named ${esc(s.name)} in ${isRoot(s) ? "root's" : "the SSH user's"} crontab; change or remove it in the Cron tab.</div>`,
      onOpen: (ov) => { sp = SchedulePicker.bind(ov); },
      onSave: async (ov) => {
        await API.post(`/servers/${serverId}/scripts/${s.id}/schedule`, { schedule: sp.value(), log: ov.querySelector('#sc-log').checked, notify: [ov.querySelector('#sc-fail').checked && 'fail', ov.querySelector('#sc-missed').checked && 'missed'].filter(Boolean) });
        showToast('Scheduled - see the Cron tab');
      } });
  }
}
