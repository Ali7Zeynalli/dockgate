// Helpers shared by the server routes (security.js, firewall.js): load the server row, build the SSH
// config, the JSON error wrapper, audit, confirm gate, and running read scripts / plans.
const crypto = require('crypto');
const { stmts } = require('../db');
const { logAction } = require('../audit');
const { decrypt } = require('../auth/secrets');
const P = require('./parse');
const runner = require('./runner');
const hostkey = require('../ssh-hostkey');
const paths = require('../paths');

function loadServer(req) {
  const row = stmts.getServer.get(req.params.id);
  if (!row) throw P.httpError(404, 'Server not found');
  if (row.id === 'local' || row.type === 'local') throw P.httpError(400, 'These settings apply to remote SSH servers');
  return row;
}
function cfgOf(row) {
  return { ...row, keyPath: paths.keyPath(row.key_path), password: decrypt(row.password), passphrase: decrypt(row.passphrase) };
}
function requireConfirm(body) {
  if (!body || body.confirm !== true) throw P.httpError(409, 'Confirmation required', { risks: [] });
}
const send = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) {
    const status = err.statusCode || (hostkey.isHostKeyError(err) ? 502 : 500);
    const message = hostkey.isHostKeyError(err) ? hostkey.MISMATCH_MESSAGE : err.message;
    res.status(status).json({ error: message, ...(err.risks ? { risks: err.risks } : {}) });
  }
};
const audit = (req, row, action, details) => logAction({ req, server: row.id, resourceType: 'server', resourceId: row.id, resourceName: row.name || row.id, action, details });
const newId = () => crypto.randomBytes(5).toString('hex');
async function readState(row, script) { return P.sections(await runner.read(cfgOf(row), script)); }
async function runOrThrow(row, plan, title) {
  const job = await runner.runAndWait(cfgOf(row), plan, { title });
  if (job.status !== 'done') throw P.httpError(400, String(job.error || 'Failed').trim().split('\n').slice(-3).join(' '));
  return job;
}

module.exports = { loadServer, cfgOf, requireConfirm, send, audit, newId, readState, runOrThrow };
