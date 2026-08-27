// Telegram Bot sender — PORT of server/notifications/telegram.js with the DB stripped.
// sendRequest / formatAlert / escapeHtml are copied verbatim; config comes from cfg.telegram;
// notification-log inserts are replaced by console lines (the agent has no DB).
const https = require('https');
const { cfg } = require('./config');

function sendRequest(token, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description || 'Telegram API error'));
        } catch (e) { reject(new Error('Invalid Telegram response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram request timeout')); });
    req.write(data);
    req.end();
  });
}

async function sendMessage({ text }) {
  const { token, chatId } = cfg.telegram;
  if (!token || !chatId) return { success: false, error: 'Telegram not configured' };
  try {
    await sendRequest(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    console.log('[agent] telegram sent');
    return { success: true };
  } catch (err) {
    console.warn('[agent] telegram failed:', err.message);
    return { success: false, error: err.message };
  }
}

function isConfigured() { return cfg.telegram.isConfigured; }

// Convert an alert subject + details into Telegram-friendly HTML text. Verbatim from telegram.js:80-94.
function formatAlert(subject, details) {
  let msg = `🐳 <b>${escapeHtml(subject)}</b>\n`;
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined && value !== null && value !== '' && value !== '—') {
        msg += `\n<b>${escapeHtml(key)}:</b> <code>${escapeHtml(String(value))}</code>`;
      }
    }
  }
  return msg;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A "Recent logs" <pre> block to append after formatAlert(). Tail-trimmed + escaped. Empty if no logs.
function formatLogs(logs, max = 700) {
  if (!logs) return '';
  let t = String(logs).trim();
  if (!t) return '';
  if (t.length > max) t = '…' + t.slice(-max);
  return `\n\n📋 <b>Recent logs:</b>\n<pre>${escapeHtml(t)}</pre>`;
}

module.exports = { sendMessage, isConfigured, formatAlert, formatLogs };
