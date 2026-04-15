/**
 * Builds page — Docker Desktop style build management
 * Build history, real-time monitoring, cache, builders
 * Module: Frontend builds page | Used via Router navigation
 */
Router.register('builds', async (content) => {
  let activeBuild = null;
  let buildLogEl = null;
  let activeTab = 'history';
  let selectedBuildId = null;

  // Capture navId to detect stale renders / Köhnə renderləri aşkar etmək üçün navId-ni saxla
  const pageNavId = Router._navId;

  // ============ ANA RENDER ============
  async function render() {
    content.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Builds</div>
          <div class="page-subtitle">Build history, cache & builders</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="new-build-btn">${Icons.play} New Build</button>
          <button class="btn btn-secondary" id="builds-refresh">${Icons.refresh}</button>
        </div>
      </div>
      <div class="tab-bar" style="margin-bottom: 16px;">
        <button class="tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history">Build History</button>
        <button class="tab-btn ${activeTab === 'cache' ? 'active' : ''}" data-tab="cache">Build Cache</button>
        <button class="tab-btn ${activeTab === 'builders' ? 'active' : ''}" data-tab="builders">Builders</button>
        ${activeBuild ? `<button class="tab-btn ${activeTab === 'live' ? 'active' : ''}" data-tab="live" style="color: var(--accent);">● Active Build</button>` : ''}
      </div>
      <div id="tab-content"></div>
    `;
    content.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => { activeTab = btn.dataset.tab; selectedBuildId = null; render(); });
    });
    document.getElementById('new-build-btn')?.addEventListener('click', showNewBuildModal);
    document.getElementById('builds-refresh')?.addEventListener('click', render);

    if (activeTab === 'history') await renderHistory();
    else if (activeTab === 'cache') await renderCache();
    else if (activeTab === 'builders') await renderBuilders();
    else if (activeTab === 'live') renderLiveBuild();
  }

  // ============ BUILD HISTORY — Docker image build history ============
  async function renderHistory() {
    const tabContent = document.getElementById('tab-content');
    try {
      // Fetch both panel builds and Docker image history
      const [panelBuilds, dockerHistory] = await Promise.all([
        API.get('/builds'),
        API.get('/builds/docker-history').catch(() => []),
      ]);

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      if (panelBuilds.length === 0 && dockerHistory.length === 0) {
        tabContent.innerHTML = `
          <div class="empty-state">
            <span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">${Icons.layers}</span>
            <h3>No build history</h3>
            <p>Build an image to see its history here.</p>
          </div>`;
        return;
      }

      // Show detail if a panel build is selected
      if (selectedBuildId) {
        await renderBuildDetail(tabContent, panelBuilds);
        return;
      }

      // Docker image history — each image as a card, expandable to see layers
      let historyHtml = '';
      if (dockerHistory.length > 0) {
        historyHtml = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <span style="font-weight:700;font-size:14px;">Docker Image Build History</span>
          </div>
          <div id="docker-history-list" style="margin-bottom:24px;"></div>
        `;
      }

      // Panel builds
      let panelHtml = '';
      if (panelBuilds.length > 0) {
        panelHtml = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <span style="font-weight:700;font-size:14px;">Panel Builds</span>
            <button class="btn btn-danger btn-sm" id="clear-history">${Icons.trash} Clear All</button>
          </div>
          <div id="panel-build-list" style="margin-bottom:24px;"></div>
        `;
      }

      tabContent.innerHTML = historyHtml + panelHtml;

      // Docker image history cards
      if (dockerHistory.length > 0) {
        const histList = document.getElementById('docker-history-list');
        dockerHistory.forEach((img, idx) => {
          const el = document.createElement('div');
          el.style.marginBottom = '6px';
          el.innerHTML = `
            <div class="build-card" data-dhi="${idx}" style="cursor:pointer;">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                <span class="cache-chev" style="transition:transform 200ms;display:flex;">${Icons.chevronRight}</span>
                <div class="build-status-icon build-status-success" style="width:28px;height:28px;font-size:12px;">✓</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(img.tag)}</div>
                  <div class="text-muted text-xs" style="margin-top:2px;">${img.layers} layers · ${formatBytes(img.size)} · ${timeAgo(img.created)}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                <span class="td-mono text-xs">${escapeHtml(img.shortId)}</span>
                <button class="btn-icon hide-docker-build" data-image-id="${img.imageId}" title="Remove from history" onclick="event.stopPropagation()">${Icons.trash}</button>
              </div>
            </div>
            <div class="docker-history-body" data-dhb="${idx}" style="display:none;border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius-lg) var(--radius-lg);overflow:hidden;background:var(--bg-card);max-height:400px;overflow-y:auto;">
              ${img.history.map((h, li) => {
                const cmd = h.createdBy.replace(/^\/bin\/sh -c\s+/, '').replace(/#\(nop\)\s+/g, '');
                const shortCmd = cmd.length > 120 ? cmd.substring(0, 117) + '...' : cmd;
                const isNop = h.createdBy.includes('#(nop)');
                return `
                  <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border);font-size:11px;${li === 0 ? 'background:rgba(0,212,170,0.05);' : ''}">
                    <span class="text-muted" style="min-width:24px;text-align:right;">${li + 1}</span>
                    <span style="min-width:60px;text-align:right;color:${h.size > 0 ? 'var(--text-primary)' : 'var(--text-muted)'};">${h.size > 0 ? formatBytes(h.size) : '0 B'}</span>
                    <span style="flex:1;font-family:var(--font-mono);word-break:break-all;color:${isNop ? 'var(--accent)' : 'var(--text-secondary)'};" title="${escapeHtml(cmd)}">${escapeHtml(shortCmd)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          `;
          histList.appendChild(el);

          const hdr = el.querySelector(`[data-dhi="${idx}"]`);
          const body = el.querySelector(`[data-dhb="${idx}"]`);
          const chev = hdr.querySelector('.cache-chev');
          hdr.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            chev.style.transform = open ? '' : 'rotate(90deg)';
            hdr.style.borderRadius = open ? '' : 'var(--radius-lg) var(--radius-lg) 0 0';
          });

          // Delete button
          el.querySelector('.hide-docker-build')?.addEventListener('click', (e) => {
            e.stopPropagation();
            showConfirm('Remove from History', `Remove "${img.tag}" from build history? (Image will not be deleted)`, async () => {
              try {
                await API.post('/builds/docker-history/hide', { imageId: img.imageId });
                showToast('Removed from history', 'success');
                render();
              } catch (err) { showToast(err.message, 'error'); }
            }, true);
          });
        });
      }

      // Panel build cards
      if (panelBuilds.length > 0) {
        const listEl = document.getElementById('panel-build-list');
        panelBuilds.forEach(b => {
          const card = document.createElement('div');
          card.className = 'build-card';
          card.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
              <div class="build-status-icon build-status-${b.status}">
                ${b.status === 'success' ? '✓' : b.status === 'failed' ? '✗' : '●'}
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:13px;">${escapeHtml(b.image_tag || 'untagged')}</div>
                <div class="text-muted text-xs" style="margin-top:2px;">${escapeHtml(b.dockerfile || 'Dockerfile')} · ${b.started_at ? timeAgo(b.started_at) : ''}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
              ${b.duration_ms ? `<span class="text-sm text-muted">${formatDuration(b.duration_ms)}</span>` : ''}
              ${buildStatusBadge(b.status)}
              <button class="btn-icon delete-build" data-id="${b.id}" title="Delete">${Icons.trash}</button>
            </div>
          `;
          card.addEventListener('click', (e) => {
            if (e.target.closest('.delete-build')) return;
            selectedBuildId = b.id;
            render();
          });
          listEl.appendChild(card);
        });

        listEl.querySelectorAll('.delete-build').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConfirm('Delete Build', 'Delete this build record?', async () => {
              try {
                await API.del(`/builds/detail/${btn.dataset.id}`);
                showToast('Build deleted', 'success');
                render();
              } catch (err) { showToast(err.message, 'error'); }
            }, true);
          });
        });

        document.getElementById('clear-history')?.addEventListener('click', () => {
          showConfirm('Clear All', 'Delete all panel build history?', async () => {
            try { await API.del('/builds'); showToast('Cleared', 'success'); render(); }
            catch (err) { showToast(err.message, 'error'); }
          }, true);
        });
      }

    } catch (err) {
      tabContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  // ============ BUILD DETAIL — Docker Desktop style ============
  async function renderBuildDetail(tabContent, builds) {
    let build;
    try {
      build = await API.get(`/builds/detail/${selectedBuildId}`);
      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;
    } catch(e) {
      selectedBuildId = null;
      await renderHistory();
      return;
    }

    let detailTab = 'info';

    function renderDetail() {
      tabContent.innerHTML = `
        <div style="margin-bottom:16px;">
          <button class="btn btn-ghost" id="back-to-list" style="margin-bottom:12px;">← Back to builds</button>
          <div style="display:flex;align-items:center;gap:16px;">
            <div class="build-status-icon build-status-${build.status}" style="width:44px;height:44px;font-size:20px;">
              ${build.status === 'success' ? '✓' : build.status === 'failed' ? '✗' : '●'}
            </div>
            <div style="flex:1;">
              <div style="font-size:18px;font-weight:700;">${escapeHtml(build.image_tag || 'untagged')}</div>
              <div class="text-muted text-sm" style="margin-top:4px;display:flex;align-items:center;gap:8px;">
                ${buildStatusBadge(build.status)}
                ${build.duration_ms ? `<span>${formatDuration(build.duration_ms)}</span>` : ''}
                ${build.started_at ? `<span>${new Date(build.started_at).toLocaleString()}</span>` : ''}
              </div>
            </div>
            <button class="btn btn-danger btn-sm" id="delete-this-build">${Icons.trash} Delete</button>
          </div>
        </div>

        <div class="tab-bar" style="margin-bottom:16px;">
          <button class="tab-btn detail-tab ${detailTab === 'info' ? 'active' : ''}" data-dtab="info">Info</button>
          <button class="tab-btn detail-tab ${detailTab === 'source' ? 'active' : ''}" data-dtab="source">${build.error ? 'Error' : 'Source'}</button>
          <button class="tab-btn detail-tab ${detailTab === 'logs' ? 'active' : ''}" data-dtab="logs">Logs</button>
          <button class="tab-btn detail-tab ${detailTab === 'history' ? 'active' : ''}" data-dtab="history">History</button>
        </div>

        <div id="detail-tab-content"></div>
      `;

      document.getElementById('back-to-list')?.addEventListener('click', () => { selectedBuildId = null; render(); });
      document.getElementById('delete-this-build')?.addEventListener('click', () => {
        showConfirm('Delete Build', 'Delete this build record?', async () => {
          try {
            await API.del(`/builds/detail/${build.id}`);
            showToast('Build deleted', 'success');
            selectedBuildId = null; render();
          } catch (err) { showToast(err.message, 'error'); }
        }, true);
      });

      tabContent.querySelectorAll('.detail-tab').forEach(btn => {
        btn.addEventListener('click', () => { detailTab = btn.dataset.dtab; renderDetail(); });
      });

      const dtc = document.getElementById('detail-tab-content');

      if (detailTab === 'info') renderInfoTab(dtc, build);
      else if (detailTab === 'source') renderSourceTab(dtc, build);
      else if (detailTab === 'logs') renderLogsTab(dtc, build);
      else if (detailTab === 'history') renderHistoryTab(dtc, build, builds);
    }

    renderDetail();
  }

  // ---- INFO TAB — Build timing, dependencies, configuration ----
  function renderInfoTab(el, build) {
    const steps = countSteps(build.log || '');
    const logText = build.log || '';
    // Cache hit hesabla
    const cacheHits = (logText.match(/Using cache/gi) || []).length;
    const totalSteps = steps || 1;
    const cachePercent = steps > 0 ? Math.round((cacheHits / totalSteps) * 100) : 0;

    // Dependencies — extract pulled images from logs
    const pullMatches = logText.match(/(?:FROM|Pulling from)\s+([^\s\n]+)/gi) || [];
    const deps = [...new Set(pullMatches.map(m => m.replace(/^(FROM|Pulling from)\s+/i, '').trim()))];

    let buildArgs = {};
    try { buildArgs = JSON.parse(build.build_args || '{}'); } catch(e) {}

    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:20px;">
        <!-- Build Timing -->
        <div class="card" style="padding:20px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:16px;">Build timing</div>
          <div class="summary-grid" style="margin-bottom:0;">
            <div class="summary-card">
              <div class="summary-card-icon blue">⏱</div>
              <div class="summary-card-content">
                <div class="summary-card-value">${build.duration_ms ? formatDuration(build.duration_ms) : '—'}</div>
                <div class="summary-card-label">Real time</div>
              </div>
            </div>
            <div class="summary-card">
              <div class="summary-card-icon purple">#</div>
              <div class="summary-card-content">
                <div class="summary-card-value">${steps}</div>
                <div class="summary-card-label">Build steps</div>
              </div>
            </div>
            <div class="summary-card">
              <div class="summary-card-icon green">⚡</div>
              <div class="summary-card-content">
                <div class="summary-card-value">${cachePercent}%</div>
                <div class="summary-card-label">Cache usage</div>
              </div>
            </div>
            <div class="summary-card">
              <div class="summary-card-icon teal">${Icons.layers}</div>
              <div class="summary-card-content">
                <div class="summary-card-value">${build.image_id ? build.image_id.replace('sha256:', '').substring(0, 12) : '—'}</div>
                <div class="summary-card-label">Image ID</div>
              </div>
            </div>
          </div>
          <!-- Cache bar -->
          <div style="margin-top:16px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span class="text-xs text-muted">Cache usage</span>
              <span class="text-xs">${cacheHits}/${totalSteps} steps cached</span>
            </div>
            <div class="disk-bar"><div class="disk-bar-fill green" style="width:${cachePercent}%"></div></div>
          </div>
        </div>

        <!-- Dependencies -->
        ${deps.length > 0 ? `
        <div class="card" style="padding:20px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Dependencies</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${deps.map(d => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:var(--radius-md);">
                <span style="color:var(--accent);">${Icons.image}</span>
                <span class="td-mono">${escapeHtml(d)}</span>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <!-- Configuration -->
        <div class="card" style="padding:20px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Configuration</div>
          <div class="detail-grid" style="gap:12px;">
            <div class="detail-item">
              <div class="detail-label">Image Tag</div>
              <div class="detail-value mono">${escapeHtml(build.image_tag || 'untagged')}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Dockerfile</div>
              <div class="detail-value mono">${escapeHtml(build.dockerfile || 'Dockerfile')}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Context</div>
              <div class="detail-value mono">${escapeHtml(build.context_url || '—')}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">No Cache</div>
              <div class="detail-value">${build.nocache ? 'Yes' : 'No'}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Pull</div>
              <div class="detail-value">${build.pull ? 'Yes' : 'No'}</div>
            </div>
          </div>
          ${Object.keys(buildArgs).length > 0 ? `
            <div style="margin-top:16px;">
              <div class="detail-label" style="margin-bottom:8px;">Build Arguments</div>
              ${Object.entries(buildArgs).map(([k,v]) => `
                <div style="display:flex;gap:8px;padding:4px 0;">
                  <span class="td-mono text-accent">${escapeHtml(k)}</span>
                  <span class="text-muted">=</span>
                  <span class="td-mono">${escapeHtml(String(v))}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Timeline -->
        <div class="card" style="padding:20px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Timeline</div>
          <div style="display:flex;flex-direction:column;gap:12px;position:relative;padding-left:20px;">
            <div style="position:absolute;left:7px;top:8px;bottom:8px;width:2px;background:var(--border);"></div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="width:12px;height:12px;border-radius:50%;background:var(--accent);position:relative;z-index:1;flex-shrink:0;"></span>
              <span class="text-sm">Started: ${build.started_at ? new Date(build.started_at).toLocaleString() : '—'}</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="width:12px;height:12px;border-radius:50%;background:${build.status === 'success' ? 'var(--success)' : build.status === 'failed' ? 'var(--danger)' : 'var(--warning)'};position:relative;z-index:1;flex-shrink:0;"></span>
              <span class="text-sm">Finished: ${build.finished_at ? new Date(build.finished_at).toLocaleString() : 'In progress...'}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---- SOURCE / ERROR TAB ----
  function renderSourceTab(el, build) {
    if (build.error) {
      el.innerHTML = `
        <div class="card" style="padding:20px;border-color:var(--danger);">
          <div style="font-weight:700;font-size:14px;color:var(--danger);margin-bottom:12px;">Build Error</div>
          <pre style="background:var(--bg-primary);border:1px solid var(--danger);border-radius:var(--radius-md);padding:16px;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--danger);">${escapeHtml(build.error)}</pre>
        </div>
      `;
    } else {
      // Extract Dockerfile steps from logs
      const logText = build.log || '';
      const stepLines = logText.split('\n').filter(l => l.match(/^Step \d+/i));
      el.innerHTML = `
        <div class="card" style="padding:20px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:12px;">Dockerfile Steps</div>
          ${stepLines.length > 0 ? `
            <div style="font-family:var(--font-mono);font-size:12px;line-height:2;">
              ${stepLines.map((line, i) => `
                <div style="padding:4px 8px;${i % 2 === 0 ? 'background:rgba(255,255,255,0.02);' : ''}border-radius:4px;">
                  <span style="color:var(--accent);font-weight:600;">${escapeHtml(line)}</span>
                </div>
              `).join('')}
            </div>
          ` : '<div class="text-muted">No Dockerfile steps found in build log.</div>'}
        </div>
      `;
    }
  }

  // ---- LOGS TAB — collapsible steps + plain text toggle ----
  function renderLogsTab(el, build) {
    const logText = build.log || '';
    let viewMode = 'list'; // list or plain

    function renderLogView() {
      const coloredLog = colorizeBuildLog(logText);
      const steps = parseSteps(logText);

      el.innerHTML = `
        <div class="build-log-container">
          <div class="build-log-toolbar">
            <div style="display:flex;gap:4px;">
              <button class="btn btn-xs ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}" id="log-list-view">List</button>
              <button class="btn btn-xs ${viewMode === 'plain' ? 'btn-primary' : 'btn-secondary'}" id="log-plain-view">Plain text</button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="text-sm text-muted">${steps.length} step(s)</span>
              <button class="btn btn-xs btn-secondary" id="copy-log">${Icons.copy} Copy</button>
            </div>
          </div>
          <div id="log-content"></div>
        </div>
      `;

      const logContent = document.getElementById('log-content');

      if (viewMode === 'plain') {
        logContent.innerHTML = `<div class="build-log-viewer">${coloredLog}</div>`;
      } else {
        // List view — collapsible steps
        if (steps.length === 0) {
          logContent.innerHTML = `<div class="build-log-viewer">${coloredLog}</div>`;
        } else {
          let html = '<div style="max-height:500px;overflow-y:auto;">';
          steps.forEach((step, i) => {
            const isError = step.lines.some(l => l.match(/error/i));
            html += `
              <div class="build-step" style="border-bottom:1px solid var(--border);">
                <div class="build-step-header" data-step="${i}" style="display:flex;align-items:center;gap:8px;padding:10px 16px;cursor:pointer;transition:background 150ms;">
                  <span class="step-chev" style="transition:transform 200ms;display:flex;width:16px;">${Icons.chevronRight}</span>
                  <span style="font-weight:600;font-size:12px;color:${isError ? 'var(--danger)' : 'var(--accent)'};">${escapeHtml(step.title)}</span>
                  <span class="text-xs text-muted" style="margin-left:auto;">${step.lines.length} line(s)</span>
                </div>
                <div class="build-step-body" data-step-body="${i}" style="display:none;padding:8px 16px 12px 40px;font-family:var(--font-mono);font-size:11px;line-height:1.6;color:#b4bcd0;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,0.1);">${step.lines.map(l => {
                  const escaped = escapeHtml(l);
                  if (l.match(/error/i)) return `<span style="color:var(--danger);">${escaped}</span>`;
                  if (l.match(/--->/)) return `<span style="color:var(--info);">${escaped}</span>`;
                  return escaped;
                }).join('\n')}</div>
              </div>
            `;
          });
          html += '</div>';
          logContent.innerHTML = html;

          // Step toggle expand/collapse
          logContent.querySelectorAll('.build-step-header').forEach(hdr => {
            const idx = hdr.dataset.step;
            const body = logContent.querySelector(`[data-step-body="${idx}"]`);
            const chev = hdr.querySelector('.step-chev');
            hdr.addEventListener('click', () => {
              const open = body.style.display !== 'none';
              body.style.display = open ? 'none' : 'block';
              chev.style.transform = open ? '' : 'rotate(90deg)';
            });
          });
        }
      }

      document.getElementById('log-list-view')?.addEventListener('click', () => { viewMode = 'list'; renderLogView(); });
      document.getElementById('log-plain-view')?.addEventListener('click', () => { viewMode = 'plain'; renderLogView(); });
      document.getElementById('copy-log')?.addEventListener('click', () => {
        navigator.clipboard.writeText(logText).then(() => showToast('Copied', 'success'));
      });
    }

    renderLogView();
  }

  // ---- HISTORY TAB — compare past builds ----
  function renderHistoryTab(el, build, builds) {
    // Find builds with same image_tag
    const related = builds.filter(b => b.image_tag === build.image_tag);

    el.innerHTML = `
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:16px;">Past builds for "${escapeHtml(build.image_tag || 'untagged')}"</div>
        ${related.length <= 1 ? '<div class="text-muted text-sm">No other builds found for this image tag.</div>' : `
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${related.map(b => `
              <div class="build-card ${b.id === build.id ? 'selected' : ''}" data-history-id="${b.id}" style="${b.id === build.id ? 'border-color:var(--accent);' : ''}">
                <div style="display:flex;align-items:center;gap:10px;flex:1;">
                  <div class="build-status-icon build-status-${b.status}" style="width:24px;height:24px;font-size:11px;">
                    ${b.status === 'success' ? '✓' : b.status === 'failed' ? '✗' : '●'}
                  </div>
                  <span class="text-sm">${b.started_at ? new Date(b.started_at).toLocaleString() : '—'}</span>
                  ${b.id === build.id ? '<span class="badge badge-running" style="font-size:9px;">Current</span>' : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  ${b.duration_ms ? `<span class="text-sm text-muted">${formatDuration(b.duration_ms)}</span>` : ''}
                  ${buildStatusBadge(b.status)}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;

    // Navigate to another build
    el.querySelectorAll('[data-history-id]').forEach(card => {
      card.addEventListener('click', () => {
        selectedBuildId = card.dataset.historyId;
        render();
      });
    });
  }

  // ============ BUILD CACHE — grouped by image ============
  async function renderCache() {
    const tabContent = document.getElementById('tab-content');
    try {
      const data = await API.get('/builds/cache');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      const { groups, totalItems, totalSize } = data;

      if (!groups || groups.length === 0) {
        tabContent.innerHTML = `<div class="empty-state"><span class="nav-item-icon" style="width:48px;height:48px;opacity:0.3">${Icons.layers}</span><h3>Build cache is empty</h3></div>`;
        return;
      }

      tabContent.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <span class="text-sm text-muted">${groups.length} group(s) · ${totalItems} layer(s) · ${formatBytes(totalSize)}</span>
          <button class="btn btn-danger btn-sm" id="prune-cache">${Icons.trash} Prune Cache</button>
        </div>
        <div id="cache-groups"></div>
      `;

      const container = document.getElementById('cache-groups');
      groups.forEach((g, i) => {
        const displayName = g.matchedImage ? g.matchedImage.tag : g.name;
        const el = document.createElement('div');
        el.style.marginBottom = '6px';
        el.innerHTML = `
          <div class="build-card" data-ci="${i}" style="cursor:pointer;">
            <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
              <span class="cache-chev" style="transition:transform 200ms;display:flex;">${Icons.chevronRight}</span>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                ${g.matchedImage ? `<div class="text-muted text-xs" style="margin-top:2px;">${g.matchedImage.id} · ${formatBytes(g.matchedImage.size)}</div>` : ''}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
              <span class="badge badge-created" style="font-size:10px;">${g.items.length} layers</span>
              ${g.inUse ? '<span class="text-accent text-xs font-bold">In Use</span>' : ''}
              <span class="text-sm" style="min-width:70px;text-align:right;">${formatBytes(g.totalSize)}</span>
            </div>
          </div>
          <div data-cb="${i}" style="display:none;border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius-lg) var(--radius-lg);overflow:hidden;background:var(--bg-card);max-height:350px;overflow-y:auto;">
            ${g.items.map(b => `
              <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border);font-size:11px;">
                <span class="td-mono" style="min-width:110px;">${(b.ID||'').substring(0,15)}...</span>
                <span class="badge ${b.Type==='regular'?'badge-running':'badge-created'}" style="font-size:9px;">${escapeHtml(b.Type||'?')}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);" title="${escapeHtml(b.Description||'')}">${escapeHtml(b.Description||'—')}</span>
                <span style="min-width:55px;text-align:right;">${formatBytes(b.Size||0)}</span>
                <span style="min-width:50px;">${b.InUse?'<span class="text-accent">In Use</span>':'<span class="text-muted">Idle</span>'}</span>
              </div>
            `).join('')}
          </div>
        `;
        container.appendChild(el);

        const hdr = el.querySelector(`[data-ci="${i}"]`);
        const body = el.querySelector(`[data-cb="${i}"]`);
        const chev = hdr.querySelector('.cache-chev');
        hdr.addEventListener('click', () => {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          chev.style.transform = open ? '' : 'rotate(90deg)';
          hdr.style.borderRadius = open ? '' : 'var(--radius-lg) var(--radius-lg) 0 0';
        });
      });

      document.getElementById('prune-cache')?.addEventListener('click', () => {
        showConfirm('Prune Build Cache', 'Remove all build cache? Next builds may take longer.', async () => {
          try {
            showToast('Pruning...', 'info');
            const res = await API.post('/builds/cache/prune');
            let space = res.SpaceReclaimedStr ? ` (${res.SpaceReclaimedStr.replace('Total reclaimed space:','').trim()})` : '';
            showToast(`Cache pruned${space}`, 'success');
            renderCache();
          } catch (err) { showToast(err.message, 'error'); }
        }, true);
      });
    } catch (err) {
      tabContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  // ============ BUILDERS ============
  async function renderBuilders() {
    const tabContent = document.getElementById('tab-content');
    try {
      const builders = await API.get('/builds/builders');

      // Abort if user navigated away / İstifadəçi başqa səhifəyə keçibsə dayandır
      if (!Router.isActiveNav(pageNavId)) return;

      tabContent.innerHTML = `
        <div style="margin-bottom:12px;">
          <span class="text-sm text-muted">${builders.length} builder(s)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${builders.map(b => `
            <div class="build-card">
              <div style="display:flex;align-items:center;gap:12px;flex:1;">
                <div class="build-status-icon build-status-success" style="width:32px;height:32px;font-size:14px;">⚙</div>
                <div>
                  <div style="font-weight:600;">${escapeHtml(b.Name || b.name || 'unknown')}</div>
                  <div class="text-muted text-sm">${escapeHtml(b.Driver || b.driver || 'docker')}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                ${(b['Builder.IsDefault'] || b.isDefault) ? '<span class="badge badge-running">Default</span>' : ''}
                <span class="badge badge-created">${escapeHtml(b.Status || b.status || 'unknown')}</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (err) {
      tabContent.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  // ============ LIVE BUILD ============
  function renderLiveBuild() {
    const tabContent = document.getElementById('tab-content');
    if (!activeBuild) {
      tabContent.innerHTML = `<div class="empty-state"><h3>No active build</h3></div>`;
      return;
    }
    tabContent.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <div class="build-status-icon build-status-building" style="animation:pulse 1.5s infinite;">●</div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:16px;">${escapeHtml(activeBuild.tag || 'untagged')}</div>
          <div class="text-muted text-sm">Building...</div>
        </div>
        <button class="btn btn-danger btn-sm" id="cancel-build">${Icons.stop} Cancel</button>
      </div>
      <div class="build-log-container">
        <div class="build-log-viewer" id="build-log-live"></div>
      </div>
    `;
    buildLogEl = document.getElementById('build-log-live');
    if (activeBuild.logs) {
      buildLogEl.innerHTML = colorizeBuildLog(activeBuild.logs);
      buildLogEl.scrollTop = buildLogEl.scrollHeight;
    }
    document.getElementById('cancel-build')?.addEventListener('click', () => {
      socket.emit('build:cancel');
      showToast('Cancelling build...', 'info');
    });
  }

  // ============ NEW BUILD MODAL ============
  function showNewBuildModal() {
    showModal('New Image Build', `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div>
          <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">Image Tag</label>
          <input type="text" id="build-tag" class="input" placeholder="myapp:latest" style="width:100%;" />
        </div>
        <div>
          <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">Context (Git repo URL or remote tarball)</label>
          <input type="text" id="build-context" class="input" placeholder="https://github.com/user/repo.git" style="width:100%;" />
        </div>
        <div>
          <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);">Dockerfile path</label>
          <input type="text" id="build-dockerfile" class="input" placeholder="Dockerfile" value="Dockerfile" style="width:100%;" />
        </div>
        <div style="display:flex;gap:16px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="build-nocache" /> No cache
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="build-pull" /> Always pull base image
          </label>
        </div>
      </div>
    `, [
      { label: 'Cancel', className: 'btn btn-secondary' },
      { label: 'Start Build', className: 'btn btn-primary', onClick: startBuild },
    ]);
  }

  function startBuild() {
    const tag = document.getElementById('build-tag')?.value.trim();
    const contextValue = document.getElementById('build-context')?.value.trim();
    const dockerfile = document.getElementById('build-dockerfile')?.value.trim() || 'Dockerfile';
    const nocache = document.getElementById('build-nocache')?.checked || false;
    const pull = document.getElementById('build-pull')?.checked || false;

    if (!contextValue) { showToast('Context URL is required', 'error'); return; }

    activeBuild = { tag: tag || 'untagged', logs: '', startTime: Date.now() };
    socket.emit('build:start', { contextType: 'url', contextValue, tag, dockerfile, nocache, pull });
    showToast('Build started...', 'info');
    activeTab = 'live';
    render();
  }

  // ============ WEBSOCKET EVENTS ============
  function onBuildLog({ buildId, data }) {
    if (!activeBuild) return;
    activeBuild.logs += data;
    if (buildLogEl) {
      buildLogEl.innerHTML = colorizeBuildLog(activeBuild.logs);
      buildLogEl.scrollTop = buildLogEl.scrollHeight;
    }
  }
  function onBuildComplete({ buildId, status, duration, imageId }) {
    const tag = activeBuild?.tag || 'untagged';
    activeBuild = null; buildLogEl = null;
    showToast(status === 'success' ? `Build complete: ${tag} (${formatDuration(duration)})` : `Build failed: ${tag}`, status === 'success' ? 'success' : 'error');
    activeTab = 'history'; render();
  }
  function onBuildError({ buildId, error }) {
    showToast(`Build error: ${error}`, 'error');
    activeBuild = null; buildLogEl = null; activeTab = 'history'; render();
  }
  function onBuildCancelled() {
    showToast('Build cancelled', 'warning');
    activeBuild = null; buildLogEl = null; activeTab = 'history'; render();
  }

  socket.on('build:log', onBuildLog);
  socket.on('build:complete', onBuildComplete);
  socket.on('build:error', onBuildError);
  socket.on('build:cancelled', onBuildCancelled);

  // ============ HELPER FUNCTIONS ============
  function buildStatusBadge(status) {
    const map = {
      'success': '<span class="badge badge-running">Success</span>',
      'failed': '<span class="badge badge-exited">Failed</span>',
      'building': '<span class="badge badge-created" style="animation:pulse 1.5s infinite;">Building</span>',
    };
    return map[status] || `<span class="badge">${escapeHtml(status)}</span>`;
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }

  function countSteps(log) {
    if (!log) return 0;
    const matches = log.match(/^Step \d+/gm);
    return matches ? matches.length : 0;
  }

  // Split logs into steps (for collapsible list view)
  function parseSteps(log) {
    if (!log) return [];
    const lines = log.split('\n');
    const steps = [];
    let current = null;

    for (const line of lines) {
      if (line.match(/^Step \d+/i)) {
        if (current) steps.push(current);
        current = { title: line, lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) steps.push(current);
    return steps;
  }

  // Colorize build logs — Docker Desktop style
  function colorizeBuildLog(text) {
    if (!text) return '<span class="text-muted">No logs available</span>';
    return escapeHtml(text).split('\n').map(line => {
      if (line.match(/^Step \d+/i)) return `<span style="color:var(--accent);font-weight:700;">${line}</span>`;
      if (line.match(/^(Successfully|Built image)/i)) return `<span style="color:var(--success);font-weight:600;">${line}</span>`;
      if (line.match(/^ERROR/i) || line.match(/^error/i)) return `<span style="color:var(--danger);">${line}</span>`;
      if (line.match(/^(---&gt;|---\>| ---&gt;)/)) return `<span style="color:var(--info);">${line}</span>`;
      if (line.match(/^(Removing|Sending|Downloading|Extracting)/i)) return `<span style="color:var(--text-muted);">${line}</span>`;
      return line;
    }).join('\n');
  }

  // ============ INIT ============
  await render();

  return () => {
    socket.off('build:log', onBuildLog);
    socket.off('build:complete', onBuildComplete);
    socket.off('build:error', onBuildError);
    socket.off('build:cancelled', onBuildCancelled);
  };
});
