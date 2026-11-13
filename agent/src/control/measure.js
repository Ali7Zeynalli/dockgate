// What Auto Scaling looks at, read the same way by the Edge agent and by DockGate: the CPU and memory of each
// replica of a service against its own limits, and how much room the server has.
const { replicasOf } = require('./executor');

/** The limits of one replica, from the container (what Compose made of the compose file). */
async function limitsOfContainer(docker, id) {
  const ct = await docker.getContainer(id).inspect();
  const h = ct.HostConfig || {};
  let cpu = (h.NanoCpus || 0) / 1e9;
  if (!cpu && h.CpuQuota > 0) cpu = h.CpuQuota / (h.CpuPeriod || 100000);
  return { cpu: Math.round(cpu * 1000) / 1000, mem: h.Memory || 0 };
}

/** One stats reading → { cpu: % of one core, mem: bytes } (page cache not counted, as `docker stats` does). */
function readStats(st) {
  const c = st.cpu_stats || {}, p = st.precpu_stats || {};
  const cpuDelta = ((c.cpu_usage || {}).total_usage || 0) - ((p.cpu_usage || {}).total_usage || 0);
  const sysDelta = (c.system_cpu_usage || 0) - (p.system_cpu_usage || 0);
  const cores = c.online_cpus || ((c.cpu_usage || {}).percpu_usage || []).length || 1;
  const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
  const m = st.memory_stats || {}, s = m.stats || {};
  const mem = Math.max(0, (m.usage || 0) - (s.inactive_file ?? s.total_inactive_file ?? s.cache ?? 0));
  return { cpu, mem };
}

/**
 * A sample of one service: per replica, CPU as % of its CPU limit and memory as % of its memory limit (null without
 * that limit); averages, least and most busy replica. Returns null when nothing runs.
 */
async function measureService(docker, project, service) {
  const reps = (await replicasOf(docker, project, service)).filter(r => r.state === 'running');
  if (!reps.length) return null;
  const lim = await limitsOfContainer(docker, reps[0].id);
  const cpu = [], mem = [];
  await Promise.all(reps.map(async (r) => {
    try {
      const st = readStats(await docker.getContainer(r.id).stats({ stream: false }));
      cpu.push(lim.cpu ? st.cpu / lim.cpu : st.cpu);
      if (lim.mem) mem.push(st.mem / lim.mem * 100);
    } catch (e) { /* stopped meanwhile */ }
  }));
  const r1 = (v) => Math.round(v * 10) / 10;
  const stat = (l) => (l.length ? { avg: r1(l.reduce((a, b) => a + b, 0) / l.length), min: r1(Math.min(...l)), max: r1(Math.max(...l)) } : null);
  const c = stat(cpu), m = stat(mem);
  return { replicas: reps.length, lim, cpu: c ? c.avg : null, cpuMin: c ? c.min : null, cpuMax: c ? c.max : null, mem: m ? m.avg : null, memMin: m ? m.min : null, memMax: m ? m.max : null };
}

/** The server's size and load: cores and memory from Docker, free memory and load from /proc (null when unreadable). */
function hostCapFrom(info, meminfo, loadavg) {
  const avail = /MemAvailable:\s+(\d+)\s*kB/.exec(String(meminfo || ''));
  const load = Number(String(loadavg || '').split(/\s+/)[0]);
  return { cpu: info.NCPU || 1, mem: info.MemTotal || 0, memAvail: avail ? Number(avail[1]) * 1024 : null, load: Number.isFinite(load) && String(loadavg || '').trim() ? load : null };
}

module.exports = { limitsOfContainer, readStats, measureService, hostCapFrom };
