// A safe text editor for server files (Tools → Files; later containers and volumes too).
//   · line numbers, Ctrl/Cmd+S saves, Esc closes — asking first when something is not saved
//   · Save shows what changes (a line diff) before it writes; the server keeps the earlier version (Versions)
//   · a file the SSH user may not read or write can be opened / saved with sudo
//   · a file changed on the server after it was opened is not overwritten silently
// FileEditor.open({ path, name, onSaved, actions: [{ label, title, run(api) }] }) — api.insert(text) at the cursor
window.FileEditor = (() => {
  const esc = (s) => escapeHtml(String(s ?? ''));

  /** Line diff of two texts: [{ t: ' '|'-'|'+', s }]. Common head and tail are cut first; LCS on the rest. */
  function diffLines(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    let h = 0; while (h < A.length && h < B.length && A[h] === B[h]) h++;
    let t = 0; while (t < A.length - h && t < B.length - h && A[A.length - 1 - t] === B[B.length - 1 - t]) t++;
    const a1 = A.slice(h, A.length - t), b1 = B.slice(h, B.length - t);
    const out = [];
    for (let i = Math.max(0, h - 3); i < h; i++) out.push({ t: ' ', s: A[i], n: i + 1 });
    if (a1.length * b1.length > 4e6) { // too big to align: show it as removed + added
      a1.forEach(s => out.push({ t: '-', s })); b1.forEach(s => out.push({ t: '+', s }));
    } else {
      const m = a1.length, n = b1.length, L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
      for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a1[i] === b1[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      while (i < m && j < n) { if (a1[i] === b1[j]) { out.push({ t: ' ', s: a1[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: a1[i++] }); else out.push({ t: '+', s: b1[j++] }); }
      while (i < m) out.push({ t: '-', s: a1[i++] }); while (j < n) out.push({ t: '+', s: b1[j++] });
    }
    for (let i = A.length - t; i < Math.min(A.length, A.length - t + 3); i++) out.push({ t: ' ', s: A[i] });
    return out;
  }
  function diffHtml(d) {
    const add = d.filter(x => x.t === '+').length, del = d.filter(x => x.t === '-').length;
    const rows = d.slice(0, 2000).map(x => `<div style="white-space:pre;${x.t === '+' ? 'background:rgba(16,185,129,.15);color:var(--success)' : x.t === '-' ? 'background:rgba(239,68,68,.15);color:var(--danger)' : 'opacity:.6'}">${x.t} ${esc(x.s)}</div>`).join('');
    return { add, del, html: `<div class="td-mono" style="font-size:12px;max-height:50vh;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--bg-primary)">${rows || '<span class="ui-sub">No change</span>'}${d.length > 2000 ? '<div class="ui-sub">… more</div>' : ''}</div>` };
  }
  const ask = (title, body, buttons) => new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = showModal(title, body, buttons.map(b => ({ ...b, onClick: () => finish(b.value) })));
    m.overlay.style.zIndex = 1300; // above the editor
    const obs = new MutationObserver(() => { if (!document.body.contains(m.overlay)) { obs.disconnect(); finish(null); } });
    obs.observe(m.overlay.parentNode || document.body, { childList: true });
  });

  // ---- light syntax colouring (an overlay under a transparent textarea; off above 300 KB) ----
  function langOf(path, name) {
    const n = name.toLowerCase();
    if (/\.ya?ml$/.test(n)) return 'yaml';
    if (/\.json$/.test(n)) return 'json';
    if (n === 'nginx.conf' || /\/nginx\//.test(path) && /\.conf$|^default$/.test(n) || /\/sites-(available|enabled)\//.test(path)) return 'nginx';
    if (/^dockerfile/.test(n) || /\.(sh|bash|zsh)$/.test(n)) return 'shell';
    if (/^\.env/.test(n) || /\.(env|ini|cfg|toml|properties|conf|cnf)$/.test(n) || n === 'caddyfile') return 'conf';
    return null;
  }
  const RULES = {
    yaml: [[/#.*/y, 'c'], [/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/y, 's'], [/^(\s*-\s+|\s*)[^\s#:'"][^:#]*?(?=:(\s|$))/y, 'k'], [/\b(true|false|yes|no|null|on|off)\b/yi, 'b'], [/-?\b\d+(\.\d+)?\b/y, 'n']],
    json: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/y, 'k'], [/"(?:[^"\\]|\\.)*"/y, 's'], [/\b(true|false|null)\b/y, 'b'], [/-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b/y, 'n']],
    nginx: [[/#.*/y, 'c'], [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y, 's'], [/^\s*[a-z_][a-z0-9_]*/y, 'k'], [/\$[a-zA-Z_][\w]*/y, 'b'], [/\b\d+[kmgs]?\b/yi, 'n']],
    shell: [[/#.*/y, 'c'], [/"(?:[^"\\]|\\.)*"|'[^']*'/y, 's'], [/^\s*(FROM|RUN|CMD|COPY|ADD|ENV|ARG|EXPOSE|WORKDIR|ENTRYPOINT|USER|VOLUME|LABEL|HEALTHCHECK|SHELL|ONBUILD|STOPSIGNAL)\b/y, 'k'], [/\$\{?[a-zA-Z_]\w*\}?/y, 'b'], [/\b(if|then|else|fi|for|do|done|case|esac|while|function|export|local|return|in)\b/y, 'k']],
    conf: [[/[#;].*/y, 'c'], [/^\s*\[[^\]]*\]/y, 'k'], [/^\s*[\w.\-]+(?=\s*[=:])/y, 'k'], [/"(?:[^"\\]|\\.)*"|'[^']*'/y, 's'], [/\$\{?[a-zA-Z_]\w*\}?/y, 'b'], [/\b(true|false|yes|no|on|off)\b/yi, 'b'], [/-?\b\d+(\.\d+)?\b/y, 'n']],
  };
  /** One line → HTML with <span class="hl-x"> tokens. Rules anchored with ^ only match at the line start. */
  function hlLine(line, rules) {
    let out = '', i = 0, plain = '';
    while (i < line.length) {
      let hit = null;
      for (const [re, cls] of rules) {
        if (re.source.startsWith('^') && i !== 0) continue;
        re.lastIndex = i;
        const m = re.exec(line);
        if (m && m.index === i && m[0].length) { hit = [m[0], cls]; break; }
      }
      if (hit) { out += esc(plain) + `<span class="hl-${hit[1]}">${esc(hit[0])}</span>`; plain = ''; i += hit[0].length; }
      else { plain += line[i]; i++; }
    }
    return out + esc(plain);
  }
  function highlight(text, lang) { const r = RULES[lang]; return text.split('\n').map(l => hlLine(l, r)).join('\n'); }
  const isCompose = (name) => /^(docker-)?compose([.-][\w-]+)?\.ya?ml$/i.test(name);
  const isNginx = (path) => /^\/etc\/nginx\//.test(path);
  // System files checked before saving, with the tool that owns them (on the server).
  const sysKind = (path) => /\.(sh|bash)$/i.test(path) ? 'bash' : /^\/etc\/ssh\/sshd_config(\.d\/[^/]+\.conf)?$/.test(path) ? 'sshd' : /^\/etc\/sudoers(\.d\/[^/]+)?$/.test(path) ? 'sudoers' : path === '/etc/fstab' ? 'fstab' : null;

  async function open({ path, name, onSaved, actions = [] }) {
    let data, sudo = false;
    try { data = await API.get(`/files/read?path=${encodeURIComponent(path)}`); }
    catch (e) {
      if (e.code !== 'EACCES') { showToast(e.message, 'error', 9000); return; }
      const ok = await ask('Open with sudo?', `<div class="text-sm"><b>${esc(name)}</b> belongs to another user, so the SSH user can not read it. Open it with <span class="td-mono">sudo</span>? Saving then keeps its owner and mode.</div>`, [{ label: 'Cancel', className: 'btn btn-secondary', value: false }, { label: 'Open with sudo', className: 'btn btn-primary', value: true }]);
      if (!ok) return;
      try { data = await API.get(`/files/read?path=${encodeURIComponent(path)}&sudo=1`); sudo = true; } catch (e2) { showToast(e2.message, 'error', 9000); return; }
    }
    if (data.isBinary) { showToast(`"${name}" is binary or larger than 2 MB — it can not be edited here. Download it instead.`, 'warning', 8000); return; }
    let original = data.content || '', baseMtime = data.mtime || null;

    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.style.zIndex = 1200;
    ov.innerHTML = `<div class="modal" style="width:min(1100px,96vw);max-width:none;height:min(820px,92vh);display:flex;flex-direction:column">
      <div class="modal-header" style="display:flex;align-items:center;gap:10px">
        <h3 style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)} <span data-dirty style="color:var(--warning);display:none" title="Not saved">●</span></h3>
        ${sudo ? UI.pill('warn', 'sudo') : ''}
        ${actions.map((a, i) => `<button class="btn btn-xs btn-secondary" data-act="${i}" title="${esc(a.title || '')}">${esc(a.label)}</button>`).join('')}
        <button class="btn btn-xs btn-secondary" data-versions title="Earlier versions saved from here">Versions</button>
        <button class="btn-icon modal-close" data-close title="Close (Esc)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
      <div class="text-xs text-muted td-mono" style="padding:0 20px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(path)} · ${formatBytes(data.size || 0)}</div>
      <div style="flex:1;min-height:0;display:flex;margin:0 20px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-primary)">
        <pre data-gutter class="td-mono" style="margin:0;padding:10px 8px;text-align:right;color:var(--text-muted);opacity:.6;user-select:none;overflow:hidden;font-size:12.5px;line-height:1.5;min-width:44px;border-right:1px solid var(--border)"></pre>
        <div style="position:relative;flex:1;min-width:0">
          <pre data-hl aria-hidden="true" class="fe-hl" style="position:absolute;inset:0;margin:0;padding:10px;overflow:hidden;pointer-events:none;font-family:var(--font-mono,monospace);font-size:12.5px;line-height:1.5;white-space:pre;tab-size:2;color:var(--text-primary)"></pre>
          <textarea data-text spellcheck="false" wrap="off" style="position:absolute;inset:0;width:100%;height:100%;border:0;outline:0;resize:none;padding:10px;background:transparent;color:inherit;font-family:var(--font-mono,monospace);font-size:12.5px;line-height:1.5;white-space:pre;overflow:auto;tab-size:2"></textarea>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;padding:12px 20px">
        <span class="ui-sub" style="flex:1">Ctrl+S saves · Esc closes · the earlier content is kept under Versions</span>
        ${isCompose(name) || sysKind(path) ? '<button class="btn btn-secondary" data-check title="Check what is in the editor with the tool that owns this file">Check</button>' : ''}
        <button class="btn btn-secondary" data-cancel>Close</button>
        <button class="btn btn-primary" data-save>Save…</button>
      </div></div>`;
    document.body.appendChild(ov);
    const ta = ov.querySelector('[data-text]'), gutter = ov.querySelector('[data-gutter]'), dot = ov.querySelector('[data-dirty]'), hlEl = ov.querySelector('[data-hl]');
    ta.value = original;
    const lang = original.length <= 300 * 1024 ? langOf(path, name) : null;
    if (lang) ta.style.color = 'transparent', ta.style.caretColor = 'var(--text-primary)'; else hlEl.style.display = 'none';
    let hlTimer = null;
    const paint = () => { if (!lang) return; clearTimeout(hlTimer); hlTimer = setTimeout(() => { hlEl.innerHTML = highlight(ta.value, lang) + '\n\n'; hlEl.scrollTop = ta.scrollTop; hlEl.scrollLeft = ta.scrollLeft; }, ta.value.length > 50000 ? 120 : 0); };
    const lines = () => { const n = ta.value.split('\n').length; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); paint(); };
    const dirty = () => ta.value !== original;
    const mark = () => { dot.style.display = dirty() ? '' : 'none'; };
    ta.addEventListener('input', () => { lines(); mark(); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; hlEl.scrollTop = ta.scrollTop; hlEl.scrollLeft = ta.scrollLeft; });
    ta.addEventListener('keydown', (e) => { // Tab inserts two spaces instead of leaving the editor
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); lines(); mark(); }
    });
    lines(); setTimeout(() => ta.focus(), 30);

    const close = async () => {
      if (dirty()) {
        const ok = await ask('Close without saving?', '<div class="text-sm">Your changes are not saved.</div>', [{ label: 'Keep editing', className: 'btn btn-secondary', value: false }, { label: 'Close without saving', className: 'btn btn-danger', value: true }]);
        if (!ok) return;
      }
      document.removeEventListener('keydown', onKey, true); ov.remove();
    };
    const write = async (force = false) => {
      const body = { path, content: ta.value, sudo, baseMtime, force };
      try {
        const before = original;
        const r = await API.post('/files/write', body);
        original = ta.value; baseMtime = r.mtime || baseMtime; mark();
        showToast(`Saved${r.versionKept ? ' — the earlier version is under Versions' : ''}`);
        if (onSaved) onSaved();
        if (isNginx(path)) await nginxCheck(before);
        return true;
      } catch (e) {
        if (e.code === 'CHANGED') {
          const v = await ask('Changed on the server', `<div class="text-sm"><b>${esc(name)}</b> changed on the server after you opened it. Saving now replaces that change.</div>`, [{ label: 'Cancel', className: 'btn btn-secondary', value: null }, { label: 'Load theirs', className: 'btn btn-secondary', value: 'reload' }, { label: 'Save mine anyway', className: 'btn btn-danger', value: 'force' }]);
          if (v === 'force') return write(true);
          if (v === 'reload') { const d = await API.get(`/files/read?path=${encodeURIComponent(path)}${sudo ? '&sudo=1' : ''}`); original = d.content || ''; baseMtime = d.mtime; ta.value = original; lines(); mark(); }
          return false;
        }
        if (e.code === 'EACCES' && !sudo) {
          const ok = await ask('Save with sudo?', `<div class="text-sm">The SSH user may not write <b>${esc(name)}</b>. Save it with <span class="td-mono">sudo</span>? Its owner and mode stay.</div>`, [{ label: 'Cancel', className: 'btn btn-secondary', value: false }, { label: 'Save with sudo', className: 'btn btn-primary', value: true }]);
          if (ok) { sudo = true; return write(force); }
          return false;
        }
        showToast(e.message, 'error', 10000); return false;
      }
    };
    // nginx -t after a save under /etc/nginx: a broken config is offered to be put back before nginx reloads it.
    const nginxCheck = async (before) => {
      let r; try { r = await API.post('/files/check', { path, kind: 'nginx' }); } catch (e) { return; }
      if (r.ok === null) return;
      if (r.ok) { showToast('nginx -t: the configuration is valid — reload nginx to use it', 'success', 7000); return; }
      const v = await ask('nginx -t failed', `<div class="text-sm" style="margin-bottom:8px">The file is saved, but nginx would not accept the configuration now. nginx keeps running with the old one until it is reloaded.</div><pre class="td-mono" style="white-space:pre-wrap;font-size:12px;max-height:40vh;overflow:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:8px;margin:0">${esc(r.output)}</pre>`, [{ label: 'Keep editing', className: 'btn btn-secondary', value: false }, { label: 'Put the previous content back', className: 'btn btn-danger', value: true }]);
      if (v) { const mine = ta.value; ta.value = before; lines(); const ok = await write(true); if (!ok) { ta.value = mine; lines(); } else showToast('The previous content is back; your edit is under Versions', 'info', 8000); mark(); }
    };
    const checkHtml = (r) => r.ok === null ? `<div class="ui-sub" style="margin-bottom:8px">${esc(r.tool)}: ${esc(r.output)}</div>`
      : `<div style="margin-bottom:8px;padding:8px 10px;border-radius:8px;border:1px solid ${r.ok ? 'var(--success)' : 'var(--danger)'};background:${r.ok ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)'}"><b style="color:${r.ok ? 'var(--success)' : 'var(--danger)'}">${r.ok ? '✓' : '✗'} ${esc(r.tool)}</b>${r.ok ? ' — valid' : `<pre class="td-mono" style="white-space:pre-wrap;font-size:12px;margin:6px 0 0;max-height:24vh;overflow:auto">${esc(r.output)}</pre>`}</div>`;
    const runChecks = async () => {
      if (/\.json$/i.test(name)) { try { JSON.parse(ta.value); return { ok: true, tool: 'JSON', output: '' }; } catch (e) { return { ok: false, tool: 'JSON', output: e.message }; } }
      if (isCompose(name)) { try { return await API.post('/files/check', { path, content: ta.value, kind: 'compose' }); } catch (e) { return { ok: null, tool: 'docker compose config', output: e.message }; } }
      const sk = sysKind(path);
      if (sk) { try { return await API.post('/files/check', { path, content: ta.value, kind: sk }); } catch (e) { return { ok: null, tool: sk, output: e.message }; } }
      return null;
    };
    const check = async () => {
      const b = ov.querySelector('[data-check]'); if (b) { b.disabled = true; b.textContent = 'Checking…'; }
      const r = await runChecks();
      if (b) { b.disabled = false; b.textContent = 'Check'; }
      if (r) await ask(r.ok ? 'Valid' : r.ok === null ? 'Could not check' : 'Not valid', checkHtml(r), [{ label: 'Close', className: 'btn btn-secondary', value: null }]);
    };
    const save = async () => {
      if (!dirty()) { showToast('Nothing changed'); return; }
      const sb = ov.querySelector('[data-save]'); sb.disabled = true;
      const chk = await runChecks();
      sb.disabled = false;
      const d = diffHtml(diffLines(original, ta.value));
      const ok = await ask(`Save ${esc(name)}?`, `${chk ? checkHtml(chk) : ''}<div class="text-sm" style="margin-bottom:8px"><span style="color:var(--success)">+${d.add}</span> · <span style="color:var(--danger)">−${d.del}</span> lines. The file is replaced in one step (never half written); its current content is kept under Versions.${isNginx(path) ? ' After saving, <span class="td-mono">nginx -t</span> checks the configuration.' : ''}</div>${d.html}`, [{ label: 'Back', className: 'btn btn-secondary', value: false }, { label: sudo ? 'Save with sudo' : 'Save', className: 'btn btn-primary', value: true }]);
      if (ok) await write();
    };
    const showVersion = async (id) => {
      let v; try { v = await API.get(`/files/version?id=${encodeURIComponent(id)}`); } catch (er) { return showToast(er.message, 'error'); }
      const d = diffHtml(diffLines(ta.value, v.content));
      const ok = await ask(`Version of ${esc(new Date(v.t).toLocaleString())}`, `<div class="text-sm" style="margin-bottom:8px">Compared with the editor now: <span style="color:var(--success)">+${d.add}</span> · <span style="color:var(--danger)">−${d.del}</span>.</div>${d.html}`, [{ label: 'Close', className: 'btn btn-secondary', value: false }, { label: 'Put it in the editor', className: 'btn btn-primary', value: true }]);
      if (ok) { ta.value = v.content; lines(); mark(); showToast('Loaded into the editor — Save to write it'); }
    };
    const versions = async () => {
      let list = [];
      try { list = await API.get(`/files/versions?path=${encodeURIComponent(path)}`); } catch (e) { return showToast(e.message, 'error'); }
      const body = list.length
        ? `<div class="text-sm" style="margin-bottom:8px">The content before each save from DockGate (the last 5). Pick one to compare it with the editor.</div>${list.map(v => `<button type="button" class="btn btn-secondary" style="display:flex;width:100%;justify-content:space-between;margin-bottom:6px" data-ver="${v.id}">${esc(new Date(v.t).toLocaleString())}<span class="ui-sub">${formatBytes(v.size)}</span></button>`).join('')}`
        : '<div class="text-sm">No earlier version yet — one is kept each time this file is saved from here (the last 5).</div>';
      const m = showModal('Versions', body, [{ label: 'Close', className: 'btn btn-secondary' }]);
      m.overlay.style.zIndex = 1300;
      m.overlay.querySelectorAll('[data-ver]').forEach(b => { b.onclick = () => { m.close(); showVersion(b.dataset.ver); }; });
    };
    const onKey = (e) => {
      if (!document.body.contains(ov)) { document.removeEventListener('keydown', onKey, true); return; }
      if (document.querySelectorAll('.modal-overlay').length > 1 && e.key === 'Escape') return; // a dialog above handles it
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    ov.querySelector('[data-close]').onclick = close;
    ov.querySelector('[data-cancel]').onclick = close;
    ov.querySelector('[data-save]').onclick = save;
    ov.querySelector('[data-versions]').onclick = versions;
    const cb = ov.querySelector('[data-check]'); if (cb) cb.onclick = check;
    // Extra buttons from the caller (e.g. Scripts → Insert block): insert text at the cursor.
    const api = { insert(text) { const s = ta.selectionStart; ta.setRangeText(text, s, ta.selectionEnd, 'end'); lines(); mark(); ta.focus(); }, get value() { return ta.value; } };
    ov.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => actions[Number(b.dataset.act)].run(api); });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  }

  return { open, diffLines, highlight, langOf };
})();
