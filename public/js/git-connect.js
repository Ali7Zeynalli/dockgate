// Connect to Git - a folder that was uploaded (no .git) becomes a checkout of a repository, in place
// (server/git-connect.js). Opened from Compose (⋯ > Connect to Git...) and Deploy > Tasks.
// GitConnect.open({ project } | { dir }, { onDone })
window.GitConnect = (() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const list = (items, more) => items.length ? `<div class="td-mono text-xs" style="max-height:160px;overflow:auto;padding:6px 8px;background:var(--bg-tertiary);border-radius:6px">${items.map(esc).join('<br>')}${more > items.length ? `<br>... and ${more - items.length} more` : ''}</div>` : '<div class="ui-sub">none</div>';

  async function open(where, { onDone } = {}) {
    let keys = [];
    try { keys = await API.get('/ssh-keys'); } catch (e) { /* token only */ }
    const st = { where, auth: null, check: null, cmp: null, rootUp: 0 };
    const m = showModal(`Connect to Git${where.project ? ' - ' + esc(where.project) : ''}`, `${typeof serverContextBanner === 'function' ? serverContextBanner() : ''}<div data-gc style="display:flex;flex-direction:column;gap:12px;min-width:0"></div>`, []);
    m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide');
    const box = m.overlay.querySelector('[data-gc]');
    const body = (p) => ({ ...where, rootUp: st.rootUp, ...st.auth, ...p });
    const errBox = (e) => `<div class="insight-card danger"><div>${esc(e.message || e)}</div></div>`;
    const busy = (btn, on, txt) => { if (!btn) return; btn.disabled = on; if (txt) btn.textContent = txt; };

    // ---- 1. repository ----
    function step1(errHtml = '') {
      box.innerHTML = `
        <div class="ui-sub">For a project you uploaded as files: DockGate makes <b>this same folder</b> a Git checkout. The folder, the project name and the volumes stay; nothing changes until you press <b>Connect</b>, and every file it replaces is backed up first.</div>
        <label class="ui-field"><span class="ui-label">Repository URL</span><input class="input td-mono" data-url placeholder="https://github.com/owner/repo" value="${esc(st.auth?.repoUrl || '')}"></label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="ui-field" style="flex:1;min-width:200px"><span class="ui-label">Access</span><select class="select" data-auth><option value="token">Public, or an access token</option><option value="key"${st.auth?.keyId ? ' selected' : ''}>Deploy key (SSH key from DockGate)</option></select></label>
          <label class="ui-field" style="flex:1;min-width:200px" data-tokrow><span class="ui-label">Access token (private repository)</span><input class="input" type="password" data-token autocomplete="new-password" placeholder="read access is enough to connect"></label>
          <label class="ui-field" style="flex:1;min-width:200px;display:none" data-keyrow><span class="ui-label">SSH key</span>${keys.length ? `<select class="select" data-key>${keys.map(k => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('')}</select>` : '<span class="ui-sub" style="color:var(--warning)">No keys yet - add one in Servers > SSH keys</span>'}</label>
        </div>
        ${where.project ? `<label class="ui-field"><span class="ui-label">Which folder is the top of the repository?</span><select class="select" data-up><option value="0">The project's folder (the compose file is at the top of the repository)</option><option value="1">One folder up (the compose file is in a subfolder of the repository)</option><option value="2">Two folders up</option></select></label>` : ''}
        ${errHtml}
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-secondary" data-cancel>Cancel</button><button class="btn btn-primary" data-check>Check access</button></div>
        <div data-res></div>`;
      const sel = box.querySelector('[data-auth]');
      const flip = () => { const k = sel.value === 'key'; box.querySelector('[data-tokrow]').style.display = k ? 'none' : ''; box.querySelector('[data-keyrow]').style.display = k ? '' : 'none'; box.querySelector('[data-url]').placeholder = k ? 'git@github.com:owner/repo.git' : 'https://github.com/owner/repo'; };
      sel.onchange = flip; flip();
      if (box.querySelector('[data-up]')) box.querySelector('[data-up]').value = String(st.rootUp);
      box.querySelector('[data-cancel]').onclick = () => m.close();
      box.querySelector('[data-check]').onclick = async (e) => { const btn = e.currentTarget;
        const key = sel.value === 'key';
        st.auth = { repoUrl: box.querySelector('[data-url]').value.trim(), token: key ? '' : box.querySelector('[data-token]').value.trim(), keyId: key ? (box.querySelector('[data-key]') || {}).value || '' : '' };
        st.rootUp = parseInt((box.querySelector('[data-up]') || {}).value || '0', 10);
        busy(btn, true, 'Checking...');
        try { st.check = await API.post('/git-connect/check', body()); showCheck(); }
        catch (er) { box.querySelector('[data-res]').innerHTML = errBox(er); }
        finally { busy(btn, false, 'Check access'); }
      };
    }

    function backupsHtml(c) {
      const open = (c.backups || []).filter(b => !b.undone);
      if (!open.length) return '';
      return `<div class="card" style="padding:10px 12px"><b>Earlier connects of this folder</b>${open.map(b => `<div style="display:flex;gap:8px;align-items:center;margin-top:6px"><span class="ui-sub" style="flex:1">${esc(new Date(b.at).toLocaleString())}, ${b.kind === 'init' ? 'first push' : 'connect'}, ${esc(b.repoUrl)} ${esc(b.branch)}, ${b.overwritten.length} file(s) backed up</span>${UI.btn('Undo...', `data-undo="${esc(b.id)}"`, 'btn-xs')}</div>`).join('')}</div>`;
    }
    function wireUndo(root) {
      root.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => showConfirm('Undo connect', 'The folder\'s .git is removed, the files the connect replaced come back as they were, and the files it added are deleted. Containers keep running.', async () => {
        try { const r = await API.post('/git-connect/undo', { backup: b.dataset.undo, project: where.project || '' }); showToast(`Undone - ${r.restored} file(s) restored, ${r.removed} removed`, 'success'); m.close(); onDone && onDone(); }
        catch (e) { showToast(e.message, 'error', 9000); }
      }, true));
    }

    function showCheck() {
      const c = st.check; const res = box.querySelector('[data-res]');
      const head = `<div class="ui-sub">Folder <span class="td-mono">${esc(c.dir)}</span> on <b>${esc(c.server)}</b>, ${c.files} file(s)</div>`;
      if (c.isGit) { res.innerHTML = `${head}<div class="insight-card"><div>This folder is a Git checkout already (${esc(c.gitRoot)}). Use <b>Git pull</b> / <b>Git sync</b> on it.</div></div>${backupsHtml(c)}`; wireUndo(res); return; }
      if (c.empty) {
        res.innerHTML = `${head}<div class="insight-card"><div><b>The repository is empty.</b> DockGate can make the first commit from this folder's files and push it - then the folder is connected.</div></div>${backupsHtml(c)}<div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" data-first>Set up the first push...</button></div>`;
        res.querySelector('[data-first]').onclick = () => firstPush();
        wireUndo(res); return;
      }
      res.innerHTML = `${head}${backupsHtml(c)}
        <div style="display:flex;gap:10px;align-items:flex-end"><label class="ui-field" style="flex:1"><span class="ui-label">Branch</span><select class="select" data-branch>${c.branches.map(b => `<option${b === c.defaultBranch ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select></label><button class="btn btn-primary" data-cmp>Compare with the folder</button></div>`;
      wireUndo(res);
      res.querySelector('[data-cmp]').onclick = async (e) => { const btn = e.currentTarget;
        busy(btn, true, 'Comparing...');
        try { st.cmp = await API.post('/git-connect/compare', body({ branch: res.querySelector('[data-branch]').value })); step2(); }
        catch (er) { res.insertAdjacentHTML('beforeend', errBox(er)); busy(btn, false, 'Compare with the folder'); }
      };
    }

    // ---- 2. compare ----
    function step2() {
      const c = st.cmp; const k = c.counts;
      const card = (n, label, sub, tone) => `<div class="card" style="padding:10px 12px;flex:1;min-width:140px"><div style="font-size:20px;font-weight:700;color:${tone || 'var(--text-primary)'}">${n}</div><div style="font-weight:600">${label}</div><div class="ui-sub">${sub}</div></div>`;
      box.innerHTML = `
        <div class="ui-sub">Branch <b>${esc(c.branch)}</b>, last commit <span class="td-mono">${esc(c.commit.hash)}</span> ${esc(c.commit.subject)}, ${c.repoFiles} file(s) in the repository</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${card(c.same, 'Same', 'nothing changes')}
          ${card(k.differs, 'Different', 'the repository\'s version is written (backed up first)', k.differs ? 'var(--warning)' : '')}
          ${card(k.onlyRepo, 'Only in the repository', 'added to the folder')}
          ${card(k.onlyServer + k.ignored, 'Only on the server', 'stay as they are', 'var(--success)')}
        </div>
        ${c.composeInRepo === false ? `<div class="insight-card danger"><div>The repository has no <span class="td-mono">${esc(c.composeRel)}</span> where the project uses it. Pick another <b>top folder</b> (Back), or the project will not find its compose file after a pull.</div></div>` : ''}
        ${k.differs ? `<div><b>Different files</b> <span class="ui-sub">- tick one to keep the server's version (it then shows as a local change; commit it to the repository, or the next Sync may replace it)</span>
          <div style="max-height:220px;overflow:auto;margin-top:6px">${c.differs.map(f => `<div style="display:flex;gap:8px;align-items:center;padding:3px 0"><input type="checkbox" data-keep="${esc(f)}"><span class="td-mono text-xs" style="flex:1;word-break:break-all">${esc(f)}</span>${UI.btn('View change', `data-view="${esc(f)}"`, 'btn-xs')}</div>`).join('')}${k.differs > c.differs.length ? `<div class="ui-sub">... and ${k.differs - c.differs.length} more</div>` : ''}</div></div>` : ''}
        <details><summary><b>Only in the repository</b> (${k.onlyRepo})</summary>${list(c.onlyRepo, k.onlyRepo)}</details>
        <details><summary><b>Only on the server, ignored by the repository</b> (${k.ignored}) - <span class="ui-sub">.env, data folders... they stay</span></summary>${list(c.ignored, k.ignored)}</details>
        <details${k.onlyServer ? ' open' : ''}><summary><b>Only on the server, not in .gitignore</b> (${k.onlyServer}) - <span class="ui-sub">they stay, Git lists them as untracked</span></summary>${list(c.onlyServer, k.onlyServer)}</details>
        ${c.sensitive.length ? `<div class="insight-card"><div>These look like secrets and are not in the repository's .gitignore: <span class="td-mono">${c.sensitive.map(esc).join(', ')}</span>. They stay on the server; add them to .gitignore in the repository so nobody commits them by mistake.</div></div>` : ''}
        <div class="ui-sub">Containers keep running. After connecting you can redeploy, or wait for the next deploy. <b>Undo</b> brings the folder back from the backup.</div>
        <div data-res></div>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-secondary" data-back>Back</button><button class="btn btn-primary" data-go>Connect</button></div>`;
      box.querySelector('[data-back]').onclick = () => step1();
      box.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
        try {
          const d = await API.post('/git-connect/diff', { session: c.session, file: b.dataset.view });
          const lines = String(d.diff || '').split('\n').filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
          showModal(`Change - ${esc(d.file)}`, `<div class="ui-sub" style="margin-bottom:6px"><span style="color:var(--danger)">− the server now</span>, <span style="color:var(--success)">+ after connecting (the repository)</span></div><pre class="td-mono text-xs" style="max-height:60vh;overflow:auto;background:var(--bg-tertiary);padding:8px;border-radius:6px">${lines.map(l => `<span style="color:${l[0] === '+' ? 'var(--success)' : l[0] === '-' ? 'var(--danger)' : l.startsWith('@@') ? 'var(--accent)' : 'inherit'}">${esc(l)}</span>`).join('\n') || 'No text change (file mode or binary).'}</pre>`, [{ label: 'Close' }]);
        } catch (e) { showToast(e.message, 'error'); }
      });
      box.querySelector('[data-go]').onclick = async (e) => { const btn = e.currentTarget;
        const keep = [...box.querySelectorAll('[data-keep]:checked')].map(x => x.dataset.keep);
        busy(btn, true, 'Connecting...');
        try { const r = await API.post('/git-connect/connect', { session: c.session, keep, project: where.project || '' }); done(r); }
        catch (er) { box.querySelector('[data-res]').innerHTML = errBox(er); busy(btn, false, 'Connect'); }
      };
    }

    // ---- 3. done ----
    function done(r, pushed) {
      box.innerHTML = `<div class="insight-card success"><div><b>${pushed ? 'Pushed and connected' : 'Connected'}.</b> <span class="td-mono">${esc(r.dir)}</span> is a checkout of ${esc(r.repoUrl)}, ${esc(r.branch)} at <span class="td-mono">${esc(pushed ? r.commit : r.commit.hash)}</span>${pushed ? '' : ` ${esc(r.commit.subject)}`}.</div></div>
        <div class="ui-sub">${pushed ? `${r.files} file(s) in the first commit${r.wroteGitignore ? ', with a new .gitignore' : ''}.` : `${r.replaced} file(s) replaced, ${r.added} added${r.kept.length ? `, ${r.kept.length} kept as local changes` : ''}. Backup: ${esc(r.backup)}.`}</div>
        <div class="ui-sub">Now: ${where.project ? '<b>Git pull</b> and <b>Git sync</b> on the project, ' : ''}the <b>Git pull</b> step of Deploy > Tasks recipes, and auto-deploy from GitHub / GitLab / Bitbucket pushes through a recipe's <b>Webhook / CI...</b>.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">${UI.btn('Undo...', `data-undo="${esc(r.backup)}"`)}${where.project ? UI.btn('Redeploy now', 'data-redeploy') : ''}<button class="btn btn-primary" data-close>Done</button></div>`;
      wireUndo(box);
      box.querySelector('[data-close]').onclick = () => { m.close(); onDone && onDone(); };
      const rd = box.querySelector('[data-redeploy]');
      if (rd) rd.onclick = async () => {
        busy(rd, true, 'Starting...');
        try { await API.post(`/compose/${encodeURIComponent(where.project)}/git-sync`, {}); showToast('Redeploy started - see Deploys on the Compose page', 'success'); m.close(); onDone && onDone(); }
        catch (e) { showToast(e.message, 'error', 9000); busy(rd, false, 'Redeploy now'); }
      };
    }

    // ---- first push (empty repository) ----
    async function firstPush() {
      box.innerHTML = '<div class="ui-sub">Reading the folder...</div>';
      let pv;
      try { pv = await API.post('/git-connect/init-preview', body()); } catch (e) { box.innerHTML = errBox(e); return; }
      const me = {};
      box.innerHTML = `
        <div class="ui-sub">The first commit is made from this folder's files and pushed to <span class="td-mono">${esc(st.auth.repoUrl)}</span>. The token or key needs <b>write</b> access.</div>
        <label class="ui-field"><span class="ui-label">.gitignore ${pv.gitignore.exists ? '(the folder has one - it is used as it is)' : '(new - what stays out of the repository)'}</span><textarea class="input td-mono" rows="9" data-gi ${pv.gitignore.exists ? 'readonly' : ''}>${esc(pv.gitignore.text)}</textarea></label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="ui-field" style="flex:1;min-width:160px"><span class="ui-label">Branch</span><input class="input td-mono" data-br value="main"></label>
          <label class="ui-field" style="flex:1;min-width:160px"><span class="ui-label">Your name (commit author)</span><input class="input" data-nm value="${esc(me.name || '')}"></label>
          <label class="ui-field" style="flex:1;min-width:200px"><span class="ui-label">Your e-mail</span><input class="input" data-em value="${esc(me.email || '')}"></label>
        </div>
        <label class="ui-field"><span class="ui-label">Commit message</span><input class="input" data-msg value="First commit from the server"></label>
        <div data-pv></div><div data-res></div>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-secondary" data-back>Back</button><button class="btn btn-secondary" data-re>Check the file list</button><button class="btn btn-primary" data-push>Commit and push</button></div>`;
      const drawPv = (p) => {
        box.querySelector('[data-pv]').innerHTML = `<details open><summary><b>${p.count} file(s) will be pushed</b></summary>${list(p.files.slice(0, 400), p.count)}</details>
          ${p.sensitive.length ? `<div class="insight-card danger"><div>These look like secrets: <span class="td-mono">${p.sensitive.map(esc).join(', ')}</span>. Add them to .gitignore.<label style="display:flex;gap:6px;margin-top:6px"><input type="checkbox" data-allow> Push them anyway</label></div></div>` : ''}
          ${p.big.length ? `<div class="insight-card danger"><div>Files over 50 MB: <span class="td-mono">${p.big.map(esc).join(', ')}</span> - add them to .gitignore.</div></div>` : ''}`;
      };
      drawPv(pv);
      box.querySelector('[data-back]').onclick = () => { step1(); showCheck(); };
      box.querySelector('[data-re]').onclick = async (e) => { const btn = e.currentTarget;
        busy(btn, true, 'Checking...');
        try { drawPv(await API.post('/git-connect/init-preview', body({ gitignore: box.querySelector('[data-gi]').value }))); } catch (er) { box.querySelector('[data-res]').innerHTML = errBox(er); }
        busy(btn, false, 'Check the file list');
      };
      box.querySelector('[data-push]').onclick = async (e) => { const btn = e.currentTarget;
        busy(btn, true, 'Pushing...');
        try {
          const r = await API.post('/git-connect/init-push', body({ gitignore: box.querySelector('[data-gi]').value, branch: box.querySelector('[data-br]').value.trim(), name: box.querySelector('[data-nm]').value.trim(), email: box.querySelector('[data-em]').value.trim(), message: box.querySelector('[data-msg]').value, allowSensitive: !!(box.querySelector('[data-allow]') || {}).checked }));
          done(r, true);
        } catch (er) { box.querySelector('[data-res]').innerHTML = errBox(er); busy(btn, false, 'Commit and push'); }
      };
    }

    step1();
  }
  return { open };
})();
