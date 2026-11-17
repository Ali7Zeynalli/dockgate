'use strict';
// The sidebar (app.js navItems) and Router.resolve: every tab has a page, and the old places of moved pages lead to the new ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const js = (f) => fs.readFileSync(path.join(__dirname, '../../public/js', f), 'utf8');

function load() {
  const ctx = { console, escapeHtml: (s) => String(s), Icons: new Proxy({}, { get: () => '<svg/>' }), Store: { get: () => ({}) }, window: {}, document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(js('router.js') + '\n;this.Router = Router;', ctx);
  vm.runInContext(js('server-sections.js') + '\n;this.SRV_OLD_TABS = SRV_OLD_TABS;', ctx);
  const app = js('app.js'); const nav = app.slice(app.indexOf('const navItems = {'), app.indexOf('/** The SERVER group'));
  vm.runInContext(js('tabbed-section.js'), ctx); // before app.js, as in index.html
  vm.runInContext(nav + '\n;this.navItems = navItems; this.navGroups = navGroups;', ctx);
  // pages registered by the page scripts (only the names matter here)
  for (const f of fs.readdirSync(path.join(__dirname, '../../public/js/pages'))) for (const m of js('pages/' + f).matchAll(/Router\.register\('([^']+)'/g)) ctx.Router.routes[m[1]] = ctx.Router.routes[m[1]] || (() => {});
  return ctx;
}

test('every sidebar entry and tab opens a registered page; every grouped item exists; tab names are unique', () => {
  const { Router, navItems, navGroups } = load();
  const seen = new Set();
  for (const g of navGroups) for (const k of g.items) { assert.ok(navItems[k], `${k} in a group`); assert.ok(Router.routes[k], `${k} has a page`); }
  for (const [k, v] of Object.entries(navItems)) if (v.tabs && !['settings', 'infra'].includes(k)) assert.ok(Router.routes[k], `section ${k} is registered`);
  for (const [k, v] of Object.entries(navItems)) for (const [t] of v.tabs || []) {
    if (!['settings', 'infra'].includes(k)) assert.ok(Router.routes[t], `${k} → ${t} has a page`);
    assert.ok(!seen.has(t), `tab ${t} only once`); seen.add(t);
  }
  assert.ok(Object.values(navItems).every(v => !v.tabs || v.tabs.length <= 10), 'at most 10 tabs');
});

test('old links lead to the new places', () => {
  const { Router } = load();
  const r = (p, params) => { const x = Router.resolve(p, params); return `${x.path}${x.params.tab ? ':' + x.params.tab : ''}`; };
  assert.equal(r('activity', { tab: 'logs' }), 'observe:logs');
  assert.equal(r('activity', { tab: 'uptime' }), 'uptime');
  assert.equal(r('activity', { tab: 'audit' }), 'activity:audit');
  assert.equal(r('observe', { tab: 'uptime' }), 'uptime');
  assert.equal(r('observe', { tab: 'audit' }), 'activity:audit');
  assert.equal(r('observe', { tab: 'notification-log' }), 'activity:notification-log');
  assert.equal(r('tools', { tab: 'databases', c: 'db' }), 'databases');
  assert.equal(Router.resolve('tools', { tab: 'databases', c: 'db' }).params.c, 'db');
  assert.equal(r('tools', { tab: 'schedules' }), 'srv-automation:schedules');
  assert.equal(r('resources', { tab: 'builds' }), 'deploy:builds');
  assert.equal(r('resources', { tab: 'cleanup' }), 'resources:prune');
  assert.equal(r('builds', {}), 'deploy:builds');
  assert.equal(r('audit', {}), 'activity:audit');
  assert.equal(r('settings', { tab: 'system' }), 'srv-status:srv-sysinfo');
  assert.equal(r('settings', { tab: 'log' }), 'activity:notification-log');
  assert.equal(r('srv-firewall', {}), 'srv-security:srv-firewall');
  assert.equal(r('infra', { tab: 'registries' }), 'deploy:registries');
});

test('every old Server Console tab has a new place in the sidebar', () => {
  const { navItems, SRV_OLD_TABS } = load();
  for (const t of ['overview', 'monitoring', 'setup', 'access', 'users', 'firewall', 'fail2ban', 'manage', 'cron', 'scripts', 'system', 'logs', 'settings']) {
    const [sec, tab] = SRV_OLD_TABS[t]; assert.ok(navItems[sec] && navItems[sec].tabs.some(([x]) => x === tab), `${t} → ${sec}/${tab}`);
  }
});
