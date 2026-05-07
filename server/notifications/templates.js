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

function containerDieTemplate({ containerName, containerId, image, time, exitCode, server }) {
  return `${header('Container Stopped')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fff3f3;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#b91c1c;">
          Container <strong>${containerName}</strong> has stopped unexpectedly.
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Container', containerName)}
          ${row('ID', containerId)}
          ${row('Image', image || '—')}
          ${row('Exit Code', exitCode ?? '—')}
          ${row('Time', time)}
        </table>
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

function containerUnhealthyTemplate({ containerName, containerId, image, time, failingStreak, lastOutput, server }) {
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
      </div>
    ${footer()}`;
}

function containerOomTemplate({ containerName, containerId, image, time, server }) {
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
      </div>
    ${footer()}`;
}

function diskAlertTemplate({ usagePercent, totalSpace, usedSpace, threshold, server }) {
  const barColor = usagePercent > 90 ? '#ef4444' : '#f59e0b';
  return `${header('Disk Usage Alert')}
      <div style="padding:20px 24px;border:1px solid #e0e0e0;border-top:0;">
        <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#92400e;">
          Docker disk usage has exceeded the <strong>${threshold}%</strong> threshold.
        </div>
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span>Disk Usage</span><span style="font-weight:600;">${usagePercent}%</span>
          </div>
          <div style="background:#e5e7eb;border-radius:4px;height:8px;overflow:hidden;">
            <div style="background:${barColor};height:100%;width:${Math.min(usagePercent, 100)}%;border-radius:4px;"></div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${serverRow(server)}
          ${row('Used', usedSpace)}
          ${row('Total', totalSpace)}
          ${row('Threshold', threshold + '%')}
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
  testEmailTemplate,
};
