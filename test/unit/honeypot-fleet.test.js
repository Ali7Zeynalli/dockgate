'use strict';
// Honeypot bans shared with every server (server/honeypot-fleet.js): reading a server, what is never spread, the
// sync (add what is missing, remove what ended, retry later), unban everywhere, and the receiving jail.
const test = require('node:test');
const assert = require('node:assert/strict');
const FB = require('../../server/honeypot-fleet');

const readOut = ({ conn = '198.51.100.5 50000 203.0.113.10 2299', addrs = '203.0.113.10 172.17.0.1', now = '2026-11-27 12:00:00', hp = [], hptime = '', fleet = null } = {}) => [
  '@@conn', conn, '@@addrs', addrs, '@@now', now, '@@f2b', 'up',
  '@@hp', hp ? `   \`- Banned IP list:\t${hp.join(' ')}` : '', '@@hptime', hptime, '@@hpbantime', '86400',
  '@@fleet', fleet ? `   \`- Banned IP list:\t${fleet.join(' ')}` : '',
].join('\n');

test('reading a server: bans with the time they end (server clock, any time zone), DockGate and own addresses', () => {
  const now = Date.UTC(2026, 10, 27, 9, 0, 0);
  const r = FB.parseRead(readOut({ hp: ['203.0.113.9', '198.51.100.7'], hptime: '203.0.113.9 \t2026-11-27 11:00:00 + 7200 = 2026-11-27 13:00:00', fleet: [] }), now);
  assert.equal(r.up, true); assert.equal(r.honeypot, true); assert.equal(r.fleetInstalled, true);
  assert.equal(r.dockgateIp, '198.51.100.5');
  assert.deepEqual(r.ownIps, ['203.0.113.10', '203.0.113.10', '172.17.0.1']);
  assert.equal(r.honeypotBans.find(b => b.ip === '203.0.113.9').endsAt, now + 3600000, 'one hour left on the server clock');
  assert.equal(r.honeypotBans.find(b => b.ip === '198.51.100.7').endsAt, now + 86400000, 'no time: the jail ban time');
  const none = FB.parseRead(readOut({ hp: null, fleet: null }), now);
  assert.equal(none.honeypot, false); assert.equal(none.fleetInstalled, false);
});

test('never spread: private ranges, given addresses, allowlist networks', () => {
  const keep = FB.protectedList(['203.0.113.10'], ['198.51.100.0/24', '2001:db8::1']);
  for (const ip of ['10.1.2.3', '172.20.0.5', '192.168.1.1', '127.0.0.1', '203.0.113.10', '198.51.100.77', '2001:db8::1', 'fe80::1', 'nonsense']) assert.equal(keep(ip), true, ip);
  for (const ip of ['203.0.113.9', '192.0.2.44', '2001:db8::2']) assert.equal(keep(ip), false, ip);
});

test('sync: a sharing server\'s bans reach the receiving one; what ended is removed; allowlisted and server addresses stay out', async () => {
  FB.q.prune.run(Date.now() + 1e12, Date.now() + 1e12); // empty
  FB.saveSettings({ enabled: true, allow: ['198.51.100.0/24'] });
  const rows = [{ id: 't-a', name: 'a', host: '203.0.113.10' }, { id: 't-b', name: 'b', host: '203.0.113.11' }];
  FB.setFlags('t-a', { share: true, receive: false });
  FB.setFlags('t-b', { share: false, receive: true });
  const now = Date.UTC(2026, 10, 27, 9, 0, 0);
  const calls = [];
  const io = {
    read: async (r) => r.id === 't-a'
      ? readOut({ hp: ['192.0.2.50', '198.51.100.9', '203.0.113.11', '10.0.0.4'] })
      : readOut({ conn: '198.51.100.5 1 203.0.113.11 22', addrs: '203.0.113.11', hp: null, fleet: ['192.0.2.99'] }),
    sh: async (r, cmd) => { calls.push([r.id, cmd]); return ''; },
  };
  const res = await FB.syncOnce({ now, io, rows });
  assert.equal(res.added, 1, 'only 192.0.2.50: the others are allowlisted, a server, or private');
  assert.deepEqual(calls.map(c => c[1].split('{{S}}').join('')), ['fail2ban-client set dockgate-fleet banip 192.0.2.50 >/dev/null && fail2ban-client set dockgate-fleet unbanip 192.0.2.99 >/dev/null 2>&1; true'], 'one SSH command for both');
  assert.equal(FB.flagsOf('t-b').active, 1);
  // a server that does not answer is retried next time, the others go on
  calls.length = 0;
  const res2 = await FB.syncOnce({ now: now + 60000, rows, io: { read: async (r) => { if (r.id === 't-b') throw new Error('timeout'); return readOut({ hp: ['192.0.2.50'] }); }, sh: io.sh } });
  assert.match(res2.servers['t-b'].error, /timeout/);
  assert.match(FB.flagsOf('t-b').error, /not reachable/);
  // off: nothing happens
  FB.saveSettings({ enabled: false });
  assert.deepEqual(await FB.syncOnce({ now, io, rows }), { skipped: 'off' });
});

test('unban everywhere: fleet jails and the honeypot that caught it, and it is not spread again', async () => {
  FB.saveSettings({ enabled: true, allow: [] });
  const rows = [{ id: 't-a', name: 'a', host: '203.0.113.10' }, { id: 't-b', name: 'b', host: '203.0.113.11' }];
  const cmds = [];
  const r = await FB.unbanEverywhere('192.0.2.50', { rows, io: { sh: async (row, c) => { cmds.push(c); if (row.id === 't-b') throw new Error('down'); } } });
  assert.deepEqual(r.done, ['a']); assert.equal(r.failed[0].server, 'b');
  assert.match(cmds[0], /dockgate-fleet unbanip 192\.0\.2\.50.*dockgate-honeypot unbanip 192\.0\.2\.50/);
  const calls = [];
  const res = await FB.syncOnce({ rows, io: { read: async (row) => (row.id === 't-a' ? readOut({ hp: ['192.0.2.50'] }) : readOut({ conn: '198.51.100.5 1 203.0.113.11 22', hp: null, fleet: [] })), sh: async (row, c) => calls.push(c) } });
  assert.equal(res.added, 0);
  assert.equal(calls.length, 0, 'the source still lists it, but it stays unbanned');
  await assert.rejects(FB.unbanEverywhere('not-an-ip', { rows: [] }), /Not an IP/);
  FB.saveSettings({ enabled: false });
});

test('receiving jail: reads no log, bans on every port, removed again on failure', () => {
  const p = FB.receivePlan();
  assert.match(FB.FILTER_TEXT, /^failregex =$/m);
  const jail = p.steps[1].cmd;
  assert.ok(p.steps[1].rollbackOnFail);
  const head = Buffer.from(/echo ([A-Za-z0-9+/=]{40,}) \| base64 -d; printf/.exec(jail)[1], 'base64').toString();
  assert.match(head, /logpath = \/dev\/null/); assert.match(head, /bantime = 30d/);
  assert.match(jail, /fleet-docker, chain=DOCKER-USER/);
  assert.match(p.rollback, /rm -f \/etc\/fail2ban\/jail\.d\/dockgate-fleet\.conf/);
  assert.throws(() => FB.saveSettings({ allow: ['example.com'] }), /Allowed address/);
});

test('a large first sync goes in a few SSH commands, each below the command line limit', () => {
  const ips = Array.from({ length: 20000 }, (_, i) => `198.18.${Math.floor(i / 250)}.${i % 250 + 1}`);
  const cmds = [];
  for (let i = 0; i < ips.length; i += 400) cmds.push(`{{S}}fail2ban-client set dockgate-fleet banip ${ips.slice(i, i + 400).join(' ')} >/dev/null`);
  const b = FB.batches(cmds);
  assert.ok(b.length <= 5, `${b.length} commands`);
  for (const x of b) assert.ok(x.length < 100 * 1024);
  assert.equal(b.join(' && ').split('banip').length - 1, 50, 'nothing lost');
  assert.deepEqual(FB.batches([]), []);
});
