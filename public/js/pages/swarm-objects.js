// Swarm → Secrets & configs and Swarm → Networks — phase 5.
//   Secrets & configs: create, view a config, Rotate (secret) / Edit (config) as a job — a new version
//   <name>_v2, services move to it with rolling updates, the old one is removed —, Remove when unused.
//   Networks: overlay networks with who uses them; New overlay network (encrypted, attachable, internal);
//   Remove when unused; Change subnet… of the ingress network when no service publishes through it.
// Server side: server/swarm-objects.js.

(() => {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const job = (...a) => window.SwarmUI.openJob(...a);
  const ago = (t) => `<span class="ui-sub" title="${esc(formatTime(t))}">${esc(timeAgo(t))}</span>`;
  const users = (list) => (list.length ? list.map(u => `<span class="text-sm">${esc(u.name)}</span>${u.target ? ` <span class="ui-sub td-mono">${esc(u.target)}</span>` : ''}`).join('<br>') : '<span class="ui-sub">not used</span>');

  function newDialog(kind, done) {
    UI.dialog({ title: kind === 'secret' ? 'New secret' : 'New config', wide: kind === 'config', saveLabel: 'Create',
      body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input" data-name placeholder="${kind === 'secret' ? 'db_password' : 'nginx_conf'}"></label>
        <label class="ui-field"><span class="ui-label">${kind === 'secret' ? 'Value' : 'File content'}</span>${kind === 'secret'
          ? '<textarea class="input" data-value rows="3" autocomplete="off" style="font-family:var(--font-mono,monospace)"></textarea><span class="ui-sub">Sent to Swarm only — DockGate does not store or log it, and it is not shown again. In a task it is the file /run/secrets/&lt;name&gt; (readable only inside the task). Apps read it through *_FILE variables, e.g. POSTGRES_PASSWORD_FILE=/run/secrets/db_password.</span>'
          : '<textarea class="input" data-value rows="14" style="font-family:var(--font-mono,monospace)" placeholder="server {\n  listen 80;\n}"></textarea><span class="ui-sub">In a task it is a file at the path you choose in the service (Settings → Env &amp; secrets → Configs). Not encrypted — use a secret for passwords.</span>'}</label>`,
      onSave: async (ov) => { await API.post(`/swarm/objects/${kind}`, { name: ov.querySelector('[data-name]').value.trim(), value: ov.querySelector('[data-value]').value }); showToast(`${kind === 'secret' ? 'Secret' : 'Config'} created`); done(); } });
  }
  async function rotateDialog(x, done) {
    let content = '';
    if (x.kind === 'config') { try { content = (await API.get(`/swarm/objects/config/${x.id}/content`)).content; } catch (e) { return showToast(e.message, 'error'); } }
    const next = (() => { const m = /^(.*)_v(\d+)$/.exec(x.name); return m ? `${m[1]}_v${Number(m[2]) + 1}` : `${x.name}_v2`; })();
    UI.dialog({ title: `${x.kind === 'secret' ? 'Rotate' : 'Edit'} ${x.name}`, wide: x.kind === 'config', saveLabel: x.kind === 'secret' ? 'Rotate' : 'Save',
      body: `<label class="ui-field"><span class="ui-label">${x.kind === 'secret' ? 'New value' : 'Content'}</span><textarea class="input" data-value rows="${x.kind === 'secret' ? 3 : 14}" autocomplete="off" style="font-family:var(--font-mono,monospace)">${x.kind === 'config' ? esc(content) : ''}</textarea></label>
        <div class="insight-card info"><div>Swarm can not change a ${x.kind}. DockGate creates <b class="td-mono">${esc(next)}</b>, moves ${x.usedBy.length ? `<b>${x.usedBy.map(u => esc(u.name)).join(', ')}</b>` : 'the services that use it'} to it one service at a time with a rolling update (the file path in the container stays the same), then removes <span class="td-mono">${esc(x.name)}</span>. If an update fails, it stops and the old one stays.${x.stack ? ` <b>It belongs to stack ${esc(x.stack)}:</b> change it in the compose file too, or the next stack deploy uses the file's value again.` : ''}</div></div>`,
      onSave: async (ov) => { const r = await API.post(`/swarm/objects/${x.kind}/${x.id}/rotate`, { value: ov.querySelector('[data-value]').value }); job(r.jobId, done, x.kind === 'secret' ? 'Rotate secret' : 'Edit config'); } });
  }

  Router.register('swarm-secrets', async (content) => {
    window.SwarmUI.css();
    const navId = Router._navId;
    async function load() {
      let d;
      try { d = await API.get('/swarm/objects'); }
      catch (e) { content.innerHTML = UI.header('Secrets & configs', esc(e.message), UI.btn('Open Overview', 'data-go')); content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' }); return; }
      if (!Router.isActiveNav(navId)) return;
      const table = (list, kind) => UI.table([{ label: 'Name' }, { label: 'Used by · path' }, { label: 'Created' }, { label: kind === 'config' ? 'Size' : 'Origin' }, { label: '', align: 'right' }], list.map(x => ({ cells: [
        `<b class="td-mono">${esc(x.name)}</b>${x.labels['dockgate.rotated-from'] ? `<div class="ui-sub">rotated from ${esc(x.labels['dockgate.rotated-from'])}</div>` : ''}`,
        users(x.usedBy), ago(x.createdAt),
        kind === 'config' ? `<span class="ui-sub">${x.size} bytes</span>` : (x.stack ? UI.chip(`stack ${esc(x.stack)}`) : x.labels['dockgate.created'] ? '<span class="ui-sub">DockGate</span>' : '<span class="ui-sub">outside DockGate</span>'),
        UI.menu([
          kind === 'config' ? { label: 'View', attrs: `data-a="view" data-k="${kind}" data-id="${x.id}"` } : null,
          { label: kind === 'secret' ? 'Rotate…' : 'Edit…', attrs: `data-a="rotate" data-k="${kind}" data-id="${x.id}"` },
          '-',
          { label: 'Remove…', attrs: `data-a="remove" data-k="${kind}" data-id="${x.id}"` },
        ]),
      ] })), { minWidth: 720, empty: kind === 'secret' ? 'No secrets yet.' : 'No configs yet.' });
      content.innerHTML = `${UI.header('Secrets', 'Passwords, keys and certificates kept encrypted by Swarm and given only to the services that use them. DockGate never stores their values.', UI.primary('New secret…', 'data-new="secret"'))}
        ${table(d.secrets, 'secret')}
        <div style="height:18px"></div>
        ${UI.header('Configs', 'Configuration files (nginx.conf, app settings) Swarm puts into the tasks. Not encrypted — use secrets for passwords.', UI.primary('New config…', 'data-new="config"'))}
        ${table(d.configs, 'config')}`;
      content.querySelectorAll('[data-new]').forEach(b => b.onclick = () => newDialog(b.dataset.new, load));
      content.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', async () => {
        const x = (b.dataset.k === 'secret' ? d.secrets : d.configs).find(y => y.id === b.dataset.id); if (!x) return;
        if (b.dataset.a === 'rotate') return rotateDialog(x, load);
        if (b.dataset.a === 'view') {
          try { const r = await API.get(`/swarm/objects/config/${x.id}/content`); const m = showModal(`Config ${esc(x.name)}`, `<pre class="log-viewer" style="max-height:60vh;white-space:pre-wrap">${esc(r.content)}</pre>`, [{ label: 'Close', className: 'btn btn-secondary' }]); m.overlay.querySelector('.modal')?.classList.add('ui-modal-wide'); }
          catch (e) { showToast(e.message, 'error'); }
          return;
        }
        if (b.dataset.a === 'remove') {
          if (x.usedBy.length) return showToast(`Still used by ${x.usedBy.map(u => u.name).join(', ')} — rotate or remove those services first`, 'error', 9000);
          return showDeleteConfirm(`Remove ${x.kind} ${x.name}`, { message: `The ${x.kind} is removed from Swarm. No service uses it.${x.kind === 'secret' ? ' Its value can not be recovered.' : ''}`, phrase: x.name, confirmLabel: 'Remove',
            onConfirm: async () => { try { await API.del(`/swarm/objects/${x.kind}/${x.id}`); showToast('Removed'); load(); } catch (e) { showToast(e.message, 'error', 9000); } } });
        }
      }));
    }
    await load();
  });

  Router.register('swarm-networks', async (content) => {
    window.SwarmUI.css();
    const navId = Router._navId;
    async function load() {
      let nets;
      try { nets = (await API.get('/swarm/networks')).networks; }
      catch (e) { content.innerHTML = UI.header('Networks', esc(e.message), UI.btn('Open Overview', 'data-go')); content.querySelector('[data-go]').onclick = () => Router.navigate('swarm', { tab: 'swarm-overview' }); return; }
      if (!Router.isActiveNav(navId)) return;
      content.innerHTML = `${UI.header('Networks', 'Overlay networks connect services across the servers; services on the same network reach each other by name. The ingress network carries published ingress ports to the tasks.', UI.primary('New overlay network…', 'data-new'))}
        ${UI.table([{ label: 'Network' }, { label: 'Subnet' }, { label: 'Options' }, { label: 'Used by' }, { label: '', align: 'right' }], nets.map(n => ({ cells: [
          `<b class="td-mono">${esc(n.name)}</b>${n.ingress ? ' ' + UI.pill('info', 'ingress') : ''}${n.stack ? ' ' + UI.chip(`stack ${esc(n.stack)}`) : ''}`,
          `<span class="td-mono text-sm">${esc(n.subnets.join(', ') || '—')}</span>${(n.gateways || []).length ? `<div class="ui-sub">gateway ${esc(n.gateways.join(', '))}</div>` : ''}`,
          [n.encrypted ? UI.pill('ok', 'encrypted') : '', n.attachable ? UI.chip('attachable') : '', n.internal ? UI.chip('internal') : ''].filter(Boolean).join(' ') || '<span class="ui-sub">—</span>',
          n.usedBy.length ? `<span class="text-sm">${n.usedBy.map(esc).join(', ')}</span>${n.ingress ? '<div class="ui-sub">publish ingress ports</div>' : ''}` : '<span class="ui-sub">not used</span>',
          n.ingress ? UI.btn('Change subnet…', `data-ingress="${n.id}"`) : UI.btn('Remove…', `data-rm="${n.id}"`),
        ] })), { minWidth: 760 })}`;
      content.querySelector('[data-new]').onclick = () => UI.dialog({ title: 'New overlay network', saveLabel: 'Create',
        body: `<label class="ui-field"><span class="ui-label">Name</span><input class="input" data-n placeholder="backend"></label>
          <label class="text-sm"><input type="checkbox" data-enc> Encrypted (IPsec between the servers)</label><div class="ui-sub" style="margin:2px 0 8px">For traffic over public addresses. DockGate allows ESP between the cluster servers it manages. Costs some CPU.</div>
          <label class="text-sm"><input type="checkbox" data-att checked> Attachable</label><div class="ui-sub" style="margin:2px 0 8px">Plain containers (Compose, docker run) can join it and talk to the services.</div>
          <label class="text-sm"><input type="checkbox" data-int> Internal</label><div class="ui-sub" style="margin:2px 0 8px">No traffic to the internet from this network.</div>
          <label class="ui-field"><span class="ui-label">Subnet (optional)</span><input class="input" data-sub placeholder="empty = from the swarm's address pool"></label>`,
        onSave: async (ov) => {
          const r = await API.post('/swarm/networks', { name: ov.querySelector('[data-n]').value.trim(), encrypted: ov.querySelector('[data-enc]').checked, attachable: ov.querySelector('[data-att]').checked, internal: ov.querySelector('[data-int]').checked, subnet: ov.querySelector('[data-sub]').value.trim() });
          const fw = r.firewall && r.firewall.servers ? r.firewall.servers.filter(s => !s.done && s.why !== 'already allowed') : [];
          showToast(`Network created${fw.length ? ` — check the firewall: ${fw.map(s => `${s.node}: ${s.why}`).join('; ')}` : ''}`, fw.length ? 'warning' : 'success', fw.length ? 12000 : 4000);
          load();
        } });
      content.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
        const n = nets.find(x => x.id === b.dataset.rm); if (!n) return;
        if (n.usedBy.length) return showToast(`Used by ${n.usedBy.join(', ')} — remove it from those services first`, 'error', 9000);
        showDeleteConfirm(`Remove network ${n.name}`, { message: 'No service uses it.', phrase: n.name, confirmLabel: 'Remove', onConfirm: async () => { try { await API.del(`/swarm/networks/${n.id}`); showToast('Removed'); load(); } catch (e) { showToast(e.message, 'error', 9000); } } });
      });
      content.querySelectorAll('[data-ingress]').forEach(b => b.onclick = () => {
        const n = nets.find(x => x.id === b.dataset.ingress);
        if (n.usedBy.length) return showToast(`${n.usedBy.join(', ')} publish ports through ingress — change them to host ports or remove them first`, 'error', 10000);
        UI.dialog({ title: 'Change the ingress subnet', danger: true, saveLabel: 'Change',
          body: `<p class="text-sm">Now <span class="td-mono">${esc(n.subnets.join(', '))}</span>. Change it when it overlaps a network the servers use (a cloud private network). The ingress network is removed and created again with the new subnet; no service publishes through it now.</p>
            <label class="ui-field"><span class="ui-label">New subnet</span><input class="input" data-sub placeholder="10.250.0.0/24"></label>`,
          onSave: async (ov) => { await API.post('/swarm/networks/ingress', { subnet: ov.querySelector('[data-sub]').value.trim(), confirm: true }); showToast('Ingress subnet changed'); load(); } });
      });
    }
    await load();
  });
})();
