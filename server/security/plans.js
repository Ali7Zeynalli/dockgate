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
const SSHD_T = "{{S}}sshd -T 2>/dev/null | grep -iE '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|maxauthtries|clientaliveinterval|clientalivecountmax|x11forwarding) '";

const READ_ACCESS = [
  'echo @@uid; id -u',
  `echo @@sshdT; ${SSHD_T}`,
  `echo @@dropin; {{S}}cat ${DROPIN} 2>/dev/null`,
  "echo @@include; grep -iE '^[[:space:]]*Include[[:space:]]' /etc/ssh/sshd_config 2>/dev/null",
  'echo @@reboot; { [ -f /var/run/reboot-required ] && echo yes; command -v needs-restarting >/dev/null 2>&1 && { {{S}}needs-restarting -r >/dev/null 2>&1 || echo yes; }; } ; true',
].join('; ');

const READ_FIREWALL = [
  'echo @@ufwbin; command -v ufw',
  'echo @@ufw; {{S}}ufw status numbered 2>/dev/null',
  'echo @@firewalld; {{S}}firewall-cmd --state 2>/dev/null',
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
  const prev = `${DROPIN}.dockgate-prev`;
  const restoreRoot = `if [ -f ${prev} ]; then mv -f ${prev} ${DROPIN}; else rm -f ${DROPIN}; fi\n${SSHD_RELOAD_ROOT}`;
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
      writeFile(DROPIN, content, '0644'),
      `{{S}}sshd -t || { if {{S}}test -f ${prev}; then {{S}}mv -f ${prev} ${DROPIN}; else {{S}}rm -f ${DROPIN}; fi; echo "sshd rejected the config — nothing was applied"; exit 1; }`,
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
  steps.push({ label: 'Keep the change and cancel the rollback', cmd: `${commitRollback(id)}; {{S}}rm -f ${prev}; true` });
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

const AFTER = '/etc/ufw/after.rules';
const STRIP_BLOCK = `{{S}}sed -i '/# BEGIN DOCKGATE-DOCKER/,/# END DOCKGATE-DOCKER/d' ${AFTER}`;

/** Turn Docker port isolation on (keepPublic: [{ port: containerPort, proto }]) or off. */
function isolationPlan({ id, enable, keepPublic, test }) {
  const prev = `${AFTER}.dockgate-prev`;
  const restoreRoot = `[ -f ${prev} ] && mv -f ${prev} ${AFTER}\nufw reload >/dev/null 2>&1`;
  const steps = [
    { label: `Back up ${AFTER}`, cmd: `command -v ufw >/dev/null 2>&1 && {{S}}ufw status | grep -q 'Status: active' || { echo "UFW is not active — enable the firewall first (Setup → Firewall)"; exit 1; }; {{S}}cp -p ${AFTER} ${prev}` },
    enable
      ? { label: 'Add the DOCKER-USER rules (drop new outside → container connections)', cmd: `${STRIP_BLOCK} && echo ${b64('\n' + DOCKER_BLOCK)} | base64 -d | {{S}}tee -a ${AFTER} >/dev/null` }
      : { label: 'Remove the DOCKER-USER rules', cmd: STRIP_BLOCK },
    { label: 'Arm automatic rollback (120 s)', cmd: armRollback(id, restoreRoot) },
  ];
  if (enable && keepPublic.length) {
    steps.push({ label: `Keep public: ${keepPublic.map(k => `${k.port}/${k.proto}`).join(', ')}`, cmd: keepPublic.map(k => `{{S}}ufw route allow proto ${P.assertProto(k.proto)} from any to any port ${P.assertPort(k.port)} >/dev/null`).join(' && ') });
  }
  steps.push({ label: 'Reload UFW', cmd: '{{S}}ufw reload >/dev/null', rollbackOnFail: true });
  steps.push({ label: 'Open a NEW SSH connection to test', test, rollbackOnFail: true });
  steps.push({ label: 'Keep the change and cancel the rollback', cmd: `${commitRollback(id)}; {{S}}rm -f ${prev}; true` });
  return { steps, rollback: rollbackNow(id) };
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
  DROPIN, DOCKER_BLOCK, READ_ACCESS, READ_FIREWALL, READ_USERS, READ_POSTURE, readKeysScript, SSHD_RELOAD_ROOT,
  accessPlan, deployUserPlan, createUserPlan, setPermsPlan, lockPlan, deleteUserPlan, addKeysPlan, writeKeysPlan,
  isolationPlan, exposeCmd, deleteRulesCmd, addRuleCmd, REBOOT, b64, shq,
};
