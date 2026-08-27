// SMTP sender — PORT of server/notifications/mailer.js. Transport build is verbatim
// (secure when port 465, optional auth, three 10s timeouts). Config comes from cfg.smtp;
// the [DockGate] subject prefix is kept so emails read identically to the panel.
const nodemailer = require('nodemailer');
const { cfg } = require('./config');

let _transport = null;
function transport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: (cfg.smtp.user && cfg.smtp.pass) ? {
      user: cfg.smtp.user,
      pass: cfg.smtp.pass,
    } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  return _transport;
}

async function sendEmail({ subject, html }) {
  if (!cfg.smtp.host) return { success: false, error: 'SMTP not configured' };
  const recipient = cfg.smtp.to;
  if (!recipient) return { success: false, error: 'No recipient configured' };
  try {
    await transport().sendMail({
      from: cfg.smtp.from,
      to: recipient,
      subject: `[DockGate] ${subject}`,
      html,
    });
    console.log('[agent] email sent');
    return { success: true };
  } catch (err) {
    console.warn('[agent] email failed:', err.message);
    return { success: false, error: err.message };
  }
}

function isConfigured() { return cfg.smtp.isConfigured; }

module.exports = { sendEmail, isConfigured };
