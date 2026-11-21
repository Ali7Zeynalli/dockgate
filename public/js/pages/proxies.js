// Web → Proxies & SSL (server/proxies.js): the web servers in front of the apps on the server in use — which
// domain goes where, certificates, config files, logs. Read-only for now: "Test config" runs the proxy's own check.
Router.register('proxies', async (content, params = {}) => {
  const navId = Router._navId; const alive = () => Router.isActiveNav(navId);
  const tab = params.tab || 'overview';
  const e = (s) => escapeHtml(String(s == null ? '' : s));
  const srv = Store.get('activeServer') || {};
  const T = [['overview', 'Overview'], ['sites', 'Sites'], ['certs', 'Certificates'], ['files', 'Config files'], ['logs', 'Logs']];
  const go = (t, extra = {}) => Router.navigate('proxies', { tab: t, ...extra }, { replace: true });
  const sslPill = (d) => d == null ? '' : d < 0 ? UI.pill('bad', `expired ${-d} d ago`) : d <= 14 ? UI.pill('warn', `${d} days`) : UI.pill('ok', `${d} days`);
  const card = (t, inner) => `<div class="card" style="padding:14px 16px"><div style="font-weight:600;margin-bottom:8px">${t}</div>${inner}</div>`;
  content.innerHTML = `${UI.header('Proxies & SSL', `The web servers in front of your apps on <b>${e(srv.name || (!srv.id || srv.id === 'local' ? 'Local' : srv.id))}</b>: which domain goes where, certificates, config files and logs.`, `${UI.btn('↻ Refresh', 'data-px-refresh')}`)}
    <div class="tabs" style="margin-bottom:14px">${T.map(([k, l]) => `<button class="tab ${tab === k ? 'active' : ''}" data-ptab="${k}">${l}</button>`).join('')}</div>
    <div id="px-body"><div class="card" style="padding:20px"><div class="skeleton" style="height:120px"></div></div></div>`;
  content.querySelectorAll('[data-ptab]').forEach(b => b.onclick = () => go(b.dataset.ptab));
  const body = content.querySelector('#px-body');
  let d;
  const load = async (fresh) => { d = await API.get(`/proxies${fresh ? '?fresh=1' : ''}`); };
  content.querySelector('[data-px-refresh]').onclick = async () => { try { await load(true); draw(); } catch (er) { showToast(er.message, 'error'); } };
  try { await load(false); } catch (er) { body.innerHTML = UI.errorState(er, { title: 'Proxies could not be read' }); return; }
  if (!alive()) return;

  const siteTarget = (s) => {
    const t = s.target; if (!t) return '<span class="ui-sub">—</span>';
    const sub = t.container ? `${t.container.project ? 'project ' + e(t.container.project) : 'container'}` : e(t.note || '');
    return `<span class="td-mono">${e(t.label)}</span>${sub ? `<div class="ui-sub">${sub}</div>` : ''}${(s.targetsAll || []).length > 1 ? `<div class="ui-sub">+${s.targetsAll.length - 1} more</div>` : ''}`;
  };
  const targetState = (s) => { const t = s.target; if (!t) return ''; if (t.container) return t.container.running ? UI.pill('ok', 'running') : UI.pill('bad', `container ${e(t.container.state)}`); if (t.kind === 'files') return UI.chip('static files'); return UI.pill('warn', t.kind === 'self' ? 'the proxy itself' : t.kind === 'host' ? 'a program on the server' : 'not a container'); };

  async function draw() {
    if (!alive()) return;
    const proxies = d.proxies, sites = d.sites;
    if (!proxies.length) {
      body.innerHTML = `<div class="card" style="padding:24px"><b>No proxy found on ${e(srv.name || 'this server')}.</b><div class="ui-sub" style="margin-top:6px">DockGate looks for nginx, OpenResty, Nginx Proxy Manager, nginx-proxy, Caddy, Traefik, HAProxy and Apache — in containers${d.remote ? ' and as services of the server (systemd)' : ''}. ${d.remote ? '' : 'On the local server, proxies installed on the host (not in containers) are not seen — add the machine as an SSH server for those.'}</div></div>`;
      return;
    }
    if (tab === 'overview') {
      let certSum = null; API.get('/proxies/certs').then(r => { certSum = r; const el = body.querySelector('[data-certsum]'); if (el) el.innerHTML = certTile(r); }).catch(() => {});
      const bad = d.warnings.filter(w => w.level === 'bad').length;
      const certTile = (r) => { if (!r) return '<div class="ui-sub">reading…</div>'; const exp = r.certs.filter(c => c.daysLeft < 0).length, soon = r.certs.filter(c => c.daysLeft >= 0 && c.daysLeft <= 14).length; return `<div style="font-size:22px;font-weight:700;color:${exp ? 'var(--danger)' : soon ? 'var(--warning)' : 'var(--text-primary)'}">${r.certs.length}</div><div style="font-weight:600">certificates</div><div class="ui-sub">${exp ? `${exp} expired · ` : ''}${soon ? `${soon} expire in 14 days` : exp ? '' : 'none expires soon'}</div>`; };
      const web = d.ports.filter(p => p.port === 80 || p.port === 443);
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:12px">
          <div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700">${proxies.length}</div><div style="font-weight:600">prox${proxies.length === 1 ? 'y' : 'ies'}</div><div class="ui-sub">${e([...new Set(proxies.map(p => p.label))].join(' · '))}</div></div>
          <div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700;color:${bad ? 'var(--warning)' : 'var(--text-primary)'}">${sites.length}</div><div style="font-weight:600">sites</div><div class="ui-sub">${sites.filter(s => s.target && s.target.container && !s.target.container.running).length} point to a stopped container</div></div>
          <div class="card" style="padding:14px 16px" data-certsum>${certTile(certSum)}</div>
          <div class="card" style="padding:14px 16px"><div style="font-size:22px;font-weight:700">${web.length ? e([...new Set(web.map(p => p.port))].join(' · ')) : '—'}</div><div style="font-weight:600">${web.length ? e([...new Set(web.map(p => p.process))].join(', ')) : 'nobody'}</div><div class="ui-sub">holds the web ports</div></div>
        </div>
        ${(d.appServers || []).length ? `<div class="ui-sub" style="margin-bottom:8px">Not counted as proxies (they serve their own app): ${d.appServers.map(e).join(', ')}.</div>` : ''}
        ${d.warnings.map(w => `<div class="insight-card ${w.level === 'bad' ? 'danger' : 'warning'}" style="margin-bottom:8px"><div>${e(w.text)}</div></div>`).join('')}
        ${UI.table([{ label: 'Proxy' }, { label: 'Where it runs' }, { label: 'Ports' }, { label: 'Config' }, { label: 'Sites' }, { label: 'State' }, { label: '', align: 'right' }], proxies.map(p => ({ cells: [
          `<b>${e(p.name)}</b><div class="ui-sub">${e(p.label)} ${e(p.version || '')}</div>`,
          p.where === 'host' ? `server · systemd ${e(p.unit)}.service` : `container${p.project ? ' · ' + e(p.project) : ''}`,
          `<span class="td-mono">${e(p.ports.join(', ') || '—')}</span>`,
          `<span class="td-mono text-xs">${e(p.config || '—')}</span>${p.managedBy ? `<div class="ui-sub">🔒 managed by ${e(p.managedBy)}</div>` : ''}${p.problem ? `<div class="ui-sub" style="color:var(--warning)">${e(p.problem)}</div>` : ''}`,
          p.sites, p.running ? UI.pill('ok', e(p.state)) : UI.pill(p.state === 'inactive' ? 'warn' : 'bad', e(p.state)),
          `${p.running && !['traefik', 'caddy-docker-proxy'].includes(p.kind) ? UI.btn('Test config', `data-test="${e(p.id)}"`) : ''} ${UI.btn('Files', `data-files="${e(p.id)}"`)} ${p.running ? UI.btn('Logs', `data-logs="${e(p.id)}"`) : ''}`] })), { minWidth: 0 })}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px;margin-top:12px">
          ${card('Web ports', d.ports.length ? UI.table([{ label: 'Port' }, { label: 'Address' }, { label: 'Process' }], d.ports.map(x => ({ cells: [`<span class="td-mono">${x.port}</span>`, `<span class="td-mono">${e(x.addr)}</span>`, e(x.process)] })), { minWidth: 0 }) : '<div class="ui-sub">Nothing listens on 80, 443, 8080 or 8443.</div>')}
          ${card('How DockGate reads them', `<div class="ui-sub">nginx: <span class="td-mono">nginx -T</span> · Caddy: the Caddyfile · Traefik and caddy-docker-proxy: the labels of containers and Swarm services · HAProxy: haproxy.cfg · Apache: <span class="td-mono">apachectl -S</span> · nginx-proxy: VIRTUAL_HOST of the containers.${d.remote ? ' Services of the server need passwordless sudo to read their configs.' : ' On the local server only proxies in containers are seen.'} Nothing is changed.</div>`)}
        </div>`;
    } else if (tab === 'sites') {
      const q = params.q || '';
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center"><input class="input" data-q placeholder="Search domain or target" value="${e(q)}" style="max-width:320px"><span class="ui-sub">${sites.length} site(s)</span></div><div data-st></div>
        <div class="ui-sub" style="margin-top:8px">A site points to a container when its upstream is a container's name, Compose service or IP on this server.</div>`;
      const drawRows = (q) => {
        const rows = sites.filter(s => !q || (s.domain + ' ' + (s.target ? s.target.label : '')).toLowerCase().includes(q.toLowerCase()));
        body.querySelector('[data-st]').innerHTML = UI.table([{ label: 'Domain' }, { label: 'Goes to' }, { label: 'Proxy' }, { label: 'HTTPS' }, { label: 'Target' }, { label: '', align: 'right' }], rows.map(s => ({ cells: [
          `<b>${e(s.domain)}</b>${s.managed ? `<div class="ui-sub">🔒 ${e(s.managed)}</div>` : ''}`, siteTarget(s), `${e(s.proxyName)}<div class="ui-sub td-mono" title="${e(s.file || '')}">${e(String(s.file || '').split('/').pop())}${s.line ? ':' + s.line : ''}</div>`,
          s.https ? `${UI.pill('ok', 'HTTPS')}${s.redirect ? '<div class="ui-sub">http → https</div>' : ''}` : UI.pill('warn', 'HTTP only'), targetState(s),
          `<a class="btn btn-xs btn-secondary" href="${s.https ? 'https' : 'http'}://${e(s.domain)}" target="_blank" rel="noopener">Open ↗</a> ${UI.btn('+ Uptime check', `data-up="${e(s.domain)}" data-https="${s.https ? 1 : ''}"`)}`] })), { minWidth: 0, empty: 'No site found in the configs.' });
        body.querySelectorAll('[data-up]').forEach(b => b.onclick = async () => {
          try { await API.post('/uptime', { name: b.dataset.up, type: 'http', target: `${b.dataset.https ? 'https' : 'http'}://${b.dataset.up}` }); showToast('Uptime check added', 'success'); b.remove(); } catch (er) { showToast(er.message, 'error'); }
        });
      };
      drawRows(q);
      body.querySelector('[data-q]').oninput = (ev) => drawRows(ev.target.value);
    } else if (tab === 'certs') {
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Reading certificates…</div></div>';
      let r; try { r = await API.get('/proxies/certs'); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      body.innerHTML = `${UI.table([{ label: 'Names' }, { label: 'Issuer' }, { label: 'Kept by' }, { label: 'Expires' }, { label: '' }, { label: 'Renewal' }], r.certs.map(c => ({ cells: [
        `<b>${e(c.names.slice(0, 3).join(', '))}</b>${c.names.length > 3 ? `<div class="ui-sub">+${c.names.length - 3} more</div>` : ''}${c.selfSigned ? '<div class="ui-sub">self-signed</div>' : ''}`,
        e(c.issuer), `${e(c.source)}<div class="ui-sub td-mono" title="${e(c.paths.join('\n'))}">${e(c.paths[0].split('/').slice(-2).join('/'))}</div>`, `<span class="td-mono">${e(c.validTo.slice(0, 10))}</span>`, sslPill(c.daysLeft),
        /none|no renewal/.test(c.renewal) ? UI.pill('bad', e(c.renewal)) : e(c.renewal)] })), { minWidth: 0, empty: 'No certificate found.' })}
        ${r.uncovered.length ? `<div class="insight-card warning" style="margin-top:10px"><div>HTTPS sites whose certificate DockGate could not read: ${r.uncovered.map(e).join(', ')}</div></div>` : ''}
        ${r.notes.length ? `<details style="margin-top:8px"><summary class="ui-sub">Notes (${r.notes.length})</summary><div class="ui-sub">${r.notes.map(e).join('<br>')}</div></details>` : ''}
        <div class="ui-sub" style="margin-top:8px">Read from the files nginx names (<span class="td-mono">ssl_certificate</span>), certbot's <span class="td-mono">/etc/letsencrypt/live</span>${d.remote ? '' : ' (SSH servers)'}, Caddy's data folder and Traefik's acme.json. Uptime's HTTPS checks warn 14 days before a certificate expires.</div>`;
    } else if (tab === 'files') {
      const withFiles = proxies.filter(p => p.running);
      const pid = params.p && withFiles.some(p => p.id === params.p) ? params.p : (withFiles[0] || {}).id;
      if (!pid) { body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">No running proxy.</div></div>'; return; }
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Reading…</div></div>';
      let r; try { r = await API.get(`/proxies/${encodeURIComponent(pid)}/files`); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      const fi = Math.min(Number(params.f) || 0, Math.max(0, r.files.length - 1)); const f = r.files[fi];
      const hl = (s) => e(s).replace(/(#[^\n]*)/g, '<span style="color:var(--text-muted)">$1</span>').replace(/\b(server|listen|server_name|location|proxy_pass|proxy_set_header|ssl_certificate_key|ssl_certificate|client_max_body_size|upstream|include|return|root|reverse_proxy|tls|encode|frontend|backend|bind|use_backend|default_backend|acl)\b/g, '<span style="color:var(--accent)">$1</span>').replace(/(\$\w+)/g, '<span style="color:var(--warning)">$1</span>');
      body.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><select class="select" data-pp style="max-width:320px">${withFiles.map(p => `<option value="${e(p.id)}" ${p.id === pid ? 'selected' : ''}>${e(p.name)} — ${e(p.label)}</option>`).join('')}</select><span class="ui-sub">${r.files.length} file(s)</span></div>
        ${r.files.length ? `<div style="display:grid;grid-template-columns:280px minmax(0,1fr);gap:12px;align-items:start">
          <div class="card" style="padding:8px;max-height:560px;overflow:auto">${r.files.map((x, i) => `<button type="button" class="btn btn-xs ${i === fi ? 'btn-primary' : 'btn-ghost'}" data-fi="${i}" style="display:block;width:100%;text-align:left;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${e(x.path)}">${x.managed ? '🔒 ' : '📄 '}${e(x.path)}</button>`).join('')}</div>
          <div class="card" style="padding:0;overflow:hidden">
            <div style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border)"><b class="td-mono">${e(f.path)}</b>${f.managed ? UI.chip('managed by ' + e(f.managed)) : ''}<span style="flex:1"></span>${UI.chip('read-only')}</div>
            <pre class="td-mono" style="margin:0;padding:12px 14px;font-size:12.5px;line-height:1.55;background:var(--bg-primary);max-height:560px;overflow:auto">${hl(f.text)}</pre>
          </div></div>` : `<div class="card" style="padding:20px"><div class="ui-sub">${e(r.note || 'No files.')}</div></div>`}
        <div class="ui-sub" style="margin-top:8px">Editing with a check, reload and automatic undo comes in the next step.</div>`;
      body.querySelector('[data-pp]').onchange = (ev) => go('files', { p: ev.target.value });
      body.querySelectorAll('[data-fi]').forEach(b => b.onclick = () => go('files', { p: pid, f: b.dataset.fi }));
    } else if (tab === 'logs') {
      const running = proxies.filter(p => p.running && p.kind !== 'certbot');
      const pid = params.p && running.some(p => p.id === params.p) ? params.p : (running[0] || {}).id;
      const which = params.which || 'access';
      if (!pid) { body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">No running proxy.</div></div>'; return; }
      body.innerHTML = '<div class="card" style="padding:20px"><div class="ui-sub">Reading…</div></div>';
      let r; try { r = await API.get(`/proxies/${encodeURIComponent(pid)}/logs?which=${which}&tail=500`); } catch (er) { body.innerHTML = UI.errorState(er); return; }
      if (!alive()) return;
      const col = (s) => s >= 500 ? 'var(--danger)' : s >= 400 ? 'var(--warning)' : s >= 300 ? 'var(--accent)' : 'var(--success)';
      const render = (filter, cls) => r.entries.filter(x => (!filter || x.line.toLowerCase().includes(filter.toLowerCase())) && (!cls || (x.status && String(x.status)[0] === cls))).slice(-500).map(x => x.status
        ? `<span class="ui-sub">${e(x.time || '')}</span>  <b style="color:${col(x.status)}">${x.status}</b>  ${e((x.method || '').padEnd(6))}${x.host ? e(x.host) + ' ' : ''}${e(x.path || '')}${x.ms != null ? `  <span class="ui-sub">${x.ms} ms</span>` : ''}  <span class="ui-sub">${e(x.ip || '')}</span>`
        : `<span class="ui-sub">${e(x.line)}</span>`).join('\n');
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center"><select class="select" data-pp style="max-width:260px">${running.map(p => `<option value="${e(p.id)}" ${p.id === pid ? 'selected' : ''}>${e(p.name)}</option>`).join('')}</select>
        <select class="select" data-wh style="max-width:140px"><option value="access" ${which === 'access' ? 'selected' : ''}>access</option><option value="error" ${which === 'error' ? 'selected' : ''}>error</option><option value="all" ${which === 'all' ? 'selected' : ''}>all</option></select>
        ${['2', '3', '4', '5'].map(c => `<button type="button" class="btn btn-xs btn-secondary" data-cls="${c}">${c}xx</button>`).join('')}<input class="input" data-flt placeholder="IP, path or domain" style="max-width:240px"></div>
        <div class="card" style="padding:0;overflow:hidden"><pre class="td-mono" data-log style="margin:0;padding:12px 14px;font-size:12.5px;line-height:1.7;background:var(--bg-primary);max-height:560px;overflow:auto">${render('', '') || '<span class="ui-sub">No lines.</span>'}</pre></div>
        ${r.stats ? `<div class="ui-sub" style="margin-top:8px">Last ${r.stats.requests} requests: ${r.stats.s4xx} with 4xx, ${r.stats.s5xx} with 5xx (${(100 * r.stats.s5xx / r.stats.requests).toFixed(1)} %).</div>` : ''}`;
      let cls = '';
      const re = () => { const el = body.querySelector('[data-log]'); el.innerHTML = render(body.querySelector('[data-flt]').value, cls) || '<span class="ui-sub">No lines.</span>'; el.scrollTop = el.scrollHeight; };
      body.querySelector('[data-pp]').onchange = (ev) => go('logs', { p: ev.target.value, which });
      body.querySelector('[data-wh]').onchange = (ev) => go('logs', { p: pid, which: ev.target.value });
      body.querySelector('[data-flt]').oninput = re;
      body.querySelectorAll('[data-cls]').forEach(b => b.onclick = () => { cls = cls === b.dataset.cls ? '' : b.dataset.cls; body.querySelectorAll('[data-cls]').forEach(x => x.classList.toggle('btn-primary', x.dataset.cls === cls)); re(); });
      const el = body.querySelector('[data-log]'); el.scrollTop = el.scrollHeight;
    }
    body.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Testing…';
      try { const r = await API.post(`/proxies/${encodeURIComponent(b.dataset.test)}/test`, {}); showModal(r.ok ? 'Config is valid' : 'Config has errors', `<div class="ui-sub" style="margin-bottom:6px"><span class="td-mono">${e(r.command)}</span></div><pre class="td-mono text-xs" style="white-space:pre-wrap;background:var(--bg-tertiary);padding:8px;border-radius:6px;color:${r.ok ? 'inherit' : 'var(--danger)'}">${e(r.output || '(no output)')}</pre>`, [{ label: 'Close' }]); }
      catch (er) { showToast(er.message, 'error'); }
      finally { b.disabled = false; b.textContent = 'Test config'; }
    });
    body.querySelectorAll('[data-files]').forEach(b => b.onclick = () => go('files', { p: b.dataset.files }));
    body.querySelectorAll('[data-logs]').forEach(b => b.onclick = () => go('logs', { p: b.dataset.logs }));
  }
  draw();
});
