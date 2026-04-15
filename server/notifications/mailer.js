// SMTP mailer service
const nodemailer = require('nodemailer');
const { stmts } = require('../db');
const templates = require('./templates');

function getSmtpSettings() {
  const rows = stmts.getSmtpConfig.all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  return config;
}

function isConfigured() {
  const c = getSmtpSettings();
  return !!(c.smtp_host && c.smtp_port && c.smtp_from && c.smtp_to);
}

function createTransport(config) {
  const port = parseInt(config.smtp_port) || 587;
  return nodemailer.createTransport({
    host: config.smtp_host,
    port,
    secure: port === 465,
    auth: (config.smtp_user && config.smtp_pass) ? {
      user: config.smtp_user,
      pass: config.smtp_pass,
    } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
}

async function sendEmail({ to, subject, html, eventType }) {
  const config = getSmtpSettings();
  if (!config.smtp_host) return { success: false, error: 'SMTP not configured' };

  const recipient = to || config.smtp_to;
  if (!recipient) return { success: false, error: 'No recipient configured' };

  try {
    const transport = createTransport(config);
    await transport.sendMail({
      from: config.smtp_from,
      to: recipient,
      subject: `[DockGate] ${subject}`,
      html,
    });

    // Log successful send
    if (eventType) {
      stmts.insertNotificationLog.run(eventType, subject, recipient, 'sent', null, null);
    }

    return { success: true };
  } catch (err) {
    // Log failed send
    if (eventType) {
      stmts.insertNotificationLog.run(eventType, subject, recipient, 'failed', err.message, null);
    }
    return { success: false, error: err.message };
  }
}

async function sendTestEmail() {
  const config = getSmtpSettings();
  if (!config.smtp_host) return { success: false, error: 'SMTP not configured' };
  if (!config.smtp_to) return { success: false, error: 'No recipient email configured' };

  return sendEmail({
    subject: 'Test Email',
    html: templates.testEmailTemplate(),
    eventType: 'test',
  });
}

module.exports = { sendEmail, sendTestEmail, getSmtpSettings, isConfigured };
