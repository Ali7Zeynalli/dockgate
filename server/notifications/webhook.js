// Webhook channel — a third channel next to email and Telegram. One URL; the body is shaped for the chosen
// service: Slack, Discord, Microsoft Teams, ntfy, or plain JSON for your own system. The URL is a secret
// (it is the credential for Slack/Discord/Teams), so it is stored encrypted like the Telegram token.
const { stmts } = require('../db');
const { decrypt } = require('../auth/secrets');

const FORMATS = ['slack', 'discord', 'teams', 'ntfy', 'json'];

function getWebhookSettings() {
  const cfg = {};
  for (const r of stmts.getSmtpConfig.all()) cfg[r.key] = r.value;
  return { url: decrypt(cfg.wh_url || ''), format: FORMATS.includes(cfg.wh_format) ? cfg.wh_format : 'json' };
}
function isConfigured() { return !!getWebhookSettings().url; }

/** Telegram text uses HTML tags and entities; webhooks get plain text. */
function plain(text) {
  return String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

function validUrl(u) {
  let x; try { x = new URL(u); } catch (e) { return false; }
  return x.protocol === 'https:' || x.protocol === 'http:';
}

/** Request for one message: { headers, body }. */
function build(format, { title, text, event, server }) {
  const t = plain(title), b = plain(text);
  switch (format) {
    case 'slack': return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${t}*\n${b}` }) };
    case 'discord': return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${t}**\n${b}`.slice(0, 2000) }) };
    case 'teams': return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `**${t}**\n\n${b.replace(/\n/g, '  \n')}` }) };
    case 'ntfy': return { headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: t.replace(/[^\x20-\x7E]/g, '').slice(0, 200) || 'DockGate' }, body: b || t };
    default: return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event || null, server: server || null, title: t, text: b, time: new Date().toISOString(), source: 'dockgate' }) };
  }
}

async function post(url, format, msg) {
  const { headers, body } = build(format, msg);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'DockGate', ...headers }, body, signal: ctl.signal, redirect: 'error' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`.trim());
  } finally { clearTimeout(to); }
}

/** Send an alert. text may contain Telegram HTML; it is converted to plain text. */
async function sendMessage({ title, text, eventType, server }) {
  const { url, format } = getWebhookSettings();
  if (!url) return { success: false, error: 'Webhook not configured' };
  const host = (() => { try { return new URL(url).host; } catch (e) { return 'webhook'; } })();
  const subject = plain(title || String(text || '').split('\n')[0]).slice(0, 100);
  try {
    await post(url, format, { title: title || String(text || '').split('\n')[0], text: title ? text : String(text || '').split('\n').slice(1).join('\n'), event: eventType, server });
    if (eventType) stmts.insertNotificationLog.run(eventType, subject, `webhook:${host}`, 'sent', null, 'webhook');
    return { success: true };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timed out after 10 s' : err.message;
    if (eventType) stmts.insertNotificationLog.run(eventType, subject, `webhook:${host}`, 'failed', msg, 'webhook');
    return { success: false, error: msg };
  }
}

function sendTestMessage() {
  return sendMessage({ title: 'DockGate test message', text: 'The webhook channel works. Alerts for enabled rules will arrive here.', eventType: 'test' });
}

module.exports = { FORMATS, getWebhookSettings, isConfigured, sendMessage, sendTestMessage, build, plain, validUrl };
