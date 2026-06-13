// Provisioning check-matrix — the SINGLE source of truth for both the runner and the read-only
// "how it works" explainer. Each item declares, per distro family, a detect / install / verify shell
// command. Commands run over SSH as the connecting user; privileged steps use `sudo` (the runner gates
// on sudo/root capability). detect exit 0 => already present => install is skipped (idempotent).
//
// SAFETY: commands here are the ONLY thing the runner may execute — the UI can never inject free shell
// (it only toggles item ids). Lockout-risky items (firewall, ssh-hardening) carry risk:'high' and are
// guarded by the runner (key-present check, SSH-allow bundle, explicit confirm).

// Canonical order (lower seq runs first): base → identity → perimeter → service.
const ITEMS = [
  {
    id: 'update', seq: 10, label: 'System update', group: 'base', risk: 'low', needsSudo: true,
    // An ACTION, not a detectable component: you can't idempotently "detect" a fully-upgraded system,
    // so detect is `false` (always runs). The UI shows it as "runs every time", not "missing".
    alwaysRun: true,
    description: 'Refresh the package index and apply available upgrades — closes known CVEs before anything else is installed.',
    distro: {
      debian: { detect: 'false', install: 'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade', verify: 'true' },
      rhel:   { detect: 'false', install: 'sudo dnf -y upgrade --refresh', verify: 'true' },
      alpine: { detect: 'false', install: 'sudo apk update && sudo apk upgrade --available', verify: 'true' },
    },
  },
  {
    id: 'base-utils', seq: 20, label: 'Base utilities', group: 'base', risk: 'low', needsSudo: true,
    description: 'curl, ca-certificates, gnupg, git — prerequisites for the Docker repo and most setup steps.',
    distro: {
      debian: { detect: 'command -v curl && command -v git && command -v gpg', install: 'sudo apt-get install -y curl ca-certificates gnupg git', verify: 'command -v curl && command -v git' },
      rhel:   { detect: 'command -v curl && command -v git', install: 'sudo dnf -y install curl ca-certificates gnupg2 git', verify: 'command -v curl && command -v git' },
      alpine: { detect: 'command -v curl && command -v git', install: 'sudo apk add curl ca-certificates gnupg git', verify: 'command -v curl && command -v git' },
    },
  },
  {
    id: 'timesync', seq: 30, label: 'Time sync (chrony)', group: 'system', risk: 'low', needsSudo: true,
    description: 'Accurate clock — TLS, logs and 2FA all depend on it.',
    distro: {
      debian: { detect: 'command -v chronyd || timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes', install: 'sudo apt-get install -y chrony && sudo systemctl enable --now chrony 2>/dev/null || sudo systemctl enable --now chronyd', verify: 'timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes || systemctl is-active chronyd' },
      rhel:   { detect: 'command -v chronyd', install: 'sudo dnf -y install chrony && sudo systemctl enable --now chronyd', verify: 'systemctl is-active chronyd' },
      alpine: { detect: 'command -v chronyd', install: 'sudo apk add chrony && sudo rc-update add chronyd default && sudo rc-service chronyd start', verify: 'rc-service chronyd status' },
    },
  },
  {
    id: 'firewall', seq: 40, label: 'Firewall (UFW)', group: 'security', risk: 'high', needsSudo: true,
    description: 'Default-deny incoming, allow only SSH + 80/443. The CURRENT SSH port is allowed BEFORE enabling, so you are not locked out.',
    distro: {
      // Allow the port we're actually connected on (SSH_CONNECTION server port) before enabling — lockout guard.
      debian: {
        detect: 'sudo ufw status 2>/dev/null | grep -qi "Status: active"',
        install: 'sudo apt-get install -y ufw && P=$(echo "$SSH_CONNECTION" | awk "{print \\$4}") && sudo ufw allow "${P:-22}"/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable',
        verify: 'sudo ufw status | grep -qi "Status: active"',
      },
      rhel: {
        detect: 'sudo firewall-cmd --state 2>/dev/null | grep -qx running',
        install: 'sudo dnf -y install firewalld && sudo systemctl enable --now firewalld && sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --permanent --add-service=http && sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload',
        verify: 'sudo firewall-cmd --state | grep -qx running',
      },
    },
  },
  {
    id: 'ssh-hardening', seq: 50, label: 'SSH hardening', group: 'security', risk: 'low', needsSudo: true,
    // SAFE hardening only — deliberately does NOT disable password auth or root password login, because
    // that locks out password-based servers (e.g. a default DigitalOcean root+password VPS). It limits
    // auth attempts, disables empty passwords + X11 forwarding, and adds an idle timeout — none of which
    // can cut your login. Brute-force is handled by fail2ban. The drop-in self-cleans if `sshd -t` rejects it.
    description: 'Safe SSH hardening — limit auth attempts, disable empty passwords & X11 forwarding, add an idle timeout. Does NOT disable password login, so it can never lock you out (works on key OR password servers). Brute-force is handled by fail2ban.',
    distro: {
      debian: {
        detect: 'sudo sshd -T 2>/dev/null | grep -qi "^maxauthtries 3"',
        install: 'printf "MaxAuthTries 3\\nLoginGraceTime 30\\nPermitEmptyPasswords no\\nX11Forwarding no\\nClientAliveInterval 300\\nClientAliveCountMax 2\\n" | sudo tee /etc/ssh/sshd_config.d/99-dockgate.conf >/dev/null && (sudo sshd -t && (sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd) || (sudo rm -f /etc/ssh/sshd_config.d/99-dockgate.conf; false))',
        verify: 'sudo sshd -T | grep -qi "^maxauthtries 3"',
      },
      rhel: {
        detect: 'sudo sshd -T 2>/dev/null | grep -qi "^maxauthtries 3"',
        install: 'printf "MaxAuthTries 3\\nLoginGraceTime 30\\nPermitEmptyPasswords no\\nX11Forwarding no\\nClientAliveInterval 300\\nClientAliveCountMax 2\\n" | sudo tee /etc/ssh/sshd_config.d/99-dockgate.conf >/dev/null && (sudo sshd -t && sudo systemctl reload sshd || (sudo rm -f /etc/ssh/sshd_config.d/99-dockgate.conf; false))',
        verify: 'sudo sshd -T | grep -qi "^maxauthtries 3"',
      },
    },
  },
  {
    id: 'fail2ban', seq: 60, label: 'Fail2ban', group: 'security', risk: 'low', needsSudo: true,
    description: 'Bans IPs after repeated failed SSH logins — reduces brute-force noise.',
    distro: {
      debian: { detect: 'command -v fail2ban-client', install: 'sudo apt-get install -y fail2ban && printf "[sshd]\\nenabled = true\\nbackend = systemd\\n" | sudo tee /etc/fail2ban/jail.local >/dev/null && sudo systemctl enable --now fail2ban', verify: 'systemctl is-active fail2ban' },
      rhel:   { detect: 'command -v fail2ban-client', install: 'sudo dnf -y install epel-release && sudo dnf -y install fail2ban && printf "[sshd]\\nenabled = true\\nbackend = systemd\\n" | sudo tee /etc/fail2ban/jail.local >/dev/null && sudo systemctl enable --now fail2ban', verify: 'systemctl is-active fail2ban' },
    },
  },
  {
    id: 'unattended-upgrades', seq: 70, label: 'Automatic security updates', group: 'security', risk: 'low', needsSudo: true,
    description: 'Applies security patches automatically going forward.',
    distro: {
      debian: { detect: 'dpkg -l unattended-upgrades 2>/dev/null | grep -q "^ii"', install: 'sudo apt-get install -y unattended-upgrades && printf "APT::Periodic::Update-Package-Lists \\"1\\";\\nAPT::Periodic::Unattended-Upgrade \\"1\\";\\n" | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null', verify: 'dpkg -l unattended-upgrades | grep -q "^ii"' },
      rhel:   { detect: 'rpm -q dnf-automatic', install: 'sudo dnf -y install dnf-automatic && sudo sed -i "s/^apply_updates =.*/apply_updates = yes/" /etc/dnf/automatic.conf && sudo systemctl enable --now dnf-automatic.timer', verify: 'systemctl is-enabled dnf-automatic.timer' },
    },
  },
  {
    id: 'swap', seq: 80, label: 'Swap file', group: 'system', risk: 'low', needsSudo: true, optional: true,
    description: 'A 2GB swap file + low swappiness — an OOM safety net for Docker build/run on small VPSes.',
    distro: {
      debian: { detect: 'swapon --show | grep -q .', install: 'sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && (grep -q "/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null) && echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-swappiness.conf >/dev/null && sudo sysctl --system >/dev/null', verify: 'swapon --show | grep -q .' },
      rhel:   { detect: 'swapon --show | grep -q .', install: 'sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && (grep -q "/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null)', verify: 'swapon --show | grep -q .' },
    },
  },
  {
    id: 'docker', seq: 90, label: 'Docker Engine + Compose', group: 'base', risk: 'medium', needsSudo: true,
    description: 'Docker Engine, CLI, containerd, buildx and the compose v2 plugin from Docker\'s official repository.',
    distro: {
      // get.docker.com is fine for first install when detect-gated (we never re-run it); compose plugin comes with it.
      debian: { detect: 'command -v docker && docker compose version', install: 'curl -fsSL https://get.docker.com | sudo sh && sudo systemctl enable --now docker', verify: 'sudo docker info >/dev/null 2>&1 && docker compose version' },
      rhel:   { detect: 'command -v docker && docker compose version', install: 'curl -fsSL https://get.docker.com | sudo sh && sudo systemctl enable --now docker', verify: 'sudo docker info >/dev/null 2>&1 && docker compose version' },
      alpine: { detect: 'command -v docker && docker compose version', install: 'sudo apk add docker docker-cli-compose && sudo rc-update add docker default && sudo rc-service docker start', verify: 'sudo docker info >/dev/null 2>&1' },
    },
  },
  {
    id: 'docker-group', seq: 100, label: 'Docker group (rootless CLI)', group: 'base', risk: 'medium', needsSudo: true, optional: true,
    description: 'Add the SSH user to the docker group so `docker` runs without sudo. NOTE: docker-group membership is root-equivalent.',
    dependsOn: ['docker'],
    distro: {
      debian: { detect: 'id -nG | grep -qw docker', install: 'sudo usermod -aG docker "$(id -un)"', verify: 'getent group docker | grep -qw "$(id -un)"' },
      rhel:   { detect: 'id -nG | grep -qw docker', install: 'sudo usermod -aG docker "$(id -un)"', verify: 'getent group docker | grep -qw "$(id -un)"' },
      alpine: { detect: 'id -nG | grep -qw docker', install: 'sudo addgroup "$(id -un)" docker', verify: 'getent group docker | grep -qw "$(id -un)"' },
    },
  },
];

// Preset → ordered item ids. 'custom' is supplied by the UI via the `only` list.
const PRESETS = {
  'just-docker': ['update', 'docker', 'docker-group'],
  'secure-baseline': ['update', 'base-utils', 'firewall', 'ssh-hardening', 'fail2ban', 'docker', 'docker-group'],
  'full': ITEMS.map(i => i.id),
};

const byId = Object.fromEntries(ITEMS.map(i => [i.id, i]));

// Map an /etc/os-release ID (or ID_LIKE) to a distro family key used in item.distro.
function distroFamily(osId) {
  const id = String(osId || '').toLowerCase();
  if (/(debian|ubuntu|mint|pop|raspbian|kali)/.test(id)) return 'debian';
  if (/(rhel|centos|fedora|rocky|almalinux|alma|amzn|ol)/.test(id)) return 'rhel';
  if (/alpine/.test(id)) return 'alpine';
  return null;
}

// Resolve a preset (or custom `only` list) to an ordered, dependency-closed list of item ids.
function resolveItems(preset, only) {
  let ids;
  if (preset === 'custom') ids = Array.isArray(only) ? only.filter(id => byId[id]) : [];
  else ids = (PRESETS[preset] || []).slice();
  // pull in dependsOn
  const set = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...set]) {
      for (const dep of (byId[id].dependsOn || [])) {
        if (!set.has(dep)) { set.add(dep); changed = true; }
      }
    }
  }
  return [...set].sort((a, b) => byId[a].seq - byId[b].seq);
}

// Build a concrete execution plan for a distro. Throws (no fabricated commands) on an unknown/unsupported distro.
function buildPlanForDistro(itemIds, osId) {
  const family = distroFamily(osId);
  if (!family) { const e = new Error(`Unsupported distro: ${osId || '(unknown)'}`); e.statusCode = 400; throw e; }
  const plan = [];
  for (const id of itemIds) {
    const item = byId[id];
    if (!item) continue;
    const cmds = item.distro[family];
    if (!cmds) { plan.push({ id, seq: item.seq, label: item.label, risk: item.risk, requiresKey: !!item.requiresKey, na: true, reason: `not available on ${family}` }); continue; }
    plan.push({ id, seq: item.seq, label: item.label, risk: item.risk, requiresKey: !!item.requiresKey, detect: cmds.detect, install: cmds.install, verify: cmds.verify });
  }
  return plan;
}

// Apply the lockout/risk guards on top of resolveItems. `hasKey` = the server uses key-based SSH.
// Returns { itemIds, skipped }. Throws an error with statusCode 409 + .risks when high-risk items
// (firewall, ssh-hardening) are requested without explicit confirmation. Pure — no DB/SSH.
function guardedResolve({ hasKey, preset, only, confirm }) {
  let ids = resolveItems(preset, only);
  const skipped = [];
  ids = ids.filter(id => {
    if (byId[id].requiresKey && !hasKey) {
      skipped.push({ id, label: byId[id].label, reason: 'requires key-based SSH (would lock out a password login)' });
      return false;
    }
    return true;
  });
  const risks = ids.filter(id => byId[id].risk === 'high').map(id => ({ id, label: byId[id].label }));
  if (risks.length && !confirm) {
    const e = new Error('Confirmation required for risky steps');
    e.statusCode = 409;
    e.risks = risks;
    throw e;
  }
  return { itemIds: ids, skipped };
}

// ============================================================================
// PHASE 5 — Service control (post-setup management). ADDITIVE: this does not touch
// the ITEMS/PRESETS provisioning matrix above. Each manageable item declares, per distro
// family, the systemd/openrc unit + an ALLOWLIST of editable config paths. The UI passes
// only an itemId + an action id (and, for a write, a content blob) — NEVER free shell and
// NEVER a path. The concrete command is resolved HERE from catalog constants.
// ============================================================================
const SERVICE = {
  timesync: {
    risk: 'low',
    family: {
      debian: { manager: 'systemd', unit: 'chrony',   configPaths: ['/etc/chrony/chrony.conf'] },
      rhel:   { manager: 'systemd', unit: 'chronyd',  configPaths: ['/etc/chrony.conf'] },
      alpine: { manager: 'openrc',  unit: 'chronyd',  configPaths: ['/etc/chrony/chrony.conf'] },
    },
  },
  firewall: {
    risk: 'high',
    family: {
      debian: { manager: 'systemd', unit: 'ufw',       configPaths: ['/etc/default/ufw'] },
      rhel:   { manager: 'systemd', unit: 'firewalld', configPaths: ['/etc/firewalld/firewalld.conf'], validate: 'sudo firewall-cmd --check-config' },
    },
  },
  'ssh-hardening': {
    risk: 'high', requiresKeyForConfig: true,
    family: {
      debian: { manager: 'systemd', unit: 'ssh',  reload: true, configPaths: ['/etc/ssh/sshd_config.d/99-dockgate.conf'], validate: 'sudo sshd -t' },
      rhel:   { manager: 'systemd', unit: 'sshd', reload: true, configPaths: ['/etc/ssh/sshd_config.d/99-dockgate.conf'], validate: 'sudo sshd -t' },
    },
  },
  fail2ban: {
    risk: 'low',
    family: {
      debian: { manager: 'systemd', unit: 'fail2ban', configPaths: ['/etc/fail2ban/jail.local'], validate: 'sudo fail2ban-client -t' },
      rhel:   { manager: 'systemd', unit: 'fail2ban', configPaths: ['/etc/fail2ban/jail.local'], validate: 'sudo fail2ban-client -t' },
    },
  },
  'unattended-upgrades': {
    risk: 'low',
    family: {
      debian: { manager: 'systemd', unit: 'apt-daily-upgrade.timer', timer: true, configPaths: ['/etc/apt/apt.conf.d/20auto-upgrades'], validate: 'apt-config dump >/dev/null 2>&1' },
      rhel:   { manager: 'systemd', unit: 'dnf-automatic.timer',     timer: true, configPaths: ['/etc/dnf/automatic.conf'] },
    },
  },
  docker: {
    risk: 'medium',
    family: {
      debian: { manager: 'systemd', unit: 'docker', configPaths: ['/etc/docker/daemon.json'] },
      rhel:   { manager: 'systemd', unit: 'docker', configPaths: ['/etc/docker/daemon.json'] },
      alpine: { manager: 'openrc',  unit: 'docker', configPaths: ['/etc/docker/daemon.json'] },
    },
  },
};

const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'];
// Destructive actions that, on a high-risk service (firewall/ssh) or on docker, require confirm.
const DESTRUCTIVE = ['stop', 'restart', 'disable'];

// Concrete action/status commands for a unit, per init system. unit comes from SERVICE (a catalog
// constant), never from the request — so interpolation here cannot be an injection vector.
function serviceVerbs(manager, unit, reload) {
  if (manager === 'openrc') {
    return {
      start:   `sudo rc-service ${unit} start`,
      stop:    `sudo rc-service ${unit} stop`,
      restart: `sudo rc-service ${unit} restart`,
      enable:  `sudo rc-update add ${unit} default && sudo rc-service ${unit} start`,
      disable: `sudo rc-update del ${unit} default && sudo rc-service ${unit} stop`,
      apply:   `sudo rc-service ${unit} restart`,
      status:  `rc-service ${unit} status >/dev/null 2>&1 && echo active || echo inactive`,
      enabled: `rc-update show default 2>/dev/null | grep -qw ${unit} && echo enabled || echo disabled`,
    };
  }
  return {
    start:   `sudo systemctl start ${unit}`,
    stop:    `sudo systemctl stop ${unit}`,
    restart: reload ? `sudo systemctl reload ${unit}` : `sudo systemctl restart ${unit}`,
    enable:  `sudo systemctl enable --now ${unit}`,
    disable: `sudo systemctl disable --now ${unit}`,
    apply:   reload ? `sudo systemctl reload ${unit}` : `sudo systemctl restart ${unit}`,
    status:  `systemctl is-active ${unit} 2>/dev/null || echo inactive`,
    enabled: `systemctl is-enabled ${unit} 2>/dev/null || echo disabled`,
  };
}

// Ids that have a service block (manageable post-setup). Order = catalog seq.
function manageableItems() {
  return ITEMS.filter(i => SERVICE[i.id]).map(i => i.id);
}

// Resolve a manageable service for a distro. null = not a manageable item; {na:true} = no variant on
// this distro family; throws 400 on an unknown distro (no fabricated commands).
function serviceFor(itemId, osId) {
  const item = byId[itemId];
  const def = SERVICE[itemId];
  if (!item || !def) return null;
  const family = distroFamily(osId);
  if (!family) { const e = new Error(`Unsupported distro: ${osId || '(unknown)'}`); e.statusCode = 400; throw e; }
  const f = def.family[family];
  if (!f) return { itemId, label: item.label, na: true, reason: `not manageable on ${family}`, risk: def.risk || item.risk };
  return {
    itemId, label: item.label, family, manager: f.manager, unit: f.unit,
    timer: !!f.timer, reload: !!f.reload, risk: def.risk || item.risk,
    requiresKeyForConfig: !!def.requiresKeyForConfig,
    configPaths: (f.configPaths || []).slice(),
    validate: f.validate || null,
    verbs: serviceVerbs(f.manager, f.unit, f.reload),
  };
}

// The fixed shell command for a lifecycle action. Throws 400 on unknown action/item/na.
function serviceAction(itemId, osId, action) {
  if (!SERVICE_ACTIONS.includes(action)) { const e = new Error(`Unknown action: ${action}`); e.statusCode = 400; throw e; }
  const svc = serviceFor(itemId, osId);
  if (!svc) { const e = new Error(`Not a manageable service: ${itemId}`); e.statusCode = 400; throw e; }
  if (svc.na) { const e = new Error(svc.reason); e.statusCode = 400; throw e; }
  return svc.verbs[action];
}

// Exact-match allowlist check for a config path. Rejects non-absolute, traversal, NUL, and any path
// not declared in the item's configPaths for this distro.
function isConfigPathAllowed(itemId, osId, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('\0')) return false;
  let svc;
  try { svc = serviceFor(itemId, osId); } catch { return false; }
  if (!svc || svc.na) return false;
  return svc.configPaths.includes(path);
}

// Guard for any server-mutating service operation. Throws 409 (+.risks) when confirmation is required
// but not given, or 400 for an SSH-config write over a password login (lockout). Pure — no DB/SSH.
function guardedServiceAction({ hasKey, itemId, osId, action, isConfigWrite, confirm }) {
  const item = byId[itemId];
  const def = SERVICE[itemId];
  if (!item || !def) { const e = new Error(`Not a manageable service: ${itemId}`); e.statusCode = 400; throw e; }
  // Distro-specific na check only when osId is known. The action endpoint resolves distro inside the
  // worker (it cannot know it without an SSH probe), so na is enforced there.
  if (osId) { const svc = serviceFor(itemId, osId); if (svc.na) { const e = new Error(svc.reason); e.statusCode = 400; throw e; } }
  if (!isConfigWrite && !SERVICE_ACTIONS.includes(action)) { const e = new Error(`Unknown action: ${action}`); e.statusCode = 400; throw e; }
  const highRisk = (def.risk || item.risk) === 'high';
  // SSH config edit over a password login would lock you out — refuse.
  if (isConfigWrite && def.requiresKeyForConfig && !hasKey) {
    const e = new Error('Editing SSH config over a password login could lock you out — connect with an SSH key first');
    e.statusCode = 400; throw e;
  }
  // Stopping or disabling the SSH daemon over a password login would lock you out (reload/restart keeps
  // the live connection, but stop/disable kills it). requiresKeyForConfig marks ssh-hardening as that lifeline.
  if (def.requiresKeyForConfig && !hasKey && (action === 'stop' || action === 'disable')) {
    const e = new Error('Stopping or disabling SSH over a password login would lock you out — connect with an SSH key first');
    e.statusCode = 400; throw e;
  }
  // Confirm gate: every config write, plus destructive actions on a high-risk service or on docker.
  const destructive = DESTRUCTIVE.includes(action) && (highRisk || itemId === 'docker');
  const needsConfirm = isConfigWrite || destructive;
  if (needsConfirm && !confirm) {
    const e = new Error('Confirmation required for this action');
    e.statusCode = 409;
    e.risks = [{ id: itemId, label: item.label, reason: isConfigWrite ? 'edits a config file on the server' : 'restart/stop disrupts the service' }];
    throw e;
  }
  return { ok: true, highRisk, destructive };
}

// ============================================================================
// PHASE 5b — service-specific RICH operations (parameterised): fail2ban ban/unban,
// ufw/firewalld add/remove port. The UI passes an opId + named params; the params are
// strictly validated to a charset that CANNOT contain shell metacharacters before being
// interpolated into the catalog command. The command itself is a catalog constant.
// ============================================================================

// Validate a single param. Returns the safe string, or null if invalid. The accepted charset for every
// type excludes shell metacharacters, so a validated value is injection-safe to interpolate.
function isIpOrCidr(s) {
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(s);
  if (m4) {
    if ([m4[1], m4[2], m4[3], m4[4]].some(o => Number(o) > 255)) return false;
    if (m4[5] !== undefined && Number(m4[5]) > 32) return false;
    return true;
  }
  // IPv6 [/CIDR] — hex + colon only (no shell metachars possible); CIDR ≤128. Light semantic check.
  const m6 = /^([0-9a-fA-F:]{2,45})(?:\/(\d{1,3}))?$/.exec(s);
  if (m6 && s.includes(':')) {
    if (m6[2] !== undefined && Number(m6[2]) > 128) return false;
    return true;
  }
  return false;
}
function validateParam(type, val) {
  const s = String(val == null ? '' : val).trim();
  if (!s) return null;
  switch (type) {
    case 'ip': return isIpOrCidr(s) ? s : null;
    case 'jail': return /^[a-zA-Z0-9_.-]{1,64}$/.test(s) ? s : null;
    case 'port': { const n = Number(s); return (Number.isInteger(n) && n >= 1 && n <= 65535) ? String(n) : null; }
    case 'proto': return (s === 'tcp' || s === 'udp') ? s : null;
    case 'rulenum': { const n = Number(s); return (Number.isInteger(n) && n >= 1 && n <= 9999) ? String(n) : null; }
    default: return null;
  }
}

const SERVICE_OPS = {
  fail2ban: {
    distroAgnostic: true,
    listLabel: 'Jails & banned IPs',
    ops: [
      { id: 'ban',   label: 'Ban IP',   risk: 'medium', confirm: true,  params: [{ name: 'jail', type: 'jail', placeholder: 'sshd' }, { name: 'ip', type: 'ip', placeholder: '203.0.113.4' }], cmd: (p) => `sudo fail2ban-client set ${p.jail} banip ${p.ip}` },
      { id: 'unban', label: 'Unban IP', risk: 'low',    confirm: false, params: [{ name: 'jail', type: 'jail', placeholder: 'sshd' }, { name: 'ip', type: 'ip', placeholder: '203.0.113.4' }], cmd: (p) => `sudo fail2ban-client set ${p.jail} unbanip ${p.ip}` },
    ],
  },
  firewall: {
    family: {
      debian: {
        listLabel: 'UFW rules',
        ops: [
          { id: 'allow',  label: 'Allow port',   risk: 'low',  confirm: false, params: [{ name: 'port', type: 'port', placeholder: '8080' }, { name: 'proto', type: 'proto', placeholder: 'tcp' }], cmd: (p) => `sudo ufw allow ${p.port}/${p.proto}` },
          { id: 'deny',   label: 'Deny port',    risk: 'high', confirm: true,  params: [{ name: 'port', type: 'port', placeholder: '8080' }, { name: 'proto', type: 'proto', placeholder: 'tcp' }], cmd: (p) => `sudo ufw deny ${p.port}/${p.proto}` },
          { id: 'delete', label: 'Delete rule #', risk: 'high', confirm: true, params: [{ name: 'num', type: 'rulenum', placeholder: '2' }], cmd: (p) => `sudo ufw --force delete ${p.num}` },
        ],
      },
      rhel: {
        listLabel: 'firewalld ports',
        ops: [
          { id: 'allow', label: 'Add port',    risk: 'low',  confirm: false, params: [{ name: 'port', type: 'port', placeholder: '8080' }, { name: 'proto', type: 'proto', placeholder: 'tcp' }], cmd: (p) => `sudo firewall-cmd --permanent --add-port=${p.port}/${p.proto} && sudo firewall-cmd --reload` },
          { id: 'deny',  label: 'Remove port', risk: 'high', confirm: true,  params: [{ name: 'port', type: 'port', placeholder: '8080' }, { name: 'proto', type: 'proto', placeholder: 'tcp' }], cmd: (p) => `sudo firewall-cmd --permanent --remove-port=${p.port}/${p.proto} && sudo firewall-cmd --reload` },
        ],
      },
    },
  },
};

// Resolve the ops definition for an item on a distro. null = no rich ops; throws 400 on unknown distro.
function opsDefFor(itemId, osId) {
  const def = SERVICE_OPS[itemId];
  if (!def) return null;
  if (def.distroAgnostic) return def;
  const family = distroFamily(osId);
  if (!family) { const e = new Error(`Unsupported distro: ${osId || '(unknown)'}`); e.statusCode = 400; throw e; }
  return def.family[family] || null;
}

// All ops for an item across families (distro-agnostic lookups for the route gate).
function allOpsFor(itemId) {
  const def = SERVICE_OPS[itemId];
  if (!def) return [];
  return def.distroAgnostic ? def.ops : Object.values(def.family || {}).flatMap(f => f.ops || []);
}
function opParamSchema(itemId, opId) { const o = allOpsFor(itemId).find(o => o.id === opId); return o ? o.params : null; }
function opRequiresConfirm(itemId, opId) { return allOpsFor(itemId).some(o => o.id === opId && o.confirm); }

// UI metadata for an item's rich ops (no command functions exposed).
function serviceOpsMeta(itemId, osId) {
  const def = opsDefFor(itemId, osId);
  if (!def) return null;
  return {
    itemId, listLabel: def.listLabel || null,
    ops: (def.ops || []).map(o => ({ id: o.id, label: o.label, risk: o.risk, confirm: !!o.confirm, params: o.params.map(p => ({ name: p.name, type: p.type, placeholder: p.placeholder || '' })) })),
  };
}

// Build the concrete command for a rich op, validating every param. Throws 400 (bad param / unknown op)
// or 409 (confirm required). Pure.
function buildServiceOp(itemId, osId, opId, rawParams, { confirm } = {}) {
  const def = opsDefFor(itemId, osId);
  if (!def) { const e = new Error('This service has no operations on this distro'); e.statusCode = 400; throw e; }
  const op = (def.ops || []).find(o => o.id === opId);
  if (!op) { const e = new Error(`Unknown operation: ${opId}`); e.statusCode = 400; throw e; }
  const params = {};
  for (const p of op.params) {
    const v = validateParam(p.type, (rawParams || {})[p.name]);
    if (v == null) { const e = new Error(`Invalid ${p.name} (expected ${p.type})`); e.statusCode = 400; throw e; }
    params[p.name] = v;
  }
  if (op.confirm && !confirm) { const e = new Error('Confirmation required for this operation'); e.statusCode = 409; e.risks = [{ id: itemId, label: op.label, reason: 'changes firewall/ban state' }]; throw e; }
  return { cmd: op.cmd(params), op };
}

// What to run to LIST current state for an item's ops (the worker interprets `kind`).
function serviceOpListPlan(itemId, osId) {
  if (itemId === 'fail2ban') return { kind: 'fail2ban' };
  if (itemId === 'firewall') {
    const family = distroFamily(osId);
    if (family === 'debian') return { kind: 'text', cmd: 'sudo ufw status numbered' };
    if (family === 'rhel') return { kind: 'text', cmd: 'sudo firewall-cmd --list-all' };
  }
  return null;
}

module.exports = {
  ITEMS, PRESETS, byId, distroFamily, resolveItems, buildPlanForDistro, guardedResolve,
  // PHASE 5 service control
  SERVICE, SERVICE_ACTIONS, serviceVerbs, manageableItems, serviceFor, serviceAction, isConfigPathAllowed, guardedServiceAction,
  // PHASE 5b rich ops
  SERVICE_OPS, isIpOrCidr, validateParam, opsDefFor, allOpsFor, opParamSchema, opRequiresConfirm, serviceOpsMeta, buildServiceOp, serviceOpListPlan,
};
