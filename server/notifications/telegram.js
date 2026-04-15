// Telegram Bot notification service
const https = require('https');
const { stmts } = require('../db');

function getTelegramSettings() {
  const rows = stmts.getSmtpConfig.all(); // shared config table
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  return { token: config.tg_token || '', chatId: config.tg_chat_id || '' };
}

function isConfigured() {
  const { token, chatId } = getTelegramSettings();
  return !!(token && chatId);
}

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
        } catch(e) { reject(new Error('Invalid Telegram response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram request timeout')); });
    req.write(data);
    req.end();
  });
}

async function sendMessage({ text, eventType }) {
  const { token, chatId } = getTelegramSettings();
  if (!token || !chatId) return { success: false, error: 'Telegram not configured' };

  try {
    await sendRequest(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    if (eventType) {
      stmts.insertNotificationLog.run(eventType, text.substring(0, 100), `telegram:${chatId}`, 'sent', null, 'telegram');
    }
    return { success: true };
  } catch (err) {
    if (eventType) {
      stmts.insertNotificationLog.run(eventType, text.substring(0, 100), `telegram:${chatId}`, 'failed', err.message, 'telegram');
    }
    return { success: false, error: err.message };
  }
}

async function sendTestMessage() {
  const { token, chatId } = getTelegramSettings();
  if (!token) return { success: false, error: 'Telegram bot token not configured' };
  if (!chatId) return { success: false, error: 'Telegram chat ID not configured' };

  return sendMessage({
    text: '🐳 <b>DockGate — Test Message</b>\n\nTelegram notification is working correctly.\nYou will receive alerts for enabled events.',
    eventType: 'test',
  });
}

// Convert HTML notification subject to Telegram-friendly text
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

module.exports = { sendMessage, sendTestMessage, getTelegramSettings, isConfigured, formatAlert };
