// ssh2 connect options for the isolated WORKER processes (service-ctl, host-stats, host-logs,
// grant-docker, provisioning, security). One place for the auth precedence and the pinned host key.
//
// cfg: { host, port, username, keyPath?, password?, passphrase?, hostKey? }
//   keyPath   absolute path of the private key (wins over password)
//   hostKey   pinned SHA256 fingerprint — when set, a different host key is refused
const fs = require('fs');
const { strictVerifier } = require('./ssh-hostkey');

function workerConnectOpts(cfg, extra = {}) {
  const opts = {
    host: cfg.host, port: cfg.port || 22, username: cfg.username,
    readyTimeout: 20000, agent: false, tryKeyboard: false,
    hostVerifier: strictVerifier(cfg.hostKey || null),
    ...extra,
  };
  if (cfg.keyPath) { opts.privateKey = fs.readFileSync(cfg.keyPath); if (cfg.passphrase) opts.passphrase = cfg.passphrase; }
  else if (cfg.password) opts.password = cfg.password;
  return opts;
}

module.exports = { workerConnectOpts };
