// Swap on an SSH server: a swap file made, resized or removed, and vm.swappiness kept in DockGate's own sysctl file.
// Used by Setup (the "Swap file" component) and by Server Console > System > Disks. Each script runs as root in one
// piece (`echo <base64> | base64 -d | sudo sh`), so it can stop with a clear reason at any point and clean up after
// itself: a swap file the kernel did not accept is never left on the disk or in /etc/fstab.
const DEFAULT_MB = 4096;
const SYSCTL_FILE = '/etc/sysctl.d/99-dockgate.conf';
// Written by DockGate before 2.89: sorts after 99-dockgate.conf, so it would win at boot over a value set in Kernel
const LEGACY_FILE = '/etc/sysctl.d/99-swappiness.conf';
const PATH_RE = /^\/(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** `sudo` is 'sudo ' (Setup, adapted for root later), '{{S}}' (System plans) or ''. */
const asRoot = (script, sudo) => `echo ${b64(script)} | base64 -d | ${sudo}sh`;

function checkPath(p) {
  const s = String(p || '').trim();
  if (!PATH_RE.test(s) || /^\/(dev|proc|sys|run)\//.test(s)) throw bad('Swap file: an absolute path such as /swapfile');
  return s;
}
function checkSize(mb) {
  const n = Number(mb);
  if (!Number.isInteger(n) || n < 256 || n > 65536) throw bad('Swap size: 256 MB - 64 GB');
  return n;
}
function checkSwappiness(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 200) throw bad('Swappiness: 0 - 200');
  return n;
}

// Taking swap back needs the RAM to hold what is in it now (+256 MB to spare).
const ROOM = (p) => `used=$(awk -v p=${p} '$1==p{print int($4/1024)}' /proc/swaps); used=\${used:-0}
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "$used" -gt 0 ] && [ "$avail" -le $((used+256)) ]; then echo "Not turned off: $used MB is in this swap and only $avail MB of RAM is free to take it back. Stop something or try later."; exit 1; fi`;
const LEGACY_CLEANUP = `if [ -f ${LEGACY_FILE} ] && ! grep -vqE '^[[:space:]]*(#|$|vm\\.swappiness[[:space:]]*=)' ${LEGACY_FILE}; then rm -f ${LEGACY_FILE}; fi`;

/** Makes (or remakes at a new size) the swap file `path` of `sizeMb`, turns it on and adds it to /etc/fstab. */
function createScript(path = '/swapfile', sizeMb = DEFAULT_MB) {
  const P = checkPath(path), S = checkSize(sizeMb);
  return `P='${P}'; S=${S}
virt=$(systemd-detect-virt -c 2>/dev/null || true)
case "$virt" in lxc*|openvz) echo "This server is a container ($virt): swap is decided by its host, a swap file can not be turned on here. Ask the provider for swap, or a VM (KVM) plan."; exit 1;; esac
if awk -v p="$P" '$1==p{f=1} END{exit !f}' /proc/swaps; then
${ROOM('"$P"')}
  swapoff "$P" || { echo "swapoff $P failed"; exit 1; }
fi
rm -f "$P"
D=$(dirname "$P"); mkdir -p "$D"
free=$(df -Pm "$D" | awk 'NR==2{print $4}')
if [ "\${free:-0}" -le $((S+1024)) ]; then echo "Not enough free disk on $D for a $S MB swap file: $free MB free, $S MB + 1 GB to spare needed. Choose a smaller size."; exit 1; fi
fs=$(stat -f -c %T "$D" 2>/dev/null)
if [ "$fs" = zfs ]; then echo "$D is on ZFS, which can not hold a swap file (use a ZFS volume for swap instead)."; exit 1; fi
err=''
mk() {
  rm -f "$P"; touch "$P" && chmod 600 "$P" || { err="could not create $P"; return 1; }
  [ "$fs" = btrfs ] && chattr +C "$P" 2>/dev/null
  if [ "$1" = fallocate ]; then fallocate -l \${S}M "$P" 2>/dev/null || { err='fallocate is not supported here'; return 1; }
  else dd if=/dev/zero of="$P" bs=1M count=$S 2>/dev/null || { err="writing $S MB failed"; return 1; }; fi
  chmod 600 "$P"; out=$(mkswap "$P" 2>&1) || { err="$out"; return 1; }
  out=$(swapon "$P" 2>&1) || { err="$out"; return 1; }
}
# fallocate is instant; some file systems take only a file written out in full (dd)
if ! mk fallocate && ! mk dd; then
  swapoff "$P" 2>/dev/null; rm -f "$P"
  hint=''
  [ "$fs" = btrfs ] && hint=' On btrfs a swap file needs a subvolume without snapshots or compression.'
  [ -n "$virt" ] && hint="$hint This server runs inside a container ($virt), which usually may not turn swap on."
  echo "The kernel did not take a swap file on $D ($fs): $err.$hint Nothing was left on the disk or in /etc/fstab."; exit 1
fi
cp -p /etc/fstab /etc/fstab.dockgate-prev 2>/dev/null
grep -qE "^[[:space:]]*$P[[:space:]]" /etc/fstab || printf '%s none swap sw 0 0\\n' "$P" >> /etc/fstab
rm -f /etc/fstab.dockgate-prev
echo "Swap on: $P, $S MB"`;
}

/** Turns the swap file off, takes it out of /etc/fstab and deletes it. */
function removeScript(path) {
  const P = checkPath(path);
  return `P='${P}'
if awk -v p="$P" '$1==p{f=1} END{exit !f}' /proc/swaps; then
${ROOM('"$P"')}
  swapoff "$P" || { echo "swapoff $P failed"; exit 1; }
fi
cp -p /etc/fstab /etc/fstab.dockgate-prev && sed -i "\\#^[[:space:]]*$P[[:space:]]#d" /etc/fstab && rm -f /etc/fstab.dockgate-prev
[ -f "$P" ] && rm -f "$P"
echo "Swap removed: $P"`;
}

/** Writes vm.swappiness into DockGate's sysctl file (other lines kept) and applies only that value. keepSet: leave a value already there. */
function swappinessScript(value, { keepSet = false } = {}) {
  const v = checkSwappiness(value);
  const F = SYSCTL_FILE;
  const write = `[ -f ${F} ] || printf '# Managed by DockGate (Server Console > System > Kernel)\\n' > ${F}
sed -i '/^[[:space:]]*vm\\.swappiness[[:space:]]*=/d' ${F}
echo 'vm.swappiness = ${v}' >> ${F}
sysctl -w vm.swappiness=${v} >/dev/null`;
  return `${keepSet ? `if ! grep -qE '^[[:space:]]*vm\\.swappiness[[:space:]]*=' ${F} 2>/dev/null; then\n${write}\nfi` : write}
${LEGACY_CLEANUP}`;
}

/** Setup's install command: a 4 GB swap file + swappiness 10 (unless DockGate already set one). */
function setupInstall(sudo = 'sudo ') {
  return `${asRoot(createScript('/swapfile', DEFAULT_MB), sudo)} && ${asRoot(swappinessScript(10, { keepSet: true }), sudo)}`;
}

/** /proc/swaps -> [{ path, type, sizeMb, usedMb, prio }]. */
function parseSwaps(text) {
  return String(text || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 4 && p[0].startsWith('/'))
    .map(p => ({ path: p[0], type: p[1], sizeMb: Math.round(Number(p[2]) / 1024), usedMb: Math.round(Number(p[3]) / 1024), prio: Number(p[4]) }));
}

module.exports = { DEFAULT_MB, SYSCTL_FILE, LEGACY_FILE, asRoot, checkPath, checkSize, checkSwappiness, createScript, removeScript, swappinessScript, setupInstall, parseSwaps };
