// Fail2ban tab (Server Console): problems first, then Banned IPs · Whitelist · Settings · History.
// Settings are written to DockGate's own files (jail.d/dockgate.conf + fail2ban.d/dockgate.conf), tested
// with `fail2ban-client -t` and applied with a RELOAD, so current bans are kept. The backend detects
// settings that cannot work (a recidive that can never trigger, a jail on the wrong SSH port, a short
// ban memory) and the preview below shows the real ban lengths fail2ban will use.

// Same maths as server/security/fail2ban.js (fail2ban's default increment formula).
const F2B_UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
function f2bSeconds(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^(\d+[smhdw])+$/.test(s)) return null;
  let t = 0; for (const m of s.matchAll(/(\d+)([smhdw])/g)) t += Number(m[1]) * F2B_UNIT[m[2]];
  return t;
}
function f2bHuman(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.round((sec % 86400) / 3600);
  if (d >= 1) return h ? `${d}d ${h}h` : `${d}d`;
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}
function f2bSequence(s, n) {
  const b = f2bSeconds(s.bantime), max = f2bSeconds(s.maxtime), f = Number(s.factor) || 1, out = [];
  for (let c = 0; c < n; c++) {
    let t = c === 0 || !s.increment ? b : Math.max(b, b * Math.pow(2, Math.min(c, 20)) * f);
    if (s.increment && max) t = Math.min(t, max);
    out.push(t);
  }
  return out;
}

async function renderFail2banPanel(serverId, container) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let f;
  try { f = await API.get(`/servers/${serverId}/fail2ban`); }
  catch (e) { return secError(container, "Couldn't read fail2ban", e, () => renderFail2banPanel(serverId, container)); }
  const reload = () => renderFail2banPanel(serverId, container);
  if (!f.installed) {
    container.innerHTML = `<div class="card" style="border-left:3px solid var(--warning)"><div style="font-weight:700;font-size:15px">fail2ban is not installed</div><div class="text-sm text-muted" style="margin-top:4px">Install it in <b>Setup → Fail2ban</b>. DockGate writes a working configuration (sshd jail on the real SSH port, ban history, recidive).</div><button class="btn btn-primary btn-sm" data-setup style="margin-top:10px">Open Setup</button></div>`;
    container.querySelector('[data-setup]').addEventListener('click', () => document.querySelector('#con-tabs .tab-btn[data-ctab="setup"]')?.click());
    return;
  }
  const LV = { crit: 'danger', warn: 'warning', info: 'info' };
  const totalBanned = f.jails.reduce((n, j) => n + j.currentlyBanned, 0);
  const rows = f.jails.flatMap(j => j.banned.map(b => ({ ...b, jail: j.name })));
  const allow = [...(f.settings.ignoreip || [])];
  const live = (name) => f.jails.find(j => j.name === name);

  container.innerHTML = `
    <div data-bar style="margin-bottom:12px"></div>
    ${f.problems.length ? `<div style="display:grid;gap:8px;margin-bottom:12px">${f.problems.map((p, i) => `
      <div class="insight-card ${LV[p.level]}" style="justify-content:space-between;margin:0"><span>${escapeHtml(p.text)}</span>${p.fix ? `<button class="btn btn-xs btn-secondary" data-fix="${i}" style="flex:none">${p.fix === 'start' ? 'Start fail2ban' : p.fix === 'editlocal' ? 'Edit jail.local' : p.fix === 'takeover' ? 'Move to DockGate…' : p.fix === 'allowdg' ? "Add DockGate's IP" : 'Fix now'}</button>` : ''}</div>`).join('')}</div>` : ''}
    ${UI.statusLine([
      `<b>${totalBanned}</b> <span class="text-muted">banned now</span>`,
      `<b>${f.jails.length}</b> <span class="text-muted">jails running</span>`,
      `<span class="text-muted">One IP gets</span> ${escapeHtml(f.sequence.slice(0, 5).join(' → '))} <span class="text-muted">· remembered ~${escapeHtml(f.memory)}</span>`,
    ])}
    <details class="f2b-card" data-banned-card style="margin-top:4px"><summary><span class="f2b-chev" aria-hidden="true">›</span><span><b>Banned IPs</b> ${UI.pill(totalBanned ? 'bad' : 'off', `${rows.length} banned`)}<div class="ui-sub">Blocked right now. They are released automatically when their time runs out.</div></span><span>${UI.primary('Ban an IP', 'data-ban')}</span></summary>
      <div style="padding:12px 14px;display:grid;gap:8px"><input class="input" id="f2b-q" placeholder="Search IP or jail…" style="width:220px;max-width:100%"><div data-banned></div></div></details>
    <div data-config style="margin-top:20px"></div>
    <details class="f2b-card" style="margin-top:20px"><summary><span class="f2b-chev" aria-hidden="true">›</span><span><b>Ban history</b><div class="ui-sub">fail2ban's own log (/var/log/fail2ban.log): bans, unbans and the failed logins it counted</div></span><span></span></summary><div style="padding:12px 14px" data-history></div></details>
`;

  renderServiceBar(serverId, 'fail2ban', container.querySelector('[data-bar]'), { label: 'fail2ban', note: f.version ? escapeHtml(f.version) + ' · Reload keeps current bans' : 'Reload keeps current bans', onChange: reload });
  f2bHistory(serverId, container.querySelector('[data-history]'));

  const saveSettings = async (settings, title) => {
    const { jobId } = await API.post(`/servers/${serverId}/fail2ban/settings`, { settings, confirm: true });
    setTimeout(async () => { if (await runLifelineJob(serverId, jobId, title || 'Fail2ban settings')) reload(); }, 0);
  };
  container.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', async () => {
    const p = f.problems[Number(b.dataset.fix)];
    try {
      if (p.fix === 'takeover') { f2bTakeoverDialog(serverId, f, reload); return; }
      if (p.fix === 'allowdg') { if (f.dockgateIp && !allow.includes(f.dockgateIp)) await saveSettings({ ...f.settings, ignoreip: [...allow, f.dockgateIp] }, "Allow DockGate's IP"); return; }
      if (p.fix === 'editlocal') { container.querySelector('[data-config] [data-ctab="files"]')?.click(); container.querySelector('[data-config]').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (p.fix === 'start') { await API.post(`/servers/${serverId}/services/fail2ban/action`, { action: 'start', confirm: true }); showToast('fail2ban started'); reload(); }
      else await saveSettings(f.settings, 'Fix fail2ban settings');
    } catch (e) { showToast(e.message, 'error', 8000); }
  }));
  // Banned IPs: collapsible (remembered per browser), 25 per page, search over all of them.
  const bannedCard = container.querySelector('[data-banned-card]');
  let bOpen = null; try { bOpen = localStorage.getItem('dg_f2b_banned_open'); } catch (e) { /* storage off */ }
  bannedCard.open = bOpen == null ? rows.length > 0 : bOpen === '1';
  bannedCard.addEventListener('toggle', () => { try { localStorage.setItem('dg_f2b_banned_open', bannedCard.open ? '1' : '0'); } catch (e) { /* storage off */ } });
  bannedCard.querySelector('summary [data-ban]')?.addEventListener('click', (e) => e.preventDefault()); // the button must not toggle the card
  const bState = { page: 1, q: '' };
  const bannedBox = container.querySelector('[data-banned]');
  const drawBanned = () => {
    const q = bState.q.toLowerCase();
    const list = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.ip.toLowerCase().includes(q) || r.jail.toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(list.length / 25)); bState.page = Math.min(bState.page, pages);
    const slice = list.slice((bState.page - 1) * 25, bState.page * 25);
    bannedBox.innerHTML = UI.table([{ label: 'IP address' }, { label: 'Jail' }, { label: 'Banned' }, { label: 'Until' }, { label: '', align: 'right' }], slice.map(({ r, i }) => `<tr data-ip="${escapeHtml(r.ip)}">
      <td><span class="td-mono" style="font-weight:600">${escapeHtml(r.ip)}</span>${r.ip === f.dockgateIp ? ' ' + UI.pill('bad', 'DockGate') : ''}</td><td>${escapeHtml(r.jail)}</td>
      <td><span class="ui-sub">${escapeHtml(r.bannedAt || '—')}</span></td><td><span class="ui-sub">${escapeHtml(r.until || '—')}${r.seconds ? ` (${escapeHtml(f2bHuman(r.seconds))})` : ''}</span></td>
      <td class="ui-td-actions">${UI.btn('Unban', `data-unban="${i}"`)}${UI.btn('Unban & allow', `data-unwl="${i}"`)}</td></tr>`), { minWidth: 640, empty: q ? 'No banned IP matches.' : 'No IP is banned right now.' }) + UI.pager(bState.page, list.length, 25);
  };
  container.querySelector('#f2b-q').addEventListener('input', (e) => { bState.q = e.target.value.trim(); bState.page = 1; drawBanned(); });
  bannedBox.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-page]'); if (pg && !pg.disabled) { bState.page = Number(pg.dataset.page); drawBanned(); return; }
    const ub = e.target.closest('[data-unban]'); if (ub) return unban(rows[Number(ub.dataset.unban)], false);
    const uw = e.target.closest('[data-unwl]'); if (uw) { const r = rows[Number(uw.dataset.unwl)];
      secConfirm({ title: `Unban and allow ${escapeHtml(r.ip)}`, confirmLabel: 'Unban & allow',
        change: 'The IP is unbanned now and added to the allowlist (ignoreip) — fail2ban will never ban it again.',
        protects: 'fail2ban reloads after a configuration test; other bans are kept.', undo: 'Remove it from the Allowlist.',
        onConfirm: () => unban(r, true) }); }
  });
  const unban = async (r, whitelist) => {
    try { await API.post(`/servers/${serverId}/fail2ban/unban`, { jail: r.jail, ip: r.ip, whitelist }); showToast(`${r.ip} unbanned${whitelist ? ' and allowed' : ''}`); reload(); }
    catch (e) { showToast(e.message, 'error', 8000); }
  };
  drawBanned();
  container.querySelector('[data-ban]').addEventListener('click', () => UI.dialog({
    title: 'Ban an IP', saveLabel: 'Ban', danger: true,
    body: `<div class="ui-row"><div class="ui-field"><label for="bn-jail">Jail</label><select class="select" id="bn-jail">${f.jails.map(j => `<option ${j.name === 'sshd' ? 'selected' : ''}>${escapeHtml(j.name)}</option>`).join('')}</select></div>
      <div class="ui-field" style="flex:1;min-width:200px"><label for="bn-ip">IP address</label><input class="input td-mono" id="bn-ip" placeholder="203.0.113.4"></div></div>
      ${UI.explain('The IP is blocked in that jail for the jail\'s ban time.', 'DockGate refuses to ban the IP it connects from.')}`,
    onSave: async (ov) => { const ip = ov.querySelector('#bn-ip').value.trim(); if (!ip) throw new Error('Enter an IP address'); await API.post(`/servers/${serverId}/fail2ban/ban`, { jail: ov.querySelector('#bn-jail').value, ip }); showToast(`${ip} banned`); reload(); },
  }));
  f2bConfig(serverId, f, container.querySelector('[data-config]'), { saveSettings, reload });
}

/** "What one IP gets" for the settings x (ban sequence, memory, recidive reachability). */
function f2bPreviewHtml(x) {
  const seq = f2bSequence(x.sshd, 6);
  if (seq.some(t => t == null)) return '<div class="text-xs" style="color:var(--danger)">Use durations like 30m, 24h, 1d, 1w.</div>';
  const purge = f2bSeconds(x.dbpurgeage) || 0;
  let rec = '';
  if (x.recidive.enabled) {
    const need = seq.slice(0, Math.max(0, x.recidive.maxretry - 1)).reduce((a, b) => a + b, 0);
    const win = f2bSeconds(x.recidive.findtime);
    rec = win != null && need >= win
      ? `<div class="insight-card danger" style="margin-top:8px"><div>recidive can never trigger: ${x.recidive.maxretry} bans take at least ${f2bHuman(need)}, the window is ${f2bHuman(win)}.</div></div>`
      : `<div class="text-xs" style="color:var(--success);margin-top:8px">✓ recidive can trigger: the ${x.recidive.maxretry}th ban comes after at least ${f2bHuman(need)} — inside the ${f2bHuman(win)} window.</div>`;
    if (x.recidive.increment) {
      const rs = f2bSequence({ bantime: x.recidive.bantime, increment: true, factor: x.recidive.factor, maxtime: x.recidive.maxtime }, 4);
      if (!rs.some(t => t == null)) rec += `<div class="text-xs text-muted" style="margin-top:4px">All-port bans for one IP: ${rs.map(f2bHuman).join(' → ')}.</div>`;
    }
  }
  return `<div class="ui-explain"><div><b>What one IP gets</b> ${seq.map((t, i) => `${i + 1}. ${f2bHuman(t)}`).join(' → ')}</div><div>A first ban is remembered for about ${f2bHuman(purge + 3 * seq[0])}; after that the IP starts again at ${f2bHuman(seq[0])}.</div></div>${rec}`;
}

/**
 * Move fail2ban's sshd / recidive / allowlist / history settings out of jail.local (and any other file read after
 * DockGate's) into DockGate's own files. Shows exactly what moves, what is corrected, what goes and what stays,
 * and every file before → after; one job applies it (backup, test, reload, restore on failure).
 */
async function f2bTakeoverDialog(serverId, f, reload) {
  let t;
  try { t = await API.post(`/servers/${serverId}/fail2ban/takeover/preview`, {}); }
  catch (e) { showToast(e.message, 'error', 9000); return; }
  const li = (rows, fmt) => rows.length ? `<ul class="f2b-list">${rows.map(r => `<li>${fmt(r)}</li>`).join('')}</ul>` : '<div class="ui-sub">—</div>';
  const many = t.files.length > 1;
  const recFixed = t.corrected.some(c => c.what === 'recidive');
  const kv = (r) => `<span class="td-mono">[${escapeHtml(r.jail)}] ${escapeHtml(r.key)} = ${escapeHtml(r.value)}</span>${many ? ` <span class="ui-sub">· ${escapeHtml(r.file)}</span>` : ''}`;
  const kvA = (r) => kv(r) + (recFixed && r.jail === 'recidive' && (r.key === 'maxretry' || r.key === 'findtime') ? ' <span class="ui-sub">→ corrected</span>' : '');
  const cur = Object.fromEntries((f.files || []).map(x => [x.path, x.text || '']));
  UI.dialog({
    title: 'Move fail2ban settings to DockGate', saveLabel: 'Move & reload', wide: true,
    body: `<div class="ui-sub">${t.files.map(x => `<span class="td-mono">${escapeHtml(x.path)}</span>`).join(', ')} ${t.files.length > 1 ? 'are' : 'is'} read after DockGate's file and override${t.files.length > 1 ? '' : 's'} it. DockGate takes over what it manages and leaves everything else in ${t.files.length > 1 ? 'those files' : 'that file'} as it is. A backup is kept next to each file (<span class="td-mono">.dockgate-backup</span>); the configuration is tested before it is applied and everything is put back if the test or the reload fails. Current bans are kept.</div>
      <div class="f2b-cols">
        <div><div class="pv-k">Carried over to DockGate</div>${li(t.adopted, kvA)}</div>
        <div><div class="pv-k">Corrected</div>${li(t.corrected, r => `<b>${escapeHtml(r.what)}</b>: ${escapeHtml(r.from)} → <b>${escapeHtml(r.to)}</b><div class="ui-sub">${escapeHtml(r.why)}</div>`)}</div>
        <div><div class="pv-k">Removed — not needed</div>${li(t.removed, r => `${kv(r)}<div class="ui-sub">${escapeHtml(r.reason)}</div>`)}</div>
        <div><div class="pv-k">Left in place</div>${li(t.kept, r => `${kv(r)}<div class="ui-sub">a [DEFAULT] option — it also applies to your other jails</div>`)}</div>
      </div>
      ${t.files.map(x => `<div style="display:grid;gap:4px"><span class="td-mono text-sm">${escapeHtml(x.path)}</span>${lineDiffHtml(x.before, x.after)}</div>`).join('')}
      ${t.dockgate.map(x => `<div style="display:grid;gap:4px"><span class="td-mono text-sm">${escapeHtml(x.path)}</span>${(cur[x.path] || '') === x.text ? '<div class="ui-sub">No change.</div>' : lineDiffHtml(cur[x.path] || '', x.text)}</div>`).join('')}`,
    onSave: async () => {
      const { jobId } = await API.post(`/servers/${serverId}/fail2ban/takeover`, { confirm: true });
      setTimeout(async () => { if (await runLifelineJob(serverId, jobId, 'Move fail2ban settings to DockGate')) reload(); }, 0);
    },
  });
}

/**
 * Configuration (Fail2ban tab): everything fail2ban runs with for SSH, in one place. Two tabs:
 *  Settings — cards in a fixed order (Allowlist → sshd → recidive → History & log → Other options). Each row shows
 *    the value, what fail2ban really runs and which file sets it. Changes are drafts: edit one card or "Edit all",
 *    changed rows turn amber, a bar at the bottom collects them — "Review & apply all" writes everything in ONE
 *    tested reload; "Save this card" applies one card and leaves the rest pending. Drafts survive a reload/navigation
 *    (per server, in memory) until applied or discarded.
 *  Files — every fail2ban file under jail.d / fail2ban.d plus jail.local / fail2ban.local, with an editor.
 */
const F2B_DRAFTS = {}; // serverId → draft settings not applied yet
const F2B_FIELDS = [ // [card, path, label, tech, type, runtime key]
  ['sshd', 'sshd.maxretry', 'Failures before a ban', 'maxretry', 'int', 'maxretry'],
  ['sshd', 'sshd.findtime', 'Counting window', 'findtime', 'dur', 'findtime'],
  ['sshd', 'sshd.bantime', 'First ban', 'bantime', 'dur', 'bantime'],
  ['sshd', 'sshd.increment', 'Longer bans for repeat offenders', 'bantime.increment', 'bool', 'increment'],
  ['sshd', 'sshd.factor', 'Growth factor', 'bantime.factor', 'num', 'factor'],
  ['sshd', 'sshd.maxtime', 'Longest ban', 'bantime.maxtime', 'dur', 'maxtime'],
  ['sshd', 'sshd.mode', 'Detection mode', 'mode', 'mode', null],
  ['recidive', 'recidive.enabled', 'On', 'enabled', 'bool', null],
  ['recidive', 'recidive.maxretry', 'Bans before', 'maxretry', 'int', 'maxretry'],
  ['recidive', 'recidive.findtime', 'Window', 'findtime', 'dur', 'findtime'],
  ['recidive', 'recidive.bantime', 'Ban on all ports', 'bantime', 'dur', 'bantime'],
  ['recidive', 'recidive.increment', 'Longer all-port bans', 'bantime.increment', 'bool', 'increment'],
  ['recidive', 'recidive.factor', 'Growth factor', 'bantime.factor', 'num', 'factor'],
  ['recidive', 'recidive.maxtime', 'Longest ban', 'bantime.maxtime', 'dur', 'maxtime'],
  ['hist', 'dbpurgeage', 'History kept', 'dbpurgeage', 'dur', null],
];
const F2B_CARD = { allow: 'Allowlist', sshd: 'SSH jail', recidive: 'Repeat offenders', hist: 'History', other: 'Other options' };
function f2bConfig(serverId, f, el, { saveSettings, reload }) {
  const st = { tab: 'settings', open: new Set(['sshd']), editing: new Set(), files: null, sel: 0 };
  const A = f.settings; // applied (DockGate's file)
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // The draft is stored as a patch (only what you changed), so a value changed elsewhere meanwhile is not reverted.
  let D = clone(A); D.extra = D.extra || { DEFAULT: [], sshd: [], recidive: [] };
  const P0 = F2B_DRAFTS[serverId];
  if (P0) {
    for (const [p, v] of Object.entries(P0.fields || {})) { const k = p.split('.'); const last = k.pop(); const o = k.reduce((a, x) => a[x], D); if (o) o[last] = v; }
    D.ignoreip = D.ignoreip.filter(ip => !(P0.ipRm || []).includes(ip)).concat((P0.ipAdd || []).filter(ip => !D.ignoreip.includes(ip)));
    for (const k of P0.exRm || []) { const sec = k.split('|')[0], line = k.slice(k.indexOf('|') + 1); D.extra[sec] = (D.extra[sec] || []).filter(x => x !== line); }
    for (const k of P0.exAdd || []) { const sec = k.split('|')[0], line = k.slice(k.indexOf('|') + 1); if (!(D.extra[sec] || []).includes(line)) D.extra[sec] = [...(D.extra[sec] || []), line]; }
  }
  const RT = (f.runtime && f.runtime.jailOpts) || {}, O = f.origin || {};
  const OWN = ((f.files || [])[0] || {}).path || '/etc/fail2ban/jail.d/dockgate.conf';
  const OWND = ((f.files || [])[1] || {}).path || '/etc/fail2ban/fail2ban.d/dockgate.conf';
  const cur = Object.fromEntries((f.files || []).map(x => [x.path, x.text || '']));
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const put = (o, p, v) => { const k = p.split('.'); const last = k.pop(); k.reduce((a, x) => a[x], o)[last] = v; };
  const show = (v, t) => t === 'bool' ? (v ? 'on' : 'off') : (v == null ? '—' : String(v));
  const isDur = (v) => { const x = f2bSeconds(v); return x != null && x > 0; };
  const errOf = (fd) => {
    const v = get(D, fd[1]);
    if (fd[4] === 'int') return Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 50 && String(v).trim() !== '' ? null : '1–50';
    if (fd[4] === 'num') return Number(v) >= 0.5 && Number(v) <= 10 ? null : '0.5–10';
    if (fd[4] === 'dur') return isDur(v) ? null : 'like 30m, 24h, 1d, 1w';
    return null;
  };
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const extraLines = (s) => ['DEFAULT', 'sshd', 'recidive'].flatMap(sec => ((s.extra || {})[sec] || []).map(l => `${sec}|${l}`));
  function changes() {
    const out = [];
    for (const fd of F2B_FIELDS) { const a = get(A, fd[1]), b = get(D, fd[1]); if (!same(a, b)) out.push({ card: fd[0], text: `${F2B_CARD[fd[0]]} · ${fd[2]}: ${show(a, fd[4])} → ${show(b, fd[4])}` }); }
    for (const ip of D.ignoreip) if (!A.ignoreip.includes(ip)) out.push({ card: 'allow', text: `Allowlist: + ${ip}` });
    for (const ip of A.ignoreip) if (!D.ignoreip.includes(ip)) out.push({ card: 'allow', text: `Allowlist: − ${ip}` });
    const ea = extraLines(A), ed = extraLines(D);
    for (const l of ed) if (!ea.includes(l)) out.push({ card: 'other', text: `Other options: + [${l.split('|')[0]}] ${l.slice(l.indexOf('|') + 1)}` });
    for (const l of ea) if (!ed.includes(l)) out.push({ card: 'other', text: `Other options: − [${l.split('|')[0]}] ${l.slice(l.indexOf('|') + 1)}` });
    return out;
  }
  const errCount = (card) => F2B_FIELDS.filter(fd => (!card || fd[0] === card) && errOf(fd)).length;
  const keep = () => {
    if (!changes().length) { delete F2B_DRAFTS[serverId]; return; }
    const fields = {}; for (const fd of F2B_FIELDS) { const v = get(D, fd[1]); if (!same(v, get(A, fd[1]))) fields[fd[1]] = v; }
    const ea = extraLines(A), ed = extraLines(D);
    F2B_DRAFTS[serverId] = { fields, ipAdd: D.ignoreip.filter(ip => !A.ignoreip.includes(ip)), ipRm: A.ignoreip.filter(ip => !D.ignoreip.includes(ip)), exAdd: ed.filter(x => !ea.includes(x)), exRm: ea.filter(x => !ed.includes(x)) };
  };
  const typed = (fd, raw) => fd[4] === 'bool' ? !!raw : (fd[4] === 'int' || fd[4] === 'num') ? (String(raw).trim() !== '' && !isNaN(Number(raw)) ? Number(raw) : raw) : String(raw).trim();

  const from = (key) => {
    const file = O[key];
    if (!file) return '<span class="f2b-src">default</span>';
    if (file === OWN || file === OWND) return '<span class="f2b-src f2b-src-dg">DockGate</span>';
    return `<span class="f2b-src ${(f.overriding || []).includes(file) ? 'f2b-src-ov' : ''}" title="${escapeHtml(file)}">${escapeHtml(file.slice(file.lastIndexOf('/') + 1))}</span>`;
  };
  const runs = (fd) => {
    const jail = fd[0], rtv = jail === 'hist' ? (f.runtime && f.runtime.dbpurgeage != null ? Number(f.runtime.dbpurgeage) : null) : fd[1] === 'recidive.enabled' ? ((f.runtime && f.runtime.jails) ? (f.runtime.jails || []).includes('recidive') : null) : (fd[5] && RT[jail] ? RT[jail][fd[5]] : null);
    if (rtv == null) return '<span class="ui-sub">—</span>';
    const mine = get(A, fd[1]);
    const a = fd[4] === 'dur' ? f2bSeconds(mine) : fd[4] === 'bool' ? !!mine : Number(mine);
    const shown = fd[4] === 'dur' ? f2bHuman(rtv) : fd[4] === 'bool' ? (rtv ? 'on' : 'off') : String(rtv);
    return a === rtv || (fd[4] !== 'dur' && fd[4] !== 'bool' && Number(rtv) === a) ? '<span class="ui-sub">same</span>' : `<span class="f2b-diff">runs ${escapeHtml(shown)}</span>`;
  };
  const originKey = (fd) => fd[0] === 'hist' ? 'Definition.dbpurgeage' : `${fd[0]}.${fd[3]}`;
  function fieldRow(fd) {
    const v = get(D, fd[1]), a = get(A, fd[1]), chg = !same(v, a), ed = st.editing.has(fd[0]), err = errOf(fd);
    let input = '';
    if (ed) {
      if (fd[4] === 'bool') input = `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-f="${fd[1]}" ${v ? 'checked' : ''}> on</label>`;
      else if (fd[4] === 'mode') input = `<select class="select" data-f="${fd[1]}">${['normal', 'aggressive', 'ddos', 'extra'].map(m => `<option ${m === v ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
      else input = `<input class="input td-mono ${err ? 'f2b-bad' : ''}" data-f="${fd[1]}" value="${escapeHtml(String(v ?? ''))}" style="width:${fd[4] === 'int' || fd[4] === 'num' ? 90 : 130}px" aria-invalid="${!!err}">`;
    }
    const note = err ? `<span class="f2b-err">${escapeHtml(err)}</span>` : chg ? `<span class="ui-sub">was <s>${escapeHtml(show(a, fd[4]))}</s></span>` : runs(fd);
    return `<div class="f2b-row ${chg ? 'f2b-chg' : ''}" data-row="${fd[1]}"><div><b>${fd[2]}</b><div class="ui-sub td-mono">${fd[3]}</div></div><div class="td-mono">${ed ? input : escapeHtml(show(v, fd[4]))}</div><div class="f2b-run" data-note>${note}</div><div class="f2b-from">${from(originKey(fd))}</div></div>`;
  }
  const auto = (label, tech, val) => `<div class="f2b-row"><div><b>${label}</b><div class="ui-sub td-mono">${tech}</div></div><div class="td-mono">${escapeHtml(val)}</div><div class="f2b-run"><span class="ui-sub">same</span></div><div class="f2b-from"><span class="f2b-src">automatic</span></div></div>`;
  const head = '<div class="f2b-row f2b-rowhead"><div>Setting</div><div>Value</div><div class="f2b-run">fail2ban runs / change</div><div class="f2b-from">From</div></div>';
  const badge = (id) => { const e = errCount(id), n = changes().filter(c => c.card === id).length; return e ? UI.pill('bad', 'fix the red field') : n ? `<span class="f2b-pend">${n} change${n > 1 ? 's' : ''}</span>` : ''; };
  function cardFoot(id) {
    const n = changes().filter(c => c.card === id).length, e = errCount(id), canEdit = id !== 'allow' && id !== 'other';
    return `<div class="f2b-cardfoot"><span class="ui-sub">${n ? `${n} pending change${n > 1 ? 's' : ''} — applied with the others, or now` : ''}</span><span class="flex gap-1">${canEdit ? (st.editing.has(id) ? UI.btn('Done', `data-done="${id}"`, 'btn-ghost') : UI.btn('Edit', `data-edit="${id}"`)) : ''}${n ? UI.btn('Save this card', `data-savecard="${id}" ${e ? 'disabled' : ''}`) : ''}</span></div>`;
  }
  const card = (id, title, summary, inner) => `<details class="f2b-card ${changes().some(c => c.card === id) ? 'f2b-card-dirty' : ''}" data-card="${id}" ${st.open.has(id) ? 'open' : ''}><summary><span class="f2b-chev" aria-hidden="true">›</span><span><b>${title}</b><div class="ui-sub" data-sum="${id}">${summary}</div></span><span data-badge="${id}">${badge(id)}</span></summary>${inner}<div data-foot="${id}">${cardFoot(id)}</div></details>`;
  const seqText = (x, n) => { const q = f2bSequence(x, n); return q.some(t => t == null) ? '—' : q.map(f2bHuman).join(' → '); };
  const summary = {
    sshd: () => `${escapeHtml(String(D.sshd.maxretry))} failures within ${escapeHtml(D.sshd.findtime)} · bans ${escapeHtml(seqText(D.sshd, 5))} · ${escapeHtml(D.sshd.mode)} mode · port ${escapeHtml(String(f.sshPort))}`,
    recidive: () => (f.problems || []).some(p => /recidive (can never trigger|reads|is on in DockGate)/.test(p.text)) && !changes().some(c => c.card === 'recidive') ? '<span class="f2b-diff">does not work as set — see the warning above</span>' : D.recidive.enabled ? `${escapeHtml(String(D.recidive.maxretry))} bans within ${escapeHtml(D.recidive.findtime)} · all-port bans ${escapeHtml(D.recidive.increment ? seqText(D.recidive, 4) : D.recidive.bantime)}` : 'off',
    hist: () => `ban history kept ${escapeHtml(D.dbpurgeage)} · a first ban is remembered ~${escapeHtml(f2bHuman((f2bSeconds(D.dbpurgeage) || 0) + 3 * (f2bSeconds(D.sshd.bantime) || 0)))} · logs to /var/log/fail2ban.log`,
  };

  function settingsHtml() {
    const ips = [...new Set([...A.ignoreip, ...D.ignoreip])];
    const allow = card('allow', 'Allowlist', `${D.ignoreip.length + 2} addresses are never banned${O['DEFAULT.ignoreip'] && O['DEFAULT.ignoreip'] !== OWN ? ` · <span class="f2b-diff">replaced by ${escapeHtml(O['DEFAULT.ignoreip'])}</span>` : ''}`,
      `<div class="f2b-chips"><span class="f2b-chip f2b-chip-fixed">127.0.0.1/8</span><span class="f2b-chip f2b-chip-fixed">::1</span>${ips.map(ip => { const gone = !D.ignoreip.includes(ip), isNew = !A.ignoreip.includes(ip);
        return `<span class="f2b-chip ${isNew ? 'f2b-chip-new' : ''} ${gone ? 'f2b-chip-gone' : ''}">${escapeHtml(ip)}${ip === f.dockgateIp ? ' ' + UI.pill('info', 'DockGate') : ''}${gone ? `<button type="button" data-keepip="${escapeHtml(ip)}" title="Keep it" aria-label="Keep ${escapeHtml(ip)}">↺</button>` : `<button type="button" data-rmip="${escapeHtml(ip)}" aria-label="Remove ${escapeHtml(ip)}">×</button>`}</span>`; }).join('')}
        <span class="flex gap-1">${f.dockgateIp && !D.ignoreip.includes(f.dockgateIp) ? UI.btn("Add DockGate's IP", 'data-adddg') : ''}<input class="input td-mono" id="f2b-newip" placeholder="IP or CIDR" style="width:150px">${UI.btn('Add', 'data-addip')}</span></div>`);
    const rows = (id) => F2B_FIELDS.filter(fd => fd[0] === id).map(fieldRow).join('');
    const sshd = card('sshd', 'SSH jail (sshd)', summary.sshd(), `<div class="f2b-rows">${head}${rows('sshd')}${auto('Port', 'port', String(f.sshPort))}${auto('Log source', 'backend', 'systemd')}</div>`);
    const rec = card('recidive', 'Repeat offenders (recidive)', summary.recidive(), `<div class="f2b-rows">${head}${rows('recidive')}${auto('Reads', 'logpath', '/var/log/fail2ban.log')}</div>`);
    const hist = card('hist', 'History & log', summary.hist(), `<div class="f2b-rows">${head}${rows('hist')}${auto('Log file', 'logtarget', '/var/log/fail2ban.log')}</div><div class="ui-sub" style="padding:8px 14px">fail2ban keeps a ban in its history for <span class="td-mono">dbpurgeage + 3 × the ban</span>; an IP back within that time gets the next, longer ban.</div>`);
    const exAll = [...new Set([...extraLines(A), ...extraLines(D)])];
    const exD = extraLines(D), exA = extraLines(A);
    const other = card('other', 'Other options', `${exD.length} option${exD.length === 1 ? '' : 's'} DockGate keeps exactly as written`,
      `<div class="f2b-rows">${exAll.map(k => { const [sec, line] = [k.split('|')[0], k.slice(k.indexOf('|') + 1)], gone = !exD.includes(k), isNew = !exA.includes(k);
        return `<div class="f2b-row f2b-row2 ${gone || isNew ? 'f2b-chg' : ''}"><div class="td-mono" style="${gone ? 'text-decoration:line-through;opacity:.6' : ''}">[${sec}] ${escapeHtml(line)}</div><div style="text-align:right">${gone ? UI.btn('Keep', `data-keepx="${escapeHtml(k)}"`, 'btn-ghost') : UI.btn('Remove', `data-rmx="${escapeHtml(k)}"`, 'btn-ghost')}</div></div>`; }).join('') || '<div class="f2b-row f2b-row2"><span class="ui-sub">None. Options DockGate has no field for (bantime.rndtime, usedns, …) go here and are kept when you save.</span></div>'}
        <div class="f2b-row f2b-row2"><span class="flex gap-1" style="flex-wrap:wrap"><select class="select" id="f2b-xsec">${['DEFAULT', 'sshd', 'recidive'].map(x => `<option>${x}</option>`).join('')}</select><input class="input td-mono" id="f2b-newx" placeholder="bantime.rndtime = 30m" style="width:240px;max-width:100%"></span><span>${UI.btn('Add', 'data-addx')}</span></div></div>`);
    return allow + sshd + rec + hist + other;
  }

  function filesHtml() {
    if (!st.files) return '<div class="ui-sub">Reading the files…</div>';
    const fs = st.files, x = fs[st.sel] || fs[0];
    if (!x) return '<div class="ui-sub">No fail2ban configuration files found.</div>';
    return `<div class="f2b-files"><div class="f2b-flist">${fs.map((y, i) => `<button type="button" class="f2b-fitem" data-file="${i}" aria-current="${i === st.sel}"><span class="td-mono">${escapeHtml(y.path)}</span><span class="ui-sub">${escapeHtml(y.note)}</span></button>`).join('')}
        <div class="ui-sub" style="margin-top:6px">fail2ban reads jail.conf, jail.d/*.conf, jail.local, jail.d/*.local — a later file wins.</div></div>
      <div class="f2b-editor"><div class="f2b-ehead"><span class="td-mono">${escapeHtml(x.path)}</span>${x.editable ? UI.pill('ok', 'editable') : UI.pill('off', 'read only')}</div>
        <div class="f2b-code"><div class="f2b-gutter" data-gut></div><textarea data-ta spellcheck="false" ${x.editable ? '' : 'readonly'}>${escapeHtml(x.text)}</textarea></div>
        <div class="f2b-ehead"><span class="ui-sub">${x.editable ? 'Save shows the change, then backup → test → reload; everything is put back if the test fails.' : escapeHtml(x.note)}</span>${x.editable ? `<span class="flex gap-1">${UI.btn('Revert', 'data-revert')}${UI.primary('Save…', 'data-fsave')}</span>` : ''}</div></div></div>`;
  }

  // Review dialog for a target settings object: the change list + both file diffs; one job on confirm.
  async function review(target, list, title) {
    let pv;
    try { pv = await API.post(`/servers/${serverId}/fail2ban/preview`, { settings: target, sshPort: f.sshPort }); }
    catch (e) { showToast(e.message, 'error', 8000); return; }
    const diffs = pv.files.map(x => (cur[x.path] || '') === x.text ? '' : `<div style="display:grid;gap:4px"><span class="td-mono text-sm">${escapeHtml(x.path)}</span>${lineDiffHtml(cur[x.path] || '', x.text)}</div>`).join('');
    UI.dialog({ title, saveLabel: `Apply ${list.length} change${list.length > 1 ? 's' : ''}`, wide: true,
      body: `<div><b>${list.length} change${list.length > 1 ? 's' : ''}</b><ul class="f2b-list" style="margin-top:4px">${list.map(c => `<li>${escapeHtml(c.text)}</li>`).join('')}</ul></div>${diffs || '<div class="ui-sub">The files do not change.</div>'}
        <div class="ui-sub">One job: back up both files → write → <span class="td-mono">fail2ban-client -t</span> → reload. If the test or the reload fails, both files are put back and nothing changes. Current bans are kept.</div>`,
      onSave: () => saveSettings(target, title) });
  }

  // Bottom bar with every pending change.
  // This instance's own bar (an earlier render's bar is removed, never reused).
  document.querySelectorAll('.f2b-applybar').forEach(b => b.remove());
  const bar = document.createElement('div'); bar.className = 'f2b-applybar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Pending fail2ban changes');
  document.body.appendChild(bar);
  function drawBar() {
    const n = changes().length, e = errCount();
    bar.classList.toggle('show', st.tab === 'settings' && (n > 0 || e > 0) && document.body.contains(el));
    bar.innerHTML = `<span>${e ? `<b>${e} field${e > 1 ? 's' : ''} to fix</b> · ` : ''}<b>${n} fail2ban change${n === 1 ? '' : 's'}</b> not applied yet</span><span class="flex gap-1">${UI.btn('Discard', 'data-discard')}${UI.btn('Review & apply all', `data-applyall ${e || !n ? 'disabled' : ''}`, 'btn-primary')}</span>`;
    bar.querySelector('[data-discard]').onclick = () => { D = clone(A); D.extra = D.extra || { DEFAULT: [], sshd: [], recidive: [] }; keep(); draw(); showToast('Changes discarded'); };
    bar.querySelector('[data-applyall]').onclick = () => review(clone(D), changes(), 'Review & apply all');
  }
  // Leave the page / server → the bar goes; the draft stays for this server.
  const gone = () => { if (!document.body.contains(el)) { bar.remove(); clearInterval(watcher); window.removeEventListener('hashchange', onHash); return true; } return false; };
  const onHash = () => { bar.classList.remove('show'); setTimeout(gone, 0); };
  window.addEventListener('hashchange', onHash);
  const watcher = setInterval(gone, 500);

  // Light refresh after typing: marks, notes, badges, summaries and the bar — inputs keep focus.
  function refresh() {
    for (const fd of F2B_FIELDS) {
      const r = el.querySelector(`[data-row="${fd[1]}"]`); if (!r) continue;
      const v = get(D, fd[1]), a = get(A, fd[1]), chg = !same(v, a), err = errOf(fd);
      r.classList.toggle('f2b-chg', chg);
      const inp = r.querySelector('input.input'); if (inp) { inp.classList.toggle('f2b-bad', !!err); inp.setAttribute('aria-invalid', String(!!err)); }
      r.querySelector('[data-note]').innerHTML = err ? `<span class="f2b-err">${escapeHtml(err)}</span>` : chg ? `<span class="ui-sub">was <s>${escapeHtml(show(a, fd[4]))}</s></span>` : runs(fd);
    }
    for (const id of Object.keys(F2B_CARD)) {
      const b = el.querySelector(`[data-badge="${id}"]`); if (b) b.innerHTML = badge(id);
      const ft = el.querySelector(`[data-foot="${id}"]`); if (ft) { ft.innerHTML = cardFoot(id); }
      const c = el.querySelector(`[data-card="${id}"]`); if (c) c.classList.toggle('f2b-card-dirty', changes().some(x => x.card === id));
      if (summary[id]) { const sm = el.querySelector(`[data-sum="${id}"]`); if (sm) sm.innerHTML = summary[id](); }
    }
    keep(); drawBar(); wireFoots();
  }
  function wireFoots() {
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { st.editing.add(b.dataset.edit); st.open.add(b.dataset.edit); draw(); });
    el.querySelectorAll('[data-done]').forEach(b => b.onclick = () => { st.editing.delete(b.dataset.done); draw(); });
    el.querySelectorAll('[data-savecard]').forEach(b => b.onclick = () => {
      const id = b.dataset.savecard, t = clone(A);
      if (id === 'allow') t.ignoreip = D.ignoreip.slice();
      else if (id === 'other') t.extra = clone(D.extra);
      else F2B_FIELDS.filter(fd => fd[0] === id).forEach(fd => put(t, fd[1], get(D, fd[1])));
      review(t, changes().filter(c => c.card === id), `Save ${F2B_CARD[id]}`);
    });
  }

  function draw() {
    const allEditing = ['sshd', 'recidive', 'hist'].every(x => st.editing.has(x));
    el.innerHTML = `${UI.header('Configuration', 'Everything fail2ban runs with for SSH. Change what you need, then apply it all at once — or one card at a time. Changes are tested before they apply; current bans are kept.',
      `${st.tab === 'settings' ? UI.btn(allEditing ? 'Done editing' : 'Edit all', 'data-editall') : ''}<div class="ui-seg" role="tablist">${[['settings', 'Settings'], ['files', 'Files']].map(([k, l]) => `<button type="button" role="tab" data-ctab="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join('')}</div>`)}
      <div style="display:grid;gap:10px">${st.tab === 'settings' ? settingsHtml() : filesHtml()}</div>`;
    el.querySelectorAll('[data-ctab]').forEach(b => b.onclick = async () => {
      st.tab = b.dataset.ctab; draw();
      if (st.tab === 'files' && !st.files) {
        try { st.files = (await API.get(`/servers/${serverId}/fail2ban/files`)).files; } catch (e) { st.files = []; showToast(e.message, 'error', 8000); }
        draw();
      }
    });
    drawBar();
    if (st.tab === 'files') return wireFiles();
    el.querySelector('[data-editall]')?.addEventListener('click', () => { const all = ['sshd', 'recidive', 'hist']; if (all.every(x => st.editing.has(x))) st.editing.clear(); else all.forEach(x => { st.editing.add(x); st.open.add(x); }); st.open.add('allow'); st.open.add('other'); draw(); });
    el.querySelectorAll('details[data-card]').forEach(d => d.addEventListener('toggle', () => { if (d.open) st.open.add(d.dataset.card); else st.open.delete(d.dataset.card); }));
    el.querySelectorAll('[data-f]').forEach(i => {
      const fd = F2B_FIELDS.find(x => x[1] === i.dataset.f);
      const upd = () => { put(D, fd[1], typed(fd, i.type === 'checkbox' ? i.checked : i.value)); refresh(); };
      i.addEventListener(i.type === 'checkbox' || i.tagName === 'SELECT' ? 'change' : 'input', upd);
    });
    const val = (id) => (el.querySelector('#' + id) || {}).value || '';
    const addIp = (ip) => { if (!ip) return; if (!/^[0-9a-fA-F:.\/]+$/.test(ip) || !/[.:]/.test(ip)) return showToast('Enter an IP address or CIDR', 'error'); if (!D.ignoreip.includes(ip)) D.ignoreip.push(ip); st.open.add('allow'); keep(); draw(); };
    el.querySelector('[data-addip]')?.addEventListener('click', () => addIp(val('f2b-newip').trim()));
    el.querySelector('#f2b-newip')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addIp(val('f2b-newip').trim()); } });
    el.querySelector('[data-adddg]')?.addEventListener('click', () => addIp(f.dockgateIp));
    el.querySelectorAll('[data-rmip]').forEach(b => b.onclick = () => { D.ignoreip = D.ignoreip.filter(x => x !== b.dataset.rmip); keep(); draw(); });
    el.querySelectorAll('[data-keepip]').forEach(b => b.onclick = () => { D.ignoreip.push(b.dataset.keepip); keep(); draw(); });
    const exSet = (k, on) => { const sec = k.split('|')[0], line = k.slice(k.indexOf('|') + 1); D.extra[sec] = (D.extra[sec] || []).filter(x => x !== line); if (on) D.extra[sec].push(line); keep(); draw(); };
    el.querySelectorAll('[data-rmx]').forEach(b => b.onclick = () => exSet(b.dataset.rmx, false));
    el.querySelectorAll('[data-keepx]').forEach(b => b.onclick = () => exSet(b.dataset.keepx, true));
    el.querySelector('[data-addx]')?.addEventListener('click', () => {
      const line = val('f2b-newx').trim(), sec = val('f2b-xsec');
      if (!/^[A-Za-z][\w.]*\s*=\s*\S/.test(line)) return showToast('Write it as: option = value', 'error');
      exSet(`${sec}|${line.replace(/\s*=\s*/, ' = ')}`, true); st.open.add('other');
    });
    wireFoots();
  }
  function wireFiles() {
    el.querySelectorAll('[data-file]').forEach(b => b.onclick = () => { st.sel = Number(b.dataset.file); draw(); });
    const ta = el.querySelector('[data-ta]'), gut = el.querySelector('[data-gut]');
    if (!ta) return;
    const fit = () => { const n = ta.value.split('\n').length; gut.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); ta.style.height = `${Math.max(280, n * 19 + 24)}px`; };
    ta.addEventListener('input', fit); fit();
    el.querySelector('[data-revert]')?.addEventListener('click', () => draw());
    el.querySelector('[data-fsave]')?.addEventListener('click', () => {
      const x = st.files[st.sel], next = ta.value;
      if (next === x.text) return showToast('No change');
      UI.dialog({ title: `Save ${x.path}`, saveLabel: 'Test & save', wide: true,
        body: `<div class="ui-sub">The lines that change. On save: backup → <span class="td-mono">fail2ban-client -t</span> → reload; the previous file is put back if the test fails. Current bans are kept.</div>${lineDiffHtml(x.text, next)}`,
        onSave: async () => {
          const { jobId } = await API.post(`/servers/${serverId}/fail2ban/file`, { path: x.path, content: next, confirm: true });
          setTimeout(async () => { if (await runLifelineJob(serverId, jobId, `Save ${x.path}`)) reload(); }, 0);
        } });
    });
  }
  window.addEventListener('beforeunload', (e) => { if (F2B_DRAFTS[serverId] && document.body.contains(el)) { e.preventDefault(); e.returnValue = ''; } });
  keep(); // an applied draft (equal to the server now) is dropped here
  if (F2B_DRAFTS[serverId]) for (const c of changes()) st.open.add(c.card);
  draw();
}

// Ban history: fail2ban's log in the shared LogViewer (jail = source, Ban = warning, errors = error),
// loaded when the card is opened. "Bans only" puts a preset in the search box.
function f2bHistory(serverId, body) {
  const card = body.closest('details');
  const mount = () => {
    if (body._lv) return;
    body._lv = LogViewer.mount(body, {
      key: 'f2b-log', fileName: `fail2ban-${serverId}`, height: '50vh',
      retention: 'The server keeps this log (logrotate)', empty: 'No lines in /var/log/fail2ban.log.',
      tools: '<button type="button" class="btn btn-sm btn-secondary" data-bans aria-pressed="false" title="Show only Ban / Unban lines">Bans only</button>',
      onTools(el, v) { el.querySelector('[data-bans]').addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); v.setQuery(on ? '\\b(Ban|Unban)\\b' : '', on); }); },
      load: async (limit) => ({ text: (await API.get(`/servers/${serverId}/host/logs?file=${encodeURIComponent('/var/log/fail2ban.log')}&lines=${limit}`)).text || '' }),
    });
  };
  if (!card || card.open) mount();
  else card.addEventListener('toggle', () => { if (card.open) mount(); });
}
