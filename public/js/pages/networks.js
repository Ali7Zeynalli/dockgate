// Networks Page
Router.register('networks', async (content) => {
  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  async function render() {
    try {
      const networks = await API.get('/networks');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;
      content.innerHTML = `
        <div class="page-header">
          <div><div class="page-title">Networks</div><div class="page-subtitle">${networks.length} network(s)</div></div>
          <div class="page-actions"><button class="btn btn-secondary" id="net-refresh">${Icons.refresh}</button></div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Name</th><th>Driver</th><th>Scope</th><th>Subnet</th><th>Gateway</th><th>Containers</th><th>Internal</th><th style="text-align:right">Actions</th></tr></thead>
            <tbody>
              ${networks.map(n => `<tr>
                <td class="td-name">${escapeHtml(n.name)}</td>
                <td><span class="badge badge-created">${n.driver}</span></td>
                <td class="text-sm">${n.scope}</td>
                <td class="td-mono">${n.subnet || '—'}</td>
                <td class="td-mono">${n.gateway || '—'}</td>
                <td><span class="badge ${n.containers > 0 ? 'badge-running' : 'badge-dead'}">${n.containers}</span></td>
                <td>${n.internal ? '<span class="badge badge-paused">Yes</span>' : '<span class="badge badge-dead">No</span>'}</td>
                <td><div class="td-actions">
                  <button class="btn-icon" title="Inspect" data-inspect="${n.id}">${Icons.eye}</button>
                  ${!['bridge', 'host', 'none'].includes(n.name) && n.containers === 0 ?
                    `<button class="btn-icon" title="Remove" data-remove="${n.id}" data-name="${escapeHtml(n.name)}" style="color:var(--danger)">${Icons.trash}</button>` : ''}
                </div></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('net-refresh')?.addEventListener('click', render);

      content.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          showConfirm('Remove Network', `Remove <strong>${btn.dataset.name}</strong>?`, async () => {
            try { await API.del(`/networks/${btn.dataset.remove}`); showToast('Network removed'); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      });

      content.querySelectorAll('[data-inspect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const data = await API.get(`/networks/${btn.dataset.inspect}`);
            const containers = Object.entries(data.Containers || {});
            showModal('Network Details', `
              <div class="detail-grid" style="grid-template-columns:1fr">
                <div class="detail-item"><div class="detail-label">Name</div><div class="detail-value">${escapeHtml(data.Name)}</div></div>
                <div class="detail-item"><div class="detail-label">Driver</div><div class="detail-value">${data.Driver}</div></div>
                <div class="detail-item"><div class="detail-label">Scope</div><div class="detail-value">${data.Scope}</div></div>
                <div class="detail-item"><div class="detail-label">Internal</div><div class="detail-value">${data.Internal ? 'Yes' : 'No'}</div></div>
                <div class="detail-item"><div class="detail-label">IPv6</div><div class="detail-value">${data.EnableIPv6 ? 'Enabled' : 'Disabled'}</div></div>
              </div>
              ${containers.length > 0 ? `
                <div class="mt-2"><div class="detail-label mb-1">Connected Containers</div>
                  <div class="table-wrapper"><table><thead><tr><th>Name</th><th>IPv4</th><th>MAC</th></tr></thead>
                    <tbody>${containers.map(([, c]) => `<tr><td class="td-mono">${escapeHtml(c.Name)}</td><td class="td-mono">${c.IPv4Address || '—'}</td><td class="td-mono">${c.MacAddress || '—'}</td></tr>`).join('')}</tbody>
                  </table></div>
                </div>` : ''}
            `, [{ label: 'Close', className: 'btn btn-secondary' }]);
          } catch (err) { showToast(err.message, 'error'); }
        });
      });
    } catch (err) { content.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`; }
  }
  await render();
});
