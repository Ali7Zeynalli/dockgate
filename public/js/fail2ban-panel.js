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

async function renderFail2banPanel(serverId, container, sub) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let f;
  try { f = await API.get(`/servers/${serverId}/fail2ban`); }
  catch (e) { return secError(container, "Couldn't read fail2ban", e, () => renderFail2banPanel(serverId, container, sub)); }
  const reload = (tab) => renderFail2banPanel(serverId, container, tab || active);
  if (!f.installed) {
    container.innerHTML = `<div class="card" style="border-left:3px solid var(--warning)"><div style="font-weight:700;font-size:15px">fail2ban is not installed</div><div class="text-sm text-muted" style="margin-top:4px">Install it in <b>Setup → Fail2ban</b>. DockGate writes a working configuration (sshd jail on the real SSH port, ban history, recidive).</div><button class="btn btn-primary btn-sm" data-setup style="margin-top:10px">Open Setup</button></div>`;
    container.querySelector('[data-setup]').addEventListener('click', () => document.querySelector('#con-tabs .tab-btn[data-ctab="setup"]')?.click());
    return;
  }
  const tabs = [['banned', 'Banned IPs'], ['whitelist', 'Whitelist'], ['settings', 'Settings'], ['history', 'History']];
  let active = tabs.some(t => t[0] === sub) ? sub : 'banned';
  const LV = { crit: ['var(--danger)', 'danger'], warn: ['var(--warning)', 'warning'], info: ['var(--info)', 'info'] };
  const totalBanned = f.jails.reduce((n, j) => n + j.currentlyBanned, 0);

  container.innerHTML = `
    <div data-bar style="margin-bottom:12px"></div>
    ${f.problems.length ? `<div style="display:grid;gap:8px;margin-bottom:14px">${f.problems.map((p, i) => `
      <div class="insight-card ${LV[p.level][1]}" style="justify-content:space-between;margin:0"><span>${escapeHtml(p.text)}</span>${p.fix ? `<button class="btn btn-xs btn-secondary" data-fix="${i}" style="flex:none">${p.fix === 'start' ? 'Start fail2ban' : 'Fix now'}</button>` : ''}</div>`).join('')}</div>` : ''}
    <div class="grid-4" style="margin-bottom:16px">
      ${f.jails.map(j => `<div class="card"><div class="text-xs text-muted" style="text-transform:uppercase;font-weight:600;letter-spacing:.04em">${escapeHtml(j.name)}</div><div style="font-weight:700;font-size:20px;margin-top:4px">${j.currentlyBanned} <span class="text-sm text-muted" style="font-weight:500">banned now</span></div><div class="text-xs text-muted">${j.totalBanned} total · ${j.currentlyFailed} failing now</div></div>`).join('') || '<div class="card text-sm text-muted">No jails are running</div>'}
      <div class="card"><div class="text-xs text-muted" style="text-transform:uppercase;font-weight:600;letter-spacing:.04em">Ban lengths</div><div class="text-sm" style="margin-top:6px">${escapeHtml(f.sequence.slice(0, 5).join(' → '))}</div><div class="text-xs text-muted">1st → 5th ban of one IP · remembered ~${escapeHtml(f.memory)}</div></div>
    </div>
    <div class="tab-bar" id="f2b-tabs">${tabs.map(([v, l]) => `<button class="tab-btn ${v === active ? 'active' : ''}" data-f2b="${v}">${l}${v === 'banned' && totalBanned ? ` (${totalBanned})` : ''}</button>`).join('')}</div>
    <div id="f2b-body"></div>
    <div data-raw style="margin-top:16px"></div>`;

  renderServiceBar(serverId, 'fail2ban', container.querySelector('[data-bar]'), { label: 'fail2ban', note: f.version ? escapeHtml(f.version) + ' · Reload keeps current bans' : 'Reload keeps current bans', onChange: () => reload() });
  renderRawConfig(serverId, 'fail2ban', '/etc/fail2ban/jail.local', container.querySelector('[data-raw]'), { label: 'jail.local', hint: 'jail.local is read AFTER DockGate\'s file — anything set here wins over the Settings tab.' });

  const saveSettings = async (settings, title) => {
    try {
      const { jobId } = await API.post(`/servers/${serverId}/fail2ban/settings`, { settings, confirm: true });
      const ok = await runLifelineJob(serverId, jobId, title || 'Fail2ban settings');
      if (ok) reload();
    } catch (e) { showToast(e.message, 'error', 8000); }
  };
  container.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', async () => {
    const p = f.problems[Number(b.dataset.fix)];
    if (p.fix === 'start') { try { await API.post(`/servers/${serverId}/services/fail2ban/action`, { action: 'start', confirm: true }); showToast('fail2ban started'); reload(); } catch (e) { showToast(e.message, 'error', 8000); } }
    else saveSettings(f.settings, 'Fix fail2ban settings');
  }));

  const body = container.querySelector('#f2b-body');
  const show = (v) => {
    active = v;
    container.querySelectorAll('#f2b-tabs .tab-btn').forEach(x => x.classList.toggle('active', x.dataset.f2b === v));
    if (v === 'banned') f2bBanned(serverId, f, body, reload);
    else if (v === 'whitelist') f2bWhitelist(f, body, saveSettings);
    else if (v === 'settings') f2bSettings(f, body, saveSettings);
    else f2bHistory(f, body);
  };
  container.querySelector('#f2b-tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-btn'); if (b) show(b.dataset.f2b); });
  show(active);
}

function f2bBanned(serverId, f, body, reload) {
  const rows = f.jails.flatMap(j => j.banned.map(b => ({ ...b, jail: j.name })));
  body.innerHTML = `
    <div class="flex gap-1 items-center" style="margin-bottom:10px;flex-wrap:wrap">
      <input class="input" id="f2b-q" placeholder="Search IP…" style="width:220px">
      <span style="flex:1"></span>
      <form data-ban class="flex gap-1 items-center" style="flex-wrap:wrap">
        <select class="select" id="f2b-jail">${f.jails.map(j => `<option ${j.name === 'sshd' ? 'selected' : ''}>${escapeHtml(j.name)}</option>`).join('')}</select>
        <input class="input" id="f2b-ip" placeholder="IP to ban, e.g. 203.0.113.4" style="width:200px">
        <button class="btn btn-sm btn-danger" type="submit">Ban IP</button>
      </form>
    </div>
    <div class="table-wrapper"><table>
      <thead><tr><th>IP</th><th>Jail</th><th>Banned at</th><th>Until</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => `<tr data-ip="${escapeHtml(r.ip)}">
        <td class="td-mono" style="font-weight:600">${escapeHtml(r.ip)}${r.ip === f.dockgateIp ? ' <span class="badge badge-stopped">DockGate</span>' : ''}</td>
        <td>${escapeHtml(r.jail)}</td>
        <td class="text-xs text-muted">${escapeHtml(r.bannedAt || '—')}</td>
        <td class="text-xs">${escapeHtml(r.until || '—')}${r.seconds ? ` <span class="text-muted">(${escapeHtml(f2bHuman(r.seconds))})</span>` : ''}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-xs btn-secondary" data-unban="${i}">Unban</button> <button class="btn btn-xs btn-secondary" data-unwl="${i}">Unban + whitelist</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="text-sm text-muted">No IP is banned right now.</td></tr>'}</tbody>
    </table></div>
    ${f.dockgateIp ? `<div class="text-xs text-muted" style="margin-top:6px">DockGate connects from <span class="td-mono">${escapeHtml(f.dockgateIp)}</span> (as this server sees it).</div>` : ''}`;
  body.querySelector('#f2b-q').addEventListener('input', (e) => { const q = e.target.value.trim(); body.querySelectorAll('tbody tr[data-ip]').forEach(tr => { tr.style.display = !q || tr.dataset.ip.includes(q) ? '' : 'none'; }); });
  const unban = async (r, whitelist) => {
    try { await API.post(`/servers/${serverId}/fail2ban/unban`, { jail: r.jail, ip: r.ip, whitelist }); showToast(`${r.ip} unbanned${whitelist ? ' and whitelisted' : ''}`); reload('banned'); }
    catch (e) { showToast(e.message, 'error', 8000); }
  };
  body.querySelectorAll('[data-unban]').forEach(b => b.addEventListener('click', () => unban(rows[Number(b.dataset.unban)], false)));
  body.querySelectorAll('[data-unwl]').forEach(b => b.addEventListener('click', () => {
    const r = rows[Number(b.dataset.unwl)];
    secConfirm({
      title: `Unban and whitelist ${escapeHtml(r.ip)}`, confirmLabel: 'Unban + whitelist',
      change: 'The IP is unbanned now and added to the whitelist (ignoreip) — fail2ban will never ban it again.',
      protects: 'fail2ban reloads after a configuration test; other bans are kept.',
      undo: 'Remove it in the Whitelist tab.',
      onConfirm: () => unban(r, true),
    });
  }));
  body.querySelector('[data-ban]').addEventListener('submit', (e) => {
    e.preventDefault();
    const jail = body.querySelector('#f2b-jail').value, ip = body.querySelector('#f2b-ip').value.trim();
    secConfirm({
      title: `Ban ${escapeHtml(ip)}`, danger: true, confirmLabel: 'Ban',
      change: `The IP is blocked in the "${escapeHtml(jail)}" jail for that jail's ban time.`,
      protects: 'DockGate refuses to ban the IP it connects from.',
      undo: '"Unban" in this list.',
      onConfirm: async () => {
        try { await API.post(`/servers/${serverId}/fail2ban/ban`, { jail, ip }); showToast(`${ip} banned`); reload('banned'); }
        catch (er) { showToast(er.message, 'error', 8000); }
      },
    });
  });
}

function f2bWhitelist(f, body, saveSettings) {
  const list = [...(f.settings.ignoreip || [])];
  const render = () => {
    body.innerHTML = `
      <div class="card">
        <div style="font-weight:700;font-size:15px">Never ban these addresses</div>
        <div class="text-sm text-muted" style="margin:4px 0 12px">Written as <span class="td-mono">ignoreip</span> in DockGate's jail file. Localhost is always included.</div>
        <div style="display:grid;gap:6px;margin-bottom:12px">${list.length ? list.map((ip, i) => `<div class="flex items-center justify-between" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px"><span class="td-mono">${escapeHtml(ip)}${ip === f.dockgateIp ? ' <span class="badge" style="background:var(--accent-dim);color:var(--accent)">DockGate</span>' : ''}</span><button class="btn btn-xs btn-secondary" data-rm="${i}">Remove</button></div>`).join('') : '<div class="text-sm text-muted">Empty — every address can be banned.</div>'}</div>
        <form data-add class="flex gap-1 items-center" style="flex-wrap:wrap">
          <input class="input" id="wl-ip" placeholder="IP or CIDR, e.g. 198.51.100.24 or 10.0.0.0/24" style="width:300px">
          <button class="btn btn-sm btn-secondary" type="submit">Add</button>
          ${f.dockgateIp && !list.includes(f.dockgateIp) ? `<button class="btn btn-sm btn-secondary" type="button" data-dg>Add DockGate's IP (${escapeHtml(f.dockgateIp)})</button>` : ''}
        </form>
        <button class="btn btn-sm btn-primary" data-save style="margin-top:14px">Save whitelist</button>
      </div>`;
    body.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { list.splice(Number(b.dataset.rm), 1); render(); }));
    body.querySelector('[data-add]').addEventListener('submit', (e) => { e.preventDefault(); const v = body.querySelector('#wl-ip').value.trim(); if (v && !list.includes(v)) list.push(v); render(); });
    body.querySelector('[data-dg]')?.addEventListener('click', () => { list.push(f.dockgateIp); render(); });
    body.querySelector('[data-save]').addEventListener('click', () => saveSettings({ ...f.settings, ignoreip: list }, 'Fail2ban whitelist'));
  };
  render();
}

function f2bSettings(f, body, saveSettings) {
  const s = JSON.parse(JSON.stringify(f.settings));
  const row = (label, desc, input) => `<div class="settings-row" style="padding:8px 0"><div><div class="settings-row-label">${label}</div><div class="settings-row-desc">${desc}</div></div>${input}</div>`;
  const inp = (id, v, w) => `<input class="input" id="${id}" value="${escapeHtml(String(v))}" style="width:${w || 90}px">`;
  const tog = (id, on) => `<div class="toggle ${on ? 'active' : ''}" id="${id}" role="switch" tabindex="0"></div>`;
  body.innerHTML = `
    ${!f.managed ? '<div class="insight-card info" style="margin-bottom:12px">fail2ban currently runs on its own/default settings. Saving writes DockGate\'s files (/etc/fail2ban/jail.d/dockgate.conf and fail2ban.d/dockgate.conf); the values below are DockGate\'s starting point.</div>' : ''}
    <div class="grid-2">
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px">SSH jail</div>
        ${row('Failures before a ban', 'maxretry', inp('s-maxretry', s.sshd.maxretry))}
        ${row('Counting window', 'findtime — failures older than this are forgotten (e.g. 1h, 1d)', inp('s-findtime', s.sshd.findtime))}
        ${row('First ban', 'bantime (e.g. 24h)', inp('s-bantime', s.sshd.bantime))}
        ${row('Longer bans for repeat offenders', 'bantime.increment', tog('s-inc', s.sshd.increment))}
        ${row('Growth factor', 'each repeat: first ban × 2^n × factor', inp('s-factor', s.sshd.factor))}
        ${row('Longest ban', 'bantime.maxtime (e.g. 30d)', inp('s-maxtime', s.sshd.maxtime))}
        ${row('History kept', 'dbpurgeage — how long repeat offenders are remembered', inp('s-purge', s.dbpurgeage))}
        ${row('Detection mode', 'aggressive also counts key probes and pre-auth disconnects — useful when password login is off', `<select class="select" id="s-mode">${['normal', 'aggressive', 'ddos', 'extra'].map(m => `<option ${m === s.sshd.mode ? 'selected' : ''}>${m}</option>`).join('')}</select>`)}
        <div class="text-xs text-muted" style="margin-top:8px">The jail always bans the port SSH really listens on (${escapeHtml(String(f.sshPort))}).</div>
      </div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px">recidive — repeat offenders on ALL ports</div>
        <div class="text-sm text-muted" style="margin-bottom:6px">Reads fail2ban's own log. When one IP is banned this many times inside the window, it is blocked on every port.</div>
        ${row('Enabled', '', tog('r-en', s.recidive.enabled))}
        ${row('Bans before', 'maxretry', inp('r-maxretry', s.recidive.maxretry))}
        ${row('Window', 'findtime — must be longer than the time those bans take (see below)', inp('r-findtime', s.recidive.findtime))}
        ${row('Ban on all ports', 'bantime', inp('r-bantime', s.recidive.bantime))}
        <div data-preview style="margin-top:12px"></div>
      </div>
    </div>
    <button class="btn btn-primary" data-save style="margin-top:14px">Test &amp; save (reload keeps current bans)</button>`;
  body.querySelectorAll('.toggle').forEach(t => { const fl = () => { t.classList.toggle('active'); preview(); }; t.addEventListener('click', fl); t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fl(); } }); });
  const read = () => {
    const v = (id) => body.querySelector('#' + id).value.trim();
    const on = (id) => body.querySelector('#' + id).classList.contains('active');
    return {
      sshd: { maxretry: Number(v('s-maxretry')), findtime: v('s-findtime'), bantime: v('s-bantime'), increment: on('s-inc'), factor: Number(v('s-factor')), maxtime: v('s-maxtime'), mode: body.querySelector('#s-mode').value },
      recidive: { enabled: on('r-en'), maxretry: Number(v('r-maxretry')), findtime: v('r-findtime'), bantime: v('r-bantime') },
      ignoreip: f.settings.ignoreip || [], dbpurgeage: v('s-purge'),
    };
  };
  const preview = () => {
    const x = read();
    const el = body.querySelector('[data-preview]');
    const seq = f2bSequence(x.sshd, 6);
    if (seq.some(t => t == null)) { el.innerHTML = '<div class="text-xs" style="color:var(--danger)">Use durations like 30m, 24h, 1d, 1w.</div>'; return; }
    const purge = f2bSeconds(x.dbpurgeage) || 0;
    let rec = '';
    if (x.recidive.enabled) {
      const need = seq.slice(0, Math.max(0, x.recidive.maxretry - 1)).reduce((a, b) => a + b, 0);
      const win = f2bSeconds(x.recidive.findtime);
      rec = win != null && need >= win
        ? `<div class="insight-card danger" style="margin-top:8px">recidive can never trigger: ${x.recidive.maxretry} bans take at least ${f2bHuman(need)}, the window is ${f2bHuman(win)}.</div>`
        : `<div class="text-xs" style="color:var(--success);margin-top:8px">✓ recidive can trigger: the ${x.recidive.maxretry}th ban comes after at least ${f2bHuman(need)} — inside the ${f2bHuman(win)} window.</div>`;
    }
    el.innerHTML = `<div class="text-xs text-muted" style="font-weight:600;text-transform:uppercase;letter-spacing:.04em">What one IP gets</div>
      <div class="text-sm" style="margin-top:4px">${seq.map((t, i) => `${i + 1}. ${f2bHuman(t)}`).join(' → ')}</div>
      <div class="text-xs text-muted" style="margin-top:4px">A first ban is remembered for about ${f2bHuman(purge + 3 * seq[0])}; after that the IP starts again at ${f2bHuman(seq[0])}.</div>${rec}`;
  };
  body.querySelectorAll('input,select').forEach(i => i.addEventListener('input', preview));
  preview();
  body.querySelector('[data-save]').addEventListener('click', () => saveSettings(read()));
}

function f2bHistory(f, body) {
  body.innerHTML = `<div class="table-wrapper"><table>
    <thead><tr><th>Time</th><th>Jail</th><th>Event</th><th>IP</th></tr></thead>
    <tbody>${f.history.length ? f.history.map(h => `<tr><td class="text-xs text-muted">${escapeHtml(h.time)}</td><td>${escapeHtml(h.jail)}</td><td><span style="color:${/Unban/.test(h.action) ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:12px">${escapeHtml(h.action)}</span></td><td class="td-mono">${escapeHtml(h.ip)}</td></tr>`).join('') : '<tr><td colspan="4" class="text-sm text-muted">No ban events in /var/log/fail2ban.log</td></tr>'}</tbody>
  </table></div>`;
}
