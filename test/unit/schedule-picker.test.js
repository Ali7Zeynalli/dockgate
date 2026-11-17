'use strict';
// The schedule picker (public/js/schedule-picker.js): cron ↔ picker state, and the words for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ctx = { UI: { esc: (s) => String(s) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/schedule-picker.js'), 'utf8') + '\nthis.SP = SchedulePicker;', ctx);
const SP = ctx.SP;

test('simple cron lines come back the same and read in words', () => {
  for (const [cron, mode, words] of [
    ['15 3 * * *', 'daily', 'Every day at 03:15'],
    ['0 */6 * * *', 'hours', 'Every 6 hours at :00 (00:00, 06:00, …)'],
    ['5 * * * *', 'hours', 'Every hour at :05'],
    ['30 22 * * 1,3,5', 'weekly', 'Every Monday, Wednesday, Friday at 22:30'],
    ['0 4 * * 0', 'weekly', 'Every Sunday at 04:00'],
    ['45 1 15 * *', 'monthly', 'On day 15 of every month at 01:45'],
    ['*/10 * * * *', 'minutes', 'Every 10 minutes'],
  ]) {
    const st = SP.parse(cron);
    assert.equal(st.mode, mode, cron);
    assert.equal(SP.build(st), cron);
    assert.equal(SP.describe(cron), words);
  }
});

test('anything else stays a custom line', () => {
  for (const c of ['@reboot', '0 3 * 1 *', '0 3 31 * *', '*/7 * * * *', '0 9-17 * * 1-5', '']) {
    const st = SP.parse(c);
    assert.equal(st.mode, 'custom', c); assert.equal(SP.build(st), c.trim());
  }
  assert.equal(SP.build({ mode: 'weekly', h: 7, m: 5, days: [0, 3, 1] }), '5 7 * * 1,3,0', 'Monday first, Sunday last');
});
