// When to add or remove replicas — one rule for Swarm Auto Scaling, Compose Auto Scaling in DockGate, and the Edge
// agent (which can only ship files from agent/). Pure, unit tested.
/**
 * The change due now, or null. Pure (unit tested).
 * samples: [{ t, cpu, cpuMin, cpuMax, mem, memMin, memMax }] one per check (cpu/mem are averages; mem null = no limit).
 * last: { at, dir: 'up'|'down' } of the last change. Out of the min–max range is put right at once.
 */
function decide(rule, samples, replicas, now = Date.now(), last = {}, everyMs = 60000) {
  if (replicas < rule.min) return { to: rule.min, action: 'up', reason: `below the minimum of ${rule.min}` };
  if (replicas > rule.max) return { to: rule.max, action: 'down', reason: `above the maximum of ${rule.max}` };
  if (last.at) {
    const wait = (last.dir === 'down' ? rule.coolDownMinutes : rule.coolUpMinutes) * 60000;
    if (now - last.at < wait) return null;
  }
  // Half a check of slack: with a check every minute, "1 minute" must still hold the sample taken a minute ago.
  const win = (m) => samples.filter(s => s.t > now - m * 60000 - everyMs / 2 && Number.isFinite(s.cpu));
  const enough = (l, m) => l.length >= Math.max(2, Math.floor(m * 60000 / everyMs) - 1); // allow one missed check
  const avg = (l, k) => Math.round(l.reduce((a, s) => a + (s[k] ?? 0), 0) / l.length);
  const every = rule.basis === 'every';
  const memOn = rule.memUp !== null && rule.memUp !== undefined;
  const up = win(rule.upMinutes);
  if (replicas < rule.max && enough(up, rule.upMinutes)) {
    const cpuV = avg(up, every ? 'cpuMin' : 'cpu');
    const memL = up.filter(s => Number.isFinite(s.mem));
    const memV = memOn && memL.length >= Math.ceil(up.length / 2) ? avg(memL, every ? 'memMin' : 'mem') : null;
    const cpuHot = cpuV >= rule.cpuUp, memHot = memV !== null && memV >= rule.memUp;
    const hot = rule.logic === 'and' && memOn ? (cpuHot && memHot) : (cpuHot || memHot);
    if (hot) {
      const what = [cpuHot ? `CPU ${cpuV}%` : null, memHot ? `memory ${memV}%` : null].filter(Boolean).join(' and ');
      return { to: Math.min(rule.max, replicas + rule.step), action: 'up', reason: `${what} ${every ? 'on every replica' : 'per replica'} for ${rule.upMinutes} min (add at CPU ${rule.cpuUp}%${memOn ? ` ${rule.logic} memory ${rule.memUp}%` : ''})` };
    }
  }
  const down = win(rule.downMinutes);
  if (replicas > rule.min && enough(down, rule.downMinutes)) {
    const cpuV = avg(down, every ? 'cpuMax' : 'cpu');
    const memL = down.filter(s => Number.isFinite(s.mem));
    const memV = memOn && memL.length ? avg(memL, every ? 'memMax' : 'mem') : null;
    const cpuLow = cpuV <= rule.cpuDown, memLow = !memOn || (memV !== null && memV <= rule.memDown);
    if (cpuLow && memLow) {
      return { to: Math.max(rule.min, replicas - rule.step), action: 'down', reason: `CPU ${cpuV}%${memOn ? ` and memory ${memV}%` : ''} ${every ? 'on every replica' : 'per replica'} for ${rule.downMinutes} min (remove at CPU ${rule.cpuDown}%${memOn ? ` and memory ${rule.memDown}%` : ''})` };
    }
  }
  return null;
}


const GB = 1073741824;
const fmt = (b) => (b >= GB ? `${Math.round(b / GB * 10) / 10} GB` : `${Math.round(b / 1048576)} MB`);

/**
 * How many more replicas fit on one server. cap: { cpu: cores, mem: bytes, memAvail: bytes|null, load: 1-min load|null };
 * lim: the limits of one replica { cpu: cores, mem: bytes }. Counted by the limit (what a replica may take), with
 * 10 % of memory and 20 % of CPU kept free for the server itself. Returns { fits, why }.
 */
function hostRoom(cap, lim) {
  const byMem = lim.mem && Number.isFinite(cap.memAvail) ? Math.floor((cap.memAvail - 0.1 * cap.mem) / lim.mem) : Infinity;
  let byCpu = Infinity;
  if (Number.isFinite(cap.load) && cap.cpu) byCpu = cap.load >= 0.8 * cap.cpu ? 0 : (lim.cpu ? Math.floor((0.8 * cap.cpu - cap.load) / lim.cpu + 1e-9) : Infinity);
  const fits = Math.max(0, Math.min(byMem, byCpu));
  const why = byMem <= byCpu
    ? `${fmt(Math.max(0, cap.memAvail || 0))} memory free of ${fmt(cap.mem)}, a replica may use ${fmt(lim.mem)}`
    : `CPU load ${Math.round(cap.load * 10) / 10} of ${cap.cpu} cores, a replica may use ${lim.cpu}`;
  return { fits, why };
}

/** decide() on one server: an increase only as far as the server has room; { action: 'full' } when it has none. */
function decideHost(rule, samples, replicas, now, last, cap, lim, everyMs) {
  const d = decide(rule, samples, replicas, now, last, everyMs);
  if (!d || d.action !== 'up') return d;
  const room = hostRoom(cap, lim);
  if (room.fits <= 0) return { action: 'full', from: replicas, to: replicas, reason: `${d.reason} — but the server has no room (${room.why})` };
  if (replicas + room.fits < d.to) return { ...d, to: replicas + room.fits, reason: `${d.reason}; only ${room.fits} more fit${room.fits === 1 ? 's' : ''} (${room.why})` };
  return d;
}

module.exports = { decide, hostRoom, decideHost };
