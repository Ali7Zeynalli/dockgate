// A schedule picker that writes a cron line: how often, then the hour (00–23) and minute (00–59) from lists,
// 24-hour clock, server time. "Custom" keeps a raw cron line for anything else.
//   SchedulePicker.html(cron, { minutes })   minutes: offer "every N minutes" (Cron, Scripts) — not for backups
//   SchedulePicker.bind(el, { onChange })    → { value() }
//   SchedulePicker.describe(cron)            "Every day at 03:15"
const SchedulePicker = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
  const DAY_NAME = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
  const EVERY_H = [1, 2, 3, 4, 6, 8, 12];
  const EVERY_M = [5, 10, 15, 20, 30];
  const num = (s, lo, hi) => /^\d+$/.test(s) && +s >= lo && +s <= hi;

  /** cron → { mode, h, m, days, dom, every } (mode 'custom' when it does not fit a simple form). */
  function parse(cron) {
    const f = String(cron || '').trim().split(/\s+/);
    const st = { mode: 'custom', h: 3, m: 15, days: [1], dom: 1, everyH: 6, everyM: 15, raw: String(cron || '').trim() };
    if (f.length !== 5) return st;
    const [mi, ho, dm, mo, wd] = f;
    if (mo !== '*') return st;
    let x;
    if ((x = /^\*\/(\d+)$/.exec(mi)) && ho === '*' && dm === '*' && wd === '*' && EVERY_M.includes(+x[1])) return { ...st, mode: 'minutes', everyM: +x[1] };
    if (!num(mi, 0, 59)) return st;
    st.m = +mi;
    if (dm === '*' && wd === '*' && ho === '*') return { ...st, mode: 'hours', everyH: 1 };
    if (dm === '*' && wd === '*' && (x = /^\*\/(\d+)$/.exec(ho)) && EVERY_H.includes(+x[1])) return { ...st, mode: 'hours', everyH: +x[1] };
    if (!num(ho, 0, 23)) return st;
    st.h = +ho;
    if (dm === '*' && wd === '*') return { ...st, mode: 'daily' };
    if (dm === '*' && /^[0-7](,[0-7])*$/.test(wd)) return { ...st, mode: 'weekly', days: [...new Set(wd.split(',').map(d => +d % 7))] };
    if (num(dm, 1, 28) && wd === '*') return { ...st, mode: 'monthly', dom: +dm };
    return st;
  }

  function build(st) {
    switch (st.mode) {
      case 'minutes': return `*/${st.everyM} * * * *`;
      case 'hours': return `${st.m} ${st.everyH === 1 ? '*' : '*/' + st.everyH} * * *`;
      case 'daily': return `${st.m} ${st.h} * * *`;
      case 'weekly': return `${st.m} ${st.h} * * ${(st.days.length ? st.days : [1]).slice().sort((a, b) => ((a || 7) - (b || 7))).join(',')}`;
      case 'monthly': return `${st.m} ${st.h} ${st.dom} * *`;
      default: return st.raw;
    }
  }

  function describe(cron) {
    const st = parse(cron);
    const at = `${pad(st.h)}:${pad(st.m)}`;
    switch (st.mode) {
      case 'minutes': return `Every ${st.everyM} minutes`;
      case 'hours': return st.everyH === 1 ? `Every hour at :${pad(st.m)}` : `Every ${st.everyH} hours at :${pad(st.m)} (00:${pad(st.m)}, ${pad(st.everyH)}:${pad(st.m)}, …)`;
      case 'daily': return `Every day at ${at}`;
      case 'weekly': return `Every ${st.days.length === 7 ? 'day' : st.days.slice().sort((a, b) => (a || 7) - (b || 7)).map(d => DAY_NAME[d]).join(', ')} at ${at}`;
      case 'monthly': return `On day ${st.dom} of every month at ${at}`;
      default: return st.raw ? `Custom: ${st.raw}` : '—';
    }
  }

  const opt = (v, label, sel) => `<option value="${v}" ${sel ? 'selected' : ''}>${label}</option>`;
  function html(cron, { minutes = false } = {}) {
    const st = parse(cron);
    if (st.mode === 'minutes' && !minutes) st.mode = 'custom';
    const modes = [...(minutes ? [['minutes', 'Every few minutes']] : []), ['hours', 'Every few hours'], ['daily', 'Every day'], ['weekly', 'On days of the week'], ['monthly', 'Once a month'], ['custom', 'Custom (cron)']];
    const sel = 'class="input" style="width:auto;padding:5px 8px"';
    return `<div class="sp" data-sp>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <select ${sel} data-sp-mode>${modes.map(([v, l]) => opt(v, l, st.mode === v)).join('')}</select>
        <span data-sp-show="minutes">every <select ${sel} data-sp-everym>${EVERY_M.map(n => opt(n, `${n} minutes`, st.everyM === n)).join('')}</select></span>
        <span data-sp-show="hours">every <select ${sel} data-sp-everyh>${EVERY_H.map(n => opt(n, n === 1 ? 'hour' : `${n} hours`, st.everyH === n)).join('')}</select> at minute</span>
        <span data-sp-show="monthly">on day <select ${sel} data-sp-dom>${Array.from({ length: 28 }, (_, i) => opt(i + 1, i + 1, st.dom === i + 1)).join('')}</select></span>
        <span data-sp-show="daily weekly monthly">at</span>
        <span data-sp-show="daily weekly monthly" style="display:inline-flex;gap:4px;align-items:center"><select ${sel} data-sp-h aria-label="Hour">${Array.from({ length: 24 }, (_, i) => opt(i, pad(i), st.h === i)).join('')}</select><b>:</b></span>
        <span data-sp-show="hours daily weekly monthly"><select ${sel} data-sp-m aria-label="Minute">${Array.from({ length: 60 }, (_, i) => opt(i, pad(i), st.m === i)).join('')}</select></span>
        <input class="input td-mono" data-sp-show="custom" data-sp-raw style="width:190px" value="${UI.esc(st.raw || '15 3 * * *')}" placeholder="m h dom mon dow">
      </div>
      <div data-sp-show="weekly" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${DAYS.map(([d, l]) => `<button type="button" class="ui-fchip" data-sp-day="${d}" aria-pressed="${st.days.includes(d)}">${l}</button>`).join('')}</div>
      <div class="ui-sub" style="margin-top:6px"><span data-sp-human></span> · server time, 24-hour · <span class="td-mono" data-sp-cron></span></div>
    </div>`;
  }

  function bind(root, { onChange } = {}) {
    const el = root.matches && root.matches('[data-sp]') ? root : root.querySelector('[data-sp]');
    const q = (s) => el.querySelector(s);
    const days = () => [...el.querySelectorAll('[data-sp-day][aria-pressed="true"]')].map(b => +b.dataset.spDay);
    const state = () => ({ mode: q('[data-sp-mode]').value, h: +q('[data-sp-h]').value, m: +q('[data-sp-m]').value, days: days(), dom: +q('[data-sp-dom]').value,
      everyH: +q('[data-sp-everyh]').value, everyM: +q('[data-sp-everym]').value, raw: q('[data-sp-raw]').value.trim() });
    const value = () => build(state());
    const sync = () => {
      const mode = q('[data-sp-mode]').value;
      el.querySelectorAll('[data-sp-show]').forEach(x => { x.style.display = x.dataset.spShow.split(' ').includes(mode) ? '' : 'none'; });
      const v = value();
      q('[data-sp-cron]').textContent = v; q('[data-sp-human]').textContent = describe(v);
      if (onChange) onChange(v);
    };
    el.querySelectorAll('select, input').forEach(x => x.addEventListener(x.tagName === 'INPUT' ? 'input' : 'change', sync));
    el.querySelectorAll('[data-sp-day]').forEach(b => b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      if (on && days().length === 1) return; // keep at least one day
      b.setAttribute('aria-pressed', String(!on)); sync();
    }));
    sync();
    return { value };
  }

  return { html, bind, describe, parse, build };
})();
