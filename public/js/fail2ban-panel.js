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
    ${UI.header('Banned IPs', 'Blocked right now. They are released automatically when their time runs out.', `<input class="input" id="f2b-q" placeholder="Search IP…" style="width:180px">${UI.primary('Ban an IP', 'data-ban')}`)}
    ${UI.table([{ label: 'IP address' }, { label: 'Jail' }, { label: 'Banned' }, { label: 'Until' }, { label: '', align: 'right' }], rows.map((r, i) => `<tr data-ip="${escapeHtml(r.ip)}">
      <td><span class="td-mono" style="font-weight:600">${escapeHtml(r.ip)}</span>${r.ip === f.dockgateIp ? ' ' + UI.pill('bad', 'DockGate') : ''}</td><td>${escapeHtml(r.jail)}</td>
      <td><span class="ui-sub">${escapeHtml(r.bannedAt || '—')}</span></td><td><span class="ui-sub">${escapeHtml(r.until || '—')}${r.seconds ? ` (${escapeHtml(f2bHuman(r.seconds))})` : ''}</span></td>
      <td class="ui-td-actions">${UI.btn('Unban', `data-unban="${i}"`)}${UI.btn('Unban & allow', `data-unwl="${i}"`)}</td></tr>`), { minWidth: 640, empty: 'No IP is banned right now.' })}
    <div data-config style="margin-top:20px"></div>
    <details class="card" style="padding:0;margin-top:20px"><summary style="cursor:pointer;padding:12px 16px;font-weight:600">Ban history <span class="ui-sub" style="font-weight:400">· ${f.history.length} events from /var/log/fail2ban.log</span></summary><div style="padding:0 16px 16px" data-history></div></details>
`;

  renderServiceBar(serverId, 'fail2ban', container.querySelector('[data-bar]'), { label: 'fail2ban', note: f.version ? escapeHtml(f.version) + ' · Reload keeps current bans' : 'Reload keeps current bans', onChange: reload });
  f2bHistory(f, container.querySelector('[data-history]'));

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
  container.querySelector('#f2b-q').addEventListener('input', (e) => { const q = e.target.value.trim(); container.querySelectorAll('tr[data-ip]').forEach(tr => { tr.style.display = !q || tr.dataset.ip.includes(q) ? '' : 'none'; }); });
  const unban = async (r, whitelist) => {
    try { await API.post(`/servers/${serverId}/fail2ban/unban`, { jail: r.jail, ip: r.ip, whitelist }); showToast(`${r.ip} unbanned${whitelist ? ' and allowed' : ''}`); reload(); }
    catch (e) { showToast(e.message, 'error', 8000); }
  };
  container.querySelectorAll('[data-unban]').forEach(b => b.addEventListener('click', () => unban(rows[Number(b.dataset.unban)], false)));
  container.querySelectorAll('[data-unwl]').forEach(b => b.addEventListener('click', () => {
    const r = rows[Number(b.dataset.unwl)];
    secConfirm({ title: `Unban and allow ${escapeHtml(r.ip)}`, confirmLabel: 'Unban & allow',
      change: 'The IP is unbanned now and added to the allowlist (ignoreip) — fail2ban will never ban it again.',
      protects: 'fail2ban reloads after a configuration test; other bans are kept.', undo: 'Remove it from the Allowlist.',
      onConfirm: () => unban(r, true) });
  }));
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
 *  Settings — cards in a fixed order (Allowlist → sshd → recidive → History & log → Other options); each row shows
 *    DockGate's value, what fail2ban really runs and which file sets it; each card edits in place and shows the
 *    file change before it saves (backup → fail2ban-client -t → reload → restore on failure).
 *  Files — every fail2ban file under jail.d / fail2ban.d plus jail.local / fail2ban.local, with an editor.
 */
function f2bConfig(serverId, f, el, { saveSettings, reload }) {
  const st = { tab: 'settings', open: new Set(['sshd']), editing: null, files: null, sel: 0 };
  const S = f.settings, RT = (f.runtime && f.runtime.jailOpts) || {}, O = f.origin || {};
  const OWN = ((f.files || [])[0] || {}).path || '/etc/fail2ban/jail.d/dockgate.conf';
  const OWND = ((f.files || [])[1] || {}).path || '/etc/fail2ban/fail2ban.d/dockgate.conf';
  const cur = Object.fromEntries((f.files || []).map(x => [x.path, x.text || '']));
  const dur = (sec) => sec == null ? '—' : f2bHuman(sec);
  const from = (key) => {
    const file = O[key];
    if (!file) return '<span class="f2b-src">default</span>';
    if (file === OWN || file === OWND) return '<span class="f2b-src f2b-src-dg">DockGate</span>';
    const wins = (f.overriding || []).includes(file);
    return `<span class="f2b-src ${wins ? 'f2b-src-ov' : ''}" title="${escapeHtml(file)}">${escapeHtml(file.slice(file.lastIndexOf('/') + 1))}</span>`;
  };
  // What fail2ban runs, against DockGate's value: "same", or the running value in red.
  const runs = (rtVal, mine, fmt) => {
    if (rtVal == null) return '<span class="ui-sub">—</span>';
    const a = fmt === 'dur' ? f2bSeconds(mine) : fmt === 'bool' ? !!mine : Number(mine);
    const shown = fmt === 'dur' ? dur(rtVal) : fmt === 'bool' ? (rtVal ? 'on' : 'off') : String(rtVal);
    return a === rtVal || (fmt !== 'dur' && fmt !== 'bool' && Number(rtVal) === a) ? '<span class="ui-sub">same</span>' : `<span class="f2b-diff">runs ${escapeHtml(shown)}</span>`;
  };
  const inp = (id, v, w = 130) => `<input class="input td-mono" id="${id}" value="${escapeHtml(String(v ?? ''))}" style="width:${w}px">`;
  const chk = (id, v) => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> on</label>`;
  const row = (card, label, tech, val, edit, run, src) => `<div class="f2b-row"><div><b>${label}</b><div class="ui-sub td-mono">${tech}</div></div><div class="td-mono">${st.editing === card && edit ? edit : escapeHtml(String(val))}</div><div class="f2b-run">${run}</div><div class="f2b-from">${src}</div></div>`;
  const auto = (label, tech, val) => `<div class="f2b-row"><div><b>${label}</b><div class="ui-sub td-mono">${tech}</div></div><div class="td-mono">${escapeHtml(val)}</div><div class="f2b-run"><span class="ui-sub">same</span></div><div class="f2b-from"><span class="f2b-src">automatic</span></div></div>`;
  const head = '<div class="f2b-row f2b-rowhead"><div>Setting</div><div>Value</div><div class="f2b-run">fail2ban runs</div><div class="f2b-from">From</div></div>';
  const foot = (card) => st.editing === card
    ? `<div class="f2b-cardfoot"><span class="ui-sub">Save shows the file change first.</span><span class="flex gap-1">${UI.btn('Cancel', 'data-cancel')}${UI.primary('Save…', `data-save="${card}"`)}</span></div>`
    : `<div class="f2b-cardfoot"><span></span>${UI.btn('Edit', `data-edit="${card}"`)}</div>`;
  const card = (id, title, summary, inner, footer) => `<details class="f2b-card" data-card="${id}" ${st.open.has(id) ? 'open' : ''}><summary><span class="f2b-chev" aria-hidden="true">›</span><span><b>${title}</b><div class="ui-sub">${summary}</div></span></summary>${inner}${footer}</details>`;

  function settingsHtml() {
    const sh = S.sshd, r = S.recidive, rs = RT.sshd || {}, rr = RT.recidive || {};
    const seq = (x, n) => f2bSequence(x, n).map(f2bHuman).join(' → ');
    const allow = card('allow', 'Allowlist', `${(S.ignoreip || []).length + 2} addresses are never banned${O['DEFAULT.ignoreip'] && O['DEFAULT.ignoreip'] !== OWN ? ` · <span class="f2b-diff">replaced by ${escapeHtml(O['DEFAULT.ignoreip'])}</span>` : ''}`,
      `<div class="f2b-chips"><span class="f2b-chip f2b-chip-fixed">127.0.0.1/8</span><span class="f2b-chip f2b-chip-fixed">::1</span>${(S.ignoreip || []).map((ip, i) => `<span class="f2b-chip">${escapeHtml(ip)}${ip === f.dockgateIp ? ' ' + UI.pill('info', 'DockGate') : ''}<button type="button" data-rmip="${i}" aria-label="Remove ${escapeHtml(ip)}">×</button></span>`).join('')}</div>`,
      `<div class="f2b-cardfoot"><span class="ui-sub">Localhost is always included.${f.dockgateIp && !(S.ignoreip || []).includes(f.dockgateIp) ? ` DockGate connects from <span class="td-mono">${escapeHtml(f.dockgateIp)}</span>.` : ''}</span><span class="flex gap-1">${f.dockgateIp && !(S.ignoreip || []).includes(f.dockgateIp) ? UI.btn("Add DockGate's IP", 'data-adddg') : ''}<input class="input td-mono" id="f2b-newip" placeholder="IP or CIDR" style="width:160px">${UI.btn('Add', 'data-addip')}</span></div>`);
    const sshd = card('sshd', 'SSH jail (sshd)', `${sh.maxretry} failures within ${escapeHtml(sh.findtime)} · bans ${escapeHtml(seq(sh, 5))} · ${escapeHtml(sh.mode)} mode · port ${escapeHtml(String(f.sshPort))}`,
      `<div class="f2b-rows">${head}
        ${row('sshd', 'Failures before a ban', 'maxretry', sh.maxretry, inp('e-max', sh.maxretry, 80), runs(rs.maxretry, sh.maxretry), from('sshd.maxretry'))}
        ${row('sshd', 'Counting window', 'findtime', sh.findtime, inp('e-find', sh.findtime), runs(rs.findtime, sh.findtime, 'dur'), from('sshd.findtime'))}
        ${row('sshd', 'First ban', 'bantime', sh.bantime, inp('e-ban', sh.bantime), runs(rs.bantime, sh.bantime, 'dur'), from('sshd.bantime'))}
        ${row('sshd', 'Longer bans for repeat offenders', 'bantime.increment', sh.increment ? 'on' : 'off', chk('e-inc', sh.increment), runs(rs.increment, sh.increment, 'bool'), from('sshd.bantime.increment'))}
        ${row('sshd', 'Growth factor', 'bantime.factor', sh.factor, inp('e-fac', sh.factor, 80), runs(rs.factor, sh.factor), from('sshd.bantime.factor'))}
        ${row('sshd', 'Longest ban', 'bantime.maxtime', sh.maxtime, inp('e-maxt', sh.maxtime), runs(rs.maxtime, sh.maxtime, 'dur'), from('sshd.bantime.maxtime'))}
        ${row('sshd', 'Detection mode', 'mode', sh.mode, `<select class="select" id="e-mode">${['normal', 'aggressive', 'ddos', 'extra'].map(m => `<option ${m === sh.mode ? 'selected' : ''}>${m}</option>`).join('')}</select>`, '<span class="ui-sub">—</span>', from('sshd.mode'))}
        ${auto('Port', 'port', String(f.sshPort))}
        ${auto('Log source', 'backend', 'systemd')}
      </div>${st.editing === 'sshd' ? '<div data-live class="f2b-live"></div>' : ''}`, foot('sshd'));
    const recBad = (f.problems || []).some(p => /recidive (can never trigger|reads|is on in DockGate)/.test(p.text));
    const rec = card('recidive', 'Repeat offenders (recidive)', recBad ? '<span class="f2b-diff">does not work as set — see the warning above</span>' : r.enabled ? `${r.maxretry} bans within ${escapeHtml(r.findtime)} · all-port bans ${escapeHtml(r.increment ? seq(r, 4) : r.bantime)}` : 'off',
      `<div class="f2b-rows">${head}
        ${row('recidive', 'On', 'enabled', r.enabled ? 'on' : 'off', chk('r-en', r.enabled), (f.runtime && f.runtime.jails) ? runs((f.runtime.jails || []).includes('recidive'), r.enabled, 'bool') : '—', from('recidive.enabled'))}
        ${row('recidive', 'Bans before', 'maxretry', r.maxretry, inp('r-max', r.maxretry, 80), runs(rr.maxretry, r.maxretry), from('recidive.maxretry'))}
        ${row('recidive', 'Window', 'findtime', r.findtime, inp('r-find', r.findtime), runs(rr.findtime, r.findtime, 'dur'), from('recidive.findtime'))}
        ${row('recidive', 'Ban on all ports', 'bantime', r.bantime, inp('r-ban', r.bantime), runs(rr.bantime, r.bantime, 'dur'), from('recidive.bantime'))}
        ${row('recidive', 'Longer all-port bans', 'bantime.increment', r.increment ? 'on' : 'off', chk('r-inc', r.increment), runs(rr.increment, r.increment, 'bool'), from('recidive.bantime.increment'))}
        ${row('recidive', 'Growth factor', 'bantime.factor', r.factor ?? 2, inp('r-fac', r.factor ?? 2, 80), runs(rr.factor, r.factor), from('recidive.bantime.factor'))}
        ${row('recidive', 'Longest ban', 'bantime.maxtime', r.maxtime || '90d', inp('r-maxt', r.maxtime || '90d'), runs(rr.maxtime, r.maxtime, 'dur'), from('recidive.bantime.maxtime'))}
        ${auto('Reads', 'logpath', '/var/log/fail2ban.log')}
      </div>${st.editing === 'recidive' ? '<div data-live class="f2b-live"></div>' : ''}`, foot('recidive'));
    const purgeRun = f.runtime && f.runtime.dbpurgeage != null ? Number(f.runtime.dbpurgeage) : null;
    const hist = card('hist', 'History & log', `ban history kept ${escapeHtml(S.dbpurgeage)} · a first ban is remembered ~${escapeHtml(f.memory)} · logs to /var/log/fail2ban.log`,
      `<div class="f2b-rows">${head}
        ${row('hist', 'History kept', 'dbpurgeage', S.dbpurgeage, inp('h-purge', S.dbpurgeage), runs(purgeRun, S.dbpurgeage, 'dur'), from('Definition.dbpurgeage'))}
        ${auto('Log file', 'logtarget', '/var/log/fail2ban.log')}
      </div><div class="ui-sub" style="padding:8px 14px">fail2ban keeps a ban in its history for <span class="td-mono">dbpurgeage + 3 × the ban</span>; an IP back within that time gets the next, longer ban.</div>`, foot('hist'));
    const ex = S.extra || { DEFAULT: [], sshd: [], recidive: [] };
    const exRows = ['DEFAULT', 'sshd', 'recidive'].flatMap(sec => (ex[sec] || []).map((l, i) => `<div class="f2b-row f2b-row2"><div class="td-mono">[${sec}] ${escapeHtml(l)}</div><div style="text-align:right">${UI.btn('Remove', `data-rmx="${sec}:${i}"`, 'btn-ghost')}</div></div>`));
    const other = card('other', 'Other options', `${exRows.length} option${exRows.length === 1 ? '' : 's'} DockGate keeps exactly as written`,
      `<div class="f2b-rows">${exRows.join('') || '<div class="f2b-row f2b-row2"><span class="ui-sub">None. Options DockGate has no field for (bantime.rndtime, usedns, …) go here and are kept when you save.</span></div>'}</div>`,
      `<div class="f2b-cardfoot"><span class="ui-sub">Any fail2ban option; tested before it applies.</span><span class="flex gap-1"><select class="select" id="f2b-xsec">${['DEFAULT', 'sshd', 'recidive'].map(x => `<option>${x}</option>`).join('')}</select><input class="input td-mono" id="f2b-newx" placeholder="bantime.rndtime = 30m" style="width:200px">${UI.btn('Add', 'data-addx')}</span></div>`);
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

  async function confirmChange(next, title) {
    let pv;
    try { pv = await API.post(`/servers/${serverId}/fail2ban/preview`, { settings: next, sshPort: f.sshPort }); }
    catch (e) { showToast(e.message, 'error', 8000); return; }
    const body = pv.files.map(x => `<div style="display:grid;gap:4px"><span class="td-mono text-sm">${escapeHtml(x.path)}</span>${(cur[x.path] || '') === x.text ? '<div class="ui-sub">No change.</div>' : lineDiffHtml(cur[x.path] || '', x.text)}</div>`).join('');
    UI.dialog({ title, saveLabel: 'Test & save', wide: true, body: `<div class="ui-sub">The lines that change. On save: backup → <span class="td-mono">fail2ban-client -t</span> → reload. If the test fails, the previous files are put back. Current bans are kept.</div>${body}`,
      onSave: () => saveSettings(next, title) });
  }
  const clone = () => JSON.parse(JSON.stringify(S));

  function draw() {
    el.innerHTML = `${UI.header('Configuration', 'Everything fail2ban runs with for SSH, in one place. Changes are tested before they apply; current bans are kept.',
      `<div class="ui-seg" role="tablist">${[['settings', 'Settings'], ['files', 'Files']].map(([k, l]) => `<button type="button" role="tab" data-ctab="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join('')}</div>`)}
      <div style="display:grid;gap:10px">${st.tab === 'settings' ? settingsHtml() : filesHtml()}</div>`;
    el.querySelectorAll('[data-ctab]').forEach(b => b.onclick = async () => {
      st.tab = b.dataset.ctab; draw();
      if (st.tab === 'files' && !st.files) {
        try { st.files = (await API.get(`/servers/${serverId}/fail2ban/files`)).files; } catch (e) { st.files = []; showToast(e.message, 'error', 8000); }
        draw();
      }
    });
    if (st.tab === 'files') return wireFiles();
    el.querySelectorAll('details[data-card]').forEach(d => d.addEventListener('toggle', () => { if (d.open) st.open.add(d.dataset.card); else st.open.delete(d.dataset.card); }));
    const v = (id) => (el.querySelector('#' + id) || {}).value, c = (id) => !!(el.querySelector('#' + id) || {}).checked;
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { st.editing = b.dataset.edit; st.open.add(st.editing); draw(); });
    el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { st.editing = null; draw(); });
    const readCard = (id) => {
      const n = clone();
      if (id === 'sshd') Object.assign(n.sshd, { maxretry: Number(v('e-max')), findtime: v('e-find').trim(), bantime: v('e-ban').trim(), increment: c('e-inc'), factor: Number(v('e-fac')), maxtime: v('e-maxt').trim(), mode: v('e-mode') });
      if (id === 'recidive') Object.assign(n.recidive, { enabled: c('r-en'), maxretry: Number(v('r-max')), findtime: v('r-find').trim(), bantime: v('r-ban').trim(), increment: c('r-inc'), factor: Number(v('r-fac')), maxtime: v('r-maxt').trim() });
      if (id === 'hist') n.dbpurgeage = v('h-purge').trim();
      return n;
    };
    // live "what one IP gets" while editing sshd / recidive
    const live = el.querySelector('[data-live]');
    if (live) { const upd = () => { live.innerHTML = f2bPreviewHtml(readCard(st.editing)); }; el.querySelectorAll(`[data-card="${st.editing}"] input, [data-card="${st.editing}"] select`).forEach(i => { i.addEventListener('input', upd); i.addEventListener('change', upd); }); upd(); }
    el.querySelectorAll('[data-save]').forEach(b => b.onclick = () => confirmChange(readCard(b.dataset.save), { sshd: 'Fail2ban · sshd', recidive: 'Fail2ban · recidive', hist: 'Fail2ban · history' }[b.dataset.save]));
    el.querySelectorAll('[data-rmip]').forEach(b => b.onclick = () => { const n = clone(); const ip = n.ignoreip.splice(Number(b.dataset.rmip), 1)[0]; confirmChange(n, `Remove ${ip} from the allowlist`); });
    const addIp = (ip) => { if (!ip) return; const n = clone(); if (n.ignoreip.includes(ip)) return showToast('Already in the allowlist'); n.ignoreip.push(ip); confirmChange(n, `Add ${ip} to the allowlist`); };
    el.querySelector('[data-addip]')?.addEventListener('click', () => addIp(v('f2b-newip').trim()));
    el.querySelector('[data-adddg]')?.addEventListener('click', () => addIp(f.dockgateIp));
    el.querySelectorAll('[data-rmx]').forEach(b => b.onclick = () => { const [sec, i] = b.dataset.rmx.split(':'); const n = clone(); n.extra = n.extra || { DEFAULT: [], sshd: [], recidive: [] }; const line = n.extra[sec].splice(Number(i), 1)[0]; confirmChange(n, `Remove ${line}`); });
    el.querySelector('[data-addx]')?.addEventListener('click', () => {
      const line = v('f2b-newx').trim(), sec = v('f2b-xsec');
      if (!/^[A-Za-z][\w.]*\s*=\s*\S/.test(line)) return showToast('Write it as: option = value', 'error');
      const n = clone(); n.extra = n.extra || { DEFAULT: [], sshd: [], recidive: [] }; n.extra[sec] = [...(n.extra[sec] || []), line];
      confirmChange(n, `Add [${sec}] ${line}`);
    });
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
  draw();
}

function f2bHistory(f, body) {
  body.innerHTML = UI.table([{ label: 'Time' }, { label: 'Jail' }, { label: 'Event' }, { label: 'IP' }], f.history.map(h => ({ cells: [
    `<span class="ui-sub">${escapeHtml(h.time)}</span>`, escapeHtml(h.jail), `<span style="color:${/Unban/.test(h.action) ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:12px">${escapeHtml(h.action)}</span>`, `<span class="td-mono">${escapeHtml(h.ip)}</span>`,
  ] })), { minWidth: 520, empty: 'No ban events in /var/log/fail2ban.log' });
}
