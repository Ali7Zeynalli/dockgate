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
  const jailRows = [
    { name: 'sshd', on: true, maxretry: f.settings.sshd.maxretry, findtime: f.settings.sshd.findtime, bantime: f.settings.sshd.bantime, inc: f.settings.sshd.increment ? `×${f.settings.sshd.factor} per repeat, up to ${f.settings.sshd.maxtime}` : 'off' },
    { name: 'recidive', on: !!f.settings.recidive.enabled, maxretry: f.settings.recidive.maxretry, findtime: f.settings.recidive.findtime, bantime: f.settings.recidive.bantime, inc: 'all ports' },
    ...f.jails.filter(j => j.name !== 'sshd' && j.name !== 'recidive').map(j => ({ name: j.name, on: true, maxretry: j.maxretry, findtime: f2bHuman(j.findtime), bantime: f2bHuman(j.bantime), inc: '—', other: true })),
  ];

  container.innerHTML = `
    <div data-bar style="margin-bottom:12px"></div>
    ${f.problems.length ? `<div style="display:grid;gap:8px;margin-bottom:12px">${f.problems.map((p, i) => `
      <div class="insight-card ${LV[p.level]}" style="justify-content:space-between;margin:0"><span>${escapeHtml(p.text)}</span>${p.fix ? `<button class="btn btn-xs btn-secondary" data-fix="${i}" style="flex:none">${p.fix === 'start' ? 'Start fail2ban' : 'Fix now'}</button>` : ''}</div>`).join('')}</div>` : ''}
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
    ${UI.header('Allowlist', `Never banned (<span class="td-mono">ignoreip</span>). Localhost is always included.${f.dockgateIp ? ` DockGate connects from <span class="td-mono">${escapeHtml(f.dockgateIp)}</span>.` : ''}`, `${f.dockgateIp && !allow.includes(f.dockgateIp) ? UI.btn("Add DockGate's IP", 'data-adddg') : ''}${UI.primary('Add address', 'data-addallow')}`)}
    ${UI.table([{ label: 'IP / range' }, { label: '' , align: 'right' }], allow.map((ip, i) => ({ cells: [`<span class="td-mono">${escapeHtml(ip)}</span>${ip === f.dockgateIp ? ' ' + UI.pill('info', 'DockGate') : ''}`, UI.btn('Remove', `data-rmallow="${i}"`, 'btn-danger')] })), { minWidth: 420, empty: 'Empty — every address can be banned.' })}
    ${UI.header('Jails', 'What fail2ban watches and how hard it bans.')}
    ${!f.managed ? '<div class="insight-card info" style="margin-bottom:8px"><div>fail2ban runs on its own/default settings. Saving a jail writes DockGate\'s files (/etc/fail2ban/jail.d/dockgate.conf and fail2ban.d/dockgate.conf).</div></div>' : ''}
    ${UI.table([{ label: 'Jail' }, { label: 'Status' }, { label: 'Failures' }, { label: 'Within' }, { label: 'First ban' }, { label: 'Repeat bans' }, { label: 'Now' }, { label: '', align: 'right' }], jailRows.map(j => { const l = live(j.name); return { cells: [
      `<b>${escapeHtml(j.name)}</b>${j.name === 'sshd' ? `<div class="ui-sub">port ${escapeHtml(String(f.sshPort))} · ${escapeHtml(f.settings.sshd.mode)} mode</div>` : ''}`,
      l ? UI.pill('ok', 'Running') : (j.on ? UI.pill('warn', 'Not running') : UI.pill('off', 'Off')),
      escapeHtml(String(j.maxretry ?? '—')), escapeHtml(String(j.findtime ?? '—')), escapeHtml(String(j.bantime ?? '—')), `<span class="ui-sub">${escapeHtml(j.inc)}</span>`,
      l ? `<span class="ui-sub">${l.currentlyFailed} failing · ${l.currentlyBanned} banned · ${l.totalBanned} total</span>` : '<span class="ui-sub">—</span>',
      j.other ? '<span class="ui-sub">edit in jail.local</span>' : UI.btn('Edit', `data-jail="${j.name}"`),
    ] }; }), { minWidth: 820 })}
    <details class="card" style="padding:0;margin-top:20px"><summary style="cursor:pointer;padding:12px 16px;font-weight:600">Ban history <span class="ui-sub" style="font-weight:400">· ${f.history.length} events from /var/log/fail2ban.log</span></summary><div style="padding:0 16px 16px" data-history></div></details>
    <div data-raw style="margin-top:16px"></div>`;

  renderServiceBar(serverId, 'fail2ban', container.querySelector('[data-bar]'), { label: 'fail2ban', note: f.version ? escapeHtml(f.version) + ' · Reload keeps current bans' : 'Reload keeps current bans', onChange: reload });
  renderRawConfig(serverId, 'fail2ban', '/etc/fail2ban/jail.local', container.querySelector('[data-raw]'), { label: 'jail.local', hint: 'jail.local is read AFTER DockGate\'s file — anything set here wins over the Jails table.' });
  f2bHistory(f, container.querySelector('[data-history]'));

  const saveSettings = async (settings, title) => {
    const { jobId } = await API.post(`/servers/${serverId}/fail2ban/settings`, { settings, confirm: true });
    setTimeout(async () => { if (await runLifelineJob(serverId, jobId, title || 'Fail2ban settings')) reload(); }, 0);
  };
  container.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', async () => {
    const p = f.problems[Number(b.dataset.fix)];
    try {
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
  const saveAllow = (list, title) => saveSettings({ ...f.settings, ignoreip: list }, title).catch(e => showToast(e.message, 'error', 8000));
  container.querySelector('[data-adddg]')?.addEventListener('click', () => saveAllow([...allow, f.dockgateIp], "Allow DockGate's IP"));
  container.querySelector('[data-addallow]').addEventListener('click', () => UI.dialog({
    title: 'Add to allowlist', saveLabel: 'Add',
    body: `<div class="ui-field"><label for="al-ip">IP address or range</label><input class="input td-mono" id="al-ip" placeholder="198.51.100.24 or 10.0.0.0/24"><span class="ui-help">fail2ban is reloaded after a configuration test; current bans are kept.</span></div>`,
    onSave: (ov) => { const v = ov.querySelector('#al-ip').value.trim(); if (!v) throw new Error('Enter an IP address or range'); if (allow.includes(v)) return; return saveSettings({ ...f.settings, ignoreip: [...allow, v] }, 'Fail2ban allowlist'); },
  }));
  container.querySelectorAll('[data-rmallow]').forEach(b => b.addEventListener('click', () => {
    const ip = allow[Number(b.dataset.rmallow)];
    secConfirm({ title: `Remove ${escapeHtml(ip)} from the allowlist`, danger: true, confirmLabel: 'Remove',
      change: 'fail2ban may ban this address again after repeated failures.', protects: ip === f.dockgateIp ? 'This is DockGate\'s own address — a ban would cut DockGate off. DockGate refuses manual bans of it, but fail2ban itself could still ban it.' : 'Nothing else changes.', undo: 'Add it again.',
      onConfirm: () => saveAllow(allow.filter(x => x !== ip), 'Fail2ban allowlist') });
  }));
  container.querySelectorAll('[data-jail]').forEach(b => b.addEventListener('click', () => f2bJailDialog(f, b.dataset.jail, saveSettings)));
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
  }
  return `<div class="ui-explain"><div><b>What one IP gets</b> ${seq.map((t, i) => `${i + 1}. ${f2bHuman(t)}`).join(' → ')}</div><div>A first ban is remembered for about ${f2bHuman(purge + 3 * seq[0])}; after that the IP starts again at ${f2bHuman(seq[0])}.</div></div>${rec}`;
}

function f2bJailDialog(f, name, saveSettings) {
  const s = JSON.parse(JSON.stringify(f.settings));
  const inp = (id, v, label, help) => `<div class="ui-field"><label for="${id}">${label}</label><input class="input" id="${id}" value="${escapeHtml(String(v))}" style="width:110px">${help ? `<span class="ui-help">${help}</span>` : ''}</div>`;
  const body = name === 'sshd' ? `
      <div class="ui-row">${inp('s-maxretry', s.sshd.maxretry, 'Failures before a ban', 'maxretry')}${inp('s-findtime', s.sshd.findtime, 'Counting window', 'findtime, e.g. 1h, 1d')}${inp('s-bantime', s.sshd.bantime, 'First ban', 'bantime, e.g. 24h')}</div>
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="s-inc" ${s.sshd.increment ? 'checked' : ''}> Longer bans for repeat offenders <span class="ui-sub">bantime.increment</span></label>
      <div class="ui-row">${inp('s-factor', s.sshd.factor, 'Growth factor', 'first ban × 2^n × factor')}${inp('s-maxtime', s.sshd.maxtime, 'Longest ban', 'e.g. 30d')}${inp('s-purge', s.dbpurgeage, 'History kept', 'dbpurgeage')}</div>
      <div class="ui-field"><label for="s-mode">Detection mode</label><select class="select" id="s-mode">${['normal', 'aggressive', 'ddos', 'extra'].map(m => `<option ${m === s.sshd.mode ? 'selected' : ''}>${m}</option>`).join('')}</select><span class="ui-help">aggressive also counts key probes and pre-auth disconnects — useful when password login is off. The jail always bans the port SSH listens on (${escapeHtml(String(f.sshPort))}).</span></div>`
    : `
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="r-en" ${s.recidive.enabled ? 'checked' : ''}> Enabled — when one IP is banned this many times inside the window, it is blocked on every port</label>
      <div class="ui-row">${inp('r-maxretry', s.recidive.maxretry, 'Bans before', 'maxretry')}${inp('r-findtime', s.recidive.findtime, 'Window', 'findtime — longer than those bans take')}${inp('r-bantime', s.recidive.bantime, 'Ban on all ports', 'bantime')}</div>`;
  UI.dialog({
    title: `Jail · ${name}`, saveLabel: 'Test & save', wide: true,
    body: `${body}<div data-preview></div>`,
    onOpen: (ov) => {
      const preview = () => { ov.querySelector('[data-preview]').innerHTML = f2bPreviewHtml(read(ov)); };
      ov.querySelectorAll('input,select').forEach(i => { i.addEventListener('input', preview); i.addEventListener('change', preview); });
      preview();
    },
    onSave: (ov) => saveSettings(read(ov), `Fail2ban · ${name}`),
  });
  function read(ov) {
    const v = (id, d) => { const el = ov.querySelector('#' + id); return el ? el.value.trim() : d; };
    const on = (id, d) => { const el = ov.querySelector('#' + id); return el ? el.checked : d; };
    return {
      sshd: { maxretry: Number(v('s-maxretry', s.sshd.maxretry)), findtime: v('s-findtime', s.sshd.findtime), bantime: v('s-bantime', s.sshd.bantime), increment: on('s-inc', s.sshd.increment), factor: Number(v('s-factor', s.sshd.factor)), maxtime: v('s-maxtime', s.sshd.maxtime), mode: v('s-mode', s.sshd.mode) },
      recidive: { enabled: on('r-en', s.recidive.enabled), maxretry: Number(v('r-maxretry', s.recidive.maxretry)), findtime: v('r-findtime', s.recidive.findtime), bantime: v('r-bantime', s.recidive.bantime) },
      ignoreip: s.ignoreip || [], dbpurgeage: v('s-purge', s.dbpurgeage),
    };
  }
}

function f2bHistory(f, body) {
  body.innerHTML = UI.table([{ label: 'Time' }, { label: 'Jail' }, { label: 'Event' }, { label: 'IP' }], f.history.map(h => ({ cells: [
    `<span class="ui-sub">${escapeHtml(h.time)}</span>`, escapeHtml(h.jail), `<span style="color:${/Unban/.test(h.action) ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:12px">${escapeHtml(h.action)}</span>`, `<span class="td-mono">${escapeHtml(h.ip)}</span>`,
  ] })), { minWidth: 520, empty: 'No ban events in /var/log/fail2ban.log' });
}
