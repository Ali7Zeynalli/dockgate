// Web > Proxies & SSL (server/proxies.js reads, server/proxy-edit.js changes): the web servers in front of the
// apps on the server in use - which domain goes where, putting a container on a domain, certificates (Let's
// Encrypt through DockGate), config files with a safe editor (check -> reload -> sites still answer, else undo),
// load balancing, logs, stats and Traefik's live routers.
Router.register('proxies', async (content, params = {}) => {
  const navId = Router._navId; const alive = () => Router.isActiveNav(navId);
  const tab = params.tab || 'overview';
  const e = (s) => escapeHtml(String(s == null ? '' : s));
  const enc = encodeURIComponent;
  const srv = Store.get('activeServer') || {};
  // where a site opens: its domain, or (no domain) the server's address on the port the proxy publishes for it
  const siteUrl = (s) => {
    const scheme = s.https ? 'https' : 'http';
    if (!s.nameless) return `${scheme}://${s.domain}`;
    const host = (srv.id && srv.id !== 'local' && srv.host) || location.hostname;
    const path = s.domain.startsWith('/') ? s.domain : '';
    const port = s.openPort && !(scheme === 'http' && s.openPort === 80) && !(scheme === 'https' && s.openPort === 443) ? `:${s.openPort}` : '';
    return `${scheme}://${host}${port}${path}`;
  };
  const siteName = (s) => !s.nameless ? `<b>${e(s.domain)}</b>` : `<b>${e(s.domain)}</b> ${UI.chip('no domain')}<div class="ui-sub">${s.domain.startsWith('/') ? 'this path on any name' : s.anyName ? `any name on port ${e(s.port)}` : `by IP, port ${e(s.port)}`}${s.port && !s.openPort && !s.domain.startsWith('/') ? ', not published' : ''}</div>`;
  const go = (t, extra = {}) => Router.navigate('proxies', { tab: t, ...extra }, { replace: true });
  const sslPill = (d) => d == null ? '' : d < 0 ? UI.pill('bad', `expired ${-d} d ago`) : d <= 14 ? UI.pill('warn', `${d} days`) : UI.pill('ok', `${d} days`);
  const card = (t, inner, extra = '') => `<div class="card" style="padding:14px 16px">${t ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b>${t}</b><span style="flex:1"></span>${extra}</div>` : ''}${inner}</div>`;
  const FILE_KINDS = ['nginx', 'caddy', 'haproxy', 'apache'];
  let d;
  const load = async (fresh) => { d = await API.get(`/proxies${fresh ? '?fresh=1' : ''}`); };
  try { await load(false); } catch (er) { content.innerHTML = UI.errorState(er, { title: 'Proxies could not be read' }); return; }
  if (!alive()) return;
  const T = [['overview', 'Overview'], ['sites', 'Sites'], ['certs', 'Certificates'], ['files', 'Config files'], ['logs', 'Logs'], ['stats', 'Stats'], ...(d.proxies.some(p => p.kind === 'traefik' && p.running) ? [['traefik', 'Traefik live']] : [])];
  content.innerHTML = `${UI.header('Proxies & SSL', `The web servers in front of your apps on <b>${e(srv.name || (!srv.id || srv.id === 'local' ? 'Local' : srv.id))}</b>: which domain goes where, certificates, config files, load balancing and logs.`, `${UI.btn('↻ Refresh', 'data-px-refresh')} ${d.proxies.some(p => (p.running || p.where === 'container') && !p.swarmService && p.kind !== 'npm' && p.kind !== 'nginx-proxy') ? UI.primary('+ Put a container on a domain', 'data-expose') : ''}`)}
    <div class="tabs" style="margin-bottom:14px">${T.map(([k, l]) => `<button class="tab ${tab === k ? 'active' : ''}" data-ptab="${k}">${l}</button>`).join('')}</div>
    <div id="px-body"><div class="card" style="padding:20px"><div class="skeleton" style="height:120px"></div></div></div>`;
  content.querySelectorAll('[data-ptab]').forEach(b => b.onclick = () => go(b.dataset.ptab));
  const body = content.querySelector('#px-body');
  content.querySelector('[data-px-refresh]').onclick = async () => { try { await load(true); draw(); } catch (er) { showToast(er.message, 'error'); } };
  const exposeBtn = content.querySelector('[data-expose]'); if (exposeBtn) exposeBtn.onclick = () => exposeWizard();

  // ---------- shared pieces ----------
  const siteTarget = (s) => {
    const t = s.target; if (!t) return '<span class="ui-sub">-</span>';
    const sub = t.container ? `${t.container.project ? 'project ' + e(t.container.project) : 'container'}` : e(t.note || '');
    return `<span class="td-mono">${e(t.label)}</span>${sub ? `<div class="ui-sub">${sub}</div>` : ''}${(s.targetsAll || []).length > 1 ? `<div class="ui-sub">+${s.targetsAll.length - 1} more (balanced)</div>` : ''}`;
  };
  const targetState = (s) => { const t = s.target; if (!t) return ''; if (t.container) return t.container.running ? UI.pill('ok', 'running') : UI.pill('bad', `container ${e(t.container.state)}`); if (t.kind === 'files') return UI.chip('static files'); return UI.pill('warn', t.kind === 'self' ? 'the proxy itself' : t.kind === 'host' ? 'a program on the server' : 'not a container'); };
  const proxyOf = (id) => d.proxies.find(p => p.id === id) || {};
  /** The result of a change: each step, the check's output, and what happened to the sites. */
  function showResult(title, r, after) {
    const steps = (r.steps || []).map(s => `<div style="display:flex;gap:8px;padding:3px 0"><span style="color:${s.warn ? 'var(--warning)' : s.ok ? 'var(--success)' : 'var(--danger)'}">${s.warn ? '!' : s.ok ? '✓' : '✗'}</span><span>${e(s.t)}</span></div>`).join('');
    const out = r.output ? `<pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px;max-height:240px;overflow:auto;color:${r.ok ? 'inherit' : 'var(--danger)'}">${e(r.output)}</pre>` : '';
    const np = (r.notPersistent || []).length ? `<div class="insight-card warning" style="margin-top:8px"><div>${r.notPersistent.map(e).join(', ')} ${r.notPersistent.length === 1 ? 'is' : 'are'} inside the container, not on a mount: ${r.notPersistent.length === 1 ? 'it is' : 'they are'} lost when the container is re-created. Mount the config folder to keep changes.</div></div>` : '';
    const labels = r.text ? `<div style="margin-top:10px"><b>Compose</b> (the service of the container):<pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px">${e(r.text.compose)}</pre><b>docker run</b>:<pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px">${e(r.text.run)}</pre><div class="ui-sub">Labels apply when the container is re-created (docker compose up -d).</div></div>` : '';
    showModal(`${r.ok ? '✓' : '✗'} ${e(title)}`, `${r.ok ? '' : `<div class="insight-card danger" style="margin-bottom:8px"><div>${r.stage === 'test' ? 'The config check failed - nothing was reloaded and the earlier files are back.' : r.stage === 'reload' ? 'The reload failed - the earlier files are back.' : r.stage === 'check' ? 'A site stopped answering after the reload - the earlier files are back.' : r.stage === 'certificate' ? 'The certificate could not be obtained.' : r.stage === 'start' ? 'The proxy did not keep running with the new files - the earlier files are back. Its last log lines are below.' : r.stage === 'run' ? 'The proxy stopped again. Its last log lines say why - fix that in its config (Config files), then start it.' : 'The change did not go through.'}</div></div>`}${steps}${out}${np}${labels}`, [{ label: 'Close' }]);
    if (after) after();
  }
  const busy = (b, t) => { const old = b.textContent; b.disabled = true; b.textContent = t; return () => { b.disabled = false; b.textContent = old; }; };
  const reloadAll = async () => { try { await load(true); } catch (er) { /* keep */ } draw(); };

  // ---------- put a container on a domain ----------
  async function exposeWizard(preset = {}) {
    let tg = [];
    try { tg = await API.get('/proxies/targets'); } catch (er) { showToast(er.message, 'error'); return; }
    let certs = null; API.get('/proxies/certs').then(r => { certs = r; }).catch(() => {});
    const usable = d.proxies.filter(p => (p.running || p.where === 'container') && !p.swarmService && !['npm', 'nginx-proxy'].includes(p.kind)).sort((a, b) => (b.ports.some(x => x === 80 || x === 443) ? 1 : 0) - (a.ports.some(x => x === 80 || x === 443) ? 1 : 0) || b.sites - a.sites);
    const portOpts = (name) => ((tg.find(t => t.name === name) || {}).ports || []);
    const rowHtml = (i, c = '', port = '') => `<div style="display:flex;gap:6px;margin-bottom:6px" data-trow="${i}"><select class="select" data-tc style="flex:2"><option value="">- container -</option>${tg.map(t => `<option value="${e(t.name)}" ${t.name === c ? 'selected' : ''}>${e(t.name)}${t.project ? ` (${e(t.project)})` : ''}</option>`).join('')}</select><input class="input" data-tp placeholder="port" list="px-ports-${i}" value="${e(port)}" style="width:110px"><datalist id="px-ports-${i}"></datalist>${i ? '<button type="button" class="btn btn-xs btn-ghost" data-trm>✕</button>' : ''}</div>`;
    let dlg; dlg = UI.dialog({ title: 'Put a container on a domain', wide: true, saveLabel: 'Preview -> ', body: `
      <div class="ui-sub" style="margin-bottom:10px">DockGate writes the site into the proxy's config, runs its check and reloads it. If the check fails or the sites stop answering, the earlier config goes back.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="ui-field"><span>Domain</span><input class="input" data-dom placeholder="app.example.com" value="${e(preset.domain || '')}"></label>
        <label class="ui-field"><span>Also answer on <span class="ui-sub">(optional)</span></span><input class="input" data-al placeholder="www.app.example.com"></label>
      </div>
      <label class="ui-field" style="margin-top:8px"><span>Proxy</span><select class="select" data-px>${usable.map(p => `<option value="${e(p.id)}" ${p.id === preset.proxy ? 'selected' : ''}>${e(p.name)} - ${e(p.label)}${p.ports.length ? `, ${e(p.ports.join(', '))}` : ''}${p.running ? '' : ' (stopped - saving starts it)'}</option>`).join('')}</select></label>
      <div style="margin-top:8px"><div class="ui-field"><span>Goes to (container and its port) - add more to balance the load</span></div><div data-trows>${rowHtml(0, preset.container || '', preset.port || '')}</div><button type="button" class="btn btn-xs btn-secondary" data-tadd>+ Another container</button></div>
      <div data-lbrow style="display:none;margin-top:8px"><label class="ui-field"><span>Balancing</span><select class="select" data-lb><option value="round_robin">Round robin - in turn</option><option value="least_conn">Least connections</option><option value="ip_hash">Same visitor -> same container (IP hash)</option></select></label></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
        <label class="ui-field"><span>HTTPS</span><select class="select" data-https></select></label>
        <label class="ui-field" data-certrow style="display:none"><span>Certificate</span><select class="select" data-cert></select></label>
      </div>
      <label class="ui-field" data-keyrow style="display:none;margin-top:8px"><span>Its key file</span><input class="input td-mono" data-key placeholder="/etc/nginx/certs/site.key"></label>
      <label data-tosrow style="display:none;margin-top:8px"><input type="checkbox" data-tos> I accept the <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener">Let's Encrypt Subscriber Agreement</a></label>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <label><input type="checkbox" data-redir checked> Send http to https</label>
        <label><input type="checkbox" data-ws> WebSockets</label>
        <label style="display:flex;gap:6px;align-items:center">Upload limit <input class="input" data-mb placeholder="e.g. 50m" style="width:90px"></label>
      </div>
      <div class="ui-sub" data-hint style="margin-top:8px"></div>`,
      onOpen: (ov) => {
        const $ = (s) => ov.querySelector(s);
        const fillPorts = (row) => { const n = row.querySelector('[data-tc]').value; const dl = row.querySelector('datalist'); const ps = portOpts(n); dl.innerHTML = ps.map(p => `<option value="${p}">`).join(''); const inp = row.querySelector('[data-tp]'); if (!inp.value && ps.length) inp.value = ps[0]; };
        const wire = () => ov.querySelectorAll('[data-trow]').forEach(row => { row.querySelector('[data-tc]').onchange = () => { row.querySelector('[data-tp]').value = ''; fillPorts(row); }; const rm = row.querySelector('[data-trm]'); if (rm) rm.onclick = () => { row.remove(); lbVis(); }; fillPorts(row); });
        const lbVis = () => { $('[data-lbrow]').style.display = ov.querySelectorAll('[data-trow]').length > 1 ? '' : 'none'; };
        let n = 1; $('[data-tadd]').onclick = () => { $('[data-trows]').insertAdjacentHTML('beforeend', rowHtml(n++)); wire(); lbVis(); };
        const httpsFor = () => {
          const p = proxyOf($('[data-px]').value);
          const opts = p.kind === 'caddy' ? [['auto', 'Automatic (Caddy gets the certificate)'], ['none', 'No - HTTP only']]
            : p.kind === 'traefik' ? [['auto', 'Yes - Traefik serves it (certificate resolver)'], ['none', 'No - HTTP only']]
            : p.kind === 'caddy-docker-proxy' ? [['auto', 'Automatic (Caddy)'], ['none', 'No']]
            : p.kind === 'haproxy' ? [['none', 'Routing only (HTTPS if the frontend already has a certificate)']]
            : [['letsencrypt', "Let's Encrypt - DockGate gets and renews it"], ['existing', 'A certificate already on the proxy'], ['none', 'No - HTTP only']];
          $('[data-https]').innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
          $('[data-hint]').innerHTML = p.kind === 'traefik' || p.kind === 'caddy-docker-proxy' ? `${e(p.label)} reads labels: DockGate gives you the labels to add to the container.` : p.kind === 'nginx' || p.kind === 'apache' ? "Let's Encrypt needs the domain's DNS to point to this server and port 80 to reach the proxy." : '';
          certVis();
        };
        const certVis = () => {
          const ex = $('[data-https]').value === 'existing'; $('[data-certrow]').style.display = ex ? '' : 'none'; $('[data-keyrow]').style.display = ex ? '' : 'none';
          $('[data-tosrow]').style.display = $('[data-https]').value === 'letsencrypt' && !(certs && certs.acme && certs.acme.tos) ? 'block' : 'none';
          const guessKey = (c) => c ? c.replace(/fullchain\.pem$/, 'privkey.pem').replace(/cert\.pem$/, 'privkey.pem').replace(/\.crt$/, '.key').replace(/\.pem$/, '.key') : '';
          if (ex) { const list = certs ? certs.certs.filter(c => !c.internal && c.paths.some(x => x.endsWith('.crt') || x.endsWith('.pem'))) : []; $('[data-cert]').innerHTML = list.length ? list.map(c => `<option value="${e(c.paths[0])}">${e(c.names[0])}, ${e(c.paths[0])}, ${c.daysLeft} days</option>`).join('') : '<option value="">No certificate file found</option>'; $('[data-key]').value = guessKey($('[data-cert]').value); $('[data-cert]').onchange = () => { $('[data-key]').value = guessKey($('[data-cert]').value); }; }
          $('[data-redir]').closest('label').style.display = $('[data-https]').value === 'none' ? 'none' : '';
        };
        $('[data-px]').onchange = httpsFor; $('[data-https]').onchange = certVis;
        wire(); httpsFor();
      },
      onSave: async (ov) => {
        const $ = (s) => ov.querySelector(s);
        const targets = [...ov.querySelectorAll('[data-trow]')].map(r => ({ container: r.querySelector('[data-tc]').value, port: r.querySelector('[data-tp]').value })).filter(t => t.container);
        const cert = $('[data-https]').value === 'existing' ? $('[data-cert]').value : '';
        if ($('[data-https]').value === 'letsencrypt' && !(certs && certs.acme && certs.acme.tos)) {
          if (!$('[data-tos]').checked) throw new Error("Tick the Let's Encrypt Subscriber Agreement first");
          await API.put('/proxies/acme', { tos: true }); if (certs && certs.acme) certs.acme.tos = true;
        }
        const req = { domain: $('[data-dom]').value.trim(), aliases: $('[data-al]').value, proxy: $('[data-px]').value, targets, lb: $('[data-lb]').value, https: $('[data-https]').value,
          redirect: $('[data-redir]').checked, websocket: $('[data-ws]').checked, maxBody: $('[data-mb]').value.trim() || null,
          certPath: cert || null, keyPath: cert ? ($('[data-key]').value.trim() || null) : null };
        const plan = await API.post('/proxies/expose/plan', req);
        previewExpose(req, plan, () => dlg.close());
        return false; // keep the form for "Back"
      },
    });
    return dlg;
  }
  function previewExpose(req, plan, closeWizard = () => {}) {
    const diffs = plan.mode === 'labels' ? `<pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px">${e(plan.text.compose)}</pre>`
      : plan.changes.map(c => `<div style="margin-bottom:8px"><div class="td-mono text-sm" style="margin-bottom:4px">${e(c.path)}${c.before ? '' : ' <span class="ui-sub">(new file)</span>'}</div>${lineDiffHtml(c.before || '', c.text)}</div>`).join('');
    const steps = [
      ...plan.join.map(n => `Join ${e(plan.proxy.name)} to the network <b>${e(n)}</b> (no restart)`),
      ...(plan.mode === 'labels' ? [plan.project ? `Add the labels to <b>${e(plan.project)}</b> (DockGate's override - your compose files are not changed) and re-create the service, or copy them yourself` : 'Show the labels to add to the container'] : [`Write ${plan.changes.length} file${plan.changes.length === 1 ? '' : 's'} (earlier versions are kept)`, 'Run the config check', 'Reload the proxy']),
      ...(plan.flow === 'letsencrypt' ? ["Ask Let's Encrypt for the certificate (checked over http://" + e(req.domain) + '/.well-known/...)', 'Write the certificate and switch the site to HTTPS', 'DockGate renews it 30 days before it expires'] : []),
    ];
    showModal(`Preview - ${e(req.domain)}`, `${plan.notes.map(n => `<div class="insight-card warning" style="margin-bottom:8px"><div>${e(n)}</div></div>`).join('')}
      <ol style="margin:0 0 10px 18px;padding:0">${steps.map(s => `<li>${s}</li>`).join('')}</ol>${diffs}`, [
      { label: 'Back' },
      ...(plan.mode === 'labels' ? [{ label: 'Show the labels', onClick: async () => { try { const r = await API.post('/proxies/expose', req); showResult(`Labels for ${req.domain}`, r); } catch (er) { showToast(er.message, 'error'); } } }] : []),
      ...(plan.mode !== 'labels' || plan.project ? [{ label: plan.mode === 'labels' ? `Add to ${plan.project}` : 'Apply', className: 'btn btn-primary', onClick: async () => {
        showToast(plan.flow === 'letsencrypt' ? "Applying - Let's Encrypt can take a minute..." : plan.mode === 'labels' ? 'Re-creating the service with the labels...' : 'Applying...', 'info');
        try { const r = await API.post('/proxies/expose', { ...req, applyLabels: plan.mode === 'labels' }); if (r.ok) closeWizard(); showResult(r.ok ? `${req.domain} is set up` : `${req.domain} - not done`, r, reloadAll); }
        catch (er) { showToast(er.message, 'error'); }
      } }] : [])]);
  }

  // ---------- one site's actions ----------
  function siteMenu(s) {
    const p = proxyOf(s.proxy);
    const fileKind = FILE_KINDS.includes(p.kind) || p.kind === 'npm';
    const fixed = p.swarmService || (p.kind === 'caddy' && p.caddyJson) || s.nameless; // no domain: the forms and Let's Encrypt work on names // read-only here: a Swarm service, or a Caddy JSON config (edited in Config files)
    const canCert = (p.kind === 'nginx' || p.kind === 'apache') && !fixed;
    const canLb = ['nginx', 'caddy', 'haproxy'].includes(p.kind) && (s.targetsAll || []).length && !fixed;
    const items = [
      ...(s.nameless && !s.openPort && !s.domain.startsWith('/') ? [] : [[`<a class="btn btn-secondary" href="${e(siteUrl(s))}" target="_blank" rel="noopener">Open ↗</a>`, `Open ${e(siteUrl(s))} in a new tab.`]]),
      [UI.btn('+ Uptime check', 'data-a="up"'), 'Watch it on Web > Uptime (status, response time, certificate days).'],
      ...(fixed ? [[UI.chip(s.nameless ? 'No domain' : p.swarmService ? 'Swarm service' : 'Caddy JSON config'), s.nameless ? 'Reached by IP or port, not by a name: site settings, load balancing and Let\'s Encrypt work on domain names - change it in the editor. Put a domain on it with “Put a container on a domain”.' : p.swarmService ? 'Read-only here: change the config where the service gets it, then update it in Swarm > Services.' : 'Site settings and load balancing write Caddyfiles: change this JSON in Config files.']] : []),
      ...(['nginx', 'caddy'].includes(p.kind) && !fixed ? [[UI.btn('Site settings...', 'data-a="settings"'), 'Names, where it goes, WebSockets, upload limit, http -> https - as a form.']] : []),
      ...(fileKind && s.file && s.file.startsWith('/') ? [[UI.btn('Edit the config', 'data-a="edit"'), `${e(s.file)}${s.line ? ':' + s.line : ''}`]] : []),
      ...(canLb ? [[UI.btn('Load balancing...', 'data-a="lb"'), 'The containers behind the site, the method, backup servers.']] : []),
      ...(canCert ? [[UI.btn(s.https ? "Use a Let's Encrypt certificate" : 'Add HTTPS (Let\'s Encrypt)', 'data-a="cert"'), s.https ? 'DockGate gets the certificate and renews it; the site\'s certificate lines are switched to it.' : 'DockGate gets a certificate, adds the HTTPS server and sends http to https.']] : []),
      ...(!s.nameless && (fileKind || ['traefik', 'caddy-docker-proxy'].includes(p.kind)) ? [[UI.btn('Remove the site', 'data-a="rm" class="btn btn-danger"'), fileKind ? 'Only sites DockGate added; the earlier config is kept as a version.' : 'Only labels DockGate added to a Compose project; the service is re-created without them.']] : []),
    ];
    const m = showModal(e(s.domain), `<div class="ui-sub" style="margin-bottom:10px">${e(s.proxyName)} -> ${e(s.target ? s.target.label : '-')}</div>${items.map(([b, t]) => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)"><div style="min-width:230px">${b}</div><div class="ui-sub">${t}</div></div>`).join('')}`, [{ label: 'Close' }]);
    const ov = m.overlay;
    const on = (a, fn) => { const b = ov.querySelector(`[data-a="${a}"]`); if (b) b.onclick = fn; };
    on('up', async () => { try { await API.post('/uptime', { name: s.domain, type: 'http', target: siteUrl(s) }); showToast('Uptime check added', 'success'); m.close(); } catch (er) { showToast(er.message, 'error'); } });
    on('edit', () => { m.close(); go('files', { p: s.proxy, path: s.file }); });
    on('lb', () => { m.close(); lbDialog(s); });
    on('settings', () => { m.close(); settingsDialog(s); });
    on('cert', () => { m.close(); showConfirm(`Let's Encrypt for ${e(s.domain)}`, `DockGate adds the challenge location to the HTTP server of ${e(s.domain)} (if missing), asks Let's Encrypt for a certificate, ${s.https ? 'switches the site\'s certificate lines to it' : 'adds an HTTPS server and sends http to https'}, checks and reloads. The domain's DNS must point to this server and port 80 must reach ${e(s.proxyName)}.`, async () => {
      const ask = async () => {
        showToast('Asking Let\'s Encrypt...', 'info');
        try { const r = await API.post(`/proxies/${enc(s.proxy)}/sites/${enc(s.domain)}/cert`, { redirect: true }); showResult(r.ok ? `HTTPS for ${s.domain}` : `HTTPS for ${s.domain} - not done`, r, reloadAll); }
        catch (er) {
          if (/terms/i.test(er.message)) showConfirm("Let's Encrypt's terms", 'Before DockGate asks for a certificate, accept the <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener">Let\'s Encrypt Subscriber Agreement</a>.', async () => { try { await API.put('/proxies/acme', { tos: true }); ask(); } catch (e2) { showToast(e2.message, 'error'); } });
          else showToast(er.message, 'error');
        }
      };
      ask();
    }); });
    on('rm', () => { m.close(); showConfirm(`Remove ${e(s.domain)}?`, `DockGate removes the site it added from ${e(s.proxyName)}, checks and reloads. The file is kept as a version you can restore.`, async () => {
      try { const r = await API.delete(`/proxies/${enc(s.proxy)}/sites/${enc(s.domain)}`); showResult(r.ok ? `${s.domain} removed` : `${s.domain} - not removed`, r, reloadAll); } catch (er) { showToast(er.message, 'error'); }
    }, true); });
  }

  // ---------- a site's settings as a form ----------
  async function settingsDialog(s) {
    let r; try { r = await API.get(`/proxies/${enc(s.proxy)}/sites/${enc(s.domain)}/settings`); } catch (er) { showToast(er.message, 'error'); return; }
    const st = r.settings; const nginx = r.kind === 'nginx';
    let tg = []; try { tg = await API.get('/proxies/targets'); } catch (er) { /* type it */ }
    UI.dialog({ title: `Site settings - ${e(s.domain)}`, wide: true, saveLabel: 'Preview -> ', body: `
      <div class="ui-sub" style="margin-bottom:8px">${e(s.proxyName)}, <span class="td-mono">${e(r.file)}</span>. Saving goes the safe way: the changed lines first, then check -> reload -> the sites must answer as before.</div>
      <label class="ui-field"><span>Names</span><input class="input" data-sn value="${e(st.names.join(' '))}"></label>
      <label class="ui-field" style="margin-top:8px"><span>Goes to</span>${st.target ? `<input class="input td-mono" data-st value="${e(st.target)}" list="px-set-addrs"><datalist id="px-set-addrs">${tg.flatMap(t => t.ports.map(pt => `<option value="${e(t.name)}:${pt}">`)).join('')}</datalist>` : `<div class="ui-sub">${st.upstream ? `Several servers (${e(st.upstream)}) - change them under Load balancing.` : 'Not a single host:port - change it in the editor.'}</div>`}</label>
      ${nginx ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;align-items:center">
        <label><input type="checkbox" data-sw ${st.websocket ? 'checked' : ''}> WebSockets</label>
        ${st.https && st.http ? `<label><input type="checkbox" data-sr ${st.redirect ? 'checked' : ''}> Send http to https</label>` : ''}
        <label style="display:flex;gap:6px;align-items:center">Upload limit <input class="input" data-sm value="${e(st.maxBody)}" placeholder="nginx default 1m" style="width:120px"></label></div>` : ''}`,
      onSave: async (ov) => {
        const q = (x) => ov.querySelector(x);
        const body = { names: q('[data-sn]').value, ...(q('[data-st]') ? { target: q('[data-st]').value.trim() } : {}), ...(nginx ? { websocket: q('[data-sw]').checked, maxBody: q('[data-sm]').value.trim(), ...(q('[data-sr]') ? { redirect: q('[data-sr]').checked } : {}) } : {}) };
        const plan = await API.post(`/proxies/${enc(s.proxy)}/sites/${enc(s.domain)}/settings/plan`, body);
        if (plan.same) { showToast('No change', 'info'); return false; }
        showModal(`Save the settings of ${e(s.domain)}?`, `<div class="td-mono text-sm" style="margin-bottom:4px">${e(plan.file)}</div>${lineDiffHtml(plan.before, plan.after)}`, [{ label: 'Back' }, { label: 'Save, check and reload', className: 'btn btn-primary', onClick: async () => {
          try { const x = await API.put(`/proxies/${enc(s.proxy)}/sites/${enc(s.domain)}/settings`, body); showResult(x.ok ? `${s.domain} saved and reloaded` : `${s.domain} - not saved`, x, () => { if (x.ok) { ov.remove(); reloadAll(); } }); } catch (er) { showToast(er.message, 'error'); }
        } }]);
        return false;
      },
    });
  }

  // ---------- load balancing ----------
  async function lbDialog(s) {
    let lb; try { lb = await API.get(`/proxies/${enc(s.proxy)}/lb?domain=${enc(s.domain)}`); } catch (er) { showToast(er.message, 'error'); return; }
    let tg = []; try { tg = await API.get('/proxies/targets'); } catch (er) { /* type addresses */ }
    const names = { round_robin: 'Round robin - in turn', least_conn: 'Least connections', ip_hash: 'Same visitor -> same server (IP hash)', random: 'Random', first: 'First available (failover)' };
    const row = (x) => `<tr data-srow><td><input class="input td-mono" data-addr value="${e(x.addr)}" list="px-lb-addrs" style="min-width:200px"></td><td><input class="input" data-w type="number" min="1" max="100" value="${x.weight || 1}" style="width:70px" ${lb.kind === 'caddy' ? 'disabled' : ''}></td><td style="text-align:center"><input type="checkbox" data-bk ${x.backup ? 'checked' : ''} ${lb.kind === 'caddy' ? 'disabled' : ''}></td><td style="text-align:center"><input type="checkbox" data-dn ${x.down ? 'checked' : ''}></td><td><button type="button" class="btn btn-xs btn-ghost" data-rm>✕</button></td></tr>`;
    UI.dialog({ title: `Load balancing - ${e(s.domain)}`, wide: true, saveLabel: 'Save, check and reload', body: `
      <div class="ui-sub" style="margin-bottom:8px">${e(s.proxyName)}, <span class="td-mono">${e(lb.file)}</span>${lb.upstream ? `, upstream <span class="td-mono">${e(lb.upstream)}</span>` : lb.single ? `, one server now: DockGate makes an upstream for it${lb.resolve && lb.resolve.resolves ? '' : ' (nginx then needs each server\'s name to resolve when it reloads)'}` : ''}</div>
      ${(lb.sharedWith || []).length ? `<div class="insight-card warning" style="margin-bottom:8px"><div>The upstream <span class="td-mono">${e(lb.upstream)}</span> is also used by ${lb.sharedWith.map(e).join(', ')}: they change too.</div></div>` : ''}
      ${lb.resolve && lb.resolve.resolves ? `<div class="ui-sub" style="margin-bottom:8px">nginx ${e(lb.resolve.version)}: container names are resolved while it runs (<span class="td-mono">resolve</span>) - nginx starts even when one is missing.</div>` : lb.resolve && lb.resolve.why ? `<div class="insight-card warning" style="margin-bottom:8px"><div>${e(lb.resolve.why)}</div></div>` : ''}
      <label class="ui-field"><span>Method</span><select class="select" data-m>${lb.methods.map(m => `<option value="${m}" ${m === lb.method ? 'selected' : ''}>${names[m] || m}</option>`).join('')}</select></label>
      <datalist id="px-lb-addrs">${tg.flatMap(t => t.ports.map(p => `<option value="${e(t.name)}:${p}">`)).join('')}</datalist>
      <table class="table" style="margin-top:8px;width:100%"><thead><tr><th>Server (host:port)</th><th>Weight</th><th>Backup</th><th>Off</th><th></th></tr></thead><tbody data-srows>${lb.servers.map(row).join('')}</tbody></table>
      <button type="button" class="btn btn-xs btn-secondary" data-add style="margin-top:6px">+ Server</button>
      <div class="ui-sub" style="margin-top:8px">Backup servers only get traffic when the others are down. "Off" keeps a server in the list without traffic (nginx <span class="td-mono">down</span>, HAProxy <span class="td-mono">disabled</span>). Containers must be on a network the proxy shares.</div>`,
      onOpen: (ov) => { const wire = () => ov.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => b.closest('tr').remove()); ov.querySelector('[data-add]').onclick = () => { ov.querySelector('[data-srows]').insertAdjacentHTML('beforeend', row({ addr: '', weight: 1 })); wire(); }; wire(); },
      onSave: async (ov) => {
        const servers = [...ov.querySelectorAll('[data-srow]')].map(r => ({ addr: r.querySelector('[data-addr]').value.trim(), weight: Number(r.querySelector('[data-w]').value) || 1, backup: r.querySelector('[data-bk]').checked, down: r.querySelector('[data-dn]').checked })).filter(x => x.addr);
        const r = await API.put(`/proxies/${enc(s.proxy)}/lb?domain=${enc(s.domain)}`, { method: ov.querySelector('[data-m]').value, servers });
        showResult(r.ok ? `Load balancing of ${s.domain} saved` : 'Load balancing - not saved', r, reloadAll);
      },
    });
  }

  // ---------- the safe editor ----------
  async function editor(pid, path, fileList) {
    const box = body.querySelector('[data-editor]');
    box.innerHTML = '<div style="padding:16px" class="ui-sub">Opening...</div>';
    let f; try { f = await API.get(`/proxies/${enc(pid)}/file?path=${enc(path)}`); } catch (er) { box.innerHTML = `<div style="padding:16px">${UI.errorState(er, { compact: true })}</div>`; return; }
    if (!alive()) return;
    const ro = !!f.locked;
    box.innerHTML = `<div style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);flex-wrap:wrap"><b class="td-mono">${e(f.path)}</b>${f.dockgate ? UI.chip('made by DockGate') : ''}${ro ? UI.chip('🔒 ' + e(f.locked)) : ''}${!f.persistent ? `<span title="Not on a mount: lost when the container is re-created">${UI.pill('warn', 'inside the container')}</span>` : ''}${/helper/.test(f.via) ? UI.chip('read-only mount - saved through a helper') : ''}${f.stopped ? `<span title="Saving writes the file, then starts the proxy and watches it for a few seconds; if it stops again, the earlier file goes back">${UI.pill('bad', 'proxy stopped - Save starts it')}</span>` : ''}<span style="flex:1"></span>
      ${UI.btn('History', 'data-hist')} ${ro ? '' : `${UI.btn('Undo changes', 'data-revert')} ${UI.primary('Save...', 'data-save')}`}</div>
      <textarea class="td-mono" data-ta spellcheck="false" ${ro ? 'readonly' : ''} style="width:100%;min-height:520px;border:0;outline:0;resize:vertical;padding:12px 14px;font-size:12.5px;line-height:1.55;background:var(--bg-primary);color:var(--text-primary);tab-size:4;white-space:pre">${e(f.text)}</textarea>
      <div class="ui-sub" style="padding:6px 12px;border-top:1px solid var(--border)">${f.stopped ? 'The proxy is stopped. Save shows the changed lines, then: earlier version kept -> write -> start the proxy -> it must keep running for a few seconds. If it stops again, the earlier file goes back and its log says why.' : `Save shows the changed lines, then: earlier version kept -> write -> <span class="td-mono">${e(proxyOf(pid).kind === 'caddy' ? 'caddy validate' : proxyOf(pid).kind === 'haproxy' ? 'haproxy -c' : proxyOf(pid).kind === 'apache' ? 'configtest' : 'nginx -t')}</span> -> reload -> the sites must answer as before. Anything fails: the earlier file goes back.`}</div>`;
    const ta = box.querySelector('[data-ta]');
    ta.addEventListener('keydown', (ev) => { if (ev.key === 'Tab' && !ro) { ev.preventDefault(); const s0 = ta.selectionStart; ta.setRangeText('  ', s0, ta.selectionEnd, 'end'); } if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); const b = box.querySelector('[data-save]'); if (b) b.click(); } });
    box.querySelector('[data-hist]').onclick = () => history(pid, path, ta.value, () => editor(pid, path, fileList));
    if (ro) return;
    box.querySelector('[data-revert]').onclick = () => { ta.value = f.text; };
    box.querySelector('[data-save]').onclick = () => {
      if (ta.value === f.text) { showToast('No change', 'info'); return; }
      showModal(`Save ${e(path.split('/').pop())}?`, `${lineDiffHtml(f.text, ta.value)}<label class="ui-field" style="margin-top:8px"><span>Note <span class="ui-sub">(optional, shown in History)</span></span><input class="input" data-note></label>`, [
        { label: 'Cancel' },
        { label: 'Save, check and reload', className: 'btn btn-primary', onClick: async () => {
          const note = (document.querySelector('.modal-overlay [data-note]') || {}).value || '';
          try {
            const r = await API.put(`/proxies/${enc(pid)}/file`, { path, text: ta.value, base: f.base, note });
            showResult(r.ok ? `${path.split('/').pop()} saved and reloaded` : `${path.split('/').pop()} - not saved`, r, () => { if (r.ok) { f.text = ta.value; load(true).then(() => editor(pid, path, fileList)).catch(() => {}); } });
          } catch (er) {
            if (er.data && er.data.conflict || /changed on the server/.test(er.message)) showModal('The file changed on the server', 'Someone (or a tool) changed it after you opened it. Reopen it to see the current file - your text is still in the editor until you do.', [{ label: 'Keep editing' }, { label: 'Reopen', className: 'btn btn-primary', onClick: () => editor(pid, path, fileList) }]);
            else showToast(er.message, 'error');
          }
        } }]);
    };
  }
  async function history(pid, path, current, reopen) {
    let v; try { v = await API.get(`/proxies/${enc(pid)}/versions?path=${enc(path)}`); } catch (er) { showToast(er.message, 'error'); return; }
    const m = showModal(`History - ${e(path.split('/').pop())}`, v.length ? `<div class="ui-sub" style="margin-bottom:8px">The file as it was before each change DockGate made (last 30).</div>${UI.table([{ label: 'Before the change of' }, { label: 'By' }, { label: 'Change' }, { label: '', align: 'right' }], v.map(x => ({ cells: [
      `<span class="td-mono">${e(new Date(x.at).toLocaleString())}</span>`, e(x.user || ''), `${e(x.note || '')}${x.existed ? '' : ' <span class="ui-sub">(file did not exist)</span>'}`,
      `${UI.btn('Compare', `data-cmp="${x.id}"`)} ${UI.btn('Restore', `data-rst="${x.id}"`)}`] })), { minWidth: 0 })}` : '<div class="ui-sub">No earlier versions yet - DockGate keeps one before each change it makes.</div>', [{ label: 'Close' }]);
    m.overlay.querySelectorAll('[data-cmp]').forEach(b => b.onclick = async () => { try { const x = await API.get(`/proxies/${enc(pid)}/versions/${b.dataset.cmp}`); showModal('That version -> now', lineDiffHtml(x.text, current), [{ label: 'Close' }]); } catch (er) { showToast(er.message, 'error'); } });
    m.overlay.querySelectorAll('[data-rst]').forEach(b => b.onclick = () => showConfirm('Restore this version?', 'It is written back with the same check, reload and site test (and the current file is kept as a version).', async () => {
      try { const r = await API.post(`/proxies/${enc(pid)}/versions/${b.dataset.rst}/restore`, {}); m.close(); showResult(r.ok ? 'Version restored' : 'Not restored', r, () => { if (r.ok) reopen(); }); } catch (er) { showToast(er.message, 'error'); }
    }));
  }

  // ---------- tabs ----------
  async function draw() {
    if (!alive()) return;
    const proxies = d.proxies, sites = d.sites;
    if (!proxies.length) {
      body.innerHTML = `<div class="card" style="padding:24px"><b>No proxy found on ${e(srv.name || 'this server')}.</b><div class="ui-sub" style="margin-top:6px">DockGate looks for nginx, OpenResty, Nginx Proxy Manager, nginx-proxy, Caddy, Traefik, HAProxy and Apache - in containers (also images built from them) and installed on the server itself. ${d.hostAccess ? '' : 'DockGate can not reach the host here (DG_HOST_ACCESS is off), so proxies installed on the host are not seen.'} Start one (for example from Deploy > Templates) and press Refresh.</div></div>`;
      return;
    }
    if (tab === 'overview') {
      let certSum = null;
      const certTile = (r) => { if (!r) return '<div class="ui-sub">reading...</div>'; const w = r.certs.filter(c => !c.internal && !c.staging); const exp = w.filter(c => c.daysLeft < 0).length, soon = w.filter(c => c.daysLeft >= 0 && c.daysLeft <= 14).length; const stale = r.certs.filter(c => c.served && c.served.stale).length; return `<div style="font-size:22px;font-weight:700;color:${exp ? 'var(--danger)' : soon ? 'var(--warning)' : 'var(--text-primary)'}">${r.certs.length}</div><div style="font-weight:600">certificates</div><div class="ui-sub">${exp ? `${exp} expired, ` : ''}${soon ? `${soon} expire in 14 days` : exp ? '' : 'none expires soon'}${r.managed && r.managed.length ? `, ${r.managed.length} renewed by DockGate` : ''}${stale ? `, <span style="color:var(--warning)">${stale} renewed but not loaded</span>` : ''}</div>`; };
      API.get('/proxies/certs').then(r => { certSum = r; const el = body.querySelector('[data-certsum]'); if (el) el.innerHTML = certTile(r); }).catch(() => {});
      const bad = d.warnings.filter(w => w.level === 'bad').length;
      const web = d.ports.filter(p => p.port === 80 || p.port === 443);
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:12px">
          <div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700">${proxies.length}</div><div style="font-weight:600">prox${proxies.length === 1 ? 'y' : 'ies'}</div><div class="ui-sub">${e([...new Set(proxies.map(p => p.label))].join(', '))}</div></div>
          <div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700;color:${bad ? 'var(--warning)' : 'var(--text-primary)'}">${sites.length}</div><div style="font-weight:600">sites</div><div class="ui-sub">${sites.filter(s => s.target && s.target.container && !s.target.container.running).length} point to a stopped container</div></div>
          <div class="card" style="padding:14px 16px" data-certsum>${certTile(certSum)}</div>
          <div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700">${web.length ? e([...new Set(web.map(p => p.port))].join(', ')) : '-'}</div><div style="font-weight:600">${web.length ? e([...new Set(web.map(p => p.process))].join(', ')) : 'nobody'}</div><div class="ui-sub">holds the web ports</div></div>
        </div>
        ${(d.appServers || []).length ? `<div class="ui-sub" style="margin-bottom:8px">Not counted as proxies (they serve their own app): ${d.appServers.map(e).join(', ')}.</div>` : ''}
        ${d.warnings.map(w => `<div class="insight-card ${w.level === 'bad' ? 'danger' : 'warning'}" style="margin-bottom:8px"><div style="flex:1">${e(w.text)}</div>${w.stopped ? `<div style="display:flex;gap:6px;flex-shrink:0">${UI.btn('Edit the config', `data-files="${e(w.proxy)}"`)} ${UI.btn('Start', `data-start="${e(w.proxy)}"`)}</div>` : ''}</div>`).join('')}
        ${UI.table([{ label: 'Proxy' }, { label: 'Where it runs' }, { label: 'Ports' }, { label: 'Config' }, { label: 'Sites' }, { label: 'State' }, { label: '', align: 'right' }], proxies.map(p => ({ cells: [
          `<b>${e(p.name)}</b><div class="ui-sub">${e(p.label)} ${e(p.version || '')}</div>`,
          p.where === 'host' ? (p.enabled === 'manual' ? 'server, started by hand (no systemd unit)' : `server, systemd ${e(p.unit)}.service`) : `${p.swarmService ? `Swarm service ${e(p.swarmService)}, ${p.replicas} replica${p.replicas === 1 ? '' : 's'} here<div class="ui-sub">read-only: change its config where the service gets it</div>` : `container${p.project ? ', ' + e(p.project) : ''}`}${p.hostNet ? '<div class="ui-sub">host network: reaches containers at their published ports</div>' : ''}${p.derived ? `<div class="ui-sub" title="${e(p.image)}">image ${e(p.image)}, built from ${e(p.label)}</div>` : ''}`,
          `<span class="td-mono">${e(p.ports.join(', ') || '-')}</span>`,
          `<span class="td-mono text-xs">${e(p.config || '-')}</span>${p.managedBy ? `<div class="ui-sub">🔒 managed by ${e(p.managedBy)}</div>` : ''}${p.problem && !p.stopReason ? `<div class="ui-sub" style="color:var(--warning)">${e(p.problem)}</div>` : ''}`,
          p.sites, `${p.running ? UI.pill('ok', e(p.state)) : UI.pill(p.state === 'inactive' ? 'warn' : 'bad', e(p.restarting ? 'restarting' : p.state))}${!p.running && p.stopReason && p.stopReason.length ? `<div class="ui-sub td-mono text-xs" style="color:var(--danger);max-width:360px;white-space:pre-wrap" title="Its last log lines">${e(p.stopReason.join('\n'))}</div>` : ''}`,
          `${p.running && !['traefik', 'caddy-docker-proxy'].includes(p.kind) ? UI.btn('Test config', `data-test="${e(p.id)}"`) : ''} ${UI.btn('Files', `data-files="${e(p.id)}"`)} ${p.running ? UI.btn('Logs', `data-logs="${e(p.id)}"`) : ''}${!p.running && p.where === 'container' ? ' ' + UI.btn('Start', `data-start="${e(p.id)}"`) : ''}`] })), { minWidth: 0 })}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px;margin-top:12px">
          ${card('Web ports', d.ports.length ? UI.table([{ label: 'Port' }, { label: 'Address' }, { label: 'Process' }], d.ports.map(x => ({ cells: [`<span class="td-mono">${x.port}</span>`, `<span class="td-mono">${e(x.addr)}</span>`, e(x.process)] })), { minWidth: 0 }) : '<div class="ui-sub">Nothing listens on 80, 443, 8080 or 8443.</div>')}
          ${card('How changes are made', `<div class="ui-sub">Every change keeps the earlier file, runs the proxy's own check (<span class="td-mono">nginx -t</span>, <span class="td-mono">caddy validate</span>, <span class="td-mono">haproxy -c</span>, <span class="td-mono">configtest</span>), reloads, and asks each site through the proxy: a site that answered before and does not after puts the earlier file back. Traefik and caddy-docker-proxy are set by labels; Nginx Proxy Manager and nginx-proxy keep their own configs (read-only here).</div>`)}
        </div>`;
    } else if (tab === 'sites') {
      const q = params.q || '';
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center"><input class="input" data-q placeholder="Search domain or target" value="${e(q)}" style="max-width:320px"><span class="ui-sub">${sites.length} site(s)</span><span style="flex:1"></span>${content.querySelector('[data-expose]') ? UI.btn('+ Put a container on a domain', 'data-expose2') : ''}</div><div data-st></div>
        <div class="ui-sub" style="margin-top:8px">A site points to a container when its upstream is a container's name, Compose service or IP on this server. ⋯ opens what you can do with a site.</div>`;
      const drawRows = (qq) => {
        const rows = sites.filter(s => !qq || (s.domain + ' ' + (s.target ? s.target.label : '') + ' ' + s.proxyName).toLowerCase().includes(qq.toLowerCase()));
        body.querySelector('[data-st]').innerHTML = UI.table([{ label: 'Domain' }, { label: 'Goes to' }, { label: 'Proxy' }, { label: 'HTTPS' }, { label: 'Target' }, { label: '', align: 'right' }], rows.map(s => ({ cells: [
          `${siteName(s)}${s.managed ? `<div class="ui-sub">🔒 ${e(s.managed)}</div>` : ''}${s.proxyStopped ? `<div>${UI.pill('bad', 'proxy stopped')}</div>` : ''}`, siteTarget(s), `${e(s.proxyName)}<div class="ui-sub td-mono" title="${e(s.file || '')}">${e(String(s.file || '').split('/').pop())}${s.line ? ':' + s.line : ''}</div>`,
          s.https ? `${UI.pill('ok', 'HTTPS')}${s.redirect ? '<div class="ui-sub">http -> https</div>' : ''}` : s.nameless ? UI.chip('HTTP') : UI.pill('warn', 'HTTP only'), targetState(s),
          `${s.nameless && !s.openPort && !s.domain.startsWith('/') ? '' : `<a class="btn btn-xs btn-secondary" href="${e(siteUrl(s))}" target="_blank" rel="noopener">Open ↗</a>`} ${UI.btn('⋯', `data-menu="${e(s.proxy)}|${e(s.domain)}" title="What you can do with this site"`)}`] })), { minWidth: 0, empty: 'No site found in the configs.' });
        body.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => { const [pid, dom] = b.dataset.menu.split('|'); siteMenu(sites.find(s => s.proxy === pid && s.domain === dom)); });
      };
      drawRows(q);
      body.querySelector('[data-q]').oninput = (ev) => drawRows(ev.target.value);
      const x2 = body.querySelector('[data-expose2]'); if (x2) x2.onclick = () => exposeWizard();
    } else if (tab === 'certs') {
      const view = params.view === 'all' ? 'all' : 'here';
      const head = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap"><div class="tabs" style="margin:0"><button class="tab ${view === 'here' ? 'active' : ''}" data-cv="here">This server</button><button class="tab ${view === 'all' ? 'active' : ''}" data-cv="all">All servers</button></div><span style="flex:1"></span>${view === 'all' ? UI.btn('Check all servers now', 'data-checkall') : UI.btn('↻ Read again', 'data-reread')}</div>`;
      const wireHead = () => { body.querySelectorAll('[data-cv]').forEach(b => b.onclick = () => go('certs', { view: b.dataset.cv })); const rr = body.querySelector('[data-reread]'); if (rr) rr.onclick = () => go('certs', { view, t: Date.now() }); };
      const renewalCell = (c) => {
        const bad = c.renewer === 'none' || /no timer|not checked|stopped|forgotten|off$/.test(c.renewal);
        return `${c.internal ? UI.chip(e(c.renewal)) : bad ? UI.pill('bad', e(c.renewal)) : c.renewer === 'dockgate' ? UI.pill('ok', e(c.renewal)) : e(c.renewal)}${c.staging ? `<div>${UI.chip('test certificate (not trusted)')}</div>` : ''}${c.renewError ? `<div class="ui-sub" style="color:var(--danger)" title="${e(c.renewError)}">last renewal failed</div>` : ''}`;
      };
      const daysCell = (c) => c.internal ? UI.chip(c.daysLeft <= 1 ? 'short-lived' : `${c.daysLeft} days`) : sslPill(c.daysLeft);
      const servedCell = (c) => !c.served ? '' : c.served.stale ? `<div style="margin-top:4px">${UI.pill('warn', 'old one still served')} ${UI.btn('Reload', `data-reload="${e(c.served.proxyId || '')}" title="The renewed file is on disk, but ${e(c.served.proxy)} still serves the certificate that ends ${e(c.served.notAfter.slice(0, 10))}"`)}</div>` : '<div class="ui-sub">✓ served</div>';
      if (view === 'all') {
        body.innerHTML = `${head}<div class="card" style="padding:20px"><div class="ui-sub">Reading the last check...</div></div>`; wireHead();
        let f; try { f = await API.get('/proxies/certs/fleet'); } catch (er) { body.innerHTML = head + UI.errorState(er); wireHead(); return; }
        if (!alive()) return;
        const rows = f.flatMap(sv => (sv.certs || []).map(c => ({ ...c, server: sv.name })));
        rows.sort((x, y) => (x.internal ? 1 : 0) - (y.internal ? 1 : 0) || x.daysLeft - y.daysLeft);
        body.innerHTML = `${head}
          ${f.some(x => x.error) ? f.filter(x => x.error).map(x => `<div class="insight-card warning" style="margin-bottom:8px"><div>${e(x.name)}: ${e(x.error)}</div></div>`).join('') : ''}
          ${f.flatMap(sv => (sv.errors || []).map(er => `<div class="insight-card warning" style="margin-bottom:8px"><div><b>${e(sv.name)}, ${e(er.proxy)}</b> logged certificate errors:<pre class="td-mono text-xs" style="white-space:pre-wrap;margin:6px 0 0">${e(er.lines.slice(-2).join('\n'))}</pre></div></div>`)).join('')}
          ${UI.table([{ label: 'Server' }, { label: 'Names' }, { label: 'Proxy' }, { label: 'Expires' }, { label: '' }, { label: 'Renewal' }], rows.map(c => ({ cells: [
            e(c.server), `<b style="display:inline-block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom" title="${e(c.names.join(', '))}">${e(c.names[0])}</b>${c.names.length > 1 ? `<div class="ui-sub">+${c.names.length - 1} more</div>` : ''}`,
            e((c.proxies || []).join(', ')), `<span class="td-mono">${e(String(c.validTo).slice(0, 10))}</span>`, `${daysCell(c)}${c.served && c.served.stale ? `<div>${UI.pill('warn', 'old one still served')}</div>` : ''}`, renewalCell(c)] })), { minWidth: 0, empty: 'No check yet - press "Check all servers now".' })}
          <div class="ui-sub" style="margin-top:8px">DockGate checks every certificate on every server once a day${f.length ? ` (last: ${e(new Date(Math.max(...f.map(x => x.at || 0))).toLocaleString())})` : ''} and alerts 14, 7, 3 and 1 days before one expires - whoever should renew it - and when a renewed certificate is not loaded or Caddy / Traefik log certificate errors.</div>`;
        wireHead();
        body.querySelector('[data-checkall]').onclick = async (ev) => { const done = busy(ev.target, 'Checking every server...'); try { await API.post('/proxies/certs/check', {}); go('certs', { view: 'all', t: Date.now() }); } catch (er) { showToast(er.message, 'error'); } finally { done(); } };
        return;
      }
      body.innerHTML = `${head}<div class="card" style="padding:20px"><div class="ui-sub">Reading certificates (and what each proxy really serves)...</div></div>`; wireHead();
      let r; try { r = await API.get(`/proxies/certs${params.t ? '?fresh=1' : ''}`); } catch (er) { body.innerHTML = head + UI.errorState(er); wireHead(); return; }
      if (!alive()) return;
      const certSite = (dom) => sites.find(s => s.domain === dom && ['nginx', 'apache'].includes(proxyOf(s.proxy).kind));
      const a = r.acme;
      const cb = r.certbot;
      body.innerHTML = `${head}
        ${(() => { // expired or about to: why, and the fix for whoever keeps it
          const due = r.certs.filter(c => !c.internal && !c.staging && c.daysLeft <= 14).sort((a, b) => a.daysLeft - b.daysLeft);
          if (!due.length) return '';
          return `<div class="card" style="padding:12px 14px;margin-bottom:12px;border-color:${due.some(c => c.daysLeft < 0) ? 'var(--danger)' : 'var(--warning)'}"><div style="font-weight:600;margin-bottom:6px">${due.some(c => c.daysLeft < 0) ? 'Expired or expiring soon' : 'Expiring soon'} - ${due.length} certificate${due.length === 1 ? '' : 's'}</div>${due.map(c => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--border)"><b style="min-width:200px">${e(c.names[0])}</b>${c.daysLeft < 0 ? UI.pill('bad', `expired ${-c.daysLeft} d ago`) : UI.pill('warn', `${c.daysLeft} days`)}<span class="ui-sub" style="flex:1">${e(c.renewal)}, ${e(c.proxies.join(', '))}</span>${UI.btn('Why?, fix', `data-doctor="${e(c.fingerprint)}" data-dname="${e(c.names[0])}"`)}</div>`).join('')}<div class="ui-sub" style="margin-top:6px">"Why?" checks what a renewal needs - the domain's DNS, port 80 and the check path from outside, the program that renews it - and offers the fix that applies.</div></div>`;
        })()}
        ${(r.errors || []).map(er => `<div class="insight-card warning" style="margin-bottom:8px"><div><b>${e(er.proxy)}</b> logged certificate errors (it renews by itself - this is why it may not):<pre class="td-mono text-xs" style="white-space:pre-wrap;margin:6px 0 0">${e(er.lines.join('\n'))}</pre></div></div>`).join('')}
        ${UI.table([{ label: 'Names' }, { label: 'Issuer' }, { label: 'Kept by' }, { label: 'Expires' }, { label: '' }, { label: 'Renewal' }], r.certs.map(c => {
          const cs = certSite(c.names[0]);
          const byHand = c.managedId || c.renewer === 'certbot' || c.renewer === 'acme.sh'; // whoever keeps it can be asked now
          return { cells: [
            `<b style="display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom" title="${e(c.names.join(', '))}">${e(c.names.slice(0, 3).join(', '))}</b>${c.names.length > 3 ? `<div class="ui-sub">+${c.names.length - 3} more</div>` : ''}${c.selfSigned ? '<div class="ui-sub">self-signed</div>' : ''}`,
            `<div style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e(c.issuer)}">${e(c.issuer)}</div>`, `${e(c.source)} <span class="ui-sub">· ${e(c.proxies.join(', '))}</span><div class="ui-sub td-mono" style="max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e(c.paths.join('\n'))}">${e(c.paths[0].split('/').slice(-2).join('/'))}</div>`,
            `<span class="td-mono">${e(c.validTo.slice(0, 10))}</span>`, `${daysCell(c)}${servedCell(c)}`,
            renewalCell(c) + (c.renewer === 'none' && cs ? `<div style="margin-top:4px">${UI.btn("Use Let's Encrypt", `data-le="${e(cs.proxy)}|${e(cs.domain)}"`)}</div>` : '') + (byHand ? `<div style="margin-top:4px">${UI.btn('Renew now', `data-rnow="${e(c.fingerprint)}" data-rname="${e(c.names[0])}" data-rwho="${e(c.managedId ? 'DockGate (Let\'s Encrypt)' : c.certbotContainer && !c.proxies.includes('host') ? `certbot in ${c.certbotContainer}` : c.renewer)}"`)}</div>` : '')] };
        }), { minWidth: 0, empty: 'No certificate found.' })}
        ${r.uncovered.length ? `<div class="insight-card warning" style="margin-top:10px"><div>HTTPS sites whose certificate DockGate could not read: ${r.uncovered.map(dom => `${e(dom)}${certSite(dom) ? ` ${UI.btn("Use Let's Encrypt", `data-le="${e(certSite(dom).proxy)}|${e(dom)}"`)}` : ''}`).join(', ')}</div></div>` : ''}
        ${r.notes.length ? `<details style="margin-top:8px" ${r.notes.some(n => /certbot renews/.test(n)) ? 'open' : ''}><summary class="ui-sub">Notes (${r.notes.length})</summary><div class="ui-sub">${r.notes.map(e).join('<br>')}</div></details>` : ''}
        <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-top:14px">
          ${cb && cb.installed ? card('certbot on this server', `<div class="ui-sub" style="margin-bottom:8px">Renewal: ${cb.timer ? UI.pill('ok', `${e(cb.timer)} on`) : UI.pill('bad', 'no timer or cron')}, After a renewal: ${cb.reloads ? UI.pill('ok', `reload hook (${e(cb.hooks.slice(0, 2).join(', '))})`) : UI.pill('bad', 'nothing reloads the web server')}</div>${cb.reloads ? '' : UI.primary('Add a reload hook...', 'data-cbhook')}`) : ''}
          ${card("Let's Encrypt certificates DockGate renews", r.managed.length ? UI.table([{ label: 'Names' }, { label: 'Proxy' }, { label: 'Expires' }, { label: 'Auto renew' }, { label: 'Last try' }, { label: '', align: 'right' }], r.managed.map(m => ({ cells: [
            `<b style="display:inline-block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom" title="${e(m.names.join(', '))}">${e(m.names.join(', '))}</b><div class="ui-sub td-mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e(m.certPath)}">${e(m.certPath)}</div>`, e(m.proxy), `${m.notAfter ? `<span class="td-mono">${e(m.notAfter.slice(0, 10))}</span> ` : ''}${sslPill(m.daysLeft)}`,
            `<label><input type="checkbox" data-auto="${m.id}" ${m.auto ? 'checked' : ''}> on</label>`,
            m.lastError ? `<span style="color:var(--danger)" title="${e(m.lastError)}">failed: ${e(m.lastError.slice(0, 60))}</span>` : m.lastTry ? `<span class="ui-sub" title="${e(new Date(m.lastTry).toLocaleString())}">${e(new Date(m.lastTry).toLocaleDateString())}</span>` : '',
            `${UI.btn('Renew now', `data-renew="${m.id}"`)} ${UI.btn('Put back', `data-redeploy="${m.id}" title="Write the certificate files to the proxy again (after the container was re-created)"`)} ${UI.btn('Forget', `data-forget="${m.id}"`)}`] })), { minWidth: 0 }) : `<div class="ui-sub">None yet. Put a container on a domain with "Let's Encrypt", or use "Use Let's Encrypt" on an nginx or Apache site. DockGate answers the check through the proxy itself (port 80), keeps the certificate and renews it ${a.renewDays} days before it expires; a failed renewal is sent to your notification channels.</div>`)}
          ${card("Let's Encrypt account", `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;align-items:end"><label class="ui-field"><span>Email <span class="ui-sub">(Let's Encrypt writes before a certificate expires)</span></span><input class="input" data-ae value="${e(a.email)}" placeholder="you@example.com"></label>
            <label class="ui-field"><span>Certificate authority</span><select class="select" data-ad><option value="letsencrypt" ${a.directory === 'letsencrypt' ? 'selected' : ''}>Let's Encrypt</option><option value="letsencrypt-staging" ${a.directory === 'letsencrypt-staging' ? 'selected' : ''}>Let's Encrypt staging (tests - not trusted)</option>${!['letsencrypt', 'letsencrypt-staging'].includes(a.directory) ? `<option value="${e(a.directory)}" selected>${e(a.directory)}</option>` : ''}<option value="__custom">Another ACME URL...</option></select></label>
            <label class="ui-field"><span>Renew this many days before expiry</span><input class="input" data-ar type="number" min="7" max="60" value="${a.renewDays}"></label>
            <div>${UI.primary('Save', 'data-asave')}</div></div>
            <label style="display:block;margin-top:10px"><input type="checkbox" data-atos ${a.tos ? 'checked' : ''}> I accept the certificate authority's terms (<a href="${e(a.terms)}" target="_blank" rel="noopener">Let's Encrypt Subscriber Agreement</a>) - needed before DockGate asks for a certificate.</label>
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)"><b>DNS check (Cloudflare)</b> <span class="ui-sub">- for wildcard certificates (*.example.com), and for sites where port 80 is closed or behind Cloudflare's proxy. DockGate adds the TXT record <span class="td-mono">_acme-challenge.&lt;name&gt;</span>, waits for public DNS, and removes it after the check.</span>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;align-items:end;margin-top:8px">
                <label class="ui-field"><span>Provider</span><select class="select" data-dnsp><option value="" ${!a.dns.provider ? 'selected' : ''}>None - HTTP check only</option><option value="cloudflare" ${a.dns.provider === 'cloudflare' ? 'selected' : ''}>Cloudflare</option></select></label>
                <label class="ui-field"><span>API token <span class="ui-sub">(Zone > DNS > Edit; stored encrypted)</span></span><input class="input" type="password" autocomplete="off" data-dnst placeholder="${a.dns.hasToken ? '•••••••• saved - type to replace' : 'Cloudflare API token'}"></label>
                <label class="ui-field"><span>Use it for</span><select class="select" data-dnsm><option value="wildcard" ${a.dns.mode !== 'all' ? 'selected' : ''}>Wildcard names only</option><option value="all" ${a.dns.mode === 'all' ? 'selected' : ''}>Every certificate</option></select></label>
                <div>${UI.btn('Save', 'data-dnssave')} ${a.dns.hasToken ? UI.btn('Test the token', 'data-dnstest') : ''}</div></div></div>
            <label style="display:block;margin-top:6px"><input type="checkbox" data-afix ${a.autoFix ? 'checked' : ''}> Fix safe problems by itself - the daily check reloads a proxy that still serves the old certificate and turns on certbot's timer. Other fixes are only suggested in the alert.</label>`)}
        </div>
        <div class="ui-sub" style="margin-top:8px">Read from the certificate files in the configs (nginx <span class="td-mono">ssl_certificate</span>, Apache <span class="td-mono">SSLCertificateFile</span>, HAProxy <span class="td-mono">bind ... crt</span>), certbot's <span class="td-mono">/etc/letsencrypt/live</span>${d.hostAccess ? '' : ' (when DockGate can reach the host)'}, Caddy's data folder and Traefik's acme.json. "✓ served" means the proxy answers with this certificate (asked from inside it).</div>`;
      wireHead();
      body.querySelectorAll('[data-le]').forEach(b => b.onclick = () => { const [pid, dom] = b.dataset.le.split('|'); siteMenu(sites.find(s => s.proxy === pid && s.domain === dom)); });
      body.querySelectorAll('[data-reload]').forEach(b => b.onclick = async () => { const done = busy(b, 'Reloading...'); try { const x = await API.post(`/proxies/${enc(b.dataset.reload)}/reload`, {}); showResult(x.ok ? 'Reloaded - the renewed certificate is served' : 'Not reloaded', { ...x, steps: [{ t: x.ok ? 'Check ok, reloaded' : `Stopped at: ${x.stage}`, ok: x.ok }] }, () => go('certs', { t: Date.now() })); } catch (er) { showToast(er.message, 'error'); } finally { done(); } });
      const doctor = async (fp, name) => {
        const m = showModal(`Why? - ${e(name)}`, '<div class="ui-sub">Checking: DNS, port 80, the check path from outside, the program that renews it...</div>', [{ label: 'Close' }]);
        let dg; try { dg = await API.get(`/proxies/certs/doctor/${encodeURIComponent(fp)}`); } catch (er) { m.overlay.querySelector('.modal-body').innerHTML = `<div class="ui-sub" style="color:var(--danger)">${e(er.message)}</div>`; return; }
        const icon = (ok) => ok === true ? '<span style="color:var(--success)">✓</span>' : ok === false ? '<span style="color:var(--danger)">✗</span>' : '<span style="color:var(--warning)">!</span>';
        m.overlay.querySelector('.modal-body').innerHTML = `<div class="insight-card ${dg.checks.some(c => c.ok === false) ? 'danger' : 'warning'}" style="margin-bottom:10px"><div>${e(dg.verdict)}</div></div>
          ${dg.checks.map(c => `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">${icon(c.ok)}<div style="flex:1"><b>${e(c.title)}</b><div class="ui-sub" style="white-space:pre-wrap">${e(c.detail)}</div></div></div>`).join('')}
          ${dg.fixes.length ? `<div style="margin-top:12px;font-weight:600">Fix</div>${dg.fixes.map(f => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0">${UI.btn(e(f.label), `data-fix="${e(f.id)}"`)}<span class="ui-sub">${e(f.desc)}</span></div>`).join('')}` : '<div class="ui-sub" style="margin-top:10px">No fix DockGate can run for this certificate - the checks above say what to change.</div>'}`;
        m.overlay.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => { const f = dg.fixes.find(x => x.id === b.dataset.fix); showConfirm(`${e(f.label)} - ${e(name)}?`, e(f.desc), async () => {
          m.close(); showToast(`${f.label}...`, 'info');
          try { const x = await API.post(`/proxies/certs/doctor/${encodeURIComponent(fp)}/fix`, { action: f.id }); showResult(x.ok ? `${f.label} - done` : `${f.label} - not done`, x); go('certs', { t: Date.now() }); } catch (er) { showToast(er.message, 'error'); }
        }); });
      };
      body.querySelectorAll('[data-doctor]').forEach(b => b.onclick = () => doctor(b.dataset.doctor, b.dataset.dname));
      body.querySelectorAll('[data-rnow]').forEach(b => b.onclick = () => showConfirm(`Renew ${e(b.dataset.rname)} now?`, `${e(b.dataset.rwho)} asks for a new certificate now, even when this one is not due yet. Then the proxies that use it are checked and reloaded. Let's Encrypt allows 5 new certificates for the same names a week.`, async () => {
        const done = busy(b, 'Renewing...');
        try { const x = await API.post('/proxies/certs/renew', { fingerprint: b.dataset.rnow }); showResult(x.ok ? `${b.dataset.rname} renewed` : `${b.dataset.rname} - not renewed`, x); go('certs', { t: Date.now() }); } catch (er) { showToast(er.message, 'error'); } finally { done(); }
      }));
      const hk = body.querySelector('[data-cbhook]');
      if (hk) hk.onclick = async () => { try { const pv = await API.get('/proxies/certbot/hook'); showModal('Add a certbot reload hook', `<div class="ui-sub" style="margin-bottom:6px">certbot runs this after every renewal, so the web servers serve the new certificate:</div><div class="td-mono text-sm">${e(pv.path)}</div><pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px">${e(pv.text)}</pre>`, [{ label: 'Cancel' }, { label: 'Write it', className: 'btn btn-primary', onClick: async () => { try { await API.post('/proxies/certbot/hook', {}); showToast('Reload hook written', 'success'); go('certs', { t: Date.now() }); } catch (er) { showToast(er.message, 'error'); } } }]); } catch (er) { showToast(er.message, 'error'); } };
      body.querySelectorAll('[data-auto]').forEach(c => c.onchange = async () => { try { await API.put(`/proxies/managed-certs/${c.dataset.auto}/auto`, { auto: c.checked }); showToast(c.checked ? 'Auto renew on' : 'Auto renew off', 'success'); } catch (er) { showToast(er.message, 'error'); } });
      body.querySelectorAll('[data-renew]').forEach(b => b.onclick = async () => { const done = busy(b, 'Renewing...'); try { await API.post(`/proxies/managed-certs/${b.dataset.renew}/renew`, {}); showToast('Renewed and reloaded', 'success'); go('certs', { t: Date.now() }); } catch (er) { showToast(er.message, 'error'); } finally { done(); } });
      body.querySelectorAll('[data-redeploy]').forEach(b => b.onclick = async () => { const done = busy(b, 'Writing...'); try { const x = await API.post(`/proxies/managed-certs/${b.dataset.redeploy}/redeploy`, {}); showToast(x.ok ? 'Certificate written and reloaded' : 'Written, but the config check failed', x.ok ? 'success' : 'error'); } catch (er) { showToast(er.message, 'error'); } finally { done(); } });
      body.querySelectorAll('[data-forget]').forEach(b => b.onclick = () => showConfirm('Forget this certificate?', 'DockGate stops renewing it. The files on the proxy stay.', async () => { try { await API.delete(`/proxies/managed-certs/${b.dataset.forget}`); go('certs', { t: Date.now() }); } catch (er) { showToast(er.message, 'error'); } }, true));
      body.querySelector('[data-ad]').onchange = (ev) => { if (ev.target.value === '__custom') { const u = prompt('ACME directory URL (https://...)'); if (u) { ev.target.insertAdjacentHTML('afterbegin', `<option value="${e(u)}" selected>${e(u)}</option>`); } else ev.target.value = a.directory; } };
      body.querySelector('[data-atos]').onchange = async (ev) => { try { await API.put('/proxies/acme', { tos: ev.target.checked }); showToast(ev.target.checked ? 'Terms accepted' : 'Terms not accepted - DockGate will not ask for certificates', ev.target.checked ? 'success' : 'info'); } catch (er) { showToast(er.message, 'error'); } };
      const dsv = body.querySelector('[data-dnssave]'); if (dsv) dsv.onclick = async () => {
        const tok = body.querySelector('[data-dnst]').value.trim();
        try { await API.put('/proxies/acme', { dnsProvider: body.querySelector('[data-dnsp]').value, dnsMode: body.querySelector('[data-dnsm]').value, ...(tok ? { dnsToken: tok } : {}) }); showToast('Saved', 'success'); go('certs'); } catch (er) { showToast(er.message, 'error', 8000); }
      };
      const dts = body.querySelector('[data-dnstest]'); if (dts) dts.onclick = async () => { dts.disabled = true; try { const r = await API.post('/proxies/acme/dns-test', {}); showToast(`Cloudflare accepts the token (${r.status})`, 'success'); } catch (er) { showToast(er.message, 'error', 9000); } dts.disabled = false; };
      const afx = body.querySelector('[data-afix]'); if (afx) afx.onchange = async () => { try { await API.put('/proxies/acme', { autoFix: afx.checked }); showToast(`Saved, ${afx.checked ? 'on' : 'off'}`, 'success'); } catch (er) { afx.checked = !afx.checked; showToast(er.message, 'error'); } };
      body.querySelector('[data-asave]').onclick = async () => { try { await API.put('/proxies/acme', { email: body.querySelector('[data-ae]').value, directory: body.querySelector('[data-ad]').value, renewDays: body.querySelector('[data-ar]').value }); showToast('Saved', 'success'); } catch (er) { showToast(er.message, 'error'); } };
    } else if (tab === 'files') {
      const withFiles = proxies.filter(p => p.running || (p.where === 'container' && p.config)); // a stopped container's files are read through Docker's archive API
      const pid = params.p && withFiles.some(p => p.id === params.p) ? params.p : (withFiles[0] || {}).id;
      if (!pid) { body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">No proxy with config files.</div></div>'; return; }
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Reading...</div></div>';
      let r; try { r = await API.get(`/proxies/${enc(pid)}/files`); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      const labels = ['traefik', 'caddy-docker-proxy'].includes(proxyOf(pid).kind);
      const fi = params.path ? Math.max(0, r.files.findIndex(x => x.path === params.path)) : Math.min(Number(params.f) || 0, Math.max(0, r.files.length - 1)); const f = r.files[fi];
      body.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><select class="select" data-pp style="max-width:320px">${withFiles.map(p => `<option value="${e(p.id)}" ${p.id === pid ? 'selected' : ''}>${e(p.name)} - ${e(p.label)}</option>`).join('')}</select><span class="ui-sub">${r.files.length} file(s)</span><span style="flex:1"></span>${!labels ? UI.btn('History of all files', 'data-allhist') : ''}</div>
        ${r.files.length ? `<div style="display:grid;grid-template-columns:280px minmax(0,1fr);gap:12px;align-items:start">
          <div class="card" style="padding:8px;max-height:620px;overflow:auto">${r.files.map((x, i) => `<button type="button" class="btn btn-xs ${i === fi ? 'btn-primary' : 'btn-ghost'}" data-fi="${e(x.path)}" style="display:block;width:100%;text-align:left;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${e(x.path)}">${x.managed ? '🔒 ' : '📄 '}${e(x.path)}</button>`).join('')}</div>
          <div class="card" style="padding:0;overflow:hidden" data-editor>${labels ? `<div style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border)"><b class="td-mono">${e(f.path)}</b><span style="flex:1"></span>${UI.chip('labels - read-only')}</div><pre class="td-mono" style="margin:0;padding:12px 14px;font-size:12.5px;line-height:1.55;background:var(--bg-primary);max-height:560px;overflow:auto">${e(f.text)}</pre>` : ''}</div></div>` : `<div class="card" style="padding:20px"><div class="ui-sub">${e(r.note || 'No files.')}</div></div>`}`;
      body.querySelector('[data-pp]').onchange = (ev) => go('files', { p: ev.target.value });
      body.querySelectorAll('[data-fi]').forEach(b => b.onclick = () => go('files', { p: pid, path: b.dataset.fi }));
      const ah = body.querySelector('[data-allhist]');
      if (ah) ah.onclick = async () => {
        try { const v = await API.get(`/proxies/${enc(pid)}/versions`); showModal(`History - ${e(proxyOf(pid).name)}`, v.length ? UI.table([{ label: 'When' }, { label: 'File' }, { label: 'By' }, { label: 'Change' }], v.map(x => ({ cells: [`<span class="td-mono">${e(new Date(x.at).toLocaleString())}</span>`, `<span class="td-mono text-xs">${e(x.path)}</span>`, e(x.user || ''), e(x.note || '')] })), { minWidth: 0 }) : '<div class="ui-sub">No changes made through DockGate yet.</div>', [{ label: 'Close' }]); } catch (er) { showToast(er.message, 'error'); }
      };
      if (f && !labels) editor(pid, f.path, r.files);
    } else if (tab === 'logs') {
      const running = proxies.filter(p => p.running && p.kind !== 'certbot');
      const pid = params.p && running.some(p => p.id === params.p) ? params.p : (running[0] || {}).id;
      const which = params.which || 'access';
      if (!pid) { body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">No running proxy.</div></div>'; return; }
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Reading...</div></div>';
      let r; try { r = await API.get(`/proxies/${enc(pid)}/logs?which=${which}&tail=500`); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      const col = (s) => s >= 500 ? 'var(--danger)' : s >= 400 ? 'var(--warning)' : s >= 300 ? 'var(--accent)' : 'var(--success)';
      const render = (filter, cls) => r.entries.filter(x => (!filter || x.line.toLowerCase().includes(filter.toLowerCase())) && (!cls || (x.status && String(x.status)[0] === cls))).slice(-500).map(x => x.status
        ? `<span class="ui-sub">${e(x.time || '')}</span>  <b style="color:${col(x.status)}">${x.status}</b>  ${e((x.method || '').padEnd(6))}${x.host ? e(x.host) + ' ' : ''}${e(x.path || '')}${x.ms != null ? `  <span class="ui-sub">${x.ms} ms</span>` : ''}  <span class="ui-sub">${e(x.ip || '')}</span>`
        : `<span class="ui-sub">${e(x.line)}</span>`).join('\n');
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center"><select class="select" data-pp style="max-width:260px">${running.map(p => `<option value="${e(p.id)}" ${p.id === pid ? 'selected' : ''}>${e(p.name)}</option>`).join('')}</select>
        <select class="select" data-wh style="max-width:140px"><option value="access" ${which === 'access' ? 'selected' : ''}>access</option><option value="error" ${which === 'error' ? 'selected' : ''}>error</option><option value="all" ${which === 'all' ? 'selected' : ''}>all</option></select>
        ${['2', '3', '4', '5'].map(c => `<button type="button" class="btn btn-xs btn-secondary" data-cls="${c}">${c}xx</button>`).join('')}<input class="input" data-flt placeholder="IP, path or domain" style="max-width:240px"><span style="flex:1"></span>${UI.btn('Stats', 'data-gostats')}</div>
        <div class="card" style="padding:0;overflow:hidden"><pre class="td-mono" data-log style="margin:0;padding:12px 14px;font-size:12.5px;line-height:1.7;background:var(--bg-primary);max-height:560px;overflow:auto">${render('', '') || '<span class="ui-sub">No lines.</span>'}</pre></div>
        ${(r.sources || []).length ? `<div class="ui-sub" style="margin-top:8px">Read from ${e(r.sources.join(' and '))}.</div>` : ''}
        ${r.stats ? `<div class="ui-sub" style="margin-top:8px">Last ${r.stats.requests} requests: ${r.stats.s4xx} with 4xx, ${r.stats.s5xx} with 5xx (${(100 * r.stats.s5xx / r.stats.requests).toFixed(1)} %).</div>` : ''}`;
      let cls = '';
      const re = () => { const el = body.querySelector('[data-log]'); el.innerHTML = render(body.querySelector('[data-flt]').value, cls) || '<span class="ui-sub">No lines.</span>'; el.scrollTop = el.scrollHeight; };
      body.querySelector('[data-pp]').onchange = (ev) => go('logs', { p: ev.target.value, which });
      body.querySelector('[data-wh]').onchange = (ev) => go('logs', { p: pid, which: ev.target.value });
      body.querySelector('[data-gostats]').onclick = () => go('stats', { p: pid });
      body.querySelector('[data-flt]').oninput = re;
      body.querySelectorAll('[data-cls]').forEach(b => b.onclick = () => { cls = cls === b.dataset.cls ? '' : b.dataset.cls; body.querySelectorAll('[data-cls]').forEach(x => x.classList.toggle('btn-primary', x.dataset.cls === cls)); re(); });
      const el = body.querySelector('[data-log]'); el.scrollTop = el.scrollHeight;
    } else if (tab === 'stats') {
      const running = proxies.filter(p => p.running && p.kind !== 'certbot');
      const pid = params.p && running.some(p => p.id === params.p) ? params.p : (running.find(p => p.sites) || running[0] || {}).id;
      if (!pid) { body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">No running proxy.</div></div>'; return; }
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Reading the access log...</div></div>';
      let s; try { s = await API.get(`/proxies/${enc(pid)}/stats?tail=3000`); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      const head = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><select class="select" data-pp style="max-width:260px">${running.map(p => `<option value="${e(p.id)}" ${p.id === pid ? 'selected' : ''}>${e(p.name)}</option>`).join('')}</select><span class="ui-sub">from the last 3000 lines of the access log</span><span style="flex:1"></span>${UI.btn('↻', 'data-again')}</div>`;
      if (!s.requests) { body.innerHTML = `${head}<div class="card" style="padding:20px"><div class="ui-sub">No access log lines DockGate can read (nginx / Apache combined format or Caddy JSON). Traefik writes access logs only with --accesslog.</div></div>`; }
      else {
        const tile = (v, l, sub, color) => `<div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700;${color ? `color:${color}` : ''}">${v}</div><div style="font-weight:600">${l}</div><div class="ui-sub">${sub || ''}</div></div>`;
        const c = Object.fromEntries(s.classes.map(x => [x.cls, x.count]));
        const pct = (n) => (100 * n / s.requests).toFixed(1) + ' %';
        const max = Math.max(1, ...s.timeline.map(t => t.n));
        const W = Math.max(1, s.timeline.length);
        const bars = s.timeline.map((t, i) => { const h = 100 * t.n / max, h5 = 100 * t.s5 / max, h4 = 100 * t.s4 / max; const x = (i / W) * 100, w = Math.max(0.6, 100 / W - 0.3); return `<g><title>${new Date(t.t).toLocaleTimeString()} - ${t.n} requests, ${t.s4} 4xx, ${t.s5} 5xx</title><rect x="${x}%" y="${100 - h}%" width="${w}%" height="${h - h4 - h5}%" fill="var(--accent)" opacity=".75"></rect><rect x="${x}%" y="${100 - h4 - h5}%" width="${w}%" height="${h4}%" fill="var(--warning)"></rect><rect x="${x}%" y="${100 - h5}%" width="${w}%" height="${h5}%" fill="var(--danger)"></rect></g>`; }).join('');
        const top = (title, rows) => card(title, rows.length ? UI.table([{ label: '' }, { label: 'Requests', align: 'right' }], rows.map(r => ({ cells: [`<div class="td-mono text-xs" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e(r.key)}">${e(r.key)}</div>`, `${r.count} <span class="ui-sub">${pct(r.count)}</span>`] })), { minWidth: 0 }) : '<div class="ui-sub">-</div>');
        body.innerHTML = `${head}
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px">
            ${tile(s.requests, 'requests', s.from ? `${new Date(s.from).toLocaleString()} - ${new Date(s.to).toLocaleTimeString()}` : '')}
            ${tile(s.perMinute != null ? s.perMinute : '-', 'per minute', 'average over the span')}
            ${tile(c['4xx'] || 0, '4xx', pct(c['4xx'] || 0), (c['4xx'] || 0) / s.requests > 0.2 ? 'var(--warning)' : '')}
            ${tile(c['5xx'] || 0, '5xx', pct(c['5xx'] || 0), (c['5xx'] || 0) ? 'var(--danger)' : '')}
            ${tile(s.ms ? `${s.ms.p50} / ${s.ms.p95} ms` : '-', 'response p50 / p95', s.ms ? `average ${s.ms.avg} ms, slowest ${s.ms.max} ms` : 'add $request_time to the log format to see it')}
          </div>
          ${card('Requests per minute', `<svg width="100%" height="140" preserveAspectRatio="none" style="display:block;background:var(--bg-primary);border-radius:6px">${bars}</svg><div class="ui-sub" style="margin-top:4px">Blue: answered, orange: 4xx, red: 5xx. Hover a bar for numbers.</div>`)}
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:12px">
            ${top('Paths', s.paths)}${top('Visitors (IP)', s.ips)}${s.hosts.length ? top('Domains', s.hosts) : ''}${top('5xx - where', s.errors)}${top('Status codes', s.statuses)}
          </div>`;
      }
      body.querySelector('[data-pp]').onchange = (ev) => go('stats', { p: ev.target.value });
      body.querySelector('[data-again]').onclick = () => draw();
    } else if (tab === 'traefik') {
      const tr = proxies.filter(p => p.kind === 'traefik' && p.running);
      const pid = params.p && tr.some(p => p.id === params.p) ? params.p : (tr[0] || {}).id;
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Asking Traefik...</div></div>';
      let t; try { t = await API.get(`/proxies/${enc(pid)}/traefik`); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      const st = (x) => x === 'enabled' || x === 'UP' ? UI.pill('ok', x === 'UP' ? 'up' : 'on') : x === 'warning' ? UI.pill('warn', 'warning') : x === 'unknown' ? UI.chip('unknown') : UI.pill('bad', e(x === 'DOWN' ? 'down' : x));
      const eps = `<div class="ui-sub" style="margin-bottom:10px">Entry points: ${t.entrypoints.length ? t.entrypoints.map(x => `<span class="td-mono">${e(x.name)}${x.port ? ':' + x.port : ''}</span>`).join(', ') : '-'}, Certificate resolvers: ${t.resolvers.length ? t.resolvers.map(x => `<span class="td-mono">${e(x)}</span>`).join(', ') : 'none'}</div>`;
      if (!t.available) { body.innerHTML = `${eps}<div class="insight-card warning"><div>${e(t.note)}</div></div>`; return; }
      body.innerHTML = `${eps}
        ${t.overview && t.overview.http ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px">${['routers', 'services', 'middlewares'].map(k => { const o = t.overview.http[k] || {}; return `<div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700">${o.total || 0}</div><div style="font-weight:600">${k}</div><div class="ui-sub">${o.warnings ? `${o.warnings} warnings, ` : ''}${o.errors ? `<span style="color:var(--danger)">${o.errors} errors</span>` : 'no errors'}</div></div>`; }).join('')}</div>` : ''}
        ${card('Routers', UI.table([{ label: 'Router' }, { label: 'Rule' }, { label: 'Entry points' }, { label: 'Service' }, { label: 'TLS' }, { label: 'State' }], t.routers.map(r => ({ cells: [`<b>${e(r.name)}</b><div class="ui-sub">${e(r.provider || '')}</div>`, `<span class="td-mono text-xs">${e(r.rule)}</span>`, e((r.entryPoints || []).join(', ')), `<span class="td-mono text-xs">${e(r.service)}</span>`, r.tls ? `${UI.pill('ok', 'TLS')}${r.resolver ? `<div class="ui-sub">${e(r.resolver)}</div>` : ''}` : '-', `${st(r.status)}${r.error ? `<div class="ui-sub" style="color:var(--danger)">${e(r.error)}</div>` : ''}`] })), { minWidth: 0 }))}
        <div style="margin-top:12px">${card('Services and their servers', UI.table([{ label: 'Service' }, { label: 'Servers' }, { label: 'Used by' }, { label: 'State' }], t.services.map(s => ({ cells: [`<b class="td-mono text-xs">${e(s.name)}</b><div class="ui-sub">${e(s.type || '')}</div>`, s.servers.length ? s.servers.map(x => `<div><span class="td-mono text-xs">${e(x.url)}</span> ${st(x.status)}</div>`).join('') : '<span class="ui-sub">-</span>', e((s.usedBy || []).join(', ')), `${st(s.status)}${s.error ? `<div class="ui-sub" style="color:var(--danger)">${e(s.error)}</div>` : ''}`] })), { minWidth: 0 }))}</div>
        <div class="ui-sub" style="margin-top:8px">Live from Traefik's API (port ${t.port} inside the container). Server state shows when a health check is set on the service.</div>`;
    }
    body.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
      const done = busy(b, 'Testing...');
      try { const r = await API.post(`/proxies/${enc(b.dataset.test)}/test`, {}); showModal(r.ok ? 'Config is valid' : 'Config has errors', `<div class="ui-sub" style="margin-bottom:6px"><span class="td-mono">${e(r.command)}</span></div><pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px;color:${r.ok ? 'inherit' : 'var(--danger)'}">${e(r.output || '(no output)')}</pre>`, [{ label: 'Close' }]); }
      catch (er) { showToast(er.message, 'error'); }
      finally { done(); }
    });
    body.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => {
      const done = busy(b, 'Starting...');
      try { const r = await API.post(`/proxies/${enc(b.dataset.start)}/start`, {}); showResult(r.ok ? 'Started' : 'It stopped again', r); if (r.ok) { done(); reloadAll(); return; } }
      catch (er) { showToast(er.message, 'error'); }
      done();
    });
    body.querySelectorAll('[data-files]').forEach(b => b.onclick = () => go('files', { p: b.dataset.files }));
    body.querySelectorAll('[data-logs]').forEach(b => b.onclick = () => go('logs', { p: b.dataset.logs }));
  }
  draw();
});
