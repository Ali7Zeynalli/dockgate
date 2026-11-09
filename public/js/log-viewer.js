// One log viewer for every log in DockGate (container logs, host logs, events, audit, notifications, build and
// deploy output, setup runs, fail2ban bans, service journals). Same toolbar everywhere:
//   search (highlights, regex, match case, ↑/↓ or Enter to jump) · level chips with counts · source · time range ·
//   how many of the newest lines to load (1,000 … 10,000, remembered per place) · Live/Pause · Wrap · Copy · Download
// A per-minute histogram (red = errors) zooms to a minute on click; a line opens its details. Only the visible rows
// are drawn, so 10,000 lines scroll as smoothly as 100.
//
// LogViewer.mount(el, opts) → { reload(), push(textOrRows), setText(text), setRows(rows), destroy() }
//   opts.key        remembers the load limit / wrap per place (localStorage, best effort)
//   opts.title, opts.desc, opts.retention   header texts ("keeps the last 10,000", "the server keeps it" …)
//   opts.limits     [1000, 2000, 5000, 8000, 10000] (default) or null when the place has no limit to choose
//   opts.load       async (limit) => ({ rows } | { text, format? })   rows: [{ t, l, src, msg, meta }]
//   opts.format     how text lines are read: 'auto' (default) · 'docker' · 'plain'
//   opts.tools      extra toolbar HTML (e.g. a source picker); opts.onTools(el, viewer) wires it
//   opts.live       true → shows Live/Pause; lines arrive through push()
//   opts.poll       ms → reload() every ms while Live is on (for places without a stream)
//   opts.liveDefault false → starts Paused (e.g. host logs: polling 10,000 lines over SSH is opt-in)
//   opts.showTime   false hides the time column (Settings → Log timestamps); times still drive the filters
//   opts.height     list height (default 60vh); opts.compact hides the histogram
//   opts.empty      text when there is nothing to show
const LogViewer = (() => {
  const LV = { E: 'Error', W: 'Warn', I: 'Info', D: 'Debug' };
  const LVC = { E: 'err', W: 'warn', I: 'info', D: 'dbg' };
  const LIMITS = [1000, 2000, 5000, 8000, 10000];
  const ROW = 22;
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const store = { get(k) { try { return JSON.parse(localStorage.getItem('dg_lv_' + k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem('dg_lv_' + k, JSON.stringify(v)); } catch (e) { /* storage off */ } } };

  /** Level of a line from its words (error / warn / debug), else info. */
  function levelOf(s) {
    if (/^(E|ERR!?):? /.test(s) || /\bnpm ERR!/.test(s)) return 'E'; // apt "E: …", npm "ERR!"
    if (/\b(fatal|panic|emerg|alert|crit(ical)?|err(or)?|exception|traceback|fail(ed|ure)?|denied|refused|oom|killed|segfault)\b|\bE\d{4}\b|level=(error|fatal)|"level":"(error|fatal)"|\[(error|err)\]/i.test(s)) return 'E';
    if (/\b(warn(ing)?|deprecated|retry(ing)?|timeout|timed out|slow|invalid user|preauth)\b|level=warn|"level":"warn"|\[warn\]/i.test(s)) return 'W';
    if (/\b(debug|trace|verbose)\b|level=debug|"level":"debug"|\[debug\]/i.test(s)) return 'D';
    return 'I';
  }
  /** One text line → { t, l, src, msg }. Understands Docker timestamps, journald short-iso, syslog, fail2ban. */
  function parseLine(line, format) {
    let t = null, src = '', msg = line, m;
    if ((m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+(.*)$/.exec(line))) { // Docker / journald short-iso
      t = Date.parse(m[1].replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); msg = m[2];
      if (format !== 'docker') { const j = /^\S+\s+([A-Za-z0-9_.@-]+?)(?:\[\d+\])?:\s(.*)$/.exec(msg); if (j) { src = j[1]; msg = j[2]; } }
    } else if ((m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:[,.]\d+)?\s+(.*)$/.exec(line))) { // fail2ban, many apps
      t = Date.parse(m[1].replace(' ', 'T')); msg = m[2];
      const f = /^fail2ban\.\S+\s+\[\d+\]:\s+(\w+)\s+\[([\w.-]+)\]\s+(.*)$/.exec(msg);
      if (f) { src = f[2]; msg = f[3]; return { t, l: /ERROR|CRITICAL/.test(f[1]) ? 'E' : /Ban/.test(f[3]) && !/Unban/.test(f[3]) ? 'W' : f[1] === 'WARNING' ? 'W' : 'I', src, msg }; }
    } else if ((m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s(\d\d:\d\d:\d\d)\s+\S+\s+([A-Za-z0-9_.@/-]+?)(?:\[\d+\])?:\s(.*)$/.exec(line))) { // classic syslog
      const d = new Date(); d.setMonth(MON[m[1].toLowerCase()] ?? d.getMonth(), Number(m[2])); const [hh, mm, ss] = m[3].split(':').map(Number); d.setHours(hh, mm, ss, 0);
      if (d.getTime() > Date.now() + 86400000) d.setFullYear(d.getFullYear() - 1);
      t = d.getTime(); src = m[4]; msg = m[5];
    }
    return { t: Number.isFinite(t) ? t : null, l: levelOf(msg), src, msg };
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtT = (t, long) => t == null ? '' : new Date(t).toLocaleString([], long ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function mount(el, opts = {}) {
    const key = opts.key || 'default';
    const saved = store.get(key) || {};
    const limits = opts.limits === null ? null : (opts.limits || LIMITS);
    const st = { q: '', rx: false, cs: false, lv: { E: true, W: true, I: true, D: true }, src: '', range: 0, minute: null, cur: -1,
      wrap: !!saved.wrap, live: (opts.live || opts.poll) ? opts.liveDefault !== false : false, limit: limits ? (limits.includes(saved.limit) ? saved.limit : (opts.defaultLimit || limits[0])) : null };
    let rows = [], view = [], matches = [], timer = null, loading = false, destroyed = false;
    el.classList.add('lv');
    el.classList.toggle('lv-notime', opts.showTime === false); // Settings → Log timestamps (times still drive filters)
    el.innerHTML = `
      ${opts.title || opts.retention ? `<div class="lv-head"><div><b>${esc(opts.title || '')}</b>${opts.desc ? `<div class="ui-sub">${esc(opts.desc)}</div>` : ''}</div>${opts.retention ? `<span class="lv-ret" title="How much of this log is kept">${esc(opts.retention)}</span>` : ''}</div>` : ''}
      <div class="lv-tools">
        <div class="lv-search"><input data-q placeholder="Search…  (Enter = next match)" aria-label="Search the log"><button type="button" data-rx aria-pressed="false" title="Regular expression">.*</button><button type="button" data-cs aria-pressed="false" title="Match case">Aa</button></div>
        <span class="lv-levels" data-levels></span>
        ${opts.tools || ''}
        <select class="select" data-src aria-label="Source"></select>
        <select class="select" data-range aria-label="Time range"><option value="0">All time</option><option value="15">Last 15 min</option><option value="60">Last hour</option><option value="1440">Last 24 h</option><option value="10080">Last 7 days</option></select>
        ${limits ? `<select class="select" data-limit aria-label="How many of the newest lines to load" title="How many of the newest lines to load">${limits.map(n => `<option value="${n}" ${n === st.limit ? 'selected' : ''}>Last ${n.toLocaleString()}</option>`).join('')}</select>` : ''}
        <span class="lv-actions">
          ${opts.live || opts.poll ? `<button type="button" class="btn btn-sm btn-secondary" data-live aria-pressed="true" title="${opts.poll ? `Load again every ${Math.round(opts.poll / 1000)} s` : 'New lines appear at the bottom'}">● Live</button>` : ''}
          ${opts.load ? `<button type="button" class="btn btn-sm btn-secondary" data-reload title="Load again">${typeof Icons !== 'undefined' ? Icons.refresh : '↻'}</button>` : ''}
          <button type="button" class="btn btn-sm btn-secondary" data-wrap aria-pressed="${st.wrap}">Wrap</button>
          <button type="button" class="btn btn-sm btn-secondary" data-copy>Copy</button>
          <button type="button" class="btn btn-sm btn-secondary" data-dl>Download</button>
        </span>
      </div>
      ${opts.compact ? '' : '<div class="lv-hist" data-hist title="Click a bar to show that minute"></div><div class="lv-histax"><span data-hfrom></span><span data-hsel></span><span data-hto></span></div>'}
      <div class="lv-list ${st.wrap ? 'lv-wrap' : ''}" data-list tabindex="0" style="height:${opts.height || '60vh'}"><div class="lv-spacer" data-spacer></div></div>
      <div class="lv-foot"><span data-status></span><span class="lv-actions"><button type="button" class="btn btn-sm btn-secondary" data-prev title="Previous match (Shift+Enter)">↑</button><button type="button" class="btn btn-sm btn-secondary" data-next title="Next match (Enter)">↓</button><button type="button" class="btn btn-sm btn-ghost" data-clear>Clear filters</button></span></div>
      <div class="lv-detail" data-detail role="dialog" aria-label="Line details"><div class="lv-detail-head"><b data-dtitle></b><button type="button" class="btn btn-sm btn-secondary" data-dclose aria-label="Close">✕</button></div><dl data-dmeta></dl><pre data-dbody></pre></div>`;
    const $ = (s) => el.querySelector(s);
    const list = $('[data-list]'), spacer = $('[data-spacer]');

    function matcher() {
      if (!st.q) return null;
      try { return new RegExp(st.rx ? st.q : st.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), st.cs ? 'g' : 'gi'); } catch (e) { return 'bad'; }
    }
    const hasTime = () => rows.some(r => r.t != null);
    function apply(keepScroll) {
      const m = matcher(), now = Date.now(), from = st.range ? now - st.range * 60000 : 0;
      const base = rows.filter(r => (!st.src || r.src === st.src) && (!from || (r.t != null && r.t >= from)) && (st.minute == null || (r.t != null && Math.floor(r.t / 60000) === st.minute)));
      const cnt = { E: 0, W: 0, I: 0, D: 0 };
      view = [];
      for (const r of base) {
        if (m && m !== 'bad') { m.lastIndex = 0; const a = m.test(r.msg); m.lastIndex = 0; if (!a && !m.test(r.src || '')) continue; }
        cnt[r.l]++;
        if (st.lv[r.l]) view.push(r);
      }
      matches = m && m !== 'bad' ? view : [];
      if (st.cur >= view.length) st.cur = -1;
      $('[data-levels]').innerHTML = ['E', 'W', 'I', 'D'].map(l => `<button type="button" class="lv-chip lv-${LVC[l]}" data-lv="${l}" aria-pressed="${st.lv[l]}">${LV[l]} <span>${cnt[l].toLocaleString()}</span></button>`).join('');
      $('[data-q]').classList.toggle('lv-bad', m === 'bad');
      const srcs = [...new Set(rows.map(r => r.src).filter(Boolean))];
      el.classList.toggle('lv-nosrc', !srcs.length); // no source column when nothing has one
      const srcSel = $('[data-src]'); srcSel.style.display = srcs.length > 1 ? '' : 'none';
      if (srcSel.dataset.n !== String(srcs.length)) { srcSel.innerHTML = `<option value="">All sources (${srcs.length})</option>` + srcs.sort().map(s => `<option ${s === st.src ? 'selected' : ''}>${esc(s)}</option>`).join(''); srcSel.dataset.n = String(srcs.length); }
      $('[data-range]').style.display = hasTime() ? '' : 'none';
      drawHist(); draw(!keepScroll);
      const shown = view.length.toLocaleString(), total = rows.length.toLocaleString();
      $('[data-status]').innerHTML = loading ? 'Loading…' : (view.length === rows.length ? `<b>${total}</b> line${rows.length === 1 ? '' : 's'}` : `<b>${shown}</b> of <b>${total}</b> lines`)
        + (st.limit && rows.length >= st.limit ? ` · the newest ${st.limit.toLocaleString()} loaded` : '')
        + (m === 'bad' ? ' · <span class="lv-e">invalid regex</span>' : m ? ` · <b>${matches.length.toLocaleString()}</b> match${matches.length === 1 ? '' : 'es'}` : '');
    }
    function drawHist() {
      const h = $('[data-hist]'); if (!h) return;
      const tr = rows.filter(r => r.t != null && (!st.src || r.src === st.src) && (!st.range || r.t >= Date.now() - st.range * 60000));
      if (tr.length < 2) { h.style.display = 'none'; $('[data-hfrom]').parentElement.style.display = 'none'; return; }
      h.style.display = ''; $('[data-hfrom]').parentElement.style.display = '';
      const t0 = Math.min(...tr.map(r => r.t)), t1 = Math.max(...tr.map(r => r.t)), N = 80, w = Math.max(60000, (t1 - t0) / N || 60000);
      const b = Array.from({ length: N }, () => ({ E: 0, W: 0, O: 0, m: null }));
      for (const r of tr) { const i = Math.min(N - 1, Math.floor((r.t - t0) / w)); const x = b[i]; if (x.m == null) x.m = Math.floor(r.t / 60000); if (r.l === 'E') x.E++; else if (r.l === 'W') x.W++; else x.O++; }
      const max = Math.max(1, ...b.map(x => x.E + x.W + x.O)), long = t1 - t0 > 86400000;
      h.innerHTML = b.map((x, i) => `<div data-b="${i}" class="${st.minute != null && x.m === st.minute ? 'lv-sel' : ''}" title="${esc(fmtT(t0 + i * w, true))} · ${x.E} errors, ${x.W} warnings, ${x.O} other" style="height:${((x.E + x.W + x.O) / max) * 100}%"><span style="flex:${x.O}" class="lv-bo"></span><span style="flex:${x.W}" class="lv-bw"></span><span style="flex:${x.E}" class="lv-be"></span></div>`).join('');
      h._b = b;
      $('[data-hfrom]').textContent = fmtT(t0, long); $('[data-hto]').textContent = fmtT(t1, long);
      $('[data-hsel]').innerHTML = st.minute != null ? `showing ${esc(fmtT(st.minute * 60000, true))} · <a href="#" data-hclr>show all</a>` : '';
    }
    function hl(s) {
      const m = matcher(), e = esc(s);
      if (!m || m === 'bad') return e;
      const parts = []; let last = 0, x; m.lastIndex = 0;
      while ((x = m.exec(s)) && parts.length < 200) { if (!x[0]) { m.lastIndex++; continue; } parts.push(esc(s.slice(last, x.index)), `<mark>${esc(x[0])}</mark>`); last = x.index + x[0].length; }
      parts.push(esc(s.slice(last)));
      return parts.join('');
    }
    function draw(toBottom) {
      if (st.wrap) { // wrapped lines have different heights: draw the newest 1,500 directly
        const part = view.slice(-1500);
        spacer.style.height = 'auto';
        spacer.innerHTML = (view.length > part.length ? `<div class="lv-more">${(view.length - part.length).toLocaleString()} older lines hidden in Wrap view — search or filter to narrow down</div>` : '') + part.map((r, k) => rowHtml(r, view.length - part.length + k, null)).join('');
        if (toBottom && st.live) list.scrollTop = list.scrollHeight;
        return;
      }
      spacer.style.height = Math.max(view.length * ROW, 1) + 'px';
      if (toBottom && st.live) list.scrollTop = spacer.offsetHeight;
      const top = list.scrollTop, hgt = list.clientHeight || 400;
      const a = Math.max(0, Math.floor(top / ROW) - 8), z = Math.min(view.length, Math.ceil((top + hgt) / ROW) + 8);
      let html = '';
      for (let i = a; i < z; i++) html += rowHtml(view[i], i, i * ROW);
      spacer.innerHTML = view.length ? html : `<div class="lv-empty">${loading ? 'Loading…' : esc(rows.length ? 'Nothing matches the filters.' : (opts.empty || 'No log lines.'))}</div>`;
    }
    function rowHtml(r, i, top) {
      return `<div class="lv-row ${r.l === 'E' ? 'lv-re' : r.l === 'W' ? 'lv-rw' : ''} ${i === st.cur ? 'lv-cur' : ''}" data-i="${i}" ${top != null ? `style="top:${top}px"` : ''}>`
        + `<span class="lv-t">${esc(fmtT(r.t, true))}</span><span class="lv-l lv-${LVC[r.l]}">${LV[r.l].toUpperCase()}</span>${r.src ? `<span class="lv-s" title="${esc(r.src)}">${esc(r.src)}</span>` : '<span class="lv-s"></span>'}<span class="lv-m">${hl(r.msg)}</span></div>`;
    }
    function jump(d) {
      if (!matches.length) return;
      st.cur = st.cur < 0 ? (d > 0 ? 0 : matches.length - 1) : (st.cur + d + matches.length) % matches.length;
      setLive(false);
      if (!st.wrap) list.scrollTop = Math.max(0, st.cur * ROW - list.clientHeight / 2);
      draw(false);
      if (st.wrap) list.querySelector('.lv-cur')?.scrollIntoView({ block: 'center' });
      $('[data-status]').innerHTML = `match <b>${(st.cur + 1).toLocaleString()}</b> of <b>${matches.length.toLocaleString()}</b>`;
    }
    function setLive(on) {
      const b = $('[data-live]'); st.live = on && !!b;
      if (b) { b.setAttribute('aria-pressed', String(st.live)); b.textContent = st.live ? '● Live' : '❚❚ Paused'; }
      clearInterval(timer); timer = null;
      if (st.live && opts.poll) timer = setInterval(() => { if (!document.body.contains(el)) return api.destroy(); load(true); }, opts.poll);
    }
    const toRows = (data) => {
      if (data.rows) return data.rows.map(r => ({ t: r.t ?? null, l: r.l || levelOf(r.msg || ''), src: r.src || '', msg: String(r.msg ?? ''), meta: r.meta }));
      return String(data.text || '').split('\n').filter(s => s.trim()).map(s => parseLine(s.replace(/\r$/, ''), data.format || opts.format || 'auto'));
    };
    let again = false;
    async function load(quiet) {
      if (!opts.load) return;
      if (loading) { if (!quiet) again = true; return; } // a newer request (limit / source changed) runs right after
      loading = true; if (!quiet) { rows = []; apply(); }
      try { const d = await opts.load(st.limit); if (destroyed) return; rows = toRows(d || {}); if (st.limit) rows = rows.slice(-st.limit); }
      catch (e) { rows = [{ t: null, l: 'E', src: '', msg: `Could not load: ${e.message}` }]; }
      finally { loading = false; }
      if (again && !destroyed) { again = false; return load(); }
      apply(quiet);
    }
    const asText = () => view.map(r => `${r.t != null ? new Date(r.t).toISOString() + ' ' : ''}${LV[r.l].toUpperCase().padEnd(5)} ${r.src ? r.src + '  ' : ''}${r.msg}`).join('\n');
    // ---- events
    let qt; $('[data-q]').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value; st.cur = -1; apply(); }, 150); });
    $('[data-q]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { e.target.value = ''; st.q = ''; apply(); } });
    $('[data-rx]').onclick = (e) => { st.rx = !st.rx; e.currentTarget.setAttribute('aria-pressed', String(st.rx)); apply(); };
    $('[data-cs]').onclick = (e) => { st.cs = !st.cs; e.currentTarget.setAttribute('aria-pressed', String(st.cs)); apply(); };
    $('[data-levels]').onclick = (e) => { const b = e.target.closest('[data-lv]'); if (!b) return; const l = b.dataset.lv;
      if (Object.values(st.lv).every(Boolean)) { for (const k in st.lv) st.lv[k] = k === l; } else st.lv[l] = !st.lv[l];
      if (!Object.values(st.lv).some(Boolean)) for (const k in st.lv) st.lv[k] = true; apply(); };
    $('[data-src]').onchange = (e) => { st.src = e.target.value; apply(); };
    $('[data-range]').onchange = (e) => { st.range = Number(e.target.value); st.minute = null; apply(); };
    $('[data-limit]')?.addEventListener('change', (e) => { st.limit = Number(e.target.value); store.set(key, { ...(store.get(key) || {}), limit: st.limit }); if (opts.onLimit) opts.onLimit(st.limit, api); else load(); });
    $('[data-hist]')?.addEventListener('click', (e) => { const d = e.target.closest('[data-b]'); const b = $('[data-hist]')._b; if (!d || !b) return; const x = b[Number(d.dataset.b)]; if (!x || x.m == null) return; st.minute = st.minute === x.m ? null : x.m; apply(); });
    el.querySelector('.lv-histax')?.addEventListener('click', (e) => { if (e.target.closest('[data-hclr]')) { e.preventDefault(); st.minute = null; apply(); } });
    list.addEventListener('scroll', () => { if (!st.wrap) draw(false); const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - ROW * 2; if (!atBottom && st.live && (opts.live || opts.poll) && document.activeElement === list) setLive(false); });
    list.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (!r) return; const x = view[Number(r.dataset.i)]; if (!x) return;
      $('[data-dtitle]').textContent = `${LV[x.l]}${x.src ? ' · ' + x.src : ''}`;
      $('[data-dmeta]').innerHTML = `${x.t != null ? `<dt>Time</dt><dd>${esc(new Date(x.t).toLocaleString())}</dd>` : ''}<dt>Level</dt><dd class="lv-${LVC[x.l]}">${LV[x.l]}</dd>${x.src ? `<dt>Source</dt><dd>${esc(x.src)}</dd>` : ''}${x.meta ? Object.entries(x.meta).filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('') : ''}`;
      const j = x.msg.match(/\{[\s\S]*\}$/); let body = x.msg;
      if (j) { try { body = x.msg.slice(0, j.index) + '\n\n' + JSON.stringify(JSON.parse(j[0]), null, 2); } catch (e2) { /* not JSON */ } }
      $('[data-dbody]').textContent = body; $('[data-detail]').classList.add('lv-show'); });
    $('[data-dclose]').onclick = () => $('[data-detail]').classList.remove('lv-show');
    $('[data-live]')?.addEventListener('click', () => { setLive(!st.live); if (st.live) { draw(true); if (opts.poll) load(true); } });
    $('[data-reload]')?.addEventListener('click', () => load());
    $('[data-wrap]').onclick = (e) => { st.wrap = !st.wrap; e.currentTarget.setAttribute('aria-pressed', String(st.wrap)); list.classList.toggle('lv-wrap', st.wrap); store.set(key, { ...(store.get(key) || {}), wrap: st.wrap }); draw(true); };
    $('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(asText()); showToast(`Copied ${view.length.toLocaleString()} lines`); } catch (e) { showToast('Copy is not available here', 'error'); } };
    $('[data-dl]').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([asText()], { type: 'text/plain;charset=utf-8' })); a.download = `${(opts.fileName || key).replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
    $('[data-prev]').onclick = () => jump(-1); $('[data-next]').onclick = () => jump(1);
    $('[data-clear]').onclick = () => { st.q = ''; $('[data-q]').value = ''; st.rx = st.cs = false; $('[data-rx]').setAttribute('aria-pressed', 'false'); $('[data-cs]').setAttribute('aria-pressed', 'false'); for (const k in st.lv) st.lv[k] = true; st.src = ''; st.range = 0; $('[data-range]').value = '0'; st.minute = null; apply(); };

    const api = {
      get limit() { return st.limit; },
      reload: () => load(),
      /** Append streamed text (one or more lines) or rows; keeps at most the chosen number of lines. */
      push(data) {
        const add = typeof data === 'string' ? toRows({ text: data }) : toRows({ rows: [].concat(data) });
        if (!add.length) return;
        rows.push(...add); if (st.limit && rows.length > st.limit) rows.splice(0, rows.length - st.limit);
        if (!st.live && (opts.live || opts.poll)) { $('[data-status]').innerHTML = `Paused · <b>${rows.length.toLocaleString()}</b> lines (new ones are kept)`; return; }
        if (!api._raf) api._raf = requestAnimationFrame(() => { api._raf = null; apply(); });
      },
      setText(text, format) { rows = toRows({ text, format }); if (st.limit) rows = rows.slice(-st.limit); apply(); },
      setRows(r) { rows = toRows({ rows: r }); apply(); },
      /** Put text in the search box (e.g. a preset like "Ban "). */
      setQuery(q, regex = false) { st.q = q || ''; st.rx = !!regex; $('[data-q]').value = st.q; $('[data-rx]').setAttribute('aria-pressed', String(st.rx)); st.cur = -1; apply(); },
      notice(text, level = 'I') { api.push([{ t: Date.now(), l: level, src: 'DockGate', msg: text }]); },
      clear() { rows = []; apply(); },
      destroy() { destroyed = true; clearInterval(timer); timer = null; },
    };
    setLive(st.live);
    if (opts.onTools) opts.onTools(el, api);
    if (opts.load) load(); else apply();
    return api;
  }
  return { mount, parseLine, levelOf, LIMITS };
})();
window.LogViewer = LogViewer;
