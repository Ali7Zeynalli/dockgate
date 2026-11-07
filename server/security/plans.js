// Command builders for the server-security features. Every command the security worker runs is built
// HERE from validated values only (usernames match USERNAME_RE, ports are integers, keys / file contents
// travel base64-encoded) — the UI never sends shell.
//
// `{{S}}` is the privilege prefix: the worker replaces it with "" when logged in as root and with
// "sudo -n " otherwise. Rollback scripts run as root (systemd-run / nohup under sudo), so they never
// contain {{S}}.
//
// A "plan" is { steps: [ { label, cmd } | { label, test: {...} } ], rollback? } — see worker.js.
const P = require('./parse');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const writeFile = (path, content, mode) =>
  `echo ${b64(content)} | base64 -d | {{S}}tee ${path} >/dev/null && {{S}}chmod ${mode} ${path}`;

const DROPIN = '/etc/ssh/sshd_config.d/10-dockgate-access.conf';
const STATE_DIR = '/var/lib/dockgate';
const sudoersFile = (u) => `/etc/sudoers.d/90-dockgate-${u}`;

// ---------------------------------------------------------------- read scripts (one round trip each)
const SSHD_T = "{{S}}sshd -T 2>/dev/null | grep -iE '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|maxauthtries|clientaliveinterval|clientalivecountmax|x11forwarding|logingracetime|channeltimeout) '";
const LEGACY = '/etc/ssh/sshd_config.d/99-dockgate.conf'; // pre-2.6 hardening file, merged into DROPIN

const READ_ACCESS = [
  'echo @@uid; id -u',
  `echo @@sshdT; ${SSHD_T}`,
  `echo @@dropin; {{S}}cat ${DROPIN} 2>/dev/null`,
  `echo @@legacy; {{S}}cat ${LEGACY} 2>/dev/null`,
  'echo @@sshver; ssh -V 2>&1 | head -1',
  "echo @@include; grep -iE '^[[:space:]]*Include[[:space:]]' /etc/ssh/sshd_config 2>/dev/null",
  'echo @@reboot; { [ -f /var/run/reboot-required ] && echo yes; command -v needs-restarting >/dev/null 2>&1 && { {{S}}needs-restarting -r >/dev/null 2>&1 || echo yes; }; } ; true',
].join('; ');

const READ_FIREWALL = [
  'echo @@ufwbin; command -v ufw',
  'echo @@ufw; {{S}}ufw status numbered 2>/dev/null',
  'echo @@firewalld; {{S}}firewall-cmd --state 2>/dev/null',
  // firewalld: default zone rules + the ports behind each enabled service (rich rules reference services too)
  'echo @@fwd; {{S}}firewall-cmd --list-all 2>/dev/null',
  "echo @@fwdsvc; if {{S}}firewall-cmd --state >/dev/null 2>&1; then for s in $({{S}}firewall-cmd --list-services 2>/dev/null) $({{S}}firewall-cmd --list-rich-rules 2>/dev/null | sed -n 's/.*service name=\"\\([^\"]*\\)\".*/\\1/p'); do echo \"$s $({{S}}firewall-cmd --permanent --service=\"$s\" --get-ports 2>/dev/null)\"; done; fi",
  "echo @@iso; {{S}}grep -c 'BEGIN DOCKGATE-DOCKER' /etc/ufw/after.rules 2>/dev/null",
  'echo @@ss; if command -v ss >/dev/null 2>&1; then {{S}}ss -H -tulpn 2>/dev/null; else {{S}}netstat -tulpn 2>/dev/null | tail -n +3; fi',
  "echo @@docker; {{S}}docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null",
  `echo @@sshdT; ${SSHD_T}`,
].join('; ');

const HUMAN_USERS = "getent passwd | awk -F: '$3==0 || ($3>=1000 && $3<60000)'";
const READ_USERS = [
  `echo @@passwd; ${HUMAN_USERS}`,
  'echo @@groups; getent group sudo wheel admin docker',
  "echo @@sudoersd; {{S}}ls /etc/sudoers.d/ 2>/dev/null",
  "echo @@shadow; {{S}}getent shadow | awk -F: '{print $1\":\"substr($2,1,1)\":\"$8}'",
  'echo @@lastlog; lastlog 2>/dev/null | tail -n +2',
  `echo @@sshd; ${SSHD_T}`,
  `${HUMAN_USERS} | awk -F: '{print $1":"$6}' | while IFS=: read -r u h; do echo "@@keys $u"; {{S}}cat "$h/.ssh/authorized_keys" 2>/dev/null; done`,
].join('; ');

const READ_POSTURE = `${READ_ACCESS}; ${READ_FIREWALL.replace('echo @@sshdT; ' + SSHD_T, 'true')}; echo @@sudoersd; {{S}}ls /etc/sudoers.d/ 2>/dev/null`;

/** Read one user's authorized_keys (for key removal). */
const readKeysScript = (u) => `H=$(getent passwd ${u} | cut -d: -f6); {{S}}cat "$H/.ssh/authorized_keys" 2>/dev/null; true`;

// ---------------------------------------------------------------- building blocks
const SSHD_RELOAD_ROOT = [
  'R=0',
  'if systemctl is-active --quiet ssh.socket 2>/dev/null; then systemctl daemon-reload && systemctl restart ssh.socket || R=1; fi',
  'if systemctl is-active --quiet ssh 2>/dev/null; then systemctl reload ssh || R=1',
  'elif systemctl is-active --quiet sshd 2>/dev/null; then systemctl reload sshd || R=1',
  'elif command -v rc-service >/dev/null 2>&1 && rc-service sshd status >/dev/null 2>&1; then rc-service sshd reload || R=1',
  'elif [ -f /run/sshd.pid ]; then kill -HUP "$(cat /run/sshd.pid)" || R=1',
  'elif [ -f /var/run/sshd.pid ]; then kill -HUP "$(cat /var/run/sshd.pid)" || R=1; fi',
  '[ "$R" = 0 ]',
].join('; ');
/** Reload sshd (root-native text) wrapped for the connection user. */
const sshdReload = () => `{{S}}sh -c ${shq(SSHD_RELOAD_ROOT)}`;

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

const ENSURE_SUDO = 'command -v sudo >/dev/null 2>&1 || { if command -v apt-get >/dev/null 2>&1; then {{S}}env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y sudo; elif command -v dnf >/dev/null 2>&1; then {{S}}dnf -y install sudo; elif command -v yum >/dev/null 2>&1; then {{S}}yum -y install sudo; elif command -v apk >/dev/null 2>&1; then {{S}}apk add sudo; else echo "sudo is not installed and no package manager was found"; exit 1; fi; }';

const createUserCmd = (u) => [
  `if id -u ${u} >/dev/null 2>&1; then echo "user ${u} exists"; `,
  `elif command -v useradd >/dev/null 2>&1; then {{S}}useradd -m -s /bin/bash ${u}; `,
  `else {{S}}adduser -D -s /bin/sh ${u} && echo "${u}:*" | {{S}}chpasswd -e; fi`,
].join('');

const sudoersCmd = (u) =>
  `${ENSURE_SUDO} && ${writeFile(sudoersFile(u), `# Managed by DockGate\n${u} ALL=(ALL) NOPASSWD:ALL\n`, '0440')} && { {{S}}visudo -cf ${sudoersFile(u)} >/dev/null || { {{S}}rm -f ${sudoersFile(u)}; echo "sudoers validation failed"; exit 1; }; }`;

const revokeSudoCmd = (u) =>
  `{{S}}rm -f ${sudoersFile(u)}; for g in sudo wheel admin; do if id -nG ${u} | grep -qw "$g"; then {{S}}gpasswd -d ${u} "$g" >/dev/null 2>&1 || {{S}}delgroup ${u} "$g" >/dev/null 2>&1; fi; done; true`;

const dockerGroupCmd = (u) =>
  `{ getent group docker >/dev/null 2>&1 || {{S}}groupadd docker 2>/dev/null || {{S}}addgroup docker; } && { {{S}}usermod -aG docker ${u} 2>/dev/null || {{S}}addgroup ${u} docker; }`;

const revokeDockerCmd = (u) =>
  `if id -nG ${u} | grep -qw docker; then {{S}}gpasswd -d ${u} docker >/dev/null 2>&1 || {{S}}delgroup ${u} docker; fi; true`;

const SSH_DIR = (u) => `H=$(getent passwd ${u} | cut -d: -f6); G=$(id -gn ${u}); {{S}}install -d -m 700 -o ${u} -g "$G" "$H/.ssh"`;

/** Append public key lines (skipping ones already present). Each key: { b64, line }. */
function addKeysCmd(u, keys) {
  const parts = [SSH_DIR(u)];
  for (const k of keys) {
    // Leading newline: an existing file may lack a trailing newline. Empty lines are harmless.
    parts.push(`{ {{S}}grep -qF ${k.b64} "$H/.ssh/authorized_keys" 2>/dev/null || echo ${b64('\n' + k.line + '\n')} | base64 -d | {{S}}tee -a "$H/.ssh/authorized_keys" >/dev/null; }`);
  }
  parts.push(`{{S}}chown ${u}:"$G" "$H/.ssh/authorized_keys" && {{S}}chmod 600 "$H/.ssh/authorized_keys"`);
  return parts.join(' && ');
}

/** Replace authorized_keys with `content` (used for removal). */
const writeKeysCmd = (u, content) =>
  `${SSH_DIR(u)} && echo ${b64(content)} | base64 -d | {{S}}tee "$H/.ssh/authorized_keys" >/dev/null && {{S}}chown ${u}:"$G" "$H/.ssh/authorized_keys" && {{S}}chmod 600 "$H/.ssh/authorized_keys"`;

// ---------------------------------------------------------------- lifeline (rollback timer)
/**
 * Arm a root-run rollback after 120 s: systemd-run when systemd is PID 1, otherwise a detached sleep.
 * `restoreRoot` is root-native shell (no {{S}}).
 */
function armRollback(id, restoreRoot) {
  const script = `${STATE_DIR}/rollback-${id}.sh`;
  const body = `#!/bin/sh\n# DockGate automatic rollback ${id}\n${restoreRoot}\nrm -f ${script}\n`;
  return [
    `{{S}}mkdir -p ${STATE_DIR}`,
    writeFile(script, body, '0700'),
    `if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1; then {{S}}systemd-run --quiet --unit=dockgate-rollback-${id} --on-active=120 /bin/sh ${script}; ` +
    // No systemd: a detached loop that exits on its own as soon as the script is removed (commit), so
    // nothing has to be killed and no stray sleep is left behind.
    `else {{S}}sh -c ${shq(`nohup sh -c 'i=0; while [ $i -lt 120 ] && [ -f ${script} ]; do sleep 1; i=$((i+1)); done; [ -f ${script} ] && sh ${script}' >/dev/null 2>&1 &`)}; fi`,
  ].join(' && ');
}
const rollbackNow = (id) => `{{S}}systemctl stop dockgate-rollback-${id}.timer 2>/dev/null; {{S}}sh ${STATE_DIR}/rollback-${id}.sh`;
const commitRollback = (id) => `{{S}}systemctl stop dockgate-rollback-${id}.timer 2>/dev/null; {{S}}rm -f ${STATE_DIR}/rollback-${id}.sh; true`;

// ---------------------------------------------------------------- plans
/**
 * Change sshd settings (root login / password login / port / hardening) with the full lifeline.
 * opts: { id, content, test, portChange?: { from, to } }
 */
function accessPlan({ id, content, test, portChange }) {
  const prev = `${DROPIN}.dockgate-prev`, lprev = `${LEGACY}.dockgate-prev`;
  const restoreRoot = `if [ -f ${prev} ]; then mv -f ${prev} ${DROPIN}; else rm -f ${DROPIN}; fi\n[ -f ${lprev} ] && mv -f ${lprev} ${LEGACY}\n${SSHD_RELOAD_ROOT}`;
  const steps = [];
  if (portChange) {
    const to = P.assertPort(portChange.to);
    steps.push({
      label: `Open ${to}/tcp in the firewall (port ${portChange.from} stays open)`,
      cmd: [
        `if command -v ufw >/dev/null 2>&1 && {{S}}ufw status | grep -q 'Status: active'; then {{S}}ufw allow ${to}/tcp >/dev/null || exit 1; fi`,
        `if {{S}}firewall-cmd --state >/dev/null 2>&1; then {{S}}firewall-cmd --permanent --add-port=${to}/tcp >/dev/null && {{S}}firewall-cmd --reload >/dev/null || exit 1; fi`,
        `if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then {{S}}semanage port -a -t ssh_port_t -p tcp ${to} 2>/dev/null || {{S}}semanage port -m -t ssh_port_t -p tcp ${to} || { echo "SELinux is enforcing and semanage could not allow port ${to}"; exit 1; }; fi`,
        'true',
      ].join('; '),
    });
  }
  steps.push({
    label: 'Write and validate the new sshd config (sshd -t)',
    cmd: [
      `grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config || { echo "/etc/ssh/sshd_config does not include sshd_config.d/*.conf — add 'Include /etc/ssh/sshd_config.d/*.conf' at the top first"; exit 1; }`,
      `{{S}}mkdir -p /etc/ssh/sshd_config.d`,
      `if {{S}}test -f ${DROPIN}; then {{S}}cp -p ${DROPIN} ${prev}; else {{S}}rm -f ${prev}; fi`,
      // the old hardening file's values are already merged into `content` — move it aside (one file)
      `if {{S}}test -f ${LEGACY}; then {{S}}mv -f ${LEGACY} ${lprev}; else {{S}}rm -f ${lprev}; fi`,
      writeFile(DROPIN, content, '0644'),
      `{{S}}sshd -t || { if {{S}}test -f ${prev}; then {{S}}mv -f ${prev} ${DROPIN}; else {{S}}rm -f ${DROPIN}; fi; [ -f ${lprev} ] && {{S}}mv -f ${lprev} ${LEGACY}; echo "sshd rejected the config — nothing was applied"; exit 1; }`,
    ].join(' && '),
  });
  steps.push({ label: 'Arm automatic rollback (120 s)', cmd: armRollback(id, restoreRoot) });
  steps.push({ label: 'Apply (reload sshd)', cmd: sshdReload(), rollbackOnFail: true });
  steps.push({ label: `Open a NEW SSH connection as ${test.username}${test.port ? ' on port ' + test.port : ''} to test`, test, rollbackOnFail: true });
  if (portChange) {
    const from = P.assertPort(portChange.from);
    steps.push({
      label: `Close the old port ${from}/tcp`,
      cmd: [
        `if command -v ufw >/dev/null 2>&1 && {{S}}ufw status | grep -q 'Status: active'; then {{S}}ufw delete allow ${from}/tcp >/dev/null 2>&1; ${from === 22 ? '{{S}}ufw delete allow OpenSSH >/dev/null 2>&1; ' : ''}fi`,
        `if {{S}}firewall-cmd --state >/dev/null 2>&1; then {{S}}firewall-cmd --permanent --remove-port=${from}/tcp >/dev/null 2>&1; ${from === 22 ? '{{S}}firewall-cmd --permanent --remove-service=ssh >/dev/null 2>&1; ' : ''}{{S}}firewall-cmd --reload >/dev/null; fi`,
        'true',
      ].join('; '),
    });
  }
  steps.push({ label: 'Keep the change and cancel the rollback', cmd: `${commitRollback(id)}; {{S}}rm -f ${prev} ${lprev}; true` });
  // After the change is kept: fail2ban must ban the NEW port, or banned IPs could still reach SSH.
  if (portChange) steps.push({ label: `Point fail2ban at port ${P.assertPort(portChange.to)}`, cmd: module.exports.f2bPortSyncCmd(portChange.to) });
  return { steps, rollback: rollbackNow(id) };
}

/** Deploy user: create, sudo, docker, keys, then prove it works with a NEW login using the new key. */
function deployUserPlan({ username, keys, test }) {
  const u = username;
  return {
    steps: [
      { label: 'Pre-flight: privileges, OpenSSH, cloud-init', cmd: `if [ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null; then echo "Needs root or passwordless sudo"; exit 1; fi; { command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ]; } || { echo "OpenSSH server (sshd) not found"; exit 1; }; if command -v cloud-init >/dev/null 2>&1; then timeout 300 cloud-init status --wait >/dev/null 2>&1; fi; true` },
      { label: `Create user "${u}"`, cmd: createUserCmd(u) },
      { label: `Grant passwordless sudo (${sudoersFile(u)}, checked with visudo)`, cmd: sudoersCmd(u) },
      { label: `Add "${u}" to the docker group`, cmd: dockerGroupCmd(u) },
      { label: keys.length > 1 ? 'Install DockGate\'s key and your public key' : 'Install DockGate\'s public key', cmd: addKeysCmd(u, keys) },
      { label: `Test: NEW SSH login as ${u} with the key → sudo -n true, docker group`, test },
    ],
  };
}

function createUserPlan({ username, sudo, docker, keys }) {
  const u = username;
  const steps = [{ label: `Create user "${u}"`, cmd: `if id -u ${u} >/dev/null 2>&1; then echo "User ${u} already exists"; exit 1; fi; ${createUserCmd(u)}` }];
  if (sudo) steps.push({ label: 'Grant passwordless sudo', cmd: sudoersCmd(u) });
  if (docker) steps.push({ label: 'Add to the docker group', cmd: dockerGroupCmd(u) });
  if (keys.length) steps.push({ label: 'Install SSH key', cmd: addKeysCmd(u, keys) });
  return { steps };
}

function setPermsPlan({ username, sudo, docker }) {
  const steps = [];
  if (sudo === true) steps.push({ label: 'Grant passwordless sudo', cmd: sudoersCmd(username) });
  if (sudo === false) steps.push({ label: 'Revoke sudo', cmd: revokeSudoCmd(username) });
  if (docker === true) steps.push({ label: 'Add to the docker group', cmd: dockerGroupCmd(username) });
  if (docker === false) steps.push({ label: 'Remove from the docker group', cmd: revokeDockerCmd(username) });
  return { steps };
}

// Lock = expire the account (blocks password AND key logins via PAM/sshd account checks) + lock the password.
const lockPlan = (u, lock) => ({
  steps: [lock
    ? { label: `Lock ${u}`, cmd: `{{S}}usermod -L ${u} 2>/dev/null; {{S}}usermod -e 1 ${u} 2>/dev/null || {{S}}passwd -l ${u}` }
    : { label: `Unlock ${u}`, cmd: `{{S}}usermod -e '' ${u} 2>/dev/null; {{S}}usermod -U ${u} 2>/dev/null; command -v usermod >/dev/null 2>&1 || {{S}}passwd -u ${u}; true` }],
});

const deleteUserPlan = (u, removeHome) => ({
  steps: [{ label: `Delete ${u}${removeHome ? ' and its home directory' : ''}`, cmd: `{ {{S}}userdel ${removeHome ? '-r ' : ''}${u} 2>&1 || {{S}}deluser ${removeHome ? '--remove-home ' : ''}${u}; } && {{S}}rm -f ${sudoersFile(u)}` }],
});

const addKeysPlan = (u, keys) => ({ steps: [{ label: `Install key for ${u}`, cmd: addKeysCmd(u, keys) }] });
const writeKeysPlan = (u, content) => ({ steps: [{ label: `Update ${u}'s authorized_keys`, cmd: writeKeysCmd(u, content) }] });

// ---------------------------------------------------------------- firewall
// The DOCKER-USER rule set (the well-known ufw-docker approach): traffic between private networks
// (container ↔ container, host ↔ container) passes; NEW connections from outside to a published
// container port are dropped unless a `ufw route allow` rule (ufw-user-forward) lets them through.
const DOCKER_BLOCK = `# BEGIN DOCKGATE-DOCKER
# Managed by DockGate — keeps published Docker ports behind UFW. Open a port with: ufw route allow proto tcp from any to any port <container-port>
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -j RETURN -s 10.0.0.0/8
-A DOCKER-USER -j RETURN -s 172.16.0.0/12
-A DOCKER-USER -j RETURN -s 192.168.0.0/16
-A DOCKER-USER -p udp -m udp --sport 53 --dport 1024:65535 -j RETURN
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 172.16.0.0/12
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 172.16.0.0/12
-A DOCKER-USER -j RETURN
-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP
COMMIT
# END DOCKGATE-DOCKER
`;

// IPv6: Docker with ip6tables (default on IPv6 networks since Docker 27) NATs published ports through the
// ip6tables FORWARD chain too, so the same idea goes into after6.rules. Container networks there are ULA
// (fc00::/7) or link-local; traffic between them passes, new outside → container connections are dropped.
const DOCKER_BLOCK6 = `# BEGIN DOCKGATE-DOCKER
# Managed by DockGate — IPv6 twin of the after.rules block. Open a port with: ufw route allow proto tcp from any to any port <container-port>
*filter
:ufw6-user-forward - [0:0]
:ufw6-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw6-user-forward
-A DOCKER-USER -j RETURN -s fc00::/7
-A DOCKER-USER -j RETURN -s fe80::/10
-A DOCKER-USER -p udp -m udp --sport 53 --dport 1024:65535 -j RETURN
-A DOCKER-USER -j ufw6-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d fc00::/7
-A DOCKER-USER -j ufw6-docker-logging-deny -p udp -m udp --dport 0:32767 -d fc00::/7
-A DOCKER-USER -j RETURN
-A ufw6-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw6-docker-logging-deny -j DROP
COMMIT
# END DOCKGATE-DOCKER
`;

const AFTER = '/etc/ufw/after.rules';
const AFTER6 = '/etc/ufw/after6.rules';
const stripBlock = (f) => `{{S}}sed -i '/# BEGIN DOCKGATE-DOCKER/,/# END DOCKGATE-DOCKER/d' ${f}`;
const STRIP_BLOCK = stripBlock(AFTER);

/** Turn Docker port isolation on (keepPublic: [{ port: containerPort, proto }]) or off — IPv4 and IPv6. */
function isolationPlan({ id, enable, keepPublic, test }) {
  const prev = `${AFTER}.dockgate-prev`, prev6 = `${AFTER6}.dockgate-prev`;
  const restoreRoot = `[ -f ${prev} ] && mv -f ${prev} ${AFTER}\n[ -f ${prev6} ] && mv -f ${prev6} ${AFTER6}\nufw reload >/dev/null 2>&1`;
  // after6.rules only exists (and only matters) when UFW manages IPv6 (IPV6=yes in /etc/default/ufw)
  const v6 = (cmd) => `if {{S}}test -f ${AFTER6}; then ${cmd}; fi`;
  const steps = [
    { label: `Back up ${AFTER} and ${AFTER6}`, cmd: `command -v ufw >/dev/null 2>&1 && {{S}}ufw status | grep -q 'Status: active' || { echo "UFW is not active — turn the firewall on first"; exit 1; }; {{S}}cp -p ${AFTER} ${prev} && ${v6(`{{S}}cp -p ${AFTER6} ${prev6}`)}` },
    enable
      ? { label: 'Add the DOCKER-USER rules, IPv4 + IPv6 (drop new outside → container connections)', cmd: `${STRIP_BLOCK} && echo ${b64('\n' + DOCKER_BLOCK)} | base64 -d | {{S}}tee -a ${AFTER} >/dev/null && ${v6(`${stripBlock(AFTER6)} && echo ${b64('\n' + DOCKER_BLOCK6)} | base64 -d | {{S}}tee -a ${AFTER6} >/dev/null`)}` }
      : { label: 'Remove the DOCKER-USER rules (IPv4 + IPv6)', cmd: `${STRIP_BLOCK} && ${v6(stripBlock(AFTER6))}` },
    { label: 'Arm automatic rollback (120 s)', cmd: armRollback(id, restoreRoot) },
  ];
  if (enable && keepPublic.length) {
    // `ufw route allow` adds the IPv4 and the IPv6 rule (when UFW manages IPv6)
    steps.push({ label: `Keep public: ${keepPublic.map(k => `${k.port}/${k.proto}`).join(', ')}`, cmd: keepPublic.map(k => `{{S}}ufw route allow proto ${P.assertProto(k.proto)} from any to any port ${P.assertPort(k.port)} >/dev/null`).join(' && ') });
  }
  steps.push({ label: 'Reload UFW', cmd: '{{S}}ufw reload >/dev/null', rollbackOnFail: true });
  steps.push({ label: 'Open a NEW SSH connection to test', test, rollbackOnFail: true });
  steps.push({ label: 'Keep the change and cancel the rollback', cmd: `${commitRollback(id)}; {{S}}rm -f ${prev} ${prev6}; true` });
  return { steps, rollback: rollbackNow(id) };
}

// ---------------------------------------------------------------- firewalld
// Every change is written to the permanent config and then applied with --reload, so it survives a reboot.
const fwdZone = (z) => { if (!P.FWD_ZONE_RE.test(String(z || ''))) throw P.httpError(400, 'Invalid firewalld zone'); return z; };
const FWD_RELOAD = '{{S}}firewall-cmd --reload >/dev/null';
const fwd = (zone, args) => `{{S}}firewall-cmd --permanent --zone=${fwdZone(zone)} ${args} >/dev/null`;
/** A rich rule for one port: from a source (family follows the address) or from anywhere (both families). */
function fwdRichRule({ port, proto, from, action }) {
  P.assertPort(port); P.assertProto(proto);
  const src = from && from !== 'any' ? P.assertSource(from) : null;
  const family = src ? ` family="${src.includes(':') ? 'ipv6' : 'ipv4'}" source address="${src}"` : '';
  return `rule${family} port port="${port}" protocol="${proto}" ${action === 'deny' ? 'reject' : 'accept'}`;
}
/** Allow (or deny) a port. Allow from anywhere = a plain port entry; everything else is a rich rule. */
function fwdAddCmd({ zone, port, proto, from, action }) {
  const any = !from || from === 'any';
  const add = any && action !== 'deny'
    ? fwd(zone, `--add-port=${P.assertPort(port)}/${P.assertProto(proto)}`)
    : fwd(zone, `--add-rich-rule=${shq(fwdRichRule({ port, proto, from, action }))}`);
  return `${add} && ${FWD_RELOAD}`;
}
/** Remove parsed firewalld rules (see parse.parseFirewalld) — one entry each, then reload. */
function fwdRemoveCmd(zone, rules) {
  const seen = new Set(), cmds = [];
  for (const r of rules) {
    const id = r.kind + '|' + r.key;
    if (seen.has(id)) continue;
    seen.add(id);
    if (r.kind === 'service') { if (!P.FWD_SERVICE_RE.test(r.key)) throw P.httpError(400, 'Invalid service name'); cmds.push(fwd(zone, `--remove-service=${r.key}`)); }
    else if (r.kind === 'port') { if (!/^\d+(-\d+)?\/(tcp|udp)$/.test(r.key)) throw P.httpError(400, 'Invalid port'); cmds.push(fwd(zone, `--remove-port=${r.key}`)); }
    else if (r.kind === 'rich') { if (/[\n\r]/.test(r.key) || !/^rule\b/.test(r.key)) throw P.httpError(400, 'Invalid rich rule'); cmds.push(fwd(zone, `--remove-rich-rule=${shq(r.key)}`)); }
  }
  return cmds.length ? `${cmds.join(' && ')} && ${FWD_RELOAD}` : 'true';
}

/** ufw allow/route-allow for one port. kind 'container' uses the CONTAINER port (post-DNAT). */
function exposeCmd({ kind, port, proto, from }) {
  const src = from && from !== 'any' ? from : 'any';
  return kind === 'container'
    ? `{{S}}ufw route allow proto ${proto} from ${src} to any port ${port}`
    : `{{S}}ufw allow proto ${proto} from ${src} to any port ${port}`;
}
const deleteRulesCmd = (numbers) => numbers.map(n => `{{S}}ufw --force delete ${Number(n)} >/dev/null`).join(' && ') || 'true';

function addRuleCmd({ port, proto, from, action }) {
  const src = from && from !== 'any' ? from : 'any';
  return `{{S}}ufw ${action === 'deny' ? 'deny' : 'allow'} proto ${proto} from ${src} to any port ${port}`;
}

const REBOOT = `{{S}}sh -c ${shq('nohup sh -c "sleep 2; systemctl reboot 2>/dev/null || reboot" >/dev/null 2>&1 &')}`;

module.exports = {
  DROPIN, DOCKER_BLOCK, DOCKER_BLOCK6, READ_ACCESS, READ_FIREWALL, READ_USERS, READ_POSTURE, readKeysScript, SSHD_RELOAD_ROOT,
  accessPlan, deployUserPlan, createUserPlan, setPermsPlan, lockPlan, deleteUserPlan, addKeysPlan, writeKeysPlan,
  isolationPlan, exposeCmd, deleteRulesCmd, addRuleCmd, REBOOT, b64, shq,
};

// ---------------------------------------------------------------- fail2ban
const F2B = require('./fail2ban');
// One read for the Fail2ban tab: service state, jails + counters + bans (with times), effective
// per-jail options, daemon options, DockGate's own files, jail.local presence, recent history, and the
// IP DockGate connects from (as the server sees it).
const READ_FAIL2BAN = [
  'echo @@installed; command -v fail2ban-client >/dev/null 2>&1 && echo yes',
  'echo @@active; systemctl is-active fail2ban 2>/dev/null || ({{S}}fail2ban-client ping >/dev/null 2>&1 && echo active)',
  'echo @@version; fail2ban-client --version 2>/dev/null | head -1',
  'echo @@status; {{S}}fail2ban-client status 2>/dev/null',
  `for j in $({{S}}fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do ` +
    'echo "@@jail $j"; {{S}}fail2ban-client status "$j" 2>/dev/null; ' +
    'echo "@@bans $j"; {{S}}fail2ban-client get "$j" banip --with-time 2>/dev/null; ' +
    'echo "@@opts $j"; for k in maxretry findtime bantime; do printf "%s=" $k; {{S}}fail2ban-client get "$j" $k 2>/dev/null | tail -1; done; ' +
    'printf "logpath="; {{S}}fail2ban-client get "$j" logpath 2>/dev/null | tr "\\n" " "; echo; ' +
    'printf "ignoreip="; {{S}}fail2ban-client get "$j" ignoreip 2>/dev/null | tr "\\n" " "; echo; ' +
    `printf "port="; {{S}}fail2ban-client -d 2>/dev/null | grep "'$j', 'action'" | grep -o "\\['port', '[^']*'\\]" | head -1; echo; ` +
  'done',
  "echo @@dbpurgeage; {{S}}fail2ban-client get dbpurgeage 2>/dev/null | grep -o '[0-9]*' | head -1",
  `echo @@dockgate; {{S}}cat ${F2B.JAIL_FILE} 2>/dev/null`,
  `echo @@daemon; {{S}}cat ${F2B.DAEMON_FILE} 2>/dev/null`,
  "echo @@jaillocal; {{S}}grep -lE '^\\[(sshd|recidive)\\]' /etc/fail2ban/jail.local /etc/fail2ban/jail.d/*.local 2>/dev/null",
  `echo @@history; {{S}}grep -hE '\\] (Ban|Unban|Increase Ban|Restore Ban) ' ${F2B.LOG_FILE} 2>/dev/null | tail -n 150`,
  "echo @@myip; echo \"$SSH_CONNECTION\" | awk '{print $1}'",
  "echo @@sshport; {{S}}sshd -T 2>/dev/null | awk '$1==\"port\"{print $2; exit}'",
].join('; ');

/** Write DockGate's fail2ban files, test the whole config, reload (bans are kept). Restore on failure. */
function fail2banSettingsPlan(settings, sshPort) {
  const jail = F2B.buildJailConf(settings, sshPort), daemon = F2B.buildDaemonConf(settings);
  const restore = `for f in ${F2B.JAIL_FILE} ${F2B.DAEMON_FILE}; do if {{S}}test -f "$f.dockgate-prev"; then {{S}}mv -f "$f.dockgate-prev" "$f"; else {{S}}rm -f "$f"; fi; done`;
  return {
    steps: [
      { label: 'Back up the current DockGate fail2ban files', cmd: `command -v fail2ban-client >/dev/null 2>&1 || { echo "fail2ban is not installed — install it in Setup first"; exit 1; }; {{S}}mkdir -p /etc/fail2ban/jail.d /etc/fail2ban/fail2ban.d && for f in ${F2B.JAIL_FILE} ${F2B.DAEMON_FILE}; do if {{S}}test -f "$f"; then {{S}}cp -p "$f" "$f.dockgate-prev"; else {{S}}rm -f "$f.dockgate-prev"; fi; done` },
      // recidive needs its log file to exist, or fail2ban refuses to start at all.
      { label: 'Write jail.d/dockgate.conf and fail2ban.d/dockgate.conf', cmd: `${writeFile(F2B.JAIL_FILE, jail, '0644')} && ${writeFile(F2B.DAEMON_FILE, daemon, '0644')} && {{S}}touch ${F2B.LOG_FILE}` },
      { label: 'Test the whole configuration (fail2ban-client -t)', cmd: `{{S}}fail2ban-client -t >/dev/null 2>&1 || { out=$({{S}}fail2ban-client -t 2>&1 | tail -5); ${restore}; echo "fail2ban rejected the configuration — nothing was applied:"; echo "$out"; exit 1; }` },
      { label: 'Reload fail2ban (current bans are kept)', cmd: `if {{S}}fail2ban-client ping >/dev/null 2>&1; then {{S}}fail2ban-client reload >/dev/null; else {{S}}systemctl enable --now fail2ban; fi || { ${restore}; {{S}}fail2ban-client reload >/dev/null 2>&1; echo "reload failed — previous files restored"; exit 1; }` },
      { label: 'Clean up', cmd: `{{S}}rm -f ${F2B.JAIL_FILE}.dockgate-prev ${F2B.DAEMON_FILE}.dockgate-prev; true` },
    ],
  };
}

const f2bBanCmd = (jail, ip) => `{{S}}fail2ban-client set ${jail} banip ${ip}`;
const f2bUnbanCmd = (jail, ip) => jail ? `{{S}}fail2ban-client set ${jail} unbanip ${ip}` : `{{S}}fail2ban-client unban ${ip}`;

/** After an SSH port change: point the sshd jail at the new port (never fails the SSH job). */
function f2bPortSyncCmd(port) {
  const p = P.assertPort(port);
  return `if command -v fail2ban-client >/dev/null 2>&1 && {{S}}fail2ban-client ping >/dev/null 2>&1; then ` +
    `{{S}}mkdir -p /etc/fail2ban/jail.d; F=${F2B.JAIL_FILE}; ` +
    `if {{S}}grep -q '^\\[sshd\\]' "$F" 2>/dev/null; then {{S}}sed -i '/^\\[sshd\\]/,/^\\[/{/^port[[:space:]]*=/d}' "$F" && {{S}}sed -i '/^\\[sshd\\]/a port = ${p}' "$F"; ` +
    `else printf '\\n[sshd]\\nport = ${p}\\n' | {{S}}tee -a "$F" >/dev/null; fi; ` +
    `{{S}}fail2ban-client -t >/dev/null 2>&1 && {{S}}fail2ban-client reload >/dev/null 2>&1 && echo "fail2ban now bans port ${p}" || echo "WARNING: could not update fail2ban — set its sshd port to ${p} in the Fail2ban tab"; ` +
    `else echo "fail2ban not running — nothing to update"; fi; true`;
}

module.exports.READ_FAIL2BAN = READ_FAIL2BAN;
module.exports.fail2banSettingsPlan = fail2banSettingsPlan;
module.exports.f2bBanCmd = f2bBanCmd;
module.exports.f2bUnbanCmd = f2bUnbanCmd;
module.exports.f2bPortSyncCmd = f2bPortSyncCmd;

// Health snapshot taken before/after a firewall change: is fail2ban still running with its bans, and are
// the same number of containers running? (A firewall reload must not silently drop either.)
const READ_HEALTH = [
  'echo @@f2b; systemctl is-active fail2ban 2>/dev/null',
  `echo @@f2bbans; for j in $({{S}}fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do {{S}}fail2ban-client status "$j" 2>/dev/null | grep -o 'Currently banned:[[:space:]]*[0-9]*' | grep -o '[0-9]*$'; done`,
  'echo @@docker; {{S}}docker ps -q 2>/dev/null | wc -l',
].join('; ');
module.exports.READ_HEALTH = READ_HEALTH;
module.exports.UFW_RELOAD = '{{S}}ufw reload >/dev/null';
Object.assign(module.exports, { FWD_RELOAD, fwdAddCmd, fwdRemoveCmd, fwdRichRule });

// ---------------------------------------------------------------- Services sub-pages (Docker · Time sync · Auto updates)
const UNITS = { docker: 'docker', timesync: 'chrony chronyd systemd-timesyncd', 'unattended-upgrades': 'unattended-upgrades apt-daily-upgrade dnf-automatic' };
const logsFor = (item) => `echo @@logs; for u in ${UNITS[item]}; do if systemctl list-unit-files "$u.service" >/dev/null 2>&1 && systemctl cat "$u.service" >/dev/null 2>&1; then {{S}}journalctl -u "$u" -n 60 --no-pager -o short-iso 2>/dev/null; break; fi; done`;
const SERVICE_INFO = {
  docker: [
    "echo @@info; {{S}}docker info --format '{{json .}}' 2>/dev/null | head -c 60000",
    'echo @@daemon; {{S}}cat /etc/docker/daemon.json 2>/dev/null',
    "echo @@df; {{S}}docker system df 2>/dev/null",
  ],
  timesync: [
    'echo @@tracking; chronyc tracking 2>/dev/null',
    'echo @@sources; chronyc -n sources 2>/dev/null',
    'echo @@timedatectl; timedatectl 2>/dev/null',
    'echo @@conf; cat /etc/chrony/chrony.conf 2>/dev/null || cat /etc/chrony.conf 2>/dev/null',
  ],
  'unattended-upgrades': [
    'echo @@family; command -v apt-get >/dev/null 2>&1 && echo debian || echo rhel',
    'echo @@auto; cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null',
    'echo @@dockgate; cat /etc/apt/apt.conf.d/52dockgate-unattended 2>/dev/null',
    "echo @@timer; systemctl list-timers apt-daily-upgrade.timer dnf-automatic.timer --no-pager 2>/dev/null | sed -n '2,3p'",
    'echo @@last; {{S}}tail -n 40 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null',
    "echo @@pending; if command -v apt >/dev/null 2>&1; then apt list --upgradable 2>/dev/null | tail -n +2 | wc -l; else dnf -q check-update 2>/dev/null | grep -c '^[a-zA-Z0-9]'; fi",
    "echo @@rhel; grep -E '^(apply_updates|upgrade_type|reboot)[[:space:]]*=' /etc/dnf/automatic.conf 2>/dev/null",
    'echo @@rhtimer; systemctl is-enabled dnf-automatic.timer 2>/dev/null',
    "echo @@rhpkg; rpm -q dnf-automatic dnf5-plugin-automatic 2>/dev/null | grep -v 'not installed'",
    'echo @@reboot; [ -f /var/run/reboot-required ] && echo yes; true',
  ],
};
const serviceInfoScript = (item) => [...SERVICE_INFO[item], logsFor(item)].join('; ');

/** Docker daemon.json: log limits + live-restore, merged (backup), validated, applied. */
function dockerSettingsPlan({ maxSize, maxFile, liveRestore }) {
  const F = '/etc/docker/daemon.json';
  const py = `import json,sys,os;p='${F}';d=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p)>0 else {};d['log-driver']=d.get('log-driver','json-file');o=d.setdefault('log-opts',{});o['max-size']=sys.argv[1];o['max-file']=sys.argv[2];d['live-restore']=sys.argv[3]=='true';json.dump(d,open(p,'w'),indent=2)`;
  const restore = `if {{S}}test -f ${F}.dockgate-prev; then {{S}}mv -f ${F}.dockgate-prev ${F}; else {{S}}rm -f ${F}; fi`;
  return {
    steps: [
      { label: 'Check Docker and swarm mode', cmd: `command -v docker >/dev/null 2>&1 || { echo "Docker is not installed"; exit 1; }; ${liveRestore ? `[ "$({{S}}docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = active ] && { echo "live-restore cannot be used in swarm mode — turn it off"; exit 1; }; ` : ''}command -v python3 >/dev/null 2>&1 || { echo "python3 is needed to edit daemon.json safely"; exit 1; }` },
      { label: `Back up and update ${F}`, cmd: `{{S}}mkdir -p /etc/docker && { if {{S}}test -f ${F}; then {{S}}cp -p ${F} ${F}.dockgate-prev; else {{S}}rm -f ${F}.dockgate-prev; fi; } && {{S}}python3 -c ${shq(py)} ${maxSize} ${maxFile} ${liveRestore ? 'true' : 'false'}` },
      { label: 'Validate (dockerd --validate)', cmd: `if {{S}}dockerd --validate --config-file ${F} >/dev/null 2>&1 || ! {{S}}dockerd --help 2>/dev/null | grep -q -- --validate; then true; else out=$({{S}}dockerd --validate --config-file ${F} 2>&1 | tail -3); ${restore}; echo "Docker rejected daemon.json — restored: $out"; exit 1; fi` },
      { label: 'Apply (restart if no containers run, otherwise reload)', cmd: `if [ -z "$({{S}}docker ps -q 2>/dev/null)" ]; then {{S}}systemctl restart docker; else {{S}}systemctl reload docker; fi || { ${restore}; {{S}}systemctl restart docker; echo "Docker failed to apply the change — restored"; exit 1; }` },
      { label: 'Clean up', cmd: `{{S}}rm -f ${F}.dockgate-prev; true` },
    ],
  };
}

/** Debian/Ubuntu unattended-upgrades: on/off + automatic reboot (and when). */
function unattendedSettingsPlan({ enabled, autoReboot, rebootTime }) {
  const auto = `APT::Periodic::Update-Package-Lists "${enabled ? 1 : 0}";\nAPT::Periodic::Unattended-Upgrade "${enabled ? 1 : 0}";\n`;
  const dg = `// Managed by DockGate (Server Console → Services → Auto updates)\nUnattended-Upgrade::Automatic-Reboot "${autoReboot ? 'true' : 'false'}";\nUnattended-Upgrade::Automatic-Reboot-Time "${rebootTime}";\n`;
  const A = '/etc/apt/apt.conf.d/20auto-upgrades', D = '/etc/apt/apt.conf.d/52dockgate-unattended';
  return {
    steps: [
      { label: 'Check unattended-upgrades', cmd: `dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii' || { echo "unattended-upgrades is not installed — install it in Setup first"; exit 1; }; for f in ${A} ${D}; do if {{S}}test -f $f; then {{S}}cp -p $f $f.dockgate-prev; else {{S}}rm -f $f.dockgate-prev; fi; done` },
      { label: 'Write the settings', cmd: `${writeFile(A, auto, '0644')} && ${writeFile(D, dg, '0644')}` },
      { label: 'Validate (apt-config)', cmd: `apt-config dump >/dev/null 2>&1 || { for f in ${A} ${D}; do if {{S}}test -f $f.dockgate-prev; then {{S}}mv -f $f.dockgate-prev $f; else {{S}}rm -f $f; fi; done; echo "apt rejected the settings — restored"; exit 1; }; {{S}}rm -f ${A}.dockgate-prev ${D}.dockgate-prev` },
    ],
  };
}

/**
 * RHEL family dnf-automatic: on/off (timer + apply_updates), all vs security-only updates, reboot policy.
 * Keys are set in place in /etc/dnf/automatic.conf ([commands]); a missing key is added under [commands].
 */
function dnfAutomaticPlan({ enabled, upgradeType, reboot }) {
  if (!['default', 'security'].includes(upgradeType)) throw P.httpError(400, 'upgradeType must be default or security');
  if (!['never', 'when-needed'].includes(reboot)) throw P.httpError(400, 'reboot must be never or when-needed');
  const F = '/etc/dnf/automatic.conf';
  // active key → replace it; else the first commented-out one → un-comment it; else add under [commands]
  const set = (k, v) => `if {{S}}grep -qE '^[[:space:]]*${k}[[:space:]]*=' ${F}; then {{S}}sed -i -E 's/^[[:space:]]*${k}[[:space:]]*=.*/${k} = ${v}/' ${F}; ` +
    `elif {{S}}grep -qE '^#[[:space:]]*${k}[[:space:]]*=' ${F}; then {{S}}sed -i -E '0,/^#[[:space:]]*${k}[[:space:]]*=.*/s//${k} = ${v}/' ${F}; ` +
    `else {{S}}sed -i '/^\\[commands\\]/a ${k} = ${v}' ${F}; fi`;
  const restore = `{{S}}mv -f ${F}.dockgate-prev ${F}`;
  return {
    steps: [
      { label: 'Check dnf-automatic', cmd: `{{S}}test -f ${F} || { echo "dnf-automatic is not installed — install it in Setup → Auto updates"; exit 1; }; {{S}}grep -q '^\\[commands\\]' ${F} || { echo "${F} has no [commands] section"; exit 1; }; {{S}}cp -p ${F} ${F}.dockgate-prev` },
      { label: 'Write the settings', cmd: `{ ${set('apply_updates', enabled ? 'yes' : 'no')} && ${set('upgrade_type', upgradeType)} && ${set('reboot', reboot)}; } || { ${restore}; echo "could not write ${F} — restored"; exit 1; }` },
      { label: enabled ? 'Enable the daily timer' : 'Disable the daily timer', cmd: `${enabled ? '{{S}}systemctl enable --now dnf-automatic.timer' : '{{S}}systemctl disable --now dnf-automatic.timer'} >/dev/null 2>&1 || { ${restore}; echo "systemctl could not ${enabled ? 'enable' : 'disable'} dnf-automatic.timer — restored"; exit 1; }` },
      { label: 'Clean up', cmd: `{{S}}rm -f ${F}.dockgate-prev; true` },
    ],
  };
}
module.exports.dnfAutomaticPlan = dnfAutomaticPlan;
module.exports.serviceInfoScript = serviceInfoScript;
module.exports.SERVICE_INFO_ITEMS = Object.keys(SERVICE_INFO);
module.exports.dockerSettingsPlan = dockerSettingsPlan;
module.exports.unattendedSettingsPlan = unattendedSettingsPlan;

// ---------------------------------------------------------------- Time sync (chrony NTP sources)
const CHRONY_CONF = 'C=/etc/chrony/chrony.conf; [ -f $C ] || C=/etc/chrony.conf; [ -f $C ] || { echo "chrony is not installed — install it in Setup → Time sync"; exit 1; }';
const CHRONY_RESTORE = 'if {{S}}test -f $C.dockgate-prev; then {{S}}mv -f $C.dockgate-prev $C; fi';
const CHRONY_RESTART = '{{S}}systemctl restart chrony 2>/dev/null || {{S}}systemctl restart chronyd 2>/dev/null || {{S}}rc-service chronyd restart';

/**
 * Set chrony's NTP sources. servers = [{ host, type: 'pool'|'server' }]; empty = back to the distro's own.
 * The distro's pool/server lines are commented out with a "#dockgate# " marker (and restored when going
 * back to defaults); DockGate's sources live between BEGIN/END markers. Validated with `chronyd -p`.
 */
function ntpPlan({ servers }) {
  const block = '# BEGIN DOCKGATE-NTP — managed by DockGate (Server Console → Services → Time sync)\n' +
    servers.map(x => `${x.type} ${x.host} iburst`).join('\n') + '\n# END DOCKGATE-NTP\n';
  // remove DockGate's block, un-comment the distro's lines, drop trailing blank lines (no build-up)
  const reset = "{{S}}sed -i -e '/^# BEGIN DOCKGATE-NTP/,/^# END DOCKGATE-NTP/d' -e 's/^#dockgate# //' $C && {{S}}sed -i -e :a -e '/^\\n*$/{$d;N;ba' -e '}' $C";
  const apply = servers.length
    ? `${reset} && {{S}}sed -i -E 's/^(pool|server|peer)([[:space:]])/#dockgate# \\1\\2/' $C && echo ${b64('\n' + block)} | base64 -d | {{S}}tee -a $C >/dev/null`
    : reset;
  return {
    steps: [
      { label: 'Back up the chrony configuration', cmd: `${CHRONY_CONF}; {{S}}cp -p $C $C.dockgate-prev` },
      { label: servers.length ? `Use ${servers.map(x => x.host).join(', ')}` : "Go back to the distro's own NTP sources", cmd: `${CHRONY_CONF}; ${apply}` },
      { label: 'Validate (chronyd -p)', cmd: `${CHRONY_CONF}; {{S}}chronyd -p -f $C >/dev/null 2>&1 || { out=$({{S}}chronyd -p -f $C 2>&1 | tail -2); ${CHRONY_RESTORE}; echo "chrony rejected the configuration — restored: $out"; exit 1; }` },
      { label: 'Restart chrony', cmd: `${CHRONY_CONF}; ${CHRONY_RESTART} || { ${CHRONY_RESTORE}; ${CHRONY_RESTART}; echo "chrony failed to start — previous configuration restored"; exit 1; }` },
      { label: 'Clean up', cmd: `${CHRONY_CONF}; {{S}}rm -f $C.dockgate-prev; true` },
    ],
  };
}
module.exports.ntpPlan = ntpPlan;

// ---------------------------------------------------------------- UFW on/off
/**
 * Turn UFW on with a lifeline: the SSH port(s) are allowed BEFORE enabling, a rollback (`ufw disable`)
 * is armed, and a NEW SSH login must succeed or the firewall is switched off again.
 * opts: { id, sshPorts: [n], webPorts: [n], test }
 */
function ufwEnablePlan({ id, sshPorts, webPorts, test }) {
  const allow = [...new Set([...sshPorts, ...webPorts].map(P.assertPort))];
  return {
    steps: [
      { label: 'Make sure UFW is installed', cmd: 'command -v ufw >/dev/null 2>&1 || { if command -v apt-get >/dev/null 2>&1; then {{S}}env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y ufw >/dev/null; else echo "UFW is not available on this distribution — use firewalld (Setup → Firewall)"; exit 1; fi; }' },
      { label: `Allow ${allow.map(p => p + '/tcp').join(', ')} before switching on`, cmd: allow.map(p => `{{S}}ufw allow ${p}/tcp >/dev/null`).join(' && ') },
      { label: 'Arm automatic rollback (120 s)', cmd: armRollback(id, 'ufw --force disable >/dev/null 2>&1') },
      { label: 'Switch the firewall on (deny incoming by default)', cmd: '{{S}}ufw default deny incoming >/dev/null && {{S}}ufw default allow outgoing >/dev/null && {{S}}ufw --force enable >/dev/null', rollbackOnFail: true },
      { label: 'Open a NEW SSH connection to test', test, rollbackOnFail: true },
      { label: 'Keep the change and cancel the rollback', cmd: `${commitRollback(id)}; true` },
    ],
    rollback: rollbackNow(id),
  };
}
const UFW_DISABLE = '{{S}}ufw --force disable >/dev/null';
module.exports.ufwEnablePlan = ufwEnablePlan;
module.exports.UFW_DISABLE = UFW_DISABLE;
