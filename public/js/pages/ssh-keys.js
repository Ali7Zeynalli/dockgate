// SSH Keys — reusable keypairs for Git-over-SSH deploys (deploy keys / machine-user keys).
// Extracted from settings.js into a global renderSshKeysInto(content) so it can be embedded
// anywhere; it now lives in the Servers section alongside Servers + Registries (all credential/
// connection setup in one place). The private key is encrypted at rest and never leaves the server.

function skShowPublic(k) {
  const body = `
    <div class="text-xs text-muted" style="margin-bottom:8px">Add this <b>public</b> key to your Git host:
      <ul style="margin:6px 0;padding-left:18px">
        <li><b>Many repos</b> → a machine/bot account (GitHub: Settings → SSH and GPG keys)</li>
        <li><b>One repo</b> → that repo's Settings → Deploy keys (leave write access OFF)</li>
      </ul>
    </div>
    <textarea class="input" readonly id="sk-pub" style="width:100%;height:110px;font-family:var(--font-mono,monospace);font-size:12px;white-space:pre-wrap;word-break:break-all">${escapeHtml(k.public_key)}</textarea>
    <div class="text-xs text-muted" style="margin-top:6px">Fingerprint: <span class="td-mono">${escapeHtml(k.fingerprint || '')}</span></div>`;
  const m = showModal(`Public key — ${escapeHtml(k.name)}`, body, [{ label: 'Close', className: 'btn btn-secondary' }]);
  const copy = document.createElement('button');
  copy.className = 'btn btn-primary'; copy.textContent = '📋 Copy';
  m.overlay.querySelector('#modal-footer').appendChild(copy);
  copy.onclick = () => { navigator.clipboard?.writeText(k.public_key).then(() => showToast('Copied')); };
}

function skGenerateModal(onDone) {
  const m = showModal('Generate SSH key', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Name *</label><input class="input" id="skg-name" placeholder="github-bot"></div>
      <div class="input-group"><label>Description</label><input class="input" id="skg-desc" placeholder="optional"></div>
      <div class="input-group"><label>Type</label>
        <select class="select" id="skg-type"><option value="ed25519">ed25519 (recommended)</option><option value="rsa">RSA-4096 (legacy)</option></select>
      </div>
    </div>`, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
  const go = document.createElement('button');
  go.className = 'btn btn-primary'; go.textContent = 'Generate';
  m.overlay.querySelector('#modal-footer').appendChild(go);
  go.onclick = async () => {
    const name = m.overlay.querySelector('#skg-name').value.trim();
    if (!name) return showToast('Name required', 'warning');
    go.disabled = true; go.textContent = 'Generating…';
    try {
      const r = await API.post('/ssh-keys', { name, description: m.overlay.querySelector('#skg-desc').value, type: m.overlay.querySelector('#skg-type').value });
      m.close(); showToast('Key generated'); onDone && onDone(); skShowPublic(r.key);
    } catch (e) { showToast(e.message, 'error'); go.disabled = false; go.textContent = 'Generate'; }
  };
}

function skImportModal(onDone) {
  const m = showModal('Import SSH key', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="input-group"><label>Name *</label><input class="input" id="ski-name" placeholder="my-key"></div>
      <div class="input-group"><label>Description</label><input class="input" id="ski-desc" placeholder="optional"></div>
      <div class="input-group"><label>Private key (OpenSSH, no passphrase) *</label>
        <textarea class="input" id="ski-priv" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="height:140px;font-family:var(--font-mono,monospace);font-size:12px;white-space:pre"></textarea>
      </div>
    </div>`, [{ label: 'Cancel', className: 'btn btn-secondary' }]);
  const go = document.createElement('button');
  go.className = 'btn btn-primary'; go.textContent = 'Import';
  m.overlay.querySelector('#modal-footer').appendChild(go);
  go.onclick = async () => {
    const name = m.overlay.querySelector('#ski-name').value.trim();
    const priv = m.overlay.querySelector('#ski-priv').value;
    if (!name) return showToast('Name required', 'warning');
    if (!priv.trim()) return showToast('Private key required', 'warning');
    go.disabled = true; go.textContent = 'Importing…';
    try {
      const r = await API.post('/ssh-keys/import', { name, description: m.overlay.querySelector('#ski-desc').value, privateKey: priv });
      m.close(); showToast('Key imported'); onDone && onDone(); skShowPublic(r.key);
    } catch (e) { showToast(e.message, 'error'); go.disabled = false; go.textContent = 'Import'; }
  };
}

// Render the SSH Keys manager into `content` (embedded inside the Servers section's tab body).
async function renderSshKeysInto(content, { embedded = false } = {}) {
  const reload = () => renderSshKeysInto(content, { embedded });
  content.innerHTML = `
    <div class="settings-section" style="max-width:760px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          <div class="settings-section-title">SSH Keys</div>
          <div class="settings-row-desc">Reusable keypairs for Git deploys (deploy keys / machine-user keys). The private key is encrypted at rest and never leaves the server.</div>
        </div>
        <div style="display:flex;gap:6px;flex:none">
          <button class="btn btn-primary btn-sm" id="sk-gen">+ Generate</button>
          <button class="btn btn-secondary btn-sm" id="sk-import">Import</button>
        </div>
      </div>
      <details class="card" style="margin-top:12px;padding:10px 14px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">ⓘ How SSH keys work — generate / import / export / use</summary>
        <div class="text-sm" style="line-height:1.6;margin-top:8px;color:var(--text-secondary)">
          <p style="margin:0 0 8px">A reusable SSH keypair authenticates <strong>Git over SSH</strong> (<code>git@github.com:owner/repo.git</code>) — create it once and use it for many repos, instead of pasting a token per project.</p>
          <p style="margin:8px 0 4px"><strong>① Create or import</strong></p>
          <ul style="margin:0 0 8px;padding-left:18px">
            <li><strong>+ Generate</strong> — DockGate makes a fresh keypair (<strong>ed25519</strong> recommended, or RSA-4096).</li>
            <li><strong>Import</strong> — paste an existing <strong>private</strong> key (OpenSSH or PEM). DockGate derives its public key + fingerprint automatically.</li>
          </ul>
          <p style="margin:8px 0 4px"><strong>② Add the PUBLIC key to your Git host</strong></p>
          <ul style="margin:0 0 8px;padding-left:18px">
            <li>Click <strong>Public key</strong> on a key below to copy it.</li>
            <li><strong>One repo</strong> (read-only) → the repo's <em>Settings → Deploy keys</em>.</li>
            <li><strong>Many repos</strong> → add it to a <em>machine-user account</em>'s SSH keys.</li>
          </ul>
          <p style="margin:8px 0 4px"><strong>③ Use it to deploy</strong></p>
          <ul style="margin:0 0 8px;padding-left:18px">
            <li>In <strong>Deploy from Git</strong>, set <strong>Auth = SSH key</strong> and pick this key; use the SSH URL (<code>git@host:owner/repo.git</code>).</li>
            <li>Optional: <strong>Test key ↔ repo</strong> checks access before you deploy.</li>
          </ul>
          <p style="margin:8px 0 0"><strong>Export &amp; security</strong> — only the <strong>public</strong> key can be copied (to add to the host). The <strong>private</strong> key is <strong>never shown or downloadable</strong>: it's AES-256-GCM encrypted at rest, never returned by the API, and only written to a temporary <code>0600</code> file during a deploy, then shredded. It never leaves the server.</p>
        </div>
      </details>
      <div id="sk-list" style="margin-top:14px"><div class="text-muted text-sm">Loading…</div></div>
    </div>`;
  document.getElementById('sk-gen').onclick = () => skGenerateModal(reload);
  document.getElementById('sk-import').onclick = () => skImportModal(reload);
  const el = document.getElementById('sk-list');
  let keys = [];
  try { keys = await API.get('/ssh-keys'); }
  catch (e) { el.innerHTML = `<div class="text-danger text-sm">${escapeHtml(e.message)}</div>`; return; }
  if (!keys.length) { el.innerHTML = `<div class="text-muted text-sm" style="padding:14px 0">No SSH keys yet. Generate one, then add its public key to your Git host (a machine account for many repos, or a single repo's Deploy Keys).</div>`; return; }
  el.innerHTML = keys.map(k => `
    <div class="card" style="padding:12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div>
          <span style="font-weight:600">${escapeHtml(k.name)}</span>
          <span class="badge badge-running" style="font-size:10px;margin-left:6px">${escapeHtml(k.key_type)}</span>
          ${k.description ? `<div class="text-xs text-muted">${escapeHtml(k.description)}</div>` : ''}
          <div class="text-xs text-muted td-mono" style="margin-top:2px">${escapeHtml(k.fingerprint || '')}</div>
        </div>
        <div style="display:flex;gap:6px;flex:none">
          <button class="btn btn-xs btn-secondary" data-skpub="${k.id}">Public key</button>
          <button class="btn btn-xs btn-secondary text-danger" data-skdel="${k.id}" data-skname="${escapeHtml(k.name)}">Delete</button>
        </div>
      </div>
    </div>`).join('');
  el.querySelectorAll('[data-skpub]').forEach(b => b.onclick = () => skShowPublic(keys.find(x => String(x.id) === b.dataset.skpub)));
  el.querySelectorAll('[data-skdel]').forEach(b => b.onclick = () => {
    showDeleteConfirm('Delete SSH key', { message: `Delete "${b.dataset.skname}"? Any Git deploy using it will stop working.`, phrase: b.dataset.skname, onConfirm: async () => {
      try { await API.delete(`/ssh-keys/${b.dataset.skdel}`); showToast('Deleted'); reload(); }
      catch (e) { showToast(e.message, 'error'); }
    } });
  });
}
