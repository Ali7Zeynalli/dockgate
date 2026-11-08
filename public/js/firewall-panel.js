// Server Console → Firewall, laid out like cloud firewalls (Hetzner / GCP): an Inbound and an Outbound
// table, one row per rule (Description · Sources/Destinations · Protocol · Port · Action), each rule
// edited on its own; the default policy is the last row of each table (as in Azure NSGs); IP lists work
// like AWS prefix lists. The backend (server/routes/firewall.js) enforces every safety rule; this file
// renders and explains. Uses ui-kit.js, server-security.js (secConfirm, secError, runLifelineJob) and
// service-pages.js (renderServiceBar, renderRawConfig).

async function renderFirewallPanel(serverId, container) {
  container.innerHTML = `<div class="card"><div class="skeleton" style="width:100%;height:160px"></div></div>`;
  let f, lists;
  try { [f, lists] = await Promise.all([API.get(`/servers/${serverId}/firewall`), API.get('/firewall-lists').then(r => r.lists || []).catch(() => [])]); }
  catch (e) { return secError(container, "Couldn't read the firewall", e, () => renderFirewallPanel(serverId, container)); }
  const reload = () => renderFirewallPanel(serverId, container);
  const warnToast = (r) => (r && r.warnings || []).forEach(w => showToast(w, 'warning', 12000));
  const isFwd = f.backend === 'firewalld';
  const ctx = { serverId, f, lists, reload, warnToast };

  // ---------- banners: firewall off · Docker ports skip the firewall · firewalld note
  let banner = '';
  if (!f.active) {
    banner = `<div class="card" style="border-left:3px solid var(--danger);margin-bottom:14px"><div class="flex justify-between items-center" style="gap:12px;flex-wrap:wrap"><div style="min-width:0;flex:1"><div style="font-weight:700;font-size:15px;color:var(--danger)">The firewall is off — every listening port is reachable from the internet</div><div class="text-sm text-muted" style="margin-top:4px">Turning it on blocks all incoming traffic except SSH (${f.sshPort}/tcp) and, if you keep them, 80 and 443. DockGate tests a new SSH login and switches it off again by itself if that fails.</div></div><button class="btn btn-danger" data-ufwon>Turn the firewall on</button></div></div>`;
  } else if (f.bypass.length && !isFwd) {
    banner = `<div class="card" style="border-left:3px solid var(--danger);margin-bottom:14px"><div class="flex justify-between items-center" style="flex-wrap:wrap;gap:12px"><div style="min-width:0;flex:1"><div style="font-weight:700;font-size:15px;color:var(--danger)">${f.bypass.length} container port${f.bypass.length === 1 ? ' is' : 's are'} open to the internet despite UFW</div><div class="text-sm text-muted" style="margin-top:4px;max-width:72ch">Docker writes its own iptables rules, so ports published with <span class="td-mono">-p</span> skip UFW. Turn on Docker port isolation: containers keep talking to each other and to this server, but only the ports you allow are reachable from outside.</div></div><button class="btn btn-danger" data-iso>Turn on Docker port isolation</button></div></div>`;
  } else if (isFwd) {
    banner = `<div class="insight-card ${f.bypass.length ? 'warning' : 'info'}" style="margin-bottom:14px"><div>This server uses firewalld (zone <b>${UI.esc(f.zone || '?')}</b>). Inbound rules are managed in that zone and saved permanently; outbound rules and Docker port isolation need UFW.${f.bypass.length ? ` <b>${f.bypass.length} container port${f.bypass.length === 1 ? '' : 's'}</b> published by Docker skip firewalld — publish them on 127.0.0.1 if they should stay private.` : ''}</div></div>`;
  }

  // ---------- status line
  const status = f.active ? UI.statusLine([
    UI.pill('ok', `● ${isFwd ? 'firewalld' : 'UFW'} on`),
    !isFwd ? `<b>Docker ports</b> <span class="text-muted">${f.dockerIsolation ? 'behind the firewall' : 'skip the firewall'}</span>${f.dockerIsolation ? ` · <a href="#" data-iso-off style="color:var(--text-secondary)">turn off isolation</a>` : ''}` : '',
    `<b>IPv6</b> <span class="text-muted">${f.ipv6 ? 'managed' : 'off in /etc/default/ufw'}</span>`,
    `<b>SSH</b> <span class="text-muted">${f.sshPort}/tcp${f.dockgateIp ? ` · DockGate connects from <span class="td-mono">${UI.esc(f.dockgateIp)}</span>` : ''}</span>`,
  ], `${UI.btn('Reload', 'data-ufwreload', 'btn-ghost')}${f.ufwActive ? UI.btn('Turn off…', 'data-ufwoff', 'btn-ghost') : ''}`) : '';

  const cols = (addrLabel) => [{ label: 'Description' }, { label: addrLabel }, { label: 'Protocol' }, { label: 'Port' }, { label: 'Action' }, { label: '', align: 'right' }];
  const ruleRows = (list, dir) => list.map((g, i) => ({ cells: [
    `<b>${UI.esc(g.description || fwAutoName(g))}</b><div class="ui-sub">${[g.usedBy ? UI.esc(g.usedBy) : '', g.container ? `container port ${g.container}${g.hostPort && g.hostPort !== g.container ? ` · host ${g.hostPort}` : ''}` : '', g.containers ? 'also containers' : '', g.isSsh ? 'SSH · DockGate keeps itself allowed' : ''].filter(Boolean).join(' · ')}</div>`,
    `<div class="ui-chips">${g.sources.map(s => fwChip(s, lists, f.dockgateIp)).join('')}</div>${g.outdated && g.outdated.length ? `<div class="ui-sub" style="color:var(--warning)">${g.outdated.map(id => UI.esc((lists.find(l => l.id === id) || {}).name || id)).join(', ')} changed — <a href="#" data-edit="${dir}:${i}">update this rule</a></div>` : ''}<div class="ui-sub">${g.family || ''}${g.addressCount ? ` · ${g.addressCount} address${g.addressCount === 1 ? '' : 'es'}` : ''}</div>`,
    (g.proto || 'any').toUpperCase(),
    `<span class="td-mono">${g.port || 'any'}</span>`,
    fwAction(g.action),
    `${UI.btn('Edit', `data-edit="${dir}:${i}"`)}${UI.btn('Delete', `data-del="${dir}:${i}"`, 'btn-danger')}`,
  ] }));
  const defaultRow = (dir) => ({ cls: 'ui-row-default', cells: [
    'Default <div class="ui-sub">everything no rule above matches</div>',
    `<div class="ui-chips">${UI.chip('Any IPv4')}${UI.chip('Any IPv6')}</div>`, 'ALL', '<span class="td-mono">any</span>',
    fwAction(f.defaults[dir === 'in' ? 'incoming' : 'outgoing']),
    f.ufwActive ? UI.btn('Change', `data-default="${dir === 'in' ? 'incoming' : 'outgoing'}"`) : '<span class="ui-sub">zone default</span>',
  ] });

  container.innerHTML = `
    <div data-svcbar style="margin-bottom:12px"></div>
    ${banner}${status}
    ${f.managed ? `
      ${UI.header('Inbound rules', 'Traffic coming to this server. Anything not allowed here is blocked.', UI.primary('Add rule', 'data-add="in"'))}
      ${UI.table(cols('Sources'), [...ruleRows(f.inbound, 'in'), defaultRow('in')], { minWidth: 760 })}
      ${f.idle.length ? `<div class="ui-sub" style="margin-top:8px">Listening with no rule — reachable only inside the server: ${f.idle.map((p, i) => `<span class="td-mono">${p.port}/${p.proto}</span> ${UI.esc(p.usedBy)} <a href="#" data-idle="${i}">allow…</a>`).join(' · ')}</div>` : ''}
      ${UI.header('Outbound rules', isFwd ? 'Outbound filtering needs UFW.' : 'Traffic leaving this server. Allowed unless a rule here denies it.', isFwd ? '' : UI.primary('Add rule', 'data-add="out"'))}
      ${isFwd ? '' : UI.table(cols('Destinations'), [...ruleRows(f.outbound, 'out'), defaultRow('out')], { minWidth: 760 })}
      <div data-iplists></div>
      <details class="card" style="padding:0;margin-top:20px"><summary style="cursor:pointer;padding:12px 16px;font-weight:600">Advanced <span class="text-xs text-muted" style="font-weight:400">· raw ${isFwd ? 'firewalld' : 'UFW'} entries${f.locked.length ? ` · ${f.locked.length} DockGate cannot show as rules` : ''}</span></summary>
        <div style="padding:0 16px 16px">
          ${f.locked.length ? `<div class="text-sm" style="margin-bottom:8px">These entries do not fit the rule table (${[...new Set(f.locked.map(l => l.reason))].map(UI.esc).join('; ')}). They still work; delete them here if they are not needed.</div>` : ''}
          ${UI.table([{ label: '#' }, { label: 'To' }, { label: 'Action' }, { label: 'From' }, { label: '', align: 'right' }], f.rules.map(r => ({ cells: [
            `<span class="text-muted">${r.n}</span>`, `<span class="td-mono">${UI.esc(r.to)}</span>${r.v6 ? ' <span class="ui-sub">v6</span>' : ''}`, UI.esc(`${r.action} ${r.dir || ''}`), `${UI.esc(r.from)}${r.note ? ` <span class="ui-sub">· ${UI.esc(r.note)}</span>` : ''}`,
            UI.btn('Delete', `data-delraw="${r.n}"`, 'btn-danger'),
          ] })), { minWidth: 560, empty: 'No entries' })}
          <div data-rawcfg style="margin-top:12px"></div>
        </div></details>` : ''}`;

  renderServiceBar(serverId, 'firewall', container.querySelector('[data-svcbar]'), { label: 'Firewall service', onChange: reload });
  if (f.backend === 'ufw' && f.managed) renderRawConfig(serverId, 'firewall', '/etc/default/ufw', container.querySelector('[data-rawcfg]'), { label: '/etc/default/ufw', high: true });
  if (f.managed) renderIpLists(container.querySelector('[data-iplists]'), lists, reload);

  const pick = (v) => { const [dir, i] = v.split(':'); return (dir === 'in' ? f.inbound : f.outbound)[Number(i)]; };
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); openFwRuleDialog(ctx, pick(b.dataset.edit)); }));
  container.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => openFwRuleDialog(ctx, null, { dir: b.dataset.add })));
  container.querySelectorAll('[data-idle]').forEach(b => b.addEventListener('click', (e) => {
    e.preventDefault(); const p = f.idle[Number(b.dataset.idle)];
    openFwRuleDialog(ctx, null, { dir: 'in', proto: p.proto, port: String(p.container ? p.containerPort : p.port), container: p.container ? p.containerPort : null, description: p.usedBy.replace(/ \(container\)$/, '') });
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const g = pick(b.dataset.del);
    secConfirm({
      title: `Delete ${g.dir === 'in' ? 'inbound' : 'outbound'} rule`, danger: true, confirmLabel: 'Delete rule',
      change: `"${UI.esc(g.description || fwAutoName(g))}" is removed — ${g.addressCount || g.sources.length} firewall entr${(g.addressCount || g.sources.length) === 1 ? 'y' : 'ies'}.${g.dir === 'in' ? ' The port stays reachable inside the server.' : ''}`,
      protects: g.isSsh ? 'DockGate refuses the change if it would lose SSH, and tests a new login afterwards.' : 'fail2ban bans and running containers are checked afterwards.',
      undo: 'Add the rule again.',
      onConfirm: () => fwSave(ctx, { original: g.key, sources: [] }, 'Rule deleted'),
    });
  }));
  container.querySelectorAll('[data-default]').forEach(b => b.addEventListener('click', () => openFwDefaultDialog(ctx, b.dataset.default)));
  container.querySelectorAll('[data-delraw]').forEach(b => b.addEventListener('click', () => secConfirm({
    title: `Delete entry #${b.dataset.delraw}`, danger: true, confirmLabel: 'Delete entry',
    change: isFwd ? 'The entry is removed from the permanent firewalld configuration and firewalld is reloaded.' : 'This one UFW entry is removed (its IPv6 twin is a separate entry).',
    protects: 'DockGate refuses to delete an entry it needs for SSH. fail2ban bans and running containers are checked afterwards.',
    undo: 'Add the rule again in the tables above.',
    onConfirm: async () => { try { const r = await API.del(`/servers/${serverId}/firewall/rules/${b.dataset.delraw}`); showToast('Entry deleted'); warnToast(r); reload(); } catch (e) { showToast(e.message, 'error', 8000); } },
  })));

  // ---------- firewall on/off, reload, Docker isolation (unchanged behaviour)
  container.querySelector('[data-ufwreload]')?.addEventListener('click', () => secConfirm({
    title: 'Reload firewall rules', confirmLabel: 'Reload',
    change: isFwd ? 'firewalld re-reads its permanent configuration. Rules added only at runtime (not with --permanent) are dropped.' : 'UFW re-reads its saved rules (including the Docker isolation rules).',
    protects: 'Open connections, including SSH, stay up. Afterwards DockGate checks that fail2ban still holds its bans and that no container stopped.',
    undo: 'Nothing to undo — the saved rules are applied as they are.',
    onConfirm: async () => { try { const r = await API.post(`/servers/${serverId}/firewall/reload`, { confirm: true }); showToast('Firewall reloaded'); warnToast(r); reload(); } catch (e) { showToast(e.message, 'error', 8000); } },
  }));
  container.querySelector('[data-ufwon]')?.addEventListener('click', () => UI.dialog({
    title: 'Turn the firewall on', saveLabel: 'Turn on', danger: true,
    body: `${UI.explain('UFW is switched on: incoming connections are blocked unless a rule allows them. Outgoing traffic is not affected.', `SSH (${f.sshPort}/tcp) is allowed before switching on. DockGate then opens a new SSH login; if it fails, the firewall is switched off again (and on the server itself after 120 s if DockGate loses contact).`)}
      <label class="flex items-center gap-2"><input type="checkbox" id="ufw-web" checked> Keep web traffic open (80/tcp, 443/tcp)</label>`,
    onSave: async (ov) => {
      const { jobId } = await API.post(`/servers/${serverId}/firewall/ufw`, { enable: true, allowWeb: ov.querySelector('#ufw-web').checked, confirm: true });
      setTimeout(async () => { if (jobId && await runLifelineJob(serverId, jobId, 'Switch the firewall on')) showToast('Firewall on'); reload(); }, 0);
    },
  }));
  container.querySelector('[data-ufwoff]')?.addEventListener('click', () => secConfirm({
    title: 'Turn the firewall off', danger: true, confirmLabel: 'Turn off',
    change: 'UFW is switched off. Every listening port becomes reachable from the internet; Docker port isolation stops working.',
    protects: 'Nothing is locked out by this — SSH stays reachable. fail2ban bans and running containers are checked afterwards.',
    undo: 'Turn the firewall on again here; your rules are kept.',
    onConfirm: async () => { try { const r = await API.post(`/servers/${serverId}/firewall/ufw`, { enable: false, confirm: true }); showToast('Firewall off', 'warning'); warnToast(r); reload(); } catch (er) { showToast(er.message, 'error', 8000); } },
  }));
  const runIsolation = async (enable, keepPublic) => {
    try {
      const { jobId } = await API.post(`/servers/${serverId}/firewall/docker-isolation`, { enable, keepPublic, confirm: true });
      if (await runLifelineJob(serverId, jobId, enable ? 'Docker port isolation' : 'Turn off Docker port isolation')) showToast(enable ? 'Docker port isolation on' : 'Docker port isolation off');
      reload();
    } catch (e) { showToast(e.message, 'error', 8000); }
  };
  container.querySelector('[data-iso]')?.addEventListener('click', () => UI.dialog({
    title: 'Turn on Docker port isolation', saveLabel: 'Turn on isolation', danger: true,
    body: `<div class="text-sm" style="color:var(--text-secondary)">After this, container ports are closed to the internet unless a rule allows them. Inside the server nothing changes. Choose which of these currently public ports should <b>stay</b> public:</div>
      <div style="display:grid;gap:6px">${f.bypass.map(p => `<label class="flex items-center gap-2" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer"><input type="checkbox" value="${p.port}/${p.proto}" ${[80, 443].includes(p.port) ? 'checked' : ''}><span class="td-mono" style="font-weight:600;min-width:72px">${p.port}/${p.proto}</span><span class="text-sm">${UI.esc(p.usedBy)}</span>${p.containerPort !== p.port ? `<span class="ui-sub">→ :${p.containerPort}</span>` : ''}</label>`).join('')}</div>
      <div class="ui-sub">Web traffic (80/443) is ticked by default. When UFW manages IPv6, the same rules are written for IPv6 too.</div>`,
    onSave: (ov) => { const keep = [...ov.querySelectorAll('input[type=checkbox]:checked')].map(x => x.value); setTimeout(() => runIsolation(true, keep), 0); },
  }));
  container.querySelector('[data-iso-off]')?.addEventListener('click', (e) => {
    e.preventDefault();
    secConfirm({ title: 'Turn off Docker port isolation', change: 'The DOCKER-USER rules are removed. Every published container port becomes reachable from the internet again.', protects: 'SSH is tested with a new connection; on failure the previous rules come back.', undo: 'Turn isolation on again here.', danger: true, confirmLabel: 'Turn off', onConfirm: () => runIsolation(false, []) });
  });
}

// ---------------------------------------------------------------- shared bits
const FW_PORT_NAMES = { 22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 443: 'HTTPS', 3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 27017: 'MongoDB', 8080: 'HTTP alt', 9100: 'Node exporter' };
function fwAutoName(g) {
  const svc = g.port && !g.port.includes('-') ? FW_PORT_NAMES[Number(g.port)] : null;
  const what = svc || (g.port ? `Port ${g.port}` : 'All ports');
  return g.dir === 'out' ? `${g.action === 'deny' ? 'Block' : 'Allow'} ${what} out` : what;
}
function fwAction(a) {
  return a === 'deny' ? '<span style="color:var(--danger);font-weight:700;font-size:12.5px">Deny</span>'
    : a === 'limit' ? '<span style="color:var(--warning);font-weight:700;font-size:12.5px" title="Allowed, at most 6 new connections per 30 s per address">Limit</span>'
    : '<span style="color:var(--success);font-weight:700;font-size:12.5px">Allow</span>';
}
function fwChip(s, lists, dockgateIp, removable) {
  const rm = removable ? s : null;
  if (s === 'any4') return UI.chip('Any IPv4', { tone: 'any', remove: rm });
  if (s === 'any6') return UI.chip('Any IPv6', { tone: 'any', remove: rm });
  if (s === '@dockgate') return UI.chip("DockGate's IP", { tone: 'me', title: dockgateIp || '', remove: rm });
  if (s[0] === '@') { const l = lists.find(y => y.id === s.slice(1)); return UI.chip(`${UI.esc(l ? l.name : s.slice(1))}${l ? ' · ' + l.items.length : ''}`, { tone: s === '@cloudflare' ? 'cf' : 'list', remove: rm }); }
  return UI.chip(UI.esc(s), { mono: true, remove: rm });
}
async function fwSave(ctx, body, okText) {
  try {
    const r = await API.post(`/servers/${ctx.serverId}/firewall/rule`, body);
    if (r.jobId) { if (await runLifelineJob(ctx.serverId, r.jobId, 'Firewall rule')) showToast(okText); }
    else { showToast(okText); ctx.warnToast(r); }
    ctx.reload();
  } catch (e) { showToast(e.message, 'error', 9000); }
}

// ---------------------------------------------------------------- one rule (add / edit)
function openFwRuleDialog(ctx, g, preset = {}) {
  const { f, lists } = ctx;
  const editing = !!g;
  const r = editing
    ? { dir: g.dir, action: g.action, proto: g.proto || 'any', port: g.port || '', containers: !!g.containers, container: g.container, description: g.description || '' }
    : { dir: 'in', action: 'allow', proto: 'tcp', port: '', containers: false, container: null, description: '', ...preset };
  if (!editing && r.dir === 'out') r.action = preset.action || 'deny';
  let sources = editing ? g.sources.slice() : (r.dir === 'out' ? ['any4', 'any6'] : []);
  let note = '', hint = null, seq = 0;
  const isIn = () => r.dir === 'in';
  const official = lists.filter(l => l.kind === 'official');
  const d = UI.dialog({
    title: `${editing ? 'Edit' : 'Add'} ${r.dir === 'in' ? 'inbound' : 'outbound'} rule`, saveLabel: editing ? 'Save rule' : 'Add rule', wide: true,
    body: '<div data-form style="display:grid;gap:14px"></div><div data-preview></div>',
    onSave: async () => {
      const res = await API.post(`/servers/${ctx.serverId}/firewall/rule`, payload(false));
      setTimeout(async () => {
        if (res.jobId) { if (await runLifelineJob(ctx.serverId, res.jobId, 'Firewall rule')) showToast('Rule saved'); }
        else { showToast(res.applied ? 'Rule saved' : 'No change'); ctx.warnToast(res); }
        ctx.reload();
      }, 0);
    },
  });
  const ov = d.overlay, form = ov.querySelector('[data-form]'), prev = ov.querySelector('[data-preview]');
  const payload = (dryRun) => {
    const desc = form.querySelector('#fr-desc'), port = form.querySelector('#fr-port');
    if (desc) r.description = desc.value;
    if (port) r.port = port.value.trim();
    return { original: editing ? g.key : null, rule: { ...r, proto: r.proto === 'any' ? null : r.proto }, sources, dryRun };
  };
  const preview = async () => {
    const my = ++seq;
    if (!sources.length && !editing) { prev.innerHTML = `<div class="ui-sub">Add at least one ${isIn() ? 'source' : 'destination'}.</div>`; d.save.disabled = true; return; }
    prev.innerHTML = '<div class="ui-sub">Checking…</div>';
    try {
      const res = await API.post(`/servers/${ctx.serverId}/firewall/rule`, payload(true));
      if (my !== seq) return;
      d.save.disabled = !res.commands.length && !editing;
      prev.innerHTML = `<div class="text-xs">${res.commands.length ? `<b style="color:var(--success)">+${res.add.length}</b> · <b style="color:var(--danger)">−${res.remove.length}</b> firewall entries${res.family ? ' · ' + res.family : ''}${res.ssh ? ' · SSH rule: a new login is tested, rollback after 120 s if it fails' : ''}` : 'No firewall change' + (editing ? ' (the description is saved)' : '')}</div>
        ${res.commands.length ? `<details style="margin-top:6px"><summary class="text-xs text-muted" style="cursor:pointer">Commands (${res.commands.length})</summary><pre class="td-mono" style="font-size:11.5px;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;background:var(--bg-input);border-radius:8px;white-space:pre-wrap">${UI.esc(res.commands.map(c => c.replace(/\{\{S\}\}/g, '').replace(/ >\/dev\/null$/, '')).join('\n'))}</pre></details>` : ''}`;
    } catch (e) { if (my !== seq) return; d.save.disabled = true; prev.innerHTML = `<div class="insight-card danger"><div>${UI.esc(e.message)}</div></div>`; }
  };
  const draw = () => {
    const portLocked = editing && r.container;
    form.innerHTML = `
      <div class="ui-field"><label for="fr-desc">Description</label><input class="input" id="fr-desc" maxlength="80" placeholder="${isIn() ? 'Web (HTTPS)' : 'Block outgoing mail'}" value="${UI.esc(r.description)}"></div>
      <div class="ui-field"><span class="ui-label">${isIn() ? 'Sources' : 'Destinations'} <span class="ui-sub" style="font-weight:400">· IPv4 and IPv6</span></span>
        <div class="ui-chips">${sources.length ? sources.map(s => fwChip(s, lists, f.dockgateIp, true)).join('') : `<span class="ui-sub">${isIn() ? 'No sources yet — the port stays closed to the outside.' : 'No destinations yet.'}</span>`}</div>
        <div class="flex gap-1" style="flex-wrap:wrap">
          ${['any4', 'any6'].map(a => UI.btn(`+ ${a === 'any4' ? 'Any IPv4' : 'Any IPv6'}`, `data-addsrc="${a}" ${sources.includes(a) ? 'disabled' : ''}`)).join('')}
          ${f.dockgateIp ? UI.btn("+ DockGate's IP", `data-addsrc="@dockgate" ${sources.includes('@dockgate') ? 'disabled' : ''}`) : ''}
          ${lists.filter(l => l.items.length).map(l => UI.btn(`+ ${UI.esc(l.name)}`, `data-addsrc="@${l.id}" ${sources.includes('@' + l.id) ? 'disabled' : ''}`)).join('')}
        </div>
        ${note ? `<div class="ui-sub" style="color:var(--info)">${note}</div>` : ''}
        ${hint ? `<div class="insight-card warning" style="font-size:13px"><div>These are exactly <b>${UI.esc(hint.name)}</b>'s official ranges. Use the ${UI.esc(hint.name)} list instead: when it changes, the rule is updated with one click.<div class="flex gap-1" style="margin-top:8px;flex-wrap:wrap">${UI.btn(`Use the ${UI.esc(hint.name)} list`, `data-uselist="${hint.id}"`, 'btn-primary')}${UI.btn('Keep separate addresses', 'data-keepips')}</div></div></div>` : ''}
        <textarea class="input" id="fr-paste" rows="2" placeholder="Paste IP addresses or ranges — one per line, or separated by spaces or commas." style="font-family:var(--font-mono);font-size:12.5px;width:100%;resize:vertical"></textarea>
        <div class="flex justify-between items-center" style="gap:8px;flex-wrap:wrap"><span class="ui-sub">Ctrl+Enter adds</span>${UI.btn('Add addresses', 'data-paste')}</div><div data-perr class="text-xs" style="color:var(--danger)"></div></div>
      <div class="ui-row">
        <div class="ui-field"><label for="fr-proto">Protocol</label><select class="select" id="fr-proto" ${portLocked ? 'disabled' : ''}>${['tcp', 'udp', 'any'].map(p => `<option value="${p}" ${r.proto === p ? 'selected' : ''}>${p === 'any' ? 'Any' : p.toUpperCase()}</option>`).join('')}</select></div>
        <div class="ui-field"><label for="fr-port">Port</label><input class="input" id="fr-port" style="width:150px" placeholder="443 or 8000-8100" value="${UI.esc(r.port)}" ${portLocked ? 'disabled' : ''}><span class="ui-help">${r.container ? 'container port' : 'empty = every port'}</span></div>
        <div class="ui-field"><span class="ui-label">Action</span><div class="ui-seg">${['allow', 'deny'].concat(r.action === 'limit' ? ['limit'] : []).map(a => `<button type="button" data-act="${a}" aria-pressed="${r.action === a}">${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</div></div>
      </div>
      ${!isIn() ? `<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="fr-cont" ${r.containers ? 'checked' : ''} ${f.dockerIsolation ? '' : 'disabled'}> Containers too <span class="ui-sub">${f.dockerIsolation ? '— Docker traffic leaves through a separate path; this adds the same rule for it' : '— needs Docker port isolation'}</span></label>` : ''}
      ${!isIn() && r.action === 'allow' && f.defaults.outgoing === 'allow' ? '<div class="insight-card info" style="font-size:13px"><div>Outgoing traffic is already allowed by default. An Allow rule only matters as an exception to a Deny rule.</div></div>' : ''}
      ${!isIn() && r.action === 'deny' && !r.port && sources.includes('any4') ? '<div class="insight-card warning" style="font-size:13px"><div>This blocks every outgoing connection: updates, Docker image pulls, DNS, time sync, certificates and DockGate alerts stop. Incoming SSH keeps working.</div></div>' : ''}`;
    const keep = () => { r.description = form.querySelector('#fr-desc').value; r.port = form.querySelector('#fr-port').value.trim(); };
    form.querySelectorAll('[data-addsrc]').forEach(b => b.onclick = () => { keep(); sources.push(b.dataset.addsrc); hint = null; draw(); });
    form.querySelectorAll('[data-chip-remove]').forEach(b => b.onclick = () => { keep(); sources = sources.filter(s => s !== b.dataset.chipRemove); hint = null; draw(); });
    form.querySelectorAll('[data-act]').forEach(b => b.onclick = () => { keep(); r.action = b.dataset.act; draw(); });
    form.querySelector('#fr-proto').onchange = (e) => { keep(); r.proto = e.target.value; draw(); };
    form.querySelector('#fr-port').onchange = () => { keep(); draw(); };
    form.querySelector('#fr-desc').oninput = () => { r.description = form.querySelector('#fr-desc').value; };
    const cont = form.querySelector('#fr-cont'); if (cont) cont.onchange = () => { r.containers = cont.checked; preview(); };
    form.querySelector('[data-uselist]')?.addEventListener('click', () => { keep(); const l = hint; sources = sources.filter(s => !l.items.includes(s)); if (!sources.includes('@' + l.id)) sources.push('@' + l.id); note = `Replaced ${l.items.length} addresses with the ${UI.esc(l.name)} list.`; hint = null; draw(); });
    form.querySelector('[data-keepips]')?.addEventListener('click', () => { hint = null; draw(); });
    const paste = async () => {
      keep();
      try {
        const res = await API.post('/firewall-lists/parse', { text: form.querySelector('#fr-paste').value });
        if (res.invalid.length) { form.querySelector('[data-perr]').textContent = `Not an IP address or range: ${res.invalid.slice(0, 6).join(', ')}${res.invalid.length > 6 ? ' …' : ''}`; return; }
        const fresh = [];
        for (const v of res.valid) { const s = v === '0.0.0.0/0' ? 'any4' : v === '::/0' ? 'any6' : v; if (!sources.includes(s)) { sources.push(s); fresh.push(s); } }
        const n6 = fresh.filter(v => v === 'any6' || (v !== 'any4' && v.includes(':'))).length;
        note = fresh.length ? `Added ${fresh.length}: ${fresh.length - n6} IPv4 + ${n6} IPv6.${res.valid.length > fresh.length ? ` ${res.valid.length - fresh.length} were already there.` : ''}` : 'All of these are already there.';
        hint = official.find(l => l.items.length && l.items.every(x => sources.includes(x))) || null;
        draw();
      } catch (e) { form.querySelector('[data-perr]').textContent = e.message; }
    };
    form.querySelector('[data-paste]').onclick = paste;
    form.querySelector('#fr-paste').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); paste(); } });
    preview();
  };
  draw();
}

// ---------------------------------------------------------------- default policy
function openFwDefaultDialog(ctx, direction) {
  const cur = ctx.f.defaults[direction];
  let policy = cur;
  UI.dialog({
    title: `Default for ${direction} traffic`, saveLabel: 'Save', danger: true,
    body: `<div class="ui-field"><span class="ui-label">Traffic no rule matches is</span><div class="ui-seg" data-seg><button type="button" data-p="deny" aria-pressed="${cur === 'deny'}">Denied</button><button type="button" data-p="allow" aria-pressed="${cur === 'allow'}">Allowed</button></div></div>
      ${direction === 'incoming'
        ? UI.explain('Allowing incoming by default opens every listening port to the internet. Denying is the safe default.', 'Denying is refused unless a rule keeps SSH reachable for DockGate.')
        : UI.explain('Denying outgoing by default stops updates, Docker image pulls, DNS, time sync, certificates and DockGate alerts unless you add Allow rules for them.', 'Incoming SSH keeps working either way.')}`,
    onOpen: (ov) => ov.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { policy = b.dataset.p; ov.querySelectorAll('[data-p]').forEach(x => x.setAttribute('aria-pressed', x === b)); }),
    onSave: async () => {
      if (policy === cur) return;
      const r = await API.post(`/servers/${ctx.serverId}/firewall/default`, { direction, policy, confirm: true });
      showToast(`Default ${direction}: ${policy}`); ctx.warnToast(r); ctx.reload();
    },
  });
}

// ---------------------------------------------------------------- IP lists (like AWS prefix lists)
function renderIpLists(el, lists, reloadPanel) {
  el.innerHTML = UI.header('IP lists', 'Named address sets to use as sources or destinations. Official lists change only when you check and confirm.', UI.btn('New list', 'data-newlist')) +
    UI.table([{ label: 'Name' }, { label: 'Addresses' }, { label: 'Kind' }, { label: 'Updated' }, { label: '', align: 'right' }], lists.map(l => ({ cells: [
      `<b>${UI.esc(l.name)}</b>${l.source ? `<div class="ui-sub">${UI.esc(l.source)}</div>` : ''}`,
      l.items.length ? `${l.items.length} <span class="ui-sub">(${l.v4} IPv4 · ${l.v6} IPv6)</span>` : '<span class="ui-sub">not loaded yet</span>',
      l.kind === 'official' ? 'Official' : 'Yours',
      `<span class="ui-sub">${l.fetchedAt ? UI.esc(l.fetchedAt) : (l.kind === 'official' ? (l.items.length ? 'built-in copy' : '—') : UI.esc(l.updatedAt || ''))}</span>`,
      l.kind === 'official' ? UI.btn('Check for updates', `data-check="${l.id}"`) : `${UI.btn('Edit', `data-editlist="${l.id}"`)}${UI.btn('Delete', `data-dellist="${l.id}"`, 'btn-danger')}`,
    ] })), { minWidth: 600 });
  el.querySelector('[data-newlist]').onclick = () => openListDialog(null, reloadPanel);
  el.querySelectorAll('[data-editlist]').forEach(b => b.onclick = () => openListDialog(lists.find(l => l.id === b.dataset.editlist), reloadPanel));
  el.querySelectorAll('[data-dellist]').forEach(b => b.onclick = () => {
    const l = lists.find(x => x.id === b.dataset.dellist);
    secConfirm({ title: `Delete list "${UI.esc(l.name)}"`, danger: true, confirmLabel: 'Delete list',
      change: 'The list is removed from DockGate. Firewall rules already on servers stay — they show as separate addresses.',
      protects: 'No server is changed.', undo: 'Create the list again with the same addresses; rules are recognised again.',
      onConfirm: async () => { try { await API.del(`/firewall-lists/${l.id}`); showToast('List deleted'); reloadPanel(); } catch (e) { showToast(e.message, 'error', 8000); } } });
  });
  el.querySelectorAll('[data-check]').forEach(b => b.onclick = async () => {
    const l = lists.find(x => x.id === b.dataset.check);
    b.disabled = true; b.textContent = 'Checking…';
    let r;
    try { r = await API.post(`/firewall-lists/${l.id}/check`); }
    catch (e) { showToast(e.message, 'error', 10000); b.disabled = false; b.textContent = 'Check for updates'; return; }
    b.disabled = false; b.textContent = 'Check for updates';
    if (!r.add.length && !r.remove.length) { showToast(`${l.name} is up to date`); return; }
    UI.dialog({
      title: `${UI.esc(l.name)} · update`, saveLabel: 'Save the new version',
      body: `<div class="text-sm">${r.add.length} new range${r.add.length === 1 ? '' : 's'}, ${r.remove.length} removed.</div>
        <pre class="td-mono" style="font-size:12px;max-height:240px;overflow:auto;padding:8px;border-radius:8px;background:var(--bg-input);margin:0">${r.add.map(x => `<span style="color:var(--success)">+ ${UI.esc(x)}</span>`).join('\n')}${r.add.length && r.remove.length ? '\n' : ''}${r.remove.map(x => `<span style="color:var(--danger)">− ${UI.esc(x)}</span>`).join('\n')}</pre>
        <div class="ui-sub">Saving updates the list in DockGate. Servers are not changed yet: rules that use the list then show "changed — update this rule", so you apply it per rule and see the exact entries first.</div>`,
      onSave: async () => { await API.post(`/firewall-lists/${l.id}/update`, { items: r.upstream }); showToast(`${l.name} saved`); reloadPanel(); },
    });
  });
}

function openListDialog(l, reloadPanel) {
  UI.dialog({
    title: l ? `Edit list · ${UI.esc(l.name)}` : 'New IP list', saveLabel: 'Save list',
    body: `<div class="ui-field"><label for="ipl-name">Name</label><input class="input" id="ipl-name" value="${UI.esc(l ? l.name : '')}" placeholder="Office, VPN, Partner API…" maxlength="40"></div>
      <div class="ui-field"><label for="ipl-items">Addresses <span class="ui-sub" style="font-weight:400">· one per line, IPv4 and IPv6</span></label><textarea class="input" id="ipl-items" rows="8" style="font-family:var(--font-mono);font-size:12.5px;width:100%;resize:vertical">${UI.esc(l ? l.items.join('\n') : '')}</textarea></div>
      ${l ? '<div class="ui-sub">Rules that use this list then show "changed — update this rule" until you update them.</div>' : ''}`,
    onSave: async (ov) => {
      const body = { name: ov.querySelector('#ipl-name').value, items: ov.querySelector('#ipl-items').value };
      if (l) await API.put(`/firewall-lists/${l.id}`, body); else await API.post('/firewall-lists', body);
      showToast('List saved'); reloadPanel();
    },
  });
}
