// Resources → Prune (was Activity → Cleanup). One table: each kind of unused data, what exactly would be
// removed and how much space it frees. Pick rows, then "Prune selected" asks once and runs them in order.
// Volumes are never pre-selected because pruning them deletes data. Full system prune sits in a danger zone.
async function renderCleanupInto(content, { embedded = false } = {}) {
  const pageNavId = Router._navId;
  let picked = null; // Set of row ids the user ticked; null = use the safe defaults

  const names = (list, key = 'name', max = 4) => {
    const n = (list || []).map(x => typeof key === 'function' ? key(x) : x[key]).filter(Boolean);
    return n.length ? escapeHtml(n.slice(0, max).join(', ')) + (n.length > max ? ` and ${n.length - max} more` : '') : '';
  };

  async function render() {
    try {
      const preview = await API.get('/cleanup/preview');
      if (!Router.isActiveNav(pageNavId)) return;
      const est = preview.estimatedSpace || {};
      const rows = [
        { id: 'containers', title: 'Stopped containers', count: preview.stoppedContainers.length, size: null,
          what: names(preview.stoppedContainers), note: 'Their volumes stay.', safe: true },
        { id: 'images', title: 'Unused images', count: preview.unusedImages.length, size: est.images || 0,
          what: names(preview.unusedImages, i => (i.repoTags && i.repoTags[0] !== '<none>:<none>') ? i.repoTags[0] : i.shortId), note: 'Images no container uses. They can be pulled again.', safe: true },
        { id: 'build_cache', title: 'Build cache', count: est.buildCache > 0 ? 1 : 0, size: est.buildCache || 0,
          what: est.buildCache > 0 ? 'cached build layers' : '', note: 'The next build takes longer.', safe: true },
        { id: 'networks', title: 'Unused networks', count: preview.unusedNetworks.length, size: null,
          what: names(preview.unusedNetworks), note: 'Networks you created that no container is attached to.', safe: true },
        { id: 'volumes', title: 'Unused volumes', count: preview.unusedVolumes.length, size: null,
          what: names(preview.unusedVolumes), note: 'Deletes the data inside them for good.', safe: false },
      ];
      if (!picked) picked = new Set(rows.filter(r => r.safe && r.count > 0).map(r => r.id));
      for (const r of rows) if (!r.count) picked.delete(r.id);
      const sel = rows.filter(r => picked.has(r.id));
      const frees = sel.reduce((a, r) => a + (r.size || 0), 0);
      const nothing = rows.every(r => !r.count);

      content.innerHTML = `
        ${UI.header('Prune', 'Free disk space by removing data nothing uses. Pick what to remove; nothing is deleted until you confirm.',
          `<button class="btn btn-secondary btn-sm" id="cleanup-refresh" title="Refresh">${Icons.refresh}</button>
           <button class="btn btn-danger btn-sm" id="prune-selected" ${sel.length ? '' : 'disabled'}>${Icons.trash} Prune selected…</button>`)}
        ${UI.table(
          [{ label: '', width: '40px' }, { label: 'What' }, { label: 'Will remove' }, { label: 'Frees', align: 'right' }],
          rows.map(r => ({
            cls: r.count ? '' : 'ui-row-muted',
            cells: [
              `<input type="checkbox" data-pick="${r.id}" ${picked.has(r.id) ? 'checked' : ''} ${r.count ? '' : 'disabled'} aria-label="${r.title}" style="width:16px;height:16px">`,
              `<b>${r.title}</b>${r.count ? ` <span class="ui-sub">${r.count}</span>` : ''}${r.safe ? '' : ' ' + UI.pill('warn', 'deletes data')}`,
              r.count ? `${r.what}<div class="ui-sub">${r.note}</div>` : '<span class="text-muted">Nothing to remove</span>',
              r.size ? `<span style="font-variant-numeric:tabular-nums">${formatBytes(r.size)}</span>` : '<span class="text-muted">—</span>',
            ],
          })),
          { minWidth: 620 })}
        ${UI.statusLine([
          nothing ? 'This server has nothing unused to remove.' : `Selected: <b>${sel.length ? sel.map(r => r.title.toLowerCase()).join(', ') : 'nothing'}</b>`,
          frees ? `Frees about <b>${formatBytes(frees)}</b>` : '',
        ])}

        <div class="ui-ph" style="margin-top:28px"><div class="ui-ph-text"><div class="ui-ph-title" style="color:var(--danger)">Danger zone</div></div></div>
        <div style="border:1px solid var(--danger);border-radius:var(--radius-lg);overflow:hidden">
          ${UI.settings([{
            label: 'Full system prune',
            desc: 'Runs docker system prune: every stopped container, unused network and unused image, plus the build cache. Tick the box to also delete unused volumes and their data.',
            value: `<label style="display:flex;align-items:center;gap:6px;cursor:pointer" class="text-sm"><input type="checkbox" id="prune-volumes" style="width:15px;height:15px"> Include volumes</label>`,
            action: `<button class="btn btn-xs btn-secondary" id="full-prune-btn" style="color:var(--danger)">${Icons.trash} Full prune…</button>`,
          }])}
        </div>
      `;

      document.getElementById('cleanup-refresh')?.addEventListener('click', render);
      content.querySelectorAll('[data-pick]').forEach(cb => cb.addEventListener('change', () => {
        cb.checked ? picked.add(cb.dataset.pick) : picked.delete(cb.dataset.pick);
        render();
      }));

      document.getElementById('prune-selected')?.addEventListener('click', () => {
        const list = sel.map(r => `<li><b>${r.title}</b> (${r.count})${r.safe ? '' : ' — <span style="color:var(--danger)">deletes the data in them</span>'}</li>`).join('');
        showDeleteConfirm('Prune selected', { message: `This removes:<ul style="margin:8px 0 0 18px">${list}</ul>${frees ? `<p style="margin-top:8px">Frees about <b>${formatBytes(frees)}</b>. Running containers are never touched.</p>` : ''}`, phrase: 'delete', onConfirm: async () => {
          let total = 0; const failed = [];
          for (const r of sel) {
            try {
              const res = await API.post(`/cleanup/${r.id}`);
              total += res.SpaceReclaimed || 0;
            } catch (e) { failed.push(`${r.title}: ${e.message}`); }
          }
          if (failed.length) showToast(`Some steps failed — ${failed.join('; ')}`, 'error', 10000);
          else showToast(`Pruned${total ? ` · ${formatBytes(total)} freed` : ''}`);
          picked = null;
          render();
        } });
      });

      document.getElementById('full-prune-btn').addEventListener('click', () => {
        const includeVols = document.getElementById('prune-volumes').checked;
        showDeleteConfirm('Full system prune', { message: `Removes every stopped container, unused network, unused image and the build cache${includeVols ? ', <b>and every unused volume with its data</b>' : ''}. This cannot be undone.`, phrase: 'delete', onConfirm: async () => {
          try {
            showToast('Running full system prune…', 'info');
            await API.post(`/cleanup/system?volumes=${includeVols}`);
            showToast('System pruned');
            picked = null;
            render();
          } catch (err) { showToast(err.message, 'error'); }
        } });
      });
    } catch (err) { content.innerHTML = UI.errorState(err); }
  }

  await render();
}
