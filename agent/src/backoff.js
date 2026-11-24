// How often to tell about a container that STAYS unhealthy: at once, then after 1 h, 6 h, and once a day after
// that - not every cooldown (a container unhealthy for a week sent hundreds of alerts). When it is no longer
// unhealthy its record is dropped, so the next problem is told at once again. store: a Map (or anything with
// get / set / delete / keys); entries are { n, last, since }.
const STEPS_MS = [0, 3600e3, 6 * 3600e3, 24 * 3600e3];

function backoff(store = new Map(), steps = STEPS_MS) {
  return {
    /** { due, n, since, next } - n is the number this alert would be (1 = the first). */
    check(key, now = Date.now(), minMs = 0) {
      const s = store.get(key);
      if (!s) return { due: true, n: 1, since: now, next: steps[1] };
      const wait = Math.max(minMs, steps[Math.min(s.n, steps.length - 1)]);
      return { due: now - s.last >= wait, n: s.n + 1, since: s.since, next: steps[Math.min(s.n + 1, steps.length - 1)] };
    },
    sent(key, now = Date.now()) {
      const s = store.get(key);
      store.set(key, { n: (s ? s.n : 0) + 1, last: now, since: s ? s.since : now });
    },
    /** Forget every key (of this prefix) that is not in `still` - those containers are healthy or gone. */
    keepOnly(still, prefix = '') {
      const keep = new Set(still);
      for (const k of [...store.keys()]) if (k.startsWith(prefix) && !keep.has(k)) store.delete(k);
    },
  };
}
const fmtFor = (ms) => ms >= 86400e3 ? `${Math.round(ms / 86400e3)} d` : ms >= 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.max(1, Math.round(ms / 60e3))} min`;

module.exports = { backoff, STEPS_MS, fmtFor };
