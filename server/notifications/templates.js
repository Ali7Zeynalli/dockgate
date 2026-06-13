// Email notification templates

function header(title) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">&#128051;</span>
          <span style="font-size:14px;font-weight:600;letter-spacing:0.5px;">DockGate</span>
        </div>
        <h2 style="margin:12px 0 0;font-size:18px;font-weight:500;">${title}</h2>
      </div>`;
}

function footer() {
  return `
      <div style="padding:12px 24px;background:#f5f5f5;text-align:center;font-size:11px;color:#888;border-radius:0 0 8px 8px;border:1px solid #e0e0e0;border-top:0;">
        Sent by DockGate &mdash; Docker Control Panel
      </div>
    </div>`;
}

function row(label, value) {
  return `<tr><td style="padding:6px 0;color:#666;font-size:13px;width:140px;">${label}</td><td style="padding:6px 0;font-size:13px;font-weight:500;">${value}</td></tr>`;
}

// Renders a Server row only when a non-local server id is supplied.
function serverRow(server) {
  if (!server || server === 'local') return '';
  return row('Server', `<code style="background:#eef2ff;padding:2px 6px;border-radius:3px;">${server}</code>`);
}

// HTML-escape free-form text (container logs can contain < > &).
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A dark "Recent container logs" block — the WHY behind a crash/OOM/unhealthy event. Empty if no logs.
function logsBlock(logs) {
  if (!logs || !String(logs).trim()) return '';
  return `
        <div style="margin-top:16px;">
          <div style="font-size:12px;color:#666;margin-bottom:4px;">Recent container logs</div>
          <pre style="margin:0;padding:10px 14px;background:#0b1021;color:#cdd6f4;border-radius:4px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:340px;overflow:auto;">${esc(logs)}</pre>
        </div>`;
}

function containerDieTemplate({ containerName, containerId, image, time, exitCode, unexpected = true, server, logs }) {
  // unexpected=false (exit 0 / intentional stop) → neutral blue; non-zero crash → red alert
  const title = unexpected ? 'Container Crashed' : 'Container Stopped';
  const boxStyle = unexpected
    ? 'background:#fff3f3;border:1px solid #fecaca;color:#b91c1c;'
    : 'background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;';
  const message = unexpected
    ? `Container <strong>${containerName}</strong> exited unexpectedly (exit code ${exitCode}).`
    : `Container <strong>${containerName}</strong> has stopped (exit code ${exitCode}).`;
  return `${header(title)}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="${boxStyle}border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;">
          ${message}
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Container', containerName)}
          ${row('ID', containerId)}
          ${row('Image', image || '—')}
          ${row('Exit Code', exitCode ?? '—')}
          ${row('Time', time)}
        </table>
        ${logsBlock(logs)}
      </div>
    ${footer()}`;
}

function containerRestartTemplate({ containerName, containerId, image, time, restartCount, server }) {
  return `${header('Container Restarted')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
          Container <strong>${containerName}</strong> has restarted.${restartCount > 3 ? ' Frequent restarts detected — investigate the cause.' : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Container', containerName)}
          ${row('ID', containerId)}
          ${row('Image', image || '—')}
          ${row('Restart Count', restartCount ?? '—')}
          ${row('Time', time)}
        </table>
      </div>
    ${footer()}`;
}

function containerUnhealthyTemplate({ containerName, containerId, image, time, failingStreak, lastOutput, server, logs }) {
  return `${header('Container Unhealthy')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fff3f3;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#b91c1c;">
          Container <strong>${containerName}</strong> is reporting unhealthy. It may be frozen or unresponsive.
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Container', containerName)}
          ${row('ID', containerId)}
          ${row('Image', image || '—')}
          ${row('Failing Streak', failingStreak ?? '—')}
          ${row('Time', time)}
        </table>
        ${lastOutput ? `<div style="margin-top:16px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;font-size:12px;color:#991b1b;font-family:monospace;white-space:pre-wrap;word-break:break-all;">${lastOutput}</div>` : ''}
        <div style="margin-top:12px;padding:10px 14px;background:#f9fafb;border-radius:4px;font-size:12px;color:#666;">
          The container is running but its health check is failing. Check application logs for details.
        </div>
        ${logsBlock(logs)}
      </div>
    ${footer()}`;
}

function containerOomTemplate({ containerName, containerId, image, time, server, logs }) {
  return `${header('OOM Kill Detected')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
          Container <strong>${containerName}</strong> was killed due to out-of-memory.
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Container', containerName)}
          ${row('ID', containerId)}
          ${row('Image', image || '—')}
          ${row('Time', time)}
        </table>
        <div style="margin-top:16px;padding:10px 14px;background:#f9fafb;border-radius:4px;font-size:12px;color:#666;">
          Consider increasing the memory limit for this container.
        </div>
        ${logsBlock(logs)}
      </div>
    ${footer()}`;
}

// thresholdGB is an absolute size limit (NOT a host disk-fullness percentage) — an alert
// fires when Docker's reclaimable space exceeds this limit. The previous version showed the
// GB/limit ratio as a "percentage", which was misleading; sizes are now reported accurately in absolute GB.
function diskAlertTemplate({ usedSpace, usedGB, thresholdGB, breakdown = {}, server }) {
  const breakdownRows = [
    breakdown.images != null ? row('Images', breakdown.images) : '',
    breakdown.containers != null ? row('Containers', breakdown.containers) : '',
    breakdown.volumes != null ? row('Volumes', breakdown.volumes) : '',
    breakdown.buildCache != null ? row('Build Cache', breakdown.buildCache) : '',
  ].join('');
  return `${header('Disk Usage Alert')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
          Docker reclaimable disk usage (<strong>${usedSpace}</strong>) has exceeded the configured <strong>${thresholdGB} GB</strong> threshold.
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Total Used', `${usedSpace} (${usedGB} GB)`)}
          ${row('Threshold', `${thresholdGB} GB`)}
          ${breakdownRows}
        </table>
        <div style="margin-top:16px;padding:10px 14px;background:#f9fafb;border-radius:4px;font-size:12px;color:#666;">
          Run docker system prune or use DockGate Cleanup to free disk space.
        </div>
      </div>
    ${footer()}`;
}

function buildFailTemplate({ imageTag, buildId, error, duration }) {
  const durationStr = duration ? `${(duration / 1000).toFixed(1)}s` : '—';
  return `${header('Build Failed')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fff3f3;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#b91c1c;">
          Image build <strong>${imageTag || 'untagged'}</strong> has failed.
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${row('Image', imageTag || 'untagged')}
          ${row('Build ID', buildId || '—')}
          ${row('Duration', durationStr)}
        </table>
        ${error ? `<div style="margin-top:16px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;font-size:12px;color:#991b1b;font-family:monospace;white-space:pre-wrap;word-break:break-all;">${error}</div>` : ''}
      </div>
    ${footer()}`;
}

// Generic lifecycle event (start / pause / unpause) — neutral informational style.
function containerLifecycleTemplate({ title, message, containerName, containerId, image, time, server }) {
  return `${header(title)}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#1e40af;">
          ${message}
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Container', containerName)}
          ${row('ID', containerId)}
          ${row('Image', image || '—')}
          ${row('Time', time)}
        </table>
      </div>
    ${footer()}`;
}

function testEmailTemplate() {
  return `${header('Test Email')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:6px;padding:12px 16px;font-size:13px;color:#065f46;">
          SMTP configuration is working correctly. You will receive notifications for enabled events.
        </div>
        <div style="margin-top:16px;padding:10px 14px;background:#f9fafb;border-radius:4px;font-size:12px;color:#666;">
          This is a test email sent from DockGate at ${new Date().toLocaleString()}.
        </div>
      </div>
    ${footer()}`;
}

module.exports = {
  containerDieTemplate,
  containerRestartTemplate,
  containerOomTemplate,
  containerUnhealthyTemplate,
  diskAlertTemplate,
  buildFailTemplate,
  containerLifecycleTemplate,
  testEmailTemplate,
};
